// Phase 4.0 M7A-CUSTOMERS-P4 — the tenant customer detail read against REAL PostgreSQL: migration 022 (schema
// tmpos_customer_detail: one STABLE SECURITY DEFINER routine, m7a_customer_get(session key, customer id, expected tenant)),
// exercised as the runtime's own non-owner login (tmpos_app + tmpos_audit_writer). This file proves the database half and
// the production adapter over it; the HTTP route — its 400/401/403/404 chain, the parked revocation and the compiled entry —
// is tests/db/tenantEntry.integration.test.mjs's (M7TE-14, M7TE-C1).
//
// WHAT IS PROVEN. 001-028 applied clean with 022's checksum the sha256 of its up bytes; 022's postcondition re-proven over the
// applied state and refusing the widenings it names; a second apply refused (M7CD-01). The login EXECUTEs the routine and
// uses its schema, reads nothing of 017's table or page directly, and tmpos_audit_writer, anon and authenticated execute
// nothing; the real startup preflight accepts the login and the ledger (M7CD-02). The routine's answers: own customer; another
// tenant's id and a random id the SAME ('not_found', nulls) row; a null or malformed argument 'invalid'; an unknown key
// 'denied'; a key of tenant A asserting tenant B 'denied' before any customer is read, hit or miss; a revoked session
// 'denied' (M7CD-03). LIST PARITY: every refusal page_v3 makes is one here too, and every read it serves is served here
// (M7CD-04). A timing sanity bound, cold and warm — NOT a constant-time claim: a foreign id's probe visits one heap tuple a
// missing id's does not (doc 08) (M7CD-05). The production adapter over the real login: the three answers, its probe true,
// and with EXECUTE withdrawn its probe false and its read a throw (M7CD-06). Reads write nothing (M7CD-07). Rollback: 022
// down alone leaves exactly the 001-021 grants (the preflight names only missing grants) and a re-apply is byte-identical in
// definition and ACL; with a 021 version row present 022 still rolls back while 021 refuses; the ledger's newest-first
// rollBackAbove('020') answers ['028', '027', '026', '025', '024', '023', '022', '021'] and restores all five (M7CD-08; M7A-CUSTOMERS-P6, -P7 and
// -P8: 023, 024 and 025 sit above 022; M5-INVOICES-AUTH-P1 and M7B-INVOICES-P1: 026, 027 and 028 above those); out of order, 020 rolled back under 021 and 022
// leaves the routine RAISING at call and the adapter throwing (a 503, fail closed), 022's rollback refusing until 020 is back,
// and the supported order 022, 021, 020 succeeding (M7CD-09).
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster
// this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is
// synthetic and randomly suffixed, every issuer key and session key is random bytes made here, and every privilege
// widening or out-of-order rollback runs in a transaction that is rolled back. It leaves the shared service as it found it:
// 022 applied, the issuer key row it found, no customer, session, ledger, role-level or version row of its own, its tenants'
// statuses back to active, and its login dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { rollBackAbove } from './migrationsThrough.mjs';
import { REQUIRED_MIGRATIONS, createPostgresStartupPreflight } from '../../server/persistence/postgresStartupPreflight.ts';
import { createPostgresCustomerDetail, probeCustomerDetail } from '../../server/persistence/postgresCustomerDirectory.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_022 = readFileSync(`${MIG_DIR}/022_m7a_customer_detail.up.sql`, 'utf8');
const DOWN_022 = readFileSync(`${MIG_DIR}/022_m7a_customer_detail.down.sql`, 'utf8');
const DOWN_023 = readFileSync(`${MIG_DIR}/023_m7a_customer_contact.down.sql`, 'utf8');
const DOWN_024 = readFileSync(`${MIG_DIR}/024_m7a_customer_edit.down.sql`, 'utf8');
const DOWN_025 = readFileSync(`${MIG_DIR}/025_m7a_customer_search.down.sql`, 'utf8');
const DOWN_026 = readFileSync(`${MIG_DIR}/026_m5_invoice_role_levels.down.sql`, 'utf8');
/** M7B-INVOICES-P1: 027 (store discovery) sits above 026 and rolls back first. */
const DOWN_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.down.sql`, 'utf8');
/** M7B-INVOICES-P1: 028 (invoice drafts) sits above 027 and rolls back before it. */
const DOWN_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.down.sql`, 'utf8');
const DOWN_021 = readFileSync(`${MIG_DIR}/021_m7a_role_level_precondition.down.sql`, 'utf8');
const UP_020 = readFileSync(`${MIG_DIR}/020_m7a_tenant_role_levels.up.sql`, 'utf8');
const DOWN_020 = readFileSync(`${MIG_DIR}/020_m7a_tenant_role_levels.down.sql`, 'utf8');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_022 = UP_022.slice(UP_022.lastIndexOf('do $$'));
const GET = 'tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)';
const PAGE_017 = 'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)';
const PAGE_V3 = 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7cd-migrator', runtimeRef: 'm7cd-runtime' };
const LOCK_KEY = 528_529;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7cd_probe';
const HOUR = 3_600_000;
const ROLLBACK = new Error('m7cd: roll the proof back');
const RC = 'isolation level read committed';
const NULLS = Object.freeze({ o_tenant_id: null, o_customer_id: null, o_name: null });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = () => AbortSignal.timeout(10_000);

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

