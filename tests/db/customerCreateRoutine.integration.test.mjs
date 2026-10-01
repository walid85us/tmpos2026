// Phase 4.0 M7A-CUSTOMERS-P3 — the customer create routine against REAL PostgreSQL: migration 019 (one SECURITY DEFINER
// routine, tmpos_customer_write.m7a_customer_create, whose ONLY authority argument is a minted tenant session's key),
// exercised as the runtime's own non-owner login (tmpos_app + tmpos_audit_writer). This file proves the database half
// alone, with no runtime in front of it; the HTTP route over it, and the runtime's comparison of the answer with its
// trusted context, are the application's to prove (a suite this file does not contain).
//
// WHAT IS PROVEN. 001-019 applied clean, 019's postcondition re-proven over the applied state and refusing every
// widening it names — among them a separate owner of one table the create rests on, held without inheritance — and 018's
// still holding; 019's preconditions, run as a non-superuser member of the owner, refusing an owner that lacks one of the
// privileges they check one at a time (M7CR-01); the login's effective privileges: no direct write to the customer
// table and no privilege on the session table, the mint ledger or the issuer key, so it can neither write a customer nor
// forge the session the routine trusts (M7CR-02); every refused key answering no row and writing nothing — forged,
// revoked, expired, administrative, an administrative session re-created over a revoked tenant session's surviving
// ledger row, technician, read-only or overdue tenant, read-only account, suspended tenant, store-only, technician plus a
// store manager grant, two tenant grants, a rotated issuer key, a grant moved to another tenant (M7CR-03); an allowed key
// creating exactly one row in its own tenant and answering the session's own tenant, actor and membership, with no tenant
// argument to name another (M7CR-04); the argument, CHECK, duplicate and isolation errors, with fixed text (M7CR-05); the
// SQL role set equal to the catalog's Customers >= Create decision, from the installed routine's source and by behaviour,
// for every TENANT_ROLE_IDS entry (M7CR-06); the rollback with customers present, the direct call then 3F000, and a clean
// re-apply restoring the same grants (M7CR-07); an issuer key rotation, and a session's expiry, that land while the create
// waits on the row it locks refusing it — the key row is locked, and the clock read, after the wait (M7CR-08); an owner's
// BEFORE INSERT trigger returning NULL making the create raise no_data_found with fixed text, nothing written (M7CR-09);
// the session's mint-ledger row held FOR SHARE until the create's transaction ends — a delete of it, and a change of its
// expiry, wait — and a ledger row deleted before the create refusing it while the session row itself stays live (M7CR-10);
// an expired key whose rows remain, and a live key minted under a since-replaced issuer key, refused before any lock: while
// the refused call's transaction stays open, the ledger row, the issuer key row and the principal's account row are all
// free (M7CR-11).
//
// THE CHAIN THROUGH 019 (M7A-CUSTOMERS-P3-R1). Migration 020 revokes the login's EXECUTE on 019's create routine (and on
// 018's page_v2), so this file — 019's own behaviour — applies 001-019 only: the migration file port the trusted executor
// reads hides every later file (tests/db/migrationsThrough.mjs). On a shared service where a later migration is already
// applied, that migration's own down file rolls it back first (with its ledger row), and it is re-applied, with its exact
// ledger row, when this file ends; so M7CR-07's rollback of 019 never runs under an applied 020. 020's replacement routines
// are proved by tests/db/tenantRoleLevelRoutine.integration.test.mjs.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a
// cluster this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every
// fixture is synthetic and randomly suffixed, and every issuer key is random bytes made here. It leaves the shared service
// as it found it: 019 applied, the issuer key row it found, no ledger, session or customer row of its own, and its login
// dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import { materializeTenantPermissions, meetsTenantPermissionLevel } from '../../server/platform-identity/permissionCatalog.ts';
import { TENANT_ROLE_IDS } from '../../server/platform-identity/authorizationConstants.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_018 = readFileSync(`${MIG_DIR}/018_m7a_tenant_session_mint.up.sql`, 'utf8');
const UP_019 = readFileSync(`${MIG_DIR}/019_m7a_customer_create.up.sql`, 'utf8');
const DOWN_019 = readFileSync(`${MIG_DIR}/019_m7a_customer_create.down.sql`, 'utf8');
/** Each file's section 8 / section 4 postcondition, run again on its own. */
const POSTCONDITION_018 = UP_018.slice(UP_018.lastIndexOf('do $$'));
const POSTCONDITION_019 = UP_019.slice(UP_019.lastIndexOf('do $$'));
/** 019's section 1, the preconditions: its first DO block. */
const PRECONDITION_019 = UP_019.slice(UP_019.indexOf('do $$'), UP_019.indexOf('\n$$;', UP_019.indexOf('do $$')) + 4);
const CREATE = 'tmpos_customer_write.m7a_customer_create(text, uuid, text)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7cr-migrator', runtimeRef: 'm7cr-runtime' };
const LOCK_KEY = 528_525;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7cr_probe';
const HOUR = 3_600_000;
const TENANT_LIFETIME = 8 * HOUR;
const ROLLBACK = new Error('m7cr: roll the proof back');
/** Every privilege has_table_privilege knows on PostgreSQL 16 (MAINTAIN is 17's). */
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
/** The tables the routine's authority and write rest on. */
const AUTHORITY_TABLES = ['tmpos_customer.customer', 'tmpos_session.session', 'tmpos_mint.tenant_session', 'tmpos_mint.issuer_key'];

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (as tenantSessionMint does)
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

const TARGET = resolveDisposableTarget('M7CR');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

const connect = (user, max) =>
  testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, installs the key, writes the fixtures and observes. RLS does not restrict it. */
const owner = connect(undefined, 3);
let runtime = null;
/** Every provider reference, tenant and session key this suite creates: what the final cleanup removes. */
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
/** The issuer key row this suite found (undefined until read, then the bytes or null), restored at the end. */
let keyBeforeSuite;
/**
 * The later migrations (020, and 021-023 since M7A-CUSTOMERS-P4 and -P6) this file rolled back to run on 001-019, re-applied at
 * the end. Its customers are created on 001-019, before 023's columns exist, so 023 re-applied finds them with no contact and
 * no creation time.
 */
