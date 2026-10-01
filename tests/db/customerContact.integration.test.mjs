// Phase 4.0 M7A-CUSTOMERS-P6 — customer contact records against REAL PostgreSQL: migration 023 (three nullable columns on
// 017's table — phone, email, created_at — with two CHECKs, and schema tmpos_customer_contact: m7a_contact_create, VOLATILE,
// and m7a_contact_profile, STABLE, both SECURITY DEFINER), exercised as the runtime's own non-owner login (tmpos_app +
// tmpos_audit_writer). The HTTP routes over it (POST /api/v1/customers with contacts, GET /api/v1/customers/{id}/profile) are
// the runtime's unit suites' and the tenant entry's; this file proves the database half, the production profile adapter and
// the tenant store's create path over it.
//
// WHAT IS PROVEN. 001-022 applied first and legacy customers seeded on them; then 023 applied by the SAME trusted executor
// over those rows, its checksum the sha256 of its up bytes; its postcondition re-proven over the applied state and refusing
// the widenings it names; a second apply refused (M7CN-01). The upgrade over populated legacy rows: ids, names, tenants and
// the page order unchanged, phone, email and created_at NULL, the columns, CHECKs and indexes exactly as declared (M7CN-02).
// The login executes the two routines and uses their schema, executes 020's create no longer (42501), holds no privilege on
// the table or any of its columns, and no other runtime role executes either routine; the real startup preflight accepts the
// login and the ledger (M7CN-03). A create through 023 as the login: created_at is the creating transaction's now() — the
// database's clock, between a read before and one after — the contacts stored as sent, a name-only create's NULL; 020's
// answer row (M7CN-04). Every refused contact class is refused by the routine (22023, a fixed message naming the field and
// never the value) and by the column CHECKs (23514), writing nothing — and, through the real tenant store's commit (the
// fence, the mutator, the audit record, the completion), a refused contact commits no customer, audit record or completion
// and leaves the attempt's lease as it was, while a valid one commits all three with audit metadata {} and no contact in the
// audit row (M7CN-05). Every refusal 020's create makes is 023's too — no row, nothing written — and a store owner creates
// through both (control) (M7CN-06). The profile read: own customer with its contacts and the creation time in toISOString's
// form (the stored instant, to the millisecond); a legacy row's NULL creation time; a foreign and a missing id the SAME
// ('not_found', nulls) row; a wrong expected tenant, an unknown key and a revoked session 'denied'; every outcome 022's for
// the same inputs; reads write nothing (M7CN-07; the production adapter now reads 024's versioned profile: customerEdit's
// M7CE-10). Rollback: committed, 023's down REFUSES while any customer holds a contact or a creation time and changes
// nothing; in a transaction that clears them, it succeeds and leaves exactly the 001-022 surface captured before 023 was
// applied (schemas, routines and ACLs, the table's columns, constraints, indexes and ACL — 020's create granted back), the
// preflight names the 023 grants missing and 020's create unexpected, and a re-apply is byte-identical in definition and
// ACL and is exactly the 023 database (which the P7 runtime accepts only once 024 is applied too); out of order, with 020 rolled back first, 023's create raises at call
// and 023's down refuses until 020 is back (M7CN-08).
// The profile read's access-control parity beyond the owner key (AC-5): every standing, grant, level and tenant refusal 022's read
// makes — a technician, manager or sales_staff narrowed to none, a suspended account or tenant — is the profile read's, with every
// contact, the creation time and the name null, and a read-only tenant is served with its contacts (M7CN-09).
//
// WHAT IS SUBSTITUTED, STATED. The tenant store in M7CN-05 is the production createPostgresTransactionalStore over the
// runtime login with CUSTOMER_CREATE_MUTATOR, but its context revalidator is a stub answering true: 023's routine derives
// the caller from the session key itself, so the stub widens nothing in the database (the composed revalidator is proved in
// server/composition/productionTransactions.test.ts M7TK-08 and tests/db/customerCreate.integration.test.mjs). A lone
// surrogate never reaches the database: the driver sends U+FFFD for one, which the CHECKs cannot tell from the character
// itself — the runtime refuses it (server/runtime/customerCreate.test.ts), as for names (017). NUL cannot be sent in text.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster
// this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. On a shared service
// it first rolls 024 and 023 back with their own committed down files (which refuse, failing this suite loudly, if any
// customer is edited or still holds a contact or a creation time), so its legacy rows are seeded on 001-022 exactly as a
// deployed database would hold them, then applies 023 (only) through the trusted executor; its teardown applies 024. Every
// fixture is synthetic and randomly suffixed; every widening and every successful rollback runs in a transaction that is
// rolled back. It leaves 023 and 024 applied, the issuer key row it found,
// no customer, session, ledger, role-level or version row of its own, and its login dropped; its tenants, identities, audit
// and idempotency records stay, as every suite's do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import { REQUIRED_MIGRATIONS, createPostgresStartupPreflight } from '../../server/persistence/postgresStartupPreflight.ts';
import { CUSTOMER_CREATE_MUTATOR } from '../../server/persistence/postgresCustomerCreate.ts';
import { createPostgresTransactionalStore } from '../../server/persistence/postgresTransactionalStore.ts';
import { defineCommands, prepareCommand } from '../../server/runtime/commandTransaction.ts';
import { CUSTOMER_CREATE_CONTRACT, planCustomerCreate } from '../../server/runtime/customerCreate.ts';
import { IDEMPOTENCY_POLICY, createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';
import { defineOutboxEvents } from '../../server/runtime/outbox.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_023 = readFileSync(`${MIG_DIR}/023_m7a_customer_contact.up.sql`, 'utf8');
const DOWN_023 = readFileSync(`${MIG_DIR}/023_m7a_customer_contact.down.sql`, 'utf8');
const UP_024 = readFileSync(`${MIG_DIR}/024_m7a_customer_edit.up.sql`, 'utf8');
const DOWN_020 = readFileSync(`${MIG_DIR}/020_m7a_tenant_role_levels.down.sql`, 'utf8');
const UP_020 = readFileSync(`${MIG_DIR}/020_m7a_tenant_role_levels.up.sql`, 'utf8');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_023 = UP_023.slice(UP_023.lastIndexOf('do $$'));
const CREATE = 'tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)';
const PROFILE = 'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)';
const CREATE_020 = 'tmpos_role.m7a_customer_create(text, uuid, text)';
const GET_022 = 'tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7cn-migrator', runtimeRef: 'm7cn-runtime' };
const LOCK_KEY = 528_530;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7cn_probe';
const HOUR = 3_600_000;
const ROLLBACK = new Error('m7cn: roll the proof back');
const RC = 'isolation level read committed';
/**
 * M7A-CUSTOMERS-P7: this file proves 023 on the chain it was written for. 024 (customer edits) revokes the login's EXECUTE
 * on 023's profile read and adds a column 023's postcondition does not know, so this file applies the chain THROUGH 023 and
 * leaves 024 to its teardown. The P7 runtime's real preflight pins 001-024, so on 023 it names 024's grants missing, 023's
 * profile read unexpected and 024's ledger row missing; with 024 applied (in a rolled-back transaction) it accepts.
 */