const TARGET = resolveDisposableTarget('M7CD');
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
  if (TENANTS.length > 0) await quietly(() => owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`);
  if (TENANTS.length > 0) await quietly(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
  if (TENANTS.length > 0) await quietly(() => owner`update tenant set status = 'active' where tenant_id = any(${TENANTS}::uuid[]) and status <> 'active'`);
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
// setup: every migration in the directory (001-028), a real non-owner runtime login, the key installed by the owner
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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7cd-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
/** A synthetic actor: an identity, an active account, and the given tenant grants. */
async function actor(label, grants) {
  const uid = `m7cd-${label}-${SUFFIX}`;
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
async function seed(tenant, names) {
  const rows = names.map((name) => ({ customer_id: randomUUID(), tenant_id: tenant, name }));
  await owner`insert into tmpos_customer.customer ${owner(rows, 'customer_id', 'tenant_id', 'name')}`;
  return rows.map((r) => ({ id: r.customer_id, name: r.name }));
}

const record = (who, audience = 'tenant', at = Date.now()) => ({
  audience, authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:m7cd', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
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
/** An ADMINISTRATIVE session for `who` (018's admin branch takes no proof): minted, live, of the wrong audience. */
async function mintAdmin(who) {
  const key = newKey();
  const r = record(who, 'admin');
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, 'admin'::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${r.createdAt + HOUR}::bigint, null::bytea) as outcome`;
  assert.equal(outcome, 'created', 'an administrative session row');
  return key;
}

/** 022's read, as the runtime login (or on `db`): its rows, plain. A raise rejects. */
const get = async (key, id, expected, db = runtime) =>
  (await db`select o_outcome, o_tenant_id, o_customer_id, o_name
    from tmpos_customer_detail.m7a_customer_get(${key}::text, ${id}::uuid, ${expected}::uuid)`).map((r) => ({ ...r }));
/** The one outcome word 022 answers, requiring exactly one row. */
const outcomeOf = async (key, id, expected) => {
  const rows = await get(key, id, expected);
  assert.equal(rows.length, 1, 'always exactly one row');
  return rows[0].o_outcome;
};
/** page_v3's first outcome word for `key` (the list's read), as the runtime login. */
const pageOutcome = async (key) =>
  (await runtime`select o_outcome from tmpos_role.m7a_customer_page_v3(${key}::text, null::uuid, 2::integer)`)[0]?.o_outcome;

const errorOf = (p) => p.then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
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
/** A kernel over one transaction, each call in its own savepoint, as whoever the caller set the authorization to. */
const kernelOn = (tx) => Object.freeze({ transaction: (_s, _b, work) => tx.savepoint((sp) => work(sp)), end: async () => {} });
/** A kernel over the runtime login's own pool: one transaction per call, as the supervised kernel runs it. */
const RUNTIME_KERNEL = Object.freeze({ transaction: (_s, _b, work) => runtime.begin((tx) => work(tx)), end: async () => {} });
/**
 * `fn` as the runtime login, in a savepoint of `tx` that is always rolled back — so the authorization (SET LOCAL survives a
 * released savepoint) and anything `fn` did are undone. Answers { value } or the { code, message } it raised.
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
/** The real startup preflight's login and ledger answers, as the runtime login, on `tx`'s state. */
const preflightOn = async (tx) => (await asRuntime(tx, async (sp) => {
  const preflight = createPostgresStartupPreflight({ client: { transaction: (_s, _b, fn) => fn(sp), end: async () => {} } });
  return { runtimeLogin: await preflight.runtimeLogin(signal()), migrationLedger: await preflight.migrationLedger(signal()) };
})).value;
/** The routine's definition, configuration and ACL, as one comparable value. */
const routineState = async (db) => ({ ...(await db`select pg_catalog.md5(p.prosrc) as src, p.proconfig::text as config,
  p.proacl::text as acl, p.provolatile as volatility, p.prosecdef as definer from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure(${GET})`)[0] });

const T_A = await newTenant('a');
const T_B = await newTenant('b');
const T_RO = await newTenant('read-only', 'read_only');
const OWNER_A = await actor('owner-a', [{ tenant: T_A, role: 'store_owner' }]);
const OWNER_RO = await actor('owner-ro', [{ tenant: T_RO, role: 'store_owner' }]);
const SEED_A = await seed(T_A, [`Ada ${SUFFIX}`, `Grace ${SUFFIX}`]);
const SEED_B = await seed(T_B, Array.from({ length: 24 }, (_, i) => `B ${i} ${SUFFIX}`));
const [SEED_RO] = await seed(T_RO, [`Ro ${SUFFIX}`]);

