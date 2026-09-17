// Phase 4.0 M5-ID-P1 — migration 007's two routines against REAL PostgreSQL.
//
// What needs a server, and therefore lives here: the privileges themselves (that the runtime role may
// execute exactly two routines and read no identity table), the security version's stability and its
// movement, the fail-closed identity cases, the transaction-local revalidation and its ordering, and
// that 007's rollback removes its three objects and its schema, and nothing of 006's. The boundary logic on either
// side of the server — what the adapter refuses without asking it, and what it does with a malformed
// answer — is proved without a database in server/persistence/postgresPrincipalResolver.test.ts.
//
// DISPOSABLE ONLY. The target is TM_POS_TEST_DATABASE_URL when CI binds one, otherwise a cluster this
// file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs.
// Every fixture is synthetic and randomly named, so the suite is re-runnable against the shared CI
// service and never collides with another suite's rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import {
  assertDisposableTestDsn,
  createPostgresExecutor,
  runTrustedApply,
} from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5-migrator', runtimeRef: 'm5-runtime' };
const LOCK_KEY = 528_491;
const NOW = () => new Date().toISOString();

const RUNTIME_LOGIN = 'tmpos_m5_probe';
const SUFFIX = randomUUID().slice(0, 8).replace(/-/g, '');
const UID = `m5-uid-${SUFFIX}`;

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
    'M5-ID INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
    'Docker and remote databases are not substitutes.',
  );
}

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** The owner: applies the migrations and writes the fixtures. RLS does not restrict it. */
const owner = postgres({ ...CLIENT_OPTS, database: DATABASE, max: 2, onnotice: () => {} });
/** The runtime principal: a LOGIN role holding tmpos_app and nothing else. */
let runtime = null;

test.after(async () => {
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
// Migration 005 refuses to finish while PUBLIC still holds CREATE or TEMPORARY on the database.
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
      deadlineMs: 120_000,
    });
  } finally {
    await handle.dispose();
  }
}

await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
runtime = postgres({ ...CLIENT_OPTS, database: DATABASE, user: RUNTIME_LOGIN, max: 2, onnotice: () => {} });

const [{ internal_user_id: ACTOR }] = await owner`
  insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${UID})
  returning internal_user_id`;
await owner`insert into app_user (internal_user_id, status) values (${ACTOR}, 'active')`;
const [{ tenant_id: TENANT }] = await owner`insert into tenant (display_name) values (${`m5-${SUFFIX}`}) returning tenant_id`;
const [{ store_id: STORE }] = await owner`insert into store (tenant_id, store_name) values (${TENANT}, ${`s-${SUFFIX}`}) returning store_id`;
await owner`insert into user_membership (internal_user_id, scope_type, role_id, status)
  values (${ACTOR}, 'platform', 'system_owner', 'active')`;
await owner`insert into user_membership (internal_user_id, tenant_id, scope_type, role_id, status)
  values (${ACTOR}, ${TENANT}, 'tenant', 'manager', 'active')`;
