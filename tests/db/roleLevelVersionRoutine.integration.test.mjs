// Phase 4.0 M7A-CUSTOMERS-P4 — the conditional role-level edit against REAL PostgreSQL: migration 021 (schema
// tmpos_role_edit: the edit counter role_level_version and two SECURITY DEFINER routines — the one-snapshot read-back
// m7a_role_level_states and the edit m7a_role_level_set_v2, conditional on the tenant and the version the owner reviewed),
// exercised as the runtime's own non-owner login (tmpos_app + tmpos_audit_writer). This file proves the database half
// alone, with no runtime in front of it; the HTTP route over it, its audit, idempotency and step-up, and the runtime's
// comparison of each answer with its trusted context, are tests/db/roleLevels.integration.test.mjs's.
//
// WHAT IS PROVEN. 001-033 applied clean, every ledger checksum the pinned one, 021's postcondition re-proven over the
// applied state and refusing every widening it names, and a second apply refused (M7RV-01); the installed inventory and
// the login's effective privileges: EXECUTE on the two new routines and on 020's levels read, create and page_v3, NONE on
// 020's unconditional edit (has_function_privilege, and 42501 when called), nothing on the version table (M7RV-02); the
// read-back's shape and order, and a customer create's NULL lock row leaving the version at 0 (M7RV-03); every refused
// edit — a malformed argument or precondition raising 22023 before any state is read, a non-owner, revoked or unminted key
// answering no row — writing nothing (M7RV-04); a tenant mismatch — a session in B asserting A, and an owner moved from A
// to B signing in again — answering 'tenant_mismatch', writing nothing in either tenant and locking no role or version row
// (M7RV-05); a version conflict writing nothing: before any edit, the unlocked pre-check inserting no lock row; after one,
// neither the level nor the version moving (M7RV-06); an applied edit advancing the version by exactly one and writing the
// level, in its own tenant only (M7RV-07); the catalog default restored through an edit, and a further edit rewriting
// that same level, each still advancing the version, so a draft from before the round trip is refused (ABA) (M7RV-08); a
// create's NULL lock row never moving the version, before or after an edit (M7RV-09); two edits from one read — one
// owner's second tab waiting in 016's hold and refused by the pre-check once the first commits; a second owner's waiting
// on the role row — a first insert's or an already committed row's — and refused under it, or applied once the first
// rolls back — and a stale draft refused without waiting (M7RV-10); the edit and a customer create in both orders, with
// pg_blocking_pids proof of each wait (M7RV-11); the rollback refused while a version row exists and under any isolation
// but READ COMMITTED, clean once the owner deletes them, dropping the trigger and giving tmpos_app NOTHING back, then a
// clean re-apply whose counter restarts at 0 (M7RV-12); a session that expires while its edit waits on the role row
// answering 020's no-row refusal, not a version conflict (M7RV-13); a 020 edit that passed its EXECUTE check before 021
// committed and waited on 021's table lock advancing the version once it completes, so a version-0 draft is refused
// (M7RV-14); and every other update of a level row — 020's edit run by the owner, a raw owner UPDATE of one or several rows
// or of nothing but updated_at, and one as a replica — advancing the version by exactly one per row (M7RV-15); and an
// update that moves a row to another key advancing BOTH keys' versions, so a draft at either key's old version is refused
// (M7RV-16).
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a
// cluster this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every
// fixture is synthetic and randomly suffixed, and every issuer key is random bytes made here. It leaves the shared service
// as it found it: 021 applied, the issuer key row it found, no version, role-level, ledger, session or customer row of its
// own (version rows first, so a later rollback of 021 and then 020 can run), and its login dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { REQUIRED_MIGRATIONS } from '../../server/persistence/postgresStartupPreflight.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_021 = readFileSync(`${MIG_DIR}/021_m7a_role_level_precondition.up.sql`, 'utf8');
const DOWN_021 = readFileSync(`${MIG_DIR}/021_m7a_role_level_precondition.down.sql`, 'utf8');
const UP_023 = readFileSync(`${MIG_DIR}/023_m7a_customer_contact.up.sql`, 'utf8');
const DOWN_023 = readFileSync(`${MIG_DIR}/023_m7a_customer_contact.down.sql`, 'utf8');
const UP_024 = readFileSync(`${MIG_DIR}/024_m7a_customer_edit.up.sql`, 'utf8');
const DOWN_024 = readFileSync(`${MIG_DIR}/024_m7a_customer_edit.down.sql`, 'utf8');
const UP_025 = readFileSync(`${MIG_DIR}/025_m7a_customer_search.up.sql`, 'utf8');
const DOWN_025 = readFileSync(`${MIG_DIR}/025_m7a_customer_search.down.sql`, 'utf8');
const UP_026 = readFileSync(`${MIG_DIR}/026_m5_invoice_role_levels.up.sql`, 'utf8');
const DOWN_026 = readFileSync(`${MIG_DIR}/026_m5_invoice_role_levels.down.sql`, 'utf8');
const UP_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.up.sql`, 'utf8');
const DOWN_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.down.sql`, 'utf8');
const UP_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.up.sql`, 'utf8');
const DOWN_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.down.sql`, 'utf8');
/** M7B-INVOICES-P2: 029 (the draft edit) lives in 028's schema and rolls back before it. */
const DOWN_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.down.sql`, 'utf8');
const UP_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.up.sql`, 'utf8');
/** M7B-INVOICES-P2-R1: 030 (the Invoices level guard and the guarded edit, in its own schema) sits above 029 and rolls back first. */
const DOWN_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P2-R1: 030 (the Invoices level guard and the guarded edit) sits above 029 and is applied with it. */
const UP_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.up.sql`, 'utf8');
/** M7B-INVOICES-P1-R3: 031 (the guarded draft save, in 030's schema) sits above 030 and rolls back first. */
const DOWN_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R3: 031 (the guarded draft save) sits above 030 and is applied with it. */
const UP_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.up.sql`, 'utf8');
/** M7B-INVOICES-P1-R4: 032 (the Customers authority of the guarded draft save, in 030's schema) sits above 031 and rolls back first. */
const DOWN_032 = readFileSync(`${MIG_DIR}/032_m7b_invoice_create_customers_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R4: 032 sits above 031 and is applied with it. */
const UP_032 = readFileSync(`${MIG_DIR}/032_m7b_invoice_create_customers_authority.up.sql`, 'utf8');
/** M7B-INVOICES-DISCARD-P1: 033 (the draft discard, in its own schema tmpos_invoice_discard) sits above 032 and rolls back first. */
const DOWN_033 = readFileSync(`${MIG_DIR}/033_m7b_invoice_draft_discard.down.sql`, 'utf8');
/** M7B-INVOICES-DISCARD-P1: 033 sits above 032 and is applied with it. */
const UP_033 = readFileSync(`${MIG_DIR}/033_m7b_invoice_draft_discard.up.sql`, 'utf8');
/** 031's routine, whose presence says 031 is applied (it stays installed, owner-only, once 032 is). */
const CREATE_V2_031 = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
/** 032's routine, whose presence says 032 is applied. */
const CREATE_V3_032 = 'tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_021 = UP_021.slice(UP_021.lastIndexOf('do $$'));
const STATES = 'tmpos_role_edit.m7a_role_level_states(uuid)';
const SET_V2 = 'tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)';
const SET_020 = 'tmpos_role.m7a_role_level_set(text, text, text, text)';
const ADVANCE = 'tmpos_role_edit.m7a_role_level_version_advance()';
const TRIGGER = 'trg_tenant_role_level_version_advance';
const LEVELS_020 = 'tmpos_role.m7a_role_levels(uuid, text)';
const CREATE_020 = 'tmpos_role.m7a_customer_create(text, uuid, text)';
/** Migration 023's create (M7A-CUSTOMERS-P6): the login's only create path, which decides through 020's create. */
const CREATE_023 = 'tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)';
/**
 * 021's postcondition, run again inside `tx`. 021's check (f) requires the login to hold EXECUTE on 020's create, which
 * migration 023 revoked (its create became the login's one path, deciding through 020's): the grant is given back first,
 * inside the same transaction that is always rolled back, so 021's own end state is what is judged. Check (l) requires 021's
 * trigger to be the ONLY trigger on 020's table, which migration 030's guard trigger and 032's Customers guard trigger
 * (M7B-INVOICES-P1-R4) are not: both are dropped first, likewise.
 */
const postcondition021 = async (tx) => {
  await tx.unsafe(`grant execute on function ${CREATE_020} to tmpos_app`);
  await tx.unsafe('drop trigger trg_tenant_role_level_invoice_guard on tmpos_role.tenant_role_level');
  await tx.unsafe('drop trigger trg_tenant_role_level_customers_guard on tmpos_role.tenant_role_level');
  await tx.unsafe(POSTCONDITION_021).simple();
};
const PAGE_020 = 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7rv-migrator', runtimeRef: 'm7rv-runtime' };
const LOCK_KEY = 528_528;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7rv_probe';
const HOUR = 3_600_000;
const TENANT_LIFETIME = 8 * HOUR;
const ROLLBACK = new Error('m7rv: roll the proof back');
/** Every privilege has_table_privilege knows on PostgreSQL 16 (MAINTAIN is 17's). */
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const MISMATCH = Object.freeze({ o_outcome: 'tenant_mismatch', o_tenant_id: null, o_actor_id: null, o_membership_id: null, o_level: null, o_version: null });
const CONFLICT = Object.freeze({ ...MISMATCH, o_outcome: 'version_conflict' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (as tenantRoleLevelRoutine does)
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

const TARGET = resolveDisposableTarget('M7RV');
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
  const quietly = async (fn) => { try { await fn(); } catch { /* an earlier failure left less to clean */ } };
  // A failed M7RV-12 or M7RV-14 may have left 021 rolled back (and M7RV-14 020's edit granted back, which 021's apply
  // revokes): the shared service is left with 021 applied, as it was found.
  await quietly(async () => {
    if ((await owner`select pg_catalog.to_regnamespace('tmpos_role_edit') is null as absent`)[0].absent) {
      await owner.begin((tx) => tx.unsafe(UP_021).simple());
    }
  });
  // And 023 (M7A-CUSTOMERS-P6), which those tests roll back first, applied again above it.
  await quietly(() => up023IfAbsent());
  // Version rows first, then levels: 021's rollback refuses while a version row exists, 020's while a level differs from
  // its default. Tenants stay, as every suite leaves its synthetic tenants.
  if (TENANTS.length > 0) await quietly(() => owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`);
  if (TENANTS.length > 0) await quietly(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
  if (KEYS.size > 0) await quietly(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
  if (UIDS.length > 0) await owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`;
  if (TENANTS.length > 0) await owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
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
// setup: every migration in the directory (001-033), a real non-owner runtime login, the key installed by the owner
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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7rv-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};

/** A synthetic actor: an identity, an active account, and the given memberships. */
async function actor(label, memberships) {
  const uid = `m7rv-${label}-${SUFFIX}`;
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
const OWNER_A = await actor('owner-a', [tenantGrant(T_A, 'store_owner')]);
/** A second owner of A: two principals editing one tenant do not share 016's account lock. */
const OWNER_A2 = await actor('owner-a2', [tenantGrant(T_A, 'store_owner')]);
const OWNER_B = await actor('owner-b', [tenantGrant(T_B, 'store_owner')]);
const SALES_A = await actor('sales-a', [tenantGrant(T_A, 'sales_staff')]);
const MANAGER_A = await actor('manager-a', [tenantGrant(T_A, 'manager')]);
const OWNER_TWO_GRANTS = await actor('owner-two-grants', [tenantGrant(T_A, 'store_owner'), tenantGrant(T_B, 'store_owner')]);
const OWNER_READ_ONLY_TENANT = await actor('owner-read-only-tenant', [tenantGrant(T_READ_ONLY, 'store_owner')]);

// ---------------------------------------------------------------------------
// the runtime login's calls
// ---------------------------------------------------------------------------

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:m7rv', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
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
/** 021's edit, called directly as the runtime login (or on `db`); the version as a number. A raise rejects. */
const setV2 = async (key, role, level, tenant, version, db = runtime, domain = 'customers') =>
  (await db`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version
    from tmpos_role_edit.m7a_role_level_set_v2(${key}::text, ${role}::text, ${domain}::text, ${level}::text,
      ${tenant}::uuid, ${version}::bigint)`)
    .map((r) => ({ ...r, o_version: r.o_version === null ? null : Number(r.o_version) }));
/**
 * Migration 023 (M7A-CUSTOMERS-P6) sits above 021 and revoked the login's EXECUTE on 020's create, which 021's apply-time
 * postcondition requires; so a committed rollback of 021 that is re-applied runs in the supported order — 023's down first,
 * 023's up last (each a file run; the ledger rows stay). 023's down refuses while any customer holds a contact or a creation
 * time, and this file's customers carry the column default's: it clears its OWN rows' (never another suite's) first — test
 * hygiene, not the migration's job — and they stay NULL (an unknown creation time) once 023 is back.
 * M7A-CUSTOMERS-P7: 024 sits above 023 and must roll back first (023's down refuses while 024's column exists); it refuses
 * while any customer is edited or an audit record names a customer — this file edits none — and is re-applied after 023.
 * M7A-CUSTOMERS-P8: 025 (the name search, no data) sits above 024: it rolls back first and is re-applied last.
 * M5-INVOICES-AUTH-P1: 026 (the Invoices level routines and the widened domain CHECKs) sits above 025 and widens 021's own
 * version table's CHECK, which 021's re-apply would narrow again: it rolls back first (it refuses while an Invoices row exists —
 * this file stores none) and is re-applied last.
 * M7B-INVOICES-P1: 027 (store discovery, no data) sits above 026: it rolls back before it and is re-applied after it; 028
 * (invoice drafts, none stored here) sits above 027 likewise, and M7B-INVOICES-P2's 029 (the draft edit, in 028's schema)
 * above 028. M7B-INVOICES-P2-R1's 030 (the Invoices level guard and the guarded edit, in its own schema, with a trigger on
 * 020's table) sits above 029: it rolls back before it and is re-applied after it. M7B-INVOICES-P1-R3's 031 (the guarded draft
 * save, in 030's schema) sits above 030: it rolls back before it and is re-applied after it. M7B-INVOICES-P1-R4's 032 (the
 * Customers authority of that save: routines in 030's schema and a trigger on 020's table) sits above 031 likewise.
 * M7B-INVOICES-DISCARD-P1's 033 (the draft discard, in its own schema, with a status CHECK and two triggers on 028's tables, and a
 * rollback-order anchor that refuses every older down while it is applied) sits above 032: it rolls back first and is re-applied last.
 */
const down023 = async () => {
  await owner`update tmpos_customer.customer set phone = null, email = null, created_at = null where tenant_id = any(${TENANTS}::uuid[])`;
  if (!(await owner`select pg_catalog.to_regnamespace('tmpos_invoice_discard') is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_033).simple());
  }
  if (!(await owner`select pg_catalog.to_regprocedure(${CREATE_V3_032}) is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_032).simple());
  }
  if (!(await owner`select pg_catalog.to_regprocedure(${CREATE_V2_031}) is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_031).simple());
  }
  if (!(await owner`select pg_catalog.to_regnamespace('tmpos_invoice_edit') is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_030).simple());
  }
  if (!(await owner`select pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_029).simple());
  }
  if (!(await owner`select pg_catalog.to_regnamespace('tmpos_invoice_draft') is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_028).simple());
  }
  if (!(await owner`select pg_catalog.to_regnamespace('tmpos_store_access') is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_027).simple());
  }
  if (!(await owner`select pg_catalog.to_regnamespace('tmpos_role_invoice') is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_026).simple());
  }
  if (!(await owner`select pg_catalog.to_regnamespace('tmpos_customer_search') is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_025).simple());
  }
  if (!(await owner`select pg_catalog.to_regnamespace('tmpos_customer_edit') is null as absent`)[0].absent) {
    await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_024).simple());
  }
  await owner.begin('isolation level read committed', (tx) => tx.unsafe(DOWN_023).simple());
};
const up023IfAbsent = async () => {
  if ((await owner`select pg_catalog.to_regnamespace('tmpos_customer_contact') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_023).simple());
  }
  if ((await owner`select pg_catalog.to_regnamespace('tmpos_customer_edit') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_024).simple());
  }
  if ((await owner`select pg_catalog.to_regnamespace('tmpos_customer_search') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_025).simple());
  }
  if ((await owner`select pg_catalog.to_regnamespace('tmpos_role_invoice') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_026).simple());
  }
  if ((await owner`select pg_catalog.to_regnamespace('tmpos_store_access') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_027).simple());
  }
  if ((await owner`select pg_catalog.to_regnamespace('tmpos_invoice_draft') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_028).simple());
  }
  if ((await owner`select pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_029).simple());
  }
  if ((await owner`select pg_catalog.to_regnamespace('tmpos_invoice_edit') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_030).simple());
  }
  if ((await owner`select pg_catalog.to_regprocedure(${CREATE_V2_031}) is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_031).simple());
  }
  if ((await owner`select pg_catalog.to_regprocedure(${CREATE_V3_032}) is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_032).simple());
  }
  if ((await owner`select pg_catalog.to_regnamespace('tmpos_invoice_discard') is null as absent`)[0].absent) {
    await owner.begin((tx) => tx.unsafe(UP_033).simple());
  }
};
/** 021's read-back, as the runtime login. */
const statesOf = async (tenant) => (await runtime`select tmpos_role_edit.m7a_role_level_states(${tenant}::uuid) as states`)[0].states;
/** The one role's entry of the read-back. */
const stateOf = async (tenant, role) => (await statesOf(tenant)).find((s) => s.roleId === role);
/**
 * A customer create, as the runtime login (or on `db`): since M7A-CUSTOMERS-P6 through migration 023's routine, name only —
 * it delegates the whole decision to 020's create, which this file's level and version cases are about.
 */
