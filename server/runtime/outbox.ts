// Phase 4.0 M6 — the transactional outbox: closed event contracts, the immutable envelope, the delivery
// port and one bounded delivery pass (G-IDEMPOT; docs/phase-4/10 ADR-17).
//
// An event is created only inside the atomic command transaction (commandTransaction.ts): the business
// mutation, its idempotency completion, its audit record and its outbox events commit together or not
// at all, in the authoritative store — PostgreSQL, once an adapter exists (ADR-17). Delivery is then AT
// LEAST ONCE until an event is dead-lettered, never exactly once: a publish whose acknowledgement is
// lost, or whose claim expires mid-flight (a publish that outlives its abort included), is published
// again — the same immutable envelope, equal field for field, under the same event ID — so every consumer
// deduplicates by `eventId`. No ordering is promised, globally or per
// aggregate; each envelope carries its aggregate's version, by which a consumer can order one aggregate's
// events itself. occurredAt is the committing transaction's timestamp, not commit order: never a cursor.
//
// Contracts. Every event type is a closed, source-defined contract (defineOutboxEvents, frozen at startup
// like the route table): a dotted type, a schema version, the aggregate type it describes and an explicit
// payload schema. A payload is a flat record of bounded scalars — strings (at most
// MAX_STRING_FIELD_LENGTH characters, no control character or lone surrogate), safe integers within
// declared bounds, booleans and closed enums — carrying exactly its declared fields, and at most
// MAX_RECORD_BYTES serialized whatever its per-field bounds allow. A field named for credential, token,
// cookie, key, session, CSRF, connection or card material is refused at definition: a lint against a
// careless schema, never proof of what a value holds — that rests on the planner seeing no such material
// and on closed, reviewed contracts. Release policy, which no code can enforce across releases: registries
// are append-only while events can be claimed, a type keeps one aggregate type in every release, the record
// limits only ever tighten, and a new type@version ships to the workers before any command emits it. A
// worker that meets a well-formed envelope whose type@version it lacks (a rolling deploy) retries it —
// within the attempt cap every event has, so one still unknown when its attempts are spent is dead-lettered
// (attempts_exhausted) for an audited redrive, never retried forever; anything less than a well-formed
// envelope is dead-lettered as invalid.
//
// The envelope. Immutable and bounded: eventId (a UUID version 4 the runtime generates), type, version,
// aggregateType, aggregateId (a server-generated UUID surrogate — pseudonymous, never a natural key),
// aggregateVersion (the version the mutation produced), tenant, store and actor (keyed digests; ONE RULE:
// a scope or identity the runtime does not have in server-derived form is null — always present, never
// absent, never invented — and before M5 it has none of the three), correlationId (a UUID the runtime
// generates per command, shared by its events and its audit record; never the client's request ID),
// payload, and occurredAt (epoch ms), which only the store stamps. No raw key, identity, credential,
// cookie, body, SQL or connection material has a field. Delivery metadata — status, claim, expiry, due
// time, attempts — is the store's and never enters the envelope: a claimed event is { eventId, attempt,
// envelope }, where eventId is the row key, so even an envelope the runtime refuses can be addressed.
//
// The port (OutboxDeliveryStore) is provider-independent and timed by the store's own clock:
//   claim       — atomically takes up to `limit` (at most MAX_CLAIM_BATCH) eligible events: pending and
//                 due, or claimed under a claim past its expiry (a reclaim). Each is then claimed under the
//                 caller's opaque token until now + claimMs, and its attempt count rises by one. No two
//                 unexpired claims ever hold one event; a delivered or dead event is never claimed again.
//                 Nothing eligible: { outcome: 'claimed', events: [] }.
//   acknowledge — iff the event is claimed under exactly this token (an expired claim nobody has
//                 reclaimed still settles): delivered, durably and for good. Otherwise 'claim_lost',
//                 changing nothing — a stale worker changes nothing.
//   retry       — iff held: pending again, due at now + delayMs.
//   deadLetter  — iff held: dead, for good, with a closed reason.
//   probe       — exactly `true` only while the store can serve.
// A call handed an already-aborted signal changes nothing. A store that cannot serve answers
// 'unavailable' or rejects and queues nothing; a call that times out or is aborted in flight has an
// indeterminate effect, which the claim's expiry resolves. Every
// adapter must pass assertOutboxDeliveryContract (transactionalOutbox.testkit.ts) to be approved. A
// PostgreSQL adapter claims in ONE statement (an UPDATE over a `FOR UPDATE SKIP LOCKED LIMIT n` subquery
// of eligible rows), settles by conditional UPDATEs on the row and its token, and runs each call in a
// fresh transaction, so now() is that call's time.
//
// Delivery (deliverOutboxBatch) is ONE bounded pass for a future worker to call: nothing here loops,
// schedules or runs in the background, and nothing is kept between passes. It claims a batch; an event
// whose envelope is not strictly valid under a known contract is dead-lettered unpublished; a well-formed
// one whose type@version this worker lacks (a known type keeping its aggregate) is retried, within the
// same attempt cap; one whose claims have outrun
// maxAttempts (claims that kept expiring) is dead-lettered unpublished; every other is published under a
// deadline — only an exact `true` delivers it — then acknowledged, retried after bounded exponential
// backoff, or dead-lettered once
// its attempts are spent. Each claim publishes at most once, so an event is published at most maxAttempts
// times, and ends delivered or dead while a store and a worker are live. There is no redrive of dead
// events here (an audited operator redrive is M8).
import { randomBytes } from 'node:crypto';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { EnforcementSetupError } from './routes.js';

