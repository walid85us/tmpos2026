// Phase 4.0 M7A-CUSTOMERS-P3-R1 — owner-edited Customers levels against REAL PostgreSQL: migration 020 (schema tmpos_role:
// the table tenant_role_level and four SECURITY DEFINER routines — the levels read, the owner's edit, the create and the
// read that decide on the stored level), exercised as the runtime's own non-owner login (tmpos_app + tmpos_audit_writer).
// This file proves the database half alone, with no runtime in front of it; the HTTP routes over it, their audit,
// idempotency and step-up, and the runtime's comparison of each answer with its trusted context, are the application's to
// prove (a suite this file does not contain).
//
// WHAT IS PROVEN. 001-020 applied clean, 020's postcondition re-proven over the applied state and refusing every widening
// it names, 019's now refusing exactly on the grants 020 revoked, and a second apply refused (M7RL-01); the installed
// inventory and ACLs (M7RL-02); the login's effective privileges: EXECUTE on the four routines, nothing on the role table
// or the customer table by any path, and 42501 on 019's create and 018's page_v2 (M7RL-03); every refused edit answering no
// row and writing nothing — a manager's, a technician's and a sales_staff's key, a store-scope owner, two tenant grants, a
// read_only or overdue tenant, a read_only account, an expired, unminted, revoked or foreign-issuer key — and every
// malformed target (the owner role itself, an unknown role, domain or level) raising 22023 before any state is read
// (M7RL-04); the owner's edit storing the level in its own tenant only, the levels read answering it, and an already-issued
// key decided on the level as it stands at every call (M7RL-05); the create's decision for every role's default and every
// stored level, equal to the catalog's Customers >= Create (M7RL-06); the read's, equal to the catalog's Customers >= View
// (M7RL-07); the SQL restatements — defaults, owner literal, editable set, ordering, vocabulary — equal to the catalog, from
// the installed source and both files (M7RL-08); the lock order in both directions, with pg_blocking_pids proof of each
// wait (M7RL-09, M7RL-10); the unlocked pre-read: a refused key writes no role row and holds no row lock (M7RL-11); a role
// row deleted while a create or an edit waits on it refusing, never defaulting (M7RL-12); the direct-call witnesses —
// create C+1/A0/K0/O0, edit level changed/A0/K0/O0 (M7RL-13); the lock-holding residual (M7RL-14); each load-bearing line
// red on a mutated routine and green again restored (M7RL-15); and the rollback refused while a level differs from its
// default, and while a grant beyond 019's and 018's own sits on a restored object, clean once every level equals its
// default, restoring exactly 019's end state, then a clean re-apply (M7RL-16); and a session that expires while its create
// or edit waits on the role row refused, the clock being read after that wait (M7RL-17).
//
// THE CHAIN THROUGH 020 (M7A-CUSTOMERS-P4). Migration 021 revokes the login's EXECUTE on 020's m7a_role_level_set,
// replacing it with tmpos_role_edit.m7a_role_level_set_v2 (the edit conditional on the tenant and version reviewed), so
// this file — 020's own behaviour — applies 001-020 only: the migration file port the trusted executor reads hides every
// later file (tests/db/migrationsThrough.mjs). On a shared service where 021 is already applied, 021's own down file rolls
// it back first (with its ledger row; it refuses while a version row exists, which every suite that writes one deletes),
// and it is re-applied, with its exact ledger row, when this file ends; so M7RL-16's rollback and re-apply of 020 never
// run under an applied 021. 021's routines are proved by tests/db/roleLevelVersionRoutine.integration.test.mjs.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a
// cluster this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every
// fixture is synthetic and randomly suffixed, and every issuer key is random bytes made here. It leaves the shared service
// as it found it: 020 applied (and 021, if it was), the issuer key row it found, no ledger, session, customer or role-level row of its own, and
// its login dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import * as catalog from '../../server/platform-identity/permissionCatalog.ts';
import { TENANT_ROLE_IDS } from '../../server/platform-identity/authorizationConstants.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const { materializeTenantPermissions, meetsTenantPermissionLevel, PERMISSION_TOKENS, TENANT_ORDERING, TENANT_ROLE_PERMISSION_DEFAULTS } = catalog;

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_019 = readFileSync(`${MIG_DIR}/019_m7a_customer_create.up.sql`, 'utf8');
const UP_020 = readFileSync(`${MIG_DIR}/020_m7a_tenant_role_levels.up.sql`, 'utf8');
const DOWN_020 = readFileSync(`${MIG_DIR}/020_m7a_tenant_role_levels.down.sql`, 'utf8');
/** Each file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_019 = UP_019.slice(UP_019.lastIndexOf('do $$'));
const POSTCONDITION_020 = UP_020.slice(UP_020.lastIndexOf('do $$'));
const LEVELS = 'tmpos_role.m7a_role_levels(uuid, text)';
const SET = 'tmpos_role.m7a_role_level_set(text, text, text, text)';
const CREATE = 'tmpos_role.m7a_customer_create(text, uuid, text)';
const PAGE = 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)';
const CREATE_019 = 'tmpos_customer_write.m7a_customer_create(text, uuid, text)';
const PAGE_018 = 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7rl-migrator', runtimeRef: 'm7rl-runtime' };
const LOCK_KEY = 528_527;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7rl_probe';
const HOUR = 3_600_000;
const TENANT_LIFETIME = 8 * HOUR;
const ROLLBACK = new Error('m7rl: roll the proof back');
/** Every privilege has_table_privilege knows on PostgreSQL 16 (MAINTAIN is 17's). */
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const DENIED = Object.freeze({ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The catalog's owner, derived rather than named: the one tenant role the catalog gives no default map (its `_grant: 'full'`
 * short-circuit) — and, when the catalog exports it, the named constant must agree.
 */
const OWNER_ROLE = (() => {
  const owners = TENANT_ROLE_IDS.filter((role) => !Object.prototype.hasOwnProperty.call(TENANT_ROLE_PERMISSION_DEFAULTS, role));
  assert.equal(owners.length, 1, 'the catalog has exactly one owner role');
  if (catalog.TENANT_OWNER_ROLE_ID !== undefined) assert.equal(catalog.TENANT_OWNER_ROLE_ID, owners[0]);
  return owners[0];
})();
/** The roles an owner edits: every other tenant role, in the catalog's order. */
const EDITABLE = TENANT_ROLE_IDS.filter((role) => role !== OWNER_ROLE);
const defaultOf = (role) => materializeTenantPermissions(role, {}, false).customers;

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (as customerCreateRoutine does)
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

const TARGET = resolveDisposableTarget('M7RL');
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
/**
 * The later migrations (021, 022 since M7A-CUSTOMERS-P4's detail read, and 023 since M7A-CUSTOMERS-P6's contact records) this
 * file rolled back to run on 001-020, re-applied at the end. 023's down gives 020's create back to tmpos_app, as 020 left it,
 * and refuses while any customer holds a contact or a creation time; 023's up (restore) revokes it again, once this file's
 * own customers — created on 001-020, with no such column — are deleted.
 */
let later = null;

test.after(async () => {
  const quietly = async (fn) => { try { await fn(); } catch { /* an earlier failure left less to clean */ } };
  // A failed M7RL-16 may have left 020 rolled back: the shared service is left with 020 applied, as it was found.
  await quietly(async () => {
    if ((await owner`select pg_catalog.to_regnamespace('tmpos_role') is null as absent`)[0].absent) {
      await owner.begin((tx) => tx.unsafe(UP_020).simple());
    }
  });
  if (TENANTS.length > 0) await quietly(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
  if (KEYS.size > 0) await quietly(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
  if (UIDS.length > 0) await owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`;
  if (TENANTS.length > 0) await owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
  // The shared service is left with the later migrations it had (021, 022, 023), each with its exact ledger row.
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
// setup: real migrations 001-020 (021 rolled back if applied), a real non-owner runtime login, the key installed by the owner
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

later = await rollBackAbove(owner, MIG_DIR, '020');
// 021's down is forward-only and never gives 020's edit back to tmpos_app (DA-122): on a shared service where 021 was
// applied, restore 020's own grant here so this suite proves 020 as 020 left it; 021's up (restore) revokes it again.
if (later.rolledBack.includes('021')) {
  await owner.unsafe('grant execute on function tmpos_role.m7a_role_level_set(text, text, text, text) to tmpos_app');
}
let applyReport;
{
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    applyReport = await runTrustedApply({
      fsPort: portThrough(createNodeFsPort(MIG_DIR, MIG_REL), '020'), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7rl-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};

/** A synthetic actor: an identity, an account in `status`, and the given memberships. */
async function actor(label, memberships, status = 'active') {
  const uid = `m7rl-${label}-${SUFFIX}`;
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
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });

const T_A = await newTenant('a');
const T_B = await newTenant('b');
const T_READ_ONLY = await newTenant('read-only', 'read_only');
const T_OVERDUE = await newTenant('overdue', 'overdue');
const [{ store_id: STORE_A }] = await owner`insert into store (tenant_id, store_name, status)
  values (${T_A}, ${`m7rl-store-a-${SUFFIX}`}, 'active') returning store_id`;

/** One actor per durable tenant role, each holding exactly one tenant grant on A. */
const BY_ROLE = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (role) => [role, await actor(`role-${role}`, [tenantGrant(T_A, role)])])));
const OWNER_A = BY_ROLE[OWNER_ROLE];
const SALES_A = BY_ROLE.sales_staff;
const OWNER_B = await actor('owner-b', [tenantGrant(T_B, OWNER_ROLE)]);
const MANAGER_READ_ONLY = await actor('manager-read-only', [tenantGrant(T_READ_ONLY, 'manager')]);
const OWNER_READ_ONLY_TENANT = await actor('owner-read-only-tenant', [tenantGrant(T_READ_ONLY, OWNER_ROLE)]);
const OWNER_OVERDUE_TENANT = await actor('owner-overdue-tenant', [tenantGrant(T_OVERDUE, OWNER_ROLE)]);
const OWNER_READ_ONLY_ACCOUNT = await actor('owner-read-only-account', [tenantGrant(T_A, OWNER_ROLE)], 'read_only');
const OWNER_STORE_SCOPE = await actor('owner-store-scope', [{ scope: 'store', tenant: T_A, store: STORE_A, role: OWNER_ROLE }]);
const OWNER_TWO_GRANTS = await actor('owner-two-grants', [tenantGrant(T_A, OWNER_ROLE), tenantGrant(T_B, OWNER_ROLE)]);

// ---------------------------------------------------------------------------
// the runtime login's calls
// ---------------------------------------------------------------------------

const record = (who, at = Date.now(), over = {}) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:m7rl', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at, ...over,
});
const mintAs = async (key, r, expiresAt, proof) => {
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint, ${proof}::bytea) as outcome`;
  return outcome;
};
/** A tenant session for `who`, minted as the runtime login under K. */
async function mint(who, { lifetime = TENANT_LIFETIME, at = Date.now() } = {}) {
  const key = newKey();
  const r = record(who, at);
  const expiresAt = r.createdAt + lifetime;
  assert.equal(await mintAs(key, r, expiresAt, proofOf(K, key, r, expiresAt)), 'created', `a tenant session for ${who.uid}`);
  return key;
}
/** 020's create, called directly as the runtime login (or on `db`). A raise rejects. */
const create = async (key, id = randomUUID(), name = `M7RL ${SUFFIX} ${randomUUID().slice(0, 4)}`, db = runtime) =>
  (await db`select o_tenant_id, o_actor_id, o_membership_id
    from tmpos_role.m7a_customer_create(${key}::text, ${id}::uuid, ${name}::text)`).map((r) => ({ ...r }));
/** 020's edit, called directly as the runtime login (or on `db`). */
const setLevel = async (key, role, level, db = runtime, domain = 'customers') =>
  (await db`select o_tenant_id, o_actor_id, o_membership_id, o_level
    from tmpos_role.m7a_role_level_set(${key}::text, ${role}::text, ${domain}::text, ${level}::text)`).map((r) => ({ ...r }));
/** 020's levels read, as the runtime login. */
const levelsOf = async (tenant, role) => (await runtime`select tmpos_role.m7a_role_levels(${tenant}::uuid, ${role}::text) as levels`)[0].levels;
/** 020's page, as the runtime login. */
const page = async (key) => (await runtime`select o_outcome, o_tenant_id, o_customer_id, o_name
  from tmpos_role.m7a_customer_page_v3(${key}::text, null::uuid, 101::integer)`).map((r) => ({ ...r }));
/** The customer rows under `id`, read by the owner. */
const rowsOf = async (id) => (await owner`select tenant_id, name from tmpos_customer.customer where customer_id = ${id}`).map((r) => ({ ...r }));
/** Every stored role row of `tenant`, read by the owner. */
const storedRows = async (tenant) => (await owner`select role_id, domain, level from tmpos_role.tenant_role_level
  where tenant_id = ${tenant} order by role_id`).map((r) => ({ ...r }));
/** Back to the catalog defaults everywhere this suite owns: no stored row at all. */
const resetLevels = () => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
/** The one tenant grant `who` holds, as the session's own tuple. */
async function ownTuple(who) {
  const [m] = await owner`select tenant_id, membership_id from user_membership where internal_user_id = ${who.id} and scope_type = 'tenant'`;
  return { o_tenant_id: m.tenant_id, o_actor_id: who.id, o_membership_id: m.membership_id };
}
const editTuple = async (who, level) => ({ ...(await ownTuple(who)), o_level: level });
const errorOf = (p) => p.then(() => null, (err) => ({ code: err.code, message: String(err.message), detail: err.detail }));
const codeOf = async (p) => (await errorOf(p))?.code ?? null;
/** Customer, audit, idempotency (every key) and outbox totals: what a direct call must be shown to leave untouched. */
const counts = async () => ({ ...(await owner`select (select count(*) from tmpos_customer.customer)::int as c,
  (select count(*) from public.audit_event)::int as a,
  (select count(*) from tmpos_internal.idempotency_record)::int as k,
  (select count(*) from tmpos_internal.outbox_event)::int as o`)[0] });
const pidOf = async (tx) => (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;

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
 * Resolves once a runtime-login backend waits on a Lock that `holder` holds (pg_blocking_pids), answering the waiter's pid
 * and the ungranted pg_locks rows it waits on. Bounded: a timeout fails ("the lever did not engage"), never passes.
 */
async function waitingOn(label, holder) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const rows = await owner`select a.pid, pg_catalog.pg_blocking_pids(a.pid) as blockers from pg_catalog.pg_stat_activity a
      where a.usename = ${RUNTIME_LOGIN} and a.wait_event_type = 'Lock'`;
    const waiter = rows.find((r) => r.blockers.includes(holder));
    if (waiter) {
      const locks = await owner`select locktype, relation::regclass::text as relation from pg_catalog.pg_locks
        where pid = ${waiter.pid} and not granted`;
      return { pid: waiter.pid, locks: locks.map((l) => ({ ...l })) };
    }
    await sleep(20);
  }
  return assert.fail(`${label}: the lever did not engage (no runtime backend waited on a lock ${holder} holds)`);
}
/** Resolves once any runtime-login backend waits on a Lock (the owner holds the lock). */
async function untilBlocked(label) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const [{ n }] = await owner`select count(*)::int as n from pg_catalog.pg_stat_activity
      where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
    if (n > 0) return;
    await sleep(20);
  }
  assert.fail(`${label}: the lever did not engage (no runtime backend waited on a lock)`);
}
/** The relation-level lock modes `pid` holds on the role table: which statements it ran there (pg_locks). */
const roleTableModes = async (pid) => (await owner`select mode from pg_catalog.pg_locks
  where pid = ${pid} and relation = 'tmpos_role.tenant_role_level'::regclass and granted order by mode`).map((r) => r.mode);
/** An owner write of one role row under a 300 ms lock bound, always rolled back: null when it ran at once, '55P03' when it waited. */
const roleRowWrite = (tenant, role) => codeOf(owner.begin(async (tx) => {
  await tx`set local lock_timeout = '300ms'`;
  await tx`update tmpos_role.tenant_role_level set updated_at = updated_at where tenant_id = ${tenant} and role_id = ${role}`;
  throw ROLLBACK;
}));

/**
 * Replaces an installed routine's body for the length of `fn` (CREATE OR REPLACE keeps its owner and ACL), then restores
 * the exact original and proves it byte-identical: the red half of a behavioural claim.
 */
async function withMutated(signature, edits, fn) {
  const read = async () => (await owner`select pg_catalog.pg_get_functiondef(p.oid) as source, p.proacl::text as acl
    from pg_catalog.pg_proc p where p.oid = ${signature}::regprocedure`)[0];
  const original = await read();
  let mutated = original.source;
  for (const [from, to] of edits) {
    assert.equal(mutated.split(from).length - 1 > 0, true, `${signature}: the mutation anchor is present (${from.trim().slice(0, 60)})`);
    mutated = mutated.split(from).join(to);
  }
  assert.notEqual(mutated, original.source);
  await owner.unsafe(mutated);
  try {
    return await fn();
  } finally {
    await owner.unsafe(original.source);
    assert.deepEqual(await read(), original, `${signature}: restored byte for byte, with its ACL`);
  }
}

// ---------------------------------------------------------------------------
// M7RL-01..03: the migration, the inventory and the login's privileges
// ---------------------------------------------------------------------------

test('M7RL-01: 001-020 applied clean; 020\'s postcondition holds and refuses every widening it names; 019\'s now refuses on the grants 020 revoked; a second apply is refused', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    Array.from({ length: 20 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.equal(ledger.at(-1).checksum, createHash('sha256').update(readFileSync(`${MIG_DIR}/020_m7a_tenant_role_levels.up.sql`)).digest('hex'),
    'the ledger records the committed 020 up file');

  const [{ me }] = await owner`select current_user as me`;
  const postcondition = async (widen, text = POSTCONDITION_020) => rolledBack('isolation level read committed', async (tx) => {
    for (const statement of widen) await tx.unsafe(statement);
    await tx.unsafe(text).simple();
  });
  for (const [label, widen] of [
    ['a SELECT on the role table', ['grant select on tmpos_role.tenant_role_level to tmpos_app']],
    ['an UPDATE on the role table to the audit writer', ['grant update on tmpos_role.tenant_role_level to tmpos_audit_writer']],
    ['a column grant on the role table', ['grant select (level) on tmpos_role.tenant_role_level to tmpos_app']],
    ['a policy on the role table', ['create policy m7rl_all on tmpos_role.tenant_role_level using (true)']],
    ['forced row security on the role table', ['alter table tmpos_role.tenant_role_level force row level security']],
    ['row security disabled on the role table', ['alter table tmpos_role.tenant_role_level disable row level security']],
    ['EXECUTE on the edit to the audit writer', [`grant execute on function ${SET} to tmpos_audit_writer`]],
    ['EXECUTE on the levels read to PUBLIC', [`grant execute on function ${LEVELS} to public`]],
    ['EXECUTE with grant option', [`grant execute on function ${CREATE} to tmpos_app with grant option`]],
    ['USAGE on the schema to the audit writer', ['grant usage on schema tmpos_role to tmpos_audit_writer']],
    ['a STABLE create', [`alter function ${CREATE} stable`]],
    ['a VOLATILE levels read', [`alter function ${LEVELS} volatile`]],
    ['a page without row_security off', [`alter function ${PAGE} reset row_security`]],
    ['an extra routine in the schema', ['create function tmpos_role.m7rl_probe() returns int language sql as \'select 1\'']],
    ['019\'s create granted back', [`grant execute on function ${CREATE_019} to tmpos_app`]],
    ['019\'s schema USAGE granted back', ['grant usage on schema tmpos_customer_write to tmpos_app']],
    ['018\'s page_v2 granted back', [`grant execute on function ${PAGE_018} to tmpos_app`]],
    ['018\'s page_v2 granted to anon', [`grant execute on function ${PAGE_018} to anon`]],
    ['membership in pg_write_all_data (an effective privilege)', ['grant pg_write_all_data to tmpos_app']],
    ['a NOINHERIT membership in the owner (SET ROLE reaches it)', ['alter role tmpos_app noinherit', `grant "${me}" to tmpos_app`]],
    ['a non-owner role holding UPDATE on the role table, reachable only through SET ROLE',
      ['create role m7rl_writer nologin', 'grant usage on schema tmpos_role to m7rl_writer',
        'grant update on tmpos_role.tenant_role_level to m7rl_writer', 'alter role tmpos_app noinherit', 'grant m7rl_writer to tmpos_app']],
    ['anon reaching tmpos_app\'s EXECUTE only through SET ROLE', ['alter role anon noinherit', 'grant tmpos_app to anon']],
  ]) {
    assert.equal((await postcondition(widen)).code, '55000', `${label} is refused`);
  }
  // A trigger alone (its function outside the schema, so the routine count is unchanged): only (a)'s trigger clause sees it —
  // the foreign key's own internal RI triggers are not refused.
  const trigger = await postcondition(['create function public.m7rl_trg() returns trigger language plpgsql as \'begin return new; end\'',
    'create trigger m7rl_trg before update on tmpos_role.tenant_role_level for each row execute function public.m7rl_trg()']);
  assert.equal(trigger.code, '55000', 'a trigger on the role table is refused');
  assert.match(trigger.message, /schema tmpos_role does not hold exactly the four routines, the table and its index/);
  assert.equal((await postcondition([])).code, undefined, 'the state 020 left satisfies it');

  // 019's own postcondition no longer holds, and refuses on exactly the grant 020 revoked (its check (e)).
  const stale = await postcondition([], POSTCONDITION_019);
  assert.equal(stale.code, '55000');
  assert.match(stale.message, /tmpos_app does not hold EXECUTE on the create routine and USAGE on schema tmpos_customer_write/);

  const again = await rolledBack('isolation level read committed', (tx) => tx.unsafe(UP_020).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /migration 020 refused: schema tmpos_role already exists/);
});

test('M7RL-02: the installed inventory — four pinned SECURITY DEFINER routines with EXECUTE to tmpos_app alone, the table under unforced RLS with no grant — and 019\'s and 018\'s name-based routines no longer granted', async () => {
  const [{ me }] = await owner`select current_user as me`;
  const routines = await owner`select p.proname as name, p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
      pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
      (select coalesce(array_agg(pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable) order by 1), '{}')
         from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where g.grantee <> p.proowner) as grants
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role'::regnamespace order by p.proname`;
  const pinned = ['search_path=pg_catalog, pg_temp', 'row_security=off'];
  assert.deepEqual(routines.map((r) => ({ ...r })), [
    { name: 'm7a_customer_create', definer: true, volatility: 'v', config: pinned,
      args: 'p_session_key text, p_customer_id uuid, p_name text', grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'm7a_customer_page_v3', definer: true, volatility: 's', config: pinned,
      args: 'p_session_key text, p_after_customer_id uuid, p_limit integer', grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'm7a_role_level_set', definer: true, volatility: 'v', config: pinned,
      args: 'p_session_key text, p_role_id text, p_domain text, p_level text', grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'm7a_role_levels', definer: true, volatility: 's', config: pinned,
      args: 'p_tenant_id uuid, p_role_id text', grants: ['tmpos_app:EXECUTE:f'] },
  ], 'the edit\'s and the create\'s only authority argument is the session key');

  const [{ pg17 }] = await owner`select pg_catalog.current_setting('server_version_num')::int >= 170000 as pg17`;
  const [table] = await owner`select c.relrowsecurity as rls, c.relforcerowsecurity as forced, c.relacl::text as acl,
      n.nspacl::text as schema_acl,
      (select count(*)::int from pg_catalog.pg_policy p where p.polrelid = c.oid) as policies,
      (select array_agg(a.attname::text order by a.attnum) from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0) as columns,
      (select array_agg(pg_catalog.pg_get_constraintdef(k.oid) order by k.conname) from pg_catalog.pg_constraint k where k.conrelid = c.oid) as constraints
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.oid = 'tmpos_role.tenant_role_level'::regclass`;
  const { constraints, ...rest } = table;
  assert.deepEqual(rest, {
    rls: true, forced: false, acl: `{${me}=arwdDxt${pg17 ? 'm' : ''}/${me}}`, schema_acl: `{${me}=UC/${me},tmpos_app=U/${me}}`, policies: 0,
    columns: ['tenant_id', 'role_id', 'domain', 'level', 'updated_at'],
  }, 'row security on, not forced, no policy, the owner alone on the table; USAGE alone to tmpos_app on the schema');
  assert.equal(constraints.length, 5, 'the primary key, the foreign key and three CHECKs');
  assert.ok(constraints.includes('PRIMARY KEY (tenant_id, role_id, domain)'), constraints.join(' | '));
  assert.ok(constraints.some((c) => /^FOREIGN KEY \(tenant_id\) REFERENCES (public\.)?tenant\(tenant_id\)$/.test(c)), constraints.join(' | '));

  const acls = await owner`select p.oid::regprocedure::text as routine, p.proacl::text as acl from pg_catalog.pg_proc p
    where p.oid in (${CREATE_019}::regprocedure, ${PAGE_018}::regprocedure) order by 1`;
  assert.deepEqual(acls.map((r) => ({ ...r })), [
    { routine: 'tmpos_customer_write.m7a_customer_create(text,uuid,text)', acl: `{${me}=X/${me}}` },
    { routine: 'tmpos_mint.m7a_customer_page_v2(text,uuid,integer)', acl: `{${me}=X/${me}}` },
  ], 'the two name-based routines stay, granted to their owner alone');
  const [{ nspacl }] = await owner`select nspacl::text from pg_catalog.pg_namespace where nspname = 'tmpos_customer_write'`;
  assert.equal(nspacl, `{${me}=UC/${me}}`);
});

