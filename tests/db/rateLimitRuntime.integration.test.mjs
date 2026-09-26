// Phase 4.0 M6-RATE-P2 — THE DISTRIBUTED RATE LIMITER, END TO END: the PostgreSQL limiter over migration 014, bound by the
// production composition, served by REAL composed runtimes on REAL loopback sockets over a disposable PostgreSQL.
//
// WHAT IS COMPOSED HERE IS PRODUCTION'S. Every runtime instance is composed on its own, as an entry would compose it: the
// transaction root is assembleTransactions over PRODUCTION_INVENTORY and a configured environment with the factories
// production ships — the M6 transactional store, 011's session store and tenant admission, 012's directory, 013's platform
// admission and 014's rate limiter — each instance over its OWN supervised kernel; the session root is assembleSessions
// over durableSessionAdapters with the transaction root's limiter binding, bound to the RATE_LIMIT_KEY bytes parsed from
// that same environment — the table composeProductionSessions assembles, which needs a provider configuration only for the
// verifier substituted below (M6RS-00 shows that root binds the same limiter); createApp serves the result through
// createBoundedServer on 127.0.0.1. The limiter every request meets is the PostgreSQL adapter — never the testkit's.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY. Two things, neither of them on the path under test:
//   * THE DATABASE CLIENT. The client factory is handed the classified endpoint of a synthetic direct URL (it only has to
//     pass classification) and returns instead a supervised kernel of four one-connection pools over the disposable
//     cluster, as a non-owner runtime LOGIN holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay
//     on a task-owned socket — so the store can be taken down the way a stopping server goes (the relay refuses new
//     connections and the server ends every runtime session) without touching the cluster.
//   * THE IDENTITY VERIFIER. A disposable cluster has no identity provider, so a bearer token maps to a synthetic provider
//     reference, authenticated now with a TOTP second factor; any other token is refused. The synthetic principals hold no
//     identity in the database, so a verified login is refused by admission (401) — after the account limit is spent.
// Client addresses are real socket peers: the trusted proxy is 127.0.0.2/32, and a proxied request leaves from 127.0.0.2
// carrying X-Forwarded-For with a synthetic client (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32); an
// untrusted direct client leaves from its own 127.a.b.c loopback address (Linux routes all of 127.0.0.0/8 to lo).
//
// WHAT IS PROVED (M6RS-NN is item NN of the stage brief's real-socket evidence; M6RS-00 is the composition itself). Two
// separately composed runtimes share every bucket, so an allowance through one is gone from the other and concurrent traffic
// split across both is admitted EXACTLY up to the production policy; the next request is a 429 whose Retry-After is the
// whole seconds left in a window that refused requests never extend; clients, namespaces and the client and account
// dimensions are isolated; a spoofed left-hand X-Forwarded-For prefix, or X-Forwarded-For from an untrusted peer, escapes
// nothing. With the store down every protected request is a bounded 503 — no local allowance, no cached verdict — while
// /health stays 200 and /readiness is 503; recovery resumes the durable counts and replays nothing; replacing an instance
// resets nothing; and an instance keyed with another RATE_LIMIT_KEY is refused (503, readiness 503) without writing a
// bucket or a fingerprint, while the first keeps enforcing.
//
// DISPOSABLE ONLY. The target is TM_POS_TEST_DATABASE_URL when CI binds one, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. The runtime key is the canonical test key
// (32 bytes of 0x07), so the fingerprint 014 registers is the one every suite on a shared database expects; the second key
// (32 bytes of 0x08) is never registered. Every principal is random per run, and every client address is random and holds no
// bucket in the store when it is picked, so the suite re-runs on a shared service inside an earlier run's windows; the
// production policies are used unchanged (RATE_LIMITS), and no test waits out a window.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';
import { createPostgresRateLimiter, rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { createPostgresSessionStore } from '../../server/persistence/postgresSessionStore.ts';
import { createPostgresTenantAdmission } from '../../server/persistence/postgresTenantAdmission.ts';
import { createPostgresTenantDirectory } from '../../server/persistence/postgresTenantDirectory.ts';
import { createPostgresTransactionalStore } from '../../server/persistence/postgresTransactionalStore.ts';
import { PRODUCTION_INVENTORY, assembleTransactions } from '../../server/composition/productionTransactions.ts';
import {
  ProductionCompositionError, assembleSessions, composeProductionSessions, durableSessionAdapters,
} from '../../server/composition/productionSessions.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { limiterSubjectOf, parseAddress } from '../../server/runtime/clientAddress.ts';
import { RATE_LIMITS, createLimiterKeyring, parseRateLimitKey } from '../../server/runtime/rateLimit.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';
import { TENANT_DISPLAY_NAME_EVENTS } from '../../server/runtime/tenantDisplayName.ts';
import { TENANT_STATUS_EVENTS } from '../../server/runtime/tenantStatus.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm6rs-migrator', runtimeRef: 'm6rs-runtime' };
const LOCK_KEY = 528_514;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m6rs_probe';
const ORIGIN = Object.freeze({ tenant: 'http://pos.trusted.test', admin: 'http://admin.trusted.test' });
const ORIGINS = Object.freeze({ tenant: Object.freeze([ORIGIN.tenant]), admin: Object.freeze([ORIGIN.admin]) });
const PROXY = '127.0.0.2';
const TRUSTED_PROXIES = Object.freeze([`${PROXY}/32`]);
/** app.ts PROBE_REUSE_MS (1 s, not exported) and a margin: a readiness probe is reused for that long. */
const PROBE_REUSE_WAIT_MS = 1_100;
const EVENTS = Object.freeze([...TENANT_DISPLAY_NAME_EVENTS, ...TENANT_STATUS_EVENTS]);
const LOGIN_CLIENT = RATE_LIMITS.loginClient; // 10 per 60 s
const LOGIN_ACCOUNT = RATE_LIMITS.loginAccount; // 5 per 5 min
const REQUEST = RATE_LIMITS.request; // 300 per 60 s
const signal = () => AbortSignal.timeout(10_000);

