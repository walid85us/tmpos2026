// Phase 4.0 M5-GIAM-D1-P2-R1 — EFFECTIVE TENANT REVOCATION, against REAL PostgreSQL over REAL sockets.
//
// This is the suite the stage exists for. Everything below runs over the COMPOSED production path:
// migration 011's session table and admission read, the real PostgreSQL session store, the real
// PostgreSQL tenant admission, the real tenant session boundary and route authorizer, and the one
// lifecycle decision — reached through a local HTTP socket.
//
// WHAT IS NOT REAL HERE, STATED EXACTLY. Three things, none of them on the path under test.
//   * THE ROUTE. There is no shipped tenant business route — every tenant-scope permission is
//     undecidable until owner decision D1 — so the protected request is a witness route declared in
//     the harness beside this file (tenantAdmissionWitness.harness.mjs) and injected here.
//   * THE IDENTITY VERIFIER. A disposable cluster has no identity provider, so a bearer token is
//     mapped to a synthetic provider reference. Everything AFTER that point — admission, the session
//     record, revalidation, authorization and the lifecycle decision — is the composed production
//     path, and it is what every assertion below judges.
//   * THE ADMIN BOUNDARY'S SESSION STORE. Since M5-GIAM-D1-P4 the admin boundary carries the durable
//     pair — migration 013's admission and the authorizer deciding on the scope it selected — but keeps
//     the in-memory store, because the admin plane is not what this suite proves. It appears in one
//     test (M5A-07), to observe that the PLATFORM plane is untouched while a tenant is suspended.
//
// WHAT IS PROVED HERE. A suspension takes effect on the very next protected request, with no grace
// window, and ends the session rather than merely refusing it; a reactivation does NOT revive the
// session it ended, because the tenant's access version never returns to a value it has held; a store
// session is denied by its PARENT tenant's suspension; a display-name edit moves the row version and
// ends nothing; the platform boundary is untouched throughout; and a suspension racing live requests
// leaves every answer either served or refused, never half-applied. Around that path: 011's own
// postcondition refuses to finish over a widened privilege, a role membership or FORCEd row security;
// its admission read RAISES — never refuses — when it cannot read a tenant's access version; session
// creation prunes a returning principal's rows only once they are a day expired; and the store-lifecycle
// gap (doc 08 DA-41) is shown as it is, an idle store session served again after a reactivation.
//
// DISPOSABLE ONLY. The target is TM_POS_TEST_DATABASE_URL when CI binds one, otherwise a cluster this
// file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs.
// Fixtures are synthetic and randomly named. The rollback proof runs inside two transactions, each
// rolled back, so a shared database keeps its state.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import { STORE_WITNESS_PATH, WITNESS_PATH, WITNESS_READS, WITNESS_ROUTES } from './tenantAdmissionWitness.harness.mjs';
import {
  assertDisposableTestDsn,
  createPostgresExecutor,
  runTrustedApply,
} from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresSessionStore } from '../../server/persistence/postgresSessionStore.ts';
import { createPostgresTenantAdmission } from '../../server/persistence/postgresTenantAdmission.ts';
import { createPostgresPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';
import { createTenantRouteAuthorizer, createTenantSessionAdmission } from '../../server/composition/tenantAuthorization.ts';
import { createAdmittedPlatformAuthorizer, createPlatformSessionAdmission } from '../../server/composition/platformAuthorization.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { ADMISSION_REVALIDATE_MS } from '../../server/runtime/sessions.ts';
import { assertSessionStoreContract, SESSION_CONTRACT_EPOCH, createMemorySessionStore } from '../../server/runtime/memorySessionStore.testkit.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { testRequestLimits } from '../../server/runtime/rateLimiter.testkit.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_011 = readFileSync(`${MIG_DIR}/011_m5_tenant_admission.up.sql`, 'utf8');
const DOWN_011 = readFileSync(`${MIG_DIR}/011_m5_tenant_admission.down.sql`, 'utf8');

const MIGRATOR = { purpose: 'migration', migratorRef: 'm5a-migrator', runtimeRef: 'm5a-runtime' };
const LOCK_KEY = 528_511;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m5a_probe';
const TENANT_ORIGIN = 'http://pos.trusted.test';
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const signal = () => AbortSignal.timeout(10_000);

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
    'M5A INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
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
const connect = (user, max) =>
  postgres(driverDsn(TARGET_DSN, user), { ...CLIENT_OPTS, ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, writes the fixtures and observes. RLS does not restrict it. */
const owner = connect(undefined, 3);
let runtime = null;
let client = null;

test.after(async () => {
  if (client) await client.end();
  if (runtime) await runtime.end({ timeout: 5 });
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: real migrations 001-013, a real non-owner runtime login, real adapters
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
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL),
      adapter: handle.adapter,
      ledger: handle.ledger,
      connectionMode: 'session',
      credential: MIGRATOR,
      lockKey: LOCK_KEY,
      now: NOW,
      deadlineMs: 180_000,
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
client = createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN),
  ssl: false,
  max: 8,
  idle_timeout: 0,
  ...CLIENT_OPTS,
  user: RUNTIME_LOGIN,
});

/** The real adapters, over that one client — exactly what productionTransactions.ts builds. */
const sessionStore = createPostgresSessionStore({ client });
const tenantAdmission = createPostgresTenantAdmission({ client });

/** A counting relay over the REAL admission: it delegates every call and adds nothing. */
function counted(port) {
  const relay = {
    calls: 0,
    admit(principal, sig) { relay.calls += 1; return port.admit(principal, sig); },
    probe(sig) { return port.probe(sig); },
  };
  return relay;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') =>
  (await owner`insert into tenant (display_name, status) values (${`m5a-${label}-${SUFFIX}`}, ${status}) returning tenant_id`)[0].tenant_id;
const newStore = async (tenant, label, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`m5a-${label}-${SUFFIX}`}, ${status}) returning store_id`)[0].store_id;

/** A synthetic actor: an identity, an active account and one active membership. */
async function actor(label, membership) {
  const uid = `m5a-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${id}, ${membership.tenant ?? null}, ${membership.store ?? null}, ${membership.scope}, ${membership.role}, 'active')`;
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}

const TENANT_A = await newTenant('tenant-a');
const TENANT_B = await newTenant('tenant-b');
const STORE_B = await newStore(TENANT_B, 'store-b');
const TENANT_ACTOR = await actor('tenant-actor', { scope: 'tenant', tenant: TENANT_A, role: 'store_owner' });
const STORE_ACTOR = await actor('store-actor', { scope: 'store', tenant: TENANT_B, store: STORE_B, role: 'manager' });
const PLATFORM_ACTOR = await actor('platform-actor', { scope: 'platform', role: 'system_owner' });

const tenantRow = async (id) => (await owner`select display_name, status, row_version, access_version from tenant where tenant_id = ${id}`)[0];
/** 010's fixed status operation, called as the runtime calls it — the only sanctioned path. */
const setStatus = async (tenant, from, to) => {
  const { row_version: version } = await tenantRow(tenant);
  const [answer] = await runtime`select o_outcome, o_version
    from tmpos_command.m5_tenant_status_change(${tenant}::uuid, ${version}::bigint, ${from}::text, ${to}::text)`;
  assert.equal(answer.o_outcome, 'applied', `${from} -> ${to}`);
  return answer.o_version;
};
const suspend = (tenant) => setStatus(tenant, 'active', 'suspended');
const reactivate = (tenant) => setStatus(tenant, 'suspended', 'active');
/** How many session rows this principal holds, read as the OWNER — the runtime role cannot. */
const sessionsOf = async (who) =>
  Number((await owner`select count(*)::int as n from tmpos_session.session where auth_provider_uid = ${who.uid}`)[0].n);
/**
 * The WITNESS the principal's live session is bound to: the admission answer, as the boundary stored
 * it. This is the value revalidation compares on every request — not the principal's own security
 * version, which 007 derives from the account alone and which no tenant lifecycle change moves.
 */
const witnessOf = async (who) => {
  const rows = await owner`select security_version from tmpos_session.session
    where auth_provider_uid = ${who.uid} order by created_at desc, session_key limit 1`;
  assert.equal(rows.length, 1, `${who.uid} holds a session`);
  return rows[0].security_version;
};
/** Every witness this principal's live sessions are bound to, in a stable order. */
const witnessesOf = async (who) => (await owner`select security_version from tmpos_session.session
  where auth_provider_uid = ${who.uid} order by session_key`).map((r) => r.security_version);
/** The refusal codes the runtime logged, in order — the mechanism behind a bare 401. */
const reasonsIn = (logs) => logs
  .map((line) => { try { return JSON.parse(line); } catch { return {}; } })
  .filter((r) => r.event === 'request' && typeof r.reason === 'string')
  .map((r) => r.reason);

// ---------------------------------------------------------------------------
// the real runtime, over a real local socket
// ---------------------------------------------------------------------------

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

/**
 * One runtime instance with the witness routes, the REAL tenant boundary (PostgreSQL store,
 * PostgreSQL admission, the tenant authorizer) and, on the admin boundary, the REAL durable pair
 * (M5-GIAM-D1-P4: migration 013's platform admission and the authorizer deciding on the scope it
 * selected) over the in-memory store — never on the tenant path anything below proves.
 */
async function withRuntime(fn, over = {}) {
  const uids = new Map([TENANT_ACTOR, STORE_ACTOR, PLATFORM_ACTOR, ...(over.actors ?? [])].map((who) => [`tok-${who.uid}`, who.uid]));
  uids.set('tok-unknown', `m5a-unknown-${SUFFIX}`);
  // Each port may be relayed separately, so a read can be attributed to the boundary or the authorizer.
  const admission = over.admission ?? tenantAdmission;
  const authorizerAdmission = over.authorizerAdmission ?? admission;
  const readiness = createReadinessState();
  readiness.setReady();
  const logs = [];
  const verifier = {
    async verify(view) {
      const uid = uids.get(view.bearerToken);
      return uid === undefined ? null : { verified: true, authProvider: 'firebase', authProviderUid: uid, authenticatedAt: Date.now(), secondFactor: 'totp' };
    },
  };
  const app = createApp({
    readiness,
    log: { log: (line) => { logs.push(line); } },
    routes: WITNESS_ROUTES,
    limits: testRequestLimits(),
    dependencyChecks: [(s) => tenantAdmission.probe(s)],
    sessions: {
      tenant: {
        trustedOrigins: [TENANT_ORIGIN],
        verifier,
        admission: createTenantSessionAdmission({ admission }),
        authorizer: createTenantRouteAuthorizer({ admission: authorizerAdmission, reads: over.reads ?? WITNESS_READS }),
        store: sessionStore,
      },
      admin: {
        trustedOrigins: [ADMIN_ORIGIN],
        verifier,
        // The PLATFORM plane, observed while a tenant is suspended (M5A-07). Nothing below reads it as
        // evidence about the tenant boundary.
        admission: createPlatformSessionAdmission({ admission: createPostgresPlatformAdmission({ client }) }),
        authorizer: createAdmittedPlatformAuthorizer(),
        store: createMemorySessionStore(),
      },
    },
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  /** A login on `audience`, answering the cookie and CSRF token, or the refusal's status. */
  const login = async (who, audience = 'tenant') => {
    const origin = audience === 'tenant' ? TENANT_ORIGIN : ADMIN_ORIGIN;
    const reply = await send(port, 'POST', sessionPaths(audience).login, {
      origin, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      authorization: `Bearer ${who === null ? 'tok-unknown' : `tok-${who.uid}`}`, 'content-length': '0',
    });
    if (reply.status !== 200) return { status: reply.status, cookie: null, csrf: null };
    return {
      status: 200,
      cookie: (reply.headers['set-cookie'] ?? [''])[0].split('; ')[0],
      csrf: JSON.parse(reply.body).csrfToken,
    };
  };
  const witness = (session, path = WITNESS_PATH) =>
    send(port, 'GET', path, { cookie: session.cookie, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin' });

  try {
    await fn({ port, login, witness, logs, send: (method, path, headers) => send(port, method, path, headers) });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const bodyOf = (reply) => (reply.body === '' ? null : JSON.parse(reply.body));

// ---------------------------------------------------------------------------
// M5A-01..03: the composition itself
// ---------------------------------------------------------------------------

test('M5A-01: migrations 001-013 applied, and the runtime role reaches the session table only through 011\'s routines', async () => {
  // The LEDGER, not this run's report: on the shared CI service an earlier suite has already applied
  // 001-013, so this run applies nothing and its report lists no version.
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013'].map((v) => [v, false]));

  // The privilege containment migration 011 section 6 asserts, observed from the runtime role itself.
  for (const statement of ['select count(*) from tmpos_session.session',
    "insert into tmpos_session.session (session_key) values ('x')",
    'update tmpos_session.session set last_seen_at = 0',
    'delete from tmpos_session.session']) {
    const code = await runtime.unsafe(statement).then(() => null, (err) => err.code);
    assert.equal(code, '42501', `the runtime role is refused: ${statement}`);
  }
  // A null field name is refused as invalid before any row is looked at: `null not in (...)` is NULL,
  // so without its explicit check the touch would match the row, change nothing and answer 'updated'.
  const [{ touched }] = await runtime`select tmpos_session.m5_session_touch(${`m5a-absent-${SUFFIX}`}::text, null::text, 1::bigint) as touched`;
  assert.equal(touched, 'invalid');
  // And the routines it MAY call are exactly six.
  const routines = await owner`select proname::text as name from pg_catalog.pg_proc
    where pronamespace = 'tmpos_session'::regnamespace order by proname`;
  assert.deepEqual(routines.map((r) => r.name), ['m5_admit_tenant_session', 'm5_session_create', 'm5_session_get',
    'm5_session_revoke', 'm5_session_revoke_principal', 'm5_session_touch'], 'five session operations and one admission read');
});

test('M5A-02: the production session store satisfies the port\'s own conformance contract against real PostgreSQL', async () => {
  // The contract stamps its records at a fixed instant, so the store is built over that same clock.
  // Its fixtures are opaque and carry the provider 'synthetic', so both cleanups name exactly those
  // rows: on a shared CI database this suite must not remove another suite's sessions.
  const clearFixtures = () => owner`delete from tmpos_session.session where auth_provider = 'synthetic'`;
  await clearFixtures();
  try {
    await assertSessionStoreContract(createPostgresSessionStore({ client, now: () => SESSION_CONTRACT_EPOCH }));
  } finally {
    await clearFixtures();
  }
});

test('M5A-02b: creating a session prunes the SAME principal\'s rows in the SAME audience only once they are a day expired', async () => {
  // The instant is the CALLER's, and instances sharing the store need not agree on the time, so the
  // prune keeps a day's grace: a login from an instance whose clock runs ahead must not delete sessions
  // that still have time left elsewhere. The boundary row is exactly a day expired and goes; one
  // millisecond younger stays; another principal's and another audience's rows are never touched.
  const DAY = 86_400_000;
  const T = SESSION_CONTRACT_EPOCH + 10 * DAY;
  const key = (label) => `m5a-prune-${label}-${SUFFIX}`;
  const make = (tx, label, audience, principalKey, createdAt, expiresAt) => tx`
    select tmpos_session.m5_session_create(${key(label)}::text, ${audience}::text, 'firebase'::text,
      ${`m5a-prune-${SUFFIX}`}::text, ${principalKey}::text, 't1:prune'::text,
      ${createdAt}::bigint, ${createdAt}::bigint, ${createdAt}::bigint, ${createdAt}::bigint, ${expiresAt}::bigint) as created`;
  await owner.begin(async (tx) => {
    const mine = `pk-prune-${SUFFIX}`;
    await make(tx, 'edge', 'tenant', mine, T - 2 * DAY, T - DAY);
    await make(tx, 'near', 'tenant', mine, T - 2 * DAY, T - DAY + 1);
    await make(tx, 'other-audience', 'admin', mine, T - 3 * DAY, T - 2 * DAY);
    await make(tx, 'other-principal', 'tenant', `pk-prune-other-${SUFFIX}`, T - 3 * DAY, T - 2 * DAY);
    const [{ created }] = await make(tx, 'new', 'tenant', mine, T, T + 3_600_000);
    assert.equal(created, 'created');
    const left = (await tx`select session_key from tmpos_session.session
      where session_key like ${`m5a-prune-%-${SUFFIX}`} order by session_key`).map((r) => r.session_key);
    assert.deepEqual(left, [key('near'), key('new'), key('other-audience'), key('other-principal')],
      'exactly the row a full day expired is gone');
    throw new Error('m5a-prune-probe');
  }).catch((err) => { if (!/m5a-prune-probe/.test(String(err.message))) throw err; });
});

test('M5A-03: readiness runs the admission routine end to end, and the witness it derives is a bounded version', async () => {
  assert.equal(await tenantAdmission.probe(signal()), true);
  const answer = await tenantAdmission.admit(TENANT_ACTOR.principal, signal());
  assert.equal(answer.outcome, 'admitted');
  assert.match(answer.securityVersion, /^t1:[A-Za-z0-9_-]{1,120}$/);
  assert.deepEqual(answer.principal.memberships.map((m) => [m.scopeType, m.tenant, m.tenantStatus]),
    [['tenant', TENANT_A, 'active']]);
  // An actor with no tenant or store grant may hold no tenant session at all.
  assert.deepEqual(await tenantAdmission.admit(PLATFORM_ACTOR.principal, signal()), { outcome: 'refused' });
  assert.deepEqual(await tenantAdmission.admit({ authProvider: 'firebase', authProviderUid: `m5a-nobody-${SUFFIX}` }, signal()),
    { outcome: 'refused' });
});

test('M5A-03b: an actor holding several grants is digested in ONE stable order, so an unchanged standing ends no session', async () => {
  // Migration 011 orders the grants by membership id AS A UUID before the caller digests them. If that
  // order were unstable — or collation-dependent, which ordering the id as TEXT would make it — the
  // witness would move between two reads of an unchanged standing and sign the actor out for nothing.
  // One grant cannot show this; several can.
  const many = await actor('many-grants', { scope: 'tenant', tenant: TENANT_A, role: 'store_owner' });
  for (const tenant of [TENANT_B, await newTenant('tenant-c'), await newTenant('tenant-d')]) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${many.id}, ${tenant}, null, 'tenant', 'manager', 'active')`;
  }
  const first = await tenantAdmission.admit(many.principal, signal());
  assert.equal(first.outcome, 'admitted');
  assert.equal(first.principal.memberships.length, 4, 'four grants');
  const ids = first.principal.memberships.map((m) => m.membershipId);
  assert.deepEqual(ids, [...ids].sort(), 'answered in membership-id order');
  for (let i = 0; i < 3; i += 1) {
    const again = await tenantAdmission.admit(many.principal, signal());
    assert.equal(again.securityVersion, first.securityVersion, 'an unchanged standing digests unchanged, every time');
  }
});