/** The largest serialized payload or command change set, in UTF-8 bytes, whatever its per-field bounds allow. */
export const MAX_RECORD_BYTES = 4_096;
/** The most fields one record schema may declare. */
export const MAX_RECORD_FIELDS = 16;
/** The longest string field a schema may declare, in UTF-16 code units. */
export const MAX_STRING_FIELD_LENGTH = 256;
/** The largest serialized outbox envelope: a bounded payload beside the fixed, format-bounded fields. */
export const MAX_OUTBOX_ENVELOPE_BYTES = MAX_RECORD_BYTES + 1_024;
/** The most events one command may enqueue. */
export const MAX_EVENTS_PER_COMMAND = 8;
/** The largest batch one claim may take. */
export const MAX_CLAIM_BATCH = 32;
/** The bound on one delivery-store call, below the caller's deadline. */
export const OUTBOX_DEADLINE_MS = 1_000;
/** The longest one publish may take. A pass claims, publishes, then settles: publish + settle < claimMs. */
export const MAX_PUBLISH_DEADLINE_MS = 10_000;

/**
 * Source-defined and identical on every worker. Backoff doubles from 1 s to a 15 min cap, so the 20
 * attempts span about three hours before an event is dead-lettered.
 */
export const OUTBOX_DELIVERY_POLICY = Object.freeze({ claimMs: 30_000, maxAttempts: 20, baseDelayMs: 1_000, maxDelayMs: 900_000 });

/** A dotted lowercase name — an event type or a command kind, e.g. `inventory.obligation.created`. */
const CONTRACT_NAME_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const MAX_CONTRACT_NAME_LENGTH = 64;
/** One lowercase token naming an aggregate type. */
export const AGGREGATE_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** A UUID in its canonical lowercase form, so one identifier has one spelling. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A UUID version 4 in canonical lowercase form: what the runtime generates. */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A keyed digest: 43 base64url characters (32 bytes). */
const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const FIELD_NAME_RE = /^[a-z][A-Za-z0-9]{0,31}$/;
const ENUM_VALUE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MAX_ENUM_VALUES = 32;
const MAX_EVENT_VERSION = 1_000;
// A field named for secret material is refused at definition, however it is cased: a lint, not a control.
const FORBIDDEN_NAME_PARTS: readonly string[] = [
  'token', 'secret', 'password', 'passwd', 'pwd', 'passphrase', 'cookie', 'credential', 'authorization', 'bearer', 'apikey', 'privatekey', 'idempotency',
  'csrf', 'session', 'connection', 'dsn', 'databaseurl', 'jwt', 'jwks', 'servicerole', 'rawbody', 'rawdb', 'cvv', 'cardnumber',
];
const FORBIDDEN_NAMES: readonly string[] = ['pan', 'pin', 'otp', 'cvc'];
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const LONE_SURROGATE_RE = /\p{Cs}/u;
const ENVELOPE_FIELDS: readonly string[] = [
  'eventId', 'type', 'version', 'aggregateType', 'aggregateId', 'aggregateVersion', 'tenant', 'store', 'actor', 'correlationId', 'payload', 'occurredAt',
];
const CLAIMED_FIELDS: readonly string[] = ['eventId', 'attempt', 'envelope'];
const DELIVERY_PARTS: readonly string[] = ['store', 'events'];
const DELIVERY_METHODS: readonly string[] = ['claim', 'acknowledge', 'retry', 'deadLetter', 'probe'];

