// Phase 4.0 M6 — the PostgreSQL transactional store: one database, one shared transaction kernel and three
// separate port implementations — DurableIdempotencyStore (server/runtime/idempotency.ts),
// CommandTransactionPort (commandTransaction.ts) and OutboxDeliveryStore (outbox.ts) — over migration 006's
// internal schema, tmpos_internal (G-IDEMPOT, G-AUDIT; docs/phase-4/10 ADR-17).
//
// NOT COMPOSED. No production module imports this file: the composition root binds no idempotency store,
// transaction port or outbox, the production entry serves the probes and the bounded fallback only, and the
// emitted server artifact (tsconfig.server.json) does not contain it. Binding it is a later, separately
// authorized step: a runtime LOGIN holding tmpos_app and tmpos_audit_writer (G-DBROLE) over a database where
// migration 006 is applied (G-MIGRATE), and a real business route (G-IDEMPOT).
//
// What it is handed, and what it never holds. The caller hands it a database client — the runtime
// principal's pool, which server/platform-identity/db.ts builds under the verified-TLS policy — and the
// closed table of business mutators, one per command kind, defined in trusted source. It constructs no
// client, opens nothing, reads no environment and keeps no state between calls. Only values cross each
// port; every statement is fixed, schema-qualified text in this file or in a mutator, every value is bound
// as a parameter, and no caller supplies SQL, an identifier or a fragment.
//
// Time. Every expiry, retention and due-time decision reads tmpos_internal.m6_store_clock() — the store's clock at
// millisecond resolution — only AFTER the row it decides about is locked, except a claim, which never waits on
// a lock (SKIP LOCKED) and reads it once at the start of its one statement, choosing and stamping every row from
// that one reading. Migration 006's guard then re-checks each claimed row against its own, later reading, which
// admits everything the statement chose unless the database's clock steps back past a chosen row's eligibility
// instant — then the guard refuses and the whole claim fails closed; this file never retries it, and only a
// caller's next claim can try again. This process's clock is never read. A
// command's stamps (its audit record and each event) are the transaction's start, now(): audit_event.occurred_at's
// own default. Every stored time this file reads back as epoch milliseconds is bounded by migration 006 — finite
// and before the year 10 000, and for an event's occurrence also at or after the first readable millisecond, the
// lower end the envelope contract accepts — so no stored row can fail the read that hands it out.
//
// Bounds. Each call that reaches the database is one fresh transaction on one reserved connection — a call refused
// at validation, or handed an already-aborted signal, opens none — under transaction-local lock and statement
// timeouts below its port deadline and an idle-in-transaction timeout at twice it, which ends a session its caller
// has left; an abort cancels the statement in flight and rolls the transaction back. Nothing is retried: a lost race
// re-reads within the same transaction, and a failed transaction is never run again.
//
// Delivery policy. An event is claimed at most OUTBOX_DELIVERY_POLICY.maxAttempts (20) times, bound from source: an
// expired claim at the cap is dead-lettered (attempts_exhausted) by the next claim instead of being reclaimed, and a
// retry at the cap is refused. Migration 006's 1 000 is a storage-integrity ceiling, and its trigger enforces the
// delivery transitions themselves.
//
// Outcomes. Every precondition is a conditional statement whose row count decides it, so no error is ever
// read as a business answer: no SQLSTATE and no constraint maps to 'conflict', and a reused event ID is a
// fault. An error before COMMIT is sent leaves nothing committed — 'unavailable'; so does a server ERROR at
// COMMIT, which rolled it back. Any other failure once COMMIT was sent — a connection lost, a fatal error —
// may have committed or not, and the call rejects with one fixed message, which the runtime treats as
// indeterminate. No driver message, statement, parameter, identifier or stack is kept, logged or returned.
import { writeAuditEvent } from '../platform-identity/auditEventWriter';
import type { AuditEventWriteInput, AuditSqlExecutor } from '../platform-identity/auditEventWriter';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../runtime/commandTransaction.js';
import type { CommandTransactionPort, TransactionMutation } from '../runtime/commandTransaction.js';
import { IDEMPOTENCY_DEADLINE_MS, MAX_SEALED_LENGTH } from '../runtime/idempotency.js';
import type { DurableIdempotencyStore } from '../runtime/idempotency.js';
import {
  AGGREGATE_TYPE_RE, MAX_CLAIM_BATCH, MAX_EVENTS_PER_COMMAND, MAX_RECORD_BYTES, OUTBOX_DEADLINE_MS, OUTBOX_DELIVERY_POLICY,
  UUID_RE, UUID_V4_RE, isContractName,
} from '../runtime/outbox.js';
import type { OutboxDeliveryStore } from '../runtime/outbox.js';

/** A statement in flight: a promise of its rows that the driver can cancel. */
export interface PgPendingQuery extends Promise<PgRows> {
  cancel(): unknown;
}
/** A statement's rows, with the number of rows it affected. */
export type PgRows = readonly Readonly<Record<string, unknown>>[] & { readonly count: number };
/** The tagged template a transaction exposes (postgres.js). */
export interface PgTransaction {
  (strings: TemplateStringsArray, ...values: unknown[]): PgPendingQuery;
  json(value: unknown): unknown;
}
/** The pool: runs `fn` in one transaction on one reserved connection, committing when it resolves. */
export interface PgClient {
  begin(fn: (tx: PgTransaction) => Promise<unknown>): Promise<unknown>;
}
/** One statement on the open transaction, tracked so an abort cancels it. */
export type PgStatement = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<PgRows>;

