// Phase 4.0 M5 — the PostgreSQL session store: the production adapter for the SessionStore port
// (server/runtime/sessions.ts), over migration 011's five fixed session routines (M5-GIAM-D1-P2-R1; DA-32),
// and — for the administrative boundary's audited pair, establish and end (M6-ADMIN-AUDIT-P1) — the existing
// audit writer's one INSERT into public.audit_event, in the same transaction as the routines it records.
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
// IT CANNOT REACH THE SESSION TABLE. The runtime role holds NO privilege on tmpos_session.session —
// not select, not insert, not update, not delete (migration 011 section 6 refuses to finish while any
// such grant exists). Every session change below is a call to a fixed definer routine, so the
// invariants the port states — an update changes an existing record only, revocation is final,
// revoking a principal touches exactly one audience — are enforced where this file cannot bypass
// them. There is no statement here that could write a session row directly even if this file were
// wrong. The five plain operations are one routine call in one transaction each.
//
// THE AUDITED PAIR (M6-ADMIN-AUDIT-P1): ONE TRANSACTION EACH, AUDIT LAST. establish and end run their
// routine calls and then the audit record in a single kernel transaction, so the session change and its
// record commit together or neither does — no migration, no new grant: the runtime login already holds
// INSERT on public.audit_event through tmpos_audit_writer (migration 005), exactly as the command store
// writes its records (postgresTransactionalStore.ts). The insert's affected-row count must be exactly one,
// since a trigger could otherwise drop the row silently. A presented or ended session counts as ended BY
// THIS transaction only once it read the session live and took its row lock (a touch writing back the
// stamp it read, which waits out any concurrent deleter) — so at most one record can ever claim to have
// ended or replaced a given session. A record names a session only by a one-way reference to its key
// (sessionRefOf), never the key itself: the key is what the session routines accept, and a reader of the
// audit trail must not be handed a way to read, extend or end a live session. `create` refuses an
// administrative record, so establish is this file's only way to write one; the DATABASE does not couple
// them — the runtime login may still call m5_session_create directly (a routine migration would be needed).
//
// ORDERED AGAINST REVOCATION (M5-ADMIN-REVOKE-P1). establish first re-reads the standing the login was admitted
// at, on its own transaction and with the actor's authority locked until COMMIT (the standing check the
// transaction root hands it), and refuses — writing nothing — when it moved. A reauthentication must then END
// the live administrative session of the same principal it presents, or it ends, creates and records nothing:
// a logout or a revocation that committed first leaves it nothing to end. And holdAdministrativeSession lets the
// command transaction hold the very session that presented a command, so that command commits only while it is live.
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
import { createHash } from 'node:crypto';
import { SESSION_TTL } from '../runtime/sessions.js';
import type { SessionEndAudit, SessionEstablishAudit, SessionRecord, SessionStore, SessionUpdate } from '../runtime/sessions.js';
import type { SessionAudience } from '../runtime/routes.js';
import {
  ADMIN_SESSION_AUDIT_EVENTS, buildAdminSessionAuditEvent, sanitizeAuditMetadata, writeAuditEvent,
} from '../platform-identity/auditEventWriter.js';
import type { AuditEventWriteInput, AuditSqlExecutor } from '../platform-identity/auditEventWriter.js';
import type { AuditMetadata } from '../platform-identity/auditEventContract.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/**
 * A plain session operation is one short statement; `end` at most four, and `establish` at most eight — the
 * standing check's three (013's read, 009's lock, 013 again; M5-ADMIN-REVOKE-P1), whose lock may wait up to the
 * lock bound on a command of the same actor, then at most five of its own. The
 * bounds sit below the caller's port deadline, as the principal resolver's do: a statement that overruns
 * is cancelled by PostgreSQL itself rather than held by this process. The audited pair shares ONE port
 * deadline across its statements, so under contention it ends at the caller's deadline (a 503, fail
 * closed) — and a deadline reached during COMMIT is an unknown outcome, never "nothing committed".
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

