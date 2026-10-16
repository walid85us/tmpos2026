// Phase 4.0 M6-RATE-P2 — the PostgreSQL distributed rate limiter against REAL PostgreSQL: migration 014 (schema
// tmpos_rate_limit — the bucket table, the one-row key-fingerprint table, the key check and the consume, probe and reclaim
// routines) observed from the owner and from the runtime's own non-owner LOGIN, and the production adapter
// createPostgresRateLimiter over the same supervised transaction kernel the composition root builds.
//
// WHAT IS PROVED HERE. 001-018 apply through the trusted engine; 014 is exactly the objects it declares — four routines as
// declared, two RLS tables whose only free-text column is CHECKed to the 43-character base64url shape of the HMAC pseudonym
// (an address or a raw identifier in its usual form is refused) beside a policy and a window, and privileges no
// wider than tmpos_app's USAGE and EXECUTE on the consume, the probe and the reclaim — and it creates no role. The UNCHANGED
// port conformance suite passes over TWO adapter instances on two separate kernels (separate pools) sharing one database.
// Past the suite: exact accounting under 200 concurrent consumes of one bucket and under mixed costs (a serial order exists
// for every grant); the window and the wait come from the DATABASE clock and the stored row, never the caller's clock, and a
// refused consume leaves its row byte for byte (xmin and ctid included); a differently keyed instance counts nothing and is
// never ready, and the registered fingerprint is never rewritten; the first registration is atomic under a race of two keys
// across three kernels, both ways round; the reclaim deletes at most four expired buckets per call, oldest first, never a
// live one, skipping rows another transaction holds (SKIP LOCKED), and the adapter starts one only after a consume that
// opened a window, one
// at a time per instance; a consume of a bucket an in-flight reclaim holds waits only for the reclaim's bound and gets a
// fresh window; the consumes of one bucket on one instance take one connection at a time (the lane), and a lane full at
// RATE_LIMIT_LANE_DEPTH refuses further consumes at once without sending anything; a read-only store is
// never ready; every malformed routine answer, a raise and a routine that never answers are unavailable, the last two
// bounded by PostgreSQL itself; a held row or table lock is unavailable within lock_timeout and spends nothing; the rollback
// refuses (55006) while a window is open, and otherwise removes exactly 014, which re-applies cleanly and refuses (55000)
// while another runtime-facing role is a member of tmpos_app; migrations 005-013 are byte-identical and the ledger's
// checksums are the files'. M6R-PERF is a bounded local concurrency check, not a load test.
//
// WHAT IS SUBSTITUTED — all of it in the disposable database or this process, none in the migration or the adapter:
//   * real time instead of a clock the harness moves: advance() SLEEPS (window 6 000 ms, the testkit's minimum), and the
//     clock proofs move a bucket's stored window (window_start and expires_at together, as 014's CHECK requires) as the owner;
//   * a byte relay on a task-owned socket is the kernels' only way to the server, so an outage is the relay refusing new
//     connections while the server ends every session of the probe login (the storeDown pattern of transactionalStore);
//   * M6R-08 REPLACES 014's consume and probe routines IN PLACE on this database — drop, then create with the same
//     signature, EXECUTE granted to tmpos_app so a refusal is the shape's and never a privilege's — and restores both from
//     the up file's own text in try/finally, then re-proves the definition, the ACL, the comment and section 6. Chosen over
//     a scratch database: the suites run serially, the relay and kernels stay on one database, and M6-PG's frozen store
//     clock set the precedent. A process killed mid-test would leave the fake in place — which fails closed (unavailable);
//   * an observing wrapper around the kernel (never around the adapter) records the failure each failed transaction ended
//     with, so a timeout can be shown to be PostgreSQL's (55P03, 57014) rather than the adapter's own deadline; a tracing
//     one (M6R-PERF-R1) also ties each consume of a burst to the one transaction it sent, through the async context the
//     adapter's call inherits, and records what the routine decided and how the transaction ended;
//   * load is the test's own (M6R-PERF-R1): the relay can delay every reply by a set time, the client can stall its own
//     event loop, and the relay can withhold the reply to a named session's first query — never a sleep for ordering.
//
// M6R-PERF-R1 traced CI's M6R-03 failures and M6R-PERF's unhandled rejections to one false test assumption and two
// defects, each reproduced here or in its unit suite: a consume deep in a bucket's line reaching its 500 ms deadline on a
// slow host (fail-closed, as designed — M6R-03 now proves exactness consume by consume and RLR-04 forces the case); a waiter
// that sent a transaction after its deadline had passed, when the line freed before its own timer callback ran (the adapter
// now checks the clock: RLR-04, unit M6R-10b); and the driver's own array-type query on a fresh connection, whose promise
// nothing handled when the kernel retired the pool during it (the kernel now turns that query off: RLR-06, DA-110).
// M6R-PERF-R2 traced M6R-PERF's "nothing unavailable" to two fail-closed mechanisms, each reproduced with a schedule the
// test owns: a hot bucket's line waiting past the deadline, and a bucket row held past lock_timeout by a consume whose
// COMMIT came late (55P03) — and rateLimitRuntime's M6RS-07, probably, to the second (its odd reply was never logged; a
// lock timeout was, in its wave, and a held COMMIT reproduces its counts). M6R-PERF now accounts for every consume and every
// bucket (its time line by line, what is established about each transaction, the owner's count checked where the snapshot
// shows the run's one window and otherwise reported inconclusive: M6R-PERF-R3), before its assertions; and a burst checks
// each hand-over and answer against an observation envelope around the call's synchronous step, inside which the adapter
// fixes its deadline — refusing what no correct adapter could do while the host's pauses stay inside its margins — while
// the contract itself, hand-over and obeying only strictly before the adapter's own monotonic deadline, is proved against
// the adapter in its unit tests (M6R-10b/10c/10d).
//
// DISPOSABLE ONLY. The target is resolveDisposableTarget's supplied DSN when CI binds one, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Keys, buckets and the probe
// login are synthetic, so the suite re-runs on the shared CI service: the ledger is read rather than this run's report,
// every rollback and re-application runs inside one owner transaction that is rolled back, every seeded or long-window
// bucket is deleted by the test that made it, and a test that empties the fingerprint table re-registers the canonical
// test key (32 bytes of 0x07) before it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createServer, connect as netConnect } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveDisposableTarget, testClient, testDriverVia } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { TransactionFailure, createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import {
  RATE_LIMIT_LANE_DEPTH, RATE_LIMIT_RECLAIM_BOUNDS, RATE_LIMIT_STORE_BOUNDS, createPostgresRateLimiter, rateLimitKeyFingerprint,
} from '../../server/persistence/postgresRateLimiter.ts';
import { LIMITER_DEADLINE_MS } from '../../server/runtime/rateLimit.ts';
import { assertRateLimiterContract } from '../../server/runtime/rateLimiter.testkit.ts';

const REPO = new URL('../../', import.meta.url).pathname;
const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = `${REPO}${MIG_REL}`;
const UP_014 = readFileSync(`${MIG_DIR}/014_m6_distributed_rate_limit.up.sql`, 'utf8');
const DOWN_014 = readFileSync(`${MIG_DIR}/014_m6_distributed_rate_limit.down.sql`, 'utf8');
/** 014's section 6 postcondition, run again on its own. */
const POSTCONDITION_014 = `set local search_path = pg_catalog, pg_temp;\n${UP_014.slice(UP_014.lastIndexOf('do $$'))}`;
/** One of 014's routines exactly as its section 5 creates and comments it, followed by the grant statements that name it. */
function routineDdl(name) {
  const start = UP_014.indexOf(`create function tmpos_rate_limit.${name}(`);
  const comment = UP_014.indexOf(`comment on function tmpos_rate_limit.${name}(`, start);
  assert.ok(start >= 0 && comment > start, `014 declares ${name}`);
  const grants = UP_014.split('\n').filter((line) => /^(?:revoke|grant) /.test(line) && line.includes(`tmpos_rate_limit.${name}(`));
  return `${UP_014.slice(start, UP_014.indexOf("';\n", comment) + 3)}\n${grants.join('\n')}\n`;
}
/** 014's consume and probe, as its section 5 creates, comments and grants them (every other routine is untouched). */
const ROUTINES_014 = `${routineDdl('m6_rate_limit_consume')}${routineDdl('m6_rate_limit_probe')}`;
const CONSUME = 'tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer)';
const PROBE = 'tmpos_rate_limit.m6_rate_limit_probe(bytea)';
const KEY_ADMITS = 'tmpos_rate_limit.m6_rate_limit_key_admits(bytea)';
const RECLAIM = 'tmpos_rate_limit.m6_rate_limit_reclaim()';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm6r-migrator', runtimeRef: 'm6r-runtime' };
const LOCK_KEY = 614_014;
const NOW = () => new Date().toISOString();

const LOGIN = 'tmpos_m6r_probe';
/** The canonical test RATE_LIMIT_KEY every suite reaching 014 shares, and a second key for the skew proofs. */
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const FP = rateLimitKeyFingerprint(KEY).toString('hex');
const OTHER_FP = rateLimitKeyFingerprint(OTHER_KEY).toString('hex');
const RUN = randomBytes(6).toString('hex');
/** A fresh pseudonymous limiter key: 43 base64url characters, as the runtime's HMAC makes them. */
const key = (label) => createHash('sha256').update(`m6r:${RUN}:${label}`).digest('base64url');
const live = () => new AbortController().signal;
const req = (k, limit, windowMs = 6_000, cost = 1) => Object.freeze({ namespace: 'tenant', dimension: 'client', key: k, limit, windowMs, cost });
const allowed = (remaining) => ({ outcome: 'allowed', remaining });
const UNAVAILABLE = { outcome: 'unavailable' };

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M6R');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

// VALIDATE BEFORE TOUCHING ANYTHING: the setup below issues cluster-wide DDL (CREATE ROLE).
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** Used only to build the URL handed to the raw relay-retargeted driver call below (kernel()). */
function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}
const connect = (user, max) =>
  testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, seeds and observes, holds locks. RLS does not restrict it. */
const owner = connect(undefined, 2);

