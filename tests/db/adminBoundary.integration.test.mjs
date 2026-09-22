// Phase 4.0 M5-GIAM-D1-P4 — THE ADMINISTRATIVE BOUNDARY, END TO END: durable platform admission and authorization over
// the REAL composed runtime, REAL loopback sockets and a disposable PostgreSQL.
//
// WHAT IS COMPOSED HERE IS PRODUCTION'S. The transaction root is assembleTransactions over PRODUCTION_INVENTORY and a
// configured environment: its own route inventory, mutators, revalidator and idempotency-key handling, and the factories
// production ships — the M6 transactional store, migration 013's platform admission, 011's session store and tenant
// admission, 012's tenant directory. The session root is assembleSessions over durableSessionAdapters, the one table
// production binds the administrative admission AND its authorizer through, both from that one platform admission.
// createApp serves the result exactly as an entry would, through createBoundedServer on 127.0.0.1.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY. Three things, none of them on the path under test:
//   * THE DATABASE CLIENT. The client factory is handed the classified endpoint of a synthetic direct URL (it only has
//     to pass classification) and returns instead a supervised client over the disposable cluster, as a non-owner
//     runtime LOGIN holding tmpos_app and tmpos_audit_writer and nothing else — the posture G-DBROLE provisions.
//   * THE IDENTITY VERIFIER. A disposable cluster has no identity provider, so a bearer token maps to a synthetic
//     provider reference, authenticated now with a TOTP second factor. Everything after that point — admission, the
//     session record, revalidation, authorization and the command transaction — is the composed production path.
//   * THE RATE LIMITER. No shared limiter store is approved, so the production composition refuses without one (M5E-00
//     shows it refuses for that alone); the testkit's in-memory limiter stands in, fresh for every runtime below.
//
// WHAT IS PROVED. An administrator is admitted on exactly one platform grant and bound to a 'p1:' witness; the
// witness moves on every change to that grant, its role, the account, the identity anchor or 007's security version, and
// — because 013's authority version only increases, and its four triggers fire even for a session running as a replica
// — never returns to a value it held. So a revoke-and-restore, a role change-and-change-back, a provider reference
// repointed and restored, or an account round trip made where 007's updated_at cannot move ends a session even when it
// made no request in between. A denial ends every administrative session the principal
// holds; a moved witness ends the presented one. The tenant plane confers nothing here: tenant and store grants, a
// tenant grant carrying a platform role id, two platform grants and client-supplied hints are all refused. An admission
// the database cannot answer is a bounded 503 that revokes nothing and fails readiness. And a revocation racing live
// requests leaves every request sent after its commit refused, with nothing committed on the old authority.
//
// DISPOSABLE ONLY. The target is TM_POS_TEST_DATABASE_URL when CI binds one, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. Fixtures are synthetic and randomly
// named; every actor and tenant a test changes is its own, so the suite re-runs on a shared service.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { MAX_POOLS, RETIRED_POOL_GRACE_S, createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';
import { createPostgresSessionStore } from '../../server/persistence/postgresSessionStore.ts';
import { createPostgresTenantAdmission } from '../../server/persistence/postgresTenantAdmission.ts';
import { createPostgresTenantDirectory } from '../../server/persistence/postgresTenantDirectory.ts';
import { createPostgresTransactionalStore } from '../../server/persistence/postgresTransactionalStore.ts';
import { PRODUCTION_INVENTORY, assembleTransactions } from '../../server/composition/productionTransactions.ts';
import { ProductionCompositionError, assembleSessions, durableSessionAdapters } from '../../server/composition/productionSessions.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { testRequestLimits } from '../../server/runtime/rateLimiter.testkit.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { ADMISSION_REVALIDATE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { TENANT_DISPLAY_NAME_EVENTS, TENANT_DISPLAY_NAME_PATH } from '../../server/runtime/tenantDisplayName.ts';
import { TENANT_STATUS_EVENTS, TENANT_STATUS_PATH } from '../../server/runtime/tenantStatus.ts';
import { TENANT_DIRECTORY_PATH } from '../../server/runtime/tenantDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5e-migrator', runtimeRef: 'm5e-runtime' };
const LOCK_KEY = 528_513;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m5e_probe';
const TENANT_ORIGIN = 'http://pos.trusted.test';
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const REASON = 'Synthetic proof of the administrative boundary.';
const ADMIT_READ = 'tmpos_admission.m5_admit_platform_session(text, text)';
/** app.ts PROBE_REUSE_MS (1 s, not exported) and a margin: a readiness probe is reused for that long. */
const PROBE_REUSE_WAIT_MS = 1_100;
const signal = () => AbortSignal.timeout(10_000);

// The configuration the transaction root reads. Synthetic: the URL only has to classify as a direct endpoint on 5432,
// and the client factory below never connects to it. The keys are 32 bytes of 0x09 and 0x07 — never a deployment's.
const CONFIGURED_ENV = Object.freeze({
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  IDEMPOTENCY_KEY: Buffer.alloc(32, 9).toString('base64url'),
  RATE_LIMIT_KEY: Buffer.alloc(32, 7).toString('base64url'),
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
    'M5E INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
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

/** The owner: applies the migrations, writes the fixtures, changes grants and observes. RLS does not restrict it. */
const owner = postgres(driverDsn(TARGET_DSN), { ...CLIENT_OPTS, max: 3, onnotice: () => {} });
let tx = null;
let closed = false;

test.after(async () => {
  if (tx !== null && !closed) await tx.close();
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: real migrations 001-014, a real non-owner runtime login, the production composition
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

/** The endpoint the root classified from CONFIGURED_ENV — recorded, never dialled. */
let classifiedEndpoint = null;
tx = assembleTransactions(PRODUCTION_INVENTORY, CONFIGURED_ENV, {
  client: (endpoint) => {
    classifiedEndpoint = endpoint;
    return createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
      ...runtimeClientOptions(TARGET_DSN), ssl: false, max: MAX_POOLS, idle_timeout: 0, ...CLIENT_OPTS, user: RUNTIME_LOGIN,
    });
  },
  store: createPostgresTransactionalStore,
  platformAdmission: (c) => createPostgresPlatformAdmission({ client: c }),
  sessionStore: (c) => createPostgresSessionStore({ client: c }),
  tenantAdmission: (c) => createPostgresTenantAdmission({ client: c }),
  tenantDirectory: (c) => createPostgresTenantDirectory({ client: c }),
});

/** Bearer token -> provider uid, for every synthetic actor this file creates. */
const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(view) {
    const uid = TOKENS.get(view.bearerToken);
    return uid === undefined ? null : { verified: true, authProvider: 'firebase', authProviderUid: uid, authenticatedAt: Date.now(), secondFactor: 'totp' };
  },
});
const EVENTS = Object.freeze([...TENANT_DISPLAY_NAME_EVENTS, ...TENANT_STATUS_EVENTS]);
const ORIGINS = Object.freeze({ tenant: Object.freeze([TENANT_ORIGIN]), admin: Object.freeze([ADMIN_ORIGIN]) });
const durable = () => durableSessionAdapters({ store: tx.sessionStore, tenantAdmission: tx.tenantAdmission, platformAdmission: tx.platformAdmission });