/** The canonical test key every suite reaching 014 uses, and a second key that must never be registered. */
const CANONICAL_KEY = Buffer.alloc(32, 7);
const SECOND_KEY = Buffer.alloc(32, 8);
// The configuration the transaction root reads. Synthetic: the URL only has to classify as a direct endpoint on 5432, and
// the client factory below never connects to it.
const CONFIGURED_ENV = Object.freeze({
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  IDEMPOTENCY_KEY: Buffer.alloc(32, 9).toString('base64url'),
  RATE_LIMIT_KEY: CANONICAL_KEY.toString('base64url'),
});

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
  throw new Error(
    'M6RS INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
    'Docker and remote databases are not substitutes.',
  );
}

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** `host`/`user` travel in client options, never the URL; a named role REPLACES the userinfo. */
function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}

/** The owner: applies the migrations, creates the runtime login and observes the store. RLS does not restrict it. */
const owner = postgres(driverDsn(TARGET_DSN), { ...CLIENT_OPTS, max: 2, onnotice: () => {} });

// ---------------------------------------------------------------------------
// the relay: every runtime kernel's only way to the server
// ---------------------------------------------------------------------------

function startRelay() {
  const u = new URL(TARGET_DSN);
  const upstream = CLIENT_OPTS.host
    ? { path: join(CLIENT_OPTS.host, `.s.PGSQL.${u.port || 5432}`) }
    : { host: u.hostname, port: Number(u.port || 5432) };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m6rs-relay-'));
  const pairs = new Set();
  // closes: the connections through this relay that a driver has finished closing, as the kernels count them.
  const state = { closes: 0, pairs };
  const server = createServer((client) => {
    client.on('error', () => {});
    const db = connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); } };
    pairs.add(pair);
    client.on('data', (chunk) => db.write(chunk));
    db.on('data', (chunk) => client.write(chunk));
    for (const socket of [client, db]) {
      socket.on('error', pair.cut);
      socket.on('close', pair.cut);
    }
  });
  const path = join(dir, '.s.PGSQL.5432');
  const listen = () => new Promise((done) => server.listen(path, done));
  // No listener, so every new connection is refused; settles once every open pair has closed.
  const refuse = () => (server.listening ? new Promise((done) => server.close(done)) : Promise.resolve());
  return {
    dir,
    listening: listen(),
    state,
    refuse,
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

/**
 * The store goes down the way a server does: the relay refuses new connections and the server ends every runtime
 * session. It returns only once every kernel has closed every connection it held through the relay, so no request meets
 * a half-closed connection (doc 08, DA-15) — every request after this finds the store simply unreachable.
 */
async function storeDown() {
  const open = relay.state.pairs.size;
  const closedBefore = relay.state.closes;
  const drained = relay.refuse();
  await owner`select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`;
  const deadline = Date.now() + 5_000;
  while (relay.state.closes - closedBefore < open) {
    if (Date.now() > deadline) throw new Error('the runtime sessions did not end within 5 s');
    await delay(5);
  }
  await drained;
}

// ---------------------------------------------------------------------------
// setup: real migrations 001-015 and a real non-owner runtime login
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

{
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const report = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
    assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 400));
  } finally {
    await handle.dispose();
  }
}

await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);

// ---------------------------------------------------------------------------
// the composed runtimes
// ---------------------------------------------------------------------------

/** Bearer token -> provider uid, for every synthetic principal this file verifies. */
const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(view) {
    const uid = TOKENS.get(view.bearerToken);
    return uid === undefined ? null : { verified: true, authProvider: 'firebase', authProviderUid: uid, authenticatedAt: Date.now(), secondFactor: 'totp' };
  },
});
/** A synthetic principal with no identity in the database: verified, then refused by admission. */
function principal(label) {
  const uid = `m6rs-${label}-${SUFFIX}`;
  TOKENS.set(`tok-${uid}`, uid);
  return { token: `tok-${uid}`, key: principalKeyOf({ authProvider: 'firebase', authProviderUid: uid }) };
}

