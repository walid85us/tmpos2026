// Phase 4.0 M6 — durable idempotency: the port, the key contract and the runtime's checks (G-IDEMPOT).
//
// A route that declares `idempotency: 'required'` (routes.ts) runs its operation at most once for
// each holder of an unexpired lease on its client key, and answers every retry of a completed
// operation with the response it recorded the first time. The step runs last in the chain
// (app.ts): after the client and rate limit, CSRF and origin, authentication and authorization,
// and the bounded body read — so a refusal reserves nothing — and just before the operation: a
// `perform`, handed only its IdempotentContext, whose outcome the runtime records; or a `command`,
// whose plan the runtime commits atomically with its completion (commandTransaction.ts).
//
// The key. Exactly one `Idempotency-Key` header line holding a UUID version 4 in its hyphenated
// hexadecimal text form — case-insensitive on input (RFC 9562), normalized to lowercase. This is
// a bare value: the expired IETF draft's quoted structured-field string, braces, a URN, another
// version or length, whitespace or a control character are all refused (400) before the store is
// asked. The raw key goes nowhere: it is digested here and never logged, stored or sent to the port.
//
// Identity, under a dedicated secret (IDEMPOTENCY_KEY, never RATE_LIMIT_KEY: keyMaterial.ts),
// by domain-separated HMAC-SHA256 over tagged JSON arrays (unambiguous framing; the contract
// version in every tag):
//   scope       = H(key digest, principal digest) — the record the store keeps. Each principal has
//                 its own key namespace, so another principal using the same key collides with,
//                 waits on and learns of nothing.
//   fingerprint = H(scope, method, route path, session boundary, tenant, store, SHA-256 of the exact
//                 body bytes) — the request the record is bound to: everything the operation sees.
//                 The tenant and store slots are reserved — no tenant or store context exists in the
//                 runtime before M5, so the chain passes null — and any context later handed to an
//                 operation must enter the fingerprint with it.
// The same key and principal with another operation, boundary, tenant, store or body is the same
// scope under another fingerprint: a conflict, answered identically whatever differs. No digest is
// a bare hash, so neither a small body nor a known key can be guessed from what the store holds.
//
// The port (DurableIdempotencyStore) is provider-independent. Per scope it keeps a fingerprint, a
// lease, the lease's expiry, a retention and — once completed — the sealed response, all timed by
// the store's own clock (one clock for every instance, such as its transaction time; never an
// instance's):
//   acquire  — absent or past retention: record it in progress under the caller's lease →
//              { outcome: 'acquired', reclaimed: false }. Another fingerprint → 'conflict'.
//              Completed → { outcome: 'replay', response }. In progress under an unexpired lease →
//              'in_progress'. Under an expired lease the caller's lease replaces it and retention
//              restarts → { outcome: 'acquired', reclaimed: true }. A refusal changes nothing: it
//              extends no lease and no retention.
//   complete — records the sealed response iff the record is unexpired, in progress and holds
//              exactly the caller's lease (an expired lease nobody has reclaimed still completes);
//              otherwise 'lease_lost', changing nothing. Completion extends no retention.
//   probe    — exactly `true` only while acquisitions can be served; readiness reports it.
// Every call is atomic across callers and instances. One handed an already-aborted signal changes
// nothing. A store that cannot serve answers 'unavailable' or rejects — never another outcome — and
// keeps no offline queue to replay later. A call that times out or is cut off in flight has an
// indeterminate effect: an acquisition may have recorded its lease (the operation then waits it
// out), a completion may have stored its response (a retry then replays it). What crosses the
// port: scope, fingerprint, a fresh random lease, the source-defined lease and retention, and
// the sealed response — no raw request, cookie, token, body, user ID or key. Every adapter must
// pass the conformance suite (idempotencyStore.testkit.ts) before it is approved.
//
// Sealing. A recorded response is an envelope — an approved status (200/201 success; 409/422 the
// approved deterministic domain rejections), the one approved content type, the allowlisted
// `Location` header only (an origin-relative path) and a bounded JSON body — encrypted and
// authenticated (AES-256-GCM under a subkey of IDEMPOTENCY_KEY) with its scope and fingerprint as
// associated data. A replay is served only when it unseals for exactly this operation and the
// envelope inside is still strictly valid, so a store can neither serve one principal's or
// operation's response for another's, nor forge one, nor read one; and Set-Cookie, Authorization,
// WWW-Authenticate, CSRF material, tracing headers and arbitrary headers can never be recorded or
// replayed. Every response on this path carries the request's own security headers and fresh
// X-Request-Id; a replay is marked `Idempotent-Replayed: true`.
//
// Retained: only such an envelope, returned by an operation within its deadline. A rejection is
// retained for the whole retention period, so an operation returns one only for a permanent,
// deterministic refusal of this exact request — a transient condition throws. Never retained: an
// infrastructure error, a timeout, a crash or a malformed outcome, which complete nothing — the
// reservation then waits out its lease.
//
// The crash window — what `perform` does NOT do. For a `perform` the reservation, the operation's own
// business write and the completion are separate steps: the business write is not in the store's
// transaction. An instance that dies, an operation that commits and then fails, or a completion
// the store refuses leaves an applied operation still in progress; once its lease expires a retry
// reclaims it (`attempt.reclaimed`) and the operation runs again. An operation that outlives its
// deadline runs on unless it honours its abort signal, and can then overlap a reclaimer. So a
// `perform` guarantees one holder of an unexpired lease per operation and the replay of a completed
// one — never exactly-once execution — and is never approved for a production route. A `command`
// closes the window by contract (commandTransaction.ts): its business mutation, the lease-checked
// completion, its audit record and its outbox events commit in one transaction of the authoritative
// store, so at most one attempt commits. No adapter implements that yet: none is approved
// (server/composition binds none) and no production route requires idempotency.
//
// Also bounded: a record lives IDEMPOTENCY_POLICY.retentionMs (24 h) from its acquisition, so a
// retry with the same key after that is a new operation; and IDEMPOTENCY_KEY and the contract
// version must be the same on every instance — changing either starts every record afresh, so a
// change waits for a drain of one retention period.
import { createCipheriv, createDecipheriv, createHash, createHmac, createSecretKey, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { outage, withDeadline } from './deadline.js';
import { secretKeyOf } from './keyMaterial.js';
import { EnforcementSetupError } from './routes.js';
import type { RouteMethod, SessionAudience, VerifiedPrincipal } from './routes.js';

export const IDEMPOTENCY_CONTRACT_VERSION = 1;

/** The lease and retention every acquisition is handed: source-defined, identical on every instance. */
export const IDEMPOTENCY_POLICY = Object.freeze({ leaseMs: 60_000, retentionMs: 24 * 60 * 60_000 });

/** The bound on one store call, below the port deadline: a durable store answers in milliseconds. */
export const IDEMPOTENCY_DEADLINE_MS = 1_000;

/** The request header that carries the client's key. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** The one approved content type of a recorded response. */
export const REPLAY_CONTENT_TYPE = 'application/json; charset=utf-8';

/** The retained statuses: success, then the approved deterministic domain rejections. */
export const RETAINED_STATUSES: ReadonlySet<number> = new Set([200, 201, 409, 422]);

/** The largest recorded body, in UTF-8 bytes. */
export const MAX_REPLAY_BODY_BYTES = 16 * 1024;

// The sealed form, as unpadded base64url: a 12-byte IV, the ciphertext of the envelope's JSON — at
// most twice the body once escaped, plus its fixed fields — and a 16-byte tag.
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ENVELOPE_BYTES = 2 * MAX_REPLAY_BODY_BYTES + 1_024;
/** The longest sealed response the runtime hands a store, and the longest it will unseal. */
export const MAX_SEALED_LENGTH = Math.ceil(((IV_BYTES + MAX_ENVELOPE_BYTES + TAG_BYTES) * 4) / 3);

// The error words only the runtime answers with: an operation's outcome may not borrow one.
const RESERVED_ERRORS: ReadonlySet<string> = new Set(['request_in_progress', 'idempotency_key_reused', 'write_conflict']);
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// An origin-relative path: no scheme, authority, backslash, query or fragment; strict percent-encoding.
const LOCATION_RE = /^\/(?!\/)(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/;
const MAX_LOCATION_LENGTH = 256;
const SEALED_RE = /^[A-Za-z0-9_-]+$/;
const LONE_SURROGATE_RE = /\p{Cs}/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const ENVELOPE_FIELDS: readonly string[] = ['status', 'contentType', 'headers', 'body'];
const OUTCOME_FIELDS: readonly string[] = ['status', 'body', 'headers'];
const REPLAY_HEADERS: readonly string[] = ['location'];
const PARTS: readonly string[] = ['store', 'keySecret'];
const STORE_METHODS: readonly string[] = ['acquire', 'complete', 'probe'];

/** A recorded response: exactly these four fields, each in contract. */
export interface ReplayEnvelope {
  readonly status: number;
  readonly contentType: string;
  readonly headers: Readonly<{ location?: string }>;
  readonly body: string;
}

export interface IdempotencyAcquireRequest {
  /** The record: 43 base64url characters. */
  readonly scope: string;
  /** The request it is bound to: 43 base64url characters. */
  readonly fingerprint: string;
  /** This attempt's lease: 43 base64url characters from 32 random bytes. */
  readonly lease: string;
  readonly leaseMs: number;
  readonly retentionMs: number;
}

export interface IdempotencyCompleteRequest {
  readonly scope: string;
  readonly lease: string;
  /** The sealed response: opaque base64url of at most MAX_SEALED_LENGTH characters, kept byte for byte. */
  readonly response: string;
}

/** The port. Each call is handed its deadline's AbortSignal and may return a Promise. */
export interface DurableIdempotencyStore {
  acquire(request: IdempotencyAcquireRequest, signal: AbortSignal): unknown;
  complete(request: IdempotencyCompleteRequest, signal: AbortSignal): unknown;
  probe(signal: AbortSignal): unknown;
}

/** What an operation is bound to, beside the client key and the principal. */
export interface OperationBinding {
  readonly method: RouteMethod;
  readonly path: string;
  readonly audience: SessionAudience | null;
  /** Reserved for M5's tenant and store context; null until the runtime has one. */
  readonly tenant: string | null;
  readonly store: string | null;
  /** The exact body bytes read. */
  readonly body: Uint8Array;
}

export interface OperationIdentity {
  readonly scope: string;
  readonly fingerprint: string;
}

export interface IdempotencyKeyring {
  operationOf(key: string, principal: VerifiedPrincipal, binding: OperationBinding): OperationIdentity;
  seal(envelope: ReplayEnvelope, operation: OperationIdentity): string;
  unseal(sealed: unknown, operation: OperationIdentity): ReplayEnvelope | null;
}

/** The durable store and its secret, as composed (createApp's `idempotency`). */
export interface IdempotencyDeps {
  /** An approved durable store in production, never a per-process stand-in. */
  readonly store: DurableIdempotencyStore;
  /** The dedicated keyed-hash secret (32–64 bytes), identical on every instance; never RATE_LIMIT_KEY. */
  readonly keySecret: Uint8Array;
}

export interface Idempotency {
  readonly store: DurableIdempotencyStore;
  readonly keyring: IdempotencyKeyring;
}

/** What the chain does with a store's answer that is not an acquisition or a replay. */
export type IdempotencyRefusal =
  | 'idempotency_in_progress'
  | 'idempotency_conflict'
  | 'idempotency_lease_lost'
  | 'idempotency_unavailable'
  | 'idempotency_timeout'
  | 'idempotency_outcome_invalid';

export type IdempotencyAcquisition =
  | { readonly outcome: 'acquired'; readonly reclaimed: boolean }
  | { readonly outcome: 'replay'; readonly response: ReplayEnvelope };

export type IdempotencyKeyRefusal = 'idempotency_key_missing' | 'idempotency_key_duplicated' | 'idempotency_key_invalid';

/** An ordinary object literal: never an array, a class instance or anything inheriting its fields. */
const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const hasOnlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((key) => keys.includes(key));
const hasMethod = (v: unknown, name: string): boolean =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)[name] === 'function';
const tag = (purpose: string, ...parts: ReadonlyArray<string | null>): string =>
  JSON.stringify(['tmpos-idempotency', IDEMPOTENCY_CONTRACT_VERSION, purpose, ...parts]);

/** The request's one Idempotency-Key, normalized, or why it is refused. Nothing but its header lines is read. */
export function readIdempotencyKey(rawHeaders: readonly string[]): { readonly key: string } | IdempotencyKeyRefusal {
  let value: string | undefined;
  let lines = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === IDEMPOTENCY_KEY_HEADER) {
      lines++;
      value = rawHeaders[i + 1];
    }
  }
  if (lines === 0) return 'idempotency_key_missing';
  if (lines > 1) return 'idempotency_key_duplicated'; // never guess which line was meant
  return typeof value === 'string' && value.length === 36 && KEY_RE.test(value) ? Object.freeze({ key: value.toLowerCase() }) : 'idempotency_key_invalid';
}

