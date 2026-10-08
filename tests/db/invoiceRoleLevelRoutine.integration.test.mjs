// Phase 4.0 M5-INVOICES-AUTH-P1 — the owner's Invoices level against REAL PostgreSQL: migration 026 (schema
// tmpos_role_invoice: the one-snapshot read-back m7a_invoice_role_level_states and the conditional edit
// m7a_invoice_role_level_set — 021's two routines with the domain fixed to 'invoices' — and the two domain CHECKs of 020's
// role table and 021's version table widened to 'customers' and 'invoices'), exercised as the runtime's own non-owner login
// (tmpos_app + tmpos_audit_writer). This file proves the database half alone, with no runtime in front of it. It is
// AUTHORIZATION CONFIGURATION only: no invoice table, route or decision exists, and nothing here claims that one is
// server-enforced. (M7B-INVOICES-P1 UPDATE: migration 028's invoice-draft routines now decide on this level; their proof is
// tests/db/invoiceDraftRoutine.integration.test.mjs's and tests/db/invoiceDraftsHttp.integration.test.mjs's.)
//
// WHAT IS PROVEN. 001-029 applied clean, every ledger checksum the pinned one, 026's postcondition re-proven over the
// applied state and refusing every widening it names, and a second apply refused (M5IRL-01); the installed inventory, the
// two widened CHECKs and the login's effective privileges — EXECUTE on the two new routines and on 020's and 021's, nothing
// on either table, nothing for the audit writer, anon, authenticated or PUBLIC (M5IRL-02); the defaults — every role reads
// level null and version 0 — and a null argument raising (M5IRL-03); every refused edit writing nothing: a malformed
// argument raising 22023, a manager's, technician's or sales_staff key, a revoked, an expired, an unminted, an ambiguous and
// a read-only or suspended tenant's key answering no row, and the same owners' fresh keys applying once their tenants are
// active again (M5IRL-04); a tenant mismatch and a version conflict writing and
// locking nothing, an applied edit advancing the version by exactly one (M5IRL-05); a reset to the catalog default advancing
// the version, so an older draft is refused (no ABA), and two drafts from one read, sent together, applying once (their
// overlap not forced: M5IRLH-07 proves the lock wait) (M5IRL-06); ISOLATION — an
// Invoices edit leaving the Customers row and version untouched and the reverse, tenant A's edits invisible in tenant B,
// 020's levels read answering both domains, a customer decision unaffected by an Invoices row (M5IRL-07); the UPGRADE — 026
// applied by the trusted executor over a 025 database (026's down file run and its ledger row removed, so the ledger reads
// 001-025) that already holds Customers edits and versions, which survive unchanged (M5IRL-08); the ROLLBACK — refused (and
// the database left as it was) while an Invoices level row and its version exist, while only an Invoices version row
// exists, while only an Invoices level row exists, and outside READ COMMITTED; clean once the owner deletes them, leaving
// 020's and 021's routines (pg_get_functiondef, owner, ACL) byte for byte and both CHECKs the narrow ones, then a clean
// re-apply (M5IRL-09).
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a
// cluster this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every
// fixture is synthetic and randomly suffixed, and every issuer key is random bytes made here. It leaves the shared service
// as it found it: 026 (and 027, 028 and 029) applied, the ledger 001-029, the issuer key row it found, no Invoices or Customers level, version,
// session or customer row of its own, and its login dropped — every cleanup step runs even after another fails, these
// postconditions are then asserted, and any failure fails the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { REQUIRED_MIGRATIONS } from '../../server/persistence/postgresStartupPreflight.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_026 = readFileSync(`${MIG_DIR}/026_m5_invoice_role_levels.up.sql`, 'utf8');
const DOWN_026 = readFileSync(`${MIG_DIR}/026_m5_invoice_role_levels.down.sql`, 'utf8');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_026 = UP_026.slice(UP_026.lastIndexOf('do $$'));
const STATES = 'tmpos_role_invoice.m7a_invoice_role_level_states(uuid)';
const SET = 'tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)';
const STATES_021 = 'tmpos_role_edit.m7a_role_level_states(uuid)';
const SET_V2 = 'tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)';
const SET_020 = 'tmpos_role.m7a_role_level_set(text, text, text, text)';
const ADVANCE = 'tmpos_role_edit.m7a_role_level_version_advance()';
const LEVELS_020 = 'tmpos_role.m7a_role_levels(uuid, text)';
const CREATE_020 = 'tmpos_role.m7a_customer_create(text, uuid, text)';
const PAGE_020 = 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)';
/** Migration 023's create: the login's only create path, which decides through 020's create. */
const CREATE_023 = 'tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)';
const NARROW = `CHECK ((domain = 'customers'::text))`;
const WIDE = `CHECK ((domain = ANY (ARRAY['customers'::text, 'invoices'::text])))`;
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5irl-migrator', runtimeRef: 'm5irl-runtime' };
const LOCK_KEY = 526_526;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m5irl_probe';
const HOUR = 3_600_000;
const TENANT_LIFETIME = 8 * HOUR;
const ROLLBACK = new Error('m5irl: roll the proof back');
/** Every privilege has_table_privilege knows on PostgreSQL 16 (MAINTAIN is 17's). */
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const MISMATCH = Object.freeze({ o_outcome: 'tenant_mismatch', o_tenant_id: null, o_actor_id: null, o_membership_id: null, o_level: null, o_version: null });
const CONFLICT = Object.freeze({ ...MISMATCH, o_outcome: 'version_conflict' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (as roleLevelVersionRoutine does)
// ---------------------------------------------------------------------------

const netstring = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes, Buffer.from(',')]);
};
const mintMessage = (key, r, expiresAt) => Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion,
    r.authenticatedAt === null ? '' : r.authenticatedAt, r.createdAt, r.lastSeenAt, r.validatedAt, expiresAt]
    .map((v) => netstring(String(v)))]);
const proofOf = (issuer, key, r, expiresAt) => createHmac('sha256', issuer).update(mintMessage(key, r, expiresAt)).digest();
/** A fresh store key in the runtime's shape: the SHA-256 of 32 random bytes' identifier. */
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M5IRL');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

const connect = (user, max) =>
  testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, installs the key, writes the fixtures and observes. RLS does not restrict it. */
const owner = connect(undefined, 3);
let runtime = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let keyBeforeSuite;