test('M7RL-03: as the application login: EXECUTE on the four routines, nothing on the role table or the customer table by any path, and 42501 on 019\'s create and 018\'s page_v2', async () => {
  // Read by the owner for the login by name: the login cannot even resolve a routine name in a schema it cannot use.
  const [rights] = await owner`select
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${LEVELS}::regprocedure, 'EXECUTE') as levels,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${SET}::regprocedure, 'EXECUTE') as edits,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE}::regprocedure, 'EXECUTE') as creates,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${PAGE}::regprocedure, 'EXECUTE') as reads,
      pg_catalog.has_schema_privilege(${RUNTIME_LOGIN}, 'tmpos_role', 'USAGE') as schema_usage,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_019}::regprocedure, 'EXECUTE') as create_019,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${PAGE_018}::regprocedure, 'EXECUTE') as page_018,
      pg_catalog.has_schema_privilege(${RUNTIME_LOGIN}, 'tmpos_customer_write', 'USAGE') as schema_019`;
  assert.deepEqual({ ...rights }, { levels: true, edits: true, creates: true, reads: true, schema_usage: true, create_019: false, page_018: false, schema_019: false });
  for (const table of ['tmpos_role.tenant_role_level', 'tmpos_customer.customer']) {
    for (const privilege of TABLE_PRIVILEGES) {
      const [{ held }] = await runtime`select pg_catalog.has_table_privilege(current_user, ${table}::regclass, ${privilege}) as held`;
      assert.equal(held, false, `the login holds no ${privilege} on ${table}`);
    }
  }
  for (const [label, statement] of [
    ['SELECT role levels', 'select level from tmpos_role.tenant_role_level limit 1'],
    ['INSERT a role level', `insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values ('${T_A}', 'sales_staff', 'customers', 'full', now())`],
    ['UPDATE role levels', 'update tmpos_role.tenant_role_level set level = \'full\''],
    ['DELETE role levels', 'delete from tmpos_role.tenant_role_level'],
    ['INSERT a customer', `insert into tmpos_customer.customer (customer_id, tenant_id, name) values ('${randomUUID()}', '${T_A}', 'm7rl direct')`],
  ]) {
    assert.equal(await codeOf(runtime.unsafe(statement)), '42501', `${label} is refused`);
  }
  const key = await mint(SALES_A);
  assert.equal(await codeOf(runtime`select * from tmpos_customer_write.m7a_customer_create(${key}::text, ${randomUUID()}::uuid, 'M7RL old'::text)`),
    '42501', '019\'s name-based create is unreachable');
  assert.equal(await codeOf(runtime`select * from tmpos_mint.m7a_customer_page_v2(${key}::text, null::uuid, 101::integer)`),
    '42501', '018\'s name-based read is unreachable');
  const [others] = await owner`select
      bool_or(pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')) as any_execute
    from pg_catalog.pg_roles r cross join pg_catalog.pg_proc p
    where r.rolname in ('tmpos_audit_writer', 'anon', 'authenticated') and p.pronamespace = 'tmpos_role'::regnamespace`;
  assert.equal(others.any_execute, false, 'the audit writer, anon and authenticated execute none of the four');
});