/** A strictly valid envelope as a fresh frozen copy, or null; a malformed body throws (callers catch). */
function envelopeOf(raw: unknown): ReplayEnvelope | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ENVELOPE_FIELDS)) return null;
  // Read once each: an answer cannot validate one value and hand back another.
  const { status, contentType, headers, body } = raw;
  if (typeof status !== 'number' || !RETAINED_STATUSES.has(status) || contentType !== REPLAY_CONTENT_TYPE) return null;
  if (!isRecord(headers) || !hasOnlyKeys(headers, REPLAY_HEADERS)) return null;
  const { location } = headers;
  if (location !== undefined && (typeof location !== 'string' || location.length > MAX_LOCATION_LENGTH || !LOCATION_RE.test(location))) return null;
  if (typeof body !== 'string' || LONE_SURROGATE_RE.test(body) || Buffer.byteLength(body, 'utf8') > MAX_REPLAY_BODY_BYTES) return null;
  const value: unknown = JSON.parse(body);
  // The runtime's own refusal words stay the runtime's, so a client can tell them from an outcome.
  if (isRecord(value) && typeof value.error === 'string' && RESERVED_ERRORS.has(value.error)) return null;
  return Object.freeze({ status, contentType, headers: Object.freeze(typeof location === 'string' ? { location } : {}), body });
}

