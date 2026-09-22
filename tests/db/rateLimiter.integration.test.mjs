// Phase 4.0 M6-RATE-P2 — the PostgreSQL distributed rate limiter against REAL PostgreSQL: migration 014 (schema
// tmpos_rate_limit — the bucket table, the one-row key-fingerprint table, the key check and the consume, probe and reclaim
// routines) observed from the owner and from the runtime's own non-owner LOGIN, and the production adapter
// createPostgresRateLimiter over the same supervised transaction kernel the composition root builds.
//
// WHAT IS PROVED HERE. 001-014 apply through the trusted engine; 014 is exactly the objects it declares — four routines as
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
//     with, so a timeout can be shown to be PostgreSQL's (55P03, 57014) rather than the adapter's own deadline.
//
// DISPOSABLE ONLY. The target is TM_POS_TEST_DATABASE_URL when CI binds one, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. Keys, buckets and the probe login are
// synthetic, so the suite re-runs on the shared CI service: the ledger is read rather than this run's report, every
// rollback and re-application runs inside one owner transaction that is rolled back, every seeded or long-window bucket is
// deleted by the test that made it, and a test that empties the fingerprint table re-registers the canonical test key
// (32 bytes of 0x07) before it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as netConnect } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
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

const ambient = process.env.TM_POS_TEST_DATABASE_URL;
let cluster = null;
let TARGET_DSN = null;
let CLIENT_OPTS = {};

if (typeof ambient === 'string' && ambient.trim() !== '') {
  TARGET_DSN = ambient.trim();
  const target = new URL(TARGET_DSN);
  const socketDir = target.hostname === '' ? target.searchParams.get('host') : null;
  if (socketDir !== null) {
    const user = target.searchParams.get('user');
    CLIENT_OPTS = { host: socketDir, ...(user !== null ? { user } : {}) };
  }
} else if (localPostgresAvailable()) {
  cluster = startDisposablePostgres();
  TARGET_DSN = cluster.dsn;
  CLIENT_OPTS = cluster.clientOptions;
} else {
  throw new Error('M6R INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. Docker and remote databases are not substitutes.');
}

// VALIDATE BEFORE TOUCHING ANYTHING: the setup below issues cluster-wide DDL (CREATE ROLE).
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** `host`/`user` travel in client options, never the URL; a named role REPLACES the userinfo. */
function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}
const connect = (user, max) =>
  postgres(driverDsn(TARGET_DSN, user), { ...CLIENT_OPTS, ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, seeds and observes, holds locks. RLS does not restrict it. */
const owner = connect(undefined, 2);

// ---------------------------------------------------------------------------
// the relay: the kernels' only way to the server
// ---------------------------------------------------------------------------

function startRelay() {
  const u = new URL(TARGET_DSN);
  const upstream = CLIENT_OPTS.host ? { path: join(CLIENT_OPTS.host, `.s.PGSQL.${u.port || 5432}`) } : { host: u.hostname, port: Number(u.port || 5432) };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m6r-relay-'));
  const pairs = new Set();
  // closes: the connections through this relay the driver has finished closing, as kernel() counts them.
  const state = { closes: 0, pairs };
  const server = createServer((client) => {
    const db = netConnect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); } };
    pairs.add(pair);
    client.pipe(db);
    db.pipe(client);
    for (const socket of [client, db]) { socket.on('error', pair.cut); socket.on('close', pair.cut); }
  });
  const path = join(dir, '.s.PGSQL.5432');
  const listen = () => new Promise((done) => server.listen(path, done));
  // No listener, so every new connection is refused; settles once every open pair has closed.
  const refuse = () => (server.listening ? new Promise((done) => server.close(done)) : Promise.resolve());
  return {
    dir, state, refuse, listening: listen(),
    restore: async () => { if (!server.listening) await listen(); },
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
 */
function kernel(max = 6, session = {}) {
  const options = runtimeClientOptions(TARGET_DSN);
  const k = createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, LOGIN), {
    ...options, connection: { ...options.connection, ...session }, ssl: false, max, idle_timeout: 0,
    onclose: () => { relay.state.closes += 1; }, host: relay.dir, port: 5432, user: LOGIN,
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
/** The adapter's other transactions (the out-of-band reclaim): how many began, the most in flight at once per kernel, their failures. */
const reclaims = { started: 0, maxInFlight: 0, faults: [] };
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
      return k.transaction(signal, bounds, work).catch((err) => { reclaims.faults.push(faultOf(err)); throw err; }).finally(() => { inFlight -= 1; });
    },
    end: () => k.end(),
  });
};
/**
 * Lets an out-of-band reclaim that a window-opening consume started finish before a snapshot: a moment for it to begin,
 * then until no session of the probe login is inside a transaction for three samples running (at most 2 s).
 */
