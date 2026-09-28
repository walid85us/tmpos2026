// M7A-CUSTOMERS-P3 — POST /api/v1/customers END TO END: the tenant entry (server/entry/tenantEntry.ts, startTenantEntry)
// creating customers over REAL loopback HTTP and a disposable PostgreSQL holding migrations 001-019, composed exactly as
// server/entry/tenantMain.ts composes it but for its construction.
//
// M7A-CUSTOMERS-P3-R1 UPDATE. The chain is now 001-020 and the create is 020's tmpos_role.m7a_customer_create — 019's body
// with its built-in role allow-list replaced by the role's effective Customers level (an owner's durable edit, else the
// catalog default) — so every "019" below names the create's behaviour 020 keeps; no role level is edited in this file, so
// every role decides at its default and the pinned outcomes are unchanged. M7CC-09's direct calls go to 020's routine and
// 019's is refused to the login. An owner's edit reaching this route is tests/db/roleLevels.integration.test.mjs's.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — the three things tests/db/tenantEntry.integration.test.mjs substitutes, none of them
// on the path under test: the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime
// LOGIN, tmpos_m7cc_probe, holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can also
// drop a COMMIT's answer), the identity verifier (a synthetic bearer-token map) and the listener (127.0.0.1:0). The host
// lock, the limiter, the Origin/CSRF checks, the tenant session boundary, the tenant authorizer, the idempotency store,
// the tenant command transaction and its revalidator, migration 019's routine, the audit writer and the completion are
// production's own code, unmodified.
//
// WHAT IS PROVEN. C/A/K/O are the customer rows, the audit rows of action tenant.customer.create, the sealed idempotency
// completions and the outbox rows (L: every idempotency row, leases included), each a delta the OWNER reads around a case:
//   M7CC-01 a sales_staff, store_owner or manager creates in its own tenant: 201 {customer:{id,name}}, no Location,
//           1/1/1/0, the row and the audit record in that tenant, found by that tenant's read and not by another's;
//   M7CC-02 no, forged, idle-expired, absolute-expired, logged-out and administrative sessions, a store-only actor and a
//           host that is not the tenant host create nothing, and acquire no key (0/0/0/0, L 0);
//   M7CC-03 a technician, a read_only or overdue tenant, a read_only account, technician-plus-store-manager and two tenant
//           grants are 403; a role, a grant, a tenant or an account changed after login is 401 — nothing written;
//   M7CC-04 races decided inside the transaction by owner lock levers: a grant removal or tenant suspension committed
//           before the command's deciding lock refuses it (503, nothing written); one attempted after WAITS for the
//           command, which commits first — and so does a logout of the presenting session;
//   M7CC-05 the Idempotency-Key: refused before any write when missing, malformed or repeated; a same-body replay is the
//           same 201 and one customer; a changed body is 422; two keys, two customers; the same principal moved to
//           another tenant replays nothing (422); a replay after the session ended is 401;
//   M7CC-06 two tenant entries over one database with the identical IDEMPOTENCY_KEY: one customer, whatever the order;
//   M7CC-07 malformed, oversized, extra-field and non-object bodies, every refused name class, Content-Type, Origin and
//           CSRF refusals are bounded {error, requestId} with the baseline headers, and write nothing; one 429;
//   M7CC-08 an audit INSERT that raises or writes no row, a 019 refusal, and a raise or a row not written inside 019 roll
//           everything back (503); a COMMIT whose answer is lost is a 503, and the retry resolves through the retained
//           completion (a replay);
//   M7CC-09 as the runtime login itself: no direct write to the customer table (42501); a technician's live key creates
//           nothing; another tenant's key creates only in ITS tenant, and the routine takes no tenant argument;
//   M7CC-10 no log line carries a customer name or id, a session identifier, key or CSRF token, or an Idempotency-Key —
//           nor, on a cluster this file started, the server's own log.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster
// this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. On a shared service
// it removes its own customer, session and mint-ledger rows and its proof schema, restores the limiter's fingerprint and the
// issuer key row it found (or its absence), drops every trigger it installed and its login. What it leaves is what every
// suite leaves: its synthetically named identities, tenants and store, their audit records and idempotency records.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriverVia } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { tenantMintProof } from '../../server/persistence/postgresSessionStore.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { principalKeyOf, SESSION_COOKIES, SESSION_CSRF_HEADER, SESSION_TTL } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { RATE_LIMITS } from '../../server/runtime/rateLimit.ts';
import { CUSTOMER_DIRECTORY_PATH } from '../../server/runtime/customerDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7cc-migrator', runtimeRef: 'm7cc-runtime' };
const LOCK_KEY = 528_524;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7cc_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** The audit action of a create (the command contract's kind), pinned here as a literal. */
const ACTION = 'tenant.customer.create';
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The bound on every lever and every awaited outcome. */
const WAIT_MS = 10_000;
/** The revalidator's first lock: 016's hold of the actor's standing (postgresTenantAdmission.ts). */
const AT_HOLD = /m5_hold_tenant_standing/;
/** The advisory key the parking trigger waits on (the two-int space: never the migration lock's bigint one). */
const PARK = [528_524, 19];
/** Four one-connection pools per instance: two instances, the owner and the observer stay inside a 20-connection cluster. */
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });

// ---------------------------------------------------------------------------
// cluster lifecycle (mirrors tests/db/tenantEntry.integration.test.mjs)
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M7CC');
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

/** The owner: applies the migrations, writes fixtures, holds the levers and counts rows. RLS does not restrict it. */
const owner = testClient(TARGET, { max: 4, onnotice: () => {} });
/** The observer: reads pg_stat_activity while the owner's connections hold levers. */
const probe = testClient(TARGET, { max: 1, onnotice: () => {} });

const DROP_RUNTIME_LOGIN = `do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then
    perform pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = '${RUNTIME_LOGIN}';
    drop owned by ${RUNTIME_LOGIN};
    drop role ${RUNTIME_LOGIN};
  end if;
end $$;`;

const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let rateLimitFingerprintBefore;
async function fingerprintRow() {
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  return rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
}
let issuerKeyBefore;
async function issuerKeyRow() {
  const rows = await owner`select key from tmpos_mint.issuer_key where singleton`;
  return rows.length === 0 ? null : Buffer.from(rows[0].key);
}