let later = null;

test.after(async () => {
  const quietly = async (fn) => { try { await fn(); } catch { /* an earlier failure left less to clean */ } };
  // A failed M7CR-07 may have left 019 rolled back: the shared service is left with 019 applied, as it was found.
  await quietly(async () => {
    if ((await owner`select pg_catalog.to_regnamespace('tmpos_customer_write') is null as absent`)[0].absent) {
      await owner.begin((tx) => tx.unsafe(UP_019).simple());
    }
  });
  if (KEYS.size > 0) await quietly(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
  if (UIDS.length > 0) await owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`;
  if (TENANTS.length > 0) await owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
  // The shared service is left with the later migrations it had (020-023), each with its exact ledger row.
  if (later !== null) await later.restore();
  if (keyBeforeSuite !== undefined) {
    await quietly(async () => {
      await owner`delete from tmpos_mint.issuer_key`;
      if (keyBeforeSuite !== null) await owner`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${keyBeforeSuite})`;
    });
  }
  if (runtime) await runtime.end({ timeout: 5 });
  await owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`;
  await owner.unsafe(`drop owned by ${RUNTIME_LOGIN}`);
  await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: real migrations 001-019, a real non-owner runtime login, the key installed by the owner
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

later = await rollBackAbove(owner, MIG_DIR, '019');
let applyReport;
{
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    applyReport = await runTrustedApply({
      fsPort: portThrough(createNodeFsPort(MIG_DIR, MIG_REL), '019'), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7cr-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};

/** A synthetic actor: an identity, an account in `status`, and the given memberships. */
async function actor(label, memberships, status = 'active') {
  const uid = `m7cr-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  UIDS.push(uid);
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role = 'manager') => ({ scope: 'tenant', tenant, role });

const T_A = await newTenant('a');
const T_B = await newTenant('b');
const T_READ_ONLY = await newTenant('read-only', 'read_only');
const T_OVERDUE = await newTenant('overdue', 'overdue');
const T_SUSPEND = await newTenant('to-suspend');
const [{ store_id: STORE_A }] = await owner`insert into store (tenant_id, store_name, status)
  values (${T_A}, ${`m7cr-store-a-${SUFFIX}`}, 'active') returning store_id`;

/** One actor per durable tenant role, each holding exactly one tenant grant on A: M7CR-06's behavioural parity. */
const BY_ROLE = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (role) => [role, await actor(`role-${role}`, [tenantGrant(T_A, role)])])));
const MANAGER_A = BY_ROLE.manager;
const MANAGER_B = await actor('manager-b', [tenantGrant(T_B)]);
const READ_ONLY_TENANT = await actor('read-only-tenant', [tenantGrant(T_READ_ONLY)]);
const OVERDUE_TENANT = await actor('overdue-tenant', [tenantGrant(T_OVERDUE)]);
const READ_ONLY_ACCOUNT = await actor('read-only-account', [tenantGrant(T_A)], 'read_only');
const SUSPENDED_TENANT = await actor('suspended-tenant', [tenantGrant(T_SUSPEND)]);
const STORE_ONLY = await actor('store-only', [{ scope: 'store', tenant: T_A, store: STORE_A, role: 'manager' }]);
const TECHNICIAN_PLUS_STORE = await actor('technician-plus-store',
  [tenantGrant(T_A, 'technician'), { scope: 'store', tenant: T_A, store: STORE_A, role: 'manager' }]);
const TWO_GRANTS = await actor('two-grants', [tenantGrant(T_A), tenantGrant(T_B)]);
const MOVER = await actor('mover', [tenantGrant(T_A)]);

// ---------------------------------------------------------------------------
// the runtime login's calls
// ---------------------------------------------------------------------------

/** A session record for `who`, every stamp at `at` (the runtime's shape; the database checks none of it but the shapes). */
const record = (who, at = Date.now(), over = {}) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:m7cr', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at, ...over,
});
/** 018's mint as the runtime login, every argument explicit. Answers the outcome word. */
const mintAs = async (key, r, expiresAt, proof) => {
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint, ${proof}::bytea) as outcome`;
  return outcome;
};
/** A tenant session for `who`, minted as the runtime login under K, the key the suite installed. */
async function mint(who, { lifetime = TENANT_LIFETIME, at = Date.now() } = {}) {
  const key = newKey();
  const r = record(who, at);
  const expiresAt = r.createdAt + lifetime;
  assert.equal(await mintAs(key, r, expiresAt, proofOf(K, key, r, expiresAt)), 'created', `a tenant session for ${who.uid}`);
  return key;
}
/** 019's create, called directly as the runtime login. Answers its rows as plain objects; a raise rejects. */
const create = async (key, id = randomUUID(), name = `M7CR ${SUFFIX} ${randomUUID().slice(0, 4)}`, db = runtime) =>
  (await db`select o_tenant_id, o_actor_id, o_membership_id
    from tmpos_customer_write.m7a_customer_create(${key}::text, ${id}::uuid, ${name}::text)`).map((r) => ({ ...r }));
/** The customer rows under `id`, read by the owner. */
const rowsOf = async (id) => (await owner`select tenant_id, name from tmpos_customer.customer where customer_id = ${id}`).map((r) => ({ ...r }));
const suiteCustomers = async () =>
  (await owner`select count(*)::int as n from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`)[0].n;
/** Refused: no row answered, and no customer under the id asked for. */
async function refused(key, label) {
  const id = randomUUID();
  assert.deepEqual(await create(key, id), [], `${label}: no row answered`);
  assert.deepEqual(await rowsOf(id), [], `${label}: nothing written`);
}
/** The one tenant grant `who` holds, as the session's own tuple (016's actor_id, the grant's tenant and membership). */
async function ownTuple(who) {
  const [m] = await owner`select tenant_id, membership_id from user_membership where internal_user_id = ${who.id} and scope_type = 'tenant'`;
  return { o_tenant_id: m.tenant_id, o_actor_id: who.id, o_membership_id: m.membership_id };
}
/** The error a promise rejects with, as { code, message, detail } — or null when it resolves. */
const errorOf = (p) => p.then(() => null, (err) => ({ code: err.code, message: String(err.message), detail: err.detail }));
const codeOf = async (p) => (await errorOf(p))?.code ?? null;

/** Runs `fn` in an owner transaction that is always rolled back. Answers { value } or the { code, message } it raised. */
async function rolledBack(isolation, fn) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}

/** Resolves once a runtime-login backend waits on a Lock. Bounded: a timeout fails ("the lever did not engage"), never passes. */
async function untilBlocked(label) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const [{ n }] = await owner`select count(*)::int as n from pg_catalog.pg_stat_activity
      where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label}: the lever did not engage (no runtime backend waited on a lock)`);
}

// ---------------------------------------------------------------------------
// M7CR-01..02: the migration and the login's privileges
// ---------------------------------------------------------------------------

test('M7CR-01: 001-019 applied clean; 019\'s postcondition holds over the applied state and refuses every widening it names; 018\'s still holds', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019']
      .map((v) => [v, false]));
  assert.equal(ledger.at(-1).checksum, createHash('sha256').update(readFileSync(`${MIG_DIR}/019_m7a_customer_create.up.sql`)).digest('hex'),
    'the ledger records the committed 019 up file');

  // The routine as the catalog reads it back: one SECURITY DEFINER VOLATILE routine, pinned, EXECUTE to tmpos_app alone.
  const routines = await owner`select p.proname as name, p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
      pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
      (select coalesce(array_agg(pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable) order by 1), '{}')
         from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where g.grantee <> p.proowner) as grants
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_write'::regnamespace order by p.proname`;
  assert.deepEqual(routines.map((r) => ({ ...r })), [{
    name: 'm7a_customer_create', definer: true, volatility: 'v', config: ['search_path=pg_catalog, pg_temp', 'row_security=off'],
    args: 'p_session_key text, p_customer_id uuid, p_name text', grants: ['tmpos_app:EXECUTE:f'],
  }], 'the only authority argument is the session key: no tenant, actor, membership, role or version to name');

  // The postcondition refuses each deliberate widening — inside a transaction that is rolled back — and holds without one.
  const postcondition = async (widen, text = POSTCONDITION_019) => (await rolledBack('isolation level read committed', async (tx) => {
    for (const statement of widen) await tx.unsafe(statement);
    await tx.unsafe(text).simple();
  })).code ?? null;
  const [{ me }] = await owner`select current_user as me`;
  for (const [label, widen] of [
    ['a direct INSERT on the customer table', ['grant insert on tmpos_customer.customer to tmpos_app']],
    ['an INSERT on the mint ledger (a forged session)', ['grant insert on tmpos_mint.tenant_session to tmpos_app']],
    ['a SELECT on the issuer key', ['grant select on tmpos_mint.issuer_key to tmpos_app']],
    ['an UPDATE on the session table', ['grant update on tmpos_session.session to tmpos_audit_writer']],
    ['a column grant on the session table', ['grant select (session_key) on tmpos_session.session to tmpos_app']],
    ['EXECUTE to the audit writer', [`grant execute on function ${CREATE} to tmpos_audit_writer`]],
    ['EXECUTE to PUBLIC', [`grant execute on function ${CREATE} to public`]],
    ['EXECUTE with grant option', [`grant execute on function ${CREATE} to tmpos_app with grant option`]],
    ['USAGE on the schema to the audit writer', ['grant usage on schema tmpos_customer_write to tmpos_audit_writer']],
    ['forced row security on the customer table', ['alter table tmpos_customer.customer force row level security']],
    ['row security disabled on the mint ledger', ['alter table tmpos_mint.tenant_session disable row level security']],
    ['a STABLE routine', [`alter function ${CREATE} stable`]],
    ['an extra routine in the schema', ['create function tmpos_customer_write.m7cr_probe() returns int language sql as \'select 1\'']],
    ['membership in pg_write_all_data (an effective privilege)', ['grant pg_write_all_data to tmpos_app']],
    ['a NOINHERIT membership in the owner (SET ROLE reaches it; no privilege check shows it)',
      ['alter role tmpos_app noinherit', `grant "${me}" to tmpos_app`]],
    ['a non-owner role holding INSERT on the customer table, reachable only through SET ROLE',
      ['create role m7cr_writer nologin', 'grant usage on schema tmpos_customer to m7cr_writer',
        'grant insert on tmpos_customer.customer to m7cr_writer', 'alter role tmpos_app noinherit', 'grant m7cr_writer to tmpos_app']],
    ['anon reaching tmpos_app\'s EXECUTE only through SET ROLE', ['alter role anon noinherit', 'grant tmpos_app to anon']],
  ]) {
    assert.equal(await postcondition(widen), '55000', `${label} is refused`);
  }
  // Each membership clause, and the exact 018 surface, alone: refused by its own message, no earlier clause seeing it.
  const refusal = (widen) => rolledBack('isolation level read committed', async (tx) => {
    for (const statement of widen) await tx.unsafe(statement);
    await tx.unsafe(POSTCONDITION_019).simple();
  });
  for (const [label, widen, message] of [
    ['(i) tmpos_app a member of a role holding nothing', ['create role m7cr_other nologin', 'grant m7cr_other to tmpos_app'],
      /tmpos_app and tmpos_audit_writer must be members of nothing \(tmpos_app in m7cr_other\)/],
    ['(i) tmpos_audit_writer a member of a role holding nothing',
      ['create role m7cr_other nologin', 'grant m7cr_other to tmpos_audit_writer'],
      /must be members of nothing \(tmpos_audit_writer in m7cr_other\)/],
    ['(j) authenticated a member of tmpos_audit_writer', ['grant tmpos_audit_writer to authenticated'],
      /anon and authenticated must reach neither tmpos_app nor tmpos_audit_writer by membership \(authenticated in tmpos_audit_writer\)/],
    ['(g) anon reaching, only through SET ROLE, a non-owner role holding INSERT on the customer table',
      ['create role m7cr_writer nologin', 'grant usage on schema tmpos_customer to m7cr_writer',
        'grant insert on tmpos_customer.customer to m7cr_writer', 'alter role anon noinherit', 'grant m7cr_writer to anon'],
      /anon on tmpos_customer\.customer holds an effective privilege on a table the create rests on/],
    ['(g) a column grant to a role no runtime role reaches', ['create role m7cr_reader nologin',
      'grant select (session_key) on tmpos_session.session to m7cr_reader'],
      /a column grant exists on a table the create rests on/],
    ['(h) one of 018\'s five routines replaced, the count unchanged',
      ['drop function tmpos_mint.m7a_issuer_key_check(bytea)', 'create function tmpos_mint.m7cr_probe() returns int language sql as \'select 1\''],
      /schema tmpos_customer or tmpos_mint does not hold what 017 and 018 left/],
  ]) {
    const out = await refusal(widen);
    assert.equal(out.code, '55000', `${label} is refused`);
    assert.match(out.message, message, label);
  }
  // A column grant later revoked leaves no grant, and is not refused. (PostgreSQL 16 stores NULL, not an empty ACL, for a
  // column whose last grant is revoked, so this holds under a NULL test as well as under the entry test the file makes.)
  const revokedColumn = await rolledBack('isolation level read committed', async (tx) => {
    await tx.unsafe('grant select (session_key) on tmpos_session.session to tmpos_audit_writer');
    await tx.unsafe('revoke select (session_key) on tmpos_session.session from tmpos_audit_writer');
    const [{ acl }] = await tx`select attacl::text as acl from pg_catalog.pg_attribute
      where attrelid = 'tmpos_session.session'::regclass and attname = 'session_key'`;
    await tx.unsafe(POSTCONDITION_019).simple();
    return acl;
  });
  assert.deepEqual(revokedColumn, { value: null }, 'a revoked column grant leaves a NULL ACL and is not refused');
  // (f)'s table-owner arm alone: a separate owner of ONE table the create rests on (not the schema's, not the routine's),
  // held by tmpos_app without inheritance, so no privilege check in (g) sees it.
  const tableOwner = await rolledBack('isolation level read committed', async (tx) => {
    await tx.unsafe('create role m7cr_table_owner nologin');
    await tx.unsafe('alter table tmpos_mint.issuer_key owner to m7cr_table_owner');
    await tx.unsafe('alter role tmpos_app noinherit');
    await tx.unsafe('grant m7cr_table_owner to tmpos_app');
    await tx.unsafe(POSTCONDITION_019).simple();
  });
  assert.equal(tableOwner.code, '55000', 'a membership in one table\'s separate owner is refused');
  assert.match(tableOwner.message, /tmpos_app is a member of the owner of schema tmpos_customer_write, its routine, or a table it rests on/);
  assert.equal(await postcondition([]), null, 'the state 019 left satisfies it');

  // Section 1, the preconditions, over a chain without 019, as a NON-superuser member of the owner (a superuser passes
  // every privilege check). With every privilege held they pass; with one the owner revoked from itself they refuse —
  // each checked alone, so a SELECT still held does not answer for a missing UPDATE.
  const precondition = (revoke) => rolledBack('isolation level read committed', async (tx) => {
    await tx.unsafe('drop schema tmpos_customer_write cascade');
    await tx.unsafe('create role m7cr_applier nologin nosuperuser inherit');
    await tx.unsafe(`grant "${me}" to m7cr_applier`);
    for (const statement of revoke) await tx.unsafe(statement);
    await tx.unsafe('set local role m7cr_applier');
    await tx.unsafe(PRECONDITION_019).simple();
  });
  assert.equal((await precondition([])).code, undefined, 'the preconditions hold for a member of the owner');
  for (const [label, revoke] of [
    ['UPDATE on the session table (SELECT still held)', `revoke update on tmpos_session.session from "${me}"`],
    ['SELECT on the mint ledger', `revoke select on tmpos_mint.tenant_session from "${me}"`],
    ['UPDATE on the mint ledger (SELECT still held)', `revoke update on tmpos_mint.tenant_session from "${me}"`],
    ['UPDATE on the issuer key (SELECT still held)', `revoke update on tmpos_mint.issuer_key from "${me}"`],
    ['INSERT on the customer table', `revoke insert on tmpos_customer.customer from "${me}"`],
  ]) {
    const out = await precondition([revoke]);
    assert.equal(out.code, '42501', `an owner without ${label} is refused`);
    assert.match(out.message, /the applying principal lacks SELECT or UPDATE/, label);
  }
  assert.equal(await postcondition([], POSTCONDITION_018), null, '018\'s own postcondition still holds: 019 left its surface as it was');
  const [after] = await owner`select pg_catalog.has_table_privilege('tmpos_app', 'tmpos_customer.customer', 'INSERT') as granted,
    (select rolinherit from pg_catalog.pg_roles where rolname = 'tmpos_app') as inherits`;
  assert.deepEqual({ ...after }, { granted: false, inherits: true }, 'the widenings did not survive');
});