// ---------------------------------------------------------------------------
// the relay: the kernels' only way to the server
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket'
    ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) }
    : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m6r-relay-'));
  const pairs = new Set();
  // closes: the connections through this relay the driver has finished closing, as kernel() counts them.
  // replyDelayMs: a delay the test sets on every chunk the server sends (0: none) — latency it owns, not a sleep.
  // holds: per application_name, the next such connection whose reply to its first query after startup is withheld.
  const state = { closes: 0, pairs, replyDelayMs: 0, holds: new Map() };
  const server = createServer((client) => {
    const db = netConnect(upstream);
    let hold = null;
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); hold?.cut(); } };
    pairs.add(pair);
    // The startup message — read whole, however the client's bytes arrive — names the session's application_name: a hold
    // armed for it takes this connection; after startup only the last 16 bytes are kept, enough to find a query's name
    // across a chunk boundary.
    let sentBytes = Buffer.alloc(0);
    let started = false;
    client.on('data', (chunk) => {
      if (started && hold === null) return;
      // Until the startup message is whole, everything; after it, only enough of the stream to find the query's name
      // across a chunk boundary.
      sentBytes = Buffer.concat([started ? sentBytes.subarray(-16) : sentBytes, chunk]);
      if (!started && sentBytes.length >= 4 && sentBytes.length >= sentBytes.readUInt32BE(0)) {
        started = true;
        const startup = sentBytes.subarray(0, sentBytes.readUInt32BE(0));
        for (const [name, armed] of state.holds) {
          if (startup.includes(`application_name\0${name}\0`)) { hold = armed; state.holds.delete(name); break; }
        }
      }
      if (hold !== null && sentBytes.includes('typcategory')) hold.typeFetch = true;
    });
    client.pipe(db);
    // Server to client, in order. A held connection forwards whole messages up to and including its first
    // ReadyForQuery, then nothing more: the reply to its first query never arrives, and the connection stays open.
    let ready = false;
    let pending = Buffer.alloc(0);
    db.on('data', (chunk) => {
      if (hold === null) {
        const ms = state.replyDelayMs;
        if (ms <= 0) { client.write(chunk); return; }
        db.pause();
        setTimeout(() => { if (!client.destroyed) client.write(chunk); db.resume(); }, ms);
        return;
      }
      if (ready) { hold.held(); return; }
      pending = Buffer.concat([pending, chunk]);
      let at = 0;
      while (!ready && pending.length - at >= 5) {
        const length = pending.readUInt32BE(at + 1);
        if (pending.length - at < 1 + length) break;
        ready = pending[at] === 0x5a; // 'Z'
        at += 1 + length;
      }
      if (at > 0) client.write(pending.subarray(0, at));
      pending = pending.subarray(at);
      if (ready && pending.length > 0) hold.held();
    });
    db.on('end', () => client.end());
    for (const socket of [client, db]) { socket.on('error', pair.cut); socket.on('close', pair.cut); }
  });
  const path = join(dir, '.s.PGSQL.5432');
  const listen = () => new Promise((done) => server.listen(path, done));
  // No listener, so every new connection is refused; settles once every open pair has closed.
  const refuse = () => (server.listening ? new Promise((done) => server.close(done)) : Promise.resolve());
  return {
    dir, state, refuse, listening: listen(),
    restore: async () => { if (!server.listening) await listen(); },
    /**
     * The next connection whose session names `applicationName` gets no reply to its first query after startup:
     * `withheld` settles once a reply is withheld, `closed` once the connection is cut; `typeFetch` says whether the
     * client sent the driver's own array-type catalog query on it. `cancel()` disarms a hold no connection took.
     */
    holdFirstReply(applicationName) {
      let withheld;
      let closed;
      const hold = {
        typeFetch: false,
        withheld: new Promise((done) => { withheld = done; }),
        closed: new Promise((done) => { closed = done; }),
        held: () => withheld(),
        cut: () => closed(),
        cancel: () => state.holds.delete(applicationName),
      };
      state.holds.set(applicationName, hold);
      return hold;
    },
    async close() {
      const drained = refuse();
      for (const pair of [...pairs]) pair.cut();
      await drained;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const relay = startRelay();
await relay.listening;

const kernels = [];
/**
 * The transaction kernel over the probe login's runtime options, through the relay; `max` one-connection pools, and
 * `session` startup parameters added to the runtime's own (an application_name that tells kernels apart, say).
 * The driver dials the relay's socket through the harness (testDriverVia); the relay forwards only to TARGET.
 */
function kernel(max = 6, session = {}) {
  const options = runtimeClientOptions(TARGET_DSN);
  const k = createSupervisedPgClient(testDriverVia(TARGET, relay.dir), driverDsn(TARGET_DSN, LOGIN), {
    ...options, connection: { ...options.connection, ...session }, ssl: false, max, idle_timeout: 0,
    onclose: () => { relay.state.closes += 1; }, user: LOGIN,
  });
  kernels.push(k);
  return k;
}

/**
 * The store goes down the way a server does: the relay refuses new connections and the server ends every session of the
 * probe login; it returns once the driver has closed every connection it held through the relay (transactionalStore's
 * storeDown, and its reason: no call meets a connection whose session has ended before the driver has seen the close).
 */
async function storeDown() {
  const open = relay.state.pairs.size;
  const closedBefore = relay.state.closes;
  const drained = relay.refuse();
  await owner`select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = ${LOGIN}`;
  const until = performance.now() + 5_000;
  while (relay.state.closes - closedBefore < open) {
    if (performance.now() > until) throw new Error('the probe login\'s sessions did not end within 5 s');
    await sleep(5);
  }
  await drained;
}

/** Every failure a consume or probe transaction ended with, in order: the SQLSTATE of a statement error, or the kernel's own. */
const faults = [];
/**
 * The adapter's other transactions (the out-of-band reclaim): how many began, the most in flight at once per kernel, their
 * failures, and the longest one (M6R-PERF-R2: a reclaim holds one of its kernel's connections while it runs).
 */
const reclaims = { started: 0, maxInFlight: 0, faults: [], longestMs: 0 };
const faultOf = (err) => (err === TransactionFailure.unavailable ? 'kernel_unavailable'
  : err === TransactionFailure.outcomeUnknown ? 'kernel_outcome_unknown' : typeof err?.code === 'string' ? err.code : 'other');
/** The kernel, observed: the adapter still calls exactly transaction(signal, bounds, work) and gets exactly its answer. */
const observed = (k) => {
  let inFlight = 0;
  /** This instance's consume and probe transactions: how many are open now, and the most ever open at once. */
  const own = { open: 0, max: 0, started: 0 };
  return Object.freeze({
    own,
    transaction: (signal, bounds, work) => {
      if (bounds === RATE_LIMIT_STORE_BOUNDS) {
        own.started += 1;
        own.max = Math.max(own.max, ++own.open);
        return k.transaction(signal, bounds, work).catch((err) => { faults.push(faultOf(err)); throw err; }).finally(() => { own.open -= 1; });
      }
      reclaims.started += 1;
      reclaims.maxInFlight = Math.max(reclaims.maxInFlight, ++inFlight);
      const began = performance.now();
      return k.transaction(signal, bounds, work).catch((err) => { reclaims.faults.push(faultOf(err)); throw err; })
        .finally(() => { inFlight -= 1; reclaims.longestMs = Math.max(reclaims.longestMs, performance.now() - began); });
    },
    end: () => k.end(),
  });
};
/**
 * Lets an out-of-band reclaim that a window-opening consume started finish before a snapshot: a moment for it to begin,
 * then until no session of the probe login is inside a transaction for three samples running (at most 2 s). Returns
 * whether that quiet was reached, and how long it waited, its 50 ms lead-in included (M6R-PERF-R3): the server's own
 * evidence that no transaction of the login is still running, which the kernel's answers alone do not establish — per
 * login, not per transaction, and not asserted.
 */
async function settle() {
  const began = performance.now();
  await sleep(50);
  const stop = performance.now() + 2_000;
  let quiet = 0;
  for (; quiet < 3 && performance.now() < stop; await sleep(10)) {
    const [{ n }] = await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_stat_activity where usename = ${LOGIN} and xact_start is not null`;
    quiet = n === 0 ? quiet + 1 : 0;
  }
  return { reached: quiet >= 3, waitedMs: Math.round(performance.now() - began) };
}

// ---------------------------------------------------------------------------
// bursts, consume by consume (M6R-PERF-R1)
// ---------------------------------------------------------------------------

/**
 * Which consume a transaction serves. A burst runs each consume in a context of its own, which the adapter's call into
 * the kernel inherits through its awaits, so the kernel observer below can tell consumes apart without wrapping the
 * adapter or changing what it is handed.
 */
const consumeContext = new AsyncLocalStorage();
/**
 * Per consume of a burst: every consume transaction it sent — when it was handed over, when the kernel began its work (it
 * had a connection by then, a fresh one's startup done, and BEGIN and the settings acknowledged: M6R-PERF-R2), what the
 * routine decided and when, and how the transaction ended.
 */
const sentBy = new Map();
/** The kernel, traced per consume: the adapter still calls exactly transaction(signal, bounds, work) and gets exactly its answer. */
const traced = (k) => Object.freeze({
  transaction: (signal, bounds, work) => {
    const id = consumeContext.getStore();
    if (bounds !== RATE_LIMIT_STORE_BOUNDS || id === undefined) return k.transaction(signal, bounds, work);
    const tx = { at: performance.now(), workAt: null, decision: undefined, decidedAt: null, ended: 'pending', endedAt: null };
    sentBy.set(id, [...(sentBy.get(id) ?? []), tx]);
    return k.transaction(signal, bounds, async (sql) => { tx.workAt = performance.now(); tx.decision = await work(sql); tx.decidedAt = performance.now(); return tx.decision; })
      .then((value) => { tx.ended = 'committed'; tx.endedAt = performance.now(); return value; },
        (err) => { tx.ended = faultOf(err); tx.endedAt = performance.now(); throw err; });
  },
  end: () => k.end(),
});
/** Four production adapters, two per kernel, each over a traced kernel. */
const fourTraced = () => [k1, k2, k1, k2].map((k) => createPostgresRateLimiter({ client: traced(k), keySecret: KEY }));
let burstSerial = 0;
/**
 * `requests` at once, the i-th on instances[i % n], each timed from just before its call (monotonic clock) and again just after
 * the call's synchronous step returns — the adapter fixes its deadline inside that step, so that deadline lies between the two
 * plus LIMITER_DEADLINE_MS; the step is usually microseconds, but a pause of the process (a garbage collection, say) can
 * stretch it to many milliseconds (M6R-PERF-R2 measured up to 17 ms) — with a timer of the deadline's length set just before
 * the call — set first, so it fires no later than the adapter's own — whose firing time is what "the deadline" means for that
 * call, however late a busy event loop runs it. `during` runs alongside,
 * handed the burst's start and a function counting the instances with a transaction outstanding. Returns once every consume has
 * answered and every transaction they sent has ended (a COMMIT still on its way when its caller was answered ends later).
 */
async function burst(instances, requests, during) {
  const tag = `burst${burstSerial++}`;
  const t0 = performance.now();
  const answers = Promise.all(requests.map((request, i) => consumeContext.run(`${tag}:${i}`, async () => {
    const start = performance.now();
    let deadlineAt = null;
    const sentinel = setTimeout(() => { deadlineAt = performance.now(); }, LIMITER_DEADLINE_MS);
    const pending = instances[i % instances.length].consume(request, live());
    const called = performance.now();
    const answer = await pending;
    const answeredAt = performance.now();
    clearTimeout(sentinel);
    return { id: `${tag}:${i}`, instance: i % instances.length, cost: request.cost, start, called, answer, answeredAt, elapsed: answeredAt - start, deadlineAt };
  })));
  /** How many instances have a transaction of this burst outstanding right now. */
  const outstanding = () => new Set([...sentBy].filter(([id, txs]) => id.startsWith(`${tag}:`) && txs.some((tx) => tx.ended === 'pending'))
    .map(([id]) => Number(id.slice(tag.length + 1)) % instances.length)).size;
  let answered;
  let ms;
  try {
    if (during !== undefined) await during({ t0, outstanding });
    answered = await answers;
    ms = performance.now() - t0;
  } finally {
    await Promise.allSettled([answers]);
  }
  // Read once every transaction has ended and the probe login is quiet — so one a consume sent after it was answered
  // is seen too (none may be: assertBurst) — bounded: a transaction that never ends fails here, never hangs the suite.
  const ids = new Set(answered.map((c) => c.id));
  const until = performance.now() + 3_000;
  while ([...sentBy].some(([id, txs]) => ids.has(id) && txs.some((tx) => tx.ended === 'pending'))) {
    assert.ok(performance.now() < until, 'every transaction a burst sent ends within 3 s');
    await sleep(5);
  }
  await settle();
  return { calls: answered.map((c) => ({ ...c, txs: sentBy.get(c.id) ?? [] })), ms };
}
/** Each consume's class, counted — for the diagnostic line. */
function describeBurst({ calls, ms }) {
  const classes = {};
  for (const c of calls) {
    const [tx] = c.txs;
    const k = c.answer.outcome !== 'unavailable' ? c.answer.outcome
      : tx === undefined ? 'unavailable: deadline before it was sent' : `unavailable: transaction ${tx.ended}${tx.ended === 'committed' ? ` (${tx.decision?.outcome}) after the deadline` : ''}`;
    classes[k] = (classes[k] ?? 0) + 1;
  }
  const lateness = calls.filter((c) => c.deadlineAt !== null).map((c) => c.deadlineAt - c.start - LIMITER_DEADLINE_MS);
  return JSON.stringify({ ms: Math.round(ms), slowestAnswerMs: Math.round(Math.max(...calls.map((c) => c.elapsed))),
    slowestCallStepMs: Math.round(Math.max(...calls.map((c) => c.called - c.start))),
    deadlineTimerLateMs: lateness.length > 0 ? Math.round(Math.max(...lateness)) : null, classes });
}
/**
 * What a burst proves consume by consume, however fast or slow the host:
 *   * faithful — an allowance or a limit is exactly the decision its own transaction committed; a consume sends at most
 *     one transaction (nothing is retried or replayed) and none once its deadline has passed; an unavailable answer is
 *     the deadline — met before the consume was sent, or while its transaction ran — or a failure its transaction ended
 *     with, never a decision withheld in time;
 *   * exact — the committed grants fit one serial order, each leaving exactly the limit minus every grant before it, and
 *     sum to `consumed`, the owner-side count (a grant whose COMMIT acknowledgement was lost counts only if it landed);
 *     and no consume was refused while its cost still fitted the count the burst ended with.
 * Unavailable answers are counted, not refused: under load they are the contract's fail-closed answer (RLR-04).
 */
/**
 * The longest a consume's call may take to return its promise (M6R-PERF-R2): pauses of up to 17 ms were measured inside it
 * under load; a fifth of the deadline is far above that and still refuses an adapter that stalls before fixing its deadline.
 */
const CALL_STEP_CAP_MS = 100;
/** How a consume transaction may fail and still be fail-closed: the kernel's own two answers, and PostgreSQL's lock and statement timeouts. */
const FAIL_CLOSED = new Set(['kernel_unavailable', 'kernel_outcome_unknown', '55P03', '57014']);
function assertBurst({ calls }, limit, consumed, label, { windowMs = 6_000, strict = false } = {}) {
  for (const c of calls) {
    assert.ok(c.txs.length <= 1, `${label}: consume ${c.id} sent ${c.txs.length} transactions — nothing is retried or replayed`);
    const [tx] = c.txs;
    // The adapter fixes its deadline inside the call's synchronous step, so somewhere between `start` and `called`, plus
    // LIMITER_DEADLINE_MS: every "no later than its deadline" bound is measured from `called` and every "not before its
    // deadline" one from `start` (M6R-PERF-R2: measured from `start` alone, a pause inside the step failed a correct
    // adapter). These are an observation envelope, not the contract: a hand-over before `called` + LIMITER_DEADLINE_MS can
    // still be past the adapter's own deadline when the step paused after fixing it. The exact contract — hand-over and
    // obeying only strictly before the adapter's own monotonic deadline, nothing at it, a pause later in the step moving
    // nothing — is proved deterministically against the adapter itself by unit M6R-10b/10c/10d (M6R-PERF-R3). This envelope
    // refuses what no correct adapter could produce only while the host's pauses stay inside its margins: the step is capped
    // at CALL_STEP_CAP_MS (which bounds, rather than forbids, a stall before the deadline is fixed — and would refuse a
    // correct adapter whose step paused that long), and the 5 ms here is for a pause between the adapter's own check and
    // this tracer's timestamp, not a longer deadline.
    assert.ok(c.called - c.start < CALL_STEP_CAP_MS, `${label}: consume ${c.id}'s call took ${Math.round(c.called - c.start)} ms to return its promise — its synchronous step fixes its deadline, and may not take ${CALL_STEP_CAP_MS} ms`);
    if (tx !== undefined) {
      assert.ok(tx.at - c.called < LIMITER_DEADLINE_MS + 5, `${label}: consume ${c.id} sent its transaction ${Math.round(tx.at - c.called)} ms after its call returned (${Math.round(tx.at - c.start)} ms after it was called) — nothing is sent once its deadline has passed`);
    }
    if (tx !== undefined && tx.ended !== 'committed') {
      assert.ok(FAIL_CLOSED.has(tx.ended), `${label}: consume ${c.id}'s transaction failed with ${tx.ended} — not a timeout or a lost connection, but a store fault`);
      // Strict (no load forced): before its deadline, only PostgreSQL's own lock or statement bound fails a transaction.
      if (strict && c.elapsed < LIMITER_DEADLINE_MS - 1) {
        assert.ok(tx.ended === '55P03' || tx.ended === '57014', `${label}: consume ${c.id}'s transaction failed with ${tx.ended} before its deadline`);
      }
    }
    // No answer of any kind outlives its deadline, as its own sentinel timer fired, by more than the timer batch it shares —
    // plus the call's synchronous step, by which the adapter's own timer may start after the sentinel.
    if (c.deadlineAt !== null) {
      assert.ok(c.answeredAt <= c.deadlineAt + 20 + (c.called - c.start), `${label}: consume ${c.id} answered ${Math.round(c.answeredAt - c.deadlineAt)} ms after its deadline fired`);
    }
    if (c.answer.outcome === 'unavailable') {
      const atDeadline = c.elapsed >= LIMITER_DEADLINE_MS - 1;
      const afterItsFailure = tx !== undefined && tx.ended !== 'committed' && c.answeredAt >= tx.endedAt;
      assert.ok(atDeadline || afterItsFailure, `${label}: consume ${c.id} answered unavailable after ${Math.round(c.elapsed)} ms, ${tx === undefined ? 'never sent' : `its transaction ${tx.ended}`} — only the deadline or its transaction's failure answers unavailable`);
      if (tx?.ended === 'committed') {
        assert.ok(tx.endedAt - c.start >= LIMITER_DEADLINE_MS - 5, `${label}: consume ${c.id}'s decision arrived ${Math.round(tx.endedAt - c.start)} ms after its call, in time, and was withheld`);
      }
    } else {
      // A decision is obeyed only inside its deadline (the adapter's clock, read in the step that obeys it).
      assert.ok(c.answeredAt - c.called < LIMITER_DEADLINE_MS + 5, `${label}: consume ${c.id} was answered ${c.answer.outcome} ${Math.round(c.answeredAt - c.called)} ms after its call returned — past its deadline`);
      assert.ok(tx !== undefined && tx.ended === 'committed', `${label}: consume ${c.id} answered ${c.answer.outcome} without a committed transaction`);
      assert.deepEqual(c.answer, tx.decision, `${label}: consume ${c.id}'s answer is exactly what its own transaction decided`);
      if (c.answer.outcome === 'limited') {
        const wait = c.answer.retryAfterMs;
        assert.ok(Number.isSafeInteger(wait) && wait >= 1 && wait <= windowMs, `${label}: consume ${c.id}'s limit waits ${wait} ms, inside the window`);
      }
    }
  }
  // Work-conserving: an instance whose consumes waited out their deadline unsent was busy the whole time — each of its
  // transactions sent within 50 ms of the one before ending, the last still running within 50 ms of the first of those
  // deadlines (the margin is for the process's own pauses, not for an idle line). A lazy or throttling
  // adapter that refuses without sending leaves its line idle and fails here.
  for (const instance of new Set(calls.map((c) => c.instance))) {
    const unsent = calls.filter((c) => c.instance === instance && c.answer.outcome === 'unavailable' && c.txs.length === 0);
    if (unsent.length === 0) continue;
    const txs = calls.filter((c) => c.instance === instance).flatMap((c) => c.txs).sort((x, y) => x.at - y.at);
    for (let i = 1; i < txs.length; i += 1) {
      assert.ok(txs[i].at - txs[i - 1].endedAt < 50, `${label}: instance ${instance}'s line sat idle ${Math.round(txs[i].at - txs[i - 1].endedAt)} ms while consumes waited in it`);
    }
    const firstDeadline = Math.min(...unsent.map((c) => c.start)) + LIMITER_DEADLINE_MS;
    assert.ok(txs.length > 0 && txs.at(-1).endedAt >= firstDeadline - 50, `${label}: instance ${instance} refused consumes unsent while its line was not busy up to their deadline`);
  }
  const decided = calls.filter((c) => c.txs[0]?.ended === 'committed').map((c) => ({ cost: c.cost, decision: c.txs[0].decision, tx: c.txs[0] }));
  assert.ok(decided.every((d) => d.decision.outcome === 'allowed' || d.decision.outcome === 'limited'), `${label}: every committed decision is an allowance or a limit`);
  const grants = decided.filter((d) => d.decision.outcome === 'allowed');
  const uncertain = calls.filter((c) => c.txs[0]?.ended === 'kernel_outcome_unknown' && c.txs[0].decision?.outcome === 'allowed')
    .map((c) => ({ cost: c.cost, decision: c.txs[0].decision }));
  // shortcut: subsets of the uncertain grants are enumerated, so they are capped at twelve — one COMMIT in doubt per pool
  // connection at a time; more than that in one burst fails here as unexplained rather than being checked another way.
  // At most one COMMIT is ever in doubt per pool connection: two kernels of six.
  assert.ok(uncertain.length <= 12, `${label}: at most twelve grants whose COMMIT acknowledgement was lost (${uncertain.length})`);
  let serial = false;
  for (let landed = 0; landed < 2 ** uncertain.length && !serial; landed += 1) {
    const all = [...grants, ...uncertain.filter((_, i) => landed & (1 << i))].sort((x, y) => y.decision.remaining - x.decision.remaining);
    let left = limit;
    serial = all.every((g) => (left -= g.cost) === g.decision.remaining) && limit - left === consumed;
  }
  assert.ok(serial, `${label}: the ${grants.length} committed grants (and ${uncertain.length} uncertain) fit one serial order that sums to the owner-side count ${consumed}`);
  for (const d of decided) {
    if (d.decision.outcome !== 'limited') continue;
    assert.ok(consumed + d.cost > limit, `${label}: no consume was refused while its cost ${d.cost} still fitted (${consumed} of ${limit})`);
    // And causally — sound, not complete: a grant sent only after this refusal was answered was decided after it (one already
    // on its way may have been decided either side of it, and is not compared), so the count at the refusal left
    // at least that grant's cost plus what it left — which must not have fitted this one.
    for (const g of grants) {
      if (g.tx.at > d.tx.decidedAt) assert.ok(d.cost > g.decision.remaining + g.cost, `${label}: a consume of cost ${d.cost} was refused while a later grant still found ${g.decision.remaining + g.cost} left — refused while its cost still fitted`);
    }
  }
}
/** After a burst, the rest of the window's capacity, exactly: what it left is allowed down to zero, and then nothing. */
async function assertRestOfWindow(instances, k, limit, consumed, label) {
  if (consumed < limit) {
    assert.deepEqual(await instances[0].consume(req(k, limit, 6_000, limit - consumed), live()), allowed(0), `${label}: exactly the ${limit - consumed} the burst left are still there`);
  }
  assert.equal((await instances[1].consume(req(k, limit), live())).outcome, 'limited', `${label}: and then nothing is`);
}
/** The bucket's one window, on the database clock, holds every decision made between `before` and now; the count is the limit. */
async function assertOneWindow(k, limit, before, label, windowMs = 6_000) {
  const after = await dbNowUs();
  const [row] = await rowsOf([k]);
  const [start, expires, span] = [BigInt(row.start_us), BigInt(row.expires_us), BigInt(windowMs) * 1000n];
  assert.ok(after - before < span, `${label}: everything ran inside one window's length (${after - before} us, database clock)`);
  assert.ok(start >= before && start <= after && expires - start === span && expires > after,
    `${label}: one window of exactly ${windowMs} ms opened after ${before} us and lasts past ${after} us — every decision fell inside it`);
  assert.deepEqual([row.consumed, row.limit_count], [limit, limit], `${label}: the owner sees exactly the limit consumed`);
}
const busy = (ms) => { const until = performance.now() + ms; while (performance.now() < until) { /* the client process runs nothing else */ } };
/**
 * Lets a rejection nothing handles surface — node:test fails the running test with it — before the test goes on: the
 * driver rejects in the timer that destroys the connection, before the socket closes, and Node reports an unhandled
 * rejection once the microtasks after it drain; a few event-loop turns past the close are ample.
 */
const turns = async () => { for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done)); };
/** `promise`, or a failure naming `what` after `ms` — a wait the test bounds, never a hang. */
async function within(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what}: not within ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

