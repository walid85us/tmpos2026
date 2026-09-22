// Phase 4.0 M6 — the PostgreSQL distributed rate limiter: the first production adapter behind the runtime's
// DistributedRateLimiter port, over migration 014's routines (M6-RATE-P2; G-IDEMPOT, G-UNAUTH, G-CPLOGIN;
// docs/phase-4/10 ADR-26).
//
// WHAT IT DOES. Each consume is one transaction on the runtime kernel that calls m6_rate_limit_consume, which locks the
// bucket — unless the committed state already refuses it, answered from an unlocked read that writes nothing — decides on
// the database clock and answers allowed, limited or key_mismatch (migration 014 section 5); the probe
// calls m6_rate_limit_probe, which touches no bucket. Every instance built over the same database shares every bucket,
// so the port's contract — atomic across callers and instances, fixed windows, refused consumes spending nothing — is the
// store's, and the conformance suite (rateLimiter.testkit.ts) runs against it unchanged.
//
// ONE CONSUME PER BUCKET IN FLIGHT, PER INSTANCE. Consumes of one bucket serialize on its row in the database anyway, so a
// second one would only hold a connection while it waited for the first. Instead it waits here, holding nothing, until the
// one ahead of it has ended — under its own deadline, and an abort while waiting sends nothing. So one client, however many
// requests it sends at once, holds at most one of the kernel's connections per bucket it reaches, rather than one per
// request — though one reaching several buckets holds several, and many clients can still exhaust the kernel's
// connections. Nothing is queued past its caller: a waiter that is no longer wanted never runs. And the line is bounded:
// at RATE_LIMIT_LANE_DEPTH a further consume of that bucket is refused at once, joining nothing — so a line whose head
// cannot end (a COMMIT the network never answers, which only the kernel's own outcome ends) holds a bounded number of
// links however long it lasts, not one per request.
//
// RECLAIM, OUT OF BAND. After a consume it answers as having opened a window — the only kind that can add a bucket — the
// adapter owes one call of m6_rate_limit_reclaim, which deletes up to RECLAIM_BATCH expired buckets, each in a transaction
// of its own under RATE_LIMIT_RECLAIM_BOUNDS, at most one at a time per instance, never awaited: the consume has already
// answered, and a reclaim that fails or times out changes nothing. Calls owed while one runs are not dropped: when it ends having deleted a
// full batch, the next one runs; when it deletes less — the expired backlog is gone — or fails, nothing more is owed. So a
// burst of new clients is followed by up to as many reclaims as it opened windows, while each still finds a full batch.
// The bounds keep any lock a reclaim holds far shorter than a consume's lock wait, so a consume of an expired bucket a
// reclaim holds at that moment still gets its answer. The probe never reclaims.
//
// THE KEY. It is bound to the deployment's RATE_LIMIT_KEY — the same bytes the runtime keys its pseudonyms with — but
// keeps only the key's fingerprint, HMAC-SHA256(key, RATE_LIMIT_KEY_FINGERPRINT_CONTEXT), a constant used for nothing
// else. Every consume and probe presents it, and the store answers key_mismatch to any fingerprint other than the one
// registered first: an instance keyed differently from the rest counts nothing and is never ready, rather than silently
// giving every client a second bucket. Nothing here registers, replaces or erases a fingerprint on purpose; migration 014
// decides that.
//
// FAIL CLOSED, NEVER FAIL OPEN. A request outside the port's bounds is never sent. An abort, a lost connection, a timeout, a
// driver error, a serialization failure, a row count other than one, an unexpected column, a value of the wrong type or out
// of range, and key_mismatch all answer { outcome: 'unavailable' } — the probe false — and never an allowance. There is no
// retry, no queue to replay later, no cache of allowances or limits, and no fallback to any other limiter: with no
// database, this limiter allows nothing.
//
// BOUNDED. A call already aborted sends nothing. Every call is bounded by its caller's signal and by LIMITER_DEADLINE_MS
// here too, whichever ends first, and answers the moment that bound ends — even when its transaction's COMMIT is already on
// its way, whose outcome the kernel still supervises (supervisedPgClient.ts): an allowance committed after the bound is
// answered unavailable, at most one consume's cost spent without an allowance, never an allowance unrecorded. PostgreSQL
// itself cancels a statement past its bounds (RATE_LIMIT_STORE_BOUNDS, or RATE_LIMIT_RECLAIM_BOUNDS for a reclaim), below
// that cap, so the server does not keep working for a caller that has gone.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING. The caller hands it the kernel the composition root already built and the key
// the session root already parsed. Importing this file connects to nothing and reads no secret. Nothing is logged: the
// limiter key is a parameter, never part of a message, an error or a return value, and a driver error is discarded.
import { createHmac } from 'node:crypto';
import { secretKeyOf } from '../runtime/keyMaterial.js';
import { LIMITER_DEADLINE_MS, RATE_LIMIT_BOUNDS } from '../runtime/rateLimit.js';
import type { DistributedRateLimiter, RateLimitOutcome } from '../runtime/rateLimit.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/**
 * One consume is one short statement, so its server-side bounds sit below the runtime's 500 ms cap: a lock wait behind
 * another instance's consume of the same bucket or a reclaim holding it, the statement itself, and the pause before COMMIT.
 */
