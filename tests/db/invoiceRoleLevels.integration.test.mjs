// M5-INVOICES-AUTH-P1 — THE OWNER'S INVOICES LEVEL OVER HTTP: the tenant entry (server/entry/tenantEntry.ts,
// startTenantEntry) over REAL loopback HTTP and a disposable PostgreSQL holding every migration in the directory (001-032),
// composed as tests/db/roleLevels.integration.test.mjs composes it. PUT /api/v1/roles/levels with domain 'invoices' writes
// through migration 026's tmpos_role_invoice.m7a_invoice_role_level_set; GET /api/v1/roles/levels/invoices reads 026's
// m7a_invoice_role_level_states. (M7B-INVOICES-P1 UPDATE: migration 028's invoice-draft routes now decide on this level;
// tests/db/invoiceDraftsHttp.integration.test.mjs proves it.) As first written: the Invoices level is AUTHORIZATION
// CONFIGURATION ONLY: no invoice route exists, and
// nothing here claims an invoice operation is decided or enforced by the server on it.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — the same three things roleLevels.integration substitutes, none on the path under
// test: the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime LOGIN,
// tmpos_m5irlh_probe, holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can also drop a
// COMMIT's answer), the identity verifier (a synthetic bearer-token map whose authentication time a test may age) and the
// listener (127.0.0.1:0). Everything else — Host, Origin/CSRF, the tenant session boundary, the tenant authorizer and its
// role-level read, step-up, the idempotency store, the command transaction and its revalidator, 026's routines, the audit
// writer and the completion — is production's own code, unmodified.
//
// WHAT IS PROVEN (each case in tenants of its own; E/A/K/O/L are the edit audit records, ALL audit records (any action, any
// tenant — a refusal or a read adds none; sign-ins, which are audited, happen outside those windows), sealed completions,
// outbox rows and every idempotency row, as owner-read deltas; `state` is a tenant's stored levels and versions in BOTH domains):
//   M5IRLH-01 AC-02 defaults: a fresh tenant reads every catalog Invoices default (manager full, technician view, sales_staff
//             create; source default, version 0), no-store, no session material; any query is 400; a read writes nothing.
//   M5IRLH-02 AC-03 durable edit: the owner's Invoices PUT answers 200 {roleLevel} at version 1 with one tenant-scope audit
//             record (role_sales_staff_invoices_to_view) and one completion; a SEPARATE entry instance, on a new session,
//             reads it back as stored. The resolver's INPUT is shown, not its output: 020's levels read (the one the tenant
//             authorizer and the revalidator call) answers the Invoices level as the runtime login, and the Customers
//             decisions made on that same read still pass (no fault). No HTTP route exposes the materialized Invoices
//             permission (no invoice route exists); its materialization is server/platform-identity/m5CanonicalPermissions.test.ts's.
//   M5IRLH-03 AC-04 isolation: an Invoices edit leaves the Customers read, rows and versions as they were (and Customers
//             decisions unchanged), a Customers edit leaves the Invoices ones; tenant A's edit never reaches tenant B; the
//             same role/level/precondition in the two domains is two requests — one key for both is 422, and the two
//             audit records carry different reason codes.
//   M5IRLH-04 AC-05 the edit's authority: manager, technician, sales_staff, a store-scope owner, another tenant's owner
//             (asserting this tenant), owners demoted or suspended after login, administrative sessions, no session, the
//             wrong Host, a stale sign-in and a missing or wrong Origin/CSRF/Idempotency-Key are all refused with no level,
//             version, audit record or completion; malformed Invoices bodies are 400.
//   M5IRLH-05 AC-05 the read's authority: the same 403/401/404/400 answers as the Customers read-back (M7RL-G02/G04).
//   M5IRLH-06 AC-06 the precondition: a stale version or another tenant is an UNSEALED 409 write_conflict, nothing written,
//             the lease kept; default -> none -> default moves the version twice, so the first read's draft stays refused.
//   M5IRLH-07 AC-06 two entries race on one role row: an Invoices edit parked holding the row makes the other instance's
//             Invoices edit (same precondition) wait INSIDE 026's set routine; the first commits, the second is 409 — and,
//             parked the same way, it never holds back a Customers edit of the same role (another row).
//   M5IRLH-08 AC-07 atomicity: an audit INSERT that raises rolls the Invoices edit back whole (503, the lease kept, 409 within it).
//   M5IRLH-09 AC-08 idempotency: the same key and body replay the recorded 200 byte for byte; another body is 422; a COMMIT
//             whose answer is lost is a 503, and the same-key retry replays what committed (unknown is not a rollback).
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. On a shared service it removes
// its own role-level rows in BOTH domains (021's versions first: 026's rollback refuses while any Invoices row exists),
// customer, session and mint-ledger rows and its proof schema, restores the limiter's fingerprint and the issuer key row it
// found, drops its triggers and its login, and asserts none of its Invoices rows remain. What it leaves is what every suite
// leaves: its synthetically named identities, tenants and stores, their audit records and idempotency records.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriverVia } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { principalKeyOf, RECENT_AUTH_MAX_AGE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER, SESSION_TTL } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5irlh-migrator', runtimeRef: 'm5irlh-runtime' };
const LOCK_KEY = 528_526;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m5irlh_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** The edit and the two read-backs, pinned as literals (roleLevels.integration's idiom). */
const ROLE_LEVELS_PATH = '/api/v1/roles/levels';
const INVOICES_PATH = '/api/v1/roles/levels/invoices';
const CUSTOMERS_PATH = '/api/v1/customers';
const EDIT_ACTION = 'tenant.role.level.update';
/** A reason the edit route admits: trimmed, 10-500 scalars. */
const REASON = 'Owner review of invoice access';
const WAIT_MS = 10_000;
const COMMAND_LOCK_BOUND_MS = Math.floor(COMMAND_TRANSACTION_DEADLINE_MS * 0.7);
/** The advisory key the parking trigger waits on (two-int space; roleLevels uses 20, roleLevelPrecondition 21). */
const PARK = [528_526, 26];
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });

const TARGET = resolveDisposableTarget('M5IRLH');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}

