// M7A-CUSTOMERS-P2 — THE TENANT ENTRY, END TO END: startTenantEntry (server/entry/tenantEntry.ts) composing the tenant
// transaction root and the tenant session boundary alone, over REAL loopback HTTP and a disposable PostgreSQL, exactly as
// server/entry/tenantMain.ts would but for its construction — and M7TE-C1 runs the COMPILED entry (tsconfig.server.tenant.json)
// the same way.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY. Three things, none of them on the path under test (as the administrative suite,
// tests/db/productionEntry.integration.test.mjs):
//   * THE DATABASE CLIENT. `construction.databaseClient` ignores the classified endpoint it is handed and returns instead a
//     supervised kernel over the disposable cluster, as a non-owner least-privilege runtime LOGIN (tmpos_m7te_probe, holding
//     tmpos_app and tmpos_audit_writer and nothing else), through a byte relay so the store can be taken down.
//   * THE IDENTITY VERIFIER. `construction.tokenVerifier` is a synthetic bearer-token map: a known token answers
//     { uid, authTime: now, secondFactor: 'totp' }, an unknown one throws.
//   * THE LISTENER. `construction.listen` always binds 127.0.0.1:0, whatever PORT names.
// The owner installs the tenant issuer key (migration 018) — 32 bytes made in this process, never written anywhere — and the
// entry is configured with its base64url. Everything else — configuration, composition, the startup preflight (connect, the
// login, the ledger, parameter logging, the issuer key, the limiter key), the route table, the host lock, the session and
// authorization chain, the customer read, readiness and shutdown — is production's own code, unmodified. The hosts are
// synthetic (tenant.tmpos.test, admin.tmpos.test) and nothing leaves the loopback interface.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. On a shared service it removes its own
// customer, session and mint-ledger rows, restores the limiter's fingerprint, the issuer key row it found (or its absence)
// and every grant, ledger row and setting a test changes, and drops its login. What it leaves is what every suite leaves:
// its synthetically named identities, tenants and store, and the approved PUBLIC revokes every suite establishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import tls from 'node:tls';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriverVia, childEnv } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { tenantMintProof } from '../../server/persistence/postgresSessionStore.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry, TENANT_SHIPPING_ROUTES } from '../../server/entry/tenantEntry.ts';
import { principalKeyOf, SESSION_COOKIES, SESSION_TTL } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { CUSTOMER_DIRECTORY_PATH, decodeCustomerCursor, encodeCustomerCursor } from '../../server/runtime/customerDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7te-migrator', runtimeRef: 'm7te-runtime' };
const LOCK_KEY = 528_523;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7te_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** app.ts PROBE_REUSE_MS (1 s, not exported) and a margin: a readiness probe is reused for that long. */
const PROBE_REUSE_WAIT_MS = 1_100;
const V2 = 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)';
/** The routines the tenant entry's other readiness probes call as the login: 018's mint, 011's session read, 016's admission. */
const MINT = 'tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)';
const SESSION_GET = 'tmpos_session.m5_session_get(text, bigint)';
const ADMIT = 'tmpos_session.m5_admit_tenant_session_v2(text, text)';

// ---------------------------------------------------------------------------
// cluster lifecycle (mirrors tests/db/productionEntry.integration.test.mjs)
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M7TE');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

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
const owner = testClient(TARGET, { max: 3, onnotice: () => {} });

const DROP_RUNTIME_LOGIN = `do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then
    perform pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = '${RUNTIME_LOGIN}';
    drop owned by ${RUNTIME_LOGIN};
    drop role ${RUNTIME_LOGIN};
  end if;
end $$;`;

/** Every provider reference, tenant and session store key this suite creates: what teardown removes rows of. */
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
/** The registered rate-limit key fingerprint before this suite touched it: undefined until taken, then the row or null. */
let rateLimitFingerprintBefore;
async function fingerprintRow() {
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  return rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
}
/** The tenant issuer key row before this suite installed its own: undefined until taken, then its bytes or null. Never printed. */
let issuerKeyBefore;
async function issuerKeyRow() {
  const rows = await owner`select key from tmpos_mint.issuer_key where singleton`;
  return rows.length === 0 ? null : Buffer.from(rows[0].key);
}
/** The fingerprint this suite registers (its RATE_LIMIT_KEY's), put back after each test that replaced it. */
const registerFingerprint = (key) => owner.begin(async (sql) => {
  await sql`delete from tmpos_rate_limit.key_fingerprint`;
  await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(key)})`;
});

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    // 016's up/down refuse while a tenant session exists, 017's down while a customer row does, 018's while a ledger row does.
    if (TENANTS.length > 0) await step(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
    if (UIDS.length > 0) {
      await step(async () => {
        for (const row of await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`) KEYS.add(row.session_key);
      });
    }
    if (KEYS.size > 0) await step(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
    if (UIDS.length > 0) await step(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
    await step(() => owner.unsafe(DROP_RUNTIME_LOGIN));
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
    if (issuerKeyBefore !== undefined) {
      await step(async () => {
        await owner.begin(async (sql) => {
          await sql`delete from tmpos_mint.issuer_key where singleton`;
          if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
        });
        const after = await issuerKeyRow();
        // Compared, never printed: the message names no byte of either key.
        assert.ok(after === null ? issuerKeyBefore === null : issuerKeyBefore !== null && after.equals(issuerKeyBefore),
          'the issuer key row this suite found is restored exactly');
      });
    }
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M7TE teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'M7TE setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster, so the store can be taken down
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket'
    ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) }
    : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m7te-relay-'));
  const pairs = new Set();
  const state = { closes: 0, pairs };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); } };
    pairs.add(pair);
    client.pipe(db);
    db.pipe(client);
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

/** End every runtime-login backend, so the kernel's next transaction opens a new session (and reads new role settings). */
async function endLoginSessions() {
  await owner`select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`;
}

/** Take the store down the way a server does: refuse new connections and end every runtime session. */
async function storeDown(relay) {
  const open = relay.state.pairs.size;
  const closedBefore = relay.state.closes;
  const drained = relay.refuse();
  await endLoginSessions();
  const deadline = Date.now() + 5_000;
  while (relay.state.closes - closedBefore < open) {
    if (Date.now() > deadline) throw new Error('the runtime sessions did not end within 5 s');
    await delay(5);
  }
  await drained;
}

/**
 * A production-shaped database client factory bound to one relay, from `kernelModule`; the classified endpoint is ignored.
 * The driver dials the relay's socket through the harness (testDriverVia); the relay forwards only to TARGET.
 */
function databaseClientOver(relay, kernelModule = { createSupervisedPgClient, MAX_POOLS, runtimeClientOptions }) {
  return (_endpoint) => kernelModule.createSupervisedPgClient(testDriverVia(TARGET, relay.dir), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...kernelModule.runtimeClientOptions(TARGET_DSN), ssl: false, max: kernelModule.MAX_POOLS, idle_timeout: 0,
    onclose: () => { relay.state.closes += 1; },
    user: RUNTIME_LOGIN,
  });
}