export const RATE_LIMIT_STORE_BOUNDS: TransactionBounds = Object.freeze({ lock: '200ms', statement: '300ms', idle: '400ms' });

/**
 * A reclaim is one statement that never waits on a lock (SKIP LOCKED), so its bounds are short: whatever row it holds, it
 * holds for well under a consume's 200 ms lock wait — its statement, then at most its idle bound before COMMIT.
 */
export const RATE_LIMIT_RECLAIM_BOUNDS: TransactionBounds = Object.freeze({ lock: '50ms', statement: '50ms', idle: '50ms' });

/**
 * The most consumes of one bucket one instance holds in line, the one in flight included. Past it a consume is refused at
 * once: a waiter that deep would outlive LIMITER_DEADLINE_MS behind the others anyway.
 */
export const RATE_LIMIT_LANE_DEPTH = 64;

/** The most expired buckets one m6_rate_limit_reclaim call deletes (migration 014). */
const RECLAIM_BATCH = 4;

/** The domain-separation constant of the key fingerprint: used for nothing else, and never with any other key. */
export const RATE_LIMIT_KEY_FINGERPRINT_CONTEXT = 'tmpos-rate-limit-key-fingerprint:v1';

/** The fingerprint migration 014 registers and compares: 32 bytes that reveal nothing usable of the key. */
export function rateLimitKeyFingerprint(keySecret: Uint8Array): Buffer {
  return createHmac('sha256', secretKeyOf(keySecret, 'rate_limit_key_invalid')).update(RATE_LIMIT_KEY_FINGERPRINT_CONTEXT).digest();
}

const UNAVAILABLE: RateLimitOutcome = Object.freeze({ outcome: 'unavailable' });
const SETTLED: Promise<void> = Promise.resolve();
const noop = (): void => undefined;
const NAMESPACES: ReadonlySet<unknown> = new Set(['runtime', 'tenant', 'admin', 'tenant-login', 'admin-login']);
const DIMENSIONS: ReadonlySet<unknown> = new Set(['client', 'account', 'tenant', 'store']);
/** The pseudonymous key: HMAC-SHA256 in unpadded base64url. */
const LIMITER_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const CONSUME_COLUMNS: readonly string[] = ['outcome', 'remaining', 'retry_after_ms'];