const owner = testClient(TARGET, { max: 4, onnotice: () => {} });
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

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => delay(5);
const quietly = (p) => { p.catch(() => {}); return p; };
async function within(promise, label) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: label }), WAIT_MS); });
  try { return await Promise.race([promise, bound]); } finally { clearTimeout(timer); }
}
const ROLLBACK = Symbol('rollback');
const OPEN = new Set();

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const open of [...OPEN]) await step(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
    await step(() => owner.unsafe('drop schema if exists m5irlh_proof cascade'));
    if (TENANTS.length > 0) {
      // 021's and 026's rollbacks refuse while a version row (026's: an Invoices row of either table) exists: versions first,
      // then levels, in BOTH domains; then this suite's customers (017's down refuses while one exists).
      await step(() => owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`);
      await step(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
      await step(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
      await step(async () => {
        const [{ n }] = await owner`select ((select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))
          + (select count(*) from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])))::int as n`;
        assert.equal(n, 0, 'no level or version row of this suite remains, in either domain');
      });
    }
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
  if (failures.length > 0) throw new AggregateError(failures, 'M5IRLH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'M5IRLH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay (roleLevels.integration's): a trap can drop a COMMIT's answer
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket'
    ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) }
    : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m5irlh-relay-'));
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
const COMMIT_PARSE = Buffer.from('\0commit\0');

/** On the first connection that sends the audit INSERT, the next COMMIT is forwarded and its answer dropped (M7RLH-07). */
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
// setup: every migration in the directory, the runtime login, the three keys, the proof schema
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
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
});

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
  await owner.unsafe('drop schema if exists m5irlh_proof cascade');
  await owner.unsafe('create schema m5irlh_proof');
  await owner.unsafe('revoke all on schema m5irlh_proof from public');
  await owner.unsafe('create sequence m5irlh_proof.fired');
});

// ---------------------------------------------------------------------------
// identities and configuration
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
    return { uid: rec.uid, authTime: rec.authTimeSec ?? Math.floor((Date.now() - rec.authAgeMs) / 1000), secondFactor: 'totp' };
  },
});

const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
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
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account',
    project_id: 'm5irlh-test-project',
    client_email: 'm5irlh-test@m5irlh-test-project.iam.gserviceaccount.com',
    private_key: FIREBASE_PRIVATE_KEY,
  }),
});

// ---------------------------------------------------------------------------
// requests and replies
// ---------------------------------------------------------------------------

function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}
const nameOf = (label) => `M5IRLH ${label} ${SUFFIX}`;

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

function assertBaseline(reply, label) {
  assert.equal(reply.headers['strict-transport-security'], HSTS_HEADER.value, `${label}: HSTS`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(reply.headers[name.toLowerCase()], value, `${label}: ${name}`);
}

/** A refusal is the fixed `{ error, requestId }`, no Set-Cookie, the baseline headers. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
}

/** An applied edit: 200, exactly { roleLevel: { roleId, domain, level, version } }, no Set-Cookie. */
function editedOf(reply, roleId, domain, level, label, { replayed = false, version } = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.status} ${reply.body}`);
  assert.ok(Number.isSafeInteger(version) && version > 0, `${label}: the case names the committed version`);
  assert.deepEqual(JSON.parse(reply.body), { roleLevel: { roleId, domain, level, version } }, label);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
}

/** The catalog's defaults (permissionCatalog.ts), the same three words in both domains. */
const DEFAULTS = Object.freeze({ manager: 'full', technician: 'view', sales_staff: 'create' });

/** A read-back of `domain`: exactly { tenant, domain, roles }, owner first fixed; each role stored or default at its version. */
function readBackOf(reply, tenant, domain, stored, label, versions = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.status} ${reply.body}`);
  const roles = [{ roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null },
    ...Object.entries(DEFAULTS).map(([roleId, defaultLevel]) => {
      const level = stored[roleId] ?? null;
      return { roleId, level: level ?? defaultLevel, defaultLevel, source: level === null ? 'default' : 'stored', editable: true, version: versions[roleId] ?? 0 };
    })];
  assert.deepEqual(JSON.parse(reply.body), { tenant, domain, roles }, label);
  assert.equal(reply.headers['cache-control'], 'no-store', `${label}: never cached`);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
}

/** The edit body: its six fields, `pre` = { tenant, version } the precondition. */
const levelBody = (roleId, domain, level, pre, reason = REASON) => ({
  roleId, domain, level, reason, expectedTenant: pre.tenant, expectedVersion: pre.version,
});

// ---------------------------------------------------------------------------
// fixtures and owner reads
// ---------------------------------------------------------------------------

async function actor(label, memberships) {
  const uid = `m5irlh-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid, authAgeMs: 0 });
  TOKENS.set(`${token}-stale`, { uid, authAgeMs: RECENT_AUTH_MAX_AGE_MS + 60_000 });
  UIDS.push(uid);
  return { id, uid, token, staleToken: `${token}-stale`, label, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });

async function shop(label) {
  const [{ tenant_id: tenant }] = await owner`insert into tenant (display_name, status) values (${`m5irlh-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(tenant);
  const boss = await actor(`${label}-owner`, [tenantGrant(tenant, 'store_owner')]);
  return { tenant, boss };
}
async function storeOf(tenant, label) {
  const [{ store_id: store }] = await owner`insert into store (tenant_id, store_name, status)
    values (${tenant}, ${`${label}-store-${SUFFIX}`}, 'active') returning store_id`;
  return store;
}

const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
const runtimeClient = () => testClient(TARGET, { user: RUNTIME_LOGIN, max: 1, onnotice: () => {} });