// ---------------------------------------------------------------------------
// setup: real migrations 001-018, a real non-owner least-privilege runtime login, the issuer key and the limiter key
// ---------------------------------------------------------------------------

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

await setupStep(async () => {
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  // G-DBROLE provisioning (not a migration): the ledger read the startup preflight requires of the runtime login.
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
});

/** Made in this process, never written anywhere: the limiter's key and the tenant issuer key (a fresh key is not weak). */
const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);

await setupStep(async () => {
  rateLimitFingerprintBefore = await fingerprintRow();
  await registerFingerprint(RATE_KEY);
  issuerKeyBefore = await issuerKeyRow();
  await installTestIssuerKey(owner, ISSUER_KEY);
});

// ---------------------------------------------------------------------------
// the synthetic identity provider and configuration every entry starts from
// ---------------------------------------------------------------------------

const TOKENS = new Map(); // bearer token -> { uid }
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) {
      const err = new Error('unknown_token');
      err.code = 'auth/invalid-id-token';
      throw err;
    }
    return { uid: rec.uid, authTime: Math.floor(Date.now() / 1000), secondFactor: 'totp' };
  },
});

const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const FIREBASE_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'm7te-test-project',
  client_email: 'm7te-test@m7te-test-project.iam.gserviceaccount.com',
  private_key: FIREBASE_PRIVATE_KEY,
});