/**
 * An operation's outcome as the envelope it would be recorded as, or null when it is not
 * retainable: an unapproved status, a body that is no JSON value or is over the cap, a header off
 * the allowlist, a reserved error word, or any field beside status, body and headers.
 */
export function envelopeFromOutcome(raw: unknown): ReplayEnvelope | null {
  try {
    if (!isRecord(raw) || !hasOnlyKeys(raw, OUTCOME_FIELDS)) return null;
    const { status, body, headers } = raw;
    // Plain JSON data only: nothing JSON.stringify would drop or rewrite is recorded as if it were intended.
    if (!isJsonData(body)) return null;
    return envelopeOf({ status, contentType: REPLAY_CONTENT_TYPE, headers: headers === undefined ? {} : headers, body: JSON.stringify(body) });
  } catch {
    return null; // a hostile getter: not retainable
  }
}

const MAX_JSON_DEPTH = 64;

/** Plain JSON data: null, strings, booleans, finite numbers, and dense arrays and plain objects of them — no toJSON, no symbol keys. */
function isJsonData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= MAX_JSON_DEPTH || typeof value !== 'object') return false; // undefined, a function, a symbol, a BigInt; or too deep (a cycle)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    // inv: every index below i holds JSON data; term: i rises to value.length.
    for (let i = 0; i < value.length; i++) if (!(i in value) || !isJsonData(value[i], depth + 1)) return false;
    return true;
  }
  return isRecord(value) && !('toJSON' in value) && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).every((key) => isJsonData(value[key], depth + 1));
}

