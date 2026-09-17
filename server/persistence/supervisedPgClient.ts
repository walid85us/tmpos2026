// Phase 4.0 M6-PG-P6/P7 — the transactional store's transaction kernel (docs/phase-4/08 DA-15, DA-19, DA-20, DA-21).
//
// The only way the store reaches PostgreSQL. It owns every transaction from BEGIN to COMMIT or ROLLBACK on one reserved
// connection, and hands the driver each statement — BEGIN, the transaction-local settings, every statement of the body,
// COMMIT and ROLLBACK — through one dispatcher behind one gate. Nothing else of the driver is used: no begin(), no
// savepoint, no pooled query but the one that opens a pool's connection (below), and neither a pool nor a reserved
// connection ever leaves this file.
//
// Why. The pinned driver (postgres 3.4.9, the latest release; no released version fixes this) writes a statement it is
// handed after its connection closed to a socket it has already dropped, from a scheduled callback nothing can catch, and
// the process exits (DA-15 (1)). Its own begin() races the transaction's scope against the close and leaves that scope
// running, so a statement, COMMIT or ROLLBACK could still be handed over after the close (DA-19), and a nested savepoint
// scope escapes even that (DA-20). A connection that closes in the same turn as a write can keep a stale write timer and
// never reconnect (DA-15 (2)), and a pool reconnects a closed connection object for whatever query waits next. Its
// reserve() leaves its request in that queue when the connection attempt fails, so the pool reconnects for a request
// already refused — and end() does not stop a reconnect already scheduled: an ended pool can still open a session
// nobody owns (DA-15 (3)).
//
// So, by construction:
//   * Pools of ONE connection. The driver's close callback (its typed `onclose` option) names nothing a caller could map
//     to a transaction; a pool of one makes the pool the connection. The kernel builds every pool itself — `max` forced to
//     1 and `onclose` its own — so that correspondence rests on no caller. `max` in the options is the number of such
//     pools. A transaction beyond it waits here, in order, until a pool is free or its signal aborts: the driver's own
//     queue never holds another transaction's statement, so no closed connection object is reconnected for it.
//   * Opened before reserved. A new pool's connection is opened by one plain statement through the same gate — which
//     the driver hands straight to the connection it opens, never to its queue — and only a pool whose connection has
//     answered is reserved, which then takes that open connection at once. So no failed attempt leaves a request queued,
//     and a retired pool has no refused request to reconnect for. (The driver still retries, at once, an attempt whose
//     socket closes without an error while it connects; if the call is abandoned, or end() runs out of grace, during those
//     retries, the next one can still open a session after its pool was ended, which the idle timeout closes.)
//   * A gate per transaction, closed synchronously. The driver calls `onclose` inside its close handling, after it has
//     rejected the statement in flight and before any code awaiting it runs, and the kernel's callback closes the gate of
//     the transaction holding that pool in that same call. A statement that fails in a way that may have lost the
//     connection closes the gate too, before anything awaiting the failure runs. And the gate is checked where the driver
//     takes a statement — in the statement's own hand-off to its connection, which the driver makes a microtask after the
//     statement is built — so a statement built before a close is still never handed over after it.
//   * Never used again. A pool whose connection closed, or whose transaction stopped trusting it, is retired: ended at
//     once, never released, never given to another transaction. The next transaction opens a fresh pool.
//   * ROLLBACK only on a connection still demonstrably usable — the gate open, nothing in flight. Otherwise the pool is
//     retired, and the server rolls the transaction back when its session ends.
//   * Reset before reuse. A transaction ends, but its session does not: a setting or role the body changed for the session,
//     a session advisory lock, LISTEN, a held cursor, a temporary object, sequence state would all reach the next
//     transaction on that connection. So a connection goes back to its pool only when the transaction's outcome is known —
//     COMMIT or ROLLBACK acknowledged — nothing is in flight, the gate is open, its caller has not aborted, and DISCARD ALL,
//     sent by the kernel through the same gate, has been acknowledged; only then can the next transaction, or a caller
//     waiting, have the pool. Anything else retires it. DISCARD ALL also removes prepared statements, so every pool is
//     built with the driver's `prepare` forced off: the driver then names no statement, has none to lose, and never sends
//     one again by itself (with it on, a statement the reset removed is re-sent by the driver, outside this gate). The body's
//     statement function stops working once the body settles, so one kept past it cannot reach the connection after its
//     reset, or another transaction's. DISCARD ALL leaves random()'s seed, and the name — not the value — of a custom
//     setting once defined, which reads '' after. A pool of one is one server session only over a direct or session-mode
//     connection: behind a transaction-mode pooler the reset could reach a different backend, so the store is never bound
//     through one.
//   * A body statement runs one at a time: frozen template text — which the driver reads again when it executes the
//     statement, so it must not be able to change in between — beginning with SELECT, INSERT, UPDATE, DELETE, WITH or
//     VALUES, and plain values only. Anything else — transaction control, SAVEPOINT, COPY, SET, DO, CALL, LOCK — is
//     refused before the driver is asked. A statement is one command (the extended protocol carries no second), so the
//     kernel's own BEGIN, COMMIT and ROLLBACK are the only transaction control that reaches the server; and an answer
//     that is not rows (a COPY stream) closes the gate.
//
// Answers. The body's value once COMMIT is acknowledged; the body's own failure once ROLLBACK is acknowledged, so the
// caller can read it. Otherwise one of two fixed failures that carry nothing of the driver: outcomeUnknown once COMMIT
// was handed to the driver and never acknowledged — it may have committed; unavailable for everything else — nothing
// committed — including a COMMIT the server answers ROLLBACK, as it does for a block an earlier error aborted. An abort before
// COMMIT is handed over answers unavailable at once and retires the pool then, cancelling any body statement in flight first,
// so a body or a statement that never finishes holds no pool; the server rolls the transaction back as the session ends. (A
// cancel is addressed to the session, not to the statement, so a pool that saw one is never reused.) An abort while ROLLBACK
// is on its way retires the pool too, and answers once ROLLBACK does. The answer is fixed once COMMIT or
// ROLLBACK is acknowledged, before the reset: a reset that fails, or a close or abort while it runs, retires the pool and
// changes nothing about the answer, which an abort or a close then gives at once. Nothing is retried or replayed.
import type { PgRows } from './postgresTransactionalStore.js';