// ---------------------------------------------------------------------------
// M5A-04: THE TEN-STEP PROOF — suspend, then reactivate, over real sockets
// ---------------------------------------------------------------------------

test('M5A-04: a suspension takes effect on the next protected request, ends the session, and a reactivation does not revive it', async () => {
  await withRuntime(async ({ login, witness, logs }) => {
    // 1. the tenant actor signs in over the real boundary
    const first = await login(TENANT_ACTOR);
    assert.equal(first.status, 200, 'login is admitted while the tenant is active');
    assert.equal(await sessionsOf(TENANT_ACTOR), 1, 'and a durable session row exists');

    // 2. a protected tenant request is served, and carries the scope the authorizer decided
    const served = await witness(first);
    assert.equal(served.status, 200, served.body);
    // `securityVersion` here is the PRINCIPAL's (007: the account, its status and its limitation) —
    // the one the trusted scope carries. The tenant witness is a different value, held by the session.
    const principalVersion = bodyOf(served).securityVersion;
    assert.deepEqual(bodyOf(served), {
      actor: TENANT_ACTOR.id, tenant: TENANT_A, store: null, roleId: 'store_owner', limitation: 'none',
      securityVersion: principalVersion,
    });
    const witnessBefore = await witnessOf(TENANT_ACTOR);
    assert.match(witnessBefore, /^t1:/, 'the session is bound to the admission witness');

    // 3. the tenant is suspended through the server-authorized command
    const versionAtStart = Number((await tenantRow(TENANT_A)).access_version);
    await suspend(TENANT_A);
    const suspended = await tenantRow(TENANT_A);
    assert.deepEqual([suspended.status, Number(suspended.access_version)], ['suspended', versionAtStart + 1],
      'the access version moves by exactly one, whatever it was before this test');

    // 4. the VERY NEXT request on the same session is refused — no sleep, no grace — and refused for
    // the REASON this stage is about, not because the cookie was unknown or the session had expired.
    const refused = await witness(first);
    assert.equal(refused.status, 401, 'a suspended tenant\'s session is refused at once');
    assert.equal(reasonsIn(logs).at(-1), 'session_admission_denied',
      'the admission denied it, and the boundary revoked what the principal held');

    // 5. and the session is GONE, not merely refused: the admission denial revoked it
    assert.equal(await sessionsOf(TENANT_ACTOR), 0, 'every session the principal held on this boundary ended');

    // 6. a fresh login while suspended is refused too
    const blocked = await login(TENANT_ACTOR);
    assert.equal(blocked.status, 401, 'login is refused while the tenant is suspended');
    assert.equal(await sessionsOf(TENANT_ACTOR), 0, 'and issues nothing');

    // 7. the tenant is reactivated through the same command; the version moves again, never back
    await reactivate(TENANT_A);
    const active = await tenantRow(TENANT_A);
    assert.deepEqual([active.status, Number(active.access_version)], ['active', versionAtStart + 2],
      'and again by one — never back to a value it has held');

    // 8. a NEW login now succeeds
    const second = await login(TENANT_ACTOR);
    assert.equal(second.status, 200);
    const again = await witness(second);
    assert.equal(again.status, 200, again.body);

    // 9. and it is admitted at a DIFFERENT witness: the standing is not the standing it had before.
    //
    // THIS IS THE WHOLE POINT OF MIGRATION 010's ACCESS VERSION. Everything 007 derives is
    // IDENTICAL on both sides of the suspension — same account, same status, same role, same tenant,
    // and the assertion below says so. Without the access version the admission answer would be
    // byte-identical too, and an idle session that survived the outage would be revived by the
    // reactivation. The version, which never returns to a value it has held, is the only difference.
    assert.equal(bodyOf(again).securityVersion, principalVersion,
      "the principal's own security version did NOT move: suspension is not part of what 007 derives");
    assert.notEqual(await witnessOf(TENANT_ACTOR), witnessBefore,
      'but the admission witness did, so the pre-suspension standing is not restored');

    // 10. the cookie from step 1 stays dead: reactivation revives no session it ended
    assert.equal((await witness(first)).status, 401, 'the old session is not revived by the reactivation');
    assert.equal(await sessionsOf(TENANT_ACTOR), 1, 'exactly the one session issued after reactivation');
  });
});

