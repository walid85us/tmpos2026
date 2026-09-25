// Phase 4.0 M6-ENTRY-P1 — THE DEPLOYABLE PRODUCTION ENTRY, END TO END: startProductionEntry
// (server/entry/productionEntry.ts) composing production's own roots, over REAL loopback HTTP and a
// disposable PostgreSQL, exactly as server/entry/main.ts would but for its construction.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY. Three things, none of them on the path under test:
//   * THE DATABASE CLIENT. `construction.databaseClient` ignores the classified endpoint it is handed
//     and returns instead a supervised kernel over the disposable cluster, as a non-owner least-
//     privilege runtime LOGIN (tmpos_m6ep_probe, holding tmpos_app and tmpos_audit_writer and nothing
//     else), through the byte relay pattern of tests/db/rateLimitRuntime.integration.test.mjs — so the
//     store can be taken down the way a stopping server goes, without touching the cluster itself.
//   * THE IDENTITY VERIFIER. `construction.tokenVerifier` is a synthetic bearer-token map: a known
//     token answers { uid, authTime: now, secondFactor: 'totp' }, an unknown one throws.
//   * THE LISTENER. `construction.listen` always binds 127.0.0.1:0, whatever PORT names.
// Everything else — configuration validation, composition, the startup preflight (connect, the
// runtime login's standing, the migration ledger, the limiter key), the route table, the session and
// authorization chain, the command transaction, readiness and shutdown — is production's own code,
// unmodified.
//
// DISPOSABLE ONLY. The target is TM_POS_TEST_DATABASE_URL when CI binds one, otherwise a cluster this
// file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresSessionStore } from '../../server/persistence/postgresSessionStore.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startProductionEntry, SHIPPING_ROUTES, STARTUP_STEP_DEADLINE_MS } from '../../server/entry/productionEntry.ts';
import {
  principalKeyOf, RECENT_AUTH_MAX_AGE_MS, REAUTHENTICATE_HEADER, REAUTHENTICATE_VALUE, SESSION_COOKIES, SESSION_CSRF_HEADER,
} from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { TENANT_DIRECTORY_PATH } from '../../server/runtime/tenantDirectory.ts';
import { TENANT_DISPLAY_NAME_PATH } from '../../server/runtime/tenantDisplayName.ts';
import { TENANT_STATUS_PATH } from '../../server/runtime/tenantStatus.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm6ep-migrator', runtimeRef: 'm6ep-runtime' };
const LOCK_KEY = 528_516;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m6ep_probe';
const ADMIN_HOST = 'admin.m6ep.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
const REASON = 'Synthetic proof for the M6-ENTRY-P1 production entry suite.';
/** app.ts PROBE_REUSE_MS (1 s, not exported) and a margin: a readiness probe is reused for that long. */
const PROBE_REUSE_WAIT_MS = 1_100;

// ---------------------------------------------------------------------------
// cluster lifecycle (mirrors tests/db/rateLimitRuntime.integration.test.mjs)
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
    'M6EP INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. '
    + 'Docker and remote databases are not substitutes.',
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

/** The owner: applies the migrations, creates the runtime login and writes/observes fixtures. RLS does not restrict it. */
const owner = postgres(driverDsn(TARGET_DSN), { ...CLIENT_OPTS, max: 3, onnotice: () => {} });

// The runtime login, existence-guarded: its backends ended before what it owns is dropped, so a rerun never inherits a
// stuck session — and `drop role` alone refuses while the role still owns anything from a previous, uncleaned run.
const DROP_RUNTIME_LOGIN = `do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then
    perform pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = '${RUNTIME_LOGIN}';
    drop owned by ${RUNTIME_LOGIN};
    drop role ${RUNTIME_LOGIN};
  end if;
end $$;`;

/** The registered rate-limit key fingerprint before this suite touched it: undefined until taken, then the row or null. */
let rateLimitFingerprintBefore;
/** Every column, as a plain object (registered_at as text) so a restore round-trips it exactly, and deepEqual compares it cleanly. */
async function fingerprintRow() {
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  return rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
}