/** The keyring under `secret` (32–64 bytes): operation identities, and sealing bound to them. */
export function createIdempotencyKeyring(secret: unknown): IdempotencyKeyring {
  const key = secretKeyOf(secret, 'idempotency_key_invalid');
  const mac = (message: string): Buffer => createHmac('sha256', key).update(message).digest();
  const digest = (message: string): string => mac(message).toString('base64url');
  // The sealing key is a subkey: the secret never keys both the HMACs and the cipher.
  const sealKey = createSecretKey(mac(tag('seal-key')));
  const associated = (operation: OperationIdentity): Buffer => Buffer.from(tag('seal', operation.scope, operation.fingerprint));
  return Object.freeze({
    operationOf(clientKey: string, principal: VerifiedPrincipal, binding: OperationBinding): OperationIdentity {
      const scope = digest(tag('scope', digest(tag('key', clientKey)), digest(tag('principal', principal.authProvider, principal.authProviderUid))));
      const body = createHash('sha256').update(binding.body).digest('base64url');
      const fingerprint = digest(tag('fingerprint', scope, binding.method, binding.path, binding.audience, binding.tenant, binding.store, body));
      return Object.freeze({ scope, fingerprint });
    },
    seal(envelope: ReplayEnvelope, operation: OperationIdentity): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', sealKey, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(associated(operation));
      return Buffer.concat([iv, cipher.update(JSON.stringify(envelope), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    },
    unseal(sealed: unknown, operation: OperationIdentity): ReplayEnvelope | null {
      if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_LENGTH || !SEALED_RE.test(sealed)) return null;
      const bytes = Buffer.from(sealed, 'base64url');
      if (bytes.length <= IV_BYTES + TAG_BYTES) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', sealKey, bytes.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
        decipher.setAAD(associated(operation));
        decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
        const plain = Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
        return envelopeOf(JSON.parse(UTF8.decode(plain)) as unknown);
      } catch {
        return null; // sealed for another operation or key, altered, or not an envelope
      }
    },
  });
}