test('M5A-04b: THE REVIVAL PROOF — a session IDLE across a whole suspend-and-reactivate episode is refused on its next request', async () => {
  // THIS is the case migration 010's access version exists for, and the one M5A-04 cannot show.
  //
  // In M5A-04 the session made a request WHILE the tenant was suspended, so admission denied it and
  // the boundary deleted it: every later 401 is then just a dead cookie, and would still be a 401 if
  // the access version had never been written. Here the session makes NO request during the episode.
  // Its row survives, still bound to the witness it was admitted at. When it finally returns, the
  // tenant is active again and 007 answers exactly what it answered before the suspension — same
  // account, same status, same role, same tenant. The ONLY thing that differs is the access version,
  // which moved twice and never returns to a value it has held. If it were not digested, this
  // request would be served and the suspension would have been undone by the reactivation.
  //
  // Its own tenant and actor, so no other test's session, suspension or count can reach it.
  const tenant = await newTenant('idle-tenant');
  const idler = await actor('idle-actor', { scope: 'tenant', tenant, role: 'store_owner' });
  await withRuntime(async ({ login, witness, logs }) => {
    const session = await login(idler);
    assert.equal(session.status, 200);
    const served = await witness(session);
    assert.deepEqual([served.status, bodyOf(served).tenant], [200, tenant]);
    const boundWitness = await witnessOf(idler);

    // The whole episode passes with this session making no request at all.
    await setStatus(tenant, 'active', 'suspended');
    await setStatus(tenant, 'suspended', 'active');
    assert.equal((await tenantRow(tenant)).status, 'active', 'the tenant is exactly as it started');
    assert.equal(await sessionsOf(idler), 1, 'and the idle session was never touched: nothing revoked it');
    assert.equal(await witnessOf(idler), boundWitness, 'still bound to the witness it was admitted at');

    // The admission answer, however, is not the answer it was — and that is the whole mechanism.
    const now = await tenantAdmission.admit(idler.principal, signal());
    assert.equal(now.outcome, 'admitted', 'the actor may hold a session again: the tenant is active');
    assert.notEqual(now.securityVersion, boundWitness,
      'but at a DIFFERENT witness, because the access version moved twice and never returns');

    // So the first request after the episode is refused — for the version, not for a missing row —
    // and THAT session is ended. A session issued after the reactivation is unaffected.
    const refused = await witness(session);
    assert.equal(refused.status, 401, 'the idle session is not revived by the reactivation');
    assert.equal(reasonsIn(logs).at(-1), 'session_version_mismatch',
      'refused because the witness moved, not because the cookie was unknown');
    assert.equal(await sessionsOf(idler), 0, 'and it is gone, so it cannot be presented again');

    const fresh = await login(idler);
    assert.equal(fresh.status, 200, 'a new login is admitted at the new witness');
    assert.equal((await witness(fresh)).status, 200);
  }, { actors: [idler] });
});