await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
  values (${ACTOR}, ${TENANT}, ${STORE}, 'store', 'technician', 'active')`;

const resolve = async (provider, uid, sql = runtime) =>
  (await sql`select * from tmpos_identity.m5_resolve_principal(${provider}::text, ${uid}::text)`)[0];
const revalidate = async (actor, version, scope, tenant, store, sql = runtime) =>
  (await sql`select * from tmpos_identity.m5_revalidate_principal_context(
    ${actor}::uuid, ${version}::text, ${scope}::text, ${tenant}::uuid, ${store}::uuid)`)[0];
const denied = async (fn) => {
  try { await fn(); return null; } catch (err) { return String(err.message); }
};

// ---------------------------------------------------------------------------

test('M5-01: migrations 001-007 apply in order against a real server', () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
});

test('M5-02: the runtime role may execute exactly the two entry routines, and read no identity table', async () => {
  // The whole point of the boundary: the routines answer, the tables do not.
  for (const relation of ['platform_identity', 'app_user', 'identity_link']) {
    const message = await denied(() => runtime.unsafe(`select 1 from public.${relation} limit 1`));
    assert.match(String(message), /permission denied/i, `${relation} must stay unreadable`);
  }
  // The version helper is granted to nobody, so the runtime role cannot compute a version for an
  // actor it has not resolved — no enumeration through the digest.
  assert.match(String(await denied(() => runtime`select tmpos_identity.m5_security_version(${ACTOR})`)), /permission denied/i);

  // And the grant matrix says the same thing: nothing but tmpos_app's EXECUTE on the two entry routines.
  const acl = await owner`
    select p.proname::text as name, a.grantee::regrole::text as grantee, a.privilege_type as priv, a.is_grantable as grantable
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
     where n.nspname = 'tmpos_identity'
       and a.grantee <> p.proowner
     order by p.proname, grantee`;
  assert.deepEqual(acl.map((r) => [r.name, r.grantee, r.priv, r.grantable]), [
    ['m5_resolve_principal', 'tmpos_app', 'EXECUTE', false],
    ['m5_revalidate_principal_context', 'tmpos_app', 'EXECUTE', false],
  ], 'PUBLIC holds nothing, the helper is granted to nobody, and no grant is grantable');
});

test('M5-03: a verified reference resolves to the actor, its status, its version and its usable grants', async () => {
  const row = await resolve('firebase', UID);
  assert.equal(row.outcome, 'resolved');
  assert.equal(row.actor_id, ACTOR);
  assert.equal(row.account_status, 'active');
  assert.equal(row.limitation, 'none');
  assert.match(row.security_version, /^[0-9a-f]{64}$/, 'a SHA-256 hex digest, which the admission rule accepts as-is');
  const grants = row.memberships.map((m) => [m.scopeType, m.roleId, m.tenantId, m.storeId]).sort();
  assert.deepEqual(grants, [
    ['platform', 'system_owner', null, null],
    ['store', 'technician', TENANT, STORE],
    ['tenant', 'manager', TENANT, null],
  ].sort());
  // Nothing in the answer carries the provider reference back.
  assert.equal(JSON.stringify(row).includes(UID), false);
});

test('M5-04: every fail-closed identity answers the same refusal', async () => {
  const cases = [
    ['an unknown reference', ['firebase', `absent-${SUFFIX}`]],
    ['a provider the audit contract does not admit', ['google', UID]],
    ['an empty reference', ['firebase', '']],
    ['an over-long reference', ['firebase', 'x'.repeat(256)]],
  ];
  for (const [label, [provider, uid]] of cases) {
    const row = await resolve(provider, uid);
    assert.deepEqual(
      { outcome: row.outcome, actor: row.actor_id, status: row.account_status, version: row.security_version, grants: row.memberships },
      { outcome: 'refused', actor: null, status: null, version: null, grants: null },
      `${label}: one bounded refusal, identical to every other`,
    );
  }
});

test('M5-05: an account that may not sign in, and an ambiguously anchored one, both refuse', async () => {
  for (const status of ['suspended', 'pending_activation']) {
    await owner`update app_user set status = ${status} where internal_user_id = ${ACTOR}`;
    assert.equal((await resolve('firebase', UID)).outcome, 'refused', status);
  }
  await owner`update app_user set status = 'active' where internal_user_id = ${ACTOR}`;
  assert.equal((await resolve('firebase', UID)).outcome, 'resolved');

  // Two ACTIVE identity links for one person is exactly the ambiguity that must not resolve. The
  // partial unique indexes of 004 allow it only across different provider references, so the fixture
  // below is a real shape, not an impossible one.
  const second = `m5-second-${SUFFIX}`;
  await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('supabase', ${second})`;
  await owner`insert into identity_link (internal_user_id, firebase_auth_provider_uid, supabase_auth_provider_uid, status)
    values (${ACTOR}, ${UID}, ${second}, 'active')`;
  assert.equal((await resolve('firebase', UID)).outcome, 'resolved', 'one active link is not ambiguous');

  // A SECOND active link to a DIFFERENT pair is legitimate — 004 permits it, and every one of them
  // anchors the same internal_user_id — so it must NOT lock the account out.
  const secondF = `m5-second-f-${SUFFIX}`;
  const secondS2 = `m5-second-s2-${SUFFIX}`;
  await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${secondF})`;
  await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('supabase', ${secondS2})`;
  await owner`insert into identity_link (internal_user_id, firebase_auth_provider_uid, supabase_auth_provider_uid, status)
    values (${ACTOR}, ${secondF}, ${secondS2}, 'active')`;
  assert.equal((await resolve('firebase', UID)).outcome, 'resolved',
    'a legitimately multi-linked account still resolves');

  // The ambiguity that DOES refuse: two active links claiming the SAME provider reference. 004's
  // partial unique index forbids it, so producing it means dropping that index — which is exactly the
  // condition the routine refuses to resolve under, a missing uniqueness guarantee.
  const dupS = `m5-dup-s-${SUFFIX}`;
  await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('supabase', ${dupS})`;
  await owner.unsafe('drop index uq_identity_link_active_firebase');
  try {
    await owner`insert into identity_link (internal_user_id, firebase_auth_provider_uid, supabase_auth_provider_uid, status)
      values (${ACTOR}, ${UID}, ${dupS}, 'active')`;
    assert.equal((await resolve('firebase', UID)).outcome, 'refused',
      'two active links on one reference refuse: the uniqueness guarantee is not in force');
    await owner`delete from identity_link where supabase_auth_provider_uid = ${dupS}`;
  } finally {
    await owner.unsafe(`create unique index uq_identity_link_active_firebase
      on identity_link (firebase_auth_provider, firebase_auth_provider_uid) where status = 'active'`);
  }
  assert.equal((await resolve('firebase', UID)).outcome, 'resolved', 'and it resolves again afterwards');
});

test('M5-06: a grant whose scope is not whole never appears, and a store under another tenant least of all', async () => {
  const other = (await owner`insert into tenant (display_name) values (${`other-${SUFFIX}`}) returning tenant_id`)[0].tenant_id;
  const foreign = (await owner`insert into store (tenant_id, store_name) values (${other}, ${`f-${SUFFIX}`}) returning store_id`)[0].store_id;
  // A store membership naming this tenant but a store belonging to another one.
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${ACTOR}, ${TENANT}, ${foreign}, 'store', 'sales_staff', 'active')`;
  const withForeign = await resolve('firebase', UID);
  assert.equal(withForeign.memberships.some((m) => m.storeId === foreign), false,
    'an inconsistent store grant is left out, never repaired');
  assert.equal((await revalidate(ACTOR, withForeign.security_version, 'store', TENANT, foreign)).outcome, 'invalid');
  await owner`delete from user_membership where internal_user_id = ${ACTOR} and store_id = ${foreign}`;

  // A suspended tenant takes its own grants and its stores' with it.
  await owner`update tenant set status = 'suspended' where tenant_id = ${TENANT}`;
  const during = await resolve('firebase', UID);
  assert.deepEqual(during.memberships.map((m) => m.scopeType), ['platform'], 'only the platform grant survives');
  await owner`update tenant set status = 'active' where tenant_id = ${TENANT}`;

  // A read_only tenant still grants, and says so, so the caller can apply the documented limiting.
  await owner`update tenant set status = 'read_only' where tenant_id = ${TENANT}`;
  const limited = await resolve('firebase', UID);
  assert.equal(limited.memberships.find((m) => m.scopeType === 'tenant').tenantStatus, 'read_only');
  await owner`update tenant set status = 'active' where tenant_id = ${TENANT}`;
});