const create = async (key, id = randomUUID(), db = runtime) =>
  (await db`select o_tenant_id from tmpos_customer_contact.m7a_contact_create(${key}::text, ${id}::uuid, ${`M7RV ${SUFFIX}`}::text,
    null::text, null::text)`).map((r) => ({ ...r }));
/** Every stored role row and every version row of `tenant`, read by the owner. */
const storedRows = async (tenant) => (await owner`select role_id, level from tmpos_role.tenant_role_level
  where tenant_id = ${tenant} order by role_id`).map((r) => ({ ...r }));
const versionRows = async (tenant) => (await owner`select role_id, version::int as version from tmpos_role_edit.role_level_version
  where tenant_id = ${tenant} order by role_id`).map((r) => ({ ...r }));
/** Back to nothing stored everywhere this suite owns: version rows first (021's rollback order), then levels. */
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
 * Resolves once a runtime-login backend waits on a Lock that `holder` holds (pg_blocking_pids), answering the ungranted
 * pg_locks rows it waits on. Bounded: a timeout fails ("the lever did not engage"), never passes.
 */
async function waitingOn(label, holder) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const rows = await owner`select a.pid, pg_catalog.pg_blocking_pids(a.pid) as blockers from pg_catalog.pg_stat_activity a
      where a.usename = ${RUNTIME_LOGIN} and a.wait_event_type = 'Lock'`;
    const waiter = rows.find((r) => r.blockers.includes(holder));
    if (waiter) {
      return (await owner`select locktype, relation::regclass::text as relation from pg_catalog.pg_locks
        where pid = ${waiter.pid} and not granted`).map((l) => ({ ...l }));
    }
    await sleep(20);
  }
  return assert.fail(`${label}: the lever did not engage (no runtime backend waited on a lock ${holder} holds)`);
}
/** A wait on the role row: the row's tuple lock, or the holder's transaction id (an uncommitted insert or update). */
const onRoleRow = (locks) => locks.length > 0 && locks.every((l) => l.locktype === 'transactionid'
  || (l.locktype === 'tuple' && l.relation === 'tmpos_role.tenant_role_level'));

