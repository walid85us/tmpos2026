// Phase 4.0 M7A-CUSTOMERS-P7 — editing a saved customer against REAL PostgreSQL: migration 024 (row_version on 017's
// table with its CHECK, public.audit_event.subject_customer_id with its partial index, and schema tmpos_customer_edit:
// m7a_customer_update, VOLATILE, and m7a_customer_profile, STABLE, both SECURITY DEFINER; tmpos_app's EXECUTE on 023's
// profile read revoked), exercised as the runtime's own non-owner login (tmpos_app + tmpos_audit_writer). The HTTP route
// over it (PATCH /api/v1/customers/{id}), the command transaction, the audit record and the idempotency completion are the
// runtime's unit suites' and the tenant entry's; this file proves the database half.
//
// WHAT IS PROVEN. 001-023 applied first and customers seeded on them — with and without contacts, a legacy NULL creation
// time and a database-written one; then 024 applied by the SAME trusted executor over those rows, its checksum the sha256 of
// its up bytes; its postcondition re-proven over the applied state and refusing the widenings it names; a second apply
// refused (M7CE-01). The upgrade over populated rows: every row_version 1, every id, tenant, name, phone, email and creation
// time byte-identical and NO row rewritten (xmin unchanged); the column, CHECK, audit column, index and grants exactly as
// declared; a create through 023 starts at 1 (M7CE-02). The login executes the two routines and uses their schema,
// executes 023's profile read no longer (42501), holds no privilege on the table or any column, and no other runtime role
// executes either routine; the real startup preflight accepts the login and the ledger (M7CE-03). Patch semantics at the
// routine: a name change, a phone and an email set and cleared, a contact not being set kept, created_at never written (a
// legacy NULL stays NULL), the version moved exactly once per applied edit (M7CE-04). Every refused argument raises 22023
// with a fixed message naming the field, never the value, before any read or lock (a held customer row is not waited on),
// and changes nothing; the table CHECK refuses row_version 0 (M7CE-05). Authority: View-only and Create-only roles get no
// row; Edit, Manage and Full apply; an owner-edited level raised to Edit applies and one lowered below Edit refuses; a
// read-only or suspended account or tenant, a revoked or expired session, a wrong expected tenant and an unknown key get
// no row; another tenant's id is the same 'not_found' as a missing one (M7CE-06). Versions: stale 'conflict' and a stale
// no-op 'conflict' write nothing; a current no-op is 'unchanged' with the same version and the row not written; an applied
// edit answers expected + 1; A->B->A leaves version 3 (M7CE-07). Concurrency, ordered by lock waits only: two edits of one
// version by two actors — one 'applied', the other blocked on the row and then 'conflict'; a session revocation and an
// owner's level narrowing that win the authority locks prevent the edit (no row), and ones that arrive while the edit holds
// its locks wait until it commits; a session that expires while the edit waits on the row gets no row, never 'conflict'
// (M7CE-08). The profile read: 023's row plus the version, for every outcome; a View-only role reads it; values and version
// always from one snapshot under concurrent committed edits (M7CE-09). Rollback: committed, 024's down REFUSES while a
// customer is edited or an audit record names a customer, and changes nothing; each condition alone refuses; outside READ
// COMMITTED it refuses; cleared in a rolled-back transaction it leaves exactly the 001-023 surface (023's profile read
// granted back) and a byte-identical re-apply is accepted; 023's down refuses while 024 is applied; with 023's profile read
// missing, 024's down refuses; and a COMMITTED rollback over un-edited customers keeps every contact and creation time and
// a re-apply starts every version at 1 (M7CE-11). The production profile adapter over the real login answers the version as
// a number with the values, refusals with none, and its probe fails closed once EXECUTE is withdrawn (M7CE-10).
//
// WHAT IS NOT HERE, STATED. The command mutator over the edit routine is the server suites' (scripted drivers) and the HTTP
// suites'; this file calls the routine as the runtime login does, with the same arguments the mutator binds. Audit records are written by the runtime's store, not by the routines: this file commits
// none — the rollback guard's audit case runs inside a rolled-back transaction.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster
// this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. On a shared service
// it first rolls 024 back with its own committed down file (which refuses, failing this suite loudly, if any customer is
// edited or any audit record names a customer), so its customers are seeded on 001-023 exactly as a deployed database holds
// them, then applies 024 through the trusted executor. Every fixture is synthetic and randomly suffixed; every widening and
// every rollback but one runs in a transaction that is rolled back. (M7A-CUSTOMERS-P8: 025, the name search, sits above 024
// and holds no data; this file rolls it back with 024 and re-applies it after, newest first and oldest first.) It leaves 024
// and 025 applied, the issuer key row it found, no
// customer, session, ledger, role-level or version row of its own, and its login dropped; its tenants and identities stay,
// as every suite's do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import { REQUIRED_MIGRATIONS, createPostgresStartupPreflight } from '../../server/persistence/postgresStartupPreflight.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';
import { createPostgresCustomerProfile, probeCustomerProfile } from '../../server/persistence/postgresCustomerDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_024 = readFileSync(`${MIG_DIR}/024_m7a_customer_edit.up.sql`, 'utf8');
const DOWN_024 = readFileSync(`${MIG_DIR}/024_m7a_customer_edit.down.sql`, 'utf8');
const UP_025 = readFileSync(`${MIG_DIR}/025_m7a_customer_search.up.sql`, 'utf8');
const DOWN_025 = readFileSync(`${MIG_DIR}/025_m7a_customer_search.down.sql`, 'utf8');
/** M5-INVOICES-AUTH-P1: 026 sits above 025 and is rolled back first wherever a proof needs exactly the 001-023 surface. */
const UP_026 = readFileSync(`${MIG_DIR}/026_m5_invoice_role_levels.up.sql`, 'utf8');
const DOWN_026 = readFileSync(`${MIG_DIR}/026_m5_invoice_role_levels.down.sql`, 'utf8');
/** M7B-INVOICES-P1: 027 (store discovery) sits above 026 and is rolled back first, re-applied last. */
const UP_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.up.sql`, 'utf8');
const DOWN_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.down.sql`, 'utf8');
/** M7B-INVOICES-P1: 028 (invoice drafts) sits above 027 and is rolled back first, re-applied last. */
const UP_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.up.sql`, 'utf8');
const DOWN_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.down.sql`, 'utf8');
/** M7B-INVOICES-P2: 029 (the draft edit) lives in 028's schema and rolls back before it. */
const DOWN_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.down.sql`, 'utf8');
/** M7B-INVOICES-P2-R1: 030 (the Invoices level guard and the guarded edit, in its own schema) sits above 029 and rolls back first. */
const DOWN_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.down.sql`, 'utf8');
const UP_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.up.sql`, 'utf8');
/** M7B-INVOICES-P2-R1: 030 (the Invoices level guard and the guarded edit) sits above 029 and is applied with it. */
const UP_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.up.sql`, 'utf8');
const DOWN_023 = readFileSync(`${MIG_DIR}/023_m7a_customer_contact.down.sql`, 'utf8');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_024 = UP_024.slice(UP_024.lastIndexOf('do $$'));
const UPDATE = 'tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)';
const PROFILE = 'tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)';
const PROFILE_023 = 'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)';
const CREATE_023 = 'tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7ce-migrator', runtimeRef: 'm7ce-runtime' };
const LOCK_KEY = 528_531;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7ce_probe';
const HOUR = 3_600_000;
const WAIT_MS = 10_000;
const MAX_VERSION = 9007199254740991;
const ROLLBACK = new Error('m7ce: roll the proof back');
const RC = 'isolation level read committed';
const NULLS = Object.freeze({ o_tenant_id: null, o_actor_id: null, o_membership_id: null, o_version: null });
const PROFILE_NULLS = Object.freeze({ o_tenant_id: null, o_customer_id: null, o_name: null, o_phone: null, o_email: null, o_created_at: null });
const signal = () => AbortSignal.timeout(10_000);
const ch = (...codes) => String.fromCodePoint(...codes);
const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
/** "Not being set": the contact's flag false and its value NULL, as the mutator binds an omitted field. */
const KEEP = Symbol('keep');

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (as customerContact does)
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

const TARGET = resolveDisposableTarget('M7CE');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

const connect = (user, max) =>
  testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, installs the key, writes the fixtures and the levers. RLS does not restrict it. */
const owner = connect(undefined, 4);
/** The observer: reads pg_stat_activity while the levers hold their locks. */
const probe = connect(undefined, 1);
let runtime = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let keyBeforeSuite;

/** Applies every migration not yet in the ledger through the trusted executor. */
async function trustedApply() {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    return await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

// Race helpers a teardown may have to settle (customerCreate's lever kit).
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => delay(5);
/** A call a failing test may abandon: its rejection is observed here, and still reaches whoever awaits it. */
const quietly = (p) => { p.catch(() => {}); return p; };
async function within(promise, label) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: label }), WAIT_MS); });
  try { return await Promise.race([promise, bound]); } finally { clearTimeout(timer); }
}
const ROLLBACK_HOLD = Symbol('rollback');
/** Holds and owner writes a failing test may leave open; teardown settles every one before it cleans up. */
const OPEN = new Set();