/** Production's factories, verbatim, but for the client: each call a kernel of its own through the relay. */
const FACTORIES = Object.freeze({
  client: () => createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 4, idle_timeout: 0,
    onclose: () => { relay.state.closes += 1; },
    host: relay.dir, port: 5432, user: RUNTIME_LOGIN,
  }),
  store: createPostgresTransactionalStore,
  platformAdmission: (c) => createPostgresPlatformAdmission({ client: c }),
  // The administrative login's standing check (M5-ADMIN-REVOKE-P1), forwarded exactly as PRODUCTION_FACTORIES forward it.
  sessionStore: (c, standing) => createPostgresSessionStore({ client: c, standing }),
  tenantAdmission: (c) => createPostgresTenantAdmission({ client: c }),
  tenantDirectory: (c) => createPostgresTenantDirectory({ client: c }),
  rateLimiter: (c, keySecret) => createPostgresRateLimiter({ client: c, keySecret }),
});
const bundleOf = (tx) => ({
  store: tx.sessionStore, tenantAdmission: tx.tenantAdmission, platformAdmission: tx.platformAdmission, rateLimiter: tx.rateLimiter,
});

const instances = new Set();

/** One runtime instance, composed from its own environment exactly as an entry composes one, and served. */
async function compose(label, rateLimitKey = CANONICAL_KEY) {
  const env = Object.freeze({ ...CONFIGURED_ENV, RATE_LIMIT_KEY: rateLimitKey.toString('base64url') });
  const tx = assembleTransactions(PRODUCTION_INVENTORY, env, FACTORIES);
  const keySecret = parseRateLimitKey(env.RATE_LIMIT_KEY); // the session root's one parse of the key
  const sessions = assembleSessions({
    origins: ORIGINS, verifier: VERIFIER, trustedProxies: TRUSTED_PROXIES, keySecret, ...durableSessionAdapters(bundleOf(tx), keySecret),
  });
  const logs = [];
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line) => { logs.push(line); } }, routes: tx.routes, limits: sessions.limits,
    idempotency: tx.idempotency, transactions: tx.transactions, events: EVENTS, sessions: sessions.sessions,
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const instance = {
    label, tx, logs, port: server.address().port,
    async close() {
      instances.delete(instance);
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await tx.close();
    },
  };
  instances.add(instance);
  return instance;
}

test.after(async () => {
  await relay.restore().catch(() => {});
  for (const instance of [...instances]) await instance.close().catch(() => {});
  await relay.close().catch(() => {});
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

let A = await compose('A');
const B = await compose('B');
let C = null; // keyed with SECOND_KEY (M6RS-13, M6RS-16)

// ---------------------------------------------------------------------------
// clients, requests and observations
// ---------------------------------------------------------------------------

const TEST_NETS = ['192.0.2', '198.51.100', '203.0.113'];
const usedSubjects = new Set([limiterSubjectOf(parseAddress(PROXY))]);
/**
 * A synthetic client address whose limiter subject no other client in this run has, and that holds no bucket in the store
 * — so an earlier run on a shared database, inside its windows, never hands this one a spent budget.
 */
async function unusedAddress(pick) {
  for (let tries = 0; tries < 200; tries++) {
    const address = pick(randomBytes(5));
    const subject = limiterSubjectOf(parseAddress(address));
    if (usedSubjects.has(subject)) continue;
    usedSubjects.add(subject);
    if (await anyBucketOf(subject, CANONICAL_KEY) === 0) return address;
  }
  throw new Error('no unused synthetic client address in 200 draws');
}
/** IPv4 TEST-NET, or a 2001:db8 /64. */
const freshAddress = (family = 6) => unusedAddress((b) => (family === 4
  ? `${TEST_NETS[b[0] % 3]}.${1 + (b[1] % 254)}`
  : `2001:db8:${b.readUInt16BE(1).toString(16)}:${b.readUInt16BE(3).toString(16)}::${1 + (b[0] % 250)}`));
/** A client behind the trusted proxy: the socket peer is 127.0.0.2, the client its forwarded address. */
const proxied = async (family = 6) => {
  const address = await freshAddress(family);
  return Object.freeze({ peer: PROXY, xff: address, address });
};
/** An untrusted client connecting directly from its own loopback address — never 127.0.0.1 or the proxy. */
const direct = async () => {
  const address = await unusedAddress((b) => `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`);
  return Object.freeze({ peer: address, address });
};

/** One request on its own connection from `from.peer`, carrying `from.xff` as X-Forwarded-For when present. */
function send(instance, method, path, headers, from) {
  const framed = { ...(method === 'GET' ? {} : { 'content-length': '0' }), ...(from.xff === undefined ? {} : { 'x-forwarded-for': from.xff }), ...headers };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: instance.port, method, path, headers: framed, localAddress: from.peer, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, ms: Date.now() - started, instance }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`no reply within 10 s: ${method} ${path}`)));
    req.end();
  });
}
/** A login exchange on `audience`, with `token` (refused by the verifier unless a principal's). */
const login = (instance, audience, from, token = 'unverified-token') => send(instance, 'POST', sessionPaths(audience).login, {
  origin: ORIGIN[audience], 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${token}`,
}, from);
/** The current-session read on `audience` with no cookie: a 401 past the limiter. */
const current = (instance, audience, from) => send(instance, 'GET', sessionPaths(audience).current, {}, from);
const probe = (instance, path) => send(instance, 'GET', path, {}, { peer: '127.0.0.1' });

/** The refusal the runtime LOGGED for one reply, found by its request id in the instance that served it. */
function reasonOf(reply) {
  const id = reply.headers['x-request-id'];
  for (const line of reply.instance.logs) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.event === 'request' && record.requestId === id) return record.reason;
  }
  return undefined;
}
/** A refusal's body is generic: the error word and the request id, nothing else. */
function refused(reply, status, error, reason) {
  assert.equal(reply.status, status, `${reply.instance.label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], 'no hint beyond the error word');
  assert.equal(body.error, error);
  if (reason !== undefined) assert.equal(reasonOf(reply), reason);
}
/** A 429 whose Retry-After is a whole number of seconds inside the policy's window; the wait. */
function limitedReply(reply, reason, policy) {
  refused(reply, 429, 'rate_limited', reason);
  const wait = reply.headers['retry-after'];
  assert.match(String(wait), /^[1-9][0-9]*$/, 'Retry-After is whole seconds');
  assert.ok(Number(wait) >= 1 && Number(wait) <= policy.windowMs / 1000, `Retry-After ${wait} within 1..${policy.windowMs / 1000}`);
  return Number(wait);
}
/** A 503 from the limiter: the store could not answer, and nothing was allowed. */
function unavailableReply(reply) {
  refused(reply, 503, 'service_unavailable');
  assert.ok(['rate_limit_unavailable', 'rate_limit_timeout'].includes(reasonOf(reply)), `limiter outage: ${reasonOf(reply)}`);
  assert.ok(reply.ms < 2_000, `bounded: ${reply.ms} ms`);
}
/** The instances in turn, so every sequence of requests is split across both runtimes. */
const alternate = (i) => (i % 2 === 0 ? A : B);