// ---------------------------------------------------------------------------
// M7RV-01..02: the migration, the inventory and the login's privileges
// ---------------------------------------------------------------------------

test('M7RV-01: 001-033 applied clean, every checksum the pinned one; 021\'s postcondition holds and refuses every widening it names; a second apply is refused', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    Array.from({ length: 33 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  // 001-020 byte-identical: the ledger, the startup pins and the files on disk agree (the pins are bound to the committed
  // bytes by tests/quality/migration-files-contract.test.mjs).
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'the ledger records the pinned chain');
  const onDisk = (version) => {
    const [name] = readdirSync(MIG_DIR).filter((f) => f.startsWith(`${version}_`) && f.endsWith('.up.sql'));
    return createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex');
  };
  assert.deepEqual(REQUIRED_MIGRATIONS.map((m) => onDisk(m.version)), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'every up file is its pinned bytes');

  const [{ me }] = await owner`select current_user as me`;
  const postcondition = async (widen) => rolledBack('isolation level read committed', async (tx) => {
    for (const statement of widen) await tx.unsafe(statement);
    await postcondition021(tx);
  });
  for (const [label, widen] of [
    ['a SELECT on the version table', ['grant select on tmpos_role_edit.role_level_version to tmpos_app']],
    ['a column grant on the version table', ['grant select (version) on tmpos_role_edit.role_level_version to tmpos_app']],
    ['a policy on the version table', ['create policy m7rv_all on tmpos_role_edit.role_level_version using (true)']],
    ['forced row security on the version table', ['alter table tmpos_role_edit.role_level_version force row level security']],
    ['a foreign key on the version table', ['alter table tmpos_role_edit.role_level_version add constraint m7rv_fk foreign key (tenant_id) references public.tenant (tenant_id)']],
    ['020\'s edit granted back to tmpos_app', [`grant execute on function ${SET_020} to tmpos_app`]],
    ['020\'s edit granted to PUBLIC', [`grant execute on function ${SET_020} to public`]],
    ['020\'s page_v3 taken from tmpos_app', [`revoke execute on function ${PAGE_020} from tmpos_app`]],
    ['EXECUTE on the edit to the audit writer', [`grant execute on function ${SET_V2} to tmpos_audit_writer`]],
    ['EXECUTE on the read-back with grant option', [`grant execute on function ${STATES} to tmpos_app with grant option`]],
    ['USAGE on the schema to the audit writer', ['grant usage on schema tmpos_role_edit to tmpos_audit_writer']],
    ['a STABLE edit', [`alter function ${SET_V2} stable`]],
    ['a read-back without row_security off', [`alter function ${STATES} reset row_security`]],
    ['an extra routine in the schema', ['create function tmpos_role_edit.m7rv_probe() returns int language sql as \'select 1\'']],
    ['EXECUTE on the trigger function to tmpos_app', [`grant execute on function ${ADVANCE} to tmpos_app`]],
    ['a trigger function without row_security off', [`alter function ${ADVANCE} reset row_security`]],
    ['the version trigger disabled', [`alter table tmpos_role.tenant_role_level disable trigger ${TRIGGER}`]],
    ['the version trigger enabled on origin only (a replica session skips it)', [`alter table tmpos_role.tenant_role_level enable trigger ${TRIGGER}`]],
    ['a second trigger on the role table', [`create trigger m7rv_extra after update on tmpos_role.tenant_role_level for each row execute function ${ADVANCE}`]],
    ['a NOINHERIT membership in the owner (SET ROLE reaches it)', ['alter role tmpos_app noinherit', `grant "${me}" to tmpos_app`]],
    ['a role holding UPDATE on the version table, reachable only through SET ROLE',
      ['create role m7rv_writer nologin', 'grant usage on schema tmpos_role_edit to m7rv_writer',
        'grant update on tmpos_role_edit.role_level_version to m7rv_writer', 'alter role tmpos_app noinherit', 'grant m7rv_writer to tmpos_app']],
  ]) {
    assert.equal((await postcondition(widen)).code, '55000', `${label} is refused`);
  }
  assert.equal((await postcondition([])).code, undefined, 'the state 021 left satisfies it');

  const again = await rolledBack('isolation level read committed', (tx) => tx.unsafe(UP_021).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /migration 021 refused: schema tmpos_role_edit already exists/);
});