test.after(async () => {
  // Every step runs even when an earlier one throws, so a failure can never skip the issuer-key restore or the login drop;
  // what failed is collected, the postconditions are then checked, and any failure fails the suite (a dirty shared
  // service is never silent).
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    // A failed M5IRL-08 or M5IRL-09 may have left 026 rolled back. M5IRL-09's rollbacks are file runs (ledger row
    // untouched); M5IRL-08's removed the ledger row too, and its own finally puts both back. Re-apply the file if needed.
    await step(async () => {
      if ((await owner`select pg_catalog.to_regnamespace('tmpos_role_invoice') is null as absent`)[0].absent) {
        await owner.begin((tx) => tx.unsafe(UP_026).simple());
      }
    });
    // Version rows first, then levels (the rollbacks' order): of EVERY domain, so no Invoices row outlives this file and a
    // later suite's rollback of 026, 021 or 020 can run. Tenants stay, as every suite leaves its synthetic tenants.
    if (TENANTS.length > 0) await step(() => owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`);
    if (TENANTS.length > 0) await step(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
    if (KEYS.size > 0) await step(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
    if (UIDS.length > 0) await step(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
    if (TENANTS.length > 0) await step(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
    if (TENANTS.length > 0) await step(() => owner`update tenant set status = 'active' where tenant_id = any(${TENANTS}::uuid[]) and status <> 'active'`);
    if (keyBeforeSuite !== undefined) {
      await step(async () => {
        await owner`delete from tmpos_mint.issuer_key`;
        if (keyBeforeSuite !== null) await owner`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${keyBeforeSuite})`;
      });
    }
    if (runtime) await step(() => runtime.end({ timeout: 5 }));
    await step(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
    await step(() => owner.unsafe(`do $$ begin
      if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
    end $$;`));
    await step(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
    // The postconditions the header promises.
    await step(async () => {
      const [state] = await owner`select
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as levels,
          (select count(*) from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[]))::int as versions,
          (select count(*) from tmpos_role.tenant_role_level where domain = 'invoices')::int as invoice_levels,
          (select count(*) from tmpos_role_edit.role_level_version where domain = 'invoices')::int as invoice_versions,
          pg_catalog.to_regnamespace('tmpos_role_invoice') is not null as schema_026,
          exists (select 1 from public.schema_migrations where version = '026') as ledger_026,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, { levels: 0, versions: 0, invoice_levels: 0, invoice_versions: 0, schema_026: true, ledger_026: true, login: false },
        'left as found: no level or version row of this suite, no Invoices row at all, 026 applied and recorded, the probe login dropped');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M5IRL teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: every migration in the directory (001-029), a real non-owner runtime login, the key installed by the owner
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

/** The trusted executor over every file in the directory: applies what the ledger does not yet record. */
async function trustedApply() {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    return await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}
const applyReport = await trustedApply();

// The login the approved runtime boundary describes: the two memberships and its one direct privilege, the ledger read.
await owner.unsafe(`do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
end $$;`);
await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
runtime = connect(RUNTIME_LOGIN, 3);

keyBeforeSuite = (await owner`select key from tmpos_mint.issuer_key`)[0]?.key ?? null;
const K = await installTestIssuerKey(owner);

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m5irl-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};

/** A synthetic actor: an identity, an active account, and the given memberships. */
async function actor(label, memberships) {
  const uid = `m5irl-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, null, 'tenant', ${m.role}, 'active')`;
  }
  UIDS.push(uid);
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role) => ({ tenant, role });

const T_A = await newTenant('a');
const T_B = await newTenant('b');
const T_READ_ONLY = await newTenant('read-only', 'read_only');
const T_SUSPENDED = await newTenant('suspended');
const OWNER_A = await actor('owner-a', [tenantGrant(T_A, 'store_owner')]);
/** A second owner of A: two principals editing one tenant do not share 016's account lock. */
const OWNER_A2 = await actor('owner-a2', [tenantGrant(T_A, 'store_owner')]);
const OWNER_B = await actor('owner-b', [tenantGrant(T_B, 'store_owner')]);
const SALES_A = await actor('sales-a', [tenantGrant(T_A, 'sales_staff')]);
const MANAGER_A = await actor('manager-a', [tenantGrant(T_A, 'manager')]);
const TECHNICIAN_A = await actor('technician-a', [tenantGrant(T_A, 'technician')]);
const OWNER_TWO_GRANTS = await actor('owner-two-grants', [tenantGrant(T_A, 'store_owner'), tenantGrant(T_B, 'store_owner')]);
const OWNER_READ_ONLY_TENANT = await actor('owner-read-only-tenant', [tenantGrant(T_READ_ONLY, 'store_owner')]);
const OWNER_SUSPENDED_TENANT = await actor('owner-suspended-tenant', [tenantGrant(T_SUSPENDED, 'store_owner')]);

// ---------------------------------------------------------------------------
// the runtime login's calls
// ---------------------------------------------------------------------------

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:m5irl', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
});
/** A tenant session for `who`, minted as the runtime login under K, live for `lifetime` ms. */
async function mint(who, lifetime = TENANT_LIFETIME) {
  const key = newKey();
  const r = record(who);
  const expiresAt = r.createdAt + lifetime;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${proofOf(K, key, r, expiresAt)}::bytea) as outcome`;
  assert.equal(outcome, 'created', `a tenant session for ${who.uid}`);
  return key;
}
const numbered = (rows) => rows.map((r) => ({ ...r, o_version: r.o_version === null ? null : Number(r.o_version) }));
/** 026's Invoices edit, called directly as the runtime login (or on `db`); the version as a number. A raise rejects. */
const setInv = async (key, role, level, tenant, version, db = runtime) =>
  numbered(await db`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version
    from tmpos_role_invoice.m7a_invoice_role_level_set(${key}::text, ${role}::text, ${level}::text, ${tenant}::uuid, ${version}::bigint)`);
/** 021's Customers edit, as the runtime login (or on `db`). */
const setCus = async (key, role, level, tenant, version, db = runtime) =>
  numbered(await db`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version
    from tmpos_role_edit.m7a_role_level_set_v2(${key}::text, ${role}::text, 'customers'::text, ${level}::text, ${tenant}::uuid, ${version}::bigint)`);
/** 026's read-back, as the runtime login. */
const statesInv = async (tenant) => (await runtime`select tmpos_role_invoice.m7a_invoice_role_level_states(${tenant}::uuid) as states`)[0].states;
const stateInv = async (tenant, role) => (await statesInv(tenant)).find((s) => s.roleId === role);
/** 021's read-back (Customers), as the runtime login. */
const statesCus = async (tenant) => (await runtime`select tmpos_role_edit.m7a_role_level_states(${tenant}::uuid) as states`)[0].states;
const stateCus = async (tenant, role) => (await statesCus(tenant)).find((s) => s.roleId === role);
/** A customer create, as the runtime login (023's routine, deciding through 020's create): one row when it was allowed. */
const create = async (key, id = randomUUID(), db = runtime) =>
  (await db`select o_tenant_id from tmpos_customer_contact.m7a_contact_create(${key}::text, ${id}::uuid, ${`M5IRL ${SUFFIX}`}::text,
    null::text, null::text)`).map((r) => ({ ...r }));
/** Every stored role row, of every domain, and every version row of `tenant`, read by the owner. */
const storedRows = async (tenant) => (await owner`select role_id, domain, level from tmpos_role.tenant_role_level
  where tenant_id = ${tenant} order by domain, role_id`).map((r) => ({ ...r }));
const versionRows = async (tenant) => (await owner`select role_id, domain, version::int as version from tmpos_role_edit.role_level_version
  where tenant_id = ${tenant} order by domain, role_id`).map((r) => ({ ...r }));
/** Back to nothing stored everywhere this suite owns: version rows first (the rollbacks' order), then levels. */
async function resetState() {
  await owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
  await owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
}
/** The applied row `who`'s own grant yields. */
async function applied(who, level, version) {
  const [m] = await owner`select tenant_id, membership_id from user_membership where internal_user_id = ${who.id} and scope_type = 'tenant'`;
  return { o_outcome: 'applied', o_tenant_id: m.tenant_id, o_actor_id: who.id, o_membership_id: m.membership_id, o_level: level, o_version: version };
}
const errorOf = (p) => p.then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
const codeOf = async (p) => (await errorOf(p))?.code ?? null;
const pidOf = async (tx) => (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
/** The relation-level lock modes `pid` holds on `table`. */
const modesOn = async (pid, table) => (await owner`select mode from pg_catalog.pg_locks
  where pid = ${pid} and relation = ${table}::regclass and granted order by mode`).map((r) => r.mode);
const none = (roleId) => ({ roleId, level: null, version: 0 });
const ALL_NONE = [none('manager'), none('technician'), none('sales_staff')];

/** Runs `fn` in an owner transaction that is always rolled back. Answers { value } or the { code, message } it raised. */
async function rolledBack(isolation, fn) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}

/**
 * Every object 020, 021 and 026 own that 026 may touch, as a comparable value: each routine's complete definition as
 * PostgreSQL prints it (pg_get_functiondef — signature, result, language, volatility, security, SET options and body),
 * its owner and ACL; the constraints, schemas, tables and the trigger.
 */
async function surface(db) {
  const routines = await db`select p.oid::regprocedure::text as fn, pg_catalog.pg_get_functiondef(p.oid) as def,
      p.proacl::text as acl, p.proowner::regrole::text as owner
    from pg_catalog.pg_proc p where p.pronamespace in ('tmpos_role'::regnamespace, 'tmpos_role_edit'::regnamespace) order by p.oid::regprocedure::text collate "C"`;
  const constraints = await db`select k.conrelid::regclass::text as rel, k.conname::text as name, pg_catalog.pg_get_constraintdef(k.oid) as def, k.convalidated as valid
    from pg_catalog.pg_constraint k where k.conrelid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_role_edit.role_level_version'::regclass) order by k.conrelid::regclass::text collate "C", k.conname::text collate "C"`;
  const schemas = await db`select n.nspname::text as name, n.nspacl::text as acl from pg_catalog.pg_namespace n
    where n.nspname in ('tmpos_role', 'tmpos_role_edit') order by n.nspname::text collate "C"`;
  const tables = await db`select c.oid::regclass::text as rel, c.relacl::text as acl, c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_catalog.pg_class c where c.oid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_role_edit.role_level_version'::regclass) order by c.oid::regclass::text collate "C"`;
  const triggers = await db`select g.tgname::text as name, g.tgtype::int as tgtype, g.tgenabled::text as enabled
    from pg_catalog.pg_trigger g where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal`;
  return JSON.parse(JSON.stringify({ routines, constraints, schemas, tables, triggers }));
}