async function settle() {
  await sleep(50);
  const stop = performance.now() + 2_000;
  for (let quiet = 0; quiet < 3 && performance.now() < stop; await sleep(10)) {
    const [{ n }] = await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_stat_activity where usename = ${LOGIN} and xact_start is not null`;
    quiet = n === 0 ? quiet + 1 : 0;
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
// setup: the real chain 001-014, a non-owner LOGIN holding only tmpos_app, two kernels, the real adapter
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

test('M6R-01: 001-014 apply clean; 014 is exactly its declared objects and privileges, holds no identifying column, and creates no role', async () => {
  // The LEDGER, not this run's report: on the shared CI service an earlier suite may already have applied the chain.
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014'].map((v) => [v, false]));

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

test('M6R-03: 120 concurrent consumes of one bucket over four instances on both kernels grant exactly the limit, once per count; mixed costs never overrun', async (t) => {
  // Every pool open first, so the burst measures the store, not twelve connection handshakes.
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? A : B).probe(live())));
  // One instance holds at most RATE_LIMIT_LANE_DEPTH consumes of one bucket in line and refuses the rest at once (M6R-13),
  // so 120 at once are spread over four instances, two per kernel: 30 in each line, none refused at the door. The limit is
  // 40, not more, because every allowance waits for its own WAL flush while it holds the row: with durable commits (CI's
  // stock server) one bucket grants roughly a hundred in the 500 ms deadline, and this proves exactness, not throughput.
  const instances = [Aobs, Bobs, createPostgresRateLimiter({ client: k1obs, keySecret: KEY }), createPostgresRateLimiter({ client: observed(k2), keySecret: KEY })];
  assert.ok(120 / instances.length < RATE_LIMIT_LANE_DEPTH);
  const hot = key('m6r03-hot');
  faults.length = 0;
  const [burst, ms] = await timed(() => Promise.all(Array.from({ length: 120 }, (_, i) => instances[i % 4].consume(req(hot, 40), live()))));
  const lost = burst.filter((o) => o.outcome === 'unavailable').length;
  t.diagnostic(`120 concurrent consumes of one bucket (limit 40) over 4 instances on 2 kernels x 6 connections: ${Math.round(ms)} ms, ${lost} unavailable ${JSON.stringify(faults)}`);
  const granted = burst.filter((o) => o.outcome === 'allowed').map((o) => o.remaining).sort((x, y) => x - y);
  assert.deepEqual(granted, Array.from({ length: 40 }, (_, i) => i), 'exactly 40 allowed, each at its own count 39..0');
  assert.equal(lost, 0, `none unavailable — ${lost} outlived LIMITER_DEADLINE_MS queued behind this one bucket (the burst took ${Math.round(ms)} ms)`);
  const limited = burst.filter((o) => o.outcome === 'limited');
  assert.equal(limited.length, 80, 'every other consume is limited');
  assert.ok(limited.every((o) => Number.isSafeInteger(o.retryAfterMs) && o.retryAfterMs >= 1 && o.retryAfterMs <= 6_000));
  assert.deepEqual((await rowsOf([hot])).map((r) => [r.consumed, r.limit_count]), [[40, 40]], 'the owner sees exactly the limit consumed');

  const mixedKey = key('m6r03-mixed');
  const costs = Array.from({ length: 200 }, (_, i) => [1, 2, 3, 5, 7][i % 5]);
  const mixed = await Promise.all(costs.map((cost, i) => instances[i % 4].consume(req(mixedKey, 100, 6_000, cost), live())));
  assert.ok(mixed.every((o) => o.outcome === 'allowed' || o.outcome === 'limited'), 'every consume is an allowance or a limit');
  // A serial order exists: sorted by what each grant left, every step down is exactly that grant's cost.
  const grants = costs.map((cost, i) => ({ cost, o: mixed[i] })).filter((g) => g.o.outcome === 'allowed').sort((x, y) => y.o.remaining - x.o.remaining);
  let left = 100;
  for (const g of grants) {
    left -= g.cost;
    assert.equal(g.o.remaining, left, 'each grant leaves exactly the limit minus every grant before it');
  }
  const spent = 100 - left;
  costs.forEach((cost, i) => { if (mixed[i].outcome === 'limited') assert.ok(spent + cost > 100, 'no consume is limited while its cost still fits'); });
  assert.deepEqual((await rowsOf([mixedKey])).map((r) => r.consumed), [spent], 'the owner-side count is the sum of the granted costs');
  t.diagnostic(`mixed costs: ${grants.length} grants spending ${spent} of 100, ${costs.length - grants.length} limited`);
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
  assert.equal(ledger.length, 14);
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
  const direct = postgres(driverDsn(TARGET_DSN, LOGIN), { ...CLIENT_OPTS, user: LOGIN, max: 1, onnotice: () => {}, connection: READ_ONLY });
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
// bounded local concurrency check — not a load test
// ---------------------------------------------------------------------------

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
  Object.assign(reclaims, { started: 0, maxInFlight: 0, faults: [] });
  try {
    const [, duration] = await timed(() => Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
      const instance = w % 2 ? Aobs : Bobs;
      while (next < CONSUMES) {
        const i = next++;
        const [answer, took] = await timed(() => instance.consume(req(plan[i].k, plan[i].limit, WINDOW), live()));
        answers[i] = answer;
        latencies[i] = took;
      }
    })));
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
      postgres: version, target: cluster ? 'local disposable cluster (socket, fsync off)' : 'TM_POS_TEST_DATABASE_URL',
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
    assert.deepEqual([overAllowed, underCounted], [0, 0], 'fail-closed: never over-allowed, never under-counted');
    assert.equal(report.unavailable, 0, 'nothing unavailable');
    assert.equal(report.databaseErrors, 0, 'no transaction failed');
    assert.equal(exact, true, 'exact accounting on every bucket');
    assert.equal(report.allowed + report.limited, CONSUMES);
  } finally {
    await owner`delete from tmpos_rate_limit.bucket where limiter_key = any (${[hot, ...cold]}::text[])`;
  }
});