test('M7RV-02: the installed inventory, and the login\'s effective privileges — the two new routines and 020\'s levels read, create and page_v3; NOT 020\'s edit; nothing on the version table', async () => {
  const [{ me }] = await owner`select current_user as me`;
  const routines = await owner`select p.proname as name, p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
      pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
      (select coalesce(array_agg(pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable) order by pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable) collate "C"), '{}')
         from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where g.grantee <> p.proowner) as grants
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role_edit'::regnamespace order by p.proname`;
  const pinned = ['search_path=pg_catalog, pg_temp', 'row_security=off'];
  assert.deepEqual(routines.map((r) => ({ ...r })), [
    { name: 'm7a_role_level_set_v2', definer: true, volatility: 'v', config: pinned,
      args: 'p_session_key text, p_role_id text, p_domain text, p_level text, p_expected_tenant uuid, p_expected_version bigint',
      grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'm7a_role_level_states', definer: true, volatility: 's', config: pinned, args: 'p_tenant_id uuid', grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'm7a_role_level_version_advance', definer: true, volatility: 'v', config: pinned, args: '', grants: [] },
  ], 'the edit\'s only authority argument is the session key; the tenant and version are preconditions; the trigger function is granted to nobody');
  const triggers = await owner`select g.tgname::text as name, g.tgtype::int as tgtype, g.tgenabled::text as enabled,
      g.tgfoid::regprocedure::text as fn, g.tgqual is null as no_when, g.tgattr::text as columns
    from pg_catalog.pg_trigger g where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal order by g.tgname`;
  assert.deepEqual(triggers.map((r) => ({ ...r })), [
    { name: 'trg_tenant_role_level_customers_guard', tgtype: 29, enabled: 'A', fn: 'tmpos_invoice_edit.m7b_customers_level_guard()', no_when: true, columns: '' },
    { name: 'trg_tenant_role_level_invoice_guard', tgtype: 29, enabled: 'A', fn: 'tmpos_invoice_edit.m7b_invoice_level_guard()', no_when: true, columns: '' },
    { name: TRIGGER, tgtype: 17, enabled: 'A', fn: ADVANCE, no_when: true, columns: '' },
  ], 'three triggers on the role table, all enabled ALWAYS, every column, no WHEN: 021\'s AFTER ROW UPDATE and the guards of 032 (Customers) and 030 (Invoices), AFTER ROW INSERT, UPDATE and DELETE');
  const [{ pg17 }] = await owner`select pg_catalog.current_setting('server_version_num')::int >= 170000 as pg17`;
  const [table] = await owner`select c.relrowsecurity as rls, c.relforcerowsecurity as forced, c.relacl::text as acl,
      n.nspacl::text as schema_acl,
      (select count(*)::int from pg_catalog.pg_policy p where p.polrelid = c.oid) as policies,
      (select array_agg(a.attname::text order by a.attnum) from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0) as columns,
      (select array_agg(k.contype::text order by k.conname) from pg_catalog.pg_constraint k where k.conrelid = c.oid) as constraints
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.oid = 'tmpos_role_edit.role_level_version'::regclass`;
  assert.deepEqual({ ...table }, {
    rls: true, forced: false, acl: `{${me}=arwdDxt${pg17 ? 'm' : ''}/${me}}`, schema_acl: `{${me}=UC/${me},tmpos_app=U/${me}}`, policies: 0,
    columns: ['tenant_id', 'role_id', 'domain', 'version'], constraints: ['c', 'p', 'c', 'c'],
  }, 'row security on, not forced, no policy, no foreign key, the owner alone on the table; USAGE alone to tmpos_app on the schema');

  // Read by the owner for the login by name: has_function_privilege follows PUBLIC and every inherited role.
  const [rights] = await owner`select
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${STATES}::regprocedure, 'EXECUTE') as states,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${SET_V2}::regprocedure, 'EXECUTE') as set_v2,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${LEVELS_020}::regprocedure, 'EXECUTE') as levels,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_023}::regprocedure, 'EXECUTE') as creates,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_020}::regprocedure, 'EXECUTE') as creates_020,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${PAGE_020}::regprocedure, 'EXECUTE') as reads,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${SET_020}::regprocedure, 'EXECUTE') as set_020,
      pg_catalog.has_function_privilege('tmpos_app', ${SET_020}::regprocedure, 'EXECUTE') as app_set_020,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${ADVANCE}::regprocedure, 'EXECUTE') as advance,
      pg_catalog.has_schema_privilege(${RUNTIME_LOGIN}, 'tmpos_role_edit', 'USAGE') as schema_usage`;
  // M7A-CUSTOMERS-P6: the login creates through 023's routine; 023 revoked 020's create from it.
  assert.deepEqual({ ...rights }, { states: true, set_v2: true, levels: true, creates: true, creates_020: false, reads: true, set_020: false, app_set_020: false, advance: false, schema_usage: true });
  const [{ set_acl }] = await owner`select proacl::text as set_acl from pg_catalog.pg_proc where oid = ${SET_020}::regprocedure`;
  assert.equal(set_acl, `{${me}=X/${me}}`, '020\'s edit stays, granted to its owner alone');
  for (const privilege of TABLE_PRIVILEGES) {
    const [{ held }] = await runtime`select pg_catalog.has_table_privilege(current_user, 'tmpos_role_edit.role_level_version'::regclass, ${privilege}) as held`;
    assert.equal(held, false, `the login holds no ${privilege} on the version table`);
  }
  const ownerKey = await mint(OWNER_A);
  for (const [label, statement] of [
    ['SELECT versions', 'select version from tmpos_role_edit.role_level_version limit 1'],
    ['INSERT a version', `insert into tmpos_role_edit.role_level_version (tenant_id, role_id, domain, version) values ('${T_A}', 'sales_staff', 'customers', 99)`],
    ['UPDATE versions', 'update tmpos_role_edit.role_level_version set version = 1'],
    ['DELETE versions', 'delete from tmpos_role_edit.role_level_version'],
    ['020\'s unconditional edit', `select * from tmpos_role.m7a_role_level_set('${ownerKey}', 'sales_staff', 'customers', 'none')`],
  ]) {
    assert.equal(await codeOf(runtime.unsafe(statement)), '42501', `${label} is refused`);
  }
  assert.deepEqual(await storedRows(T_A), [], 'nothing written');
  const [others] = await owner`select bool_or(pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')) as any_execute
    from pg_catalog.pg_roles r cross join pg_catalog.pg_proc p
    where r.rolname in ('tmpos_audit_writer', 'anon', 'authenticated')
      and (p.pronamespace = 'tmpos_role_edit'::regnamespace or p.oid = ${SET_020}::regprocedure)`;
  assert.equal(others.any_execute, false, 'the audit writer, anon and authenticated execute none of them');
});