// Race helpers a teardown may have to settle.
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => delay(5);
/** A request a failing test may abandon: its rejection is observed here, and still reaches whoever awaits it. */
const quietly = (p) => { p.catch(() => {}); return p; };
async function within(promise, label) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: label }), WAIT_MS); });
  try { return await Promise.race([promise, bound]); } finally { clearTimeout(timer); }
}
const ROLLBACK = Symbol('rollback');
/** Holds and owner writes a failing test may leave open; teardown settles every one before it cleans up. */
const OPEN = new Set();

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const open of [...OPEN]) await step(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
    // The proof schema's function carries every trigger this file installed: CASCADE drops them with it.
    await step(() => owner.unsafe('drop schema if exists m7cc_proof cascade'));
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
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_rate_limit.key_fingerprint where singleton`;
        if (rateLimitFingerprintBefore !== null) {
          await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
            values (${rateLimitFingerprintBefore.singleton}, ${rateLimitFingerprintBefore.fingerprint}, ${rateLimitFingerprintBefore.registered_at}::text::timestamptz)`;
        }
      }));
    }
    if (issuerKeyBefore !== undefined) {
      await step(async () => {
        await owner.begin(async (sql) => {
          await sql`delete from tmpos_mint.issuer_key where singleton`;
          if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
        });
        const after = await issuerKeyRow();
        assert.ok(after === null ? issuerKeyBefore === null : issuerKeyBefore !== null && after.equals(issuerKeyBefore),
          'the issuer key row this suite found is restored exactly');
      });
    }
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M7CC teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'M7CC setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster; a trap can drop a COMMIT's answer (productionEntry's)
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket'
    ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) }
    : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m7cc-relay-'));
  const pairs = new Set();
  const state = { closes: 0, pairs, trap: null };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); }, audited: false, silenced: false };
    pairs.add(pair);
    client.on('data', (chunk) => { if (state.trap !== null) state.trap(pair, chunk); db.write(chunk); });
    db.on('data', (chunk) => { if (!pair.silenced) client.write(chunk); });
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
    async close() {
      const drained = refuse();
      for (const pair of [...pairs]) pair.cut();
      await drained;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const AUDIT_INSERT_TEXT = Buffer.from('insert into public.audit_event');
const COMMIT_PARSE = Buffer.from('\0commit\0'); // the kernel's own `commit`, as an unnamed Parse message carries it

/**
 * Arm `relay` (productionEntry.integration's M6AA-10 technique): on the first connection that sends the audit INSERT, the
 * next COMMIT is forwarded — so the server commits — and every byte of the server's answer after it is dropped.
 * release() disarms the trap and cuts the silenced connection.
 */
function loseCommitAnswer(relay) {
  const silenced = [];
  relay.state.trap = (pair, chunk) => {
    if (chunk.includes(AUDIT_INSERT_TEXT)) {
      pair.audited = true;
    } else if (pair.audited && chunk.includes(COMMIT_PARSE)) {
      pair.silenced = true;
      silenced.push(pair);
      relay.state.trap = null;
    }
  };
  return { silenced, release: () => { relay.state.trap = null; for (const pair of silenced) pair.cut(); } };
}

function databaseClientOver(relay, kernelModule = { createSupervisedPgClient, MAX_POOLS, runtimeClientOptions }) {
  return (_endpoint) => kernelModule.createSupervisedPgClient(testDriverVia(TARGET, relay.dir), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...kernelModule.runtimeClientOptions(TARGET_DSN), ssl: false, max: kernelModule.MAX_POOLS, idle_timeout: 0,
    onclose: () => { relay.state.closes += 1; },
    user: RUNTIME_LOGIN,
  });
}

// ---------------------------------------------------------------------------
// setup: 001-020, the runtime login, the three keys, and the owner's proof schema
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

/** Made in this process, never written anywhere: the limiter's key, the tenant issuer key and the tenant command key. */
const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);

await setupStep(async () => {
  rateLimitFingerprintBefore = await fingerprintRow();
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(RATE_KEY)})`;
  });
  issuerKeyBefore = await issuerKeyRow();
  await installTestIssuerKey(owner, ISSUER_KEY);
  // The owner's levers: a schema outside ^(public|tmpos_) (the preflight's application set) holding one witness sequence;
  // withTrigger installs one trigger function in it at a time. Nothing in it is granted to anyone.
  await owner.unsafe('drop schema if exists m7cc_proof cascade');
  await owner.unsafe('create schema m7cc_proof');
  await owner.unsafe('revoke all on schema m7cc_proof from public');
  await owner.unsafe('create sequence m7cc_proof.fired');
});

// ---------------------------------------------------------------------------
// the synthetic identity provider and the configuration every entry starts from
// ---------------------------------------------------------------------------

const TOKENS = new Map();
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
  project_id: 'm7cc-test-project',
  client_email: 'm7cc-test@m7cc-test-project.iam.gserviceaccount.com',
  private_key: FIREBASE_PRIVATE_KEY,
});

/** Every instance gets the SAME IDEMPOTENCY_KEY: the process cannot check that its peers hold it (DA-101), so the suite does. */
const ENV = Object.freeze({
  NODE_ENV: 'production',
  PORT: '8443',
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  DATABASE_CA_CERT: tls.rootCertificates[0],
  RATE_LIMIT_KEY: RATE_KEY.toString('base64url'),
  TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
  SESSION_ADMIN_ORIGINS: ADMIN_ORIGIN,
  SESSION_TENANT_ORIGINS: TENANT_ORIGIN,
  TENANT_SESSION_ISSUER_KEY: ISSUER_KEY.toString('base64url'),
  IDEMPOTENCY_KEY: IDEMPOTENCY_KEY.toString('base64url'),
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: FIREBASE_JSON,
});

// ---------------------------------------------------------------------------
// requests, replies and logs
// ---------------------------------------------------------------------------

/** A random 127.x.y.z loopback source, never the trusted proxy: each is its own limiter subject. */
function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}

/** Every captured log line across the suite, and every secret-shaped value it handled: M7CC-10 joins the two. */
const ALL_LOG_LINES = [];
const SECRETS = new Set();

/** A customer name no other run shares, registered as a log canary. */
function canary(label) {
  const name = `M7CC ${label} ${SUFFIX}`;
  SECRETS.add(name);
  return name;
}

function send(port, method, path, headers, body, { localAddress } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
  const framed = method === 'GET' ? { ...headers } : { 'content-length': String(payload?.length ?? 0), ...headers };
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
    request.setTimeout(20_000, () => request.destroy(new Error(`no reply within 20 s: ${method} ${path}`)));
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

/** A raw request over a fresh socket: a repeated header line, a declared length with no body, or a hand-framed chunk. */
function rawRequest(port, text, { localAddress, timeoutMs = 10_000 } = {}) {
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

/** The baseline headers every reply carries, the HSTS one included (the tenant entry serves with hsts: true). */
function assertBaseline(reply, label) {
  assert.equal(reply.headers['strict-transport-security'], HSTS_HEADER.value, `${label}: HSTS`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(reply.headers[name.toLowerCase()], value, `${label}: ${name}`);
}

/** A refusal is the fixed `{ error, requestId }` and nothing else, never sets a cookie, and carries the baseline headers. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  const cookies = reply.setCookies ?? reply.headers['set-cookie'];
  assert.ok(cookies === undefined || cookies.length === 0, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
}

/** A created customer: 201, exactly { customer: { id, name } }, a version-4 id, no Location. Answers { id, name }. */
function createdOf(reply, name, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['customer'], label);
  assert.deepEqual(Object.keys(body.customer), ['id', 'name'], label);
  assert.match(body.customer.id, V4, `${label}: a server-generated version-4 id`);
  assert.equal(body.customer.name, name, label);
  assert.equal(reply.headers.location, undefined, `${label}: no Location (no customer-detail route exists)`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
  SECRETS.add(body.customer.id);
  return body.customer;
}

// ---------------------------------------------------------------------------
// fixtures — all written through the owner
// ---------------------------------------------------------------------------

async function actor(label, memberships, status = 'active') {
  const uid = `m7cc-${label}-${SUFFIX}`;
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
  return { id, uid, token, label, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });

async function newTenant(label, status = 'active') {
  const name = `m7cc-${label}-${SUFFIX}`;
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${name}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  SECRETS.add(id).add(name);
  return id;
}

const T_A = await setupStep(() => newTenant('a'));
const T_B = await setupStep(() => newTenant('b'));
const T_RO = await setupStep(() => newTenant('read-only', 'read_only'));
const T_OD = await setupStep(() => newTenant('overdue', 'overdue'));
const STORE_A = await setupStep(async () =>
  (await owner`insert into store (tenant_id, store_name, status) values (${T_A}, ${`m7cc-store-a-${SUFFIX}`}, 'active') returning store_id`)[0].store_id);

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
  return key;
}

/** A live, well-formed ADMINISTRATIVE session row minted as the runtime login through 018's admin branch: its identifier. */
async function adminSessionId(who) {
  const id = randomBytes(32).toString('base64url');
  const key = createHash('sha256').update(id).digest('base64url');
  KEYS.add(key);
  SECRETS.add(id).add(key);
  const runtime = testClient(TARGET, { user: RUNTIME_LOGIN, max: 1, onnotice: () => {} });
  try {
    const at = Date.now();
    const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, 'admin'::text, 'firebase'::text,
      ${who.uid}::text, ${principalKeyOf(who.principal)}::text, 'm7cc-admin'::text, ${at}::bigint, ${at}::bigint, ${at}::bigint,
      ${at}::bigint, ${at + SESSION_TTL.admin.absoluteMs}::bigint, null::bytea) as outcome`;
    assert.equal(outcome, 'created', 'an administrative row exists to be presented');
  } finally {
    await runtime.end({ timeout: 5 });
  }
  return id;
}