/** A live administrative session row minted as the runtime login (018's admin branch): its identifier. */
async function adminSessionId(who) {
  const id = randomBytes(32).toString('base64url');
  const key = createHash('sha256').update(id).digest('base64url');
  KEYS.add(key);
  const runtime = runtimeClient();
  try {
    const at = Date.now();
    const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, 'admin'::text, 'firebase'::text,
      ${who.uid}::text, ${principalKeyOf(who.principal)}::text, 'm5irlh-admin'::text, ${at}::bigint, ${at}::bigint, ${at}::bigint,
      ${at}::bigint, ${at + SESSION_TTL.admin.absoluteMs}::bigint, null::bytea) as outcome`;
    assert.equal(outcome, 'created', 'an administrative row exists to be presented');
  } finally {
    await runtime.end({ timeout: 5 });
  }
  return id;
}

/** A role's stored level in `domain`: a level, null (a lock row) or undefined (no row). */
async function levelOf(tenant, roleId, domain = 'invoices') {
  const rows = await owner`select level from tmpos_role.tenant_role_level where tenant_id = ${tenant} and role_id = ${roleId} and domain = ${domain}`;
  return rows.length === 0 ? undefined : rows[0].level;
}
/** A role's version in `domain`: 0 until its first edit. */
async function versionOf(tenant, roleId, domain = 'invoices') {
  const rows = await owner`select version from tmpos_role_edit.role_level_version where tenant_id = ${tenant} and role_id = ${roleId} and domain = ${domain}`;
  return rows.length === 0 ? 0 : Number(rows[0].version);
}
const preOf = async (tenant, roleId, domain = 'invoices') => ({ tenant, version: await versionOf(tenant, roleId, domain) });

/** Every stored level and version of `tenant`, by domain then role: what "no row change, no version change" compares. */
async function stateOf(tenant) {
  const levels = await owner`select domain, role_id, level from tmpos_role.tenant_role_level where tenant_id = ${tenant}`;
  const versions = await owner`select domain, role_id, version::int as version from tmpos_role_edit.role_level_version where tenant_id = ${tenant}`;
  const of = (domain) => ({
    levels: Object.fromEntries(levels.filter((r) => r.domain === domain).map((r) => [r.role_id, r.level]).sort()),
    versions: Object.fromEntries(versions.filter((r) => r.domain === domain).map((r) => [r.role_id, r.version]).sort()),
  });
  return { customers: of('customers'), invoices: of('invoices') };
}

/** The edit audit records of `tenant`, oldest first: reason code and the owner's words. */
const editAuditsOf = async (tenant) => (await owner`select reason_code, human_readable_reason from public.audit_event
  where action_id = ${EDIT_ACTION} and tenant_id = ${tenant} order by occurred_at, event_id`).map((r) => ({ ...r }));

const openLeases = async () => new Set((await owner`select scope from tmpos_internal.idempotency_record where response is null`).map((r) => r.scope));

async function counts() {
  const [r] = await owner`select
    (select count(*) from tmpos_customer.customer)::int as c,
    (select count(*) from public.audit_event where action_id = ${EDIT_ACTION})::int as e,
    (select count(*) from public.audit_event)::int as a,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as k,
    (select count(*) from tmpos_internal.outbox_event)::int as o,
    (select count(*) from tmpos_internal.idempotency_record)::int as l`;
  return { ...r };
}
async function deltaSince(before) {
  const now = await counts();
  return { C: now.c - before.c, E: now.e - before.e, A: now.a - before.a, K: now.k - before.k, O: now.o - before.o, L: now.l - before.l };
}
async function assertDelta(before, expected, label) {
  const got = await deltaSince(before);
  assert.deepEqual(got, { ...got, ...expected }, `${label}: C/E/A/K/O/L ${JSON.stringify(got)}`);
}
/** A refusal or a read: no customer, no audit record of ANY action (A — so a refusal audited under another action id, or
 *  in another tenant, still fails), no completion, no outbox row. Sign-ins are audited, so they happen before `before`. */
const NOTHING = Object.freeze({ C: 0, E: 0, A: 0, K: 0, O: 0 });
const EDIT = Object.freeze({ C: 0, E: 1, K: 1, O: 0 });

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

function makeCapture() {
  const lines = [];
  const codes = [];
  return { lines, codes, proc: new EventEmitter(), log: { log: (line) => { lines.push(line); } }, exit: (code) => { codes.push(code); } };
}

function unsafeHeaders(s, key) {
  return {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }),
    'content-type': 'application/json',
    ...(key === null ? {} : { 'idempotency-key': key }),
  };
}

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
  const unsafe = (method, path) => (s, body, { key = randomUUID(), headers = {}, drop = [] } = {}) => {
    const all = { ...unsafeHeaders(s, key), ...headers };
    for (const name of drop) delete all[name];
    return send(port, method, path, all, typeof body === 'string' ? body : JSON.stringify(body), { localAddress: clientAddress });
  };
  const read = (path) => (s, { query = '', headers = {} } = {}) => send(port, 'GET', `${path}${query}`,
    { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie }), ...headers }, undefined, { localAddress: clientAddress });
  const ctx = {
    cap, relay, port,
    put: unsafe('PUT', ROLE_LEVELS_PATH),
    post: unsafe('POST', CUSTOMERS_PATH),
    /** The Invoices read-back (M5-INVOICES-AUTH-P1) and the Customers one (M7A-CUSTOMERS-P3-R2). */
    invoices: read(INVOICES_PATH),
    customers: read(ROLE_LEVELS_PATH),
    list: (s) => send(port, 'GET', `${CUSTOMERS_PATH}?limit=10`, { host: TENANT_HOST, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }, undefined, { localAddress: clientAddress }),
    records: (reply) => cap.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
      .filter((r) => r.requestId === reply.headers['x-request-id']),
    reason: (reply) => {
      const lines = ctx.records(reply).filter((r) => r.event === 'request');
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

async function signIn(ctx, who, { token = who.token } = {}) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const key = keyOf(cookie);
  KEYS.add(key);
  return { cookie, csrf: JSON.parse(reply.body).csrfToken, key };
}

/** The owner's edit as the shop builds it: the domain's read-back first, then the edit asserting that read's tenant and version. */
async function edit(ctx, s, domain, roleId, level, label = `the owner sets ${domain} ${roleId} to ${level}`, { key } = {}) {
  const read = await (domain === 'invoices' ? ctx.invoices : ctx.customers)(s);
  assert.equal(read.status, 200, `${label}: the read the draft is made from: ${read.body}`);
  const { tenant, roles } = JSON.parse(read.body);
  const { version } = roles.find((r) => r.roleId === roleId);
  const reply = await ctx.put(s, levelBody(roleId, domain, level, { tenant, version }), key === undefined ? {} : { key });
  editedOf(reply, roleId, domain, level, label, { version: version + 1 });
  return reply;
}

// ---------------------------------------------------------------------------
// levers (roleLevels.integration's): owner-held locks and owner triggers
// ---------------------------------------------------------------------------

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
const holdPark = () => hold('the parking key', (sql) => sql`select pg_catalog.pg_advisory_xact_lock(${PARK[0]}::int, ${PARK[1]}::int)`);

async function blockedNow({ by = null, query = null } = {}) {
  const rows = await probe`select pid, query, pg_blocking_pids(pid) as blockers from pg_stat_activity
    where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
  return rows.filter((r) => (query === null || query.test(r.query)) && (by === null || r.blockers.includes(by)))
    .map((r) => ({ pid: r.pid, blockers: r.blockers }));
}
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
function waitingPid(outcome, what) {
  assert.ok(outcome !== null, `lever did not engage: ${what} not observed within ${WAIT_MS} ms`);
  assert.ok(outcome.blocked, `${what}: the request completed instead of waiting (${JSON.stringify(outcome.settled?.value?.status ?? outcome.settled)} ${outcome.settled?.value?.body ?? ''})`);
  return outcome.blocked[0].pid;
}
async function replyTo(request, label) {
  const reply = await within(request, label);
  assert.ok(typeof reply?.status === 'number', `no reply to ${label} within ${WAIT_MS} ms: ${JSON.stringify(reply)}`);
  return reply;
}
const waitingLocks = (pid) => probe`select locktype, mode from pg_catalog.pg_locks where pid = ${pid} and not granted`;

const TRIGGER_ACTIONS = Object.freeze({
  park: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); return new;`,
  raise: `raise exception 'M5IRLH injected fault' using errcode = 'P0001';`,
});
async function withTrigger(table, when, action, work) {
  await owner.unsafe(`create function m5irlh_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('m5irlh_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function m5irlh_proof.fire() from public');
  await owner.unsafe(`create trigger m5irlh_fire before insert on ${table} for each row when (${when}) execute function m5irlh_proof.fire()`);
  try {
    return await work();
  } finally {
    await owner.unsafe(`drop trigger if exists m5irlh_fire on ${table}`);
    await owner.unsafe('drop function if exists m5irlh_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('m5irlh_proof.fired'::regclass), 0)::int as n`)[0].n;
/** An INVOICES edit's audit INSERT only: a Customers edit's record never matches. */
const INVOICE_EDIT_AUDIT = `new.action_id = '${EDIT_ACTION}' and pg_catalog.strpos(new.reason_code, '_invoices_to_') > 0`;

// ===========================================================================
// M5IRLH-01 (AC-02): the defaults
// ===========================================================================

test('M5IRLH-01 (AC-02): a fresh tenant reads every catalog Invoices default — manager full, technician view, sales_staff create, source default, version 0 — no-store and no session material, under a stale sign-in too; any query is 400; a read writes nothing', async () => {
  const { tenant, boss } = await shop('m5irlh01');
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    const stale = await signIn(ctx, boss, { token: boss.staleToken }); // signed in before the window: a login is audited
    const before = await counts();
    const fresh = await ctx.invoices(o);
    readBackOf(fresh, tenant, 'invoices', {}, 'a fresh tenant: every Invoices default');
    for (const [label, secret] of [['the cookie identifier', o.cookie.slice(o.cookie.indexOf('=') + 1)], ['the session CSRF token', o.csrf], ['the store key', o.key]]) {
      assert.ok(!fresh.body.includes(secret), `the answer carries no ${label}`);
    }
    readBackOf(await ctx.invoices(stale), tenant, 'invoices', {}, 'a stale sign-in reads (a read is not the sensitive change)');
    readBackOf(await ctx.customers(o), tenant, 'customers', {}, 'the Customers read-back beside it (control)');
    for (const [label, query] of [['a tenant in the query', `?tenantId=${tenant}`], ['an empty query', '?'], ['a domain in the query', '?domain=customers'],
      ['an unknown query key', '?foo=1']]) {
      const reply = await ctx.invoices(o, { query });
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'role_level_directory_query_invalid', label);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'reads write nothing');
    assert.deepEqual(await stateOf(tenant), { customers: { levels: {}, versions: {} }, invoices: { levels: {}, versions: {} } }, 'no row, in either domain');
  });
});