test.after(async () => {
  const swallow = async (fn) => { try { await fn(); } catch { /* an earlier failure left less to clean */ } };
  for (const open of [...OPEN]) await swallow(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
  if (TENANTS.length > 0) await swallow(() => owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`);
  if (TENANTS.length > 0) await swallow(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
  if (TENANTS.length > 0) await swallow(() => owner`update tenant set status = 'active' where tenant_id = any(${TENANTS}::uuid[]) and status <> 'active'`);
  if (KEYS.size > 0) await swallow(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
  if (UIDS.length > 0) await swallow(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
  // Test hygiene: every customer this file made, edited or not. A later suite's rollback of 024 refuses while any customer
  // is edited, and of 023 while any holds a contact or a creation time, so none of ours may stay behind.
  if (TENANTS.length > 0) await swallow(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
  // The shared service is left with 024 applied, whatever failed above: the executor applies it if it is not.
  await swallow(async () => {
    const [{ applied }] = await owner`select exists (select 1 from public.schema_migrations where version = '030') as applied`;
    if (!applied) await trustedApply();
  });
  if (keyBeforeSuite !== undefined) {
    await swallow(async () => {
      await owner`delete from tmpos_mint.issuer_key`;
      if (keyBeforeSuite !== null) await owner`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${keyBeforeSuite})`;
    });
  }
  if (runtime) await runtime.end({ timeout: 5 });
  await swallow(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
  await swallow(() => owner.unsafe(`drop owned by ${RUNTIME_LOGIN}`));
  await swallow(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
  await probe.end({ timeout: 5 });
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: 001-023 (024 rolled back on a shared service), a real non-owner runtime login, the key, customers, then 024
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

// On a shared service an earlier step applied 024: its own committed down file removes it (and refuses, loudly, while any
// customer of any suite is edited or any audit record names a customer). On a fresh cluster there is nothing to roll back.
const rolledBackAtSetup = (await rollBackAbove(owner, MIG_DIR, '023')).rolledBack;
// The chain THROUGH 023: 024 and every later file (025 since M7A-CUSTOMERS-P8) hidden from the executor's file port.
const ROLL_BACK_PORT = (port) => portThrough(port, '023');
const applyThrough023 = await (async () => {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    return await runTrustedApply({
      fsPort: ROLL_BACK_PORT(createNodeFsPort(MIG_DIR, MIG_REL)), adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
})();

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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7ce-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
/** A synthetic actor: an identity, an account of `status`, and the given tenant grants. */
async function actor(label, grants, status = 'active') {
  const uid = `m7ce-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const g of grants) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${g.tenant}, null, 'tenant', ${g.role}, 'active')`;
  }
  UIDS.push(uid);
  const [m] = grants.length === 0 ? [] : await owner`select membership_id from user_membership where internal_user_id = ${id} and tenant_id = ${grants[0].tenant}`;
  return { id, uid, membership: m?.membership_id ?? null, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:m7ce', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
});
/** A tenant session for `who`, minted as the runtime login under K, live for `lifetime` ms. Answers the key. */
async function mint(who, lifetime = HOUR) {
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

/** 023's create as the runtime login: a customer with a database-written creation time and the contacts given. */
const create023 = async (key, id, name, phone = null, email = null) =>
  (await runtime`select o_tenant_id from tmpos_customer_contact.m7a_contact_create(${key}::text, ${id}::uuid, ${name}::text, ${phone}::text, ${email}::text)`).length;
/**
 * 024's edit as the runtime login (or on `db`), bound as the mutator binds it: a contact that is KEEP is not being set
 * (flag false, value NULL); any other value, NULL included, is set. Its rows, plain, the version as decimal text.
 */
const edit = async (key, id, tenant, version, name, phone = KEEP, email = KEEP, db = runtime) =>
  editRaw([key, id, tenant, version === null ? null : String(version), name,
    phone !== KEEP, phone === KEEP ? null : phone, email !== KEEP, email === KEEP ? null : email], db);
const editRaw = async (args, db = runtime) =>
  (await db`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_version::text as o_version
    from tmpos_customer_edit.m7a_customer_update(${args[0]}::text, ${args[1]}::uuid, ${args[2]}::uuid, ${args[3]}::bigint,
      ${args[4]}::text, ${args[5]}::boolean, ${args[6]}::text, ${args[7]}::boolean, ${args[8]}::text)`).map((r) => ({ ...r }));
/** 024's profile read as the runtime login (or on `db`): its rows, plain, the version as decimal text. */
const profile = async (key, id, expected, db = runtime) =>
  (await db`select o_outcome, o_tenant_id, o_customer_id, o_name, o_phone, o_email, o_created_at, o_version::text as o_version
    from tmpos_customer_edit.m7a_customer_profile(${key}::text, ${id}::uuid, ${expected}::uuid)`).map((r) => ({ ...r }));
/** 023's profile read for the same inputs — as the OWNER, the only role that may still call it. */
const profile023 = async (key, id, expected) =>
  (await owner`select o_outcome, o_tenant_id, o_customer_id, o_name, o_phone, o_email, o_created_at
    from tmpos_customer_contact.m7a_contact_profile(${key}::text, ${id}::uuid, ${expected}::uuid)`).map((r) => ({ ...r }));
/** One customer row as stored: every column, the creation time as epoch microseconds text (exact), the version and xmin as text. */
const stored = async (id) => {
  const [row] = await owner`select customer_id, tenant_id, name, phone, email,
      (extract(epoch from created_at) * 1000000)::bigint::text as created_us,
      row_version::text as row_version, xmin::text as xmin
    from tmpos_customer.customer where customer_id = ${id}`;
  return row === undefined ? undefined : { ...row };
};
/** The applied answer for `who` at `version`. */
const applied = (who, tenant, version) => [{ o_outcome: 'applied', o_tenant_id: tenant, o_actor_id: who.id, o_membership_id: who.membership, o_version: String(version) }];

const errorOf = (p) => p.then(() => null, (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? null, hint: err.hint ?? null }));

/** Runs `fn` in an owner transaction that is always rolled back. Answers { value } or the { code, message } it raised. */
async function rolledBack(isolation, fn) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}
/** `fn` as the runtime login, in a savepoint of `tx` that is always rolled back. Answers { value } or { code, message }. */
async function asRuntime(tx, fn) {
  let out;
  await tx.savepoint(async (sp) => {
    await sp.unsafe(`set local session authorization ${RUNTIME_LOGIN}`);
    out = await fn(sp).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }).catch((err) => { if (err !== ROLLBACK) throw err; });
  return out;
}
/** The real startup preflight's login and ledger answers, as the runtime login, on `tx`'s state. */
const preflightOn = async (tx) => (await asRuntime(tx, async (sp) => {
  const preflight = createPostgresStartupPreflight({ client: { transaction: (_s, _b, fn) => fn(sp), end: async () => {} } });
  return { runtimeLogin: await preflight.runtimeLogin(signal()), migrationLedger: await preflight.migrationLedger(signal()) };
})).value;
/** Both routines' definitions, configuration and ACLs, as one comparable value. */
const routineState = async (db) => (await db`select p.oid::regprocedure::text as routine, pg_catalog.md5(p.prosrc) as src,
    p.proconfig::text as config, p.proacl::text as acl, p.provolatile as volatility, p.prosecdef as definer
  from pg_catalog.pg_proc p where p.pronamespace = pg_catalog.to_regnamespace('tmpos_customer_edit') order by 1`).map((r) => ({ ...r }));
/**
 * The database surface 024 touches, as one comparable value: every tmpos_* schema and its ACL; every routine there, its
 * source digest and ACL; 017's table's columns, constraints, indexes and ACL; the audit table's columns and indexes.
 * Captured on 001-023 before 024 is applied, read under one fixed search path.
 */
const surface = (db) => ('savepoint' in db ? db.savepoint.bind(db) : db.begin.bind(db))(async (sp) => {
  await sp.unsafe('set local search_path = pg_catalog, pg_temp');
  return surfaceOn(sp);
});
const columnsOf = async (db, table) => (await db`select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
    a.attnotnull as not_null, a.atthasdef as has_default, a.attacl::text as acl from pg_catalog.pg_attribute a
  where a.attrelid = ${table}::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`).map((r) => ({ ...r }));
const indexesOf = async (db, table) => (await db`select pg_catalog.pg_get_indexdef(x.indexrelid) as def from pg_catalog.pg_index x
  where x.indrelid = ${table}::regclass order by 1`).map((r) => r.def);
const surfaceOn = async (db) => ({
  schemas: (await db`select n.nspname::text as name, n.nspacl::text as acl from pg_catalog.pg_namespace n
    where n.nspname like 'tmpos\\_%' order by 1`).map((r) => ({ ...r })),
  routines: (await db`select p.oid::regprocedure::text as routine, pg_catalog.md5(p.prosrc) as src, p.proacl::text as acl
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname like 'tmpos\\_%' order by 1`).map((r) => ({ ...r })),
  columns: await columnsOf(db, 'tmpos_customer.customer'),
  constraints: (await db`select c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def from pg_catalog.pg_constraint c
    where c.conrelid = 'tmpos_customer.customer'::regclass order by 1`).map((r) => ({ ...r })),
  indexes: await indexesOf(db, 'tmpos_customer.customer'),
  tableAcl: (await db`select c.relacl::text as acl from pg_catalog.pg_class c where c.oid = 'tmpos_customer.customer'::regclass`)[0].acl,
  auditColumns: await columnsOf(db, 'public.audit_event'),
  auditIndexes: await indexesOf(db, 'public.audit_event'),
  auditAcl: (await db`select c.relacl::text as acl from pg_catalog.pg_class c where c.oid = 'public.audit_event'::regclass`)[0].acl,
});
/** Every audit subject cleared — the append-only trigger lifted and restored — inside the caller's own (rolled-back) transaction (tenantDisplayName's technique). */
async function clearCustomerSubjects(tx) {
  await tx.unsafe('alter table public.audit_event disable trigger trg_audit_event_reject_mutation');
  await tx.unsafe('update public.audit_event set subject_customer_id = null where subject_customer_id is not null');
  await tx.unsafe('alter table public.audit_event enable trigger trg_audit_event_reject_mutation');
}

// ---------------------------------------------------------------------------
// the lever kit (customerCreate's, over owner transactions and runtime calls)
// ---------------------------------------------------------------------------

/** Hold locks in an OPEN transaction on `db` (the owner by default) until released. */
async function hold(label, setup, db = owner) {
  const ready = deferred();
  const release = deferred();
  let value;
  const done = db.begin(RC, async (sql) => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    value = await setup(sql);
    ready.resolve({ pid });
    if ((await release.promise) === 'rollback') throw ROLLBACK_HOLD;
  }).then(() => 'committed', (e) => (e === ROLLBACK_HOLD ? 'rolled back' : `failed:${e?.message ?? e}`));
  const first = await Promise.race([ready.promise, done.then((v) => ({ early: v }))]);
  if ('early' in first) throw new Error(`${label}: the hold ended before it was taken (${first.early})`);
  let ending = null;
  const h = {
    ...first, label, done, value,
    end(how) {
      if (ending === null) { release.resolve(how); ending = done; OPEN.delete(h); }
      return ending;
    },
    commit: () => h.end('commit'),
    settle: () => h.end('rollback'),
  };
  OPEN.add(h);
  return h;
}
const holdCustomer = (id) => hold('customer for update', (sql) => sql`select 1 from tmpos_customer.customer where customer_id = ${id} for update`);

/** An owner write: its backend pid once started, and 'committed' | 'failed:...' once settled. */
function ownerWrite(label, fn) {
  const started = deferred();
  const done = owner.begin(RC, async (sql) => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    started.resolve({ pid });
    await fn(sql);
  }).then(() => 'committed', (e) => `failed:${e?.message ?? e}`);
  const write = { label, done, started: Promise.race([started.promise, done.then((v) => ({ early: v }))]) };
  OPEN.add(write);
  done.then(() => OPEN.delete(write));
  return write;
}
/** Wait until an owner write settles or waits on a Lock: { settled } | { blocked, blockers } | null (bound). */
async function ownerOutcome(write) {
  const s = await write.started;
  if ('early' in s) return { settled: s.early };
  let settled = null;
  write.done.then((v) => { settled = v; });
  for (const until = Date.now() + WAIT_MS; Date.now() < until; await tick()) {
    if (settled !== null) return { settled };
    const [row] = await probe`select wait_event_type, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = ${s.pid}`;
    if (settled !== null) return { settled };
    if (row?.wait_event_type === 'Lock') return { blocked: true, blockers: row.blockers };
  }
  return null;
}
/** Runtime-login backends waiting on a Lock now, filtered by blocker pid and statement text. */
async function blockedNow({ by = null, query = null } = {}) {
  const rows = await probe`select pid, query, pg_blocking_pids(pid) as blockers from pg_stat_activity
    where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
  return rows.filter((r) => (query === null || query.test(r.query)) && (by === null || r.blockers.includes(by)))
    .map((r) => ({ pid: r.pid, blockers: r.blockers }));
}
/** Wait until `request` settles or a runtime backend matching `criteria` waits on a Lock: { settled } | { blocked } | null. */
async function blockedOrSettled(request, criteria) {
  let settled = null;
  request.then((value) => { settled = { value }; }, (error) => { settled = { error: String(error) }; });
  for (const until = Date.now() + WAIT_MS; Date.now() < until; await tick()) {
    if (settled !== null) return { settled };
    const hit = await blockedNow(criteria);
    if (hit.length > 0) return { blocked: hit };
  }
  return settled !== null ? { settled } : null;
}
/** A call that must be waiting: its backend's pid — or a failure naming what happened instead. */
function waitingPid(outcome, what) {
  assert.ok(outcome !== null, `lever did not engage: ${what} not observed within ${WAIT_MS} ms`);
  assert.ok(outcome.blocked, `${what}: the call completed instead of waiting (${JSON.stringify(outcome.settled)})`);
  return outcome.blocked[0].pid;
}
/** What a waiting backend waits on: the lock types of its ungranted locks. */
const waitingOn = async (pid) => (await probe`select locktype from pg_catalog.pg_locks where pid = ${pid} and not granted`).map((r) => r.locktype);
const AT_EDIT = /tmpos_customer_edit\.m7a_customer_update/;