/** A statement the driver has built: a promise of its rows that runs when first awaited, handed to its connection by `handler`. */
interface DriverQuery extends PromiseLike<PgRows> {
  handler: unknown;
  cancel(): unknown;
  reject(reason: unknown): void;
}
/** Builds one statement on the driver's connection. */
type DriverStatement = (strings: TemplateStringsArray, ...values: unknown[]) => DriverQuery;
/** The driver's reserved connection (postgres.js ReservedSql). Never leaves this file. */
export interface DriverReserved extends DriverStatement {
  json(value: unknown): unknown;
  release(): void;
}
/** A driver pool (postgres.js Sql) — here always of exactly one connection. Never leaves this file. */
export interface DriverPool extends DriverStatement {
  reserve(): Promise<DriverReserved>;
  end(options: { timeout: number }): Promise<unknown>;
}
/** The driver's pool constructor: postgres.js's default export. */
export type PgDriver = (url: string, options: Record<string, unknown>) => DriverPool;

/** What the body is handed: one statement at a time through the gate, and the JSON parameter a statement may bind. */
export interface PgTransactionScope {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<PgRows>;
  readonly json: (value: unknown) => unknown;
}
/** A transaction's server-side bounds, each `<n>ms`: a lock wait, one statement, an idle transaction. */
export interface TransactionBounds {
  readonly lock: string;
  readonly statement: string;
  readonly idle: string;
}

/** Why a transaction ended with neither the body's value nor its own failure. Carries nothing else. */
export class TransactionFailure {
  private constructor(readonly outcomeUnknown: boolean) {}
  /** Nothing committed. */
  static readonly unavailable: TransactionFailure = Object.freeze(new TransactionFailure(false));
  /** COMMIT was handed to the driver and never acknowledged: it may have committed. */
  static readonly outcomeUnknown: TransactionFailure = Object.freeze(new TransactionFailure(true));
}