// ---------------------------------------------------------------------------
// M7RV-03..04: the read-back and the refusals
// ---------------------------------------------------------------------------

test('M7RV-03: the read-back answers the three editable roles in order, level and version, on one snapshot; a create\'s NULL lock row leaves level null and version 0', async () => {
  await resetState();
  const none = (roleId) => ({ roleId, level: null, version: 0 });
  assert.deepEqual(await statesOf(T_A), [none('manager'), none('technician'), none('sales_staff')], 'nothing stored: every level null, every version 0');
  assert.deepEqual(await statesOf(randomUUID()), [none('manager'), none('technician'), none('sales_staff')], 'an unknown tenant reads the same');
  assert.equal((await create(await mint(SALES_A))).length, 1, 'sales_staff creates at its default');
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'sales_staff', level: null }], 'the create left its NULL lock row');
  assert.deepEqual(await statesOf(T_A), [none('manager'), none('technician'), none('sales_staff')], 'a lock row is no edit: null, version 0');
  assert.deepEqual(await setV2(await mint(OWNER_A), 'technician', 'create', T_A, 0), [await applied(OWNER_A, 'create', 1)]);
  assert.deepEqual(await statesOf(T_A), [none('manager'), { roleId: 'technician', level: 'create', version: 1 }, none('sales_staff')]);
  assert.deepEqual(await statesOf(T_B), [none('manager'), none('technician'), none('sales_staff')], 'B is untouched');
  assert.deepEqual(await errorOf(statesOf(null)), { code: '22023', message: 'migration 021 states: the argument is null' });
});

test('M7RV-04: every refused edit writes nothing — a malformed argument or precondition raises 22023 before any state is read, outside READ COMMITTED 55000, and a key 020\'s edit refuses answers no row', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  for (const [label, key, role, domain, level, tenant, version] of [
    ['a null expected tenant', ownerKey, 'sales_staff', 'customers', 'view', null, 0],
    ['a null expected version', ownerKey, 'sales_staff', 'customers', 'view', T_A, null],
    ['a negative expected version', ownerKey, 'sales_staff', 'customers', 'view', T_A, -1],
    ['the owner role as the target', ownerKey, 'store_owner', 'customers', 'none', T_A, 0],
    ['another domain', ownerKey, 'sales_staff', 'sales', 'view', T_A, 0],
    ['a level outside the vocabulary', ownerKey, 'sales_staff', 'customers', 'admin', T_A, 0],
    ['a null key', null, 'sales_staff', 'customers', 'view', T_A, 0],
    ['a key outside 011\'s shape', 'has a space', 'sales_staff', 'customers', 'view', T_A, 0],
  ]) {
    assert.deepEqual(await errorOf(setV2(key, role, level, tenant, version, runtime, domain)),
      { code: '22023', message: 'migration 021 set: an argument is malformed' }, label);
  }
  for (const isolation of ['isolation level repeatable read', 'isolation level serializable']) {
    assert.equal(await codeOf(runtime.begin(isolation, (tx) => setV2(ownerKey, 'sales_staff', 'view', T_A, 0, tx))), '55000', isolation);
  }
  const revoked = await mint(OWNER_A);
  await runtime`select tmpos_session.m5_session_revoke(${revoked}::text)`;
  for (const [label, key, tenant] of [
    ['a manager\'s key', await mint(MANAGER_A), T_A],
    ['a sales_staff key', await mint(SALES_A), T_A],
    ['an owner holding two tenant grants (ambiguous)', await mint(OWNER_TWO_GRANTS), T_A],
    ['the owner of a read_only tenant', await mint(OWNER_READ_ONLY_TENANT), T_READ_ONLY],
    ['a revoked owner key', revoked, T_A],
    ['an unminted key', newKey(), T_A],
  ]) {
    assert.deepEqual(await setV2(key, 'sales_staff', 'none', tenant, 0), [], label);
  }
  for (const tenant of [T_A, T_B, T_READ_ONLY]) {
    assert.deepEqual({ levels: await storedRows(tenant), versions: await versionRows(tenant) }, { levels: [], versions: [] },
      'no refusal wrote a role row, a lock row or a version');
  }
});

// ---------------------------------------------------------------------------
// M7RV-05..09: the preconditions
// ---------------------------------------------------------------------------