// ===========================================================================
// M5IRLH-02 (AC-03): the durable edit, read back through another instance
// ===========================================================================

test('M5IRLH-02 (AC-03): the owner\'s Invoices PUT answers 200 {roleLevel} at version 1 with one audit record and one completion; a SEPARATE entry instance on a new session reads it back as stored; 020\'s levels read — the authorizer\'s input — carries it, and the Customers decisions made on that read still pass', async () => {
  const { tenant, boss } = await shop('m5irlh02');
  const sales = await actor('m5irlh02-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const o = await signIn(a, boss);
    const before = await counts();
    const body = levelBody('sales_staff', 'invoices', 'view', await preOf(tenant, 'sales_staff'), `  ${REASON} for the back office  `);
    editedOf(await a.put(o, body), 'sales_staff', 'invoices', 'view', 'instance A: the owner\'s Invoices edit', { version: 1 });
    await assertDelta(before, { ...EDIT, L: 1 }, 'one audit record, one completion, no outbox event');
    const audits = await owner`select scope_type, tenant_id, store_id, required_permission, decision, reason_code, human_readable_reason,
        subject_tenant_id, metadata from public.audit_event where action_id = ${EDIT_ACTION} and actor_internal_user_id = ${boss.id}`;
    assert.deepEqual(audits.map((r) => ({ ...r })), [{
      scope_type: 'tenant', tenant_id: tenant, store_id: null, required_permission: 'edit_role_levels', decision: 'allow',
      reason_code: 'role_sales_staff_invoices_to_view', human_readable_reason: `${REASON} for the back office`,
      subject_tenant_id: null, metadata: {},
    }], 'the audit record names the Invoices edit and the owner\'s words');
    assert.deepEqual(await stateOf(tenant), {
      customers: { levels: {}, versions: {} }, invoices: { levels: { sales_staff: 'view' }, versions: { sales_staff: 1 } },
    }, 'stored: the Invoices row and its version, nothing in Customers');

    // Instance B, a new session: the committed value, from the database, never from A's memory.
    const ob = await signIn(b, boss);
    readBackOf(await b.invoices(ob), tenant, 'invoices', { sales_staff: 'view' }, 'instance B reads the edit back', { sales_staff: 1 });
    readBackOf(await b.customers(ob), tenant, 'customers', {}, 'instance B: Customers still every default');

    // The resolver's input: 020's levels read, as the runtime login, answers the Invoices level beside the (absent) Customers
    // one. The tenant authorizer and the command revalidator read exactly this; their materialization of the Invoices level is
    // the resolver unit's (m5CanonicalPermissions.test.ts) — no served route decides on it.
    const runtime = runtimeClient();
    try {
      const [{ levels }] = await runtime`select tmpos_role.m7a_role_levels(${tenant}::uuid, 'sales_staff'::text) as levels`;
      assert.deepEqual(levels, { invoices: 'view' }, 'the authorizer\'s read carries the Invoices level');
    } finally {
      await runtime.end({ timeout: 5 });
    }
    // Both read paths admit the Invoices row: the sales_staff's Customers decisions (authorizer, then revalidator) still pass.
    const s = await signIn(b, sales);
    assert.equal((await b.list(s)).status, 200, 'the sales_staff still lists customers (the authorizer read did not fault)');
    const created = await b.post(s, { name: nameOf('m5irlh02 after the invoices edit') });
    assert.equal(created.status, 201, `the sales_staff still creates (the revalidator read did not fault): ${created.body}`);
  }));
});

// ===========================================================================
// M5IRLH-03 (AC-04): isolation between domains and tenants
// ===========================================================================

test('M5IRLH-03 (AC-04): an Invoices edit leaves the Customers read, rows, versions and decisions as they were and the reverse; tenant A\'s edit never reaches tenant B; the same edit in both domains is two requests — one key for both is 422 — with two reason codes', async () => {
  const a = await shop('m5irlh03-a');
  const b = await shop('m5irlh03-b');
  const sales = await actor('m5irlh03-sales', [tenantGrant(a.tenant, 'sales_staff')]);
  const tech = await actor('m5irlh03-tech', [tenantGrant(a.tenant, 'technician')]);
  await withEntry({}, async (ctx) => {
    const oa = await signIn(ctx, a.boss);
    const ob = await signIn(ctx, b.boss);
    const s = await signIn(ctx, sales);
    const t = await signIn(ctx, tech);

    // (a) Invoices: sales_staff to None, technician to Full. Customers is untouched, and decides as before: the sales_staff
    //     still creates (Customers default Create), the technician still cannot (Customers default View).
    let customersBefore = (await stateOf(a.tenant)).customers;
    await edit(ctx, oa, 'invoices', 'sales_staff', 'none');
    await edit(ctx, oa, 'invoices', 'technician', 'full');
    assert.deepEqual((await stateOf(a.tenant)).customers, customersBefore, 'the Customers rows and versions as they were');
    readBackOf(await ctx.customers(oa), a.tenant, 'customers', {}, 'the Customers read-back: every default, version 0');
    const name = nameOf('m5irlh03 sales');
    assert.equal((await ctx.post(s, { name })).status, 201, 'Invoices None does not narrow the sales_staff\'s Customers create');
    assertRefusal(await ctx.post(t, { name: nameOf('m5irlh03 tech') }), 403, 'forbidden', 'Invoices Full does not widen the technician\'s Customers create');

    // (b) Customers: technician to Create. Invoices is untouched.
    const invoicesBefore = (await stateOf(a.tenant)).invoices;
    await edit(ctx, oa, 'customers', 'technician', 'create');
    assert.deepEqual((await stateOf(a.tenant)).invoices, invoicesBefore, 'the Invoices rows and versions as they were');
    readBackOf(await ctx.invoices(oa), a.tenant, 'invoices', { sales_staff: 'none', technician: 'full' }, 'the Invoices read-back after a Customers edit',
      { sales_staff: 1, technician: 1 });
    readBackOf(await ctx.customers(oa), a.tenant, 'customers', { technician: 'create' }, 'the Customers edit, its own version', { technician: 1 });

    // (c) Tenant B sees none of A's edits; neither answer names the other tenant.
    const rb = await ctx.invoices(ob);
    readBackOf(rb, b.tenant, 'invoices', {}, 'tenant B: every Invoices default');
    assert.ok(!rb.body.includes(a.tenant), 'tenant B\'s answer never names tenant A');
    assert.deepEqual(await stateOf(b.tenant), { customers: { levels: {}, versions: {} }, invoices: { levels: {}, versions: {} } }, 'tenant B: no row');
    readBackOf(await ctx.invoices(ob, { headers: { 'x-tenant-id': a.tenant } }), b.tenant, 'invoices', {}, 'a header naming tenant A is no authority');

    // (d) The same role, level, tenant and version in both domains: manager to Edit at version 0. One key carries the
    //     Customers edit; the Invoices edit under that key is another request (the domain is in the fingerprinted body): 422,
    //     nothing written. Under its own key it applies, with its own reason code.
    const key = randomUUID();
    const pre = { tenant: a.tenant, version: 0 };
    editedOf(await ctx.put(oa, levelBody('manager', 'customers', 'edit', pre), { key }), 'manager', 'customers', 'edit', 'Customers manager Edit', { version: 1 });
    const before = await counts();
    customersBefore = await stateOf(a.tenant);
    assertRefusal(await ctx.put(oa, levelBody('manager', 'invoices', 'edit', pre), { key }), 422, 'idempotency_key_reused', 'the same key, the Invoices domain');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'the reused key wrote nothing');
    assert.deepEqual(await stateOf(a.tenant), customersBefore, 'neither domain changed');
    editedOf(await ctx.put(oa, levelBody('manager', 'invoices', 'edit', pre)), 'manager', 'invoices', 'edit', 'Invoices manager Edit, its own key', { version: 1 });
    const codes = (await editAuditsOf(a.tenant)).map((r) => r.reason_code);
    assert.deepEqual(codes, [
      'role_sales_staff_invoices_to_none', 'role_technician_invoices_to_full', 'role_technician_customers_to_create',
      'role_manager_customers_to_edit', 'role_manager_invoices_to_edit',
    ], 'each edit audited once, its domain in its reason code');
    // sales_staff's Customers NULL is the lock row its create took in (a) — 020's create, not an edit: no version, the default.
    assert.deepEqual((await stateOf(a.tenant)), {
      customers: { levels: { manager: 'edit', sales_staff: null, technician: 'create' }, versions: { manager: 1, technician: 1 } },
      invoices: { levels: { manager: 'edit', sales_staff: 'none', technician: 'full' }, versions: { manager: 1, sales_staff: 1, technician: 1 } },
    }, 'each domain holds its own rows and versions');
  });
});