/** The runtime login's own connection, for the direct database attempts. */
const runtimeClient = () => testClient(TARGET, { user: RUNTIME_LOGIN, max: 1, onnotice: () => {} });
async function codeOf(query) {
  try { await query; return 'ok'; } catch (err) { return err?.code ?? String(err); }
}

// ---------------------------------------------------------------------------
// row counts: C/A/K/O (and L), as deltas around a case
// ---------------------------------------------------------------------------

async function counts() {
  const [r] = await owner`select
    (select count(*) from tmpos_customer.customer)::int as c,
    (select count(*) from public.audit_event where action_id = ${ACTION})::int as a,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as k,
    (select count(*) from tmpos_internal.outbox_event)::int as o,
    (select count(*) from tmpos_internal.idempotency_record)::int as l`;
  return { ...r };
}
/** The delta since `before`: C/A/K/O always, L only when `expected` names it. */
async function assertDelta(before, expected, label) {
  const now = await counts();
  const got = { C: now.c - before.c, A: now.a - before.a, K: now.k - before.k, O: now.o - before.o, L: now.l - before.l };
  assert.deepEqual(got, { ...got, ...expected }, `${label}: C/A/K/O/L`);
}
const NOTHING = Object.freeze({ C: 0, A: 0, K: 0, O: 0 });
const ONE = Object.freeze({ C: 1, A: 1, K: 1, O: 0 });

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

function makeCapture() {
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const log = { log: (line) => { lines.push(line); ALL_LOG_LINES.push(line); } };
  const exit = (code) => { codes.push(code); };
  return { lines, codes, proc, log, exit };
}

/** The headers of a well-formed unsafe tenant request presenting `s` (null: no session) and `key` (null: no key). */
function unsafeHeaders(s, key) {
  return {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }),
    'content-type': 'application/json',
    ...(key === null ? {} : { 'idempotency-key': key }),
  };
}

/** Start one tenant entry over its own relay, hand the test a bound request surface, then stop it. */
async function withEntry(overrides, fn) {
  const relay = startRelay();
  await relay.listening;
  const clientAddress = randomLoopback();
  const cap = makeCapture();
  const construction = {
    databaseClient: databaseClientOver(relay, overrides.kernelModule),
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  const result = await startTenantEntry({ env: ENV, construction, proc: cap.proc, exit: cap.exit, log: cap.log });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  const port = result.address.port;
  const ctx = {
    cap, relay, port, clientAddress,
    post: (s, body, { key = randomUUID(), headers = {}, drop = [], localAddress = clientAddress } = {}) => {
      // A malformed probe as short as 'abc' is no secret, and would match a request id by chance.
      if (key !== null && key.length >= 12) SECRETS.add(key);
      const all = { ...unsafeHeaders(s, key), ...headers };
      for (const name of drop) delete all[name];
      return send(port, 'POST', CUSTOMER_DIRECTORY_PATH, all, typeof body === 'string' ? body : JSON.stringify(body), { localAddress });
    },
    /** A hand-framed POST: the unsafe headers of `s`, then `lines` (each ending CRLF), then `tail` as the body bytes. */
    raw: (s, lines, tail = '') => {
      const head = Object.entries(unsafeHeaders(s, null)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      return rawRequest(port, `POST ${CUSTOMER_DIRECTORY_PATH} HTTP/1.1\r\n${head}${lines}Connection: close\r\n\r\n${tail}`, { localAddress: clientAddress });
    },
    list: (s, query = '?limit=100') => send(port, 'GET', `${CUSTOMER_DIRECTORY_PATH}${query}`, { host: TENANT_HOST, cookie: s.cookie }, undefined, { localAddress: clientAddress }),
    logout: (s) => send(port, 'POST', sessionPaths('tenant').logout, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf,
    }, undefined, { localAddress: clientAddress }),
    /** The refusal reason the runtime logged for one reply. */
    reason: (reply) => {
      const lines = cap.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
        .filter((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id']);
      assert.equal(lines.length, 1, 'exactly one log line for the request');
      return lines[0].reason ?? '-';
    },
  };
  try {
    return await fn(ctx);
  } finally {
    if (cap.codes.length === 0) {
      cap.proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; cap.codes.length === 0 && Date.now() < until;) await delay(10);
    }
    await relay.close().catch(() => {});
  }
}

/** A tenant login from a fresh loopback source (the login limit is per source): { cookie, csrf, key }. */
async function signIn(ctx, who) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${who.token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const csrf = JSON.parse(reply.body).csrfToken;
  SECRETS.add(csrf);
  return { cookie, csrf, key: await noteSession(cookie) };
}

/** Every customer the session's tenant read answers, following nextCursor: id -> name. */
async function customersOf(ctx, s) {
  const seen = new Map();
  let query = '?limit=100';
  for (let guard = 0; guard < 50; guard++) {
    const reply = await ctx.list(s, query);
    assert.equal(reply.status, 200, reply.body);
    const body = JSON.parse(reply.body);
    for (const c of body.customers) seen.set(c.id, c.name);
    if (body.nextCursor === null) return seen;
    SECRETS.add(body.nextCursor);
    query = `?limit=100&cursor=${body.nextCursor}`;
  }
  throw new Error('the walk did not end');
}

// ---------------------------------------------------------------------------
// levers: owner-held locks, owner triggers and competing owner writes, observed through pg_stat_activity
// (tests/db/adminRevocation.integration.test.mjs)
// ---------------------------------------------------------------------------

/** Hold locks in an OPEN owner transaction until released. */
async function hold(label, setup) {
  const ready = deferred();
  const release = deferred();
  const done = owner.begin(async (sql) => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    await setup(sql);
    ready.resolve({ pid });
    if ((await release.promise) === 'rollback') throw ROLLBACK;
  }).then(() => 'committed', (e) => (e === ROLLBACK ? 'rolled back' : `failed:${e?.message ?? e}`));
  const first = await Promise.race([ready.promise, done.then((v) => ({ early: v }))]);
  if ('early' in first) throw new Error(`${label}: the hold ended before it was taken (${first.early})`);
  let ending = null;
  const h = {
    ...first, label, done,
    end(how) {
      if (ending === null) { release.resolve(how); ending = done; OPEN.delete(h); }
      return ending;
    },
    commit: () => h.end('commit'),
    settle: () => h.end('rollback'),
  };
  OPEN.add(h);
  return h;
}
const holdAccount = (who) => hold('app_user for update', (sql) => sql`select 1 from public.app_user where internal_user_id = ${who.id} for update`);
/** The advisory key the parking trigger waits on, held until released. */
const holdPark = () => hold('the parking key', (sql) => sql`select pg_catalog.pg_advisory_xact_lock(${PARK[0]}::int, ${PARK[1]}::int)`);

/** An owner write: its backend pid once started, and 'committed' | 'failed:...' once settled. */
function ownerWrite(label, fn) {
  const started = deferred();
  const done = owner.begin(async (sql) => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    started.resolve({ pid });
    await fn(sql);
  }).then(() => 'committed', (e) => `failed:${e?.message ?? e}`);
  const write = { label, done, started: Promise.race([started.promise, done.then((v) => ({ early: v }))]) };
  OPEN.add(write);
  done.then(() => OPEN.delete(write));
  return write;
}
/** Wait until an owner write settles or waits on a Lock: { settled } | { blocked, blockers } | null (bound). */
async function ownerOutcome(write) {
  const s = await write.started;
  if ('early' in s) return { settled: s.early };
  let settled = null;
  write.done.then((v) => { settled = v; });
  for (const until = Date.now() + WAIT_MS; Date.now() < until; await tick()) {
    if (settled !== null) return { settled };
    const [row] = await probe`select wait_event_type, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = ${s.pid}`;
    if (settled !== null) return { settled };
    if (row?.wait_event_type === 'Lock') return { blocked: true, blockers: row.blockers };
  }
  return null;
}

