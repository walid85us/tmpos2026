// Phase 4.0 M7A-CUSTOMERS-P1 — the tenant customer directory against REAL PostgreSQL: migration 017 (one table and one
// gated read routine in their own schema), the adapter over the runtime's own non-owner login, and GET /api/v1/customers
// served by the tenant session boundary over real loopback sockets — the production session store with the login's
// standing check, the PostgreSQL tenant admission at the boundary and in the authorizer, and the canonical view_customers
// decision — exactly the parts a tenant deployment composes. Also proven: a session past its idle window or its
// absolute lifetime is refused before the customer port is ever asked (M7C-15); concurrent inserts racing concurrent
// page walks never break one walk's order, uniqueness or completeness (M7C-16); and the 'trialing' account/tenant
// standing reads exactly as 'active' does (M7C-17).
//
// SINCE M7A-CUSTOMERS-P2 (migration 018) the route reads through 018's session-bound routine: the runtime login can no
// longer execute 017's page, the store mints every tenant session under a synthetic issuer key the owner installs here,
// and the read is bound to the presenting minted session. The assertions that encoded the old exposure — 017's page as
// the login's way in (M7C-02, M7C-09), the adapter judging a caller-built scope (M7C-10), and 017 rolled back alone
// (M7C-14) — are rewritten for it; the page, paging, isolation and refusal contract are unchanged.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY. The identity verifier (a bearer token maps to a synthetic provider reference,
// authenticated now with a TOTP factor) and the rate limiter (the testkit's in-memory one whose clock jumps one maximum
// window per consume, so no budget is ever spent: this suite is not about limits). Nothing else.
//
// DISPOSABLE ONLY. The target is whatever the harness resolves — a supplied disposable target or a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and randomly
// suffixed, so the suite re-runs on the shared CI service after the other suites. It leaves that service as it found it:
// 017 and 018 applied, no customer row, session or mint-ledger row of its own; privileges it widens are widened inside
// transactions that are rolled back. The issuer key it installs stays installed; the next suite that mints installs its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver, unreachableTestDriver } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresSessionStore, tenantMintProof } from '../../server/persistence/postgresSessionStore.ts';
import { createPostgresTenantAdmission, holdTenantStanding, readTenantAdmission } from '../../server/persistence/postgresTenantAdmission.ts';
import { createPostgresPlatformAdmission, readPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';
import { lockPlatformAuthority } from '../../server/persistence/postgresPrincipalResolver.ts';
import { createPostgresCustomerDirectory } from '../../server/persistence/postgresCustomerDirectory.ts';
import {
  createTenantEstablishCheck, createTenantRouteAuthorizer, createTenantSessionAdmission, readKey,
} from '../../server/composition/tenantAuthorization.ts';
import {
  createAdmittedPlatformAuthorizer, createPlatformEstablishCheck, createPlatformSessionAdmission,
} from '../../server/composition/platformAuthorization.ts';
import { uncataloguedRoutePermissions } from '../../server/composition/productionTransactions.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { selectScope } from '../../server/runtime/principals.ts';
import { createMemoryRateLimiter, testRequestLimits } from '../../server/runtime/rateLimiter.testkit.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SESSION_COOKIES, SESSION_TTL } from '../../server/runtime/sessions.ts';
import {
  CUSTOMER_DIRECTORY_PATH, createCustomerDirectoryRoute, decodeCustomerCursor, encodeCustomerCursor,
} from '../../server/runtime/customerDirectory.ts';
import { encodeTenantCursor } from '../../server/runtime/tenantDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_017 = readFileSync(`${MIG_DIR}/017_m7a_customer_directory.up.sql`, 'utf8');
const DOWN_017 = readFileSync(`${MIG_DIR}/017_m7a_customer_directory.down.sql`, 'utf8');
const UP_018 = readFileSync(`${MIG_DIR}/018_m7a_tenant_session_mint.up.sql`, 'utf8');
const DOWN_018 = readFileSync(`${MIG_DIR}/018_m7a_tenant_session_mint.down.sql`, 'utf8');
/** 017's section 5 postcondition, run again on its own after a deliberate widening, to prove it refuses. */
const POSTCONDITION_017 = UP_017.slice(UP_017.lastIndexOf('do $$'));
/** 018's section 8 postcondition, run again on its own. */
const POSTCONDITION_018 = UP_018.slice(UP_018.lastIndexOf('do $$'));
const ROUTINE = 'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)';
const ROUTINE_V2 = 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)';
const CREATE_011 = 'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7c-migrator', runtimeRef: 'm7c-runtime' };
const LOCK_KEY = 528_521;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7c_probe';
const TENANT_ORIGIN = 'http://pos.trusted.test';
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const signal = () => AbortSignal.timeout(10_000);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M7C');
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
const connect = (user, max) =>
  testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, writes the fixtures and observes. RLS does not restrict it. */
const owner = connect(undefined, 3);
let runtime = null;
let client = null;
/** Every provider reference and tenant this suite creates: what the final cleanup removes sessions and customers of. */
const UIDS = [];
const TENANTS = [];
/** Every session store key a sign-in here minted: what the final cleanup removes mint-ledger rows of. */
const KEYS = new Set();

test.after(async () => {
  // Leave the shared service usable: no customer row and no session of this suite's (016's up/down refuse while a
  // tenant session exists; 017's down while a customer row does).
  try {
    if (TENANTS.length > 0) await owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
  } catch { /* 017 rolled back by a failed M7C-14: nothing of ours remains in it */ }
  if (UIDS.length > 0) await owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`;
  try {
    if (KEYS.size > 0) await owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`;
  } catch { /* 018 rolled back by a failed M7C-14: nothing of ours remains in it */ }
  if (client) await client.end();
  if (runtime) await runtime.end({ timeout: 5 });
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: real migrations 001-018, a real non-owner runtime login, real adapters, the issuer key installed by the owner
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

await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
runtime = connect(RUNTIME_LOGIN, 2);

/** The transaction kernel over the runtime login — ONE client, as the composition root builds it. */
client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 6, idle_timeout: 0, user: RUNTIME_LOGIN,
});

// The owner installs a synthetic issuer key (018; design-B §3.12), and the store mints tenant sessions under it.
const ISSUER_KEY = await installTestIssuerKey(owner);

// The production session store with the production standing check: the ONE store serves both audiences, dispatching on
// the record's audience exactly as productionTransactions.ts does (M5-ADMIN-REVOKE-P1, M5-TENANT-SESSION-P1).
const adminStanding = createPlatformEstablishCheck({ read: readPlatformAdmission, authority: lockPlatformAuthority });
const tenantStanding = createTenantEstablishCheck({ hold: holdTenantStanding, read: readTenantAdmission });
const SESSIONS = createPostgresSessionStore({
  client,
  issuerKey: ISSUER_KEY,
  standing: async (sql, record) => {
    if (record.audience === 'admin') return adminStanding(sql, record);
    if (record.audience === 'tenant') return tenantStanding(sql, record);
    throw new Error('session standing unavailable');
  },
});
const tenantAdmission = createPostgresTenantAdmission({ client });
const platformAdmission = createPostgresPlatformAdmission({ client });
const DIRECTORY = createPostgresCustomerDirectory({ client });

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(view) {
    const uid = TOKENS.get(view.bearerToken);
    return uid === undefined ? null : { verified: true, authProvider: 'firebase', authProviderUid: uid, authenticatedAt: Date.now(), secondFactor: 'totp' };
  },
});

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7c-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, label) =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`m7c-${label}-${SUFFIX}`}, 'active') returning store_id`)[0].store_id;

/** A synthetic actor: an identity, an account in `status`, and the given memberships. */
async function actor(label, memberships, status = 'active') {
  const uid = `m7c-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  UIDS.push(uid);
  TOKENS.set(`tok-${uid}`, uid);
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
const membershipOf = async (who) =>
  (await owner`select membership_id from user_membership where internal_user_id = ${who.id} and scope_type = 'tenant' order by membership_id`)[0].membership_id;

/** Every customer id and name this suite writes, and every cursor it sees or sends: none may ever reach a log line. */
const SEEDED_IDS = new Set();
const SEEDED_NAMES = new Set();
const CURSORS = new Set();
/** Every session identifier, store key and mint proof the suite's sign-ins produced (design-B M7M-11): nor may any of these. */
const SESSION_SECRETS = new Set();
/** Insert customers for `tenant` as the owner; `ids` optionally fixes some ids. Answers [{ id, name }]. */
async function seed(tenant, names, ids = []) {
  const rows = names.map((name, i) => ({ customer_id: ids[i] ?? randomUUID(), tenant_id: tenant, name }));
  await owner`insert into tmpos_customer.customer ${owner(rows, 'customer_id', 'tenant_id', 'name')}`;
  for (const r of rows) { SEEDED_IDS.add(r.customer_id); SEEDED_NAMES.add(r.name); }
  return rows.map((r) => ({ id: r.customer_id, name: r.name }));
}