// Teardown is registered before the first mutation, and run by setupStep should top-level setup stop part-way — node:test
// runs no hook at all once the module itself has thrown (the pattern of productionEntryPreflight.integration.test.mjs).
async function teardown() {
  // Each step runs even when an earlier one failed; every failure is reported once the owner and the cluster are closed.
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    await step(() => owner.unsafe(DROP_RUNTIME_LOGIN));
    // The one registered rate-limit key fingerprint: restored to exactly its snapshot, or removed if there was none — in
    // one transaction, so a failed insert never leaves the table empty — and proven exact, every column. registered_at
    // goes back as a text parameter the server parses: a bare `::timestamptz` parameter goes through a JS Date and loses
    // the microseconds.
    if (rateLimitFingerprintBefore !== undefined) {
      await step(async () => {
        await owner.begin(async (sql) => {
          await sql`delete from tmpos_rate_limit.key_fingerprint where singleton`;
          if (rateLimitFingerprintBefore !== null) {
            await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
              values (${rateLimitFingerprintBefore.singleton}, ${rateLimitFingerprintBefore.fingerprint}, ${rateLimitFingerprintBefore.registered_at}::text::timestamptz)`;
          }
        });
        assert.deepEqual(await fingerprintRow(), rateLimitFingerprintBefore);
      });
    }
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M6EP teardown: a cleanup step failed');
}
test.after(teardown);

/** A top-level setup step that creates state teardown owns: should it throw, teardown runs before the failure propagates. */
async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'M6EP setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster, so the store can be taken down
// ---------------------------------------------------------------------------

function startRelay() {
  const u = new URL(TARGET_DSN);
  const upstream = CLIENT_OPTS.host
    ? { path: join(CLIENT_OPTS.host, `.s.PGSQL.${u.port || 5432}`) }
    : { host: u.hostname, port: Number(u.port || 5432) };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m6ep-relay-'));
  const pairs = new Set();
  const state = { closes: 0, pairs };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
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

/** Take the store down the way a server does: refuse new connections and end every runtime session. */
async function storeDown(relay) {
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

/** A production-shaped database client factory bound to one relay; the classified endpoint is ignored. */
function databaseClientOver(relay) {
  return (_endpoint) => createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max: MAX_POOLS, idle_timeout: 0,
    onclose: () => { relay.state.closes += 1; },
    host: relay.dir, port: 5432, user: RUNTIME_LOGIN,
  });
}

// ---------------------------------------------------------------------------
// setup: real migrations 001-014 and a real non-owner least-privilege runtime login
// ---------------------------------------------------------------------------

// The roles the migrations name, PUBLIC's CREATE and TEMPORARY on the database revoked (the startup preflight refuses a
// login holding either) and migrations 001-014: the approved production state, which every earlier database suite also
// establishes, so it stays in place on a shared database. It is re-established here, not inherited.
await setupStep(async () => {
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
  await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
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
});

// A rerun against a persistent database must not fail on a leftover login or schema_migrations grant. Should a grant
// below fail, teardown drops the login all the same.
await setupStep(async () => {
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  // G-DBROLE provisioning (not a migration): the one direct privilege the entry's startup preflight
  // requires of the runtime login — the ledger read postgresStartupPreflight.ts checks for.
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
});

const CANONICAL_RATE_KEY = Buffer.alloc(32, 7);
const CANONICAL_IDEMPOTENCY_KEY = Buffer.alloc(32, 9);

// The one registered RATE_LIMIT_KEY fingerprint (migration 014): snapshotted now, before any test can touch it,
// restored exactly by teardown — no routine ever resets it, so a persistent database must get its row back. Then the
// canonical key is registered here, as productionEntryPreflight does, so no earlier suite's leftover key decides this one:
// the delete and the insert in one transaction, so the table is never left empty.
await setupStep(async () => {
  rateLimitFingerprintBefore = await fingerprintRow();
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(CANONICAL_RATE_KEY)})`;
  });
});

// ---------------------------------------------------------------------------
// the synthetic identity provider and configuration every entry starts from
// ---------------------------------------------------------------------------

const TOKENS = new Map(); // bearer token -> { uid, authAgeSec? }
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) {
      const err = new Error('unknown_token');
      err.code = 'auth/invalid-id-token'; // maps to a credential refusal, never an outage
      throw err;
    }
    // authAgeSec stands for a token the provider REFRESHED: a fresh token whose auth_time is still the old sign-in's.
    return { uid: rec.uid, authTime: Math.floor(Date.now() / 1000) - (rec.authAgeSec ?? 0), secondFactor: 'totp' };
  },
});

const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const FIREBASE_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'm6ep-test-project',
  client_email: 'm6ep-test@m6ep-test-project.iam.gserviceaccount.com',
  private_key: FIREBASE_PRIVATE_KEY,
});

function baseEnv(overrides = {}) {
  return Object.freeze({
    NODE_ENV: 'production',
    PORT: '8080',
    APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
    DATABASE_CA_CERT: tls.rootCertificates[0],
    RATE_LIMIT_KEY: CANONICAL_RATE_KEY.toString('base64url'),
    IDEMPOTENCY_KEY: CANONICAL_IDEMPOTENCY_KEY.toString('base64url'),
    TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
    SESSION_ADMIN_ORIGINS: ADMIN_ORIGIN,
    FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: FIREBASE_JSON,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// small generic helpers
// ---------------------------------------------------------------------------

function waitFor(predicate, timeoutMs = 5_000, intervalMs = 10) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function tick() {
      if (predicate()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error('timed out waiting for condition')); return; }
      setTimeout(tick, intervalMs);
    })();
  });
}

/** A random 127.x.y.z loopback source, never the trusted proxy and never the same twice within a run. */
function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}

/** Every captured log line, across every test in this file — for the SECRETS check at the end. */
const ALL_LOG_LINES = [];

function makeCapture() {
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const log = { log: (line) => { lines.push(line); ALL_LOG_LINES.push(line); } };
  const exit = (code) => { codes.push(code); };
  return { lines, codes, proc, log, exit };
}

function sendReq(port, method, path, headers = {}, body, localAddress) {
  const payload = body === undefined ? undefined : Buffer.from(body);
  const framed = { ...(payload !== undefined ? { 'content-length': String(payload.length) } : {}), ...headers };
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, method, path, headers: framed, agent: false };
    if (localAddress) options.localAddress = localAddress;
    const request = http.request(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error(`no reply within 10 s: ${method} ${path}`)));
    request.end(payload);
  });
}

function parseHttpHead(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const lines = raw.slice(0, idx).split('\r\n');
  const m = /^HTTP\/\d\.\d (\d{3})/.exec(lines[0] ?? '');
  if (m === null) return null;
  const headers = {};
  const setCookies = [];
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (name === 'set-cookie') setCookies.push(value); else headers[name] = value;
  }
  const bodyStart = idx + 4;
  const len = Number(headers['content-length'] ?? '0');
  if (raw.length - bodyStart < len) return null;
  return { status: Number(m[1]), headers, setCookies, body: raw.slice(bodyStart, bodyStart + len) };
}

/** A raw HTTP request over a fresh socket — the only way to send a duplicated or absent Host header. */
function rawRequest(port, text, { localAddress, timeoutMs = 4_000 } = {}) {
  return new Promise((resolve) => {
    const options = { port, host: '127.0.0.1' };
    if (localAddress) options.localAddress = localAddress;
    const socket = net.connect(options);
    let raw = '';
    let settled = false;
    const timer = setTimeout(() => finish(parseHttpHead(raw) ?? { status: 0, headers: {}, setCookies: [], body: raw }), timeoutMs);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      const parsed = parseHttpHead(raw);
      if (parsed !== null) finish(parsed);
    });
    socket.on('error', () => finish({ status: 0, headers: {}, setCookies: [], body: '' }));
    socket.on('close', () => finish(parseHttpHead(raw) ?? { status: 0, headers: {}, setCookies: [], body: raw }));
  });
}

function assertBounded404(reply) {
  assert.equal(reply.status, 404, reply.body);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
  assert.equal(body.error, 'not_found');
  assert.equal(reply.headers['set-cookie'], undefined);
}

function assertRawBounded404(reply) {
  assert.equal(reply.status, 404, JSON.stringify(reply));
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
  assert.equal(body.error, 'not_found');
  assert.equal(reply.setCookies.length, 0);
}