// ---------------------------------------------------------------------------
// the populated 001-023 state, then 024
// ---------------------------------------------------------------------------

const T_A = await newTenant('a');
const T_B = await newTenant('b');
const OWNER_A = await actor('owner-a', [{ tenant: T_A, role: 'store_owner' }]);
const OWNER_B = await actor('owner-b', [{ tenant: T_B, role: 'store_owner' }]);
const KEY_A_023 = await mint(OWNER_A);
const KEY_B_023 = await mint(OWNER_B);

// Customers as a deployed 023 database holds them: legacy rows with NO creation time (inserted before 023 applied — here
// stated explicitly), and rows created through 023 with a database-written creation time, with and without contacts.
const LEGACY = [];
for (const [tenant, name] of [[T_A, `Legacy Zed ${SUFFIX}`], [T_A, `Legacy Ada ${SUFFIX}`], [T_B, `Legacy Bo ${SUFFIX}`]]) {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, created_at) values (${id}, ${tenant}, ${name}, null)`;
  LEGACY.push(id);
}
const CREATED = [];
for (const [key, name, phone, email] of [
  [KEY_A_023, `Ada Lovelace ${SUFFIX}`, '+1 555 0100', 'ada@example.test'],
  [KEY_A_023, `Name Only ${SUFFIX}`, null, null],
  [KEY_A_023, `Phone Only ${SUFFIX}`, '+1 555 0101', null],
  [KEY_B_023, `Bea ${SUFFIX}`, null, 'bea@example.test'],
]) {
  const id = randomUUID();
  assert.equal(await create023(key, id, name, phone, email), 1, `seeded through 023: ${name}`);
  CREATED.push(id);
}
const ALL_SEEDED = [...LEGACY, ...CREATED];
const rowsAt023 = async () => (await owner`select customer_id, tenant_id, name, phone, email,
    (extract(epoch from created_at) * 1000000)::bigint::text as created_us, xmin::text as xmin
  from tmpos_customer.customer where customer_id = any(${ALL_SEEDED}::uuid[]) order by customer_id`).map((r) => ({ ...r }));
const ROWS_023 = await rowsAt023();
const SURFACE_023 = await surface(owner);
const PROFILE_023_ACL = (await owner`select proacl::text as acl from pg_catalog.pg_proc where oid = ${PROFILE_023}::regprocedure`)[0].acl;

// Now 024, by the same trusted executor, over those rows.
const applyReport = await trustedApply();

// ===========================================================================
// M7CE-01..03: the migration, the upgrade over populated rows, and the login's privileges
// ===========================================================================

test('M7CE-01: 024 applied by the trusted executor over a populated 001-023, its checksum its up bytes; its postcondition holds and refuses the widenings it names; a second apply is refused', async () => {
  assert.equal(applyThrough023.outcome, 'complete', JSON.stringify(applyThrough023).slice(0, 400));
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  assert.deepEqual(applyReport.applied, ['024', '025', '026', '027', '028', '029', '030'], `024 (and 025, 026, 027, 028, 029 and 030 above it, M7A-CUSTOMERS-P8, M5-INVOICES-AUTH-P1, M7B-INVOICES-P1, -P2, -P2-R1) applied over the populated 001-023 chain (rolled back at setup: ${JSON.stringify(rolledBackAtSetup)})`);
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 30 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.equal(ledger[23].checksum, createHash('sha256').update(readFileSync(`${MIG_DIR}/024_m7a_customer_edit.up.sql`)).digest('hex'));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'the ledger records the pinned chain');
  // M7B-INVOICES-P1: 028 adds its composite-key UNIQUE (customer_tenant_customer_key) to the customer table, which 024's exact
  // constraint and index lists do not know; 024's postcondition is therefore judged on 024's own surface — 028's committed
  // down run first, in the same rolled-back transaction (no draft exists here).
  assert.equal((await rolledBack(RC, async (tx) => { await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(DOWN_028).simple(); await tx.unsafe(POSTCONDITION_024).simple(); })).code, undefined,
    'the postcondition holds as applied (028 rolled back above it)');
  const on028 = await rolledBack(RC, (tx) => tx.unsafe(POSTCONDITION_024).simple());
  assert.equal(on028.code, '55000', `028 applied: 024's exact list sees 028's UNIQUE (${JSON.stringify(on028)})`);
  assert.match(on028.message, /customer_tenant_customer_key/);
  for (const [label, widen, pattern] of [
    ['a table grant', 'grant select on tmpos_customer.customer to tmpos_app', /holds a privilege on tmpos_customer\.customer/],
    ['a column grant on the version', 'grant update (row_version) on tmpos_customer.customer to tmpos_app', /holds a privilege on tmpos_customer\.customer|column grant/],
    ['023\'s profile read given back', `grant execute on function ${PROFILE_023} to tmpos_app`, /can execute 023's profile read/],
    ['EXECUTE to the audit writer', `grant execute on function ${UPDATE} to tmpos_audit_writer`, /unexpected direct grant/],
    ['EXECUTE to PUBLIC', `grant execute on function ${PROFILE} to public`, /unexpected direct grant/],
    ['a grantable EXECUTE', `grant execute on function ${UPDATE} to tmpos_app with grant option`, /unexpected direct grant/],
    ['USAGE to the audit writer', 'grant usage on schema tmpos_customer_edit to tmpos_audit_writer', /carries an unexpected grant/],
    ['a third routine', 'create function tmpos_customer_edit.extra() returns integer language sql as $$ select 1 $$', /exactly the two routines/],
    ['a table beside them', 'create table tmpos_customer_edit.extra (x integer)', /exactly the two routines/],
    ['an index on the version', 'create index m7ce_version_idx on tmpos_customer.customer (row_version)', /exactly 017's two indexes/],
    ['the version CHECK dropped', 'alter table tmpos_customer.customer drop constraint customer_row_version_chk', /constraints/],
    ['another default for the version', 'alter table tmpos_customer.customer alter column row_version set default 2', /exactly 017's and 023's columns/],
    ['a nullable version', 'alter table tmpos_customer.customer alter column row_version drop not null', /exactly 017's and 023's columns/],
    ['the edit made STABLE', `alter function ${UPDATE} stable`, /SECURITY DEFINER routines/],
    ['the read made VOLATILE', `alter function ${PROFILE} volatile`, /SECURITY DEFINER routines/],
    ['the audit subject column granted', 'grant insert (subject_customer_id) on public.audit_event to tmpos_audit_writer', /subject_customer_id/],
    ['the audit subject index dropped', 'drop index public.idx_audit_event_subject_customer_occurred', /subject_customer_id/],
    ['a default on the audit subject', `alter table public.audit_event alter column subject_customer_id set default '${randomUUID()}'`, /subject_customer_id/],
  ]) {
    const out = await rolledBack(RC, async (tx) => {
      await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple();
      await tx.unsafe(DOWN_028).simple();
      await tx.unsafe(widen);
      await tx.unsafe(POSTCONDITION_024).simple();
    });
    assert.equal(out.code, '55000', `${label}: ${JSON.stringify(out)}`);
    assert.match(out.message, pattern, label);
  }
  // A row at a version the apply could not have left: refused. (That no row was rewritten is M7CE-02's tuple proof.)
  for (const [label, write] of [['a version of 2', 'row_version = 2']]) {
    const out = await rolledBack(RC, async (tx) => {
      await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple();
      await tx.unsafe(DOWN_028).simple();
      await tx.unsafe(`update tmpos_customer.customer set ${write} where customer_id = '${LEGACY[0]}'`);
      await tx.unsafe(POSTCONDITION_024).simple();
    });
    assert.equal(out.code, '55000', `${label}: ${JSON.stringify(out)}`);
    assert.match(out.message, /a customer has a row_version other than 1$/, label);
  }
  const again = await rolledBack(RC, (tx) => tx.unsafe(UP_024).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /migration 024 refused: schema tmpos_customer_edit already exists/);
});

test('M7CE-02: the upgrade over populated rows sets every row_version to 1 and rewrites no row — ids, tenants, names, contacts and creation times (NULL and database-written) byte-identical; the column, CHECK, audit subject and index exactly as declared; a create through 023 starts at 1', async () => {
  const after = (await owner`select customer_id, tenant_id, name, phone, email,
      (extract(epoch from created_at) * 1000000)::bigint::text as created_us, xmin::text as xmin, row_version::text as row_version
    from tmpos_customer.customer where customer_id = any(${ALL_SEEDED}::uuid[]) order by customer_id`).map((r) => ({ ...r }));
  assert.deepEqual(after.map(({ row_version: _v, ...r }) => r), ROWS_023, 'every column byte-identical, and the same tuple (xmin): no row was rewritten');
  assert.deepEqual(after.map((r) => r.row_version), after.map(() => '1'), 'every existing row reads version 1');
  assert.equal(ROWS_023.filter((r) => r.created_us === null).length, LEGACY.length, 'the legacy NULL creation times are still NULL');
  assert.equal(ROWS_023.filter((r) => r.created_us !== null).length, CREATED.length, 'the database-written creation times are still there');
  assert.ok(ROWS_023.some((r) => r.phone !== null) && ROWS_023.some((r) => r.email !== null), 'contacts were present to be kept');
  // M7B-INVOICES-P1: 028 adds its composite-key UNIQUE to the customer table and its own audit subject column and index; 024's
  // additions are judged on 024's surface (028's committed down first, rolled back), and 028's are only those.
  const at024 = await rolledBack(RC, async (tx) => { await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(DOWN_028).simple(); return surface(tx); });
  assert.ok(at024.value !== undefined, JSON.stringify(at024));
  const now = at024.value;
  const with028 = await surface(owner);
  assert.deepEqual(with028.constraints.filter((c) => c.name !== 'customer_tenant_customer_key'), now.constraints, '028 adds one customer constraint');
  assert.deepEqual(with028.constraints.find((c) => c.name === 'customer_tenant_customer_key')?.def, 'UNIQUE (tenant_id, customer_id)');
  assert.deepEqual(with028.columns, now.columns, '028 adds no customer column');
  assert.deepEqual(with028.auditColumns.filter((c) => c.name !== 'subject_invoice_draft_id'), now.auditColumns, '028 adds one audit column');
  assert.deepEqual(now.columns, [...SURFACE_023.columns,
    { name: 'row_version', type: 'bigint', not_null: true, has_default: true, acl: null }]);
  const [{ dflt }] = await owner`select pg_catalog.pg_get_expr(d.adbin, d.adrelid) as dflt from pg_catalog.pg_attrdef d
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'tmpos_customer.customer'::regclass and a.attname = 'row_version'`;
  assert.equal(dflt, '1');
  assert.deepEqual(now.constraints.filter((c) => c.name !== 'customer_row_version_chk'), SURFACE_023.constraints, '017\'s and 023\'s constraints untouched');
  assert.match(now.constraints.find((c) => c.name === 'customer_row_version_chk')?.def ?? '', /row_version >= 1.*row_version <= '?9007199254740991/);
  assert.deepEqual(now.indexes, SURFACE_023.indexes, 'no customer index added or changed');
  assert.equal(now.tableAcl, SURFACE_023.tableAcl, 'the table\'s ACL unchanged');
  assert.deepEqual(now.auditColumns, [...SURFACE_023.auditColumns,
    { name: 'subject_customer_id', type: 'uuid', not_null: false, has_default: false, acl: null }], 'one nullable uuid, no default, no column grant');
  assert.deepEqual(now.auditIndexes.filter((d) => !SURFACE_023.auditIndexes.includes(d)), [
    'CREATE INDEX idx_audit_event_subject_customer_occurred ON public.audit_event USING btree (subject_customer_id, occurred_at DESC) WHERE (subject_customer_id IS NOT NULL)']);
  assert.equal(now.auditAcl, SURFACE_023.auditAcl, 'the audit table\'s ACL unchanged');
  const [w] = await owner`select pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_customer_id', 'INSERT') as writer,
    pg_catalog.has_column_privilege('tmpos_app', 'public.audit_event', 'subject_customer_id', 'SELECT') as app_reads`;
  assert.deepEqual({ ...w }, { writer: true, app_reads: false }, 'the writer\'s table-wide INSERT covers the subject; nothing else is granted');
  // New rows start at 1 — including a 023 create that writes its contacts onto the row it just inserted.
  const key = await mint(OWNER_A);
  for (const [phone, email] of [['+1 555 0102', 'new@example.test'], [null, null]]) {
    const id = randomUUID();
    assert.equal(await create023(key, id, `New ${SUFFIX}`, phone, email), 1);
    assert.equal((await stored(id)).row_version, '1', `a customer created through 023 (${phone ?? 'no contacts'}) starts at version 1`);
  }
});

test('M7CE-03: the login executes 024\'s two routines and uses their schema, executes 023\'s profile read no longer, holds nothing on the table or its columns; no other runtime role executes either; the real preflight accepts the login and the ledger', async () => {
  const [p] = await owner`select
    pg_catalog.has_function_privilege('tmpos_app', ${UPDATE}, 'EXECUTE') as app_update,
    pg_catalog.has_function_privilege('tmpos_app', ${PROFILE}, 'EXECUTE') as app_profile,
    pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_edit', 'USAGE') as app_usage,
    pg_catalog.has_function_privilege('tmpos_app', ${PROFILE_023}, 'EXECUTE') as app_profile_023,
    pg_catalog.has_function_privilege('tmpos_app', ${CREATE_023}, 'EXECUTE') as app_create_023,
    pg_catalog.has_function_privilege('tmpos_audit_writer', ${UPDATE}, 'EXECUTE') as writer_update,
    pg_catalog.has_function_privilege('tmpos_audit_writer', ${PROFILE}, 'EXECUTE') as writer_profile,
    pg_catalog.has_function_privilege('anon', ${PROFILE}, 'EXECUTE') as anon_profile,
    pg_catalog.has_function_privilege('authenticated', ${UPDATE}, 'EXECUTE') as authenticated_update,
    pg_catalog.has_function_privilege('public', ${UPDATE}, 'EXECUTE') as public_update,
    pg_catalog.has_table_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as app_table,
    pg_catalog.has_any_column_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT, INSERT, UPDATE, REFERENCES') as app_columns,
    pg_catalog.has_column_privilege('tmpos_app', 'tmpos_customer.customer', 'row_version', 'UPDATE') as app_version`;
  assert.deepEqual({ ...p }, {
    app_update: true, app_profile: true, app_usage: true, app_profile_023: false, app_create_023: true, writer_update: false,
    writer_profile: false, anon_profile: false, authenticated_update: false, public_update: false, app_table: false,
    app_columns: false, app_version: false,
  });
  const key = await mint(OWNER_A);
  assert.equal((await errorOf(runtime`select * from tmpos_customer_contact.m7a_contact_profile(${key}::text, ${CREATED[0]}::uuid, ${T_A}::uuid)`))?.code,
    '42501', '023\'s profile read is no longer the login\'s');
  for (const statement of ['select row_version from tmpos_customer.customer limit 1', 'update tmpos_customer.customer set row_version = 99 where false',
    'update tmpos_customer.customer set name = \'x\' where false']) {
    assert.equal((await errorOf(runtime.unsafe(statement)))?.code, '42501', statement);
  }
  const [config] = await owner`select pg_catalog.array_agg(p.proconfig::text order by p.proname) as configs,
    pg_catalog.array_agg(p.provolatile::text order by p.proname) as volatility, pg_catalog.bool_and(p.prosecdef) as definer
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_edit'::regnamespace`;
  assert.deepEqual({ ...config }, {
    configs: ['{"search_path=pg_catalog, pg_temp",row_security=off}', '{"search_path=pg_catalog, pg_temp",row_security=off}'],
    volatility: ['s', 'v'], definer: true,
  });
  // A hostile search path planted by the caller changes nothing: the routines pin their own.
  const hostile = await rolledBack(RC, async (tx) => {
    await tx.unsafe('create schema m7ce_hostile');
    await tx.unsafe('create function m7ce_hostile.char_length(text) returns integer language sql as $$ select 1 $$');
    await tx.unsafe('grant usage on schema m7ce_hostile to public');
    return (await asRuntime(tx, async (sp) => {
      await sp.unsafe('set local search_path = m7ce_hostile, pg_catalog');
      return edit(key, CREATED[0], T_A, MAX_VERSION, 'x'.repeat(201), KEEP, KEEP, sp);
    }));
  });
  assert.equal(hostile.value?.code, '22023', `an over-long name is still refused under a planted search path: ${JSON.stringify(hostile)}`);
  const verdict = await rolledBack(RC, (tx) => preflightOn(tx));
  assert.deepEqual(verdict.value, { runtimeLogin: [], migrationLedger: [] }, JSON.stringify(verdict));
});