/** The absolute expiry of `record`, from its OWN audience's lifetime, or a throw. */
function expiryOf(record: SessionRecord): number {
  // An OWN property, not a prototype-reachable one: `SESSION_TTL['constructor']` is not undefined.
  const lifetime = Object.hasOwn(SESSION_TTL, record.audience) ? SESSION_TTL[record.audience as SessionAudience] : undefined;
  if (lifetime === undefined) throw new SessionStoreUnavailable('audience_invalid');
  const expiresAt = record.createdAt + lifetime.absoluteMs;
  // Number.isSafeInteger already bounds this by MAX_SAFE_INTEGER; a second comparison would be dead.
  if (!Number.isSafeInteger(expiresAt)) throw new SessionStoreUnavailable('lifetime_invalid');
  return expiresAt;
}

// --- the audited pair (M6-ADMIN-AUDIT-P1) ---------------------------------------------------------

/**
 * How an audit record names a session: a one-way, domain-separated digest of its store key — itself already
 * the SHA-256 of the identifier (sessions.ts digestOf). Not the key: the key is the argument the session
 * routines accept and the runtime role may execute them, so a reader of the trail holding that role could
 * otherwise read, extend or end a live session. Stable, so a logout's record and the login record that
 * created that session carry the same reference.
 */
const sessionRefOf = (key: string): string =>
  createHash('sha256').update(`tmpos-audit-session-ref:v1\n${key}`).digest('base64url');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The runtime's entry as this store's record, checked BEFORE anything is sent — every field read once — and then
 * built and validated by the writer, which fixes every other column of a session event (auditEventWriter.ts
 * ADMIN_SESSION_AUDIT_EVENTS), so a refused record aborts nothing: nothing has begun. `establish` records a login or
 * a reauthentication, always of the actor admission selected, and the authentication time bound into the record it
 * creates; `end` records a logout, which names no actor and binds no authentication time.
 */
function auditRowOf(raw: unknown, operation: 'establish' | 'end', authenticated: number | null, metadata: AuditMetadata): AuditEventWriteInput {
  if (typeof raw !== 'object' || raw === null) throw new SessionStoreUnavailable('audit_invalid');
  const { action, operationId, actor, authenticatedAt } = raw as Record<string, unknown>;
  const known = operation === 'establish'
    ? (action === 'login' || action === 'reauthenticate' ? action : undefined)
    : (action === 'logout' ? action : undefined);
  // The operation id is the server's random UUID (sessions.ts), the record's request_id: never a client's value.
  if (known === undefined || typeof operationId !== 'string' || !UUID_RE.test(operationId)
    || (operation === 'establish' ? typeof actor !== 'string' : actor !== null) || authenticatedAt !== authenticated) {
    throw new SessionStoreUnavailable('audit_invalid');
  }
  // Outside the refusal below: a dropped key is this store's defect, not a refused record, and keeps its own word.
  persistedAuditMetadata(metadata, ADMIN_SESSION_AUDIT_EVENTS[known].actionId);
  try {
    return buildAdminSessionAuditEvent(known, operationId, actor as string | null, metadata);
  } catch {
    // The writer's label is safe but not this store's word; the caller learns only that the record was refused.
    throw new SessionStoreUnavailable('audit_invalid');
  }
}

/**
 * `metadata` exactly as the writer will persist it for `actionId`, or a throw: the writer STRIPS a key it does not
 * keep for an action (auditEventWriter.ts, action-scoped), and a session record that silently lost one — its
 * session reference above all — would commit a record that says less than this store decided to record.
 * Exported for its unit test; this file's audited pair is its only caller.
 */
