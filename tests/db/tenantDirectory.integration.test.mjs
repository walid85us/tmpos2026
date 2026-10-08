// Phase 4.0 M5-GIAM-D1-P3 — the platform tenant directory against REAL PostgreSQL: migration 012 (one gated read routine in
// its own schema), the adapter over the runtime's own non-owner login, and the Tenant Management page's whole server
// surface over real loopback sockets — the read route and the two existing commands, decided by the canonical platform
// authorizer, committed by the real store. M5-GIAM-D1-P4: the admin boundary is the durable pair — migration 013's
// admission, asked at login and on every request, and the authorizer deciding on the scope that admission selected — so
// an account that is not eligible, or holds no platform grant or two, is refused at the login itself. M5-ADMIN-REVOKE-P1:
// the store runs the production revalidator whole (009's locks, the presenting session held, 013's read of its standing)
// and the chain the production session store with the login's standing check, so the session a command carries is the
// durable row its transaction holds.
//
// DISPOSABLE ONLY. The target is resolveDisposableTarget's supplied DSN when CI binds one, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and
// randomly named, so the suite re-runs on the shared CI service, where earlier suites already applied 001-018 and left tenants
// of their own: every directory assertion is made against the owner's own ordered read of the whole table, never a count this
// suite assumes. Every rollback and refusal proof runs inside one transaction that is rolled back.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

import { resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresTransactionalStore } from '../../server/persistence/postgresTransactionalStore.ts';
import {
  createPostgresPrincipalResolver, lockPlatformAuthority, revalidatePlatformAuthority,
} from '../../server/persistence/postgresPrincipalResolver.ts';
import { createPostgresPlatformAdmission, readPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';
import { createPostgresSessionStore, holdAdministrativeSession } from '../../server/persistence/postgresSessionStore.ts';
import { createPostgresTenantDirectory } from '../../server/persistence/postgresTenantDirectory.ts';
import { TENANT_DISPLAY_NAME_MUTATOR } from '../../server/persistence/tenantDisplayNameMutator.ts';
import { TENANT_STATUS_MUTATOR } from '../../server/persistence/tenantStatusMutator.ts';
import {
  createAdmittedPlatformAuthorizer, createPlatformContextRevalidator, createPlatformEstablishCheck, createPlatformPermits,
  createPlatformSessionAdmission,
} from '../../server/composition/platformAuthorization.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { TEST_IDEMPOTENCY_KEY } from '../../server/runtime/idempotencyStore.testkit.ts';
import { selectScope } from '../../server/runtime/principals.ts';
import { testRequestLimits } from '../../server/runtime/rateLimiter.testkit.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { TENANT_DISPLAY_NAME_EVENTS, TENANT_DISPLAY_NAME_PATH, TENANT_DISPLAY_NAME_ROUTE } from '../../server/runtime/tenantDisplayName.ts';
import { TENANT_STATUS_EVENTS, TENANT_STATUS_PATH, TENANT_STATUS_ROUTE } from '../../server/runtime/tenantStatus.ts';
import { TENANT_DIRECTORY_PATH, createTenantDirectoryRoute, decodeTenantCursor, encodeTenantCursor } from '../../server/runtime/tenantDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_012 = readFileSync(`${MIG_DIR}/012_m5_platform_tenant_directory.up.sql`, 'utf8');
const DOWN_012 = readFileSync(`${MIG_DIR}/012_m5_platform_tenant_directory.down.sql`, 'utf8');
const DOWN_011 = readFileSync(`${MIG_DIR}/011_m5_tenant_admission.down.sql`, 'utf8');
const DOWN_016 = readFileSync(`${MIG_DIR}/016_m5_tenant_session_ordering.down.sql`, 'utf8');
/** 012's section 4 postcondition, run again on its own after a deliberate widening, to prove it refuses. */
const POSTCONDITION_012 = UP_012.slice(UP_012.lastIndexOf('do $$'));
const ROUTINE = 'tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5t-migrator', runtimeRef: 'm5t-runtime' };
const LOCK_KEY = 528_512;
const NOW = () => new Date().toISOString();

