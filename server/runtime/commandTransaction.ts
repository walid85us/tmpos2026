// Phase 4.0 M6 — the atomic command transaction: one protected operation committed as one unit
// (G-IDEMPOT, G-AUDIT; docs/phase-4/10 ADR-17).
//
// A route that declares `idempotency: 'required'` with a `command` (routes.ts) closes the crash window
// idempotency.ts documents for `perform`. The route declares its command contract — the kind, whether it
// creates or updates, the one aggregate type it mutates, its change schema and the events it may enqueue
// — which startup validates against the event contracts (outbox.ts). Its planner must be synchronous,
// deterministic and free of effects: it holds no infrastructure, performs no I/O and writes nothing, and
// from the parsed body alone returns a CommandPlan, which the runtime turns into one TransactionCommand
// for the authoritative store to commit — every part in ONE transaction, or none:
//   - the lease check: the idempotency record is in progress, within its retention, and holds exactly
//     this attempt's lease — the fencing token. A reclaim replaced the lease, so an older attempt whose
//     commit arrives late is fenced out, and a completed record accepts no second commit;
//   - the authorized business mutation: one aggregate — by a create contract, created at a UUID the
//     runtime generated (a create names no ID of the client's); by an update contract, updated at the
//     version the plan expects (optimistic concurrency) — written at the next version;
//   - the sealed completion, so every retry replays the response (idempotency.ts);
//   - the durable audit record;
//   - zero or more outbox events, stamped with the transaction's own timestamp.
// Only values cross the port: a registered command kind, canonical UUIDs, a version, typed bounded
// changes and events, the lease and a sealed response — never SQL, a relation, column or schema name, a
// raw request, key, credential, cookie or body. The adapter owns every statement: a closed set of kinds,
// each mapped to static statements and columns; every value a command carries is bound as data, and no
// kind, type or field name is ever interpolated into SQL. The planner's context holds no header, cookie,
// key, credential or principal, so none reaches a command through it; the parsed body can — a schema
// bounds a value's shape, not its meaning — so each contract's fields are reviewed for what they may carry.
// The runtime enforces only that a planner is a function that returns no thenable: that it returns nothing
// it captured or imported, and makes no effect, are source-review rules as well, so the one transaction
// covers what its plan hands the store — never an effect a planner makes beside it.
//
// The port (CommandTransactionPort):
//   commit — checks, in this order and inside the transaction, (1) the lease — else 'lease_lost', so a
//            fenced attempt learns nothing of business state — and (2) the mutation's precondition —
//            else 'conflict'; then writes every part → 'committed'. An event ID that is not new is a
//            fault of the runtime or the store, never a conflict: nothing commits, and the answer is
//            'unavailable' or a rejection. 'lease_lost', 'conflict' and 'unavailable' change nothing —
//            'unavailable' only when the adapter knows nothing committed; one that cannot tell rejects —
//            and a call handed an already-aborted signal changes nothing. A call that throws, rejects,
//            times out or is aborted in flight has an INDETERMINATE effect: it committed entirely or not
//            at all, never in part.
//   probe  — exactly `true` only while commits can be served; readiness reports it.
// One adapter serves this port and the idempotency store over one database, since the lease it checks is
// that store's (createApp composes neither alone). It must pass assertIdempotencyStoreContract and
// assertCommandTransactionContract (transactionalOutbox.testkit.ts) over two instances against the real
// store, fault injection and interleaved statements included, before it is approved. A PostgreSQL
// adapter runs one fresh transaction per call; locks the idempotency row first (`SELECT … FOR UPDATE`, or
// the conditional completion UPDATE checked for one row) and the aggregate row second, in that one order,
// judging retention by clock_timestamp() taken once the row is locked; states each precondition as a
// conditional statement, never a caught error followed by more statements (an error aborts the whole
// transaction); maps only its own constraints to 'conflict'; bounds every statement below the commit
// deadline (statement and lock timeouts) and cancels it when the signal aborts, so an abandoned commit
// never holds the idempotency row; and stamps the audit record and every event with the one transaction
// timestamp — the transaction's start time (audit_event.occurred_at's default), not its commit order.
//
// The runtime (app.ts) acknowledges success only after 'committed'. 'conflict' is a 409 write_conflict:
// nothing committed, nothing recorded, and the attempt's lease simply expires. Every other outcome — an
// explicit 'unavailable', 'lease_lost', a throw, a timeout or a malformed answer — is a bounded 503 that
// assumes no rollback: the runtime never releases or replaces a lease (there is no such call), so a retry
// replays the record if the commit landed, or waits (409 request_in_progress) until the lease expires and
// a reclaim plans and commits again — while the reclaimed attempt, if its commit is still in flight, is
// fenced out. So a planner can run more than once, but at most one attempt of an operation commits while
// its record is retained: atomic creation, never exactly-once processing.
//
// Audit coupling. The existing durable writer (server/platform-identity/auditEventWriter.ts) joins a
// transaction through its executor seam, but the runtime cannot import it. So the command carries a
// transaction-local audit record the runtime builds from trusted sources only — the route's registered
// kind (the action) and authorization requirement, and the command's server-generated correlation ID —
// never the planner's output. A PostgreSQL adapter writes it through that writer on the same transaction
// handle (an append-only INSERT; a failed write aborts the commit) — never after the commit. It records
// committed mutations only. The actor is null, like tenant and store, until M5 supplies the app-owned
// identity: no provider-derived pseudonym is written into a permanent record (G-AUDIT).
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { outage, withDeadline } from './deadline.js';
import { envelopeFromOutcome } from './idempotency.js';
import type { ReplayEnvelope } from './idempotency.js';
import { AGGREGATE_TYPE_RE, MAX_EVENTS_PER_COMMAND, UUID_RE, isContractName, parseRecordSchema, recordOf } from './outbox.js';
import type { EventContract, OutboxEventDraft, OutboxEventRegistry, RecordSchema, RecordValue } from './outbox.js';
import { EnforcementSetupError } from './routes.js';
import type { AuthorizationRequirement, AuthorizationScope } from './routes.js';