/** The composed table in a canonical, order-independent form, for a deep-equal against SHIPPING_ROUTES. */
function canonical(routes) {
  return [...routes].map((r) => `${r.method} ${r.path} ${r.access} ${r.body} ${r.idempotency}`).sort();
}

/** Wraps net.Server.prototype.listen (http.Server inherits it) so a real bind attempt is proven, not inferred; always restore. */
function spyOnBind() {
  const original = net.Server.prototype.listen;
  let attempts = 0;
  net.Server.prototype.listen = function spiedListen(...args) {
    attempts += 1;
    return original.apply(this, args);
  };
  return { count: () => attempts, restore: () => { net.Server.prototype.listen = original; } };
}

/** A built client whose end() is counted into `ends` — `calls` when invoked, `completed` once it resolved — so a test proves the entry ended it. */
function recordingEnd(real, ends) {
  return {
    transaction: (...args) => real.transaction(...args),
    end: async () => { ends.calls += 1; await real.end(); ends.completed += 1; },
  };
}

/** Best-effort SIGTERM, once, if the entry has not already exited — for a finally block after an early assertion failure. */
async function ensureShutdown(cap) {
  if (cap.codes.length === 0) {
    cap.proc.emit('SIGTERM');
    await waitFor(() => cap.codes.length > 0, 5_000).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// fixtures — all written through the owner
// ---------------------------------------------------------------------------

async function actor(label, memberships, status = 'active') {
  const uid = `m6ep-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  return { id, uid, token };
}

const newTenant = async (label) =>
  (await owner`insert into tenant (display_name) values (${`m6ep-${label}-${SUFFIX}`}) returning tenant_id`)[0].tenant_id;

const tenantRow = async (id) => ({ ...(await owner`select display_name, status, row_version from tenant where tenant_id = ${id}`)[0] });

const idempotencyRecordCount = async () => (await owner`select count(*)::int as n from tmpos_internal.idempotency_record`)[0].n;

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

/** Start one production entry over its own relay, hand the test a bound request surface, then stop it. */
async function withEntry(overrides, fn) {
  const relay = startRelay();
  await relay.listening;
  const clientAddress = randomLoopback();
  const cap = makeCapture();
  const construction = {
    databaseClient: databaseClientOver(relay),
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
    ...(overrides.constructionOverrides ?? {}),
  };
  const env = baseEnv(overrides.envOverrides ?? {});
  // Scoped tightly around the entry's own startup: the relay above already bound its socket, so every attempt
  // counted here is the entry's, and only the entry's.
  const bindSpy = spyOnBind();
  let result;
  try {
    result = await startProductionEntry({
      env, construction, proc: cap.proc, exit: cap.exit, log: cap.log, forceTimeoutMs: overrides.forceTimeoutMs,
    });
  } finally {
    bindSpy.restore();
  }
  const port = result.address?.port ?? null;
  const ctx = {
    result, proc: cap.proc, codes: cap.codes, lines: cap.lines, port, relay, clientAddress, bindAttempts: bindSpy.count(),
    req: (method, path, headers = {}, body) => sendReq(port, method, path, { host: ADMIN_HOST, ...headers }, body, clientAddress),
    login: (token, extra = {}) => sendReq(port, 'POST', sessionPaths('admin').login, {
      host: ADMIN_HOST, origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      authorization: `Bearer ${token}`, ...extra,
    }, undefined, clientAddress),
  };
  try {
    return await fn(ctx);
  } finally {
    await ensureShutdown(cap);
    await relay.restore().catch(() => {});
    await relay.close().catch(() => {});
  }
}

async function signIn(ctx, act) {
  const reply = await ctx.login(act.token);
  assert.equal(reply.status, 200, `login ${act.uid}: ${reply.body}`);
  const setCookie = (reply.headers['set-cookie'] ?? [''])[0];
  const cookie = setCookie.split('; ')[0];
  const csrf = JSON.parse(reply.body).csrfToken;
  return { cookie, csrf, setCookie };
}

function surface(ctx, session) {
  const unsafe = {
    origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, [SESSION_CSRF_HEADER]: session.csrf,
    cookie: session.cookie, 'content-type': 'application/json',
  };
  return {
    list: (query = '') => ctx.req('GET', `${TENANT_DIRECTORY_PATH}${query}`, { cookie: session.cookie }),
    rename: (body, extra = {}) => ctx.req('PATCH', TENANT_DISPLAY_NAME_PATH, { ...unsafe, 'idempotency-key': randomUUID(), ...extra }, JSON.stringify(body)),
    status: (body, extra = {}) => ctx.req('PATCH', TENANT_STATUS_PATH, { ...unsafe, 'idempotency-key': randomUUID(), ...extra }, JSON.stringify(body)),
  };
}

async function listed(ctx, session, tenantId) {
  let query = '?limit=50';
  for (let guard = 0; guard < 200; guard++) {
    const reply = await ctx.req('GET', `${TENANT_DIRECTORY_PATH}${query}`, { cookie: session.cookie });
    assert.equal(reply.status, 200, reply.body);
    const body = JSON.parse(reply.body);
    const hit = body.tenants.find((t) => t.tenantId === tenantId);
    if (hit !== undefined) return hit;
    if (body.nextCursor === null) return null;
    query = `?limit=50&cursor=${body.nextCursor}`;
  }
  throw new Error('directory walk did not end');
}

async function waitReady(ctx, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ctx.req('GET', '/readiness')).status === 200) return true;
    await delay(200);
  }
  return false;
}

// ===========================================================================
// M6EP-01..12, 16, 18..23, FORCED SHUTDOWN, TLS, SECRETS
// ===========================================================================

test('M6EP-01: valid complete configuration starts exactly one listener', async () => {
  let listenCalls = 0;
  await withEntry({
    constructionOverrides: { listen: () => { listenCalls += 1; return { port: 0, host: '127.0.0.1' }; } },
  }, async (ctx) => {
    assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
    assert.equal(ctx.result.address.address, '127.0.0.1');
    assert.deepEqual(canonical(ctx.result.routes), canonical(SHIPPING_ROUTES));
    assert.equal(listenCalls, 1, 'construction.listen was called exactly once: no second listener ever appeared');
    assert.equal(ctx.bindAttempts, 1, 'exactly one real net.Server bind attempt: no second listener ever appeared');
  });
});

test('M6EP-02: /health and /readiness answer on the admin Host and a foreign Host, host-exempt, with HSTS and the baseline headers', async () => {
  await withEntry({}, async (ctx) => {
    for (const host of [ADMIN_HOST, 'foreign.test']) {
      const health = await ctx.req('GET', '/health', { host });
      assert.equal(health.status, 200, health.body);
      assert.deepEqual(JSON.parse(health.body), { status: 'alive' });
      const readiness = await ctx.req('GET', '/readiness', { host });
      assert.equal(readiness.status, 200, readiness.body);
      assert.deepEqual(JSON.parse(readiness.body), { status: 'ready' });
      assert.equal(health.headers['strict-transport-security'], HSTS_HEADER.value, host);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(health.headers[name.toLowerCase()], value, `${name} on ${host}`);
      }
    }
  });
});

test('M6EP-03: an authorized administrator logs in on a host-locked, host-only cookie and lists tenants', async () => {
  await withEntry({}, async (ctx) => {
    const admin = await actor('m6ep03', [{ scope: 'platform', role: 'system_owner' }]);
    const tenant = await newTenant('m6ep03');
    const session = await signIn(ctx, admin);
    assert.match(session.setCookie, /^__Host-tmpos_admin_session=[^;]+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    assert.doesNotMatch(session.setCookie.toLowerCase(), /domain=/);
    const hit = await listed(ctx, session, tenant);
    assert.ok(hit !== null, 'the tenant this test created is on the page');
    assert.equal(hit.displayName, `m6ep-m6ep03-${SUFFIX}`);
    assert.equal(hit.status, 'active');
  });
});

test('M6EP-04: the rename command works through the entry; a replay under the same Idempotency-Key replays', async () => {
  await withEntry({}, async (ctx) => {
    const admin = await actor('m6ep04', [{ scope: 'platform', role: 'system_owner' }]);
    const tenant = await newTenant('m6ep04');
    const session = await signIn(ctx, admin);
    const s = surface(ctx, session);
    const key = randomUUID();
    const first = await s.rename({ tenantId: tenant, displayName: 'M6EP renamed', expectedVersion: 1 }, { 'idempotency-key': key });
    assert.equal(first.status, 200, first.body);
    assert.deepEqual(JSON.parse(first.body), { tenantId: tenant, displayName: 'M6EP renamed', version: 2 });
    assert.deepEqual(await tenantRow(tenant), { display_name: 'M6EP renamed', status: 'active', row_version: '2' });

    const replay = await s.rename({ tenantId: tenant, displayName: 'M6EP renamed', expectedVersion: 1 }, { 'idempotency-key': key });
    assert.equal(replay.status, 200, replay.body);
    assert.deepEqual(JSON.parse(replay.body), JSON.parse(first.body));
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    assert.deepEqual(await tenantRow(tenant), { display_name: 'M6EP renamed', status: 'active', row_version: '2' }, 'the replay changed nothing');
  });
});

test('M6EP-05: suspend then reactivate work through the entry', async () => {
  await withEntry({}, async (ctx) => {
    const admin = await actor('m6ep05', [{ scope: 'platform', role: 'system_owner' }]);
    const tenant = await newTenant('m6ep05');
    const session = await signIn(ctx, admin);
    const s = surface(ctx, session);

    const suspended = await s.status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 });
    assert.equal(suspended.status, 200, suspended.body);
    assert.deepEqual(JSON.parse(suspended.body), { tenantId: tenant, status: 'suspended', version: 2 });
    assert.deepEqual(await tenantRow(tenant), { display_name: `m6ep-m6ep05-${SUFFIX}`, status: 'suspended', row_version: '2' });

    const reactivated = await s.status({ tenantId: tenant, status: 'active', reason: REASON, expectedVersion: 2 });
    assert.equal(reactivated.status, 200, reactivated.body);
    assert.deepEqual(JSON.parse(reactivated.body), { tenantId: tenant, status: 'active', version: 3 });
    assert.deepEqual(await tenantRow(tenant), { display_name: `m6ep-m6ep05-${SUFFIX}`, status: 'active', row_version: '3' });
  });
});

test('M6EP-06: missing authentication is refused on the list and on both commands; nothing mutated', async () => {
  await withEntry({}, async (ctx) => {
    const tenant = await newTenant('m6ep06');
    const before = await tenantRow(tenant);
    const list = await ctx.req('GET', TENANT_DIRECTORY_PATH);
    assert.equal(list.status, 401, list.body);
    const unsafe = { origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json' };
    const rename = await ctx.req('PATCH', TENANT_DISPLAY_NAME_PATH,
      { ...unsafe, 'idempotency-key': randomUUID() }, JSON.stringify({ tenantId: tenant, displayName: 'nope', expectedVersion: 1 }));
    assert.equal(rename.status, 401, rename.body);
    const status = await ctx.req('PATCH', TENANT_STATUS_PATH,
      { ...unsafe, 'idempotency-key': randomUUID() }, JSON.stringify({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 }));
    assert.equal(status.status, 401, status.body);
    assert.deepEqual(await tenantRow(tenant), before);
  });
});

test('M6EP-07: insufficient permission is 403 on both commands after a 200 list; no platform grant refuses login (401)', async () => {
  await withEntry({}, async (ctx) => {
    const billing = await actor('m6ep07-billing', [{ scope: 'platform', role: 'billing_admin' }]);
    const tenant = await newTenant('m6ep07');
    const session = await signIn(ctx, billing);
    const s = surface(ctx, session);
    assert.equal((await s.list()).status, 200);
    const before = await tenantRow(tenant);
    assert.equal((await s.rename({ tenantId: tenant, displayName: 'nope', expectedVersion: 1 })).status, 403);
    assert.equal((await s.status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 })).status, 403);
    assert.deepEqual(await tenantRow(tenant), before);

    const noGrant = await actor('m6ep07-none', []);
    assert.equal((await ctx.login(noGrant.token)).status, 401);
  });
});

test('M6EP-08: unknown routes get the bounded fallback and nothing else', async () => {
  await withEntry({}, async (ctx) => {
    for (const [method, path] of [
      ['GET', '/nope'],
      ['GET', `${TENANT_DIRECTORY_PATH}/x`],
      ['DELETE', TENANT_DIRECTORY_PATH],
      ['GET', TENANT_DISPLAY_NAME_PATH],
    ]) {
      assertBounded404(await ctx.req(method, path));
    }
  });
});

test('M6EP-09: test, DEV and witness routes are absent, and never appear in the served inventory', async () => {
  await withEntry({}, async (ctx) => {
    const absent = [
      '/api/v1/session/login', '/api/v1/session', '/identity/whoami', '/dev', '/__witness',
      '/admin/v1/witness', '/diagnostics', '/bootstrap', '/migrations',
    ];
    for (const path of absent) {
      assertBounded404(await ctx.req('GET', path));
      assert.ok(!ctx.result.routes.some((r) => r.path === path), `${path} is not in the served inventory`);
    }
  });
});

test('M6EP-10: an unknown Host is refused exactly like an unknown route — never a Set-Cookie', async () => {
  await withEntry({}, async (ctx) => {
    const admin = await actor('m6ep10', [{ scope: 'platform', role: 'system_owner' }]);
    const session = await signIn(ctx, admin);
    const loginText = (hostLine) =>
      `POST ${sessionPaths('admin').login} HTTP/1.1\r\n${hostLine}Origin: ${ADMIN_ORIGIN}\r\nSec-Fetch-Site: same-origin\r\n${CSRF_HEADER}: 1\r\nAuthorization: Bearer ${admin.token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
    const listText = (hostLine) =>
      `GET ${TENANT_DIRECTORY_PATH} HTTP/1.1\r\n${hostLine}Cookie: ${session.cookie}\r\nConnection: close\r\n\r\n`;

    for (const host of ['evil.test', `${ADMIN_HOST}.evil.test`, `evil.${ADMIN_HOST}`, `${ADMIN_HOST}:8443`, `x@${ADMIN_HOST}`]) {
      assertRawBounded404(await rawRequest(ctx.port, listText(`Host: ${host}\r\n`), { localAddress: ctx.clientAddress }));
      assertRawBounded404(await rawRequest(ctx.port, loginText(`Host: ${host}\r\n`), { localAddress: ctx.clientAddress }));
    }
    // duplicated Host header
    assertRawBounded404(await rawRequest(ctx.port, listText(`Host: ${ADMIN_HOST}\r\nHost: ${ADMIN_HOST}\r\n`), { localAddress: ctx.clientAddress }));
    assertRawBounded404(await rawRequest(ctx.port, loginText(`Host: ${ADMIN_HOST}\r\nHost: ${ADMIN_HOST}\r\n`), { localAddress: ctx.clientAddress }));
    // missing Host, HTTP/1.0
    assertRawBounded404(await rawRequest(ctx.port, `GET ${TENANT_DIRECTORY_PATH} HTTP/1.0\r\nCookie: ${session.cookie}\r\n\r\n`, { localAddress: ctx.clientAddress }));
    assertRawBounded404(await rawRequest(ctx.port,
      `POST ${sessionPaths('admin').login} HTTP/1.0\r\nOrigin: ${ADMIN_ORIGIN}\r\nSec-Fetch-Site: same-origin\r\n${CSRF_HEADER}: 1\r\nAuthorization: Bearer ${admin.token}\r\nContent-Length: 0\r\n\r\n`,
      { localAddress: ctx.clientAddress }));
    // X-Forwarded-Host is never read: a foreign Host is still 404 even naming the admin host there
    assertRawBounded404(await rawRequest(ctx.port, listText(`Host: evil.test\r\nX-Forwarded-Host: ${ADMIN_HOST}\r\n`), { localAddress: ctx.clientAddress }));
    // ...and the admin Host is served normally even with a foreign X-Forwarded-Host
    const served = await rawRequest(ctx.port, listText(`Host: ${ADMIN_HOST}\r\nX-Forwarded-Host: evil.test\r\n`), { localAddress: ctx.clientAddress });
    assert.equal(served.status, 200, served.body);
  });
});