const RUNTIME_LOGIN = 'tmpos_m5t_probe';
const SUFFIX = randomUUID().slice(0, 8);
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const REASON = 'Synthetic lifecycle proof for the directory suite.';
const signal = () => AbortSignal.timeout(10_000);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M5T');
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
const owner = connect(undefined, 2);
let runtime = null;
let client = null;

test.after(async () => {
  if (client) await client.end();
  if (runtime) await runtime.end({ timeout: 5 });
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: real migrations, a real non-owner principal, synthetic identities
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
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 120_000,
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

client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 6, idle_timeout: 0, user: RUNTIME_LOGIN,
});
// The production revalidator, composed exactly as productionTransactions.ts composes it (M5-ADMIN-REVOKE-P1).
const store = createPostgresTransactionalStore({
  client, mutators: [TENANT_DISPLAY_NAME_MUTATOR, TENANT_STATUS_MUTATOR],
  revalidate: createPlatformContextRevalidator({
    authority: revalidatePlatformAuthority, session: (sql, key) => holdAdministrativeSession(sql, key, Date.now()), read: readPlatformAdmission,
  }),
});
/** The production session store over the same kernel, with the administrative login's standing check (M5-ADMIN-REVOKE-P1). */
const SESSIONS = createPostgresSessionStore({
  client, standing: createPlatformEstablishCheck({ read: readPlatformAdmission, authority: lockPlatformAuthority }),
});
const principals = createPostgresPrincipalResolver({ client });
const directory = createPostgresTenantDirectory({ client });