// ===========================================================================
// M5IRLH-04 (AC-05): who may edit
// ===========================================================================

test('M5IRLH-04 (AC-05): manager, technician, sales_staff, a store-scope owner, another tenant\'s owner, owners demoted or suspended after login, administrative sessions, no session, the wrong Host, a stale sign-in and a missing or wrong Origin/CSRF/Idempotency-Key cannot change an Invoices level — no row, version, audit record or completion; malformed Invoices bodies are 400', async () => {
  const { tenant, boss } = await shop('m5irlh04');
  const store = await storeOf(tenant, 'm5irlh04');
  const refusedEditors = [
    ['a manager', await actor('m5irlh04-manager', [tenantGrant(tenant, 'manager')])],
    ['a technician', await actor('m5irlh04-tech', [tenantGrant(tenant, 'technician')])],
    ['a sales_staff', await actor('m5irlh04-sales', [tenantGrant(tenant, 'sales_staff')])],
    ['a store-scope store_owner', await actor('m5irlh04-store-owner', [{ scope: 'store', tenant, store, role: 'store_owner' }])],
  ];
  const demoted = await actor('m5irlh04-demoted', [tenantGrant(tenant, 'store_owner')]);
  const suspended = await actor('m5irlh04-suspended', [tenantGrant(tenant, 'store_owner')]);
  const elsewhere = await shop('m5irlh04-elsewhere');
  const admin = await actor('m5irlh04-admin', [{ scope: 'platform', role: 'system_owner' }]);
  const adminId = await adminSessionId(admin);
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    const pre = await preOf(tenant, 'sales_staff');
    const body = levelBody('sales_staff', 'invoices', 'none', pre);
    const nothingChanged = async (before, stateBefore, label, L = 0) => {
      await assertDelta(before, { ...NOTHING, L }, label);
      assert.deepEqual(await stateOf(tenant), stateBefore, `${label}: no level or version changed`);
    };

    // Non-owner editors: the authorizer's generic 403, before any key.
    const editors = [];
    for (const [label, who] of refusedEditors) editors.push([label, await signIn(ctx, who)]);
    let before = await counts();
    let state = await stateOf(tenant);
    for (const [label, s] of editors) assertRefusal(await ctx.put(s, body), 403, 'forbidden', label);
    await nothingChanged(before, state, 'non-owner editors');

    // Another tenant's owner asserting THIS tenant: the precondition refuses (its session's tenant is its own); neither
    // tenant changes, and no edit is audited in either.
    const eo = await signIn(ctx, elsewhere.boss);
    before = await counts();
    const foreign = await ctx.put(eo, body);
    assertRefusal(foreign, 409, 'write_conflict', 'another tenant\'s owner asserting this tenant');
    await nothingChanged(before, state, 'another tenant\'s owner', 1);
    assert.deepEqual(await stateOf(elsewhere.tenant), { customers: { levels: {}, versions: {} }, invoices: { levels: {}, versions: {} } }, 'the other tenant: no row');
    assert.deepEqual(await editAuditsOf(elsewhere.tenant), [], 'no edit audited in the other tenant');

    // Owners whose standing changed after login: the chain ends the session (401), never the old authority.
    for (const [label, who, change] of [
      ['an owner demoted to manager after login', demoted, () => owner`update user_membership set role_id = 'manager' where internal_user_id = ${demoted.id}`],
      ['an owner grant suspended after login', suspended, () => owner`update user_membership set status = 'suspended' where internal_user_id = ${suspended.id}`],
    ]) {
      const live = await signIn(ctx, who);
      await change();
      before = await counts();
      assertRefusal(await ctx.put(live, body), 401, 'unauthenticated', label);
      await nothingChanged(before, state, label);
    }

    // A stale sign-in: step-up, before the key.
    const stale = await signIn(ctx, boss, { token: boss.staleToken });
    before = await counts();
    const stepUp = await ctx.put(stale, body);
    assertRefusal(stepUp, 403, 'step_up_required', 'a stale sign-in');
    assert.equal(ctx.reason(stepUp), 'recent_auth_required', 'a stale sign-in');
    await nothingChanged(before, state, 'a stale sign-in');

    // Refused before any key: audience, Host, the key itself, Origin, CSRF.
    const edited = JSON.stringify(body);
    const csrf = randomBytes(32).toString('base64url');
    before = await counts();
    for (const [label, request, status, error, reason] of [
      ['an administrative session under its own cookie', () => ctx.put({ cookie: `${SESSION_COOKIES.admin}=${adminId}`, csrf }, edited), 401, 'unauthenticated', 'session_missing'],
      ['an administrative session under the tenant cookie', () => ctx.put({ cookie: `${SESSION_COOKIES.tenant}=${adminId}`, csrf }, edited), 401, 'unauthenticated', 'session_wrong_audience'],
      ['no session', () => ctx.put(null, edited), 401, 'unauthenticated', null],
      ['the admin host', () => ctx.put(o, edited, { headers: { host: ADMIN_HOST } }), 404, 'not_found', null],
      ['an unknown host', () => ctx.put(o, edited, { headers: { host: 'unknown.tmpos.test' } }), 404, 'not_found', null],
      ['no Idempotency-Key', () => ctx.put(o, edited, { key: null }), 400, 'invalid_request', 'idempotency_key_missing'],
      ['a malformed Idempotency-Key', () => ctx.put(o, edited, { key: 'abc' }), 400, 'invalid_request', 'idempotency_key_invalid'],
      ['a foreign Origin', () => ctx.put(o, edited, { headers: { origin: 'https://evil.test' } }), 403, 'forbidden', 'csrf_origin_mismatch'],
      ['the admin Origin', () => ctx.put(o, edited, { headers: { origin: ADMIN_ORIGIN } }), 403, 'forbidden', 'csrf_origin_mismatch'],
      ['no Origin', () => ctx.put(o, edited, { drop: ['origin'] }), 403, 'forbidden', 'csrf_origin_missing'],
      ['no pre-session CSRF header', () => ctx.put(o, edited, { drop: [CSRF_HEADER] }), 403, 'forbidden', 'csrf_token_missing'],
      ['no session CSRF', () => ctx.put(o, edited, { drop: [SESSION_CSRF_HEADER] }), 403, 'forbidden', null],
      ['a wrong session CSRF', () => ctx.put(o, edited, { headers: { [SESSION_CSRF_HEADER]: csrf } }), 403, 'forbidden', null],
    ]) {
      const reply = await request();
      assertRefusal(reply, status, error, label);
      if (reason !== null) assert.equal(ctx.reason(reply), reason, label);
    }
    await nothingChanged(before, state, 'refused before the key');

    // Bodies the contract refuses once the key is acquired: 400, the lease only.
    const bodies = [
      ['the domain in another letter case', { ...body, domain: 'Invoices' }],
      ['an unknown domain', { ...body, domain: 'invoice' }],
      ['the owner role', levelBody('store_owner', 'invoices', 'view', pre)],
      ['a level in another letter case', levelBody('sales_staff', 'invoices', 'View', pre)],
      ['an extra tenantId', { ...body, tenantId: elsewhere.tenant }],
    ];
    before = await counts();
    for (const [label, b] of bodies) {
      const reply = await ctx.put(o, b);
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'command_request_invalid', label);
    }
    await nothingChanged(before, state, 'refused by the contract', bodies.length);

    // Control: the tenant's own owner, recently signed in, edits.
    before = await counts();
    editedOf(await ctx.put(o, body), 'sales_staff', 'invoices', 'none', 'the owner (control)', { version: 1 });
    await assertDelta(before, { ...EDIT, L: 1 }, 'the owner (control)');
    state = await stateOf(tenant);
    assert.deepEqual(state.invoices, { levels: { sales_staff: 'none' }, versions: { sales_staff: 1 } }, 'the control applied');
  });
});