test('M7RV-05: a tenant mismatch — a B session asserting A, and an owner moved from A to B who signs in again — answers tenant_mismatch, writes nothing in either tenant and locks no role or version row', async () => {
  await resetState();
  const keyB = await mint(OWNER_B);
  await runtime.begin(async (tx) => {
    assert.deepEqual(await setV2(keyB, 'sales_staff', 'none', T_A, 0, tx), [MISMATCH], 'B\'s session asserting A');
    const pid = await pidOf(tx);
    assert.deepEqual({ role: await modesOn(pid, 'tmpos_role.tenant_role_level'), version: await modesOn(pid, 'tmpos_role_edit.role_level_version') },
      { role: [], version: [] }, 'refused before the role row or the version table is touched');
  });

  // The DA-125 shape: the owner reads A, the same account is moved to B, signs in again, and sends the A draft.
  const tA = await newTenant('move-a');
  const tB = await newTenant('move-b');
  const mover = await actor('mover', [tenantGrant(tA, 'store_owner')]);
  const before = await mint(mover);
  const read = await stateOf(tA, 'sales_staff');
  assert.deepEqual(read, { roleId: 'sales_staff', level: null, version: 0 });
  await owner`delete from user_membership where internal_user_id = ${mover.id} and tenant_id = ${tA}`;
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${mover.id}, ${tB}, null, 'tenant', 'store_owner', 'active')`;
  assert.deepEqual(await setV2(before, 'sales_staff', 'create', tA, read.version), [], 'the session minted under A no longer edits (its standing moved)');
  const after = await mint(mover);
  assert.deepEqual(await setV2(after, 'sales_staff', 'create', tA, read.version), [MISMATCH], 'the A draft on the new B session');
  for (const tenant of [tA, tB]) {
    assert.deepEqual({ levels: await storedRows(tenant), versions: await versionRows(tenant) }, { levels: [], versions: [] },
      'neither A nor B holds a level, a lock row or a version');
  }
  assert.deepEqual(await setV2(after, 'sales_staff', 'create', tB, 0), [await applied(mover, 'create', 1)], 'a B draft on the B session applies in B');
  assert.deepEqual(await storedRows(tA), [], 'A is still untouched');
});

test('M7RV-06: a version conflict writes nothing — before any edit the unlocked pre-check inserts no lock row; after one neither the level nor the version moves', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  await runtime.begin(async (tx) => {
    assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'none', T_A, 1, tx), [CONFLICT], 'a version never issued');
    const pid = await pidOf(tx);
    assert.deepEqual({ role: await modesOn(pid, 'tmpos_role.tenant_role_level'), version: await modesOn(pid, 'tmpos_role_edit.role_level_version') },
      { role: [], version: ['AccessShareLock'] }, 'only the plain version read ran: no lock row inserted, no row locked');
  });
  assert.deepEqual({ levels: await storedRows(T_A), versions: await versionRows(T_A) }, { levels: [], versions: [] });

  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)]);
  for (const stale of [0, 2, 9_007_199_254_740_991]) {
    assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'full', T_A, stale), [CONFLICT], `expected ${stale} against 1`);
  }
  assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'view', version: 1 }, 'the level and the version stand');
});

test('M7RV-07: an applied edit writes the level and advances the version by exactly one, in its own tenant only', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  let version = 0;
  for (const level of ['view', 'none', 'full', 'create']) {
    assert.deepEqual(await setV2(ownerKey, 'sales_staff', level, T_A, version), [await applied(OWNER_A, level, version + 1)], level);
    version += 1;
    assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level, version });
    assert.deepEqual(await versionRows(T_A), [{ role_id: 'sales_staff', version }]);
  }
  assert.deepEqual(await setV2(ownerKey, 'manager', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)], 'each role counts on its own');
  assert.deepEqual(await setV2(await mint(OWNER_B), 'sales_staff', 'none', T_B, 0), [await applied(OWNER_B, 'none', 1)], 'each tenant counts on its own');
  assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 4 }, 'A is untouched by B');
  // The level written is the one every decision reads: 020's levels read and create.
  assert.deepEqual((await runtime`select tmpos_role.m7a_role_levels(${T_A}::uuid, 'sales_staff'::text) as levels`)[0].levels, { customers: 'create' });
  assert.equal((await create(salesKey)).length, 1, 'enforced: sales_staff at create creates');
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'view', T_A, 4), [await applied(OWNER_A, 'view', 5)]);
  assert.deepEqual(await create(salesKey), [], 'enforced: sales_staff at view does not');
});

test('M7RV-08: restoring the catalog default through an edit, and a further edit rewriting that same level, each still advance the version, so a draft from before the round trip is refused (no ABA)', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  const v0 = await stateOf(T_A, 'sales_staff');
  assert.deepEqual(v0, { roleId: 'sales_staff', level: null, version: 0 }, 'the default, create, and version 0');
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'none', T_A, 0), [await applied(OWNER_A, 'none', 1)]);
  assert.deepEqual(await create(salesKey), [], 'at none, no create');
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'create', T_A, 1), [await applied(OWNER_A, 'create', 2)], 'back to the default word');
  assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 2 }, 'stored explicitly, at version 2');
  assert.equal((await create(salesKey)).length, 1, 'at create, a create');
  // One further edit after the reset, writing the level already stored: still an edit, still one more version.
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'create', T_A, 2), [await applied(OWNER_A, 'create', 3)], 'the same word again');
  for (const stale of [v0.version, 1, 2]) {
    assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'view', T_A, stale), [CONFLICT], `the draft at version ${stale} is refused`);
  }
  assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 3 }, 'the restored default stands');
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'view', T_A, 3), [await applied(OWNER_A, 'view', 4)], 'reapplied against the version read now');
});

test('M7RV-09: a customer create\'s NULL lock row never moves the version, before or after an edit', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  const managerKey = await mint(MANAGER_A);
  assert.equal((await create(salesKey)).length, 1);
  assert.equal((await create(managerKey)).length, 1);
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'manager', level: null }, { role_id: 'sales_staff', level: null }], 'two NULL lock rows');
  assert.deepEqual(await versionRows(T_A), [], 'and no version');
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'edit', T_A, 0), [await applied(OWNER_A, 'edit', 1)], 'version 0 still applies: no false conflict');
  for (let i = 0; i < 3; i += 1) assert.equal((await create(salesKey)).length, 1);
  assert.deepEqual(await versionRows(T_A), [{ role_id: 'sales_staff', version: 1 }], 'creates at edit leave version 1');
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'view', T_A, 1), [await applied(OWNER_A, 'view', 2)]);
});

// ---------------------------------------------------------------------------
// M7RV-10..11: the order two edits, and an edit and a create, take
// ---------------------------------------------------------------------------

test('M7RV-10: two edits from one read — one owner\'s second tab waits on the first (016\'s account lock) and its pre-check refuses it; a second owner\'s edit waits on the role row and is refused under it once the first commits, applied once it rolls back; a draft already stale is refused without waiting', async () => {
  // (a) One owner, two tabs: the second edit waits in 016's hold on the owner's own account, before the role row.
  await resetState();
  const tab1 = await mint(OWNER_A);
  const tab2 = await mint(OWNER_A);
  let pending;
  let wait;
  await runtime.begin(async (tx) => {
    const holder = await pidOf(tx);
    assert.deepEqual(await setV2(tab1, 'sales_staff', 'none', T_A, 0, tx), [await applied(OWNER_A, 'none', 1)], 'tab 1');
    pending = setV2(tab2, 'sales_staff', 'create', T_A, 0);
    pending.catch(() => {});
    wait = await waitingOn('the same owner\'s second tab', holder);
  });
  assert.ok(!wait.some((l) => l.relation === 'tmpos_role.tenant_role_level'), `it waited before the role row: ${JSON.stringify(wait)}`);
  assert.deepEqual(await pending, [CONFLICT], 'tab 2\'s older draft is refused');
  assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'none', version: 1 }, 'tab 1\'s None stands');

  // (b) Two owners of one tenant share no account lock: the second waits on the role row, and the version read under that
  //     lock (not the pre-check, which passed) decides.
  for (const commit of [true, false]) {
    await resetState();
    const first = await mint(OWNER_A);
    const second = await mint(OWNER_A2);
    const edit = runtime.begin(async (tx) => {
      const holder = await pidOf(tx);
      assert.deepEqual(await setV2(first, 'sales_staff', 'none', T_A, 0, tx), [await applied(OWNER_A, 'none', 1)], 'the first owner');
      assert.deepEqual(await setV2(second, 'sales_staff', 'full', T_A, 3), [CONFLICT], 'a draft at a version never committed: refused at once');
      pending = setV2(second, 'sales_staff', 'create', T_A, 0);
      pending.catch(() => {});
      wait = await waitingOn(`the second owner waiting on the first (${commit ? 'commit' : 'rollback'})`, holder);
      if (!commit) throw ROLLBACK;
    });
    if (commit) await edit; else await assert.rejects(edit, (err) => err === ROLLBACK);
    assert.ok(onRoleRow(wait), JSON.stringify(wait));
    if (commit) {
      assert.deepEqual(await pending, [CONFLICT], 'the second owner\'s older draft is refused under the lock');
      assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'none', version: 1 });
      assert.deepEqual(await storedRows(T_A), [{ role_id: 'sales_staff', level: 'none' }]);
    } else {
      assert.deepEqual(await pending, [await applied(OWNER_A2, 'create', 1)], 'the first rolled back: the second is the first edit');
      assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 1 });
    }
  }

  // (c) (b) on a role row already committed (version 1), so the wait is on the first edit's update of that row, not on an
  //     uncommitted first insert: the second owner's stale draft (version 1) passes the unlocked pre-check, waits, and is
  //     refused under the lock once the first commits, or applied once it rolls back.
  for (const commit of [true, false]) {
    await resetState();
    const first = await mint(OWNER_A);
    const second = await mint(OWNER_A2);
    assert.deepEqual(await setV2(first, 'sales_staff', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)], 'a committed row at version 1');
    const edit = runtime.begin(async (tx) => {
      const holder = await pidOf(tx);
      assert.deepEqual(await setV2(first, 'sales_staff', 'none', T_A, 1, tx), [await applied(OWNER_A, 'none', 2)], 'the first owner');
      pending = setV2(second, 'sales_staff', 'full', T_A, 1);
      pending.catch(() => {});
      wait = await waitingOn(`the second owner waiting on a committed row (${commit ? 'commit' : 'rollback'})`, holder);
      if (!commit) throw ROLLBACK;
    });
    if (commit) await edit; else await assert.rejects(edit, (err) => err === ROLLBACK);
    assert.ok(onRoleRow(wait), JSON.stringify(wait));
    if (commit) {
      assert.deepEqual(await pending, [CONFLICT], 'the version read under the lock refuses the draft the pre-check passed');
      assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'none', version: 2 });
    } else {
      assert.deepEqual(await pending, [await applied(OWNER_A2, 'full', 2)], 'the first rolled back: the draft at version 1 applies');
      assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'full', version: 2 });
    }
  }
});

test('M7RV-11: an edit and a customer create, both orders — the edit holding the row makes the create wait and refuse; the create holding it makes the edit wait and apply, the version moved by the edit alone', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  const salesKey = await mint(SALES_A);
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'create', T_A, 0), [await applied(OWNER_A, 'create', 1)], 'a committed row');

  const refusedId = randomUUID();
  let pendingCreate;
  let wait;
  await runtime.begin(async (tx) => {
    const holder = await pidOf(tx);
    assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'view', T_A, 1, tx), [await applied(OWNER_A, 'view', 2)]);
    pendingCreate = create(salesKey, refusedId);
    pendingCreate.catch(() => {});
    wait = await waitingOn('a create waiting on an edit', holder);
  });
  assert.ok(onRoleRow(wait), JSON.stringify(wait));
  assert.deepEqual(await pendingCreate, [], 'the narrowing committed first: the create refuses');
  assert.deepEqual((await owner`select count(*)::int as n from tmpos_customer.customer where customer_id = ${refusedId}`)[0].n, 0);

  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'create', T_A, 2), [await applied(OWNER_A, 'create', 3)]);
  const madeId = randomUUID();
  let pendingEdit;
  await runtime.begin(async (tx) => {
    const holder = await pidOf(tx);
    assert.equal((await create(salesKey, madeId, tx)).length, 1);
    pendingEdit = setV2(ownerKey, 'sales_staff', 'view', T_A, 3);
    pendingEdit.catch(() => {});
    wait = await waitingOn('an edit waiting on a create', holder);
    assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'create', version: 3 }, 'while it waits nothing moved');
  });
  assert.ok(onRoleRow(wait), JSON.stringify(wait));
  assert.deepEqual(await pendingEdit, [await applied(OWNER_A, 'view', 4)], 'the create committed first: the edit applies, version 3 + 1');
  assert.deepEqual((await owner`select count(*)::int as n from tmpos_customer.customer where customer_id = ${madeId}`)[0].n, 1);
});

// ---------------------------------------------------------------------------
// M7RV-12: rollback and re-apply
// ---------------------------------------------------------------------------

test('M7RV-12: 021 down refuses while a version row exists and outside READ COMMITTED; once the owner deletes them it removes its objects and gives tmpos_app nothing back; 021 re-applies cleanly, its counter at 0', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)]);

  const refused = await rolledBack('isolation level read committed', (tx) => tx.unsafe(DOWN_021).simple());
  assert.equal(refused.code, '55000');
  assert.match(refused.message, /migration 021 rollback refused: a role-level version has been issued/);
  await owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
  const isolation = await rolledBack('isolation level repeatable read', (tx) => tx.unsafe(DOWN_021).simple());
  assert.equal(isolation.code, '55000');
  assert.match(isolation.message, /it must run under READ COMMITTED/);
  // Its postcondition: a grant of 020's edit made while 021 was applied refuses the rollback instead of surviving it.
  const regranted = await rolledBack('isolation level read committed', async (tx) => {
    await tx.unsafe(`grant execute on function ${SET_020} to tmpos_app`);
    await tx.unsafe(DOWN_021).simple();
  });
  assert.equal(regranted.code, '55000');
  assert.match(regranted.message, /can execute 020's unconditional edit/);

  await down023();
  await owner.begin((tx) => tx.unsafe(DOWN_021).simple());
  try {
    const [state] = await owner`select pg_catalog.to_regnamespace('tmpos_role_edit') is null as gone,
        (select count(*)::int from pg_catalog.pg_trigger g where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal) as triggers,
        pg_catalog.has_function_privilege('tmpos_app', ${SET_020}::regprocedure, 'EXECUTE') as set_020,
        pg_catalog.has_function_privilege('tmpos_app', ${LEVELS_020}::regprocedure, 'EXECUTE') as levels_020`;
    assert.deepEqual({ ...state }, { gone: true, triggers: 0, set_020: false, levels_020: true }, 'its objects and its trigger gone; 020\'s edit NOT given back; 020 as it was');
    assert.deepEqual(await storedRows(T_A), [{ role_id: 'sales_staff', level: 'view' }], 'the level stays');
    assert.equal(await codeOf(setV2(ownerKey, 'sales_staff', 'none', T_A, 0)), '3F000', 'no tmpos_role_edit schema to call');
    assert.equal(await codeOf(runtime`select * from tmpos_role.m7a_role_level_set(${ownerKey}::text, 'sales_staff'::text, 'customers'::text, 'none'::text)`),
      '42501', 'rolled back, the runtime role edits nothing');
  } finally {
    await owner.begin((tx) => tx.unsafe(UP_021).simple());
    await up023IfAbsent();
  }
  assert.equal((await rolledBack('isolation level read committed', (tx) => postcondition021(tx))).code, undefined,
    're-applied, 021\'s postcondition holds');
  assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'view', version: 0 }, 're-applied, the counter restarts at 0');
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'none', T_A, 0), [await applied(OWNER_A, 'none', 1)], 're-applied, the edit works');
});

// ---------------------------------------------------------------------------
// M7RV-13: a session that expires during the role row's wait
// ---------------------------------------------------------------------------

test('M7RV-13: a session that expires while its edit waits on the role row answers 020\'s no-row refusal, not a version conflict — the clock is read again before the version is judged', async () => {
  await resetState();
  const first = await mint(OWNER_A);
  // A second owner (no shared account lock), minted to live 3 s: long enough to pass every check before the role row.
  const shortKey = await mint(OWNER_A2, 3_000);
  const [{ expires_at: expiresAt }] = await owner`select expires_at from tmpos_session.session where session_key = ${shortKey}`;
  let pending;
  let wait;
  await runtime.begin(async (tx) => {
    const holder = await pidOf(tx);
    assert.deepEqual(await setV2(first, 'sales_staff', 'none', T_A, 0, tx), [await applied(OWNER_A, 'none', 1)], 'the first owner');
    pending = setV2(shortKey, 'sales_staff', 'full', T_A, 0);
    pending.catch(() => {});
    wait = await waitingOn('an edit whose session expires while it waits', holder);
    // Held until the database clock has passed the waiting session's expiry; then the first edit commits (version 1).
    const until = Date.now() + 10_000;
    while (!(await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint >= ${expiresAt}::bigint as past`)[0].past) {
      assert.ok(Date.now() < until, 'the waiting session expired');
      await sleep(50);
    }
  });
  assert.ok(onRoleRow(wait), JSON.stringify(wait));
  assert.deepEqual(await pending, [], 'expired during the wait: no row (020\'s refusal), although its version 0 has also moved');
  assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'none', version: 1 }, 'the first edit alone stands');
});