/** The bound on one commit, below the port deadline: a durable transaction of a few statements. */
export const COMMAND_TRANSACTION_DEADLINE_MS = 2_000;

/** The statuses a committed command answers with: success only, since a rejection commits no mutation. */
export const COMMAND_RESPONSE_STATUSES: ReadonlySet<number> = new Set([200, 201]);

const MAX_EXPECTED_VERSION = Number.MAX_SAFE_INTEGER - 1;
const PARTS: readonly string[] = ['port'];
const PORT_METHODS: readonly string[] = ['commit', 'probe'];
const PLAN_FIELDS: readonly string[] = ['aggregateId', 'expectedVersion', 'changes', 'events', 'response'];

/** One closed command contract: whether it creates or updates, the aggregate, its change schema and the events it may enqueue. */
export interface CommandContract {
  readonly kind: string;
  readonly mode: 'create' | 'update';
  readonly aggregateType: string;
  readonly changes: RecordSchema;
  /** Each a registered event contract of the same aggregate type, at most one per type. */
  readonly events: readonly Readonly<{ type: string; version: number }>[];
}

export interface CommandRegistry {
  contract(kind: string): CommandContract | undefined;
  list(): readonly CommandContract[];
}

/** The business mutation: one aggregate, created (expectedVersion null) or updated at expectedVersion. */
export interface TransactionMutation {
  readonly kind: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly expectedVersion: number | null;
  readonly changes: RecordValue;
}

/** The transaction-local audit record, built by the runtime from trusted sources only. */
export interface TransactionAudit {
  /** The route's registered command kind. */
  readonly action: string;
  /** The route's authorization requirement. */
  readonly permission: string;
  readonly scope: AuthorizationScope;
  /** Null until M5 supplies server-derived tenant, store and actor identities. */
  readonly tenant: null;
  readonly store: null;
  readonly actor: null;
  /** The command's server-generated correlation ID (a UUID version 4), shared by its events. */
  readonly correlationId: string;
}

/** What one commit is handed: the fence, the sealed completion, the mutation, its audit record and its events. */
export interface TransactionCommand {
  /** The idempotency record: 43 base64url characters. */
  readonly scope: string;
  /** This attempt's lease — the fencing token. */
  readonly lease: string;
  /** The sealed response, recorded as the completion. */
  readonly response: string;
  readonly mutation: TransactionMutation;
  readonly audit: TransactionAudit;
  readonly events: readonly OutboxEventDraft[];
}

/** The port. Each call is handed its deadline's AbortSignal and may return a Promise. */
export interface CommandTransactionPort {
  commit(command: TransactionCommand, signal: AbortSignal): unknown;
  probe(signal: AbortSignal): unknown;
}

/** The authoritative store's commit port, as composed (createApp's `transactions`). */
export interface CommandTransactionDeps {
  /** An approved durable adapter in production — the idempotency store's own database — never a per-process stand-in. */
  readonly port: CommandTransactionPort;
}