// ---------------------------------------------------------------------------
// M7RL-04..05: the owner's edit
// ---------------------------------------------------------------------------

test('M7RL-04: every refused edit answers no row and writes nothing; a malformed target raises 22023 and outside READ COMMITTED 55000', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  const refusedKeys = [
    ['a manager\'s key', await mint(BY_ROLE.manager)],
    ['a technician\'s key', await mint(BY_ROLE.technician)],
    ['a sales_staff key', await mint(SALES_A)],
    ['a store-scope store_owner (a store grant never qualifies)', await mint(OWNER_STORE_SCOPE)],
    ['an owner holding two tenant grants (ambiguous)', await mint(OWNER_TWO_GRANTS)],
    ['the owner of a read_only tenant', await mint(OWNER_READ_ONLY_TENANT)],
    ['the owner of an overdue tenant', await mint(OWNER_OVERDUE_TENANT)],
    ['an owner whose account is read_only', await mint(OWNER_READ_ONLY_ACCOUNT)],
    ['an expired owner key', await mint(OWNER_A, { lifetime: HOUR, at: Date.UTC(2023, 10, 14) })],
    ['an unminted key', newKey()],
  ];
  const revoked = await mint(OWNER_A);
  await runtime`select tmpos_session.m5_session_revoke(${revoked}::text)`;
  refusedKeys.push(['a revoked owner key', revoked]);
  for (const [label, key] of refusedKeys) {
    assert.deepEqual(await setLevel(key, 'sales_staff', 'none'), [], label);
  }
  const foreign = await mint(OWNER_A);
  await installTestIssuerKey(owner, randomBytes(32));
  try {
    assert.deepEqual(await setLevel(foreign, 'sales_staff', 'none'), [], 'an owner key minted under a replaced issuer key');
  } finally {
    await installTestIssuerKey(owner, K);
  }
  for (const tenant of [T_A, T_B, T_READ_ONLY, T_OVERDUE]) {
    assert.deepEqual(await storedRows(tenant), [], 'no refusal wrote a role row, not even a NULL lock row');
  }

  for (const [label, role, domain, level, key] of [
    ['the owner role itself as the target', OWNER_ROLE, 'customers', 'none', ownerKey],
    ['a platform role', 'system_owner', 'customers', 'none', ownerKey],
    ['a custom role', 'm7rl_custom', 'customers', 'view', ownerKey],
    ['a null role', null, 'customers', 'view', ownerKey],
    ['another domain', 'sales_staff', 'sales', 'view', ownerKey],
    ['a differently cased domain', 'sales_staff', 'Customers', 'view', ownerKey],
    ['a null domain', 'sales_staff', null, 'view', ownerKey],
    ['a level outside the vocabulary', 'sales_staff', 'customers', 'admin', ownerKey],
    ['an upper-cased level', 'sales_staff', 'customers', 'FULL', ownerKey],
    ['an empty level', 'sales_staff', 'customers', '', ownerKey],
    ['a null level', 'sales_staff', 'customers', null, ownerKey],
    ['a null key', 'sales_staff', 'customers', 'view', null],
    ['a key outside 011\'s shape', 'sales_staff', 'customers', 'view', 'has a space'],
  ]) {
    const err = await errorOf(setLevel(key, role, level, runtime, domain));
    assert.deepEqual(err, { code: '22023', message: 'migration 020 set: an argument is malformed', detail: undefined }, label);
  }
  for (const isolation of ['isolation level repeatable read', 'isolation level serializable']) {
    let code = null;
    await runtime.begin(isolation, (tx) => setLevel(ownerKey, 'sales_staff', 'view', tx)).catch((err) => { code = err.code; });
    assert.equal(code, '55000', isolation);
  }
  assert.deepEqual(await storedRows(T_A), [], 'still nothing written');
});