// ===========================================================================
// M5IRLH-05 (AC-05): who may read
// ===========================================================================

test('M5IRLH-05 (AC-05): only the tenant\'s store owner reads the Invoices levels back — manager, technician, sales_staff and a store-scope owner 403; no session and administrative sessions 401; the admin or an unknown Host 404; an owner demoted or suspended after login 401 (never the old answer), re-login as a manager 403; nothing is written', async () => {
  const { tenant, boss } = await shop('m5irlh05');
  const store = await storeOf(tenant, 'm5irlh05');
  const refusedReaders = [
    ['a manager', await actor('m5irlh05-manager', [tenantGrant(tenant, 'manager')])],
    ['a technician', await actor('m5irlh05-tech', [tenantGrant(tenant, 'technician')])],
    ['a sales_staff', await actor('m5irlh05-sales', [tenantGrant(tenant, 'sales_staff')])],
    ['a store-scope store_owner', await actor('m5irlh05-store-owner', [{ scope: 'store', tenant, store, role: 'store_owner' }])],
  ];
  const demoted = await actor('m5irlh05-demoted', [tenantGrant(tenant, 'store_owner')]);
  const suspended = await actor('m5irlh05-suspended', [tenantGrant(tenant, 'store_owner')]);
  const admin = await actor('m5irlh05-admin', [{ scope: 'platform', role: 'system_owner' }]);
  const adminId = await adminSessionId(admin);
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    await edit(ctx, o, 'invoices', 'manager', 'manage');
    readBackOf(await ctx.invoices(o), tenant, 'invoices', { manager: 'manage' }, 'the owner (control): a stored manage round-trips', { manager: 1 });
    // Every sign-in is audited, so each one this case needs happens before the window it measures.
    const readers = [];
    for (const [label, who] of refusedReaders) readers.push([label, await signIn(ctx, who)]);
    const live = new Map([[demoted, await signIn(ctx, demoted)], [suspended, await signIn(ctx, suspended)]]);
    let before = await counts();
    for (const [label, s] of readers) assertRefusal(await ctx.invoices(s), 403, 'forbidden', label);
    for (const [label, request, status, error, reason] of [
      ['no session', () => ctx.invoices(null), 401, 'unauthenticated', null],
      ['an administrative session under its own cookie', () => ctx.invoices({ cookie: `${SESSION_COOKIES.admin}=${adminId}` }), 401, 'unauthenticated', 'session_missing'],
      ['an administrative session under the tenant cookie', () => ctx.invoices({ cookie: `${SESSION_COOKIES.tenant}=${adminId}` }), 401, 'unauthenticated', 'session_wrong_audience'],
      ['the admin host', () => ctx.invoices(o, { headers: { host: ADMIN_HOST } }), 404, 'not_found', null],
      ['an unknown host', () => ctx.invoices(o, { headers: { host: 'unknown.tmpos.test' } }), 404, 'not_found', null],
    ]) {
      const reply = await request();
      assertRefusal(reply, status, error, label);
      if (reason !== null) assert.equal(ctx.reason(reply), reason, label);
    }
    for (const [label, who, change] of [
      ['an owner demoted to manager after login', demoted, () => owner`update user_membership set role_id = 'manager' where internal_user_id = ${demoted.id}`],
      ['an owner grant suspended after login', suspended, () => owner`update user_membership set status = 'suspended' where internal_user_id = ${suspended.id}`],
    ]) {
      readBackOf(await ctx.invoices(live.get(who)), tenant, 'invoices', { manager: 'manage' }, `${label}: reads while an owner (control)`, { manager: 1 });
      await change();
      const after = await ctx.invoices(live.get(who));
      assertRefusal(after, 401, 'unauthenticated', label);
      assert.ok(!after.body.includes('manage') && !after.body.includes(tenant), `${label}: nothing of the old answer`);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused reads write nothing');
    const relogin = await signIn(ctx, demoted);
    before = await counts();
    assertRefusal(await ctx.invoices(relogin), 403, 'forbidden', 're-login as a manager');
    await assertDelta(before, { ...NOTHING, L: 0 }, 're-login as a manager: the refused read writes nothing');
    assert.deepEqual((await stateOf(tenant)).invoices, { levels: { manager: 'manage' }, versions: { manager: 1 } }, 'untouched by the refusals');
  });
});

// ===========================================================================
// M5IRLH-06 (AC-06): the precondition through the route
// ===========================================================================