// ---------------------------------------------------------------------------
// M7RV-14..15: every update of a level row advances its version (the trigger)
// ---------------------------------------------------------------------------

test('M7RV-14: a 020 edit parked across 021\'s apply — its EXECUTE checked while 021 is uncommitted, then waiting on 021\'s table lock — completes after 021 commits AND advances the version, so a version-0 draft is refused', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  // 020 the newest migration, as the pre-021 runtime saw it: 023 and 021 rolled back (no version row exists; 023 first, the
  // supported order) and 020's grant of its edit to tmpos_app, which 021 revoked and its rollback does not give back, restored.
  await down023();
  await owner.begin(async (tx) => {
    await tx.unsafe(DOWN_021).simple();
    await tx.unsafe(`grant execute on function ${SET_020} to tmpos_app`);
  });
  try {
    let parked;
    let wait;
    await owner.begin(async (tx) => {
      const applier = await pidOf(tx);
      await tx.unsafe(UP_021).simple();
      // Uncommitted: the revoke is not yet visible, so the call passes EXECUTE and then waits for 021's lock on the table.
      parked = (async () => (await runtime`select * from tmpos_role.m7a_role_level_set(${ownerKey}::text, 'sales_staff'::text,
        'customers'::text, 'none'::text)`).map((r) => ({ ...r })))();
      parked.catch(() => {});
      wait = await waitingOn('a 020 edit parked behind 021\'s uncommitted apply', applier);
    });
    assert.deepEqual(wait, [{ locktype: 'relation', relation: 'tmpos_role.tenant_role_level' }], 'it waited on 021\'s table lock');
    assert.deepEqual((await parked).map((r) => r.o_level), ['none'], 'the parked 020 edit completed after 021 committed');
    assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: 'none', version: 1 }, 'and its update advanced the version');
    assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'full', T_A, 0), [CONFLICT], 'a draft at version 0 is refused: it cannot overwrite that edit');
    assert.equal(await codeOf(runtime`select * from tmpos_role.m7a_role_level_set(${ownerKey}::text, 'sales_staff'::text, 'customers'::text, 'full'::text)`),
      '42501', 'the next 020 call is refused');
    assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'full', T_A, 1), [await applied(OWNER_A, 'full', 2)], 'the draft at version 1 applies');
  } finally {
    if ((await owner`select pg_catalog.to_regnamespace('tmpos_role_edit') is null as absent`)[0].absent) {
      await owner.begin((tx) => tx.unsafe(UP_021).simple());
    }
    await up023IfAbsent();
  }
  assert.equal((await rolledBack('isolation level read committed', (tx) => postcondition021(tx))).code, undefined,
    're-applied over a parked call, 021\'s postcondition holds');
});