test('M7RL-05: the owner\'s edit stores the level in its own tenant only, the levels read answers it, and an already-issued key is decided on the level as it stands at every call', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  assert.deepEqual(await levelsOf(T_A, 'sales_staff'), {}, 'nothing stored: the default');
  assert.equal((await create(salesKey)).length, 1, 'sales_staff creates at its default');

  assert.deepEqual(await setLevel(ownerKey, 'sales_staff', 'view'), [await editTuple(OWNER_A, 'view')],
    'one row: the editor\'s own tenant, actor and membership, and the level stored');
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'sales_staff', domain: 'customers', level: 'view' }]);
  assert.deepEqual(await levelsOf(T_A, 'sales_staff'), { customers: 'view' });
  assert.deepEqual(await levelsOf(T_B, 'sales_staff'), {}, 'B is untouched');
  assert.deepEqual(await levelsOf(T_A, OWNER_ROLE), {}, 'the owner role has nothing stored');
  assert.deepEqual(await levelsOf(T_A, 'm7rl_custom'), {}, 'an unknown role has nothing stored');
  for (const [tenant, role] of [[null, 'sales_staff'], [T_A, null]]) {
    assert.deepEqual(await errorOf(levelsOf(tenant, role)), { code: '22023', message: 'migration 020 levels: an argument is null', detail: undefined });
  }

  assert.deepEqual(await create(salesKey), [], 'the SAME key, issued before the edit, no longer creates');
  assert.deepEqual(await setLevel(ownerKey, 'sales_staff', 'create'), [await editTuple(OWNER_A, 'create')]);
  assert.equal((await create(salesKey)).length, 1, 'restored, the same key creates again');

  // There is no tenant input: B's owner edits only B.
  assert.deepEqual(await setLevel(await mint(OWNER_B), 'sales_staff', 'none'), [await editTuple(OWNER_B, 'none')]);
  assert.deepEqual(await levelsOf(T_B, 'sales_staff'), { customers: 'none' });
  assert.deepEqual(await levelsOf(T_A, 'sales_staff'), { customers: 'create' }, 'A keeps its own level');
});