test('M5IRLH-06 (AC-06): a stale version or another tenant\'s id is an UNSEALED 409 write_conflict — nothing written, the lease kept (409 request_in_progress for the same key); default -> None -> Create moves the version twice, so the first read\'s draft stays refused and Create stands', async () => {
  const { tenant, boss } = await shop('m5irlh06');
  const elsewhere = await shop('m5irlh06-elsewhere');
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    const conflictOf = (reply, label) => {
      assertRefusal(reply, 409, 'write_conflict', label);
      assert.equal(ctx.reason(reply), 'transaction_precondition_failed', label);
      assert.equal(reply.headers['idempotent-replayed'], undefined, `${label}: a decision, not a replay`);
    };
    const firstRead = JSON.parse((await ctx.invoices(o)).body);
    const firstPre = { tenant: firstRead.tenant, version: firstRead.roles.find((r) => r.roleId === 'sales_staff').version };
    assert.deepEqual(firstPre, { tenant, version: 0 }, 'a never-edited role reads version 0');
    const versions = [0];

    // (a) default (Create) -> None at version 1, through the route.
    editedOf(await ctx.put(o, levelBody('sales_staff', 'invoices', 'none', firstPre)), 'sales_staff', 'invoices', 'none', 'None at version 1', { version: 1 });
    versions.push(await versionOf(tenant, 'sales_staff'));
    // A stale draft (version 0): refused, nothing written, its lease kept; the same key within the lease is in progress.
    const staleKey = randomUUID();
    const staleBody = levelBody('sales_staff', 'invoices', 'full', firstPre);
    const leasesBefore = await openLeases();
    let before = await counts();
    let state = await stateOf(tenant);
    conflictOf(await ctx.put(o, staleBody, { key: staleKey }), 'the stale draft');
    await assertDelta(before, { ...NOTHING, L: 1 }, 'the stale draft: its lease only');
    assert.deepEqual(await stateOf(tenant), state, 'the stale draft changed no level or version');
    const lease = [...(await openLeases())].filter((scope) => !leasesBefore.has(scope));
    assert.equal(lease.length, 1, 'unsealed: exactly its lease');
    before = await counts();
    assertRefusal(await ctx.put(o, staleBody, { key: staleKey }), 409, 'request_in_progress', 'the same key within its lease');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'the same key within its lease');

    // (b) Another tenant's id at the current version: refused; neither tenant changes.
    before = await counts();
    conflictOf(await ctx.put(o, levelBody('sales_staff', 'invoices', 'full', { tenant: elsewhere.tenant, version: 1 })), 'another tenant asserted');
    await assertDelta(before, { ...NOTHING, L: 1 }, 'another tenant asserted: its lease only');
    assert.deepEqual(await stateOf(tenant), state, 'this tenant unchanged');
    assert.deepEqual(await stateOf(elsewhere.tenant), { customers: { levels: {}, versions: {} }, invoices: { levels: {}, versions: {} } }, 'the other tenant unchanged');

    // (c) Reset ABA: None -> back to the default Create at version 2. The version-0 and version-1 drafts stay refused.
    const beforeRestore = await preOf(tenant, 'sales_staff');
    await edit(ctx, o, 'invoices', 'sales_staff', 'create', 'the owner restores the default');
    versions.push(await versionOf(tenant, 'sales_staff'));
    assert.deepEqual(versions, [0, 1, 2], 'the versions read 0, 1, 2: a restored default is an edit');
    assert.equal(await levelOf(tenant, 'sales_staff'), 'create', 'the default WORD is stored');
    before = await counts();
    state = await stateOf(tenant);
    conflictOf(await ctx.put(o, levelBody('sales_staff', 'invoices', 'view', firstPre)), 'the first read\'s draft (version 0)');
    conflictOf(await ctx.put(o, levelBody('sales_staff', 'invoices', 'view', beforeRestore)), 'the draft from before the restore (version 1)');
    await assertDelta(before, { ...NOTHING, L: 2 }, 'the old drafts: their leases only');
    assert.deepEqual(await stateOf(tenant), state, 'Create stands');
    readBackOf(await ctx.invoices(o), tenant, 'invoices', { sales_staff: 'create' }, 'Create, stored, at version 2', { sales_staff: 2 });
  });
});

// ===========================================================================
// M5IRLH-07 (AC-06): two entries race on one role row
// ===========================================================================

test('M5IRLH-07 (AC-06): two entries on one database — an Invoices edit parked holding the role row makes the other instance\'s Invoices edit of the same role (same precondition) wait INSIDE 026\'s set routine; the first commits (200), the second is 409 write_conflict; parked the same way, it never holds back a Customers edit of another role, while a Customers edit of the same role waits for it on the per-role advisory key and commits right after', async () => {
  const { tenant, boss } = await shop('m5irlh07');
  // A SECOND owner of the same tenant on instance B: 016's standing hold locks the actor's app_user row FOR UPDATE, so one
  // principal's two commands would serialize there, before either reached a role row.
  const coOwner = await actor('m5irlh07-co-owner', [tenantGrant(tenant, 'store_owner')]);
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const oa = await signIn(a, boss);
    const ob = await signIn(b, coOwner);

    // (1) Isolation under the lock: the Invoices edit parks at its audit INSERT holding the Invoices row FOR UPDATE and the
    //     per-(tenant, role) advisory key EXCLUSIVE (030's guard; migration 032 widened the same key to Customers writes). The
    //     other instance's Customers edit of ANOTHER role (another row, another key) commits meanwhile; its Customers edit of
    //     the SAME role (another row, the same key) waits on the parked edit's key — not on its row — and commits right after it.
    let invoiceReply;
    let customersReply;
    let sameRoleReply;
    let sameRoleLocks;
    let parkedMs;
    // The drafts are made before the lever: the parked edit's lock wait is bounded (COMMAND_LOCK_BOUND_MS), so the park
    // lasts only the two Customers requests themselves.
    const invoicePre = await preOf(tenant, 'sales_staff');
    const otherRolePre = await preOf(tenant, 'technician', 'customers');
    const customersPre = await preOf(tenant, 'sales_staff', 'customers');
    await withTrigger('public.audit_event', INVOICE_EDIT_AUDIT, 'park', async () => {
      const lever = await holdPark();
      let invoiceReq;
      let sameRoleReq;
      const parkedAt = Date.now();
      try {
        invoiceReq = quietly(a.put(oa, levelBody('sales_staff', 'invoices', 'view', invoicePre)));
        const invoicePid = waitingPid(await blockedOrSettled(invoiceReq, { by: lever.pid }), 'the Invoices edit parked at its audit INSERT');
        customersReply = await replyTo(quietly(b.put(ob, levelBody('technician', 'customers', 'none', otherRolePre))),
          'the Customers edit of another role beside the parked Invoices edit');
        sameRoleReq = quietly(b.put(ob, levelBody('sales_staff', 'customers', 'view', customersPre)));
        const sameRolePid = waitingPid(await blockedOrSettled(sameRoleReq, { by: invoicePid }),
          'the Customers edit of the same role waiting on the parked Invoices edit');
        sameRoleLocks = await waitingLocks(sameRolePid);
      } finally {
        parkedMs = Date.now() - parkedAt;
        await lever.commit();
      }
      invoiceReply = await replyTo(invoiceReq, 'the Invoices edit');
      sameRoleReply = await replyTo(sameRoleReq, 'the Customers edit of the same role');
    });
    assert.ok(sameRoleLocks.length > 0 && sameRoleLocks.every((l) => l.locktype === 'advisory'),
      `the same-role Customers edit waited on the per-role advisory key, not a row: ${JSON.stringify(sameRoleLocks)}`);
    editedOf(customersReply, 'technician', 'customers', 'none', 'the Customers edit of another role is not held by the Invoices edit', { version: 1 });
    // A park past the command's lock bound ends the edit in the 503 whatever the product does: inconclusive, never a pass.
    assert.ok(parkedMs < COMMAND_LOCK_BOUND_MS, `INCONCLUSIVE: the Invoices edit was parked ${parkedMs} ms, past the ${COMMAND_LOCK_BOUND_MS} ms lock bound`);
    editedOf(invoiceReply, 'sales_staff', 'invoices', 'view', `the parked Invoices edit then commits (logged ${JSON.stringify(a.records(invoiceReply).map((r) => r.reason ?? r.event))}, parked ${parkedMs} ms)`, { version: 1 });
    editedOf(sameRoleReply, 'sales_staff', 'customers', 'view', 'the same-role Customers edit commits once the Invoices edit has', { version: 1 });

    // (2) Serialization: both instances draft from version 1. A parks holding the row; B waits inside 026's routine; A commits
    //     None at version 2; B, asserting version 1, is refused with nothing written.
    const pre = await preOf(tenant, 'sales_staff');
    assert.deepEqual(pre, { tenant, version: 1 }, 'both drafts assert version 1');
    const before = await counts();
    let first;
    let second;
    let locks;
    let sentAt;
    let repliedAt;
    await withTrigger('public.audit_event', INVOICE_EDIT_AUDIT, 'park', async () => {
      const lever = await holdPark();
      let firstReq;
      let secondReq;
      try {
        firstReq = quietly(a.put(oa, levelBody('sales_staff', 'invoices', 'none', pre)));
        const firstPid = waitingPid(await blockedOrSettled(firstReq, { by: lever.pid }), 'the first Invoices edit parked at its audit INSERT, its row locked');
        sentAt = Date.now();
        secondReq = quietly(b.put(ob, levelBody('sales_staff', 'invoices', 'full', pre)));
        secondReq.then(() => { repliedAt = Date.now(); }, () => {});
        const secondPid = waitingPid(await blockedOrSettled(secondReq, { by: firstPid, query: /tmpos_role_invoice\.m7a_invoice_role_level_set/ }),
          'the second Invoices edit waiting on the first inside 026\'s set routine');
        locks = await waitingLocks(secondPid);
      } finally {
        await lever.commit();
      }
      first = await replyTo(firstReq, 'the first edit');
      second = await replyTo(secondReq, 'the second edit');
    });
    assert.ok(locks.length > 0 && locks.every((l) => l.locktype === 'transactionid' || l.locktype === 'tuple'),
      `the second edit waited on the first's row: ${JSON.stringify(locks)}`);
    editedOf(first, 'sales_staff', 'invoices', 'none', 'the first edit commits', { version: 2 });
    assertRefusal(second, 409, 'write_conflict', 'the second edit, its version superseded while it waited');
    assert.equal(b.reason(second), 'transaction_precondition_failed', 'the second edit: the precondition');
    assert.ok(repliedAt - sentAt < COMMAND_LOCK_BOUND_MS, `answered before any lock bound could expire (${repliedAt - sentAt} ms)`);
    await assertDelta(before, { ...EDIT, L: 2 }, 'one edit applied whole, the other its lease only');
    assert.deepEqual((await stateOf(tenant)).invoices, { levels: { sales_staff: 'none' }, versions: { sales_staff: 2 } }, 'the first edit stands');
    assert.deepEqual((await stateOf(tenant)).customers, { levels: { sales_staff: 'view', technician: 'none' }, versions: { sales_staff: 1, technician: 1 } }, 'Customers untouched by the race');
  }));
});