function baseEnv(overrides = {}) {
  const env = {
    NODE_ENV: 'production',
    PORT: '8443',
    APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
    DATABASE_CA_CERT: tls.rootCertificates[0],
    RATE_LIMIT_KEY: RATE_KEY.toString('base64url'),
    TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
    SESSION_ADMIN_ORIGINS: ADMIN_ORIGIN,
    SESSION_TENANT_ORIGINS: TENANT_ORIGIN,
    TENANT_SESSION_ISSUER_KEY: ISSUER_KEY.toString('base64url'),
    FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: FIREBASE_JSON,
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return Object.freeze(env);
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

/** Every captured log line, across every test in this file — for the M7TE-11 check at the end. */
const ALL_LOG_LINES = [];
/** Every secret-shaped value the suite handles: none may reach a log line. */
const SECRETS = new Set();

function makeCapture() {
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const log = { log: (line) => { lines.push(line); ALL_LOG_LINES.push(line); } };
  const exit = (code) => { codes.push(code); };
  return { lines, codes, proc, log, exit };
}

function sendReq(port, method, path, headers = {}, localAddress) {
  const framed = { ...(method === 'GET' ? {} : { 'content-length': '0' }), ...headers };
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
    request.end();
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

/** A refusal is the fixed `{ error, requestId }` and nothing else, and never sets a cookie. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  const cookies = reply.setCookies ?? reply.headers['set-cookie'];
  assert.ok(cookies === undefined || cookies.length === 0, `${label}: no Set-Cookie`);
}
const assertBounded404 = (reply, label) => assertRefusal(reply, 404, 'not_found', label);

/** The composed table in a canonical, order-independent form, for a deep-equal against TENANT_SHIPPING_ROUTES. */
function canonical(routes) {
  return [...routes].map((r) => `${r.method} ${r.path} ${r.access} ${r.body} ${r.idempotency}`).sort();
}

/** Wraps net.Server.prototype.listen so a real bind attempt is proven, not inferred; always restore. */
function spyOnBind() {
  const original = net.Server.prototype.listen;
  let attempts = 0;
  net.Server.prototype.listen = function spiedListen(...args) {
    attempts += 1;
    return original.apply(this, args);
  };
  return { count: () => attempts, restore: () => { net.Server.prototype.listen = original; } };
}

/** A built client whose end() is counted — `calls` when invoked, `completed` once it resolved. */
function recordingEnd(real, ends) {
  return {
    transaction: (...args) => real.transaction(...args),
    end: async () => { ends.calls += 1; await real.end(); ends.completed += 1; },
  };
}

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
  const uid = `m7te-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  UIDS.push(uid);
  SECRETS.add(token).add(uid).add(id);
  return { id, uid, token, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });

async function newTenant(label, status = 'active') {
  const name = `m7te-${label}-${SUFFIX}`;
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${name}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  SECRETS.add(id).add(name);
  return id;
}

/** Insert customers for `tenant` as the owner. Answers [{ id, name }]; every id and name is a secret to the logs. */
async function seed(tenant, names) {
  const rows = names.map((name) => ({ customer_id: randomUUID(), tenant_id: tenant, name }));
  await owner`insert into tmpos_customer.customer ${owner(rows, 'customer_id', 'tenant_id', 'name')}`;
  for (const r of rows) SECRETS.add(r.customer_id).add(r.name);
  return rows.map((r) => ({ id: r.customer_id, name: r.name }));
}
/** The page order the contract promises: UTF-8 byte order of the name, then the uuid — computed here, not by the database. */
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const T_A = await setupStep(() => newTenant('a'));
const T_B = await setupStep(() => newTenant('b'));
const T_RO = await setupStep(() => newTenant('read-only', 'read_only'));
const STORE_A = await setupStep(async () =>
  (await owner`insert into store (tenant_id, store_name, status) values (${T_A}, ${`m7te-store-a-${SUFFIX}`}, 'active') returning store_id`)[0].store_id);
const SEED_A = (await setupStep(() => seed(T_A, [`Élan ${SUFFIX}`, `elan ${SUFFIX}`, `Same ${SUFFIX}`, `Same ${SUFFIX}`, `Ａcme ${SUFFIX}`,
  `\u{1F600} Smile ${SUFFIX}`, `Zed ${SUFFIX}`]))).sort(byteOrder);
const SEED_B = (await setupStep(() => seed(T_B, Array.from({ length: 60 }, (_, i) => `B ${String(i).padStart(3, '0')} ${SUFFIX}`)))).sort(byteOrder);
const SEED_RO = (await setupStep(() => seed(T_RO, [`Ro one ${SUFFIX}`, `Ro two ${SUFFIX}`]))).sort(byteOrder);

/** The store key of the session a cookie presents: the SHA-256 of its identifier, as the chain computes it. */
const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
/** Records a fresh sign-in's identifier, store key and mint proof (read back before any request touches the row) as secrets. */
async function noteSession(cookie) {
  const key = keyOf(cookie);
  KEYS.add(key);
  SECRETS.add(cookie.slice(cookie.indexOf('=') + 1)).add(key);
  const [row] = await owner`select audience, auth_provider, auth_provider_uid, principal_key, security_version, authenticated_at,
      created_at, last_seen_at, validated_at, expires_at from tmpos_session.session where session_key = ${key}`;
  assert.equal(row?.audience, 'tenant', 'the sign-in wrote one tenant session row');
  const proof = tenantMintProof(ISSUER_KEY, key, {
    audience: row.audience, authProvider: row.auth_provider, authProviderUid: row.auth_provider_uid, principalKey: row.principal_key,
    securityVersion: row.security_version, authenticatedAt: row.authenticated_at === null ? null : Number(row.authenticated_at),
    createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at), validatedAt: Number(row.validated_at),
  }, Number(row.expires_at));
  for (const encoding of ['hex', 'base64', 'base64url']) SECRETS.add(proof.toString(encoding));
}

/**
 * An administrative session row, live and well formed, minted as the runtime login through 018's admin branch (which takes
 * no proof, DA-37): the identifier a cookie would carry.
 */
async function adminSessionId(who) {
  const id = randomBytes(32).toString('base64url');
  const key = createHash('sha256').update(id).digest('base64url');
  KEYS.add(key);
  SECRETS.add(id).add(key);
  const runtime = testClient(TARGET, { user: RUNTIME_LOGIN, max: 1, onnotice: () => {} });
  try {
    const at = Date.now();
    const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, 'admin'::text, 'firebase'::text,
      ${who.uid}::text, ${principalKeyOf(who.principal)}::text, 'm7te-admin'::text, ${at}::bigint, ${at}::bigint, ${at}::bigint,
      ${at}::bigint, ${at + SESSION_TTL.admin.absoluteMs}::bigint, null::bytea) as outcome`;
    assert.equal(outcome, 'created', 'an administrative row exists to be presented');
  } finally {
    await runtime.end({ timeout: 5 });
  }
  return id;
}

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

/**
 * Start one tenant entry over its own relay — the source entry, or `start` (M7TE-C1's compiled one) — hand the test a bound
 * request surface, then stop it.
 */
async function withEntry(overrides, fn) {
  const relay = startRelay();
  await relay.listening;
  const clientAddress = randomLoopback();
  const cap = makeCapture();
  const ends = { calls: 0, completed: 0 };
  let built = 0;
  const buildClient = databaseClientOver(relay, overrides.kernelModule);
  const construction = {
    databaseClient: (endpoint) => { built += 1; return recordingEnd(buildClient(endpoint), ends); },
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  const bindSpy = spyOnBind();
  let result;
  try {
    result = await (overrides.start ?? startTenantEntry)({
      env: baseEnv(overrides.env ?? {}), construction, proc: cap.proc, exit: cap.exit, log: cap.log,
    });
  } finally {
    bindSpy.restore();
  }
  const port = result.address?.port ?? null;
  const ctx = {
    result, cap, relay, ends, port, clientAddress, bindAttempts: bindSpy.count(), clientsBuilt: () => built,
    req: (method, path, headers = {}) => sendReq(port, method, path, { host: TENANT_HOST, ...headers }, clientAddress),
    raw: (text) => rawRequest(port, text, { localAddress: clientAddress }),
    login: (who, extra = {}) => sendReq(port, 'POST', sessionPaths('tenant').login, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      authorization: `Bearer ${who.token}`, ...extra,
    }, clientAddress),
  };
  try {
    return await fn(ctx);
  } finally {
    await ensureShutdown(cap);
    await relay.restore().catch(() => {});
    await relay.close().catch(() => {});
  }
}

async function signIn(ctx, who) {
  const reply = await ctx.login(who);
  assert.equal(reply.status, 200, `login ${who.uid}: ${reply.body}`);
  const setCookie = (reply.headers['set-cookie'] ?? [''])[0];
  const cookie = setCookie.split('; ')[0];
  await noteSession(cookie);
  SECRETS.add(JSON.parse(reply.body).csrfToken);
  return { cookie, setCookie };
}

const list = (ctx, cookie, query = '') => {
  for (const m of query.matchAll(/cursor=([^&]*)/g)) if (m[1].length >= 16) SECRETS.add(m[1]); // a cursor, not a malformed probe like 'abc'
  return ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}${query}`, cookie === null ? {} : { cookie });
};

/** A page body: exactly { customers: [{ id, name }], nextCursor }. Answers it. */
function pageOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['customers', 'nextCursor'], label);
  for (const c of body.customers) assert.deepEqual(Object.keys(c), ['id', 'name'], label);
  if (body.nextCursor !== null) {
    SECRETS.add(body.nextCursor);
    assert.equal(decodeCustomerCursor(body.nextCursor), body.customers.at(-1).id, `${label}: the cursor names the last customer`);
  }
  return body;
}

/** Every page of a walk at `limit`, following nextCursor. */
async function walk(ctx, cookie, limit) {
  const pages = [];
  let query = `?limit=${limit}`;
  for (let guard = 0; guard < 100; guard++) {
    const body = pageOf(await list(ctx, cookie, query), `walk page ${pages.length + 1}`);
    pages.push(body.customers);
    if (body.nextCursor === null) return pages;
    query = `?limit=${limit}&cursor=${body.nextCursor}`;
  }
  throw new Error('walk did not end');
}

/** The refusal reason the runtime logged for one reply. */
function reasonOf(ctx, reply) {
  const lines = ctx.cap.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id']);
  assert.equal(lines.length, 1, 'exactly one log line for the request');
  return lines[0].reason ?? '-';
}

async function readinessUntil(ctx, status, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ctx.req('GET', '/readiness')).status === status) return true;
    await delay(200);
  }
  return false;
}

/** Readiness stays `status` across three reuse windows: the dependency, not a transient reconnect, decides it. */
async function readinessHolds(ctx, status) {
  for (let i = 0; i < 3; i++) {
    await delay(PROBE_REUSE_WAIT_MS);
    assert.equal((await ctx.req('GET', '/readiness')).status, status, `readiness ${status} after ${i + 1} reuse window(s)`);
  }
}

/** `fn`'s ACL, one sorted line per entry: grantor, grantee (0 is PUBLIC), privilege and grant option. */
async function aclOf(fn) {
  const rows = await owner`select a.grantor::regrole::text as grantor, a.grantee::text as grantee, a.privilege_type as privilege,
      a.is_grantable as grantable
    from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) a where p.oid = pg_catalog.to_regprocedure(${fn})`;
  return rows.map((r) => `${r.grantor}>${r.grantee}:${r.privilege}:${r.grantable}`).sort();
}

/**
 * EXECUTE on `fn` withdrawn from tmpos_app while `work` runs, then granted back as the migration granted it — and the
 * routine's ACL proved exactly as found, whether or not `work` failed.
 */
async function withoutExecute(fn, work) {
  const before = await aclOf(fn);
  assert.ok(before.length > 0, `${fn}: an ACL to restore`);
  try {
    await owner.unsafe(`revoke execute on function ${fn} from tmpos_app`);
    await work();
  } finally {
    await owner.unsafe(`grant execute on function ${fn} to tmpos_app`);
    assert.deepEqual(await aclOf(fn), before, `${fn}: EXECUTE restored exactly`);
  }
}

/**
 * CX-T3: the tenant host in another letter case is the same authority — the runtime lowercases Host (app.ts) — so the login
 * and the read are served, with only the caller's `rows`; with a trailing dot it is another authority: the bounded 404, both.
 */
async function assertHostSpellings(ctx, who, rows, label) {
  const loginText = (host) => `POST ${sessionPaths('tenant').login} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${TENANT_ORIGIN}\r\n`
    + `Sec-Fetch-Site: same-origin\r\n${CSRF_HEADER}: ${CSRF_HEADER_VALUE}\r\nAuthorization: Bearer ${who.token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
  const listText = (host, cookie) => `GET ${CUSTOMER_DIRECTORY_PATH} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`;
  let cookie = null;
  for (const host of [TENANT_HOST.toUpperCase(), 'Tenant.Tmpos.Test']) {
    const login = await ctx.raw(loginText(host));
    assert.equal(login.status, 200, `${label}: login on ${host}: ${login.body}`);
    cookie = login.setCookies[0].split('; ')[0];
    await noteSession(cookie);
    SECRETS.add(JSON.parse(login.body).csrfToken);
    const read = await ctx.raw(listText(host, cookie));
    assert.equal(read.status, 200, `${label}: read on ${host}: ${read.body}`);
    assert.deepEqual(JSON.parse(Buffer.from(read.body, 'latin1').toString('utf8')).customers, rows, `${label}: read on ${host}, only the caller's rows`);
  }
  assertBounded404(await ctx.raw(loginText(`${TENANT_HOST}.`)), `${label}: login on the tenant host with a trailing dot`);
  assertBounded404(await ctx.raw(listText(`${TENANT_HOST}.`, cookie)), `${label}: read on the tenant host with a trailing dot`);
}