// ---------------------------------------------------------------------------
// M7RL-06..08: the decisions, against the catalog
// ---------------------------------------------------------------------------

test('M7RL-06: the create decides every role\'s default and every stored level exactly as the catalog\'s Customers >= Create', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  const keys = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (role) => [role, await mint(BY_ROLE[role])])));
  const decide = async (role, expected, label) => {
    const who = BY_ROLE[role];
    const id = randomUUID();
    const answer = await create(keys[role], id);
    if (expected) {
      assert.deepEqual(answer, [await ownTuple(who)], `${label}: creates`);
      assert.deepEqual((await rowsOf(id)).map((r) => r.tenant_id), [T_A], `${label}: in its own tenant`);
    } else {
      assert.deepEqual(answer, [], `${label}: refused`);
      assert.deepEqual(await rowsOf(id), [], `${label}: nothing written`);
    }
  };
  const byDefault = TENANT_ROLE_IDS.filter((role) => meetsTenantPermissionLevel(defaultOf(role), 'create'));
  assert.deepEqual([...byDefault].sort(), ['manager', 'sales_staff', 'store_owner'], 'the catalog\'s defaults this pins');
  for (const role of TENANT_ROLE_IDS) await decide(role, byDefault.includes(role), `${role} at its default`);
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'manager', domain: 'customers', level: null },
    { role_id: 'sales_staff', domain: 'customers', level: null }], 'the allowed roles hold NULL lock rows; the refused technician wrote none');

  for (const role of EDITABLE) {
    for (const level of PERMISSION_TOKENS) {
      assert.deepEqual(await setLevel(ownerKey, role, level), [await editTuple(OWNER_A, level)]);
      await decide(role, meetsTenantPermissionLevel(level, 'create'), `${role} at ${level}`);
    }
    assert.equal((await setLevel(ownerKey, role, 'none')).length, 1);
  }
  await decide(OWNER_ROLE, true, 'the owner, with every other role at none');
});

test('M7RL-07: the read decides every role\'s default and every stored level exactly as the catalog\'s Customers >= View, with page_v2\'s answers', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  assert.equal((await create(ownerKey)).length, 1, 'A holds a customer');
  assert.equal((await create(await mint(OWNER_B))).length, 1, 'B holds a customer');
  const keys = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (role) => [role, await mint(BY_ROLE[role])])));
  const reads = async (role, expected, label) => {
    const rows = await page(keys[role]);
    if (expected) {
      assert.ok(rows.length > 0 && rows.every((r) => r.o_outcome === 'customer' && r.o_tenant_id === T_A),
        `${label}: a page of A's customers only (${JSON.stringify(rows[0])})`);
    } else {
      assert.deepEqual(rows, [DENIED], `${label}: denied`);
    }
  };
  for (const role of TENANT_ROLE_IDS) await reads(role, meetsTenantPermissionLevel(defaultOf(role), 'view'), `${role} at its default`);
  assert.deepEqual(await storedRows(T_A), [], 'the read writes no row');
  for (const role of EDITABLE) {
    for (const level of PERMISSION_TOKENS) {
      assert.equal((await setLevel(ownerKey, role, level)).length, 1);
      await reads(role, meetsTenantPermissionLevel(level, 'view'), `${role} at ${level}`);
    }
  }
  await reads(OWNER_ROLE, true, 'the owner, with every other role at full');

  assert.deepEqual(await page('has a space'), [{ ...DENIED, o_outcome: 'invalid' }], 'a malformed key');
  assert.deepEqual(await page(newKey()), [DENIED], 'an unminted key');
  // A read-limited tenant still reads at a default at or above View (017's status rule, unchanged): an empty page, not denied.
  assert.deepEqual(await page(await mint(MANAGER_READ_ONLY)), [], 'a read_only tenant\'s manager reads its (empty) page');
});