/** Spend `n` of `from`'s tenant-login client budget with refused credentials, split across both runtimes: each a 401. */
async function spendLogins(from, n, audience = 'tenant') {
  for (let i = 0; i < n; i++) refused(await login(alternate(i), audience, from), 401, 'unauthenticated');
}
/** Exhaust `from`'s login client limit on `audience` and prove the next attempt is the 429. */
async function exhaustLogins(from, audience = 'tenant') {
  await spendLogins(from, LOGIN_CLIENT.limit, audience);
  return limitedReply(await login(B, audience, from), 'login_client_limited', LOGIN_CLIENT);
}

const KEYRINGS = new Map([[CANONICAL_KEY, createLimiterKeyring(CANONICAL_KEY)], [SECOND_KEY, createLimiterKeyring(SECOND_KEY)]]);
const subjectOf = (from) => limiterSubjectOf(parseAddress(from.address));
/** The stored bucket of one (namespace, dimension, subject, policy) under `key`'s pseudonyms, read as the owner; or null. */
async function bucket(namespace, dimension, subject, policy, key = CANONICAL_KEY) {
  const limiterKey = KEYRINGS.get(key).keyOf(namespace, dimension, subject);
  const rows = await owner`select consumed, (extract(epoch from expires_at) * 1000)::float8 as expires_ms,
      (extract(epoch from window_start) * 1000)::float8 as start_ms
    from tmpos_rate_limit.bucket
    where namespace = ${namespace} and dimension = ${dimension} and limiter_key = ${limiterKey}
      and limit_count = ${policy.limit} and window_ms = ${policy.windowMs}`;
  assert.ok(rows.length <= 1);
  return rows.length === 0 ? null : { ...rows[0] };
}
const loginBucket = (from, audience = 'tenant') => bucket(`${audience}-login`, 'client', subjectOf(from), LOGIN_CLIENT);
/** Every bucket any key of `subject` could hold, in every namespace and dimension this file spends, under `key`. */
async function anyBucketOf(subject, key) {
  const ring = KEYRINGS.get(key);
  const keys = ['runtime', 'tenant', 'admin', 'tenant-login', 'admin-login'].map((ns) => ring.keyOf(ns, 'client', subject));
  return (await owner`select count(*)::int as n from tmpos_rate_limit.bucket where limiter_key = any(${keys})`)[0].n;
}
const fingerprintRow = async () =>
  ({ ...(await owner`select fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint`)[0] });
const dbNow = async () => (await owner`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`)[0].t;
/** Buckets whose window opened at or after `sinceMs` on the database clock: created or reopened since then. */
const bucketsOpenedSince = async (sinceMs) => (await owner`select count(*)::int as n from tmpos_rate_limit.bucket
  where window_start >= to_timestamp(${sinceMs / 1000})`)[0].n;

// ---------------------------------------------------------------------------
// M6RS-00: the composition binds the PostgreSQL limiter
// ---------------------------------------------------------------------------