/** The page order the contract promises: UTF-8 byte order of the name, then the uuid — computed here, not by the database. */
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** A tenant's customers as the owner reads them, ordered in JS. */
const expectedOf = async (tenant) =>
  (await owner`select customer_id, name from tmpos_customer.customer where tenant_id = ${tenant}`)
    .map((r) => ({ id: r.customer_id, name: r.name })).sort(byteOrder);

const T_A = await newTenant('a');
const T_B = await newTenant('b');
const T_C = await newTenant('c');
const T_D = await newTenant('d-empty');
const T_RO = await newTenant('read-only', 'read_only');
const T_OVERDUE = await newTenant('overdue', 'overdue');
const T_PENDING = await newTenant('pending', 'pending_activation');
const T_SUSPEND = await newTenant('to-suspend');
const T_P10 = await newTenant('p10-suspend');
const T_DORMANT = await newTenant('dormant', 'suspended');
const T_NAMES = await newTenant('names');
const STORE_A = await newStore(T_A, 'store-a');
const STORE_C = await newStore(T_C, 'store-c');

// Tenant A: a group of three IDENTICAL names, four names differing only in case and accent, and two names whose UTF-8
// byte order is the reverse of their UTF-16 order (U+FF21 before U+1F600 in bytes, after it in JS's default compare).
const SEED_A = await seed(T_A, [
  `Same ${SUFFIX}`, `Same ${SUFFIX}`, `Same ${SUFFIX}`,
  `Élan ${SUFFIX}`, `elan ${SUFFIX}`, `Elan ${SUFFIX}`, `élan ${SUFFIX}`,
  `Ａcme ${SUFFIX}`, `\u{1F600} Smile ${SUFFIX}`,
]);
// Tenant B: 250 customers in pairs of identical names, offset by one so each page boundary at 100 splits a pair.
const SEED_B = await seed(T_B, Array.from({ length: 250 }, (_, i) => `B ${String(Math.floor((i + 1) / 2)).padStart(3, '0')} ${SUFFIX}`));
const SEED_C = await seed(T_C, [`Cobalt ${SUFFIX}`, `cobalt ${SUFFIX}`, `Cyan ${SUFFIX}`]);
const SEED_RO = await seed(T_RO, [`Ro one ${SUFFIX}`, `Ro two ${SUFFIX}`]);
const SEED_OVERDUE = await seed(T_OVERDUE, [`Late one ${SUFFIX}`, `Late two ${SUFFIX}`]);
await seed(T_PENDING, [`Pending ${SUFFIX}`]);
await seed(T_SUSPEND, [`Suspended ${SUFFIX}`]);
const SEED_P10 = await seed(T_P10, [`P10 ${SUFFIX}`]);
await seed(T_DORMANT, [`Dormant ${SUFFIX}`]);

const A_OWNER = await actor('a-owner', [tenantGrant(T_A, 'store_owner')]);
const A_MANAGER = await actor('a-manager', [tenantGrant(T_A, 'manager')]);
const A_TECH = await actor('a-tech', [tenantGrant(T_A, 'technician')]);
const A_SALES = await actor('a-sales', [tenantGrant(T_A, 'sales_staff')]);
const B_USER = await actor('b-user', [tenantGrant(T_B, 'manager')]);
const C_USER = await actor('c-user', [tenantGrant(T_C, 'sales_staff')]);
const D_USER = await actor('d-user', [tenantGrant(T_D, 'store_owner')]);
const STORE_ONLY = await actor('store-only', [{ scope: 'store', tenant: T_A, store: STORE_A, role: 'manager' }]);
const TWO_TENANTS = await actor('two-tenants', [tenantGrant(T_A, 'manager'), tenantGrant(T_C, 'manager')]);
const PLATFORM_ONLY = await actor('platform-only', [{ scope: 'platform', role: 'system_owner' }]);
const NO_GRANT = await actor('no-grant', []);
const RO_USER = await actor('ro-user', [tenantGrant(T_RO, 'technician')]);
const OVERDUE_USER = await actor('overdue-user', [tenantGrant(T_OVERDUE, 'sales_staff')]);
const PENDING_USER = await actor('pending-user', [tenantGrant(T_PENDING, 'store_owner')]);
const SUSPEND_USER = await actor('suspend-user', [tenantGrant(T_SUSPEND, 'store_owner')]);
const ACCOUNT_SUSPENDED = await actor('account-suspended', [tenantGrant(T_A, 'manager')]);
const ROLE_MOVED = await actor('role-moved', [tenantGrant(T_A, 'manager')]);
const GRANT_OFF = await actor('grant-off', [tenantGrant(T_A, 'manager')]);
const RO_ACCOUNT = await actor('ro-account', [tenantGrant(T_A, 'manager')], 'read_only');
const MIXED = await actor('mixed', [tenantGrant(T_A, 'store_owner'), { scope: 'store', tenant: T_C, store: STORE_C, role: 'technician' }]);
const MID_REQUEST = await actor('mid-request', [tenantGrant(T_A, 'manager')]);
const P10_STALE = await actor('p10-stale', [tenantGrant(T_A, 'manager')], 'read_only');
const P10_TSUSP = await actor('p10-tsusp', [tenantGrant(T_P10, 'manager')]);
const P10_SECOND = await actor('p10-second', [tenantGrant(T_A, 'manager')]);
const P10_ACCOUNT = await actor('p10-account', [tenantGrant(T_A, 'manager')]);
const P10_GRANT = await actor('p10-grant', [tenantGrant(T_A, 'manager')]);
// An active grant on A beside an active grant on a SUSPENDED (or pending) tenant: the second is not an eligible grant.
const A_PLUS_SUSPENDED = await actor('a-plus-suspended', [tenantGrant(T_A, 'store_owner'), tenantGrant(T_DORMANT, 'manager')]);
const A_PLUS_PENDING = await actor('a-plus-pending', [tenantGrant(T_A, 'technician'), tenantGrant(T_PENDING, 'manager')]);
const NAMES_USER = await actor('names-user', [tenantGrant(T_NAMES, 'sales_staff')]);
const IDLE_USER = await actor('idle-user', [tenantGrant(T_A, 'manager')]);
const EXPIRE_USER = await actor('expire-user', [tenantGrant(T_A, 'manager')]);
const T_TRIAL = await newTenant('trial', 'trialing');
const TRIAL_USER = await actor('trial-user', [tenantGrant(T_TRIAL, 'manager')], 'trialing');

// ---------------------------------------------------------------------------
// the real runtime, over a real local socket
// ---------------------------------------------------------------------------

/** Every log line every instance emitted, across the whole suite. */
const LOGS = [];

function send(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end();
  });
}
const bodyOf = (reply) => JSON.parse(reply.body);
const cookieOf = (reply) => (reply.headers['set-cookie'] ?? [''])[0].split('; ')[0];

/** A refusal is the fixed `{ error, requestId }` and nothing else — no customer, no scope, no reason. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = bodyOf(reply);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  assert.equal(body.requestId, reply.headers['x-request-id'], label);
  for (const id of SEEDED_IDS) assert.ok(!reply.body.includes(id), `${label}: no customer id in a refusal`);
}

/** A page body: exactly { customers: [{ id, name }], nextCursor }. Answers it. */
function pageOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  const body = bodyOf(reply);
  assert.deepEqual(Object.keys(body), ['customers', 'nextCursor'], label);
  assert.ok(Array.isArray(body.customers), label);
  for (const c of body.customers) assert.deepEqual(Object.keys(c), ['id', 'name'], label);
  assert.ok(body.nextCursor === null || typeof body.nextCursor === 'string', label);
  if (body.nextCursor !== null) {
    CURSORS.add(body.nextCursor);
    assert.equal(decodeCustomerCursor(body.nextCursor), body.customers.at(-1).id, `${label}: the cursor names the last customer`);
  }
  return body;
}

/**
 * One runtime instance: the customer route (over `customers`, default the PostgreSQL adapter) on the tenant boundary,
 * the platform boundary beside it (so an administrative session exists to be refused), both over the production store.
 */