export function persistedAuditMetadata(metadata: AuditMetadata, actionId: string): AuditMetadata {
  const kept = sanitizeAuditMetadata(metadata, actionId);
  const given = Object.keys(metadata);
  if (Object.keys(kept).length !== given.length || !given.every((k) => Object.hasOwn(kept, k) && kept[k] === metadata[k])) {
    throw new SessionStoreUnavailable('audit_metadata_dropped');
  }
  return kept;
}

/**
 * The record, through the existing writer, on the caller's transaction — its LAST statement. The executor hands the
 * writer's own frozen template and parameters to the kernel unchanged, and reads only the result's command and
 * count: exactly one row INSERTed, or the transaction rolls back (a BEFORE INSERT trigger answering NULL would
 * otherwise drop the record while the session change committed). The result itself is neither kept nor returned.
 */
async function writeSessionAudit(sql: PgTransactionScope, row: AuditEventWriteInput): Promise<void> {
  persistedAuditMetadata(row.metadata ?? {}, row.actionId);
  let inserted = false;
  const executor: AuditSqlExecutor = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]): Promise<void> => {
    const result = await sql(strings, ...values);
    if (Reflect.get(result, 'command') !== 'INSERT' || result.count !== 1) {
      throw new SessionStoreUnavailable('audit_not_written');
    }
    inserted = true;
  }, { json: (value: unknown) => sql.json(value) });
  await writeAuditEvent(row, { executor });
  if (!inserted) throw new SessionStoreUnavailable('audit_not_written');
}

/** The live record under `key` as this transaction reads it, or undefined when it names none. */
async function liveRecord(sql: PgTransactionScope, key: string, now: number): Promise<SessionRecord | undefined> {
  const rows = await sql`select * from tmpos_session.m5_session_get(${key}::text, ${now}::bigint)`;
  if (!Array.isArray(rows)) throw new SessionStoreUnavailable('answer_shape_invalid');
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) throw new SessionStoreUnavailable('answer_shape_invalid');
  return recordOf(rows[0]);
}

/**
 * Hold `held`, the record just read live under `key`, for the rest of this transaction: the touch writes back the
 * stamp as read — an UPDATE that changes nothing but takes the row's lock, waiting out any concurrent deleter, after
 * whose commit it answers 'absent'. True once this transaction holds it; false when another ended it first, in which
 * case nothing is changed.
 */
async function hold(sql: PgTransactionScope, key: string, held: SessionRecord): Promise<boolean> {
  const touched = only(await sql`select tmpos_session.m5_session_touch(${key}::text, 'validatedAt', ${held.validatedAt}::bigint) as outcome`, 'outcome');
  if (touched === 'absent') return false;
  if (touched !== 'updated') throw new SessionStoreUnavailable('not_updated');
  return true;
}

/**
 * End `held`, the record just read live under `key`, if THIS transaction is the one that ends it: held first (above),
 * and only then is the row deleted. True when this transaction ended it; false when another got there first, in which
 * case nothing is changed.
 */
async function endHeld(sql: PgTransactionScope, key: string, held: SessionRecord): Promise<boolean> {
  if (!(await hold(sql, key, held))) return false;
  if (only(await sql`select tmpos_session.m5_session_revoke(${key}::text) as outcome`, 'outcome') !== 'revoked') {
    throw new SessionStoreUnavailable('not_revoked');
  }
  return true;
}

/**
 * The live ADMINISTRATIVE session under `key`, held by the caller's transaction until it ends, or undefined when there
 * is none (M5-ADMIN-REVOKE-P1). The command transaction calls it — through the revalidator the transaction root builds —
 * so a command commits only while the very session that presented it is live: a logout, a revocation or a rotation that
 * committed first leaves nothing to hold (undefined), and one that comes later waits on the row lock taken here until the
 * command's COMMIT. Undefined, before anything is written, for a key naming no live record or a record of another
 * audience; the touch answering 'absent' (ended since the read) is undefined too. Any other doubt THROWS, and the
 * caller's kernel rolls back. `key` is a SQL parameter and nothing else: it is never returned, logged or recorded.
 */