export interface SupervisedPgClient {
  /**
   * `work` in one transaction on one reserved connection under `bounds`: its value once committed; its own failure once
   * rolled back; otherwise TransactionFailure.unavailable, or TransactionFailure.outcomeUnknown. The connection is reset
   * before it serves another transaction, or its pool retired; neither changes the answer.
   */
  transaction<T>(signal: AbortSignal, bounds: TransactionBounds, work: (sql: PgTransactionScope) => Promise<T>): Promise<T>;
  /** Refuses every later transaction, lets those in flight finish for up to RETIRED_POOL_GRACE_S, then ends every pool. */
  end(): Promise<void>;
}

/** Seconds end() lets transactions in flight finish before their connections are closed under them. */
export const RETIRED_POOL_GRACE_S = 5;
/** The most one-connection pools one client holds: the runtime principal's connection budget. */
export const MAX_POOLS = 10;

const BOUND_RE = /^[1-9][0-9]{0,6}ms$/;
/** A statement's first word, after leading whitespace only: a comment, a semicolon or anything else first is refused. */
const LEADING_WORD_RE = /^\s*([A-Za-z]+)(?![A-Za-z0-9_$])/;
/** The only words a body statement may begin with: a query or a row change, nothing that controls the transaction or the session. */
const BODY_WORDS: ReadonlySet<string> = new Set(['select', 'insert', 'update', 'delete', 'with', 'values']);
const DRIVER_LOCAL_CODES: readonly string[] = ['57014', 'UNDEFINED_VALUE', 'MAX_PARAMETERS_EXCEEDED'];
const noop = (): void => undefined;

/** Refused before the driver was asked; the connection is untouched. */
const REFUSED = Object.freeze(new Error('transactional_store_statement_refused'));
/** The gate is closed: the connection is lost, or no longer trusted. */
const CLOSED = Object.freeze(new Error('transactional_store_connection_closed'));

/** A server-reported ERROR on an open connection: never a lost connection, a connection exception (08) or an operator intervention (57P). */
export function isStatementError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, severity } = err as { code?: unknown; severity?: unknown };
  return severity === 'ERROR' && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !/^(?:08|57P)/.test(code);
}

/** A failure after which the connection is still usable: a server statement ERROR, or a refusal the driver raised itself. */
function leavesConnectionOpen(err: unknown): boolean {
  if (isStatementError(err)) return true;
  if (typeof err !== 'object' || err === null) return false;
  const { code, severity } = err as { code?: unknown; severity?: unknown };
  return severity === undefined && typeof code === 'string' && DRIVER_LOCAL_CODES.includes(code);
}

const tagged = (...parts: string[]): TemplateStringsArray =>
  Object.freeze(Object.assign([...parts], { raw: Object.freeze([...parts]) })) as unknown as TemplateStringsArray;
const OPEN = tagged('select 1');
const BEGIN = tagged('begin');
const COMMIT = tagged('commit');
const ROLLBACK = tagged('rollback');
/** The whole session back to how it opened: CLOSE ALL, SET SESSION AUTHORIZATION DEFAULT, RESET ALL, DEALLOCATE ALL, UNLISTEN *, pg_advisory_unlock_all(), DISCARD PLANS, TEMP and SEQUENCES. Refused inside a transaction block. */
const RESET = tagged('discard all');
// The transaction's bounds, and its search path: pg_catalog, then pg_temp — no schema a less privileged role could write to,
// so an operator or function placed there is never a candidate beside pg_catalog's own.
const SETTINGS = tagged("select pg_catalog.set_config('lock_timeout', ", ", true), pg_catalog.set_config('statement_timeout', ",
  ", true), pg_catalog.set_config('idle_in_transaction_session_timeout', ",
  ", true), pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)");