const PREFLIGHT_AT_023 = Object.freeze({ runtimeLogin: ['role_privilege_missing', 'role_privilege_unexpected'], migrationLedger: ['migration_missing'] });
/** 024 applied on `tx`, its ledger row recorded, as the trusted executor would leave them. */
async function apply024(tx) {
  await tx.unsafe(UP_024).simple();
  await tx`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
    values ('024', ${createHash('sha256').update(readFileSync(`${MIG_DIR}/024_m7a_customer_edit.up.sql`)).digest('hex')}, false, now(), now())`;
}
const PROFILE_NULLS = Object.freeze({ o_tenant_id: null, o_customer_id: null, o_name: null, o_phone: null, o_email: null, o_created_at: null });
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const signal = () => AbortSignal.timeout(10_000);
const ch = (...codes) => String.fromCodePoint(...codes);
const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (as customerDetail does)
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

const TARGET = resolveDisposableTarget('M7CN');
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

/** Applies every migration not yet in the ledger through the trusted executor, through `through` ('NNN') or all. */
async function trustedApply(through) {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const port = createNodeFsPort(MIG_DIR, MIG_REL);
    return await runTrustedApply({
      fsPort: through === undefined ? port : portThrough(port, through), adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

test.after(async () => {
  const quietly = async (fn) => { try { await fn(); } catch { /* an earlier failure left less to clean */ } };
  if (TENANTS.length > 0) await quietly(() => owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`);
  if (TENANTS.length > 0) await quietly(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
  if (TENANTS.length > 0) await quietly(() => owner`update tenant set status = 'active' where tenant_id = any(${TENANTS}::uuid[]) and status <> 'active'`);
  if (KEYS.size > 0) await quietly(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
  if (UIDS.length > 0) await quietly(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
  // Every customer this file made, legacy or created through 023: a later suite's rollback of 023 refuses while any
  // customer holds a creation time, so none of ours may stay behind.
  if (TENANTS.length > 0) await quietly(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
  // The shared service is left with 023 AND 024 applied, whatever failed above: the executor applies what is not (024, which
  // this file keeps out while it proves 023, always).
  await quietly(async () => {
    const [{ applied }] = await owner`select exists (select 1 from public.schema_migrations where version = '024') as applied`;
    if (!applied) await trustedApply();
  });
  if (keyBeforeSuite !== undefined) {
    await quietly(async () => {
      await owner`delete from tmpos_mint.issuer_key`;
      if (keyBeforeSuite !== null) await owner`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${keyBeforeSuite})`;
    });
  }
  if (runtime) await runtime.end({ timeout: 5 });
  await quietly(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
  await quietly(() => owner.unsafe(`drop owned by ${RUNTIME_LOGIN}`));
  await quietly(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: 001-022 (023 rolled back on a shared service), a real non-owner runtime login, the key, legacy rows, then 023
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

// On a shared service an earlier step applied 023: its own committed down file removes it (and refuses, loudly, while any
// customer of any suite still holds a contact or a creation time). On a fresh cluster there is nothing to roll back.
const rolledBackAtSetup = (await rollBackAbove(owner, MIG_DIR, '022')).rolledBack;
const applyThrough022 = await trustedApply('022');

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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7cn-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
/** A synthetic actor: an identity, an active account, and the given tenant grants. */
async function actor(label, grants) {
  const uid = `m7cn-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const g of grants) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${g.tenant}, null, 'tenant', ${g.role}, 'active')`;
  }
  UIDS.push(uid);
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
/** Owner-inserted customers: 017's three columns, as a deployed 022 database holds them. */
async function seedLegacy(tenant, names) {
  const rows = names.map((name) => ({ customer_id: randomUUID(), tenant_id: tenant, name }));
  await owner`insert into tmpos_customer.customer ${owner(rows, 'customer_id', 'tenant_id', 'name')}`;
  return rows.map((r) => ({ id: r.customer_id, name: r.name }));
}

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:m7cn', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
});
/** A tenant session for `who`, minted as the runtime login under K, live for `lifetime` ms. */
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

/** 023's create as the runtime login (or on `db`): its rows, plain. A raise rejects. */
const create = async (key, id, name, phone = null, email = null, db = runtime) =>
  (await db`select o_tenant_id, o_actor_id, o_membership_id
    from tmpos_customer_contact.m7a_contact_create(${key}::text, ${id}::uuid, ${name}::text, ${phone}::text, ${email}::text)`).map((r) => ({ ...r }));
/** 023's profile read as the runtime login (or on `db`): its rows, plain. */
const profile = async (key, id, expected, db = runtime) =>
  (await db`select o_outcome, o_tenant_id, o_customer_id, o_name, o_phone, o_email, o_created_at
    from tmpos_customer_contact.m7a_contact_profile(${key}::text, ${id}::uuid, ${expected}::uuid)`).map((r) => ({ ...r }));
/** 022's read for the same inputs, as the runtime login. */
const detail = async (key, id, expected) =>
  (await runtime`select o_outcome, o_tenant_id, o_customer_id, o_name
    from tmpos_customer_detail.m7a_customer_get(${key}::text, ${id}::uuid, ${expected}::uuid)`).map((r) => ({ ...r }));
/** page_v3's ids for `key`, in its order, as the runtime login. */
const pageIds = async (key) =>
  (await runtime`select o_outcome, o_customer_id from tmpos_role.m7a_customer_page_v3(${key}::text, null::uuid, 101::integer)`)
    .map((r) => (r.o_outcome === 'customer' ? r.o_customer_id : r.o_outcome));
/** One customer row as stored, the creation time as epoch microseconds text (exact) and a Date. */
const stored = async (id) => {
  const [row] = await owner`select customer_id, tenant_id, name, phone, email, created_at,
      (extract(epoch from created_at) * 1000000)::bigint::text as created_us
    from tmpos_customer.customer where customer_id = ${id}`;
  return row === undefined ? undefined : { ...row };
};

const errorOf = (p) => p.then(() => null, (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? null }));

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
 * `fn` as the runtime login, in a savepoint of `tx` that is always rolled back — so the authorization and anything `fn` did
 * are undone. Answers { value } or the { code, message } it raised.
 */
async function asRuntime(tx, fn) {
  let out;
  await tx.savepoint(async (sp) => {
    await sp.unsafe(`set local session authorization ${RUNTIME_LOGIN}`);
    out = await fn(sp).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }).catch((err) => { if (err !== ROLLBACK) throw err; });
  return out;
}
/** A kernel over the runtime login's own pool: one READ COMMITTED transaction per call, as the supervised kernel runs it. */
const RUNTIME_KERNEL = Object.freeze({ transaction: (_s, _b, work) => runtime.begin(RC, (tx) => work(tx)), end: async () => {} });
/** The real startup preflight's login and ledger answers, as the runtime login, on `tx`'s state. */
const preflightOn = async (tx) => (await asRuntime(tx, async (sp) => {
  const preflight = createPostgresStartupPreflight({ client: { transaction: (_s, _b, fn) => fn(sp), end: async () => {} } });
  return { runtimeLogin: await preflight.runtimeLogin(signal()), migrationLedger: await preflight.migrationLedger(signal()) };
})).value;
/** Both routines' definitions, configuration and ACLs, as one comparable value. */
const routineState = async (db) => (await db`select p.oid::regprocedure::text as routine, pg_catalog.md5(p.prosrc) as src,
    p.proconfig::text as config, p.proacl::text as acl, p.provolatile as volatility, p.prosecdef as definer
  from pg_catalog.pg_proc p where p.pronamespace = pg_catalog.to_regnamespace('tmpos_customer_contact') order by 1`).map((r) => ({ ...r }));
/**
 * The database surface 023 touches, as one comparable value: every tmpos_* schema and its ACL; every routine there, its
 * source digest and ACL; 017's table's columns, constraints, indexes and ACL. Captured on 001-022 before 023 is applied.
 * Read under one fixed search path (a migration file sets its own), so every catalog spelling is the same wherever it runs.
 */
const surface = (db) => ('savepoint' in db ? db.savepoint.bind(db) : db.begin.bind(db))(async (sp) => {
  await sp.unsafe('set local search_path = pg_catalog, pg_temp');
  return surfaceOn(sp);
});
const surfaceOn = async (db) => ({
  schemas: (await db`select n.nspname::text as name, n.nspacl::text as acl from pg_catalog.pg_namespace n
    where n.nspname like 'tmpos\\_%' order by 1`).map((r) => ({ ...r })),
  routines: (await db`select p.oid::regprocedure::text as routine, pg_catalog.md5(p.prosrc) as src, p.proacl::text as acl
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname like 'tmpos\\_%' order by 1`).map((r) => ({ ...r })),
  columns: (await db`select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
      a.attacl::text as acl from pg_catalog.pg_attribute a
    where a.attrelid = 'tmpos_customer.customer'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`).map((r) => ({ ...r })),
  constraints: (await db`select c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def from pg_catalog.pg_constraint c
    where c.conrelid = 'tmpos_customer.customer'::regclass order by 1`).map((r) => ({ ...r })),
  indexes: (await db`select pg_catalog.pg_get_indexdef(x.indexrelid) as def from pg_catalog.pg_index x
    where x.indrelid = 'tmpos_customer.customer'::regclass order by 1`).map((r) => r.def),
  tableAcl: (await db`select c.relacl::text as acl from pg_catalog.pg_class c where c.oid = 'tmpos_customer.customer'::regclass`)[0].acl,
});

const T_A = await newTenant('a');
const T_B = await newTenant('b');
const OWNER_A = await actor('owner-a', [{ tenant: T_A, role: 'store_owner' }]);
const OWNER_B = await actor('owner-b', [{ tenant: T_B, role: 'store_owner' }]);

// The legacy state, on 001-022: rows of 017's three columns, the page order an owner reads, and the surface 023 touches.
const LEGACY_A = await seedLegacy(T_A, [`Zed ${SUFFIX}`, `Ada ${SUFFIX}`, `Ada ${SUFFIX}`, `Mia ${SUFFIX}`]);
const LEGACY_B = await seedLegacy(T_B, [`Bo ${SUFFIX}`]);
const legacyRows = async () => (await owner`select customer_id, tenant_id, name from tmpos_customer.customer
  where tenant_id = any(${[T_A, T_B]}::uuid[]) order by tenant_id, name, customer_id`).map((r) => ({ ...r }));
const LEGACY_ROWS_022 = await legacyRows();
const KEY_A_022 = await mint(OWNER_A);
const PAGE_A_022 = await pageIds(KEY_A_022);
const SURFACE_022 = await surface(owner);
const COLUMNS_AT_022 = (await owner`select a.attname::text as name from pg_catalog.pg_attribute a
  where a.attrelid = 'tmpos_customer.customer'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`).map((r) => r.name);

// Now 023, by the same trusted executor, over those rows (and not 024: see PREFLIGHT_AT_023).
const applyReport = await trustedApply('023');

const scopeOf = async (who, tenant) => {
  const [m] = await owner`select membership_id, role_id from user_membership where internal_user_id = ${who.id} and tenant_id = ${tenant} and scope_type = 'tenant'`;
  return Object.freeze({ actor: who.id, securityVersion: 'sv', scope: 'tenant', tenant, store: null, membershipId: m.membership_id, roleId: m.role_id, limitation: 'none' });
};

// ---------------------------------------------------------------------------
// M7CN-01..03: the migration, the upgrade over legacy rows, and the login's privileges
// ---------------------------------------------------------------------------

test('M7CN-01: 023 applied by the trusted executor over 001-022, its checksum its up bytes; its postcondition holds and refuses the widenings it names; a second apply is refused', async () => {
  assert.equal(applyThrough022.outcome, 'complete', JSON.stringify(applyThrough022).slice(0, 400));
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  assert.deepEqual(applyReport.applied, ['023'], `023 alone applied over the populated 001-022 chain (rolled back at setup: ${JSON.stringify(rolledBackAtSetup)})`);
  assert.deepEqual(COLUMNS_AT_022, ['customer_id', 'tenant_id', 'name'], 'the rows were seeded on 017\'s three columns');
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 23 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.slice(0, 23).map((m) => m.checksum), 'the ledger records the pinned chain through 023');
  assert.equal(ledger[22].checksum, createHash('sha256').update(readFileSync(`${MIG_DIR}/023_m7a_customer_contact.up.sql`)).digest('hex'));
  assert.equal((await rolledBack(RC, (tx) => tx.unsafe(POSTCONDITION_023).simple())).code, undefined, 'the postcondition holds as applied');
  for (const [label, widen, pattern] of [
    ['a table grant', 'grant select on tmpos_customer.customer to tmpos_app', /holds a privilege on tmpos_customer\.customer/],
    ['a column grant', 'grant select (phone, email) on tmpos_customer.customer to tmpos_app', /holds a privilege on tmpos_customer\.customer|column grant/],
    ['020\'s create given back', `grant execute on function ${CREATE_020} to tmpos_app`, /can execute 020's create/],
    ['EXECUTE to the audit writer', `grant execute on function ${CREATE} to tmpos_audit_writer`, /unexpected direct grant/],
    ['EXECUTE to PUBLIC', `grant execute on function ${PROFILE} to public`, /unexpected direct grant/],
    ['a grantable EXECUTE', `grant execute on function ${CREATE} to tmpos_app with grant option`, /unexpected direct grant/],
    ['USAGE to the audit writer', 'grant usage on schema tmpos_customer_contact to tmpos_audit_writer', /carries an unexpected grant/],
    ['a third routine', 'create function tmpos_customer_contact.extra() returns integer language sql as $$ select 1 $$', /exactly the two routines/],
    ['a table beside them', 'create table tmpos_customer_contact.extra (x integer)', /exactly the two routines/],
    ['an index on a contact', 'create index m7cn_phone_idx on tmpos_customer.customer (phone)', /exactly 017's two indexes/],
    ['a unique contact', 'alter table tmpos_customer.customer add constraint m7cn_email_key unique (email)', /constraints|indexes/],
    ['a default on phone', 'alter table tmpos_customer.customer alter column phone set default \'0\'', /exactly 017's columns/],
    ['a NOT NULL email', 'alter table tmpos_customer.customer alter column email set not null', /exactly 017's columns/],
    ['the create made STABLE', `alter function ${CREATE} stable`, /SECURITY DEFINER routines/],
  ]) {
    const out = await rolledBack(RC, async (tx) => {
      // A NOT NULL email needs no NULL email to exist: inside this rolled-back proof every row gets one first.
      if (label === 'a NOT NULL email') await tx`update tmpos_customer.customer set email = 'm7cn@example.test'`;
      await tx.unsafe(widen);
      await tx.unsafe(POSTCONDITION_023).simple();
    });
    assert.equal(out.code, '55000', `${label}: ${JSON.stringify(out)}`);
    assert.match(out.message, pattern, label);
  }
  // A row holding a creation time the apply could not have left: refused (every pre-existing row keeps NULL).
  const stamped = await rolledBack(RC, async (tx) => {
    await tx`update tmpos_customer.customer set created_at = now() where customer_id = ${LEGACY_A[0].id}`;
    await tx.unsafe(POSTCONDITION_023).simple();
  });
  assert.equal(stamped.code, '55000');
  assert.match(stamped.message, /did not leave NULL/);
  const again = await rolledBack(RC, (tx) => tx.unsafe(UP_023).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /migration 023 refused: schema tmpos_customer_contact already exists/);
});

test('M7CN-02: the upgrade over populated legacy rows keeps every id, name, tenant and the page order; phone, email and created_at are NULL; the columns, CHECKs and indexes are exactly as declared', async () => {
  assert.deepEqual(await legacyRows(), LEGACY_ROWS_022, 'the same rows, ids, names and tenants');
  assert.deepEqual(await pageIds(KEY_A_022), PAGE_A_022, 'the same page, in the same (name, id) order, for a session minted before 023');
  assert.equal(PAGE_A_022.length, LEGACY_A.length);
  const contacts = await owner`select count(*)::int as n from tmpos_customer.customer
    where tenant_id = any(${[T_A, T_B]}::uuid[]) and (phone is not null or email is not null or created_at is not null)`;
  assert.equal(contacts[0].n, 0, 'no legacy row was given a contact or a creation time — never the migration\'s time');
  const columns = await owner`select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
      co.collname::text as collation, a.attnotnull as not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as dflt
    from pg_catalog.pg_attribute a
    left join pg_catalog.pg_collation co on co.oid = a.attcollation
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'tmpos_customer.customer'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`;
  assert.deepEqual(columns.map((r) => ({ ...r })), [
    { name: 'customer_id', type: 'uuid', collation: null, not_null: true, dflt: null },
    { name: 'tenant_id', type: 'uuid', collation: null, not_null: true, dflt: null },
    { name: 'name', type: 'text', collation: 'C', not_null: true, dflt: null },
    { name: 'phone', type: 'text', collation: 'C', not_null: false, dflt: null },
    { name: 'email', type: 'text', collation: 'C', not_null: false, dflt: null },
    { name: 'created_at', type: 'timestamp with time zone', collation: null, not_null: false, dflt: 'now()' },
  ]);
  const after = await surface(owner);
  assert.deepEqual(after.indexes, SURFACE_022.indexes, 'no index added: the profile read is a primary-key probe and the page order is unchanged');
  assert.deepEqual(after.constraints.filter((c) => !/^customer_(phone|email)_chk$/.test(c.name)), SURFACE_022.constraints, '017\'s constraints untouched');
  assert.deepEqual(after.constraints.map((c) => c.name).filter((n) => /^customer_(phone|email)_chk$/.test(n)), ['customer_email_chk', 'customer_phone_chk']);
  assert.equal(after.tableAcl, SURFACE_022.tableAcl, 'the table\'s ACL unchanged');
  // The profile of a legacy row: no contact, and no known creation time.
  assert.deepEqual(await profile(await mint(OWNER_A), LEGACY_A[0].id, T_A), [{
    o_outcome: 'customer', o_tenant_id: T_A, o_customer_id: LEGACY_A[0].id, o_name: LEGACY_A[0].name, o_phone: null, o_email: null, o_created_at: null,
  }]);
});

test('M7CN-03: the login executes 023\'s two routines and uses their schema, executes 020\'s create no longer, holds nothing on the table or its columns; no other runtime role executes either; the real preflight accepts the login and the ledger', async () => {
  const [p] = await owner`select
    pg_catalog.has_function_privilege('tmpos_app', ${CREATE}, 'EXECUTE') as app_create,
    pg_catalog.has_function_privilege('tmpos_app', ${PROFILE}, 'EXECUTE') as app_profile,
    pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_contact', 'USAGE') as app_usage,
    pg_catalog.has_function_privilege('tmpos_app', ${CREATE_020}, 'EXECUTE') as app_020,
    pg_catalog.has_function_privilege('tmpos_app', ${GET_022}, 'EXECUTE') as app_022,
    pg_catalog.has_function_privilege('tmpos_audit_writer', ${CREATE}, 'EXECUTE') as writer_create,
    pg_catalog.has_function_privilege('anon', ${PROFILE}, 'EXECUTE') as anon_profile,
    pg_catalog.has_function_privilege('authenticated', ${CREATE}, 'EXECUTE') as authenticated_create,
    pg_catalog.has_table_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as app_table,
    pg_catalog.has_any_column_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT, INSERT, UPDATE, REFERENCES') as app_columns`;
  assert.deepEqual({ ...p }, {
    app_create: true, app_profile: true, app_usage: true, app_020: false, app_022: true, writer_create: false, anon_profile: false,
    authenticated_create: false, app_table: false, app_columns: false,
  });
  const key = await mint(OWNER_A);
  assert.equal((await errorOf(runtime`select * from tmpos_role.m7a_customer_create(${key}::text, ${randomUUID()}::uuid, 'x'::text)`))?.code, '42501',
    '020\'s create is no longer the login\'s');
  for (const statement of ['select phone from tmpos_customer.customer limit 1', 'select count(*) from tmpos_customer.customer',
    `update tmpos_customer.customer set phone = '1' where false`]) {
    assert.equal((await errorOf(runtime.unsafe(statement)))?.code, '42501', statement);
  }
  const verdict = await rolledBack(RC, (tx) => preflightOn(tx));
  assert.deepEqual(verdict.value, PREFLIGHT_AT_023, `the P7 runtime refuses a 023 database: ${JSON.stringify(verdict)}`);
  const with024 = await rolledBack(RC, async (tx) => { await apply024(tx); return preflightOn(tx); });
  assert.deepEqual(with024.value, { runtimeLogin: [], migrationLedger: [] }, `023's grants with 024's applied: accepted (${JSON.stringify(with024)})`);
});

// ---------------------------------------------------------------------------
// M7CN-04..06: the create — the database's clock, the contacts, every refusal
// ---------------------------------------------------------------------------

test('M7CN-04: a create through 023 as the login stores the contacts as sent and the creating transaction\'s now() as created_at, between a clock read before and one after; a name-only create stores NULL contacts', async () => {
  const key = await mint(OWNER_A);
  const scope = await scopeOf(OWNER_A, T_A);
  const [{ before }] = await owner`select (extract(epoch from pg_catalog.clock_timestamp()) * 1000000)::bigint::text as before`;
  const id = randomUUID();
  let txNow;
  let answer;
  await runtime.begin(RC, async (tx) => {
    [{ now: txNow }] = await tx`select (extract(epoch from pg_catalog.now()) * 1000000)::bigint::text as now`;
    answer = await create(key, id, 'Ada Lovelace', '+1 555 0100', 'ada@example.test', tx);
  });
  const [{ after }] = await owner`select (extract(epoch from pg_catalog.clock_timestamp()) * 1000000)::bigint::text as after`;
  assert.deepEqual(answer, [{ o_tenant_id: T_A, o_actor_id: OWNER_A.id, o_membership_id: scope.membershipId }], '020\'s answer: the derived tenant, actor and grant');
  const row = await stored(id);
  assert.deepEqual({ tenant: row.tenant_id, name: row.name, phone: row.phone, email: row.email },
    { tenant: T_A, name: 'Ada Lovelace', phone: '+1 555 0100', email: 'ada@example.test' });
  assert.equal(row.created_us, txNow, 'created_at is the creating transaction\'s start (the column default), to the microsecond');
  assert.ok(BigInt(before) <= BigInt(row.created_us) && BigInt(row.created_us) <= BigInt(after), 'between the clock before and after');
  // Name-only, and each contact alone: absent is NULL, never ''.
  for (const [phone, email] of [[null, null], ['+44 20 7946 0958', null], [null, 'grace@example.test']]) {
    const nid = randomUUID();
    assert.equal((await create(key, nid, 'Grace Hopper', phone, email)).length, 1);
    const r = await stored(nid);
    assert.deepEqual([r.phone, r.email], [phone, email]);
    assert.ok(r.created_at instanceof Date && r.created_us !== null, 'a creation time from the database');
  }
  // Another tenant's key creates in ITS tenant only; the routine takes no tenant argument.
  const bid = randomUUID();
  assert.deepEqual((await create(await mint(OWNER_B), bid, 'Bo B', '1', null))[0].o_tenant_id, T_B);
  assert.equal((await stored(bid)).tenant_id, T_B);
});

/** Every contact class 023 refuses, as [label, phone, email]: each sent to the routine and to the column CHECKs. */
const REFUSED_CONTACTS = [
  ['an empty phone (absent is NULL, never \'\')', '', null], ['a phone with no digit', 'call me', null], ['a 65-character phone', '1'.repeat(65), null],
  ['a phone with a C0 control', `1${ch(0x1)}2`, null], ['a phone with a unit separator', `1${ch(0x1f)}2`, null], ['a phone with a tab inside', `1${ch(0x9)}2`, null],
  ['a phone with DEL', `1${ch(0x7f)}2`, null], ['a phone with a C1 control', `1${ch(0x85)}2`, null], ['a phone with APC', `1${ch(0x9f)}2`, null],
  ['a phone with LS', `1${ch(0x2028)}2`, null], ['a phone with PS', `1${ch(0x2029)}2`, null],
  ['a phone with a leading space', ' 1', null], ['a phone with a trailing NBSP', `1${ch(0xa0)}`, null], ['a phone with a leading BOM', `${ch(0xfeff)}1`, null],
  ['a phone with a trailing ideographic space', `1${ch(0x3000)}`, null],
  ...BIDI.map((c) => [`a phone with Bidi_Control U+${c.toString(16)}`, `1${ch(c)}2`, null]),
  ['an empty email', null, ''], ['an email with no @', null, 'ada.example.test'], ['an email with two @', null, 'a@b@example.test'],
  ['an email with an empty local part', null, '@example.test'], ['an email with an empty domain', null, 'ada@'], ['only @', null, '@'],
  ['a 255-character email', null, `${'a'.repeat(127)}@${'b'.repeat(127)}`], ['an email with a space', null, 'ada lovelace@example.test'],
  ['an email with a tab', null, `ada${ch(0x9)}@example.test`], ['an email with an NBSP', null, `ada${ch(0xa0)}@example.test`],
  ['an email with an ideographic space', null, `ada${ch(0x3000)}@example.test`], ['an email with an en quad', null, `ada${ch(0x2000)}@example.test`],
  ['an email with NEL', null, `ada${ch(0x85)}@example.test`], ['an email with a C0 control', null, `a${ch(0x1)}@b`], ['an email with DEL', null, `a${ch(0x7f)}@b`],
  ['an email with LS', null, `a${ch(0x2028)}@b`], ['an email with a trailing space', null, 'ada@example.test '], ['an email with a leading BOM', null, `${ch(0xfeff)}a@b`],
  ...BIDI.map((c) => [`an email with Bidi_Control U+${c.toString(16)}`, null, `a${ch(c)}@b`]),
];

test('M7CN-05: every refused contact class is refused by 023\'s routine (22023, the field named, never the value) and by the column CHECKs (23514), writing nothing; through the real tenant store a refused contact commits no customer, audit record or completion and leaves the lease, and a valid one commits all three with no contact in the audit row', async () => {
  const key = await mint(OWNER_A);
  const levelsBefore = (await owner`select count(*)::int as n from tmpos_role.tenant_role_level`)[0].n;
  for (const [label, phone, email] of REFUSED_CONTACTS) {
    const id = randomUUID();
    const err = await errorOf(create(key, id, 'Refused Contact', phone, email));
    assert.equal(err?.code, '22023', `${label}: ${JSON.stringify(err)}`);
    assert.match(err.message, phone !== null ? /^migration 023 create: the phone is not one the customer table admits$/ : /^migration 023 create: the email is not one the customer table admits$/, label);
    for (const value of [phone, email]) {
      if (value !== null && value.length > 2) assert.ok(!err.message.includes(value) && !String(err.detail ?? '').includes(value), `${label}: the value is never echoed`);
    }
    assert.equal(await stored(id), undefined, `${label}: no customer row`);
    // The column CHECK alone refuses it too, on a legacy row the owner updates (in a transaction that is rolled back).
    const checked = await rolledBack(RC, (tx) => tx`update tmpos_customer.customer set phone = ${phone}, email = ${email} where customer_id = ${LEGACY_A[1].id}`);
    assert.equal(checked.code, '23514', `${label}: the CHECK refuses it (${JSON.stringify(checked)})`);
  }
  assert.equal((await owner`select count(*)::int as n from tmpos_role.tenant_role_level`)[0].n, levelsBefore, 'not even 020\'s lock row: the contacts are judged first');
  // NUL cannot be sent as text at all: the server refuses the bind, and nothing is written.
  const nul = randomUUID();
  assert.ok((await errorOf(create(key, nul, 'Nul Contact', `1${ch(0)}2`, null))) !== null, 'NUL in a phone is refused before the routine');
  assert.equal(await stored(nul), undefined);
  // Every value the runtime admits at its bounds, the CHECKs admit too (the database never refuses what the runtime sends).
  for (const [label, phone, email] of [
    ['64 characters', `1${ch(0x1f4de).repeat(63)}`, null], ['254 characters', null, `${ch(0x1f600).repeat(126)}@${ch(0x1f600).repeat(127)}`],
    ['punctuation kept', '+44 (0)20 7946-0958 ext. 12', null], ['an internal NBSP in a phone', `555${ch(0xa0)}0100`, null],
    ['a ZWSP in an email', null, `a${ch(0x200b)}@b`], ['quotes and plus in an email', null, '"ada+x"@example.test'],
  ]) {
    const id = randomUUID();
    assert.equal((await create(key, id, 'Bound Contact', phone, email)).length, 1, label);
    assert.deepEqual([(await stored(id)).phone, (await stored(id)).email], [phone, email], label);
  }

  // Through the real tenant store's commit: fence, (stub) revalidator, CUSTOMER_CREATE_MUTATOR into 023, audit, completion.
  const store = createPostgresTransactionalStore({ client: RUNTIME_KERNEL, mutators: [CUSTOMER_CREATE_MUTATOR], contextScope: 'tenant', revalidate: async () => true });
  const events = defineOutboxEvents([]);
  const contract = defineCommands([CUSTOMER_CREATE_CONTRACT], events).contract(CUSTOMER_CREATE_CONTRACT.kind);
  const keyring = createIdempotencyKeyring(randomBytes(32));
  const context = await scopeOf(OWNER_A, T_A);
  /** Acquires a fresh key for `changes` and prepares the create exactly as the runtime does, its change set as given. */
  const preparedWith = async (changes) => {
    const id = randomUUID();
    const operation = keyring.operationOf(randomUUID(), OWNER_A.principal, {
      method: 'POST', path: '/api/v1/customers', audience: 'tenant', tenant: T_A, store: null, actor: OWNER_A.id, body: Buffer.from(JSON.stringify(changes)),
    });
    const lease = randomBytes(32).toString('base64url');
    const acquired = await store.idempotency.acquire({ scope: operation.scope, fingerprint: operation.fingerprint, lease, ...IDEMPOTENCY_POLICY }, signal());
    assert.deepEqual(acquired, { outcome: 'acquired', reclaimed: false });
    // The planner's own plan for a valid body, its change set replaced: the runtime would refuse these contacts first.
    const plan = { ...planCustomerCreate({ audience: 'tenant', body: { name: changes.name }, newAggregateId: id }), changes };
    const prepared = prepareCommand(contract, events, plan, {
      scope: operation.scope, lease, newAggregateId: id, authorization: Object.freeze({ scope: 'tenant', permission: 'create_customers' }),
      context, authNotAfter: null, sessionKey: key, seal: (envelope) => keyring.seal(envelope, operation),
    });
    assert.ok(prepared !== null, 'the change set is in contract (bounded clean strings)');
    return { id, scope: operation.scope, lease, command: prepared.command };
  };
  const recordOf = async (scope) => ({ ...(await owner`select lease, response is not null as completed from tmpos_internal.idempotency_record where scope = ${scope}`)[0] });
  const auditOf = async (requestId) => (await owner`select a.metadata::text as metadata, pg_catalog.row_to_json(a)::text as row
    from public.audit_event a where a.request_id = ${requestId}`).map((r) => ({ ...r }));
  // The contacts the runtime refuses but a hand-built change set can still carry (control characters never pass the record
  // schema): each rolls the whole command back.
  for (const [label, phone, email] of [
    ['a Bidi override in the phone', `1${ch(0x202e)}2`, ''], ['a phone with no digit', 'call me', ''], ['a 65-character phone', '1'.repeat(65), ''],
    ['an email with a space', '', 'ada lovelace@example.test'], ['an email with two @', '', 'a@b@example.test'], ['an email with an NBSP', '', `a${ch(0xa0)}@b`],
  ]) {
    const p = await preparedWith({ name: 'Store Refused', phone, email });
    const before = await recordOf(p.scope);
    assert.deepEqual(await store.transactions.commit(p.command, signal()), { outcome: 'unavailable' }, label);
    assert.equal(await stored(p.id), undefined, `${label}: no customer`);
    assert.deepEqual(await auditOf(p.command.audit.correlationId), [], `${label}: no audit record`);
    assert.deepEqual(await recordOf(p.scope), before, `${label}: no completion, and the attempt's lease unchanged`);
    assert.equal(before.completed, false);
  }
  const ok = await preparedWith({ name: 'Store Created', phone: '+1 555 0100', email: 'ada@example.test' });
  assert.deepEqual(await store.transactions.commit(ok.command, signal()), { outcome: 'committed' });
  const row = await stored(ok.id);
  assert.deepEqual([row.tenant_id, row.name, row.phone, row.email], [T_A, 'Store Created', '+1 555 0100', 'ada@example.test']);
  assert.ok(row.created_at instanceof Date, 'the creation time the database wrote');
  const [audit] = await auditOf(ok.command.audit.correlationId);
  assert.equal(audit.metadata, '{}', 'audit metadata stays {}');
  for (const value of ['555 0100', 'ada@example.test', 'example.test', 'Store Created']) assert.ok(!audit.row.includes(value), `the audit row carries no ${value}`);
  assert.equal((await recordOf(ok.scope)).completed, true, 'the completion committed with the customer');
  // A name-only change set binds NULL contacts ('' is absent).
  const nameOnly = await preparedWith({ name: 'Store Name Only', phone: '', email: '' });
  assert.deepEqual(await store.transactions.commit(nameOnly.command, signal()), { outcome: 'committed' });
  assert.deepEqual([(await stored(nameOnly.id)).phone, (await stored(nameOnly.id)).email], [null, null]);
});

test('M7CN-06: every refusal 020\'s create makes is 023\'s too — no row, nothing written — and a store owner creates through both (control)', async () => {
  /** 020's create for the same arguments, as the owner (023 revokes it from the login), in a transaction rolled back. */
  const as020 = async (key, id) => (await rolledBack(RC, async (tx) => (await tx`select o_tenant_id, o_actor_id, o_membership_id
    from tmpos_role.m7a_customer_create(${key}::text, ${id}::uuid, 'Parity'::text)`).length)).value;
  const fresh = async (label, role, status = 'active') => {
    const tenant = await newTenant(label, status);
    const who = await actor(label, [{ tenant, role }]);
    return { tenant, who, key: await mint(who) };
  };
  const cases = [
    ['an unknown key', async () => ({ key: newKey() })],
    ['a revoked session', async () => { const f = await fresh('revoked', 'manager'); await runtime`select tmpos_session.m5_session_revoke(${f.key}::text)`; return f; }],
    ['an expired session', async () => { const f = await fresh('expired', 'manager'); const key = await mint(f.who, 1_000); await new Promise((r) => setTimeout(r, 1_200)); return { ...f, key }; }],
    ['a technician (View by default)', () => fresh('technician', 'technician')],
    ['sales_staff narrowed to View', async () => {
      const f = await fresh('narrowed', 'sales_staff');
      await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${f.tenant}, 'sales_staff', 'customers', 'view', now())`;
      return f;
    }],
    ['a read_only tenant', () => fresh('read-only', 'store_owner', 'read_only')],
    ['a suspended account', async () => { const f = await fresh('suspended', 'manager'); await owner`update app_user set status = 'suspended' where internal_user_id = ${f.who.id}`; return f; }],
  ];
  for (const [label, arrange] of cases) {
    const f = await arrange();
    const id = randomUUID();
    const levels = (await owner`select count(*)::int as n from tmpos_role.tenant_role_level`)[0].n;
    assert.deepEqual(await create(f.key, id, 'Parity', '+1 555 0100', 'ada@example.test'), [], `${label}: 023 answers no row`);
    assert.equal(await stored(id), undefined, `${label}: no customer`);
    assert.equal((await owner`select count(*)::int as n from tmpos_role.tenant_role_level`)[0].n, levels, `${label}: no lock row`);
    assert.equal(await as020(f.key, randomUUID()), 0, `${label}: 020 answers no row for the same key`);
  }
  const key = await mint(OWNER_A);
  assert.equal(await as020(key, randomUUID()), 1, 'store_owner: 020 creates (control, rolled back)');
  assert.equal((await create(key, randomUUID(), 'Parity', null, null)).length, 1, 'store_owner: 023 creates (control)');
  // A duplicate id is 020's unique_violation, raised again through 023 with 020's fixed message.
  const dup = randomUUID();
  await create(key, dup, 'Dup', null, null);
  const again = await errorOf(create(key, dup, 'Dup', '1', null));
  assert.deepEqual([again?.code, again?.message], ['23505', 'migration 020 create: the customer id is already taken']);
  assert.equal((await stored(dup)).phone, null, 'the first row is unchanged');
});

// ---------------------------------------------------------------------------
// M7CN-07: the profile read
// ---------------------------------------------------------------------------

test('M7CN-07: the profile read answers the contacts and the creation time in toISOString\'s form; legacy NULL; foreign and missing the same row; wrong tenant, unknown and revoked keys denied; every outcome 022\'s; reads write nothing', async () => {
  const key = await mint(OWNER_A);
  const id = randomUUID();
  await create(key, id, 'Profile Owner', '+1 555 0100', 'ada@example.test');
  const row = await stored(id);
  const [own] = await profile(key, id, T_A);
  assert.deepEqual({ ...own, o_created_at: null }, {
    o_outcome: 'customer', o_tenant_id: T_A, o_customer_id: id, o_name: 'Profile Owner', o_phone: '+1 555 0100', o_email: 'ada@example.test', o_created_at: null,
  });
  assert.match(own.o_created_at, ISO_RE, 'YYYY-MM-DDTHH:mm:ss.sssZ');
  assert.equal(new Date(own.o_created_at).toISOString(), own.o_created_at, 'the text is toISOString\'s own form');
  assert.equal(BigInt(Date.parse(own.o_created_at)), BigInt(row.created_us) / 1000n, 'the stored instant, to the millisecond');
  // Missing and foreign: the same row from the same statement.
  const foreignId = randomUUID();
  await create(await mint(OWNER_B), foreignId, 'Foreign', '1', null);
  const foreign = await profile(key, foreignId, T_A);
  const missing = await profile(key, randomUUID(), T_A);
  assert.deepEqual(foreign, [{ o_outcome: 'not_found', ...PROFILE_NULLS }]);
  assert.deepEqual(missing, foreign, 'a missing id: the byte-identical row');
  assert.deepEqual(await profile(key, LEGACY_B[0].id, T_A), foreign, 'a foreign legacy id: the same row');
  // Denied: a wrong expected tenant (before any customer is read), an unknown key, a revoked session; invalid arguments.
  for (const [label, k, cid, t] of [['asserting B', key, id, T_B], ['asserting B for B\'s id', key, foreignId, T_B], ['an unknown key', newKey(), id, T_A]]) {
    assert.deepEqual(await profile(k, cid, t), [{ o_outcome: 'denied', ...PROFILE_NULLS }], label);
  }
  const revoked = await mint(OWNER_A);
  assert.equal((await profile(revoked, id, T_A))[0].o_outcome, 'customer', 'live (control)');
  await runtime`select tmpos_session.m5_session_revoke(${revoked}::text)`;
  assert.deepEqual(await profile(revoked, id, T_A), [{ o_outcome: 'denied', ...PROFILE_NULLS }], 'a revoked session reads nothing');
  for (const [label, k, cid, t] of [['a null key', null, id, T_A], ['a key with a space', 'a b', id, T_A], ['a null id', key, null, T_A], ['a null tenant', key, id, null]]) {
    assert.deepEqual(await profile(k, cid, t), [{ o_outcome: 'invalid', ...PROFILE_NULLS }], label);
  }
  // Parity: for every input above, the outcome is 022's.
  for (const [k, cid, t] of [[key, id, T_A], [key, foreignId, T_A], [key, id, T_B], [newKey(), id, T_A], [revoked, id, T_A], [key, LEGACY_A[0].id, T_A]]) {
    assert.equal((await profile(k, cid, t))[0].o_outcome, (await detail(k, cid, t))[0].o_outcome, `${cid} as ${t}`);
  }
  // The production profile adapter and its probe read 024's versioned profile since M7A-CUSTOMERS-P7, a routine this file
  // keeps out while it proves 023: they are proven over the real login in tests/db/customerEdit.integration.test.mjs (M7CE-10).
  // Reads write nothing.
  const counts = async () => ({ ...(await owner`select
    (select count(*) from public.audit_event)::int as audit,
    (select count(*) from tmpos_internal.idempotency_record)::int as idempotency,
    (select count(*) from tmpos_customer.customer)::int as customers,
    (select count(*) from tmpos_role.tenant_role_level)::int as levels`)[0] });
  const before = await counts();
  for (const cid of [id, foreignId, randomUUID(), LEGACY_A[0].id]) await profile(key, cid, T_A);
  await profile(newKey(), id, T_A);
  assert.deepEqual(await counts(), before);
});

// ---------------------------------------------------------------------------
// M7CN-08: rollback — refused over data, exact without it, re-applied; out of order fail closed
// ---------------------------------------------------------------------------

test('M7CN-08: committed, 023\'s down refuses while any customer holds a contact or a creation time and changes nothing; without them it leaves exactly the 001-022 surface (020\'s create granted back) and a byte-identical, accepted re-apply; with 020 rolled back first it refuses', async () => {
  const applied = await routineState(owner);
  const appliedSurface = await surface(owner);
  assert.ok((await owner`select count(*)::int as n from tmpos_customer.customer where created_at is not null`)[0].n > 0, 'customers created through 023 exist');
  // Committed: refused, and nothing changed.
  const refused = await errorOf(owner.begin(RC, (tx) => tx.unsafe(DOWN_023).simple()));
  assert.equal(refused?.code, '55000', JSON.stringify(refused));
  assert.match(refused.message, /^migration 023 rollback refused: a customer holds a phone, an email or a creation time, and a rollback never discards customer data$/);
  assert.deepEqual(await surface(owner), appliedSurface, 'the refused rollback changed nothing');
  assert.deepEqual(await routineState(owner), applied);
  // The guard sees a contact alone, and a creation time alone (in transactions rolled back).
  for (const [label, set] of [['a phone alone', 'phone = \'1\''], ['an email alone', 'email = \'a@b\''], ['a creation time alone', 'created_at = now()']]) {
    const out = await rolledBack(RC, async (tx) => {
      await tx`update tmpos_customer.customer set phone = null, email = null, created_at = null`;
      await tx.unsafe(`update tmpos_customer.customer set ${set} where customer_id = '${LEGACY_A[0].id}'`);
      await tx.unsafe(DOWN_023).simple();
    });
    assert.equal(out.code, '55000', `${label}: ${JSON.stringify(out)}`);
  }
  // REPEATABLE READ is refused before the data is looked at (its snapshot could predate the lock).
  const rr = await rolledBack('isolation level repeatable read', (tx) => tx.unsafe(DOWN_023).simple());
  assert.equal(rr.code, '55000');
  assert.match(rr.message, /READ COMMITTED/);
  // With no contact and no creation time (cleared inside the transaction, which is rolled back): exactly 001-022.
  const alone = await rolledBack(RC, async (tx) => {
    await tx`update tmpos_customer.customer set phone = null, email = null, created_at = null`;
    await tx.unsafe(DOWN_023).simple();
    const down = { surface: await surface(tx), preflight: await preflightOn(tx),
      app020: (await tx`select pg_catalog.has_function_privilege('tmpos_app', ${CREATE_020}, 'EXECUTE') as e`)[0].e };
    await tx.unsafe(UP_023).simple();
    return { down, reapplied: await routineState(tx), reappliedSurface: await surface(tx), up: await preflightOn(tx) };
  });
  assert.ok(alone.value !== undefined, JSON.stringify(alone));
  assert.deepEqual(alone.value.down.surface, SURFACE_022, 'rolled back alone: exactly the surface captured on 001-022 — schemas, routines, ACLs, columns, constraints, indexes');
  assert.equal(alone.value.down.app020, true, 'tmpos_app executes 020\'s create again');
  // The ledger still records 023 here (a file run, not a ledger rollback): the grants are judged — 023's missing, 020's back.
  assert.deepEqual(alone.value.down.preflight.runtimeLogin, ['role_privilege_missing', 'role_privilege_unexpected'], JSON.stringify(alone.value.down.preflight));
  assert.deepEqual(alone.value.reapplied, applied, 're-applied: the same definitions, configuration and ACLs');
  assert.deepEqual(alone.value.reappliedSurface.routines, appliedSurface.routines);
  assert.deepEqual(alone.value.reappliedSurface.columns, appliedSurface.columns);
  assert.deepEqual(alone.value.up, PREFLIGHT_AT_023, 're-applied: exactly the 023 database (the P7 runtime needs 024 as well)');
  // Out of order: 020 rolled back under 023 (its own guard cleared first) — 023's create raises at call, and 023's down
  // refuses until 020 is applied again; then it rolls back.
  // Minted first, on the login's own connection: the transaction below holds 020's tables, which the mint would wait on.
  const key = await mint(OWNER_A);
  const outOfOrder = await rolledBack(RC, async (tx) => {
    await tx`delete from tmpos_role_edit.role_level_version`;
    await tx`delete from tmpos_role.tenant_role_level`;
    await tx`update tmpos_customer.customer set phone = null, email = null, created_at = null`;
    await tx.unsafe(DOWN_020).simple();
    const raised = (await asRuntime(tx, (sp) => create(key, randomUUID(), 'Out Of Order', null, null, sp))).code ?? null;
    const down = await tx.savepoint((sp) => sp.unsafe(DOWN_023).simple()).then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
    await tx.unsafe(UP_020).simple();
    await tx.unsafe(DOWN_023).simple();
    return { raised, down, gone: (await tx`select pg_catalog.to_regnamespace('tmpos_customer_contact') is null as g`)[0].g };
  });
  assert.ok(outOfOrder.value !== undefined, JSON.stringify(outOfOrder));
  assert.match(String(outOfOrder.value.raised), /^(42883|3F000|42P01)$/, `023's create raises on the missing routine: ${outOfOrder.value.raised}`);
  assert.equal(outOfOrder.value.down?.code, '55000');
  assert.match(outOfOrder.value.down.message, /roll 023 back before 020/);
  assert.equal(outOfOrder.value.gone, true, '020 re-applied: 023 rolls back');
  assert.deepEqual(await routineState(owner), applied, 'every proof above was rolled back: 023 is as applied');
});

// ---------------------------------------------------------------------------
// M7CN-09: ACCESS-CONTROL PARITY of the profile read — AC-5 at the routine, beyond the owner key
// ---------------------------------------------------------------------------

test('M7CN-09: PROFILE PARITY — every standing, grant, level and tenant failure 022\'s read refuses is refused by the profile read with the same outcome and no contact, creation time or name; a read-only tenant, which 022 serves, is served with the contacts', async () => {
  const PHONE = '+1 555 0100';
  /** A fresh tenant with one customer that HAS a phone, an email and a creation time, and one actor of `role`, minted: what each case mutates alone. */
  const fresh = async (label, role, status = 'active') => {
    const tenant = await newTenant(`p9-${label}`, status); // p9-: no label of another test's fixtures
    const id = randomUUID();
    const email = `${label}-${SUFFIX}@example.test`;
    await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, phone, email)
      values (${id}, ${tenant}, ${`${label} ${SUFFIX}`}, ${PHONE}, ${email})`;
    assert.ok((await stored(id)).created_at !== null, `${label}: the customer holds a creation time, so a null one in an answer is the routine's`);
    const who = await actor(`p9-${label}`, [{ tenant, role }]);
    const key = await mint(who);
    // The control every case below changes alone: before its change the profile read answers the customer with its contacts.
    const [live] = await profile(key, id, tenant);
    assert.deepEqual([live.o_outcome, live.o_phone, live.o_email], ['customer', PHONE, email], `${label}: reads its contacts before the change (control)`);
    return { label, tenant, id, email, who, key };
  };
  /** The two reads for one fixture, as the runtime login. */
  const both = async (f) => ({ profile: await profile(f.key, f.id, f.tenant), detail: await detail(f.key, f.id, f.tenant) });
  const narrow = (role) => async () => {
    const f = await fresh(`narrow-${role}`, role);
    await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${f.tenant}, ${role}, 'customers', 'none', now())`;
    return f;
  };
  const refusals = [
    ['a technician narrowed to none', narrow('technician')],
    ['a manager narrowed to none', narrow('manager')],
    ['a sales_staff narrowed to none', narrow('sales_staff')],
    ['the account suspended', async () => {
      const f = await fresh('suspended-acct', 'technician');
      await owner`update app_user set status = 'suspended' where internal_user_id = ${f.who.id}`;
      return f;
    }],
    ['the tenant suspended', async () => {
      const f = await fresh('t-suspended', 'manager');
      await owner`update tenant set status = 'suspended' where tenant_id = ${f.tenant}`;
      return f;
    }],
    ['the tenant pending activation', async () => {
      const f = await fresh('t-pending', 'manager');
      await owner`update tenant set status = 'pending_activation' where tenant_id = ${f.tenant}`;
      return f;
    }],
    ['the security version bumped', async () => {
      const f = await fresh('sv', 'technician');
      await owner`update app_user set updated_at = updated_at + interval '1 second' where internal_user_id = ${f.who.id}`;
      return f;
    }],
    ['the membership role changed', async () => {
      const f = await fresh('role-changed', 'manager');
      await owner`update user_membership set role_id = 'sales_staff' where internal_user_id = ${f.who.id}`;
      return f;
    }],
  ];
  for (const [label, arrange] of refusals) {
    const f = await arrange();
    const { profile: p, detail: d } = await both(f);
    assert.equal(p.length, 1, `${label}: exactly one row`);
    assert.equal(p[0].o_outcome, d[0].o_outcome, `${label}: the profile read's outcome is 022's`);
    assert.equal(p[0].o_outcome, 'denied', label);
    // ALL contact, time and identity columns are null: nothing of the customer leaves with a refusal.
    assert.deepEqual(p, [{ o_outcome: 'denied', ...PROFILE_NULLS }], label);
    for (const column of ['o_phone', 'o_email', 'o_created_at', 'o_name']) assert.equal(p[0][column], null, `${label}: ${column}`);
  }
  // Served by both: a read-only tenant (a read is admitted there, as 022's and the list's are), and each role's default.
  const served = [['a read-only tenant', await fresh('read-only', 'store_owner', 'read_only')]];
  for (const role of ['manager', 'technician', 'sales_staff']) served.push([`${role} at its default`, await fresh(`default-${role}`, role)]);
  for (const [label, f] of served) {
    const { profile: p, detail: d } = await both(f);
    assert.equal(p[0].o_outcome, d[0].o_outcome, `${label}: parity`);
    assert.deepEqual({ ...p[0], o_created_at: null }, {
      o_outcome: 'customer', o_tenant_id: f.tenant, o_customer_id: f.id, o_name: `${f.label} ${SUFFIX}`, o_phone: PHONE, o_email: f.email, o_created_at: null,
    }, `${label}: served with its contacts`);
    assert.match(p[0].o_created_at, ISO_RE, label);
  }
});