// ---------------------------------------------------------------------------
// fixtures and observations — all through the owner
// ---------------------------------------------------------------------------

/** A synthetic actor: an identity, an account in `status`, and the given memberships. */
async function actor(label, memberships, status = 'active') {
  const uid = `m5e-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  TOKENS.set(`tok-${uid}`, uid);
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const newTenant = async (label) =>
  (await owner`insert into tenant (display_name) values (${`m5e-${label}-${SUFFIX}`}) returning tenant_id`)[0].tenant_id;
const tenantRow = async (id) => ({ ...(await owner`select display_name, status, row_version from tenant where tenant_id = ${id}`)[0] });
/** The actor's one platform grant. */
const grantOf = async (who) =>
  (await owner`select membership_id from user_membership where internal_user_id = ${who.id} and scope_type = 'platform'`)[0].membership_id;
/** How many ADMINISTRATIVE session rows this principal holds, read as the owner — the runtime role cannot. */
const sessionsOf = async (who, audience = 'admin') =>
  (await owner`select count(*)::int as n from tmpos_session.session where auth_provider_uid = ${who.uid} and audience = ${audience}`)[0].n;
/** The witness the principal's newest administrative session is bound to. */
const witnessOf = async (who) => {
  const rows = await owner`select security_version from tmpos_session.session
    where auth_provider_uid = ${who.uid} and audience = 'admin' order by created_at desc, session_key limit 1`;
  assert.equal(rows.length, 1, `${who.uid} holds an administrative session`);
  return rows[0].security_version;
};
/** Migration 013's read, through the composed port, exactly as the boundary asks it. */
const admitted = (who) => tx.platformAdmission.admit(who.principal, signal());
/** The actor's platform authority version, read from 013's table as the owner: 0 until its first change. */
const authorityOf = async (who) => BigInt((await owner`select coalesce((select authority_version
    from tmpos_admission.platform_authority_version where internal_user_id = ${who.id}), 0)::text as v`)[0].v);
/** 007's security version, read as the owner from 007's own resolution — not through 013's read. */
const securityVersionOf = async (who) => {
  const [row] = await owner`select outcome, security_version from tmpos_identity.m5_resolve_principal('firebase', ${who.uid})`;
  assert.equal(row.outcome, 'resolved', `${who.uid} resolves`);
  return row.security_version;
};
/** What the commands leave behind for one tenant: its row, its audit records and its events. */
const effectsOn = async (sql, tenant) => ({ ...(await sql`select
    (select row_version from public.tenant where tenant_id = ${tenant})::text as version,
    (select status from public.tenant where tenant_id = ${tenant}) as status,
    (select count(*)::int from public.audit_event where subject_tenant_id = ${tenant}) as audits,
    (select count(*)::int from tmpos_internal.outbox_event where aggregate_id = ${tenant}) as events`)[0] });

// ---------------------------------------------------------------------------
// the composed runtime, over a real local socket
// ---------------------------------------------------------------------------

function send(port, method, path, headers = {}, body) {
  const payload = body === undefined ? undefined : Buffer.from(body);
  const framed = method === 'GET' ? headers : { 'content-length': String(payload?.length ?? 0), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: framed, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** The refusal the runtime LOGGED for one reply, found by its request id — the mechanism behind a bare status. */
const reasonOf = (logs, reply) => {
  const id = reply.headers['x-request-id'];
  for (const line of logs) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.event === 'request' && record.requestId === id) return record.reason;
  }
  return undefined;
};
/** A refusal's body is generic: the error word and the request id, nothing else. */
function generic(reply, status, error) {
  assert.equal(reply.status, status, reply.body);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], 'no hint beyond the error word');
  assert.equal(body.error, error);
}

/**
 * One runtime instance: the production composition above, served. Each gets a fresh in-memory limiter, so no test's
 * logins spend another's budget (10 logins a minute per client, 5 per account in five minutes).
 */
async function withRuntime(fn) {
  const logs = [];
  const readiness = createReadinessState();
  readiness.setReady();
  const limits = testRequestLimits();
  const sessions = assembleSessions({
    origins: ORIGINS, verifier: VERIFIER, trustedProxies: limits.trustedProxies, keySecret: limits.keySecret,
    ...durable(),
    // AFTER the spread: the production table carries no limiter, and it is the one slot a harness fills.
    limiter: limits.limiter,
  });
  const app = createApp({
    readiness,
    log: { log: (line) => { logs.push(line); } },
    routes: tx.routes,
    limits: sessions.limits,
    idempotency: tx.idempotency,
    transactions: tx.transactions,
    events: EVENTS,
    sessions: sessions.sessions,
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  /** A login on `audience`: the reply, and the cookie and CSRF token when it was admitted. */
  const login = async (who, audience = 'admin') => {
    const reply = await send(port, 'POST', sessionPaths(audience).login, {
      origin: audience === 'admin' ? ADMIN_ORIGIN : TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      authorization: `Bearer tok-${who.uid}`,
    });
    if (reply.status !== 200) return { reply, cookie: null, csrf: null };
    return { reply, cookie: (reply.headers['set-cookie'] ?? [''])[0].split('; ')[0], csrf: JSON.parse(reply.body).csrfToken };
  };
  /** The administrative surface as one session sees it. */
  const as = (session) => {
    const unsafe = {
      origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, [SESSION_CSRF_HEADER]: session.csrf,
      cookie: session.cookie, 'content-type': 'application/json',
    };
    return {
      list: (query = '', extra = {}) => send(port, 'GET', `${TENANT_DIRECTORY_PATH}${query}`, { cookie: session.cookie, ...extra }),
      current: () => send(port, 'GET', sessionPaths('admin').current, { cookie: session.cookie }),
      rename: (body, extra = {}, query = '') =>
        send(port, 'PATCH', `${TENANT_DISPLAY_NAME_PATH}${query}`, { ...unsafe, 'idempotency-key': randomUUID(), ...extra }, JSON.stringify(body)),
      status: (body, extra = {}, query = '') =>
        send(port, 'PATCH', `${TENANT_STATUS_PATH}${query}`, { ...unsafe, 'idempotency-key': randomUUID(), ...extra }, JSON.stringify(body)),
    };
  };
  /** An administrative login that must be admitted, and that session's surface. */
  const signIn = async (who) => {
    const session = await login(who);
    assert.equal(session.reply.status, 200, `admin login for ${who.uid}: ${session.reply.body}`);
    return { ...session, ...as(session) };
  };
  try {
    await fn({ port, login, signIn, as, logs, send: (method, path, headers, body) => send(port, method, path, headers, body) });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

/** The tenant's directory entry as `session` sees it, found by walking the pages; and the actions it is shown. */
async function listed(session, tenantId) {
  let query = '?limit=50';
  for (let guard = 0; guard < 200; guard++) {
    const reply = await session.list(query);
    assert.equal(reply.status, 200, reply.body);
    const body = JSON.parse(reply.body);
    const hit = body.tenants.find((t) => t.tenantId === tenantId);
    if (hit !== undefined) return { entry: hit, actions: body.actions };
    if (body.nextCursor === null) return { entry: null, actions: body.actions };
    query = `?limit=50&cursor=${body.nextCursor}`;
  }
  throw new Error('directory walk did not end');
}

// ---------------------------------------------------------------------------
// M5E-00: the composition itself
// ---------------------------------------------------------------------------

test('M5E-00: 001-014 applied, the production roots compose over them, and only the limiter keeps them from composing alone', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014'].map((v) => [v, false]));

  // The transaction root classified the configured endpoint before building its one client, and hands back the ports
  // the two boundaries are served with — never the kernel, a pool or the URL.
  assert.ok(classifiedEndpoint !== null && typeof classifiedEndpoint === 'object', 'the endpoint was classified first');
  assert.deepEqual(Object.keys(tx).sort(),
    ['close', 'idempotency', 'platformAdmission', 'routes', 'sessionStore', 'tenantAdmission', 'transactions']);
  assert.deepEqual(tx.routes.map((r) => `${r.method} ${r.path}`).sort(),
    [`GET ${TENANT_DIRECTORY_PATH}`, `PATCH ${TENANT_DISPLAY_NAME_PATH}`, `PATCH ${TENANT_STATUS_PATH}`]);

  // The session root over the durable adapters alone refuses for exactly one reason: no approved limiter. So the
  // limiter is the only slot this suite fills beyond the verifier; both administrative slots came from 013's port.
  const limits = testRequestLimits();
  assert.throws(
    () => assembleSessions({ origins: ORIGINS, verifier: VERIFIER, trustedProxies: [], keySecret: limits.keySecret, ...durable() }),
    (err) => err instanceof ProductionCompositionError && JSON.stringify(err.blockers) === JSON.stringify(['rate_limit_store_unavailable']),
  );
  assert.deepEqual(ADMISSION_REVALIDATE_MS, { tenant: 0, admin: 0 }, 'neither boundary keeps a revalidation window');
  assert.equal(await tx.platformAdmission.probe(signal()), true, 'readiness runs 013\'s read end to end');
});

// ---------------------------------------------------------------------------
// M5E-A: the normal administrator
// ---------------------------------------------------------------------------

test('M5E-A: a system_owner signs in, lists the directory, renames, suspends and reactivates — on one \'p1:\' session throughout', async () => {
  const admin = await actor('a-owner', [{ scope: 'platform', role: 'system_owner' }]);
  const tenant = await newTenant('a');
  await withRuntime(async ({ signIn }) => {
    const session = await signIn(admin);
    assert.equal(await sessionsOf(admin), 1, 'one durable administrative session row');
    const witness = await witnessOf(admin);
    assert.match(witness, /^p1:[A-Za-z0-9_-]{43}$/, 'bound to the platform admission witness');
    assert.equal((await session.current()).status, 200, 'the current-session read is admitted too');

    const { entry, actions } = await listed(session, tenant);
    assert.deepEqual(entry, { tenantId: tenant, displayName: `m5e-a-${SUFFIX}`, status: 'active', version: 1 });
    assert.deepEqual(actions, { editDisplayName: true, changeStatus: true }, 'Manage presents both commands');

    const renamed = await session.rename({ tenantId: tenant, displayName: `m5e-a-renamed-${SUFFIX}`, expectedVersion: 1 });
    assert.deepEqual([renamed.status, JSON.parse(renamed.body)], [200, { tenantId: tenant, displayName: `m5e-a-renamed-${SUFFIX}`, version: 2 }]);
    // The login's own provider authentication is the recent authentication the lifecycle command requires.
    const suspended = await session.status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 2 });
    assert.deepEqual([suspended.status, JSON.parse(suspended.body)], [200, { tenantId: tenant, status: 'suspended', version: 3 }]);
    const reactivated = await session.status({ tenantId: tenant, status: 'active', reason: REASON, expectedVersion: 3 });
    assert.deepEqual([reactivated.status, JSON.parse(reactivated.body)], [200, { tenantId: tenant, status: 'active', version: 4 }]);

    assert.deepEqual(await tenantRow(tenant), { display_name: `m5e-a-renamed-${SUFFIX}`, status: 'active', row_version: '4' });
    const audits = await owner`select actor_internal_user_id, scope_type, action_id, decision from audit_event
      where subject_tenant_id = ${tenant} order by occurred_at, request_id`;
    assert.deepEqual(audits.map((a) => [a.actor_internal_user_id, a.scope_type, a.decision]),
      [[admin.id, 'platform', 'allow'], [admin.id, 'platform', 'allow'], [admin.id, 'platform', 'allow']],
      'each command audited under the admitted actor, at platform scope');
    assert.equal((await effectsOn(owner, tenant)).events, 3, 'one event per command');
    // Commands on a tenant move nothing an administrative session is bound to.
    assert.equal(await witnessOf(admin), witness, 'the witness is unchanged by the administrator\'s own commands');
    assert.equal(await sessionsOf(admin), 1);
  });
});

// ---------------------------------------------------------------------------
// M5E-B: grant revocation
// ---------------------------------------------------------------------------

test('M5E-B1: a disabled grant refuses the next request and ends EVERY session the principal holds; restoring it revives none', async () => {
  const admin = await actor('b1-owner', [{ scope: 'platform', role: 'system_owner' }]);
  const grant = await grantOf(admin);
  await withRuntime(async ({ signIn, login, logs }) => {
    const first = await signIn(admin);
    const second = await signIn(admin); // a second device
    assert.equal(await sessionsOf(admin), 2);
    assert.equal((await first.list()).status, 200);

    await owner`update user_membership set status = 'suspended' where membership_id = ${grant}`;
    const refused = await first.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_admission_denied', 'the admission denied it: no platform grant remains');
    assert.equal(await sessionsOf(admin), 0, 'every administrative session the principal held ended, the idle second one too');
    assert.equal((await second.list()).status, 401);
    const blocked = await login(admin);
    generic(blocked.reply, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, blocked.reply), 'login_admission_denied');

    await owner`update user_membership set status = 'active' where membership_id = ${grant}`;
    const old = await first.list();
    generic(old, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, old), 'session_unknown', 'the ended session stays ended');
    const fresh = await signIn(admin);
    assert.equal((await fresh.list()).status, 200, 'a fresh login is admitted on the restored grant');
    assert.equal(await sessionsOf(admin), 1);
  });
});

test('M5E-B2: a grant DELETED and RE-INSERTED byte for byte, while the session is idle, ends that session on its next request', async () => {
  // The most natural way to "restore" a grant: put the exported row back. 007's answer is then IDENTICAL — same
  // membership id, role, scope and timestamps — so only 013's authority version tells the two standings apart.
  const admin = await actor('b2-owner', [{ scope: 'platform', role: 'system_owner' }]);
  const grant = await grantOf(admin);
  await withRuntime(async ({ signIn, logs }) => {
    const session = await signIn(admin);
    assert.equal((await session.list()).status, 200);
    const bound = await witnessOf(admin);
    const before = await admitted(admin);
    assert.equal(before.outcome, 'resolved');

    // The row as JSON text, so its timestamps keep their microseconds through the round trip.
    const exported = async () => (await owner`select pg_catalog.row_to_json(m)::text as row from user_membership m where membership_id = ${grant}`)[0]?.row;
    const row = await exported();
    await owner`delete from user_membership where membership_id = ${grant}`;
    assert.equal(await exported(), undefined, 'gone');
    await owner`insert into user_membership select * from pg_catalog.jsonb_populate_record(null::public.user_membership, ${row}::text::jsonb)`;
    assert.equal(await exported(), row, 'the grant is exactly the row it was, byte for byte');

    const after = await admitted(admin);
    assert.deepEqual(after.principal, before.principal, 'everything 007 derives is identical');
    assert.equal(BigInt(after.authorityVersion), BigInt(before.authorityVersion) + 2n, 'the authority version moved twice, never back');
    assert.equal(await sessionsOf(admin), 1, 'nothing ended the idle session while it made no request');
    assert.equal(await witnessOf(admin), bound);

    const refused = await session.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_version_mismatch', 'refused because the witness moved');
    assert.equal(await sessionsOf(admin), 0, 'and that session is removed');
    const fresh = await signIn(admin);
    assert.equal((await fresh.list()).status, 200);
    assert.notEqual(await witnessOf(admin), bound, 'the new session is bound to a witness the old one never held');
  });
});

test('M5E-B3: a grant disabled and re-enabled while the session is IDLE still ends that session — the witness never returns', async () => {
  const admin = await actor('b3-owner', [{ scope: 'platform', role: 'system_owner' }]);
  const grant = await grantOf(admin);
  await withRuntime(async ({ signIn, logs }) => {
    const session = await signIn(admin);
    assert.equal((await session.list()).status, 200);
    const before = await admitted(admin);

    await owner`update user_membership set status = 'suspended' where membership_id = ${grant}`;
    await owner`update user_membership set status = 'active' where membership_id = ${grant}`;
    const after = await admitted(admin);
    assert.deepEqual(after.principal, before.principal, 'the standing is exactly as it started');
    assert.equal(BigInt(after.authorityVersion), BigInt(before.authorityVersion) + 2n);
    assert.equal(await sessionsOf(admin), 1, 'the idle session was never touched');

    const refused = await session.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_version_mismatch');
    assert.equal(await sessionsOf(admin), 0);
    assert.equal((await (await signIn(admin)).list()).status, 200, 'a fresh login is admitted');
  });
});

// ---------------------------------------------------------------------------
// M5E-C: role change
// ---------------------------------------------------------------------------

test('M5E-C: a role change ends the session; the new role is authorized as itself; changing it back revives nothing', async () => {
  const admin = await actor('c-owner', [{ scope: 'platform', role: 'system_owner' }]);
  const grant = await grantOf(admin);
  const tenant = await newTenant('c');
  await withRuntime(async ({ signIn, logs }) => {
    const first = await signIn(admin);
    assert.equal((await first.list()).status, 200);

    await owner`update user_membership set role_id = 'billing_admin' where membership_id = ${grant}`;
    const refused = await first.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_version_mismatch', 'still admitted, but at another witness');
    assert.equal(await sessionsOf(admin), 0);

    const billing = await signIn(admin);
    const { entry, actions } = await listed(billing, tenant);
    assert.equal(entry.status, 'active');
    assert.deepEqual(actions, { editDisplayName: false, changeStatus: false }, 'View presents no command');
    generic(await billing.status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 }), 403, 'forbidden');
    generic(await billing.rename({ tenantId: tenant, displayName: 'Refused', expectedVersion: 1 }), 403, 'forbidden');
    assert.deepEqual(await tenantRow(tenant), { display_name: `m5e-c-${SUFFIX}`, status: 'active', row_version: '1' }, 'nothing moved');

    await owner`update user_membership set role_id = 'system_owner' where membership_id = ${grant}`;
    const demoted = await billing.list();
    generic(demoted, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, demoted), 'session_version_mismatch', 'the billing session ends on the change back');
    generic(await first.list(), 401, 'unauthenticated');
    assert.equal(await sessionsOf(admin), 0, 'neither session survives');

    const regained = await signIn(admin);
    const suspended = await regained.status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 });
    assert.deepEqual([suspended.status, JSON.parse(suspended.body)], [200, { tenantId: tenant, status: 'suspended', version: 2 }],
      'a new login regains Manage');
  });
});

test('M5E-C2: a role changed and changed back while the session is IDLE still ends that session', async () => {
  const admin = await actor('c2-owner', [{ scope: 'platform', role: 'system_owner' }]);
  const grant = await grantOf(admin);
  await withRuntime(async ({ signIn, logs }) => {
    const session = await signIn(admin);
    assert.equal((await session.list()).status, 200);
    const before = await admitted(admin);

    await owner`update user_membership set role_id = 'billing_admin' where membership_id = ${grant}`;
    await owner`update user_membership set role_id = 'system_owner' where membership_id = ${grant}`;
    const after = await admitted(admin);
    assert.deepEqual(after.principal, before.principal, 'the same grant, the same role, the same account');
    assert.equal(BigInt(after.authorityVersion), BigInt(before.authorityVersion) + 2n);

    const refused = await session.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_version_mismatch');
    assert.equal(await sessionsOf(admin), 0);
    assert.equal((await (await signIn(admin)).list()).status, 200);
  });
});

// ---------------------------------------------------------------------------
// M5E-D: the account and its security version
// ---------------------------------------------------------------------------

test('M5E-D1: an account made read_only is refused at once and ends every session; restoring it revives none', async () => {
  const admin = await actor('d1-owner', [{ scope: 'platform', role: 'system_owner' }]);
  await withRuntime(async ({ signIn, login, logs }) => {
    const session = await signIn(admin);
    assert.equal((await session.list()).status, 200);

    await owner`update app_user set status = 'read_only' where internal_user_id = ${admin.id}`;
    const refused = await session.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_admission_denied', 'a limited account holds no administrative session');
    assert.equal(await sessionsOf(admin), 0);
    const blocked = await login(admin);
    generic(blocked.reply, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, blocked.reply), 'login_admission_denied');

    await owner`update app_user set status = 'active' where internal_user_id = ${admin.id}`;
    generic(await session.list(), 401, 'unauthenticated');
    const fresh = await signIn(admin);
    assert.equal((await fresh.list()).status, 200);
  });
});

test('M5E-D2: an account change that leaves the principal admitted ends ONLY the session presented, as a version mismatch', async () => {
  const admin = await actor('d2-owner', [{ scope: 'platform', role: 'system_owner' }]);
  await withRuntime(async ({ signIn, logs }) => {
    const first = await signIn(admin);
    const second = await signIn(admin);
    assert.equal((await first.list()).status, 200);
    const before = { authority: await authorityOf(admin), security: await securityVersionOf(admin) };

    // A status round trip through another ELIGIBLE status: the account ends exactly as it started and is admitted
    // throughout, so the witness moves but nothing denies. 007 digests its updated_at, and 013's app_user trigger
    // moves the authority version once per write that changed the status.
    await owner`update app_user set status = 'trialing' where internal_user_id = ${admin.id}`;
    await owner`update app_user set status = 'active' where internal_user_id = ${admin.id}`;
    assert.equal(await authorityOf(admin), before.authority + 2n, 'the authority version moved once per status write');
    assert.notEqual(await securityVersionOf(admin), before.security, '007\'s security version moved too');

    const refused = await first.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_version_mismatch');
    assert.equal(await sessionsOf(admin), 1, 'only the presented session ended: the principal is still admitted');
    const fresh = await signIn(admin);
    assert.equal((await fresh.list()).status, 200, 'a fresh login is admitted at the new witness');
    const idle = await second.list();
    generic(idle, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, idle), 'session_version_mismatch', 'the other device\'s session ends when it is presented');
    assert.equal(await sessionsOf(admin), 1, 'the fresh session alone remains');
  });
});

test('M5E-D3: only an active or trialing account may sign in — overdue, pending_activation and suspended are refused', async () => {
  await withRuntime(async ({ login, signIn, logs }) => {
    for (const status of ['overdue', 'pending_activation', 'suspended']) {
      const who = await actor(`d3-${status}`, [{ scope: 'platform', role: 'system_owner' }], status);
      const refused = await login(who);
      generic(refused.reply, 401, 'unauthenticated');
      assert.equal(reasonOf(logs, refused.reply), 'login_admission_denied', status);
      assert.equal(await sessionsOf(who), 0, `${status}: nothing issued`);
    }
    const trialing = await actor('d3-trialing', [{ scope: 'platform', role: 'system_owner' }], 'trialing');
    assert.equal((await (await signIn(trialing)).list()).status, 200, 'trialing is eligible');
  });
});

test('M5E-D4: a provider reference repointed and restored while the session is IDLE still ends that session — 007 never sees it', async () => {
  // 007 digests the account and its links, never the anchor: a reference moved to another uid and back leaves its
  // security version exactly as it was. Only 013's platform_identity trigger records that, in between, the login's
  // reference named nobody — or, had the owner pointed another identity at it, someone else.
  const admin = await actor('d4-owner', [{ scope: 'platform', role: 'system_owner' }]);
  await withRuntime(async ({ signIn, logs }) => {
    const session = await signIn(admin);
    assert.equal((await session.list()).status, 200);
    const bound = await witnessOf(admin);
    const before = { authority: await authorityOf(admin), security: await securityVersionOf(admin), admitted: await admitted(admin) };

    await owner`update platform_identity set auth_provider_uid = ${`${admin.uid}-moved`} where internal_user_id = ${admin.id}`;
    await owner`update platform_identity set auth_provider_uid = ${admin.uid} where internal_user_id = ${admin.id}`;
    const [{ anchor }] = await owner`select auth_provider || ':' || auth_provider_uid as anchor from platform_identity where internal_user_id = ${admin.id}`;
    assert.equal(anchor, `firebase:${admin.uid}`, 'the anchor is the login\'s provider reference again');
    assert.equal(await securityVersionOf(admin), before.security, '007\'s security version did not move');
    assert.deepEqual((await admitted(admin)).principal, before.admitted.principal, 'everything 007 derives is identical');
    assert.equal(await authorityOf(admin), before.authority + 2n, 'the authority version moved once per repoint');
    assert.equal(await sessionsOf(admin), 1, 'the idle session was never touched');
    assert.equal(await witnessOf(admin), bound);

    const refused = await session.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_version_mismatch', 'still admitted, at a witness the session was never bound to');
    assert.equal(await sessionsOf(admin), 0, 'and that session is removed');
    const fresh = await signIn(admin);
    assert.equal((await fresh.list()).status, 200, 'a fresh login is admitted');
    assert.notEqual(await witnessOf(admin), bound);
  });
});

test('M5E-D5: an account suspended and restored in ONE replica-mode transaction, while the session is IDLE, still ends that session', async () => {
  // As a replica, 002's updated_at trigger does not fire, so the account row ends byte for byte as it started and
  // 007's digest cannot move. 013's triggers are enabled ALWAYS and record the round trip anyway. The owner must be
  // able to take the replica role; if it cannot, this proof is not made, and the test FAILS rather than skipping it.
  const admin = await actor('d5-owner', [{ scope: 'platform', role: 'system_owner' }]);
  const account = async () => (await owner`select pg_catalog.row_to_json(u)::text as row from app_user u where internal_user_id = ${admin.id}`)[0].row;
  await withRuntime(async ({ signIn, logs }) => {
    const session = await signIn(admin);
    assert.equal((await session.list()).status, 200);
    const bound = await witnessOf(admin);
    const before = { account: await account(), authority: await authorityOf(admin), security: await securityVersionOf(admin) };

    await owner.begin(async (sql) => {
      await sql`set local session_replication_role = replica`.catch((err) => {
        throw new Error(`M5E-D5 needs an owner that may set session_replication_role, and this one may not: ${err.message}`);
      });
      const [{ mode }] = await sql`select pg_catalog.current_setting('session_replication_role') as mode`;
      assert.equal(mode, 'replica', 'the round trip runs as a replica');
      await sql`update app_user set status = 'suspended' where internal_user_id = ${admin.id}`;
      await sql`update app_user set status = 'active' where internal_user_id = ${admin.id}`;
    });
    assert.equal(await account(), before.account, 'the account row is exactly as it was, updated_at included');
    assert.equal(await securityVersionOf(admin), before.security, '007\'s security version did not move');
    assert.equal(await authorityOf(admin), before.authority + 2n, 'the authority version moved once per status write');
    assert.equal(await sessionsOf(admin), 1, 'the idle session was never touched');
    assert.equal(await witnessOf(admin), bound);

    const refused = await session.list();
    generic(refused, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused), 'session_version_mismatch', 'still admitted, at a witness the session was never bound to');
    assert.equal(await sessionsOf(admin), 0, 'and that session is removed');
    const fresh = await signIn(admin);
    assert.equal((await fresh.list()).status, 200, 'a fresh login is admitted');
    assert.notEqual(await witnessOf(admin), bound);
  });
});

// ---------------------------------------------------------------------------
// M5E-E: plane isolation — nothing but one platform grant confers platform authority
// ---------------------------------------------------------------------------

test('M5E-E: tenant and store grants, a planted tenant-scope system_owner, two grants and client hints confer nothing', async () => {
  const home = await newTenant('e-home');
  const [{ store_id: store }] = await owner`insert into store (tenant_id, store_name) values (${home}, ${`m5e-e-${SUFFIX}`}) returning store_id`;
  const tenantOnly = await actor('e-tenant-only', [
    { scope: 'tenant', tenant: home, role: 'store_owner' }, { scope: 'store', tenant: home, store, role: 'manager' },
  ]);
  const twoGrants = await actor('e-two-grants', [{ scope: 'platform', role: 'system_owner' }, { scope: 'platform', role: 'support_admin' }]);
  const billing = await actor('e-billing', [{ scope: 'platform', role: 'billing_admin' }]);
  const planted = await actor('e-planted', []);
  const target = await newTenant('e-target');

  await withRuntime(async ({ login, signIn, logs, send: request }) => {
    // 1. Tenant and store grants: no administrative session, and no way to the directory.
    const refused = await login(tenantOnly);
    generic(refused.reply, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, refused.reply), 'login_admission_denied');
    generic(await request('GET', TENANT_DIRECTORY_PATH), 401, 'unauthenticated');
    // The same actor's TENANT session is real — and is no administrative session, under either cookie name.
    const tenantSession = await login(tenantOnly, 'tenant');
    assert.equal(tenantSession.reply.status, 200, 'the tenant boundary admits the tenant grant');
    const asTenantCookie = await request('GET', TENANT_DIRECTORY_PATH, { cookie: tenantSession.cookie });
    generic(asTenantCookie, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, asTenantCookie), 'session_missing', 'the admin boundary never reads the tenant cookie');
    const renamed = `${SESSION_COOKIES.admin}=${tenantSession.cookie.split('=')[1]}`;
    const asAdminCookie = await request('GET', TENANT_DIRECTORY_PATH, { cookie: renamed });
    generic(asAdminCookie, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, asAdminCookie), 'session_wrong_audience', 'a tenant session id under the admin name is refused');
    assert.equal(await sessionsOf(tenantOnly, 'tenant'), 1, 'and the tenant session itself is untouched');

    // 2. A tenant-scope grant carrying the platform role id 'system_owner'. 003's constraint forbids it, so it is
    // dropped to plant the row and restored exactly as it was.
    const [{ def }] = await owner`select pg_catalog.pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint
      where conrelid = 'public.user_membership'::regclass and conname = 'user_membership_role_scope_chk'`;
    await owner.unsafe('alter table public.user_membership drop constraint user_membership_role_scope_chk');
    try {
      await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
        values (${planted.id}, ${home}, null, 'tenant', 'system_owner', 'active')`;
      const answer = await admitted(planted);
      assert.equal(answer.outcome, 'resolved');
      assert.deepEqual(answer.principal.memberships, [], 'a tenant-scope grant is never a platform grant, whatever its role id');
      const planting = await login(planted);
      generic(planting.reply, 401, 'unauthenticated');
      assert.equal(reasonOf(logs, planting.reply), 'login_admission_denied');
    } finally {
      await owner`delete from user_membership where internal_user_id = ${planted.id}`;
      await owner.unsafe(`alter table public.user_membership add constraint user_membership_role_scope_chk ${def}`);
    }
    const [{ restored }] = await owner`select pg_catalog.pg_get_constraintdef(oid) as restored from pg_catalog.pg_constraint
      where conrelid = 'public.user_membership'::regclass and conname = 'user_membership_role_scope_chk'`;
    assert.equal(restored, def, 'the constraint is back exactly as it was');

    // 3. Two platform grants are ambiguous: there is no first match.
    const ambiguous = await login(twoGrants);
    generic(ambiguous.reply, 401, 'unauthenticated');
    assert.equal(reasonOf(logs, ambiguous.reply), 'login_admission_denied');

    // 4. A billing_admin (View) sending every hint a client could: nothing it carries is authority.
    const snapshot = async () => ({ ...(await owner`select
        (select row_version from public.tenant where tenant_id = ${target})::text as version,
        (select status from public.tenant where tenant_id = ${target}) as status,
        (select count(*)::int from public.audit_event) as audits,
        (select count(*)::int from tmpos_internal.outbox_event) as events,
        (select count(*)::int from tmpos_internal.idempotency_record) as records`)[0] });
    const session = await signIn(billing);
    const before = await snapshot();
    const hints = {
      'x-tmpos-role': 'system_owner', 'x-tmpos-permissions': 'change_tenant_status,edit_tenant_profile',
      'x-tmpos-actor': twoGrants.id, 'x-tmpos-scope': 'platform',
    };
    const extra = { role: 'system_owner', permissions: ['change_tenant_status'], actor: twoGrants.id, scope: 'platform' };
    const suspend = await session.status({ tenantId: target, status: 'suspended', reason: REASON, expectedVersion: 1, ...extra }, hints, '?role=system_owner');
    generic(suspend, 403, 'forbidden');
    const rename = await session.rename({ tenantId: target, displayName: 'Hinted', expectedVersion: 1, ...extra }, hints, '?role=system_owner');
    generic(rename, 403, 'forbidden');
    const plain = await session.status({ tenantId: target, status: 'suspended', reason: REASON, expectedVersion: 1 });
    generic(plain, 403, 'forbidden');
    generic(await session.list('?role=system_owner'), 400, 'invalid_request');
    const hinted = await session.list('?limit=50', hints);
    assert.equal(hinted.status, 200);
    assert.deepEqual(JSON.parse(hinted.body).actions, { editDisplayName: false, changeStatus: false }, 'headers raise nothing');
    assert.deepEqual(await snapshot(), before, 'no tenant, audit record, event or idempotency record moved');
  });
});

