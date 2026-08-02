// Phase 4.0 M3 S3 — mutation-plus-audit, in ONE transaction, fail-closed.
//
// PURPOSE: a sensitive business mutation and the audit row that is REQUIRED to evidence it
// must both land or neither must. Today's audit callers cannot promise that: they write the
// mutation, then write the audit, then record a flag if the audit failed — leaving a committed
// change with no compliance trail, which is exactly the outcome
// AUDIT_WRITE_FAILURE_STRATEGY.sensitiveOrStateChanging = 'fail_closed' forbids. This module
// is the smallest thing that makes the promise real: one transaction, one executor, mutation
// first, required audit second, and no success value produced before COMMIT.
//
// WHAT MAKES IT ATOMIC IS THE EXECUTOR, NOT THE ORDER. Running the audit "right after" the
// mutation on a DIFFERENT connection is two transactions wearing one function's name: the
// mutation is already durable when the audit fails. So the transaction-scoped handle the
// boundary hands back is passed to BOTH — `writeAuditEvent(event, { executor: tx })`, always,
// never its default getDb() client. There is no second `begin`, no retry, no compensating
// out-of-transaction write, and no catch that turns an audit failure into a flag.
//
// NO PARALLEL DATABASE ABSTRACTION. `AuditTransactionBoundary` is the narrowest shape
// postgres.js already satisfies — `sql.begin(fn)` — and the handle is the same
// `AuditSqlExecutor` the audit writer accepts, so one type spans both halves. This module
// opens no connection, reads no configuration, holds no DSN, and issues no SQL of its own.
//
// NO TENANT AUTHORITY ENTERS HERE. There is deliberately no context parameter. A future
// caller that must run under Row-Level Security installs its SERVER-DERIVED tenant/store
// context as the first statement inside its own `mutate`, on this same `tx`, transaction-
// locally (the `set_config(..., true)` form db.ts uses). Accepting a context argument would
// invite a client-supplied tenant to arrive as one, and no S3 caller needs it.
//
// NOT WIRED (binding): no production or DEV request path calls this in S3. Gate G-AUDIT is
// advanced by it and stays OPEN; full wiring, audit-review SELECT access, retention and
// duplicate suppression remain M6.

import {
  writeAuditEvent as durableWriteAuditEvent,
  type AuditEventWriteInput,
  type AuditSqlExecutor,
  type WriteAuditEventOptions,
  type WrittenAuditEvent,
} from './auditEventWriter';

/**
 * The transaction seam, injected by the caller.
 *
 * `begin` must open a REAL transaction and resolve only after it commits. Its shape mirrors
 * postgres.js's own `begin` — including the `T | Promise<T>` callback return — because a real
 * client has to be ASSIGNABLE to this interface for any typed caller to pass one. A narrower
 * declaration was written first and rejected at the type level: postgres.js hands the callback
 * a `TransactionSql`, which is not assignable to `Sql`, so an interface phrased in terms of the
 * repository's `SqlExecutor` compiles here and then refuses every real client at the call site.
 * The integration suite is `.mjs` and would never have caught it.
 *
 * A postgres.js TRANSACTION HANDLE does NOT satisfy it — measured on the pinned driver, the
 * handle passed to a `begin` callback exposes no `begin` of its own, so handing one back fails
 * loudly instead of quietly opening a savepoint and calling it a transaction. That is the whole
 * of the nesting guard: structural, not advisory.
 */
export interface AuditTransactionBoundary {
  begin<T>(fn: (tx: AuditSqlExecutor) => T | Promise<T>): Promise<T>;
}

/** The durable audit write, injectable so unit tests can prove control flow without a DB. */
export type AuditWriteFn = (
  event: AuditEventWriteInput,
  options: WriteAuditEventOptions,
) => Promise<WrittenAuditEvent>;

/** The two halves of one audited operation. Both run on the SAME transaction handle. */
export interface AuditedMutation<TResult> {
  /**
   * The business mutation. Receives the transaction-scoped executor and must use it — a
   * statement sent on any other handle is outside this transaction and outside this promise.
   */
  mutate: (tx: AuditSqlExecutor) => Promise<TResult>;
  /**
   * Build the REQUIRED audit event, from the caller's already-validated inputs and, where the
   * event needs it, the mutation's result (a generated id, an affected count). Throwing here
   * aborts the transaction, which is correct: an operation whose audit cannot even be
   * described must not commit.
   */
  buildAuditEvent: (result: TResult) => AuditEventWriteInput;
}

/** What a committed audited mutation yields. Produced only after COMMIT. */
export interface AuditedMutationOutcome<TResult> {
  result: TResult;
  audit: WrittenAuditEvent;
}

export interface AuditedMutationDeps {
  /** Defaults to the sanctioned durable writer. Always invoked with the transaction handle. */
  writeAuditEvent?: AuditWriteFn;
}

/** A non-sensitive misuse error (carries a label only — never an input value or DSN). */
export class AuditTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditTransactionError';
  }
}

/**
 * Run `operation.mutate` and its REQUIRED audit INSERT inside ONE transaction on ONE executor.
 *
 * Order is mutation → build event → audit INSERT, and every failure along it aborts the whole
 * transaction:
 *   - the mutation rejects   → the audit INSERT is never executed and nothing commits;
 *   - buildAuditEvent throws → the mutation is rolled back through the same transaction;
 *   - the audit INSERT rejects → the mutation is rolled back, and the error propagates
 *     UNCHANGED so the caller sees why (SQLSTATE and all) rather than a flag;
 *   - COMMIT itself fails    → `begin` rejects and no outcome is ever produced.
 *
 * Nothing is retried and nothing is written outside the transaction on any path.
 */
export async function runAuditedMutation<TResult>(
  boundary: AuditTransactionBoundary,
  operation: AuditedMutation<TResult>,
  deps: AuditedMutationDeps = {},
): Promise<AuditedMutationOutcome<TResult>> {
  if (typeof boundary?.begin !== 'function') {
    // A transaction handle, a bare tagged template, or undefined — all land here rather than
    // running the mutation un-transacted, which is the failure this module exists to prevent.
    // Nothing has been executed at this point.
    throw new AuditTransactionError(
      'a transaction-capable database boundary is required; pass the client, not a transaction handle',
    );
  }
  if (typeof operation?.mutate !== 'function' || typeof operation?.buildAuditEvent !== 'function') {
    throw new AuditTransactionError('an audited mutation requires both mutate and buildAuditEvent');
  }

  const writeAudit: AuditWriteFn = deps.writeAuditEvent ?? durableWriteAuditEvent;

  return boundary.begin<AuditedMutationOutcome<TResult>>(async (tx) => {
    const result = await operation.mutate(tx);
    const event = operation.buildAuditEvent(result);
    // `executor: tx` is not an optimization. Omitting it would send the audit down the writer's
    // default getDb() client — a second connection, a second transaction, and a durable audit
    // row that would survive this transaction's rollback.
    const audit = await writeAudit(event, { executor: tx });
    return { result, audit };
  });
}