// ===========================================================================
// M5IRLH-08 (AC-07): failure atomicity
// ===========================================================================

test('M5IRLH-08 (AC-07): an audit INSERT that raises rolls the Invoices edit back whole — 503, no level, version, audit record or completion, the lease kept (409 for the same key within it)', async () => {
  const { tenant, boss } = await shop('m5irlh08');
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    // A row and version exist first, so the rollback has an UPDATE and a version move to undo, not only an INSERT.
    await edit(ctx, o, 'invoices', 'sales_staff', 'view');
    const key = randomUUID();
    const body = levelBody('sales_staff', 'invoices', 'none', await preOf(tenant, 'sales_staff'));
    const state = await stateOf(tenant);
    const before = await counts();
    const firedBefore = await fired();
    const reply = await withTrigger('public.audit_event', INVOICE_EDIT_AUDIT, 'raise', () => ctx.put(o, body, { key }));
    assertRefusal(reply, 503, 'service_unavailable', 'the audit INSERT raises');
    assert.equal(await fired(), firedBefore + 1, 'the fault ran, inside the command');
    await assertDelta(before, { ...NOTHING, L: 1 }, 'rolled back whole: the lease only');
    assert.deepEqual(await stateOf(tenant), state, 'the level and version as they were');
    assertRefusal(await ctx.put(o, body, { key }), 409, 'request_in_progress', 'the same key within its lease');
    await assertDelta(before, { ...NOTHING, L: 1 }, 'the retry wrote nothing');
    readBackOf(await ctx.invoices(o), tenant, 'invoices', { sales_staff: 'view' }, 'the read-back: View at version 1', { sales_staff: 1 });
  });
});

// ===========================================================================
// M5IRLH-09 (AC-08): idempotency and the lost COMMIT answer
// ===========================================================================

test('M5IRLH-09 (AC-08): the same key and body replay the recorded 200 byte for byte; another body under the key is 422; a COMMIT whose answer is lost is a 503 and the same-key retry replays what committed — unknown outcome is not a rollback', async () => {
  const { tenant, boss } = await shop('m5irlh09');
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    const key = randomUUID();
    const body = levelBody('sales_staff', 'invoices', 'view', await preOf(tenant, 'sales_staff'));
    const first = await ctx.put(o, body, { key });
    editedOf(first, 'sales_staff', 'invoices', 'view', 'the edit', { version: 1 });
    let before = await counts();
    const again = await ctx.put(o, body, { key });
    editedOf(again, 'sales_staff', 'invoices', 'view', 'the replay', { replayed: true, version: 1 });
    assert.equal(again.body, first.body, 'byte for byte');
    assertRefusal(await ctx.put(o, { ...body, level: 'none' }, { key }), 422, 'idempotency_key_reused', 'the same key, another level');
    assertRefusal(await ctx.put(o, { ...body, domain: 'customers' }, { key }), 422, 'idempotency_key_reused', 'the same key, the Customers domain');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'replay and conflicts write nothing');
    assert.deepEqual((await stateOf(tenant)).invoices, { levels: { sales_staff: 'view' }, versions: { sales_staff: 1 } }, 'one edit, once');

    // The COMMIT reaches the server and its answer is dropped: unknown, so 503 — and the edit DID commit; the retry with the
    // same key and body resolves through the retained completion and replays it.
    const lostKey = randomUUID();
    const lostBody = levelBody('sales_staff', 'invoices', 'edit', await preOf(tenant, 'sales_staff'));
    before = await counts();
    const trap = loseCommitAnswer(ctx.relay);
    let reply;
    try {
      reply = await ctx.put(o, lostBody, { key: lostKey });
    } finally {
      trap.release();
    }
    assert.equal(trap.silenced.length, 1, 'one COMMIT reached the server, and its answer was dropped');
    assertRefusal(reply, 503, 'service_unavailable', 'the lost answer');
    assert.equal(ctx.reason(reply), 'transaction_timeout', 'unknown at the port deadline');
    let level;
    for (const until = Date.now() + 5_000; level !== 'edit' && Date.now() < until; await delay(50)) level = await levelOf(tenant, 'sales_staff');
    assert.equal(level, 'edit', 'what committed becomes visible: not a rollback');
    editedOf(await ctx.put(o, lostBody, { key: lostKey }), 'sales_staff', 'invoices', 'edit', 'the retry replays what committed', { replayed: true, version: 2 });
    assert.equal(await versionOf(tenant, 'sales_staff'), 2, 'the version moved once');
    await assertDelta(before, { ...EDIT, L: 1 }, 'the edit landed whole, once');
  });
});