test('M7RL-08: every SQL restatement — the defaults, the owner literal, the editable set, the ordering and the vocabulary — equals the catalog, in the installed routines and both files', async () => {
  const defaults = Object.fromEntries(EDITABLE.map((role) => [role, defaultOf(role)]));
  assert.deepEqual(defaults, Object.fromEntries(EDITABLE.map((role) => [role, TENANT_ROLE_PERMISSION_DEFAULTS[role].customers])));
  assert.deepEqual(defaults, { manager: 'full', technician: 'view', sales_staff: 'create' }, 'the catalog\'s answer this parity pins');
  assert.equal(OWNER_ROLE, 'store_owner');
  assert.equal(defaultOf(OWNER_ROLE), 'full', 'the catalog\'s owner is Full in Customers, the literal every routine answers');
  const sorted = (list) => [...list].sort();

  const restated = (source, label, expect) => {
    const cases = [...source.matchAll(/case [a-z_.]+ ((?:when '[a-z_]+' then '[a-z]+' )+)end/g)]
      .map((m) => Object.fromEntries([...m[1].matchAll(/when '([a-z_]+)' then '([a-z]+)'/g)].map((p) => [p[1], p[2]])));
    assert.equal(cases.length, expect.cases, `${label}: every default restatement found`);
    for (const c of cases) assert.deepEqual(c, defaults, `${label}: the defaults`);
    const owners = [...source.matchAll(/v_role (?:=|is distinct from) '([a-z_]+)'/g)].map((m) => m[1]);
    assert.equal(owners.length, expect.owners, `${label}: every owner literal found`);
    for (const o of owners) assert.equal(o, OWNER_ROLE, `${label}: the owner literal`);
    const sets = [...source.matchAll(/(?:role_id|v_role|p_role_id) (?:not )?in \(([^)]*)\)/g)]
      .map((m) => sorted(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))));
    assert.equal(sets.length, expect.sets, `${label}: every editable set found`);
    for (const s of sets) assert.deepEqual(s, sorted(EDITABLE), `${label}: the editable set`);
    const orderings = [...source.matchAll(/array\[('none'[^\]]*)\]/g)].map((m) => m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
    assert.equal(orderings.length, expect.orderings, `${label}: every ordering found`);
    for (const o of orderings) assert.deepEqual(o, [...TENANT_ORDERING], `${label}: the tenant ordering`);
    const vocabularies = [...source.matchAll(/level (?:not )?in \(('none'[^)]*)\)/g)].map((m) => sorted(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))));
    assert.equal(vocabularies.length, expect.vocabularies, `${label}: every level vocabulary found`);
    for (const v of vocabularies) assert.deepEqual(v, sorted(PERMISSION_TOKENS), `${label}: the level vocabulary`);
  };
  const installed = async (signature) => (await owner`select pg_catalog.pg_get_functiondef(${signature}::regprocedure) as source`)[0].source;
  restated(await installed(CREATE), 'the installed create', { cases: 2, owners: 1, sets: 1, orderings: 1, vocabularies: 0 });
  restated(await installed(PAGE), 'the installed page', { cases: 1, owners: 1, sets: 1, orderings: 1, vocabularies: 0 });
  restated(await installed(SET), 'the installed edit', { cases: 0, owners: 1, sets: 1, orderings: 0, vocabularies: 1 });
  restated(UP_020, 'the up file', { cases: 3, owners: 3, sets: 4, orderings: 2, vocabularies: 2 });
  restated(DOWN_020, 'the down file', { cases: 1, owners: 0, sets: 0, orderings: 0, vocabularies: 0 });
  // The table's CHECKs, as the database reads them back: its role set and its level vocabulary.
  const checks = (await owner`select pg_catalog.pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint
    where conrelid = 'tmpos_role.tenant_role_level'::regclass and contype = 'c' order by conname`).map((r) => r.def);
  const listed = (def) => sorted([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]));
  assert.deepEqual(checks.map(listed), [['customers'], sorted(PERMISSION_TOKENS), sorted(EDITABLE)]);
});

// ---------------------------------------------------------------------------
// M7RL-09..12: the order an edit and a create take
// ---------------------------------------------------------------------------

test('M7RL-09: an edit holding the role row makes a create wait on it; once the edit commits, the narrowed role refuses (and a non-narrowing edit lets it create)', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'create')).length, 1, 'a committed row at the default');
  for (const [level, expected] of [['view', false], ['edit', true]]) {
    const id = randomUUID();
    let pending;
    let wait;
    await runtime.begin(async (tx) => {
      const holder = await pidOf(tx);
      assert.deepEqual(await setLevel(ownerKey, 'sales_staff', level, tx), [await editTuple(OWNER_A, level)]);
      pending = create(salesKey, id);
      pending.catch(() => {});
      wait = await waitingOn(`a create waiting on an edit to ${level}`, holder);
    });
    // The edit's transaction holds only the owner's own account FOR UPDATE, shared FOR SHARE locks and the role row: the
    // create, a different principal, can be blocked by it on the role row alone.
    assert.ok(wait.locks.length > 0 && wait.locks.every((l) => l.locktype === 'transactionid'
      || (l.locktype === 'tuple' && l.relation === 'tmpos_role.tenant_role_level')), JSON.stringify(wait.locks));
    if (expected) {
      assert.deepEqual(await pending, [await ownTuple(SALES_A)], `after an edit to ${level} committed, it creates`);
      assert.equal((await rowsOf(id)).length, 1);
    } else {
      assert.deepEqual(await pending, [], `after an edit to ${level} committed, it refuses`);
      assert.deepEqual(await rowsOf(id), [], 'nothing written');
    }
    assert.equal((await setLevel(ownerKey, 'sales_staff', 'create')).length, 1);
  }
});

test('M7RL-10: a create holding the role row FOR SHARE makes the edit wait until it commits; the edit then lands, and the next create refuses', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'create')).length, 1, 'a committed row: the create adds none, only its FOR SHARE');
  const id = randomUUID();
  let pendingEdit;
  await runtime.begin(async (tx) => {
    const holder = await pidOf(tx);
    assert.deepEqual(await create(salesKey, id, undefined, tx), [await ownTuple(SALES_A)]);
    assert.ok((await roleTableModes(holder)).includes('RowShareLock'), 'the create took the role row FOR SHARE');
    pendingEdit = setLevel(ownerKey, 'sales_staff', 'view');
    pendingEdit.catch(() => {});
    await waitingOn('an edit waiting on a create', holder);
    assert.deepEqual(await levelsOf(T_A, 'sales_staff'), { customers: 'create' }, 'while it waits the level is unchanged');
  });
  assert.deepEqual(await pendingEdit, [await editTuple(OWNER_A, 'view')], 'the edit lands after the create committed');
  assert.equal((await rowsOf(id)).length, 1, 'the create committed first');
  assert.deepEqual(await create(salesKey), [], 'and the next create refuses');
});

test('M7RL-11: the unlocked pre-read — a key whose effective level is already below Create writes no role row and holds no row lock; an allowed one holds the row', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'view')).length, 1);
  /** Inside one open runtime transaction: the create, then the role-table lock modes it holds and an owner write of the row. */
  const whileOpen = (key, role) => runtime.begin(async (tx) => {
    const answer = await create(key, randomUUID(), undefined, tx);
    const pid = await pidOf(tx);
    return { answer: answer.length, modes: await roleTableModes(pid), write: await roleRowWrite(T_A, role) };
  });
  assert.deepEqual(await whileOpen(await mint(SALES_A), 'sales_staff'), { answer: 0, modes: ['AccessShareLock'], write: null },
    'a stored level below Create: only the plain read ran, and the row is free while the transaction stays open');
  assert.deepEqual(await whileOpen(await mint(BY_ROLE.technician), 'technician'), { answer: 0, modes: ['AccessShareLock'], write: null },
    'a default below Create (technician, nothing stored): the same');
  assert.deepEqual((await storedRows(T_A)).map((r) => r.role_id), ['sales_staff'], 'the technician\'s refusal wrote no lock row');

  assert.equal((await setLevel(ownerKey, 'sales_staff', 'create')).length, 1);
  assert.deepEqual(await whileOpen(await mint(SALES_A), 'sales_staff'),
    { answer: 1, modes: ['AccessShareLock', 'RowExclusiveLock', 'RowShareLock'], write: '55P03' },
    'contrast: an allowed create holds the row until its transaction ends');
});