/** Runtime-login backends waiting on a Lock now, filtered by blocker pid and statement text. */
async function blockedNow({ by = null, query = null } = {}) {
  const rows = await probe`select pid, query, pg_blocking_pids(pid) as blockers from pg_stat_activity
    where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
  return rows.filter((r) => (query === null || query.test(r.query)) && (by === null || r.blockers.includes(by)))
    .map((r) => ({ pid: r.pid, blockers: r.blockers }));
}
/** Wait until `request` settles or a runtime backend matching `criteria` waits on a Lock: { settled } | { blocked } | null. */
async function blockedOrSettled(request, criteria) {
  let settled = null;
  request.then((value) => { settled = { value }; }, (error) => { settled = { error: String(error) }; });
  for (const until = Date.now() + WAIT_MS; Date.now() < until; await tick()) {
    if (settled !== null) return { settled };
    const hit = await blockedNow(criteria);
    if (hit.length > 0) return { blocked: hit };
  }
  return settled !== null ? { settled } : null;
}
/** A request that must be waiting at `what`: its backend's pid — or a failure naming what happened instead. */
function waitingPid(outcome, what) {
  assert.ok(outcome !== null, `lever did not engage: ${what} not observed within ${WAIT_MS} ms`);
  assert.ok(outcome.blocked, `${what}: the request completed instead of waiting (${JSON.stringify(outcome.settled?.value?.status ?? outcome.settled)})`);
  return outcome.blocked[0].pid;
}
async function replyTo(request, label) {
  const reply = await within(request, label);
  assert.ok(typeof reply?.status === 'number', `no reply to ${label} within ${WAIT_MS} ms: ${JSON.stringify(reply)}`);
  return reply;
}

/**
 * `work` runs with ONE owner trigger BEFORE INSERT on `table` for each row matching `when`: it counts itself on
 * m7cc_proof.fired (a sequence, so the count survives the rollback it causes), then parks on the advisory key PARK, raises,
 * or returns NULL (the row is silently not inserted). Dropped, with its function, whatever `work` did.
 */
const TRIGGER_ACTIONS = Object.freeze({
  park: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); return new;`,
  raise: `raise exception 'M7CC injected fault' using errcode = 'P0001';`,
  skip: 'return null;',
});
async function withTrigger(table, when, action, work) {
  await owner.unsafe(`create function m7cc_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('m7cc_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function m7cc_proof.fire() from public');
  await owner.unsafe(`create trigger m7cc_fire before insert on ${table} for each row when (${when}) execute function m7cc_proof.fire()`);
  try {
    return await work();
  } finally {
    await owner.unsafe(`drop trigger if exists m7cc_fire on ${table}`);
    await owner.unsafe('drop function if exists m7cc_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('m7cc_proof.fired'::regclass), 0)::int as n`)[0].n;
/** A customer INSERT whose name starts `M7CC <prefix>` (canary names do): the parking and fault triggers' filter. */
const namedLike = (prefix) => `pg_catalog.starts_with(new.name, 'M7CC ${prefix}')`;
const CREATE_AUDIT = `new.action_id = '${ACTION}'`;

// ===========================================================================
// M7CC-01: create in the session's own tenant; isolation
// ===========================================================================

test('M7CC-01: sales_staff, store_owner and manager each create in their own tenant — 201 {customer:{id,name}}, no Location, one row, one tenant-scoped audit record, one completion, no outbox event — and only their own tenant reads it', async () => {
  const makers = [
    await actor('m7cc01-sales', [tenantGrant(T_A, 'sales_staff')]),
    await actor('m7cc01-owner', [tenantGrant(T_A, 'store_owner')]),
    await actor('m7cc01-manager', [tenantGrant(T_A, 'manager')]),
  ];
  const reader = await actor('m7cc01-b', [tenantGrant(T_B, 'manager')]);
  await withEntry({}, async (ctx) => {
    const b = await signIn(ctx, reader);
    const bBefore = await customersOf(ctx, b);
    for (const who of makers) {
      const s = await signIn(ctx, who);
      const name = canary(`created by ${who.label}`);
      const before = await counts();
      const created = createdOf(await ctx.post(s, { name }), name, who.label);
      await assertDelta(before, { ...ONE, L: 1 }, who.label);

      const [row] = await owner`select tenant_id, name from tmpos_customer.customer where customer_id = ${created.id}`;
      assert.deepEqual({ ...row }, { tenant_id: T_A, name }, `${who.label}: the row, in the session's tenant`);
      const audits = await owner`select scope_type, tenant_id, store_id, required_permission, metadata
        from public.audit_event where action_id = ${ACTION} and actor_internal_user_id = ${who.id}`;
      assert.equal(audits.length, 1, `${who.label}: one audit record, of the trusted actor`);
      assert.deepEqual({ ...audits[0] }, { scope_type: 'tenant', tenant_id: T_A, store_id: null, required_permission: 'create_customers', metadata: {} },
        `${who.label}: tenant scope from the trusted context; neither the name nor the id in its metadata`);

      assert.equal((await customersOf(ctx, s)).get(created.id), name, `${who.label}: its own tenant reads it`);
    }
    assert.deepEqual(await customersOf(ctx, b), bBefore, 'tenant B reads exactly what it read before');
  });
});

// ===========================================================================
// M7CC-02: no valid tenant session, or not the tenant host — nothing, not even a key
// ===========================================================================

test('M7CC-02: a missing, forged, idle-expired, absolute-expired, logged-out or administrative session, a store-only actor and a host other than the tenant host create nothing and acquire no key', async () => {
  const who = await actor('m7cc02', [tenantGrant(T_A, 'manager')]);
  const storeOnly = await actor('m7cc02-store', [{ scope: 'store', tenant: T_A, store: STORE_A, role: 'manager' }]);
  const admin = await actor('m7cc02-admin', [{ scope: 'platform', role: 'system_owner' }]);
  const adminId = await adminSessionId(admin);
  await withEntry({}, async (ctx) => {
    const idle = await signIn(ctx, who);
    const expired = await signIn(ctx, who);
    const ended = await signIn(ctx, who);
    const store = await signIn(ctx, storeOnly);
    // The owner ages two rows within 011's CHECKs: the idle window, then the absolute lifetime, passed with no request.
    const age = (s, ms) => owner`update tmpos_session.session set created_at = created_at - ${ms}::bigint,
      last_seen_at = last_seen_at - ${ms}::bigint, validated_at = validated_at - ${ms}::bigint where session_key = ${s.key}`;
    await age(idle, SESSION_TTL.tenant.idleMs + 1);
    await age(expired, SESSION_TTL.tenant.absoluteMs + 1);
    assert.equal((await ctx.logout(ended)).status, 204, 'the logout ends the session');
    const forged = randomBytes(32).toString('base64url');
    SECRETS.add(forged);
    const csrf = randomBytes(32).toString('base64url');

    const before = await counts();
    const name = canary('never created m7cc02');
    for (const [label, s, status, error, reason] of [
      ['no session', null, 401, 'unauthenticated', null],
      ['a forged session', { cookie: `${SESSION_COOKIES.tenant}=${forged}`, csrf }, 401, 'unauthenticated', null],
      ['an idle-expired session', idle, 401, 'unauthenticated', 'session_idle_expired'],
      ['an absolute-expired session', expired, 401, 'unauthenticated', 'session_expired'],
      ['a logged-out session', ended, 401, 'unauthenticated', null],
      ['an administrative session under its own cookie', { cookie: `${SESSION_COOKIES.admin}=${adminId}`, csrf }, 401, 'unauthenticated', 'session_missing'],
      ['an administrative session under the tenant cookie', { cookie: `${SESSION_COOKIES.tenant}=${adminId}`, csrf }, 401, 'unauthenticated', 'session_wrong_audience'],
      ['a store-only actor', store, 403, 'forbidden', null],
    ]) {
      const reply = await ctx.post(s, { name });
      assertRefusal(reply, status, error, label);
      if (reason !== null) assert.equal(ctx.reason(reply), reason, label);
    }
    const s = await signIn(ctx, who);
    for (const host of [ADMIN_HOST, 'unknown.tmpos.test', '127.0.0.1', `${TENANT_HOST}:443`, `${TENANT_HOST}.`]) {
      assertRefusal(await ctx.post(s, { name }, { headers: { host } }), 404, 'not_found', `the host ${host}`);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused before the key');
  });
});

// ===========================================================================
// M7CC-03: authority and standing
// ===========================================================================

test('M7CC-03: a technician, a read_only or overdue tenant, a read_only account, a technician with a store manager grant and two tenant grants are 403; a role, grant, tenant or account changed after login is 401 — nothing is written', async () => {
  const T_S = await newTenant('m7cc03-suspended');
  const refused = [
    ['a technician', await actor('m7cc03-tech', [tenantGrant(T_A, 'technician')])],
    ['a read_only tenant', await actor('m7cc03-ro-tenant', [tenantGrant(T_RO, 'manager')])],
    ['an overdue tenant', await actor('m7cc03-overdue', [tenantGrant(T_OD, 'store_owner')])],
    ['a read_only account', await actor('m7cc03-ro-account', [tenantGrant(T_A, 'manager')], 'read_only')],
    ['a tenant technician with a store manager grant', await actor('m7cc03-tech-store',
      [tenantGrant(T_A, 'technician'), { scope: 'store', tenant: T_A, store: STORE_A, role: 'manager' }])],
    ['two tenant grants', await actor('m7cc03-two', [tenantGrant(T_A, 'manager'), tenantGrant(T_B, 'manager')])],
  ];
  const changed = [
    ['the role changed to technician', await actor('m7cc03-demoted', [tenantGrant(T_A, 'manager')]),
      (who) => owner`update user_membership set role_id = 'technician' where internal_user_id = ${who.id}`],
    ['the grant suspended', await actor('m7cc03-grant', [tenantGrant(T_A, 'sales_staff')]),
      (who) => owner`update user_membership set status = 'suspended' where internal_user_id = ${who.id}`],
    ['the tenant suspended', await actor('m7cc03-tenant', [tenantGrant(T_S, 'manager')]),
      () => owner`update tenant set status = 'suspended' where tenant_id = ${T_S}`],
    ['the account suspended', await actor('m7cc03-account', [tenantGrant(T_A, 'manager')]),
      (who) => owner`update app_user set status = 'suspended' where internal_user_id = ${who.id}`],
  ];
  await withEntry({}, async (ctx) => {
    const before = await counts();
    const name = canary('never created m7cc03');
    for (const [label, who] of refused) {
      const s = await signIn(ctx, who);
      assertRefusal(await ctx.post(s, { name }), 403, 'forbidden', label);
    }
    for (const [label, who, change] of changed) {
      const s = await signIn(ctx, who);
      await change(who);
      assertRefusal(await ctx.post(s, { name }), 401, 'unauthenticated', label);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused before the key');
  });
});

// ===========================================================================
// M7CC-04: races decided inside the command transaction
// ===========================================================================

test('M7CC-04: a grant removal or tenant suspension committed before the command\'s deciding lock refuses it with nothing written; one attempted after — and a logout of the presenting session — waits, and the command commits first', async () => {
  await withEntry({}, async (ctx) => {
    // (a)/(b) The revocation commits first: the create waits on 016's hold (the owner holds the account), the revocation
    // commits meanwhile, then the create proceeds, re-reads, and refuses.
    const T_R1 = await newTenant('m7cc04-suspended-first');
    for (const [label, grantOn, revoke] of [
      ['the grant suspended first', T_A, (who) => (sql) => sql`update user_membership set status = 'suspended' where internal_user_id = ${who.id}`],
      ['the tenant suspended first', T_R1, () => (sql) => sql`update tenant set status = 'suspended' where tenant_id = ${T_R1}`],
    ]) {
      const who = await actor(`m7cc04-${label.split(' ')[1]}-first`, [tenantGrant(grantOn, 'manager')]);
      const s = await signIn(ctx, who);
      const name = canary(`${label} m7cc04`);
      const before = await counts();
      const h = await holdAccount(who);
      let pending;
      try {
        pending = quietly(ctx.post(s, { name }));
        waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_HOLD }), `${label}: the create waiting on 016's hold`);
        const outcome = await ownerOutcome(ownerWrite(label, revoke(who)));
        assert.equal(outcome?.settled, 'committed', `${label}: the revocation commits while the create waits (${JSON.stringify(outcome)})`);
      } finally {
        await h.commit();
      }
      assertRefusal(await replyTo(pending, label), 503, 'service_unavailable', `${label}: the create refuses inside its transaction`);
      await assertDelta(before, { ...NOTHING, L: 1 }, `${label}: nothing written; the lease, taken before, stays`);
      assertRefusal(await ctx.post(s, { name }), 401, 'unauthenticated', `${label}: the next request`);
    }

    // (c)/(d)/(e) The command locks first: parked at its INSERT (after every hold), a grant removal, a tenant suspension
    // and a logout each wait for it; it commits, then they do.
    const T_R2 = await newTenant('m7cc04-suspended-after');
    for (const [label, grantOn, competitor] of [
      ['a grant removal', T_A, (who) => ({ write: (sql) => sql`update user_membership set status = 'suspended' where internal_user_id = ${who.id}` })],
      ['a tenant suspension', T_R2, () => ({ write: (sql) => sql`update tenant set status = 'suspended' where tenant_id = ${T_R2}` })],
      ['a logout of the presenting session', T_A, (_who, s) => ({ request: quietly(ctx.logout(s)) })],
    ]) {
      const who = await actor(`m7cc04-after-${label.split(' ').at(-1)}`, [tenantGrant(grantOn, 'manager')]);
      const s = await signIn(ctx, who);
      const name = canary(`park ${label}`);
      const before = await counts();
      await withTrigger('tmpos_customer.customer', namedLike('park'), 'park', async () => {
        const lever = await holdPark();
        let pending;
        let rival;
        try {
          pending = quietly(ctx.post(s, { name }));
          const commandPid = waitingPid(await blockedOrSettled(pending, { by: lever.pid }), `${label}: the create parked at its INSERT`);
          rival = competitor(who, s);
          if (rival.write !== undefined) {
            rival.done = ownerWrite(label, rival.write);
            const outcome = await ownerOutcome(rival.done);
            assert.ok(outcome?.blocked && outcome.blockers.includes(commandPid), `${label} waits for the create (${JSON.stringify(outcome)})`);
          } else {
            waitingPid(await blockedOrSettled(rival.request, { by: commandPid }), `${label} waits for the create`);
          }
        } finally {
          await lever.commit();
        }
        createdOf(await replyTo(pending, label), name, `${label}: the create commits first`);
        if (rival.write !== undefined) assert.equal(await within(rival.done.done, label), 'committed', `${label} commits after`);
        else assert.equal((await replyTo(rival.request, label)).status, 204, `${label} ends the session after`);
      });
      await assertDelta(before, { ...ONE, L: 1 }, label);
      assertRefusal(await ctx.post(s, { name }), 401, 'unauthenticated', `${label}: the next request`);
    }
  });
});