test.after(async () => {
  for (const k of kernels) await k.end().catch(() => {});
  await relay.close().catch(() => {});
  await owner.unsafe(`drop role if exists ${LOGIN}`).catch(() => {});
  await owner.end({ timeout: 5 }).catch(() => {});
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: the real chain 001-018, a non-owner LOGIN holding only tmpos_app, two kernels, the real adapter
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

let applyReport;
{
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    applyReport = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

await owner.unsafe(`drop role if exists ${LOGIN}`);
await owner.unsafe(`create role ${LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${LOGIN}`);

const k1 = kernel(6, { application_name: 'm6r-k1' });
const k2 = kernel(6, { application_name: 'm6r-k2' });
/** The production binding, twice: two instances, two kernels, one database. */
const A = createPostgresRateLimiter({ client: k1, keySecret: KEY });
const B = createPostgresRateLimiter({ client: k2, keySecret: KEY });
/** The same, over observed kernels, where a test needs to know why a transaction failed. */
const k1obs = observed(k1);
const Aobs = createPostgresRateLimiter({ client: k1obs, keySecret: KEY });
const Bobs = createPostgresRateLimiter({ client: observed(k2), keySecret: KEY });
/** On a fresh database this registers the canonical key; on the shared one it must already be registered. */
const CANONICAL_READY_AT_START = await A.probe(live());

// ---------------------------------------------------------------------------
// observers
// ---------------------------------------------------------------------------

/** Bucket rows for `keys` as the owner sees them: the whole row as JSON, its tuple identity, and the window in microseconds. */
const rowsOf = async (keys, sql = owner) => (await sql`select b.limiter_key, pg_catalog.row_to_json(b)::text as row,
    b.xmin::text as xmin, b.ctid::text as ctid, b.consumed, b.limit_count,
    (extract(epoch from b.window_start) * 1000000)::bigint::text as start_us, (extract(epoch from b.expires_at) * 1000000)::bigint::text as expires_us
  from tmpos_rate_limit.bucket b where b.limiter_key = any (${keys}::text[])
  order by b.limiter_key, b.namespace, b.dimension, b.limit_count, b.window_ms`).map((r) => ({ ...r }));
/** Every bucket, as an identity-to-(row, xmin, ctid) map. */
const allBuckets = async (sql = owner) => new Map((await sql`select b.namespace || '/' || b.dimension || '/' || b.limiter_key || '/' || b.limit_count || '/' || b.window_ms as id,
    pg_catalog.row_to_json(b)::text || b.xmin::text || b.ctid::text as v from tmpos_rate_limit.bucket b`).map((r) => [r.id, r.v]));
/** The database clock, in microseconds. */
const dbNowUs = async () => BigInt((await owner`select (extract(epoch from pg_catalog.clock_timestamp()) * 1000000)::bigint::text as t`)[0].t);
const fingerprintRow = async (sql = owner) => (await sql`select pg_catalog.encode(f.fingerprint, 'hex') as fp, f.registered_at::text as registered_at,
  f.xmin::text as xmin from tmpos_rate_limit.key_fingerprint f`).map((r) => ({ ...r }));
/** Whether a session of the probe login is blocked by backend `pid` — that one, not any — polled for up to `ms`. */
async function blockedBy(pid, ms = 150) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const [{ n }] = await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_stat_activity a
      where a.usename = ${LOGIN} and ${pid}::int = any (pg_catalog.pg_blocking_pids(a.pid))`;
    if (n > 0) return true;
    await sleep(2);
  }
  return false;
}
/** Whether a session of the probe login waits on a lock, polled for up to `ms`. */
async function lockWaitSeen(ms = 150) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const [{ n }] = await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_locks l
      join pg_catalog.pg_stat_activity a on a.pid = l.pid where not l.granted and a.usename = ${LOGIN}`;
    if (n > 0) return true;
    await sleep(2);
  }
  return false;
}
const ceilMs = (us) => Math.ceil(Number(us) / 1000);
const timed = async (call) => { const t0 = performance.now(); const value = await call(); return [value, performance.now() - t0]; };
const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

/** The statement's refusal, caught inside a savepoint so the surrounding transaction survives: {code, message}, or null. */
const refusalIn = (tx) => async (fn) => {
  try { await tx.savepoint(fn); return null; } catch (err) { return { code: err.code ?? null, message: String(err.message) }; }
};
const ROLLBACK = new Error('m6r: roll the proof back');
/** Runs `fn` in one owner transaction that is ALWAYS rolled back, so a shared database keeps its state. */
async function rolledBack(fn) {
  await assert.rejects(owner.begin(async (tx) => { await fn(tx); throw ROLLBACK; }), (err) => err === ROLLBACK);
}
/** Every bucket expired, the CHECK kept: window_start and expires_at move back together by more than the longest window. */
const expireAll = (tx) => tx`update tmpos_rate_limit.bucket set window_start = window_start - interval '2 hours', expires_at = expires_at - interval '2 hours'`;
const rolesSnapshot = async (sql) => ({
  roles: (await sql`select r.rolname::text as name, r.oid::text as oid from pg_catalog.pg_roles r order by 1`).map((r) => `${r.name}:${r.oid}`),
  members: (await sql`select m.roleid::text || '>' || m.member::text as edge from pg_catalog.pg_auth_members m order by 1`).map((r) => r.edge),
});

/**
 * 014 as declared, read from the catalog: routines, relations, constraints, columns, every ACL, every effective privilege
 * of the roles that must hold none (and of tmpos_app and the probe login, which hold exactly USAGE and two EXECUTEs), RLS,
 * ownership and membership. Used as applied (M6R-01), after M6R-08's restore, and after M6R-10's re-application.
 */
async function assertDeclared(sql, label) {
  const routines = await sql`select p.proname::text as name, p.prosecdef, p.provolatile::text as volatility, p.proconfig,
      l.lanname::text as language, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
      pg_catalog.pg_get_function_result(p.oid) as result, p.proowner = n.nspowner as schema_owner
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace join pg_catalog.pg_language l on l.oid = p.prolang
    where n.nspname = 'tmpos_rate_limit' order by p.proname`;
  const pinned = ['search_path=pg_catalog, pg_temp'];
  assert.deepEqual(routines.map((r) => ({ ...r })), [
    { name: 'm6_rate_limit_consume', prosecdef: true, volatility: 'v', proconfig: pinned, language: 'plpgsql',
      args: 'p_key_fingerprint bytea, p_namespace text, p_dimension text, p_limiter_key text, p_limit integer, p_window_ms integer, p_cost integer',
      result: 'TABLE(outcome text, remaining integer, retry_after_ms integer)', schema_owner: true },
    { name: 'm6_rate_limit_key_admits', prosecdef: false, volatility: 'v', proconfig: pinned, language: 'plpgsql',
      args: 'p_key_fingerprint bytea', result: 'boolean', schema_owner: true },
    { name: 'm6_rate_limit_probe', prosecdef: true, volatility: 'v', proconfig: pinned, language: 'plpgsql',
      args: 'p_key_fingerprint bytea', result: 'TABLE(outcome text)', schema_owner: true },
    { name: 'm6_rate_limit_reclaim', prosecdef: true, volatility: 'v', proconfig: pinned, language: 'plpgsql',
      args: '', result: 'integer', schema_owner: true },
  ], `${label}: exactly the four routines, each as declared`);

  const relations = await sql`select c.relname::text as name, c.relkind::text as kind, c.reloptions, c.relrowsecurity as rls,
      c.relforcerowsecurity as forced, c.relowner = n.nspowner as schema_owner
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'tmpos_rate_limit' order by c.relname`;
  assert.deepEqual(relations.map((r) => ({ ...r })), [
    { name: 'bucket', kind: 'r', reloptions: ['fillfactor=70'], rls: true, forced: false, schema_owner: true },
    { name: 'bucket_expires_at_idx', kind: 'i', reloptions: null, rls: false, forced: false, schema_owner: true },
    { name: 'bucket_pkey', kind: 'i', reloptions: null, rls: false, forced: false, schema_owner: true },
    { name: 'key_fingerprint', kind: 'r', reloptions: null, rls: true, forced: false, schema_owner: true },
    { name: 'key_fingerprint_pkey', kind: 'i', reloptions: null, rls: false, forced: false, schema_owner: true },
  ], `${label}: two tables with RLS on (not forced on the owner the routines run as), their keys and the expiry index — no view, no sequence`);
  const [{ def }] = await sql`select pg_catalog.pg_get_indexdef('tmpos_rate_limit.bucket_expires_at_idx'::regclass) as def`;
  assert.equal(def, 'CREATE INDEX bucket_expires_at_idx ON tmpos_rate_limit.bucket USING btree (expires_at)');
  const [{ extra }] = await sql`select
      (select pg_catalog.count(*)::int from pg_catalog.pg_policy p where p.polrelid in ('tmpos_rate_limit.bucket'::regclass, 'tmpos_rate_limit.key_fingerprint'::regclass))
    + (select pg_catalog.count(*)::int from pg_catalog.pg_trigger g where g.tgrelid in ('tmpos_rate_limit.bucket'::regclass, 'tmpos_rate_limit.key_fingerprint'::regclass))
    + (select pg_catalog.count(*)::int from pg_catalog.pg_type t where t.typnamespace = 'tmpos_rate_limit'::regnamespace
         and t.typrelid not in ('tmpos_rate_limit.bucket'::regclass, 'tmpos_rate_limit.key_fingerprint'::regclass)
         and t.typelem not in (select c.reltype from pg_catalog.pg_class c where c.oid in ('tmpos_rate_limit.bucket'::regclass, 'tmpos_rate_limit.key_fingerprint'::regclass)))
    as extra`;
  assert.equal(extra, 0, `${label}: no policy, no trigger, and no type but the two tables' own row types`);

  const constraints = await sql`select c.conrelid::regclass::text as rel, c.conname::text as name, c.contype::text as kind
    from pg_catalog.pg_constraint c where c.connamespace = 'tmpos_rate_limit'::regnamespace order by 1, 2`;
  assert.deepEqual(constraints.map((r) => `${r.rel} ${r.name} ${r.kind}`), [
    'tmpos_rate_limit.bucket bucket_consumed_chk c', 'tmpos_rate_limit.bucket bucket_dimension_chk c', 'tmpos_rate_limit.bucket bucket_expiry_chk c',
    'tmpos_rate_limit.bucket bucket_limit_chk c', 'tmpos_rate_limit.bucket bucket_limiter_key_chk c', 'tmpos_rate_limit.bucket bucket_namespace_chk c',
    'tmpos_rate_limit.bucket bucket_pkey p', 'tmpos_rate_limit.bucket bucket_window_chk c',
    'tmpos_rate_limit.key_fingerprint key_fingerprint_length_chk c', 'tmpos_rate_limit.key_fingerprint key_fingerprint_pkey p',
    'tmpos_rate_limit.key_fingerprint key_fingerprint_singleton_chk c',
  ]);
  const columns = await sql`select a.attrelid::regclass::text as rel, a.attname::text as name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as dflt
    from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid in ('tmpos_rate_limit.bucket'::regclass, 'tmpos_rate_limit.key_fingerprint'::regclass) and a.attnum > 0 and not a.attisdropped
    order by a.attrelid::regclass::text, a.attnum`;
  // The bucket holds the pseudonymous key (a CHECKed 43-character base64url string), two CHECKed enumerations, the policy,
  // the count and the window — no column that could hold an address, a provider UID, a token or any request data.
  assert.deepEqual(columns.map((r) => [r.rel.replace('tmpos_rate_limit.', ''), r.name, r.type, r.not_null, r.dflt]), [
    ['bucket', 'namespace', 'text', true, null], ['bucket', 'dimension', 'text', true, null], ['bucket', 'limiter_key', 'text', true, null],
    ['bucket', 'limit_count', 'integer', true, null], ['bucket', 'window_ms', 'integer', true, null], ['bucket', 'consumed', 'integer', true, null],
    ['bucket', 'window_start', 'timestamp with time zone', true, null], ['bucket', 'expires_at', 'timestamp with time zone', true, null],
    ['key_fingerprint', 'singleton', 'boolean', true, 'true'], ['key_fingerprint', 'fingerprint', 'bytea', true, null],
    ['key_fingerprint', 'registered_at', 'timestamp with time zone', true, 'clock_timestamp()'],
  ], `${label}: the exact column lists`);

  // Every direct grant but the owner's own: on the schema, the routines, the tables and every column.
  const grants = await sql`select x.what, x.grantee, x.privilege, x.grantable from (
      select 'schema' as what, g.grantee, g.privilege_type as privilege, g.is_grantable as grantable
        from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
       where n.nspname = 'tmpos_rate_limit' and g.grantee <> n.nspowner
      union all
      select p.proname::text, g.grantee, g.privilege_type, g.is_grantable
        from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.pronamespace = 'tmpos_rate_limit'::regnamespace and g.grantee <> p.proowner
      union all
      select c.relname::text, g.grantee, g.privilege_type, g.is_grantable
        from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
       where c.relnamespace = 'tmpos_rate_limit'::regnamespace and c.relkind = 'r' and g.grantee <> c.relowner
      union all
      select c.relname::text || '.' || a.attname::text, g.grantee, g.privilege_type, g.is_grantable
        from pg_catalog.pg_class c join pg_catalog.pg_attribute a on a.attrelid = c.oid, pg_catalog.aclexplode(a.attacl) g
       where c.relnamespace = 'tmpos_rate_limit'::regnamespace and c.relkind = 'r' and not a.attisdropped and g.grantee <> c.relowner
    ) x order by 1, 2, 3`;
  // grantee 0 is PUBLIC: it appears nowhere.
  const [{ app }] = await sql`select 'tmpos_app'::regrole::oid::text as app`;
  assert.deepEqual(grants.map((r) => `${r.what} ${String(r.grantee) === app ? 'tmpos_app' : r.grantee} ${r.privilege}${r.grantable ? ' WITH GRANT' : ''}`), [
    'm6_rate_limit_consume tmpos_app EXECUTE', 'm6_rate_limit_probe tmpos_app EXECUTE', 'm6_rate_limit_reclaim tmpos_app EXECUTE', 'schema tmpos_app USAGE',
  ], `${label}: the only direct grants are tmpos_app's USAGE and three EXECUTEs, none grantable — nothing to PUBLIC, nothing on a table or column`);

  const roles = ['anon', 'authenticated', 'public', 'tmpos_app', 'tmpos_audit_writer', LOGIN];
  const effective = await sql`select r.name,
      pg_catalog.has_table_privilege(r.name, 'tmpos_rate_limit.bucket', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as bucket,
      pg_catalog.has_table_privilege(r.name, 'tmpos_rate_limit.key_fingerprint', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as fingerprint,
      pg_catalog.has_any_column_privilege(r.name, 'tmpos_rate_limit.bucket', 'SELECT, INSERT, UPDATE, REFERENCES')
        or pg_catalog.has_any_column_privilege(r.name, 'tmpos_rate_limit.key_fingerprint', 'SELECT, INSERT, UPDATE, REFERENCES') as columns,
      pg_catalog.has_function_privilege(r.name, ${CONSUME}, 'EXECUTE') as consume,
      pg_catalog.has_function_privilege(r.name, ${PROBE}, 'EXECUTE') as probe,
      pg_catalog.has_function_privilege(r.name, ${RECLAIM}, 'EXECUTE') as reclaim,
      pg_catalog.has_function_privilege(r.name, ${KEY_ADMITS}, 'EXECUTE') as key_admits,
      pg_catalog.has_schema_privilege(r.name, 'tmpos_rate_limit', 'USAGE') as usage,
      pg_catalog.has_schema_privilege(r.name, 'tmpos_rate_limit', 'CREATE') as create_in
    from pg_catalog.unnest(${roles}::text[]) as r(name) order by r.name`;
  const runtimeSide = (name) => name === 'tmpos_app' || name === LOGIN;
  assert.deepEqual(effective.map((r) => ({ ...r })), [...roles].sort().map((name) => ({
    name, bucket: false, fingerprint: false, columns: false, consume: runtimeSide(name), probe: runtimeSide(name), reclaim: runtimeSide(name),
    key_admits: false, usage: runtimeSide(name), create_in: false,
  })), `${label}: effective privileges — tmpos_app (and the login through it) may run the consume, the probe and the reclaim, and nobody may touch a table`);
  const [{ v17 }] = await sql`select pg_catalog.current_setting('server_version_num')::int >= 170000 as v17`;
  if (v17) {
    const [{ maintain }] = await sql`select pg_catalog.bool_or(pg_catalog.has_table_privilege(r.name, t.rel, 'MAINTAIN')) as maintain
      from pg_catalog.unnest(${roles}::text[]) r(name) cross join (values ('tmpos_rate_limit.bucket'), ('tmpos_rate_limit.key_fingerprint')) t(rel)`;
    assert.equal(maintain, false, `${label}: nor MAINTAIN`);
  }
  const [{ owner: schemaOwner, me, members }] = await sql`select n.nspowner::regrole::text as owner, current_user::text as me,
      (select pg_catalog.count(*)::int from pg_catalog.pg_roles r where r.rolname = any (${roles}::name[]) and pg_catalog.pg_has_role(r.oid, n.nspowner, 'MEMBER')) as members
    from pg_catalog.pg_namespace n where n.nspname = 'tmpos_rate_limit'`;
  assert.equal(schemaOwner, me, `${label}: owned by the applier`);
  assert.equal(members, 0, `${label}: no runtime-facing role is a member of the owner`);
}

/**
 * 014's objects by definition — every routine's full text, ACL and comment; every constraint's and index's definition; every
 * relation's and the schema's ACL, options and comment — read under the search path 014 itself runs with.
 */
async function definitionOf(sql) {
  await sql`select pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`;
  return {
    routines: (await sql`select p.proname::text as name, pg_catalog.pg_get_functiondef(p.oid) as def, p.proacl::text as acl,
        pg_catalog.obj_description(p.oid, 'pg_proc') as comment
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tmpos_rate_limit' order by 1`).map((r) => ({ ...r })),
    constraints: (await sql`select c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def
      from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid = c.connamespace where n.nspname = 'tmpos_rate_limit' order by 1`)
      .map((r) => `${r.name}: ${r.def}`),
    relations: (await sql`select c.relname::text as name, c.relacl::text as acl, c.reloptions::text as options,
        pg_catalog.obj_description(c.oid, 'pg_class') as comment, case when c.relkind = 'i' then pg_catalog.pg_get_indexdef(c.oid) end as indexdef
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'tmpos_rate_limit' order by 1`).map((r) => ({ ...r })),
    schema: (await sql`select n.nspacl::text as acl, pg_catalog.obj_description(n.oid, 'pg_namespace') as comment
      from pg_catalog.pg_namespace n where n.nspname = 'tmpos_rate_limit'`).map((r) => ({ ...r })),
  };
}

/** From the probe login itself: every table statement and the key check are refused (42501); the probe answers. */
async function assertLoginContained(label) {
  const runtime = connect(LOGIN, 1);
  try {
    const fp = `'\\x${FP}'::bytea`;
    for (const statement of [
      'select count(*) from tmpos_rate_limit.bucket', 'select count(*) from tmpos_rate_limit.key_fingerprint',
      'delete from tmpos_rate_limit.bucket', 'update tmpos_rate_limit.bucket set consumed = 1', 'truncate tmpos_rate_limit.bucket',
      'delete from tmpos_rate_limit.key_fingerprint', `insert into tmpos_rate_limit.key_fingerprint (fingerprint) values (${fp})`,
      `update tmpos_rate_limit.key_fingerprint set fingerprint = ${fp}`, `select tmpos_rate_limit.m6_rate_limit_key_admits(${fp})`,
    ]) {
      assert.equal(await runtime.unsafe(statement).then(() => null, (err) => err.code), '42501', `${label}: the login is refused: ${statement}`);
    }
    assert.deepEqual((await runtime.unsafe(`select outcome from tmpos_rate_limit.m6_rate_limit_probe(${fp})`)).map((r) => r.outcome), ['ready']);
  } finally {
    await runtime.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// migration 014 as applied
// ---------------------------------------------------------------------------

test('M6R-01: 001-034 apply clean; 014 is exactly its declared objects and privileges, holds no identifying column, and creates no role', async () => {
  // The LEDGER, not this run's report: on the shared CI service an earlier suite may already have applied the chain.
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024', '025', '026', '027', '028', '029', '030', '031', '032', '033', '034'].map((v) => [v, false]));

  await assertDeclared(owner, 'as applied');
  await assertLoginContained('as applied');
  assert.equal(CANONICAL_READY_AT_START, true, 'the canonical test key is the registered one');
  assert.deepEqual((await fingerprintRow()).map((r) => r.fp), [FP]);

  // The CHECKs admit only a pseudonym: a TEST-NET address or any non-base64url text is refused, the HMAC shape is stored.
  await rolledBack(async (tx) => {
    const put = (limiterKey) => (sp) => sp`insert into tmpos_rate_limit.bucket values ('tenant', 'client', ${limiterKey}, 5, 6000, 1, now(), now() + interval '6 seconds')`;
    const code = async (limiterKey) => (await refusalIn(tx)(put(limiterKey)))?.code ?? null;
    for (const addressLike of ['198.51.100.23', '2001:db8::7', '203.0.113.9'.padEnd(43, '0'), `2001:db8:0:0:0:0:0:1${'a'.repeat(23)}`, `m6r ${'a'.repeat(39)}`]) {
      assert.equal(await code(addressLike), '23514', `refused: ${addressLike}`);
    }
    assert.equal(await code(key('m6r01-shape')), null, 'a 43-character base64url pseudonym is stored');
  });

  // No role: the files name none, and neither the rollback nor a re-application changes pg_roles or pg_auth_members.
  const statements = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  for (const text of [UP_014, DOWN_014]) assert.doesNotMatch(statements(text), /\b(?:create|alter|drop)\s+(?:role|user|group)\b/i);
  await rolledBack(async (tx) => {
    const before = await rolesSnapshot(tx);
    await expireAll(tx);
    await tx.unsafe(DOWN_014).simple();
    assert.deepEqual(await rolesSnapshot(tx), before, 'the rollback dropped no role and no membership');
    await tx.unsafe(UP_014).simple();
    assert.deepEqual(await rolesSnapshot(tx), before, 'the application created no role and no membership');
  });
});

// ---------------------------------------------------------------------------
// the port contract, unchanged
// ---------------------------------------------------------------------------

test('M6R-02: the UNCHANGED conformance suite passes over two adapter instances on two separate kernels sharing one database', async (t) => {
  const [, ms] = await timed(() => assertRateLimiterContract({
    limiter: A, peer: B, windowMs: 6_000,
    // Real time: the store's clock is the database's, which this harness cannot move. The margin covers the timers.
    advance: (ms) => sleep(ms + 25),
    breakStore: storeDown,
    restoreStore: () => relay.restore(),
  }));
  t.diagnostic(`conformance suite: ${Math.round(ms)} ms (window 6000 ms, real time)`);
  assert.equal(await A.probe(live()), true);
  assert.equal(await B.probe(live()), true);
});

// ---------------------------------------------------------------------------
// beyond the suite
// ---------------------------------------------------------------------------

test('M6R-03: 120 concurrent consumes of one bucket over four instances on both kernels, and 200 of mixed cost: each answer is its own committed decision or fail-closed, the committed grants are one serial order summing to the owner\'s count inside one window, and the rest of that window is exactly what they left', async (t) => {
  // Every pool open first, so the burst measures the store, not twelve connection handshakes.
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? A : B).probe(live())));
  // One instance holds at most RATE_LIMIT_LANE_DEPTH consumes of one bucket in line and refuses the rest at once (M6R-13),
  // so the bursts are spread over four instances, two per kernel: 30 and 50 in each line, none refused at the door. Each
  // consume in a line waits for every transaction ahead of it under its own 500 ms deadline, so how many answer before it
  // depends on the host — durable commits, a busy CPU, a stalled client — and the deepest answer unavailable when it is
  // slow: the contract's fail-closed answer, not a fault (M6R-PERF-R1 traced CI's failures of this test to exactly that).
  // So this test proves exactness consume by consume, whatever the host's speed (assertBurst), and then the rest of the
  // window; how many were unavailable is reported, and RLR-04 forces that case and proves it fail-closed. When none was,
  // the burst itself must have granted exactly the limit and refused past it.
  const instances = fourTraced();
  assert.ok(120 / instances.length < RATE_LIMIT_LANE_DEPTH && 200 / instances.length < RATE_LIMIT_LANE_DEPTH);
  for (const [label, limit, costs] of [
    ['120 at cost 1, limit 40', 40, Array.from({ length: 120 }, () => 1)],
    ['200 at costs 1, 2, 3, 5 and 7, limit 100', 100, Array.from({ length: 200 }, (_, i) => [1, 2, 3, 5, 7][i % 5])],
  ]) {
    const k = key(`m6r03-${limit}`);
    const before = await dbNowUs();
    const run = await burst(instances, costs.map((cost) => req(k, limit, 6_000, cost)));
    t.diagnostic(`${label} over 4 instances on 2 kernels x 6 connections: ${describeBurst(run)}`);
    const [{ consumed }] = await rowsOf([k]);
    assertBurst(run, limit, consumed, label, { strict: true });
    // A burst that lost no consume to its deadline granted exactly the limit and refused past it. One that did lost them
    // behind lines assertBurst has proved busy, so how far it got is the host's speed — the rest of the window, below,
    // still holds exactly what it left.
    if (!run.calls.some((c) => c.answer.outcome === 'unavailable')) {
      assert.equal(consumed, limit, `${label}: the burst itself granted exactly the limit`);
      assert.ok(run.calls.some((c) => c.txs[0]?.ended === 'committed' && c.txs[0].decision.outcome === 'limited'), `${label}: and refused past it`);
    }
    for (let i = 0; i < instances.length; i += 1) {
      assert.ok(run.calls.some((c) => c.instance === i && c.txs.length === 1), `${label}: instance ${i} reached the store`);
    }
    await assertRestOfWindow(instances, k, limit, consumed, label);
    await assertOneWindow(k, limit, before, label);
  }
});

