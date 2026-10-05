// Phase 4.0 M6 — the PostgreSQL transactional store: one database, one shared transaction kernel and three
// separate port implementations — DurableIdempotencyStore (server/runtime/idempotency.ts),
// CommandTransactionPort (commandTransaction.ts) and OutboxDeliveryStore (outbox.ts) — over migration 006's
// internal schema, tmpos_internal (G-IDEMPOT, G-AUDIT; docs/phase-4/10 ADR-17).
//
// COMPOSED BY THE TWO TRANSACTION ROOTS ALONE, each over its own kernel and for its own scope: the administrative root
// (server/composition/productionTransactions.ts) for platform-scope commands, and since M7A-CUSTOMERS-P3 the tenant root
// (server/composition/transactionKernel.ts, `contextScope: 'tenant'`) for tenant-scope ones — neither binds the outbox
// delivery port or a worker. A store admits contexts of its root's scope (and, for the tenant root since M7B-INVOICES-P1,
// store contexts for a store mutator), each re-proved by the revalidator its root hands it, and audits each command at
// exactly that scope. Deploying either still waits on a runtime LOGIN holding tmpos_app and
// tmpos_audit_writer (G-DBROLE) over a database where the migrations are applied (G-MIGRATE).
//
// What it is handed, and what it never holds. The caller hands it the transaction kernel (supervisedPgClient.ts) over the
// runtime principal's client options, which server/platform-identity/db.ts builds under the verified-TLS policy, and the
// closed table of business mutators, one per command kind, defined in trusted source. It constructs no client, opens
// nothing, reads no environment and keeps no state between calls; it never holds a pool, a reserved connection or a driver
// transaction, and a mutator is handed only the kernel's statement function — no savepoint, no nested transaction, no handle. Only values cross each
// port; every statement is fixed, schema-qualified text in this file or in a mutator, every value is bound
// as a parameter, and no caller supplies SQL, an identifier or a fragment.
//
// Authority. The runtime role holds no privilege on either store table (migration 006, section 4): this file
// names no table of the store at all, and reaches it only through 006's fixed lifecycle routines, which lock the
// rows they decide about, decide on the store's clock and change a record or an event only under the lease or
// claim token presented — a token the runtime role cannot read. So a mutator's SQL, which runs as the same role,
// can do no more to the store than a call to this adapter could.
//
// Time. Every expiry, retention and due-time decision is a routine's, on tmpos_internal.m6_store_clock() — the
// store's clock at millisecond resolution — read only AFTER the row it decides about is locked, except a claim,
// which never waits on a lock (SKIP LOCKED) and reads it once at the start of its one statement, choosing and
// stamping every row from that one reading. Migration 006's guard then re-checks each claimed row against its own,
// later reading, which admits everything the statement chose unless the database's clock steps back past a chosen
// row's eligibility instant — then the guard refuses and the whole claim fails closed; this file never retries it,
// and only a caller's next claim can try again. This process's clock is never read. A command's stamps (its audit
// record and each event) are the transaction's start, now(): audit_event.occurred_at's own default. Every stored
// time handed back as epoch milliseconds is bounded by migration 006 — finite and before the year 10 000, and for
// an event's occurrence also at or after the first readable millisecond, the lower end the envelope contract
// accepts — so no stored row can fail the read that hands it out.
//
// Bounds. Each call that reaches the database is one fresh transaction on one reserved connection, run by the kernel —
// a call refused at validation, or handed an already-aborted signal, opens none — under transaction-local lock and
// statement timeouts below its port deadline and an idle-in-transaction timeout at twice it, which ends a session its
// caller has left; an abort answers at once, cancels the statement in flight and rolls the transaction back. Nothing is
// retried: a lost race re-reads within the same transaction, and a failed transaction is never run again.
//
// Delivery policy. An event is claimed at most OUTBOX_DELIVERY_POLICY.maxAttempts (20) times, fixed in migration 006's
// claim routine and never passed to it: an expired claim at the cap is dead-lettered (attempts_exhausted) by the next
// claim instead of being reclaimed, and a retry at the cap is refused. 006's 1 000 is a storage-integrity ceiling,
// and its trigger enforces the delivery transitions themselves.
//
// M7B-INVOICES-P1 — STORE CONTEXTS, ROWS AND ONE TYPED SEALED REFUSAL. Every mutator DECLARES its context scope
// (`contextScope`, design R4: required, never defaulted — the mutator table refuses one without it); each earlier mutator
// states the scope it always had (platform for the administrative ones, tenant for the tenant ones), so they commit exactly
// as before. The tenant store admits the closed set {tenant, store}:
// a command commits only under a context of its MUTATOR's scope — a tenant mutator refuses a store context and a store
// mutator a tenant one — and is audited at exactly that scope (a store context's record names its tenant AND store, and an
// invoice draft's names the draft as subject_invoice_draft_id, migration 028). A change set may carry a `rows` field (a
// bounded list of flat records, outbox.ts) re-checked here as a frozen deep copy; an event payload never may. A create
// whose command carries the sealed 422 for 'customer_not_found' (commandTransaction.ts `sealedRefusal`) records it as the
// completion when its mutator answers that word having written nothing, as the sealed 409s are; and a store create's
// 'precondition_failed' is rolled back exactly as a tenant one's. The administrative store admits platform contexts alone.
//
// Outcomes. Every precondition is a routine's answer, so no error is ever read as a business answer: no SQLSTATE and no
// constraint maps to 'conflict', and a reused event ID is a fault. A refusal is rolled back and answered only once the
// kernel has the ROLLBACK acknowledged. Anything that leaves nothing committed — an error or a lost connection before
// COMMIT is handed to the driver, a server ERROR at COMMIT — is 'unavailable'. COMMIT handed over and never acknowledged
// may have committed or not, and the call rejects with one fixed message, which the runtime treats as indeterminate. No
// driver message, statement, parameter, identifier or stack is kept, logged or returned.
import { writeAuditEvent } from '../platform-identity/auditEventWriter.js';
import { isTrustedScope } from '../runtime/principals.js';
// A frozen copy of a trusted scope's eight scalar fields, or undefined when the value is not one.
// Every field is read exactly once, so the context validated is the context committed under, and a
// hostile getter cannot answer differently to the audit record and to the revalidation's parameters.
const trustedScopeOf = (raw: unknown): TrustedScope | undefined => {
  if (!isTrustedScope(raw)) return undefined;
  const { actor, securityVersion, scope, tenant, store, membershipId, roleId, limitation } = raw;
  const copy = Object.freeze({ actor, securityVersion, scope, tenant, store, membershipId, roleId, limitation });
  return isTrustedScope(copy) ? copy : undefined;
};
import type { TrustedScope } from '../runtime/principals.js';
import { TransactionFailure } from './supervisedPgClient.js';
import type { PgRows, PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import type { AuditEventWriteInput, AuditSqlExecutor } from '../platform-identity/auditEventWriter.js';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../runtime/commandTransaction.js';
import type { CommandContextScope, CommandTransactionPort, TransactionMutation } from '../runtime/commandTransaction.js';
import { IDEMPOTENCY_DEADLINE_MS, MAX_SEALED_LENGTH } from '../runtime/idempotency.js';
import type { DurableIdempotencyStore } from '../runtime/idempotency.js';
import {
  AGGREGATE_TYPE_RE, MAX_CHANGE_ROWS, MAX_CLAIM_BATCH, MAX_EVENTS_PER_COMMAND, MAX_RECORD_BYTES, MAX_ROWS_CHANGE_BYTES, MAX_ROW_FIELDS,
  OUTBOX_DEADLINE_MS, OUTBOX_DELIVERY_POLICY, UUID_RE, UUID_V4_RE, isContractName,
} from '../runtime/outbox.js';
import type { OutboxDeliveryStore } from '../runtime/outbox.js';

/** A statement's rows, with the number of rows it affected: the kernel's (supervisedPgClient.ts), named here too for mutators. */
export type { PgRows } from './supervisedPgClient.js';
/** One statement on the open transaction, through the kernel's gate. */
export type PgStatement = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<PgRows>;

/** How one command kind mutates its aggregate: trusted source, frozen at construction, never a caller's. */
export interface AggregateMutator {
  readonly kind: string;
  readonly mode: 'create' | 'update';
  readonly aggregateType: string;
  /**
   * The scope of the trusted context this mutator acts under (M7B-INVOICES-P1, design R4): REQUIRED, never defaulted —
   * 'platform' for an administrative mutator (the only scope the administrative store admits), 'tenant' or 'store' for a
   * tenant root's ('store' for the invoice draft create). A command commits only under a context of exactly this scope.
   */
  readonly contextScope: CommandContextScope;
  /**
   * Apply the mutation on the open transaction through fixed, parameterized statements: 'applied' once
   * exactly its row was created (mode create) or moved from expectedVersion to the next (mode update), or
   * 'conflict' when that precondition does not hold, having written nothing. An update may also answer 'not_found' — its aggregate
   * does not exist — 'invalid_state' — the aggregate is there at the expected version but its current state
   * does not admit this change, so nothing was written and no business state commits — only the sealed
   * rejection's own completion may (M5-GIAM-D1-P2; M5-GIAM-D1-P2-R1) — or 'unchanged'
   * — its changes already hold at expectedVersion, so it wrote nothing,
   * and it holds the aggregate's row locked until the transaction ends, so the store's completion of the
   * no-op is recorded at the moment it was decided (M5-GIAM-D1-P1-R1). Anything else — another answer, a
   * throw — commits nothing. A create in a tenant store may also answer 'precondition_failed' (M7A-CUSTOMERS-P4): a
   * precondition its caller asserted — the tenant or the version it reviewed — no longer holds, so it wrote nothing; unlike
   * 'conflict', that commits nothing at all, no completion either (commit, step 2a'). The role-level edit's mutator
   * answers it (postgresRoleLevels.ts), and since M7B-INVOICES-P1 the invoice draft create's, at store scope. A create whose
   * command carries the sealed 422 (M7B-INVOICES-P1) may answer 'customer_not_found' having written nothing: the store then
   * records that 422 as the completion and commits only it. `authority` is what this transaction revalidated before the mutator runs
   * (M7A-CUSTOMERS-P3): the store always hands it; a mutator that needs neither of its values ignores it, and one that
   * does treats its absence as a fault.
   */
  readonly apply: (sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority) => Promise<unknown>;
}

/**
 * What the store hands a mutator beside its mutation (M7A-CUSTOMERS-P3): the trusted context and the presenting session's
 * key THIS transaction revalidated — the store's own frozen checked copies, never the caller's. Both null for a
 * contextless command. The key is a session-bound definer routine's parameter and nothing else. Since M7A-CUSTOMERS-P3-R1
 * also the recent-authentication deadline the revalidator judged (null when the route requires none), so a mutator whose
 * routine can wait on a lock AFTER that judgment judges it again once the wait is over (postgresRoleLevels.ts).
 */
export interface MutationAuthority {
  readonly context: TrustedScope | null;
  readonly sessionKey: string | null;
  readonly authNotAfter: number | null;
}

/**
 * Re-reads a command's trusted context on the committing transaction's own handle: exactly true only while
 * the authority the command was authorized under still holds exactly — the actor, the security version, the
 * very grant and role selected, and the route's `permission` decided again on that role's current
 * definition (M5-GIAM-D1-P1-R1). Anything else, a throw included, commits nothing. The store is handed it
 * rather than owning it, so no authorization policy lives in persistence and a command can be proven
 * against a synthetic revalidator with no database at all.
 */
export type ContextRevalidator = (
  sql: PgTransactionScope,
  scope: TrustedScope,
  permission: string,
  /**
   * When this attempt's trusted authentication evidence goes stale (epoch ms), for a command whose route
   * required a recent authentication — judged against the DATABASE's clock, not this process's, so a
   * request that was fresh when the chain admitted it cannot commit once the evidence has expired
   * (M5-GIAM-D1-P2). null when the route required none, and then no freshness is checked.
   */
  authNotAfter: number | null,
  /**
   * The store key of the session that presented the command (M5-ADMIN-REVOKE-P1; a tenant session since
   * M7A-CUSTOMERS-P3), or null: the revalidator holds that session's row on this transaction and re-reads the standing it
   * is bound to, so the command commits only while it is live. Bound as a parameter of those reads — and, for a tenant
   * command, of its mutator's session-bound routine (MutationAuthority) — and nothing else: never audited, logged,
   * evented or returned.
   */
  sessionKey: string | null,
) => Promise<boolean>;

export interface TransactionalStoreOptions {
  readonly client: SupervisedPgClient;
  readonly mutators: readonly AggregateMutator[];
  /**
   * Required once a command may carry a trusted context. Absent, the store commits only contextless
   * commands and refuses every command that carries one — it never commits one unrevalidated.
   */
  readonly revalidate?: ContextRevalidator;
  /**
   * The root scope whose contexts this store's revalidator re-proves (M7A-CUSTOMERS-P3): 'platform' — the default, the
   * administrative root's store, unchanged — or 'tenant', the tenant root's, which requires `revalidate` and refuses every
   * contextless command. The tenant store also admits STORE contexts (M7B-INVOICES-P1) — for a mutator that declares store
   * scope, and only for it; the administrative store admits platform contexts alone.
   */
  readonly contextScope?: 'platform' | 'tenant';
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
/** A precondition the command asserted no longer holds: rolled back, nothing recorded (M7A-CUSTOMERS-P4). */
const PRECONDITION_FAILED = answer('precondition_failed');
const NOT_FOUND = answer('not_found');
/** The aggregate is there at the expected version, but its current state does not allow this change. */
const INVALID_STATE = answer('invalid_state');
const UNCHANGED = answer('unchanged');
/** A create's typed sealed refusal (M7B-INVOICES-P1): its sealed 422 recorded as the completion, nothing else written. */
const CUSTOMER_NOT_FOUND = answer('customer_not_found');
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
const MAX_PERMISSION_LENGTH = 128;
const DEAD_REASONS: readonly string[] = ['attempts_exhausted', 'envelope_invalid'];
const COMMAND_FIELDS: readonly string[] = ['scope', 'lease', 'response', 'unchanged', 'rejected', 'mutation', 'audit', 'events', 'context', 'authNotAfter', 'sessionKey'];
/** The sealed responses for the deterministic post-authorization rejections (M5-GIAM-D1-P2-R1; M7B-INVOICES-P1's typed 422). */
const REJECTED_FIELDS: readonly string[] = ['conflict', 'invalidState', 'customerNotFound'];
const MUTATION_FIELDS: readonly string[] = ['kind', 'aggregateType', 'aggregateId', 'expectedVersion', 'changes'];
const AUDIT_FIELDS: readonly string[] = ['action', 'permission', 'scope', 'tenant', 'store', 'actor', 'correlationId', 'reasonCode', 'reason'];
/** A closed lowercase token naming what an audited action did; the runtime validated it before it got here. */
const REASON_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** 500 Unicode scalar values at two UTF-16 units each: the bound the runtime's own contract applies. */
const MAX_REASON_LENGTH = 1_000;
/**
 * The characters a recorded reason may not carry, re-checked here independently of the runtime that built
 * it: controls, the line and paragraph separators, a lone surrogate and every Bidi_Control character. The
 * value is kept verbatim in a durable, append-only row people read, so two layers refuse it, not one.
 */
const REASON_REFUSED_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}|\p{Bidi_Control}/u;
const EVENT_FIELDS: readonly string[] = [
  'eventId', 'type', 'version', 'aggregateType', 'aggregateId', 'aggregateVersion', 'tenant', 'store', 'actor', 'correlationId', 'payload',
];
/** Who the audit record says wrote it: this adapter, for a command the runtime chain authorized. */
export const COMMAND_AUDIT_EVALUATED_BY = 'm6_postgres_command_transaction@v1';
/** The aggregate type whose commands name their target as the audit record's subject tenant (migration 009). */
const TENANT_AGGREGATE = 'tenant';
/** The aggregate type whose UPDATE commands name their target as the audit record's subject customer (migration 024). */
const CUSTOMER_AGGREGATE = 'customer';
/** The aggregate type whose CREATE commands name the new draft as the audit record's subject (migration 028). */
const INVOICE_DRAFT_AGGREGATE = 'invoice_draft';
/** The context scopes each root's store admits (M7B-INVOICES-P1): a mutator's declared scope must be one of its root's. */
const ADMITTED_SCOPES: Readonly<Record<'platform' | 'tenant', readonly CommandContextScope[]>> = Object.freeze({
  platform: Object.freeze(['platform'] as const), tenant: Object.freeze(['tenant', 'store'] as const),
});

/** Transaction-local bounds under a port deadline: lock waits, then any one statement, then an idle transaction. */
const boundsUnder = (deadlineMs: number): TransactionBounds => Object.freeze({
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
type ChangeRecord = Readonly<Record<string, string | number | boolean | readonly ScalarRecord[]>>;
/**
 * A command's change set re-checked at this boundary (M7B-INVOICES-P1): scalarRecordOf's rules for every scalar field, and
 * a `rows` field — a plain array of at most MAX_CHANGE_ROWS plain records of at most MAX_ROW_FIELDS scalars each, each row
 * read once into a frozen copy (scalarRecordOf) — as a frozen list. At most MAX_ROWS_CHANGE_BYTES serialized when a rows
 * field is present, otherwise MAX_RECORD_BYTES, so a scalar-only change set is judged exactly as before. Or null.
 */
function changeRecordOf(v: unknown): ChangeRecord | null {
  if (!isRecord(v)) return null;
  const keys = Object.keys(v);
  if (Reflect.ownKeys(v).length !== keys.length) return null;
  const entries: [string, string | number | boolean | readonly ScalarRecord[]][] = [];
  let rows = false;
  for (const key of keys) {
    const x: unknown = v[key];
    if (Array.isArray(x)) {
      if (Object.getPrototypeOf(x) !== Array.prototype) return null;
      const count = x.length; // read once: the bound checked is the bound the loop runs to
      if (count > MAX_CHANGE_ROWS) return null;
      const copy: ScalarRecord[] = [];
      // inv: copy holds a checked frozen copy of each row below i; term: i rises to count (at most MAX_CHANGE_ROWS).
      for (let i = 0; i < count; i++) {
        const row = i in x ? scalarRecordOf(x[i]) : null;
        if (row === null || Object.keys(row).length > MAX_ROW_FIELDS) return null;
        copy.push(row);
      }
      entries.push([key, Object.freeze(copy)]);
      rows = true;
    } else {
      if (typeof x !== 'boolean' && typeof x !== 'string' && !isInteger(x, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) return null;
      entries.push([key, x]);
    }
  }
  const copy: ChangeRecord = Object.freeze(Object.fromEntries(entries));
  return Buffer.byteLength(JSON.stringify(copy), 'utf8') <= (rows ? MAX_ROWS_CHANGE_BYTES : MAX_RECORD_BYTES) ? copy : null;
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
 * The kernel: `work` in one transaction under `limits`. Its answer once committed, or the answer a Rollback carried once
 * rolled back; 'unavailable' whenever nothing committed; a rejection with OUTCOME_UNKNOWN only when COMMIT was handed to
 * the driver and never acknowledged.
 */
async function transact(client: SupervisedPgClient, signal: AbortSignal, limits: TransactionBounds, work: (sql: PgTransactionScope) => Promise<Answer>): Promise<Answer> {
  if (signal.aborted) return UNAVAILABLE;
  try {
    return await client.transaction(signal, limits, work);
  } catch (err) {
    if (err instanceof Rollback) return err.answer;
    if (err === TransactionFailure.outcomeUnknown) throw new Error(OUTCOME_UNKNOWN);
    return UNAVAILABLE;
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

/** Every port's readiness: 006's probe routine answers exactly true. */
async function probe(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  try {
    const result = await transact(client, signal, IDEMPOTENCY_BOUNDS, async (sql) =>
      (single(await sql`select tmpos_internal.m6_store_probe() as ok`).ok === true ? READY : UNAVAILABLE));
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

/** 006's acquisition routine, answered as the port answers: an acquisition commits; every refusal rolls back, changing nothing. */
async function acquire(sql: PgStatement, r: AcquireRequest): Promise<Answer> {
  const row = single(await sql`select o_outcome, o_response from tmpos_internal.m6_idempotency_acquire(${r.scope}::text, ${r.fingerprint}::text,
    ${r.lease}::text, ${ms(r.leaseMs)}::bigint, ${ms(r.retentionMs)}::bigint)`);
  switch (row.o_outcome) {
    case 'acquired': return ACQUIRED;
    case 'reclaimed': return RECLAIMED;
    case 'in_progress': return refuse(IN_PROGRESS);
    case 'conflict': return refuse(CONFLICT);
    case 'replay': return refuse(Object.freeze({ outcome: 'replay', response: textOf(row.o_response) }));
    default: return refuse(UNAVAILABLE);
  }
}

/** 006's completion routine: true once the response is stored under exactly this lease, within retention. */
async function completed(sql: PgStatement, scope: string, lease: string, response: string): Promise<boolean> {
  const { outcome } = single(await sql`select tmpos_internal.m6_idempotency_complete(${scope}::text, ${lease}::text, ${response}::text) as outcome`);
  return outcome === 'completed' ? true : outcome === 'lease_lost' ? false : refuse(UNAVAILABLE);
}

function idempotencyPort(client: SupervisedPgClient): DurableIdempotencyStore {
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
      return transact(client, signal, IDEMPOTENCY_BOUNDS, async (sql) => ((await completed(sql, scope, lease, response)) ? COMPLETED : refuse(LEASE_LOST)));
    },
    probe: (signal: AbortSignal): Promise<boolean> => probe(client, signal),
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
  readonly scope: string; readonly lease: string; readonly response: string; readonly unchanged: string | null;
  /** The sealed refusal this transaction records as the completion when it determines that rejection, in it. */
  readonly rejected: Readonly<{ conflict: string; invalidState: string | null; customerNotFound: string | null }>;
  readonly mutator: AggregateMutator; readonly mutation: TransactionMutation; readonly audit: AuditEventWriteInput;
  readonly events: readonly EventDraft[]; readonly context: TrustedScope | null;
  /** When this attempt's trusted authentication evidence goes stale, or null when its route required none. */
  readonly authNotAfter: number | null;
  /** The presenting session's store key, or null (M5-ADMIN-REVOKE-P1). A SQL parameter only. */
  readonly sessionKey: string | null;
  /** The context and key the mutator is handed once they are revalidated: the frozen copies above. */
  readonly authority: MutationAuthority;
}


/**
 * A command in contract, re-checked at the store's boundary: LEASE_LOST when its fence can never match a
 * granted lease; UNAVAILABLE when anything else is malformed or no mutator serves its kind. Only a command of
 * the store's own `contextScope` commits (M7A-CUSTOMERS-P3): the administrative store's platform-scope ones —
 * contextless included — or the tenant store's tenant-scope ones, each audited at exactly that scope. Since
 * M7B-INVOICES-P1 the scope is the mutator's DECLARED one (required, never the store's by default) and the tenant store
 * also admits a store scope — for a store mutator alone. An event names no tenant, store or actor in any case — those columns are keyed
 * digests in migration 006, and this stage keys none. Since M5-ID-P1 the AUDIT record names the app-owned actor
 * whenever a trusted context is carried.
 */
function commandOf(raw: unknown, mutators: ReadonlyMap<string, AggregateMutator>, contextScope: 'platform' | 'tenant'): Command | Answer {
  // M7B-INVOICES-P1: the scope a command must carry is its MUTATOR's declared one — no fallback — and one of the scopes
  // this store's root admits ({platform} for the administrative store, {tenant, store} for the tenant store).
  try {
    if (!isRecord(raw) || !hasExactKeys(raw, COMMAND_FIELDS)) return UNAVAILABLE;
    const { scope, lease, response, unchanged, rejected: rawRejected, mutation, audit, events, context: rawContext, authNotAfter, sessionKey } = raw;
    // The instant this attempt's trusted authentication evidence goes stale, when its route required one
    // (M5-GIAM-D1-P2). Read once here and judged inside the transaction against the database's clock.
    if (authNotAfter !== null && !isInteger(authNotAfter, 1, Number.MAX_SAFE_INTEGER)) return UNAVAILABLE;
    // The presenting session's store key (M5-ADMIN-REVOKE-P1), read once: null, or exactly a session key's shape — the
    // SHA-256 digest of the identifier in base64url (sessions.ts digestOf), 43 characters.
    if (sessionKey !== null && !isDigest(sessionKey)) return UNAVAILABLE;
    if (!isDigest(scope) || !isDigest(lease)) return LEASE_LOST;
    if (!isSealed(response) || response.length === 0 || !isRecord(mutation) || !hasExactKeys(mutation, MUTATION_FIELDS)) return UNAVAILABLE;
    const { kind, aggregateType, aggregateId, expectedVersion, changes: rawChanges } = mutation;
    const mutator = typeof kind === 'string' ? mutators.get(kind) : undefined;
    if (mutator === undefined || aggregateType !== mutator.aggregateType || typeof aggregateId !== 'string' || !UUID_RE.test(aggregateId)) return UNAVAILABLE;
    if (mutator.mode === 'create' ? expectedVersion !== null : !isInteger(expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1)) return UNAVAILABLE;
    // An unchanged response belongs to an update alone, and is sealed text exactly like the response.
    if (unchanged !== null && (mutator.mode !== 'update' || !isSealed(unchanged) || unchanged.length === 0)) return UNAVAILABLE;
    // The two sealed deterministic rejections, read once and re-checked here (M5-GIAM-D1-P2-R1). Every
    // command carries a conflict; only an update can be in a state that refuses its change, so a create
    // must carry no invalidState and an update must carry one — a command missing the response for the
    // rejection its own mode can reach would otherwise reach the commit and roll back there instead.
    if (!isRecord(rawRejected) || !hasExactKeys(rawRejected, REJECTED_FIELDS)) return UNAVAILABLE;
    const { conflict, invalidState, customerNotFound } = rawRejected;
    if (!isSealed(conflict) || conflict.length === 0) return UNAVAILABLE;
    if (mutator.mode === 'update' ? !(isSealed(invalidState) && invalidState.length > 0) : invalidState !== null) return UNAVAILABLE;
    // The typed sealed 422 (M7B-INVOICES-P1): null, or sealed text on a create alone — an update never carries one.
    if (customerNotFound !== null && (mutator.mode !== 'create' || !isSealed(customerNotFound) || customerNotFound.length === 0)) return UNAVAILABLE;
    const changes = changeRecordOf(rawChanges);
    if (changes === null || !isRecord(audit) || !hasExactKeys(audit, AUDIT_FIELDS)) return UNAVAILABLE;
    // The trusted context, read once. A command carries one or it does not; anything that is not a
    // trusted scope is not a context, and a context this store cannot revalidate is never committed.
    // Read once and COPIED, like every other value at this boundary: a getter that answered one way
    // here and another way when the revalidation binds its parameters would otherwise let a command
    // be proved against one actor and audited as another.
    const context = rawContext === null ? null : trustedScopeOf(rawContext);
    if (context === undefined) return UNAVAILABLE;
    // A freshness claim with no actor to hold it is not one this store can judge, and it is refused here —
    // at validation, before a transaction is opened — rather than inside the commit.
    if (context === null && authNotAfter !== null) return UNAVAILABLE;
    // Likewise a session key: with no context there is no revalidation to hold the session in, and a key this store
    // would carry unread is a key it was handed for nothing.
    if (context === null && sessionKey !== null) return UNAVAILABLE;
    // A command is a write. A context the resolver marked read-only — because the account, the tenant
    // or the store is `read_only` or `overdue` — may not perform one, and that limiting is applied
    // here rather than left to a caller who might forget it.
    if (context !== null && context.limitation !== 'none') return UNAVAILABLE;
    // Only a context of the scope this store's revalidator re-proves commits here (M7A-CUSTOMERS-P3): the administrative
    // store's platform contexts, contextless commands included, or the tenant store's tenant contexts — never a
    // contextless command there, whose tenant nothing would prove. Any other is refused rather than audited at a scope
    // this transaction cannot prove. M7B-INVOICES-P1: the scope is the MUTATOR's declared one (never defaulted) and must
    // be one this store's root admits; so the tenant store commits a store context only for a store mutator, and a tenant
    // mutator never under a store context (nor a store mutator under a tenant one).
    const required = mutator.contextScope;
    if (!ADMITTED_SCOPES[contextScope].includes(required)) return UNAVAILABLE;
    if (context === null ? required !== 'platform' : context.scope !== required) return UNAVAILABLE;
    const { action, permission, scope: auditScope, tenant, store, actor, correlationId, reasonCode, reason } = audit;
    // The record is audited at exactly the context's scope. Migration 005's audit policy checks the tuple's shape alone,
    // not the session's context, so this equality — with the tenant, store and actor checks below — is the provenance
    // (G-AUDIT: TypeScript-only).
    if (action !== kind || auditScope !== (context === null ? 'platform' : context.scope)) return UNAVAILABLE;
    // The bounded reason pair a sensitive command records: both present or both absent, each within the
    // same bounds the runtime's own contract applied. A reason with no code, or a code with no reason,
    // is not a pair this store will write.
    if ((reasonCode === null) !== (reason === null)) return UNAVAILABLE;
    if (reasonCode !== null && (typeof reasonCode !== 'string' || !REASON_CODE_RE.test(reasonCode))) return UNAVAILABLE;
    if (reason !== null && (typeof reason !== 'string' || reason.length === 0 || reason.length > MAX_REASON_LENGTH || REASON_REFUSED_RE.test(reason))) return UNAVAILABLE;
    // With no context the audit names no tenant, store or actor, exactly as before. With one, it names
    // that context's own values and nothing else — never a value the caller chose independently.
    if (tenant !== (context === null ? null : context.tenant) || store !== (context === null ? null : context.store)
      || actor !== (context === null ? null : context.actor)) return UNAVAILABLE;
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
      if (aggregateVersion !== version || eventCorrelationId !== correlationId) return UNAVAILABLE;
      // An event's tenant, store and actor are KEYED DIGESTS in migration 006, not identifiers
      // (outbox_event_digest_chk), and this stage defines no keying for them. They therefore stay
      // null even under a trusted context — the actor is attributed on the audit record, whose
      // column is the app-owned uuid itself. Naming one here would abort the whole transaction.
      if (eventTenant !== null || eventStore !== null || eventActor !== null) return UNAVAILABLE;
      const payload = scalarRecordOf(rawPayload);
      if (payload === null) return UNAVAILABLE;
      drafts.push(Object.freeze({
        eventId, type, version: eventVersion, aggregateType: mutator.aggregateType, aggregateId, aggregateVersion: version,
        tenant: null, store: null, actor: null, correlationId, payload,
      }));
    }
    const auditEvent: AuditEventWriteInput = {
      requestId: correlationId, traceId: null, actorInternalUserId: context === null ? null : context.actor,
      actorAuthProvider: null, onBehalfOfInternalUserId: null,
      // The scope, tenant and store proven equal to the context's above: platform with neither, a tenant with no store, or
      // (M7B-INVOICES-P1) a store with its tenant — migration 005's consistency rule, which the writer re-checks.
      scopeType: auditScope as CommandContextScope, tenantId: tenant as string | null, storeId: store as string | null,
      actionId: kind as string, requiredPermission: permission, decision: 'allow',
      // A sensitive command's own bounded pair when it carries one — the transition it performed, and the
      // operator's words as its planner validated them (M5-GIAM-D1-P2) — otherwise the fixed pair every
      // command has always written. Neither is ever taken from a caller-named audit field: the runtime
      // built both from the plan its own contract accepted.
      reasonCode: reasonCode === null ? 'command_committed' : reasonCode as string,
      humanReadableReason: reason === null
        ? 'An authorized command committed atomically with its idempotency completion and outbox events.'
        : reason as string,
      resultStatus: 'succeeded', sourceOfTruth: 'command_transaction', evaluatedBy: COMMAND_AUDIT_EVALUATED_BY, evidenceLevel: 'durable_compliance_event', metadata: {},
      // The record's direct subject (migration 009): a tenant command's own target — the aggregate ID checked
      // above, which its mutator locks and changes — never a value the caller's audit record names. So the
      // record finds its tenant without the outbox event it shares a correlation with.
      subjectTenantId: mutator.aggregateType === TENANT_AGGREGATE ? aggregateId : null,
      // M7A-CUSTOMERS-P7 (migration 024): a customer UPDATE names its target customer the same way — the aggregate ID
      // checked above, which its mutator locks in the session's tenant. A customer create names none (DA-111 unchanged).
      subjectCustomerId: mutator.aggregateType === CUSTOMER_AGGREGATE && mutator.mode === 'update' ? aggregateId : null,
      // M7B-INVOICES-P1 (migration 028): an invoice draft CREATE names the draft it made — the runtime's new aggregate id
      // checked above, which its mutator inserted in the context's tenant and store.
      subjectInvoiceDraftId: mutator.aggregateType === INVOICE_DRAFT_AGGREGATE && mutator.mode === 'create' ? aggregateId : null,
    };
    // The mutator is handed this copy — the values checked above, frozen — never the caller's live object.
    const checked: TransactionMutation = Object.freeze({
      kind: mutator.kind, aggregateType: mutator.aggregateType, aggregateId, expectedVersion: expectedVersion as number | null, changes,
    });
    return Object.freeze({
      scope, lease, response, unchanged: unchanged as string | null,
      rejected: Object.freeze({
        conflict: conflict as string, invalidState: (invalidState ?? null) as string | null, customerNotFound: (customerNotFound ?? null) as string | null,
      }),
      mutator, mutation: checked, audit: auditEvent, events: Object.freeze(drafts), context,
      authNotAfter: authNotAfter as number | null, sessionKey: sessionKey as string | null,
      authority: Object.freeze({ context, sessionKey: sessionKey as string | null, authNotAfter: authNotAfter as number | null }),
    });
  } catch {
    return UNAVAILABLE; // a hostile getter: not in contract
  }
}

/** The command in the order the contract fixes: fence, mutation, audit, events, completion — then COMMIT. */
async function commit(sql: PgTransactionScope, c: Command, revalidate: ContextRevalidator | null): Promise<Answer> {
  // 1. The fence, before any business state: the routine locks the record for the rest of the transaction, then reads
  //    the clock — held iff within retention, in progress and under exactly this lease.
  if (single(await sql`select tmpos_internal.m6_command_fence(${c.scope}::text, ${c.lease}::text) as held`).held !== true) return refuse(LEASE_LOST);
  // 1b. The trusted context, re-read on THIS transaction before any business state is touched
  //     (M5-ID-P1; docs/phase-4/08 G-CPLOGIN). The lease is judged first and learns nothing about the
  //     actor, so a stale attempt still answers 'lease_lost' and no more. A context that no longer
  //     holds — a suspended account, a moved security version, a withdrawn membership, a suspended
  //     tenant or store, a grant added, duplicated, replaced or re-roled, a permission the role no
  //     longer carries — rolls the whole transaction back: no mutation, no completion, no audit
  //     record, no event. The refusal is 'unavailable', the same answer an outage gives, so nothing
  //     distinguishes a revoked actor from a database that could not answer. The permission is the
  //     route's own requirement, which the runtime put on the audit record (M5-GIAM-D1-P1-R1). Since
  //     M5-ADMIN-REVOKE-P1 it also holds the presenting session's row and re-reads that session's standing
  //     here, so a logout, a revocation or a removal-and-restoration that committed first refuses the command
  //     the same way, and one that comes later waits for this COMMIT.
  if (c.context !== null) {
    if (revalidate === null) return refuse(UNAVAILABLE);
    if ((await revalidate(sql, c.context, c.audit.requiredPermission, c.authNotAfter, c.sessionKey)) !== true) return refuse(UNAVAILABLE);
  }
  // 2. The business mutation, by the kind's own mutator. An update whose aggregate is absent wrote nothing and
  //    rolls back, so no completion, audit record or event exists for it.
  // A sealed rejection COMMITS (M5-GIAM-D1-P2-R1), so — unlike the rollback it replaced — it would carry
  // anything the mutator had written before deciding to refuse. The mutator contract forbids that: a
  // mutator answers 'conflict' or 'invalid_state' having written nothing. The store CANNOT verify it
  // here: the kernel's statement gate admits DML only, so a SAVEPOINT around the mutation is not
  // available to this file (supervisedPgClient.ts: 'Anything else — transaction control, SAVEPOINT,
  // COPY, SET, DO, CALL, LOCK — is refused before the driver is asked'). The guarantee is therefore the
  // mutator's, stated in its contract above and held by both registered mutators, each of which decides
  // and writes inside one fixed definer routine. Recorded as DA-36.
  const applied = await c.mutator.apply(sql, c.mutation, c.authority);
  // 2a. The aggregate is not at the version this request named (M5-GIAM-D1-P2-R1). The mutator wrote
  //     nothing, and still holds whatever row it read under the lease this transaction fenced at step 1
  //     and the authority it revalidated at step 1b — so the rejection is a decided property of the
  //     intent, and its sealed 409 is recorded as the completion HERE and commits with that decision.
  //     Nothing else is written: no mutation, no audit record, no event. The key is then terminal for
  //     the rest of its retention, so the same intent can never be replanned into a mutation; an
  //     identical retry replays this exact 409 instead. A completion that does not hold — a lease
  //     reclaimed, or a retention that ended while this transaction ran — rolls the whole thing back to
  //     'unavailable', which records nothing and leaves the lease to expire as it did before.
  if (applied === 'conflict') return (await completed(sql, c.scope, c.lease, c.rejected.conflict)) ? CONFLICT : refuse(UNAVAILABLE);
  // 2a'. A precondition the client asserted no longer holds (M7A-CUSTOMERS-P4; DA-125): the owner's role-level edit named a
  //     tenant the session is no longer admitted to, or a version another edit has since moved. The mutator wrote nothing
  //     that survives — the whole transaction is ROLLED BACK here, and the idempotency record stays as its own acquisition
  //     left it, in progress under this lease — so unlike the sealed conflict above NOTHING is recorded: no mutation, no
  //     audit record, no event and NO completion (the brief: "a refused precondition writes no role edit or
  //     audit/completion"). The key is therefore not terminal: its lease,
  //     acquired in its own transaction before this one, waits out its time as it does for every rolled-back refusal, so an
  //     identical retry is 409 request_in_progress until it expires and is then planned and decided again — against the
  //     state it finds then. A retry asserting another tenant or version is another body, so another fingerprint: 422 under
  //     this key. Admitted only from a create in a tenant store with its revalidated context — the one shape the role-level
  //     edit has — and anything else answering it is the fault below. M7B-INVOICES-P1: or a create in a STORE context (the
  //     invoice draft's expectedTenant is not the store's tenant), rolled back exactly the same way.
  if (applied === 'precondition_failed' && c.mutator.mode === 'create' && c.context !== null
    && (c.context.scope === 'tenant' || c.context.scope === 'store')) {
    return refuse(PRECONDITION_FAILED);
  }
  // 2a''. A create's typed sealed refusal (M7B-INVOICES-P1): the invoice draft's customer is missing from the context's
  //     tenant, or is another tenant's — one answer for both. The mutator decided it after the authority was established and
  //     BEFORE writing anything (DA-36: a sealed answer commits whatever came before it), so — as for the sealed 409s above —
  //     its sealed 422 is recorded as the completion HERE and commits with that decision, and nothing else is written: no
  //     draft, no line, no audit record, no event. Only a command that carries that 422 may answer it; any other is the fault
  //     below and commits nothing.
  if (applied === 'customer_not_found' && c.mutator.mode === 'create') {
    if (c.rejected.customerNotFound === null) return refuse(UNAVAILABLE);
    return (await completed(sql, c.scope, c.lease, c.rejected.customerNotFound)) ? CUSTOMER_NOT_FOUND : refuse(UNAVAILABLE);
  }
  if (c.mutator.mode === 'update' && applied === 'not_found') return refuse(NOT_FOUND);
  // 2b. The aggregate is there at the expected version, but its current state does not admit this change —
  //     a lifecycle transition from the wrong state, or to the state it already holds (M5-GIAM-D1-P2).
  //     Sealed and recorded exactly as the conflict above, and for the same reason.
  if (c.mutator.mode === 'update' && applied === 'invalid_state') {
    if (c.rejected.invalidState === null) return refuse(UNAVAILABLE);
    return (await completed(sql, c.scope, c.lease, c.rejected.invalidState)) ? INVALID_STATE : refuse(UNAVAILABLE);
  }
  // 2c. Changes already in place (M5-GIAM-D1-P1-R1): the mutator moved nothing and still holds the aggregate's row
  //     locked, so the no-op's sealed response is recorded as the completion HERE, under the lease held since step 1,
  //     and commits with the decision — no change can land between them, and a retry replays exactly it. Nothing
  //     else is written: no audit record and no event, since nothing changed. A command with no unchanged response,
  //     or a completion that does not hold, commits nothing.
  if (c.mutator.mode === 'update' && applied === 'unchanged') {
    if (c.unchanged === null) return refuse(UNAVAILABLE);
    return (await completed(sql, c.scope, c.lease, c.unchanged)) ? UNCHANGED : refuse(UNAVAILABLE);
  }
  if (applied !== 'applied') return refuse(UNAVAILABLE);
  // 3. The audit record, through the existing writer, on this transaction and nowhere else. Exactly one row INSERTed, or
  //    the whole transaction rolls back (M7A-CUSTOMERS-P3, decision R6): a BEFORE INSERT trigger answering NULL would
  //    otherwise drop the record while the mutation and its completion committed — the session store's rule, here too.
  let audited = false;
  const executor: AuditSqlExecutor = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]): Promise<void> => {
    const result = await sql(strings, ...values);
    if (Reflect.get(result, 'command') !== 'INSERT' || result.count !== 1) refuse(UNAVAILABLE);
    audited = true;
  }, {
    json: (value: unknown) => sql.json(value),
  });
  await writeAuditEvent(c.audit, { executor });
  if (!audited) return refuse(UNAVAILABLE);
  // 4. The events, each under the fence: pending, due now by the store's clock, stamped with the transaction's timestamp.
  for (const e of c.events) {
    const { inserted } = single(await sql`select tmpos_internal.m6_command_enqueue(${c.scope}::text, ${c.lease}::text, ${e.eventId}::uuid,
      ${e.type}::text, ${e.version}::integer, ${e.aggregateType}::text, ${e.aggregateId}::uuid, ${ms(e.aggregateVersion)}::bigint,
      ${e.tenant}::text, ${e.store}::text, ${e.actor}::text, ${e.correlationId}::uuid, ${sql.json(e.payload)}::jsonb) as inserted`);
    if (inserted !== true) return refuse(UNAVAILABLE); // an event ID that is not new is a fault, never a conflict
  }
  // 5. The sealed completion, under the lease this transaction has held since step 1. Each routine from step 4 on judges retention
  //    again: a transaction that outlived it commits nothing ('unavailable') rather than a completion no request could replay.
  return (await completed(sql, c.scope, c.lease, c.response)) ? COMMITTED : refuse(UNAVAILABLE);
}

function transactionPort(client: SupervisedPgClient, mutators: ReadonlyMap<string, AggregateMutator>, revalidate: ContextRevalidator | null,
  contextScope: 'platform' | 'tenant'): CommandTransactionPort {
  return Object.freeze({
    async commit(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const command = commandOf(raw, mutators, contextScope);
      if (!('mutator' in command)) return command;
      return transact(client, signal, TRANSACTION_BOUNDS, (sql) => commit(sql, command as Command, revalidate));
    },
    probe: (signal: AbortSignal): Promise<boolean> => probe(client, signal),
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

/**
 * Settle an event held under `claim` through `routine`, 006's settlement for it, which locks the event, checks the
 * claim and changes it only under exactly that token: `success` for its `done` word, CLAIM_LOST for claim_lost —
 * nothing changed — and anything else (a retry at the cap, answered 'exhausted') rolls back as UNAVAILABLE.
 */
async function settle(client: SupervisedPgClient, signal: AbortSignal, raw: unknown, done: string, success: Answer,
  routine: (sql: PgStatement, eventId: string, claim: string) => Promise<PgRows>): Promise<Answer> {
  const fields = fieldsOf(raw, ['eventId', 'claim']);
  if (fields === null) return UNAVAILABLE;
  const { eventId, claim } = fields;
  if (typeof eventId !== 'string' || !UUID_V4_RE.test(eventId) || !isDigest(claim)) return CLAIM_LOST; // never a claim the store granted
  return transact(client, signal, DELIVERY_BOUNDS, async (sql) => {
    const { outcome } = single(await routine(sql, eventId, claim));
    return outcome === done ? success : refuse(outcome === 'claim_lost' ? CLAIM_LOST : UNAVAILABLE);
  });
}

function deliveryPort(client: SupervisedPgClient): OutboxDeliveryStore {
  return Object.freeze({
    async claim(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const fields = fieldsOf(raw, ['claim', 'limit', 'claimMs']);
      if (fields === null) return UNAVAILABLE;
      const { claim, limit, claimMs } = fields;
      if (!isDigest(claim) || !isInteger(limit, 1, MAX_CLAIM_BATCH) || !isInteger(claimMs, 1, MAX_CLAIM_MS)) return UNAVAILABLE;
      return transact(client, signal, DELIVERY_BOUNDS, async (sql) => {
        // 006's claim routine: ONE statement over one clock reading, SKIP LOCKED, the earliest eligible events in
        // (eligibility time, event ID) order claimed under this token, an expired claim never reclaimed under the token
        // that held it, and one at the fixed cap dead-lettered (attempts_exhausted), unpublished, instead of handed out
        // a 21st time. Its rows come back in that order.
        const rows = await sql`select o_spent as spent, o_event_id as event_id, o_attempt as attempt, o_event_type as event_type,
            o_event_version as event_version, o_aggregate_type as aggregate_type, o_aggregate_id as aggregate_id,
            o_aggregate_version as aggregate_version, o_tenant_digest as tenant_digest, o_store_digest as store_digest,
            o_actor_digest as actor_digest, o_correlation_id as correlation_id, o_payload as payload, o_occurred_at as occurred_at
          from tmpos_internal.m6_outbox_claim(${claim}::text, ${limit}::integer, ${ms(claimMs)}::bigint)
          order by o_eligible_at, o_event_id`;
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
    acknowledge: (raw: unknown, signal: AbortSignal): Promise<Answer> => settle(client, signal, raw, 'acknowledged', answer('acknowledged'),
      (sql, eventId, claim) => sql`select tmpos_internal.m6_outbox_acknowledge(${eventId}::uuid, ${claim}::text) as outcome`),
    async retry(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const delayMs = fieldsOf(raw, ['delayMs'])?.delayMs;
      if (!isInteger(delayMs, 1, OUTBOX_DELIVERY_POLICY.maxDelayMs)) return UNAVAILABLE;
      // An event that has spent its attempts is never pending again: the retry changes nothing ('unavailable'), and
      // once its claim expires the next claim dead-letters it.
      return settle(client, signal, raw, 'scheduled', answer('scheduled'),
        (sql, eventId, claim) => sql`select tmpos_internal.m6_outbox_retry(${eventId}::uuid, ${claim}::text, ${ms(delayMs)}::bigint) as outcome`);
    },
    async deadLetter(raw: unknown, signal: AbortSignal): Promise<Answer> {
      const reason = fieldsOf(raw, ['reason'])?.reason;
      if (typeof reason !== 'string' || !DEAD_REASONS.includes(reason)) return UNAVAILABLE;
      return settle(client, signal, raw, 'dead_lettered', answer('dead_lettered'),
        (sql, eventId, claim) => sql`select tmpos_internal.m6_outbox_dead_letter(${eventId}::uuid, ${claim}::text, ${reason}::text) as outcome`);
    },
    probe: (signal: AbortSignal): Promise<boolean> => probe(client, signal),
  });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const MUTATOR_FIELDS: readonly string[] = ['kind', 'mode', 'aggregateType', 'apply', 'contextScope'];
const MUTATOR_SCOPES: readonly string[] = ['platform', 'tenant', 'store'];

function mutatorOf(raw: unknown): AggregateMutator {
  // The five fields every mutator has — its declared context scope among them, required (M7B-INVOICES-P1, R4).
  if (isRecord(raw) && hasExactKeys(raw, MUTATOR_FIELDS)) {
    const { kind, mode, aggregateType, apply, contextScope } = raw;
    if (isContractName(kind) && (mode === 'create' || mode === 'update') && typeof aggregateType === 'string' && AGGREGATE_TYPE_RE.test(aggregateType)
      && typeof apply === 'function' && typeof contextScope === 'string' && MUTATOR_SCOPES.includes(contextScope)) {
      return Object.freeze({ kind, mode, aggregateType, apply: apply as AggregateMutator['apply'], contextScope: contextScope as CommandContextScope });
    }
  }
  throw new TypeError('transactional store mutator invalid');
}

/** The three ports over `client`. Validates the mutator table; opens nothing until a port is called. */
export function createPostgresTransactionalStore(options: TransactionalStoreOptions): TransactionalStore {
  const { client, mutators, revalidate, contextScope = 'platform' } = isRecord(options) ? options : ({} as Partial<TransactionalStoreOptions>);
  if (typeof client !== 'object' || client === null || typeof client.transaction !== 'function' || !Array.isArray(mutators)) {
    throw new TypeError('transactional store options invalid');
  }
  if (revalidate !== undefined && typeof revalidate !== 'function') throw new TypeError('transactional store options invalid');
  // A tenant store without its revalidator could never commit, and a scope it does not know is a wiring fault.
  if ((contextScope !== 'platform' && contextScope !== 'tenant') || (contextScope === 'tenant' && revalidate === undefined)) {
    throw new TypeError('transactional store options invalid');
  }
  const table = new Map<string, AggregateMutator>();
  for (const raw of mutators) {
    const mutator = mutatorOf(raw);
    if (table.has(mutator.kind)) throw new TypeError('transactional store mutator invalid');
    table.set(mutator.kind, mutator);
  }
  return Object.freeze({
    idempotency: idempotencyPort(client),
    transactions: transactionPort(client, table, revalidate ?? null, contextScope),
    delivery: deliveryPort(client),
  });
}