/** One field of a record schema. */
export type FieldSchema =
  | Readonly<{ type: 'string'; maxLength: number }>
  | Readonly<{ type: 'integer'; min: number; max: number }>
  | Readonly<{ type: 'boolean' }>
  | Readonly<{ type: 'enum'; values: readonly string[] }>;

/** A flat record schema: field name → field. A value carries exactly these fields. */
export type RecordSchema = Readonly<Record<string, FieldSchema>>;

/** A value in contract with its schema: bounded scalars only. */
export type RecordValue = Readonly<Record<string, string | number | boolean>>;

/** One closed event contract. */
export interface EventContract {
  readonly type: string;
  readonly version: number;
  readonly aggregateType: string;
  readonly payload: RecordSchema;
}

export interface OutboxEventRegistry {
  contract(type: string, version: number): EventContract | undefined;
  list(): readonly EventContract[];
}

/** What a command transaction enqueues: the event, all but the store's timestamp. */
export interface OutboxEventDraft {
  readonly eventId: string;
  readonly type: string;
  readonly version: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  /** Null until M5 supplies server-derived tenant, store and actor identities (the one null rule). */
  readonly tenant: string | null;
  readonly store: string | null;
  readonly actor: string | null;
  readonly correlationId: string;
  readonly payload: RecordValue;
}

/** The immutable event as delivered: the draft and the authoritative transaction timestamp. */
export interface OutboxEnvelope extends OutboxEventDraft {
  /** Epoch milliseconds of the committing transaction, stamped by the store. */
  readonly occurredAt: number;
}

export interface OutboxClaimRequest {
  /** The claim's fencing token: 43 base64url characters from 32 random bytes, fresh per claim. */
  readonly claim: string;
  /** At most MAX_CLAIM_BATCH. */
  readonly limit: number;
  readonly claimMs: number;
}

export interface OutboxSettleRequest {
  readonly eventId: string;
  readonly claim: string;
}

export interface OutboxRetryRequest extends OutboxSettleRequest {
  /** 1 .. OUTBOX_DELIVERY_POLICY.maxDelayMs. */
  readonly delayMs: number;
}

export type DeadLetterReason = 'attempts_exhausted' | 'envelope_invalid';

export interface OutboxDeadLetterRequest extends OutboxSettleRequest {
  readonly reason: DeadLetterReason;
}

/** The port. Each call is handed its deadline's AbortSignal and may return a Promise. */
export interface OutboxDeliveryStore {
  claim(request: OutboxClaimRequest, signal: AbortSignal): unknown;
  acknowledge(request: OutboxSettleRequest, signal: AbortSignal): unknown;
  retry(request: OutboxRetryRequest, signal: AbortSignal): unknown;
  deadLetter(request: OutboxDeadLetterRequest, signal: AbortSignal): unknown;
  probe(signal: AbortSignal): unknown;
}

/** The delivery store and the event contracts it carries, as a future worker composes them. */
export interface OutboxDeliveryDeps {
  readonly store: OutboxDeliveryStore;
  readonly events: readonly EventContract[];
}