type Row = Readonly<Record<string, unknown>>;
interface Consume {
  readonly namespace: string;
  readonly dimension: string;
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly cost: number;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** The request, each field read once, if it is inside the port's bounds; otherwise nothing is sent. */
function consumeOf(request: unknown): Consume | null {
  if (typeof request !== 'object' || request === null) return null;
  const { namespace, dimension, key, limit, windowMs, cost } = request as Record<string, unknown>;
  if (!NAMESPACES.has(namespace) || !DIMENSIONS.has(dimension) || typeof key !== 'string' || !LIMITER_KEY_RE.test(key)) return null;
  if (!isInt(limit) || limit < 1 || limit > RATE_LIMIT_BOUNDS.maxLimit) return null;
  if (!isInt(windowMs) || windowMs < RATE_LIMIT_BOUNDS.minWindowMs || windowMs > RATE_LIMIT_BOUNDS.maxWindowMs) return null;
  if (!isInt(cost) || cost < 1 || cost > limit) return null;
  return { namespace: namespace as string, dimension: dimension as string, key, limit, windowMs, cost };
}

/** Exactly one row, with exactly the columns the routine declares — or nothing is trusted. */
function onlyRow(rows: unknown, columns: readonly string[]): Row | null {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null) return null;
  const keys = Object.keys(row as Record<string, unknown>);
  if (keys.length !== columns.length || !columns.every((c) => keys.includes(c))) return null;
  return row as Row;
}

/** The routine's answer as the port's, if it is exactly one of its two in-contract shapes; anything else is null. */
function outcomeOf(rows: unknown, request: Consume): RateLimitOutcome | null {
  const row = onlyRow(rows, CONSUME_COLUMNS);
  if (row === null) return null;
  const { outcome, remaining, retry_after_ms: wait } = row;
  if (outcome === 'allowed' && wait === null && isInt(remaining) && remaining >= 0 && remaining <= request.limit - request.cost) {
    return Object.freeze({ outcome: 'allowed', remaining });
  }
  if (outcome === 'limited' && remaining === null && isInt(wait) && wait >= 1 && wait <= request.windowMs) {
    return Object.freeze({ outcome: 'limited', retryAfterMs: wait });
  }
  return null; // key_mismatch, or a routine this file was not written against
}

/**
 * The production limiter over the M6 runtime kernel. `client` is the kernel the transaction root built — one client,
 * one credential, one governed endpoint; `keySecret` is RATE_LIMIT_KEY as the session root parsed it (32–64 bytes;
 * anything else refuses here, before any limiter exists).
 */
