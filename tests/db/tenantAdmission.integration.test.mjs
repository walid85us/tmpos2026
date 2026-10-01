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
// gap (doc 08 DA-41) is closed: an idle store session is refused after a reactivation. Migration 016 —
// the access-version and grant-version triggers, the v2 read, the hold and its own refusals — is proved
// at the SQL level (M5A-14..20).
//
// DISPOSABLE ONLY. The target is resolveDisposableTarget's supplied DSN when CI binds one, otherwise a
// cluster this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs.
// Fixtures are synthetic and randomly named. The rollback proof runs inside two transactions, each
// rolled back, so a shared database keeps its state.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
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
import { createPostgresTenantAdmission, holdTenantStanding, readTenantAdmission } from '../../server/persistence/postgresTenantAdmission.ts';
import { createPostgresPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';
import { createPostgresRoleLevels } from '../../server/persistence/postgresRoleLevels.ts';
import {
  createTenantEstablishCheck,
  createTenantRouteAuthorizer,
  createTenantSessionAdmission,
} from '../../server/composition/tenantAuthorization.ts';
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
const UP_015 = readFileSync(`${MIG_DIR}/015_m5_admin_standing_serialization.up.sql`, 'utf8');
const DOWN_015 = readFileSync(`${MIG_DIR}/015_m5_admin_standing_serialization.down.sql`, 'utf8');
const UP_016 = readFileSync(`${MIG_DIR}/016_m5_tenant_session_ordering.up.sql`, 'utf8');
const DOWN_016 = readFileSync(`${MIG_DIR}/016_m5_tenant_session_ordering.down.sql`, 'utf8');
/** 016's section 8 postcondition, run again on its own after a deliberate widening, to prove it refuses. */
const POSTCONDITION_016 = UP_016.slice(UP_016.lastIndexOf('do $$'));
const V2 = 'tmpos_session.m5_admit_tenant_session_v2(text, text)';
const HOLD = 'tmpos_session.m5_hold_tenant_standing(text, text)';

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

const TARGET = resolveDisposableTarget('M5A');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** Used only to build the URL handed to production code that takes a driver (createSupervisedPgClient below). */
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

test.after(async () => {
  if (client) await client.end();
  if (runtime) await runtime.end({ timeout: 5 });
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: real migrations 001-024, a real non-owner runtime login, real adapters, the issuer key installed by the owner
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
client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN),
  ssl: false,
  max: 8,
  idle_timeout: 0,
  user: RUNTIME_LOGIN,
});

// Migration 018: every tenant session is minted under the issuer key the owner installs (a synthetic one here).
const ISSUER_KEY = await installTestIssuerKey(owner);
/**
 * The real adapters, over that one client — what productionTransactions.ts builds for the tenant audience: the store's
 * establish-time standing check holds the actor's standing (016's hold) and re-reads 016's v2 on that transaction.
 */
const sessionStore = createPostgresSessionStore({
  client,
  issuerKey: ISSUER_KEY,
  standing: createTenantEstablishCheck({ hold: holdTenantStanding, read: readTenantAdmission }),
});
const tenantAdmission = createPostgresTenantAdmission({ client });
/**
 * The owner's durable role edits (migration 020, M7A-CUSTOMERS-P3-R1), read by the production reader: the tenant route
 * authorizer requires it and decides each permission on the selected role's current definition. No level is edited here,
 * so every role decides at its catalog default and this suite's admission proofs are unchanged.
 */
const roleLevels = createPostgresRoleLevels({ client });