/** A synthetic actor: an identity, an account in `status`, and the given memberships. */
async function actor(label, memberships, status = 'active') {
  const uid = `m5t-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const newTenant = async (name) => (await owner`insert into tenant (display_name) values (${name}) returning tenant_id`)[0].tenant_id;
const tenantRow = async (id) => (await owner`select display_name, status, row_version from tenant where tenant_id = ${id}`)[0];
/** The directory as the owner sees it: every tenant, in 012's order. */
const ownerDirectory = async () => (await owner`select tenant_id from tenant order by created_at, tenant_id`).map((r) => r.tenant_id);
const refusalIn = (tx) => async (fn) => {
  try { await tx.savepoint(fn); return null; } catch (err) { return err.code ?? String(err.message); }
};

const [{ tenant_id: T_HOME }] = await owner`insert into tenant (display_name) values (${`m5t-home-${SUFFIX}`}) returning tenant_id`;
const [{ store_id: STORE }] = await owner`insert into store (tenant_id, store_name) values (${T_HOME}, ${`m5t-s-${SUFFIX}`}) returning store_id`;
const OWNER = await actor('owner', [{ scope: 'platform', role: 'system_owner' }]);
const OPS = await actor('ops', [{ scope: 'platform', role: 'operations_admin' }]);
const SUPPORT = await actor('support', [{ scope: 'platform', role: 'support_admin' }]);
const BILLING = await actor('billing', [{ scope: 'platform', role: 'billing_admin' }]);
const SECURITY = await actor('security', [{ scope: 'platform', role: 'security_admin' }]);
const READ_ONLY = await actor('read-only', [{ scope: 'platform', role: 'system_owner' }], 'read_only');
const SUSPENDED = await actor('suspended', [{ scope: 'platform', role: 'system_owner' }], 'suspended');
const TWO_GRANTS = await actor('two-grants', [{ scope: 'platform', role: 'system_owner' }, { scope: 'platform', role: 'support_admin' }]);
const TENANT_ONLY = await actor('tenant-only', [{ scope: 'tenant', tenant: T_HOME, role: 'store_owner' }]);
const STORE_ONLY = await actor('store-only', [{ scope: 'store', tenant: T_HOME, store: STORE, role: 'technician' }]);

/** The trusted scope the canonical authorizer would hand the read: resolved and selected by the real resolver. */
async function scopeOf(who) {
  const resolution = await principals.resolve(who.principal, signal());
  assert.equal(resolution.outcome, 'resolved', `${who.uid} resolves`);
  const selection = selectScope(resolution.principal, 'platform', { tenant: null, store: null });
  assert.equal(selection.outcome, 'selected');
  return selection.scope;
}
/** The routine called directly as the runtime login, with every argument explicit. */
const routine = (sql, s, after = null, limit = 51) => sql`select o_outcome, o_tenant_id, o_display_name, o_status, o_version
  from tmpos_directory.m5_tenant_directory_page(${s.actor}::uuid, ${s.securityVersion}::text, ${s.membershipId}::uuid, ${s.roleId}::text,
    ${after}::uuid, ${limit}::integer)`;

// ---------------------------------------------------------------------------
// migration 012 as applied
// ---------------------------------------------------------------------------

test('M5T-01: 001-029 apply clean; 012 is one STABLE SECURITY DEFINER routine in its own schema, reachable by tmpos_app alone', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024', '025', '026', '027', '028', '029'].map((v) => [v, false]));
  const routines = await owner`select p.proname, p.prosecdef, p.provolatile, p.proconfig
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_directory'::regnamespace`;
  assert.deepEqual(routines.map((r) => ({ ...r })), [{
    proname: 'm5_tenant_directory_page', prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, pg_temp'],
  }]);
  const [grants] = await owner`select
      pg_catalog.has_function_privilege('tmpos_app', ${ROUTINE}, 'EXECUTE') as app,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${ROUTINE}, 'EXECUTE') as audit_writer,
      pg_catalog.has_function_privilege('anon', ${ROUTINE}, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${ROUTINE}, 'EXECUTE') as authenticated,
      pg_catalog.has_function_privilege('public', ${ROUTINE}, 'EXECUTE') as public_role,
      pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_directory', 'USAGE') as app_usage,
      pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_directory', 'CREATE') as app_create,
      pg_catalog.has_schema_privilege('anon', 'tmpos_directory', 'USAGE') as anon_usage`;
  assert.deepEqual({ ...grants }, {
    app: true, audit_writer: false, anon: false, authenticated: false, public_role: false, app_usage: true, app_create: false, anon_usage: false,
  });
  // WHY 012 EXISTS: the runtime login sees no tenant row at all without a tenant context (005's policy) — and still sees none now.
  assert.equal((await runtime`select count(*)::int as n from public.tenant`)[0].n, 0, 'no platform-wide read through the table');
  const page = await routine(runtime, await scopeOf(OWNER));
  assert.ok(page.length > 0 && page.every((r) => r.o_outcome === 'tenant'), 'the routine is the one platform read');
});

test('M5T-02: the routine reads only on behalf of a live platform grant — every part of the authority is confirmed, and every failure is one answer', async () => {
  const own = await scopeOf(OWNER);
  const support = await scopeOf(SUPPORT);
  const denied = async (s, label) => {
    const rows = await routine(runtime, s);
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ o_outcome: 'denied', o_tenant_id: null, o_display_name: null, o_status: null, o_version: null }], label);
  };
  await denied({ ...own, securityVersion: 'f'.repeat(64) }, 'another security version');
  await denied({ ...own, membershipId: support.membershipId }, 'another actor\'s grant');
  await denied({ ...own, roleId: 'support_admin' }, 'another role on the right grant');
  await denied({ ...own, actor: randomUUID() }, 'an actor that does not exist');
  await denied({ ...own, actor: SUSPENDED.id }, 'a suspended account');
  const twoGrants = (await owner`select membership_id from user_membership where internal_user_id = ${TWO_GRANTS.id} order by membership_id`)[0].membership_id;
  await denied({ ...own, actor: TWO_GRANTS.id, membershipId: twoGrants }, 'two active platform grants are ambiguous');
  const tenantGrant = (await owner`select membership_id from user_membership where internal_user_id = ${TENANT_ONLY.id}`)[0].membership_id;
  await denied({ ...own, actor: TENANT_ONLY.id, membershipId: tenantGrant, roleId: 'store_owner' }, 'a tenant grant is no platform authority');
  // A read is not a write: an account limited to reads may still list, exactly as the authorizer's cap allows View.
  const readOnly = await scopeOf(READ_ONLY);
  assert.equal(readOnly.limitation, 'read_only');
  assert.ok((await routine(runtime, readOnly)).every((r) => r.o_outcome === 'tenant'), 'a read-only account reads');
  // A grant withdrawn AFTER its scope was selected is denied at the read.
  const late = await actor('late', [{ scope: 'platform', role: 'billing_admin' }]);
  const lateScope = await scopeOf(late);
  await owner`update user_membership set status = 'suspended' where internal_user_id = ${late.id}`;
  await denied(lateScope, 'a grant withdrawn between the authorizer and the read');
  // Malformed arguments are 'invalid' — a fault the adapter reports as an outage, never a verdict.
  for (const [label, s, limit] of [['limit 0', own, 0], ['limit 52', own, 52], ['a malformed role', { ...own, roleId: 'System Owner' }, 5]]) {
    assert.equal((await routine(runtime, s, null, limit))[0].o_outcome, 'invalid', label);
  }
});