test('M6EP-11: wrong Origin, missing pre-session CSRF, or missing session-CSRF each refuse before any mutation', async () => {
  await withEntry({}, async (ctx) => {
    const admin = await actor('m6ep11', [{ scope: 'platform', role: 'system_owner' }]);
    const tenant = await newTenant('m6ep11');
    const session = await signIn(ctx, admin);
    const before = await tenantRow(tenant);
    const idemBefore = await idempotencyRecordCount();

    const base = {
      origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      [SESSION_CSRF_HEADER]: session.csrf, cookie: session.cookie, 'content-type': 'application/json',
    };
    const body = JSON.stringify({ tenantId: tenant, displayName: 'nope', expectedVersion: 1 });
    const attempt = (headers) => ctx.req('PATCH', TENANT_DISPLAY_NAME_PATH, { ...headers, 'idempotency-key': randomUUID() }, body);

    assert.equal((await attempt({ ...base, origin: 'https://evil.test' })).status, 403, 'wrong Origin');
    const { [CSRF_HEADER]: _dropCsrf, ...noPreSessionCsrf } = base;
    assert.equal((await attempt(noPreSessionCsrf)).status, 403, 'missing X-TMPOS-CSRF');
    const { [SESSION_CSRF_HEADER]: _dropSessionCsrf, ...noSessionCsrf } = base;
    assert.equal((await attempt(noSessionCsrf)).status, 403, 'missing X-TMPOS-Session-CSRF');

    assert.deepEqual(await tenantRow(tenant), before, 'the tenant row and version are unchanged');
    assert.equal(await idempotencyRecordCount(), idemBefore, 'no idempotency record exists for the refused attempts');
  });
});