/** A counting relay over the REAL admission: it delegates every call and adds nothing. */
function counted(port) {
  const relay = {
    calls: 0,
    admit(principal, sig) { relay.calls += 1; return port.admit(principal, sig); },
    probe(sig) { return port.probe(sig); },
  };
  return relay;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/**
 * The counting relay's recording sibling: it delegates every call, notes who each answer was for and
 * its outcome, and adds nothing. Setting `hold` to `{ entered, release }` (two deferreds) makes the
 * NEXT read signal `entered` and wait for `release` before it reaches the database — an in-process gate
 * that orders a request's read after a commit without a sleep.
 */
function recorded(port) {
  const relay = {
    answers: [],
    hold: null,
    async admit(principal, sig) {
      const hold = relay.hold;
      if (hold !== null) { relay.hold = null; hold.entered.resolve(); await hold.release.promise; }
      const answer = await port.admit(principal, sig);
      relay.answers.push({ uid: principal.authProviderUid, outcome: answer?.outcome });
      return answer;
    },
    probe(sig) { return port.probe(sig); },
  };
  return relay;
}

/**
 * A relay over the REAL session store that records every stamp write (`update`) and delegates everything.
 * Bind `logs` to the runtime's log lines and each write also records the line logged just before it.
 */
function stampsRecorded(store) {
  const relay = {
    updates: [],
    logs: null,
    create: (key, record, sig) => store.create(key, record, sig),
    get: (key, sig) => store.get(key, sig),
    update(key, fields, sig) {
      relay.updates.push({ fields: Object.keys(fields), after: relay.logs?.at(-1) ?? null });
      return store.update(key, fields, sig);
    },
    revoke: (key, sig) => store.revoke(key, sig),
    revokePrincipal: (audience, principalKey, sig) => store.revokePrincipal(audience, principalKey, sig),
    // The audited pair a tenant login and logout commit through (M5-TENANT-SESSION-P1): delegated, not recorded — the
    // stamps below are the idle refreshes, which only `update` writes.
    establish: (key, record, replaces, audit, sig) => store.establish(key, record, replaces, audit, sig),
    end: (key, audit, sig) => store.end(key, audit, sig),
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
/** Every audit record and outbox event naming this tenant (or, for audit, this actor): what a request acting on them would leave. */
const tracesOf = async (tenant, who) => ({ ...(await owner`select
    (select count(*)::int from public.audit_event
      where tenant_id = ${tenant} or subject_tenant_id = ${tenant} or actor_internal_user_id = ${who.id}) as audits,
    (select count(*)::int from tmpos_internal.outbox_event where aggregate_id = ${tenant}) as events`)[0] });
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
/** The refusal code logged for ONE reply, joined on the request id its response header carries. */
const reasonOf = (logs, reply) => {
  const lines = logs
    .map((line) => { try { return JSON.parse(line); } catch { return {}; } })
    .filter((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id']);
  assert.equal(lines.length, 1, 'exactly one log line for the request');
  return lines[0].reason;
};
/** A refusal's body is the fixed `{ error, requestId }` and nothing else: no scope, no reason, no tenant. */
const assertRefusalBody = (reply, error) => {
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], reply.body);
  assert.equal(body.error, error);
  assert.equal(body.requestId, reply.headers['x-request-id']);
};

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
        authorizer: createTenantRouteAuthorizer({ admission: authorizerAdmission, reads: over.reads ?? WITNESS_READS, levels: roleLevels }),
        store: over.store ?? sessionStore,
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

test('M5A-01: migrations 001-024 applied, and the runtime role reaches the session table only through 011\'s routines and 018\'s mint', async () => {
  // The LEDGER, not this run's report: on the shared CI service an earlier suite has already applied
  // 001-024, so this run applies nothing and its report lists no version.
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024']
      .map((v) => [v, false]));

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
  // And the schema holds exactly ten routines: 011's five session operations and its admission read, and 016's two
  // version triggers, v2 read and hold. The runtime role may call seven of them — never a trigger function, and since
  // migration 018 no longer 011's create, which would let it write a session for anyone (doc 08 DA-83): every session
  // is created through 018's tmpos_mint.m7a_session_create, a tenant one only with the issuer key's proof.
  const routines = await owner`select proname::text as name,
      pg_catalog.has_function_privilege('tmpos_app', oid, 'EXECUTE') as app
    from pg_catalog.pg_proc where pronamespace = 'tmpos_session'::regnamespace order by proname`;
  assert.deepEqual(routines.map((r) => [r.name, r.app]), [['m5_access_version_moved', false], ['m5_admit_tenant_session', true],
    ['m5_admit_tenant_session_v2', true], ['m5_hold_tenant_standing', true], ['m5_session_create', false], ['m5_session_get', true],
    ['m5_session_revoke', true], ['m5_session_revoke_principal', true], ['m5_session_touch', true], ['m5_tenant_grant_moved', false]],
  '011\'s five session operations and admission read, 016\'s v2 read and hold, and two trigger functions nobody may call');
});

test('M5A-02: the production session store satisfies the port\'s own conformance contract against real PostgreSQL', async () => {
  // The contract stamps its records at a fixed instant, so the store is built over that same clock.
  // Its fixtures are opaque and carry the provider 'synthetic', so both cleanups name exactly those
  // rows: on a shared CI database this suite must not remove another suite's sessions.
  const clearFixtures = () => owner`delete from tmpos_session.session where auth_provider = 'synthetic'`;
  await clearFixtures();
  try {
    // `standing` is the establish-time standing check the production composition binds; the store
    // refuses to establish without one. A stub that always answers true, because the contract judges
    // the PORT (create, get, update, revoke, establish, end), not admission.
    // Since 018 its tenant records are minted, so it carries the issuer key the owner installed.
    await assertSessionStoreContract(createPostgresSessionStore({
      client, now: () => SESSION_CONTRACT_EPOCH, standing: async () => true, issuerKey: ISSUER_KEY,
    }));
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
  assert.match(answer.securityVersion, /^t2:[A-Za-z0-9_-]{1,120}$/);
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
    assert.match(witnessBefore, /^t2:/, 'the session is bound to the admission witness');

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

test('M5A-05b: a STORE suspended under an ACTIVE tenant ends the ACTIVE session — and an IDLE one is refused after reactivation (DA-41 closed)', async () => {
  // A different path from M5A-05, and it lands in the same place for a different reason. 007's
  // resolver filters out a grant whose STORE is suspended, exactly as it does for a suspended tenant,
  // so the actor is left holding no tenant or store grant at all: admission REFUSES, and the boundary
  // ends every session it holds. No command changes a store's status, so the owner writes it here —
  // and since migration 016 that write moves the store's access version, which the second half proves.
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

    // THE GAP DA-41 RECORDED, now closed (M5-TENANT-SESSION-P1). Before migration 016 a store had no
    // monotonic witness: once active again the admission answer was byte-identical to the one before
    // the suspension, and a session IDLE across the whole episode was served again on its old witness.
    // 016's trigger moves the store's access version on every status change — whoever writes it, a raw
    // owner write included — and it never returns to a value it has held, so the answer after the
    // reactivation differs from the one before the suspension.
    const { access_version: versionBefore } = (await owner`select access_version from store where store_id = ${store}`)[0];
    await setStore('active');
    assert.equal(Number((await owner`select access_version from store where store_id = ${store}`)[0].access_version),
      Number(versionBefore) + 1, 'the reactivation moved the store access version again, never back');
    const after = await login(keeper);
    assert.equal(after.status, 200);
    assert.notEqual(await witnessOf(keeper), boundBefore,
      'the witness did NOT return to its pre-suspension value: the store access version moved twice');
    assert.equal((await witness(after, STORE_WITNESS_PATH)).status, 200);
    // THE CLOSURE ITSELF: the idle session, admitted before the suspension and untouched since, is
    // refused on its next request for the version — exactly what M5A-04b proves for a tenant — and ended.
    assert.equal(await witnessOf(idler), idleBound, 'still bound to the witness it was admitted at');
    assert.equal((await witness(idle, STORE_WITNESS_PATH)).status, 401, 'not revived by the reactivation');
    assert.equal(reasonsIn(logs).at(-1), 'session_version_mismatch',
      'refused because the witness moved, not because the cookie was unknown');
    assert.equal(await sessionsOf(idler), 0, 'and ended, so it cannot be presented again');
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

// How one protected tenant request can end when a suspension commits while it is in flight. It makes
// three reads in turn — its session (T1), the boundary's admission (T2) and the authorizer's own
// admission re-read (T3, doc 08 DA-38) — and the commit can land between any two:
//   200 — T2 and T3 both preceded the commit: decided before it, served in full;
//   403 authz_denied — T2 admitted before the commit, T3 came after it (DA-63): refused in full by the
//         authorizer, with no handler run, nothing written, nothing revoked and no idle stamp slid;
//   401 session_admission_denied — T2 came after the commit: the boundary ends every session held;
//   401 session_unknown — T1 came after another request's revocation.
// Nothing else is correct: a 5xx, a *_unrevoked reason, a body naming a scope, or a 403 no refused read explains.
const RACE_REFUSALS_401 = ['session_admission_denied', 'session_unknown'];

test('M5A-09: a suspension racing live requests — each answer served or refused in full, each 403 proven, nothing half-applied, the session ended', async (t) => {
  // The authorizer's port is recorded apart from the boundary's, so a 403 is traced to the read that
  // refused it; the store is recorded, so a stamp written by a refused request would be seen.
  const atAuthorizer = recorded(tenantAdmission);
  const stamps = stampsRecorded(sessionStore);
  await withRuntime(async ({ login, witness, logs }) => {
    stamps.logs = logs;
    const session = await login(TENANT_ACTOR);
    assert.equal(session.status, 200);
    const before = await tenantRow(TENANT_A);
    const tracesBefore = await tracesOf(TENANT_A, TENANT_ACTOR);
    assert.equal(before.status, 'active');
    assert.equal((await tenantAdmission.admit(TENANT_ACTOR.principal, signal())).outcome, 'admitted',
      'before the suspension, the read the authorizer makes admits this actor');
    // Four requests in flight while the suspension commits underneath them, with no gate and no sleep:
    // where each one's reads fall against the commit is the interleaving under test. Kept below the
    // kernel's pool so a queued transaction cannot overrun its deadline and answer 503 — which would be
    // a resource verdict, not the concurrency property under test.
    const inflight = Array.from({ length: 4 }, () => witness(session));
    await suspend(TENANT_A);
    const answers = await Promise.all(inflight);
    let reactivated = false;
    try {
      const served = answers.filter((r) => r.status === 200);
      const forbidden = answers.filter((r) => r.status === 403);
      const refused = answers.filter((r) => r.status === 401);
      t.diagnostic(`answers: 200x${served.length} 401x${refused.length} 403x${forbidden.length}`);
      assert.equal(served.length + forbidden.length + refused.length, answers.length,
        `served or refused, never anything else: ${answers.map((r) => `${r.status} ${r.body}`).join(' | ')}`);

      // Served in full: the scope the authorizer decided, and nothing else.
      for (const reply of served) {
        const { securityVersion, ...scope } = bodyOf(reply);
        assert.deepEqual(scope, { actor: TENANT_ACTOR.id, tenant: TENANT_A, store: null, roleId: 'store_owner', limitation: 'none' });
        assert.equal(typeof securityVersion, 'string');
      }
      // Refused in full: the fixed body, naming no scope.
      for (const reply of forbidden) assertRefusalBody(reply, 'forbidden');
      for (const reply of refused) assertRefusalBody(reply, 'unauthenticated');

      // EVERY 403 IS PROVEN, not merely tolerated. The authorizer answers the chain's 403 when its own read
      // does not admit, and for this actor a refusing read can only be one that saw the suspension: the
      // same read admitted just before it, and the suspension is the one write this test makes (the tenant
      // row, below, moved exactly once). So a 403 with no refused authorizer read behind it fails here.
      for (const read of atAuthorizer.answers) assert.equal(read.uid, TENANT_ACTOR.uid, 'only this actor reached the authorizer');
      const refusedReads = atAuthorizer.answers.filter((read) => read.outcome !== 'admitted');
      assert.ok(forbidden.length <= refusedReads.length,
        `${forbidden.length} 403(s) but only ${refusedReads.length} authorizer read(s) that did not admit`);
      assert.equal((await tenantAdmission.admit(TENANT_ACTOR.principal, signal())).outcome, 'refused',
        'and after the suspension the same read refuses');

      // Whatever the interleaving, the settled state is one: the next request is refused and the session is gone.
      const next = await witness(session);
      assert.equal(next.status, 401);
      assertRefusalBody(next, 'unauthenticated');
      assert.equal(await sessionsOf(TENANT_ACTOR), 0, 'no session survives');

      // Each refusal for the reason its reads give — joined on the request id, not on log order — and
      // never an *_unrevoked one, which would mean a revocation failed and a row was left behind.
      for (const reply of forbidden) assert.equal(reasonOf(logs, reply), 'authz_denied');
      for (const reply of [...refused, next]) {
        const reason = reasonOf(logs, reply);
        assert.ok(RACE_REFUSALS_401.includes(reason), `401 for ${reason}`);
      }

      // No state change after a denial: the tenant row moved exactly once — the suspension — and is still suspended.
      const after = await tenantRow(TENANT_A);
      assert.deepEqual(
        [after.status, Number(after.access_version), Number(after.row_version), after.display_name],
        ['suspended', Number(before.access_version) + 1, Number(before.row_version) + 1, before.display_name],
        'one suspension, and nothing any request did');
      // Nor did any request of the race leave an audit record or an event (010's status routine writes neither).
      assert.deepEqual(await tracesOf(TENANT_A, TENANT_ACTOR), tracesBefore, 'no audit record, no outbox event');

      // No revival: once the tenant is active again, the cookie from before the race is still refused.
      await reactivate(TENANT_A);
      reactivated = true;
      const revived = await witness(session);
      assert.equal(revived.status, 401, 'a reactivation revives no session the suspension ended');
      assert.equal(await sessionsOf(TENANT_ACTOR), 0);
      assert.equal(reasonOf(logs, revived), 'session_unknown', 'the row is gone, not merely refused');

      // No refused request slid the idle stamp. The row cannot be compared (the settled request deleted
      // it), so each write is attributed at the store instead. The only store write a witness request
      // makes is its idle refresh, issued SYNCHRONOUSLY from its response's 'finish' — whose earlier
      // listener, the request log line, has just been written (app.ts registers that one first, and
      // withDeadline calls the port in its executor). So the line logged immediately before a write names
      // the response it followed: every write must follow a distinct SERVED response, and only the idle
      // stamp is ever written. A write after a 401 or 403 line, or a second write for one response, fails.
      const writes = stamps.updates.map(({ fields, after }) => ({ fields, line: JSON.parse(after) }));
      for (const { fields, line } of writes) {
        assert.deepEqual(fields, ['lastSeenAt'], 'only the idle stamp, never the validation stamp');
        assert.deepEqual([line.event, line.status], ['request', 200], `a write after ${JSON.stringify(line)}`);
        assert.ok(served.some((reply) => reply.headers['x-request-id'] === line.requestId), 'after a served race answer');
      }
      const refreshed = writes.map(({ line }) => line.requestId);
      assert.equal(new Set(refreshed).size, refreshed.length, 'at most one write per served answer');
    } finally {
      if (!reactivated) await reactivate(TENANT_A);
    }
  }, { authorizerAdmission: atAuthorizer, store: stamps });
});

test('M5A-09b: the 403 ordering forced — boundary admits, the suspension commits, the authorizer\'s read refuses — and nothing changes', async () => {
  // The interleaving M5A-09 reaches only sometimes, made deterministic by an in-process gate on the
  // AUTHORIZER's port alone: the request's boundary read runs freely, its authorizer read waits until
  // the suspension has committed. Its own tenant and actor, so the session row survives the 403 and can
  // be read back — which is the direct evidence M5A-09 cannot have.
  const tenant = await newTenant('gated-tenant');
  const gated = await actor('gated-actor', { scope: 'tenant', tenant, role: 'store_owner' });
  const atAuthorizer = recorded(tenantAdmission);
  const stamps = stampsRecorded(sessionStore);
  const rowOf = async () => (await owner`select session_key, last_seen_at, validated_at, security_version
    from tmpos_session.session where auth_provider_uid = ${gated.uid}`).map((row) => ({ ...row }));
  await withRuntime(async ({ login, witness, logs }) => {
    const session = await login(gated);
    assert.equal(session.status, 200);
    const tenantBefore = await tenantRow(tenant);
    const rowsBefore = await rowOf();
    assert.equal(rowsBefore.length, 1);

    const hold = { entered: deferred(), release: deferred() };
    atAuthorizer.hold = hold;
    const pending = witness(session);
    // The authorizer is reached only once the boundary has admitted the request, so T2 is behind us.
    await hold.entered.promise;
    await setStatus(tenant, 'active', 'suspended'); // committed before the held read reaches the database
    const tracesBefore = await tracesOf(tenant, gated);
    hold.release.resolve();
    const reply = await pending;

    assert.equal(reply.status, 403, reply.body);
    assertRefusalBody(reply, 'forbidden');
    assert.deepEqual(atAuthorizer.answers, [{ uid: gated.uid, outcome: 'refused' }], 'the held read, and it refused');
    // The mechanism is read after a DB round trip, so the request's log line is certainly written.
    const tenantAfter = await tenantRow(tenant);
    assert.equal(reasonOf(logs, reply), 'authz_denied');

    // Nothing changed: the tenant moved once (the suspension), the session is neither ended nor slid.
    assert.deepEqual(
      [tenantAfter.status, Number(tenantAfter.access_version), Number(tenantAfter.row_version), tenantAfter.display_name],
      ['suspended', Number(tenantBefore.access_version) + 1, Number(tenantBefore.row_version) + 1, tenantBefore.display_name]);
    assert.deepEqual(await rowOf(), rowsBefore, 'the 403 revoked nothing and slid no stamp: the row is exactly as it was');
    assert.deepEqual(stamps.updates, [], 'and the store was asked to write nothing');
    assert.deepEqual(await tracesOf(tenant, gated), tracesBefore, 'and no audit record or outbox event was left');

    // The next request is where the session ends: the boundary's own read now refuses.
    const next = await witness(session);
    assert.equal(next.status, 401);
    assertRefusalBody(next, 'unauthenticated');
    assert.equal(await sessionsOf(gated), 0);
    assert.equal(reasonOf(logs, next), 'session_admission_denied');

    // And a reactivation revives nothing.
    await setStatus(tenant, 'suspended', 'active');
    const revived = await witness(session);
    assert.equal(revived.status, 401);
    assert.equal(await sessionsOf(gated), 0);
    assert.equal(reasonOf(logs, revived), 'session_unknown');
  }, { actors: [gated], authorizerAdmission: atAuthorizer, store: stamps });
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
    // Newest first (D4): 016 lives in 011's schema, whose rollback drops it WITHOUT CASCADE, so 016 comes off first.
    await tx.unsafe(DOWN_016).simple();
    await tx.unsafe(DOWN_011).simple();
    const [{ gone }] = await tx`select pg_catalog.to_regnamespace('tmpos_session') is null as gone`;
    assert.equal(gone, true, 'the schema, its table and its six routines are removed');
    const [{ tenant_column }] = await tx`select count(*)::int as tenant_column from pg_catalog.pg_attribute
      where attrelid = 'public.tenant'::regclass and attname = 'access_version' and not attisdropped`;
    assert.equal(tenant_column, 1, 'and 010 is untouched: the rollback removes only what 011 created');

    // 010 -> 011 again, over the rolled-back state: the upgrade applies cleanly, and 016 over it.
    await tx.unsafe(UP_011).simple();
    const routinesIn = async () => (await tx`select count(*)::int as n from pg_catalog.pg_proc where pronamespace = 'tmpos_session'::regnamespace`)[0].n;
    assert.equal(await routinesIn(), 6, 'the upgrade re-applies');
    await tx.unsafe(UP_016).simple();
    assert.equal(await routinesIn(), 10, 'and 016 re-applies over it');
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
      await tx.unsafe(DOWN_016).simple(); // newest first: 016 lives in 011's schema
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

// ---------------------------------------------------------------------------
// M5A-14..20: migration 016 at the SQL level (M5-TENANT-SESSION-P1)
// ---------------------------------------------------------------------------

/** The statement's refusal, caught inside a savepoint so the surrounding transaction survives: {code, message}, or null. */
const refusalIn = (tx) => async (fn) => {
  try { await tx.savepoint(fn); return null; } catch (err) { return { code: err.code ?? null, message: String(err.message) }; }
};
const ROLLBACK_016 = new Error('m5a: roll the 016 proof back');
/** Runs `fn` in one owner transaction that is ALWAYS rolled back, so a shared database keeps its state. */
async function rolledBack(fn) {
  await assert.rejects(owner.begin(async (tx) => { await fn(tx); throw ROLLBACK_016; }), (err) => err === ROLLBACK_016);
}
/** Whether every object 016 creates is present (true), every one absent (false), or neither (throws). */
async function applied016(tx) {
  const [row] = await tx`select
      pg_catalog.to_regprocedure(${V2}) is not null as v2, pg_catalog.to_regprocedure(${HOLD}) is not null as hold,
      pg_catalog.to_regclass('tmpos_session.tenant_grant_version') is not null as grant_table,
      exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.store'::regclass and attname = 'access_version'
               and not attisdropped) as store_column,
      (select pg_catalog.count(*)::int from pg_catalog.pg_trigger where tgname in
        ('trg_tenant_access_version', 'trg_store_access_version', 'trg_user_membership_tenant_grant_version',
         'trg_tenant_tenant_grant_version', 'trg_store_tenant_grant_version')) = 5 as triggers`;
  const values = Object.values({ ...row });
  assert.ok(values.every((v) => v === values[0]), `016 is wholly present or wholly absent: ${JSON.stringify(row)}`);
  return values[0];
}

test('M5A-14: 016 as applied — its column, table, triggers and routines exactly as declared — and its chain contiguous both ways', async () => {
  const [column] = await owner`select a.atttypid::regtype::text as type, a.attnotnull as not_null,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid) as dflt,
      (select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
        where c.conrelid = 'public.store'::regclass and c.conname = 'store_access_version_chk') as chk
    from pg_catalog.pg_attribute a join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.store'::regclass and a.attname = 'access_version' and not a.attisdropped`;
  assert.deepEqual([column.type, column.not_null, column.dflt], ['bigint', true, '1'], 'store.access_version: bigint, not null, default 1');
  assert.match(String(column.chk), /access_version >= 1/);

  // Five triggers, each ENABLE ALWAYS with no column list and no WHEN: BEFORE ROW UPDATE (19) on the tenant and BEFORE ROW
  // INSERT or UPDATE (23) on the store; AFTER ROW INSERT, UPDATE and DELETE (29) on the grant and AFTER ROW DELETE (9) on the
  // tenant and the store — and no other trigger calls either function.
  const triggers = await owner`select n.nspname::text || '.' || c.relname::text as relation, g.tgname::text as name,
      g.tgtype::int as tgtype, g.tgenabled::text as enabled, p.proname::text as fn, g.tgattr::text as columns, g.tgqual is null as no_when
    from pg_catalog.pg_trigger g join pg_catalog.pg_class c on c.oid = g.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_proc p on p.oid = g.tgfoid
    where p.pronamespace = 'tmpos_session'::regnamespace order by g.tgname`;
  assert.deepEqual(triggers.map((r) => ({ ...r })), [
    { relation: 'public.store', name: 'trg_store_access_version', tgtype: 23, enabled: 'A', fn: 'm5_access_version_moved', columns: '', no_when: true },
    { relation: 'public.store', name: 'trg_store_tenant_grant_version', tgtype: 9, enabled: 'A', fn: 'm5_tenant_grant_moved', columns: '', no_when: true },
    { relation: 'public.tenant', name: 'trg_tenant_access_version', tgtype: 19, enabled: 'A', fn: 'm5_access_version_moved', columns: '', no_when: true },
    { relation: 'public.tenant', name: 'trg_tenant_tenant_grant_version', tgtype: 9, enabled: 'A', fn: 'm5_tenant_grant_moved', columns: '', no_when: true },
    { relation: 'public.user_membership', name: 'trg_user_membership_tenant_grant_version', tgtype: 29, enabled: 'A', fn: 'm5_tenant_grant_moved', columns: '', no_when: true },
  ]);

  const routines = await owner`select p.proname::text as name, p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig,
      p.prorettype::regtype::text as returns, p.proowner = n.nspowner as schema_owner
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tmpos_session'
      and p.proname in ('m5_access_version_moved', 'm5_tenant_grant_moved', 'm5_admit_tenant_session_v2', 'm5_hold_tenant_standing')
    order by p.proname`;
  const pinned = ['search_path=pg_catalog, pg_temp'];
  assert.deepEqual(routines.map((r) => ({ ...r })), [
    // SECURITY INVOKER: it reads no relation, only the row it is handed (008's row-version trigger is the same).
    { name: 'm5_access_version_moved', definer: false, volatility: 'v', proconfig: pinned, returns: 'trigger', schema_owner: true },
    // STABLE is load-bearing: 007's read, the joins and both counters on one snapshot.
    { name: 'm5_admit_tenant_session_v2', definer: true, volatility: 's', proconfig: pinned, returns: 'record', schema_owner: true },
    { name: 'm5_hold_tenant_standing', definer: true, volatility: 'v', proconfig: pinned, returns: 'text', schema_owner: true },
    { name: 'm5_tenant_grant_moved', definer: true, volatility: 'v', proconfig: pinned, returns: 'trigger', schema_owner: true },
  ]);

  // The grant version: no foreign key (the counter outlives the account), row security on and not forced, no grant.
  const constraints = await owner`select conname::text as name, contype::text as kind from pg_catalog.pg_constraint
    where conrelid = 'tmpos_session.tenant_grant_version'::regclass order by conname`;
  assert.deepEqual(constraints.map((r) => [r.name, r.kind]), [['tenant_grant_version_pkey', 'p'], ['tenant_grant_version_range_chk', 'c']]);
  const [rls] = await owner`select relrowsecurity, relforcerowsecurity from pg_catalog.pg_class where oid = 'tmpos_session.tenant_grant_version'::regclass`;
  assert.deepEqual({ ...rls }, { relrowsecurity: true, relforcerowsecurity: false });

  // EXECUTE reaches tmpos_app on the read and the hold, and nobody on anything else.
  for (const [routine, app] of [[V2, true], [HOLD, true], ['tmpos_session.m5_access_version_moved()', false], ['tmpos_session.m5_tenant_grant_moved()', false]]) {
    for (const role of ['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated', 'public']) {
      const [{ may }] = await owner`select pg_catalog.has_function_privilege(${role}, ${routine}, 'EXECUTE') as may`;
      assert.equal(may, app && role === 'tmpos_app', `${role} on ${routine}`);
    }
  }
  // And the runtime login is refused every direct path 016 could have opened.
  for (const statement of ['select count(*) from tmpos_session.tenant_grant_version',
    "insert into tmpos_session.tenant_grant_version values ('00000000-0000-4000-8000-000000000001', 1)",
    'select tmpos_session.m5_tenant_grant_moved()',
    'update public.store set access_version = 9',
    "update public.store set status = 'suspended'",
    'delete from public.store']) {
    assert.equal(await runtime.unsafe(statement).then(() => null, (err) => err.code), '42501', `the runtime role is refused: ${statement}`);
  }

  // CONTIGUITY. 011's rollback cannot run beneath 016 (its schema is dropped WITHOUT CASCADE); 016 refuses without 015;
  // the chain re-applies in order; a second rollback fails at its first drop, having changed nothing.
  await rolledBack(async (tx) => {
    const code = refusalIn(tx);
    await tx`delete from tmpos_session.session`;
    const beneath = await code((sp) => sp.unsafe(DOWN_011).simple());
    assert.equal(beneath?.code, '2BP01', `011's rollback refuses beneath 016: ${beneath?.message}`);
    assert.equal(await applied016(tx), true, 'and changed nothing');
    await tx.unsafe(DOWN_016).simple();
    assert.equal(await applied016(tx), false, 'the rollback removes every object 016 created');
    const [kept] = await tx`select pg_catalog.has_function_privilege('tmpos_app', 'tmpos_session.m5_admit_tenant_session(text, text)', 'EXECUTE') as v1,
        (select pg_catalog.count(*)::int from pg_catalog.pg_proc where pronamespace = 'tmpos_session'::regnamespace) as routines`;
    assert.deepEqual({ ...kept }, { v1: true, routines: 6 }, '011\'s six routines stay, its admission read still granted');
    await tx.unsafe(DOWN_015).simple();
    const without015 = await code((sp) => sp.unsafe(UP_016).simple());
    assert.equal(without015?.code, '55000');
    assert.match(without015.message, /migration 016 refused: migration 015 must be applied first/);
    await tx.unsafe(UP_015).simple();
    await tx.unsafe(UP_016).simple();
    assert.equal(await applied016(tx), true, '015 then 016 re-apply');
    await tx.unsafe(DOWN_016).simple();
    assert.equal((await code((sp) => sp.unsafe(DOWN_016).simple()))?.code, '42704', 'a second rollback fails at its first drop');
    assert.equal(await applied016(tx), false);
  });
  assert.equal(await applied016(owner), true, 'the shared state is untouched');
});

test('M5A-15: 016\'s up and its rollback each refuse while a TENANT session exists — an administrative one blocks neither — because a re-application restarts every version', async () => {
  const at = SESSION_CONTRACT_EPOCH;
  const live = (tx, audience) => tx`select tmpos_session.m5_session_create(${`m5a-016-${audience}-${randomUUID()}`}::text, ${audience}::text,
    'firebase'::text, ${TENANT_ACTOR.uid}::text, ${`pk-016-${SUFFIX}`}::text, 't2:probe'::text,
    ${at}::bigint, ${at}::bigint, ${at}::bigint, ${at}::bigint, ${at + 3_600_000}::bigint) as created`;
  await rolledBack(async (tx) => {
    await tx`delete from tmpos_session.session`;
    await live(tx, 'tenant');
    const refused = await refusalIn(tx)((sp) => sp.unsafe(DOWN_016).simple());
    assert.equal(refused?.code, '55000', 'object_not_in_prerequisite_state');
    assert.match(refused.message, /migration 016 rollback refused: 1 tenant session row\(s\) remain/);
    assert.equal(await applied016(tx), true, 'the refused rollback dropped nothing');
  });
  await rolledBack(async (tx) => {
    await tx`delete from tmpos_session.session`;
    await live(tx, 'admin');
    await tx.unsafe(DOWN_016).simple();
    assert.equal(await applied016(tx), false, 'an administrative session does not block the rollback');
    // A login that read its witness before the rollback commits its row in the gap: the re-application refuses too.
    await live(tx, 'tenant');
    const refused = await refusalIn(tx)((sp) => sp.unsafe(UP_016).simple());
    assert.equal(refused?.code, '55000');
    assert.match(refused.message, /migration 016 refused: 1 tenant session row\(s\) exist/);
    assert.equal(await applied016(tx), false, 'and the refused up created nothing');
    await tx`delete from tmpos_session.session where audience = 'tenant'`;
    await tx.unsafe(UP_016).simple();
    assert.equal(await applied016(tx), true, 're-applied beside the administrative session');
    // WHY: every store version restarted at 1 and every grant version at 0, so a witness bound before could be met again.
    const [restart] = await tx`select (select pg_catalog.max(access_version)::int from public.store) as store_max,
      (select pg_catalog.count(*)::int from tmpos_session.tenant_grant_version) as grant_rows`;
    assert.deepEqual({ ...restart }, { store_max: 1, grant_rows: 0 });
  });
});

test('M5A-16: every status change of a tenant or a store, and every move of a store to another tenant, moves its access version by exactly one — 010\'s command, a raw write, a replica — a store starts at one whatever its INSERT names, and nothing else may move it', async () => {
  const tenant = await newTenant('av-tenant');
  const store = await newStore(tenant, 'av-store');
  // The runtime keeps 005's INSERT on public.store: an INSERT naming the bound is stored at 1, or the store's first
  // suspension would raise (22003) for good. Inside the runtime's own tenant context, rolled back.
  let named = null;
  await assert.rejects(runtime.begin(async (sql) => {
    await sql`select pg_catalog.set_config('app.tenant_id', ${tenant}, true), pg_catalog.set_config('app.scope_type', 'tenant', true)`;
    [{ access_version: named }] = await sql`insert into public.store (tenant_id, store_name, access_version)
      values (${tenant}, ${`m5a-av-runtime-${SUFFIX}`}, ${'9007199254740991'}::bigint) returning access_version`;
    throw ROLLBACK_016;
  }), (err) => err === ROLLBACK_016);
  assert.equal(Number(named), 1, 'the runtime\'s INSERT naming the bound is stored at 1');
  await rolledBack(async (tx) => {
    const now = async () => {
      const [r] = await tx`select t.access_version as tenant, t.row_version as row, s.access_version as store
        from public.tenant t join public.store s on s.tenant_id = t.tenant_id where t.tenant_id = ${tenant} and s.store_id = ${store}`;
      return [Number(r.tenant), Number(r.row), Number(r.store)];
    };
    assert.deepEqual(await now(), [1, 1, 1]);
    // 010's command sets the version to itself plus one with the status, and the trigger assigns the same value: +1 exactly.
    const [{ o_outcome: suspended }] = await tx`select o_outcome from tmpos_command.m5_tenant_status_change(${tenant}::uuid, 1::bigint, 'active'::text, 'suspended'::text)`;
    assert.equal(suspended, 'applied');
    assert.deepEqual(await now(), [2, 2, 1], '010: access +1, row +1, the store untouched');
    // A raw owner write — outside 010's command — moves it too now, and 008's row version still once.
    await tx`update public.tenant set status = 'active' where tenant_id = ${tenant}`;
    assert.deepEqual(await now(), [3, 3, 1], 'raw reactivation: +1, never back');
    // A status write that names its own version gets old + 1 regardless, as 008 overwrites a named row_version.
    await tx`update public.tenant set status = 'read_only', access_version = 99 where tenant_id = ${tenant}`;
    assert.deepEqual(await now(), [4, 4, 1]);
    // A rename, or a status written to itself, moves no access version.
    await tx`update public.tenant set display_name = ${`m5a-av-renamed-${SUFFIX}`}, status = status where tenant_id = ${tenant}`;
    assert.deepEqual(await now(), [4, 5, 1], 'rename: the row version moves, the access version does not');
    // The store: the same rule on 016's column.
    await tx`update public.store set status = 'suspended' where store_id = ${store}`;
    await tx`update public.store set status = 'active', store_name = ${`m5a-av-store-${SUFFIX}`} where store_id = ${store}`;
    await tx`update public.store set store_name = ${`m5a-av-store2-${SUFFIX}`} where store_id = ${store}`;
    assert.deepEqual(await now(), [4, 5, 3], 'store suspend and reactivate: +1 each; a rename: nothing');
    // Nothing else may move either version, not even the owner: the trigger refuses it (check_violation).
    for (const [what, write] of [
      ['a tenant version reset', (sp) => sp`update public.tenant set access_version = 1 where tenant_id = ${tenant}`],
      ['a tenant version raised', (sp) => sp`update public.tenant set access_version = access_version + 10 where tenant_id = ${tenant}`],
      ['a store version reset', (sp) => sp`update public.store set access_version = 1 where store_id = ${store}`],
    ]) {
      assert.equal((await refusalIn(tx)(write))?.code, '23514', `${what} is refused`);
    }
    // ALWAYS: a session running as a replica moves it too, and is refused the direct write too.
    await tx`set local session_replication_role = replica`.catch((err) => {
      throw new Error(`M5A-16 needs an owner that may set session_replication_role, and this one may not: ${err.message}`);
    });
    await tx`update public.tenant set status = 'active' where tenant_id = ${tenant}`;
    await tx`update public.store set status = 'read_only' where store_id = ${store}`;
    assert.deepEqual(await now(), [5, 6, 4], 'replica mode: tenant +1, store +1');
    assert.equal((await refusalIn(tx)((sp) => sp`update public.store set access_version = 7 where store_id = ${store}`))?.code, '23514',
      'and the direct write is refused as a replica too');
    await tx`set local session_replication_role = origin`;

    const storeAt = async (id) => Number((await tx`select access_version from public.store where store_id = ${id}`)[0].access_version);
    const tenantAt = async (id) => Number((await tx`select access_version from public.tenant where tenant_id = ${id}`)[0].access_version);
    // An owner's INSERT, and a replica's, start at 1 too, whatever they name; the first status change then moves it to 2.
    for (const [mode, version] of [['origin', '9007199254740991'], ['origin', '5'], ['replica', '9007199254740991']]) {
      await tx.unsafe(`set local session_replication_role = ${mode}`);
      const [{ store_id: fresh }] = await tx`insert into public.store (tenant_id, store_name, access_version)
        values (${tenant}, ${`m5a-av-named-${mode}-${version}-${SUFFIX}`}, ${version}::bigint) returning store_id`;
      assert.equal(await storeAt(fresh), 1, `${mode}: an INSERT naming ${version} is stored at 1`);
      await tx`update public.store set status = 'suspended' where store_id = ${fresh}`;
      assert.equal(await storeAt(fresh), 2, `${mode}: its first status change moves it to 2, never past the bound`);
    }
    await tx`set local session_replication_role = origin`;

    // A store moved to another tenant and back: 007 drops its grants while it is away and returns them once it is back,
    // so each move is a change of standing — +1 each way, never back — in an ordinary session and as a replica.
    const [{ tenant_id: elsewhere }] = await tx`insert into public.tenant (display_name)
      values (${`m5a-av-elsewhere-${SUFFIX}`}) returning tenant_id`;
    const [tenantBefore, storeBefore] = [await tenantAt(tenant), await storeAt(store)];
    await tx`update public.store set tenant_id = ${elsewhere} where store_id = ${store}`;
    assert.equal(await storeAt(store), storeBefore + 1, 're-parented: +1');
    await tx`update public.store set tenant_id = ${tenant} where store_id = ${store}`;
    assert.equal(await storeAt(store), storeBefore + 2, 'and back: +1 again, never back');
    await tx`set local session_replication_role = replica`;
    await tx`update public.store set tenant_id = ${elsewhere} where store_id = ${store}`;
    await tx`update public.store set tenant_id = ${tenant} where store_id = ${store}`;
    assert.equal(await storeAt(store), storeBefore + 4, 'replica mode: +1 each way');
    await tx`set local session_replication_role = origin`;
    // The parent tenant's version moves for none of its store's changes; and a key never changes at all (M5A-16b).
    assert.equal(await tenantAt(tenant), tenantBefore, 'the tenant moved for none of its store\'s changes');
    // A key or parent written to itself moves nothing, so the version still refuses a direct change beside it.
    for (const [what, write] of [
      ['a store version beside a parent written to itself', (sp) => sp`update public.store set tenant_id = tenant_id, access_version = 99 where store_id = ${store}`],
      ['a tenant version beside a key written to itself', (sp) => sp`update public.tenant set tenant_id = tenant_id, access_version = 99 where tenant_id = ${tenant}`],
    ]) {
      assert.equal((await refusalIn(tx)(write))?.code, '23514', `${what} is refused`);
    }
  });
});

test('M5A-16b: a tenant\'s or a store\'s key never changes — refused at the rekey, in an ordinary session and as a replica — so no row inserted under the old key can bring a witness back', async () => {
  // THE SEQUENCE THIS CLOSES. As a replica no foreign key is checked and no cascade runs: the owner moves the row to a new
  // key, then inserts a row under the old one — for a store, a write tmpos_app itself may make (005 grants it INSERT).
  // The new row starts at one (a store) or at whatever its INSERT names (a tenant), so a grant still naming the old key
  // reads, from a row it was never admitted against, the version it was admitted at. Refused at the rekey instead.
  const tenant = await newTenant('rekey-tenant');
  const store = await newStore(tenant, 'rekey-store');
  const holder = await actor('rekey-actor', { scope: 'store', tenant, store, role: 'manager' });
  await rolledBack(async (tx) => {
    /** v2's whole answer for the actor a session on this store grant is bound to, as text. */
    const answer = async () => {
      const [row] = await tx`select * from tmpos_session.m5_admit_tenant_session_v2('firebase'::text, ${holder.uid}::text)`;
      return JSON.stringify({ ...row, memberships: typeof row.memberships === 'string' ? JSON.parse(row.memberships) : row.memberships });
    };
    const before = await answer();
    assert.deepEqual(JSON.parse(before).memberships.map((m) => [m.tenantAccessVersion, m.storeAccessVersion]), [['1', '1']],
      'both versions sit at 1, where a row inserted under either key would start');
    for (const [what, rekey, reinsert, refusal] of [
      ['store', (sp) => sp`update public.store set store_id = ${randomUUID()} where store_id = ${store}`,
        (sp) => sp`insert into public.store (store_id, tenant_id, status) values (${store}, ${tenant}, 'active')`,
        /a public\.store row's key never changes/],
      ['tenant', (sp) => sp`update public.tenant set tenant_id = ${randomUUID()} where tenant_id = ${tenant}`,
        (sp) => sp`insert into public.tenant (tenant_id, display_name, status, access_version)
          values (${tenant}, ${`m5a-rekey-again-${SUFFIX}`}, 'active', 1)`,
        /a public\.tenant row's key never changes/],
    ]) {
      for (const mode of ['replica', 'origin']) {
        await tx.unsafe(`set local session_replication_role = ${mode}`);
        const refused = await refusalIn(tx)(async (sp) => { await rekey(sp); await reinsert(sp); });
        await tx`set local session_replication_role = origin`;
        const after = await answer();
        assert.equal(refused?.code, '23514', `${what}, ${mode}: the rekey is refused (${refused === null
          ? `it and the INSERT under the old key committed, and v2 ${after === before ? 'answers byte-identically' : 'moved'}`
          : refused.message})`);
        assert.match(refused.message, refusal);
        assert.equal(after, before, `${what}, ${mode}: the refused attempt left v2's answer where it was`);
      }
    }
  });
});

test('M5A-17: every write to a TENANT- or STORE-scope grant, and every delete of a tenant or store one names, moves its actor\'s grant version — cascades, re-points and replicas included — and no other write does', async () => {
  const tenant = await newTenant('gv-tenant');
  const store = await newStore(tenant, 'gv-store');
  const a = await actor('gv-a', { scope: 'tenant', tenant, role: 'manager' });
  const b = await actor('gv-b', { scope: 'store', tenant, store, role: 'technician' });
  const p = await actor('gv-p', { scope: 'platform', role: 'system_owner' });
  await rolledBack(async (tx) => {
    const version = async (who) => Number((await tx`select coalesce((select grant_version from tmpos_session.tenant_grant_version
      where internal_user_id = ${who.id}), 0) as v`)[0].v);
    const versions = async () => [await version(a), await version(b), await version(p)];
    assert.deepEqual(await versions(), [1, 1, 0], 'each tenant or store grant\'s insert moved its actor once; a platform grant never');
    const [{ membership_id: grant }] = await tx`select membership_id from public.user_membership where internal_user_id = ${a.id}`;

    await tx`update public.user_membership set status = 'suspended' where membership_id = ${grant}`;
    await tx`update public.user_membership set status = 'active' where membership_id = ${grant}`;
    assert.deepEqual(await versions(), [3, 1, 0], 'disabled and re-enabled: +1 each, never back (DA-41)');
    await tx`update public.user_membership set updated_at = updated_at - interval '1 day' where membership_id = ${grant}`;
    await tx`update public.user_membership set status = status where membership_id = ${grant}`;
    assert.deepEqual(await versions(), [3, 1, 0], 'an updated_at-only or no-op update moves nothing');
    await tx`update public.user_membership set role_id = 'sales_staff' where membership_id = ${grant}`;
    assert.deepEqual(await versions(), [4, 1, 0], 're-roled: +1');
    await tx`update public.user_membership set internal_user_id = ${b.id} where membership_id = ${grant}`;
    assert.deepEqual(await versions(), [5, 2, 0], 're-pointed: the actor it left and the actor it names, each once');
    await tx`delete from public.user_membership where membership_id = ${grant}`;
    assert.deepEqual(await versions(), [5, 3, 0], 'removed: its actor +1');

    // Scope moves count on the side that is tenant or store scope, once per actor.
    const [{ membership_id: platformGrant }] = await tx`select membership_id from public.user_membership where internal_user_id = ${p.id}`;
    await tx`update public.user_membership set status = 'suspended' where membership_id = ${platformGrant}`;
    assert.deepEqual(await versions(), [5, 3, 0], 'a platform grant\'s write moves no grant version (013\'s version moves)');
    await tx`update public.user_membership set scope_type = 'tenant', tenant_id = ${tenant}, role_id = 'manager' where membership_id = ${platformGrant}`;
    assert.deepEqual(await versions(), [5, 3, 1], 'platform -> tenant: +1');
    await tx`update public.user_membership set scope_type = 'platform', tenant_id = null, role_id = 'system_owner' where membership_id = ${platformGrant}`;
    assert.deepEqual(await versions(), [5, 3, 2], 'tenant -> platform: +1');

    // Cascades fire it too: the store's removal takes B's store grant (and the grant re-pointed to B earlier went above).
    await tx`insert into public.user_membership (internal_user_id, tenant_id, scope_type, role_id) values (${a.id}, ${tenant}, 'tenant', 'technician')`;
    assert.deepEqual(await versions(), [6, 3, 2]);
    await tx`delete from public.store where store_id = ${store}`;
    assert.deepEqual(await versions(), [6, 4, 2], 'a store removed: every grant it cascades moves its actor');
    await tx`delete from public.tenant where tenant_id = ${tenant}`;
    assert.deepEqual(await versions(), [7, 4, 2], 'a tenant removed: likewise');
    await tx`insert into public.user_membership (internal_user_id, tenant_id, scope_type, role_id) values (${b.id}, ${TENANT_A}, 'tenant', 'technician')`;
    await tx`delete from public.app_user where internal_user_id = ${b.id}`;
    assert.deepEqual(await versions(), [7, 6, 2], 'an account removed: its grants cascade, and the counter outlives it (no foreign key)');

    // ALWAYS: a replica's write moves it too.
    await tx`set local session_replication_role = replica`;
    await tx`insert into public.user_membership (internal_user_id, tenant_id, scope_type, role_id) values (${a.id}, ${TENANT_B}, 'tenant', 'technician')`;
    await tx`set local session_replication_role = origin`;
    assert.deepEqual(await versions(), [8, 6, 2], 'replica mode: +1');
  });

  // A tenant or a store DELETED as a replica takes no grant with it — no cascade runs — so every grant naming it would
  // return with a row inserted again under its key. The delete itself moves each actor holding a tenant- or store-scope
  // grant that names it, whatever the grant's status, once per actor; nobody else moves.
  const t2 = await newTenant('gv-del-tenant');
  const s2 = await newStore(t2, 'gv-del-store');
  const t3 = await newTenant('gv-del-other');
  const s3 = await newStore(t3, 'gv-del-other');
  const c = await actor('gv-c', { scope: 'tenant', tenant: t2, role: 'manager' });
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${c.id}, ${t2}, ${s2}, 'store', 'technician', 'active')`;
  const d = await actor('gv-d', { scope: 'store', tenant: t2, store: s2, role: 'manager' });
  await owner`update user_membership set status = 'suspended' where internal_user_id = ${d.id}`;
  const e = await actor('gv-e', { scope: 'tenant', tenant: t3, role: 'manager' });
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${e.id}, ${t3}, ${s3}, 'store', 'technician', 'active')`;
  const q = await actor('gv-q', { scope: 'platform', role: 'system_owner' });
  await rolledBack(async (tx) => {
    const version = async (who) => Number((await tx`select coalesce((select grant_version from tmpos_session.tenant_grant_version
      where internal_user_id = ${who.id}), 0) as v`)[0].v);
    const versions = async () => [await version(c), await version(d), await version(e), await version(q)];
    const naming = async (tenantId) => (await tx`select count(*)::int as n from public.user_membership where tenant_id = ${tenantId}`)[0].n;
    assert.deepEqual(await versions(), [2, 2, 2, 0], 'two grants each for C and E, D\'s one grant inserted and suspended, Q platform-only');
    await tx`set local session_replication_role = replica`;
    await tx`delete from public.store where store_id = ${s2}`;
    assert.deepEqual(await versions(), [3, 3, 2, 0], 'a store deleted as a replica: each actor naming it +1, a suspended grant\'s too');
    await tx`delete from public.tenant where tenant_id = ${t2}`;
    assert.deepEqual(await versions(), [4, 4, 2, 0], 'a tenant deleted as a replica: each actor with a tenant or store grant naming it +1, once');
    assert.equal(await naming(t2), 3, 'no cascade ran: every grant naming it is still there');
    await tx`set local session_replication_role = origin`;
    // In an ordinary session the cascade takes the grants, each moving its actor, and the delete may move it again.
    await tx`delete from public.tenant where tenant_id = ${t3}`;
    const [cv, dv, ev, qv] = await versions();
    assert.deepEqual([cv, dv, qv], [4, 4, 0], 'nobody else moved');
    assert.ok(ev >= 3, `a tenant deleted in an ordinary session moves each actor naming it at least once (${ev})`);
    assert.equal(await naming(t3), 0, 'its grants cascaded');
  });
});

test('M5A-18: v2 answers 011\'s read plus each grant\'s store access version and the actor\'s two versions — to the runtime role — and RAISES on a store it cannot read', async () => {
  const COLUMNS = ['outcome', 'actor_id', 'account_status', 'limitation', 'security_version', 'memberships', 'authority_version', 'grant_version'];
  const KEYS = ['membershipId', 'roleId', 'scopeType', 'storeAccessVersion', 'storeId', 'storeStatus', 'tenantAccessVersion', 'tenantId', 'tenantStatus'];
  const DIGITS = /^[0-9]{1,19}$/;
  const read = async (who) => {
    const rows = await runtime`select * from tmpos_session.m5_admit_tenant_session_v2('firebase'::text, ${who}::text)`;
    assert.equal(rows.length, 1, 'one row, always');
    assert.deepEqual(Object.keys(rows[0]), COLUMNS);
    const row = { ...rows[0] };
    if (typeof row.memberships === 'string') row.memberships = JSON.parse(row.memberships);
    return row;
  };
  for (const who of [TENANT_ACTOR, STORE_ACTOR]) {
    const row = await read(who.uid);
    assert.deepEqual([row.outcome, row.actor_id], ['resolved', who.id]);
    assert.match(row.authority_version, DIGITS);
    assert.match(row.grant_version, DIGITS);
    assert.ok(Number(row.grant_version) >= 1, 'its tenant or store grant moved its grant version');
    for (const entry of row.memberships) {
      assert.deepEqual(Object.keys(entry).sort(), KEYS, 'nine keys: 007\'s seven, 011\'s tenant version and 016\'s store version');
      assert.equal(entry.storeAccessVersion === null, entry.storeId === null, 'a store version exactly when the grant names a store');
      if (entry.storeId !== null) {
        assert.match(entry.storeAccessVersion, DIGITS);
        const [{ v }] = await owner`select access_version::text as v from public.store where store_id = ${entry.storeId}`;
        assert.equal(entry.storeAccessVersion, v, 'the store\'s current access version');
      }
    }
  }
  const platform = await read(PLATFORM_ACTOR.uid);
  assert.deepEqual([platform.outcome, platform.grant_version], ['resolved', '0'], 'no tenant or store grant ever: grant version 0');
  const nobody = await read(`m5a-nobody-${SUFFIX}`);
  assert.deepEqual(nobody, { outcome: 'refused', actor_id: null, account_status: null, limitation: null, security_version: null,
    memberships: null, authority_version: null, grant_version: null }, 'every refusal is the one identical row');
  // 011's read is unchanged beside it: eight keys, no store version.
  const [v1] = await runtime`select memberships from tmpos_session.m5_admit_tenant_session('firebase'::text, ${STORE_ACTOR.uid}::text)`;
  const v1Entries = typeof v1.memberships === 'string' ? JSON.parse(v1.memberships) : v1.memberships;
  assert.deepEqual(Object.keys(v1Entries[0]).sort(), KEYS.filter((k) => k !== 'storeAccessVersion'));

  // The drift 011 guards for tenants, for a store: v2's owner is moved, inside a rolled-back transaction, to a role that
  // sees every tenant row (a policy for it alone) but is subject to the store's row security with no policy — so 007
  // still resolves the store grant, and v2 finds no store version. A refusal would end every session the principal
  // holds; a raise is an outage.
  const blind = `m5a_blind_store_${SUFFIX.replace(/-/g, '')}`;
  await rolledBack(async (tx) => {
    await tx.unsafe(`create role ${blind} nologin`);
    await tx.unsafe(`grant usage on schema public, tmpos_identity, tmpos_admission, tmpos_session to ${blind}`);
    await tx.unsafe(`grant select on public.tenant, public.store, tmpos_admission.platform_authority_version, tmpos_session.tenant_grant_version to ${blind}`);
    await tx.unsafe(`grant execute on function tmpos_identity.m5_resolve_principal(text, text) to ${blind}`);
    await tx.unsafe(`create policy m5a_blind_tenant on public.tenant for select to ${blind} using (true)`);
    await tx.unsafe(`alter function ${V2} owner to ${blind}`);
    const outcome = (who) => tx`select outcome from tmpos_session.m5_admit_tenant_session_v2('firebase'::text, ${who}::text)`;
    assert.equal((await outcome(TENANT_ACTOR.uid))[0].outcome, 'resolved', 'a tenant grant, whose version it can read, answers');
    assert.equal((await outcome(`m5a-nobody-${SUFFIX}`))[0].outcome, 'refused');
    const raised = await refusalIn(tx)((sp) => sp`select outcome from tmpos_session.m5_admit_tenant_session_v2('firebase'::text, ${STORE_ACTOR.uid}::text)`);
    assert.equal(raised?.code, '42501', 'insufficient_privilege, never the refusal the boundary would mass-revoke on');
    assert.match(raised.message, /store grant\(s\) carry no store access version/);
  });
});

test('M5A-19: the hold locks the actor\'s account FOR UPDATE and its links, grants, tenants and stores FOR SHARE until COMMIT — nothing else — and answers absent without an anchor or an account', async () => {
  const tenant = await newTenant('hold-tenant');
  const unnamed = await newTenant('hold-unnamed');
  const store = await newStore(tenant, 'hold-store');
  const holder = await actor('hold-actor', { scope: 'store', tenant, store, role: 'manager' });
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${holder.id}, ${tenant}, null, 'tenant', 'store_owner', 'active')`;
  // One identity link: 004 references an anchor of each provider.
  const supabaseUid = `m5a-hold-sb-${SUFFIX}`;
  await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('supabase', ${supabaseUid})`;
  const [{ link_id: link }] = await owner`insert into identity_link (internal_user_id, firebase_auth_provider_uid, supabase_auth_provider_uid)
    values (${holder.id}, ${holder.uid}, ${supabaseUid}) returning link_id`;
  const grants = (await owner`select membership_id from user_membership where internal_user_id = ${holder.id} order by membership_id`)
    .map((r) => r.membership_id);
  assert.equal(grants.length, 2);

  // The hold, as the runtime role, in a transaction kept open until the probes below are done.
  const entered = deferred();
  const release = deferred();
  const holding = runtime.begin(async (sql) => {
    const [row] = await sql`select tmpos_session.m5_hold_tenant_standing('firebase'::text, ${holder.uid}::text) as held,
      pg_catalog.pg_backend_pid() as pid`;
    entered.resolve(row);
    await release.promise;
  });
  const { held, pid } = await entered.promise;
  /** A statement in its own owner transaction: its SQLSTATE, or null. Nothing it does is kept. */
  const probe = (text, params = []) => owner.begin(async (tx) => { await tx`set local lock_timeout = '200ms'`; await tx.unsafe(text, params); throw ROLLBACK_016; })
    .then(() => 'committed', (err) => (err === ROLLBACK_016 ? null : err.code));
  try {
    assert.equal(held, 'held');
    const locked = (await owner`select c.relname::text as rel from pg_catalog.pg_locks l join pg_catalog.pg_class c on c.oid = l.relation
      where l.pid = ${pid} and l.granted and l.mode = 'RowShareLock' and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      order by 1`).map((r) => r.rel);
    assert.deepEqual(locked, ['app_user', 'identity_link', 'store', 'tenant', 'user_membership'],
      'pg_locks: the holder took row locks (RowShareLock) on exactly these five tables');
    // The row modes, told apart by what a NOWAIT competitor is refused: FOR UPDATE refuses even FOR KEY SHARE; FOR SHARE
    // admits another FOR SHARE and refuses FOR NO KEY UPDATE.
    assert.equal(await probe('select 1 from public.app_user where internal_user_id = $1 for key share nowait', [holder.id]), '55P03',
      'the account is held FOR UPDATE');
    for (const [what, table, key, id] of [['the link', 'identity_link', 'link_id', link], ['grant 1', 'user_membership', 'membership_id', grants[0]],
      ['grant 2', 'user_membership', 'membership_id', grants[1]], ['the tenant', 'tenant', 'tenant_id', tenant], ['the store', 'store', 'store_id', store]]) {
      assert.equal(await probe(`select 1 from public.${table} where ${key} = $1 for share nowait`, [id]), null, `${what} admits another FOR SHARE`);
      assert.equal(await probe(`select 1 from public.${table} where ${key} = $1 for no key update nowait`, [id]), '55P03', `${what} is held FOR SHARE`);
    }
    assert.equal(await probe('select 1 from public.tenant where tenant_id = $1 for update nowait', [unnamed]), null, 'a tenant no grant names is free');
    assert.equal(await probe('select 1 from public.app_user where internal_user_id = $1 for update nowait', [TENANT_ACTOR.id]), null, 'another account is free');
    // Who waits for the COMMIT (lock_timeout 200ms: 55P03 means the write had to wait for the holder).
    for (const [what, text, params] of [
      ['010\'s status command', 'select * from tmpos_command.m5_tenant_status_change($1::uuid, (select row_version from public.tenant where tenant_id = $1), \'active\', \'suspended\')', [tenant]],
      ['a store status write', 'update public.store set status = \'read_only\' where store_id = $1', [store]],
      ['a grant inserted for the actor', 'insert into public.user_membership (internal_user_id, tenant_id, scope_type, role_id) values ($1, $2, \'tenant\', \'technician\')', [holder.id, unnamed]],
      ['a grant disabled', 'update public.user_membership set status = \'suspended\' where membership_id = $1', [grants[0]]],
      ['a link disabled', 'update public.identity_link set status = \'disabled\' where link_id = $1', [link]],
      ['an account write', 'update public.app_user set status = \'read_only\' where internal_user_id = $1', [holder.id]],
    ]) {
      assert.equal(await probe(text, params), '55P03', `${what} waits for the login's COMMIT`);
    }
    // A reader never waits: v2 takes no lock.
    assert.equal((await owner`select outcome from tmpos_session.m5_admit_tenant_session_v2('firebase'::text, ${holder.uid}::text)`)[0].outcome, 'resolved');
  } finally {
    release.resolve();
    await holding;
  }
  assert.equal(await probe('select 1 from public.app_user where internal_user_id = $1 for update nowait', [holder.id]), null, 'released at COMMIT');

  const anchorOnly = `m5a-hold-no-account-${SUFFIX}`;
  await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${anchorOnly})`;
  const [answers] = await runtime`select tmpos_session.m5_hold_tenant_standing('firebase'::text, ${`m5a-nobody-${SUFFIX}`}::text) as nobody,
    tmpos_session.m5_hold_tenant_standing('firebase'::text, ${anchorOnly}::text) as anchor_only`;
  assert.deepEqual({ ...answers }, { nobody: 'absent', anchor_only: 'absent' }, 'no anchor, or an anchor with no account: absent');
});

test('M5A-20: 016 refuses to apply over FORCEd row security, and its postcondition refuses every widening, a membership of its owner and a weakened trigger', async () => {
  const [{ owner_name: ownerName }] = await owner`select current_user::text as owner_name`;
  // [label, the widening, whether the whole up runs (016 rolled back first) or its postcondition alone, the refusal]
  const cases = [
    ['row security FORCEd on public.store', 'alter table public.store force row level security', true, /forces row level security on its owner/],
    ['row security FORCEd on public.user_membership', 'alter table public.user_membership force row level security', true, /forces row level security on its owner/],
    ['a default privilege granting the runtime role new tables', 'alter default privileges grant select on tables to tmpos_app', true, /tenant_grant_version carries a direct grant/],
    ['a default privilege granting the audit writer new routines', 'alter default privileges grant execute on functions to tmpos_audit_writer', true, /unexpected direct grant remains on a routine/],
    ['a predefined role handing the audit writer every table', 'grant pg_read_all_data to tmpos_audit_writer', true, /tmpos_audit_writer holds an effective privilege on tmpos_session\.tenant_grant_version/],
    ['the runtime role made a member of the owner', `grant "${ownerName}" to tmpos_app`, true, /tmpos_app is a member of an owner/],
    ['EXECUTE on the hold to the audit writer', `grant execute on function ${HOLD} to tmpos_audit_writer`, false, /unexpected direct grant remains on a routine/],
    ['a grantable EXECUTE on v2', `grant execute on function ${V2} to tmpos_app with grant option`, false, /unexpected direct grant remains on a routine/],
    ['EXECUTE on a trigger function to PUBLIC', 'grant execute on function tmpos_session.m5_tenant_grant_moved() to public', false, /unexpected direct grant remains on a routine/],
    ['UPDATE of store.status to tmpos_app', 'grant update (status) on public.store to tmpos_app', false, /store lifecycle column carries a direct grant/],
    ['UPDATE of every store column to authenticated', 'grant update on public.store to authenticated', false, /may write a lifecycle column directly/],
    ['DELETE of store rows to tmpos_app', 'grant delete on public.store to tmpos_app', false, /may delete a tenant or store row/],
    ['the store trigger disabled', 'alter table public.store disable trigger trg_store_access_version', false, /version triggers are not exactly the five/],
    ['the grant trigger enabled for origin sessions only', 'alter table public.user_membership enable trigger trg_user_membership_tenant_grant_version', false, /version triggers are not exactly the five/],
    ['the tenant delete trigger enabled for origin sessions only', 'alter table public.tenant enable trigger trg_tenant_tenant_grant_version', false, /version triggers are not exactly the five/],
    ['row security off on the grant version', 'alter table tmpos_session.tenant_grant_version disable row level security', false, /row level security is not enabled/],
    ['an eleventh routine in the schema', 'create function tmpos_session.m5a_extra() returns integer language sql as $$ select 1 $$', false, /six routines and this file's four/],
    ['one of 011\'s routines replaced by an overload of another', 'drop function tmpos_session.m5_session_touch(text, text, bigint); '
      + 'create function tmpos_session.m5_session_get(text) returns integer language sql as $$ select 1 $$', false, /six routines and this file's four/],
    ['EXECUTE on one of 011\'s routines to PUBLIC', 'grant execute on function tmpos_session.m5_session_get(text, bigint) to public', false, /unexpected direct grant remains on a routine/],
    // A SET-only membership: has_column_privilege does not follow it, SET ROLE does, and so does the postcondition.
    ['a store writer the runtime role can SET ROLE to', `create role m5a_writer_${SUFFIX.replace(/-/g, '')} nologin; `
      + `grant update, delete on public.store to m5a_writer_${SUFFIX.replace(/-/g, '')}; `
      + `grant m5a_writer_${SUFFIX.replace(/-/g, '')} to tmpos_app with inherit false, set true`, false, /may write a lifecycle column directly/],
    // The paths around a version the triggers do not move: a key, a new tenant, a truncation, a trigger of one's own.
    ['UPDATE of store.store_id to tmpos_app', 'grant update (store_id) on public.store to tmpos_app', false, /tmpos_app:public\.store\.store_id:UPDATE/],
    ['INSERT of tenants to tmpos_app', 'grant insert on public.tenant to tmpos_app', false, /tmpos_app:public\.tenant:INSERT/],
    ['INSERT of one tenant column to authenticated', 'grant insert (display_name) on public.tenant to authenticated', false, /authenticated:public\.tenant:INSERT/],
    ['TRUNCATE of public.user_membership to tmpos_app', 'grant truncate on public.user_membership to tmpos_app', false, /tmpos_app:public\.user_membership:TRUNCATE/],
    ['TRIGGER on public.store to a role the runtime role can SET ROLE to', `create role m5a_trigger_${SUFFIX.replace(/-/g, '')} nologin; `
      + `grant trigger on public.store to m5a_trigger_${SUFFIX.replace(/-/g, '')}; `
      + `grant m5a_trigger_${SUFFIX.replace(/-/g, '')} to tmpos_app with inherit false, set true`, false, /m5a_trigger_\w+:public\.store:TRIGGER/],
  ];
  for (const [label, widen, whole, refusal] of cases) {
    await rolledBack(async (tx) => {
      await tx`delete from tmpos_session.session`;
      if (whole) await tx.unsafe(DOWN_016).simple();
      await tx.unsafe(widen).simple();
      const refused = await refusalIn(tx)((sp) => sp.unsafe(whole ? UP_016 : POSTCONDITION_016).simple());
      assert.equal(refused?.code, '55000', `${label}: ${refused?.message}`);
      assert.match(refused.message, refusal, label);
    });
  }
  // Control: over the state 016 left, its postcondition holds.
  await rolledBack(async (tx) => { assert.equal(await refusalIn(tx)((sp) => sp.unsafe(POSTCONDITION_016).simple()), null); });
  assert.equal(await applied016(owner), true, 'every case was rolled back');
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