/** How one command kind mutates its aggregate: trusted source, frozen at construction, never a caller's. */
export interface AggregateMutator {
  readonly kind: string;
  readonly mode: 'create' | 'update';
  readonly aggregateType: string;
  /**
   * Apply the mutation on the open transaction through fixed, parameterized statements: 'applied' once
   * exactly its row was created (mode create) or moved from expectedVersion to the next (mode update), or
   * 'conflict' when that precondition does not hold. Anything else — another answer, a throw — commits nothing.
   */
  readonly apply: (sql: PgStatement, mutation: TransactionMutation) => Promise<unknown>;
}

export interface TransactionalStoreOptions {
  readonly client: PgClient;
  readonly mutators: readonly AggregateMutator[];
}

/** The three ports over one database: separate objects, each only its own interface. */
export interface TransactionalStore {
  readonly idempotency: DurableIdempotencyStore;
  readonly transactions: CommandTransactionPort;
  readonly delivery: OutboxDeliveryStore;
}

type Answer = Readonly<Record<string, unknown>>;

const answer = (outcome: string): Answer => Object.freeze({ outcome });
const UNAVAILABLE = answer('unavailable');
const ACQUIRED = Object.freeze({ outcome: 'acquired', reclaimed: false });
const RECLAIMED = Object.freeze({ outcome: 'acquired', reclaimed: true });
const IN_PROGRESS = answer('in_progress');
const CONFLICT = answer('conflict');
const COMPLETED = answer('completed');
const LEASE_LOST = answer('lease_lost');
const COMMITTED = answer('committed');
const CLAIM_LOST = answer('claim_lost');
const READY = answer('ready');
const EMPTY = Object.freeze({ outcome: 'claimed', events: Object.freeze([]) });

/** The one rejection: COMMIT was sent and its fate is unknown. */
const OUTCOME_UNKNOWN = 'transactional_store_outcome_unknown';

const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const SEALED_RE = /^[A-Za-z0-9_-]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_LEASE_MS = 24 * 60 * 60_000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_CLAIM_MS = 60 * 60_000;
const MAX_EVENT_VERSION = 1_000;
/**
 * The delivery policy's cap on claims, bound from source and never from a request: an event is claimed at most this
 * many times. Migration 006's own ceiling (1 000) is storage integrity only, never this policy.
 */
const MAX_ATTEMPTS: number = OUTBOX_DELIVERY_POLICY.maxAttempts;
const MAX_PERMISSION_LENGTH = 128;
const DEAD_REASONS: readonly string[] = ['attempts_exhausted', 'envelope_invalid'];
const COMMAND_FIELDS: readonly string[] = ['scope', 'lease', 'response', 'mutation', 'audit', 'events'];
const MUTATION_FIELDS: readonly string[] = ['kind', 'aggregateType', 'aggregateId', 'expectedVersion', 'changes'];
const AUDIT_FIELDS: readonly string[] = ['action', 'permission', 'scope', 'tenant', 'store', 'actor', 'correlationId'];
const EVENT_FIELDS: readonly string[] = [
  'eventId', 'type', 'version', 'aggregateType', 'aggregateId', 'aggregateVersion', 'tenant', 'store', 'actor', 'correlationId', 'payload',
];
/** Who the audit record says wrote it: this adapter, for a command the runtime chain authorized. */
export const COMMAND_AUDIT_EVALUATED_BY = 'm6_postgres_command_transaction@v1';

interface Bounds { readonly lock: string; readonly statement: string; readonly idle: string }
/** Transaction-local bounds under a port deadline: lock waits, then any one statement, then an idle transaction. */
const boundsUnder = (deadlineMs: number): Bounds => Object.freeze({
  lock: `${Math.floor(deadlineMs * 0.7)}ms`, statement: `${Math.floor(deadlineMs * 0.9)}ms`, idle: `${deadlineMs * 2}ms`,
});
const IDEMPOTENCY_BOUNDS = boundsUnder(IDEMPOTENCY_DEADLINE_MS);
const TRANSACTION_BOUNDS = boundsUnder(COMMAND_TRANSACTION_DEADLINE_MS);
const DELIVERY_BOUNDS = boundsUnder(OUTBOX_DEADLINE_MS);

/** An ordinary object literal: never an array, a class instance or anything inheriting its fields. */
const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
/** Exactly `keys` as own properties: none missing, none extra, no symbol. */
const hasExactKeys = (o: object, keys: readonly string[]): boolean => {
  const own = Reflect.ownKeys(o);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key));
};
const isInteger = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max && !Object.is(v, -0);
const isDigest = (v: unknown): v is string => typeof v === 'string' && DIGEST_RE.test(v);
const isSealed = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_SEALED_LENGTH && SEALED_RE.test(v);
type ScalarRecord = Readonly<Record<string, string | number | boolean>>;
/**
 * A flat record of bounded scalars, at most MAX_RECORD_BYTES serialized, as a frozen copy with each field read
 * exactly once — or null. A symbol or a field hidden from enumeration refuses it.
 */