test('M6EP-12: a tenant/store cookie cannot enter the admin boundary', async () => {
  await withEntry({}, async (ctx) => {
    const rig = createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
      ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 2, idle_timeout: 0, ...CLIENT_OPTS, user: RUNTIME_LOGIN,
    });
    try {
      const store = createPostgresSessionStore({ client: rig });
      const id = randomBytes(32).toString('base64url');
      const key = createHash('sha256').update(id).digest('base64url');
      const uid = `m6ep12-tenant-${SUFFIX}`;
      const principal = { authProvider: 'firebase', authProviderUid: uid };
      const t = Date.now();
      await store.create(key, {
        audience: 'tenant', authProvider: 'firebase', authProviderUid: uid, principalKey: principalKeyOf(principal),
        securityVersion: 'v1', authenticatedAt: null, createdAt: t, lastSeenAt: t, validatedAt: t,
      }, AbortSignal.timeout(10_000));

      const asTenantCookie = await ctx.req('GET', TENANT_DIRECTORY_PATH, { cookie: `${SESSION_COOKIES.tenant}=${id}` });
      assert.equal(asTenantCookie.status, 401, 'the admin boundary never reads the tenant cookie name');
      const asAdminCookie = await ctx.req('GET', TENANT_DIRECTORY_PATH, { cookie: `${SESSION_COOKIES.admin}=${id}` });
      assert.equal(asAdminCookie.status, 401, 'the same identifier under the admin name: audience mismatch');

      const storeTenant = await newTenant('m6ep12-store');
      const [{ store_id: storeId }] = await owner`insert into store (tenant_id, store_name) values (${storeTenant}, ${`m6ep12-store-${SUFFIX}`}) returning store_id`;
      const storeActor = await actor('m6ep12-store', [{ scope: 'store', tenant: storeTenant, store: storeId, role: 'manager' }]);
      assert.equal((await ctx.login(storeActor.token)).status, 401, 'a store-scope actor cannot log in on the admin boundary');
    } finally {
      await rig.end();
    }
  });
});