export interface OutboxDelivery {
  readonly store: OutboxDeliveryStore;
  readonly registry: OutboxEventRegistry;
}

export type OutboxRefusal = 'outbox_unavailable' | 'outbox_timeout' | 'outbox_outcome_invalid';

/**
 * One claimed event, addressed by its row key. `envelope` is null when the stored one is not strictly
 * valid: `known` is then false only for a well-formed envelope of this row whose type@version this worker
 * lacks (retried within the attempt cap); anything else is broken (dead-lettered).
 */
export interface ClaimedEvent {
  readonly eventId: string;
  readonly attempt: number;
  readonly envelope: OutboxEnvelope | null;
  readonly known: boolean;
}

/** What a settlement came to: done, a claim that is no longer this worker's, or a store that could not answer. */
export type SettleVerdict = 'settled' | 'claim_lost' | OutboxRefusal;

/** Publishes one envelope; only an exact `true` means delivered. */
export type OutboxPublisher = (envelope: OutboxEnvelope, signal: AbortSignal) => unknown;

/** A pass's counts. `lost`: another claim holds the event now; `unsettled`: the store did not answer, so the claim expires. */
export interface DeliveryPass {
  readonly claimed: number;
  readonly acknowledged: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly lost: number;
  readonly unsettled: number;
}

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
const isInteger = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max && !Object.is(v, -0);
const isDigestOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && DIGEST_RE.test(v));
/** A string of at most `max` UTF-16 code units with no control character or lone surrogate. */
const isCleanString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max && !CONTROL_RE.test(v) && !LONE_SURROGATE_RE.test(v);
/** A dotted lowercase contract name: an event type or a command kind. */
export const isContractName = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_CONTRACT_NAME_LENGTH && CONTRACT_NAME_RE.test(v);