test('M5-07: the security version moves with the account and the link, and not with a membership', async () => {
  const before = (await resolve('firebase', UID)).security_version;
  assert.equal((await resolve('firebase', UID)).security_version, before, 'unchanged state, unchanged version');

  await owner`update user_membership set status = 'suspended'
    where internal_user_id = ${ACTOR} and scope_type = 'platform'`;
  assert.equal((await resolve('firebase', UID)).security_version, before,
    'a withdrawn membership must not revoke every session the person holds elsewhere');
  await owner`update user_membership set status = 'active'
    where internal_user_id = ${ACTOR} and scope_type = 'platform'`;

  await owner`update app_user set status = 'read_only' where internal_user_id = ${ACTOR}`;
  const afterStatus = await resolve('firebase', UID);
  assert.notEqual(afterStatus.security_version, before, 'a status change moves it');
  assert.equal(afterStatus.limitation, 'read_only');
  await owner`update app_user set status = 'active' where internal_user_id = ${ACTOR}`;

  await owner`update identity_link set status = 'disabled' where internal_user_id = ${ACTOR}`;
  assert.notEqual((await resolve('firebase', UID)).security_version, before, 'an unlinked provider moves it');
  assert.equal((await resolve('firebase', UID)).outcome, 'resolved', 'but a disabled link does not deny on its own');
  await owner`update identity_link set status = 'active' where internal_user_id = ${ACTOR}`;
});