// ---------------------------------------------------------------------------
// M5E-F: an admission the database cannot answer
// ---------------------------------------------------------------------------

test('M5E-F: an unanswerable admission is a bounded 503 that revokes nothing and fails readiness; restored, the SAME cookie is served', async () => {
  const admin = await actor('f-owner', [{ scope: 'platform', role: 'system_owner' }]);
  await withRuntime(async ({ signIn, logs, send: request }) => {
    const session = await signIn(admin);
    assert.equal((await session.list()).status, 200);
    assert.equal((await request('GET', '/readiness')).status, 200, 'ready before');

    await owner.unsafe(`revoke execute on function ${ADMIT_READ} from tmpos_app`);
    try {
      const reply = await session.list();
      generic(reply, 503, 'service_unavailable');
      assert.equal(reasonOf(logs, reply), 'admission_unavailable');
      const { requestId } = JSON.parse(reply.body);
      const text = reply.body.replace(requestId, '');
      assert.doesNotMatch(text, /permission|denied|42501|tmpos|admission|function|execute|firebase|m5e|system_owner|sql/i,
        'no driver, routine, role, reference or reason text');
      assert.equal(await sessionsOf(admin), 1, 'an outage is no verdict: the session row is still there');
      generic(await session.current(), 503, 'service_unavailable');
      // Readiness reuses a probe answer for a second; after that it asks 013's read again.
      await delay(PROBE_REUSE_WAIT_MS);
      assert.equal((await request('GET', '/readiness')).status, 503, 'not ready while the admission cannot answer');
      assert.equal((await request('GET', '/health')).status, 200, 'but alive');
    } finally {
      await owner.unsafe(`grant execute on function ${ADMIT_READ} to tmpos_app`);
    }
    const served = await session.list();
    assert.equal(served.status, 200, `the same cookie is served again: ${served.body}`);
    await delay(PROBE_REUSE_WAIT_MS);
    assert.equal((await request('GET', '/readiness')).status, 200, 'ready again');
  });
});