function parseField(raw: unknown): FieldSchema | null {
  if (!isRecord(raw)) return null;
  const { type, maxLength, min, max, values } = raw;
  if (type === 'string' && hasExactKeys(raw, ['type', 'maxLength']) && isInteger(maxLength, 1, MAX_STRING_FIELD_LENGTH)) {
    return Object.freeze({ type, maxLength });
  }
  if (type === 'integer' && hasExactKeys(raw, ['type', 'min', 'max']) && isInteger(min, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    && isInteger(max, min, Number.MAX_SAFE_INTEGER)) {
    return Object.freeze({ type, min, max });
  }
  if (type === 'boolean' && hasExactKeys(raw, ['type'])) return Object.freeze({ type });
  if (type === 'enum' && hasExactKeys(raw, ['type', 'values']) && isPlainArray(values) && values.length >= 1 && values.length <= MAX_ENUM_VALUES) {
    const copy = [...values];
    if (copy.every((v) => typeof v === 'string' && ENUM_VALUE_RE.test(v)) && new Set(copy).size === copy.length) {
      return Object.freeze({ type, values: Object.freeze(copy as string[]) });
    }
  }
  return null;
}

/** Whether a field name is refused: malformed, an Object.prototype member, or named for secret material. */
function isRefusedFieldName(name: string): boolean {
  if (!FIELD_NAME_RE.test(name) || name in Object.prototype) return true;
  const lower = name.toLowerCase();
  return FORBIDDEN_NAMES.includes(lower) || lower.endsWith('key') || FORBIDDEN_NAME_PARTS.some((part) => lower.includes(part));
}

/** A strictly valid record schema as a frozen copy, or null. Definitions are source code, validated once at startup. */
export function parseRecordSchema(raw: unknown): RecordSchema | null {
  if (!isRecord(raw)) return null;
  const names = Reflect.ownKeys(raw);
  if (names.length > MAX_RECORD_FIELDS) return null;
  const schema: Record<string, FieldSchema> = {};
  for (const name of names) {
    if (typeof name !== 'string' || isRefusedFieldName(name)) return null;
    const field = parseField(raw[name]);
    if (field === null) return null;
    schema[name] = field;
  }
  return Object.freeze(schema);
}

function fieldAccepts(field: FieldSchema, value: unknown): boolean {
  switch (field.type) {
    case 'string':
      return isCleanString(value, field.maxLength);
    case 'integer':
      return isInteger(value, field.min, field.max);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && field.values.includes(value);
  }
}

/**
 * `raw` in contract with `schema` as a fresh frozen copy, or null: exactly the schema's fields, each read
 * once and in bounds, and at most MAX_RECORD_BYTES serialized.
 */
export function recordOf(schema: RecordSchema, raw: unknown): RecordValue | null {
  try {
    if (!isRecord(raw)) return null;
    const names = Object.keys(schema);
    if (!hasExactKeys(raw, names)) return null;
    const value: Record<string, string | number | boolean> = {};
    for (const name of names) {
      const field: unknown = raw[name];
      if (!fieldAccepts(schema[name], field)) return null;
      value[name] = field as string | number | boolean;
    }
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RECORD_BYTES ? Object.freeze(value) : null;
  } catch {
    return null; // a hostile getter: not in contract
  }
}

function parseEventContract(raw: unknown): EventContract {
  if (isRecord(raw) && hasExactKeys(raw, ['type', 'version', 'aggregateType', 'payload'])) {
    const { type, version, aggregateType, payload } = raw;
    const schema = parseRecordSchema(payload);
    if (isContractName(type) && isInteger(version, 1, MAX_EVENT_VERSION) && typeof aggregateType === 'string'
      && AGGREGATE_TYPE_RE.test(aggregateType) && schema !== null) {
      return Object.freeze({ type, version, aggregateType, payload: schema });
    }
  }
  throw new EnforcementSetupError('outbox_registry_invalid');
}

/** Validate every event contract and build the closed, frozen registry; startup fails closed on any fault. */
export function defineOutboxEvents(defs: unknown): OutboxEventRegistry {
  if (!isPlainArray(defs)) throw new EnforcementSetupError('outbox_registry_invalid');
  const byType = new Map<string, Map<number, EventContract>>();
  const list: EventContract[] = [];
  for (const raw of defs) {
    const contract = parseEventContract(raw);
    const versions = byType.get(contract.type) ?? new Map<number, EventContract>();
    // One aggregate per type, and one contract per version.
    const [sibling] = versions.values();
    if (versions.has(contract.version) || (sibling !== undefined && sibling.aggregateType !== contract.aggregateType)) {
      throw new EnforcementSetupError('outbox_registry_invalid');
    }
    versions.set(contract.version, contract);
    byType.set(contract.type, versions);
    list.push(contract);
  }
  const frozen = Object.freeze(list);
  return Object.freeze({
    contract: (type: string, version: number) => byType.get(type)?.get(version),
    list: () => frozen,
  });
}

/** A stored envelope read once: its strict copy, or null — and then whether it names a contract the registry lacks. */
interface EnvelopeReading {
  readonly envelope: OutboxEnvelope | null;
  readonly unknownContract: boolean;
}
const REFUSED: EnvelopeReading = Object.freeze({ envelope: null, unknownContract: false });
const UNKNOWN: EnvelopeReading = Object.freeze({ envelope: null, unknownContract: true });

/**
 * Whether a payload could be a record under some contract: at most MAX_RECORD_FIELDS well-formed names none
 * refused, each a boolean, a safe integer or a clean string of at most MAX_STRING_FIELD_LENGTH, and at most
 * MAX_RECORD_BYTES serialized — each field read once. Which fields, and their bounds, only a contract decides.
 */
function couldBeRecord(raw: Record<string, unknown>): boolean {
  const names = Reflect.ownKeys(raw);
  if (names.length > MAX_RECORD_FIELDS) return false;
  const copy: Record<string, string | number | boolean> = {};
  for (const name of names) {
    if (typeof name !== 'string' || isRefusedFieldName(name)) return false;
    const field: unknown = raw[name];
    if (typeof field !== 'boolean' && !isInteger(field, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) && !isCleanString(field, MAX_STRING_FIELD_LENGTH)) return false;
    copy[name] = field as string | number | boolean;
  }
  return Buffer.byteLength(JSON.stringify(copy), 'utf8') <= MAX_RECORD_BYTES;
}

/**
 * Read a stored envelope once. It is obeyed only when strictly in contract with a registered event
 * contract — exactly its fields, each well formed, within MAX_OUTBOX_ENVELOPE_BYTES — and, given a row key,
 * only when it is that row's. It names a contract the registry lacks only when everything a contract does
 * not decide — its payload's shape and outer bounds included — is well formed too, and a type the registry
 * knows keeps its one aggregate: anything less is no envelope, never a rolling deploy.
 */
function readEnvelope(registry: OutboxEventRegistry, raw: unknown, rowKey?: string): EnvelopeReading {
  try {
    if (!isRecord(raw) || !hasExactKeys(raw, ENVELOPE_FIELDS)) return REFUSED;
    // Read once each: an answer cannot validate one value and hand back another.
    const { eventId, type, version, aggregateType, aggregateId, aggregateVersion, tenant, store, actor, correlationId, payload, occurredAt } = raw;
    if (typeof eventId !== 'string' || !UUID_V4_RE.test(eventId) || (rowKey !== undefined && eventId !== rowKey)) return REFUSED;
    if (!isContractName(type) || !isInteger(version, 1, MAX_EVENT_VERSION) || typeof aggregateType !== 'string' || !AGGREGATE_TYPE_RE.test(aggregateType)) return REFUSED;
    if (typeof aggregateId !== 'string' || !UUID_RE.test(aggregateId) || !isInteger(aggregateVersion, 1, Number.MAX_SAFE_INTEGER)) return REFUSED;
    if (!isDigestOrNull(tenant) || !isDigestOrNull(store) || !isDigestOrNull(actor)) return REFUSED;
    if (typeof correlationId !== 'string' || !UUID_V4_RE.test(correlationId) || !isInteger(occurredAt, 1, Number.MAX_SAFE_INTEGER)) return REFUSED;
    if (!isRecord(payload)) return REFUSED;
    const contract = registry.contract(type, version);
    if (contract === undefined) {
      // A type keeps one aggregate in every release (release policy; defineOutboxEvents checks one registry),
      // so a known type under another aggregate is no newer version.
      const sibling = registry.list().find((c) => c.type === type);
      return (sibling === undefined || sibling.aggregateType === aggregateType) && couldBeRecord(payload) ? UNKNOWN : REFUSED;
    }
    if (aggregateType !== contract.aggregateType) return REFUSED;
    const value = recordOf(contract.payload, payload);
    if (value === null) return REFUSED;
    const envelope: OutboxEnvelope = Object.freeze({
      eventId, type, version, aggregateType, aggregateId, aggregateVersion, tenant, store, actor, correlationId, payload: value, occurredAt,
    });
    return Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_OUTBOX_ENVELOPE_BYTES ? Object.freeze({ envelope, unknownContract: false }) : REFUSED;
  } catch {
    return REFUSED;
  }
}

/**
 * A stored envelope as a fresh frozen copy when it is strictly in contract with a registered event
 * contract — exactly its fields, each well formed, within MAX_OUTBOX_ENVELOPE_BYTES — or null.
 */
export function envelopeOf(registry: OutboxEventRegistry, raw: unknown): OutboxEnvelope | null {
  return readEnvelope(registry, raw).envelope;
}

/** Validate the composed delivery store and its event contracts; startup fails closed on anything missing or malformed. */
export function createOutboxDelivery(raw: unknown): OutboxDelivery {
  if (!isRecord(raw) || !hasExactKeys(raw, DELIVERY_PARTS)) throw new EnforcementSetupError('outbox_delivery_invalid');
  const { store, events } = raw;
  if (!DELIVERY_METHODS.every((name) => hasMethod(store, name))) throw new EnforcementSetupError('outbox_delivery_invalid');
  return Object.freeze({ store: store as OutboxDeliveryStore, registry: defineOutboxEvents(events) });
}

/**
 * Claim under the store deadline (the caller's, capped at OUTBOX_DEADLINE_MS), obeying only an exact
 * answer: at most `limit` items of exactly { eventId, attempt, envelope } with distinct canonical row
 * keys. An item whose envelope is not in contract, or is not this row's, comes back with a null
 * envelope; an item that cannot be addressed breaks the whole answer.
 */
export async function claimOutbox(
  delivery: OutboxDelivery, request: OutboxClaimRequest, deadlineMs: number,
): Promise<readonly ClaimedEvent[] | OutboxRefusal> {
  let raw: unknown;
  try {
    raw = await withDeadline(Math.min(deadlineMs, OUTBOX_DEADLINE_MS), (signal) => delivery.store.claim(request, signal));
  } catch (err) {
    return outage('outbox', err);
  }
  try {
    if (!isRecord(raw)) return 'outbox_outcome_invalid';
    const { outcome, events } = raw;
    if (outcome === 'unavailable' && hasExactKeys(raw, ['outcome'])) return 'outbox_unavailable';
    if (outcome !== 'claimed' || !hasExactKeys(raw, ['outcome', 'events']) || !isPlainArray(events)) return 'outbox_outcome_invalid';
    const count: unknown = events.length; // read once: a proxied length cannot pass the bound and then drive the loop past it
    if (!isInteger(request.limit, 1, MAX_CLAIM_BATCH) || !isInteger(count, 0, request.limit)) return 'outbox_outcome_invalid';
    const claimed: ClaimedEvent[] = [];
    const seen = new Set<string>();
    // inv: claimed holds one entry per item below i, with distinct canonical row keys; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const item: unknown = events[i];
      if (!isRecord(item) || !hasExactKeys(item, CLAIMED_FIELDS)) return 'outbox_outcome_invalid';
      const { eventId, attempt, envelope } = item;
      if (typeof eventId !== 'string' || !UUID_V4_RE.test(eventId) || seen.has(eventId) || !isInteger(attempt, 1, Number.MAX_SAFE_INTEGER)) {
        return 'outbox_outcome_invalid';
      }
      seen.add(eventId);
      const reading = readEnvelope(delivery.registry, envelope, eventId);
      claimed.push(Object.freeze({ eventId, attempt, envelope: reading.envelope, known: !reading.unknownContract }));
    }
    return Object.freeze(claimed);
  } catch {
    return 'outbox_outcome_invalid'; // a hostile answer breaks the contract too
  }
}