/** A refused startup: its category and codes, no listener, exit 1 — and, when a client was built, that client ended. */
function assertRefused(ctx, failure, reasons, label) {
  assert.equal(ctx.result.outcome, 'refused', `${label}: ${JSON.stringify(ctx.result)}`);
  assert.equal(ctx.result.failure, failure, label);
  if (reasons !== undefined) assert.deepEqual([...ctx.result.reasons].sort(), [...reasons].sort(), label);
  assert.equal(ctx.result.address, null, label);
  assert.equal(ctx.bindAttempts, 0, `${label}: no real bind attempt`);
  assert.deepEqual(ctx.cap.codes, [1], `${label}: exit 1, once`);
  assert.ok(ctx.cap.lines.some((l) => { try { const r = JSON.parse(l); return r.event === 'startup_refused' && r.reason.startsWith(failure); } catch { return false; } }),
    `${label}: a startup_refused line names the category`);
  if (ctx.clientsBuilt() > 0) assert.deepEqual(ctx.ends, { calls: 1, completed: 1 }, `${label}: the refusal ended the entry's own client`);
}

// ===========================================================================
// Acceptance (3): only the tenant route, only on the tenant host, only for a valid tenant session
// ===========================================================================

test('M7TE-01: a valid configuration binds exactly one listener serving TENANT_SHIPPING_ROUTES; the probes answer on any host with HSTS and the baseline headers', async () => {
  await withEntry({}, async (ctx) => {
    assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
    assert.equal(ctx.result.address.address, '127.0.0.1');
    assert.deepEqual(canonical(ctx.result.routes), canonical(TENANT_SHIPPING_ROUTES));
    assert.equal(ctx.bindAttempts, 1, 'exactly one real bind attempt');
    assert.equal(ctx.clientsBuilt(), 1, 'one kernel');
    for (const host of [TENANT_HOST, ADMIN_HOST, 'foreign.test']) {
      const health = await ctx.req('GET', '/health', { host });
      assert.equal(health.status, 200, health.body);
      assert.deepEqual(JSON.parse(health.body), { status: 'alive' });
      const readiness = await ctx.req('GET', '/readiness', { host });
      assert.equal(readiness.status, 200, readiness.body);
      assert.deepEqual(JSON.parse(readiness.body), { status: 'ready' });
      assert.equal(health.headers['strict-transport-security'], HSTS_HEADER.value, host);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(health.headers[name.toLowerCase()], value, `${name} on ${host}`);
    }
  });
});