// ===========================================================================
// M7CE-04..07: patch semantics, validation, authority, versions
// ===========================================================================

test('M7CE-04: patch semantics — a name change, a phone and an email set and cleared, a contact not being set kept; created_at, id and tenant never written (a legacy NULL stays NULL); the version moves exactly once per applied edit', async () => {
  const key = await mint(OWNER_A);
  const id = CREATED[0];
  const before = await stored(id);
  assert.deepEqual([before.name, before.phone, before.email, before.row_version], [`Ada Lovelace ${SUFFIX}`, '+1 555 0100', 'ada@example.test', '1']);
  assert.deepEqual(await edit(key, id, T_A, 1, `Ada King ${SUFFIX}`), applied(OWNER_A, T_A, 2), 'a name change, contacts not being set');
  let row = await stored(id);
  assert.deepEqual([row.name, row.phone, row.email, row.row_version], [`Ada King ${SUFFIX}`, '+1 555 0100', 'ada@example.test', '2'], 'the contacts kept');
  assert.deepEqual(await edit(key, id, T_A, 2, `Ada King ${SUFFIX}`, '+1 555 0199'), applied(OWNER_A, T_A, 3), 'a phone set');
  assert.deepEqual(await edit(key, id, T_A, 3, `Ada King ${SUFFIX}`, null), applied(OWNER_A, T_A, 4), 'the phone cleared');
  row = await stored(id);
  assert.deepEqual([row.phone, row.email, row.row_version], [null, 'ada@example.test', '4']);
  assert.deepEqual(await edit(key, id, T_A, 4, `Ada King ${SUFFIX}`, KEEP, 'ada.king@example.test'), applied(OWNER_A, T_A, 5), 'an email set');
  assert.deepEqual(await edit(key, id, T_A, 5, `Ada King ${SUFFIX}`, KEEP, null), applied(OWNER_A, T_A, 6), 'the email cleared');
  assert.deepEqual(await edit(key, id, T_A, 6, `Ada ${SUFFIX}`, '+1 555 0100', 'ada@example.test'), applied(OWNER_A, T_A, 7), 'all three at once');
  row = await stored(id);
  assert.deepEqual([row.customer_id, row.tenant_id, row.name, row.phone, row.email, row.created_us, row.row_version],
    [id, T_A, `Ada ${SUFFIX}`, '+1 555 0100', 'ada@example.test', before.created_us, '7'], 'the id, tenant and creation time are the original ones');
  // A legacy row: its unknown creation time stays unknown through an edit, and a contact can be given to it.
  const legacy = LEGACY[0];
  assert.deepEqual(await edit(key, legacy, T_A, 1, `Legacy Zed ${SUFFIX}`, '+1 555 0103', KEEP), applied(OWNER_A, T_A, 2));
  const l = await stored(legacy);
  assert.deepEqual([l.created_us, l.phone, l.email, l.row_version], [null, '+1 555 0103', null, '2'], 'created_at is never invented');
  // The table's other rows are untouched by any of it.
  assert.deepEqual((await stored(CREATED[1])).row_version, '1');
});