/** Validate the composed store and secret; startup fails closed on anything missing or malformed. */
export function createIdempotency(raw: unknown): Idempotency {
  if (!isRecord(raw) || !hasOnlyKeys(raw, PARTS)) throw new EnforcementSetupError('idempotency_invalid');
  const { store, keySecret } = raw;
  if (!STORE_METHODS.every((name) => hasMethod(store, name))) throw new EnforcementSetupError('idempotency_invalid');
  return Object.freeze({ store: store as DurableIdempotencyStore, keyring: createIdempotencyKeyring(keySecret) });
}

/**
 * Acquire under the store deadline (the port deadline, capped at IDEMPOTENCY_DEADLINE_MS),
 * obeying only an exact, in-contract answer: an acquisition, or a replay that unseals for exactly
 * this operation. An explicit refusal is reported as such; a throw, a rejection or an overrun is
 * an outage; anything else breaks the contract.
 */
export async function acquireIdempotency(
  idempotency: Idempotency, request: IdempotencyAcquireRequest, deadlineMs: number,
): Promise<IdempotencyAcquisition | IdempotencyRefusal> {
  let raw: unknown;
  try {
    raw = await withDeadline(Math.min(deadlineMs, IDEMPOTENCY_DEADLINE_MS), (signal) => idempotency.store.acquire(request, signal));
  } catch (err) {
    return outage('idempotency', err);
  }
  try {
    if (!isRecord(raw)) return 'idempotency_outcome_invalid';
    // Read once each, as the limiter's answers are; and an answer carries exactly its own fields —
    // never an extra one, nor one it merely inherits.
    const { outcome, reclaimed, response } = raw;
    const fields = outcome === 'acquired' ? ['outcome', 'reclaimed'] : outcome === 'replay' ? ['outcome', 'response'] : ['outcome'];
    if (Object.keys(raw).length !== fields.length || !fields.every((field) => Object.hasOwn(raw, field))) return 'idempotency_outcome_invalid';
    if (outcome === 'acquired' && typeof reclaimed === 'boolean') return Object.freeze({ outcome: 'acquired' as const, reclaimed });
    if (outcome === 'replay') {
      const envelope = idempotency.keyring.unseal(response, request);
      return envelope === null ? 'idempotency_outcome_invalid' : Object.freeze({ outcome: 'replay' as const, response: envelope });
    }
    if (outcome === 'in_progress') return 'idempotency_in_progress';
    if (outcome === 'conflict') return 'idempotency_conflict';
    return outcome === 'unavailable' ? 'idempotency_unavailable' : 'idempotency_outcome_invalid';
  } catch {
    return 'idempotency_outcome_invalid'; // a hostile answer — a throwing getter — breaks the contract too
  }
}

/**
 * Complete under the store deadline — the runtime's own, never the client's connection. null once
 * the store has recorded the response; otherwise why not: a lost lease, an outage or a broken answer.
 */
export async function completeIdempotency(
  idempotency: Idempotency, request: IdempotencyCompleteRequest, deadlineMs: number,
): Promise<IdempotencyRefusal | null> {
  let raw: unknown;
  try {
    raw = await withDeadline(Math.min(deadlineMs, IDEMPOTENCY_DEADLINE_MS), (signal) => idempotency.store.complete(request, signal));
  } catch (err) {
    return outage('idempotency', err);
  }
  try {
    if (!isRecord(raw)) return 'idempotency_outcome_invalid';
    const { outcome } = raw;
    if (Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'outcome')) return 'idempotency_outcome_invalid'; // exactly its one own field
    if (outcome === 'completed') return null;
    if (outcome === 'lease_lost') return 'idempotency_lease_lost';
    return outcome === 'unavailable' ? 'idempotency_unavailable' : 'idempotency_outcome_invalid';
  } catch {
    return 'idempotency_outcome_invalid';
  }
}