// ---------------------------------------------------------------------------
// M5IRL-01..02: the migration, the inventory and the login's privileges
// ---------------------------------------------------------------------------

test('M5IRL-01: 001-029 applied clean, every checksum the pinned one; 026\'s postcondition holds and refuses every widening it names; a second apply is refused', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    Array.from({ length: 29 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'the ledger records the pinned chain');
  const onDisk = (version) => {
    const [name] = readdirSync(MIG_DIR).filter((f) => f.startsWith(`${version}_`) && f.endsWith('.up.sql'));
    return createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex');
  };
  assert.deepEqual(REQUIRED_MIGRATIONS.map((m) => onDisk(m.version)), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'every up file is its pinned bytes');

  const [{ me }] = await owner`select current_user as me`;
  const postcondition = async (widen) => rolledBack('isolation level read committed', async (tx) => {
    for (const statement of widen) await tx.unsafe(statement);
    await tx.unsafe(POSTCONDITION_026).simple();
  });
  for (const [label, widen] of [
    ['a SELECT on the version table', ['grant select on tmpos_role_edit.role_level_version to tmpos_app']],
    ['a SELECT on the role table', ['grant select on tmpos_role.tenant_role_level to tmpos_app']],
    ['a column grant on the role table', ['grant select (level) on tmpos_role.tenant_role_level to tmpos_app']],
    ['a policy on the role table', ['create policy m5irl_all on tmpos_role.tenant_role_level using (true)']],
    ['forced row security on the version table', ['alter table tmpos_role_edit.role_level_version force row level security']],
    ['EXECUTE on the edit to the audit writer', [`grant execute on function ${SET} to tmpos_audit_writer`]],
    ['EXECUTE on the read-back to PUBLIC', [`grant execute on function ${STATES} to public`]],
    ['EXECUTE on the read-back with grant option', [`grant execute on function ${STATES} to tmpos_app with grant option`]],
    ['EXECUTE on the edit taken from tmpos_app', [`revoke execute on function ${SET} from tmpos_app`]],
    ['USAGE on the schema to the audit writer', ['grant usage on schema tmpos_role_invoice to tmpos_audit_writer']],
    ['USAGE on the schema taken from tmpos_app', ['revoke usage on schema tmpos_role_invoice from tmpos_app']],
    ['a STABLE edit', [`alter function ${SET} stable`]],
    ['a read-back without row_security off', [`alter function ${STATES} reset row_security`]],
    ['an invoker-rights edit', [`alter function ${SET} security invoker`]],
    ['an extra routine in the schema', ['create function tmpos_role_invoice.m5irl_probe() returns int language sql as \'select 1\'']],
    ['an extra table in the schema', ['create table tmpos_role_invoice.m5irl_probe (x int)']],
    ['020\'s levels read taken from tmpos_app', [`revoke execute on function ${LEVELS_020} from tmpos_app`]],
    ['021\'s edit taken from tmpos_app', [`revoke execute on function ${SET_V2} from tmpos_app`]],
    ['the role table\'s CHECK still the narrow one',
      ['alter table tmpos_role.tenant_role_level drop constraint tenant_role_level_domain_chk, add constraint tenant_role_level_domain_chk check (domain = \'customers\')']],
    ['the version table\'s CHECK still the narrow one',
      ['alter table tmpos_role_edit.role_level_version drop constraint role_level_version_domain_chk, add constraint role_level_version_domain_chk check (domain = \'customers\')']],
    ['a third domain admitted by the role table\'s CHECK',
      ['alter table tmpos_role.tenant_role_level drop constraint tenant_role_level_domain_chk, add constraint tenant_role_level_domain_chk check (domain in (\'customers\', \'invoices\', \'sales\'))']],
    ['the version trigger disabled', ['alter table tmpos_role.tenant_role_level disable trigger trg_tenant_role_level_version_advance']],
    ['a second trigger on the role table', [`create trigger m5irl_extra after update on tmpos_role.tenant_role_level for each row execute function ${ADVANCE}`]],
    ['a NOINHERIT membership in the owner (SET ROLE reaches it)', ['alter role tmpos_app noinherit', `grant "${me}" to tmpos_app`]],
    ['a role holding UPDATE on the role table, reachable only through SET ROLE',
      ['create role m5irl_writer nologin', 'grant usage on schema tmpos_role to m5irl_writer',
        'grant update on tmpos_role.tenant_role_level to m5irl_writer', 'alter role tmpos_app noinherit', 'grant m5irl_writer to tmpos_app']],
  ]) {
    assert.equal((await postcondition(widen)).code, '55000', `${label} is refused`);
  }
  assert.equal((await postcondition([])).code, undefined, 'the state 026 left satisfies it');

  const again = await rolledBack('isolation level read committed', (tx) => tx.unsafe(UP_026).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /migration 026 refused: schema tmpos_role_invoice already exists/);
});