// ---------------------------------------------------------------------------
// M5A-05..09: the other proofs this stage owes
// ---------------------------------------------------------------------------

test('M5A-05: a STORE session is denied by its parent tenant\'s suspension, and restored by its reactivation', async () => {
  await withRuntime(async ({ login, witness }) => {
    const session = await login(STORE_ACTOR);
    assert.equal(session.status, 200);
    const served = await witness(session, STORE_WITNESS_PATH);
    assert.equal(served.status, 200, served.body);
    assert.deepEqual([bodyOf(served).tenant, bodyOf(served).store, bodyOf(served).roleId], [TENANT_B, STORE_B, 'manager']);

    await suspend(TENANT_B);
    assert.equal((await witness(session, STORE_WITNESS_PATH)).status, 401, 'the store is denied by its tenant, which it never names');
    assert.equal(await sessionsOf(STORE_ACTOR), 0);
    assert.equal((await login(STORE_ACTOR)).status, 401, 'and cannot sign in again beneath a suspended tenant');

    await reactivate(TENANT_B);
    const after = await login(STORE_ACTOR);
    assert.equal(after.status, 200);
    assert.equal((await witness(after, STORE_WITNESS_PATH)).status, 200);
  });
});

test('M5A-05b: a STORE suspended under an ACTIVE tenant ends the ACTIVE session — and an IDLE one is served again after reactivation (DA-41)', async () => {
  // A different path from M5A-05, and it lands in the same place for a different reason. 007's
  // resolver filters out a grant whose STORE is suspended, exactly as it does for a suspended tenant,
  // so the actor is left holding no tenant or store grant at all: admission REFUSES, and the boundary
  // ends every session it holds. No access version moves — 010 keeps one per TENANT, and no command
  // changes a store's status at all — which is why the second half of this test exists.
  const tenant = await newTenant('store-parent');
  const store = await newStore(tenant, 'suspendable');
  const keeper = await actor('store-keeper', { scope: 'store', tenant, store, role: 'manager' });
  const idler = await actor('store-idler', { scope: 'store', tenant, store, role: 'manager' });
  const setStore = (status) => owner`update store set status = ${status} where store_id = ${store}`;
  await withRuntime(async ({ login, witness, logs }) => {
    const session = await login(keeper);
    assert.equal(session.status, 200);
    assert.equal((await witness(session, STORE_WITNESS_PATH)).status, 200);
    const boundBefore = await witnessOf(keeper);
    // A second actor on the same store signs in and then makes NO request until the episode is over.
    const idle = await login(idler);
    assert.equal(idle.status, 200);
    const idleBound = await witnessOf(idler);

    await setStore('suspended');
    assert.equal((await witness(session, STORE_WITNESS_PATH)).status, 401, 'the next request is refused at once');
    assert.equal(reasonsIn(logs).at(-1), 'session_admission_denied', 'admission refused: no tenant or store grant remains');
    assert.equal(await sessionsOf(keeper), 0, 'and the session is ended, not merely refused');
    assert.equal((await login(keeper)).status, 401, 'nor can the actor sign in while the store is suspended');
    assert.equal(await sessionsOf(idler), 1, 'the idle session made no request, so nothing ended it');

    // THE RECORDED GAP (doc 08 DA-41), asserted rather than assumed. A store's lifecycle has no
    // monotonic witness, so once it is active again the admission answer is byte-identical to the one
    // it gave before the suspension. Any session that was IDLE across the whole episode — this one
    // was not; it was revoked above — would therefore be admitted on its old witness, which is the
    // revival the tenant access version closes for tenants and nothing closes for stores. It is
    // unreachable today (no shipped command changes a store's status), and this assertion is here so
    // that the day a store lifecycle command is written, whoever writes it is told what it must add.
    await setStore('active');
    const after = await login(keeper);
    assert.equal(after.status, 200);
    assert.equal(await witnessOf(keeper), boundBefore,
      'the witness RETURNED to its pre-suspension value: a store carries no access version (DA-41)');
    assert.equal((await witness(after, STORE_WITNESS_PATH)).status, 200);
    // THE GAP ITSELF: the idle session, admitted before the suspension, is SERVED on its old witness.
    // For a tenant, M5A-04b proves the opposite; for a store nothing moves, so nothing refuses it.
    assert.equal(await witnessOf(idler), idleBound, 'still bound to the witness it was admitted at');
    assert.equal((await witness(idle, STORE_WITNESS_PATH)).status, 200,
      'revived by the reactivation: the gap DA-41 records, and a store lifecycle command must close');
  }, { actors: [keeper, idler] });
});