export interface CommandTransactions {
  readonly port: CommandTransactionPort;
}

/** What the runtime binds a plan to: the fence, the aggregate a create must use, the requirement and the sealing. */
export interface CommandBinding {
  readonly scope: string;
  readonly lease: string;
  /** The UUID the runtime generated for this attempt: the only aggregate a create may name. */
  readonly newAggregateId: string;
  readonly authorization: AuthorizationRequirement;
  readonly seal: (envelope: ReplayEnvelope) => string;
}

export interface PreparedCommand {
  readonly command: TransactionCommand;
  /** The response to send once — and only once — the commit is confirmed. */
  readonly response: ReplayEnvelope;
}

export type CommandRefusal =
  | 'transaction_lease_lost'
  | 'transaction_conflict'
  | 'transaction_unavailable'
  | 'transaction_timeout'
  | 'transaction_outcome_invalid';

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
const isPlainArray = (v: unknown): v is unknown[] => Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype;
const hasMethod = (v: unknown, name: string): boolean =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)[name] === 'function';

function eventRefOf(raw: unknown, aggregateType: string, events: OutboxEventRegistry): Readonly<{ type: string; version: number }> | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['type', 'version'])) return null;
  const { type, version } = raw;
  if (typeof type !== 'string' || typeof version !== 'number') return null;
  const contract = events.contract(type, version);
  return contract !== undefined && contract.aggregateType === aggregateType ? Object.freeze({ type, version }) : null;
}

function parseCommandContract(raw: unknown, events: OutboxEventRegistry): CommandContract {
  if (isRecord(raw) && hasExactKeys(raw, ['kind', 'mode', 'aggregateType', 'changes', 'events'])) {
    const { kind, mode, aggregateType, changes, events: refs } = raw;
    const schema = parseRecordSchema(changes);
    if (isContractName(kind) && (mode === 'create' || mode === 'update') && typeof aggregateType === 'string'
      && AGGREGATE_TYPE_RE.test(aggregateType) && schema !== null && isPlainArray(refs) && refs.length <= MAX_EVENTS_PER_COMMAND) {
      const parsed: Readonly<{ type: string; version: number }>[] = [];
      for (const ref of refs) {
        const valid = eventRefOf(ref, aggregateType, events);
        if (valid === null || parsed.some((seen) => seen.type === valid.type)) throw new EnforcementSetupError('command_registry_invalid');
        parsed.push(valid);
      }
      return Object.freeze({ kind, mode, aggregateType, changes: schema, events: Object.freeze(parsed) });
    }
  }
  throw new EnforcementSetupError('command_registry_invalid');
}

/** Validate every command contract against the event registry and build the closed, frozen registry: one route per kind. */
export function defineCommands(defs: unknown, events: OutboxEventRegistry): CommandRegistry {
  if (!isPlainArray(defs)) throw new EnforcementSetupError('command_registry_invalid');
  const table = new Map<string, CommandContract>();
  for (const raw of defs) {
    const contract = parseCommandContract(raw, events);
    if (table.has(contract.kind)) throw new EnforcementSetupError('command_registry_invalid');
    table.set(contract.kind, contract);
  }
  const list = Object.freeze([...table.values()]);
  return Object.freeze({ contract: (kind: string) => table.get(kind), list: () => list });
}

/** Validate the composed port; startup fails closed on anything missing or malformed. */
export function createCommandTransactions(raw: unknown): CommandTransactions {
  if (!isRecord(raw) || !hasExactKeys(raw, PARTS)) throw new EnforcementSetupError('command_transaction_invalid');
  const { port } = raw;
  if (!PORT_METHODS.every((name) => hasMethod(port, name))) throw new EnforcementSetupError('command_transaction_invalid');
  return Object.freeze({ port: port as CommandTransactionPort });
}

/** A planner is synchronous: a thenable is no plan, and its rejection is observed rather than left unhandled. */
function refuseThenable(value: unknown): boolean {
  try {
    // A native promise's own rejection is observed even when its `then` is overridden.
    if (types.isPromise(value)) {
      Promise.prototype.then.call(value, undefined, () => undefined);
      return true;
    }
    if (typeof value !== 'object' || value === null || typeof (value as { then?: unknown }).then !== 'function') return false;
    Promise.resolve(value).catch(() => undefined);
    return true;
  } catch {
    return true; // a hostile `then` getter
  }
}