async function settle(call: (signal: AbortSignal) => unknown, success: string, deadlineMs: number): Promise<SettleVerdict> {
  let raw: unknown;
  try {
    raw = await withDeadline(Math.min(deadlineMs, OUTBOX_DEADLINE_MS), call);
  } catch (err) {
    return outage('outbox', err);
  }
  try {
    if (!isRecord(raw) || !hasExactKeys(raw, ['outcome'])) return 'outbox_outcome_invalid';
    const { outcome } = raw;
    if (outcome === success) return 'settled';
    if (outcome === 'claim_lost') return 'claim_lost';
    return outcome === 'unavailable' ? 'outbox_unavailable' : 'outbox_outcome_invalid';
  } catch {
    return 'outbox_outcome_invalid';
  }
}

/** Acknowledge a delivered event under its claim; only an exact answer is obeyed. */
export const acknowledgeOutbox = (delivery: OutboxDelivery, request: OutboxSettleRequest, deadlineMs: number): Promise<SettleVerdict> =>
  settle((signal) => delivery.store.acknowledge(request, signal), 'acknowledged', deadlineMs);

/** Schedule a held event's retry; only an exact answer is obeyed. */
export const retryOutbox = (delivery: OutboxDelivery, request: OutboxRetryRequest, deadlineMs: number): Promise<SettleVerdict> =>
  settle((signal) => delivery.store.retry(request, signal), 'scheduled', deadlineMs);