test('M7CR-02: as the application login: no direct write to the customer table, and no privilege on the session table, the mint ledger or the issuer key', async () => {
  // Effective privileges, from the login's own session: none on any of the four tables, by any path.
  for (const table of AUTHORITY_TABLES) {
    for (const privilege of TABLE_PRIVILEGES) {
      const [{ held }] = await runtime`select pg_catalog.has_table_privilege(current_user, ${table}::regclass, ${privilege}) as held`;
      assert.equal(held, false, `the login holds no ${privilege} on ${table}`);
    }
  }
  // And the statements themselves refused, not silently filtered.
  for (const [label, statement] of [
    ['INSERT a customer', `insert into tmpos_customer.customer (customer_id, tenant_id, name) values ('${randomUUID()}', '${T_A}', 'm7cr direct')`],
    ['UPDATE customers', 'update tmpos_customer.customer set name = name'],
    ['DELETE customers', 'delete from tmpos_customer.customer'],
    ['TRUNCATE customers', 'truncate tmpos_customer.customer'],
    ['SELECT customers', 'select customer_id from tmpos_customer.customer limit 1'],
    ['INSERT a session row', 'insert into tmpos_session.session (session_key) values (\'m7cr-forged\')'],
    ['UPDATE session rows', 'update tmpos_session.session set expires_at = expires_at'],
    ['INSERT a mint-ledger row', 'insert into tmpos_mint.tenant_session (session_key) values (\'m7cr-forged\')'],
    ['SELECT the issuer key', 'select key from tmpos_mint.issuer_key'],
  ]) {
    assert.equal(await codeOf(runtime.unsafe(statement)), '42501', `${label} is refused`);
  }
  // The login executes the routine; the audit writer, anon and authenticated do not, by any path.
  const [grants] = await owner`select pg_catalog.has_function_privilege('tmpos_app', ${CREATE}, 'EXECUTE') as app,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${CREATE}, 'EXECUTE') as audit_writer,
      pg_catalog.has_function_privilege('anon', ${CREATE}, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${CREATE}, 'EXECUTE') as authenticated`;
  assert.deepEqual({ ...grants }, { app: true, audit_writer: false, anon: false, authenticated: false });
});