test('M5IRL-02: the installed inventory, the two widened CHECKs, and the login\'s effective privileges — the two new routines and 020\'s and 021\'s; nothing on either table; nothing for anyone else', async () => {
  const [{ me }] = await owner`select current_user as me`;
  const routines = await owner`select p.proname as name, p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
      pg_catalog.pg_get_function_identity_arguments(p.oid) as args, p.proowner = (select oid from pg_catalog.pg_roles where rolname = current_user) as owned,
      (select coalesce(array_agg(pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable) order by 1), '{}')
         from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where g.grantee <> p.proowner) as grants
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role_invoice'::regnamespace order by p.proname`;
  const pinned = ['search_path=pg_catalog, pg_temp', 'row_security=off'];
  assert.deepEqual(routines.map((r) => ({ ...r })), [
    { name: 'm7a_invoice_role_level_set', definer: true, volatility: 'v', config: pinned, owned: true,
      args: 'p_session_key text, p_role_id text, p_level text, p_expected_tenant uuid, p_expected_version bigint', grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'm7a_invoice_role_level_states', definer: true, volatility: 's', config: pinned, owned: true, args: 'p_tenant_id uuid', grants: ['tmpos_app:EXECUTE:f'] },
  ], 'two routines, no domain argument: the domain is written into each; the session key is the only authority argument');
  const [relations] = await owner`select (select count(*)::int from pg_catalog.pg_class c where c.relnamespace = 'tmpos_role_invoice'::regnamespace) as relations,
      (select n.nspacl::text from pg_catalog.pg_namespace n where n.oid = 'tmpos_role_invoice'::regnamespace) as schema_acl`;
  assert.deepEqual({ ...relations }, { relations: 0, schema_acl: `{${me}=UC/${me},tmpos_app=U/${me}}` }, 'no relation; USAGE alone to tmpos_app');
  const constraints = await owner`select k.conrelid::regclass::text as rel, k.conname::text as name, pg_catalog.pg_get_constraintdef(k.oid) as def, k.convalidated as valid
    from pg_catalog.pg_constraint k
    where k.conrelid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_role_edit.role_level_version'::regclass) and k.contype = 'c' and k.conname like '%domain_chk' order by k.conrelid::regclass::text collate "C"`;
  assert.deepEqual(constraints.map((r) => ({ ...r })), [
    { rel: 'tmpos_role.tenant_role_level', name: 'tenant_role_level_domain_chk', def: WIDE, valid: true },
    { rel: 'tmpos_role_edit.role_level_version', name: 'role_level_version_domain_chk', def: WIDE, valid: true },
  ], 'both CHECKs keep their names and now admit exactly customers and invoices');

  // Read by the owner for the login by name: has_function_privilege follows PUBLIC and every inherited role.
  const [rights] = await owner`select
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${STATES}::regprocedure, 'EXECUTE') as states,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${SET}::regprocedure, 'EXECUTE') as set_026,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${STATES_021}::regprocedure, 'EXECUTE') as states_021,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${SET_V2}::regprocedure, 'EXECUTE') as set_v2,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${LEVELS_020}::regprocedure, 'EXECUTE') as levels,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${PAGE_020}::regprocedure, 'EXECUTE') as page,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_023}::regprocedure, 'EXECUTE') as create_023,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_020}::regprocedure, 'EXECUTE') as create_020,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${SET_020}::regprocedure, 'EXECUTE') as set_020,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${ADVANCE}::regprocedure, 'EXECUTE') as advance,
      pg_catalog.has_schema_privilege(${RUNTIME_LOGIN}, 'tmpos_role_invoice', 'USAGE') as schema_usage`;
  assert.deepEqual({ ...rights }, { states: true, set_026: true, states_021: true, set_v2: true, levels: true, page: true, create_023: true,
    create_020: false, set_020: false, advance: false, schema_usage: true }, 'the login keeps everything 020, 021 and 023 gave it, plus the two new routines and the schema');
  for (const table of ['tmpos_role.tenant_role_level', 'tmpos_role_edit.role_level_version']) {
    for (const privilege of TABLE_PRIVILEGES) {
      const [{ held }] = await runtime`select pg_catalog.has_table_privilege(current_user, ${table}::regclass, ${privilege}) as held`;
      assert.equal(held, false, `the login holds no ${privilege} on ${table}`);
    }
  }
  const ownerKey = await mint(OWNER_A);
  for (const [label, statement] of [
    ['SELECT levels', 'select level from tmpos_role.tenant_role_level limit 1'],
    ['INSERT an Invoices level', `insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values ('${T_A}', 'manager', 'invoices', 'none', now())`],
    ['UPDATE levels', 'update tmpos_role.tenant_role_level set level = null'],
    ['SELECT versions', 'select version from tmpos_role_edit.role_level_version limit 1'],
    ['INSERT an Invoices version', `insert into tmpos_role_edit.role_level_version (tenant_id, role_id, domain, version) values ('${T_A}', 'manager', 'invoices', 99)`],
    ['DELETE versions', 'delete from tmpos_role_edit.role_level_version'],
    ['020\'s unconditional edit', `select * from tmpos_role.m7a_role_level_set('${ownerKey}', 'manager', 'customers', 'none')`],
  ]) {
    assert.equal(await codeOf(runtime.unsafe(statement)), '42501', `${label} is refused`);
  }
  assert.deepEqual(await storedRows(T_A), [], 'nothing written');
  const [others] = await owner`select bool_or(pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')) as any_execute
    from pg_catalog.pg_roles r cross join pg_catalog.pg_proc p
    where r.rolname in ('tmpos_audit_writer', 'anon', 'authenticated') and p.pronamespace = 'tmpos_role_invoice'::regnamespace`;
  assert.equal(others.any_execute, false, 'the audit writer, anon and authenticated execute neither routine');
  const [publicRights] = await owner`select
      pg_catalog.has_function_privilege('public', ${SET}::regprocedure, 'EXECUTE') as set_public,
      pg_catalog.has_function_privilege('public', ${STATES}::regprocedure, 'EXECUTE') as states_public,
      pg_catalog.has_schema_privilege('public', 'tmpos_role_invoice', 'USAGE') as schema_public`;
  assert.deepEqual({ ...publicRights }, { set_public: false, states_public: false, schema_public: false }, 'PUBLIC holds nothing');
  // The audit writer's own session cannot call them either.
  const auditor = connect(undefined, 1);
  try {
    await auditor`set role tmpos_audit_writer`;
    assert.equal(await codeOf(auditor`select tmpos_role_invoice.m7a_invoice_role_level_states(${T_A}::uuid)`), '42501');
    assert.equal(await codeOf(auditor`select * from tmpos_role_invoice.m7a_invoice_role_level_set('k'::text, 'manager'::text, 'none'::text, ${T_A}::uuid, 0::bigint)`), '42501');
  } finally {
    await auditor.end({ timeout: 5 });
  }
});