// ---------------------------------------------------------------------------
// M5E-G: a revocation racing live requests
// ---------------------------------------------------------------------------

test('M5E-G: a revocation racing live requests — everything sent after its commit is refused, and nothing commits on the old authority', async (t) => {
  const racer = await actor('g-racer', [{ scope: 'platform', role: 'system_owner' }]);
  const grant = await grantOf(racer);
  const tenant = await newTenant('g');
  await withRuntime(async ({ signIn, logs }) => {
    const session = await signIn(racer);
    assert.equal((await session.list('?limit=5')).status, 200, 'served before the race');

    const results = [];
    const inflight = [];
    let commitAt = null;
    let atRevocation = null;
    let sentAfter = 0;
    // The revocation waits for one command to be SERVED, so the proof below is never about a race nothing entered.
    let firstCommit;
    const committed = new Promise((resolve) => { firstCommit = resolve; });
    const record = (kind, sentAt, reply) => {
      results.push({ kind, sentAt, status: reply.status, reason: reasonOf(logs, reply), body: reply.body });
      if (kind === 'patch' && reply.status === 200) firstCommit();
    };
    const fireGet = () => {
      const sentAt = performance.now();
      if (commitAt !== null) sentAfter += 1;
      inflight.push(session.list('?limit=5').then((reply) => record('get', sentAt, reply)));
    };
    const firePatch = () => inflight.push((async () => {
      const row = await tenantRow(tenant);
      const body = { tenantId: tenant, status: row.status === 'active' ? 'suspended' : 'active', reason: REASON, expectedVersion: Number(row.row_version) };
      const sentAt = performance.now();
      if (commitAt !== null) sentAfter += 1;
      record('patch', sentAt, await session.status(body));
    })());
    // The revocation: its UPDATE takes the grant's row lock — waiting for any command whose in-transaction
    // revalidation (009) already holds it FOR SHARE, i.e. for every command that can still commit on this grant —
    // and the effects read right after it, on the same transaction, therefore include every command that will ever
    // commit on the old authority. It is held open briefly so commands pile up behind the lock.
    const revocation = (async () => {
      await Promise.race([committed, delay(10_000, undefined, { ref: false })]);
      await owner.begin(async (sql) => {
        await sql`update user_membership set status = 'suspended' where membership_id = ${grant}`;
        atRevocation = await effectsOn(sql, tenant);
        await delay(40);
      });
      commitAt = performance.now();
    })();
    for (let tick = 0; tick < 500 && sentAfter < 8; tick++) {
      fireGet();
      if (tick % 2 === 0) firePatch(); else fireGet();
      await delay(15);
    }
    await revocation;
    await Promise.all(inflight);

    assert.ok(commitAt !== null && atRevocation !== null);
    const after = results.filter((r) => r.sentAt > commitAt);
    const before = results.filter((r) => r.sentAt <= commitAt);
    assert.ok(after.length >= 8, `requests were sent after the commit: ${after.length}`);
    // EVERY request sent after the revocation committed is refused as unauthenticated — never served, never 403 on a
    // stale scope — whichever path refused it: the admission denial, or the session it had already ended.
    for (const r of after) {
      assert.equal(r.status, 401, `${r.kind} sent after the commit: ${r.status} ${r.reason}`);
      assert.ok(['session_admission_denied', 'session_unknown'].includes(r.reason), r.reason);
    }
    // Requests sent before it are served in full or refused in full, each for a named reason.
    const allowed = new Set([
      'get 200 -', 'get 401 session_admission_denied', 'get 401 session_unknown', 'get 403 tenant_directory_denied',
      'patch 200 -', 'patch 401 session_admission_denied', 'patch 401 session_unknown', 'patch 409 transaction_conflict',
      'patch 503 transaction_unavailable',
    ]);
    for (const r of before) assert.ok(allowed.has(`${r.kind} ${r.status} ${r.reason ?? '-'}`), `${r.kind} ${r.status} ${r.reason} ${r.body}`);
    assert.ok(before.some((r) => r.kind === 'get' && r.status === 200), 'the race began on a served session');
    assert.ok(results.some((r) => r.reason === 'session_admission_denied'), 'the admission denial is what ended it');

    // Nothing committed after the revocation took its lock, so nothing after its commit: the tenant, its audit
    // records and its events are exactly what they were inside the revoking transaction — and every committed change
    // was answered 200, one audit record and one event each.
    const final = await effectsOn(owner, tenant);
    assert.deepEqual(final, atRevocation, 'no command committed on the revoked authority');
    const served = results.filter((r) => r.kind === 'patch' && r.status === 200).length;
    assert.ok(served >= 1, 'a command was served on the old authority before the revocation');
    assert.deepEqual([final.audits, final.events, Number(final.version) - 1], [served, served, served]);
    const tally = (rows) => [...rows.reduce((m, r) => m.set(`${r.kind} ${r.status}`, (m.get(`${r.kind} ${r.status}`) ?? 0) + 1), new Map())]
      .map(([k, n]) => `${k} x${n}`).sort().join(', ');
    t.diagnostic(`sent before the commit: ${tally(before)}; sent after: ${tally(after)}`);

    assert.equal(await sessionsOf(racer), 0, 'the session ends revoked');
    generic(await session.list(), 401, 'unauthenticated');
  });
});

// ---------------------------------------------------------------------------
// M5E-Z: shutdown
// ---------------------------------------------------------------------------

test('M5E-Z: the transaction root\'s close ends the kernel within its bounded grace', async () => {
  const bound = (RETIRED_POOL_GRACE_S + 5) * 1_000;
  const started = Date.now();
  let timer;
  const outcome = await Promise.race([
    tx.close().then(() => 'closed'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('overran'), bound); }),
  ]);
  clearTimeout(timer);
  closed = outcome === 'closed';
  assert.equal(outcome, 'closed', `close resolved within ${bound} ms`);
  assert.ok(Date.now() - started < bound);
});