test('M7TE-02: a tenant user logs in on the tenant host on a host-only cookie and reads only its own tenant\'s id/name rows, under the P1 paging and error contract', async () => {
  const aUser = await actor('m7te02-a', [tenantGrant(T_A, 'manager')]);
  const bUser = await actor('m7te02-b', [tenantGrant(T_B, 'sales_staff')]);
  await withEntry({}, async (ctx) => {
    const a = await signIn(ctx, aUser);
    assert.match(a.setCookie, /^__Host-tmpos_tenant_session=[^;]+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    assert.doesNotMatch(a.setCookie.toLowerCase(), /domain=/);

    // Only A's customers, exactly, in UTF-8 byte order then id; one at a time and two at a time, nothing repeated or skipped.
    assert.deepEqual(pageOf(await list(ctx, a.cookie), 'A default'), { customers: SEED_A, nextCursor: null });
    assert.deepEqual((await walk(ctx, a.cookie, 1)).flat(), SEED_A, 'limit=1 walk');
    const pairs = await walk(ctx, a.cookie, 2);
    assert.deepEqual(pairs.map((p) => p.length), [2, 2, 2, 1]);
    assert.deepEqual(pairs.flat(), SEED_A, 'limit=2 walk');

    // B: default 50 then the rest; 100 accepted; B's session never sees A's rows, nor A's B's.
    const b = await signIn(ctx, bUser);
    const first = pageOf(await list(ctx, b.cookie), 'B default');
    assert.deepEqual(first.customers, SEED_B.slice(0, 50), 'default limit 50');
    const rest = pageOf(await list(ctx, b.cookie, `?cursor=${first.nextCursor}`), 'B rest');
    assert.deepEqual(rest, { customers: SEED_B.slice(50), nextCursor: null });
    assert.deepEqual(pageOf(await list(ctx, b.cookie, '?limit=100'), 'B 100').customers, SEED_B);
    const aIds = new Set(SEED_A.map((c) => c.id));
    assert.ok(first.customers.every((c) => !aIds.has(c.id)) && rest.customers.every((c) => !aIds.has(c.id)), 'B never sees A');

    // Every bad query is one 400; a cursor issued to B, presented by A, is the same 400 as a random one.
    for (const query of ['?limit=0', '?limit=101', '?limit=-1', '?limit=abc', '?limit=5&limit=5', `?tenant=${T_B}`, '?',
      `?cursor=${encodeCustomerCursor(SEED_A[0].id)}&cursor=${encodeCustomerCursor(SEED_A[0].id)}`, '?cursor=abc']) {
      assertRefusal(await list(ctx, a.cookie, query), 400, 'invalid_request', query);
    }
    const foreign = await list(ctx, a.cookie, `?cursor=${first.nextCursor}`);
    const random = await list(ctx, a.cookie, `?cursor=${encodeCustomerCursor(randomUUID())}`);
    assertRefusal(foreign, 400, 'invalid_request', 'B\'s cursor to A');
    assertRefusal(random, 400, 'invalid_request', 'random cursor');
    assert.equal(foreign.body.length, random.body.length, 'bodies of one length: only the request id differs');
    assert.deepEqual([reasonOf(ctx, foreign), reasonOf(ctx, random)], ['customer_directory_cursor_unknown', 'customer_directory_cursor_unknown']);
    for (const c of SEED_B) assert.ok(!foreign.body.includes(c.id) && !foreign.body.includes(c.name));
  });
});

test('M7TE-03: no session, a forged session, a store-only actor and an actor with two tenant grants are refused; a read-only tenant still reads; a platform-only or grantless user cannot log in on the tenant host', async () => {
  const storeOnly = await actor('m7te03-store', [{ scope: 'store', tenant: T_A, store: STORE_A, role: 'manager' }]);
  const twoTenants = await actor('m7te03-two', [tenantGrant(T_A, 'manager'), tenantGrant(T_B, 'manager')]);
  const readOnly = await actor('m7te03-ro', [tenantGrant(T_RO, 'technician')]);
  const platformOnly = await actor('m7te03-platform', [{ scope: 'platform', role: 'system_owner' }]);
  const noGrant = await actor('m7te03-none', []);
  await withEntry({}, async (ctx) => {
    assertRefusal(await list(ctx, null), 401, 'unauthenticated', 'no cookie');
    const forged = randomBytes(32).toString('base64url');
    SECRETS.add(forged);
    assertRefusal(await list(ctx, `${SESSION_COOKIES.tenant}=${forged}`), 401, 'unauthenticated', 'forged session cookie');
    assertRefusal(await list(ctx, (await signIn(ctx, storeOnly)).cookie), 403, 'forbidden', 'store-only actor');
    assertRefusal(await list(ctx, (await signIn(ctx, twoTenants)).cookie), 403, 'forbidden', 'two tenant grants');
    assert.deepEqual(pageOf(await list(ctx, (await signIn(ctx, readOnly)).cookie), 'read_only tenant'), { customers: SEED_RO, nextCursor: null },
      'a read-only tenant reads: the route is classified a read');
    for (const [label, who] of [['platform-only', platformOnly], ['grantless', noGrant]]) {
      const reply = await ctx.login(who);
      assertRefusal(reply, 401, 'unauthenticated', `${label} login on the tenant host`);
      assert.equal(reasonOf(ctx, reply), 'login_admission_denied', label);
    }
    const [{ n }] = await owner`select count(*)::int as n from tmpos_session.session where auth_provider_uid = any(${[platformOnly.uid, noGrant.uid]}::text[])`;
    assert.equal(n, 0, 'no session was issued to either');
  });
});

test('M7TE-04: an administrative session is no tenant session; no administrative, witness or DEV route exists on the tenant entry', async () => {
  const admin = await actor('m7te04-admin', [{ scope: 'platform', role: 'system_owner' }]);
  const id = await adminSessionId(admin);
  await withEntry({}, async (ctx) => {
    const underAdminName = await list(ctx, `${SESSION_COOKIES.admin}=${id}`);
    assertRefusal(underAdminName, 401, 'unauthenticated', 'an administrative cookie');
    assert.equal(reasonOf(ctx, underAdminName), 'session_missing', 'the tenant boundary never reads the administrative cookie');
    const underTenantName = await list(ctx, `${SESSION_COOKIES.tenant}=${id}`);
    assertRefusal(underTenantName, 401, 'unauthenticated', 'an administrative session under the tenant cookie name');
    assert.equal(reasonOf(ctx, underTenantName), 'session_wrong_audience');
    for (const [method, path] of [['POST', sessionPaths('admin').login], ['GET', sessionPaths('admin').current], ['POST', sessionPaths('admin').logout],
      ['GET', '/admin/v1/tenants'], ['PATCH', '/admin/v1/tenants/display-name'], ['PATCH', '/admin/v1/tenants/status'],
      ['GET', '/__witness'], ['GET', '/admin/v1/witness'], ['GET', '/dev'], ['GET', '/identity/whoami'], ['GET', '/diagnostics'],
      ['GET', '/bootstrap'], ['GET', '/migrations'], ['POST', CUSTOMER_DIRECTORY_PATH], ['GET', `${CUSTOMER_DIRECTORY_PATH}/x`]]) {
      assertBounded404(await ctx.req(method, path, { cookie: `${SESSION_COOKIES.admin}=${id}` }), `${method} ${path}`);
      assert.ok(!ctx.result.routes.some((r) => r.method === method && r.path === path), `${method} ${path} is not in the served inventory`);
    }
  });
});

test('M7TE-05: the admin host, an unknown, wildcard-looking or IP host, the tenant host with :443 or a trailing dot, a duplicated or missing Host and a forwarded Host each get the bounded 404 — the route and the login alike; the tenant host in another letter case is served', async () => {
  const who = await actor('m7te05', [tenantGrant(T_A, 'store_owner')]);
  await withEntry({}, async (ctx) => {
    const session = await signIn(ctx, who);
    const listText = (hostLines, version = '1.1') =>
      `GET ${CUSTOMER_DIRECTORY_PATH} HTTP/${version}\r\n${hostLines}Cookie: ${session.cookie}\r\nConnection: close\r\n\r\n`;
    const loginText = (hostLines, version = '1.1') =>
      `POST ${sessionPaths('tenant').login} HTTP/${version}\r\n${hostLines}Origin: ${TENANT_ORIGIN}\r\nSec-Fetch-Site: same-origin\r\n`
      + `${CSRF_HEADER}: ${CSRF_HEADER_VALUE}\r\nAuthorization: Bearer ${who.token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
    for (const host of [ADMIN_HOST, 'unknown.tmpos.test', `*.tmpos.test`, '*', `${TENANT_HOST}.evil.test`, `evil.${TENANT_HOST}`, '127.0.0.1',
      '[::1]', `${TENANT_HOST}:443`, `${TENANT_HOST}:8443`, `x@${TENANT_HOST}`]) {
      assertBounded404(await ctx.raw(listText(`Host: ${host}\r\n`)), `list on ${host}`);
      assertBounded404(await ctx.raw(loginText(`Host: ${host}\r\n`)), `login on ${host}`);
    }
    assertBounded404(await ctx.raw(listText(`Host: ${TENANT_HOST}\r\nHost: ${TENANT_HOST}\r\n`)), 'duplicated Host');
    assertBounded404(await ctx.raw(loginText(`Host: ${TENANT_HOST}\r\nHost: ${TENANT_HOST}\r\n`)), 'duplicated Host, login');
    assertBounded404(await ctx.raw(listText('', '1.0')), 'missing Host (HTTP/1.0)');
    assertBounded404(await ctx.raw(loginText('', '1.0')), 'missing Host (HTTP/1.0), login');
    assertBounded404(await ctx.raw(listText(`Host: evil.test\r\nX-Forwarded-Host: ${TENANT_HOST}\r\n`)), 'X-Forwarded-Host is never read');
    // The tenant host is served — a foreign X-Forwarded-Host changes nothing.
    const served = await ctx.raw(listText(`Host: ${TENANT_HOST}\r\nX-Forwarded-Host: evil.test\r\n`));
    assert.equal(served.status, 200, served.body);
    assert.deepEqual(JSON.parse(Buffer.from(served.body, 'latin1').toString('utf8')).customers, SEED_A, 'the raw socket reads bytes');
    await assertHostSpellings(ctx, who, SEED_A, 'M7TE-05');
  });
});

test('M7TE-06: a wrong Origin, a missing pre-session CSRF header or a cross-site fetch refuse the login with no cookie', async () => {
  const who = await actor('m7te06', [tenantGrant(T_A, 'manager')]);
  await withEntry({}, async (ctx) => {
    const base = {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${who.token}`,
    };
    const { [CSRF_HEADER]: _dropped, ...noCsrf } = base;
    for (const [label, headers] of [
      ['wrong Origin', { ...base, origin: 'https://evil.test' }],
      ['the admin Origin', { ...base, origin: ADMIN_ORIGIN }],
      ['no pre-session CSRF', noCsrf],
      ['cross-site', { ...base, 'sec-fetch-site': 'cross-site' }],
    ]) {
      assertRefusal(await sendReq(ctx.port, 'POST', sessionPaths('tenant').login, headers, ctx.clientAddress), 403, 'forbidden', label);
    }
    const [{ n }] = await owner`select count(*)::int as n from tmpos_session.session where auth_provider_uid = ${who.uid}`;
    assert.equal(n, 0, 'no session was issued');
  });
});