const OUT_OF_RANGE_MESSAGES = [];
test('M7CE-05: every refused argument raises 22023 with a fixed message naming the field, never the value, before any read or lock, and changes nothing; outside READ COMMITTED 55000; the table CHECK refuses version 0', async () => {
  const key = await mint(OWNER_A);
  const id = CREATED[1];
  const before = await stored(id);
  const levels = async () => (await owner`select count(*)::int as n from tmpos_role.tenant_role_level`)[0].n;
  const levelsBefore = await levels();
  const name = `Name Only ${SUFFIX}`;
  const BAD_NAMES = ['', ' Ada', 'Ada ', `Ada${ch(0x00a0)}`, `${ch(0xfeff)}Ada`, 'A\u0001da', 'A\u007fda', 'A\u0085da', 'A\u2028da', 'x'.repeat(201),
    ...BIDI.map((c) => `A${ch(c)}da`)];
  const BAD_PHONES = ['', 'no digits', ' 555', '555 ', '5\u0001', '5'.repeat(65), ...BIDI.map((c) => `5${ch(c)}5`)];
  const BAD_EMAILS = ['', 'ada', 'a@b@c', '@b', 'a@', 'a b@c', 'a@b\u00a0c', `${'a'.repeat(250)}@b.cd`, 'a\u0001@b', ...BIDI.map((c) => `a${ch(c)}@b`)];
  const cases = [
    ...BAD_NAMES.map((n) => [`name ${JSON.stringify(n).slice(0, 24)}`, [key, id, T_A, '1', n, false, null, false, null], /the name is not one/]),
    ['a null name', [key, id, T_A, '1', null, false, null, false, null], /the name is not one/],
    ...BAD_PHONES.map((v) => [`phone ${JSON.stringify(v).slice(0, 24)}`, [key, id, T_A, '1', name, true, v, false, null], /the phone is not one/]),
    ...BAD_EMAILS.map((v) => [`email ${JSON.stringify(v).slice(0, 24)}`, [key, id, T_A, '1', name, false, null, true, v], /the email is not one/]),
    ['a phone sent while not being set', [key, id, T_A, '1', name, false, '+1 555 0100', false, null], /the phone is not one/],
    ['an email sent while not being set', [key, id, T_A, '1', name, false, null, false, 'ada@example.test'], /the email is not one/],
    ['version 0', [key, id, T_A, '0', name, false, null, false, null], /expected version/],
    ['a negative version', [key, id, T_A, '-1', name, false, null, false, null], /expected version/],
    ['version 2^53-1', [key, id, T_A, String(MAX_VERSION), name, false, null, false, null], /expected version/],
    ['a null version', [key, id, T_A, null, name, false, null, false, null], /expected version/],
    ['a null key', [null, id, T_A, '1', name, false, null, false, null], /an argument is malformed/],
    ['a key with a space', ['a b', id, T_A, '1', name, false, null, false, null], /an argument is malformed/],
    ['a null id', [key, null, T_A, '1', name, false, null, false, null], /an argument is malformed/],
    ['a null tenant', [key, id, null, '1', name, false, null, false, null], /an argument is malformed/],
    ['a null phone flag', [key, id, T_A, '1', name, null, null, false, null], /an argument is malformed/],
    ['a null email flag', [key, id, T_A, '1', name, false, null, null, null], /an argument is malformed/],
  ];
  // Expected versions outside bigint itself never reach the routine: the bind's cast refuses them (22003). The value is a
  // version number, never personal data; whether the server's message repeats it is recorded, not asserted (P7 report).
  const OUT_OF_INT64 = [['2^63', '9223372036854775808'], ['-2^63-1', '-9223372036854775809'], ['a huge negative', `-${'9'.repeat(40)}`]];
  // The row is held FOR UPDATE throughout: a refusal that read or locked it would wait, so every one must answer at once.
  const h = await holdCustomer(id);
  try {
    for (const [label, args, pattern] of cases) {
      const out = await within(errorOf(editRaw(args)), label);
      assert.equal(out?.code, '22023', `${label}: ${JSON.stringify(out)}`);
      assert.match(out.message, pattern, label);
      assert.match(out.message, /^migration 024 update: [a-z ]+$/, `${label}: a fixed message, no value`);
      assert.equal(out.detail, null, label);
      assert.equal(out.hint, null, label);
    }
    for (const [label, v] of OUT_OF_INT64) {
      const out = await within(errorOf(editRaw([key, id, T_A, v, name, false, null, false, null])), label);
      assert.equal(out?.code, '22003', `${label}: refused at the argument cast (${JSON.stringify(out)})`);
      OUT_OF_RANGE_MESSAGES.push(`${label}: ${out.message.includes(v) ? 'message repeats the value' : 'message carries no value'}`);
    }
  } finally {
    await h.settle();
  }
  console.log(`# M7CE-05 out-of-int64 versions: ${OUT_OF_RANGE_MESSAGES.join('; ')}`);
  assert.deepEqual(await stored(id), before, 'nothing changed: the same tuple');
  assert.equal(await levels(), levelsBefore, 'no role row was made to exist');
  // A MANAGER's key, whose authority path takes 016's hold (its account FOR UPDATE, its tenant FOR SHARE), the session and
  // ledger rows FOR SHARE and makes its role row exist: with every one of those rows held FOR UPDATE by another transaction
  // and no role row yet, a malformed call still answers at once and leaves no role row — refused before any read or lock.
  const mt = await newTenant('p5-manager');
  const mgr = await actor('p5-manager', [{ tenant: mt, role: 'manager' }]);
  const mKey = await mint(mgr);
  const mId = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${mId}, ${mt}, ${`Manager Case ${SUFFIX}`})`;
  const roleRows = async () => (await owner`select count(*)::int as n from tmpos_role.tenant_role_level where tenant_id = ${mt}`)[0].n;
  assert.equal(await roleRows(), 0, 'no role row exists for the manager\'s tenant yet');
  const locks = await hold('every row the authority path would lock', async (sql) => {
    await sql`select 1 from public.app_user where internal_user_id = ${mgr.id} for update`;
    await sql`select 1 from public.tenant where tenant_id = ${mt} for update`;
    await sql`select 1 from tmpos_session.session where session_key = ${mKey} for update`;
    await sql`select 1 from tmpos_mint.tenant_session where session_key = ${mKey} for update`;
    await sql`select 1 from tmpos_customer.customer where customer_id = ${mId} for update`;
  });
  try {
    for (const [label, args] of [
      ['a bad name', [mKey, mId, mt, '1', ' x', false, null, false, null]],
      ['a bad phone', [mKey, mId, mt, '1', 'Ada', true, 'no digits', false, null]],
      ['version 0', [mKey, mId, mt, '0', 'Ada', false, null, false, null]],
      ['a null tenant', [mKey, mId, null, '1', 'Ada', false, null, false, null]],
    ]) {
      const out = await within(errorOf(editRaw(args)), `manager: ${label}`);
      assert.equal(out?.code, '22023', `manager, ${label}: answered at once with every lock held elsewhere (${JSON.stringify(out)})`);
    }
    // Control: the same lever DOES stop a well-formed call — it waits on a row the holder has.
    const valid = quietly(edit(mKey, mId, mt, 1, `Manager Edited ${SUFFIX}`));
    waitingPid(await blockedOrSettled(valid, { by: locks.pid, query: AT_EDIT }), 'a well-formed manager call waiting on the held rows (control)');
    assert.equal(await roleRows(), 0, 'refused calls made no role row exist');
    assert.equal(await locks.settle(), 'rolled back');
    assert.deepEqual(await within(valid, 'the control call'), applied(mgr, mt, 2), 'the control applies once released');
  } finally {
    await locks.settle();
  }
  // The valid edges are admitted (control): the longest name, phone and email.
  const edges = await rolledBack(RC, (tx) => asRuntime(tx, (sp) => edit(key, id, T_A, 1, 'n'.repeat(200), '5'.repeat(64), `${'a'.repeat(250)}@b.c`, sp)));
  assert.deepEqual(edges.value?.value, applied(OWNER_A, T_A, 2), JSON.stringify(edges));
  const rr = await rolledBack('isolation level repeatable read', (tx) => asRuntime(tx, (sp) => edit(key, id, T_A, 1, name, KEEP, KEEP, sp)));
  assert.equal(rr.value?.code, '55000', JSON.stringify(rr));
  assert.match(rr.value.message, /READ COMMITTED/);
  // The column CHECK: version 0, a negative version and one past the bound are refused even for the owner.
  for (const v of ['0', '-1', '9007199254740992']) {
    const out = await rolledBack(RC, (tx) => tx`update tmpos_customer.customer set row_version = ${v}::bigint where customer_id = ${id}`);
    assert.equal(out.code, '23514', `row_version ${v}: ${JSON.stringify(out)}`);
  }
});

test('M7CE-06: authority — View-only and Create-only roles get no row; Edit, Manage and Full apply; owner-edited levels honoured both ways; read-only and suspended accounts and tenants, revoked and expired sessions, a wrong expected tenant and an unknown key get no row; another tenant\'s id is the same not_found as a missing one', async () => {
  const PHONE = '+1 555 0100';
  /** A fresh tenant of `status` with one customer, and one actor of `role` (account `account`), minted. */
  const fresh = async (label, role, { status = 'active', account = 'active', level } = {}) => {
    const tenant = await newTenant(`p6-${label}`, status);
    const id = randomUUID();
    await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, phone) values (${id}, ${tenant}, ${`${label} ${SUFFIX}`}, ${PHONE})`;
    if (level !== undefined) {
      await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${tenant}, ${role}, 'customers', ${level}, now())`;
    }
    const who = await actor(`p6-${label}`, [{ tenant, role }], account);
    return { label, tenant, id, who, key: await mint(who) };
  };
  const attempt = (f, tenant = f.tenant, key = f.key, id = f.id) => edit(key, id, tenant, 1, `${f.label} edited ${SUFFIX}`);
  const unchangedRow = async (f) => {
    const row = await stored(f.id);
    assert.deepEqual([row.name, row.row_version], [`${f.label} ${SUFFIX}`, '1'], `${f.label}: nothing written`);
  };
  const allowed = [
    ['store_owner', 'store_owner'], ['manager at its default (full)', 'manager'],
    ['technician raised to edit', 'technician', { level: 'edit' }], ['sales_staff raised to edit', 'sales_staff', { level: 'edit' }],
    ['manager at manage', 'manager', { level: 'manage' }], ['sales_staff raised to full', 'sales_staff', { level: 'full' }],
    ['manager at approve', 'manager', { level: 'approve' }], ['a trialing tenant', 'store_owner', { status: 'trialing' }],
  ];
  for (const [label, role, opts] of allowed) {
    const f = await fresh(label.replace(/\W+/g, '-'), role, opts);
    assert.deepEqual(await attempt(f), applied(f.who, f.tenant, 2), label);
  }
  const refused = [
    ['technician at its default (view)', 'technician'], ['sales_staff at its default (create)', 'sales_staff'],
    ['manager narrowed to view', 'manager', { level: 'view' }], ['manager narrowed to create', 'manager', { level: 'create' }],
    ['manager narrowed to none', 'manager', { level: 'none' }], ['technician raised only to create', 'technician', { level: 'create' }],
    ['a read-only tenant', 'store_owner', { status: 'read_only' }], ['an overdue tenant', 'store_owner', { status: 'overdue' }],
    ['a read-only account', 'store_owner', { account: 'read_only' }],
  ];
  for (const [label, role, opts] of refused) {
    const f = await fresh(label.replace(/\W+/g, '-'), role, opts);
    assert.deepEqual(await attempt(f), [], label);
    await unchangedRow(f);
  }
  // Standing changed after the mint: a suspended account or tenant, a revoked session, an expired session.
  const later = [
    ['the account suspended', (f) => owner`update app_user set status = 'suspended' where internal_user_id = ${f.who.id}`],
    ['the tenant suspended', (f) => owner`update tenant set status = 'suspended' where tenant_id = ${f.tenant}`],
    ['the session revoked', (f) => runtime`select tmpos_session.m5_session_revoke(${f.key}::text)`],
  ];
  for (const [label, change] of later) {
    const f = await fresh(label.replace(/\W+/g, '-'), 'store_owner');
    await change(f);
    assert.deepEqual(await attempt(f), [], label);
    await unchangedRow(f);
  }
  const short = await fresh('expired', 'store_owner');
  const SHORT_LIFETIME = 4_000;
  const shortKey = await mint(short.who, SHORT_LIFETIME);
  // Positive control: a second session minted with the same recipe edits (another customer of the tenant) while live.
  const controlKey = await mint(short.who, SHORT_LIFETIME);
  const controlId = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${controlId}, ${short.tenant}, ${`Short Control ${SUFFIX}`})`;
  assert.deepEqual(await edit(controlKey, controlId, short.tenant, 1, `Short Control Edited ${SUFFIX}`), applied(short.who, short.tenant, 2),
    'a session of the same recipe applies while live (positive control)');
  const [{ expires_at: shortExpiresText }] = await owner`select expires_at::text as expires_at from tmpos_session.session where session_key = ${shortKey}`;
  const dbNow = async () => Number((await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint::text as t`)[0].t);
  await delay(Math.max(0, Number(shortExpiresText) + 500 - Date.now()));
  assert.ok(Number(shortExpiresText) <= await dbNow(), 'past its expiry on the database clock before the call');
  assert.deepEqual(await attempt(short, short.tenant, shortKey), [], 'an expired session');
  await unchangedRow(short);
  // A wrong expected tenant and an unknown key: no row, whatever the id.
  const a = await fresh('tenant-a', 'store_owner');
  const b = await fresh('tenant-b', 'store_owner');
  assert.deepEqual(await attempt(a, b.tenant), [], 'a session of A asserting B');
  assert.deepEqual(await attempt(a, b.tenant, a.key, b.id), [], 'a session of A asserting B, for B\'s customer');
  assert.deepEqual(await attempt(a, a.tenant, newKey()), [], 'an unknown key');
  await unchangedRow(a);
  await unchangedRow(b);
  // A MANAGER's key asserting another tenant: refused at step 7b, before step 8 makes its role row exist.
  const m = await fresh('tenant-m', 'manager');
  const mRoleRows = async () => (await owner`select count(*)::int as n from tmpos_role.tenant_role_level where tenant_id = ${m.tenant}`)[0].n;
  assert.equal(await mRoleRows(), 0);
  assert.deepEqual(await attempt(m, b.tenant), [], 'a manager\'s session of M asserting B');
  assert.deepEqual(await attempt(m, b.tenant, m.key, b.id), [], 'a manager\'s session of M asserting B, for B\'s customer');
  assert.equal(await mRoleRows(), 0, 'no role row was made to exist: the tenant precondition comes first');
  await unchangedRow(m);
  // The wrong audience: an ADMINISTRATIVE session row for a principal holding a tenant grant is no tenant session.
  const adminKey = newKey();
  KEYS.add(adminKey);
  const at = Date.now();
  const [{ outcome: adminOutcome }] = await runtime`select tmpos_mint.m7a_session_create(${adminKey}::text, 'admin'::text, 'firebase'::text,
    ${a.who.uid}::text, ${principalKeyOf(a.who.principal)}::text, 'm7ce-admin'::text, ${at}::bigint, ${at}::bigint, ${at}::bigint,
    ${at}::bigint, ${at + HOUR}::bigint, null::bytea) as outcome`;
  assert.equal(adminOutcome, 'created', 'an administrative session row exists to be presented');
  assert.deepEqual(await attempt(a, a.tenant, adminKey), [], 'an administrative session key');
  await unchangedRow(a);
  // Authorized in A: B's customer and a missing id are the same answer, byte for byte, and B's row is untouched.
  const foreign = await attempt(a, a.tenant, a.key, b.id);
  const missing = await attempt(a, a.tenant, a.key, randomUUID());
  assert.deepEqual(foreign, [{ o_outcome: 'not_found', ...NULLS }]);
  assert.deepEqual(missing, foreign, 'a missing id: the identical row');
  await unchangedRow(b);
});

test('M7CE-07: versions — stale is conflict and a stale no-op is conflict, writing nothing; a current no-op is unchanged with the same version and the row not written; applied answers expected + 1; A->B->A leaves version 3 and a draft at 1 conflicts', async () => {
  const key = await mint(OWNER_A);
  const id = CREATED[2];
  const name = `Phone Only ${SUFFIX}`;
  const start = await stored(id);
  assert.equal(start.row_version, '1');
  // Current no-op: every target equal (the name as stored, the phone set to its value, the email not being set).
  assert.deepEqual(await edit(key, id, T_A, 1, name, '+1 555 0101'),
    [{ o_outcome: 'unchanged', o_tenant_id: T_A, o_actor_id: OWNER_A.id, o_membership_id: OWNER_A.membership, o_version: '1' }]);
  assert.deepEqual(await edit(key, id, T_A, 1, name, KEEP, null), (await edit(key, id, T_A, 1, name)), 'clearing an already-NULL email is a no-op too');
  assert.deepEqual(await stored(id), start, 'nothing written: the same tuple (xmin)');
  // Applied: expected + 1.
  assert.deepEqual(await edit(key, id, T_A, 1, `B ${SUFFIX}`), applied(OWNER_A, T_A, 2));
  const moved = await stored(id);
  // Stale: a conflict, nothing written — and a stale no-op (values equal to the stored ones) is a conflict too.
  assert.deepEqual(await edit(key, id, T_A, 1, `C ${SUFFIX}`), [{ o_outcome: 'conflict', ...NULLS }]);
  assert.deepEqual(await edit(key, id, T_A, 1, `B ${SUFFIX}`), [{ o_outcome: 'conflict', ...NULLS }], 'a stale no-op conflicts: the version is judged first');
  assert.deepEqual(await edit(key, id, T_A, 3, `B ${SUFFIX}`), [{ o_outcome: 'conflict', ...NULLS }], 'a version from the future conflicts');
  assert.deepEqual(await stored(id), moved, 'nothing written by a conflict');
  // A -> B -> A: the version never returns.
  assert.deepEqual(await edit(key, id, T_A, 2, name), applied(OWNER_A, T_A, 3));
  assert.equal((await stored(id)).name, start.name);
  assert.deepEqual(await edit(key, id, T_A, 1, `D ${SUFFIX}`), [{ o_outcome: 'conflict', ...NULLS }], 'the first draft, at 1, is stale though the values are back');
  // The bound: a customer at 2^53-2 advances once more to 2^53-1, the CHECK's bound, and no further edit can be expressed.
  const top = await rolledBack(RC, async (tx) => {
    await tx`update tmpos_customer.customer set row_version = ${String(MAX_VERSION - 1)}::bigint where customer_id = ${id}`;
    const first = await asRuntime(tx, (sp) => edit(key, id, T_A, MAX_VERSION - 1, `E ${SUFFIX}`, KEEP, KEEP, sp));
    return first;
  });
  assert.deepEqual(top.value?.value, applied(OWNER_A, T_A, MAX_VERSION), JSON.stringify(top));
});

// ===========================================================================
// M7CE-08: concurrency, ordered by lock waits only
// ===========================================================================

test('M7CE-08: two edits of one version by two actors — one applied, the other waits on the row and conflicts; revocations that win the authority locks prevent the edit, ones that arrive while the edit holds them wait for its commit; a session expiring while the edit waits gets no row', async () => {
  const tenant = await newTenant('race');
  const boss = await actor('race-owner', [{ tenant, role: 'store_owner' }]);
  const mgr = await actor('race-manager', [{ tenant, role: 'manager' }]);
  const seed = async (label) => {
    const id = randomUUID();
    await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`${label} ${SUFFIX}`})`;
    return id;
  };
  const bossKey = await mint(boss);
  const mgrKey = await mint(mgr);

  // (1) Two edits of version 1 from two connections: the first holds the row (applied, uncommitted); the second waits on
  //     it inside the routine, then — the first committed — re-reads the moved row and conflicts.
  {
    const id = await seed('two-writers');
    const first = await hold('the first edit', (sql) => edit(bossKey, id, tenant, 1, `First ${SUFFIX}`, KEEP, KEEP, sql), runtime);
    assert.deepEqual(first.value, applied(boss, tenant, 2), 'the first edit applied, uncommitted');
    const second = quietly(edit(mgrKey, id, tenant, 1, `Second ${SUFFIX}`));
    const pid = waitingPid(await blockedOrSettled(second, { by: first.pid, query: AT_EDIT }), 'the second edit waiting on the first');
    const waits = await waitingOn(pid);
    assert.ok(waits.length > 0 && waits.every((t) => t === 'transactionid' || t === 'tuple'), `it waits on the customer row: ${JSON.stringify(waits)}`);
    assert.equal(await first.commit(), 'committed');
    assert.deepEqual(await within(second, 'the second edit'), [{ o_outcome: 'conflict', ...NULLS }]);
    const row = await stored(id);
    assert.deepEqual([row.name, row.row_version], [`First ${SUFFIX}`, '2'], 'the first edit\'s values, one increment');
  }
  // (1a) IDENTICAL new values at one version: the second waits on the row, and once the first commits it is a conflict —
  //      the version is judged before the values, so it can never be 'unchanged' against the first's committed write.
  {
    const id = await seed('identical-writers');
    const first = await hold('the first edit', (sql) => edit(bossKey, id, tenant, 1, `Same ${SUFFIX}`, '+1 555 0100', KEEP, sql), runtime);
    assert.deepEqual(first.value, applied(boss, tenant, 2));
    const second = quietly(edit(mgrKey, id, tenant, 1, `Same ${SUFFIX}`, '+1 555 0100'));
    const pid = waitingPid(await blockedOrSettled(second, { by: first.pid, query: AT_EDIT }), 'the identical second edit waiting on the first');
    const waits = await waitingOn(pid);
    assert.ok(waits.length > 0 && waits.every((t) => t === 'transactionid' || t === 'tuple'), `it waits on the customer row: ${JSON.stringify(waits)}`);
    assert.equal(await first.commit(), 'committed');
    assert.deepEqual(await within(second, 'the identical second edit'), [{ o_outcome: 'conflict', ...NULLS }], 'conflict, never unchanged');
    assert.equal((await stored(id)).row_version, '2', 'one increment');
  }
  // (1b) The first rolls back instead: the second applies on version 1.
  {
    const id = await seed('rolled-back-first');
    const first = await hold('the first edit', (sql) => edit(bossKey, id, tenant, 1, `First ${SUFFIX}`, KEEP, KEEP, sql), runtime);
    const second = quietly(edit(mgrKey, id, tenant, 1, `Second ${SUFFIX}`));
    waitingPid(await blockedOrSettled(second, { by: first.pid, query: AT_EDIT }), 'the second edit waiting on the first');
    assert.equal(await first.settle(), 'rolled back');
    assert.deepEqual(await within(second, 'the second edit'), applied(mgr, tenant, 2));
  }
  // (2) Revocation FIRST: the owner's level narrowing holds the role row FOR UPDATE; the manager's edit waits on it, then
  //     reads the narrowed level and refuses — no row, nothing written.
  {
    const id = await seed('narrowed-first');
    const lever = await hold('the owner narrows the manager', (sql) => sql`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${tenant}, 'manager', 'customers', 'view', now())
      on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`);
    const call = quietly(edit(mgrKey, id, tenant, 1, `Narrowed ${SUFFIX}`));
    waitingPid(await blockedOrSettled(call, { by: lever.pid, query: AT_EDIT }), 'the edit waiting on the role row');
    assert.equal(await lever.commit(), 'committed');
    assert.deepEqual(await within(call, 'the edit'), [], 'the narrowing that won refuses the edit');
    assert.equal((await stored(id)).row_version, '1');
    await owner`update tmpos_role.tenant_role_level set level = null where tenant_id = ${tenant} and role_id = 'manager'`;
  }
  //     ... and the session revoked FIRST: the revocation holds the session row; the edit waits on it, then finds none.
  {
    const id = await seed('revoked-first');
    const key = await mint(mgr);
    const lever = await hold('the session revoked', (sql) => sql`delete from tmpos_session.session where session_key = ${key}`);
    const call = quietly(edit(key, id, tenant, 1, `Revoked ${SUFFIX}`));
    waitingPid(await blockedOrSettled(call, { by: lever.pid, query: AT_EDIT }), 'the edit waiting on the session row');
    assert.equal(await lever.commit(), 'committed');
    assert.deepEqual(await within(call, 'the edit'), [], 'the revocation that won refuses the edit');
    assert.equal((await stored(id)).row_version, '1');
  }
  // (3) The edit FIRST: it holds its authority locks (applied, uncommitted); the owner's narrowing and the session's
  //     revocation each wait on the EDIT's backend, and land only after it commits.
  {
    const id = await seed('edit-first-narrow');
    const edited = await hold('the edit', (sql) => edit(mgrKey, id, tenant, 1, `Edited ${SUFFIX}`, KEEP, KEEP, sql), runtime);
    assert.deepEqual(edited.value, applied(mgr, tenant, 2));
    const narrowing = ownerWrite('the owner narrows the manager', (sql) => sql`update tmpos_role.tenant_role_level set level = 'view'
      where tenant_id = ${tenant} and role_id = 'manager' and domain = 'customers'`);
    const seen = await ownerOutcome(narrowing);
    assert.ok(seen?.blocked && seen.blockers.includes(edited.pid), `the narrowing waits on the edit: ${JSON.stringify(seen)}`);
    assert.equal(await edited.commit(), 'committed');
    assert.equal(await within(narrowing.done, 'the narrowing'), 'committed', 'then the narrowing lands');
    assert.equal((await stored(id)).row_version, '2', 'the edit committed first');
    assert.deepEqual(await edit(mgrKey, id, tenant, 2, `Again ${SUFFIX}`), [], 'and the next edit is refused');
    await owner`update tmpos_role.tenant_role_level set level = null where tenant_id = ${tenant} and role_id = 'manager'`;
  }
  {
    const id = await seed('edit-first-revoke');
    const key = await mint(mgr);
    const edited = await hold('the edit', (sql) => edit(key, id, tenant, 1, `Edited ${SUFFIX}`, KEEP, KEEP, sql), runtime);
    assert.deepEqual(edited.value, applied(mgr, tenant, 2));
    const revoking = ownerWrite('the session revoked', (sql) => sql`delete from tmpos_session.session where session_key = ${key}`);
    const seen = await ownerOutcome(revoking);
    assert.ok(seen?.blocked && seen.blockers.includes(edited.pid), `the revocation waits on the edit: ${JSON.stringify(seen)}`);
    assert.equal(await edited.commit(), 'committed');
    assert.equal(await within(revoking.done, 'the revocation'), 'committed');
    assert.equal((await stored(id)).row_version, '2');
    assert.deepEqual(await edit(key, id, tenant, 2, `Again ${SUFFIX}`), [], 'and the revoked session edits no more');
  }
  // (4) A session that expires while the edit waits on the customer row: no row — never a conflict.
  {
    const id = await seed('expires-waiting');
    const lifetime = 12_000;
    const key = await mint(boss, lifetime);
    const [{ expires_at: expiresText }] = await owner`select expires_at::text as expires_at from tmpos_session.session where session_key = ${key}`;
    const expiresAt = Number(expiresText);
    const lever = await holdCustomer(id);
    const call = quietly(edit(key, id, tenant, 1, `Late ${SUFFIX}`));
    waitingPid(await blockedOrSettled(call, { by: lever.pid, query: AT_EDIT }), 'the edit waiting on the customer row');
    const [{ live }] = await owner`select ${expiresAt}::bigint > pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint as live`;
    assert.equal(live, true, 'the edit reached the customer row while its session was still live (else this case proves nothing)');
    await delay(Math.max(0, expiresAt + 1_000 - Date.now()));
    // On the database clock, just before the waiter resumes: the session has expired.
    const [{ expired }] = await owner`select ${expiresAt}::bigint <= pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint as expired`;
    assert.equal(expired, true, 'the session expired while the edit waited');
    assert.equal(await lever.commit(), 'committed');
    assert.deepEqual(await within(call, 'the late edit'), [], 'expired while waiting: no row');
    assert.equal((await stored(id)).row_version, '1');
  }
});