test('M7RV-15: every other update of a level row advances its version by exactly one per row — 020\'s edit run by the table owner, a raw owner UPDATE of one row, of nothing but updated_at, of several rows at once, and one as a replica', async (t) => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  const set020 = async (role, level) => (await owner`select * from tmpos_role.m7a_role_level_set(${ownerKey}::text, ${role}::text,
    'customers'::text, ${level}::text)`).map((r) => r.o_level);
  const sales = async () => stateOf(T_A, 'sales_staff');
  assert.deepEqual(await set020('sales_staff', 'view'), ['view'], '020\'s edit, as the owner');
  assert.deepEqual(await sales(), { roleId: 'sales_staff', level: 'view', version: 1 });
  await owner`update tmpos_role.tenant_role_level set level = 'full' where tenant_id = ${T_A} and role_id = 'sales_staff'`;
  assert.deepEqual(await sales(), { roleId: 'sales_staff', level: 'full', version: 2 }, 'a raw owner UPDATE of the level');
  await owner`update tmpos_role.tenant_role_level set updated_at = updated_at where tenant_id = ${T_A} and role_id = 'sales_staff'`;
  assert.deepEqual(await sales(), { roleId: 'sales_staff', level: 'full', version: 3 }, 'an UPDATE of nothing but updated_at is still an update');
  assert.deepEqual(await set020('manager', 'view'), ['view']);
  await owner`update tmpos_role.tenant_role_level set level = 'none' where tenant_id = ${T_A}`;
  assert.deepEqual(await versionRows(T_A), [{ role_id: 'manager', version: 2 }, { role_id: 'sales_staff', version: 4 }], 'one statement, two rows: each advanced once');
  let version = 4;
  const [{ superuser }] = await owner`select r.rolsuper as superuser from pg_catalog.pg_roles r where r.rolname = current_user`;
  if (superuser) {
    await owner.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update tmpos_role.tenant_role_level set level = 'view' where tenant_id = ${T_A} and role_id = 'sales_staff'`;
    });
    version += 1;
    assert.deepEqual(await sales(), { roleId: 'sales_staff', level: 'view', version }, 'enabled ALWAYS: a replica session advances it too');
  } else {
    t.diagnostic('the owner is not a superuser here: session_replication_role cannot be set, the replica case is not exercised');
  }
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'create', T_A, version - 1), [CONFLICT], 'a draft from before the last update is refused');
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'create', T_A, version), [await applied(OWNER_A, 'create', version + 1)],
    'the edit over them: exactly one more, not two');
  assert.deepEqual(await versionRows(T_A), [{ role_id: 'manager', version: 2 }, { role_id: 'sales_staff', version: version + 1 }]);
});

test('M7RV-16: an update that moves a level row to another key advances the version of BOTH keys by exactly one, so a draft at either key\'s version from before the move is refused', async () => {
  await resetState();
  const ownerKey = await mint(OWNER_A);
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'view', T_A, 0), [await applied(OWNER_A, 'view', 1)]);
  assert.deepEqual(await setV2(ownerKey, 'sales_staff', 'none', T_A, 1), [await applied(OWNER_A, 'none', 2)]);
  const pre = { sales_staff: (await stateOf(T_A, 'sales_staff')).version, technician: (await stateOf(T_A, 'technician')).version };
  assert.deepEqual(pre, { sales_staff: 2, technician: 0 }, 'before the move: sales_staff edited twice, technician never (no row)');
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'sales_staff', level: 'none' }]);
  // The table's owner moves the row to an editable key that has no row in this tenant.
  await owner`update tmpos_role.tenant_role_level set role_id = 'technician' where tenant_id = ${T_A} and role_id = 'sales_staff'`;
  assert.deepEqual(await storedRows(T_A), [{ role_id: 'technician', level: 'none' }], 'the row moved');
  assert.deepEqual(await versionRows(T_A), [{ role_id: 'sales_staff', version: 3 }, { role_id: 'technician', version: 1 }],
    'the old key and the new key each advanced by exactly one');
  assert.deepEqual(await stateOf(T_A, 'sales_staff'), { roleId: 'sales_staff', level: null, version: 3 });
  assert.deepEqual(await stateOf(T_A, 'technician'), { roleId: 'technician', level: 'none', version: 1 });
  for (const role of ['sales_staff', 'technician']) {
    assert.deepEqual(await setV2(ownerKey, role, 'full', T_A, pre[role]), [CONFLICT], `${role}'s draft from before the move is refused`);
  }
  assert.deepEqual(await versionRows(T_A), [{ role_id: 'sales_staff', version: 3 }, { role_id: 'technician', version: 1 }], 'the refusals wrote nothing');
  await resetState();
});