// ---------------------------------------------------------------------------
// M7CR-03..05: the routine's answers
// ---------------------------------------------------------------------------

test('M7CR-03: every refused key answers no row and writes nothing', async () => {
  const before = await suiteCustomers();
  await refused(newKey(), 'a well-formed key naming no session');

  const revoked = await mint(MANAGER_A);
  await runtime`select tmpos_session.m5_session_revoke(${revoked}::text)`;
  await refused(revoked, 'a revoked (logged-out) session');
  await refused(await mint(MANAGER_A, { lifetime: HOUR, at: Date.UTC(2023, 10, 14) }), 'an expired session');

  const adminKey = newKey();
  const at = Date.now();
  assert.equal(await mintAs(adminKey, record(MANAGER_A, at, { audience: 'admin' }), at + HOUR, null), 'created');
  await refused(adminKey, 'an administrative session (no ledger row, audience admin)');

  // The audience filter alone. A revoked tenant session's ledger row outlives it (018), and the login re-creates the same
  // key as an ADMINISTRATIVE session, which needs no proof: same principal, same expiry, standing and issuer key unchanged,
  // so the ledger join, the expiry equality and both digests all match. Only audience = 'tenant' refuses it.
  const reusedKey = newKey();
  const reused = record(MANAGER_A, Date.now());
  const reusedExpiry = reused.createdAt + HOUR;
  assert.equal(await mintAs(reusedKey, reused, reusedExpiry, proofOf(K, reusedKey, reused, reusedExpiry)), 'created');
  await runtime`select tmpos_session.m5_session_revoke(${reusedKey}::text)`;
  assert.equal(await mintAs(reusedKey, { ...reused, audience: 'admin' }, reusedExpiry, null), 'created',
    'the key re-created as an administrative session over the surviving ledger row');
  await refused(reusedKey, 'an administrative session over a revoked tenant session\'s ledger row');

  await refused(await mint(BY_ROLE.technician), 'a technician\'s live key (Customers at View)');
  await refused(await mint(READ_ONLY_TENANT), 'a read_only tenant');
  await refused(await mint(OVERDUE_TENANT), 'an overdue tenant');
  await refused(await mint(READ_ONLY_ACCOUNT), 'a read_only account');
  await refused(await mint(STORE_ONLY), 'a store-grant-only actor');
  await refused(await mint(TECHNICIAN_PLUS_STORE), 'a technician tenant grant plus a store manager grant in the same tenant');
  await refused(await mint(TWO_GRANTS), 'two tenant grants (ambiguous)');

  // Minted while standing, then the tenant suspended: 016's answer drops the grant on it (007), so the digest moves AND no
  // tenant grant remains. The mover below is the case only the digest check refuses.
  const suspendKey = await mint(SUSPENDED_TENANT);
  await owner`update tenant set status = 'suspended' where tenant_id = ${T_SUSPEND}`;
  await refused(suspendKey, 'a tenant suspended after mint');

  // Minted under K, then the key rotated: the issuer digest no longer matches. Put back, the session is good again.
  const rotatedKey = await mint(MANAGER_A);
  await installTestIssuerKey(owner, randomBytes(32));
  try {
    await refused(rotatedKey, 'a session minted under a rotated issuer key');
  } finally {
    await installTestIssuerKey(owner, K);
  }

  // The actor's one grant moved from A to B: the old key follows no one to B, and a fresh key creates only in B.
  const moverKey = await mint(MOVER);
  await owner`update user_membership set tenant_id = ${T_B} where internal_user_id = ${MOVER.id} and scope_type = 'tenant'`;
  await refused(moverKey, 'a key minted before the actor\'s grant moved to another tenant');
  assert.equal(await suiteCustomers(), before, 'no refusal wrote a customer');

  const moved = await create(await mint(MOVER));
  assert.deepEqual(moved, [await ownTuple(MOVER)]);
  assert.equal(moved[0].o_tenant_id, T_B, 're-minted after the move, it creates in B, the tenant its standing now names');
});