// ===========================================================================
// Acceptance (5): every missing or malformed dependency refuses startup; readiness is never ready while one fails
// ===========================================================================

test('M7TE-07: each missing or malformed tenant configuration refuses config_invalid with its bounded code, builds no client and binds nothing', async () => {
  const weakByte = randomBytes(1)[0];
  const cases = [
    ['SESSION_TENANT_ORIGINS missing', { SESSION_TENANT_ORIGINS: undefined }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_missing'],
    ['a wildcard tenant origin', { SESSION_TENANT_ORIGINS: 'https://*.tmpos.test' }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_invalid'],
    ['an http tenant origin', { SESSION_TENANT_ORIGINS: `http://${TENANT_HOST}` }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_invalid'],
    ['two tenant origins', { SESSION_TENANT_ORIGINS: `${TENANT_ORIGIN},https://other.tmpos.test` }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_not_single'],
    ['the admin host', { SESSION_TENANT_ORIGINS: `https://${ADMIN_HOST}:8443` }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_shares_admin_host'],
    ['SESSION_ADMIN_ORIGINS missing', { SESSION_ADMIN_ORIGINS: undefined }, 'SESSION_ADMIN_ORIGINS:session_admin_origin_missing'],
    ['issuer key missing', { TENANT_SESSION_ISSUER_KEY: undefined }, 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_missing'],
    ['issuer key malformed', { TENANT_SESSION_ISSUER_KEY: 'not-a-key' }, 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_invalid'],
    ['issuer key = RATE_LIMIT_KEY', { TENANT_SESSION_ISSUER_KEY: RATE_KEY.toString('base64url') }, 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_shared'],
    ['issuer key = the recorded vector', { TENANT_SESSION_ISSUER_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url') },
      'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_weak'],
    ['issuer key of one repeated byte', { TENANT_SESSION_ISSUER_KEY: Buffer.alloc(32, weakByte).toString('base64url') }, 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_weak'],
    ['IDEMPOTENCY_KEY present', { IDEMPOTENCY_KEY: randomBytes(32).toString('base64url') }, 'IDEMPOTENCY_KEY:idempotency_key_present'],
    ['RATE_LIMIT_KEY missing', { RATE_LIMIT_KEY: undefined }, 'RATE_LIMIT_KEY:rate_limit_key_missing'],
    ['RATE_LIMIT_KEY malformed', { RATE_LIMIT_KEY: 'abc' }, 'RATE_LIMIT_KEY:rate_limit_key_invalid'],
    ['APP_DATABASE_URL missing', { APP_DATABASE_URL: undefined }, 'APP_DATABASE_URL:app_database_url_missing'],
  ];
  for (const [label, env, reason] of cases) {
    // A malformed probe as short as 'abc' is no secret, and would match a request id or cursor by chance: every real secret,
    // origin and DSN is at least 12 characters.
    for (const value of Object.values(env)) if (value !== undefined && value.length >= 12) SECRETS.add(value);
    await withEntry({ env }, async (ctx) => {
      assertRefused(ctx, 'config_invalid', [reason], label);
      assert.equal(ctx.clientsBuilt(), 0, `${label}: no database client was built`);
    });
  }
});

test('M7TE-08: the database must hold this process\'s issuer key; the limiter must hold its key; the login must hold the customer read and the session mint — each refuses startup with its bounded code', async () => {
  try {
    await owner`delete from tmpos_mint.issuer_key`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'tenant_issuer_key_absent', [], 'no key installed'));
    await installTestIssuerKey(owner, randomBytes(32));
    await withEntry({}, async (ctx) => assertRefused(ctx, 'tenant_issuer_key_mismatch', [], 'another key installed'));
  } finally {
    await installTestIssuerKey(owner, ISSUER_KEY);
  }
  try {
    await registerFingerprint(randomBytes(32));
    await withEntry({}, async (ctx) => assertRefused(ctx, 'rate_limit_key_mismatch', [], 'another limiter key registered'));
  } finally {
    await registerFingerprint(RATE_KEY);
  }
  try {
    await owner.unsafe(`revoke execute on function ${V2} from tmpos_app`);
    await withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'], 'the customer read withdrawn'));
  } finally {
    await owner.unsafe(`grant execute on function ${V2} to tmpos_app`);
  }
  // The mint withdrawn: the runtime login's grant census names it before the readiness step's mint probe is reached.
  await withoutExecute(MINT, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the session mint withdrawn')));
  await withEntry({}, async (ctx) => assert.equal(ctx.result.outcome, 'listening', 'restored: it starts'));
});

test('M7TE-09: any setting that would log a bound parameter refuses startup database_logging_unsafe, naming the setting', async () => {
  const set = (settings) => owner.unsafe(`alter role ${RUNTIME_LOGIN} set ${settings}`);
  const reset = () => owner.unsafe(`alter role ${RUNTIME_LOGIN} reset all`);
  const cases = [
    ['log_parameter_max_length_on_error = 64', ['log_parameter_max_length_on_error = 64'], ['log_parameter_max_length_on_error']],
    ['log_statement = all', ['log_statement = \'all\''], ['log_statement']],
    ['log_min_duration_statement = 0', ['log_min_duration_statement = 0'], ['log_min_duration_statement']],
    ['log_min_duration_sample = 250ms', ['log_min_duration_sample = 250'], ['log_min_duration_sample']],
    ['debug_print_plan = on', ['debug_print_plan = on'], ['debug_print_plan']],
    // auto_explain logs a plan, and a custom plan carries the parameter values whatever its own parameter length says.
    ['auto_explain loaded, logging every plan', ['session_preload_libraries = \'auto_explain\'', 'auto_explain.log_min_duration = 0',
      'auto_explain.log_parameter_max_length = 0'], ['auto_explain_parameters']],
  ];
  try {
    for (const [label, settings, reasons] of cases) {
      for (const s of settings) await set(s);
      try {
        await withEntry({}, async (ctx) => assertRefused(ctx, 'database_logging_unsafe', reasons, label));
      } finally {
        await reset();
      }
    }
    // The statement logged with no parameter attached is safe: log_parameter_max_length = 0 turns every other rule off.
    await set('log_parameter_max_length = 0');
    await set('log_statement = \'all\'');
    await withEntry({}, async (ctx) => assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result)));
  } finally {
    await reset();
    await endLoginSessions();
  }
  await withEntry({}, async (ctx) => assert.equal(ctx.result.outcome, 'listening', 'reset: it starts'));
});

test('M7TE-10: a migration ledger that is not exactly 001-018 refuses startup migration_state_invalid', async () => {
  const [row] = await owner`select version, checksum, dirty, started_at::text as started_at, finished_at::text as finished_at
    from public.schema_migrations where version = '018'`;
  assert.ok(row !== undefined, '018 is recorded');
  const restore = () => owner.begin(async (sql) => {
    await sql`delete from public.schema_migrations where version in ('018', '019')`;
    await sql`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
      values (${row.version}, ${row.checksum}, ${row.dirty}, ${row.started_at}::text::timestamptz, ${row.finished_at}::text::timestamptz)`;
  });
  try {
    await owner`delete from public.schema_migrations where version = '018'`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'migration_state_invalid', ['migration_missing'], 'a database at 017'));
    await restore();
    await owner`update public.schema_migrations set checksum = ${createHash('sha256').update('not 018').digest('hex')} where version = '018'`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'migration_state_invalid', ['migration_checksum_mismatch'], '018 with another checksum'));
    await restore();
    await owner`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
      values ('019', ${createHash('sha256').update('019').digest('hex')}, false, now(), now())`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'migration_state_invalid', ['migration_unknown'], 'an unknown 019'));
    await restore();
    // Not only the newest row is judged: an intermediate migration left dirty refuses as well.
    await owner`update public.schema_migrations set dirty = true where version = '010'`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'migration_state_invalid', ['migration_dirty'], '010 dirty'));
  } finally {
    await owner`update public.schema_migrations set dirty = false where version = '010'`;
    await restore();
  }
  const [back] = await owner`select version, checksum, dirty, started_at::text as started_at, finished_at::text as finished_at
    from public.schema_migrations where version = '018'`;
  assert.deepEqual({ ...back }, { ...row }, 'the ledger row is restored exactly');
});