test('M5-08: revalidation answers the still-granted role at exactly that scope, or one bounded invalid', async () => {
  const version = (await resolve('firebase', UID)).security_version;
  assert.deepEqual(await revalidate(ACTOR, version, 'platform', null, null), { outcome: 'valid', granted_role_id: 'system_owner' });
  assert.deepEqual(await revalidate(ACTOR, version, 'tenant', TENANT, null), { outcome: 'valid', granted_role_id: 'manager' });
  assert.deepEqual(await revalidate(ACTOR, version, 'store', TENANT, STORE), { outcome: 'valid', granted_role_id: 'technician' });

  const invalid = { outcome: 'invalid', granted_role_id: null };
  const cases = [
    ['a version that moved', [ACTOR, 'f'.repeat(64), 'platform', null, null]],
    ['an unknown actor', [randomUUID(), version, 'platform', null, null]],
    ['a platform scope carrying a tenant', [ACTOR, version, 'platform', TENANT, null]],
    ['a tenant scope carrying no tenant', [ACTOR, version, 'tenant', null, null]],
    ['a store scope carrying no store', [ACTOR, version, 'store', TENANT, null]],
    ['a tenant the actor does not hold', [ACTOR, version, 'tenant', randomUUID(), null]],
    ['an unknown scope name', [ACTOR, version, 'everything', null, null]],
  ];
  for (const [label, args] of cases) {
    assert.deepEqual(await revalidate(...args), invalid, label);
  }
});

test('M5-09: a revocation committed before the command invalidates the context it was planned under', async () => {
  const version = (await resolve('firebase', UID)).security_version;

  await owner`update user_membership set status = 'suspended'
    where internal_user_id = ${ACTOR} and scope_type = 'tenant'`;
  assert.deepEqual(await revalidate(ACTOR, version, 'tenant', TENANT, null), { outcome: 'invalid', granted_role_id: null },
    'a withdrawn membership invalidates the command without touching the version');
  await owner`update user_membership set status = 'active'
    where internal_user_id = ${ACTOR} and scope_type = 'tenant'`;

  await owner`update app_user set status = 'suspended' where internal_user_id = ${ACTOR}`;
  assert.deepEqual(await revalidate(ACTOR, version, 'platform', null, null), { outcome: 'invalid', granted_role_id: null });
  await owner`update app_user set status = 'active' where internal_user_id = ${ACTOR}`;

  await owner`update store set status = 'suspended' where store_id = ${STORE}`;
  assert.deepEqual(await revalidate(ACTOR, version, 'store', TENANT, STORE), { outcome: 'invalid', granted_role_id: null });
  await owner`update store set status = 'active' where store_id = ${STORE}`;

  // Restoring a status is itself a write, so the version has moved on: the context planned under the
  // OLD one stays invalid, and only a context resolved from current state is valid again.
  assert.deepEqual(await revalidate(ACTOR, version, 'platform', null, null), { outcome: 'invalid', granted_role_id: null },
    'a context from before the suspension never becomes valid again');
  const current = (await resolve('firebase', UID)).security_version;
  assert.notEqual(current, version, 'suspending and restoring an account moves its security version');
  assert.deepEqual(await revalidate(ACTOR, current, 'platform', null, null), { outcome: 'valid', granted_role_id: 'system_owner' },
    'and a freshly resolved context is valid');
});

test('M5-10: a revocation racing a command waits for it — the documented isolation rule', async () => {
  // Under READ COMMITTED the routine's FOR SHARE locks make the race deterministic in BOTH directions.
  // Here the command holds its lock first, so the revoking transaction blocks until the command ends;
  // it therefore cannot slip in between the check and the COMMIT.
  const version = (await resolve('firebase', UID)).security_version;
  const held = postgres({ ...CLIENT_OPTS, database: DATABASE, user: RUNTIME_LOGIN, max: 1, onnotice: () => {} });
  const revoker = postgres({ ...CLIENT_OPTS, database: DATABASE, max: 1, onnotice: () => {} });
  let settled = false;
  let revocation = null;
  try {
    await held.begin(async (tx) => {
      const answer = (await tx`select * from tmpos_identity.m5_revalidate_principal_context(
        ${ACTOR}::uuid, ${version}::text, 'platform'::text, null::uuid, null::uuid)`)[0];
      assert.equal(answer.outcome, 'valid');
      revocation = revoker`update app_user set status = 'suspended' where internal_user_id = ${ACTOR}`
        .then(() => { settled = true; }, () => { settled = true; });
      // Give it a real chance to commit: it must not, because this transaction holds the row.
      await new Promise((done) => setTimeout(done, 400));
      assert.equal(settled, false, 'the revocation waits for the command, it does not overtake it');
    });
    await revocation;
    assert.equal(settled, true, 'and it proceeds the moment the command is done');
    // The next command, planned under the same version, is refused.
    assert.deepEqual(await revalidate(ACTOR, version, 'platform', null, null), { outcome: 'invalid', granted_role_id: null });
  } finally {
    await held.end({ timeout: 5 });
    await revoker.end({ timeout: 5 });
    await owner`update app_user set status = 'active' where internal_user_id = ${ACTOR}`;
  }
});