// ===========================================================================
// M7CE-09: the profile read
// ===========================================================================

test('M7CE-09: the profile read answers 023\'s row plus the version for every outcome; a View-only role reads it; values and version always come from one snapshot under concurrent committed edits', async () => {
  const key = await mint(OWNER_A);
  const id = CREATED[3] === undefined ? null : CREATED[0];
  const [mine] = await profile(key, id, T_A);
  const [theirs] = await profile023(key, id, T_A);
  assert.deepEqual({ ...mine, o_version: undefined }, { ...theirs, o_version: undefined }, '023\'s row exactly');
  assert.equal(mine.o_version, (await stored(id)).row_version);
  // Every refusal passes through with a NULL version, 023's outcome for the same inputs.
  const foreignId = CREATED[3];
  for (const [label, k, cid, t, outcome] of [
    ['B\'s customer', key, foreignId, T_A, 'not_found'], ['a missing id', key, randomUUID(), T_A, 'not_found'],
    ['asserting B', key, id, T_B, 'denied'], ['an unknown key', newKey(), id, T_A, 'denied'],
    ['a null key', null, id, T_A, 'invalid'], ['a null id', key, null, T_A, 'invalid'],
  ]) {
    assert.deepEqual(await profile(k, cid, t), [{ o_outcome: outcome, ...PROFILE_NULLS, o_version: null }], label);
    assert.equal((await profile023(k, cid, t))[0].o_outcome, outcome, `${label}: 023's outcome`);
  }
  // A View-only role (technician at its default) reads the profile and its version — the P6 policy, unchanged — but cannot edit.
  const tech = await actor('tech-a', [{ tenant: T_A, role: 'technician' }]);
  const techKey = await mint(tech);
  assert.deepEqual(await profile(techKey, id, T_A), [mine]);
  assert.deepEqual(await edit(techKey, id, T_A, Number(mine.o_version), 'Tech edit'), []);
  // An uncommitted edit is not seen; once committed, the new values and the new version are seen together.
  const v = Number(mine.o_version);
  const open = await hold('an open edit', (sql) => edit(key, id, T_A, v, `Snapshot ${SUFFIX}`, KEEP, KEEP, sql), runtime);
  assert.deepEqual(await profile(key, id, T_A), [mine], 'the open edit is not visible');
  assert.equal(await open.commit(), 'committed');
  const [after] = await profile(key, id, T_A);
  assert.deepEqual([after.o_name, after.o_version], [`Snapshot ${SUFFIX}`, String(v + 1)]);
  // Interleaved (a smoke check; the one-snapshot property is held by the routines' STABLE pins): a writer commits edits whose
  // name names its version while a reader reads; every read pairs them exactly.
  const ROUNDS = 25;
  let stop = false;
  const writer = (async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
      const [{ row_version: cur }] = await owner`select row_version::text as row_version from tmpos_customer.customer where customer_id = ${id}`;
      const next = Number(cur) + 1;
      assert.deepEqual(await edit(key, id, T_A, Number(cur), `Version ${next} ${SUFFIX}`), applied(OWNER_A, T_A, next));
    }
    stop = true;
  })();
  let reads = 0;
  while (!stop) {
    const [r] = await profile(key, id, T_A);
    if (r.o_name.startsWith('Version ')) assert.equal(r.o_name, `Version ${r.o_version} ${SUFFIX}`, 'smoke check: the values and version read together match (the one-snapshot property itself is held by the STABLE pins, M7CE-01/03)');
    reads += 1;
  }
  await writer;
  assert.ok(reads > 0);
  // Reads write nothing.
  const counts = async () => ({ ...(await owner`select
    (select count(*) from public.audit_event)::int as audit,
    (select count(*) from tmpos_customer.customer)::int as customers,
    (select count(*) from tmpos_role.tenant_role_level)::int as levels`)[0] });
  const before = await counts();
  const row = await stored(id);
  for (const cid of [id, foreignId, randomUUID()]) await profile(key, cid, T_A);
  assert.deepEqual(await counts(), before);
  assert.deepEqual(await stored(id), row, 'the row read is not written');
});