test('M6RS-00: 001-015 applied; the transaction root hands over the limiter binding and the session root binds it to its own key', async () => {
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.ok(ledger.some((r) => r.version === '014' && r.dirty === false), '014 applied and clean');
  assert.ok(ledger.some((r) => r.version === '015' && r.dirty === false), '015 applied and clean');
  assert.equal(typeof A.tx.rateLimiter, 'function');
  assert.notEqual(A.tx, B.tx, 'two separately composed roots, each over its own kernel');

  // Without a key the binding is never called: the slot stays null and is named — the only blocker left.
  assert.throws(
    () => assembleSessions({ origins: ORIGINS, verifier: VERIFIER, trustedProxies: TRUSTED_PROXIES, keySecret: CANONICAL_KEY, ...durableSessionAdapters(bundleOf(A.tx)) }),
    (err) => err instanceof ProductionCompositionError && JSON.stringify(err.blockers) === JSON.stringify(['rate_limit_store_unavailable']),
  );
  // The production root itself: with RATE_LIMIT_KEY configured and the bundle handed over, the limiter is no longer a
  // blocker (the identity verifier, which needs a provider configuration, is the one left); without the key, both are.
  const env = {
    SESSION_TENANT_ORIGINS: 'https://pos.trusted.test', SESSION_ADMIN_ORIGINS: 'https://admin.trusted.test',
    TRUSTED_PROXY_CIDRS: TRUSTED_PROXIES.join(','), RATE_LIMIT_KEY: CONFIGURED_ENV.RATE_LIMIT_KEY,
  };
  const blockersOf = (e) => {
    try { composeProductionSessions(e, bundleOf(A.tx)); } catch (err) { if (err instanceof ProductionCompositionError) return [...err.blockers]; throw err; }
    return [];
  };
  assert.deepEqual(blockersOf(env), ['identity_verifier_unconfigured']);
  const unkeyed = blockersOf({ ...env, RATE_LIMIT_KEY: undefined });
  assert.ok(unkeyed.includes('rate_limit_key_missing') && unkeyed.includes('rate_limit_store_unavailable'), unkeyed.join());

  // The bound limiter answers readiness through 014's probe, and both served runtimes are ready.
  assert.equal(await A.tx.rateLimiter(CANONICAL_KEY).probe(signal()), true);
  for (const instance of [A, B]) assert.equal((await probe(instance, '/readiness')).status, 200, `${instance.label} ready`);
  assert.deepEqual((await fingerprintRow()).fingerprint, rateLimitKeyFingerprint(CANONICAL_KEY), 'the canonical key is registered');
});

// ---------------------------------------------------------------------------
// M6RS-01..09: one shared store behind two runtimes
// ---------------------------------------------------------------------------

test('M6RS-01: two separately composed runtimes share one client bucket', async () => {
  const client = await proxied();
  refused(await login(A, 'tenant', client), 401, 'unauthenticated');
  refused(await login(B, 'tenant', client), 401, 'unauthenticated');
  // One row per (namespace, dimension, key, policy), counted by both: the login limit and the tenant request limit.
  assert.equal((await loginBucket(client)).consumed, 2);
  assert.equal((await bucket('tenant', 'client', subjectOf(client), REQUEST)).consumed, 2);
  // The trusted proxy is never the subject: nothing is counted for 127.0.0.2 itself.
  assert.equal(await anyBucketOf(limiterSubjectOf(parseAddress(PROXY)), CANONICAL_KEY), 0);
});

test('M6RS-02: allowances spent through one runtime are gone from the other', async () => {
  const client = await proxied(4);
  for (let i = 0; i < 7; i++) refused(await login(A, 'tenant', client), 401, 'unauthenticated');
  for (let i = 0; i < 3; i++) refused(await login(B, 'tenant', client), 401, 'unauthenticated');
  limitedReply(await login(B, 'tenant', client), 'login_client_limited', LOGIN_CLIENT);
  limitedReply(await login(A, 'tenant', client), 'login_client_limited', LOGIN_CLIENT);
  assert.equal((await loginBucket(client)).consumed, LOGIN_CLIENT.limit);
});

test('M6RS-03: concurrent traffic split across both runtimes is admitted exactly up to the production login limit', async () => {
  const client = await proxied();
  const replies = await Promise.all(Array.from({ length: 24 }, (_, i) => login(alternate(i), 'tenant', client)));
  const statuses = replies.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, LOGIN_CLIENT.limit, statuses.join());
  assert.equal(statuses.filter((s) => s === 429).length, 24 - LOGIN_CLIENT.limit, statuses.join());
  for (const r of replies.filter((reply) => reply.status === 429)) limitedReply(r, 'login_client_limited', LOGIN_CLIENT);
  assert.equal((await loginBucket(client)).consumed, LOGIN_CLIENT.limit, 'the store counted exactly the allowances');
});

/**
 * A refused login of an exhausted client, timed on the DATABASE clock (the one 014 decides on): its Retry-After must be the
 * whole seconds between some instant inside the request and the stored expiry — a margin of one for rounding only.
 */
async function timedRefusal(instance, client, expiresMs) {
  const sentAt = await dbNow();
  const wait = limitedReply(await login(instance, 'tenant', client), 'login_client_limited', LOGIN_CLIENT);
  const answeredAt = await dbNow();
  assert.ok(wait >= Math.ceil((expiresMs - answeredAt) / 1000) - 1 && wait <= Math.ceil((expiresMs - sentAt) / 1000) + 1,
    `Retry-After ${wait} is the time left to the stored expiry`);
  return wait;
}