test('M7CR-04: an allowed key creates exactly one row in its own tenant and answers the session\'s own tenant, actor and membership', async () => {
  const key = await mint(MANAGER_A);
  const id = randomUUID();
  const name = `M7CR manager ${SUFFIX}`;
  const answer = await create(key, id, name);
  assert.deepEqual(answer, [await ownTuple(MANAGER_A)], 'one row: the session\'s own tenant, actor and membership');
  assert.deepEqual(await rowsOf(id), [{ tenant_id: T_A, name }], 'the customer is A\'s, stored byte-exact');

  // There is no tenant input: repeated calls with A's key only ever create in A, and B's key only in B.
  for (let i = 0; i < 3; i++) assert.equal((await create(key))[0].o_tenant_id, T_A);
  const keyB = await mint(MANAGER_B);
  const inB = randomUUID();
  assert.deepEqual(await create(keyB, inB), [await ownTuple(MANAGER_B)]);
  assert.deepEqual((await rowsOf(inB)).map((r) => r.tenant_id), [T_B]);

  // 018's session-bound read: each key answers a real page of its own tenant's customers (not 'denied' or 'invalid',
  // which name no customer and would make "not listed" vacuous), A's listing `id` and not `inB`, B's the reverse.
  const listed = async (k, tenant, label) => {
    const rows = await runtime`select o_outcome, o_tenant_id, o_customer_id
      from tmpos_mint.m7a_customer_page_v2(${k}::text, null::uuid, 101::integer)`;
    assert.ok(rows.length > 0 && rows.every((r) => r.o_outcome === 'customer' && r.o_tenant_id === tenant),
      `${label}: a page of its own tenant's customers (${JSON.stringify(rows[0])})`);
    return rows.map((r) => r.o_customer_id);
  };
  const pageA = await listed(key, T_A, 'A\'s read');
  assert.ok(pageA.includes(id) && !pageA.includes(inB), 'A\'s read lists A\'s customer and not B\'s');
  const pageB = await listed(keyB, T_B, 'B\'s read');
  assert.ok(pageB.includes(inB) && !pageB.includes(id), 'B\'s read lists B\'s customer and not A\'s');
});