// ===========================================================================
// M7CC-05: the Idempotency-Key
// ===========================================================================

test('M7CC-05: a missing, malformed or repeated key refuses before any write; a same-body replay is the same 201 and one customer; a changed body is 422; two keys make two customers; another actor\'s key is its own; the same principal moved to another tenant replays nothing; a replay after logout is 401', async () => {
  const who = await actor('m7cc05', [tenantGrant(T_A, 'manager')]);
  const peer = await actor('m7cc05-peer', [tenantGrant(T_A, 'sales_staff')]);
  const mover = await actor('m7cc05-mover', [tenantGrant(T_A, 'manager')]);
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, who);

    let before = await counts();
    const refusedName = canary('key refused');
    const body = JSON.stringify({ name: refusedName });
    for (const [label, key, reason] of [
      ['no key', null, 'idempotency_key_missing'],
      ['a version-1 UUID', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'idempotency_key_invalid'],
      ['a short token', 'abc', 'idempotency_key_invalid'],
      ['a UUID with braces', `{${randomUUID().slice(0, 34)}}`, 'idempotency_key_invalid'],
    ]) {
      const reply = await ctx.post(s, body, { key });
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), reason, label);
    }
    const twice = await ctx.raw(s, `Idempotency-Key: ${randomUUID()}\r\nIdempotency-Key: ${randomUUID()}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`, body);
    assertRefusal(twice, 400, 'invalid_request', 'two Idempotency-Key lines');
    assert.equal(ctx.reason(twice), 'idempotency_key_duplicated');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'no key acquired');

    // Same key, same body: the recorded 201, byte for byte, marked a replay; still one customer.
    const key = randomUUID();
    const name = canary('replayed');
    before = await counts();
    const first = await ctx.post(s, { name }, { key });
    const made = createdOf(first, name, 'the first attempt');
    const again = await ctx.post(s, { name }, { key });
    assert.deepEqual(createdOf(again, name, 'the replay', { replayed: true }), made);
    assert.equal(again.body, first.body, 'the recorded body, byte for byte');
    await assertDelta(before, { ...ONE, L: 1 }, 'one create under one key');

    // Same key, another body: the existing conflict policy; nothing new.
    before = await counts();
    assertRefusal(await ctx.post(s, { name: canary('another body') }, { key }), 422, 'idempotency_key_reused', 'a changed body');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'a changed body');

    // Two keys, one name: two customers (no uniqueness rule exists).
    const same = canary('twice under two keys');
    before = await counts();
    const x = createdOf(await ctx.post(s, { name: same }), same, 'first key');
    const y = createdOf(await ctx.post(s, { name: same }), same, 'second key');
    assert.notEqual(x.id, y.id);
    const listed = await customersOf(ctx, s);
    assert.ok(listed.get(x.id) === same && listed.get(y.id) === same, 'both listed');
    await assertDelta(before, { C: 2, A: 2, K: 2, O: 0, L: 2 }, 'two keys');

    // The same key and body from another actor of the same tenant: its own operation, never the first actor's answer.
    before = await counts();
    const other = createdOf(await ctx.post(await signIn(ctx, peer), { name }, { key }), name, 'another actor, same key and body');
    assert.notEqual(other.id, made.id);
    await assertDelta(before, { ...ONE, L: 1 }, 'another actor');

    // The same principal moved to tenant B (its grant re-pointed by the owner), signed in again: A's key and body are
    // A's operation — the conflict policy, never A's customer, and nothing created in B.
    const m = await signIn(ctx, mover);
    const moveKey = randomUUID();
    const moveName = canary('before the move');
    const inA = createdOf(await ctx.post(m, { name: moveName }, { key: moveKey }), moveName, 'created in A');
    await owner`update user_membership set tenant_id = ${T_B} where internal_user_id = ${mover.id} and scope_type = 'tenant'`;
    assertRefusal(await ctx.post(m, { name: moveName }, { key: moveKey }), 401, 'unauthenticated', 'the move ended the session');
    const moved = await signIn(ctx, mover);
    before = await counts();
    const replayInB = await ctx.post(moved, { name: moveName }, { key: moveKey });
    assertRefusal(replayInB, 422, 'idempotency_key_reused', 'A\'s key and body presented in B');
    assert.ok(!replayInB.body.includes(inA.id), 'never A\'s customer');
    assert.ok(!(await customersOf(ctx, moved)).has(inA.id), 'B does not read A\'s customer');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'nothing in B');

    // A replay never bypasses the session: after logout, the recorded key answers 401.
    assert.equal((await ctx.logout(s)).status, 204);
    before = await counts();
    assertRefusal(await ctx.post(s, { name }, { key }), 401, 'unauthenticated', 'a replay after logout');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'a replay after logout');
  });
});