test('M6R-04: the window and the wait are the database clock\'s and the stored row\'s; the window reopens exactly at windowMs; a refused consume writes nothing', async () => {
  // The window opens on the database clock: bracketed by two owner readings of clock_timestamp().
  const a = key('m6r04-open');
  const before = await dbNowUs();
  assert.deepEqual(await A.consume(req(a, 1, 2_000), live()), allowed(0));
  const after = await dbNowUs();
  const [opened] = await rowsOf([a]);
  assert.ok(BigInt(opened.start_us) >= before && BigInt(opened.start_us) <= after, 'window_start is the database clock at the consume');
  assert.equal(BigInt(opened.expires_us) - BigInt(opened.start_us), 2_000_000n, 'expires_at is window_start + windowMs exactly');

  // The wait is the STORED expiry minus the database's now. The owner moves the window 4.5 s into the past: the caller's
  // own clock still says about 6 s are left; the store answers about 1.5 s. A refused consume leaves the row as it was.
  const s = key('m6r04-shift');
  assert.deepEqual(await A.consume(req(s, 1), live()), allowed(0));
  await owner`update tmpos_rate_limit.bucket set window_start = window_start - interval '4500 milliseconds', expires_at = expires_at - interval '4500 milliseconds'
    where limiter_key = ${s}`;
  const [shifted] = await rowsOf([s]);
  const b0 = await dbNowUs();
  const refused = await B.consume(req(s, 1), live());
  const a0 = await dbNowUs();
  assert.equal(refused.outcome, 'limited');
  const expires = BigInt(shifted.expires_us);
  assert.ok(refused.retryAfterMs >= ceilMs(expires - a0) && refused.retryAfterMs <= ceilMs(expires - b0),
    `retryAfterMs ${refused.retryAfterMs} is expires_at minus the database clock (${ceilMs(expires - a0)}..${ceilMs(expires - b0)})`);
  assert.ok(refused.retryAfterMs <= 1_500, 'never the caller-side ~6 s');
  assert.deepEqual(await rowsOf([s]), [shifted], 'the refused consume changed nothing: row, xmin and ctid byte-identical');

  // The boundary is the database's: an expiry set to the owner's clock reading is past for the next consume (reopened, in
  // place), and one set a second ahead is still a limit whose wait is bounded by that second.
  await owner`with n as (select pg_catalog.clock_timestamp() as t) update tmpos_rate_limit.bucket b
    set window_start = n.t - interval '6000 milliseconds', expires_at = n.t from n where b.limiter_key = ${s}`;
  const [atBoundary] = await rowsOf([s]);
  assert.deepEqual(await A.consume(req(s, 1), live()), allowed(0), 'expires_at <= the database now: the window reopens');
  const [reopened] = await rowsOf([s]);
  assert.equal(reopened.ctid === atBoundary.ctid && reopened.xmin === atBoundary.xmin, false, 'rewritten');
  assert.ok(BigInt(reopened.start_us) >= BigInt(atBoundary.expires_us), 'the new window starts at or after the old expiry');
  await owner`with n as (select pg_catalog.clock_timestamp() + interval '1000 milliseconds' as t) update tmpos_rate_limit.bucket b
    set window_start = n.t - interval '6000 milliseconds', expires_at = n.t from n where b.limiter_key = ${s}`;
  const [ahead] = await rowsOf([s]);
  const b1 = await dbNowUs();
  const still = await B.consume(req(s, 1), live());
  const a1 = await dbNowUs();
  assert.equal(still.outcome, 'limited');
  assert.ok(still.retryAfterMs >= ceilMs(BigInt(ahead.expires_us) - a1) && still.retryAfterMs <= ceilMs(BigInt(ahead.expires_us) - b1));

  // In real time, over a 1 s window: limited just before windowMs has passed on the database clock, allowed right after.
  // The near-end consume must run before the expiry; on a host that stalls past it, the attempt starts again on a new key.
  let r;
  let first;
  let end;
  for (let attempt = 1; ; attempt++) {
    r = key(`m6r04-reopen-${attempt}`);
    assert.deepEqual(await A.consume(req(r, 2, 1_000), live()), allowed(1));
    assert.deepEqual(await B.consume(req(r, 2, 1_000), live()), allowed(0));
    [first] = await rowsOf([r]);
    end = BigInt(first.expires_us);
    await sleep(Math.max(0, ceilMs(end - (await dbNowUs())) - 250));
    const b2 = await dbNowUs();
    const near = await A.consume(req(r, 2, 1_000), live());
    const a2 = await dbNowUs();
    if (a2 >= end && attempt < 3) continue;
    assert.ok(a2 < end, 'the near-end consume ran before the expiry on the database clock (three attempts)');
    assert.equal(near.outcome, 'limited', 'not reopened before windowMs');
    assert.ok(near.retryAfterMs >= ceilMs(end - a2) && near.retryAfterMs <= ceilMs(end - b2) && near.retryAfterMs <= 250);
    break;
  }
  assert.deepEqual(await rowsOf([r]), [first], 'and it wrote nothing');
  while ((await dbNowUs()) <= end) await sleep(Math.max(1, ceilMs(end - (await dbNowUs())) + 5));
  assert.deepEqual(await B.consume(req(r, 2, 1_000), live()), allowed(1), 'reopened once windowMs has passed');
  const [next] = await rowsOf([r]);
  assert.ok(BigInt(next.start_us) >= end, 'the next window starts no earlier than windowMs after the first');
  assert.equal(BigInt(next.expires_us) - BigInt(next.start_us), 1_000_000n);
  assert.equal(next.consumed, 1);
});

test('M6R-05: an instance keyed differently counts nothing and is never ready, while the canonical instances keep working; the fingerprint is never rewritten', async () => {
  const skewed = createPostgresRateLimiter({ client: k1, keySecret: OTHER_KEY });
  const registered = await fingerprintRow();
  assert.deepEqual(registered.map((r) => r.fp), [FP]);
  const known = key('m6r05-known');
  assert.deepEqual(await A.consume(req(known, 3), live()), allowed(2));
  await settle(); // that consume opened a window: its out-of-band reclaim ends before the table is read
  const everything = await allBuckets();
  const fresh = key('m6r05-fresh');
  assert.deepEqual(await skewed.consume(req(fresh, 3), live()), UNAVAILABLE, 'a new bucket: unavailable');
  assert.deepEqual(await skewed.consume(req(known, 3), live()), UNAVAILABLE, 'nor one the canonical key opened');
  assert.equal(await skewed.probe(live()), false, 'never ready');
  assert.deepEqual(await allBuckets(), everything, 'no bucket written, read-modified or reclaimed: every row byte-identical, none added');
  assert.deepEqual(await fingerprintRow(), registered, 'the fingerprint row is untouched: fingerprint, registered_at and xmin');
  assert.deepEqual(await A.consume(req(known, 3), live()), allowed(1), 'the canonical instance counts on, the skewed calls having spent nothing');
  assert.deepEqual(await B.consume(req(fresh, 3), live()), allowed(2));
  assert.equal(await A.probe(live()), true);
  assert.deepEqual(await fingerprintRow(), registered);
});

test('M6R-06: the first registration is atomic — a race of two keys across three kernels registers exactly one, and only its instances work', async (t) => {
  const k3 = kernel(2);
  const instances = [k1, k2, k3].flatMap((k) => [['canonical', createPostgresRateLimiter({ client: k, keySecret: KEY })],
    ['other', createPostgresRateLimiter({ client: k, keySecret: OTHER_KEY })]]);
  const wins = { canonical: 0, other: 0 };
  let rounds = 0;
  let restored = null;
  try {
    while (rounds < 40 && (rounds < 6 || wins.canonical === 0 || wins.other === 0)) {
      rounds += 1;
      await owner`delete from tmpos_rate_limit.key_fingerprint`;
      // 24 first calls: each of six instances (two keys x three kernels) consumes twice and probes twice, in a shuffled order.
      const calls = instances.flatMap(([side, instance], i) => [0, 1].flatMap((j) => [
        { side, instance, op: 'consume', key: key(`m6r06:${rounds}:${i}:${j}`) }, { side, instance, op: 'probe' }]));
      for (let i = calls.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [calls[i], calls[j]] = [calls[j], calls[i]]; }
      const answers = await Promise.all(calls.map((c) => (c.op === 'consume' ? c.instance.consume(req(c.key, 5), live()) : c.instance.probe(live()))));
      const rows = await fingerprintRow();
      assert.equal(rows.length, 1, 'exactly one fingerprint registered');
      const winner = rows[0].fp === FP ? 'canonical' : rows[0].fp === OTHER_FP ? 'other' : null;
      assert.notEqual(winner, null, 'and it is one of the two presented');
      wins[winner] += 1;
      calls.forEach((c, i) => assert.deepEqual(answers[i],
        c.side === winner ? (c.op === 'consume' ? allowed(4) : true) : (c.op === 'consume' ? UNAVAILABLE : false),
        `round ${rounds}: a ${c.side} ${c.op} when ${winner} registered first`));
      const consumes = calls.filter((c) => c.op === 'consume');
      assert.deepEqual((await rowsOf(consumes.map((c) => c.key))).map((r) => r.limiter_key).sort(),
        consumes.filter((c) => c.side === winner).map((c) => c.key).sort(), 'only the registered key\'s consumes wrote a bucket');
    }
  } finally {
    await owner`delete from tmpos_rate_limit.key_fingerprint`;
    restored = await A.probe(live());
    await k3.end();
  }
  t.diagnostic(`${rounds} rounds of 24 concurrent first calls: canonical registered first ${wins.canonical}x, other ${wins.other}x`);
  assert.ok(wins.canonical > 0 && wins.other > 0, 'both outcomes exercised');
  assert.equal(restored, true, 'the canonical registration is restored');
  assert.deepEqual((await fingerprintRow()).map((r) => r.fp), [FP]);
});