/**
 * A plan as the one command the store is to commit, and the response to send once it has, or null when
 * the plan is not in contract with the route's command contract: exactly its five fields; for a create
 * contract, no version and exactly the runtime's new aggregate ID; for an update contract, a canonical
 * lowercase UUID at a version;
 * changes and event payloads in their schemas; events only of the types the contract allows, each at
 * most once (one logical event per operation); and a success response a replay can carry. The runtime
 * supplies everything else: event IDs, the version produced, the correlation ID, the null scope and actor
 * slots and the audit record.
 */
export function prepareCommand(contract: CommandContract, events: OutboxEventRegistry, raw: unknown, binding: CommandBinding): PreparedCommand | null {
  if (refuseThenable(raw)) return null;
  try {
    if (!isRecord(raw) || !hasExactKeys(raw, PLAN_FIELDS)) return null;
    // Read once each: a plan cannot validate one value and hand back another.
    const { aggregateId, expectedVersion, changes, events: planned, response } = raw;
    if (contract.mode === 'create' ? expectedVersion !== null || aggregateId !== binding.newAggregateId
      : !(typeof aggregateId === 'string' && UUID_RE.test(aggregateId) && typeof expectedVersion === 'number'
        && Number.isSafeInteger(expectedVersion) && expectedVersion >= 1 && expectedVersion <= MAX_EXPECTED_VERSION)) return null;
    const mutationChanges = recordOf(contract.changes, changes);
    if (mutationChanges === null || !isPlainArray(planned)) return null;
    const count = planned.length;
    if (count > contract.events.length) return null;
    const id = aggregateId as string;
    const version = expectedVersion === null ? 1 : (expectedVersion as number) + 1;
    const correlationId = randomUUID();
    const drafts: OutboxEventDraft[] = [];
    // inv: drafts holds a valid draft for each item below i, their types distinct and allowed by the contract; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const item: unknown = planned[i];
      if (!isRecord(item) || !hasExactKeys(item, ['type', 'payload'])) return null;
      const { type, payload } = item;
      const ref = contract.events.find((allowed) => allowed.type === type);
      if (ref === undefined || drafts.some((draft) => draft.type === ref.type)) return null;
      const event = events.contract(ref.type, ref.version) as EventContract; // registration proved it
      const value = recordOf(event.payload, payload);
      if (value === null) return null;
      drafts.push(Object.freeze({
        eventId: randomUUID(), type: event.type, version: event.version, aggregateType: contract.aggregateType, aggregateId: id,
        aggregateVersion: version, tenant: null, store: null, actor: null, correlationId, payload: value,
      }));
    }
    const envelope = envelopeFromOutcome(response);
    if (envelope === null || !COMMAND_RESPONSE_STATUSES.has(envelope.status)) return null;
    const command: TransactionCommand = Object.freeze({
      scope: binding.scope,
      lease: binding.lease,
      response: binding.seal(envelope),
      mutation: Object.freeze({
        kind: contract.kind, aggregateType: contract.aggregateType, aggregateId: id, expectedVersion: expectedVersion as number | null, changes: mutationChanges,
      }),
      audit: Object.freeze({
        action: contract.kind, permission: binding.authorization.permission, scope: binding.authorization.scope, tenant: null, store: null, actor: null,
        correlationId,
      }),
      events: Object.freeze(drafts),
    });
    return Object.freeze({ command, response: envelope });
  } catch {
    return null; // a hostile getter: not in contract
  }
}

/**
 * Commit under the transaction deadline (the port deadline, capped at COMMAND_TRANSACTION_DEADLINE_MS),
 * obeying only an exact answer. null once the store has committed; otherwise why not — a fenced lease, a
 * conflict, or an outage, overrun or broken answer, none of which the runtime treats as a rollback.
 */
export async function commitCommand(transactions: CommandTransactions, command: TransactionCommand, deadlineMs: number): Promise<CommandRefusal | null> {
  let raw: unknown;
  try {
    raw = await withDeadline(Math.min(deadlineMs, COMMAND_TRANSACTION_DEADLINE_MS), (signal) => transactions.port.commit(command, signal));
  } catch (err) {
    return outage('transaction', err);
  }
  try {
    if (!isRecord(raw) || !hasExactKeys(raw, ['outcome'])) return 'transaction_outcome_invalid'; // exactly its one own field
    const { outcome } = raw;
    if (outcome === 'committed') return null;
    if (outcome === 'lease_lost') return 'transaction_lease_lost';
    if (outcome === 'conflict') return 'transaction_conflict';
    return outcome === 'unavailable' ? 'transaction_unavailable' : 'transaction_outcome_invalid';
  } catch {
    return 'transaction_outcome_invalid'; // a hostile answer breaks the contract too
  }
}