// ===========================================================================
// M7CC-06: two instances, one database, one key
// ===========================================================================

test('M7CC-06: two tenant entries over one database with the identical IDEMPOTENCY_KEY commit at most one customer for one key — deterministically (the second is refused while the first commits, then replays it) and under a concurrent burst', async () => {
  const who = await actor('m7cc06', [tenantGrant(T_A, 'manager')]);
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const s = await signIn(a, who);

    // Deterministic: A's create waits on 016's hold with its lease taken, and A's transaction already holds the record's
    // row FOR UPDATE (006's fence, taken before the hold). B, same key, starts its acquire with SELECT ... FOR UPDATE on
    // that row, so it can only wait on A until its lock bound and answer 503 idempotency_unavailable — never 409, which it
    // answers only on reading a live lease no transaction holds (reachable in the burst below, not here), and never a
    // plan; A commits; B replays A's answer.
    const key = randomUUID();
    const name = canary('two instances, one key');
    let before = await counts();
    const h = await holdAccount(who);
    let pending;
    try {
      pending = quietly(a.post(s, { name }, { key }));
      const aPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_HOLD }), 'A\'s create waiting on 016\'s hold');
      const request = quietly(b.post(s, { name }, { key }));
      const seen = await blockedOrSettled(request, { by: aPid });
      const second = await replyTo(request, 'B');
      assertRefusal(second, 503, 'service_unavailable', 'B while A commits');
      assert.equal(b.reason(second), 'idempotency_unavailable', 'B while A commits: its acquire ran out its lock bound');
      assert.ok(seen?.blocked?.some((w) => w.pid !== aPid && w.blockers.includes(aPid)),
        `B's backend waited with A's among its blockers (${JSON.stringify(seen)})`);
    } finally {
      await h.commit();
    }
    const won = createdOf(await replyTo(pending, 'A'), name, 'A commits');
    assert.deepEqual(createdOf(await b.post(s, { name }, { key }), name, 'B replays A\'s answer', { replayed: true }), won);
    await assertDelta(before, { ...ONE, L: 1 }, 'deterministic');

    // A burst: eight same-key requests alternating between the instances. Exactly one plans and commits; every other is
    // in progress, unavailable while the winner commits, or the winner's answer replayed.
    const burstKey = randomUUID();
    const burstName = canary('burst');
    before = await counts();
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? a : b).post(s, { name: burstName }, { key: burstKey })));
    const fresh = replies.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] === undefined);
    assert.equal(fresh.length, 1, `one fresh 201: ${replies.map((r) => r.status).join(',')}`);
    const winner = createdOf(fresh[0], burstName, 'the winner');
    for (const r of replies.filter((reply) => reply !== fresh[0])) {
      if (r.status === 201) assert.deepEqual(createdOf(r, burstName, 'a replay', { replayed: true }), winner);
      else if (r.status === 409) assertRefusal(r, 409, 'request_in_progress', 'in progress');
      else assertRefusal(r, 503, 'service_unavailable', 'unavailable while the winner commits');
    }
    await assertDelta(before, { ...ONE, L: 1 }, 'burst');

    // A replay through either instance after the session ended is 401.
    assert.equal((await b.logout(s)).status, 204);
    assertRefusal(await a.post(s, { name }, { key }), 401, 'unauthenticated', 'a replay after logout, A');
    assertRefusal(await b.post(s, { name: burstName }, { key: burstKey }), 401, 'unauthenticated', 'a replay after logout, B');
  }));
});