test('M5T-03: pages walk the whole directory once, in 012\'s order, never repeating a tenant — across renames mid-walk', async () => {
  for (let i = 0; i < 9; i++) await newTenant(i === 4 ? null : `m5t-walk-${i}-${SUFFIX}`);
  const s = await scopeOf(BILLING);
  const expected = await ownerDirectory();
  const seen = [];
  let after = null;
  let pages = 0;
  for (;;) {
    const answer = await directory.page(s, { after, limit: 4 }, signal());
    assert.equal(answer.outcome, 'page');
    assert.ok(answer.tenants.length <= 4);
    seen.push(...answer.tenants.map((t) => t.tenantId));
    pages++;
    if (pages === 2) {
      // Between two pages: rename a tenant already seen AND one not yet seen. Order is by (created_at, tenant_id), which
      // neither moves, so no tenant repeats and none is skipped.
      const ahead = expected[Math.min(seen.length + 1, expected.length - 1)];
      await owner`update tenant set display_name = ${`m5t-renamed-${SUFFIX}`} where tenant_id = ${seen[0]}`;
      await owner`update tenant set display_name = ${`m5t-renamed-ahead-${SUFFIX}`} where tenant_id = ${ahead}`;
    }
    if (!answer.hasMore) break;
    after = answer.tenants.at(-1).tenantId;
  }
  assert.deepEqual(seen, expected, 'every tenant exactly once, in the owner\'s own order');
  assert.equal(new Set(seen).size, seen.length);
  // A tenant that never had a display name is listed with null, never an invented one.
  const [{ tenant_id: unnamed }] = await owner`select tenant_id from tenant where display_name is null order by created_at desc, tenant_id limit 1`;
  const at = expected.indexOf(unnamed);
  const around = await directory.page(s, { after: at === 0 ? null : expected[at - 1], limit: 1 }, signal());
  assert.deepEqual(around.tenants[0], { tenantId: unnamed, displayName: null, status: 'active', version: 1 });
  // A continuation naming no tenant is its own answer, never a restart.
  assert.deepEqual(await directory.page(s, { after: randomUUID(), limit: 5 }, signal()), { outcome: 'cursor_unknown' });
  // Tenants created in one transaction share created_at (now() is fixed per transaction), so only the id orders them.
  // Five in a row at three per page put a page boundary between two of them: each still comes back exactly once, in id order.
  const tied = await owner.begin(async (tx) => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await tx`insert into tenant (display_name) values (${`m5t-tie-${i}-${SUFFIX}`}) returning tenant_id`)[0].tenant_id);
    return ids;
  });
  const [{ n }] = await owner`select count(distinct created_at)::int as n from tenant where tenant_id in ${owner(tied)}`;
  assert.equal(n, 1, 'the five share one created_at');
  const walked = [];
  after = null;
  for (;;) {
    const answer = await directory.page(s, { after, limit: 3 }, signal());
    walked.push(...answer.tenants.map((t) => t.tenantId));
    if (!answer.hasMore) break;
    after = answer.tenants.at(-1).tenantId;
  }
  assert.deepEqual(walked, await ownerDirectory(), 'a tie never repeats or skips a tenant across a page boundary');
  assert.deepEqual(walked.filter((id) => tied.includes(id)), [...tied].sort(), 'tied tenants in id order');
});