// ===========================================================================
// M7CE-10: the production profile adapter and its probe over 024's read (moved here from customerContact's M7CN-07)
// ===========================================================================

test('M7CE-10: the production profile adapter over the real login answers the profile with the version as a number; refusals carry none; its probe is true, and with EXECUTE withdrawn its probe is false and its read a throw', async () => {
  const key = await mint(OWNER_A);
  const id = randomUUID();
  assert.equal(await create023(key, id, `Adapter ${SUFFIX}`, '+1 555 0100', 'ada@example.test'), 1);
  assert.deepEqual(await edit(key, id, T_A, 1, `Adapter Edited ${SUFFIX}`), applied(OWNER_A, T_A, 2));
  const [own] = await profile(key, id, T_A);
  const scope = Object.freeze({ actor: OWNER_A.id, securityVersion: 'sv', scope: 'tenant', tenant: T_A, store: null,
    membershipId: OWNER_A.membership, roleId: 'store_owner', limitation: 'none' });
  const kernel = Object.freeze({ transaction: (_s, _b, work) => runtime.begin(RC, (tx) => work(tx)), end: async () => {} });
  const adapter = createPostgresCustomerProfile({ client: kernel });
  assert.deepEqual(await adapter.get(scope, key, id, signal()), { outcome: 'customer', id, name: `Adapter Edited ${SUFFIX}`,
    phone: '+1 555 0100', email: 'ada@example.test', createdAt: own.o_created_at, version: 2 });
  assert.deepEqual(await adapter.get(scope, key, LEGACY[1], signal()), { outcome: 'customer', id: LEGACY[1], name: `Legacy Ada ${SUFFIX}`,
    phone: null, email: null, createdAt: null, version: 1 }, 'a legacy row: no creation time, version 1');
  assert.deepEqual(await adapter.get(scope, key, CREATED[3], signal()), { outcome: 'not_found' }, 'another tenant\'s customer');
  assert.deepEqual(await adapter.get({ ...scope, tenant: T_B }, key, id, signal()), { outcome: 'denied' }, 'the scope\'s tenant is a precondition');
  assert.equal(await probeCustomerProfile(kernel, signal()), true);
  const withdrawn = await rolledBack(RC, async (tx) => {
    await tx.unsafe(`revoke execute on function ${PROFILE} from tmpos_app`);
    await tx.unsafe(`set local session authorization ${RUNTIME_LOGIN}`);
    const on = Object.freeze({ transaction: (_s, _b, work) => tx.savepoint((sp) => work(sp)), end: async () => {} });
    const probed = await probeCustomerProfile(on, signal());
    const read = await errorOf(createPostgresCustomerProfile({ client: on }).get(scope, key, id, signal()));
    return { probed, read: read?.code ?? read?.message ?? null };
  });
  assert.deepEqual(withdrawn.value, { probed: false, read: '42501' }, JSON.stringify(withdrawn));
});

// ===========================================================================
// M7CE-11: rollback — refused over edits and audit subjects, exact without them, re-applied
// ===========================================================================