test('M6R-07: reclaim is out of band — at most four expired buckets per call, oldest first, never a live one, skipping rows another transaction holds; only a window opening starts one', async (t) => {
  const SEED = `m6r07${RUN}`;
  const PAD = 43 - SEED.length - 1;
  const seededKey = (tag, i) => `${SEED}${tag}${String(i).padStart(PAD, '0')}`;
  // Seeded as the owner, far in the past, so they are the oldest expired buckets the table holds.
  const seed = (tag, from, to, base) => owner`insert into tmpos_rate_limit.bucket
      (namespace, dimension, limiter_key, limit_count, window_ms, consumed, window_start, expires_at)
    select 'runtime', 'store', ${`${SEED}${tag}`} || pg_catalog.lpad(i::text, ${PAD}, '0'), 5, 1000, 1,
      ${base}::timestamptz + i * interval '1 second', ${base}::timestamptz + i * interval '1 second' + interval '1000 milliseconds'
    from pg_catalog.generate_series(${from}::int, ${to}::int) i`;
  const mineExpired = async (sql = owner) => (await sql`select b.limiter_key from tmpos_rate_limit.bucket b
    where b.limiter_key like ${`${SEED}%`} and b.expires_at <= pg_catalog.clock_timestamp() order by b.expires_at`).map((r) => r.limiter_key);
  /** Polls until `ok(value)` holds, for up to a second; answers the last value read. */
  const until = async (read, ok) => {
    const stop = performance.now() + 1_000;
    let value = await read();
    while (!ok(value) && performance.now() < stop) { await sleep(10); value = await read(); }
    return value;
  };
  const runtime = connect(LOGIN, 1);
  const reclaimAs = async (sql) => (await sql`select tmpos_rate_limit.m6_rate_limit_reclaim() as n`)[0].n;
  const skewed = createPostgresRateLimiter({ client: observed(k1), keySecret: OTHER_KEY });
  try {
    await settle();
    await seed('e', 0, 9, '2001-01-01 00:00:00+00');
    await owner`insert into tmpos_rate_limit.bucket (namespace, dimension, limiter_key, limit_count, window_ms, consumed, window_start, expires_at)
      select 'runtime', 'account', ${`${SEED}l`} || pg_catalog.lpad(i::text, ${PAD}, '0'), 5, 60000, 2, now(), now() + interval '60000 milliseconds'
      from pg_catalog.generate_series(0, 4) i`;
    const liveSeeded = Array.from({ length: 5 }, (_, i) => seededKey('l', i));
    const liveBefore = await rowsOf(liveSeeded);
    const [{ older }] = await owner`select pg_catalog.count(*)::int as older from tmpos_rate_limit.bucket
      where limiter_key not like ${`${SEED}%`} and expires_at <= timestamptz '2001-01-01 00:00:12+00'`;
    assert.equal(older, 0, 'no other bucket is older than the seeded ones');

    // The routine, called by the runtime login: exactly the four oldest expired buckets go, and it says so; every other
    // row, live or expired, is byte-identical.
    const before = await allBuckets();
    const [n, took] = await timed(() => reclaimAs(runtime));
    assert.equal(n, 4, 'it answers how many it deleted');
    const after = await allBuckets();
    assert.deepEqual([...before.keys()].filter((id) => !after.has(id)).sort(),
      [0, 1, 2, 3].map((i) => `runtime/store/${seededKey('e', i)}/5/1000`), 'the four oldest expired buckets, and nothing else');
    for (const [id, v] of after) assert.equal(v, before.get(id), `untouched: ${id}`);

    // A row another transaction holds is skipped, not waited on: the call answers at once and takes the next four.
    await owner.begin(async (tx) => {
      const held = (await mineExpired(tx))[0];
      assert.equal(held, seededKey('e', 4));
      await tx`select 1 from tmpos_rate_limit.bucket where limiter_key = ${held} for update`;
      // The runtime login sets no lock_timeout here: had the call waited for the held row, it could not return before
      // this transaction ends, which is after it returns.
      const deleted = await reclaimAs(runtime);
      assert.equal(deleted, 4);
      assert.deepEqual(await mineExpired(tx), [held, seededKey('e', 9)], 'the held row stays; e5-e8 were reclaimed instead');
    });
    t.diagnostic(`one reclaim call: ${took.toFixed(1)} ms`);

    // From the adapter, only an allowance that opened a window starts one — not the probe, not a refused key, not a count
    // inside an open window, not a limit — and it runs after the consume has answered.
    const k = key('m6r07-trigger');
    reclaims.started = 0;
    const quiet = await allBuckets();
    assert.equal(await Aobs.probe(live()), true);
    assert.deepEqual(await skewed.consume(req(key('m6r07-skewed'), 2), live()), UNAVAILABLE);
    await settle();
    assert.equal(reclaims.started, 0, 'the probe and a refused key start no reclaim');
    assert.deepEqual(await allBuckets(), quiet, 'and nothing was reclaimed');
    assert.deepEqual(await Aobs.consume(req(k, 2), live()), allowed(1), 'opens a window');
    assert.deepEqual(await until(mineExpired, (left) => left.length === 0), [], 'the expired rows drop once the window opened');
    assert.equal(reclaims.started, 1, 'one reclaim');
    await seed('x', 0, 3, '2001-06-01 00:00:00+00');
    assert.deepEqual(await Aobs.consume(req(k, 2), live()), allowed(0), 'counts inside the window');
    assert.equal((await Aobs.consume(req(k, 2), live())).outcome, 'limited');
    await settle();
    assert.equal(reclaims.started, 1, 'neither a count inside an open window nor a limit starts one');
    assert.equal((await mineExpired()).length, 4, 'and nothing was reclaimed');

    // A large backlog under concurrency: every consume answers, the totals are exact, and the backlog shrinks by at most
    // four per reclaim — at most one in flight per instance, and only after a window opened.
    const BACKLOG = 3_000;
    await seed('b', 0, BACKLOG - 1, '2002-01-01 00:00:00+00');
    const backlog0 = (await mineExpired()).length;
    const keys = Array.from({ length: 20 }, (_, i) => key(`m6r07-many-${i}`));
    const calls = Array.from({ length: 60 }, (_, i) => ({ k: keys[i % 20], instance: i % 2 ? Aobs : Bobs }));
    Object.assign(reclaims, { started: 0, maxInFlight: 0, faults: [] });
    const latencies = [];
    const [answers, ms] = await timed(() => Promise.all(calls.map(async ({ k: bucket, instance }) => {
      const [answer, took1] = await timed(() => instance.consume(req(bucket, 2), live()));
      latencies.push(took1);
      return answer;
    })));
    await settle();
    assert.equal(answers.filter((o) => o.outcome === 'unavailable').length, 0, 'never unavailable');
    assert.equal(answers.filter((o) => o.outcome === 'allowed').length, 40);
    assert.equal(answers.filter((o) => o.outcome === 'limited').length, 20);
    for (const bucket of keys) {
      assert.deepEqual(answers.filter((o, i) => calls[i].k === bucket && o.outcome === 'allowed').map((o) => o.remaining).sort(), [0, 1]);
    }
    assert.deepEqual((await rowsOf(keys)).map((r) => r.consumed), keys.map(() => 2), 'the owner sees each bucket at its limit');
    const shrink = backlog0 - (await mineExpired()).length;
    assert.ok(reclaims.started >= 1 && reclaims.started <= keys.length, `${reclaims.started} reclaims for ${keys.length} window openings`);
    assert.ok(reclaims.maxInFlight <= 1, 'never two reclaims in flight on one instance');
    assert.ok(shrink >= 1 && shrink <= 4 * reclaims.started, `the backlog shrank by ${shrink}: at most four per reclaim`);
    assert.deepEqual(await rowsOf(liveSeeded), liveBefore, 'no reclaim touched a live bucket');
    latencies.sort((x, y) => x - y);
    t.diagnostic(`under load: ${calls.length} concurrent consumes (20 window openings) over a ${backlog0}-row expired backlog in ${Math.round(ms)} ms `
      + `(p50 ${percentile(latencies, 0.5).toFixed(1)} ms, p95 ${percentile(latencies, 0.95).toFixed(1)} ms); ${reclaims.started} reclaims `
      + `(failed: ${JSON.stringify(reclaims.faults)}), backlog shrank by ${shrink}. OPERATIONAL LIMIT: at most 4 expired rows per window `
      + 'opening, one reclaim at a time per instance; N expired rows need at least ceil(N/4) window openings to drain, and none drain without traffic');
  } finally {
    try {
      await owner`delete from tmpos_rate_limit.bucket where limiter_key like ${`${SEED}%`}`;
    } finally {
      await runtime.end({ timeout: 5 }).catch(() => {});
    }
  }
});

test('M6R-08: every malformed routine answer, a raise and a routine that never answers are unavailable (the probe false); 014 is then restored exactly', async (t) => {
  const SHAPE = 'table (outcome text, remaining integer, retry_after_ms integer)';
  const signature = { consume: [CONSUME, 'm6_rate_limit_consume', 'p_key_fingerprint bytea, p_namespace text, p_dimension text, p_limiter_key text, p_limit integer, p_window_ms integer, p_cost integer'],
    probe: [PROBE, 'm6_rate_limit_probe', 'p_key_fingerprint bytea'] };
  /** Replaces 014's routine by one of the same signature, executable by tmpos_app, so only its answer differs. */
  const fake = (which, returns, body, language = 'sql') => {
    const [sig, name, args] = signature[which];
    return owner.unsafe(`drop function ${sig};
      create function tmpos_rate_limit.${name}(${args}) returns ${returns} language ${language} volatile as $m6r$ ${body} $m6r$;
      grant execute on function ${sig} to tmpos_app`).simple();
  };
  const restore = () => owner.begin((tx) => tx.unsafe(`set local search_path = pg_catalog, pg_temp;
    drop function if exists ${CONSUME}; drop function if exists ${PROBE};\n${ROUTINES_014}`).simple());
  const definition = async () => (await owner`select p.oid::regprocedure::text as sig, pg_catalog.pg_get_functiondef(p.oid) as def, p.proacl::text as acl,
      pg_catalog.obj_description(p.oid, 'pg_proc') as comment from pg_catalog.pg_proc p
    where p.pronamespace = 'tmpos_rate_limit'::regnamespace order by p.proname`).map((r) => ({ ...r }));
  const asApplied = await definition();
  const k = key('m6r08');
  const calls = [];
  try {
    for (const [label, returns, body, expected, fault, language] of [
      ['control: a well-formed allowance', SHAPE, "select 'allowed'::text, p_limit - p_cost, null::integer", allowed(4), []],
      ['control: a well-formed limit', SHAPE, "select 'limited'::text, null::integer, p_window_ms", { outcome: 'limited', retryAfterMs: 6_000 }, []],
      ['two rows', SHAPE, "values ('allowed'::text, 4, null::integer), ('allowed'::text, 3, null::integer)", UNAVAILABLE, []],
      ['no row', SHAPE, "select 'allowed'::text, 4, null::integer where false", UNAVAILABLE, []],
      ['allowed with more left than the limit minus the cost', SHAPE, "select 'allowed'::text, p_limit - p_cost + 1, null::integer", UNAVAILABLE, []],
      ['allowed with a negative remainder', SHAPE, "select 'allowed'::text, -1, null::integer", UNAVAILABLE, []],
      ['allowed with no remainder', SHAPE, "select 'allowed'::text, null::integer, null::integer", UNAVAILABLE, []],
      ['allowed carrying a wait', SHAPE, "select 'allowed'::text, 0, 5", UNAVAILABLE, []],
      ['limited with a zero wait', SHAPE, "select 'limited'::text, null::integer, 0", UNAVAILABLE, []],
      ['limited with a wait past the window', SHAPE, "select 'limited'::text, null::integer, p_window_ms + 1", UNAVAILABLE, []],
      ['limited carrying a remainder', SHAPE, "select 'limited'::text, 0, 5", UNAVAILABLE, []],
      ['key_mismatch', SHAPE, "select 'key_mismatch'::text, null::integer, null::integer", UNAVAILABLE, []],
      ['an outcome the port does not know', SHAPE, "select 'ready'::text, 0, null::integer", UNAVAILABLE, []],
      ['a null outcome', SHAPE, 'select null::text, 0, null::integer', UNAVAILABLE, []],
      ['remaining as bigint', 'table (outcome text, remaining bigint, retry_after_ms integer)', "select 'allowed'::text, 4::bigint, null::integer", UNAVAILABLE, []],
      ['remaining as text', 'table (outcome text, remaining text, retry_after_ms integer)', "select 'allowed'::text, '4'::text, null::integer", UNAVAILABLE, []],
      ['a column missing', 'table (outcome text, remaining integer)', "select 'allowed'::text, 4", UNAVAILABLE, ['42703']],
      ['a column renamed', 'table (outcome text, remaining integer, retry_after integer)', "select 'allowed'::text, 4, null::integer", UNAVAILABLE, ['42703']],
      // The adapter names its three columns, so a fourth is never read: the answer is judged on those three alone.
      ['an added column, never read', 'table (outcome text, remaining integer, retry_after_ms integer, detail text)',
        "select 'allowed'::text, p_limit - p_cost, null::integer, '198.51.100.23'::text", allowed(4), []],
      ['a raise', SHAPE, "begin raise exception 'm6r' using errcode = '40001'; end", UNAVAILABLE, ['40001'], 'plpgsql'],
      ['a statement that never answers', SHAPE, "select 'allowed'::text, 4, null::integer from pg_catalog.pg_sleep(3)", UNAVAILABLE, ['57014']],
    ]) {
      await fake('consume', returns, body, language);
      faults.length = 0;
      const [answer, took] = await timed(() => Aobs.consume(req(k, 5), live()));
      calls.push(took);
      assert.deepEqual(answer, expected, `consume: ${label}`);
      assert.ok(took < LIMITER_DEADLINE_MS + 200, `consume: ${label} answered in ${took.toFixed(0)} ms`);
      // The adapter answers the moment its bound ends; the kernel's own account of the transaction may land after that.
      for (const stop = performance.now() + 2_000; k1obs.own.open > 0 && performance.now() < stop;) await sleep(2);
      assert.deepEqual(faults, fault, `consume: ${label} — how the transaction ended`);
    }
    // The routine that never answered was cancelled by PostgreSQL (statement_timeout), not merely abandoned by the caller.
    const [{ busy }] = await owner`select pg_catalog.count(*)::int as busy from pg_catalog.pg_stat_activity
      where usename = ${LOGIN} and state = 'active' and query like '%m6_rate_limit_consume%'`;
    assert.equal(busy, 0, 'no session of the login is still running it');
    await restore();

    for (const [label, returns, body, expected, fault = []] of [
      ['control: ready', 'table (outcome text)', "select 'ready'::text", true],
      ['two rows', 'table (outcome text)', "values ('ready'::text), ('ready'::text)", false],
      ['no row', 'table (outcome text)', "select 'ready'::text where false", false],
      ['another spelling', 'table (outcome text)', "select 'READY'::text", false],
      ['consume_unavailable', 'table (outcome text)', "select 'consume_unavailable'::text", false],
      ['store_read_only', 'table (outcome text)', "select 'store_read_only'::text", false],
      ['key_mismatch', 'table (outcome text)', "select 'key_mismatch'::text", false],
      ['a null outcome', 'table (outcome text)', 'select null::text', false],
      ['a boolean', 'table (outcome boolean)', 'select true', false],
      ['a column renamed', 'table (state text)', "select 'ready'::text", false, ['42703']],
      ['a statement that never answers', 'table (outcome text)', "select 'ready'::text from pg_catalog.pg_sleep(3)", false, ['57014']],
    ]) {
      await fake('probe', returns, body);
      faults.length = 0;
      const [answer, took] = await timed(() => Aobs.probe(live()));
      assert.equal(answer, expected, `probe: ${label}`);
      assert.ok(took < LIMITER_DEADLINE_MS + 200, `probe: ${label} answered in ${took.toFixed(0)} ms`);
      for (const stop = performance.now() + 2_000; k1obs.own.open > 0 && performance.now() < stop;) await sleep(2);
      assert.deepEqual(faults, fault, `probe: ${label} — how the transaction ended`);
    }
  } finally {
    await restore();
  }
  t.diagnostic(`routines replaced in place on this database and restored from the up file; slowest answer ${Math.max(...calls).toFixed(0)} ms`);
  assert.deepEqual(await definition(), asApplied, 'both routines restored exactly: definition, ACL and comment');
  await owner.begin((tx) => tx.unsafe(POSTCONDITION_014).simple());
  await assertDeclared(owner, 'restored');
  await assertLoginContained('restored');
  assert.deepEqual(await A.consume(req(k, 5), live()), allowed(4), 'the real routine counts again (no fake wrote a bucket)');
  assert.equal(await B.probe(live()), true);
});

test('M6R-09: a held row or table lock answers unavailable within lock_timeout, PostgreSQL gives up the wait, and nothing is spent', async () => {
  const k = key('m6r09');
  assert.deepEqual(await A.consume(req(k, 5), live()), allowed(4));
  await settle(); // the window opening's reclaim ends before any lock is taken
  const [row] = await rowsOf([k]);
  for (const [label, lock, probeToo] of [
    ['the bucket row, FOR UPDATE', (tx) => tx`select 1 from tmpos_rate_limit.bucket where limiter_key = ${k} for update`, false],
    ['the bucket table, ACCESS EXCLUSIVE', (tx) => tx`lock table tmpos_rate_limit.bucket in access exclusive mode`, false],
    ['the fingerprint table, ACCESS EXCLUSIVE', (tx) => tx`lock table tmpos_rate_limit.key_fingerprint in access exclusive mode`, true],
  ]) {
    await owner.begin(async (tx) => {
      await lock(tx);
      faults.length = 0;
      const [answer, took] = await timed(() => Aobs.consume(req(k, 5), live()));
      assert.deepEqual(answer, UNAVAILABLE, `${label}: unavailable`);
      assert.ok(took >= 150 && took < LIMITER_DEADLINE_MS + 100, `${label}: after lock_timeout (200 ms), inside the deadline: ${took.toFixed(0)} ms`);
      assert.deepEqual(faults, ['55P03'], `${label}: PostgreSQL's lock_timeout, not the caller's deadline`);
      assert.equal(await lockWaitSeen(20), false, `${label}: the server gave up the wait while the lock is still held`);
      if (probeToo) {
        const [ready, probed] = await timed(() => A.probe(live()));
        assert.equal(ready, false, `${label}: the probe is not ready`);
        assert.ok(probed < LIMITER_DEADLINE_MS + 100);
      }
    });
    assert.deepEqual(await rowsOf([k]), [row], `${label}: the refused consume wrote nothing`);
  }
  assert.deepEqual(await B.consume(req(k, 5), live()), allowed(3), 'released: the next consume counts from where the bucket stood');
  assert.equal(await A.probe(live()), true);
});