test('M6EP-16: database outage opens no listener', async () => {
  const deadDir = mkdtempSync(join(tmpdir(), 'tmpos-m6ep-dead-'));
  const cap = makeCapture();
  const ends = { calls: 0, completed: 0 };
  const bindSpy = spyOnBind();
  try {
    const construction = {
      databaseClient: () => recordingEnd(createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
        ...runtimeClientOptions(TARGET_DSN), ssl: false, max: MAX_POOLS, idle_timeout: 0, host: deadDir, port: 5432, user: RUNTIME_LOGIN,
      }), ends),
      tokenVerifier: VERIFIER,
      listen: () => ({ port: 0, host: '127.0.0.1' }),
    };
    const started = Date.now();
    const result = await startProductionEntry({ env: baseEnv(), construction, proc: cap.proc, exit: cap.exit, log: cap.log });
    const elapsed = Date.now() - started;
    assert.equal(result.outcome, 'refused');
    assert.equal(result.failure, 'database_unavailable');
    assert.equal(result.address, null);
    assert.deepEqual(cap.codes, [1]);
    assert.ok(cap.lines.some((l) => { try { const r = JSON.parse(l); return r.event === 'startup_refused' && r.reason === 'database_unavailable'; } catch { return false; } }));
    assert.ok(elapsed < STARTUP_STEP_DEADLINE_MS, `well under the deadline: ${elapsed} ms`);
    assert.equal(bindSpy.count(), 0, 'no real bind attempt on a refused startup: address === null alone is not proof');
    assert.deepEqual(ends, { calls: 1, completed: 1 }, "the refusal ended the entry's own database client exactly once, and it completed");
  } finally {
    bindSpy.restore();
    await ensureShutdown(cap);
    rmSync(deadDir, { recursive: true, force: true });
  }
});

test('M6EP-18: after startup, taking the store down fails closed; restoring resumes service', async () => {
  await withEntry({}, async (ctx) => {
    const admin = await actor('m6ep18', [{ scope: 'platform', role: 'system_owner' }]);
    const session = await signIn(ctx, admin);
    assert.equal((await ctx.req('GET', '/readiness')).status, 200);

    await storeDown(ctx.relay);
    await delay(PROBE_REUSE_WAIT_MS);
    assert.equal((await ctx.req('GET', '/readiness')).status, 503);
    assert.equal((await ctx.req('GET', TENANT_DIRECTORY_PATH, { cookie: session.cookie })).status, 503);
    const s = surface(ctx, session);
    const patch = await s.rename({ tenantId: randomUUID(), displayName: 'x', expectedVersion: 1 });
    assert.equal(patch.status, 503);
    assert.equal((await ctx.req('GET', '/health')).status, 200, 'still alive and prompt');

    await ctx.relay.restore();
    assert.ok(await waitReady(ctx), 'readiness returns to 200 after the probe reuse window');
    assert.equal((await ctx.req('GET', TENANT_DIRECTORY_PATH, { cookie: session.cookie })).status, 200, 'the protected route answers again');
  });
});

test('M6EP-19: shutdown closes the listener and ends the database client', async () => {
  const relay = startRelay();
  await relay.listening;
  const cap = makeCapture();
  const buildReal = databaseClientOver(relay);
  const ends = { calls: 0, completed: 0 };
  const construction = {
    databaseClient: (endpoint) => recordingEnd(buildReal(endpoint), ends),
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  try {
    const result = await startProductionEntry({ env: baseEnv(), construction, proc: cap.proc, exit: cap.exit, log: cap.log });
    assert.equal(result.outcome, 'listening', JSON.stringify(result));
    const port = result.address.port;

    cap.proc.emit('SIGTERM');
    await waitFor(() => cap.codes.length > 0, 5_000);
    cap.proc.emit('SIGTERM'); // repeated signal: one shutdown
    await delay(100);
    assert.deepEqual(cap.codes, [0], 'exit was called exactly once, with 0');
    assert.deepEqual(ends, { calls: 1, completed: 1 }, "the entry's own database client end() was called exactly once and completed");

    await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); reject(new Error('connected after shutdown')); });
      s.on('error', () => resolve());
    });
    assert.equal(relay.state.pairs.size, 0, 'the relay holds no open pairs');
  } finally {
    await ensureShutdown(cap);
    await relay.close().catch(() => {});
  }
});