// ---------------------------------------------------------------------------
// M5IRL-03..04: the defaults, the read-back and the refusals
// ---------------------------------------------------------------------------

test('M5IRL-03: the read-back answers the three editable roles in order — level null, version 0 — for every tenant, and a null argument raises', async () => {
  await resetState();
  assert.deepEqual(await statesInv(T_A), ALL_NONE, 'nothing stored: every level null, every version 0');
  assert.deepEqual(await statesInv(randomUUID()), ALL_NONE, 'an unknown tenant reads the same');
  assert.deepEqual(await errorOf(statesInv(null)), { code: '22023', message: 'migration 026 states: the argument is null' });
  assert.deepEqual((await runtime`select tmpos_role.m7a_role_levels(${T_A}::uuid, 'manager'::text) as levels`)[0].levels, {}, 'the all-domain read: nothing stored, nothing answered');
  // A Customers lock row (a create's NULL row) is no Invoices state.
  assert.equal((await create(await mint(SALES_A))).length, 1, 'sales_staff creates at its default');
  assert.deepEqual(await statesInv(T_A), ALL_NONE, 'a Customers lock row leaves every Invoices state null / 0');
});

test('M5IRL-04: every refused Invoices edit writes nothing — a malformed argument raises 22023, outside READ COMMITTED 55000, and a key 021\'s edit refuses answers no row', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  for (const [label, key, role, level, tenant, version] of [
    ['a null expected tenant', ownerKey, 'sales_staff', 'view', null, 0],
    ['a null expected version', ownerKey, 'sales_staff', 'view', T_A, null],
    ['a negative expected version', ownerKey, 'sales_staff', 'view', T_A, -1],
    ['the owner role as the target', ownerKey, 'store_owner', 'none', T_A, 0],
    ['a null role', ownerKey, null, 'none', T_A, 0],
    ['a level outside the vocabulary', ownerKey, 'sales_staff', 'admin', T_A, 0],
    ['a null level', ownerKey, 'sales_staff', null, T_A, 0],
    ['a null key', null, 'sales_staff', 'view', T_A, 0],
    ['a key outside 011\'s shape', 'has a space', 'sales_staff', 'view', T_A, 0],
  ]) {
    assert.deepEqual(await errorOf(setInv(key, role, level, tenant, version)),
      { code: '22023', message: 'migration 026 set: an argument is malformed' }, label);
  }
  for (const isolation of ['isolation level repeatable read', 'isolation level serializable']) {
    assert.equal(await codeOf(runtime.begin(isolation, (tx) => setInv(ownerKey, 'sales_staff', 'view', T_A, 0, tx))), '55000', isolation);
  }
  const revoked = await mint(OWNER_A);
  await runtime`select tmpos_session.m5_session_revoke(${revoked}::text)`;
  const expired = await mint(OWNER_A2, 1_200);
  const suspendedKey = await mint(OWNER_SUSPENDED_TENANT);
  await owner`update tenant set status = 'suspended' where tenant_id = ${T_SUSPENDED}`;
  // Expired by the DATABASE's clock (the routine compares clock_timestamp() in ms with the stored expiry), polled — never a
  // fixed sleep racing the host clock.
  for (const until = Date.now() + 15_000; ;) {
    const [{ due }] = await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint >= s.expires_at as due
      from tmpos_mint.tenant_session s where s.session_key = ${expired}`;
    if (due) break;
    assert.ok(Date.now() < until, 'the 1.2 s key did not expire by the database clock within 15 s');
    await sleep(50);
  }
  for (const [label, key, tenant] of [
    ['a manager\'s key', await mint(MANAGER_A), T_A],
    ['a technician\'s key', await mint(TECHNICIAN_A), T_A],
    ['a sales_staff key', await mint(SALES_A), T_A],
    ['an owner holding two tenant grants (ambiguous)', await mint(OWNER_TWO_GRANTS), T_A],
    ['the owner of a read_only tenant', await mint(OWNER_READ_ONLY_TENANT), T_READ_ONLY],
    ['the owner of a suspended tenant', suspendedKey, T_SUSPENDED],
    ['a revoked owner key', revoked, T_A],
    ['an expired owner key', expired, T_A],
    ['an unminted key', newKey(), T_A],
  ]) {
    assert.deepEqual(await setInv(key, 'sales_staff', 'none', tenant, 0), [], label);
  }
  await owner`update tenant set status = 'active' where tenant_id = ${T_SUSPENDED}`;
  for (const tenant of [T_A, T_B, T_READ_ONLY, T_SUSPENDED]) {
    assert.deepEqual({ levels: await storedRows(tenant), versions: await versionRows(tenant) }, { levels: [], versions: [] },
      'no refusal wrote a role row, a lock row or a version');
  }
  // Positive controls: with the tenant active again, the same edit by the same owner on a fresh key applies — so the []
  // above came from the tenant's standing, not from the owner, the key or the arguments.
  try {
    await owner`update tenant set status = 'active' where tenant_id = ${T_READ_ONLY}`;
    for (const [label, who, tenant] of [['the read_only tenant\'s owner, tenant active', OWNER_READ_ONLY_TENANT, T_READ_ONLY],
      ['the suspended tenant\'s owner, tenant active', OWNER_SUSPENDED_TENANT, T_SUSPENDED]]) {
      assert.deepEqual(await setInv(await mint(who), 'sales_staff', 'none', tenant, 0), [await applied(who, 'none', 1)], label);
    }
  } finally {
    await owner`update tenant set status = 'read_only' where tenant_id = ${T_READ_ONLY}`;
    await resetState();
  }
});

// ---------------------------------------------------------------------------
// M5IRL-05..06: the preconditions, the applied edit, the version
// ---------------------------------------------------------------------------

test('M5IRL-05: a tenant mismatch and a version conflict write and lock nothing; an applied edit writes the level and advances the version by exactly one, in its own tenant only', async () => {
  await resetState();
  const keyB = await mint(OWNER_B);
  await runtime.begin(async (tx) => {
    assert.deepEqual(await setInv(keyB, 'sales_staff', 'none', T_A, 0, tx), [MISMATCH], 'B\'s session asserting A');
    const pid = await pidOf(tx);
    assert.deepEqual({ role: await modesOn(pid, 'tmpos_role.tenant_role_level'), version: await modesOn(pid, 'tmpos_role_edit.role_level_version') },
      { role: [], version: [] }, 'refused before the role row or the version table is touched');
  });
  const ownerKey = await mint(OWNER_A);
  await runtime.begin(async (tx) => {
    assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'none', T_A, 1, tx), [CONFLICT], 'a version never issued');
    const pid = await pidOf(tx);
    assert.deepEqual({ role: await modesOn(pid, 'tmpos_role.tenant_role_level'), version: await modesOn(pid, 'tmpos_role_edit.role_level_version') },
      { role: [], version: ['AccessShareLock'] }, 'only the plain version read ran: no lock row inserted, no row locked');
  });
  for (const tenant of [T_A, T_B]) {
    assert.deepEqual({ levels: await storedRows(tenant), versions: await versionRows(tenant) }, { levels: [], versions: [] }, 'nothing written');
  }

  let version = 0;
  for (const level of ['view', 'none', 'full', 'create']) {
    assert.deepEqual(await setInv(ownerKey, 'sales_staff', level, T_A, version), [await applied(OWNER_A, level, version + 1)], level);
    version += 1;
    assert.deepEqual(await stateInv(T_A, 'sales_staff'), { roleId: 'sales_staff', level, version });
    assert.deepEqual(await versionRows(T_A), [{ role_id: 'sales_staff', domain: 'invoices', version }]);
  }
  for (const stale of [0, 3, 5, 9_007_199_254_740_991]) {
    assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'full', T_A, stale), [CONFLICT], `expected ${stale} against 4`);
  }
  assert.deepEqual(await stateInv(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 4 }, 'a conflict moved nothing');
  assert.deepEqual(await setInv(ownerKey, 'manager', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)], 'each role counts on its own');
  assert.deepEqual(await setInv(ownerKey, 'technician', 'none', T_A, 0), [await applied(OWNER_A, 'none', 1)]);
  assert.deepEqual(await statesInv(T_A), [{ roleId: 'manager', level: 'view', version: 1 }, { roleId: 'technician', level: 'none', version: 1 },
    { roleId: 'sales_staff', level: 'create', version: 4 }], 'the read-back, in order, on one snapshot');
  assert.deepEqual(await setInv(await mint(OWNER_B), 'sales_staff', 'none', T_B, 0), [await applied(OWNER_B, 'none', 1)], 'each tenant counts on its own');
  assert.deepEqual(await stateInv(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 4 }, 'A is untouched by B');
  assert.deepEqual(await storedRows(T_B), [{ role_id: 'sales_staff', domain: 'invoices', level: 'none' }]);
});

test('M5IRL-06: a reset to the catalog default advances the version, so an older draft is refused (no ABA); two owners\' drafts from one read, sent together, apply exactly once (overlap is not forced here: M5IRLH-07 proves the lock wait)', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  const v0 = await stateInv(T_A, 'sales_staff');
  assert.deepEqual(v0, none('sales_staff'), 'the default (create) and version 0');
  assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'none', T_A, 0), [await applied(OWNER_A, 'none', 1)]);
  assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'create', T_A, 1), [await applied(OWNER_A, 'create', 2)], 'back to the default word');
  assert.deepEqual(await stateInv(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 2 }, 'stored explicitly, at version 2');
  assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'create', T_A, 2), [await applied(OWNER_A, 'create', 3)], 'the same word again');
  for (const stale of [v0.version, 1, 2]) {
    assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'view', T_A, stale), [CONFLICT], `the draft at version ${stale} is refused`);
  }
  assert.deepEqual(await stateInv(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 3 }, 'the restored default stands');

  // Two owners of A edit from one read, sent together on the pool: one applies, the other is refused — whether the two
  // overlapped (the role row's lock) or ran one after the other (the pre-check) is not controlled here; the forced lock
  // wait is invoiceRoleLevels.integration's M5IRLH-07.
  await resetState();
  const first = await mint(OWNER_A);
  const second = await mint(OWNER_A2);
  const results = await Promise.all([setInv(first, 'technician', 'edit', T_A, 0), setInv(second, 'technician', 'full', T_A, 0)]);
  assert.deepEqual(results.map((r) => r[0].o_outcome).sort(), ['applied', 'version_conflict'], JSON.stringify(results));
  assert.equal((await stateInv(T_A, 'technician')).version, 1, 'exactly one edit counted');
});

// ---------------------------------------------------------------------------
// M5IRL-07: isolation between the two domains and between tenants
// ---------------------------------------------------------------------------

test('M5IRL-07: an Invoices edit leaves the Customers row and version untouched and the reverse; tenant A\'s edits are invisible in B; 020\'s levels read answers both domains; a customer decision ignores an Invoices row', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  // Invoices first: Customers untouched.
  assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'none', T_A, 0), [await applied(OWNER_A, 'none', 1)]);
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'sales_staff', domain: 'invoices', level: 'none' }], 'only the Invoices row');
  assert.deepEqual(await versionRows(T_A), [{ role_id: 'sales_staff', domain: 'invoices', version: 1 }]);
  assert.deepEqual(await stateCus(T_A, 'sales_staff'), none('sales_staff'), 'Customers reads level null, version 0');
  assert.equal((await create(salesKey)).length, 1, 'a customer decision ignores the Invoices none: sales_staff still creates at its Customers default');
  // Customers edit with the Invoices row in place: Invoices untouched.
  assert.deepEqual(await setCus(ownerKey, 'sales_staff', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)]);
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'sales_staff', domain: 'customers', level: 'view' }, { role_id: 'sales_staff', domain: 'invoices', level: 'none' }]);
  assert.deepEqual(await versionRows(T_A), [{ role_id: 'sales_staff', domain: 'customers', version: 1 }, { role_id: 'sales_staff', domain: 'invoices', version: 1 }]);
  assert.deepEqual(await stateInv(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'none', version: 1 }, 'the Invoices state stands');
  assert.deepEqual(await stateCus(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'view', version: 1 });
  assert.deepEqual(await create(salesKey), [], 'the Customers view now refuses a create');
  // Each domain's version is its own: a stale draft of one is not refused by the other's counter.
  assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'full', T_A, 1), [await applied(OWNER_A, 'full', 2)]);
  assert.deepEqual(await setCus(ownerKey, 'sales_staff', 'none', T_A, 1), [await applied(OWNER_A, 'none', 2)]);
  assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'view', T_A, 1), [CONFLICT], 'the Invoices counter is at 2');
  assert.deepEqual(await setCus(ownerKey, 'sales_staff', 'view', T_A, 1), [CONFLICT], 'the Customers counter is at 2');
  // 020's all-domain read answers both.
  assert.deepEqual((await runtime`select tmpos_role.m7a_role_levels(${T_A}::uuid, 'sales_staff'::text) as levels`)[0].levels,
    { customers: 'none', invoices: 'full' }, 'both domains');
  // Tenant B sees none of it.
  assert.deepEqual(await statesInv(T_B), ALL_NONE, 'A\'s Invoices edits are invisible in B');
  assert.deepEqual(await statesCus(T_B), ALL_NONE);
  assert.deepEqual((await runtime`select tmpos_role.m7a_role_levels(${T_B}::uuid, 'sales_staff'::text) as levels`)[0].levels, {});
  assert.deepEqual({ levels: await storedRows(T_B), versions: await versionRows(T_B) }, { levels: [], versions: [] });
  // B's owner edits B's Invoices level; A is untouched.
  assert.deepEqual(await setInv(await mint(OWNER_B), 'manager', 'none', T_B, 0), [await applied(OWNER_B, 'none', 1)]);
  assert.deepEqual(await stateInv(T_A, 'manager'), none('manager'), 'A is untouched by B');
  // A raw update of the Invoices row (the owner's) advances only the Invoices version.
  await owner`update tmpos_role.tenant_role_level set level = 'edit', updated_at = now() where tenant_id = ${T_A} and role_id = 'sales_staff' and domain = 'invoices'`;
  assert.deepEqual(await versionRows(T_A), [{ role_id: 'sales_staff', domain: 'customers', version: 2 }, { role_id: 'sales_staff', domain: 'invoices', version: 3 }],
    'the trigger counts the Invoices key alone');
  // Customers decisions the customer reads and creates make never read an Invoices row: reset Customers to the default
  // word with an Invoices row of the other word stored.
  assert.deepEqual(await setCus(ownerKey, 'sales_staff', 'create', T_A, 2), [await applied(OWNER_A, 'create', 3)]);
  assert.equal((await create(salesKey)).length, 1, 'Customers create, Invoices edit: creates');
});

// ---------------------------------------------------------------------------
// M5IRL-08: the upgrade — 026 over a 025 database that already holds Customers edits
// ---------------------------------------------------------------------------

test('M5IRL-08: 026 applied by the trusted executor over a 025 database (ledger 001-025) that already holds Customers edits and versions leaves them unchanged', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  const ownerB = await mint(OWNER_B);
  // Back to a real 025 database: 026's committed down file and its ledger row removed in one READ COMMITTED transaction
  // (no Invoices row exists, so the rollback runs). `restore` re-applies the file and re-inserts the exact row, for a failure.
  const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '025');
  assert.deepEqual(undone, ['029', '028', '027', '026'], 'only 026 (and 027, 028 and 029 above it, M7B-INVOICES-P1 and -P2) was above 025');
  try {
    assert.deepEqual((await owner`select pg_catalog.to_regnamespace('tmpos_role_invoice') is null as gone`)[0].gone, true);
    assert.deepEqual((await owner`select version from public.schema_migrations order by version`).map((r) => r.version),
      Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(3, '0')), 'the ledger is 001-025');
    assert.equal(await codeOf(statesInv(T_A)), '3F000', 'no tmpos_role_invoice schema to call');
    assert.equal(await codeOf(owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${T_A}, 'manager', 'invoices', 'none', now())`),
      '23514', 'at 025 an Invoices level row is refused by the narrow CHECK');
    // The Customers edits and versions a 025 database holds.
    assert.deepEqual(await setCus(ownerKey, 'sales_staff', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)]);
    assert.deepEqual(await setCus(ownerKey, 'sales_staff', 'none', T_A, 1), [await applied(OWNER_A, 'none', 2)]);
    assert.deepEqual(await setCus(ownerKey, 'manager', 'edit', T_A, 0), [await applied(OWNER_A, 'edit', 1)]);
    assert.deepEqual(await setCus(ownerB, 'technician', 'create', T_B, 0), [await applied(OWNER_B, 'create', 1)]);
    assert.equal((await create(await mint(TECHNICIAN_A))).length, 0, 'technician at its default view does not create');
    const before = {
      levels: [await storedRows(T_A), await storedRows(T_B)], versions: [await versionRows(T_A), await versionRows(T_B)],
      states: [await statesCus(T_A), await statesCus(T_B)],
      raw: (await owner`select tenant_id, role_id, domain, level, updated_at::text as updated_at from tmpos_role.tenant_role_level where tenant_id = any(${[T_A, T_B]}::uuid[]) order by 1, 2, 3`).map((r) => ({ ...r })),
    };
    assert.equal(before.levels[0].length, 2, 'A holds two Customers rows');
    // The upgrade as a deployment runs it: the trusted executor finds 026 pending and applies it, recording its ledger row.
    const upgrade = await trustedApply();
    assert.deepEqual([upgrade.outcome, upgrade.applied], ['complete', ['026', '027', '028', '029']], JSON.stringify(upgrade).slice(0, 400));
    const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
    assert.deepEqual(ledger.map((r) => [r.version, r.dirty, r.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, false, m.checksum]),
      'the ledger is 001-029 again, 026 at its pinned checksum');
    assert.deepEqual({
      levels: [await storedRows(T_A), await storedRows(T_B)], versions: [await versionRows(T_A), await versionRows(T_B)],
      states: [await statesCus(T_A), await statesCus(T_B)],
      raw: (await owner`select tenant_id, role_id, domain, level, updated_at::text as updated_at from tmpos_role.tenant_role_level where tenant_id = any(${[T_A, T_B]}::uuid[]) order by 1, 2, 3`).map((r) => ({ ...r })),
    }, before, 'every Customers row, version and read-back unchanged by the upgrade');
    assert.deepEqual(await statesInv(T_A), ALL_NONE, 'and every Invoices state is the default');
    // The upgraded database works for both: an Invoices edit beside the Customers ones, then the Customers edits continue.
    assert.deepEqual(await setInv(ownerKey, 'sales_staff', 'full', T_A, 0), [await applied(OWNER_A, 'full', 1)]);
    assert.deepEqual(await setCus(ownerKey, 'sales_staff', 'view', T_A, 2), [await applied(OWNER_A, 'view', 3)]);
    assert.deepEqual(await stateCus(T_A, 'manager'), { roleId: 'manager', level: 'edit', version: 1 });
  } finally {
    // A failure before the upgrade recorded 026: put back the file and the exact ledger row the rollback removed.
    if ((await owner`select count(*)::int as n from public.schema_migrations where version = '026'`)[0].n === 0) await restore();
  }
  assert.equal((await rolledBack('isolation level read committed', (tx) => tx.unsafe(POSTCONDITION_026).simple())).code, undefined, 'the upgraded state satisfies 026\'s postcondition');
});