test('M5-11: neither a hostile search_path nor a temporary object can alter resolution', async () => {
  // Migration 005 revokes the database TEMPORARY grant from PUBLIC, so the shadowing attack has no
  // first step at all for the runtime role.
  assert.match(String(await denied(() => runtime.unsafe('create temporary table app_user (x int)'))),
    /permission denied to create temporary/i);

  // And a shadowing schema ahead of public changes nothing, because each routine pins its own path and
  // every relation it names is schema-qualified.
  const evil = `m5_evil_${SUFFIX}`;
  await owner.unsafe(`create schema ${evil}`);
  await owner.unsafe(`create table ${evil}.app_user (internal_user_id uuid, status text, updated_at timestamptz)`);
  await owner.unsafe(`create table ${evil}.platform_identity (internal_user_id uuid, auth_provider text, auth_provider_uid text)`);
  await owner.unsafe(`create table ${evil}.user_membership (membership_id uuid, internal_user_id uuid, scope_type text, tenant_id uuid, store_id uuid, role_id text, status text)`);
  await owner.unsafe(`insert into ${evil}.platform_identity values ('${randomUUID()}', 'firebase', '${UID}')`);
  await owner.unsafe(`grant usage on schema ${evil} to tmpos_app`);
  await owner.unsafe(`grant select on all tables in schema ${evil} to tmpos_app`);
  try {
    const honest = await resolve('firebase', UID);
    const underAttack = await runtime.begin(async (tx) => {
      await tx.unsafe(`set local search_path = ${evil}, public, pg_temp`);
      return (await tx`select * from tmpos_identity.m5_resolve_principal('firebase'::text, ${UID}::text)`)[0];
    });
    assert.equal(underAttack.actor_id, honest.actor_id, 'the same actor');
    assert.equal(underAttack.security_version, honest.security_version, 'and the same version');
  } finally {
    await owner.unsafe(`drop schema ${evil} cascade`);
  }
});

test('M5-12: 007 rolls back to exactly its three objects, leaves 006 whole, and re-applies', async () => {
  const { readFileSync } = await import('node:fs');
  const down = readFileSync(`${MIG_DIR}/007_m5_trusted_principal_resolution.down.sql`, 'utf8');
  const up = readFileSync(`${MIG_DIR}/007_m5_trusted_principal_resolution.up.sql`, 'utf8');
  const routines = async (like) => (await owner`
    select pg_catalog.count(*)::int as n from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('tmpos_identity', 'tmpos_internal') and p.proname like ${like}`)[0].n;

  assert.equal(await routines('m5\\_%'), 3);
  const sixBefore = await routines('m6\\_%');

  await owner.begin(async (tx) => { await tx.unsafe(down); });
  assert.equal(await routines('m5\\_%'), 0, '007 down removes its own three objects');
  assert.equal(await routines('m6\\_%'), sixBefore, "and none of 006's");
  assert.equal((await owner`select 1 from pg_catalog.pg_namespace where nspname = 'tmpos_identity'`).length, 0,
    'and its own schema with them');
  assert.equal((await owner`select 1 from pg_catalog.pg_namespace where nspname = 'tmpos_internal'`).length, 1,
    "while migration 006's schema survives untouched");

  // The up file is re-appliable, so a down/up cycle succeeds — including its own verify section, which
  // would refuse if a grant or an attribute had drifted.
  await owner.begin(async (tx) => { await tx.unsafe(up); });
  assert.equal(await routines('m5\\_%'), 3);
  assert.equal((await resolve('firebase', UID)).outcome, 'resolved', 'and the runtime role can call it again');
});