test('M7RL-12: a role row deleted while a create or an edit waits on it refuses them — never the default', async () => {
  const deletedWhileWaiting = async (call) => {
    await resetLevels();
    assert.equal((await setLevel(await mint(OWNER_A), 'sales_staff', 'create')).length, 1, 'a committed row at the default');
    let pending;
    await owner.begin(async (tx) => {
      await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${T_A} and role_id = 'sales_staff' for update`;
      pending = call();
      pending.catch(() => {});
      await untilBlocked('a call waiting on the role row');
      await tx`delete from tmpos_role.tenant_role_level where tenant_id = ${T_A} and role_id = 'sales_staff'`;
    });
    return { answer: await pending, stored: await storedRows(T_A) };
  };
  const id = randomUUID();
  const salesKey = await mint(SALES_A);
  assert.deepEqual(await deletedWhileWaiting(() => create(salesKey, id)), { answer: [], stored: [] },
    'the create refuses, and re-creates no row');
  assert.deepEqual(await rowsOf(id), [], 'nothing written (the default, create, would have created)');
  const ownerKey = await mint(OWNER_A);
  assert.deepEqual(await deletedWhileWaiting(() => setLevel(ownerKey, 'sales_staff', 'view')), { answer: [], stored: [] },
    'the edit refuses, and writes no row');
});

// ---------------------------------------------------------------------------
// M7RL-13..14: the residuals, witnessed
// ---------------------------------------------------------------------------

test('M7RL-13: direct calls as tmpos_app with a live key — the create adds a customer and the edit changes a level, each with no audit, idempotency or outbox row (pre-deployment residuals)', async () => {
  await resetLevels();
  const before = await counts();
  const id = randomUUID();
  assert.deepEqual(await create(await mint(SALES_A), id), [await ownTuple(SALES_A)]);
  const afterCreate = await counts();
  assert.deepEqual({ C: afterCreate.c - before.c, A: afterCreate.a - before.a, K: afterCreate.k - before.k, O: afterCreate.o - before.o },
    { C: 1, A: 0, K: 0, O: 0 }, 'a customer with no audit, idempotency or outbox record');

  assert.deepEqual(await setLevel(await mint(OWNER_A), 'technician', 'create'), [await editTuple(OWNER_A, 'create')]);
  const afterEdit = await counts();
  assert.deepEqual(await levelsOf(T_A, 'technician'), { customers: 'create' }, 'the level changed');
  assert.deepEqual({ C: afterEdit.c - afterCreate.c, A: afterEdit.a - afterCreate.a, K: afterEdit.k - afterCreate.k, O: afterEdit.o - afterCreate.o },
    { C: 0, A: 0, K: 0, O: 0 }, 'a role edit with no audit, idempotency or outbox record');
  assert.equal((await create(await mint(BY_ROLE.technician))).length, 1, 'and it is enforced: the technician now creates');
});

test('M7RL-14: lock holding — a runtime-login transaction holding a role row FOR SHARE makes the owner\'s edit wait until its lock timeout; once it ends the edit proceeds', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  let bounded;
  await runtime.begin(async (tx) => {
    assert.equal((await create(salesKey, randomUUID(), undefined, tx)).length, 1);
    bounded = await codeOf(runtime.begin(async (edit) => {
      await edit`set local lock_timeout = '300ms'`;
      return setLevel(ownerKey, 'sales_staff', 'view', edit);
    }));
  });
  assert.equal(bounded, '55P03', 'the edit waited on the held row until its lock timeout');
  assert.deepEqual(await setLevel(ownerKey, 'sales_staff', 'view'), [await editTuple(OWNER_A, 'view')], 'released, the edit proceeds');
});

// ---------------------------------------------------------------------------
// M7RL-15: each load-bearing line, red when mutated
// ---------------------------------------------------------------------------

test('M7RL-15: each load-bearing line is red on a mutated routine and green again restored — the create\'s level decision, pre-read, FOR SHARE and not-found refusal, the edit\'s owner check, the read\'s level decision', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  const managerKey = await mint(BY_ROLE.manager);
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'view')).length, 1);

  // (1) The create's level decision: without it a narrowed role creates.
  await withMutated(CREATE, [['< pg_catalog.array_position(c_levels, \'create\')', '< pg_catalog.array_position(c_levels, \'none\')']], async () => {
    assert.equal((await create(salesKey)).length, 1, 'mutated: sales_staff at view creates (red)');
  });
  assert.deepEqual(await create(salesKey), [], 'restored: refused');

  // (2) The edit's owner check: without it a manager edits.
  await withMutated(SET, [['if v_role is distinct from \'store_owner\' then', 'if v_role not in (\'store_owner\', \'manager\') then']], async () => {
    assert.deepEqual(await setLevel(managerKey, 'sales_staff', 'full'), [await editTuple(BY_ROLE.manager, 'full')], 'mutated: a manager edits (red)');
  });
  assert.deepEqual(await setLevel(managerKey, 'sales_staff', 'view'), [], 'restored: refused');
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'view')).length, 1);

  // (3) The read's level decision: without it a role at none reads.
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'none')).length, 1);
  await withMutated(PAGE, [['< pg_catalog.array_position(c_levels, \'view\')', '< pg_catalog.array_position(c_levels, \'none\')']], async () => {
    assert.notDeepEqual(await page(salesKey), [DENIED], 'mutated: sales_staff at none reads (red)');
  });
  assert.deepEqual(await page(salesKey), [DENIED], 'restored: denied');

  // (4) The pre-read: without its refusal a refused technician key writes a NULL lock row.
  await resetLevels();
  const techKey = await mint(BY_ROLE.technician);
  const preRead = ['\'create\') then\n      return;\n    end if;\n    -- (b)', '\'create\') then\n      null;\n    end if;\n    -- (b)'];
  await withMutated(CREATE, [preRead], async () => {
    assert.deepEqual(await create(techKey), [], 'mutated: still refused at the locked decision');
    assert.deepEqual((await storedRows(T_A)).map((r) => r.role_id), ['technician'], 'mutated: but it wrote a lock row (red)');
  });
  await resetLevels();
  assert.deepEqual(await create(techKey), [], 'restored: refused');
  assert.deepEqual(await storedRows(T_A), [], 'restored: no row');

  // (5) The create's FOR SHARE: without it, an edit does not wait for an open create and commits first.
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'create')).length, 1);
  await withMutated(CREATE, [['\n       for share;\n    if not found then', '\n       ;\n    if not found then']], async () => {
    await runtime.begin(async (tx) => {
      assert.equal((await create(salesKey, randomUUID(), undefined, tx)).length, 1);
      const edit = setLevel(ownerKey, 'sales_staff', 'view');
      edit.catch(() => {});
      const first = await Promise.race([edit.then(() => 'edit committed'), sleep(2_000).then(() => 'edit waiting')]);
      assert.equal(first, 'edit committed', 'mutated: the narrowing committed while the create was still open (red)');
    });
  });

  // (6) The create's not-found refusal: without it a row deleted while the create waits reads as the default and creates.
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'create')).length, 1);
  const id = randomUUID();
  await withMutated(CREATE, [['\n       for share;\n    if not found then\n      return;\n    end if;', '\n       for share;']], async () => {
    let pending;
    await owner.begin(async (tx) => {
      await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${T_A} and role_id = 'sales_staff' for update`;
      pending = create(salesKey, id);
      pending.catch(() => {});
      await untilBlocked('a mutated create waiting on the role row');
      await tx`delete from tmpos_role.tenant_role_level where tenant_id = ${T_A} and role_id = 'sales_staff'`;
    });
    assert.equal((await pending).length, 1, 'mutated: it defaulted and created (red)');
  });
  assert.equal((await rowsOf(id)).length, 1);
});

// ---------------------------------------------------------------------------
// M7RL-16: rollback and re-apply
// ---------------------------------------------------------------------------