test('M7CE-11: 024\'s down refuses while a customer is edited or an audit record names a customer and changes nothing; each alone refuses; outside READ COMMITTED it refuses; cleared, it leaves exactly the 001-023 surface and a byte-identical re-apply is accepted; out of order it refuses; a committed rollback keeps every contact and creation time', async () => {
  const appliedState = await routineState(owner);
  const appliedSurface = await surface(owner);
  // This test's own edited customer (row_version 2), committed: the guard's subject.
  const ownEdited = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${ownEdited}, ${T_A}, ${`Rollback Edited ${SUFFIX}`})`;
  assert.deepEqual(await edit(await mint(OWNER_A), ownEdited, T_A, 1, `Rollback Edited Twice ${SUFFIX}`), applied(OWNER_A, T_A, 2));
  // Committed: refused, and nothing changed.
  const refused = await errorOf(owner.begin(RC, (tx) => tx.unsafe(DOWN_024).simple()));
  assert.equal(refused?.code, '55000', JSON.stringify(refused));
  assert.match(refused.message, /^migration 024 rollback refused: a customer has been edited \(its row_version is above 1\)/);
  assert.deepEqual(await surface(owner), appliedSurface, 'the refused rollback changed nothing');
  assert.deepEqual(await routineState(owner), appliedState);
  // The guard sees one edited row alone, and one audit subject alone (in transactions rolled back).
  // M7B-INVOICES-P1: 028 (no draft here) adds a UNIQUE and a foreign key to the customer table that 023's and 024's exact
  // lists do not know, so each rolled-back proof below starts on 024's own surface: 028's committed down first.
  const cleared = async (tx) => {
    await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple();
    await tx.unsafe(DOWN_028).simple();
    await tx`update tmpos_customer.customer set row_version = 1 where row_version <> 1`;
    await clearCustomerSubjects(tx);
  };
  const oneEdited = await rolledBack(RC, async (tx) => {
    await cleared(tx);
    await tx`update tmpos_customer.customer set row_version = 2 where customer_id = ${LEGACY[1]}`;
    await tx.unsafe(DOWN_024).simple();
  });
  assert.equal(oneEdited.code, '55000', JSON.stringify(oneEdited));
  assert.match(oneEdited.message, /a customer has been edited/);
  const oneSubject = await rolledBack(RC, async (tx) => {
    await cleared(tx);
    await tx`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, action_id, required_permission,
        decision, reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_customer_id)
      values (${randomUUID()}, ${OWNER_A.id}, 'tenant', ${T_A}, 'tenant.customer.update', 'edit_customers', 'allow', 'command_committed',
        'm7ce proof', 'succeeded', 'm7ce_proof', 'm7ce_proof', 'durable_compliance_event', ${CREATED[0]})`;
    await tx.unsafe(DOWN_024).simple();
  });
  assert.equal(oneSubject.code, '55000', JSON.stringify(oneSubject));
  assert.match(oneSubject.message, /an audit record names the customer its action targeted/);
  // REPEATABLE READ is refused before the data is looked at.
  const rr = await rolledBack('isolation level repeatable read', (tx) => tx.unsafe(DOWN_024).simple());
  assert.equal(rr.code, '55000');
  assert.match(rr.message, /READ COMMITTED/);
  // A column grant made while 024 is installed — to tmpos_app, or to a role tmpos_app reaches — refuses the rollback before
  // anything is dropped, and once revoked the rollback proceeds.
  for (const [label, grant, revoke] of [
    ['SELECT (name) to tmpos_app', 'grant select (name) on tmpos_customer.customer to tmpos_app', 'revoke select (name) on tmpos_customer.customer from tmpos_app'],
    ['INSERT (phone) to tmpos_app', 'grant insert (phone) on tmpos_customer.customer to tmpos_app', 'revoke insert (phone) on tmpos_customer.customer from tmpos_app'],
    ['REFERENCES (customer_id) to tmpos_app', 'grant references (customer_id) on tmpos_customer.customer to tmpos_app',
      'revoke references (customer_id) on tmpos_customer.customer from tmpos_app'],
    ['SELECT (created_at) to PUBLIC', 'grant select (created_at) on tmpos_customer.customer to public', 'revoke select (created_at) on tmpos_customer.customer from public'],
    ['UPDATE (email) to a role tmpos_app reaches', 'create role m7ce_reached nologin; grant m7ce_reached to tmpos_app; grant update (email) on tmpos_customer.customer to m7ce_reached',
      'revoke update (email) on tmpos_customer.customer from m7ce_reached; revoke m7ce_reached from tmpos_app; drop role m7ce_reached'],
  ]) {
    const out = await rolledBack(RC, async (tx) => {
      await cleared(tx);
      await tx.unsafe(grant);
      const before = await surface(tx);
      const refusedDown = await tx.savepoint((sp) => sp.unsafe(DOWN_024).simple()).then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
      const unchanged = JSON.stringify(await surface(tx)) === JSON.stringify(before);
      await tx.unsafe(revoke);
      await tx.unsafe(DOWN_024).simple();
      return { refusedDown, unchanged, gone: (await tx`select pg_catalog.to_regnamespace('tmpos_customer_edit') is null as g`)[0].g };
    });
    assert.ok(out.value !== undefined, `${label}: ${JSON.stringify(out)}`);
    assert.equal(out.value.refusedDown?.code, '55000', `${label}: ${JSON.stringify(out.value.refusedDown)}`);
    assert.match(out.value.refusedDown.message, /^migration 024 rollback refused: a column grant exists on tmpos_customer\.customer/, label);
    assert.equal(out.value.unchanged, true, `${label}: the refused rollback changed nothing`);
    assert.equal(out.value.gone, true, `${label}: revoked, the rollback proceeds`);
  }
  // 023's down refuses while 024 is applied (its postcondition finds row_version): roll 024 back first.
  const down023 = await rolledBack(RC, async (tx) => {
    await cleared(tx);
    await tx`update tmpos_customer.customer set phone = null, email = null, created_at = null`;
    await tx.unsafe(DOWN_023).simple();
  });
  assert.equal(down023.code, '55000', JSON.stringify(down023));
  assert.match(down023.message, /does not have exactly 017's columns again/);
  // With 023's profile read gone (as an out-of-order rollback would leave it), 024's down refuses: roll 024 back first.
  const outOfOrder = await rolledBack(RC, async (tx) => {
    await cleared(tx);
    await tx.unsafe(`drop function ${PROFILE_023}`);
    await tx.unsafe(DOWN_024).simple();
  });
  assert.equal(outOfOrder.code, '55000', JSON.stringify(outOfOrder));
  assert.match(outOfOrder.message, /roll 024 back before 023/);
  // Cleared (in a transaction rolled back): exactly the 001-023 surface, 023's profile read the login's again; re-applied,
  // the same definitions and ACLs, accepted. 025 (M7A-CUSTOMERS-P8) sits above 024 and rolls back first, the supported order,
  // and is re-applied after it.
  const alone = await rolledBack(RC, async (tx) => {
    await cleared(tx);
    await tx.unsafe(DOWN_027).simple();
    await tx.unsafe(DOWN_026).simple();
    await tx.unsafe(DOWN_025).simple();
    await tx.unsafe(DOWN_024).simple();
    const down = { surface: await surface(tx), preflight: await preflightOn(tx),
      app023: (await tx`select pg_catalog.has_function_privilege('tmpos_app', ${PROFILE_023}, 'EXECUTE') as e`)[0].e,
      acl023: (await tx`select proacl::text as acl from pg_catalog.pg_proc where oid = ${PROFILE_023}::regprocedure`)[0].acl,
      // Run again once rolled back: a stated refusal, never a missing-column error.
      again: await tx.savepoint((sp) => sp.unsafe(DOWN_024).simple()).then(() => null, (err) => ({ code: err.code, message: String(err.message) })) };
    await tx.unsafe(UP_024).simple();
    await tx.unsafe(UP_025).simple();
    await tx.unsafe(UP_026).simple();
    await tx.unsafe(UP_027).simple();
    await tx.unsafe(UP_028).simple();
    await tx.unsafe(UP_029).simple();
    await tx.unsafe(UP_030).simple();
    return { down, reapplied: await routineState(tx), reappliedSurface: await surface(tx), up: await preflightOn(tx),
      versions: (await tx`select pg_catalog.array_agg(distinct row_version)::text as v from tmpos_customer.customer`)[0].v };
  });
  assert.ok(alone.value !== undefined, JSON.stringify(alone));
  assert.deepEqual(alone.value.down.surface, SURFACE_023, 'rolled back: exactly the surface captured on 001-023 — schemas, routines, ACLs, both tables\' columns and indexes');
  assert.equal(alone.value.down.again?.code, '55000', `a second rollback: ${JSON.stringify(alone.value.down.again)}`);
  assert.match(alone.value.down.again.message, /^migration 024 rollback refused: migration 024 is not applied/);
  assert.equal(alone.value.down.app023, true, 'tmpos_app executes 023\'s profile read again');
  assert.equal(alone.value.down.acl023, PROFILE_023_ACL, 'with exactly the ACL 023 left');
  // The ledger still records 024 here (a file run, not a ledger rollback): the grants are judged — 024's missing, 023's back.
  assert.deepEqual(alone.value.down.preflight.runtimeLogin, ['role_privilege_missing', 'role_privilege_unexpected'], JSON.stringify(alone.value.down.preflight));
  assert.deepEqual(alone.value.reapplied, appliedState, 're-applied: the same definitions, configuration and ACLs');
  // The WHOLE surface: schemas and their ACLs, routines with source digests and ACLs, the customer table's columns,
  // constraint expressions (the version CHECK's bound), indexes and ACL, and the audit table's columns, indexes (the partial
  // index with its predicate) and ACL.
  assert.deepEqual(alone.value.reappliedSurface, appliedSurface, 're-applied: the whole surface byte-identical');
  assert.deepEqual(alone.value.up, { runtimeLogin: [], migrationLedger: [] }, 're-applied: accepted');
  assert.equal(alone.value.versions, '{1}', 're-applied, every version restarts at 1 (only after the owner reset them: the residual)');
  assert.deepEqual(await routineState(owner), appliedState, 'every proof above was rolled back: 024 is as applied');

  // COMMITTED, over un-edited customers: this suite's edited customers are deleted first (test hygiene — its own rows, never
  // a guard weakened), then the rollback with its ledger row and the re-apply through rollBackAbove's restore.
  await owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]) and row_version > 1`;
  const keptRows = async () => (await owner`select customer_id, tenant_id, name, phone, email,
      (extract(epoch from created_at) * 1000000)::bigint::text as created_us
    from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]) order by customer_id`).map((r) => ({ ...r }));
  const kept = await keptRows();
  assert.ok(kept.some((r) => r.phone !== null) && kept.some((r) => r.created_us !== null) && kept.some((r) => r.created_us === null),
    'customers with contacts, creation times and unknown creation times remain');
  const { rolledBack: down, restore } = await rollBackAbove(owner, MIG_DIR, '023');
  try {
    assert.deepEqual(down, ['030', '029', '028', '027', '026', '025', '024'], 'newest first: 030 above 029 above 028 above 027 above 026 above 025 above 024 (M7A-CUSTOMERS-P8, M5-INVOICES-AUTH-P1, M7B-INVOICES-P1, -P2, -P2-R1)');
    assert.deepEqual(await keptRows(), kept, 'the rollback dropped no name, contact or creation time');
    assert.deepEqual(await surface(owner), SURFACE_023, 'exactly 001-023');
  } finally {
    await restore();
  }
  assert.deepEqual(await routineState(owner), appliedState, 're-applied with its ledger row');
  assert.deepEqual(await keptRows(), kept);
  assert.equal((await owner`select count(*)::int as n from tmpos_customer.customer where row_version <> 1`)[0].n, 0);
  const [{ checksum }] = await owner`select checksum from public.schema_migrations where version = '024'`;
  assert.equal(checksum, createHash('sha256').update(readFileSync(`${MIG_DIR}/024_m7a_customer_edit.up.sql`)).digest('hex'));
});