test('M6EP-20: a signal during preflight exits without ever binding', async () => {
  const stallDir = mkdtempSync(join(tmpdir(), 'tmpos-m6ep-stall-'));
  const stallSockets = new Set();
  const stallServer = net.createServer((socket) => { // accepts, never answers
    socket.on('error', () => {});
    stallSockets.add(socket);
    socket.on('close', () => stallSockets.delete(socket));
  });
  await new Promise((resolve) => stallServer.listen(join(stallDir, '.s.PGSQL.5432'), resolve));
  const cap = makeCapture();
  const ends = { calls: 0, completed: 0 };
  const bindSpy = spyOnBind();
  try {
    const construction = {
      databaseClient: () => recordingEnd(createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
        ...runtimeClientOptions(TARGET_DSN), ssl: false, max: MAX_POOLS, idle_timeout: 0, host: stallDir, port: 5432, user: RUNTIME_LOGIN,
      }), ends),
      tokenVerifier: VERIFIER,
      listen: () => ({ port: 0, host: '127.0.0.1' }),
    };
    const pending = startProductionEntry({ env: baseEnv(), construction, proc: cap.proc, exit: cap.exit, log: cap.log });
    // The connect step's own socket, accepted and never answered: the signal lands inside preflight, never before it.
    await waitFor(() => stallSockets.size > 0, 5_000);
    cap.proc.emit('SIGTERM');
    const result = await pending;
    assert.equal(result.outcome, 'interrupted');
    assert.equal(result.address, null);
    // The outcome can resolve before the lifecycle's own shutdown hooks (ending the kernel) finish: wait for exit.
    await waitFor(() => cap.codes.length > 0, 5_000);
    assert.deepEqual(cap.codes, [0]);
    assert.ok(!cap.lines.some((l) => { try { return JSON.parse(l).event === 'startup_ready'; } catch { return false; } }), 'no startup_ready log');
    assert.equal(bindSpy.count(), 0, 'no real bind attempt while the connect step was stalled: address === null alone is not proof');
    assert.deepEqual(ends, { calls: 1, completed: 1 }, "the interrupt ended the entry's own database client exactly once, and it completed");
  } finally {
    bindSpy.restore();
    await ensureShutdown(cap);
    for (const socket of [...stallSockets]) socket.destroy();
    await new Promise((resolve) => stallServer.close(resolve));
    rmSync(stallDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// step-up and reauthentication (M5-ADMIN-STEPUP-P1)
// ---------------------------------------------------------------------------

/** The durable record's key: the SHA-256 of the cookie's identifier (sessions.ts digestOf), never the identifier. */
const sessionKeyOf = (session) =>
  createHash('sha256').update(session.cookie.slice(session.cookie.indexOf('=') + 1)).digest('base64url');
const authenticatedAtOf = async (session) =>
  (await owner`select authenticated_at from tmpos_session.session where session_key = ${sessionKeyOf(session)}`)[0]?.authenticated_at ?? null;

/**
 * Stand in for time passing since the administrator signed in: the session's bound provider authentication is set
 * `ageMs` into the past, through the owner. The real clock runs on, so the chain and the transaction judge it as is.
 */
async function ageAuthentication(session, ageMs) {
  const rows = await owner`update tmpos_session.session set authenticated_at = ${Date.now() - ageMs}
    where session_key = ${sessionKeyOf(session)} returning session_key`;
  assert.equal(rows.length, 1, 'exactly the one session aged');
}

/** A reauthentication: the ordinary admin login presenting `session`'s cookie, with the opt-in header. */
const reauthenticate = (ctx, token, session) =>
  ctx.login(token, { cookie: session.cookie, [REAUTHENTICATE_HEADER]: REAUTHENTICATE_VALUE });

function assertStepUp(reply, label) {
  assert.equal(reply.status, 403, `${label}: ${reply.body}`);
  assert.equal(JSON.parse(reply.body).error, 'step_up_required', label);
}

test('M6EP-21: a stale session is refused step_up_required; a same-administrator reauthentication lets a NEW command succeed and the old cookie cannot', async () => {
  await withEntry({}, async (ctx) => {
    const admin = await actor('m6ep21', [{ scope: 'platform', role: 'system_owner' }]);
    const tenant = await newTenant('m6ep21');
    const old = await signIn(ctx, admin);
    await ageAuthentication(old, RECENT_AUTH_MAX_AGE_MS + 60_000);
    const records = await idempotencyRecordCount();
    const refused = await surface(ctx, old).status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 });
    assertStepUp(refused, 'the stale session');
    assert.deepEqual(await tenantRow(tenant), { display_name: `m6ep-m6ep21-${SUFFIX}`, status: 'active', row_version: '1' }, 'the tenant is unchanged');
    assert.equal(await idempotencyRecordCount(), records, 'the refusal reserved no idempotency record');

    const renewedReply = await reauthenticate(ctx, admin.token, old);
    assert.equal(renewedReply.status, 200, renewedReply.body);
    const renewed = {
      cookie: renewedReply.headers['set-cookie'][0].split('; ')[0], csrf: JSON.parse(renewedReply.body).csrfToken,
    };
    assert.notEqual(renewed.cookie, old.cookie, 'a fresh session identifier');
    assert.notEqual(renewed.csrf, old.csrf, 'and its own CSRF token');
    assert.ok(Date.now() - Number(await authenticatedAtOf(renewed)) < 60_000, 'the new record carries the new sign-in\'s time');
    assert.equal(await authenticatedAtOf(old), null, 'the superseded record is gone, never updated');

    // The old cookie cannot borrow the new evidence: it is no session at all.
    assert.equal((await ctx.req('GET', sessionPaths('admin').current, { cookie: old.cookie })).status, 401);
    const oldAttempt = await surface(ctx, old).status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 });
    assert.equal(oldAttempt.status, 401, oldAttempt.body);
    assert.deepEqual(await tenantRow(tenant), { display_name: `m6ep-m6ep21-${SUFFIX}`, status: 'active', row_version: '1' }, 'still unchanged');

    // A newly sent command — a new Idempotency-Key, the version just read, a newly entered reason — succeeds.
    const current = await listed(ctx, renewed, tenant);
    const suspended = await surface(ctx, renewed).status({
      tenantId: tenant, status: 'suspended', reason: 'Confirmed again after a recent sign-in.', expectedVersion: current.version,
    });
    assert.equal(suspended.status, 200, suspended.body);
    assert.deepEqual(JSON.parse(suspended.body), { tenantId: tenant, status: 'suspended', version: 2 });
    assert.deepEqual(await tenantRow(tenant), { display_name: `m6ep-m6ep21-${SUFFIX}`, status: 'suspended', row_version: '2' });
  });
});