test('M7CR-05: malformed arguments raise 22023, a CHECK failure 23514 and a duplicate id 23505 — fixed text, neither the name nor the id — and outside READ COMMITTED 55000', async () => {
  const key = await mint(MANAGER_A);
  for (const [label, args] of [
    ['a null key', [null, randomUUID(), 'x']],
    ['a key outside 011\'s shape', ['has a space', randomUUID(), 'x']],
    ['a null id', [key, null, 'x']],
    ['a version-1 id', [key, 'c232ab00-9414-11ec-b3c8-9f6bdeced846', 'x']],
    ['a null name', [key, randomUUID(), null]],
  ]) {
    assert.equal(await codeOf(create(...args)), '22023', label);
  }

  const id = randomUUID();
  assert.equal((await create(key, id, `M7CR taken ${SUFFIX}`)).length, 1);
  const duplicate = await errorOf(create(key, id, `M7CR again ${SUFFIX}`));
  assert.deepEqual(duplicate, { code: '23505', message: 'migration 019 create: the customer id is already taken', detail: undefined });

  const before = await suiteCustomers();
  for (const [label, name] of [
    ['leading whitespace', ` Leading ${SUFFIX}`],
    ['trailing whitespace', `Trailing ${SUFFIX} `],
    ['a C0 control', `Bell\u0007${SUFFIX}`],
    ['a Bidi control', `Right‮${SUFFIX}`],
    ['a line separator', `Line ${SUFFIX}`],
    ['201 characters', `${SUFFIX}${'x'.repeat(201 - SUFFIX.length)}`],
  ]) {
    const nameId = randomUUID();
    const err = await errorOf(create(key, nameId, name));
    assert.deepEqual(err, { code: '23514', message: 'migration 019 create: the name is not one the customer table admits', detail: undefined }, label);
    assert.ok(!err.message.includes(SUFFIX) && !err.message.includes(nameId), `${label}: the text names neither the name nor the id`);
  }
  assert.equal(await suiteCustomers(), before, 'no refused name was written');

  for (const isolation of ['isolation level repeatable read', 'isolation level serializable']) {
    let code = null;
    await runtime.begin(isolation, (tx) => create(key, randomUUID(), `M7CR iso ${SUFFIX}`, tx)).catch((err) => { code = err.code; });
    assert.equal(code, '55000', isolation);
  }
});

// ---------------------------------------------------------------------------
// M7CR-06: the SQL role set is the catalog's Customers >= Create decision
// ---------------------------------------------------------------------------

test('M7CR-06: the routine\'s role set equals the catalog\'s Customers >= Create for every TENANT_ROLE_IDS entry — from the installed source and by behaviour', async () => {
  const catalog = TENANT_ROLE_IDS.filter((role) => meetsTenantPermissionLevel(materializeTenantPermissions(role, {}, false).customers, 'create'));
  assert.deepEqual([...catalog].sort(), ['manager', 'sales_staff', 'store_owner'], 'the catalog\'s answer this parity pins');
  // A read-only limitation caps every role below Create: the routine's write allow-list refuses what the catalog would.
  assert.deepEqual(TENANT_ROLE_IDS.filter((role) => meetsTenantPermissionLevel(materializeTenantPermissions(role, {}, true).customers, 'create')), []);

  const setIn = (source, label) => {
    const found = [...source.matchAll(/->> 'roleId'\) not in \(([^)]*)\)/g)];
    assert.equal(found.length, 1, `${label}: exactly one role set`);
    return found[0][1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort();
  };
  const [{ source }] = await owner`select pg_catalog.pg_get_functiondef(${CREATE}::regprocedure) as source`;
  assert.deepEqual(setIn(source, 'the installed routine'), [...catalog].sort());
  assert.deepEqual(setIn(UP_019, 'the migration file'), [...catalog].sort());

  // By behaviour: a live key of each role, holding exactly one tenant grant, creates iff the catalog grants Create.
  for (const role of TENANT_ROLE_IDS) {
    const who = BY_ROLE[role];
    const id = randomUUID();
    const answer = await create(await mint(who), id);
    if (catalog.includes(role)) {
      assert.deepEqual(answer, [await ownTuple(who)], `${role} creates`);
      assert.deepEqual((await rowsOf(id)).map((r) => r.tenant_id), [T_A], `${role}: in its own tenant`);
    } else {
      assert.deepEqual(answer, [], `${role} is refused`);
      assert.deepEqual(await rowsOf(id), [], `${role}: nothing written`);
    }
  }
});

// ---------------------------------------------------------------------------
// M7CR-07: rollback and re-apply
// ---------------------------------------------------------------------------