// ---------------------------------------------------------------------------
// rollback, upgrade and the apply-time refusals — inside transactions that are rolled back
// ---------------------------------------------------------------------------

const ROLLBACK = new Error('m5t: roll the proof back');
async function rolledBack(fn) {
  await assert.rejects(owner.begin(async (tx) => { await fn(tx); throw ROLLBACK; }), (err) => err === ROLLBACK);
}

test('M5T-04: 012 rolls back exactly — its schema gone, 007-011 intact — and re-applies over existing rows', async () => {
  await rolledBack(async (tx) => {
    await tx.unsafe(DOWN_012).simple();
    const [gone] = await tx`select pg_catalog.to_regnamespace('tmpos_directory') is null as schema_gone,
      pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is not null as s011,
      pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is not null as s010,
      pg_catalog.to_regprocedure('tmpos_identity.m5_security_version(uuid)') is not null as s007`;
    assert.deepEqual({ ...gone }, { schema_gone: true, s011: true, s010: true, s007: true });
    await tx.unsafe(UP_012).simple();
    const [back] = await tx`select pg_catalog.has_function_privilege('tmpos_app', ${ROUTINE}, 'EXECUTE') as app`;
    assert.equal(back.app, true, 're-applied with its one grant');
  });
  assert.ok((await owner`select pg_catalog.to_regnamespace('tmpos_directory') is not null as present`)[0].present, 'the shared state is untouched');
});

test('M5T-05: 012 refuses to apply without 011 or over forced row security, and its postcondition refuses a widened grant or schema', async () => {
  await rolledBack(async (tx) => {
    const code = refusalIn(tx);
    await tx.unsafe(DOWN_012).simple();
    // 011's rollback refuses while any session row remains; earlier suites on the shared service may have left some. They go
    // only inside this transaction, which is rolled back.
    await tx.unsafe('delete from tmpos_session.session');
    // 016 lives in 011's schema, whose rollback drops it WITHOUT CASCADE: 016 comes off first, newest first (D4).
    await tx.unsafe(DOWN_016).simple();
    await tx.unsafe(DOWN_011).simple();
    assert.equal(await code((sp) => sp.unsafe(UP_012).simple()), '55000', 'without 011 it refuses before creating anything');
  });
  await rolledBack(async (tx) => {
    const code = refusalIn(tx);
    await tx.unsafe(DOWN_012).simple();
    await tx.unsafe('alter table public.tenant force row level security');
    assert.equal(await code((sp) => sp.unsafe(UP_012).simple()), '42501', 'forced row security would hide every row from the definer');
  });
  for (const [label, widen] of [
    ['EXECUTE to authenticated', `grant execute on function ${ROUTINE} to authenticated`],
    ['a grantable EXECUTE', `grant execute on function ${ROUTINE} to tmpos_app with grant option`],
    ['USAGE to anon', 'grant usage on schema tmpos_directory to anon'],
    ['CREATE to tmpos_app', 'grant create on schema tmpos_directory to tmpos_app'],
    ['a second routine', 'create function tmpos_directory.extra() returns integer language sql as $$ select 1 $$'],
  ]) {
    await rolledBack(async (tx) => {
      await tx.unsafe(widen);
      assert.equal(await refusalIn(tx)((sp) => sp.unsafe(POSTCONDITION_012).simple()), '55000', `the postcondition refuses ${label}`);
    });
  }
  // Control: over the state 012 left, its postcondition holds.
  await rolledBack(async (tx) => { assert.equal(await refusalIn(tx)((sp) => sp.unsafe(POSTCONDITION_012).simple()), null); });
});