test('M7TE-11: after startup, readiness is 503 while the issuer key is deleted or rotated, parameter logging is on, the customer read, the session mint, the session read or the tenant admission is withdrawn, the limiter key is replaced or the database is down — each alone, and 200 once each recovers; /health stays 200', async () => {
  const who = await actor('m7te11', [tenantGrant(T_A, 'manager')]);
  await withEntry({}, async (ctx) => {
    assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
    const session = await signIn(ctx, who);
    assert.equal((await ctx.req('GET', '/readiness')).status, 200);
    try {
      // The key deleted: not ready, no new login, and an existing session reads nothing.
      await owner`delete from tmpos_mint.issuer_key`;
      await readinessHolds(ctx, 503);
      assertRefusal(await ctx.login(who), 503, 'service_unavailable', 'login with no key');
      assertRefusal(await list(ctx, session.cookie), 403, 'forbidden', 'a session read with no key');
      assert.equal((await ctx.req('GET', '/health')).status, 200);
      await installTestIssuerKey(owner, ISSUER_KEY);
      assert.ok(await readinessUntil(ctx, 200), 'the key reinstalled: ready');
      assert.deepEqual(pageOf(await list(ctx, session.cookie), 'the same key again').customers, SEED_A);
      // The key rotated to one this process does not hold.
      await installTestIssuerKey(owner, randomBytes(32));
      await readinessHolds(ctx, 503);
      assertRefusal(await list(ctx, session.cookie), 403, 'forbidden', 'a session minted under the old key');
    } finally {
      await installTestIssuerKey(owner, ISSUER_KEY);
    }
    assert.ok(await readinessUntil(ctx, 200), 'restored');

    // Parameter logging turned on for the login's sessions: a reconnect alone recovers, the setting holds readiness at 503.
    try {
      await endLoginSessions();
      assert.ok(await readinessUntil(ctx, 200), 'a reconnect alone is ready again');
      await owner.unsafe(`alter role ${RUNTIME_LOGIN} set log_min_duration_statement = 0`);
      await endLoginSessions();
      await readinessHolds(ctx, 503);
    } finally {
      await owner.unsafe(`alter role ${RUNTIME_LOGIN} reset all`);
      await endLoginSessions();
    }
    assert.ok(await readinessUntil(ctx, 200), 'logging reset: ready');

    // The customer read withdrawn from the login.
    try {
      await owner.unsafe(`revoke execute on function ${V2} from tmpos_app`);
      await readinessHolds(ctx, 503);
      assertRefusal(await list(ctx, session.cookie), 503, 'service_unavailable', 'the read withdrawn');
    } finally {
      await owner.unsafe(`grant execute on function ${V2} to tmpos_app`);
    }
    assert.ok(await readinessUntil(ctx, 200), 'the read restored: ready');

    // The mint probe writes nothing: readiness asked it across three reuse windows, and every mint-ledger and session row is
    // exactly as it was — counted, and digested whole on the server (a digest, never a row, leaves the database).
    const rowState = async () => ({ ...(await owner`select
      (select count(*) from tmpos_mint.tenant_session)::int as minted,
      (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(m::text, '|' order by m.session_key), ''),
        'UTF8')), 'hex') from tmpos_mint.tenant_session m) as minted_digest,
      (select count(*) from tmpos_session.session)::int as sessions,
      (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(s::text, '|' order by s.session_key), ''),
        'UTF8')), 'hex') from tmpos_session.session s) as sessions_digest`)[0] });
    const rowsBefore = await rowState();
    await readinessHolds(ctx, 200);
    assert.deepEqual(await rowState(), rowsBefore, 'the mint probe adds, changes and removes no mint-ledger or session row');

    // The session mint withdrawn from the login: not ready, and no login can be issued.
    await withoutExecute(MINT, async () => {
      await readinessHolds(ctx, 503);
      assertRefusal(await ctx.login(who), 503, 'service_unavailable', 'login with the mint withdrawn');
      assert.equal((await ctx.req('GET', '/health')).status, 200);
    });
    assert.ok(await readinessUntil(ctx, 200), 'the mint restored: ready');

    // The limiter's registered fingerprint replaced under the running process (as the owner, as M7TE-08 does).
    try {
      await registerFingerprint(randomBytes(32));
      await readinessHolds(ctx, 503);
      assertRefusal(await list(ctx, session.cookie), 503, 'service_unavailable', 'a read with another limiter key registered');
      assert.equal((await ctx.req('GET', '/health')).status, 200);
    } finally {
      await registerFingerprint(RATE_KEY);
    }
    assert.ok(await readinessUntil(ctx, 200), 'the limiter key restored: ready');

    // The session read (the store's get) and the tenant admission withdrawn from the login, each alone.
    for (const [label, fn] of [['the session read', SESSION_GET], ['the tenant admission', ADMIT]]) {
      await withoutExecute(fn, async () => {
        await readinessHolds(ctx, 503);
        assertRefusal(await list(ctx, session.cookie), 503, 'service_unavailable', `a read with ${label} withdrawn`);
        assert.equal((await ctx.req('GET', '/health')).status, 200);
      });
      assert.ok(await readinessUntil(ctx, 200), `${label} restored: ready`);
    }

    // The database down.
    await storeDown(ctx.relay);
    await readinessHolds(ctx, 503);
    assertRefusal(await list(ctx, session.cookie), 503, 'service_unavailable', 'the store down');
    assert.equal((await ctx.req('GET', '/health')).status, 200, 'still alive');
    await ctx.relay.restore();
    assert.ok(await readinessUntil(ctx, 200), 'the store restored: ready');
    assert.deepEqual(pageOf(await list(ctx, session.cookie), 'after every recovery').customers, SEED_A);
  });
});