// ===========================================================================
// M7CC-07: the request itself
// ===========================================================================

test('M7CC-07: malformed, oversized, extra-field and non-object bodies, every refused name class, a wrong Content-Type, Origin or CSRF are bounded refusals that write nothing; admitted names are stored exactly (trimmed at the edges); the request limiter answers 429', async () => {
  const who = await actor('m7cc07', [tenantGrant(T_A, 'manager')]);
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, who);
    const name = canary('never created m7cc07');
    const body = JSON.stringify({ name });

    // Refused before any key is acquired: the framing, the media type, Origin and CSRF, and the JSON itself (Host: M7CC-02).
    let before = await counts();
    for (const [label, request, status, error, reason] of [
      ['malformed JSON', () => ctx.post(s, '{"name":'), 400, 'invalid_request', 'body_malformed'],
      ['an empty body', () => ctx.post(s, ''), 400, 'invalid_request', 'body_required'],
      ['text/plain', () => ctx.post(s, body, { headers: { 'content-type': 'text/plain' } }), 415, 'unsupported_media_type', 'media_type_unsupported'],
      ['no Content-Type', () => ctx.post(s, body, { drop: ['content-type'] }), 415, 'unsupported_media_type', 'media_type_missing'],
      ['a declared length over the cap', () => ctx.raw(s, `Idempotency-Key: ${randomUUID()}\r\nContent-Length: 4097\r\n`), 413, 'content_too_large', 'body_declared_too_large'],
      ['a streamed body over the cap', () => {
        const big = JSON.stringify({ name: 'x'.repeat(5_000) });
        return ctx.raw(s, `Idempotency-Key: ${randomUUID()}\r\nTransfer-Encoding: chunked\r\n`, `${Buffer.byteLength(big).toString(16)}\r\n${big}\r\n0\r\n\r\n`);
      }, 413, 'content_too_large', 'body_streamed_too_large'],
      ['a foreign Origin', () => ctx.post(s, body, { headers: { origin: 'https://evil.test' } }), 403, 'forbidden', 'csrf_origin_mismatch'],
      ['the admin Origin', () => ctx.post(s, body, { headers: { origin: ADMIN_ORIGIN } }), 403, 'forbidden', 'csrf_origin_mismatch'],
      ['no Origin', () => ctx.post(s, body, { drop: ['origin'] }), 403, 'forbidden', 'csrf_origin_missing'],
      ['a cross-site fetch', () => ctx.post(s, body, { headers: { 'sec-fetch-site': 'cross-site' } }), 403, 'forbidden', 'csrf_cross_site'],
      ['no pre-session CSRF header', () => ctx.post(s, body, { drop: [CSRF_HEADER] }), 403, 'forbidden', 'csrf_token_missing'],
      ['no session CSRF', () => ctx.post(s, body, { drop: [SESSION_CSRF_HEADER] }), 403, 'forbidden', null],
      ['a wrong session CSRF', () => ctx.post(s, body, { headers: { [SESSION_CSRF_HEADER]: randomBytes(32).toString('base64url') } }), 403, 'forbidden', null],
    ]) {
      const reply = await request();
      assertRefusal(reply, status, error, label);
      if (reason !== null) assert.equal(ctx.reason(reply), reason, label);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused before the key');

    // Refused by the command's own contract, once the key is acquired: the lease is taken and nothing else is written.
    const refused = [
      ['an extra tenantId field', { name, tenantId: T_B }],
      ['an extra id field', { name, id: randomUUID() }],
      ['an array', []],
      ['an empty object', {}],
      ['a JSON string', '"x"'],
      ['JSON null', 'null'],
      ['a number name', { name: 1 }],
      ['a null name', { name: null }],
      ['an empty name', { name: '' }],
      ['201 scalars', { name: 'x'.repeat(201) }],
      ['whitespace only', { name: ' \t　 ' }],
      ...[['ZERO WIDTH SPACE', '​'], ['WORD JOINER', '⁠'], ['SOFT HYPHEN', '­'], ['HANGUL FILLER', 'ㅤ'],
        ['BRAILLE PATTERN BLANK', '⠀'], ['a combining mark alone', '́']].map(([what, c]) => [`${what} only`, { name: `${c}${c}` }]),
      ...[['BEL', '\u0007'], ['NUL', '\u0000'], ['DEL', '\u007F'], ['NEL (C1)', '\u0085'], ['LINE SEPARATOR', ' '],
        ['PARAGRAPH SEPARATOR', ' '], ['RIGHT-TO-LEFT OVERRIDE', '‮'], ['LEFT-TO-RIGHT MARK', '‎'], ['FIRST STRONG ISOLATE', '⁨']]
        .map(([what, c]) => [`a ${what}`, { name: `Acme${c}Ltd` }]),
      ['a lone surrogate (JSON escape)', '{"name":"Acme\\uD800Ltd"}'],
    ];
    before = await counts();
    for (const [label, payload] of refused) {
      const reply = await ctx.post(s, typeof payload === 'string' ? payload : JSON.stringify(payload));
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'command_request_invalid', label);
      for (const c of Object.values(typeof payload === 'object' ? payload : {})) assert.ok(typeof c !== 'string' || c.length < 8 || !reply.body.includes(c), `${label}: nothing echoed`);
    }
    await assertDelta(before, { ...NOTHING, L: refused.length }, 'refused by the contract');

    // Admitted: stored exactly as answered — the edges trimmed, everything inside kept, nothing normalized.
    before = await counts();
    const admitted = [
      ['200 astral scalars', '\u{1F600}'.repeat(200), '\u{1F600}'.repeat(200)],
      ['a ZWJ sequence', canary('zwj \u{1F469}‍\u{1F4BB}'), null],
      ['internal spaces', canary('two  inner  spaces'), null],
      ['edge whitespace', ` \t ${canary('trimmed')} 　\n`, canary('trimmed')],
      ['a decomposed accent', canary('Café'), null],
    ];
    for (const [label, sent, stored] of admitted) {
      const expected = stored ?? sent;
      const created = createdOf(await ctx.post(s, { name: sent }), expected, label);
      const [row] = await owner`select name from tmpos_customer.customer where customer_id = ${created.id}`;
      assert.equal(row.name, expected, `${label}: stored byte for byte`);
    }
    await assertDelta(before, { C: admitted.length, A: admitted.length, K: admitted.length, O: 0 }, 'admitted');

    // The request limiter: RATE_LIMITS.request spent from one source (cheap unauthenticated reads), then the create from it.
    const limited = randomLoopback();
    for (let sent = 0; sent < RATE_LIMITS.request.limit; sent += 25) {
      await Promise.all(Array.from({ length: Math.min(25, RATE_LIMITS.request.limit - sent) },
        () => send(ctx.port, 'GET', CUSTOMER_DIRECTORY_PATH, { host: TENANT_HOST }, undefined, { localAddress: limited })));
    }
    before = await counts();
    const throttled = await ctx.post(s, body, { localAddress: limited });
    assertRefusal(throttled, 429, 'rate_limited', 'the request limit spent');
    assert.ok(Number(throttled.headers['retry-after']) >= 1, 'a Retry-After');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'throttled');
  });
});

// ===========================================================================
// M7CC-08: failure atomicity and the lost COMMIT answer
// ===========================================================================

