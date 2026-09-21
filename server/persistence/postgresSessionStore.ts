// Phase 4.0 M5 — the PostgreSQL session store: the production adapter for the SessionStore port
// (server/runtime/sessions.ts), over migration 011's five fixed operations (M5-GIAM-D1-P2-R1; DA-32).
//
// WHY IT EXISTS. The session boundary has always declared a durable, shared store as its contract
// (docs/phase-4/03 §2 #18) and never had one: the only implementation was the in-memory test kit,
// which the deployable artifact excludes and the production graph forbids, so `productionSessions.ts`
// bound null and the composition refused. This is the minimum durable store that contract needs —
// not a cache, not a fallback, and not a wrapper around the kit.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING. The caller hands it the transaction kernel
// (supervisedPgClient.ts) the composition root already built; this file opens no connection, reads no
// environment and keeps no state between calls. Importing it connects to nothing.
//
// IT CANNOT REACH THE TABLE. The runtime role holds NO privilege on tmpos_session.session — not
// select, not insert, not update, not delete (migration 011 section 6 refuses to finish while any
// such grant exists). Every operation below is one call to a fixed definer routine, so the
// invariants the port states — an update changes an existing record only, revocation is final,
// revoking a principal touches exactly one audience — are enforced where this file cannot bypass
// them. There is no statement here that could write a session row directly even if this file were
// wrong.
//
// FAIL CLOSED, NEVER FAIL OPEN. A malformed row, an unexpected column set, a row count other than
// the one expected, an out-of-range timestamp, an abort, a timeout, a lost connection and a driver
// error all THROW. The boundary reads a throw as 'unavailable' and refuses the request
// (sessions.ts); none of them is ever reported as "no such session", which would silently log a live
// user out, nor as a session that exists.
//
// NOTHING IS LOGGED. Keys, provider references and driver errors are bound as parameters or
// discarded; the caller learns that an operation failed and nothing else — no SQLSTATE, no
// statement, no parameter, no connection string, no stack.
import { SESSION_TTL } from '../runtime/sessions.js';
import type { SessionRecord, SessionStore, SessionUpdate } from '../runtime/sessions.js';
import type { SessionAudience } from '../runtime/routes.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/**
 * A session operation is one short statement. The bounds sit below the caller's port deadline, as the
 * principal resolver's do: a statement that overruns is cancelled by PostgreSQL itself rather than
 * held by this process.
 */