function scalarRecordOf(v: unknown): ScalarRecord | null {
  if (!isRecord(v)) return null;
  const keys = Object.keys(v);
  if (Reflect.ownKeys(v).length !== keys.length) return null;
  const entries: [string, string | number | boolean][] = [];
  for (const key of keys) {
    const x: unknown = v[key];
    if (typeof x !== 'boolean' && typeof x !== 'string' && !isInteger(x, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) return null;
    entries.push([key, x]);
  }
  const copy: ScalarRecord = Object.freeze(Object.fromEntries(entries));
  return Buffer.byteLength(JSON.stringify(copy), 'utf8') <= MAX_RECORD_BYTES ? copy : null;
}
/** The named fields of a caller's ordinary object, each read once into a frozen copy — or null when it is none. */
function fieldsOf(raw: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  try {
    return isRecord(raw) ? Object.freeze(Object.fromEntries(keys.map((key) => [key, raw[key]]))) : null;
  } catch {
    return null; // a hostile getter or proxy trap: not in contract
  }
}

/** Thrown inside a transaction to roll it back and answer with `answer` instead. */
class Rollback {
  constructor(readonly answer: Answer) {}
}
const refuse = (outcome: Answer): never => {
  throw new Rollback(outcome);
};

/**
 * A server-reported ERROR: the statement failed and its transaction commits nothing. Never a lost or
 * refused connection (no SQLSTATE), a connection exception (class 08) or an operator intervention (57P).
 */
function isStatementError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, severity } = err as { code?: unknown; severity?: unknown };
  return severity === 'ERROR' && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !/^(?:08|57P)/.test(code);
}

/** The driver's own refusals, raised before or without the server; its connection stays open (postgres 3.4.9). */
const DRIVER_LOCAL_CODES: readonly string[] = ['57014', 'UNDEFINED_VALUE', 'MAX_PARAMETERS_EXCEEDED'];

/**
 * A failure after which the transaction can still be rolled back on its connection: a server statement ERROR,
 * or a refusal the driver raised itself — a statement cancelled before it was sent, a value it cannot bind.
 */
function leavesConnectionOpen(err: unknown): boolean {
  if (isStatementError(err)) return true;
  if (typeof err !== 'object' || err === null) return false;
  const { code, severity } = err as { code?: unknown; severity?: unknown };
  return severity === undefined && typeof code === 'string' && DRIVER_LOCAL_CODES.includes(code);
}

/**
 * The kernel: `work` in one transaction under `limits`. Its answer once committed (or the answer a
 * Rollback carried); 'unavailable' when the transaction failed before COMMIT or COMMIT reported an ERROR;
 * a rejection with OUTCOME_UNKNOWN only when COMMIT was sent and its fate cannot be known.
 */