test('M7CR-07: 019 down with customers present removes only its own objects — the direct call is then 3F000 and the customers stay readable — and 019 re-applies cleanly with the same grants', async () => {
  const key = await mint(MANAGER_A);
  const id = randomUUID();
  assert.equal((await create(key, id, `M7CR kept ${SUFFIX}`)).length, 1);
  const aclOf = async () => (await owner`select p.proacl::text as acl, n.nspacl::text as schema_acl
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where p.oid = ${CREATE}::regprocedure`)
    .map((r) => ({ ...r }))[0];
  const aclBefore = await aclOf();

  // Committed, as a real rollback would be.
  await owner.begin((tx) => tx.unsafe(DOWN_019).simple());
  try {
    assert.equal(await codeOf(create(key)), '3F000', 'no tmpos_customer_write schema to call');
    const [state] = await owner`select pg_catalog.to_regnamespace('tmpos_customer_write') is null as gone,
        (select count(*)::int from tmpos_customer.customer where customer_id = ${id}) as kept,
        pg_catalog.to_regprocedure('tmpos_mint.m7a_customer_page_v2(text, uuid, integer)') is not null as read_018`;
    assert.deepEqual({ ...state }, { gone: true, kept: 1, read_018: true }, 'the customer stays, and so does 018\'s read');
    const [{ listed }] = await runtime`select count(*)::int as listed from tmpos_mint.m7a_customer_page_v2(${key}::text, null::uuid, 101::integer)
      where o_customer_id = ${id}`;
    assert.equal(listed, 1, 'still readable through 018\'s session-bound read');
  } finally {
    await owner.begin((tx) => tx.unsafe(UP_019).simple());
  }
  const [me] = await owner`select current_user as name`;
  assert.deepEqual(await aclOf(), aclBefore, 're-applied, the routine and the schema carry exactly the grants a fresh apply writes');
  assert.match(aclBefore.acl, new RegExp(`^\\{${me.name}=X/${me.name},tmpos_app=X/${me.name}\\}$`));
  assert.deepEqual(await create(key), [await ownTuple(MANAGER_A)], 're-applied, the create works for the same live session');
});

// ---------------------------------------------------------------------------
// M7CR-08: the key row is locked, and the clock read, after the create's lock waits
// ---------------------------------------------------------------------------