// ---------------------------------------------------------------------------
// M7CD-01..02: the migration and the login's privileges
// ---------------------------------------------------------------------------

test('M7CD-01: 001-028 applied clean, 022\'s checksum its up bytes; its postcondition holds and refuses the widenings it names; a second apply is refused', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 28 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'the ledger records the pinned chain');
  assert.equal(ledger[21].checksum, createHash('sha256').update(readFileSync(`${MIG_DIR}/022_m7a_customer_detail.up.sql`)).digest('hex'));
  assert.equal((await rolledBack(RC, (tx) => tx.unsafe(POSTCONDITION_022).simple())).code, undefined, 'the postcondition holds as applied');
  for (const [label, widen, pattern] of [
    ['a table grant', 'grant select on tmpos_customer.customer to tmpos_app', /holds a privilege on tmpos_customer\.customer/],
    ['017\'s page granted', `grant execute on function ${PAGE_017} to tmpos_app`, /can execute 017's page/],
    ['EXECUTE to the audit writer', `grant execute on function ${GET} to tmpos_audit_writer`, /unexpected direct grant/],
    ['EXECUTE to PUBLIC', `grant execute on function ${GET} to public`, /unexpected direct grant/],
    ['a grantable EXECUTE', `grant execute on function ${GET} to tmpos_app with grant option`, /unexpected direct grant/],
    ['USAGE to the audit writer', 'grant usage on schema tmpos_customer_detail to tmpos_audit_writer', /carries an unexpected grant/],
    ['a second routine', 'create function tmpos_customer_detail.extra() returns integer language sql as $$ select 1 $$', /exactly the one routine/],
    ['a table beside it', 'create table tmpos_customer_detail.extra (x integer)', /exactly the one routine/],
  ]) {
    const out = await rolledBack(RC, async (tx) => {
      await tx.unsafe(widen);
      await tx.unsafe(POSTCONDITION_022).simple();
    });
    assert.equal(out.code, '55000', `${label}: ${JSON.stringify(out)}`);
    assert.match(out.message, pattern, label);
  }
  const again = await rolledBack(RC, (tx) => tx.unsafe(UP_022).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /migration 022 refused: schema tmpos_customer_detail already exists/);
});

test('M7CD-02: the login executes 022\'s routine and uses its schema and nothing of 017\'s; no other runtime role executes it; the real preflight accepts the login and the ledger', async () => {
  const [p] = await owner`select
    pg_catalog.has_function_privilege('tmpos_app', ${GET}, 'EXECUTE') as app_get,
    pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_detail', 'USAGE') as app_usage,
    pg_catalog.has_function_privilege('tmpos_audit_writer', ${GET}, 'EXECUTE') as writer_get,
    pg_catalog.has_function_privilege('anon', ${GET}, 'EXECUTE') as anon_get,
    pg_catalog.has_function_privilege('authenticated', ${GET}, 'EXECUTE') as authenticated_get,
    pg_catalog.has_function_privilege('tmpos_app', ${PAGE_017}, 'EXECUTE') as app_017,
    pg_catalog.has_table_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as app_table`;
  assert.deepEqual({ ...p }, { app_get: true, app_usage: true, writer_get: false, anon_get: false, authenticated_get: false, app_017: false, app_table: false });
  assert.equal(await outcomeOf(newKey(), randomUUID(), T_A), 'denied', 'the login calls it');
  assert.equal(await codeOf(runtime`select count(*) from tmpos_customer.customer`), '42501', 'no direct read of 017\'s table');
  assert.equal(await codeOf(runtime`select * from tmpos_customer.m7a_customer_page(${OWNER_A.id}::uuid, 'x'::text, ${randomUUID()}::uuid,
    'store_owner'::text, ${T_A}::uuid, null::uuid, 1::integer)`), '42501', 'no direct call of 017\'s page');
  const verdict = await rolledBack(RC, (tx) => preflightOn(tx));
  assert.deepEqual(verdict.value, { runtimeLogin: [], migrationLedger: [] }, JSON.stringify(verdict));
});