// ---------------------------------------------------------------------------
// M5IRL-09: rollback and re-apply
// ---------------------------------------------------------------------------

test('M5IRL-09: 026 down refuses while an Invoices level row and its version, only an Invoices version row, or only an Invoices level row exists, and outside READ COMMITTED, leaving everything as it was; once the owner deletes them it removes its objects, restores both CHECKs, leaves 020\'s and 021\'s objects as they were; 026 re-applies cleanly', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  assert.deepEqual(await setCus(ownerKey, 'sales_staff', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)], 'a Customers edit stays through every rollback below');
  const before = await surface(owner);
  const NARROW_DEFS = ['tenant_role_level_domain_chk', 'role_level_version_domain_chk'];
  assert.ok(before.constraints.filter((c) => NARROW_DEFS.includes(c.name)).every((c) => c.def === WIDE && c.valid));
  const intact = async (label) => {
    assert.deepEqual(await surface(owner), before, `${label}: 020's and 021's objects, both CHECKs and every ACL exactly as before`);
    assert.deepEqual((await owner`select pg_catalog.to_regnamespace('tmpos_role_invoice') is not null as present`)[0].present, true, `${label}: 026's schema stands`);
    assert.equal((await rolledBack('isolation level read committed', (tx) => tx.unsafe(POSTCONDITION_026).simple())).code, undefined, `${label}: 026's postcondition holds`);
  };

  // (a) an Invoices level row (and its version).
  assert.deepEqual(await setInv(ownerKey, 'manager', 'none', T_A, 0), [await applied(OWNER_A, 'none', 1)]);
  const levelRefused = await rolledBack('isolation level read committed', (tx) => tx.unsafe(DOWN_026).simple());
  assert.equal(levelRefused.code, '55000');
  assert.match(levelRefused.message, /migration 026 rollback refused: an Invoices role level or version exists/);
  assert.equal(await codeOf(owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_026).simple())), '55000', 'committed attempt: refused too');
  await intact('level row present');
  assert.deepEqual(await stateInv(T_A, 'manager'), { roleId: 'manager', level: 'none', version: 1 }, 'the Invoices edit stands');

  // (b) only an Invoices version row: the level row deleted deliberately, the version row stays.
  await owner`delete from tmpos_role.tenant_role_level where tenant_id = ${T_A} and domain = 'invoices'`;
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'sales_staff', domain: 'customers', level: 'view' }]);
  assert.deepEqual((await versionRows(T_A)).filter((v) => v.domain === 'invoices'), [{ role_id: 'manager', domain: 'invoices', version: 1 }]);
  const versionRefused = await rolledBack('isolation level read committed', (tx) => tx.unsafe(DOWN_026).simple());
  assert.equal(versionRefused.code, '55000');
  assert.match(versionRefused.message, /migration 026 rollback refused: an Invoices role level or version exists/);
  await intact('version row only');

  // (b') only an Invoices level row: one stored as the owner, then every Invoices version row deleted deliberately — the
  // role table's guard alone must refuse.
  await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${T_A}, 'technician', 'invoices', 'none', now())`;
  await owner`delete from tmpos_role_edit.role_level_version where tenant_id = ${T_A} and domain = 'invoices'`;
  assert.deepEqual((await storedRows(T_A)).filter((l) => l.domain === 'invoices'), [{ role_id: 'technician', domain: 'invoices', level: 'none' }]);
  assert.deepEqual((await versionRows(T_A)).filter((v) => v.domain === 'invoices'), [], 'no Invoices version row');
  const levelOnlyRefused = await rolledBack('isolation level read committed', (tx) => tx.unsafe(DOWN_026).simple());
  assert.equal(levelOnlyRefused.code, '55000');
  assert.match(levelOnlyRefused.message, /migration 026 rollback refused: an Invoices role level or version exists/);
  await intact('level row only');
  await owner`delete from tmpos_role.tenant_role_level where tenant_id = ${T_A} and domain = 'invoices'`;

  // (c) outside READ COMMITTED: refused, even with nothing Invoices-shaped left.
  await owner`delete from tmpos_role_edit.role_level_version where tenant_id = ${T_A} and domain = 'invoices'`;
  const isolation = await rolledBack('isolation level repeatable read', (tx) => tx.unsafe(DOWN_026).simple());
  assert.equal(isolation.code, '55000');
  assert.match(isolation.message, /it must run under READ COMMITTED/);
  await intact('repeatable read');

  // (d) the owner deleted every Invoices row: the rollback runs and restores exactly the 025 database for what it touched.
  const customersBefore = { levels: await storedRows(T_A), versions: await versionRows(T_A) };
  await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_026).simple());
  try {
    const after = await surface(owner);
    assert.deepEqual(after.routines, before.routines, '020\'s and 021\'s routines: complete definition (pg_get_functiondef), owner and ACL byte for byte');
    assert.deepEqual(after.schemas, before.schemas, 'their schemas and ACLs as before');
    assert.deepEqual(after.tables, before.tables, 'their tables\' ACLs and row security as before');
    assert.deepEqual(after.triggers, before.triggers, '021\'s one trigger as before');
    assert.deepEqual(after.constraints.filter((c) => NARROW_DEFS.includes(c.name)).map((c) => [c.rel, c.def, c.valid]),
      [['tmpos_role.tenant_role_level', NARROW, true], ['tmpos_role_edit.role_level_version', NARROW, true]], 'both CHECKs are the narrow ones 020 and 021 create');
    assert.deepEqual(after.constraints.filter((c) => !NARROW_DEFS.includes(c.name)), before.constraints.filter((c) => !NARROW_DEFS.includes(c.name)), 'every other constraint as before');
    const [state] = await owner`select pg_catalog.to_regnamespace('tmpos_role_invoice') is null as gone,
        pg_catalog.has_function_privilege('tmpos_app', ${LEVELS_020}::regprocedure, 'EXECUTE') as levels,
        pg_catalog.has_function_privilege('tmpos_app', ${PAGE_020}::regprocedure, 'EXECUTE') as page,
        pg_catalog.has_function_privilege('tmpos_app', ${SET_V2}::regprocedure, 'EXECUTE') as set_v2,
        pg_catalog.has_function_privilege('tmpos_app', ${STATES_021}::regprocedure, 'EXECUTE') as states_021,
        pg_catalog.has_function_privilege('tmpos_app', ${SET_020}::regprocedure, 'EXECUTE') as set_020`;
    assert.deepEqual({ ...state }, { gone: true, levels: true, page: true, set_v2: true, states_021: true, set_020: false }, 'the schema gone; tmpos_app keeps 020\'s and 021\'s EXECUTEs');
    assert.deepEqual({ levels: await storedRows(T_A), versions: await versionRows(T_A) }, customersBefore, 'the Customers rows and versions untouched');
    assert.equal(await codeOf(setInv(ownerKey, 'manager', 'none', T_A, 0)), '3F000', 'no tmpos_role_invoice schema to call');
    assert.equal(await codeOf(owner`insert into tmpos_role_edit.role_level_version (tenant_id, role_id, domain, version) values (${T_A}, 'manager', 'invoices', 1)`), '23514', 'the narrow CHECK refuses an Invoices version again');
    const again = await rolledBack('isolation level read committed', (tx) => tx.unsafe(DOWN_026).simple());
    assert.equal(again.code, '55000', 'a second rollback is refused with a stated reason');
    assert.match(again.message, /migration 026 rollback refused: migration 026 is not applied/);
    assert.deepEqual(await stateCus(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'view', version: 1 }, '021\'s read-back still serves Customers');
  } finally {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(UP_026).simple());
  }
  // (e) re-applied: the same surface, the postcondition, and the edit works, its counter restarting at 0.
  await intact('re-applied');
  assert.deepEqual(await stateInv(T_A, 'manager'), none('manager'), 're-applied, the Invoices counter restarts at 0 (the rows were deleted deliberately)');
  assert.deepEqual(await setInv(ownerKey, 'manager', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)], 're-applied, the edit works');
  await resetState();
  const ledger = await owner`select version from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => r.version), Array.from({ length: 29 }, (_, i) => String(i + 1).padStart(3, '0')), 'the ledger is still 001-029');
});