/** Dead-letter a held event; only an exact answer is obeyed. */
export const deadLetterOutbox = (delivery: OutboxDelivery, request: OutboxDeadLetterRequest, deadlineMs: number): Promise<SettleVerdict> =>
  settle((signal) => delivery.store.deadLetter(request, signal), 'dead_lettered', deadlineMs);

/** The delay before retrying after attempt `attempt` (≥ 1): doubling from baseDelayMs, capped at maxDelayMs. */
export function retryDelayMs(attempt: number): number {
  const { baseDelayMs, maxDelayMs } = OUTBOX_DELIVERY_POLICY;
  // ponytail: no jitter — events that fail together retry together; add full jitter once a real publisher shows herding.
  return Math.min(baseDelayMs * 2 ** Math.min(Math.max(attempt, 1) - 1, 30), maxDelayMs);
}

type DeliveryResult = 'acknowledged' | 'retried' | 'dead_lettered' | 'lost' | 'unsettled';

async function deliverOne(delivery: OutboxDelivery, publish: OutboxPublisher, claim: string, event: ClaimedEvent, deadlineMs: number): Promise<DeliveryResult> {
  const { maxAttempts } = OUTBOX_DELIVERY_POLICY;
  const held = { eventId: event.eventId, claim };
  const as = (done: DeliveryResult) => (verdict: SettleVerdict): DeliveryResult =>
    verdict === 'settled' ? done : verdict === 'claim_lost' ? 'lost' : 'unsettled';
  const deadLetter = (reason: DeadLetterReason): Promise<DeliveryResult> =>
    deadLetterOutbox(delivery, Object.freeze({ ...held, reason }), deadlineMs).then(as('dead_lettered'));
  // Undelivered this time: retried after backoff until its attempts are spent, then dead-lettered.
  const retryOrDeadLetter = (): Promise<DeliveryResult> => (event.attempt >= maxAttempts
    ? deadLetter('attempts_exhausted')
    : retryOutbox(delivery, Object.freeze({ ...held, delayMs: retryDelayMs(event.attempt) }), deadlineMs).then(as('retried')));
  const { envelope } = event;
  if (envelope === null && event.known) return deadLetter('envelope_invalid'); // the truer reason, whatever its attempts
  if (event.attempt > maxAttempts) return deadLetter('attempts_exhausted');
  if (envelope === null) return retryOrDeadLetter();
  let delivered = false;
  try {
    delivered = (await withDeadline(deadlineMs, (signal) => publish(envelope, signal))) === true;
  } catch {
    // A throw, a rejection or an overrun: not delivered. The error itself goes nowhere.
  }
  if (delivered) return acknowledgeOutbox(delivery, Object.freeze(held), deadlineMs).then(as('acknowledged'));
  return retryOrDeadLetter();
}