interface Pool {
  readonly driver: DriverPool;
  /** Its connection has answered a statement, so a reserve() takes it at once. */
  opened: boolean;
  /** Its connection closed, or a transaction on it stopped trusting it: never used again. */
  closed: boolean;
  /** The gate of the transaction holding it, while one does. */
  gate: Gate | null;
}
interface Gate {
  closed: boolean;
  /** Told when the connection closes under the transaction: it answers at once, unless COMMIT is on its way. */
  readonly lost: () => void;
}
interface Waiter {
  readonly resolve: (pool: Pool) => void;
  readonly reject: () => void;
}
/** A transaction's answer: the body's value, or the failure it ends with. */
type Outcome = { readonly value: unknown } | { readonly failure: unknown };
interface Flight {
  /** COMMIT is on its way: only its own outcome answers, not an abort nor a close. */
  committing: boolean;
  /** ROLLBACK is on its way: a close answers with its outcome, a few microtasks on, not before it. */
  rollingBack: boolean;
  /** The answer, once COMMIT or ROLLBACK has settled it: nothing after — the reset, a close, an abort — changes it. */
  outcome: Outcome | null;
  inFlight: DriverQuery | null;
  /** Answers at once: the known outcome, or unavailable while none is known. */
  abandon: () => void;
  /** Stops trusting the connection: nothing more is sent on it, and its pool is retired — at once, if the answer is known. */
  distrust: () => void;
}

/**
 * Template text that cannot change after it is checked: a frozen array of strings, each index a data property, with a frozen
 * `raw` — as every template literal is. The driver reads the text again when the statement executes, a microtask later.
 */
function isFixedText(strings: unknown): strings is TemplateStringsArray {
  if (!Array.isArray(strings) || !Object.isFrozen(strings) || strings.length === 0) return false;
  const raw: unknown = (strings as { raw?: unknown }).raw;
  if (!Array.isArray(raw) || !Object.isFrozen(raw)) return false;
  for (let i = 0; i < strings.length; i++) {
    const own = Object.getOwnPropertyDescriptor(strings, i);
    if (own === undefined || !('value' in own) || typeof own.value !== 'string') return false;
  }
  return true;
}

const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const isPlainValue = (v: unknown): boolean =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' || v instanceof Date || v instanceof Uint8Array;

/**
 * The kernel over `driver` (postgres.js's default export) for `url` and the driver `options` — the runtime principal's,
 * with its transport. `options.max` (1..MAX_POOLS) is the number of one-connection pools; each is built with `max: 1` and
 * the kernel's own close callback, which then tells `options.onclose`, if any.
 */