test('M7RL-16: 020 down refuses while a stored level differs from its default, succeeds once every level equals it — restoring exactly 019\'s grants, its create and 018\'s read working again — and 020 re-applies cleanly', async () => {
  await resetLevels();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  const [{ me }] = await owner`select current_user as me`;
  assert.equal((await setLevel(ownerKey, 'sales_staff', 'view')).length, 1);
  assert.equal((await setLevel(ownerKey, 'manager', 'full')).length, 1);

  const refusedDown = await rolledBack('isolation level read committed', (tx) => tx.unsafe(DOWN_020).simple());
  assert.equal(refusedDown.code, '55000');
  assert.match(refusedDown.message, /migration 020 rollback refused: a stored Customers level differs from its role's catalog default/);
  const isolation = await rolledBack('isolation level repeatable read', (tx) => tx.unsafe(DOWN_020).simple());
  assert.equal(isolation.code, '55000');
  assert.match(isolation.message, /it must run under READ COMMITTED/);

  // The owner sets each edited role back to its default; a NULL lock row stays too. Now the rollback decides nothing
  // differently from 019 and 018, and runs — committed, as a real rollback would be.
  assert.equal((await setLevel(ownerKey, 'sales_staff', defaultOf('sales_staff'))).length, 1);
  assert.equal((await create(await mint(BY_ROLE.technician))).length, 0);
  assert.equal((await create(salesKey)).length, 1);
  assert.deepEqual((await storedRows(T_A)).map((r) => [r.role_id, r.level]), [['manager', 'full'], ['sales_staff', 'create']]);
  // A grant added to one of the three restored objects while 020 was applied refuses the rollback instead of surviving it.
  for (const [label, widen] of [
    ['EXECUTE on 019\'s create to PUBLIC', `grant execute on function ${CREATE_019} to public`],
    ['EXECUTE on 018\'s page_v2 to the audit writer', `grant execute on function ${PAGE_018} to tmpos_audit_writer`],
    ['USAGE on 019\'s schema to tmpos_app with grant option', 'grant usage on schema tmpos_customer_write to tmpos_app with grant option'],
    ['USAGE on schema tmpos_mint taken from tmpos_app', 'revoke usage on schema tmpos_mint from tmpos_app'],
  ]) {
    const out = await rolledBack('isolation level read committed', async (tx) => {
      await tx.unsafe(widen);
      await tx.unsafe(DOWN_020).simple();
    });
    assert.equal(out.code, '55000', `${label}: refused`);
    assert.match(out.message, /migration 020 rollback refused: (a grant beyond 019's and 018's own remains|tmpos_app does not hold EXECUTE)/, label);
  }
  await owner.begin((tx) => tx.unsafe(DOWN_020).simple());
  try {
    const [state] = await owner`select pg_catalog.to_regnamespace('tmpos_role') is null as gone,
        (select proacl::text from pg_catalog.pg_proc where oid = ${CREATE_019}::regprocedure) as create_acl,
        (select proacl::text from pg_catalog.pg_proc where oid = ${PAGE_018}::regprocedure) as page_acl,
        (select nspacl::text from pg_catalog.pg_namespace where nspname = 'tmpos_customer_write') as schema_acl`;
    assert.deepEqual({ ...state }, { gone: true, create_acl: `{${me}=X/${me},tmpos_app=X/${me}}`,
      page_acl: `{${me}=X/${me},tmpos_app=X/${me}}`, schema_acl: `{${me}=UC/${me},tmpos_app=U/${me}}` }, 'exactly 019\'s end-state grants');
    const post019 = await rolledBack('isolation level read committed', (tx) => tx.unsafe(POSTCONDITION_019).simple());
    assert.equal(post019.code, undefined, '019\'s own postcondition holds again');
    assert.equal(await codeOf(create(salesKey)), '3F000', 'no tmpos_role schema to call');
    const id = randomUUID();
    const [row] = await runtime`select o_tenant_id from tmpos_customer_write.m7a_customer_create(${salesKey}::text, ${id}::uuid, ${`M7RL 019 ${SUFFIX}`}::text)`;
    assert.equal(row.o_tenant_id, T_A, '019\'s create works again for the same live key');
    const listed = await runtime`select o_customer_id from tmpos_mint.m7a_customer_page_v2(${salesKey}::text, null::uuid, 101::integer)`;
    assert.ok(listed.some((r) => r.o_customer_id === id), '018\'s read works again');
  } finally {
    await owner.begin((tx) => tx.unsafe(UP_020).simple());
  }
  assert.equal((await rolledBack('isolation level read committed', (tx) => tx.unsafe(POSTCONDITION_020).simple())).code, undefined,
    're-applied, 020\'s postcondition holds');
  assert.equal(await codeOf(runtime`select * from tmpos_customer_write.m7a_customer_create(${salesKey}::text, ${randomUUID()}::uuid, 'M7RL again'::text)`),
    '42501', 're-applied, 019\'s create is unreachable again');
  assert.deepEqual(await levelsOf(T_A, 'sales_staff'), {}, 're-applied, nothing is stored');
  assert.deepEqual(await create(salesKey), [await ownTuple(SALES_A)], 're-applied, the create works for the same live key');
});

// ---------------------------------------------------------------------------
// M7RL-17: the clock is read again after the role row's wait
// ---------------------------------------------------------------------------

test('M7RL-17: a session that expires while its create or its edit waits on the role row refuses it — the clock is read after that wait (red without it)', async () => {
  const lifetime = 3_000;
  /** The owner holds the committed role row FOR UPDATE past `who`'s short session; then releases it UNCHANGED. */
  const expiresWhileWaiting = async (who, call) => {
    await resetLevels();
    assert.equal((await setLevel(await mint(OWNER_A), 'sales_staff', 'create')).length, 1, 'a committed row at the default');
    const at = Date.now();
    const key = await mint(who, { lifetime, at });
    let pending;
    await owner.begin(async (tx) => {
      await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${T_A} and role_id = 'sales_staff' for update`;
      pending = call(key);
      pending.catch(() => {});
      await untilBlocked('a call waiting on the role row');
      assert.ok(Date.now() < at + lifetime - 500, 'it began waiting while the session was live (else this proves nothing)');
      while (Date.now() <= at + lifetime + 250) await sleep(50);
    });
    return pending;
  };
  const id = randomUUID();
  assert.deepEqual(await expiresWhileWaiting(SALES_A, (key) => create(key, id)), [], 'the create refuses');
  assert.deepEqual(await rowsOf(id), [], 'nothing written');
  assert.deepEqual(await expiresWhileWaiting(OWNER_A, (key) => setLevel(key, 'sales_staff', 'none')), [], 'the edit refuses');
  assert.deepEqual(await levelsOf(T_A, 'sales_staff'), { customers: 'create' }, 'the level is unchanged');

  // Red: without the create's second clock read, the same wait creates for an expired session.
  const recheck = ['  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;\n  if v_now >= v_session.expires_at then\n    return;\n  end if;\n\n  -- 10.',
    '  -- 10.'];
  const redId = randomUUID();
  await withMutated(CREATE, [recheck], async () => {
    assert.equal((await expiresWhileWaiting(SALES_A, (key) => create(key, redId))).length, 1, 'mutated: an expired session creates (red)');
  });
  // Red: without the edit's, the same wait changes a level for an expired owner session.
  const editRecheck = ['  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;\n  if v_now >= v_session.expires_at then\n    return;\n  end if;\n  update tmpos_role.tenant_role_level l',
    '  update tmpos_role.tenant_role_level l'];
  await withMutated(SET, [editRecheck], async () => {
    assert.equal((await expiresWhileWaiting(OWNER_A, (key) => setLevel(key, 'sales_staff', 'none'))).length, 1, 'mutated: an expired owner edits (red)');
  });
  assert.deepEqual(await levelsOf(T_A, 'sales_staff'), { customers: 'none' });
});