test('M6EP-22: a DIFFERENT administrator\'s reauthentication is a 401 that changes nothing; the first session stays stale', async () => {
  await withEntry({}, async (ctx) => {
    const first = await actor('m6ep22-first', [{ scope: 'platform', role: 'system_owner' }]);
    const second = await actor('m6ep22-second', [{ scope: 'platform', role: 'system_owner' }]);
    const tenant = await newTenant('m6ep22');
    const session = await signIn(ctx, first);
    await ageAuthentication(session, RECENT_AUTH_MAX_AGE_MS + 60_000);
    const aged = await authenticatedAtOf(session);
    const reply = await reauthenticate(ctx, second.token, session);
    assert.equal(reply.status, 401, reply.body);
    assert.equal(JSON.parse(reply.body).error, 'unauthenticated');
    assert.equal(reply.headers['set-cookie'], undefined, 'no session is issued to the second administrator');
    assert.equal(await authenticatedAtOf(session), aged, 'the first administrator\'s record is exactly as it was');
    assert.equal((await ctx.req('GET', sessionPaths('admin').current, { cookie: session.cookie })).status, 200, 'and still active');
    assertStepUp(await surface(ctx, session).status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 }),
      'the first session after the refused reauthentication');
    assert.deepEqual(await tenantRow(tenant), { display_name: `m6ep-m6ep22-${SUFFIX}`, status: 'active', row_version: '1' }, 'the tenant is unchanged');
  });
});

// This proves the admin login auth-age policy (applied by the chain before the login handler), not the reauthentication
// guard: there is no new evidence without a new sign-in, whatever header the login carries.
test('M6EP-23: no new evidence without a new sign-in — a refreshed token is refused by the login auth-age policy; the stale session still cannot change the tenant', async () => {
  await withEntry({}, async (ctx) => {
    const admin = await actor('m6ep23', [{ scope: 'platform', role: 'system_owner' }]);
    const tenant = await newTenant('m6ep23');
    const session = await signIn(ctx, admin);
    await ageAuthentication(session, RECENT_AUTH_MAX_AGE_MS + 60_000);
    const aged = await authenticatedAtOf(session);
    const refreshed = `${admin.token}-refreshed`;
    TOKENS.set(refreshed, { uid: admin.uid, authAgeSec: 6 * 60 }); // auth_time six minutes old: past the admin login's five
    const reply = await reauthenticate(ctx, refreshed, session);
    assert.equal(reply.status, 401, reply.body);
    assert.equal(reply.headers['set-cookie'], undefined);
    assert.equal(await authenticatedAtOf(session), aged, 'no evidence was carried into the session');
    assertStepUp(await surface(ctx, session).status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 }),
      'the stale session after the refreshed-token attempt');
    assert.deepEqual(await tenantRow(tenant), { display_name: `m6ep-m6ep23-${SUFFIX}`, status: 'active', row_version: '1' }, 'the tenant is unchanged');
  });
});

test('M6EP-FORCED: a hung client.end() forces shutdown at the deadline, never before it, exactly once', async () => {
  const relay = startRelay();
  await relay.listening;
  let realClient = null;
  const cap = makeCapture();
  const buildReal = databaseClientOver(relay);
  const forceTimeoutMs = 1_500;
  const construction = {
    databaseClient: (endpoint) => {
      realClient = buildReal(endpoint);
      return { transaction: (...args) => realClient.transaction(...args), end: () => new Promise(() => {}) };
    },
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  try {
    const result = await startProductionEntry({ env: baseEnv(), construction, proc: cap.proc, exit: cap.exit, log: cap.log, forceTimeoutMs });
    assert.equal(result.outcome, 'listening', JSON.stringify(result));
    const signalled = Date.now();
    cap.proc.emit('SIGTERM');
    await waitFor(() => cap.codes.length > 0, 5_000);
    const elapsed = Date.now() - signalled;
    assert.ok(elapsed >= forceTimeoutMs - 50, `forced only at the deadline, never before it: ${elapsed} ms`);
    assert.deepEqual(cap.codes, [1], 'exit was forced exactly once, with 1');
    assert.ok(cap.lines.some((l) => { try { return JSON.parse(l).event === 'shutdown_forced'; } catch { return false; } }));
  } finally {
    await ensureShutdown(cap); // an early failure must not leave the listener up: the hung end() is forced out at the deadline
    if (realClient !== null) await realClient.end().catch(() => {});
    await relay.restore().catch(() => {});
    await relay.close().catch(() => {});
  }
});

test('M6EP-TLS: verified TLS over the plaintext cluster refuses — the driver never falls back to plaintext', async () => {
  const cap = makeCapture();
  const bindSpy = spyOnBind();
  let client = null;
  const ends = { calls: 0, completed: 0 };
  const construction = {
    databaseClient: () => {
      client = createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
        ...runtimeClientOptions(TARGET_DSN), ssl: { ca: tls.rootCertificates[0], rejectUnauthorized: true },
        ...CLIENT_OPTS, user: RUNTIME_LOGIN,
      });
      return recordingEnd(client, ends);
    },
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  try {
    const result = await startProductionEntry({ env: baseEnv(), construction, proc: cap.proc, exit: cap.exit, log: cap.log });
    assert.equal(result.outcome, 'refused', JSON.stringify(result));
    assert.equal(result.failure, 'database_unavailable');
    assert.equal(result.address, null);
    assert.deepEqual(cap.codes, [1]);
    assert.equal(bindSpy.count(), 0, 'no real bind attempt on a refused startup: address === null alone is not proof');
    assert.deepEqual(ends, { calls: 1, completed: 1 }, "the refusal ended the entry's own database client exactly once, and it completed");
  } finally {
    bindSpy.restore();
    await ensureShutdown(cap);
    if (client !== null) await client.end().catch(() => {});
  }
});

test('M6EP-SECRETS: no captured log line from any test contains a configuration value', () => {
  const forbidden = [
    'synthetic-pw',
    CANONICAL_RATE_KEY.toString('base64url'),
    CANONICAL_IDEMPOTENCY_KEY.toString('base64url'),
    // The private key's body, excluding the PEM boilerplate lines themselves.
    ...FIREBASE_PRIVATE_KEY.split('\n').filter((line) => line.length > 20 && !line.startsWith('-----')),
  ];
  assert.ok(ALL_LOG_LINES.length > 0, 'log lines were actually captured across the suite');
  for (const line of ALL_LOG_LINES) {
    for (const needle of forbidden) {
      assert.ok(!line.includes(needle), `a log line leaked a configuration value: ${needle.slice(0, 16)}...`);
    }
  }
});