export function createSupervisedPgClient(driver: PgDriver, url: string, options: Readonly<Record<string, unknown>>): SupervisedPgClient {
  if (typeof driver !== 'function' || typeof url !== 'string' || !isRecord(options)) throw new TypeError('createSupervisedPgClient: invalid arguments');
  const { max, onclose: observer } = options;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > MAX_POOLS || (observer !== undefined && typeof observer !== 'function')) {
    throw new TypeError('createSupervisedPgClient: invalid arguments');
  }
  const poolCount: number = max;
  const pools = new Set<Pool>();
  const idle: Pool[] = [];
  const waiters: Waiter[] = [];
  const ending = new Set<Promise<void>>();
  const running = new Set<Promise<unknown>>();
  let ended = false;

  function retire(pool: Pool): void {
    pool.closed = true;
    if (pool.gate !== null) {
      // Closed under a transaction still holding it (end()'s grace ran out): it answers now, not when the socket closes.
      pool.gate.closed = true;
      pool.gate.lost();
    }
    const at = idle.indexOf(pool);
    if (at >= 0) idle.splice(at, 1);
    if (!pools.delete(pool)) return;
    // No wait: a retired pool has no transaction left to finish, so whatever is still open closes at once.
    const done = Promise.resolve().then(() => pool.driver.end({ timeout: 0 })).then(noop, noop);
    ending.add(done);
    void done.then(() => ending.delete(done));
    serve();
  }

  function open(): Pool {
    const pool = { opened: false, closed: false, gate: null } as Pool & { driver: DriverPool };
    const onclose = (...args: unknown[]): void => {
      // Synchronous, inside the driver's close handling: the gate shuts before anything awaiting the connection runs.
      pool.closed = true;
      if (pool.gate !== null) {
        pool.gate.closed = true;
        pool.gate.lost();
      } else retire(pool); // no transaction holds it: an idle pool's connection ended (an idle timeout, the server)
      if (typeof observer === 'function') {
        try {
          const told: unknown = observer(...args);
          if (told instanceof Promise) told.catch(noop);
        } catch {
          // an observer's failure changes nothing here
        }
      }
    };
    // `prepare` off: DISCARD ALL removes prepared statements, and a driver that kept one would send it again by itself.
    pool.driver = driver(url, { ...options, max: 1, prepare: false, onclose });
    pools.add(pool);
    return pool;
  }

  /** A free pool, a new one while there is room, or null. */
  function take(): Pool | null {
    const pool = idle.pop();
    if (pool !== undefined) return pool;
    return pools.size < poolCount ? open() : null;
  }

  function serve(): void {
    // inv: every waiter ahead of the first still waiting holds a pool; term: each pass removes a waiter or returns.
    while (waiters.length > 0 && !ended) {
      const pool = take();
      if (pool === null) return;
      (waiters.shift() as Waiter).resolve(pool);
    }
  }

  const acquire = (signal: AbortSignal): Promise<Pool> => new Promise<Pool>((resolve, reject) => {
    const pool = take();
    if (pool !== null) {
      resolve(pool);
      return;
    }
    const onAbort = (): void => {
      const at = waiters.indexOf(waiter);
      if (at >= 0) waiters.splice(at, 1);
      reject(TransactionFailure.unavailable);
    };
    const waiter: Waiter = {
      resolve: (p) => {
        signal.removeEventListener('abort', onAbort);
        resolve(p);
      },
      reject: () => {
        signal.removeEventListener('abort', onAbort);
        reject(TransactionFailure.unavailable);
      },
    };
    signal.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
  });

  /** The pool back once a transaction is done with it: idle again only when nothing leaves the connection in doubt — and, once anything was sent on it, only after its reset. */
  function giveBack(pool: Pool, reserved: DriverReserved | null, usable: boolean): void {
    const gate = pool.gate;
    pool.gate = null;
    if (!usable || ended || pool.closed || (gate !== null && gate.closed)) {
      retire(pool);
      return;
    }
    if (reserved !== null) {
      try {
        reserved.release();
      } catch {
        retire(pool);
        return;
      }
    }
    idle.push(pool);
    serve();
  }

  async function run<T>(signal: AbortSignal, bounds: TransactionBounds, work: (sql: PgTransactionScope) => Promise<T>, flight: Flight): Promise<T> {
    const pool = await acquire(signal);
    const gate: Gate = { closed: pool.closed, lost: () => { if (flight.outcome !== null || !(flight.committing || flight.rollingBack)) flight.abandon(); } };
    pool.gate = gate;
    flight.distrust = () => {
      gate.closed = true;
      // Nothing on this connection is waited out — a body, a statement or a reset that never finishes: the pool is retired
      // now and a waiting caller served — while it is still this transaction's, never once it is idle again or another's.
      if (pool.gate === gate) retire(pool);
    };
    if (gate.closed || signal.aborted) {
      giveBack(pool, null, true);
      throw TransactionFailure.unavailable;
    }
    let commitHandedOver = false;

    /** THE dispatcher: every statement of this transaction, the kernel's own included — on the pool only to open it. */
    const dispatch = (sql: DriverStatement, strings: TemplateStringsArray, values: readonly unknown[], ending: 'commit' | 'rollback' | null = null): Promise<PgRows> => {
      if (gate.closed) return Promise.reject(CLOSED);
      if (flight.inFlight !== null) return Promise.reject(REFUSED);
      const query = sql(strings, ...values);
      const handOver = query.handler;
      if (typeof handOver !== 'function') {
        gate.closed = true; // not the driver this kernel was written against: trust nothing more on this connection
        return Promise.reject(CLOSED);
      }
      // The driver hands a statement to its connection only through this call, a microtask after building it: checked
      // here, a close processed in between still keeps the statement off the connection.
      query.handler = (q: DriverQuery): unknown => {
        if (gate.closed) {
          q.reject(CLOSED);
          return undefined;
        }
        if (ending === 'commit') {
          // From here COMMIT is on its way: neither an abort nor a close answers before its own outcome does.
          commitHandedOver = true;
          flight.committing = true;
        } else if (ending === 'rollback') {
          // ROLLBACK too, for a close — which the driver reports only after rejecting it, so its outcome follows at once. An
          // acknowledgement the close lands behind still settles the answer: the body's own failure.
          flight.rollingBack = true;
        }
        return (handOver as (q: DriverQuery) => unknown)(q);
      };
      flight.inFlight = query;
      return new Promise<PgRows>((resolve, reject) => {
        query.then((rows) => {
          flight.inFlight = null;
          if (!Array.isArray(rows)) {
            // Not rows — a COPY stream, which the driver keeps open and would destroy with an error nothing listens for.
            const stream = rows as { on?: unknown };
            if (typeof stream.on === 'function') (stream.on as (event: string, listener: () => void) => void)('error', noop);
            gate.closed = true;
            reject(CLOSED);
            return;
          }
          Reflect.deleteProperty(rows, 'state'); // the connection's live cancel key: not the body's to hold
          resolve(rows);
        }, (err: unknown) => {
          flight.inFlight = null;
          if (!leavesConnectionOpen(err)) gate.closed = true; // before anything awaiting this statement runs
          reject(err);
        });
      });
    };

    if (!pool.opened) {
      // A reserve() on a connection not yet open queues its request, and a failed attempt leaves it queued (DA-15 (3));
      // a plain statement opens the connection without the queue, and resolves only once it is open again.
      try {
        await dispatch(pool.driver, OPEN, []);
      } catch {
        giveBack(pool, null, false);
        throw TransactionFailure.unavailable;
      }
      pool.opened = true;
      if (gate.closed || signal.aborted) {
        giveBack(pool, null, true);
        throw TransactionFailure.unavailable;
      }
    }
    let reserved: DriverReserved;
    try {
      reserved = await pool.driver.reserve();
    } catch {
      giveBack(pool, null, false);
      throw TransactionFailure.unavailable;
    }
    if (gate.closed || signal.aborted) {
      giveBack(pool, reserved, true); // nothing was sent on it
      throw TransactionFailure.unavailable;
    }
    const params = new WeakSet<object>();
    /** The body has settled: its statement function — kept past it, or called from a timer — reaches nothing any more. */
    let bodyDone = false;

    const statement = (strings: TemplateStringsArray, ...values: unknown[]): Promise<PgRows> => {
      const leading = isFixedText(strings) ? LEADING_WORD_RE.exec(strings[0]) : null;
      if (leading === null || !BODY_WORDS.has(leading[1].toLowerCase())) return Promise.reject(REFUSED);
      if (!values.every((v) => isPlainValue(v) || (typeof v === 'object' && v !== null && params.has(v)))) return Promise.reject(REFUSED);
      if (bodyDone || signal.aborted) return Promise.reject(REFUSED);
      return dispatch(reserved, strings, values);
    };
    const json = (value: unknown): unknown => {
      const param = reserved.json(value);
      if (typeof param === 'object' && param !== null) params.add(param);
      return param;
    };
    const scope: PgTransactionScope = Object.freeze(Object.assign(statement, { json }));

    /** ROLLBACK iff the connection is still demonstrably usable: nothing in flight, the gate open. True once acknowledged. */
    const rollback = async (): Promise<boolean> => {
      // inv: at most one statement is in flight, and dispatch clears it as it settles; term: that statement settles.
      while (flight.inFlight !== null) {
        const pending = flight.inFlight;
        await new Promise<void>((resolve) => { pending.then(() => resolve(), () => resolve()); });
      }
      if (gate.closed) return false;
      try {
        await dispatch(reserved, ROLLBACK, [], 'rollback');
        return true; // a close after the acknowledgement leaves the transaction rolled back; the reset then refuses the connection
      } catch {
        return false;
      }
    };

    /**
     * DISCARD ALL iff the connection may serve another transaction: nothing in flight, the gate open, the caller still
     * waiting (its signal is what bounds the reset), the client not ending. True once acknowledged with the gate still open.
     */
    const reset = async (): Promise<boolean> => {
      if (gate.closed || flight.inFlight !== null || signal.aborted || ended) return false;
      try {
        await dispatch(reserved, RESET, []);
        return !gate.closed;
      } catch {
        return false;
      }
    };
    /**
     * The transaction's answer is `outcome`, fixed before anything more is sent. A connection whose transaction definitely
     * ended — COMMIT or ROLLBACK acknowledged — is reset, and only a reset connection is released; otherwise, or when the
     * reset fails, the pool is retired. Only then is the pool free for a waiter — and only then does the answer return.
     */
    const settle = async (outcome: Outcome, definitelyEnded: boolean): Promise<T> => {
      flight.outcome = outcome;
      giveBack(pool, reserved, definitelyEnded && await reset());
      if ('value' in outcome) return outcome.value as T;
      throw outcome.failure;
    };

    try {
      await dispatch(reserved, BEGIN, []);
      await dispatch(reserved, SETTINGS, [bounds.lock, bounds.statement, bounds.idle]);
    } catch {
      return settle({ failure: TransactionFailure.unavailable }, await rollback());
    }
    let value: T;
    try {
      value = await work(scope);
    } catch (bodyFailure) {
      bodyDone = true;
      const rolledBack = await rollback();
      return settle({ failure: rolledBack && !signal.aborted ? bodyFailure : TransactionFailure.unavailable }, rolledBack);
    }
    bodyDone = true;
    if (gate.closed || signal.aborted || flight.inFlight !== null) {
      // The connection is in doubt, the deadline passed during the body, or the body left a statement running: never commit.
      return settle({ failure: TransactionFailure.unavailable }, await rollback());
    }
    let committed: PgRows;
    try {
      committed = await dispatch(reserved, COMMIT, [], 'commit');
    } catch (err) {
      // Refused before the driver took it: nothing was sent. A server ERROR at COMMIT rolled the transaction back on a
      // connection still open. Anything else, once COMMIT was handed over, may have committed.
      const rolledBack = !commitHandedOver || (isStatementError(err) && !gate.closed);
      return settle({ failure: rolledBack ? TransactionFailure.unavailable : TransactionFailure.outcomeUnknown }, commitHandedOver && rolledBack);
    }
    // A block that an error the body caught left aborted ends at COMMIT with the answer ROLLBACK, and no error: nothing
    // committed, and the transaction did end.
    if (Reflect.get(committed, 'command') !== 'COMMIT') return settle({ failure: TransactionFailure.unavailable }, true);
    return settle({ value }, true);
  }

  return Object.freeze({
    async transaction<T>(signal: AbortSignal, bounds: TransactionBounds, work: (sql: PgTransactionScope) => Promise<T>): Promise<T> {
      if (ended || !(signal instanceof AbortSignal) || signal.aborted || typeof work !== 'function' || !isRecord(bounds)
        || ![bounds.lock, bounds.statement, bounds.idle].every((b) => typeof b === 'string' && BOUND_RE.test(b))) {
        throw TransactionFailure.unavailable;
      }
      const flight: Flight = { committing: false, rollingBack: false, outcome: null, inFlight: null, abandon: noop, distrust: noop };
      const abandoned = new Promise<T>((resolve, reject) => {
        flight.abandon = () => {
          const known = flight.outcome;
          if (known === null) reject(TransactionFailure.unavailable);
          else if ('value' in known) resolve(known.value as T);
          else reject(known.failure);
        };
      });
      abandoned.catch(noop);
      // Once COMMIT is on its way, only its own outcome answers. Otherwise an abort stops trusting the connection and retires
      // its pool at once — after cancelling a body statement in flight, so the server stops it — and answers: unavailable
      // before any outcome is known, the known outcome once it is (the reset running), and ROLLBACK's own outcome, which the
      // retirement brings at once, while ROLLBACK is on its way.
      const onAbort = (): void => {
        if (flight.committing && flight.outcome === null) return;
        const query = flight.inFlight;
        if (query !== null && flight.outcome === null && !flight.rollingBack) void Promise.resolve().then(() => query.cancel()).catch(noop);
        flight.distrust();
        if (flight.outcome !== null || !flight.rollingBack) flight.abandon();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const transaction = run(signal, bounds, work, flight);
      running.add(transaction);
      void transaction.then(() => running.delete(transaction), () => running.delete(transaction));
      try {
        return await Promise.race([transaction, abandoned]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    async end(): Promise<void> {
      if (!ended) {
        ended = true;
        for (const waiter of waiters.splice(0)) waiter.reject();
        for (const pool of [...idle]) retire(pool);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, RETIRED_POOL_GRACE_S * 1_000); });
      try {
        await Promise.race([Promise.all([...running].map((t) => t.then(noop, noop))), grace]);
      } finally {
        clearTimeout(timer);
      }
      for (const pool of [...pools]) retire(pool); // still busy after the grace: closed under their transactions
      await Promise.all([...ending]);
    },
  });
}