test('M6RS-04: the next request is a 429 with a bounded Retry-After', async () => {
  const client = await proxied();
  await exhaustLogins(client);
  const stored = await loginBucket(client);
  assert.equal(stored.consumed, LOGIN_CLIENT.limit);
  assert.ok(await timedRefusal(A, client, stored.expires_ms) >= LOGIN_CLIENT.windowMs / 1000 - 10, 'most of the window is left');
});

test('M6RS-05: refused requests do not extend the window — Retry-After counts down over real time', async () => {
  const client = await proxied(4);
  await exhaustLogins(client);
  const before = await loginBucket(client);
  const waits = [];
  for (let i = 0; i < 3; i++) {
    waits.push(await timedRefusal(alternate(i), client, before.expires_ms));
    if (i < 2) await delay(1_200);
  }
  assert.deepEqual(await loginBucket(client), before, 'neither the count nor the expiry moved');
  assert.ok(waits[2] <= waits[0] - 2 && waits[1] <= waits[0], `counts down: ${waits.join(' > ')}`);
});

test('M6RS-06: one client at its limit does not limit another behind the same proxy', async () => {
  const limited = await proxied();
  await exhaustLogins(limited);
  const other = await proxied(4);
  refused(await login(A, 'tenant', other), 401, 'unauthenticated');
  refused(await login(B, 'tenant', other), 401, 'unauthenticated');
  limitedReply(await login(A, 'tenant', limited), 'login_client_limited', LOGIN_CLIENT);
  assert.equal((await loginBucket(other)).consumed, 2);
});

test('M6RS-07: the tenant, admin, tenant-login and admin-login namespaces are isolated', async () => {
  // Each login namespace exhausted leaves the other login namespace and both request namespaces untouched.
  for (const [spent, other] of [['tenant', 'admin'], ['admin', 'tenant']]) {
    const client = await proxied();
    await exhaustLogins(client, spent);
    refused(await login(A, other, client), 401, 'unauthenticated');
    refused(await current(B, 'tenant', client), 401, 'unauthenticated');
    refused(await current(A, 'admin', client), 401, 'unauthenticated');
    assert.equal((await loginBucket(client, other)).consumed, 1);
  }
  // A request namespace exhausted — exactly REQUEST.limit of concurrent requests split across both runtimes pass.
  const total = REQUEST.limit + 6;
  async function exhaustRequests(audience, from) {
    const statuses = [];
    for (let sent = 0; sent < total; sent += 20) {
      const wave = await Promise.all(Array.from({ length: Math.min(20, total - sent) }, (_, i) => current(alternate(i), audience, from)));
      for (const reply of wave) {
        statuses.push(reply.status);
        if (reply.status === 429) limitedReply(reply, 'rate_limited', REQUEST);
      }
    }
    assert.equal(statuses.filter((s) => s === 401).length, REQUEST.limit);
    assert.equal(statuses.filter((s) => s === 429).length, total - REQUEST.limit);
    assert.equal((await bucket(audience, 'client', subjectOf(from), REQUEST)).consumed, REQUEST.limit);
  }
  const client = await proxied(4);
  await exhaustRequests('admin', client);
  // The admin login is refused with it (its request limit is spent first); the tenant namespaces and unknown paths are not.
  limitedReply(await login(A, 'admin', client), 'rate_limited', REQUEST);
  refused(await current(A, 'tenant', client), 401, 'unauthenticated');
  refused(await login(B, 'tenant', client), 401, 'unauthenticated');
  assert.equal((await send(A, 'GET', '/m6rs-not-a-route', {}, client)).status, 404);
  // And the reverse: the tenant request namespace exhausted leaves the admin request and admin-login namespaces untouched.
  const other = await proxied(4);
  await exhaustRequests('tenant', other);
  limitedReply(await login(A, 'tenant', other), 'rate_limited', REQUEST);
  refused(await current(A, 'admin', other), 401, 'unauthenticated');
  refused(await login(B, 'admin', other), 401, 'unauthenticated');
  assert.equal((await bucket('admin', 'client', subjectOf(other), REQUEST)).consumed, 2);
  assert.equal((await loginBucket(other, 'admin')).consumed, 1);
});

test('M6RS-08: the client and account dimensions are isolated; the account budget is spent only once verified', async () => {
  const [u1, u2, u3] = [principal('u1'), principal('u2'), principal('u3')];
  const accountBucket = (who) => bucket('tenant-login', 'account', who.key, LOGIN_ACCOUNT);

  // Five verified logins of one account from one client: each admitted by the limiter, then refused by admission.
  const first = await proxied();
  for (let i = 0; i < LOGIN_ACCOUNT.limit; i++) refused(await login(alternate(i), 'tenant', first, u1.token), 401, 'unauthenticated', 'login_admission_denied');
  assert.equal((await accountBucket(u1)).consumed, LOGIN_ACCOUNT.limit);
  // The sixth, from a client never seen, is the account's 429 — its client budget is untouched but for this attempt.
  const second = await proxied(4);
  limitedReply(await login(B, 'tenant', second, u1.token), 'login_account_limited', LOGIN_ACCOUNT);
  assert.equal((await loginBucket(second)).consumed, 1);
  // That client, and the first one, still log in as another account.
  refused(await login(A, 'tenant', second, u2.token), 401, 'unauthenticated', 'login_admission_denied');
  refused(await login(B, 'tenant', first, u2.token), 401, 'unauthenticated', 'login_admission_denied');

  // A client at its login limit spends no account budget: the credential is never examined.
  const third = await proxied();
  await spendLogins(third, LOGIN_CLIENT.limit);
  limitedReply(await login(A, 'tenant', third, u3.token), 'login_client_limited', LOGIN_CLIENT);
  assert.equal(await accountBucket(u3), null, 'no account bucket for a login refused on its client');
  refused(await login(B, 'tenant', await proxied(), u3.token), 401, 'unauthenticated', 'login_admission_denied');
  assert.equal((await accountBucket(u3)).consumed, 1);
});