async function transact(client: PgClient, signal: AbortSignal, limits: Bounds, work: (sql: PgStatement, tx: PgTransaction) => Promise<Answer>): Promise<Answer> {
  if (signal.aborted) return UNAVAILABLE;
  let inFlight: PgPendingQuery | null = null;
  let committing = false;
  let abandon: (answer: Answer) => void = () => undefined;
  const abandoned = new Promise<Answer>((resolve) => { abandon = resolve; });
  // An abort before COMMIT is sent answers at once, even while the driver is still waiting for a connection:
  // the statement in flight is cancelled, and every later step refuses before COMMIT, so nothing can commit.
  // Once COMMIT is sent, only its own outcome answers.
  const onAbort = (): void => {
    if (committing) return;
    const query = inFlight;
    if (query !== null) void Promise.resolve().then(() => query.cancel()).catch(() => undefined);
    abandon(UNAVAILABLE);
  };
  // Once begin has settled, the transaction is over or its connection is gone, so nothing further should reach the
  // driver: a statement, or the ROLLBACK or COMMIT the driver's own transaction scope sends, would each be written
  // to the closed socket, and the pinned driver's write of a short payload throws from a scheduled callback where
  // nothing can catch it, ending the process (postgres 3.4.9; doc 08, DA-15). `ended` refuses every statement this
  // file issues from the moment it is set, and a body still running then simply never finishes. It is set late,
  // though — only once begin's rejection has propagated here — and begin() races the body's scope against the
  // connection's close, so a close that wins leaves that scope running. A connection lost while a statement is in
  // flight is safe: the driver rejects that statement before it reports the close, and the wrapper below never
  // settles it. But a close processed after a statement returned and before `ended` is set leaves the body free to
  // issue its next statement, and the scope free to send COMMIT for a body that resolves or ROLLBACK for one that
  // throws — including the abort refusal after `work` below. All three reach the closed socket (doc 08, DA-19).
  let ended = false;
  const settle = async (): Promise<Answer> => {
    try {
      return (await client.begin(async (tx) => {
        const sql: PgStatement = async (strings, ...values) => {
          if (ended) return new Promise<PgRows>(() => undefined);
          if (signal.aborted) refuse(UNAVAILABLE);
          const query = tx(strings, ...values);
          inFlight = query;
          try {
            return await query;
          } catch (err) {
            if (leavesConnectionOpen(err)) throw err;
            // Anything else is taken for a lost connection: the driver rejects the transaction when it closes, and
            // a ROLLBACK sent from here would be written to the closed socket and crash the process (postgres 3.4.9;
            // doc 08 DA-15). So nothing more runs in this transaction: this statement never settles. A failure
            // misread this way on a connection still open holds it only until the server's idle-in-transaction
            // timeout ends the session.
            return new Promise<PgRows>(() => undefined);
          } finally {
            if (inFlight === query) inFlight = null;
          }
        };
        // The transaction's bounds, and its search path: pg_catalog, then pg_temp — no schema a less privileged role
        // could write to, so an operator or function placed there is never a candidate beside pg_catalog's own (an
        // implicit cast would otherwise let an exact match elsewhere win). Every relation is schema-qualified: the
        // store's in tmpos_internal, the audit writer's public.audit_event, and a mutator's own tables.
        await sql`select pg_catalog.set_config('lock_timeout', ${limits.lock}, true),
          pg_catalog.set_config('statement_timeout', ${limits.statement}, true),
          pg_catalog.set_config('idle_in_transaction_session_timeout', ${limits.idle}, true),
          pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`;
        let result: Answer;
        try {
          result = await work(sql, tx);
        } catch (err) {
          if (ended) return new Promise<Answer>(() => undefined);
          throw err;
        }
        if (ended) return new Promise<Answer>(() => undefined);
        if (signal.aborted) refuse(UNAVAILABLE); // the deadline passed during the last statement: roll back, never commit late
        committing = true;
        return result;
      })) as Answer;
    } catch (err) {
      if (err instanceof Rollback) return err.answer;
      if (committing && !isStatementError(err)) throw new Error(OUTCOME_UNKNOWN);
      return UNAVAILABLE;
    } finally {
      ended = true;
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const running = settle();
  running.catch(() => undefined); // an abandoned transaction's later failure is observed, never unhandled
  try {
    return await Promise.race([running, abandoned]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Exactly one row, or the transaction fails closed. */
const single = (rows: PgRows): Readonly<Record<string, unknown>> => (rows.length === 1 ? rows[0] : refuse(UNAVAILABLE));
/** A bigint the driver returns as text, as a safe integer — or the transaction fails closed. */
const integerOf = (v: unknown): number => {
  const n = typeof v === 'string' && /^-?[0-9]{1,16}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) ? n : refuse(UNAVAILABLE);
};
const textOf = (v: unknown): string => (typeof v === 'string' ? v : refuse(UNAVAILABLE));
const nullableTextOf = (v: unknown): string | null => (v === null ? null : textOf(v));
/** Epoch milliseconds as the bigint text a statement binds: exact, never a float. */
const ms = (n: number): string => String(n);

/** The store's clock, read now — after whatever this transaction has locked. */
async function storeClock(sql: PgStatement): Promise<number> {
  return integerOf(single(await sql`select (extract(epoch from tmpos_internal.m6_store_clock()) * 1000)::bigint::text as now`).now);
}

async function probe(client: PgClient, signal: AbortSignal, statement: (sql: PgStatement) => Promise<PgRows>): Promise<boolean> {
  try {
    const result = await transact(client, signal, IDEMPOTENCY_BOUNDS, async (sql) => (single(await statement(sql)).ok === true ? READY : UNAVAILABLE));
    return result === READY;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// DurableIdempotencyStore
// ---------------------------------------------------------------------------

interface AcquireRequest { readonly scope: string; readonly fingerprint: string; readonly lease: string; readonly leaseMs: number; readonly retentionMs: number }

function acquireRequestOf(raw: unknown): AcquireRequest | null {
  const fields = fieldsOf(raw, ['scope', 'fingerprint', 'lease', 'leaseMs', 'retentionMs']);
  if (fields === null) return null;
  const { scope, fingerprint, lease, leaseMs, retentionMs } = fields;
  return isDigest(scope) && isDigest(fingerprint) && isDigest(lease) && isInteger(leaseMs, 1, MAX_LEASE_MS) && isInteger(retentionMs, leaseMs, MAX_RETENTION_MS)
    ? { scope, fingerprint, lease, leaseMs, retentionMs } : null;
}

/** Record the caller's binding, lease and terms, from `now`: a new record, one past its retention, or a reclaim. */
async function recordLease(sql: PgStatement, r: AcquireRequest, now: number): Promise<void> {
  const updated = await sql`update tmpos_internal.idempotency_record
    set fingerprint = ${r.fingerprint}, lease = ${r.lease}, response = null,
      lease_expires_at = 'epoch'::timestamptz + (${ms(now + r.leaseMs)}::bigint * interval '1 millisecond'),
      expires_at = 'epoch'::timestamptz + (${ms(now + r.retentionMs)}::bigint * interval '1 millisecond')
    where scope = ${r.scope}`;
  if (updated.count !== 1) refuse(UNAVAILABLE);
}

async function acquire(sql: PgStatement, r: AcquireRequest): Promise<Answer> {
  // inv: each pass either locks the scope's row or records it; term: at most two passes — a second only after
  // a concurrent caller recorded the scope first, whose committed row the second pass then locks.
  for (let pass = 0; pass < 2; pass++) {
    const rows = await sql`select fingerprint, lease, response,
        (extract(epoch from lease_expires_at) * 1000)::bigint::text as lease_expires,
        (extract(epoch from expires_at) * 1000)::bigint::text as expires
      from tmpos_internal.idempotency_record where scope = ${r.scope} for update`;
    if (rows.length === 0) {
      // Recorded first with placeholder terms, so no clock is read before a wait on a concurrent recording. The
      // placeholder is 'epoch': long past every retention, and — unlike an infinity — a time the ports read back.
      const inserted = await sql`insert into tmpos_internal.idempotency_record (scope, fingerprint, lease, lease_expires_at, expires_at)
        values (${r.scope}, ${r.fingerprint}, ${r.lease}, 'epoch', 'epoch') on conflict (scope) do nothing`;
      if (inserted.count === 0) continue;
      await recordLease(sql, r, await storeClock(sql));
      return ACQUIRED;
    }
    const row = single(rows);
    const fingerprint = textOf(row.fingerprint);
    const response = nullableTextOf(row.response);
    const leaseExpires = integerOf(row.lease_expires);
    const expires = integerOf(row.expires);
    const now = await storeClock(sql);
    if (now >= expires) {
      await recordLease(sql, r, now); // past its retention a record is absent: the operation starts afresh
      return ACQUIRED;
    }
    if (fingerprint !== r.fingerprint) return refuse(CONFLICT);
    if (response !== null) return refuse(Object.freeze({ outcome: 'replay', response }));
    if (now < leaseExpires) return refuse(IN_PROGRESS);
    await recordLease(sql, r, now);
    return RECLAIMED;
  }
  return refuse(UNAVAILABLE);
}

function idempotencyPort(client: PgClient): DurableIdempotencyStore {
  return Object.freeze({
    async acquire(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const request = acquireRequestOf(raw);
      return request === null ? UNAVAILABLE : transact(client, signal, IDEMPOTENCY_BOUNDS, (sql) => acquire(sql, request));
    },
    async complete(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const fields = fieldsOf(raw, ['scope', 'lease', 'response']);
      if (fields === null) return UNAVAILABLE;
      const { scope, lease, response } = fields;
      if (!isDigest(scope) || !isDigest(lease)) return LEASE_LOST; // never a lease the store granted
      if (!isSealed(response) || response.length === 0) return UNAVAILABLE;
      return transact(client, signal, IDEMPOTENCY_BOUNDS, async (sql) => {
        if ((await sql`select 1 from tmpos_internal.idempotency_record where scope = ${scope} for update`).length === 0) return refuse(LEASE_LOST);
        // The row is locked, so the clock read below is fresh: completed iff within retention, in progress, under this lease.
        const done = await sql`update tmpos_internal.idempotency_record set response = ${response}
          where scope = ${scope} and lease = ${lease} and response is null and expires_at > tmpos_internal.m6_store_clock()`;
        if (done.count === 0) return refuse(LEASE_LOST);
        return done.count === 1 ? COMPLETED : refuse(UNAVAILABLE);
      });
    },
    probe: (signal: AbortSignal): Promise<boolean> =>
      probe(client, signal, (sql) => sql`select tmpos_internal.m6_store_clock() is not null
        and not exists (select from tmpos_internal.idempotency_record where false) as ok`),
  });
}

// ---------------------------------------------------------------------------
// CommandTransactionPort
// ---------------------------------------------------------------------------

interface EventDraft {
  readonly eventId: string; readonly type: string; readonly version: number; readonly aggregateType: string; readonly aggregateId: string;
  readonly aggregateVersion: number; readonly tenant: string | null; readonly store: string | null; readonly actor: string | null;
  readonly correlationId: string; readonly payload: ScalarRecord;
}
interface Command {
  readonly scope: string; readonly lease: string; readonly response: string; readonly mutator: AggregateMutator;
  readonly mutation: TransactionMutation; readonly audit: AuditEventWriteInput; readonly events: readonly EventDraft[];
}


/**
 * A command in contract, re-checked at the store's boundary: LEASE_LOST when its fence can never match a
 * granted lease; UNAVAILABLE when anything else is malformed or no mutator serves its kind. Tenant and store
 * scopes wait on M5, which supplies their identities: until then only a platform-scope command is audited, and its
 * events name no tenant, store or actor.
 */
function commandOf(raw: unknown, mutators: ReadonlyMap<string, AggregateMutator>): Command | Answer {
  try {
    if (!isRecord(raw) || !hasExactKeys(raw, COMMAND_FIELDS)) return UNAVAILABLE;
    const { scope, lease, response, mutation, audit, events } = raw;
    if (!isDigest(scope) || !isDigest(lease)) return LEASE_LOST;
    if (!isSealed(response) || response.length === 0 || !isRecord(mutation) || !hasExactKeys(mutation, MUTATION_FIELDS)) return UNAVAILABLE;
    const { kind, aggregateType, aggregateId, expectedVersion, changes: rawChanges } = mutation;
    const mutator = typeof kind === 'string' ? mutators.get(kind) : undefined;
    if (mutator === undefined || aggregateType !== mutator.aggregateType || typeof aggregateId !== 'string' || !UUID_RE.test(aggregateId)) return UNAVAILABLE;
    if (mutator.mode === 'create' ? expectedVersion !== null : !isInteger(expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1)) return UNAVAILABLE;
    const changes = scalarRecordOf(rawChanges);
    if (changes === null || !isRecord(audit) || !hasExactKeys(audit, AUDIT_FIELDS)) return UNAVAILABLE;
    const { action, permission, scope: auditScope, tenant, store, actor, correlationId } = audit;
    if (action !== kind || auditScope !== 'platform' || tenant !== null || store !== null || actor !== null) return UNAVAILABLE;
    if (typeof permission !== 'string' || permission.length === 0 || permission.length > MAX_PERMISSION_LENGTH || CONTROL_RE.test(permission)) return UNAVAILABLE;
    if (typeof correlationId !== 'string' || !UUID_V4_RE.test(correlationId)) return UNAVAILABLE;
    // The array and its length, each read once: a proxied length cannot pass the bound and then drive the loop past it.
    const count: unknown = Array.isArray(events) && Object.getPrototypeOf(events) === Array.prototype ? events.length : undefined;
    if (!isInteger(count, 0, MAX_EVENTS_PER_COMMAND)) return UNAVAILABLE;
    const version = (expectedVersion === null ? 0 : expectedVersion as number) + 1;
    const drafts: EventDraft[] = [];
    // inv: drafts holds a checked copy of each event below i, each field read once, their IDs distinct; term: i rises to count (at most 8).
    for (let i = 0; i < count; i++) {
      const e: unknown = (events as readonly unknown[])[i];
      if (!isRecord(e) || !hasExactKeys(e, EVENT_FIELDS)) return UNAVAILABLE;
      const { eventId, type, version: eventVersion, aggregateType: eventAggregateType, aggregateId: eventAggregateId, aggregateVersion,
        tenant: eventTenant, store: eventStore, actor: eventActor, correlationId: eventCorrelationId, payload: rawPayload } = e;
      if (typeof eventId !== 'string' || !UUID_V4_RE.test(eventId) || drafts.some((d) => d.eventId === eventId)) return UNAVAILABLE;
      if (!isContractName(type) || !isInteger(eventVersion, 1, MAX_EVENT_VERSION) || eventAggregateType !== mutator.aggregateType || eventAggregateId !== aggregateId) return UNAVAILABLE;
      if (aggregateVersion !== version || eventCorrelationId !== correlationId || eventTenant !== null || eventStore !== null || eventActor !== null) return UNAVAILABLE;
      const payload = scalarRecordOf(rawPayload);
      if (payload === null) return UNAVAILABLE;
      drafts.push(Object.freeze({
        eventId, type, version: eventVersion, aggregateType: mutator.aggregateType, aggregateId, aggregateVersion: version,
        tenant: null, store: null, actor: null, correlationId, payload,
      }));
    }
    const auditEvent: AuditEventWriteInput = {
      requestId: correlationId, traceId: null, actorInternalUserId: null, actorAuthProvider: null, onBehalfOfInternalUserId: null,
      scopeType: 'platform', tenantId: null, storeId: null, actionId: kind as string, requiredPermission: permission, decision: 'allow',
      reasonCode: 'command_committed', humanReadableReason: 'An authorized command committed atomically with its idempotency completion and outbox events.',
      resultStatus: 'succeeded', sourceOfTruth: 'command_transaction', evaluatedBy: COMMAND_AUDIT_EVALUATED_BY, evidenceLevel: 'durable_compliance_event', metadata: {},
    };
    // The mutator is handed this copy — the values checked above, frozen — never the caller's live object.
    const checked: TransactionMutation = Object.freeze({
      kind: mutator.kind, aggregateType: mutator.aggregateType, aggregateId, expectedVersion: expectedVersion as number | null, changes,
    });
    return Object.freeze({ scope, lease, response, mutator, mutation: checked, audit: auditEvent, events: Object.freeze(drafts) });
  } catch {
    return UNAVAILABLE; // a hostile getter: not in contract
  }
}

/** The command in the order the contract fixes: fence, mutation, audit, events, completion — then COMMIT. */
async function commit(sql: PgStatement, tx: PgTransaction, c: Command): Promise<Answer> {
  // 1. The fence, before any business state: lock the record, then read the clock.
  const row = await sql`select lease, response is null as open, (extract(epoch from expires_at) * 1000)::bigint::text as expires
    from tmpos_internal.idempotency_record where scope = ${c.scope} for update`;
  if (row.length === 0) return refuse(LEASE_LOST);
  const record = single(row);
  const expires = integerOf(record.expires);
  const now = await storeClock(sql);
  if (record.open !== true || textOf(record.lease) !== c.lease || now >= expires) return refuse(LEASE_LOST);
  // 2. The business mutation, by the kind's own mutator.
  const applied = await c.mutator.apply(sql, c.mutation);
  if (applied === 'conflict') return refuse(CONFLICT);
  if (applied !== 'applied') return refuse(UNAVAILABLE);
  // 3. The audit record, through the existing writer, on this transaction and nowhere else.
  const executor: AuditSqlExecutor = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...values), {
    json: (value: unknown) => tx.json(value),
  });
  await writeAuditEvent(c.audit, { executor });
  // 4. The events: pending, due now by the store's clock, stamped with the transaction's timestamp.
  for (const e of c.events) {
    const inserted = await sql`insert into tmpos_internal.outbox_event (event_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, tenant_digest, store_digest, actor_digest, correlation_id, payload, occurred_at, status, attempt, due_at)
      values (${e.eventId}, ${e.type}, ${e.version}, ${e.aggregateType}, ${e.aggregateId}, ${ms(e.aggregateVersion)}::bigint,
        ${e.tenant}, ${e.store}, ${e.actor}, ${e.correlationId}, ${tx.json(e.payload)}, pg_catalog.now(), 'pending', 0,
        'epoch'::timestamptz + (${ms(now)}::bigint * interval '1 millisecond'))
      on conflict (event_id) do nothing`;
    if (inserted.count !== 1) return refuse(UNAVAILABLE); // an event ID that is not new is a fault, never a conflict
  }
  // 5. The sealed completion, under the lease this transaction has held since step 1.
  const completed = await sql`update tmpos_internal.idempotency_record set response = ${c.response}
    where scope = ${c.scope} and lease = ${c.lease} and response is null`;
  return completed.count === 1 ? COMMITTED : refuse(UNAVAILABLE);
}

function transactionPort(client: PgClient, mutators: ReadonlyMap<string, AggregateMutator>): CommandTransactionPort {
  return Object.freeze({
    async commit(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const command = commandOf(raw, mutators);
      if (!('mutator' in command)) return command;
      return transact(client, signal, TRANSACTION_BOUNDS, (sql, tx) => commit(sql, tx, command as Command));
    },
    probe: (signal: AbortSignal): Promise<boolean> =>
      probe(client, signal, (sql) => sql`select tmpos_internal.m6_store_clock() is not null
        and not exists (select from tmpos_internal.idempotency_record where false)
        and not exists (select from tmpos_internal.outbox_event where false) as ok`),
  });
}

// ---------------------------------------------------------------------------
// OutboxDeliveryStore
// ---------------------------------------------------------------------------

/** A claimed row as { eventId, attempt, envelope }, every column read once and typed — or the claim fails closed. */
function claimedOf(row: Readonly<Record<string, unknown>>): Answer {
  const eventId = textOf(row.event_id);
  const aggregateVersion = integerOf(row.aggregate_version);
  const occurredAt = integerOf(row.occurred_at);
  const { attempt, event_version: version, payload } = row;
  if (typeof attempt !== 'number' || typeof version !== 'number' || !isRecord(payload)) return refuse(UNAVAILABLE);
  return Object.freeze({
    eventId,
    attempt,
    envelope: Object.freeze({
      eventId, type: textOf(row.event_type), version, aggregateType: textOf(row.aggregate_type), aggregateId: textOf(row.aggregate_id),
      aggregateVersion, tenant: nullableTextOf(row.tenant_digest), store: nullableTextOf(row.store_digest), actor: nullableTextOf(row.actor_digest),
      correlationId: textOf(row.correlation_id), payload, occurredAt,
    }),
  });
}

/** Settle an event held under `claim`: lock it, check the claim, then apply `update` — or change nothing. */
async function settle(client: PgClient, signal: AbortSignal, raw: unknown, success: Answer, update: (sql: PgStatement, eventId: string) => Promise<PgRows>): Promise<Answer> {
  const fields = fieldsOf(raw, ['eventId', 'claim']);
  if (fields === null) return UNAVAILABLE;
  const { eventId, claim } = fields;
  if (typeof eventId !== 'string' || !UUID_V4_RE.test(eventId) || !isDigest(claim)) return CLAIM_LOST; // never a claim the store granted
  return transact(client, signal, DELIVERY_BOUNDS, async (sql) => {
    const rows = await sql`select status, claim_token from tmpos_internal.outbox_event where event_id = ${eventId} for update`;
    if (rows.length === 0) return refuse(CLAIM_LOST);
    const row = single(rows);
    // Only the claim's current holder settles — an expired claim nobody has reclaimed included.
    if (row.status !== 'claimed' || row.claim_token !== claim) return refuse(CLAIM_LOST);
    return (await update(sql, eventId)).count === 1 ? success : refuse(UNAVAILABLE);
  });
}

function deliveryPort(client: PgClient): OutboxDeliveryStore {
  return Object.freeze({
    async claim(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const fields = fieldsOf(raw, ['claim', 'limit', 'claimMs']);
      if (fields === null) return UNAVAILABLE;
      const { claim, limit, claimMs } = fields;
      if (!isDigest(claim) || !isInteger(limit, 1, MAX_CLAIM_BATCH) || !isInteger(claimMs, 1, MAX_CLAIM_MS)) return UNAVAILABLE;
      return transact(client, signal, DELIVERY_BOUNDS, async (sql) => {
        // ONE statement: one clock reading; the earliest due pending rows and the earliest expired claims, each
        // walked in its own index's order and locked with SKIP LOCKED so concurrent claims never wait on or share a
        // row; merged into (eligibility time, event ID) order and claimed under this token. A row a branch locked
        // beyond the merged limit stays as it was, and its lock ends at COMMIT. An expired claim that has already
        // had MAX_ATTEMPTS is never reclaimed: the same statement dead-letters it (attempts_exhausted), unpublished,
        // so no event is ever claimed a 21st time and none waits for a worker to retire it.
        const rows = await sql`with clock as materialized (select tmpos_internal.m6_store_clock() as t),
          due as materialized (
            select e.event_id, e.due_at as eligible_at
              from tmpos_internal.outbox_event e
             where e.status = 'pending' and e.due_at <= (select t from clock) and e.attempt < ${MAX_ATTEMPTS}
             order by e.due_at, e.event_id
             limit ${limit}
             for update of e skip locked
          ),
          expired as materialized (
            select e.event_id, e.claim_expires_at as eligible_at
              from tmpos_internal.outbox_event e
             where e.status = 'claimed' and e.claim_expires_at <= (select t from clock) and e.attempt < ${MAX_ATTEMPTS}
             order by e.claim_expires_at, e.event_id
             limit ${limit}
             for update of e skip locked
          ),
          spent as materialized (
            select e.event_id
              from tmpos_internal.outbox_event e
             where e.status = 'claimed' and e.claim_expires_at <= (select t from clock) and e.attempt >= ${MAX_ATTEMPTS}
             order by e.claim_expires_at, e.event_id
             limit ${limit}
             for update of e skip locked
          ),
          exhausted as (
            update tmpos_internal.outbox_event o
               set status = 'dead', claim_token = null, claim_expires_at = null, dead_reason = 'attempts_exhausted'
              from spent
             where o.event_id = spent.event_id
            returning o.event_id
          ),
          eligible as (
            select event_id, eligible_at from due
            union all
            select event_id, eligible_at from expired
            order by eligible_at, event_id
            limit ${limit}
          ),
          claimed as (
            update tmpos_internal.outbox_event o
               set status = 'claimed', attempt = o.attempt + 1, claim_token = ${claim},
                   claim_expires_at = (select t from clock) + (${ms(claimMs)}::bigint * interval '1 millisecond')
              from eligible
             where o.event_id = eligible.event_id
            returning o.event_id, o.attempt, eligible.eligible_at, o.event_type, o.event_version, o.aggregate_type, o.aggregate_id,
              o.aggregate_version::text as aggregate_version, o.tenant_digest, o.store_digest, o.actor_digest, o.correlation_id, o.payload,
              floor(extract(epoch from o.occurred_at) * 1000)::bigint::text as occurred_at
          )
          select x.spent, c.* from (select count(*)::int as spent from exhausted) x
            left join claimed c on true
           order by c.eligible_at, c.event_id`;
        // Always at least one row: how many spent claims the statement dead-lettered, beside each event it claimed.
        const spent: unknown = rows.length === 0 ? null : rows[0].spent;
        if (!isInteger(spent, 0, MAX_CLAIM_BATCH)) return refuse(UNAVAILABLE);
        const events = rows.filter((row) => row.event_id !== null);
        // Nothing claimed and nothing dead-lettered rolls back, so an idle claim is never indeterminate; a claim that
        // dead-lettered a spent event commits even when it hands nothing out.
        if (events.length === 0) return spent === 0 ? refuse(EMPTY) : EMPTY;
        if (events.length !== rows.length || events.length > limit) return refuse(UNAVAILABLE);
        return Object.freeze({ outcome: 'claimed', events: Object.freeze(events.map(claimedOf)) });
      });
    },
    acknowledge: (raw: unknown, signal: AbortSignal): Promise<Answer> => settle(client, signal, raw, answer('acknowledged'), (sql, eventId) =>
      sql`update tmpos_internal.outbox_event set status = 'delivered', claim_token = null, claim_expires_at = null where event_id = ${eventId}`),
    async retry(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const delayMs = fieldsOf(raw, ['delayMs'])?.delayMs;
      if (!isInteger(delayMs, 1, OUTBOX_DELIVERY_POLICY.maxDelayMs)) return UNAVAILABLE;
      // An event that has spent its attempts is never pending again: the retry changes nothing ('unavailable'), and
      // once its claim expires the next claim dead-letters it.
      return settle(client, signal, raw, answer('scheduled'), (sql, eventId) =>
        sql`update tmpos_internal.outbox_event set status = 'pending', claim_token = null, claim_expires_at = null,
          due_at = tmpos_internal.m6_store_clock() + (${ms(delayMs)}::bigint * interval '1 millisecond')
          where event_id = ${eventId} and attempt < ${MAX_ATTEMPTS}`);
    },
    async deadLetter(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const reason = fieldsOf(raw, ['reason'])?.reason;
      if (typeof reason !== 'string' || !DEAD_REASONS.includes(reason)) return UNAVAILABLE;
      return settle(client, signal, raw, answer('dead_lettered'), (sql, eventId) =>
        sql`update tmpos_internal.outbox_event set status = 'dead', claim_token = null, claim_expires_at = null, dead_reason = ${reason}
          where event_id = ${eventId}`);
    },
    probe: (signal: AbortSignal): Promise<boolean> =>
      probe(client, signal, (sql) => sql`select tmpos_internal.m6_store_clock() is not null
        and not exists (select from tmpos_internal.outbox_event where false) as ok`),
  });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function mutatorOf(raw: unknown): AggregateMutator {
  if (isRecord(raw) && hasExactKeys(raw, ['kind', 'mode', 'aggregateType', 'apply'])) {
    const { kind, mode, aggregateType, apply } = raw;
    if (isContractName(kind) && (mode === 'create' || mode === 'update') && typeof aggregateType === 'string' && AGGREGATE_TYPE_RE.test(aggregateType)
      && typeof apply === 'function') {
      return Object.freeze({ kind, mode, aggregateType, apply: apply as AggregateMutator['apply'] });
    }
  }
  throw new TypeError('transactional store mutator invalid');
}

/** The three ports over `client`. Validates the mutator table; opens nothing until a port is called. */
export function createPostgresTransactionalStore(options: TransactionalStoreOptions): TransactionalStore {
  const { client, mutators } = isRecord(options) ? options : ({} as Partial<TransactionalStoreOptions>);
  // A postgres.js pool is itself a function (its tagged template), so the client may be either shape.
  if ((typeof client !== 'object' && typeof client !== 'function') || client === null || typeof client.begin !== 'function' || !Array.isArray(mutators)) {
    throw new TypeError('transactional store options invalid');
  }
  const table = new Map<string, AggregateMutator>();
  for (const raw of mutators) {
    const mutator = mutatorOf(raw);
    if (table.has(mutator.kind)) throw new TypeError('transactional store mutator invalid');
    table.set(mutator.kind, mutator);
  }
  return Object.freeze({ idempotency: idempotencyPort(client), transactions: transactionPort(client, table), delivery: deliveryPort(client) });
}