test('M7TE-12: shutdown closes the listener and ends the database client exactly once', async () => {
  await withEntry({}, async (ctx) => {
    assert.equal(ctx.result.outcome, 'listening');
    ctx.cap.proc.emit('SIGTERM');
    await waitFor(() => ctx.cap.codes.length > 0, 5_000);
    ctx.cap.proc.emit('SIGTERM');
    await delay(100);
    assert.deepEqual(ctx.cap.codes, [0], 'exit was called exactly once, with 0');
    assert.deepEqual(ctx.ends, { calls: 1, completed: 1 });
    await new Promise((resolve, reject) => {
      const s = net.connect(ctx.port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); reject(new Error('connected after shutdown')); });
      s.on('error', () => resolve());
    });
  });
});

// ===========================================================================
// M7TE-C1: the COMPILED tenant entry over the same disposable database and real sockets
// ===========================================================================

test('M7TE-C1: the compiled tenant entry starts over the disposable database, serves the customer read on the tenant host alone (in another letter case too, never with a trailing dot), refuses the admin cookie, and stops cleanly', async () => {
  // The compiled ENTRY module is started, as the source one is above: the compiled executable (tenantMain.js) passes
  // PRODUCTION_CONSTRUCTION — verified TLS to the sealed managed endpoint — which no disposable database can answer. Its own
  // bytes are pinned elsewhere: it runs under node and refuses (production-runtime-contract), and its one call passes
  // exactly the administrative executable's options (the A9 census there). Built into node_modules/.cache (gitignored), so
  // the emitted ESM resolves its packages from the repository's node_modules.
  mkdirSync(join(REPO, 'node_modules', '.cache'), { recursive: true });
  const out = mkdtempSync(join(REPO, 'node_modules', '.cache', 'tmpos-tenant-build-'));
  try {
    const build = spawnSync(join(REPO, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.server.tenant.json', '--outDir', out],
      { cwd: REPO, env: childEnv(undefined), encoding: 'utf8', timeout: 180_000 });
    assert.equal(build.status, 0, `the tenant build succeeds:\n${(build.stdout || '') + (build.stderr || '')}`);
    const compiled = (m) => import(pathToFileURL(join(out, m)).href);
    const entry = await compiled('server/entry/tenantEntry.js');
    const kernel = await compiled('server/persistence/supervisedPgClient.js');
    const { runtimeClientOptions: compiledClientOptions } = await compiled('server/platform-identity/db.js');
    assert.notEqual(entry.startTenantEntry, startTenantEntry, 'the compiled module, not the source');

    const who = await actor('m7te-c1', [tenantGrant(T_A, 'manager')]);
    const admin = await actor('m7te-c1-admin', [{ scope: 'platform', role: 'system_owner' }]);
    const adminId = await adminSessionId(admin);
    // The compiled entry, over the compiled kernel and client options: every module on the path is the artifact's.
    const kernelModule = { createSupervisedPgClient: kernel.createSupervisedPgClient, MAX_POOLS: kernel.MAX_POOLS, runtimeClientOptions: compiledClientOptions };
    await withEntry({ start: entry.startTenantEntry, kernelModule }, async (ctx) => {
      assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
      assert.deepEqual(canonical(ctx.result.routes), canonical(TENANT_SHIPPING_ROUTES));
      assert.deepEqual(canonical(entry.TENANT_SHIPPING_ROUTES), canonical(TENANT_SHIPPING_ROUTES), 'the compiled inventory is the source literal');
      const session = await signIn(ctx, who);
      assert.match(session.setCookie, /^__Host-tmpos_tenant_session=[^;]+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
      assert.deepEqual(pageOf(await list(ctx, session.cookie, '?limit=100'), 'compiled read'), { customers: SEED_A, nextCursor: null });
      const listText = (hostLines, version = '1.1') =>
        `GET ${CUSTOMER_DIRECTORY_PATH} HTTP/${version}\r\n${hostLines}Cookie: ${session.cookie}\r\nConnection: close\r\n\r\n`;
      assertBounded404(await ctx.raw(listText(`Host: ${ADMIN_HOST}\r\n`)), 'compiled: the admin host');
      assertBounded404(await ctx.raw(listText('Host: unknown.tmpos.test\r\n')), 'compiled: an unknown host');
      assertBounded404(await ctx.raw(listText('Host: *.tmpos.test\r\n')), 'compiled: a wildcard-looking host');
      assertBounded404(await ctx.raw(listText('', '1.0')), 'compiled: no Host');
      await assertHostSpellings(ctx, who, SEED_A, 'compiled');
      const adminCookie = await list(ctx, `${SESSION_COOKIES.admin}=${adminId}`);
      assertRefusal(adminCookie, 401, 'unauthenticated', 'compiled: the administrative cookie');
      assertRefusal(await list(ctx, `${SESSION_COOKIES.tenant}=${adminId}`), 401, 'unauthenticated', 'compiled: an administrative session as a tenant one');
      assertBounded404(await ctx.req('GET', '/admin/v1/tenants', { cookie: `${SESSION_COOKIES.admin}=${adminId}` }), 'compiled: no administrative route');
      assert.equal((await ctx.req('GET', '/readiness')).status, 200);

      ctx.cap.proc.emit('SIGTERM');
      await waitFor(() => ctx.cap.codes.length > 0, 5_000);
      assert.deepEqual(ctx.cap.codes, [0], 'the compiled entry stops cleanly, exit 0');
      assert.deepEqual(ctx.ends, { calls: 1, completed: 1 }, 'and ends its kernel exactly once');
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('M7TE-13: no captured log line carries a configuration value, a key, a proof, a session identifier or key, a token, a customer name or id, or a cursor', () => {
  const forbidden = [
    'synthetic-pw',
    ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e)]),
    ...FIREBASE_PRIVATE_KEY.split('\n').filter((line) => line.length > 20 && !line.startsWith('-----')),
    ...SECRETS,
  ];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const line of ALL_LOG_LINES) {
    for (const needle of forbidden) assert.ok(!line.includes(needle), `a log line leaked a value: ${String(needle).slice(0, 6)}...`);
  }
});