test('M5A-06: a display-name edit moves the row version and ends NO session', async () => {
  await withRuntime(async ({ login, witness }) => {
    const session = await login(TENANT_ACTOR);
    assert.equal(session.status, 200);
    const held = await sessionsOf(TENANT_ACTOR); // one per device; this actor may already hold others
    assert.equal((await witness(session)).status, 200);
    // The witnesses the actor's live sessions are BOUND to — the values revalidation compares. The
    // principal's own security version would not do: no tenant lifecycle change ever moves it, so
    // comparing it could not tell a rename from a suspension.
    const boundBefore = await witnessesOf(TENANT_ACTOR);
    const { row_version: version, access_version: access } = await tenantRow(TENANT_A);

    // The shipped display-name command, called as the runtime calls it (migration 009).
    const [changed] = await runtime`select o_outcome, o_version from tmpos_command.m5_tenant_display_name_update_v2(
      ${TENANT_A}::uuid, ${version}::bigint, ${`m5a-renamed-${SUFFIX}`}::text)`;
    assert.equal(changed.o_outcome, 'applied');

    const row = await tenantRow(TENANT_A);
    assert.notEqual(row.row_version, version, 'the row version moved');
    assert.equal(row.access_version, access, 'the ACCESS version did not: nobody\'s standing changed');

    const after = await witness(session);
    assert.equal(after.status, 200, 'the session still answers');
    assert.deepEqual(await witnessesOf(TENANT_ACTOR), boundBefore, 'every session is still bound to the witness it had: a rename is not a revocation');
    assert.equal(await sessionsOf(TENANT_ACTOR), held, 'and not one session anywhere was ended');
  });
});