test('M7CD-02b: indirect paths — a carrier role (INHERIT TRUE; INHERIT FALSE, SET TRUE; a carrier of EXECUTE) or a direct grant — are refused by 022\'s postcondition on the roles it names and by the real startup preflight on the runtime login', async () => {
  const [{ v }] = await owner`select pg_catalog.current_setting('server_version_num')::integer as v`;
  const setOption = v >= 160000;
  if (!setOption) console.log(`# M7CD-02b: server_version_num ${v} < 160000 has no per-grant INHERIT/SET options: the INHERIT FALSE, SET TRUE cases are skipped`);
  else assert.ok(v >= 160000);
  const CARRIER = `m7cd_carrier_${SUFFIX.replace(/-/g, '')}`;
  /**
   * `setup` (with CARRIER created first) in a transaction that is always rolled back — the carrier role and every grant with
   * it: 022's postcondition as the owner, then the real preflight as the runtime login, on that uncommitted state.
   */
  const judge = async (setup) => {
    const out = await rolledBack(RC, async (tx) => {
      await tx.unsafe(`create role ${CARRIER} nologin`);
      for (const statement of setup) await tx.unsafe(statement);
      const postcondition = await tx.savepoint((sp) => sp.unsafe(POSTCONDITION_022).simple())
        .then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
      return { postcondition, preflight: (await preflightOn(tx)).runtimeLogin };
    });
    assert.ok(out.value !== undefined, JSON.stringify(out));
    return out.value;
  };
  const SELECT = `grant select on tmpos_customer.customer to ${CARRIER}`;
  const EXEC_017 = `grant execute on function ${PAGE_017} to ${CARRIER}`;
  const EXEC_GET = `grant execute on function ${GET} to ${CARRIER}`;
  try {
    // (1) THROUGH A RUNTIME ROLE 022's postcondition names: each refused by the postcondition AND the preflight. (A carrier
    //     of EXECUTE on 022's own routine is caught first by its ACL check (c), before the membership walk (e).)
    const viaRoles = [
      ['a SELECT carrier in tmpos_app, INHERIT TRUE', [SELECT, `grant ${CARRIER} to tmpos_app with inherit true`], /holds a privilege on tmpos_customer\.customer/],
      ...(setOption ? [['a SELECT carrier in tmpos_app, INHERIT FALSE, SET TRUE', [SELECT, `grant ${CARRIER} to tmpos_app with inherit false, set true`],
        /holds a privilege on tmpos_customer\.customer/]] : []),
      ['a carrier of EXECUTE on 017\'s page in tmpos_app', [EXEC_017, `grant ${CARRIER} to tmpos_app with inherit true`], /can execute 017's page/],
      ['a carrier of EXECUTE on 022\'s read in tmpos_audit_writer', [EXEC_GET, `grant ${CARRIER} to tmpos_audit_writer with inherit true`],
        /unexpected direct grant remains on the tmpos_customer_detail routine|other than tmpos_app can execute/],
      ...(setOption ? [['a carrier of EXECUTE on 022\'s read in tmpos_audit_writer, INHERIT FALSE, SET TRUE',
        [EXEC_GET, `grant ${CARRIER} to tmpos_audit_writer with inherit false, set true`], /unexpected direct grant remains on the tmpos_customer_detail routine|other than tmpos_app can execute/]] : []),
      ['SELECT granted directly to tmpos_app', ['grant select on tmpos_customer.customer to tmpos_app'], /holds a privilege on tmpos_customer\.customer/],
    ];
    for (const [label, setup, pattern] of viaRoles) {
      const { postcondition, preflight } = await judge(setup);
      assert.equal(postcondition?.code, '55000', `${label}: the postcondition refuses (${JSON.stringify(postcondition)})`);
      assert.match(postcondition.message, pattern, label);
      assert.ok(preflight.length > 0 && preflight.some((c) => c.startsWith('role_')), `${label}: the preflight refuses (${JSON.stringify(preflight)})`);
    }
    // (2) THROUGH THE RUNTIME LOGIN ITSELF: the preflight refuses each. 022's postcondition names only tmpos_app,
    // tmpos_audit_writer, anon and authenticated — it cannot know the provisioned login (its header: WHAT THIS DOES NOT
    // PROVE) — so it does not refuse these; that boundary is recorded here, not asserted away.
    const viaLogin = [
      ['a SELECT carrier granted to the login, INHERIT TRUE', [SELECT, `grant ${CARRIER} to ${RUNTIME_LOGIN} with inherit true`], 'membership_unexpected'],
      ...(setOption ? [['a SELECT carrier granted to the login, INHERIT FALSE, SET TRUE', [SELECT, `grant ${CARRIER} to ${RUNTIME_LOGIN} with inherit false, set true`],
        'membership_unexpected']] : []),
      ['a carrier of EXECUTE on 017\'s page granted to the login', [EXEC_017, `grant ${CARRIER} to ${RUNTIME_LOGIN} with inherit true`], 'membership_unexpected'],
      ['SELECT on the customer table granted directly to the login', [`grant select on tmpos_customer.customer to ${RUNTIME_LOGIN}`], 'login_privilege_unexpected'],
    ];
    for (const [label, setup, code] of viaLogin) {
      const { postcondition, preflight } = await judge(setup);
      assert.ok(preflight.includes(code), `${label}: the preflight refuses with ${code} (${JSON.stringify(preflight)})`);
      assert.equal(postcondition, null, `${label}: RECORDED BOUNDARY — 022's postcondition does not name the runtime login`);
      console.log(`# M7CD-02b ${label}: preflight ${JSON.stringify(preflight)}; 022 postcondition does not name the login`);
    }
  } finally {
    // Every carrier lived only in a rolled-back transaction; this proves none survived.
    assert.equal((await owner`select count(*)::int as n from pg_catalog.pg_roles where rolname = ${CARRIER}`)[0].n, 0, 'no carrier role remains');
  }
});

// ---------------------------------------------------------------------------
// M7CD-03..04: the answers, and parity with the list's read
// ---------------------------------------------------------------------------

test('M7CD-03: own customer; another tenant\'s and a missing id the SAME not_found row; invalid arguments; an unknown key, a foreign tenant asserted and a revoked session denied', async () => {
  const key = await mint(OWNER_A);
  const [own] = SEED_A;
  assert.deepEqual(await get(key, own.id, T_A), [{ o_outcome: 'customer', o_tenant_id: T_A, o_customer_id: own.id, o_name: own.name }]);
  const foreign = await get(key, SEED_B[0].id, T_A);
  const missing = await get(key, randomUUID(), T_A);
  assert.deepEqual(foreign, [{ o_outcome: 'not_found', ...NULLS }], 'another tenant\'s id');
  assert.deepEqual(missing, foreign, 'a random id: the byte-identical row');
  for (const [label, k, id, t] of [
    ['a null key', null, own.id, T_A], ['an empty key', '', own.id, T_A], ['a key with a space', 'a b', own.id, T_A],
    ['a 129-character key', 'k'.repeat(129), own.id, T_A], ['a null id', key, null, T_A], ['a null expected tenant', key, own.id, null],
  ]) {
    assert.deepEqual(await get(k, id, t), [{ o_outcome: 'invalid', ...NULLS }], label);
  }
  assert.deepEqual(await get(newKey(), own.id, T_A), [{ o_outcome: 'denied', ...NULLS }], 'an unknown key');
  // C2.3: a key of tenant A asserting tenant B is refused before any customer is read — hit (A's id, B's id) or miss.
  for (const [label, id] of [['A\'s own id', own.id], ['B\'s id', SEED_B[0].id], ['a missing id', randomUUID()]]) {
    assert.deepEqual(await get(key, id, T_B), [{ o_outcome: 'denied', ...NULLS }], `asserting B: ${label}`);
  }
  // C2.2: revocation (011's m5_session_revoke, which removes the row) — the routine finds no session.
  const revoked = await mint(OWNER_A);
  assert.equal(await outcomeOf(revoked, own.id, T_A), 'customer', 'live (control)');
  await runtime`select tmpos_session.m5_session_revoke(${revoked}::text)`;
  assert.deepEqual(await get(revoked, own.id, T_A), [{ o_outcome: 'denied', ...NULLS }], 'a revoked session reads nothing');
});

test('M7CD-04: LIST PARITY — every standing, grant, level and tenant failure page_v3 refuses is refused here, and every read page_v3 serves is served here', async () => {
  /** A fresh tenant with one customer, and one actor of `role` in it, minted: what each case mutates alone. */
  const fresh = async (label, role, status = 'active') => {
    const tenant = await newTenant(label, status);
    const [c] = await seed(tenant, [`${label} ${SUFFIX}`]);
    const who = await actor(label, [{ tenant, role }]);
    return { tenant, c, who, key: await mint(who) };
  };
  const both = async (f) => [await outcomeOf(f.key, f.c.id, f.tenant), await pageOutcome(f.key)];
  const refusals = [
    ['expired', async () => {
      const f = await fresh('expired', 'manager');
      const key = await mint(f.who, 1_500);
      await sleep(1_700);
      return { ...f, key };
    }],
    ['an administrative session', async () => { const f = await fresh('admin-aud', 'manager'); return { ...f, key: await mintAdmin(f.who) }; }],
    ['the issuer key rotated', async () => { const f = await fresh('rotated', 'manager'); await installTestIssuerKey(owner, randomBytes(32)); return f; }],
    ['the standing digest changed (a store grant added)', async () => {
      const f = await fresh('standing', 'manager');
      const [{ store_id: store }] = await owner`insert into store (tenant_id, store_name, status) values (${f.tenant}, ${`m7cd-st-${SUFFIX}`}, 'active') returning store_id`;
      await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
        values (${f.who.id}, ${f.tenant}, ${store}, 'store', 'sales_staff', 'active')`;
      return f;
    }],
    ['a second tenant grant', async () => {
      const f = await fresh('two-grants', 'manager');
      await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
        values (${f.who.id}, ${T_B}, null, 'tenant', 'manager', 'active')`;
      return f;
    }],
    ['the account suspended', async () => { const f = await fresh('suspended-acct', 'manager'); await owner`update app_user set status = 'suspended' where internal_user_id = ${f.who.id}`; return f; }],
    ['the security version bumped', async () => {
      const f = await fresh('sv', 'manager');
      await owner`update app_user set updated_at = updated_at + interval '1 second' where internal_user_id = ${f.who.id}`;
      return f;
    }],
    ['the membership role changed', async () => {
      const f = await fresh('role-changed', 'manager');
      await owner`update user_membership set role_id = 'sales_staff' where internal_user_id = ${f.who.id}`;
      return f;
    }],
    ['the tenant suspended', async () => { const f = await fresh('t-suspended', 'manager'); await owner`update tenant set status = 'suspended' where tenant_id = ${f.tenant}`; return f; }],
    ['the tenant pending activation', async () => { const f = await fresh('t-pending', 'manager'); await owner`update tenant set status = 'pending_activation' where tenant_id = ${f.tenant}`; return f; }],
    ...['manager', 'technician', 'sales_staff'].map((role) => [`${role} narrowed to none`, async () => {
      const f = await fresh(`narrow-${role}`, role);
      assert.deepEqual(await both(f), ['customer', 'customer'], `${role}: reads before the narrowing (control)`);
      await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${f.tenant}, ${role}, 'customers', 'none', now())`;
      return f;
    }]),
  ];
  try {
    for (const [label, arrange] of refusals) {
      const f = await arrange();
      try {
        assert.deepEqual(await both(f), ['denied', 'denied'], label);
      } finally {
        if (label === 'the issuer key rotated') await installTestIssuerKey(owner, K);
      }
    }
  } finally {
    await installTestIssuerKey(owner, K);
  }
  // Served by both: a read-only tenant, store_owner, each catalog default, and a stored 'view'.
  const reads = [
    ['a read-only tenant', { tenant: T_RO, c: SEED_RO, key: await mint(OWNER_RO) }],
    ['store_owner', { tenant: T_A, c: SEED_A[0], key: await mint(OWNER_A) }],
  ];
  for (const role of ['manager', 'technician', 'sales_staff']) reads.push([`${role} at its default`, await fresh(`default-${role}`, role)]);
  const stored = await fresh('stored-view', 'sales_staff');
  await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${stored.tenant}, 'sales_staff', 'customers', 'view', now())`;
  reads.push(['a stored view', stored]);
  for (const [label, f] of reads) assert.deepEqual(await both(f), ['customer', 'customer'], label);
});

// ---------------------------------------------------------------------------
// M7CD-05: the timing residual, bounded (a sanity check, not a constant-time claim)
// ---------------------------------------------------------------------------

test('M7CD-05: foreign and missing ids take the same statements; their medians stay within max(2 ms, 25%) cold and warm — a documented residual, not a constant-time guarantee', async () => {
  const key = await mint(OWNER_A);
  const timed = async (id) => {
    const t0 = process.hrtime.bigint();
    assert.equal(await outcomeOf(key, id, T_A), 'not_found');
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const bound = (label, f, m) => {
    const [mf, mm] = [median(f), median(m)];
    console.log(`# M7CD-05 ${label}: median foreign ${mf.toFixed(3)} ms, missing ${mm.toFixed(3)} ms`);
    assert.ok(Math.abs(mf - mm) <= Math.max(2, 0.25 * Math.max(mf, mm)), `${label}: foreign ${mf.toFixed(3)} ms, missing ${mm.toFixed(3)} ms`);
  };
  // Cold: each foreign id visited once (the 20 not used elsewhere), each missing id fresh; randomized interleaving.
  const cold = { f: [], m: [] };
  for (const c of SEED_B.slice(4)) {
    for (const k of (Math.random() < 0.5 ? ['f', 'm'] : ['m', 'f'])) cold[k].push(await timed(k === 'f' ? c.id : randomUUID()));
  }
  bound('cold', cold.f, cold.m);
  // Warm: 5 warm-ups, then 40 interleaved calls on one foreign id and fresh missing ids.
  for (let i = 0; i < 5; i++) { await timed(SEED_B[1].id); await timed(randomUUID()); }
  const warm = { f: [], m: [] };
  for (let i = 0; i < 20; i++) {
    for (const k of (Math.random() < 0.5 ? ['f', 'm'] : ['m', 'f'])) warm[k].push(await timed(k === 'f' ? SEED_B[1].id : randomUUID()));
  }
  bound('warm', warm.f, warm.m);
});

// ---------------------------------------------------------------------------
// M7CD-06..07: the production adapter over the real login; reads write nothing
// ---------------------------------------------------------------------------

const scopeOf = async (who, tenant) => {
  const [m] = await owner`select membership_id, role_id from user_membership where internal_user_id = ${who.id} and tenant_id = ${tenant} and scope_type = 'tenant'`;
  return Object.freeze({ actor: who.id, securityVersion: 'sv', scope: 'tenant', tenant, store: null, membershipId: m.membership_id, roleId: m.role_id, limitation: 'none' });
};

test('M7CD-06: the production adapter over the real login answers customer, not_found and denied, probes true — and with EXECUTE withdrawn probes false and throws', async () => {
  const key = await mint(OWNER_A);
  const scope = await scopeOf(OWNER_A, T_A);
  const adapter = createPostgresCustomerDetail({ client: RUNTIME_KERNEL });
  const [own] = SEED_A;
  assert.deepEqual(await adapter.get(scope, key, own.id, signal()), { outcome: 'customer', id: own.id, name: own.name });
  assert.deepEqual(await adapter.get(scope, key, SEED_B[0].id, signal()), { outcome: 'not_found' });
  assert.deepEqual(await adapter.get(scope, key, randomUUID(), signal()), { outcome: 'not_found' });
  assert.deepEqual(await adapter.get(scope, newKey(), own.id, signal()), { outcome: 'denied' });
  assert.deepEqual(await adapter.get({ ...scope, tenant: T_B }, key, own.id, signal()), { outcome: 'denied' }, 'the scope\'s tenant is a precondition');
  assert.equal(await probeCustomerDetail(RUNTIME_KERNEL, signal()), true);
  const withdrawn = await rolledBack(RC, async (tx) => {
    await tx.unsafe(`revoke execute on function ${GET} from tmpos_app`);
    await tx.unsafe(`set local session authorization ${RUNTIME_LOGIN}`);
    const probe = await probeCustomerDetail(kernelOn(tx), signal());
    const read = await errorOf(createPostgresCustomerDetail({ client: kernelOn(tx) }).get(scope, key, own.id, signal()));
    return { probe, read: read?.code ?? read?.message ?? null };
  });
  assert.deepEqual(withdrawn.value, { probe: false, read: '42501' }, JSON.stringify(withdrawn));
});

test('M7CD-07: reads write nothing — no audit, outbox, idempotency, customer, session or level row moves', async () => {
  const counts = async () => ({ ...(await owner`select
    (select count(*) from public.audit_event)::int as audit,
    (select count(*) from tmpos_internal.outbox_event)::int as outbox,
    (select count(*) from tmpos_internal.idempotency_record)::int as idempotency,
    (select count(*) from tmpos_customer.customer)::int as customers,
    (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(s::text, '|' order by s.session_key), ''), 'UTF8')), 'hex')
       from tmpos_session.session s) as sessions,
    (select count(*) from tmpos_role.tenant_role_level)::int as levels,
    (select count(*) from tmpos_role_edit.role_level_version)::int as versions`)[0] });
  const key = await mint(OWNER_A);
  const before = await counts();
  for (const id of [SEED_A[0].id, SEED_B[0].id, randomUUID()]) await get(key, id, T_A);
  await get(key, SEED_A[0].id, T_B);
  await get(newKey(), SEED_A[0].id, T_A);
  assert.deepEqual(await counts(), before);
});

// ---------------------------------------------------------------------------
// M7CD-08..09: rollback — alone, independent of 021's, newest first; and out of order
// ---------------------------------------------------------------------------

test('M7CD-08: 022 down alone leaves exactly the 001-021 grants and a byte-identical re-apply; it rolls back beside a 021 version row that refuses 021\'s; rollBackAbove(020) answers 025, 024, 023, 022 then 021 and restores all five', async () => {
  const applied = await routineState(owner);
  const alone = await rolledBack(RC, async (tx) => {
    await tx.unsafe(DOWN_022).simple();
    const [gone] = await tx`select pg_catalog.to_regnamespace('tmpos_customer_detail') is null as gone,
      pg_catalog.has_function_privilege('tmpos_app', ${PAGE_V3}, 'EXECUTE') as v3,
      pg_catalog.has_table_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT') as table_select`;
    const down = await preflightOn(tx);
    await tx.unsafe(UP_022).simple();
    const reapplied = await routineState(tx);
    const up = await preflightOn(tx);
    return { gone: { ...gone }, down: down.runtimeLogin, up, reapplied };
  });
  assert.deepEqual(alone.value?.gone, { gone: true, v3: true, table_select: false }, JSON.stringify(alone));
  // The ledger still records 022 here (a file run, not a ledger rollback): only the grants are judged — missing, nothing extra.
  assert.deepEqual(alone.value.down, ['role_privilege_missing'], 'rolled back: only 022\'s grants are missing, nothing unexpected');
  assert.deepEqual(alone.value.up, { runtimeLogin: [], migrationLedger: [] }, 're-applied: accepted');
  assert.deepEqual(alone.value.reapplied, applied, 're-applied: the same definition, configuration and ACL');
  // Independence: a 021 version row refuses 021's rollback, never 022's.
  const beside = await rolledBack(RC, async (tx) => {
    await tx`insert into tmpos_role_edit.role_level_version (tenant_id, role_id, domain, version) values (${T_A}, 'manager', 'customers', 1)`;
    await tx.unsafe(DOWN_022).simple();
    const edit = await tx.savepoint((sp) => sp.unsafe(DOWN_021).simple()).then(() => null, (err) => err.code);
    return { edit };
  });
  assert.deepEqual(beside.value, { edit: '55000' }, JSON.stringify(beside));
  // The ledger's own order, committed and restored (every suite deletes its version rows, so 021's rollback can run).
  const ledgerOf = async () => (await owner`select version, checksum, dirty, started_at::text as s, finished_at::text as f
    from public.schema_migrations order by version`).map((r) => ({ ...r }));
  const ledgerBefore = await ledgerOf();
  // M7A-CUSTOMERS-P6: 023 sits above 022, and its rollback refuses while any customer holds a contact or a creation time.
  // This file's seeds were inserted after 023 and so carry the column default's creation time: it clears its OWN rows'
  // (never another suite's) before rolling back past 023 — test hygiene, not the migration's job — and they stay NULL (an
  // unknown creation time, as a legacy row's) once 023 is restored.
  await owner`update tmpos_customer.customer set phone = null, email = null, created_at = null where tenant_id = any(${TENANTS}::uuid[])`;
  const later = await rollBackAbove(owner, MIG_DIR, '020');
  try {
    assert.deepEqual(later.rolledBack, ['028', '027', '026', '025', '024', '023', '022', '021'], 'newest first');
    const [gone] = await owner`select pg_catalog.to_regnamespace('tmpos_customer_detail') is null as detail,
      pg_catalog.to_regnamespace('tmpos_role_edit') is null as edit`;
    assert.deepEqual({ ...gone }, { detail: true, edit: true });
  } finally {
    await later.restore();
  }
  assert.deepEqual(await ledgerOf(), ledgerBefore, 'the ledger rows restored exactly');
  assert.deepEqual(await routineState(owner), applied, 'restored: the same routine');
  assert.equal(await outcomeOf(await mint(OWNER_A), SEED_A[0].id, T_A), 'customer', 'restored: it reads');
});

test('M7CD-09: out of order, 020 rolled back under 021, 022 and 023 leaves an editable role\'s read raising and the adapter throwing (fail closed); 022\'s rollback refuses until 020 is back; the supported order 025, 024, 023, 022, 021, 020 succeeds', async () => {
  // An editable role's read consults 020's level table (store_owner's is Full by the literal and never reads it).
  const manager = await actor('manager-a', [{ tenant: T_A, role: 'manager' }]);
  const key = await mint(manager);
  const scope = await scopeOf(manager, T_A);
  // 020's and 021's rollbacks refuse while a stored level differs from its default or a version row exists, and 023's
  // (M7A-CUSTOMERS-P6) while any customer holds a contact or a creation time, and 024's (M7A-CUSTOMERS-P7) while any
  // customer is edited: cleared here, inside the transaction that is rolled back, never committed.
  const clear = async (tx) => {
    await tx`delete from tmpos_role_edit.role_level_version`;
    await tx`delete from tmpos_role.tenant_role_level`;
    await tx`update tmpos_customer.customer set phone = null, email = null, created_at = null`;
    await tx`update tmpos_customer.customer set row_version = 1 where row_version <> 1`;
  };
  const outOfOrder = await rolledBack(RC, async (tx) => {
    await clear(tx);
    await tx.unsafe(DOWN_020).simple();
    const raised = (await asRuntime(tx, (sp) => get(key, SEED_A[0].id, T_A, sp))).code ?? null;
    const adapter = (await asRuntime(tx, (sp) => createPostgresCustomerDetail({ client: { transaction: (_s, _b, work) => work(sp), end: async () => {} } })
      .get(scope, key, SEED_A[0].id, signal()))).value === undefined ? 'threw' : 'answered';
    const refused = await tx.savepoint((sp) => sp.unsafe(DOWN_022).simple()).then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
    await tx.unsafe(UP_020).simple();
    await tx.unsafe(DOWN_022).simple();
    return { raised, adapter, refused, detailGone: (await tx`select pg_catalog.to_regnamespace('tmpos_customer_detail') is null as g`)[0].g };
  });
  assert.ok(outOfOrder.value !== undefined, JSON.stringify(outOfOrder));
  assert.match(String(outOfOrder.value.raised), /^(42P01|3F000|42883)$/, `the routine raises on the missing object: ${outOfOrder.value.raised}`);
  assert.equal(outOfOrder.value.adapter, 'threw', 'the adapter throws: the route answers a bounded 503');
  assert.equal(outOfOrder.value.refused?.code, '55000');
  assert.match(outOfOrder.value.refused.message, /roll 022 back before 020/);
  assert.equal(outOfOrder.value.detailGone, true, '020 re-applied: 022 rolls back');
  const supported = await rolledBack(RC, async (tx) => {
    await clear(tx);
    for (const file of [DOWN_028, DOWN_027, DOWN_026, DOWN_025, DOWN_024, DOWN_023, DOWN_022, DOWN_021, DOWN_020]) await tx.unsafe(file).simple();
    return { ...(await tx`select pg_catalog.to_regnamespace('tmpos_customer_search') is null as customer_search,
      pg_catalog.to_regnamespace('tmpos_customer_edit') is null as customer_edit,
      pg_catalog.to_regnamespace('tmpos_customer_contact') is null as contact,
      pg_catalog.to_regnamespace('tmpos_customer_detail') is null as detail,
      pg_catalog.to_regnamespace('tmpos_role_edit') is null as edit, pg_catalog.to_regnamespace('tmpos_role') is null as role`)[0] };
  });
  assert.deepEqual(supported.value, { customer_search: true, customer_edit: true, contact: true, detail: true, edit: true, role: true }, JSON.stringify(supported));
  assert.equal(await outcomeOf(key, SEED_A[0].id, T_A), 'customer', 'all of it rolled back: the service reads as before');
});