test('M6RS-09: a spoofed forwarded prefix, or X-Forwarded-For from an untrusted peer, cannot escape an exhausted bucket', async () => {
  // Through the trusted proxy only the right-hand client is believed: extra left-hand entries are the client's own text.
  const client = await proxied();
  await exhaustLogins(client);
  const spoofs = [await freshAddress(4), await freshAddress(), await freshAddress(4)];
  for (const [i, xff] of [`${spoofs[0]}, ${client.address}`, `${spoofs[1]},${spoofs[2]}, ${client.address}`].entries()) {
    limitedReply(await login(alternate(i), 'tenant', { peer: PROXY, xff }), 'login_client_limited', LOGIN_CLIENT);
  }
  // An untrusted peer's X-Forwarded-For is never read: the peer is the client, whatever it names.
  const peer = await direct();
  await exhaustLogins(peer);
  for (const [i, named] of [spoofs[0], await freshAddress()].entries()) {
    limitedReply(await login(alternate(i), 'tenant', { peer: peer.peer, xff: named }), 'login_client_limited', LOGIN_CLIENT);
  }
  assert.equal((await loginBucket(peer)).consumed, LOGIN_CLIENT.limit);
  for (const address of spoofs) assert.equal(await anyBucketOf(limiterSubjectOf(parseAddress(address)), CANONICAL_KEY), 0, 'nothing counted for a spoofed name');
});

// ---------------------------------------------------------------------------
// M6RS-13, 10, 11, 12, 14: the store goes down and comes back. 13 runs first: it composes the differently keyed instance
// while the store is up, then opens the outage the next three observe.
// ---------------------------------------------------------------------------

const beforeOutage = { partial: null, exhausted: null, spent: 4 };

test('M6RS-13: /readiness is 503 for an instance with a mismatched RATE_LIMIT_KEY, and on every instance during the store failure', async () => {
  assert.deepEqual((await fingerprintRow()).fingerprint, rateLimitKeyFingerprint(CANONICAL_KEY), 'the canonical key registered first');
  C = await compose('C', SECOND_KEY);
  assert.equal((await probe(A, '/readiness')).status, 200);
  assert.equal((await probe(C, '/readiness')).status, 503, 'the store is up, but not for this key');
  assert.equal((await probe(C, '/health')).status, 200);
  // The same kernel bound to the canonical key is ready: the key alone refuses.
  assert.equal(await C.tx.rateLimiter(CANONICAL_KEY).probe(signal()), true);
  assert.equal(await C.tx.rateLimiter(SECOND_KEY).probe(signal()), false);

  // Buckets the outage will find: one partly spent, one exhausted.
  beforeOutage.partial = await proxied();
  await spendLogins(beforeOutage.partial, beforeOutage.spent);
  beforeOutage.exhausted = await proxied(4);
  await exhaustLogins(beforeOutage.exhausted);

  await storeDown();
  await delay(PROBE_REUSE_WAIT_MS);
  for (const instance of [A, B, C]) {
    assert.equal((await probe(instance, '/readiness')).status, 503, `${instance.label} not ready while the store is down`);
    assert.equal((await probe(instance, '/health')).status, 200, `${instance.label} alive`);
  }
});

let neverSeen = null;

test('M6RS-10: with the store down every protected request is a bounded 503 — no local allowance', async () => {
  neverSeen = await proxied();
  for (const instance of [A, B]) {
    for (let i = 0; i < 3; i++) {
      unavailableReply(await login(instance, 'tenant', neverSeen));
      unavailableReply(await login(instance, 'admin', neverSeen));
      unavailableReply(await current(instance, 'tenant', neverSeen));
      unavailableReply(await current(instance, 'admin', neverSeen));
      unavailableReply(await send(instance, 'GET', '/m6rs-not-a-route', {}, neverSeen));
    }
  }
  unavailableReply(await login(A, 'tenant', await direct()));
});

test('M6RS-11: a bucket seen before the outage gets no local fallback during it — neither an allowance nor a cached 429', async () => {
  for (let i = 0; i < 4; i++) {
    unavailableReply(await login(alternate(i), 'tenant', beforeOutage.partial));
    unavailableReply(await login(alternate(i), 'tenant', beforeOutage.exhausted));
  }
});