test('M5A-07: the platform boundary is untouched while a tenant is suspended', async () => {
  await withRuntime(async ({ login, send: request }) => {
    const admin = await login(PLATFORM_ACTOR, 'admin');
    assert.equal(admin.status, 200, 'a platform actor holds an admin session');
    const current = () => request('GET', sessionPaths('admin').current, { cookie: admin.cookie, origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin' });
    assert.equal((await current()).status, 200);

    await suspend(TENANT_A);
    try {
      assert.equal((await current()).status, 200, 'suspending a tenant does not touch the administrator who did it');
      // The platform actor never held a tenant session, and still may not hold one.
      assert.equal((await login(PLATFORM_ACTOR)).status, 401, 'and a platform grant is still not a tenant session');
    } finally {
      await reactivate(TENANT_A);
    }
  });
});

test('M5A-08: there is NO grace window — the SESSION boundary and the authorizer each re-read on every protected request', async () => {
  assert.equal(ADMISSION_REVALIDATE_MS.tenant, 0, 'the tenant boundary declares no revalidation interval');
  // One relay per call site, so a read is attributed rather than pooled: a boundary that started
  // caching its revalidation would still show three authorizer reads, and the pooled count alone
  // could not tell that apart from the correct behaviour.
  const atBoundary = counted(tenantAdmission);
  const atAuthorizer = counted(tenantAdmission);
  await withRuntime(async ({ login, witness }) => {
    const session = await login(TENANT_ACTOR);
    assert.equal(session.status, 200);
    assert.deepEqual([atBoundary.calls, atAuthorizer.calls], [1, 0], 'the login asks the boundary, and no route is authorized yet');
    for (let i = 0; i < 3; i += 1) assert.equal((await witness(session)).status, 200);
    // The cost is stated rather than optimised away — it is exactly what "no grace window" buys
    // (doc 08 DA-38): the boundary revalidates the SESSION, then the authorizer decides the REQUEST
    // on what the database says now rather than on what the session carries.
    assert.deepEqual([atBoundary.calls - 1, atAuthorizer.calls], [3, 3], 'three requests, one read each at each call site, none cached');
    // And the stamp a boundary WITH a window would slide is never written — on ANY row, so no read
    // could ever be skipped, whichever session a later request presents.
    const stamps = await owner`select validated_at, created_at from tmpos_session.session
      where auth_provider_uid = ${TENANT_ACTOR.uid}`;
    assert.ok(stamps.length >= 1, 'there are rows to judge');
    for (const row of stamps) assert.equal(row.validated_at, row.created_at, 'validatedAt is never refreshed on a boundary that re-reads unconditionally');
  }, { admission: atBoundary, authorizerAdmission: atAuthorizer });
});

test('M5A-09: a suspension racing live requests leaves every answer either served or refused, and the session ended', async () => {
  await withRuntime(async ({ login, witness }) => {
    const session = await login(TENANT_ACTOR);
    assert.equal(session.status, 200);
    // Eight requests in flight while the suspension commits underneath them.
    // Kept below the kernel's pool so a queued transaction cannot overrun its deadline and answer
    // 503 — which would be a resource verdict, not the concurrency property under test.
    const inflight = Array.from({ length: 4 }, () => witness(session));
    await suspend(TENANT_A);
    const answers = await Promise.all(inflight);
    try {
      for (const reply of answers) {
        // 200 or 401 and NOTHING ELSE: no 5xx, no half-applied answer, no partial state. A request
        // that was decided before the suspension committed is served in full; one decided after is
        // refused in full.
        assert.ok([200, 401].includes(reply.status), `served or refused, never anything else: ${reply.status} ${reply.body}`);
        if (reply.status === 200) assert.equal(bodyOf(reply).tenant, TENANT_A);
      }
      // Whatever the interleaving, the settled state is one: the session is gone and stays gone.
      assert.equal((await witness(session)).status, 401);
      assert.equal(await sessionsOf(TENANT_ACTOR), 0);
    } finally {
      await reactivate(TENANT_A);
    }
  });
});

// ---------------------------------------------------------------------------
// M5A-10: 011's rollback and re-apply, inside a transaction that is rolled back
// ---------------------------------------------------------------------------

test('M5A-10: 011 refuses to roll back while a session row remains, and rolls back once none does', async () => {
  const principalKey = `pk-${SUFFIX}`;
  const clear = (tx) => tx`delete from tmpos_session.session`;
  const liveSession = async (tx) => {
    const now = SESSION_CONTRACT_EPOCH;
    const [{ created }] = await tx`select tmpos_session.m5_session_create(${`m5a-${randomUUID()}`}::text, 'tenant'::text,
      'firebase'::text, ${TENANT_ACTOR.uid}::text, ${principalKey}::text, 't1:probe'::text,
      ${now}::bigint, ${now}::bigint, ${now}::bigint, ${now}::bigint, ${now + 3_600_000}::bigint) as created`;
    assert.equal(created, 'created');
  };

  // A refused rollback aborts its own transaction, so the refusal and the successful rollback are
  // proved in TWO transactions, each rolled back so a shared database keeps its state.
  await owner.begin(async (tx) => {
    await clear(tx);
    await liveSession(tx);
    await assert.rejects(
      tx.unsafe(DOWN_011).simple(),
      // 55000 object_not_in_prerequisite_state — the code the refusal raises with, and whose hint
      // names the remedy. It is NOT 55006 (object_in_use): nothing here is in use.
      (err) => err.code === '55000' && /session row\(s\) remain/.test(String(err.message)),
      'the rollback refuses while anyone holds a session',
    );
    throw new Error('m5a-refusal-probe');
  }).catch((err) => { if (!/m5a-refusal-probe/.test(String(err.message))) throw err; });

  await owner.begin(async (tx) => {
    // The remedy the refusal names: end the sessions through the boundary that owns them.
    await clear(tx);
    await liveSession(tx);
    const [{ ended }] = await tx`select tmpos_session.m5_session_revoke_principal('tenant'::text, ${principalKey}::text) as ended`;
    assert.ok(Number(ended) >= 1, 'the remedy ends the sessions it names');
    await clear(tx);
    await tx.unsafe(DOWN_011).simple();
    const [{ gone }] = await tx`select pg_catalog.to_regnamespace('tmpos_session') is null as gone`;
    assert.equal(gone, true, 'the schema, its table and its six routines are removed');
    const [{ tenant_column }] = await tx`select count(*)::int as tenant_column from pg_catalog.pg_attribute
      where attrelid = 'public.tenant'::regclass and attname = 'access_version' and not attisdropped`;
    assert.equal(tenant_column, 1, 'and 010 is untouched: the rollback removes only what 011 created');

    // 010 -> 011 again, over the rolled-back state: the upgrade applies cleanly.
    await tx.unsafe(UP_011).simple();
    const [{ back }] = await tx`select count(*)::int as back from pg_catalog.pg_proc where pronamespace = 'tmpos_session'::regnamespace`;
    assert.equal(back, 6, 'the upgrade re-applies');
    throw new Error('m5a-rollback-probe'); // roll the whole proof back
  }).catch((err) => {
    if (!/m5a-rollback-probe/.test(String(err.message))) throw err;
  });

  const [{ present }] = await owner`select pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is not null as present`;
  assert.equal(present, true, 'the proof left the database as it found it');
});

test('M5A-12: 011 refuses to finish over a widened privilege, a membership of its owner, or FORCEd row security', async () => {
  // Each case re-applies 011 over the rolled-back 010 state with ONE thing widened first, inside a
  // transaction that is always rolled back. The ACL checks see what was WRITTEN on the new objects; the
  // membership and effective-privilege checks see what a role HOLDS by any path; section 1 sees the
  // row-security state 007's resolver and 011's routine both depend on.
  const [{ owner_name: ownerName }] = await owner`select current_user::text as owner_name`;
  const cases = [
    ['a predefined role handing the audit writer every table', 'grant pg_read_all_data to tmpos_audit_writer',
      /tmpos_audit_writer holds an effective privilege on tmpos_session\.session/],
    ['a default privilege granting the runtime role new tables', 'alter default privileges grant select on tables to tmpos_app',
      /tmpos_session\.session carries a direct grant/],
    ['a default privilege granting the audit writer new routines', 'alter default privileges grant execute on functions to tmpos_audit_writer',
      /unexpected direct grant remains on a routine/],
    ['the runtime role made a member of the owner', `grant "${ownerName}" to tmpos_app`,
      /tmpos_app is a member of an owner/],
    ['row security FORCEd on public.tenant', 'alter table public.tenant force row level security',
      /public\.tenant forces row level security on its owner/],
  ];
  for (const [label, widen, refusal] of cases) {
    await owner.begin(async (tx) => {
      await tx`delete from tmpos_session.session`;
      await tx.unsafe(DOWN_011).simple();
      await tx.unsafe(widen);
      await assert.rejects(tx.unsafe(UP_011).simple(), (err) => refusal.test(String(err.message)), label);
      throw new Error('m5a-postcondition-probe');
    }).catch((err) => { if (!/m5a-postcondition-probe/.test(String(err.message))) throw err; });
  }
  const [{ present }] = await owner`select pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is not null as present`;
  assert.equal(present, true, 'every case was rolled back');
});

test('M5A-13: an admission read that cannot see a tenant\'s access version RAISES — it never answers a refusal', async () => {
  // The drift this guards: 011's routine sees LESS of public.tenant than 007's resolver does. Here its
  // owner is moved, inside a rolled-back transaction, to a role that may SELECT the table but is
  // subject to its row security — so 007 still resolves the grant, and 011's join finds no version.
  // A refusal would make the boundary end every session the principal holds; a raise is an outage.
  const blind = `m5a_blind_${SUFFIX.replace(/-/g, '')}`;
  await owner.begin(async (tx) => {
    await tx.unsafe(`create role ${blind} nologin`);
    await tx.unsafe(`grant usage on schema public, tmpos_identity to ${blind}`);
    await tx.unsafe(`grant select on public.tenant to ${blind}`);
    await tx.unsafe(`grant execute on function tmpos_identity.m5_resolve_principal(text, text) to ${blind}`);
    await tx.unsafe(`alter function tmpos_session.m5_admit_tenant_session(text, text) owner to ${blind}`);
    const outcome = async (who) => (await tx`select outcome from tmpos_session.m5_admit_tenant_session('firebase'::text, ${who}::text)`)[0].outcome;
    // Nothing that needs no access version is disturbed: a platform grant and a nobody answer as before.
    assert.equal(await outcome(PLATFORM_ACTOR.uid), 'resolved');
    assert.equal(await outcome(`m5a-nobody-${SUFFIX}`), 'refused');
    // A tenant grant, whose version the routine can no longer read, fails the statement instead.
    await assert.rejects(outcome(TENANT_ACTOR.uid),
      (err) => err.code === '42501' && /carry no access version/.test(String(err.message)),
      'insufficient_privilege, naming the fault, never the refusal the boundary would mass-revoke on');
    throw new Error('m5a-raise-probe');
  }).catch((err) => { if (!/m5a-raise-probe/.test(String(err.message))) throw err; });
});

test('M5A-11: migrations 005-010 are byte-identical to what this stage found', () => {
  const pinned = {
    '005_principal_separation_rls_foundation.up.sql': 'a4a61385beedf98194fb427bcd528704b068d7ca2947a9713d7a1a1c87157bda',
    '006_m6_transactional_store.up.sql': '091933e19559d1d109580dd86cd381ada12398fbe1a93b011ac97e15c23dc68c',
    '007_m5_trusted_principal_resolution.up.sql': 'a3a9aa98b299cd343e35df6b9048ea1468f5b11668e7ea6996045cb514f7bcbe',
    '008_m5_tenant_display_name_command.up.sql': 'cfaa5724bd4b9bb1681f6a8633a282aa8dd3ea3ed3d3cf9a89a8e28d33a51d5e',
    '009_m5_first_command_hardening.up.sql': '032842618ee71ca1e523502a75d9824ea5c922236e03670defb99f0e0764b54c',
    '010_m5_tenant_lifecycle_command.up.sql': 'a3a2f41107df582826c20001a91edff569507582e1d90df6c339778b2fb8748b',
  };
  for (const [name, expected] of Object.entries(pinned)) {
    assert.equal(createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex'), expected, name);
  }
});