async function withApp(fn, over = {}) {
  let clock = Date.now();
  const readiness = createReadinessState();
  readiness.setReady();
  const logs = [];
  const app = createApp({
    readiness,
    log: { log: (line) => { logs.push(line); LOGS.push(line); } },
    ...(over.now === undefined ? {} : { now: over.now }),
    routes: [createCustomerDirectoryRoute({ customers: over.customers ?? DIRECTORY }, over.deadlineMs === undefined ? {} : { deadlineMs: over.deadlineMs })],
    limits: testRequestLimits({ limiter: createMemoryRateLimiter({ now: () => (clock += 3_600_001) }) }),
    sessions: {
      tenant: {
        trustedOrigins: [TENANT_ORIGIN],
        verifier: VERIFIER,
        admission: createTenantSessionAdmission({ admission: tenantAdmission }),
        authorizer: createTenantRouteAuthorizer({ admission: tenantAdmission, reads: new Set([readKey('GET', CUSTOMER_DIRECTORY_PATH)]) }),
        store: SESSIONS,
      },
      admin: {
        trustedOrigins: [ADMIN_ORIGIN],
        verifier: VERIFIER,
        admission: createPlatformSessionAdmission({ admission: platformAdmission }),
        authorizer: createAdmittedPlatformAuthorizer(),
        store: SESSIONS,
      },
    },
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const login = (who, audience = 'tenant') => send(port, 'POST', sessionPaths(audience).login, {
    origin: audience === 'tenant' ? TENANT_ORIGIN : ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer tok-${who.uid}`, 'content-length': '0',
  });
  const signIn = async (who, audience = 'tenant') => {
    const reply = await login(who, audience);
    assert.equal(reply.status, 200, `${audience} login for ${who.uid}: ${reply.body}`);
    const cookie = cookieOf(reply);
    await noteSession(cookie);
    return cookie;
  };
  const list = (cookie, query = '') => {
    for (const m of query.matchAll(/cursor=([^&]*)/g)) CURSORS.add(m[1]);
    return send(port, 'GET', `${CUSTOMER_DIRECTORY_PATH}${query}`, cookie === null ? {} : { cookie });
  };
  /** The refusal reason the runtime logged for one reply ('-' when none). */
  const reason = (reply) => {
    const lines = logs.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
      .filter((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id']);
    assert.equal(lines.length, 1, 'exactly one log line for the request');
    return lines[0].reason ?? '-';
  };
  /** Every page from `query`'s start to the end, following nextCursor. */
  const walk = async (cookie, limit) => {
    const pages = [];
    let query = limit === undefined ? '' : `?limit=${limit}`;
    for (let guard = 0; guard < 400; guard++) {
      const body = pageOf(await list(cookie, query), `walk page ${pages.length + 1}`);
      pages.push(body.customers);
      if (body.nextCursor === null) return pages;
      query = `?${limit === undefined ? '' : `limit=${limit}&`}cursor=${body.nextCursor}`;
    }
    throw new Error('walk did not end');
  };
  try {
    await fn({ port, login, signIn, list, reason, walk, logs });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

/** The trusted scope the authorizer would select for `who` at tenant scope, from a live admission. */
async function scopeOf(who, tenant) {
  const answer = await tenantAdmission.admit(who.principal, signal());
  assert.equal(answer.outcome, 'admitted', `${who.uid} is admitted`);
  const selection = selectScope(answer.principal, 'tenant', { tenant, store: null });
  assert.equal(selection.outcome, 'selected', `${who.uid} selects tenant scope`);
  return selection.scope;
}
/** The store key of the session a cookie presents: the SHA-256 of its identifier, as the chain computes it (sessions.ts digestOf). */
const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
/**
 * Records a fresh sign-in's identifier, store key and — for a tenant session, read back before any request touches its
 * stamps — the mint proof the store sent (tenantMintProof over the same row), for the log scan and the final cleanup.
 */
async function noteSession(cookie) {
  const key = keyOf(cookie);
  KEYS.add(key);
  SESSION_SECRETS.add(cookie.slice(cookie.indexOf('=') + 1));
  SESSION_SECRETS.add(key);
  const [row] = await owner`select audience, auth_provider, auth_provider_uid, principal_key, security_version, authenticated_at,
      created_at, last_seen_at, validated_at, expires_at from tmpos_session.session where session_key = ${key}`;
  if (row?.audience !== 'tenant') return;
  const proof = tenantMintProof(ISSUER_KEY, key, {
    audience: row.audience, authProvider: row.auth_provider, authProviderUid: row.auth_provider_uid, principalKey: row.principal_key,
    securityVersion: row.security_version, authenticatedAt: row.authenticated_at === null ? null : Number(row.authenticated_at),
    createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at), validatedAt: Number(row.validated_at),
  }, Number(row.expires_at));
  for (const encoding of ['hex', 'base64', 'base64url']) SESSION_SECRETS.add(proof.toString(encoding));
}
/** A session the production chain mints for `who` (a real sign-in; a tenant one carries the store's proof): its store key. */
async function minted(who, audience = 'tenant') {
  let key;
  await withApp(async ({ signIn }) => { key = keyOf(await signIn(who, audience)); });
  return key;
}
/** 018's session-bound read called directly as the runtime login: the session key is its one authority argument. */
const v2 = (key, after = null, limit = 50) => runtime`select o_outcome, o_tenant_id, o_customer_id, o_name
  from tmpos_mint.m7a_customer_page_v2(${key}::text, ${after}::uuid, ${limit}::integer)`;
/** 017's routine run as `db`, every argument explicit: as the OWNER, the baseline v2 must equal; as the login, refused. */
const routineAs = (db) => (scope, after = null, limit = 50) => db`select o_outcome, o_tenant_id, o_customer_id, o_name
  from tmpos_customer.m7a_customer_page(${scope.actor}::uuid, ${scope.securityVersion}::text, ${scope.membershipId}::uuid,
    ${scope.roleId}::text, ${scope.tenant}::uuid, ${after}::uuid, ${limit}::integer)`;
const routineAsOwner = routineAs(owner);
const routineAsLogin = routineAs(runtime);

// ---------------------------------------------------------------------------
// M7C-01..02: the composition and migration 017 as applied
// ---------------------------------------------------------------------------

test('M7C-01: 001-018 applied clean; 005-017 byte-identical to their pins; the route is decidable and composed read-classified', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018']
      .map((v) => [v, false]));
  // 005-016 up checksums are postgresStartupPreflight.ts REQUIRED_MIGRATIONS; down checksums are the committed pins of
  // the earlier suites (tenantDirectory, migration-files-contract). 017's are M7A-CUSTOMERS-P1's; 018's are pinned by the
  // preflight and by tests/db/tenantSessionMint.integration.test.mjs.
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
    '014_m6_distributed_rate_limit.up.sql': '48ff3e4bc2b3d4c6ee3cc2c54e4111d8647669d349d1449b249303a9dcc4cf62',
    '014_m6_distributed_rate_limit.down.sql': '72aab6e28ff512e2c8061cfae510e073466f4f5d5bb9ca9d27e3a5e333a63846',
    '015_m5_admin_standing_serialization.up.sql': 'a3b1514ee65703d29b3becf78ef338e8966eb0ee12550ecd5e1f19d357154f4e',
    '015_m5_admin_standing_serialization.down.sql': 'c065b4129bf5499b762d76288b89bd9358845dd274f2eda6484d367b98822e3c',
    '016_m5_tenant_session_ordering.up.sql': 'e5633336da5376a747d05aabac21b73ca9ebcf4743a9436081c58322ac07e9be',
    '016_m5_tenant_session_ordering.down.sql': 'acf8a95610c97c8dca496da6fad4a3618a49a7268a9a82237ecb5849040728a6',
    '017_m7a_customer_directory.up.sql': '1fea57a1c4bdba7efdb5da0f34893879a6b8aa741c1f117b2dcf63259f85d66d',
    '017_m7a_customer_directory.down.sql': '8e6b095959670d2c53d139be3a3c00f4c06544b72c264d6febf4373ef67eb440',
  };
  for (const [name, digest] of Object.entries(PINNED)) {
    assert.equal(createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex'), digest, name);
  }
  // The route as a deployment would hold it: a tenant session read of view_customers, which the catalog DECIDES.
  const route = createCustomerDirectoryRoute({ customers: DIRECTORY });
  assert.deepEqual({ method: route.method, path: route.path, policy: route.policy, trustedContext: route.trustedContext },
    { method: 'GET', path: '/api/v1/customers', trustedContext: 'required',
      policy: { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'view_customers' } } });
  assert.deepEqual(uncataloguedRoutePermissions([route]), [], 'view_customers is catalogued and decidable');
});

test('M7C-02: the runtime login cannot touch the table or 017\'s routine; 018\'s session-bound read is its one way in; the catalog and both postconditions say so', async () => {
  for (const statement of [
    'select count(*) from tmpos_customer.customer',
    `insert into tmpos_customer.customer (customer_id, tenant_id, name) values ('${randomUUID()}', '${T_A}', 'x')`,
    'update tmpos_customer.customer set name = name',
    'delete from tmpos_customer.customer',
    'truncate tmpos_customer.customer',
  ]) {
    const code = await runtime.unsafe(statement).then(() => null, (err) => err.code);
    assert.equal(code, '42501', `the runtime login is refused: ${statement}`);
  }
  // REWRITTEN FOR DA-83 (M7A-CUSTOMERS-P2). 017's routine took the authority as arguments the login could build itself
  // (doc 08 DA-83), so 018 revoked it: the login's call is refused, whatever tuple it names — its own real one included.
  const s = await scopeOf(A_OWNER, T_A);
  assert.equal(await routineAsLogin(s).then(() => null, (err) => err.code), '42501', '017\'s routine is closed to the runtime login');
  // 018's read is the way in, with one authority argument: a minted session's key. A's key reads exactly what 017's page
  // run as the owner answers for A's real authority; a key no sign-in minted is 'denied'; a malformed limit 'invalid'.
  const a = await minted(A_OWNER);
  const rows = await v2(a);
  assert.deepEqual(rows.map((r) => ({ ...r })), (await routineAsOwner(s)).map((r) => ({ ...r })), 'the owner\'s 017 page for the same authority');
  assert.deepEqual(rows.map((r) => r.o_customer_id).sort(), SEED_A.map((c) => c.id).sort());
  assert.ok(rows.every((r) => r.o_outcome === 'customer' && r.o_tenant_id === T_A), 'every row names the admitted tenant');
  assert.deepEqual((await v2(keyOf(`k=${randomBytes(32).toString('base64url')}`))).map((r) => ({ ...r })),
    [{ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null }], 'a key no sign-in minted');
  for (const limit of [0, 102]) assert.deepEqual((await v2(a, null, limit)).map((r) => r.o_outcome), ['invalid'], `limit ${limit}`);
  // B's whole directory at the routine's own maximum, continuation included: every row B's.
  const b = await minted(B_USER);
  const pages = [await v2(b, null, 101)];
  while (pages.at(-1).length === 101) pages.push(await v2(b, pages.at(-1).at(-1).o_customer_id, 101));
  assert.deepEqual(pages.map((p) => p.length), [101, 101, 48]);
  assert.ok(pages.flat().every((r) => r.o_outcome === 'customer' && r.o_tenant_id === T_B), 'every B row names B');

  const [cat] = await owner`select
      c.relrowsecurity as rls,
      (select coalesce(array_agg(pg_catalog.format('%s:%s', g.grantee::regrole, g.privilege_type)), '{}')
         from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g where g.grantee <> c.relowner) as table_grants,
      (select count(*)::int from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attacl is not null) as column_grants,
      p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
      (select coalesce(array_agg(pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable)), '{}')
         from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where g.grantee <> p.proowner) as routine_grants,
      (select coalesce(array_agg(pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable)), '{}')
         from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
        where n.nspname = 'tmpos_customer' and g.grantee <> n.nspowner) as schema_grants
    from pg_catalog.pg_class c, pg_catalog.pg_proc p
   where c.oid = 'tmpos_customer.customer'::regclass and p.oid = ${ROUTINE}::regprocedure`;
  // 018 revoked the routine's one grant; the schema's USAGE stays (with no routine or table open to it, it confers nothing).
  assert.deepEqual({ ...cat }, {
    rls: true, table_grants: [], column_grants: 0, definer: true, volatility: 's',
    config: ['search_path=pg_catalog, pg_temp', 'row_security=off'],
    routine_grants: [], schema_grants: ['tmpos_app:USAGE:f'],
  });

  // Each postcondition refuses a deliberate widening — inside a transaction that is rolled back — and holds without one.
  // 017's proves the EXECUTE 018 revoked, so it holds only over 017's own state, restored inside that transaction.
  const ROLLBACK = new Error('m7c: roll the proof back');
  const postcondition = async (widen, proof = POSTCONDITION_017, restore017 = true) => {
    let code = 'unset';
    await assert.rejects(owner.begin(async (tx) => {
      if (restore017) await tx.unsafe(`grant execute on function ${ROUTINE} to tmpos_app`);
      if (widen !== null) await tx.unsafe(widen);
      code = await tx.savepoint((sp) => sp.unsafe(proof).simple()).then(() => null, (err) => err.code);
      throw ROLLBACK;
    }), (err) => err === ROLLBACK);
    return code;
  };
  assert.equal(await postcondition('grant select on tmpos_customer.customer to tmpos_app'), '55000', 'a SELECT granted to tmpos_app is refused');
  assert.equal(await postcondition('create policy m7c_probe on tmpos_customer.customer for select to tmpos_app using (true)'), '55000',
    'a policy on the table is refused');
  assert.equal(await postcondition('grant pg_read_all_data to tmpos_app'), '55000', 'membership in pg_read_all_data (an effective privilege) is refused');
  assert.equal(await postcondition(null), null, 'the state 017 left satisfies it');
  assert.equal(await postcondition(null, POSTCONDITION_017, false), '55000', 'the state 018 leaves does not: the login lost 017\'s EXECUTE');
  assert.equal(await postcondition(null, POSTCONDITION_018, false), null, '018\'s own postcondition holds over it');
  assert.equal(await postcondition(null, POSTCONDITION_018), '55000', 'and refuses 017\'s EXECUTE given back');
  const [after] = await owner`select pg_catalog.has_table_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT') as granted,
    (select count(*)::int from pg_catalog.pg_policy where polrelid = 'tmpos_customer.customer'::regclass) as policies,
    pg_catalog.has_function_privilege('tmpos_app', ${ROUTINE}, 'EXECUTE') as routine,
    pg_catalog.has_function_privilege('tmpos_app', ${ROUTINE_V2}, 'EXECUTE') as routine_v2`;
  assert.deepEqual({ ...after }, { granted: false, policies: 0, routine: false, routine_v2: true }, 'the widenings did not survive');
});

test('M7C-02b: the name CHECK mirrors 009 — no control, line/paragraph separator, Bidi_Control or edge whitespace; 1-200 characters', async () => {
  const insert = (name) => owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${randomUUID()}, ${T_NAMES}, ${name})`
    .then(() => null, (err) => err.code);
  const E = '\u{1F600}';
  for (const [label, name] of [['U+202E', 'a‮b'], ['U+2066', 'a⁦b'], ['U+061C', 'a؜b'], ['U+200E', 'a‎b'],
    ['leading space', ' lead'], ['trailing space', 'trail '], ['leading NBSP', ' lead'], ['trailing U+3000', 'trail　'],
    ['trailing U+FEFF', 'trail﻿'], ['U+2028', 'a b'], ['U+2029', 'a b'], ['U+0085', 'a\u0085b'], ['DEL', 'a\u007Fb'],
    ['tab', 'a\tb'], ['only spaces', '   '], ['empty', ''], ['201 characters', 'n'.repeat(201)], ['201 astral characters', E.repeat(201)]]) {
    assert.equal(await insert(name), '23514', `${label} is refused by the CHECK`);
  }
  const accepted = await seed(T_NAMES, ['mid dle', 'n'.repeat(200), E.repeat(200)]);
  assert.equal((await owner`select count(*)::int as n from tmpos_customer.customer where tenant_id = ${T_NAMES}`)[0].n, 3, 'only the three accepted');
  // The longest name the schema holds (200 astral characters = 400 UTF-16 units) is served whole, not a 503.
  await withApp(async ({ signIn, list }) => {
    assert.deepEqual(pageOf(await list(await signIn(NAMES_USER)), 'names'), { customers: [...accepted].sort(byteOrder), nextCursor: null });
  });
});

// ---------------------------------------------------------------------------
// M7C-03..08: the page
// ---------------------------------------------------------------------------

test('M7C-03: every built-in tenant role on A reads exactly A\'s customers, in UTF-8 byte order then id, and nothing else', async () => {
  const expected = await expectedOf(T_A);
  assert.deepEqual(expected.map((c) => c.id).sort(), SEED_A.map((c) => c.id).sort(), 'the database holds what was seeded');
  // The fixture can tell byte order from JS's UTF-16 order, and from any case- or accent-folding collation.
  assert.notDeepEqual(expected.map((c) => c.name), [...expected.map((c) => c.name)].sort(), 'UTF-8 and UTF-16 orders differ here');
  await withApp(async ({ signIn, list }) => {
    for (const who of [A_OWNER, A_MANAGER, A_TECH, A_SALES]) {
      const body = pageOf(await list(await signIn(who)), who.uid);
      assert.deepEqual(body, { customers: expected, nextCursor: null }, who.uid);
    }
  });
});

test('M7C-04: B walks 250 customers at 100 as 100,100,50 and at 50 as five pages; no tenant ever sees another\'s customer', async () => {
  const ids = (tenantSeed) => new Set(tenantSeed.map((c) => c.id));
  const [idsA, idsB, idsC] = [ids(SEED_A), ids(SEED_B), ids(SEED_C)];
  const expectedB = await expectedOf(T_B);
  await withApp(async ({ signIn, walk }) => {
    const b = await signIn(B_USER);
    const pages = await walk(b, 100);
    assert.deepEqual(pages.map((p) => p.length), [100, 100, 50]);
    const seen = pages.flat();
    assert.equal(new Set(seen.map((c) => c.id)).size, 250, 'no duplicate');
    assert.deepEqual(seen, expectedB, 'every B customer once, in order');
    assert.ok(seen.every((c) => idsB.has(c.id)), 'no other tenant\'s id on any page');
    // Page 100/101 is one identical-name pair split by the boundary: the keyset carries it by id.
    assert.equal(seen[99].name, seen[100].name);
    const fifties = await walk(b, 50);
    assert.deepEqual(fifties.map((p) => p.length), [50, 50, 50, 50, 50], 'an exact multiple ends with nextCursor null, not an empty page');
    assert.deepEqual(fifties.flat(), expectedB);

    const a = (await walk(await signIn(A_OWNER), 100)).flat();
    assert.ok(a.every((c) => idsA.has(c.id)) && !a.some((c) => idsB.has(c.id) || idsC.has(c.id)), 'A never sees B or C');
    const c = (await walk(await signIn(C_USER), 100)).flat();
    assert.deepEqual(c, await expectedOf(T_C), 'C sees exactly C');
  });
});

test('M7C-05: limit=1 walks A with no duplicate or skip across the equal-name group; default 50, 100 accepted, every bad query a 400', async () => {
  await withApp(async ({ signIn, list, walk }) => {
    const a = await signIn(A_MANAGER);
    const ones = await walk(a, 1);
    assert.ok(ones.every((p) => p.length === 1));
    assert.deepEqual(ones.flat(), await expectedOf(T_A), 'one at a time, the equal names by id, nothing repeated or skipped');

    const b = await signIn(B_USER);
    const expectedB = await expectedOf(T_B);
    const byDefault = pageOf(await list(b), 'default');
    assert.deepEqual([byDefault.customers, decodeCustomerCursor(byDefault.nextCursor)], [expectedB.slice(0, 50), expectedB[49].id], 'default limit 50');
    assert.deepEqual(pageOf(await list(b, '?limit=100'), 'limit 100').customers, expectedB.slice(0, 100));

    const cursor = encodeCustomerCursor(expectedB[0].id);
    for (const query of ['?limit=0', '?limit=101', '?limit=-1', '?limit=01', '?limit=abc', '?limit=5&limit=5', '?limit=', '?limit=1000',
      '?tenant=' + T_A, '?limit=5&tenantId=' + T_A, '?', '?limit=5&', '?&limit=5', '?limit=%35', `?cursor=${cursor}&cursor=${cursor}`,
      `?limit=5&x=${'1'.repeat(130)}`]) {
      const reply = await list(b, query);
      assertRefusal(reply, 400, 'invalid_request', query);
    }
  });
});

test('M7C-06: a tenant with no customer answers an empty page', async () => {
  await withApp(async ({ signIn, list }) => {
    assert.deepEqual(pageOf(await list(await signIn(D_USER)), 'empty'), { customers: [], nextCursor: null });
  });
});

test('M7C-07: a malformed, foreign, other-route or deleted-customer cursor is one indistinguishable 400', async () => {
  await withApp(async ({ signIn, list, reason }) => {
    const a = await signIn(A_OWNER);
    const b = await signIn(B_USER);
    const valid = encodeCustomerCursor(SEED_A[0].id);
    const last = valid.at(-1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const nonCanonical = valid.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    assert.equal(Buffer.from(nonCanonical, 'base64url').equals(Buffer.from(valid, 'base64url')), true, 'the same bytes, another spelling');
    for (const [label, cursor] of [['abc', 'abc'], ['22 chars', valid.slice(0, 22)], ['24 chars', `${valid}A`],
      ['non-canonical', nonCanonical], ['tenant-directory cursor', encodeTenantCursor(T_A)], ['empty', '']]) {
      assertRefusal(await list(a, `?cursor=${cursor}`), 400, 'invalid_request', label);
    }

    // A real continuation B was ISSUED, presented by A, and a random uuid's: the same 400, the same logged reason.
    const issuedToB = pageOf(await list(b, '?limit=10'), 'b page').nextCursor;
    const foreign = await list(a, `?cursor=${issuedToB}`);
    const random = await list(a, `?cursor=${encodeCustomerCursor(randomUUID())}`);
    assertRefusal(foreign, 400, 'invalid_request', 'B\'s cursor to A');
    assertRefusal(random, 400, 'invalid_request', 'random cursor');
    assert.equal(foreign.body.length, random.body.length, 'bodies of one length: only the request id differs');
    assert.deepEqual([reason(foreign), reason(random)], ['customer_directory_cursor_unknown', 'customer_directory_cursor_unknown']);
    for (const c of SEED_B) assert.ok(!foreign.body.includes(c.id) && !foreign.body.includes(c.name));

    // A cursor naming a customer deleted after it was issued.
    const [transient] = await seed(T_A, [`#transient ${SUFFIX}`]);
    const first = pageOf(await list(a, '?limit=1'), 'transient page');
    assert.deepEqual(first.customers, [transient], 'the transient customer sorts first');
    await owner`delete from tmpos_customer.customer where customer_id = ${transient.id}`;
    const stale = await list(a, `?limit=1&cursor=${first.nextCursor}`);
    assertRefusal(stale, 400, 'invalid_request', 'deleted customer\'s cursor');
    assert.equal(reason(stale), 'customer_directory_cursor_unknown');
  });
});

test('M7C-08: a customer inserted mid-walk appears once if it sorts after the cursor and never if before; nothing repeats', async () => {
  await withApp(async ({ signIn, list }) => {
    const a = await signIn(A_TECH);
    const page1 = pageOf(await list(a, '?limit=2'), 'page 1');
    const cursorId = decodeCustomerCursor(page1.nextCursor);
    const cursorName = page1.customers[1].name;
    assert.equal(cursorName, `Same ${SUFFIX}`, 'the cursor stands inside the identical-name group');
    let lower; do lower = randomUUID(); while (lower >= cursorId);
    let higher; do higher = randomUUID(); while (higher <= cursorId);
    // Before the cursor: a smaller name, and the SAME name with a smaller id. After it: the same name with a larger id,
    // and a larger name.
    const before = await seed(T_A, [`!before ${SUFFIX}`, cursorName], [undefined, lower]);
    const after = await seed(T_A, [cursorName, `~after ${SUFFIX}`], [higher, undefined]);
    const rest = [];
    let cursor = page1.nextCursor;
    for (let guard = 0; cursor !== null && guard < 50; guard++) {
      const body = pageOf(await list(a, `?limit=2&cursor=${cursor}`), 'page n');
      rest.push(...body.customers);
      cursor = body.nextCursor;
    }
    const restIds = rest.map((c) => c.id);
    assert.equal(new Set([...page1.customers.map((c) => c.id), ...restIds]).size, page1.customers.length + rest.length, 'no duplicate');
    for (const c of after) assert.equal(restIds.filter((id) => id === c.id).length, 1, `after ${c.name}: exactly once`);
    for (const c of before) assert.ok(!restIds.includes(c.id), `before ${c.name}: never`);
    const now = await expectedOf(T_A);
    assert.deepEqual(rest, now.slice(now.findIndex((c) => c.id === cursorId) + 1), 'the rest is exactly what sorts after the cursor now');
  });
});

// ---------------------------------------------------------------------------
// M7C-09..11: refusals, the routine's own re-check, outages
// ---------------------------------------------------------------------------

/** What each refusal case answered, for the report. */
const OBSERVED = {};

test('M7C-09: every caller who may not list is refused with the chain\'s own status and no customer data', async () => {
  const setStatus = (table, key, id, status) => owner.unsafe(`update ${table} set status = $1 where ${key} = $2`, [status, id]);
  await withApp(async ({ login, signIn, list, reason }) => {
    const refused = async (label, reply, status, error) => {
      assertRefusal(reply, status, error, label);
      OBSERVED[label] = `${reply.status} ${bodyOf(reply).error} (${reason(reply)})`;
    };
    await refused('no cookie', await list(null), 401, 'unauthenticated');
    const tenantCookie = SESSION_COOKIES.tenant;
    await refused('forged session cookie', await list(`${tenantCookie}=${randomBytes(32).toString('base64url')}`), 401, 'unauthenticated');
    await refused('malformed session cookie', await list(`${tenantCookie}=not-a-session`), 401, 'unauthenticated');

    // A platform session: its own cookie is not the tenant's, and its value under the tenant name is the wrong audience.
    const admin = await signIn(PLATFORM_ONLY, 'admin');
    await refused('admin session cookie', await list(admin), 401, 'unauthenticated');
    await refused('admin session under the tenant cookie name', await list(`${tenantCookie}=${admin.slice(admin.indexOf('=') + 1)}`), 401, 'unauthenticated');
    for (const [label, who] of [['platform-only tenant login', PLATFORM_ONLY], ['no-grant tenant login', NO_GRANT],
      ['pending_activation tenant login', PENDING_USER]]) {
      const reply = await login(who);
      await refused(label, reply, 401, 'unauthenticated');
      assert.equal(reply.headers['set-cookie'], undefined, `${label}: no session issued`);
    }
    await refused('store-only user', await list(await signIn(STORE_ONLY)), 403, 'forbidden');
    await refused('two tenant grants', await list(await signIn(TWO_TENANTS)), 403, 'forbidden');

    // Standing changed after the login: the next request is refused.
    const changes = [
      ['tenant suspended after login', SUSPEND_USER, () => setStatus('tenant', 'tenant_id', T_SUSPEND, 'suspended')],
      ['account suspended after login', ACCOUNT_SUSPENDED, () => setStatus('app_user', 'internal_user_id', ACCOUNT_SUSPENDED.id, 'suspended')],
      ['role manager -> technician after login', ROLE_MOVED, () => owner`update user_membership set role_id = 'technician' where internal_user_id = ${ROLE_MOVED.id}`],
      ['membership suspended after login', GRANT_OFF, () => owner`update user_membership set status = 'suspended' where internal_user_id = ${GRANT_OFF.id}`],
    ];
    for (const [label, who, change] of changes) {
      const cookie = await signIn(who);
      pageOf(await list(cookie, '?limit=1'), `${label}: served before the change`);
      await change();
      await refused(label, await list(cookie), 401, 'unauthenticated');
    }

    // Reads stay open to read-limited standings.
    const served = async (label, who, expected) => {
      const body = pageOf(await list(await signIn(who)), label);
      assert.deepEqual(body, { customers: expected, nextCursor: null }, label);
      OBSERVED[label] = '200';
    };
    await served('read_only tenant', RO_USER, [...SEED_RO].sort(byteOrder));
    await served('overdue tenant', OVERDUE_USER, [...SEED_OVERDUE].sort(byteOrder));
    await served('read_only account', RO_ACCOUNT, await expectedOf(T_A));
    await served('tenant grant plus a store grant elsewhere', MIXED, await expectedOf(T_A));
    // A second tenant grant on a SUSPENDED or PENDING tenant is not an eligible grant: exactly A, at the chain and in the routine.
    await served('tenant grant plus a grant on a suspended tenant', A_PLUS_SUSPENDED, await expectedOf(T_A));
    await served('tenant grant plus a grant on a pending tenant', A_PLUS_PENDING, await expectedOf(T_A));
    for (const who of [A_PLUS_SUSPENDED, A_PLUS_PENDING]) {
      // The routine asked with the actor's own minted session key, the only authority 018's read takes (rewritten for DA-83).
      const rows = await v2(keyOf(await signIn(who)));
      assert.deepEqual(rows.map((r) => ({ id: r.o_customer_id, name: r.o_name })), await expectedOf(T_A), `${who.uid}: the routine pages`);
      assert.ok(rows.every((r) => r.o_outcome === 'customer' && r.o_tenant_id === T_A), `${who.uid}: every row A's`);
    }
  });
});

// REWRITTEN FOR DA-83 (M7A-CUSTOMERS-P2). The adapter used to hand the database the scope's five facts, and the routine
// judged that caller-built tuple. It now hands only the session key: the database derives the authority from the minted
// session, and the adapter still pages only rows of the AUTHORIZER's tenant.
test('M7C-10: the adapter reads only through a minted, live session key: a stale, forged, foreign or unminted one is refused, and only the authorizer\'s tenant is paged', async () => {
  const page = (scope, key, limit = 100) => DIRECTORY.page(scope, key, { after: null, limit }, signal());
  const denied = async (scope, key, label) => assert.deepEqual(await page(scope, key), { outcome: 'denied' }, label);
  const invalid = /customer directory answer invalid/;

  const own = await scopeOf(A_OWNER, T_A);
  const key = await minted(A_OWNER);
  const valid = await page(own, key);
  assert.deepEqual(valid, { outcome: 'page', customers: await expectedOf(T_A), hasMore: false });
  assert.deepEqual(await page(own, key, 3), { outcome: 'page', customers: (await expectedOf(T_A)).slice(0, 3), hasMore: true });
  // The scope's actor, membership, role and version are no longer parameters: whatever they say, the session decides.
  for (const [label, forged] of [['another actor\'s membership on the same tenant', { membershipId: await membershipOf(A_MANAGER) }],
    ['another role on the right membership', { roleId: 'manager' }], ['a security version never issued', { securityVersion: 'f'.repeat(64) }]]) {
    assert.deepEqual(await page({ ...own, ...forged }, key), valid, `${label}: not sent, so it widens and narrows nothing`);
  }
  // A scope naming another tenant: the session's rows are A's, and a row of any tenant but the authorizer's is a fault.
  await assert.rejects(page({ ...own, tenant: T_B }, key), invalid, 'a tenant the actor holds no grant on');
  await assert.rejects(page({ ...own, tenant: randomUUID() }, key), invalid, 'a tenant that does not exist');
  const mixed = await scopeOf(MIXED, T_A);
  await assert.rejects(page({ ...mixed, tenant: T_C }, await minted(MIXED)), invalid, 'a tenant the actor holds only a STORE grant under');
  await assert.rejects(page(own, await minted(B_USER)), invalid, 'another tenant\'s actor\'s key: B\'s rows are not the authorizer\'s tenant\'s');

  // Keys that name no minted, live tenant session.
  await denied(own, keyOf(`k=${randomBytes(32).toString('base64url')}`), 'a key no sign-in minted');
  const legacy = keyOf(`k=${randomBytes(32).toString('base64url')}`);
  const at = Date.now();
  await owner`insert into tmpos_session.session (session_key, audience, auth_provider, auth_provider_uid, principal_key, security_version,
      authenticated_at, created_at, last_seen_at, validated_at, expires_at)
    values (${legacy}, 'tenant', 'firebase', ${A_OWNER.uid}, ${'p'.repeat(43)}, 't2:legacy', ${at}, ${at}, ${at}, ${at}, ${at + 3_600_000})`;
  await denied(own, legacy, 'a tenant session row written outside the mint (no ledger row)');
  const admin = await minted(PLATFORM_ONLY, 'admin');
  await denied(own, admin, 'an administrative session\'s key');
  const revoked = await minted(A_OWNER);
  await runtime`select tmpos_session.m5_session_revoke(${revoked}::text)`;
  await denied(own, revoked, 'a revoked session');

  // Changes committed after the session was minted: the database compares the standing it minted with the live one.
  const stale = await scopeOf(P10_STALE, T_A);
  assert.equal(stale.limitation, 'read_only');
  const staleKey = await minted(P10_STALE);
  await owner`update app_user set status = 'active' where internal_user_id = ${P10_STALE.id}`;
  await denied(stale, staleKey, 'a standing the account moved away from');
  assert.equal((await page(await scopeOf(P10_STALE, T_A), await minted(P10_STALE))).outcome, 'page', 'a fresh session reads');

  const tsusp = await scopeOf(P10_TSUSP, T_P10);
  const tsuspKey = await minted(P10_TSUSP);
  assert.deepEqual(await page(tsusp, tsuspKey), { outcome: 'page', customers: SEED_P10, hasMore: false }, 'reads before the suspension');
  await owner`update tenant set status = 'suspended' where tenant_id = ${T_P10}`;
  await denied(tsusp, tsuspKey, 'the tenant suspended');

  const second = await scopeOf(P10_SECOND, T_A);
  const secondKey = await minted(P10_SECOND);
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${P10_SECOND.id}, ${T_C}, null, 'tenant', 'manager', 'active')`;
  await denied(second, secondKey, 'a second tenant grant added: ambiguous');

  const account = await scopeOf(P10_ACCOUNT, T_A);
  const accountKey = await minted(P10_ACCOUNT);
  await owner`update app_user set status = 'suspended' where internal_user_id = ${P10_ACCOUNT.id}`;
  await denied(account, accountKey, 'the account suspended');

  const grant = await scopeOf(P10_GRANT, T_A);
  const grantKey = await minted(P10_GRANT);
  await owner`update user_membership set status = 'suspended' where internal_user_id = ${P10_GRANT.id}`;
  await denied(grant, grantKey, 'the membership suspended');

  // A scope that is not a tenant scope, an out-of-range limit or a key not of the store-key shape never reaches the database.
  await assert.rejects(DIRECTORY.page({ ...own, scope: 'store' }, key, { after: null, limit: 5 }, signal()), invalid);
  await assert.rejects(DIRECTORY.page(own, key, { after: null, limit: 101 }, signal()), invalid);
  await assert.rejects(DIRECTORY.page(own, `${key}=`, { after: null, limit: 5 }, signal()), invalid);
});

test('M7C-11: an unreachable database or an out-of-shape answer is a bounded 503; a grant withdrawn mid-request is a 403', async () => {
  // A store nobody listens on: an explicit socket in an empty directory the harness owns, never the
  // disposable target and never anything ambient.
  const dead = createSupervisedPgClient(unreachableTestDriver(), 'postgres:///tmpos_s1b_unreachable', {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 1, idle_timeout: 0, connect_timeout: 1, user: RUNTIME_LOGIN,
  });
  try {
    await withApp(async ({ signIn, list, reason }) => {
      const reply = await list(await signIn(A_OWNER));
      assertRefusal(reply, 503, 'service_unavailable', 'unreachable customer store');
      OBSERVED['unreachable customer store'] = `503 (${reason(reply)})`;
    }, { customers: createPostgresCustomerDirectory({ client: dead }), deadlineMs: 1_500 });
  } finally {
    await dead.end();
  }

  const shaped = (customers) => ({ page: async () => ({ outcome: 'page', customers, hasMore: false }) });
  for (const [label, port] of [
    ['a customer carrying email', shaped([{ id: randomUUID(), name: 'x', email: 'x@example.test' }])],
    ['a customer without a name', shaped([{ id: randomUUID() }])],
    ['a non-uuid id', shaped([{ id: 'not-a-uuid', name: 'x' }])],
    ['a refusal mixed with extra keys', { page: async () => ({ outcome: 'denied', tenant: T_B }) }],
  ]) {
    await withApp(async ({ signIn, list, reason }) => {
      const reply = await list(await signIn(A_OWNER));
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(reason(reply), 'customer_directory_answer_invalid', label);
      assert.ok(!reply.body.includes('example.test'));
    }, { customers: port });
  }

  // The authorizer decided on the grant, then the grant moved before the routine read: the routine's 'denied' is a 403.
  const racing = {
    async page(scope, key, query, sig) {
      await owner`update user_membership set role_id = 'technician' where membership_id = ${scope.membershipId}`;
      return DIRECTORY.page(scope, key, query, sig);
    },
  };
  await withApp(async ({ signIn, list, reason }) => {
    const reply = await list(await signIn(MID_REQUEST));
    assertRefusal(reply, 403, 'forbidden', 'grant moved between the authorizer and the read');
    assert.equal(reason(reply), 'customer_directory_denied');
    OBSERVED['grant moved mid-request'] = `403 (${reason(reply)})`;
  }, { customers: racing });
});

// ---------------------------------------------------------------------------
// M7C-15..18: session lifetime, concurrent reads racing concurrent inserts, the 'trialing' standing,
// and a forced-RLS, non-superuser table owner
// ---------------------------------------------------------------------------

test('M7C-15: a validly-shaped session past its idle window, or its absolute lifetime, is refused with no customer read', async () => {
  const spy = { count: 0, page: async (...args) => { spy.count++; return DIRECTORY.page(...args); } };
  const BASE = Date.now();

  // Idle: SESSION_TTL.tenant.idleMs (30 min) passes with no other request on the session, so lastSeenAt (stamped
  // at login) is stale; createdAt is just as stale, but far short of the 8h absolute lifetime.
  let idleClock = BASE;
  await withApp(async ({ signIn, list, reason }) => {
    const cookie = await signIn(IDLE_USER);
    idleClock += SESSION_TTL.tenant.idleMs + 1;
    const reply = await list(cookie);
    assertRefusal(reply, 401, 'unauthenticated', 'idle-expired session');
    assert.equal(reason(reply), 'session_idle_expired');
  }, { now: () => idleClock, customers: spy });

  // Absolute: SESSION_TTL.tenant.absoluteMs (8h) passes with no other request either, so the SAME record is also
  // idle-expired — sessions.ts liveSession checks the absolute lifetime FIRST, and it wins.
  let expireClock = BASE;
  await withApp(async ({ signIn, list, reason }) => {
    const cookie = await signIn(EXPIRE_USER);
    expireClock += SESSION_TTL.tenant.absoluteMs + 1;
    const reply = await list(cookie);
    assertRefusal(reply, 401, 'unauthenticated', 'absolute-expired session');
    assert.equal(reason(reply), 'session_expired');
  }, { now: () => expireClock, customers: spy });

  assert.equal(spy.count, 0, 'the customer port is never asked for an expired session');
});

test('M7C-16: concurrent inserts race concurrent page walks; every reply is 200, one tenant\'s, ordered, no duplicate', async () => {
  const T_RACE = await newTenant('race');
  const RACE_USER = await actor('race-user', [tenantGrant(T_RACE, 'manager')]);
  const before = await seed(T_RACE, Array.from({ length: 40 }, (_, i) => `Race ${String(i).padStart(3, '0')} ${SUFFIX}`));
  const beforeIds = new Set(before.map((c) => c.id));
  const inserted = [];
  await withApp(async ({ signIn, walk }) => {
    const cookie = await signIn(RACE_USER);
    let stop = false;
    const inserter = (async () => {
      for (let i = 0; i < 30 && !stop; i++) {
        const [row] = await seed(T_RACE, [`Race-new ${String(i).padStart(3, '0')} ${SUFFIX}`]);
        inserted.push(row);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    // Several full walks at once (walk() itself issues one 200-asserting page request at a time, in sequence,
    // so this is several concurrent page requests as well as several concurrent full walks).
    const walks = await Promise.all([1, 2, 3].map(() => walk(cookie, 7)));
    stop = true;
    await inserter;
    const insertedIds = new Set(inserted.map((r) => r.id));
    assert.ok(insertedIds.size > 0, 'the background inserter actually raced the walks');
    for (const pages of walks) {
      const flat = pages.flat();
      assert.ok(flat.every((c) => beforeIds.has(c.id) || insertedIds.has(c.id)), 'only this tenant\'s ids appear on any page');
      const ids = flat.map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, 'no id repeats across one whole walk');
      assert.deepEqual(flat, [...flat].sort(byteOrder), 'strictly ordered by (name as UTF-8 bytes, id) across the whole walk');
      for (const c of before) assert.equal(flat.filter((x) => x.id === c.id).length, 1, `${c.name}: untouched and pre-existing, seen exactly once`);
    }
  });
  await owner`delete from tmpos_customer.customer where customer_id = any(${inserted.map((r) => r.id)}::uuid[])`;
  assert.deepEqual(await expectedOf(T_RACE), before, 'cleaned up: only the pre-existing baseline remains');
});

test('M7C-17: an account and tenant both \'trialing\' sign in and read exactly that tenant\'s customers', async () => {
  const trial = await seed(T_TRIAL, [`Trial one ${SUFFIX}`, `Trial two ${SUFFIX}`]);
  await withApp(async ({ signIn, list }) => {
    assert.deepEqual(pageOf(await list(await signIn(TRIAL_USER)), 'trialing'), { customers: [...trial].sort(byteOrder), nextCursor: null });
  });
});

test('M7C-18: a forced, non-superuser table owner closes the blind spot: the down is refused 42501, no row is dropped, ownership is restored', async () => {
  const [{ tenant_id: T_FORCE }] = await owner`insert into tenant (display_name, status) values (${`m7c-force-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(T_FORCE);
  const [forced] = await seed(T_FORCE, [`Forced ${SUFFIX}`]);
  await owner.unsafe('drop role if exists m7c_cust_owner');
  await owner.unsafe('create role m7c_cust_owner nologin nosuperuser nobypassrls');
  try {
    await owner.unsafe('alter schema tmpos_customer owner to m7c_cust_owner');
    await owner.unsafe('alter table tmpos_customer.customer owner to m7c_cust_owner');
    await owner.unsafe('alter table tmpos_customer.customer force row level security');

    // The blind spot the fix closes: forced RLS, no policy, and row_security left ON — even the table's own
    // (non-BYPASSRLS) owner sees no row: a false EXISTS while the row is physically present.
    const [blind] = await owner.begin(async (tx) => {
      await tx.unsafe('set local role m7c_cust_owner');
      return tx`select exists (select 1 from tmpos_customer.customer where customer_id = ${forced.id}) as e`;
    });
    assert.equal(blind.e, false, 'forced RLS, row_security on: the owner\'s own guard silently sees no row');

    // The down, run as that forced owner: its own new `set local row_security = off` turns that silent blind
    // spot into a hard refusal instead of a guard that (wrongly) proceeds. Granted only what its LOCK needs.
    const code = await owner.begin(async (tx) => {
      await tx.unsafe('grant all on public.tenant to m7c_cust_owner');
      await tx.unsafe('set local role m7c_cust_owner');
      await tx.unsafe(DOWN_017).simple();
    }).then(() => null, (err) => err.code);
    assert.equal(code, '42501', 'the down as the forced, non-superuser owner is refused, never reaching its guard\'s answer');
    assert.equal((await owner`select count(*)::int as n from tmpos_customer.customer where customer_id = ${forced.id}`)[0].n, 1,
      'the row survives the refused down');
  } finally {
    await owner.unsafe('alter table tmpos_customer.customer no force row level security');
    await owner.unsafe('alter table tmpos_customer.customer owner to current_user');
    await owner.unsafe('alter schema tmpos_customer owner to current_user');
    await owner.unsafe('drop role if exists m7c_cust_owner');
  }
  const [restored] = await owner`select pg_catalog.pg_get_userbyid(c.relowner) as owner, c.relforcerowsecurity as forced, current_user as me
    from pg_catalog.pg_class c where c.oid = 'tmpos_customer.customer'::regclass`;
  assert.deepEqual({ ...restored }, { owner: restored.me, forced: false, me: restored.me }, 'ownership and FORCE are exactly as 017 left them');
});

// ---------------------------------------------------------------------------
// M7C-12..14: logs, audit, rollback
// ---------------------------------------------------------------------------

function assertNoLeak() {
  assert.ok(LOGS.length > 50, 'the suite captured the runtime\'s log lines');
  assert.ok(SESSION_SECRETS.size > 50, 'the suite recorded its sessions\' identifiers, keys and proofs');
  const issuer = ['hex', 'base64', 'base64url'].map((encoding) => ISSUER_KEY.toString(encoding));
  const needles = [...SEEDED_NAMES, ...SEEDED_IDS, ...[...CURSORS].filter((c) => c.length >= 8), '?', ...SESSION_SECRETS, ...issuer];
  const leaks = [];
  for (const line of LOGS) for (const needle of needles) if (line.includes(needle)) leaks.push(needle.slice(0, 4));
  assert.deepEqual(leaks, [], 'no customer name, id, cursor, query string, session identifier or key, mint proof or issuer key in any log line');
}

// design-B M7M-11 is this scan: the suite's sessions are minted through the real store and read over the real chain.
test('M7C-12: across the suite no log line carries a customer name or id, a cursor, a query string, a session identifier or key, a mint proof or the issuer key', () => {
  assertNoLeak();
  const requests = LOGS.map((l) => JSON.parse(l)).filter((r) => r.event === 'request' && r.route !== undefined);
  assert.ok(requests.some((r) => r.status === 400) && requests.some((r) => r.status === 200));
});

test('M7C-13: listing writes no audit record and no event', async () => {
  const counts = async () => ({ ...(await owner`select
      (select count(*)::int from public.audit_event) as audits,
      (select count(*)::int from tmpos_internal.outbox_event) as events`)[0] });
  await withApp(async ({ signIn, list, walk }) => {
    const b = await signIn(B_USER);
    const a = await signIn(A_SALES);
    const before = await counts();
    await walk(b, 100);
    pageOf(await list(a), 'a');
    assertRefusal(await list(a, '?limit=0'), 400, 'invalid_request', 'bad query');
    assertRefusal(await list(a, `?cursor=${encodeCustomerCursor(randomUUID())}`), 400, 'invalid_request', 'unknown cursor');
    assert.deepEqual(await counts(), before);
  });
});

// REWRITTEN FOR DA-83 (M7A-CUSTOMERS-P2; judge-contract A-J2). 017 now sits under 018, whose routines call its page: a
// real rollback empties the issuer key and the mint ledger as the owner, runs 018's down, then 017's, and re-applies 017
// THEN 018 in one transaction. 017 re-applied alone would give the runtime login its EXECUTE back and re-open DA-83 on the
// shared service, which the next suite's preflight (M6PF-01) would refuse.
test('M7C-14: 017 down refuses while a customer exists; under 018 the rollback runs 018\'s down first, removes only its own objects, and re-applied 017 then 018 leave a fresh apply\'s grants', async () => {
  const down = (file, isolation) => owner.begin(isolation, (tx) => tx.unsafe(file).simple())
    .then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
  const present = async () => (await owner`select pg_catalog.to_regnamespace('tmpos_customer') is not null as present`)[0].present;
  const withRows = await down(DOWN_017, 'isolation level read committed');
  assert.equal(withRows?.code, '55000', 'a rollback never deletes customer records');
  assert.match(withRows.message, /holds customer records/);
  assert.equal(await present(), true);

  await withApp(async ({ signIn, list }) => {
    const a = await signIn(A_OWNER);
    await owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
    // 018 first: its down refuses while the key or the ledger holds a row, so the owner empties both deliberately.
    await owner`delete from tmpos_mint.issuer_key`;
    await owner`delete from tmpos_mint.tenant_session`;
    try {
      assert.equal(await down(DOWN_018, 'isolation level read committed'), null, '018 rolls back once the key and the ledger are empty');
      // With no row left, a snapshot older than the check could still hide a committed insert: only READ COMMITTED runs.
      for (const isolation of ['isolation level repeatable read', 'isolation level serializable']) {
        const refused = await down(DOWN_017, isolation);
        assert.equal(refused?.code, '55000', isolation);
        assert.match(refused.message, /READ COMMITTED/, `${isolation}: refused for its isolation, not for a row`);
        assert.equal(await present(), true, `${isolation}: nothing dropped`);
      }
      assert.equal(await down(DOWN_017, 'isolation level read committed'), null, 'READ COMMITTED with no row succeeds');
      const [gone] = await owner`select pg_catalog.to_regnamespace('tmpos_customer') is null as schema_gone,
        pg_catalog.to_regnamespace('tmpos_mint') is null as mint_gone,
        pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is not null as s016,
        pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is not null as s016_hold,
        pg_catalog.to_regprocedure('tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)') is not null as s012,
        pg_catalog.to_regprocedure('tmpos_identity.m5_security_version(uuid)') is not null as s007`;
      assert.deepEqual({ ...gone }, { schema_gone: true, mint_gone: true, s016: true, s016_hold: true, s012: true, s007: true });
      // Without its routine the listing is an outage, never a page.
      assertRefusal(await list(a), 503, 'service_unavailable', 'rolled back');
    } finally {
      // 017 then 018, together: never a committed moment with 017's grant given back. Then the key again.
      await owner.begin(async (tx) => {
        if ((await tx`select pg_catalog.to_regnamespace('tmpos_customer') is null as absent`)[0].absent) await tx.unsafe(UP_017).simple();
        if ((await tx`select pg_catalog.to_regnamespace('tmpos_mint') is null as absent`)[0].absent) await tx.unsafe(UP_018).simple();
      });
      await installTestIssuerKey(owner, ISSUER_KEY);
    }
    const [{ me }] = await owner`select current_user as me`;
    const [back] = await owner`select pg_catalog.has_function_privilege('tmpos_app', ${ROUTINE}, 'EXECUTE') as app,
      pg_catalog.has_function_privilege('tmpos_app', ${ROUTINE_V2}, 'EXECUTE') as app_v2,
      pg_catalog.has_table_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT') as app_select,
      (select proacl::text from pg_catalog.pg_proc where oid = ${ROUTINE}::regprocedure) as acl_017,
      (select proacl::text from pg_catalog.pg_proc where oid = ${CREATE_011}::regprocedure) as acl_011`;
    assert.deepEqual({ ...back }, { app: false, app_v2: true, app_select: false, acl_017: `{${me}=X/${me}}`, acl_011: `{${me}=X/${me}}` },
      'the grants a fresh 001-018 apply leaves: the login holds neither 017\'s page nor 011\'s create');
    // The session minted before the rollback lost its ledger row with it and reads nothing; a fresh sign-in reads again.
    assertRefusal(await list(a), 403, 'forbidden', 'a session minted before the rollback');
    assert.deepEqual(pageOf(await list(await signIn(A_OWNER)), 're-applied'), { customers: [], nextCursor: null }, 'the same runtime reads again');
  });
  assertNoLeak();
  const report = Object.entries(OBSERVED).map(([k, v]) => `${k}: ${v}`).join('\n');
  console.log(`# M7C observed refusals\n${report.replace(/^/gm, '#   ')}`);
});