test('M7CC-08: an audit INSERT that raises or writes no row, a 019 refusal, and a raise or a row not written inside 019 each roll the whole command back (503, nothing written, the lease kept); a COMMIT whose answer is lost is a 503 and the retry replays what committed', async () => {
  const who = await actor('m7cc08', [tenantGrant(T_A, 'manager')]);
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, who);
    for (const [label, table, when, action] of [
      ['the audit INSERT raises', 'public.audit_event', CREATE_AUDIT, 'raise'],
      ['the audit INSERT writes no row', 'public.audit_event', CREATE_AUDIT, 'skip'],
      ['the customer INSERT inside 019 raises', 'tmpos_customer.customer', namedLike('fault'), 'raise'],
      // 019 checks its INSERT wrote the row: an owner trigger returning NULL raises no_data_found, never a 201 with no customer.
      ['the customer INSERT inside 019 writes no row', 'tmpos_customer.customer', namedLike('fault'), 'skip'],
    ]) {
      const key = randomUUID();
      const name = canary(`fault ${label}`);
      const before = await counts();
      const firedBefore = await fired();
      const reply = await withTrigger(table, when, action, () => ctx.post(s, { name }, { key }));
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      await assertDelta(before, { ...NOTHING, L: 1 }, label);
      // The lease was taken in its own transaction and is not reported rolled back: a retry within it is in progress.
      assertRefusal(await ctx.post(s, { name }, { key }), 409, 'request_in_progress', `${label}: the retry within the lease`);
    }

    // 019 refuses (no row) after the revalidator admitted the command: only 019 reads the mint ledger on this path.
    const unminted = await signIn(ctx, who);
    await owner`delete from tmpos_mint.tenant_session where session_key = ${unminted.key}`;
    let before = await counts();
    assertRefusal(await ctx.post(unminted, { name: canary('refused by 019') }), 503, 'service_unavailable', '019 answers no row');
    await assertDelta(before, { ...NOTHING, L: 1 }, '019 refused');

    // The COMMIT reaches the server and its answer is dropped: unknown, so a 503 — never a 201 before the commit is known.
    const key = randomUUID();
    const name = canary('lost commit answer');
    before = await counts();
    const trap = loseCommitAnswer(ctx.relay);
    let reply;
    try {
      reply = await ctx.post(s, { name }, { key });
    } finally {
      trap.release();
    }
    assert.equal(trap.silenced.length, 1, 'one COMMIT reached the server, and its answer was dropped');
    assertRefusal(reply, 503, 'service_unavailable', 'the lost answer');
    assert.equal(ctx.reason(reply), 'transaction_timeout', 'the outcome was unknown at the port deadline');
    let row;
    for (const until = Date.now() + 5_000; row === undefined && Date.now() < until; await delay(50)) {
      [row] = await owner`select customer_id from tmpos_customer.customer where name = ${name}`;
    }
    assert.ok(row !== undefined, 'what committed becomes visible');
    await assertDelta(before, { ...ONE, L: 1 }, 'the commit landed whole');
    // The retry resolves through the retained completion: the committed customer, replayed — never a second one.
    assert.equal(createdOf(await ctx.post(s, { name }, { key }), name, 'the retry', { replayed: true }).id, row.customer_id);
    assertRefusal(await ctx.post(s, { name: canary('changed after the lost answer') }, { key }), 422, 'idempotency_key_reused', 'a changed retry');
    await assertDelta(before, { ...ONE, L: 1 }, 'never a second customer');
  });
});

// ===========================================================================
// M7CC-09: the runtime login itself
// ===========================================================================

// M7A-CUSTOMERS-P3-R1: the routine the login can call is 020's tmpos_role.m7a_customer_create (019's decided on the role's
// name alone and is revoked from the login, with its schema's USAGE); the direct calls below go to it, and 019's is refused.
test('M7CC-09: as the runtime login, no direct write reaches the customer table (42501) and 019\'s create is closed (42501); a technician\'s live key creates nothing; another tenant\'s key creates only in its own tenant — the routine takes no tenant argument', async () => {
  const tech = await actor('m7cc09-tech', [tenantGrant(T_A, 'technician')]);
  const bManager = await actor('m7cc09-b', [tenantGrant(T_B, 'manager')]);
  const [{ args }] = await owner`select pg_catalog.pg_get_function_identity_arguments('tmpos_role.m7a_customer_create(text, uuid, text)'::regprocedure) as args`;
  assert.equal(args, 'p_session_key text, p_customer_id uuid, p_name text', 'the session key is the only authority argument');
  await withEntry({}, async (ctx) => {
    const techSession = await signIn(ctx, tech);
    const bSession = await signIn(ctx, bManager);
    const runtime = runtimeClient();
    try {
      const name = canary('direct');
      const before = await counts();
      for (const [label, query] of [
        ['INSERT', runtime`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${randomUUID()}, ${T_A}, ${name})`],
        ['UPDATE', runtime`update tmpos_customer.customer set name = ${name} where tenant_id = ${T_A}`],
        ['DELETE', runtime`delete from tmpos_customer.customer where tenant_id = ${T_A}`],
        ['TRUNCATE', runtime`truncate tmpos_customer.customer`],
      ]) assert.equal(await codeOf(query), '42501', `${label} on the customer table`);
      // 019's routine, with a live key it would once have honoured (B's manager): permission denied, nothing written.
      assert.equal(await codeOf(runtime`select * from tmpos_customer_write.m7a_customer_create(${bSession.key}::text, ${randomUUID()}::uuid, ${name}::text)`),
        '42501', '019\'s create is closed to the runtime login');
      const none = await runtime`select * from tmpos_role.m7a_customer_create(${techSession.key}::text, ${randomUUID()}::uuid, ${name}::text)`;
      assert.equal(none.length, 0, 'a technician\'s live key: no row');
      await assertDelta(before, { ...NOTHING, L: 0 }, 'nothing written');

      // B's live key, called by the login directly: there is no tenant to name, so the one row lands in B, never in A.
      const [{ n: inA }] = await owner`select count(*)::int as n from tmpos_customer.customer where tenant_id = ${T_A}`;
      const id = randomUUID();
      const made = await runtime`select * from tmpos_role.m7a_customer_create(${bSession.key}::text, ${id}::uuid, ${name}::text)`;
      const [{ membership_id: grant }] = await owner`select membership_id from user_membership where internal_user_id = ${bManager.id}`;
      assert.deepEqual(made.map((r) => ({ ...r })), [{ o_tenant_id: T_B, o_actor_id: bManager.id, o_membership_id: grant }],
        'the key\'s own tenant, actor and grant');
      const [row] = await owner`select tenant_id from tmpos_customer.customer where customer_id = ${id}`;
      assert.equal(row.tenant_id, T_B, 'created in the key\'s own tenant');
      const [{ n: inAAfter }] = await owner`select count(*)::int as n from tmpos_customer.customer where tenant_id = ${T_A}`;
      assert.equal(inAAfter, inA, 'nothing in A');
    } finally {
      await runtime.end({ timeout: 5 });
    }
  });
});

// ===========================================================================
// M7CC-10: logs (declared last)
// ===========================================================================

test('M7CC-10: no captured log line carries a customer name or id, a session identifier, key or CSRF token, an Idempotency-Key, a token or a key — nor does the server log of a cluster this file started', () => {
  const forbidden = [
    'synthetic-pw',
    ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)]),
    ...SECRETS,
  ];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const line of ALL_LOG_LINES) {
    for (const needle of forbidden) assert.ok(!line.includes(needle), `a log line leaked a value: ${String(needle).slice(0, 6)}...`);
  }
  if (cluster !== null) {
    const log = readFileSync(`${cluster.root}/postgres.log`, 'utf8');
    const leaked = forbidden.filter((v) => log.includes(v));
    assert.deepEqual(leaked.map((v) => String(v).slice(0, 6)), [], 'nothing of these in the server log');
  }
});