export const SESSION_STORE_DEADLINE_MS = 3_000;
export const SESSION_STORE_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(SESSION_STORE_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(SESSION_STORE_DEADLINE_MS * 0.9)}ms`,
  idle: `${SESSION_STORE_DEADLINE_MS * 2}ms`,
});

/** The columns migration 011's read answers with, in the runtime's own field names. */
const RECORD_COLUMNS: readonly string[] = [
  'audience', 'authProvider', 'authProviderUid', 'principalKey',
  'securityVersion', 'authenticatedAt', 'createdAt', 'lastSeenAt', 'validatedAt',
];

class SessionStoreUnavailable extends Error {
  constructor(reason: string) {
    // The reason is a bounded word chosen in this file — never a driver message, a key or a value.
    super(`session store unavailable: ${reason}`);
    this.name = 'SessionStoreUnavailable';
  }
}

/**
 * A bigint column as the runtime's number, or a throw. The driver hands an int8 back as decimal TEXT,
 * so this is a parse, not a cast: a value outside the safe-integer range would silently lose precision
 * on the way through, and a session stamped with a number that is not the number stored is a record
 * the reader would judge on the wrong evidence.
 */
function epochMs(value: unknown, nullable: boolean): number | null {
  // Only `null` is a SQL NULL. `undefined` means the decoder produced a key with no value — a fault,
  // not an absent timestamp — and reading it as "no authentication time" would quietly hand the reader
  // a record the database never stored.
  if (value === null) {
    if (nullable) return null;
    throw new SessionStoreUnavailable('timestamp_missing');
  }
  if (value === undefined) throw new SessionStoreUnavailable('timestamp_missing');
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) throw new SessionStoreUnavailable('timestamp_invalid');
    return value;
  }
  if (typeof value !== 'string' || !/^[0-9]{1,19}$/.test(value)) throw new SessionStoreUnavailable('timestamp_invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new SessionStoreUnavailable('timestamp_invalid');
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new SessionStoreUnavailable(`${field}_invalid`);
  return value;
}

/**
 * The stored row as a SessionRecord, every field read once and checked. An extra column, a missing
 * one, or a value of the wrong type makes the whole read unavailable rather than a record with one
 * field quietly defaulted — the reader (sessions.ts liveSession) takes no default either, and a store
 * that supplied one would be deciding something the boundary has refused to decide.
 */
function recordOf(row: unknown): SessionRecord {
  if (typeof row !== 'object' || row === null) throw new SessionStoreUnavailable('row_invalid');
  const keys = Object.keys(row as Record<string, unknown>);
  if (keys.length !== RECORD_COLUMNS.length || !RECORD_COLUMNS.every((c) => keys.includes(c))) {
    throw new SessionStoreUnavailable('row_shape_invalid');
  }
  const r = row as Record<string, unknown>;
  const audience = text(r.audience, 'audience');
  if (audience !== 'tenant' && audience !== 'admin') throw new SessionStoreUnavailable('audience_invalid');
  return Object.freeze({
    audience,
    authProvider: text(r.authProvider, 'auth_provider'),
    authProviderUid: text(r.authProviderUid, 'auth_provider_uid'),
    principalKey: text(r.principalKey, 'principal_key'),
    securityVersion: text(r.securityVersion, 'security_version'),
    authenticatedAt: epochMs(r.authenticatedAt, true),
    createdAt: epochMs(r.createdAt, false) as number,
    lastSeenAt: epochMs(r.lastSeenAt, false) as number,
    validatedAt: epochMs(r.validatedAt, false) as number,
  });
}

/** Exactly one row with exactly one named column, or a throw. */
function only(rows: unknown, column: string): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) throw new SessionStoreUnavailable('answer_shape_invalid');
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null) throw new SessionStoreUnavailable('answer_shape_invalid');
  const keys = Object.keys(row as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== column) throw new SessionStoreUnavailable('answer_shape_invalid');
  return (row as Record<string, unknown>)[column];
}

export interface PostgresSessionStoreDeps {
  /** The kernel the composition root already built for this boundary — one client, one credential. */
  readonly client: SupervisedPgClient;
  /**
   * The clock a record's absolute expiry is measured against. Injected rather than read from the
   * global clock so the port's conformance suite — whose records are stamped at a fixed instant
   * (memorySessionStore.testkit.ts SESSION_CONTRACT_EPOCH) — can be run against this store unchanged.
   */
  readonly now?: () => number;
}

// WHY THIS STORE IS NOT BOUND TO ONE AUDIENCE, AND WHAT THAT LEAVES OPEN (doc 08 DA-37).
//
// The port hands the audience to every operation that needs one and stamps it on every record, so a
// store holds records of both boundaries and is told which it is being asked about; its conformance
// suite writes a tenant record and an admin record to ONE store and requires that revoking a
// principal in one audience leaves the other's untouched. An instance bound to a single audience
// would fail the very contract it implements, so this adapter takes the audience from the caller and
// from the record, exactly as the port declares.
//
// WHAT STILL SEPARATES THE TWO BOUNDARIES. The runtime never passes an audience but its own: a
// boundary revokes with the audience it was constructed with (sessions.ts revokeAllOf) and refuses any
// record stamped with another (`session_wrong_audience`). So no request path crosses the boundaries.
//
// WHAT DOES NOT. Both boundaries' rows live in ONE table reached by ONE runtime role, so the DATABASE
// does not separate them the way it separates tenants: a defect in one boundary's adapter could name
// the other's session key and the grant would permit the read. Closing that needs a second runtime
// role with its own grants — a privilege change wider than this stage authorizes — so it is recorded
// as a deferred assurance item rather than claimed as met.

/**
 * The production session store. `create` writes one record and refuses to overwrite one; `get`
 * answers the live record or nothing; `update` slides one stamp on a record that exists; `revoke` is
 * final; `revokePrincipal` ends one principal's sessions in this store's audience alone.
 */
export function createPostgresSessionStore(deps: PostgresSessionStoreDeps): SessionStore {
  const { client } = deps;
  const clock = deps.now ?? Date.now;
  /**
   * The instant liveness is judged at, checked before it is used. An unusable clock — NaN, a fraction,
   * a value past the safe-integer range — would otherwise be sent as the comparison bound and match no
   * row, so every read would answer "no such session" and log every user out silently. A clock that
   * cannot be read is an outage, which is what the boundary must see.
   */
  const now = (): number => {
    const t = clock();
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 1) throw new SessionStoreUnavailable('clock_invalid');
    return t;
  };

  const run = async <T>(signal: AbortSignal, work: (sql: PgTransactionScope) => Promise<T>): Promise<T> => {
    // An already-aborted call never reaches the database: the caller's deadline has passed, and the
    // boundary will read this throw as the outage it is.
    if (signal.aborted) throw new SessionStoreUnavailable('aborted');
    try {
      return await client.transaction(signal, SESSION_STORE_BOUNDS, work);
    } catch (err) {
      // A driver error carries a SQLSTATE, a hint, a schema and a host:port. None of that crosses this
      // boundary; a fault this file raised keeps its own bounded word.
      throw err instanceof SessionStoreUnavailable ? err : new SessionStoreUnavailable('store_failed');
    }
  };

  return Object.freeze({
    async create(key: string, record: SessionRecord, signal: AbortSignal): Promise<void> {
      // The record is the boundary's own, but the absolute expiry is this store's to compute: the port
      // carries no expiry field. The lifetime is the RECORD's own audience's, read from the runtime's
      // one table of lifetimes, so a record never outlives the boundary that issued it.
      // An OWN property, not a prototype-reachable one: `SESSION_TTL['constructor']` is not undefined.
      const lifetime = Object.hasOwn(SESSION_TTL, record.audience) ? SESSION_TTL[record.audience as SessionAudience] : undefined;
      if (lifetime === undefined) throw new SessionStoreUnavailable('audience_invalid');
      const expiresAt = record.createdAt + lifetime.absoluteMs;
      // Number.isSafeInteger already bounds this by MAX_SAFE_INTEGER; a second comparison would be dead.
      if (!Number.isSafeInteger(expiresAt)) throw new SessionStoreUnavailable('lifetime_invalid');
      const outcome = await run(signal, async (sql) => only(await sql`
        select tmpos_session.m5_session_create(
          ${key}::text, ${record.audience}::text, ${record.authProvider}::text, ${record.authProviderUid}::text,
          ${record.principalKey}::text, ${record.securityVersion}::text,
          ${record.authenticatedAt}::bigint, ${record.createdAt}::bigint,
          ${record.lastSeenAt}::bigint, ${record.validatedAt}::bigint, ${expiresAt}::bigint) as outcome`, 'outcome'));
      // A taken key is not a normal outcome: the identifier is 32 random bytes, so a collision means
      // the source of randomness is wrong. It fails the login rather than overwriting a live session.
      if (outcome !== 'created') throw new SessionStoreUnavailable('not_created');
    },

    async get(key: string, signal: AbortSignal): Promise<SessionRecord | undefined> {
      return run(signal, async (sql) => {
        const rows = await sql`select * from tmpos_session.m5_session_get(${key}::text, ${now()}::bigint)`;
        if (!Array.isArray(rows)) throw new SessionStoreUnavailable('answer_shape_invalid');
        // No row is the ONE answer that is not a fault: this key names no live session.
        if (rows.length === 0) return undefined;
        if (rows.length !== 1) throw new SessionStoreUnavailable('answer_shape_invalid');
        // The record carries its own audience; judging it is the boundary's, which refuses one
        // stamped with another (sessions.ts: session_wrong_audience). A store that filtered here
        // would answer 'no such session' for a record that exists, which the port reserves for a
        // key that names none.
        return recordOf(rows[0]);
      });
    },

    async update(key: string, fields: SessionUpdate, signal: AbortSignal): Promise<void> {
      // Exactly one named stamp, and the name is one of two words this file holds — never a key the
      // caller composed, and never a field the port has not declared updatable.
      const names = Object.keys(fields);
      if (names.length !== 1) throw new SessionStoreUnavailable('update_shape_invalid');
      const field = names[0];
      if (field !== 'lastSeenAt' && field !== 'validatedAt') throw new SessionStoreUnavailable('update_field_invalid');
      const value = (fields as Record<string, unknown>)[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new SessionStoreUnavailable('update_value_invalid');
      const outcome = await run(signal, async (sql) => only(
        await sql`select tmpos_session.m5_session_touch(${key}::text, ${field}::text, ${value}::bigint) as outcome`, 'outcome'));
      // 'absent' is not a fault: the port states that an update never creates a record, so a key that
      // names none is a no-op — a revoked session must stay revoked, not come back as a side effect.
      if (outcome !== 'updated' && outcome !== 'absent') throw new SessionStoreUnavailable('not_updated');
    },

    async revoke(key: string, signal: AbortSignal): Promise<void> {
      const outcome = await run(signal, async (sql) => only(
        await sql`select tmpos_session.m5_session_revoke(${key}::text) as outcome`, 'outcome'));
      if (outcome !== 'revoked') throw new SessionStoreUnavailable('not_revoked');
    },

    async revokePrincipal(target: SessionAudience, principalKey: string, signal: AbortSignal): Promise<void> {
      // Exactly the audience the caller named, and it must be one the runtime knows: a boundary
      // always names its own (sessions.ts revokeAllOf), and an unrecognised word would otherwise
      // reach the routine and match nothing, reporting a revocation that ended nothing.
      // An OWN property, not a prototype-reachable one: 'constructor' would otherwise pass this guard,
      // reach the routine, match nothing and report a revocation that ended nothing.
      if (!Object.hasOwn(SESSION_TTL, target)) throw new SessionStoreUnavailable('audience_invalid');
      const ended = await run(signal, async (sql) => only(
        await sql`select tmpos_session.m5_session_revoke_principal(${target}::text, ${principalKey}::text) as ended`, 'ended'));
      // Zero is a valid answer — the principal held no session here — but a non-count is not.
      const count = typeof ended === 'number' ? ended : Number(typeof ended === 'string' ? ended : NaN);
      if (!Number.isSafeInteger(count) || count < 0) throw new SessionStoreUnavailable('not_revoked');
    },
  });
}