test('M6R-10: the rollback refuses while a window is open; otherwise it removes exactly 014, and 014 re-applies cleanly — all rolled back', async () => {
  const present = async (sql) => ({ ...(await sql`select pg_catalog.to_regnamespace('tmpos_rate_limit') is not null as schema,
      (select pg_catalog.count(*)::int from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'tmpos_rate_limit') as routines,
      (select pg_catalog.count(*)::int from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'tmpos_rate_limit') as relations`)[0] });
  const earlier = async (sql) => ({ ...(await sql`select
      pg_catalog.to_regprocedure('tmpos_admission.m5_admit_platform_session(text, text)') is not null as s013,
      pg_catalog.to_regclass('tmpos_admission.platform_authority_version') is not null as s013_table,
      pg_catalog.to_regprocedure('tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)') is not null as s012,
      pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is not null as s011,
      pg_catalog.to_regclass('tmpos_session.session') is not null as s011_table,
      pg_catalog.to_regprocedure('tmpos_identity.m5_resolve_principal(text, text)') is not null as s007,
      pg_catalog.to_regclass('tmpos_internal.idempotency_record') is not null as s006,
      pg_catalog.has_function_privilege('tmpos_app', 'tmpos_admission.m5_admit_platform_session(text, text)', 'EXECUTE') as s013_grant`)[0] });
  const APPLIED = { schema: true, routines: 4, relations: 5 };
  const EARLIER = { s013: true, s013_table: true, s012: true, s011: true, s011_table: true, s007: true, s006: true, s013_grant: true };

  assert.deepEqual(await A.consume(req(key('m6r10-open'), 2), live()), allowed(1));
  await settle();
  const buckets = await allBuckets();
  const registered = await fingerprintRow();
  const applied = await owner.begin((tx) => definitionOf(tx));

  // REFUSED while a window is open, and the refusal changes nothing.
  await rolledBack(async (tx) => {
    const refused = await refusalIn(tx)((sp) => sp.unsafe(DOWN_014).simple());
    assert.equal(refused?.code, '55006', 'object_in_use');
    assert.match(refused.message, /rate-limit bucket\(s\) are still inside their window/);
    assert.deepEqual(await present(tx), APPLIED);
    assert.deepEqual(await allBuckets(tx), buckets, 'no bucket dropped');
  });

  await rolledBack(async (tx) => {
    // The remedy the refusal names — every window closed — planted by moving each window back, the CHECK kept.
    await expireAll(tx);
    await tx.unsafe(DOWN_014).simple();
    assert.deepEqual(await present(tx), { schema: false, routines: 0, relations: 0 }, 'everything 014 created is gone');
    assert.deepEqual(await earlier(tx), EARLIER, '006-013 intact, and tmpos_app keeps what 013 granted');
    await tx.unsafe(UP_014).simple();
    assert.deepEqual(await present(tx), APPLIED, 're-applied, its section 6 passing');
    await assertDeclared(tx, 're-applied');
    assert.deepEqual(await definitionOf(tx), applied,
      'what the shared database holds is, definition for definition, a fresh application of the file: routine bodies, ACLs, comments, constraints, indexes');
    assert.equal(await refusalIn(tx)((sp) => sp.unsafe(POSTCONDITION_014).simple()), null, 'section 6 holds when run again');
    const [{ fingerprints, rows }] = await tx`select (select pg_catalog.count(*)::int from tmpos_rate_limit.key_fingerprint) as fingerprints,
      (select pg_catalog.count(*)::int from tmpos_rate_limit.bucket) as rows`;
    assert.deepEqual([fingerprints, rows], [0, 0], 'a new store: no fingerprint registered, no bucket');
  });

  // Section 6 refuses an application under which another runtime-facing role reaches a routine through membership in
  // tmpos_app — one that could call the probe first could register a fingerprint of its choosing — and creates nothing.
  await rolledBack(async (tx) => {
    await tx`delete from tmpos_rate_limit.bucket`;
    await tx.unsafe(DOWN_014).simple();
    for (const role of ['anon', 'authenticated', 'tmpos_audit_writer']) {
      const refused = await refusalIn(tx)(async (sp) => {
        await sp.unsafe(`grant tmpos_app to ${role}`);
        await sp.unsafe(UP_014).simple();
      });
      assert.deepEqual(refused, { code: '55000', message: 'migration 014 refused: a runtime-facing role other than tmpos_app can execute a rate-limit '
        + `routine (${role} on m6_rate_limit_consume, ${role} on m6_rate_limit_probe, ${role} on m6_rate_limit_reclaim)` }, `${role} in tmpos_app`);
      assert.deepEqual(await present(tx), { schema: false, routines: 0, relations: 0 }, `${role}: the refused application created nothing`);
    }
    // A NOINHERIT member holds no effective EXECUTE, but could SET ROLE tmpos_app: the membership itself is refused.
    const noinherit = await refusalIn(tx)(async (sp) => {
      await sp.unsafe('grant tmpos_app to anon with inherit false');
      await sp.unsafe(UP_014).simple();
    });
    assert.deepEqual(noinherit, { code: '55000', message: 'migration 014 refused: anon is a member of tmpos_app, and no runtime-facing role may be' });
    await tx.unsafe(UP_014).simple();
    assert.deepEqual(await present(tx), APPLIED, 'control: without the membership it applies');
  });

  // The rollback's window check is sound only at READ COMMITTED, so it refuses to run at any stricter level.
  await assert.rejects(owner.begin('isolation level repeatable read', async (tx) => {
    const refused = await refusalIn(tx)((sp) => sp.unsafe(DOWN_014).simple());
    assert.equal(refused?.code, '55000');
    assert.match(refused.message, /it runs only at READ COMMITTED/);
    assert.deepEqual(await present(tx), APPLIED);
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);

  assert.deepEqual(await present(owner), APPLIED, 'the shared state is untouched');
  assert.deepEqual(await allBuckets(), buckets, 'every bucket byte-identical');
  assert.deepEqual(await fingerprintRow(), registered, 'the registration byte-identical');
  assert.equal(await A.probe(live()), true);
});

test('M6R-11: migrations 005-013 are byte-identical to their pins, and the ledger records each applied file\'s checksum', async () => {
  // DUPLICATED from tests/quality/migration-files-contract.test.mjs, whose PINNED object is not exported.
  const PINNED = {
    '005_principal_separation_rls_foundation.up.sql': 'a4a61385beedf98194fb427bcd528704b068d7ca2947a9713d7a1a1c87157bda',
    '005_principal_separation_rls_foundation.down.sql': 'c198c0fa9c481cb2fe99c7f841aba4023bfbbef06663e2948755abca1d74db64',
    '006_m6_transactional_store.up.sql': '091933e19559d1d109580dd86cd381ada12398fbe1a93b011ac97e15c23dc68c',
    '006_m6_transactional_store.down.sql': '767afd8a194b5bfe4b8541af25342f12346d219b8bc046d588ddb18cf3d44ecc',
    '007_m5_trusted_principal_resolution.up.sql': 'a3a9aa98b299cd343e35df6b9048ea1468f5b11668e7ea6996045cb514f7bcbe',
    '007_m5_trusted_principal_resolution.down.sql': '1f3a130489d2c19a9cba27ece60d2937fa92956bf7b1d5e13cfa63602b697984',
    '008_m5_tenant_display_name_command.up.sql': 'cfaa5724bd4b9bb1681f6a8633a282aa8dd3ea3ed3d3cf9a89a8e28d33a51d5e',
    '008_m5_tenant_display_name_command.down.sql': '532ef95098745971cabbef107fe8a8b1fad02fe7f29e4b8722b1a38e3362718f',
    '009_m5_first_command_hardening.up.sql': '032842618ee71ca1e523502a75d9824ea5c922236e03670defb99f0e0764b54c',
    '009_m5_first_command_hardening.down.sql': 'b08558c05c36b0248713409cb2d1924f9d773eb5301707ff77d792a50f75f2b3',
    '010_m5_tenant_lifecycle_command.up.sql': 'a3a2f41107df582826c20001a91edff569507582e1d90df6c339778b2fb8748b',
    '010_m5_tenant_lifecycle_command.down.sql': '02b1633e9f22fa92ca458131c97ac2a79b6499b38802e67fc2c125cf6c240297',
    '011_m5_tenant_admission.up.sql': 'b3944f909c4298f700746784cd52385c5410acd3a15ad39f0a7138d5d6911c7d',
    '011_m5_tenant_admission.down.sql': 'c272ab6656c7a37e62d007bf60404bfaebe21a40ef95dc906efacd7914f7495b',
    '012_m5_platform_tenant_directory.up.sql': '6e71d4d5223576b86bd6acc46ed429bbcff64390d69a6d3980a3bc9baf3efce6',
    '012_m5_platform_tenant_directory.down.sql': '9d359194edc3031ff5dd1dd60bd54bbe448d850c58d393876993cb5301f47a89',
    '013_m5_platform_admission.up.sql': 'c6df3d2e3559270243a52477c8acc9b8d7cca71c576acc00caf8d267a5151f7a',
    '013_m5_platform_admission.down.sql': 'b0d07b580154e6e387d8093b98ad2889273dcd659c0b53aa15a03cf6c3a0b0ab',
  };
  const sha256 = (name) => createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex');
  for (const [name, digest] of Object.entries(PINNED)) assert.equal(sha256(name), digest, name);
  const files = readdirSync(MIG_DIR);
  const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
  assert.equal(ledger.length, 34);
  for (const { version, checksum } of ledger) {
    const up = files.filter((f) => f.startsWith(`${version}_`) && f.endsWith('.up.sql'));
    assert.equal(up.length, 1, version);
    assert.equal(checksum, sha256(up[0]), `the ledger's ${version} is ${up[0]} as it is on disk`);
  }
});

test('M6R-12: a consume of an expired bucket that an in-flight reclaim holds waits less than lock_timeout and still opens a fresh window', async (t) => {
  // Twice. (1) A reclaim-like OWNER transaction locks and deletes the bucket, and commits once the consume is seen waiting:
  // the consume then creates the bucket afresh. (2) The real routine, run as the adapter runs it — the runtime login, one
  // transaction under RATE_LIMIT_RECLAIM_BOUNDS — deletes it and then stalls: its own idle bound makes the server end the
  // session, the delete rolls back, and the consume reopens the bucket in place. Either way the consume is blocked by that
  // transaction's backend (pg_blocking_pids) and still ALLOWED — so its wait ended inside its 200 ms lock_timeout, which
  // would otherwise have made it unavailable.
  const reclaimer = connect(LOGIN, 1);
  const { lock, statement, idle } = RATE_LIMIT_RECLAIM_BOUNDS;
  const waits = [];
  try {
    for (const variant of ['owner-commits', 'reclaim-stalls']) {
      await settle();
      const k = key(`m6r12-${variant}`);
      // Spent, so a stale count would be a limit; and the oldest expired bucket the table holds, so a reclaim takes it first.
      await owner`insert into tmpos_rate_limit.bucket values ('tenant', 'client', ${k}, 3, 6000, 3,
        timestamptz '2000-01-01 00:00:00+00', timestamptz '2000-01-01 00:00:06+00')`;
      const [oldest] = await owner`select limiter_key from tmpos_rate_limit.bucket where expires_at <= pg_catalog.clock_timestamp() order by expires_at limit 1`;
      assert.equal(oldest.limiter_key, k, 'the seeded bucket is the oldest expired one');
      let pending = null;
      let waited = false;
      if (variant === 'owner-commits') {
        await owner.begin(async (tx) => {
          const [{ pid }] = await tx`select pg_catalog.pg_backend_pid() as pid`;
          await tx`select 1 from tmpos_rate_limit.bucket where limiter_key = ${k} for update`;
          await tx`delete from tmpos_rate_limit.bucket where limiter_key = ${k} and expires_at <= pg_catalog.clock_timestamp()`;
          pending = timed(() => A.consume(req(k, 3), live()));
          waited = await blockedBy(pid);
        });
      } else {
        const stalled = reclaimer.begin(async (tx) => {
          const [{ pid }] = await tx`select pg_catalog.pg_backend_pid() as pid`;
          await tx`select pg_catalog.set_config('lock_timeout', ${lock}, true), pg_catalog.set_config('statement_timeout', ${statement}, true),
            pg_catalog.set_config('idle_in_transaction_session_timeout', ${idle}, true)`;
          assert.ok((await tx`select tmpos_rate_limit.m6_rate_limit_reclaim() as n`)[0].n >= 1, 'the reclaim deleted rows, the oldest first');
          pending = timed(() => A.consume(req(k, 3), live()));
          waited = await blockedBy(pid);
          await sleep(200); // idle past its bound: the server ends this session, and the reclaim with it
          await tx`select 1`;
        });
        await assert.rejects(stalled, 'the stalled reclaim was ended by its own idle bound');
      }
      const [answer, took] = await pending;
      waits.push(`${variant}: ${took.toFixed(0)} ms`);
      assert.equal(waited, true, `${variant}: the consume was blocked by that transaction's backend`);
      assert.deepEqual(answer, allowed(2), `${variant}: allowed — its lock wait ended inside lock_timeout — in a fresh window: the old count of 3 is gone`);
      assert.ok(took < LIMITER_DEADLINE_MS, `${variant}: answered in ${took.toFixed(0)} ms`);
      const [row] = await rowsOf([k]);
      assert.equal(row.consumed, 1);
      assert.ok(BigInt(row.start_us) > 1_100_000_000_000_000n, 'the window starts now, not in 2000');
    }
  } finally {
    await reclaimer.end({ timeout: 5 }).catch(() => {});
  }
  t.diagnostic(`consume behind an in-flight reclaim: ${waits.join('; ')}`);
});

test('M6R-13: the consumes of one bucket on one instance wait in its lane, holding no connection — one transaction at a time — and exactly the limit is granted', async (t) => {
  const k = key('m6r13');
  assert.deepEqual(await Aobs.consume(req(k, 40), live()), allowed(39), 'the window opens first, so no reclaim runs during the burst');
  await settle();
  let sampling = true;
  let samples = 0;
  let held = 0;
  // This kernel's sessions (its application_name) inside a transaction, from pg_stat_activity, for as long as the burst runs.
  const sampler = (async () => {
    while (sampling) {
      const [{ n }] = await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_stat_activity
        where usename = ${LOGIN} and application_name = 'm6r-k1' and xact_start is not null`;
      samples += 1;
      held = Math.max(held, n);
    }
  })();
  k1obs.own.max = 0;
  const [burst, ms] = await timed(() => Promise.all(Array.from({ length: 50 }, () => Aobs.consume(req(k, 40), live()))));
  sampling = false;
  await sampler;
  t.diagnostic(`50 concurrent consumes of one bucket on one instance: ${Math.round(ms)} ms; ${samples} samples, at most ${held} session(s) in a transaction`);
  assert.deepEqual(burst.filter((o) => o.outcome === 'allowed').map((o) => o.remaining).sort((x, y) => x - y), Array.from({ length: 39 }, (_, i) => i));
  assert.equal(burst.filter((o) => o.outcome === 'limited').length, 11);
  assert.equal(burst.filter((o) => o.outcome === 'unavailable').length, 0);
  assert.deepEqual((await rowsOf([k])).map((r) => r.consumed), [40], 'exactly the limit, as the owner counts it');
  assert.equal(k1obs.own.max, 1, 'the instance never had two of its transactions open at once');
  assert.ok(samples >= 5 && held === 1, 'pg_stat_activity saw the lane at work, and never more than one of the kernel\'s connections in a transaction');

  // The line is bounded: past RATE_LIMIT_LANE_DEPTH a consume is refused at once and sends nothing; the line still counts exactly.
  const d = key('m6r13-depth');
  assert.deepEqual(await Aobs.consume(req(d, 40), live()), allowed(39));
  await settle();
  k1obs.own.started = 0;
  const over = await Promise.all(Array.from({ length: RATE_LIMIT_LANE_DEPTH + 16 }, () => Aobs.consume(req(d, 40), live())));
  assert.deepEqual(over.slice(RATE_LIMIT_LANE_DEPTH), Array.from({ length: 16 }, () => UNAVAILABLE), 'the 16 past the line are refused');
  assert.equal(k1obs.own.started, RATE_LIMIT_LANE_DEPTH, 'and sent nothing: one transaction per consume in line');
  const inLine = over.slice(0, RATE_LIMIT_LANE_DEPTH);
  assert.deepEqual(inLine.filter((o) => o.outcome === 'allowed').map((o) => o.remaining).sort((x, y) => x - y), Array.from({ length: 39 }, (_, i) => i));
  assert.equal(inLine.filter((o) => o.outcome === 'limited').length, RATE_LIMIT_LANE_DEPTH - 39, 'every other consume in line is limited');
  assert.deepEqual((await rowsOf([d])).map((r) => r.consumed), [40]);
});

test('M6R-14: a read-only store is never ready and counts nothing', async () => {
  // Read-only sessions of the same login, by startup parameter — nothing about the role or the database changes, so
  // nothing outlives this test: a fresh kernel, and one direct connection that asks the routine itself.
  const READ_ONLY = { default_transaction_read_only: 'on' };
  const readOnly = kernel(1, READ_ONLY);
  const direct = testClient(TARGET, { user: LOGIN, max: 1, onnotice: () => {}, connection: READ_ONLY });
  const k = key('m6r14');
  try {
    assert.deepEqual((await direct`select outcome from tmpos_rate_limit.m6_rate_limit_probe(${Buffer.from(FP, 'hex')}::bytea)`).map((r) => r.outcome),
      ['store_read_only'], 'the routine says why');
    const R = createPostgresRateLimiter({ client: readOnly, keySecret: KEY });
    assert.equal(await R.probe(live()), false, 'the adapter is not ready');
    assert.deepEqual(await R.consume(req(k, 3), live()), UNAVAILABLE, 'and counts nothing');
  } finally {
    await direct.end({ timeout: 5 });
    await readOnly.end();
  }
  assert.deepEqual(await rowsOf([k]), [], 'no bucket was written');
  assert.equal(await A.probe(live()), true, 'the writable store is ready');
});

// ---------------------------------------------------------------------------
// M6R-PERF-R1: overload, the driver's own type query, and the burst account's controls
// ---------------------------------------------------------------------------

test('RLR-04: overload is fail-closed — with every reply 5 ms late, and with the client stalled past the deadline once every line is busy, the bursts lose consumes only to the deadline, a lock or statement timeout, or a lost connection; each answer is still its own decision, no later than its own deadline firing; the instances recover', async (t) => {
  // RLR-05: the production bounds these schedules run against, unchanged.
  assert.equal(LIMITER_DEADLINE_MS, 500);
  assert.equal(RATE_LIMIT_LANE_DEPTH, 64);
  assert.deepEqual({ ...RATE_LIMIT_STORE_BOUNDS }, { lock: '200ms', statement: '300ms', idle: '400ms' });
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? A : B).probe(live())));
  const instances = fourTraced();
  // Each consume is five round trips (BEGIN, the settings, the routine, COMMIT, the reset), so 5 ms on every reply puts
  // a line 30 deep well past 500 ms on any host; a stall of this process past the deadline holds every reply and timer behind it.
  for (const [label, delayMs, during] of [
    ['every reply 5 ms late', 5, undefined],
    // Once every line has a transaction outstanding at the same moment, the client stalls until past every consume's deadline.
    ['the client stalled past the deadline', 0, async ({ t0, outstanding }) => {
      while (outstanding() < instances.length) await new Promise((done) => setImmediate(done));
      busy(t0 + LIMITER_DEADLINE_MS + 50 - performance.now());
    }],
  ]) {
    const k = key(`rlr04-${delayMs}`);
    const before = await dbNowUs();
    relay.state.replyDelayMs = delayMs;
    let run;
    try {
      run = await burst(instances, Array.from({ length: 120 }, () => req(k, 40)), during);
    } finally {
      relay.state.replyDelayMs = 0;
    }
    t.diagnostic(`${label}: ${describeBurst(run)}`);
    const unavailable = run.calls.filter((c) => c.answer.outcome === 'unavailable');
    assert.ok(unavailable.length > 0, `${label}: the schedule did overload the lines`);
    const consumed = (await rowsOf([k]))[0]?.consumed ?? 0; // no row: every transaction was aborted before it committed
    assertBurst(run, 40, consumed, label);
    // assertBurst bounds every answer by its own deadline sentinel: a starved loop runs the adapter's timer late, and the
    // answer may be that late — the measured firing, not a larger deadline.
    await assertRestOfWindow(instances, k, 40, consumed, label);
    await assertOneWindow(k, 40, before, label);
    // Recovery: every instance serves a fresh bucket at once, and is ready.
    for (const [i, instance] of instances.entries()) {
      assert.deepEqual(await instance.consume(req(key(`rlr04-${delayMs}-after-${i}`), 3), live()), allowed(2), `${label}: instance ${i} recovered`);
      assert.equal(await instance.probe(live()), true);
    }
  }
});

test('RLR-06: a fresh connection sends no array-type query of its own, so a transaction ended while its first reply is withheld — by an abort, or by the limiter\'s own deadline — leaves nothing unhandled, its connection closed and no session behind, and the kernel serves again', async (t) => {
  const cases = [
    ['an abort', async (kx, hold) => {
      const controller = new AbortController();
      const tx = kx.transaction(controller.signal, RATE_LIMIT_STORE_BOUNDS, (sql) => sql`select 1 as one`);
      await within(hold.withheld, 5_000, 'the first reply withheld');
      controller.abort();
      await assert.rejects(tx, (err) => err === TransactionFailure.unavailable);
    }],
    ['the limiter\'s deadline', async (kx, hold) => {
      const X = createPostgresRateLimiter({ client: kx, keySecret: KEY });
      const [answer, ms] = await timed(() => X.consume(req(key('rlr06'), 3), live()));
      assert.deepEqual(answer, UNAVAILABLE);
      assert.ok(ms >= LIMITER_DEADLINE_MS - 1, `answered at the deadline (${Math.round(ms)} ms)`);
      await within(hold.withheld, 5_000, 'the first reply withheld');
    }],
  ];
  for (const [i, [label, end]] of cases.entries()) {
    const name = `m6r-rlr06-${RUN}-${i}`;
    const kx = kernel(1, { application_name: name });
    const hold = relay.holdFirstReply(name);
    try {
      await end(kx, hold);
      await within(hold.closed, 5_000, 'the held connection closed'); // the kernel retired the pool and the driver closed it
      await turns(); // a rejection nothing handles surfaces here, failing this test (DA-110's signature)
      assert.equal(hold.typeFetch, false, `${label}: the connection never sent the driver's array-type query`);
      t.diagnostic(`${label}: the first reply withheld, the connection closed, nothing unhandled`);
      assert.deepEqual((await kx.transaction(live(), RATE_LIMIT_STORE_BOUNDS, (sql) => sql`select 1 as one`)).map((r) => ({ ...r })), [{ one: 1 }],
        `${label}: a fresh pool serves the next transaction`);
    } finally {
      hold.cancel();
      await kx.end();
    }
    // RLR-07: what this test opened is gone — its kernel's sessions, and its connections through the relay.
    const until = performance.now() + 2_000;
    let left = -1;
    while (left !== 0 && performance.now() < until) {
      [{ n: left }] = await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_stat_activity where application_name = ${name}`;
      if (left !== 0) await sleep(10);
    }
    assert.equal(left, 0, `${label}: RLR-07 — no session of the ended kernel remains`);
  }
});

test('RLR-09: the burst account refuses what a defective adapter or store would do — an allowance for an unavailable consume, a limit answered as an allowance, an unavailable answer before the deadline, a retry, a send after the answer, a double spend, an early refusal and a store fault', async () => {
  const [inner] = fourTraced();
  // Each control is refused by the account's own assertion for that defect — not merely by some assertion.
  const defective = [
    ['an allowance for an unavailable consume', (r, s) => inner.consume(r, s).then((a) => (a.outcome === 'unavailable' ? { outcome: 'allowed', remaining: 0 } : a)),
      /answered allowed without a committed transaction|answer is exactly what its own transaction decided/],
    ['an unavailable answer before the deadline, never sent', () => Promise.resolve(UNAVAILABLE),
      /only the deadline or its transaction's failure answers unavailable/],
    ['a send after the answer', (r, s) => inner.consume(r, s).then((a) => { if (a.outcome === 'unavailable') void inner.consume(r, live()); return a; }),
      /nothing is retried or replayed|nothing is sent once its deadline has passed/],
    ['a limit answered as an allowance', (r, s) => inner.consume(r, s).then((a) => (a.outcome === 'limited' ? { outcome: 'allowed', remaining: 0 } : a)),
      /answer is exactly what its own transaction decided/],
    ['a retry of an unavailable consume', (r, s) => inner.consume(r, s).then((a) => (a.outcome === 'unavailable' ? inner.consume(r, live()) : a)),
      /nothing is retried or replayed|nothing is sent once its deadline has passed/],
  ];
  for (const [label, consume, refusal] of defective) {
    const k = key(`rlr09-${label}`);
    relay.state.replyDelayMs = 5; // 40 in one line: some answer, some reach the deadline
    let run;
    try {
      run = await burst([{ consume }], Array.from({ length: 40 }, () => req(k, 5)));
    } finally {
      relay.state.replyDelayMs = 0;
    }
    const consumed = (await rowsOf([k]))[0]?.consumed ?? 0; // no row: nothing reached the store
    assert.throws(() => assertBurst(run, 5, consumed, label), refusal, `${label}: refused`);
  }
  // Defective stores, each behind the real kernel: the first transaction runs the real routine, the rest misbehave.
  const stores = [
    ['a double spend', (sql, work) => work(sql).then(() => work(sql)), /fit one serial order/],
    // A routine that answers limited while capacity remains: the adapter's own statement gets a well-formed limited row.
    ['an early refusal', (sql, work) => work(Object.assign(async () => [{ outcome: 'limited', remaining: null, retry_after_ms: 1_000 }], { json: sql.json })),
      /refused while its cost/],
    ['a store fault', async () => { throw Object.assign(new Error('m6r: a store fault'), { code: '42P01' }); }, /not a timeout or a lost connection, but a store fault/],
  ];
  for (const [label, misbehave, refusal] of stores) {
    let first = true;
    const store = { transaction: (s, b, work) => k1.transaction(s, b, async (sql) => {
      if (first) { first = false; return work(sql); }
      return misbehave(sql, work);
    }), end: () => k1.end() };
    const X = createPostgresRateLimiter({ client: traced(store), keySecret: KEY });
    const k = key(`rlr09-${label}`);
    await X.consume(req(k, 40), live()); // the window opens on the real routine, outside the burst
    const run = await burst([X], Array.from({ length: 6 }, () => req(k, 40)));
    const [{ consumed }] = await rowsOf([k]);
    // The opening consume spent 1 outside the burst: what the burst saw was a bucket of 39.
    assert.throws(() => assertBurst(run, 39, consumed - 1, label), refusal, `${label}: refused`);
  }
});

test('RLR-10: the accounts state their own limits — more than twelve grants whose COMMIT acknowledgement was lost fails as unexplained, never passes unchecked; the burst\'s observation envelope is measured from the end of the call\'s step, which is itself capped; and an owner-side count outside its acknowledged grants plus the unacknowledged ones fails only where the snapshot shows the run\'s one window (or no row before any window could have ended) — elsewhere it is inconclusive, never a pass', () => {
  // Synthetic consumes, no database: each sent one transaction that ended as `ended` with the routine's `outcome`.
  const consume = (i, ended, outcome, remaining) => ({
    id: `rlr10:${i}`, instance: 0, cost: 1, key: 'k', start: 0, called: 0, answeredAt: 10, elapsed: 10, deadlineAt: null,
    answer: ended === 'committed' ? { outcome, ...(outcome === 'allowed' ? { remaining } : { retryAfterMs: 1_000 }) } : UNAVAILABLE,
    txs: [{ at: 1, workAt: 2, decision: outcome === 'allowed' ? { outcome, remaining } : { outcome, retryAfterMs: 1_000 }, decidedAt: 3, ended, endedAt: 4 }],
  });
  // Thirteen unacknowledged allowances: refused by name before any subset is tried.
  const lost = Array.from({ length: 13 }, (_, i) => consume(i, 'kernel_outcome_unknown', 'allowed', 39 - i));
  assert.throws(() => assertBurst({ calls: lost }, 40, 13, 'thirteen lost'), /at most twelve grants whose COMMIT acknowledgement was lost \(13\)/);
  // Twelve are checked: every subset is tried, and one that sums to the owner's count passes; none that does fails.
  assert.doesNotThrow(() => assertBurst({ calls: lost.slice(0, 12) }, 40, 5, 'twelve lost'));
  assert.throws(() => assertBurst({ calls: lost.slice(0, 12) }, 40, 13, 'twelve lost, thirteen counted'), /fit one serial order/);
  // The envelope's bounds, measured from the end of the call's step (here 17 ms after its start): a hand-over 500 ms after it
  // passes, 506 ms after it is refused; an allowance answered 506 ms after it is refused; a 150 ms step is refused.
  const timed1 = (at, answeredAt, called = 17) => {
    const c = consume(0, 'committed', 'allowed', 39);
    return { ...c, start: 0, called, answeredAt, elapsed: answeredAt, txs: [{ ...c.txs[0], at }] };
  };
  assert.doesNotThrow(() => assertBurst({ calls: [timed1(517, 520)] }, 40, 1, 'in time'));
  assert.throws(() => assertBurst({ calls: [timed1(523, 524)] }, 40, 1, 'late hand-over'), /nothing is sent once its deadline has passed/);
  assert.throws(() => assertBurst({ calls: [timed1(100, 523)] }, 40, 1, 'late answer'), /past its deadline/);
  assert.throws(() => assertBurst({ calls: [timed1(200, 210, 150)] }, 40, 1, 'long step'), /may not take/);
  // PERF's per-bucket reconciliation (M6R-PERF-R3: eligibility per bucket): known 2, unknown 1 — in a window the snapshot
  // shows to be the run's one, the owner's 2 and 3 pass and 1 and 4 fail; a window that is not shown to be the run's one is
  // inconclusive whatever the count — never a pass.
  const two = [consume(0, 'committed', 'allowed', 2), consume(1, 'committed', 'allowed', 1), consume(2, 'kernel_outcome_unknown', 'allowed', 0),
    consume(3, 'kernel_unavailable', 'allowed', 0), consume(4, 'committed', 'limited')];
  const SPAN = 60_000_000n;
  const reconcile = (owner, { startUs = 1_000n, expiresUs = startUs + SPAN, atUs = 2_000_000n, row = true, calls = two, pending = new Set() } = {}) => {
    const r = reconcileBuckets(calls, { atUs, rows: new Map(row ? [['k', { consumed: owner, startUs, expiresUs }]] : []), pending }, { before: 0n, spanUs: SPAN });
    assert.equal(r.counted, 1);
    assert.equal(r.passed + r.failed + r.inconclusive, 1);
    return r.buckets[0];
  };
  for (const [owner, result] of [[2, 'passed'], [3, 'passed'], [1, 'failed'], [4, 'failed']]) {
    const b = reconcile(owner);
    assert.deepEqual([b.result, b.eligible, b.known, b.knownGrants, b.unknown, b.unknownGrants, b.owner], [result, true, 2, 2, 1, 1, owner], `owner ${owner}`);
  }
  for (const [label, opts, reason] of [
    ['a window that opened before the run', { startUs: -1n }, /opened before this run/],
    ['a window that opened a span after the run began', { startUs: SPAN, atUs: SPAN + 1_000n }, /earlier one may have rolled/],
    ['a window ended by the snapshot', { startUs: 1_000n, expiresUs: 1_000n + SPAN, atUs: 1_000n + SPAN }, /had ended by the snapshot/],
    ['no row once a window could have ended', { row: false, atUs: SPAN }, /could have ended and been reclaimed/],
    ['a transaction still unanswered', { calls: [...two, { ...consume(5, 'committed', 'allowed', 0), txs: [{ ...consume(5, 'committed', 'allowed', 0).txs[0], ended: 'pending', endedAt: null }] }] }, /unanswered by the kernel at the snapshot/],
    ['a transaction unanswered when the snapshot was read, answered since', { pending: new Set(['rlr10:1']) }, /unanswered by the kernel at the snapshot/],
  ]) {
    for (const owner of [1, 2, 3, 4]) {
      const b = reconcile(owner, opts);
      assert.equal(b.result, 'inconclusive', `${label}, owner ${owner}: inconclusive, never passed or failed`);
      assert.match(b.inconclusive, reason, label);
      assert.equal(b.eligible, false, label);
    }
  }
  // The eligible side of each boundary: a window opened at the run's very start, or one reading short of a span after it;
  // a window expiring one reading after the snapshot; no row one reading short of a span — each still decides.
  for (const [label, opts] of [
    ['a window opened at the run\'s start', { startUs: 0n }],
    ['a window opened just short of a span after it', { startUs: SPAN - 1n, expiresUs: 2n * SPAN - 1n, atUs: SPAN }],
    ['a window expiring just after the snapshot', { startUs: 1_000n, expiresUs: 1_000n + SPAN, atUs: 1_000n + SPAN - 1n }],
  ]) {
    assert.deepEqual([reconcile(2, opts).result, reconcile(4, opts).result], ['passed', 'failed'], label);
  }
  // No row, before any window could have ended: the owner's count is zero, and two acknowledged grants do not fit it.
  assert.equal(reconcile(0, { row: false }).result, 'failed', 'no row while a window of this run was still open, after acknowledged grants');
  assert.equal(reconcile(0, { row: false, atUs: SPAN - 1n }).result, 'failed', 'no row one reading short of a span: still decided');
  // Each bucket is decided on its own: one eligible and outside its range fails while another, whose window opened before
  // the run, is inconclusive — in one call.
  const mixed = reconcileBuckets([...two, { ...consume(9, 'committed', 'allowed', 0), key: 'j' }],
    { atUs: 2_000_000n, rows: new Map([['k', { consumed: 4, startUs: 1_000n, expiresUs: 1_000n + SPAN }], ['j', { consumed: 1, startUs: -1n, expiresUs: SPAN - 1n }]]), pending: new Set() },
    { before: 0n, spanUs: SPAN });
  assert.deepEqual([mixed.counted, mixed.passed, mixed.failed, mixed.inconclusive], [2, 0, 1, 1], 'decided per bucket, never run-wide');
});

// ---------------------------------------------------------------------------
// bounded local concurrency check — not a load test
// ---------------------------------------------------------------------------

/**
 * M6R-PERF-R2, made explicit per bucket by M6R-PERF-R3: the owner-side reconciliation, and when it applies at all.
 *
 * Per bucket key, from how each transaction ended — never from the answers: the acknowledged grants (an allowance whose
 * COMMIT was acknowledged: their number and cost, `known`) and the possible ones (an allowance whose COMMIT was handed over
 * and its acknowledgement lost: `unknown`, either way). The rule: the owner-side count lies in [known, known + unknown].
 *
 * The rule applies to a bucket only when the snapshot (`snapshot.rows`, read at `snapshot.atUs` on the database clock,
 * after a bounded wait for the kernel's answers — one still unanswered then fails M6R-PERF's own assertion) shows the one
 * window this run's consumes of it fell in:
 *   * no transaction of the bucket was unanswered by the kernel just before the snapshot was read (`snapshot.pending`, the
 *     consumes', and any still unanswered now): one could yet commit;
 *   * its window opened at or after `before`, the run's start — not a window that held anything else;
 *   * its window opened before `before` + the window's span — an earlier window of this run that had rolled would have
 *     ended at or after that instant, so a window opening before it is the run's first;
 *   * its window was still open at the snapshot — not one ended, to be reset or reclaimed;
 *   * or, with no row at all, the snapshot came before any window of this run could have ended (a row is only removed
 *     once its window has).
 * Otherwise it is inconclusive, with its reason: never a pass. An eligible bucket outside the range fails.
 */
function reconcileBuckets(calls, snapshot, { before, spanUs }) {
  const ledger = new Map();
  for (const c of calls) {
    const e = ledger.get(c.key) ?? { key: c.key, known: 0, knownGrants: 0, unknown: 0, unknownGrants: 0, open: 0, consumes: 0 };
    e.consumes += 1;
    if (snapshot.pending?.has(c.id)) e.open += 1;
    for (const tx of c.txs) { // one at most (nothing is retried); every one is counted all the same
      if (tx.ended === 'pending' && !snapshot.pending?.has(c.id)) e.open += 1;
      if (tx.decision?.outcome === 'allowed' && tx.ended === 'committed') { e.known += c.cost; e.knownGrants += 1; }
      if (tx.decision?.outcome === 'allowed' && tx.ended === 'kernel_outcome_unknown') { e.unknown += c.cost; e.unknownGrants += 1; }
    }
    ledger.set(c.key, e);
  }
  const buckets = [...ledger.values()].map((e) => {
    const row = snapshot.rows.get(e.key);
    const window = row === undefined ? null
      : { openedUsAfterRunStart: Number(row.startUs - before), expiresUsAfterSnapshot: Number(row.expiresUs - snapshot.atUs) };
    const owner = row?.consumed ?? 0;
    const inconclusive = e.open > 0 ? 'a transaction of it was unanswered by the kernel at the snapshot'
      : row === undefined ? (snapshot.atUs - before >= spanUs ? 'no row, and a window of this run could have ended and been reclaimed' : null)
        : row.startUs < before ? 'its window opened before this run'
          : row.startUs - before >= spanUs ? 'its window opened a whole span after the run began: an earlier one may have rolled'
            : row.expiresUs <= snapshot.atUs ? 'its window had ended by the snapshot' : null;
    const result = inconclusive !== null ? 'inconclusive' : owner >= e.known && owner <= e.known + e.unknown ? 'passed' : 'failed';
    return { ...e, owner, window, eligible: inconclusive === null, result, ...(inconclusive === null ? {} : { inconclusive }) };
  });
  const tally = (r) => buckets.filter((b) => b.result === r).length;
  return { counted: buckets.length, passed: tally('passed'), failed: tally('failed'), inconclusive: tally('inconclusive'), buckets };
}
/**
 * M6R-PERF-R2, phases named by M6R-PERF-R3: what is established about a consume's transaction, from how the kernel answered
 * for it — never from the consume's answer, which may be unavailable for any of these:
 *   * not dispatched — nothing was handed to the kernel;
 *   * established commit — the kernel's value: COMMIT acknowledged (supervisedPgClient.ts settles a value nowhere else);
 *   * established non-commit — the body's own failure (PostgreSQL's SQLSTATE, or another), answered only once its ROLLBACK
 *     was acknowledged; or the kernel's `unavailable`, which never follows a COMMIT the server could have committed: COMMIT
 *     was never handed over — after an abort the kernel's gate checks keep it off the connection, besides its check after
 *     the body (the kernel's unit test "once COMMIT is handed over only its own outcome answers…" pins that nothing is
 *     handed over, and that an abort or close once COMMIT is on its way never answers unavailable) — or the server
 *     answered it with an error or as a rollback;
 *   * commit unknown — the kernel's outcomeUnknown: COMMIT handed over and no answer establishes what it did;
 *   * still pending — the kernel has not answered.
 * Commit status is not the server's end: `serverEndOf` says what is established about that.
 */
const establishedBy = (tx) => (tx === undefined ? 'not dispatched' : tx.ended === 'committed' ? 'established commit'
  : tx.ended === 'kernel_outcome_unknown' ? 'commit unknown' : tx.ended === 'pending' ? 'still pending' : 'established non-commit');
/**
 * M6R-PERF-R3: whether the server's own transaction is known to have ended when the kernel answered — the kernel's answer
 * settles the caller's promise, not the backend. Established by an acknowledged COMMIT, or by the body's own failure (its
 * ROLLBACK acknowledged first); not established by the kernel's `unavailable` (often an abandoned connection whose
 * backend may still be running its statement and holding its row lock until a cancel or the disconnect reaches it) or by
 * outcomeUnknown; not yet answered while pending; null when nothing was dispatched.
 */
const serverEndOf = (tx) => (tx === undefined ? null : tx.ended === 'pending' ? 'kernel not answered'
  : tx.ended === 'kernel_unavailable' || tx.ended === 'kernel_outcome_unknown' ? 'not established' : 'established');
/**
 * M6R-PERF-R2: one consume's time, in milliseconds from its call — OBSERVED: when the call's synchronous step returned (the
 * adapter's deadline is fixed inside it), when its deadline sentinel fired, when its
 * transaction was handed to the kernel, when the kernel began its work (a connection held — a fresh one's startup
 * included — and BEGIN and the settings acknowledged; those the kernel does not tell apart), when the routine answered (what
 * it decided), when the kernel answered for the transaction and how (its SQLSTATE, or the kernel's own failure — an abort
 * at the deadline is answered as the kernel's, whatever PostgreSQL was doing — unless its COMMIT was already on its way,
 * when the COMMIT's own outcome answers, or its outcome was already fixed), what that establishes (established and
 * serverEnd), and when the consume was answered; INFERRED (under `inferred`): how many consumes of its bucket on its
 * instance were in line at its call, itself included (begun, and the kernel not yet answering for their transaction — or,
 * if none was sent, not yet answered). The kernel's answer comes after the COMMIT's acknowledgement and the connection's
 * reset when it committed — at once if an abort arrives during the reset — and at once when an abort abandoned it, the
 * backend then perhaps still running (serverEnd: not established). Here "end" in a name means the kernel's answer. null is
 * unknown — never a time made up.
 */
function timelineOf(c, calls) {
  const [tx] = c.txs;
  const rel = (at) => (at === null || at === undefined ? null : Math.round(at - c.start));
  const inLine = calls.filter((o) => o.instance === c.instance && o.key === c.key && o.start <= c.start
    && (o.txs[0]?.endedAt ?? o.answeredAt ?? Infinity) > c.start).length;
  return {
    id: c.id, instance: c.instance, bucket: c.hot ? 'hot' : 'cold', callReturned: rel(c.called), deadlineFired: rel(c.deadlineAt),
    handedOver: rel(tx?.at), workBegan: rel(tx?.workAt), routineAnswered: rel(tx?.decidedAt), decided: tx?.decision === undefined ? null : tx.decision.outcome,
    kernelAnswered: rel(tx?.endedAt), endedWith: tx?.ended ?? null, established: establishedBy(tx), serverEnd: serverEndOf(tx), answered: rel(c.answeredAt), answer: c.answer.outcome,
    inferred: { inLineAtCall: inLine },
  };
}

/**
 * M6R-PERF-R3: the reconciliation in the account — how many buckets passed, failed or were inconclusive and why, then the
 * hot bucket and every bucket that did not pass (at most twelve), each in full: its window (opened after the run's start,
 * expiring after the snapshot, database clock), its consumes, its acknowledged and possible grants, the owner's count.
 */
function reconciliationLine({ snapshotUsAfterRunStart, reconciliation: r }, hot) {
  const full = ({ key: k, ...b }) => ({ bucket: k === hot ? 'hot' : `cold ${k.slice(0, 8)}`, ...b });
  const notPassed = r.buckets.filter((b) => b.result !== 'passed');
  const reasons = {};
  for (const b of notPassed) if (b.inconclusive !== undefined) reasons[b.inconclusive] = (reasons[b.inconclusive] ?? 0) + 1;
  return {
    snapshotUsAfterRunStart, counted: r.counted, passed: r.passed, failed: r.failed, inconclusive: r.inconclusive, reasons,
    hot: r.buckets.filter((b) => b.key === hot).map(full)[0] ?? null,
    notPassed: notPassed.slice(0, 12).map(full), ...(notPassed.length > 12 ? { notPassedNotShown: notPassed.length - 12 } : {}),
  };
}
/**
 * M6R-PERF-R2: M6R-PERF's account, one line — the answers by class, this process's event-loop delay, the deadline timers'
 * lateness, the time split into waiting in line, hand-over to the kernel's work, the routine, and the routine's answer to
 * the kernel's answer; what is established about every transaction and about the server's end of it (M6R-PERF-R3), and
 * whether the probe login's backends went quiet; connections closed; the reclaims; the per-bucket reconciliation (passed,
 * failed, or inconclusive and why: M6R-PERF-R3); transactions the kernel had not answered for within 3 s; and the hot
 * bucket's window — then the consumes answered unavailable or whose transaction failed, at most twelve, each in full.
 */
async function perfAccount(t, { calls, loop, closesBefore, before, hot, account }) {
  const sent = calls.filter((c) => c.txs.length > 0);
  const spans = (pick) => {
    const v = sent.map(pick).filter((x) => x !== null).sort((x, y) => x - y);
    return v.length === 0 ? null : { p50: Math.round(percentile(v, 0.5)), p95: Math.round(percentile(v, 0.95)), max: Math.round(v.at(-1)) };
  };
  const byClass = {};
  for (const c of calls) {
    const [tx] = c.txs;
    const k = c.answer.outcome !== 'unavailable' ? c.answer.outcome
      : tx === undefined ? 'unavailable: deadline before it was sent' : `unavailable: transaction ${tx.ended}${tx.ended === 'committed' ? ` (${tx.decision?.outcome}) after the deadline` : ''}`;
    byClass[k] = (byClass[k] ?? 0) + 1;
  }
  const [hotRow] = await rowsOf([hot]);
  const failing = calls.filter((c) => c.answer.outcome === 'unavailable' || (c.txs[0] !== undefined && c.txs[0].ended !== 'committed'));
  const lateness = calls.filter((c) => c.deadlineAt !== null).map((c) => c.deadlineAt - c.start - LIMITER_DEADLINE_MS);
  t.diagnostic(`M6R-PERF account: ${JSON.stringify({
    classes: byClass,
    eventLoopDelayMs: { max: Math.round(loop.max / 1e6), p99: Math.round(loop.percentile(99) / 1e6) },
    deadlineTimerLateMaxMs: lateness.length > 0 ? Math.round(Math.max(...lateness)) : null,
    waitedToHandOverMs: { hot: spans((c) => (c.hot ? c.txs[0].at - c.start : null)), cold: spans((c) => (c.hot ? null : c.txs[0].at - c.start)) },
    handOverToWorkMs: {
      hot: spans((c) => (c.hot && c.txs[0].workAt !== null ? c.txs[0].workAt - c.txs[0].at : null)),
      cold: spans((c) => (!c.hot && c.txs[0].workAt !== null ? c.txs[0].workAt - c.txs[0].at : null)),
    },
    routineMs: {
      hot: spans((c) => (c.hot && c.txs[0].decidedAt !== null ? c.txs[0].decidedAt - c.txs[0].workAt : null)),
      cold: spans((c) => (!c.hot && c.txs[0].decidedAt !== null ? c.txs[0].decidedAt - c.txs[0].workAt : null)),
    },
    routineAnswerToEndMs: spans((c) => (c.txs[0].decidedAt !== null && c.txs[0].endedAt !== null ? c.txs[0].endedAt - c.txs[0].decidedAt : null)),
    established: Object.fromEntries(['not dispatched', 'established commit', 'established non-commit', 'commit unknown', 'still pending']
      .map((e) => [e, calls.filter((c) => establishedBy(c.txs[0]) === e).length])),
    serverEnd: Object.fromEntries(['established', 'not established', 'kernel not answered']
      .map((e) => [e, calls.filter((c) => serverEndOf(c.txs[0]) === e).length])),
    backendQuiet: account.backendQuiet,
    connectionsClosed: relay.state.closes - closesBefore,
    reclaims: { started: reclaims.started, longestMs: Math.round(reclaims.longestMs) },
    buckets: reconciliationLine(account, hot),
    unansweredByKernelIn3s: account.lateOrOpen, untracedAnswers: account.untraced,
    hotWindow: hotRow === undefined ? null : {
      openedMsAfterRunStart: Math.round(Number(BigInt(hotRow.start_us) - before) / 1000),
      spanMs: Number(BigInt(hotRow.expires_us) - BigInt(hotRow.start_us)) / 1000, consumed: hotRow.consumed,
    },
  })}`);
  // The consumes answered unavailable or whose transaction failed, at most twelve, each in full.
  for (const c of failing.slice(0, 12)) t.diagnostic(`M6R-PERF consume: ${JSON.stringify(timelineOf(c, calls))}`);
  if (failing.length > 12) t.diagnostic(`M6R-PERF consume: ${failing.length - 12} more not shown`);
}

test('M6R-PERF: 2000 consumes at concurrency 32 over two instances, hot and cold buckets — exact accounting and nothing unavailable', async (t) => {
  const CONCURRENCY = 32;
  const CONSUMES = 2_000;
  const KERNEL_MAX = 6;
  const HOT_LIMIT = 500;
  const COLD_KEYS = 400;
  const COLD_LIMIT = 3;
  const WINDOW = 60_000; // no window closes mid-run; every bucket is deleted afterwards
  const hot = key('perf-hot');
  const cold = Array.from({ length: COLD_KEYS }, (_, i) => key(`perf-cold-${i}`));
  const plan = Array.from({ length: CONSUMES }, (_, i) => (i % 10 < 3 ? { k: hot, limit: HOT_LIMIT } : { k: cold[(i * 7) % COLD_KEYS], limit: COLD_LIMIT }));
  const answers = new Array(CONSUMES);
  const latencies = new Array(CONSUMES);
  let next = 0;
  faults.length = 0;
  Object.assign(reclaims, { started: 0, maxInFlight: 0, faults: [], longestMs: 0 });
  // M6R-PERF-R2: the same two production adapters over the same two kernels, observed as Aobs's and Bobs's are and traced
  // too, so each consume is tied to the one transaction it sent (the async context its call inherits); each consume has a
  // deadline sentinel of its own, set just before the call as a burst's are; and this process's event-loop delay is sampled
  // throughout. The workload, the owner-side snapshot and the original assertions are as they were: R2's account is taken
  // after that snapshot, printed before those assertions, and checked after them.
  const [Bperf, Aperf] = [k2, k1].map((k) => createPostgresRateLimiter({ client: traced(observed(k)), keySecret: KEY }));
  const calls = new Array(CONSUMES);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const closesBefore = relay.state.closes;
  const before = await dbNowUs();
  const open = () => calls.filter((c) => c !== undefined && (sentBy.get(c.id) ?? []).some((tx) => tx.ended === 'pending')).length;
  try {
    loop.enable();
    const [, duration] = await timed(() => Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
      const instance = w % 2 ? Aperf : Bperf;
      while (next < CONSUMES) {
        const i = next++;
        const call = { id: `perf:${RUN}:${i}`, instance: w % 2, key: plan[i].k, hot: plan[i].k === hot, start: performance.now(), called: null, deadlineAt: null, answeredAt: null };
        calls[i] = call;
        const sentinel = setTimeout(() => { call.deadlineAt = performance.now(); }, LIMITER_DEADLINE_MS);
        const [answer, took] = await timed(() => consumeContext.run(call.id, () => {
          const pending = instance.consume(req(plan[i].k, plan[i].limit, WINDOW), live());
          call.called = performance.now();
          return pending;
        }));
        call.answeredAt = performance.now();
        clearTimeout(sentinel);
        answers[i] = answer;
        latencies[i] = took;
      }
    })));
    loop.disable();
    await settle(); // the background reclaims the run started end before they are counted
    // Exact accounting, per bucket: min(calls, limit) allowed, each at its own count, the rest limited, and the owner-side
    // count equal to what was granted.
    const expected = new Map();
    plan.forEach(({ k, limit }, i) => {
      const e = expected.get(k) ?? { limit, calls: 0, granted: [] };
      e.calls += 1;
      if (answers[i].outcome === 'allowed') e.granted.push(answers[i].remaining);
      expected.set(k, e);
    });
    const consumed = new Map((await owner`select limiter_key, consumed from tmpos_rate_limit.bucket
      where limiter_key = any (${[...expected.keys()]}::text[])`).map((r) => [r.limiter_key, r.consumed]));
    let exact = true;
    // Fail-closed, whatever the timing: no bucket granted past its limit or twice at one count, and the owner-side count
    // never below what was granted (above it only by consumes whose answer was lost to the deadline).
    let overAllowed = 0;
    let underCounted = 0;
    for (const [k, e] of expected) {
      const n = Math.min(e.calls, e.limit);
      const counts = [...e.granted].sort((x, y) => x - y);
      exact &&= counts.length === n && counts.every((r, i) => r === e.limit - n + i) && consumed.get(k) === n;
      if (counts.length > e.limit || new Set(counts).size !== counts.length) overAllowed += 1;
      if ((consumed.get(k) ?? 0) < counts.length) underCounted += 1;
    }
    const tally = (o) => answers.filter((a) => a.outcome === o).length;
    const sorted = [...latencies].sort((x, y) => x - y);
    const faultCounts = Object.fromEntries([...new Set(faults)].map((f) => [f, faults.filter((x) => x === f).length]));
    const [{ version }] = await owner`select pg_catalog.current_setting('server_version') as version`;
    const report = {
      postgres: version, target: cluster ? 'local disposable cluster (socket, fsync off)' : 'supplied disposable target',
      concurrency: CONCURRENCY, instances: 2, kernelMaxEach: KERNEL_MAX, effectiveInFlightTransactions: 2 * KERNEL_MAX,
      consumes: CONSUMES, hotConsumes: plan.filter((p) => p.k === hot).length, hotLimit: HOT_LIMIT, coldKeys: COLD_KEYS, coldLimit: COLD_LIMIT,
      durationMs: Math.round(duration), throughputPerSec: Math.round(CONSUMES / (duration / 1000)),
      latencyMs: { p50: +percentile(sorted, 0.5).toFixed(2), p95: +percentile(sorted, 0.95).toFixed(2), p99: +percentile(sorted, 0.99).toFixed(2), max: +sorted.at(-1).toFixed(2) },
      allowed: tally('allowed'), limited: tally('limited'), unavailable: tally('unavailable'),
      databaseErrors: faults.length, faults: faultCounts, exactAccounting: exact, overAllowedBuckets: overAllowed, underCountedBuckets: underCounted,
      backgroundReclaims: { started: reclaims.started, maxInFlightPerInstance: reclaims.maxInFlight, failed: reclaims.faults.length },
    };
    t.diagnostic(JSON.stringify(report));
    if (process.env.M6R_PERF_OUT) writeFileSync(`${REPO}.workflow/scratch/m6r/perf.json`, `${JSON.stringify(report, null, 2)}\n`);

    // M6R-PERF-R2, after the original snapshot above and changing nothing in it: the kernel answers for every transaction a
    // consume sent — a COMMIT still on its way when its consume was answered is answered later — within 3 s of the last
    // answer (bounded: never a hang); then (M6R-PERF-R3) the server's own quiet for the probe login, reported, not assumed
    // from those answers; then a second owner-side snapshot, for the reconciliation alone; then the account, printed before
    // the original assertions. A fault in any of it is held, not thrown, so it can never mask them, and fails after them.
    let account;
    try {
      const endBy = Math.max(...calls.map((c) => c.answeredAt)) + 3_000;
      while (open() > 0 && performance.now() < endBy) await sleep(5);
      calls.forEach((c, i) => { c.answer = answers[i]; c.txs = sentBy.get(c.id) ?? []; });
      const backendQuiet = await settle();
      // M6R-PERF-R3: the second snapshot reads each bucket's window with its count, and the database clock in the same
      // statement, so whether the reconciliation applies is decided per bucket (reconcileBuckets), not assumed; the consumes
      // whose transaction the kernel had not answered for are taken just before it is read.
      const pending = new Set(calls.filter((c) => c.txs.some((tx) => tx.ended === 'pending')).map((c) => c.id));
      const after = await owner`select b.limiter_key, b.consumed,
          (extract(epoch from b.window_start) * 1000000)::bigint::text as start_us, (extract(epoch from b.expires_at) * 1000000)::bigint::text as expires_us,
          (extract(epoch from pg_catalog.statement_timestamp()) * 1000000)::bigint::text as at_us
        from tmpos_rate_limit.bucket b where b.limiter_key = any (${[...expected.keys()]}::text[])`;
      const snapshot = {
        atUs: after.length > 0 ? BigInt(after[0].at_us) : await dbNowUs(),
        rows: new Map(after.map((r) => [r.limiter_key, { consumed: r.consumed, startUs: BigInt(r.start_us), expiresUs: BigInt(r.expires_us) }])),
        pending,
      };
      assert.equal(snapshot.rows.size, after.length, 'one bucket row per key: each key is used with one limit and window');
      assert.equal(new Set(calls.map((c) => c.key)).size, expected.size, 'every planned bucket is in the reconciliation');
      account = {
        lateOrOpen: calls.flatMap((c) => c.txs).filter((tx) => tx.endedAt === null || tx.endedAt > endBy).length,
        untraced: calls.filter((c) => c.answer.outcome !== 'unavailable' && c.txs.length === 0).length,
        snapshotUsAfterRunStart: Number(snapshot.atUs - before), backendQuiet,
        reconciliation: reconcileBuckets(calls.map((c) => ({ ...c, cost: 1 })), snapshot, { before, spanUs: BigInt(WINDOW) * 1000n }),
      };
      await perfAccount(t, { calls, loop, closesBefore, before, hot, account });
    } catch (err) {
      account = { error: String(err?.message ?? err) };
      t.diagnostic(`M6R-PERF account: could not be computed — ${account.error}`);
    }
    assert.deepEqual([overAllowed, underCounted], [0, 0], 'fail-closed: never over-allowed, never under-counted');
    assert.equal(report.unavailable, 0, 'nothing unavailable');
    assert.equal(report.databaseErrors, 0, 'no transaction failed');
    assert.equal(exact, true, 'exact accounting on every bucket');
    assert.equal(report.allowed + report.limited, CONSUMES);
    // M6R-PERF-R2: the account was computed; every allowance or limit was traced to its own transaction; every transaction
    // ended within 3 s of the last answer (the kernel answered for it: client-side settlement, not the server's own end);
    // and every bucket the reconciliation applies to (M6R-PERF-R3: decided per bucket — the rest are reported above as
    // inconclusive, with why, and are not a pass) has the count its acknowledged COMMITs granted, plus at most the
    // allowances whose acknowledgement was lost.
    assert.equal(account.error, undefined, 'the M6R-PERF account was computed');
    assert.equal(account.untraced, 0, 'every allowance or limit was traced to its own transaction');
    assert.equal(account.lateOrOpen, 0, 'the kernel answered for every transaction M6R-PERF sent within 3 s of the last answer');
    assert.equal(account.reconciliation.failed, 0, 'every eligible owner-side count lies between its acknowledged grants and those plus the unacknowledged ones');
    // And the check ran: with every transaction answered and the snapshot inside one window's span of the run's start, no
    // bucket can be ineligible — so an eligibility rule broken into refusing every bucket fails here, not silently.
    if (account.lateOrOpen === 0 && account.snapshotUsAfterRunStart < WINDOW * 1_000) {
      assert.equal(account.reconciliation.inconclusive, 0, 'inside one window\'s span with every transaction answered, every bucket was eligible for the reconciliation');
    }
  } finally {
    loop.disable();
    for (const c of calls) if (c !== undefined) sentBy.delete(c.id);
    await owner`delete from tmpos_rate_limit.bucket where limiter_key = any (${[hot, ...cold]}::text[])`;
  }
});