test('M6RS-12: /health answers 200 throughout the limiter failure, beside protected requests refused with 503', async () => {
  const clients = [await proxied(), await proxied(), await proxied(), await proxied()];
  const replies = await Promise.all([A, B, A, B].flatMap((instance, i) => [probe(instance, '/health'), current(instance, 'tenant', clients[i])]));
  for (const reply of replies) {
    if (reply.status === 200) assert.deepEqual(JSON.parse(reply.body), { status: 'alive' });
    else unavailableReply(reply);
  }
  assert.equal(replies.filter((r) => r.status === 200).length, 4);
});

test('M6RS-14: recovery resumes from the durable counts, and no call refused during the outage is replayed', async () => {
  // Nothing refused during the outage reached the store — in any namespace — before or after it returns.
  const requestBucket = () => bucket('tenant', 'client', subjectOf(beforeOutage.partial), REQUEST);
  const partialRequests = (await requestBucket()).consumed;
  assert.equal(partialRequests, beforeOutage.spent);
  assert.equal(await anyBucketOf(subjectOf(neverSeen), CANONICAL_KEY), 0);
  await relay.restore();
  for (const instance of [A, B]) {
    let status = 0;
    for (const until = Date.now() + 15_000; status !== 200 && Date.now() < until;) {
      status = (await probe(instance, '/readiness')).status;
      if (status !== 200) await delay(250);
    }
    assert.equal(status, 200, `${instance.label} ready again`);
  }
  assert.equal(await anyBucketOf(subjectOf(neverSeen), CANONICAL_KEY), 0, 'reconnecting replayed nothing');
  assert.equal((await loginBucket(beforeOutage.partial)).consumed, beforeOutage.spent, 'the outage spent nothing');
  assert.equal((await requestBucket()).consumed, partialRequests, 'nor at the request limit it met first');

  // The partly spent client resumes where it stood; the exhausted one is still limited; the unseen one starts full.
  await spendLogins(beforeOutage.partial, LOGIN_CLIENT.limit - beforeOutage.spent);
  limitedReply(await login(A, 'tenant', beforeOutage.partial), 'login_client_limited', LOGIN_CLIENT);
  limitedReply(await login(B, 'tenant', beforeOutage.exhausted), 'login_client_limited', LOGIN_CLIENT);
  await exhaustLogins(neverSeen);
});

// ---------------------------------------------------------------------------
// M6RS-15, 16: instances replaced, and an instance keyed differently
// ---------------------------------------------------------------------------

test('M6RS-15: closing an instance and composing a new one does not reset a bucket', async () => {
  const exhausted = await proxied();
  const waitBefore = await exhaustLogins(exhausted);
  const partial = await proxied(4);
  for (let i = 0; i < 3; i++) refused(await login(A, 'tenant', partial), 401, 'unauthenticated');

  await A.close(); // the server, then its kernel
  A = await compose('A2');
  const waitAfter = limitedReply(await login(A, 'tenant', exhausted), 'login_client_limited', LOGIN_CLIENT);
  assert.ok(waitAfter <= waitBefore, 'the same window, still counting down');
  limitedReply(await login(B, 'tenant', exhausted), 'login_client_limited', LOGIN_CLIENT);
  for (let i = 0; i < LOGIN_CLIENT.limit - 3; i++) refused(await login(A, 'tenant', partial), 401, 'unauthenticated');
  limitedReply(await login(A, 'tenant', partial), 'login_client_limited', LOGIN_CLIENT);
});

test('M6RS-16: an instance keyed with another RATE_LIMIT_KEY is refused and creates no identity of its own; the first keeps enforcing', async () => {
  const fingerprint = await fingerprintRow();
  // Counted by what opened since, not the store's total: an earlier allowed consume's background reclaim may still remove
  // expired buckets, but nothing but this instance's refused requests runs until the check.
  const since = await dbNow();
  const client = await proxied();
  for (let i = 0; i < 3; i++) {
    for (const reply of [await login(C, 'tenant', client), await current(C, 'admin', client), await login(C, 'admin', client)]) {
      refused(reply, 503, 'service_unavailable', 'rate_limit_unavailable');
    }
  }
  await delay(PROBE_REUSE_WAIT_MS);
  assert.equal((await probe(C, '/readiness')).status, 503);
  assert.equal((await probe(A, '/readiness')).status, 200);

  // Nothing written: no bucket under either key, no second fingerprint, the registered one untouched.
  assert.equal(await bucketsOpenedSince(since), 0, 'the store gained no bucket');
  assert.equal(await anyBucketOf(subjectOf(client), SECOND_KEY), 0);
  assert.equal(await anyBucketOf(subjectOf(client), CANONICAL_KEY), 0);
  assert.deepEqual(await fingerprintRow(), fingerprint);
  assert.deepEqual(fingerprint.fingerprint, rateLimitKeyFingerprint(CANONICAL_KEY));
  assert.equal((await owner`select count(*)::int as n from tmpos_rate_limit.key_fingerprint`)[0].n, 1);

  // The canonically keyed instances enforce as before: the same client starts full there, and a limit still holds.
  refused(await login(A, 'tenant', client), 401, 'unauthenticated');
  assert.equal((await loginBucket(client)).consumed, 1, 'the refused instance spent nothing');
  const limited = await proxied(4);
  await exhaustLogins(limited);
  limitedReply(await login(A, 'tenant', limited), 'login_client_limited', LOGIN_CLIENT);
});