export function createPostgresRateLimiter(deps: { readonly client: SupervisedPgClient; readonly keySecret: Uint8Array }): DistributedRateLimiter {
  const { client } = deps;
  const fingerprint = rateLimitKeyFingerprint(deps.keySecret);
  /**
   * Per bucket, this instance's line: `tail` settles once every consume in it has ended, and `members` counts the links
   * not yet passed — a waiter that gave up still counts until the line reaches it, so the count bounds what is held.
   */
  const lanes = new Map<string, { tail: Promise<void>; members: number }>();
  /** Whether a reclaim transaction is in flight on this instance, and how many window openings still await one. */
  let reclaiming = false;
  let owed = 0;

  /**
   * `work` in one kernel transaction under `bounds`, once `ahead` has settled, bounded by the caller's signal and
   * LIMITER_DEADLINE_MS. Answers `fallback` the moment that bound ends — while waiting, or with a statement or even COMMIT
   * on its way — and on any failure. `ended` runs once the transaction has really ended, with its value (undefined if it
   * failed), or at once if none started.
   */
  const run = async <T>(
    signal: AbortSignal, bounds: TransactionBounds, work: (sql: PgTransactionScope) => Promise<T>, fallback: T,
    ahead: Promise<void> = SETTLED, ended: (value: T | undefined) => void = noop,
  ): Promise<T> => {
    const bound = new AbortController();
    const stop = (): void => bound.abort();
    const stopped = new Promise<T>((resolve) => bound.signal.addEventListener('abort', () => resolve(fallback), { once: true }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    try {
      if (!(signal instanceof AbortSignal) || signal.aborted) return fallback; // nothing is sent
      signal.addEventListener('abort', stop, { once: true });
      timer = setTimeout(stop, LIMITER_DEADLINE_MS);
      await Promise.race([ahead, stopped]);
      if (bound.signal.aborted) return fallback; // its deadline passed while it waited: nothing is sent
      const transaction = Promise.resolve().then(() => client.transaction(bound.signal, bounds, work));
      started = true;
      // The bucket stays this call's until the kernel has finished with it.
      void transaction.then(ended, () => ended(undefined));
      return await Promise.race([transaction, stopped]);
    } catch {
      return fallback; // an outage, an abort, an overrun or a driver fault: nothing is disclosed
    } finally {
      if (!started) ended(undefined); // first: nothing below may keep a line held
      clearTimeout(timer);
      if (signal instanceof AbortSignal) signal.removeEventListener('abort', stop);
    }
  };

  /** Best effort: at most one at a time, never awaited; a full batch deleted while more are owed runs the next. */
  const startReclaim = (): void => {
    reclaiming = true;
    owed -= 1;
    void run(new AbortController().signal, RATE_LIMIT_RECLAIM_BOUNDS, async (sql) => {
      const row = onlyRow(await sql`select tmpos_rate_limit.m6_rate_limit_reclaim()`, ['m6_rate_limit_reclaim']);
      return row === null ? null : row.m6_rate_limit_reclaim;
    }, null, SETTLED, (deleted) => {
      reclaiming = false;
      if (deleted === RECLAIM_BATCH && owed > 0) startReclaim();
      else owed = 0; // the backlog is cleared, or the store is failing: nothing more is owed
    });
  };
  /** Owe one reclaim for a window that opened. */
  const reclaim = (): void => {
    owed += 1;
    if (!reclaiming) startReclaim();
  };

  return Object.freeze({
    async consume(request: unknown, signal: AbortSignal): Promise<RateLimitOutcome> {
      let parsed: Consume | null;
      try {
        // A call already aborted sends nothing and joins no line.
        parsed = signal instanceof AbortSignal && !signal.aborted ? consumeOf(request) : null;
      } catch {
        return UNAVAILABLE; // a hostile request object — a throwing getter — is never sent
      }
      if (parsed === null) return UNAVAILABLE;
      const consume = parsed;
      const { namespace, dimension, key, limit, windowMs, cost } = consume;

      // Join this bucket's line: wait for the consume ahead, and hold the line until this one's transaction has ended.
      const bucket = `${namespace}\n${dimension}\n${limit}\n${windowMs}\n${key}`;
      const lane = lanes.get(bucket) ?? { tail: SETTLED, members: 0 };
      if (lane.members >= RATE_LIMIT_LANE_DEPTH) return UNAVAILABLE; // the line is full: refused at once, nothing held
      lanes.set(bucket, lane);
      lane.members += 1;
      const ahead = lane.tail;
      let release: () => void = noop;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      const tail = ahead.then(() => mine);
      lane.tail = tail;
      void tail.then(() => {
        lane.members -= 1;
        if (lane.members === 0) lanes.delete(bucket); // every consume in it has ended
      });

      const outcome = await run(signal, RATE_LIMIT_STORE_BOUNDS, async (sql) => {
        const rows = await sql`select outcome, remaining, retry_after_ms
          from tmpos_rate_limit.m6_rate_limit_consume(${fingerprint}::bytea, ${namespace}::text, ${dimension}::text, ${key}::text,
                                                      ${limit}::integer, ${windowMs}::integer, ${cost}::integer)`;
        return outcomeOf(rows, consume) ?? UNAVAILABLE;
      }, UNAVAILABLE, ahead, () => release());
      // Only a consume that opened a window can have added a bucket: that is when expired ones are reclaimed.
      if (outcome.outcome === 'allowed' && outcome.remaining === limit - cost) reclaim();
      return outcome;
    },

    /** Readiness: exactly true only when the store answers 'ready' for this key — writable, the consume executable, key registered. */
    probe(signal: AbortSignal): Promise<boolean> {
      return run(signal, RATE_LIMIT_STORE_BOUNDS, async (sql) => {
        const rows = await sql`select outcome from tmpos_rate_limit.m6_rate_limit_probe(${fingerprint}::bytea)`;
        const row = onlyRow(rows, ['outcome']);
        return row !== null && row.outcome === 'ready';
      }, false);
    },
  });
}