test('M7CR-08: an issuer key rotation, and a session\'s expiry, that land while the create waits on the row it locks refuse it', async () => {
  // (1) The owner rotates the key and holds the row; the create waits on the key row (FOR SHARE), then reads the rotated
  //     key and refuses. Read without the lock, it would take the committed old key and create.
  const rotating = await mint(MANAGER_A);
  const rotatedId = randomUUID();
  let pending;
  try {
    await owner.begin(async (tx) => {
      await tx`update tmpos_mint.issuer_key set key = ${randomBytes(32)} where singleton`;
      pending = create(rotating, rotatedId);
      pending.catch(() => {});
      await untilBlocked('a create waiting on the issuer key row');
    });
    assert.deepEqual(await pending, [], 'a rotation committed while it waited refuses the create');
    assert.deepEqual(await rowsOf(rotatedId), [], 'nothing written');
  } finally {
    await installTestIssuerKey(owner, K);
  }

  // (2) The owner holds the session row past its expiry; the create, begun while the session was live, waits on it (FOR
  //     SHARE) and then reads the clock: expired, refused. On the calling statement's clock it would still be live.
  const lifetime = 4_000;
  const at = Date.now();
  const expiring = await mint(MANAGER_A, { lifetime, at });
  const expiredId = randomUUID();
  await owner.begin(async (tx) => {
    await tx`select 1 from tmpos_session.session where session_key = ${expiring} for update`;
    pending = create(expiring, expiredId);
    pending.catch(() => {});
    await untilBlocked('a create waiting on its session row');
    assert.ok(Date.now() < at + lifetime - 500, 'the create began waiting while the session was live (else this proves nothing)');
    while (Date.now() <= at + lifetime + 250) await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.deepEqual(await pending, [], 'a session that expired while the create waited refuses it');
  assert.deepEqual(await rowsOf(expiredId), [], 'nothing written');

  // Control: the same waits with nothing changing under them create.
  const steady = await mint(MANAGER_A);
  await owner.begin(async (tx) => {
    await tx`select 1 from tmpos_mint.issuer_key where singleton for update`;
    await tx`select 1 from tmpos_session.session where session_key = ${steady} for update`;
    pending = create(steady);
    pending.catch(() => {});
    await untilBlocked('a create waiting on rows nothing changes');
  });
  assert.deepEqual(await pending, [await ownTuple(MANAGER_A)], 'released unchanged, the create proceeds');
});

// ---------------------------------------------------------------------------
// M7CR-09: a row the INSERT did not write is never answered as created
// ---------------------------------------------------------------------------

test('M7CR-09: a BEFORE INSERT trigger returning NULL (only the table owner can install one) makes the create raise P0002 with fixed text, writing nothing', async () => {
  const key = await mint(MANAGER_A);
  const id = randomUUID();
  const before = await suiteCustomers();
  await owner.unsafe('drop schema if exists m7cr_proof cascade');
  await owner.unsafe('create schema m7cr_proof');
  try {
    await owner.unsafe(`create function m7cr_proof.skip() returns trigger language plpgsql
      set search_path = pg_catalog, pg_temp as $$ begin return null; end $$`);
    await owner.unsafe('revoke all on function m7cr_proof.skip() from public');
    await owner.unsafe('create trigger m7cr_skip before insert on tmpos_customer.customer for each row execute function m7cr_proof.skip()');
    assert.deepEqual(await errorOf(create(key, id)),
      { code: 'P0002', message: 'migration 019 create: the customer row was not written', detail: undefined });
    assert.deepEqual(await rowsOf(id), [], 'nothing written');
  } finally {
    await owner.unsafe('drop trigger if exists m7cr_skip on tmpos_customer.customer');
    await owner.unsafe('drop schema if exists m7cr_proof cascade');
  }
  assert.equal(await suiteCustomers(), before, 'no customer was written');
  assert.deepEqual(await create(key, id), [await ownTuple(MANAGER_A)], 'without the trigger, the same key and id create');
});

// ---------------------------------------------------------------------------
// M7CR-10: the mint-ledger row is held with the session row
// ---------------------------------------------------------------------------

test('M7CR-10: the session\'s mint-ledger row is held FOR SHARE until the create\'s transaction ends — a delete or a change of it waits — and one deleted before the create refuses it', async () => {
  const key = await mint(MANAGER_A);
  const id = randomUUID();
  const name = `M7CR held ${SUFFIX}`;
  /** An owner write to this session's ledger row under a 300 ms lock bound, always rolled back: '55P03' when it waited. */
  const ledgerWrite = (statement) => codeOf(owner.begin(async (tx) => {
    await tx`set local lock_timeout = '300ms'`;
    await tx.unsafe(statement, [key]);
    throw ROLLBACK;
  }));
  await runtime.begin(async (tx) => {
    assert.deepEqual(await create(key, id, name, tx), [await ownTuple(MANAGER_A)], 'the create answered its row');
    assert.equal(await ledgerWrite('delete from tmpos_mint.tenant_session where session_key = $1'), '55P03',
      'a delete of the ledger row waits for the create\'s transaction');
    assert.equal(await ledgerWrite('update tmpos_mint.tenant_session set expires_at = expires_at - 1 where session_key = $1'), '55P03',
      'a change of the ledger row\'s expiry waits for it too');
  });
  assert.deepEqual(await rowsOf(id), [{ tenant_id: T_A, name }], 'the create committed');

  // Once it has ended the delete proceeds without waiting, and, committed before the next create, refuses it: the session
  // row is still there, live and of audience 'tenant', so the missing ledger row alone answers no row.
  const deleted = await owner.begin(async (tx) => {
    await tx`set local lock_timeout = '300ms'`;
    return (await tx`delete from tmpos_mint.tenant_session where session_key = ${key} returning session_key`).length;
  });
  assert.equal(deleted, 1, 'the ledger row is deleted once the create\'s transaction has ended');
  const [{ n }] = await owner`select count(*)::int as n from tmpos_session.session
    where session_key = ${key} and audience = 'tenant' and expires_at > floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
  assert.equal(n, 1, 'the session row itself is still there and live');
  await refused(key, 'a live tenant session whose ledger row was deleted before the create');
});

// ---------------------------------------------------------------------------
// M7CR-11: a key refused before the locks holds no row
// ---------------------------------------------------------------------------

test('M7CR-11: an expired key whose rows remain, and a live key minted under a replaced issuer key, are refused before any lock — while the refused call\'s transaction stays open, its ledger row, the issuer key row and its account row are free', async () => {
  const who = MANAGER_A;
  /** An owner statement under a 300 ms lock bound, always rolled back: { code: null, rows } when it ran, code '55P03' when it waited. */
  const ownerProbe = async (write) => {
    let rows = null;
    const code = await codeOf(owner.begin(async (tx) => {
      await tx`set local lock_timeout = '300ms'`;
      rows = (await write(tx)).count;
      throw ROLLBACK;
    }));
    return { code, rows };
  };
  const PROBES = ['a delete of its ledger row (018\'s prune in every tenant login)', 'a change of the issuer key row (a rotation)',
    'its account row FOR UPDATE NOWAIT (the row 016\'s hold locks)'];
  /** Every probe proceeding at once, 1 row each: what a call that locked no row leaves. */
  const FREE = Object.fromEntries(PROBES.map((what) => [what, { code: null, rows: 1 }]));
  /**
   * Inside one open runtime transaction: the create answers no row, then the three owner probes run. Once that
   * transaction has COMMITTED, the owner finds no customer under the id: an uncommitted insert is invisible to the
   * owner's connection, so "nothing written" is judged only after runtime.begin resolves.
   */
  const whileOpen = async (key, label) => {
    const id = randomUUID();
    const seen = await runtime.begin(async (tx) => {
      assert.deepEqual(await create(key, id, undefined, tx), [], `${label}: no row answered`);
      const writes = [
        (o) => o`delete from tmpos_mint.tenant_session where session_key = ${key}`,
        (o) => o`update tmpos_mint.issuer_key set key = ${randomBytes(32)} where singleton`,
        (o) => o`select 1 from public.app_user where internal_user_id = ${who.id} for update nowait`,
      ];
      const probes = {};
      for (const [i, what] of PROBES.entries()) probes[what] = await ownerProbe(writes[i]);
      return probes;
    });
    assert.deepEqual(await rowsOf(id), [], `${label}: nothing written (after the transaction committed)`);
    return seen;
  };
  const rowsNow = async (key) => (await owner`select s.expires_at = m.expires_at as same_expiry,
      s.expires_at > floor(extract(epoch from clock_timestamp()) * 1000)::bigint as live,
      m.expires_at <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 86400000 as prunable
    from tmpos_session.session s join tmpos_mint.tenant_session m on m.session_key = s.session_key
    where s.session_key = ${key} and s.audience = 'tenant'`).map((r) => ({ ...r }));

  // (a) Expired years ago, both rows still there (nothing has pruned them yet): a day past expiry, so 018's prune in any
  //     tenant login would delete its ledger row — and wait on it, were it held.
  const expired = await mint(who, { lifetime: HOUR, at: Date.UTC(2023, 10, 14) });
  assert.deepEqual(await rowsNow(expired), [{ same_expiry: true, live: false, prunable: true }], 'an expired key whose session and ledger rows remain');
  const seen = { expired: await whileOpen(expired, 'an expired key') };

  // (b) Live, minted under K, then K replaced: only the issuer digest refuses it.
  const stale = await mint(who);
  assert.deepEqual(await rowsNow(stale), [{ same_expiry: true, live: true, prunable: false }], 'a live key');
  await installTestIssuerKey(owner, randomBytes(32));
  try {
    seen.staleIssuer = await whileOpen(stale, 'a live key minted under a replaced issuer key');
  } finally {
    await installTestIssuerKey(owner, K);
  }
  assert.deepEqual(seen, { expired: FREE, staleIssuer: FREE },
    'while the refused call\'s transaction was open, every probe proceeded at once (a held row answers 55P03)');
});