export async function holdAdministrativeSession(sql: PgTransactionScope, key: string, now: number): Promise<SessionRecord | undefined> {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 1) throw new SessionStoreUnavailable('clock_invalid');
  const held = await liveRecord(sql, key, now);
  if (held === undefined || held.audience !== 'admin') return undefined;
  return (await hold(sql, key, held)) ? held : undefined;
}

/**
 * The administrative login's standing check, on establish's OWN transaction (M5-ADMIN-REVOKE-P1): true only while the
 * standing `record` was admitted at still holds, with the actor's authority locked until COMMIT. The transaction root
 * builds it (platformAuthorization.ts createPlatformEstablishCheck); this store only calls it, first. It throws for an
 * outage — never answering false for one — and the kernel rolls back.
 */
export type SessionStandingCheck = (sql: PgTransactionScope, record: SessionRecord) => Promise<boolean>;

export interface PostgresSessionStoreDeps {
  /** The kernel the composition root already built for this boundary — one client, one credential. */
  readonly client: SupervisedPgClient;
  /**
   * The clock a record's absolute expiry is measured against. Injected rather than read from the
   * global clock so the port's conformance suite — whose records are stamped at a fixed instant
   * (memorySessionStore.testkit.ts SESSION_CONTRACT_EPOCH) — can be run against this store unchanged.
   */
  readonly now?: () => number;
  /**
   * The standing check `establish` runs first (M5-ADMIN-REVOKE-P1). Optional only because the tenant boundary's
   * operations need none: `establish` without one THROWS ('standing_check_missing') and issues nothing, so no
   * administrative session is ever established on a standing this transaction did not re-read.
   */
  readonly standing?: SessionStandingCheck;
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
 * final; `revokePrincipal` ends one principal's sessions in this store's audience alone. `establish`
 * and `end` issue and end an administrative session with its audit record, one transaction each.
 */
export function createPostgresSessionStore(deps: PostgresSessionStoreDeps): SessionStore {
  const { client, standing } = deps;
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
      // An administrative session is written only by establish, with its audit record (M6-ADMIN-AUDIT-P1).
      if (record.audience === 'admin') throw new SessionStoreUnavailable('audit_required');
      // The record is the boundary's own, but the absolute expiry is this store's to compute: the port
      // carries no expiry field. The lifetime is the RECORD's own audience's, read from the runtime's
      // one table of lifetimes, so a record never outlives the boundary that issued it.
      const expiresAt = expiryOf(record);
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
      // No row is the ONE answer that is not a fault: this key names no live session. The record
      // carries its own audience; judging it is the boundary's, which refuses one stamped with another
      // (sessions.ts: session_wrong_audience). A store that filtered here would answer 'no such
      // session' for a record that exists, which the port reserves for a key that names none.
      return run(signal, (sql) => liveRecord(sql, key, now()));
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

    async establish(
      key: string, record: SessionRecord, replaces: string | null, audit: SessionEstablishAudit, signal: AbortSignal,
    ): Promise<'established' | 'session_ended' | 'standing_changed'> {
      // Fail closed: an administrative session is never established on a standing this transaction did not re-read.
      if (standing === undefined) throw new SessionStoreUnavailable('standing_check_missing');
      if (record.audience !== 'admin') throw new SessionStoreUnavailable('audience_invalid');
      const expiresAt = expiryOf(record);
      const metadata: AuditMetadata = {
        sessionRef: sessionRefOf(key), ...(record.authenticatedAt === null ? {} : { authenticatedAt: record.authenticatedAt }),
      };
      const row = auditRowOf(audit, 'establish', record.authenticatedAt, metadata);
      // Keyed on the action the runtime chose, which it chooses only on the path whose every same-principal check passed.
      const reauthenticating = row.actionId === ADMIN_SESSION_AUDIT_EVENTS.reauthenticate.actionId;
      return run(signal, async (sql) => {
        // 0. The standing, FIRST, on this very transaction (M5-ADMIN-REVOKE-P1): the admission the login read is read
        //    again with the actor's authority locked until COMMIT, so a change committed before this point refuses the
        //    login and one committed after it waits for this COMMIT. Refused: nothing written — nothing ended, created or
        //    recorded. A fault throws and the kernel rolls back (a 503); so does an answer that is neither boolean, which
        //    is a broken check, never a verdict about the standing.
        const standingHolds = await standing(sql, record);
        if (standingHolds === false) return 'standing_changed';
        if (standingHolds !== true) throw new SessionStoreUnavailable('standing_invalid');
        // 1. The presented session, when one is: ended by THIS transaction only if it reads it live and holds its lock.
        //    A reauthentication must END it, and it must be, in this order, live, administrative and the same
        //    principal's: anything else — a logout, a revocation or another reauthentication that committed first
        //    included — ends, creates and records nothing ('session_ended'); the checks precede the end, so a refusal
        //    deletes nothing. An ordinary login rotates as it always has: a record of another audience under the
        //    administrative cookie is still ended (rotation ends whatever it is presented), a key naming nothing live
        //    still establishes, and only an administrative one this transaction ended is named as replaced.
        const held = replaces === null ? undefined : await liveRecord(sql, replaces, now());
        if (reauthenticating && (held === undefined || held.audience !== 'admin' || held.principalKey !== record.principalKey
          || !(await endHeld(sql, replaces as string, held)))) return 'session_ended';
        const replaced = reauthenticating || (held !== undefined && (await endHeld(sql, replaces as string, held)) && held.audience === 'admin');
        // 2. The new session. A taken key fails the whole transaction, so the presented session is left as it was.
        const outcome = only(await sql`
          select tmpos_session.m5_session_create(
            ${key}::text, ${record.audience}::text, ${record.authProvider}::text, ${record.authProviderUid}::text,
            ${record.principalKey}::text, ${record.securityVersion}::text,
            ${record.authenticatedAt}::bigint, ${record.createdAt}::bigint,
            ${record.lastSeenAt}::bigint, ${record.validatedAt}::bigint, ${expiresAt}::bigint) as outcome`, 'outcome');
        if (outcome !== 'created') throw new SessionStoreUnavailable('not_created');
        // 3. Its record, last.
        await writeSessionAudit(sql, replaced ? { ...row, metadata: { ...metadata, replacedSessionRef: sessionRefOf(replaces as string) } } : row);
        return 'established';
      });
    },

    async end(key: string, audit: SessionEndAudit, signal: AbortSignal): Promise<'ended' | 'absent'> {
      const row = auditRowOf(audit, 'end', null, { sessionRef: sessionRefOf(key) });
      return run(signal, async (sql) => {
        const held = await liveRecord(sql, key, now());
        // Nothing live to end — another operation ended it first, or it reached its absolute expiry since the request's
        // own read: nothing is recorded, and an expired row still under the key is deleted, so an instance whose clock
        // runs behind this one's cannot go on accepting it. A key that names no row deletes nothing. The delete is by key,
        // after a read that found nothing live; a new live row can appear under this key in between only if another login
        // drew the same 32 random bytes, a collision this store treats as a fault everywhere else, so it deletes an expired row or none.
        if (held === undefined) {
          if (only(await sql`select tmpos_session.m5_session_revoke(${key}::text) as outcome`, 'outcome') !== 'revoked') {
            throw new SessionStoreUnavailable('not_revoked');
          }
          return 'absent';
        }
        if (held.audience !== 'admin') throw new SessionStoreUnavailable('audience_invalid');
        if (!(await endHeld(sql, key, held))) return 'absent';
        await writeSessionAudit(sql, row);
        return 'ended';
      });
    },
  });
}