test('M5T-06: migrations 005-011 are byte-identical to what this stage found', () => {
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
  };
  for (const [name, digest] of Object.entries(PINNED)) {
    assert.equal(createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex'), digest, name);
  }
});

// ---------------------------------------------------------------------------
// the Tenant Management page's server surface, over real loopback sockets
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
const errorOf = (reply) => JSON.parse(reply.body).error;

async function withChain(fn) {
  const everyone = [OWNER, OPS, SUPPORT, BILLING, SECURITY, READ_ONLY, SUSPENDED, TWO_GRANTS, TENANT_ONLY, STORE_ONLY];
  const tokens = new Map(everyone.map((who) => [`tok-${who.uid}`, who.uid]));
  tokens.set('tok-unknown', `m5t-unknown-${SUFFIX}`);
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness,
    log: { log: () => {} },
    routes: [TENANT_DISPLAY_NAME_ROUTE, TENANT_STATUS_ROUTE, createTenantDirectoryRoute({ tenantDirectory: directory, permits: createPlatformPermits() })],
    events: [...TENANT_DISPLAY_NAME_EVENTS, ...TENANT_STATUS_EVENTS],
    idempotency: { store: store.idempotency, keySecret: TEST_IDEMPOTENCY_KEY },
    transactions: { port: store.transactions },
    limits: testRequestLimits(),
    sessions: {
      admin: {
        trustedOrigins: [ADMIN_ORIGIN],
        verifier: {
          async verify(view) {
            const uid = tokens.get(view.bearerToken);
            return uid === undefined ? null : { verified: true, authProvider: 'firebase', authProviderUid: uid, authenticatedAt: Date.now(), secondFactor: 'totp' };
          },
        },
        admission: createPlatformSessionAdmission({ admission: createPostgresPlatformAdmission({ client }) }),
        authorizer: createAdmittedPlatformAuthorizer(),
        store: SESSIONS,
      },
    },
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  /** The admin login's raw reply for `who` (null: a verified reference naming nobody), with any `extra` headers on it. */
  const login = (who, extra = {}) => send(port, 'POST', sessionPaths('admin').login, {
    origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${who === null ? 'tok-unknown' : `tok-${who.uid}`}`, ...extra,
  });
  const signIn = async (who) => {
    const reply = await login(who);
    assert.equal(reply.status, 200, `admin login: ${reply.body}`);
    const cookie = (reply.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const csrf = JSON.parse(reply.body).csrfToken;
    const unsafe = { origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, [SESSION_CSRF_HEADER]: csrf, cookie, 'content-type': 'application/json' };
    return {
      list: (query = '', extra = {}) => send(port, 'GET', `${TENANT_DIRECTORY_PATH}${query}`, { cookie, ...extra }),
      rename: (body, key = randomUUID()) => send(port, 'PATCH', TENANT_DISPLAY_NAME_PATH, { ...unsafe, 'idempotency-key': key }, JSON.stringify(body)),
      status: (body, key = randomUUID()) => send(port, 'PATCH', TENANT_STATUS_PATH, { ...unsafe, 'idempotency-key': key }, JSON.stringify(body)),
    };
  };
  try {
    await fn({ port, signIn, login });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

/** The tenant's entry as the directory shows it to `session`, found by walking the pages. */
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

test('M5T-07: unauthenticated, unknown, tenant- and store-scoped callers are refused the directory with one generic answer', async () => {
  await withChain(async ({ port, login }) => {
    const anonymous = await send(port, 'GET', TENANT_DIRECTORY_PATH);
    assert.deepEqual([anonymous.status, errorOf(anonymous)], [401, 'unauthenticated']);
    const bodies = [];
    // M5-GIAM-D1-P4: durable admission refuses each of these at the login itself — the generic 401, no cookie — so none
    // holds a session that could reach the directory; the forged headers on the login change nothing.
    for (const [label, who] of [['no actor at all', null], ['a tenant-role holder', TENANT_ONLY], ['a store-role holder', STORE_ONLY],
      ['a suspended platform account', SUSPENDED], ['two platform grants', TWO_GRANTS]]) {
      const reply = await login(who, { 'x-tenant-id': T_HOME, 'x-role': 'system_owner', 'x-internal-user-id': OWNER.id });
      assert.deepEqual([reply.status, errorOf(reply), reply.headers['set-cookie']], [401, 'unauthenticated', undefined], label);
      bodies.push(Object.keys(JSON.parse(reply.body)).sort().join(','));
    }
    assert.deepEqual(new Set(bodies), new Set(['error,requestId']), 'every denial has the same shape: no hint of which part failed');
  });
});

test('M5T-08: View reads but cannot rename or suspend; Edit renames but cannot suspend; Manage does both — decided by the canonical catalog on the server', async () => {
  const tenant = await newTenant(`m5t-matrix-${SUFFIX}`);
  await withChain(async ({ signIn, login }) => {
    // M5-GIAM-D1-P4: an account limited to reads holds no administrative session at all — durable admission admits only
    // an 'active' or 'trialing' account — so the read-only System Owner is refused at the login, not capped to View.
    const readOnly = await login(READ_ONLY);
    assert.deepEqual([readOnly.status, errorOf(readOnly)], [401, 'unauthenticated'], 'a read-only account is refused at the login');
    for (const who of [BILLING, SECURITY]) {
      const session = await signIn(who);
      const { entry, actions } = await listed(session, tenant);
      assert.deepEqual(entry, { tenantId: tenant, displayName: `m5t-matrix-${SUFFIX}`, status: 'active', version: 1 }, `${who.uid} reads the tenant`);
      assert.deepEqual(actions, { editDisplayName: false, changeStatus: false }, `${who.uid}: View presents no command`);
      // The hidden commands, invoked anyway: the server refuses each, and nothing moves.
      const rename = await session.rename({ tenantId: tenant, displayName: 'Refused', expectedVersion: 1 });
      assert.deepEqual([rename.status, errorOf(rename)], [403, 'forbidden'], `${who.uid}: rename refused`);
      const suspend = await session.status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 1 });
      assert.deepEqual([suspend.status, errorOf(suspend)], [403, 'forbidden'], `${who.uid}: suspend refused`);
    }
    assert.deepEqual({ ...(await tenantRow(tenant)) }, { display_name: `m5t-matrix-${SUFFIX}`, status: 'active', row_version: '1' }, 'nothing moved');

    const support = await signIn(SUPPORT);
    assert.deepEqual((await listed(support, tenant)).actions, { editDisplayName: true, changeStatus: false }, 'Edit presents the rename only');
    const renamed = await support.rename({ tenantId: tenant, displayName: 'Renamed by Support', expectedVersion: 1 });
    assert.deepEqual([renamed.status, JSON.parse(renamed.body)], [200, { tenantId: tenant, displayName: 'Renamed by Support', version: 2 }]);
    const refused = await support.status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 2 });
    assert.deepEqual([refused.status, errorOf(refused)], [403, 'forbidden'], 'Edit cannot suspend');
    assert.deepEqual((await listed(support, tenant)).entry, { tenantId: tenant, displayName: 'Renamed by Support', status: 'active', version: 2 },
      'the directory shows the server-confirmed state and the version the next command takes');

    const ops = await signIn(OPS);
    assert.deepEqual((await listed(ops, tenant)).actions, { editDisplayName: true, changeStatus: true }, 'Manage presents both');
    const suspended = await ops.status({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion: 2 });
    assert.deepEqual([suspended.status, JSON.parse(suspended.body)], [200, { tenantId: tenant, status: 'suspended', version: 3 }]);
    assert.deepEqual((await listed(ops, tenant)).entry, { tenantId: tenant, displayName: 'Renamed by Support', status: 'suspended', version: 3 });
    const reactivated = await ops.status({ tenantId: tenant, status: 'active', reason: REASON, expectedVersion: 3 });
    assert.deepEqual([reactivated.status, JSON.parse(reactivated.body)], [200, { tenantId: tenant, status: 'active', version: 4 }]);
    // A version the directory showed before a change is stale: the command answers the sealed conflict, nothing moves.
    const stale = await ops.rename({ tenantId: tenant, displayName: 'Stale', expectedVersion: 2 });
    assert.deepEqual([stale.status, JSON.parse(stale.body)], [409, { error: 'write_conflict' }]);
    assert.equal((await tenantRow(tenant)).row_version, '4');
  });
});

test('M5T-09: the request can name no scope — a tenant id in the query is refused, headers are ignored — and malformed queries change nothing', async () => {
  const snapshot = async () => (await owner`select
      (select count(*)::int from public.tenant) as tenants,
      (select coalesce(sum(row_version), 0)::text from public.tenant) as versions,
      (select count(*)::int from public.audit_event) as audits,
      (select count(*)::int from tmpos_internal.outbox_event) as events,
      (select count(*)::int from tmpos_internal.idempotency_record) as records`)[0];
  await withChain(async ({ signIn }) => {
    const billing = await signIn(BILLING);
    const before = { ...(await snapshot()) };
    for (const query of [`?tenantId=${T_HOME}`, `?tenant=${T_HOME}`, '?scope=tenant', '?limit=0', '?limit=51', '?limit=x', '?cursor=abc',
      `?cursor=${encodeTenantCursor(T_HOME)}&cursor=${encodeTenantCursor(T_HOME)}`, '?limit=5&limit=5', '?']) {
      const reply = await billing.list(query);
      assert.deepEqual([reply.status, Object.keys(JSON.parse(reply.body)).sort()], [400, ['error', 'requestId']], query);
    }
    assert.deepEqual({ ...(await snapshot()) }, before, 'no tenant, version, audit record, event or idempotency record moved');
    // Headers naming another tenant or actor change nothing: the page is the platform directory, the same with or without them.
    const plain = JSON.parse((await billing.list('?limit=50')).body);
    const forged = JSON.parse((await billing.list('?limit=50', { 'x-tenant-id': T_HOME, 'x-internal-user-id': OWNER.id, 'x-scope': 'tenant' })).body);
    assert.deepEqual(forged, plain);
    // A walk over HTTP matches the owner's own ordered read, page for page.
    const expected = await ownerDirectory();
    const seen = [];
    let query = '?limit=7';
    for (;;) {
      const body = JSON.parse((await billing.list(query)).body);
      assert.ok(body.tenants.length <= 7);
      seen.push(...body.tenants.map((t) => t.tenantId));
      if (body.nextCursor === null) break;
      assert.equal(decodeTenantCursor(body.nextCursor), seen.at(-1));
      query = `?limit=7&cursor=${body.nextCursor}`;
    }
    assert.deepEqual(seen, expected);
    const unknown = await billing.list(`?cursor=${encodeTenantCursor(randomUUID())}`);
    assert.deepEqual([unknown.status, errorOf(unknown)], [400, 'invalid_request'], 'a continuation naming no tenant');
  });
});

test('M5T-10: a directory the database cannot answer is a bounded 503 that discloses nothing', async () => {
  await withChain(async ({ signIn }) => {
    const billing = await signIn(BILLING);
    await owner.unsafe(`revoke execute on function ${ROUTINE} from tmpos_app`);
    try {
      const reply = await billing.list();
      assert.equal(reply.status, 503, reply.body);
      assert.deepEqual(Object.keys(JSON.parse(reply.body)).sort(), ['error', 'requestId']);
      assert.equal(errorOf(reply), 'service_unavailable');
      assert.doesNotMatch(reply.body, /permission|tmpos|function|denied|42501|tenant_directory/i, 'no driver, routine or reason text');
    } finally {
      await owner.unsafe(`grant execute on function ${ROUTINE} to tmpos_app`);
    }
    assert.equal((await billing.list()).status, 200, 'restored');
  });
});