/**
 * One bounded delivery pass: claim at most `limit` events under a fresh token, publish each at most once
 * in parallel, and settle each. Returns the pass's counts, or why nothing could be claimed.
 */
export async function deliverOutboxBatch(
  delivery: OutboxDelivery, publish: OutboxPublisher, options: { readonly limit?: number; readonly deadlineMs?: number } = {},
): Promise<DeliveryPass | OutboxRefusal> {
  const limit = options.limit ?? MAX_CLAIM_BATCH;
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  if (typeof publish !== 'function' || !isInteger(limit, 1, MAX_CLAIM_BATCH) || !isInteger(deadlineMs, 1, MAX_PUBLISH_DEADLINE_MS)) {
    throw new RangeError('outbox delivery options out of range');
  }
  const claim = randomBytes(32).toString('base64url');
  const claimed = await claimOutbox(delivery, Object.freeze({ claim, limit, claimMs: OUTBOX_DELIVERY_POLICY.claimMs }), deadlineMs);
  if (typeof claimed === 'string') return claimed;
  const results = await Promise.all(claimed.map((event) => deliverOne(delivery, publish, claim, event, deadlineMs)));
  const count = (result: DeliveryResult): number => results.filter((r) => r === result).length;
  return Object.freeze({
    claimed: claimed.length, acknowledged: count('acknowledged'), retried: count('retried'), deadLettered: count('dead_lettered'),
    lost: count('lost'), unsettled: count('unsettled'),
  });
}
