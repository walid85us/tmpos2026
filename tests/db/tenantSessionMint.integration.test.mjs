// Phase 4.0 M7A-CUSTOMERS-P2 — the tenant session mint against REAL PostgreSQL: migration 018 (an issuer key the runtime
// role cannot read; a mint that requires an HMAC under it for every tenant session and checks every argument of both
// audiences first; a replay ledger that never cascades; and the customer read bound in the database to a minted, live
// session under the key installed now), exercised as the runtime's own non-owner login (tmpos_app + tmpos_audit_writer).
//
// WHAT IS PROVEN. The migration as applied and its postcondition (M7M-01); the routines the login may execute and its own
// table and column privileges by every grant path — not what the definer routines it executes write for it (M7M-02) —,
// a source tripwire over those routines and every trigger for the account, identity, link and membership tables (M7M-02c,
// not a proof), and the startup preflight's verdict on the login (M7M-02b); the recorded vectors against the database
// and the runtime (M7M-03); key custody (M7M-04); every mint refusal, writing nothing (M7M-05); CH1's direct-call levers closed (M7M-06),
// and the read's audience and expiry clauses each denying on its own (M7M-06b); every standing change failing closed
// with no revival (M7M-07); the read equal to 017's page for the authority it derives (M7M-08); the rollback (M7M-09),
// and 017 rolled back and re-applied beneath 018 (M7M-09b); concurrent mints, key rotation and removal, and the unproven
// admin branch over a real socket (M7M-10); and the standing digest's rendering pin and its independence from the
// caller's settings (M7M-12). The HTTP log scan is M7C-12's.
//
// THE CHAIN THROUGH 019 (M7A-CUSTOMERS-P3-R1). Migration 020 revokes the login's EXECUTE on 018's page_v2 (and on 019's
// create), replacing it with tmpos_role.m7a_customer_page_v3, so this file — 018's own behaviour — applies 001-019 only:
// the migration file port the trusted executor reads hides every later file (tests/db/migrationsThrough.mjs). On a shared
// service where a later migration is already applied, its own down file rolls it back first (with its ledger row) and it
// is re-applied, with its exact ledger row, when this file ends. The startup preflight now requires 001-025, so M7M-02b
// applies 020-025 through the same executor for its verdict and rolls them back again (newest first). The
// customers this file seeds are written on 001-019, before 023 exists, so 023 adds them with no contact and no creation
// time, and its rollback (which refuses while any customer holds either) finds none of this file's. page_v3's own proofs are
// tests/db/tenantRoleLevelRoutine.integration.test.mjs's.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and randomly
// suffixed, and every issuer key is random bytes made here. It leaves the shared service as it found it: 018 applied, the
// issuer key row it found, no ledger, session or customer row of its own, and its login dropped. To roll 018 back for
// real (M7M-09) the owner empties the key and the whole ledger first, as M7C-14 does for its own rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { SESSION_COOKIES, principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_017 = readFileSync(`${MIG_DIR}/017_m7a_customer_directory.up.sql`, 'utf8');
const DOWN_017 = readFileSync(`${MIG_DIR}/017_m7a_customer_directory.down.sql`, 'utf8');
const UP_018 = readFileSync(`${MIG_DIR}/018_m7a_tenant_session_mint.up.sql`, 'utf8');
const DOWN_018 = readFileSync(`${MIG_DIR}/018_m7a_tenant_session_mint.down.sql`, 'utf8');
const UP_020 = readFileSync(`${MIG_DIR}/020_m7a_tenant_role_levels.up.sql`, 'utf8');
const UP_021 = readFileSync(`${MIG_DIR}/021_m7a_role_level_precondition.up.sql`, 'utf8');
const UP_022 = readFileSync(`${MIG_DIR}/022_m7a_customer_detail.up.sql`, 'utf8');
const UP_023 = readFileSync(`${MIG_DIR}/023_m7a_customer_contact.up.sql`, 'utf8');
const UP_024 = readFileSync(`${MIG_DIR}/024_m7a_customer_edit.up.sql`, 'utf8');
const UP_025 = readFileSync(`${MIG_DIR}/025_m7a_customer_search.up.sql`, 'utf8');
/** 018's section 8 postcondition, run again on its own after a deliberate widening, to prove it refuses. */
const POSTCONDITION_018 = UP_018.slice(UP_018.lastIndexOf('do $$'));
const CREATE_011 = 'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)';
const PAGE_017 = 'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)';
const MINT = 'tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)';
const PAGE_V2 = 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)';
const KEY_CHECK = 'tmpos_mint.m7a_issuer_key_check(bytea)';
const HMAC = 'tmpos_mint.hmac_sha256(bytea, bytea)';
const MESSAGE = 'tmpos_mint.mint_message(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7m-migrator', runtimeRef: 'm7m-runtime' };
const LOCK_KEY = 528_523;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7m_probe';
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const HOUR = 3_600_000;
const TENANT_LIFETIME = 8 * HOUR;
const signal = () => AbortSignal.timeout(10_000);
const ROLLBACK = new Error('m7m: roll the proof back');

// ---------------------------------------------------------------------------
// the construction, computed here independently of the runtime's own (postgresSessionStore.ts tenantMintProof)
// ---------------------------------------------------------------------------

const netstring = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes, Buffer.from(',')]);
};
// String() is the identity on every well-formed value; it lets the argument cases below prove over a NULL too.
const mintMessage = (key, r, expiresAt) => Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion,
    r.authenticatedAt === null ? '' : r.authenticatedAt, r.createdAt, r.lastSeenAt, r.validatedAt, expiresAt]
    .map((v) => netstring(String(v)))]);
const proofOf = (issuer, key, r, expiresAt) => createHmac('sha256', issuer).update(mintMessage(key, r, expiresAt)).digest();
const fingerprintOf = (issuer) => createHmac('sha256', issuer).update('tmpos-tenant-issuer-key-fingerprint:v1').digest();
const digestOf = (id) => createHash('sha256').update(id).digest('base64url');
/** A fresh store key in the runtime's shape: the SHA-256 of 32 random bytes' identifier. */
const newKey = () => digestOf(randomBytes(32).toString('base64url'));

/** design-B §4's recorded vector. Its issuer is the bytes 0x00..0x1f, built here, never written out. */
const VECTOR = Object.freeze({
  issuer: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
  handle: 'session-key-vector',
  record: Object.freeze({
    audience: 'tenant', authProvider: 'firebase', authProviderUid: 'uid-Ω-vector', principalKey: 'pk-vector', securityVersion: 't2:vector',
    authenticatedAt: null, createdAt: 1790000000000, lastSeenAt: 1790000000000, validatedAt: 1790000000000,
  }),
  expiresAt: 1790028800000,
  message: 'tmpos-tenant-session-mint:v118:session-key-vector,6:tenant,8:firebase,13:uid-Ω-vector,9:pk-vector,9:t2:vector,0:,13:1790000000000,13:1790000000000,13:1790000000000,13:1790028800000,',
  proof: '54c2bf73916e2d04e33889e948ff9ec4812ea1f054d9895ff282245da79392e4',
  fingerprint: 'e3cea24acf7070c68bee2a3d19a3040ed203fc23f1d1aeef90ea566a52b5ef15',
});

/** RFC 4231 test cases 1-4: [key bytes, data, HMAC-SHA256]. */
const RFC4231 = [
  [Buffer.alloc(20, 0x0b), Buffer.from('Hi There'),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
  [Buffer.from('Jefe'), Buffer.from('what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
  [Buffer.alloc(20, 0xaa), Buffer.alloc(50, 0xdd),
    '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
  [Buffer.from(Array.from({ length: 25 }, (_, i) => i + 1)), Buffer.alloc(50, 0xcd),
    '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'],
];

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M7M');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** `host`/`user` travel in client options, never the URL; a named role REPLACES the userinfo. */
function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}
const connect = (user, max) =>
  testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, installs the key, writes the fixtures and observes. RLS does not restrict it. */
const owner = connect(undefined, 3);
let runtime = null;
let client = null;
/** Every provider reference, tenant and session key this suite creates: what the final cleanup removes. */
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
/** The issuer key row this suite found (undefined until read, then the bytes or null), restored at the end. */
let keyBeforeSuite;
/** The later migrations (020-025) this file rolled back to run on 001-019, re-applied at the end. */
let later = null;

test.after(async () => {
  const quietly = async (fn) => { try { await fn(); } catch { /* 018 rolled back by a failed M7M-09: nothing of ours is left in it */ } };
  if (KEYS.size > 0) await quietly(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
  if (UIDS.length > 0) await owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`;
  if (TENANTS.length > 0) await owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
  // A failed M7M-02b may have left 020-025 applied: back to 019 first, then the service gets back the later migrations it had.
  await quietly(() => rollBackAbove(owner, MIG_DIR, '019'));
  if (later !== null) await later.restore();
  if (keyBeforeSuite !== undefined) {
    await quietly(async () => {
      await owner`delete from tmpos_mint.issuer_key`;
      if (keyBeforeSuite !== null) await owner`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${keyBeforeSuite})`;
    });
  }
  if (client) await client.end();
  if (runtime) await runtime.end({ timeout: 5 });
  await owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`;
  await owner.unsafe(`drop owned by ${RUNTIME_LOGIN}`);
  await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: real migrations 001-018, a real non-owner runtime login, the key installed by the owner
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

/** The transaction kernel over the runtime login — ONE client, as the composition root builds it. */
client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 4, idle_timeout: 0, user: RUNTIME_LOGIN,
});

/** The owner's install statement (design-B §3.12): a bound parameter, and also a rotation. */
const install = (issuer) => installTestIssuerKey(owner, issuer);
keyBeforeSuite = (await owner`select key from tmpos_mint.issuer_key`)[0]?.key ?? null;
const K = randomBytes(32);
await install(K);
/** The key the mint helpers below prove under; M7M-10 rotates it. */
let issuerNow = K;

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7m-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, label) =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`m7m-${label}-${SUFFIX}`}, 'active') returning store_id`)[0].store_id;
const seed = async (tenant, names) => {
  const rows = names.map((name) => ({ customer_id: randomUUID(), tenant_id: tenant, name }));
  await owner`insert into tmpos_customer.customer ${owner(rows, 'customer_id', 'tenant_id', 'name')}`;
  return rows.map((r) => r.customer_id);
};

/** A synthetic actor: an identity, an account in `status`, and the given memberships. */
async function actor(label, memberships, status = 'active') {
  const uid = `m7m-${label}-${SUFFIX}`;
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
const T_C = await newTenant('c');
const T_EMPTY = await newTenant('empty');
const T_SUSPEND = await newTenant('to-suspend');
const STORE_A = await newStore(T_A, 'store-a');
const SEED_A = await seed(T_A, [`Alpha ${SUFFIX}`, `alpha ${SUFFIX}`, `Beta ${SUFFIX}`]);
// 150 customers in pairs of identical names, so a page boundary at 101 or 7 can split a pair.
const SEED_B = await seed(T_B, Array.from({ length: 150 }, (_, i) => `B ${String(Math.floor(i / 2)).padStart(3, '0')} ${SUFFIX}`));
const SEED_C = await seed(T_C, [`Cobalt ${SUFFIX}`, `Cyan ${SUFFIX}`]);
const SEED_SUSPEND = await seed(T_SUSPEND, [`Suspended ${SUFFIX}`]);

const A_USER = await actor('a-user', [tenantGrant(T_A)]);
const B_USER = await actor('b-user', [tenantGrant(T_B)]);
const EMPTY_USER = await actor('empty-user', [tenantGrant(T_EMPTY, 'store_owner')]);
const STORE_ONLY = await actor('store-only', [{ scope: 'store', tenant: T_A, store: STORE_A, role: 'manager' }]);
const GRANT_USER = await actor('grant-user', [tenantGrant(T_A)]);
const ACCOUNT_USER = await actor('account-user', [tenantGrant(T_A)]);
const TENANT_USER = await actor('tenant-user', [tenantGrant(T_SUSPEND)]);
const SECOND_USER = await actor('second-user', [tenantGrant(T_A)]);
const ROLE_USER = await actor('role-user', [tenantGrant(T_A)]);
const LINK_USER = await actor('link-user', [tenantGrant(T_A)]);
const REVOKED_USER = await actor('revoked-user', [tenantGrant(T_A)]);
const EXPIRE_USER = await actor('expire-user', [tenantGrant(T_A)]);
const PLATFORM_ONLY = await actor('platform-only', [{ scope: 'platform', role: 'system_owner' }]);

// ---------------------------------------------------------------------------
// the runtime login's calls
// ---------------------------------------------------------------------------

/** A session record for `who`, every stamp at `at` (the runtime's shape; the database checks none of it but the shapes). */
const record = (who, at = Date.now(), over = {}) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:m7m', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at, ...over,
});
/** 018's mint as `db`, every argument explicit. Answers the outcome word; a raise rejects. */
const mintAs = (db, key, r, expiresAt, proof) => {
  if (typeof key === 'string') KEYS.add(key);
  return db`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint, ${proof}::bytea) as outcome`
    .then((rows) => rows[0].outcome);
};
/** A tenant session for `who`, minted as the runtime login under the key installed now. */
async function mint(who, lifetime = TENANT_LIFETIME, at = Date.now()) {
  const key = newKey();
  const r = record(who, at);
  const expiresAt = r.createdAt + lifetime;
  const outcome = await mintAs(runtime, key, r, expiresAt, proofOf(issuerNow, key, r, expiresAt));
  return { key, r, expiresAt, outcome };
}
const page = async (key, after = null, limit = 50) => (await runtime`select o_outcome, o_tenant_id, o_customer_id, o_name
  from tmpos_mint.m7a_customer_page_v2(${key}::text, ${after}::uuid, ${limit}::integer)`).map((r) => ({ ...r }));
const DENIED = Object.freeze({ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null });
const denied = async (key, label) => assert.deepEqual(await page(key, null, 101), [DENIED], label);
/** The session reads exactly `tenant`'s customers `ids`, every page of them. */
const reads = async (key, tenant, ids, label) => {
  const rows = [];
  for (let after = null, guard = 0; guard < 10; guard++) {
    const got = await page(key, after, 101);
    rows.push(...got);
    if (got.length < 101) break;
    after = got.at(-1).o_customer_id;
  }
  assert.ok(rows.every((r) => r.o_outcome === 'customer' && r.o_tenant_id === tenant), `${label}: ${JSON.stringify(rows[0])}`);
  assert.deepEqual(rows.map((r) => r.o_customer_id).sort(), [...ids].sort(), label);
};
const codeOf = (p) => p.then(() => null, (err) => err.code);
const counts = async () => ({ ...(await owner`select (select count(*)::int from tmpos_mint.tenant_session) as ledger,
  (select count(*)::int from tmpos_session.session) as sessions`)[0] });
const keyCheck = async (fingerprint) => (await runtime`select tmpos_mint.m7a_issuer_key_check(${fingerprint}::bytea) as o`)[0].o;

/** Runs `fn` in an owner transaction that is always rolled back. Answers { value } or the { code, message } it raised. */
async function rolledBack(isolation, fn) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}

// ---------------------------------------------------------------------------
// M7M-01..04: the migration, the login, the vectors, key custody
// ---------------------------------------------------------------------------

test('M7M-01: 001-019 applied clean; 005-017 byte-identical to their pins; 018\'s postcondition re-proven, and refusing every widening', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019']
      .map((v) => [v, false]));
  assert.equal(ledger.find((r) => r.version === '018').checksum,
    createHash('sha256').update(readFileSync(`${MIG_DIR}/018_m7a_tenant_session_mint.up.sql`)).digest('hex'),
    'the ledger records the committed 018 up file');
  // 005-017: postgresStartupPreflight.ts REQUIRED_MIGRATIONS (up) and the earlier suites' pins (down), unchanged by 018.
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
    '012_m5_platform_tenant_directory.up.sql': '6e71d4d5223576b86bd6acc46ed429bbcff64390d69a6d3980a3bc9baf3efce6',
    '012_m5_platform_tenant_directory.down.sql': '9d359194edc3031ff5dd1dd60bd54bbe448d850c58d393876993cb5301f47a89',
    '013_m5_platform_admission.up.sql': 'c6df3d2e3559270243a52477c8acc9b8d7cca71c576acc00caf8d267a5151f7a',
    '013_m5_platform_admission.down.sql': 'b0d07b580154e6e387d8093b98ad2889273dcd659c0b53aa15a03cf6c3a0b0ab',
    '014_m6_distributed_rate_limit.up.sql': '48ff3e4bc2b3d4c6ee3cc2c54e4111d8647669d349d1449b249303a9dcc4cf62',
    '014_m6_distributed_rate_limit.down.sql': '72aab6e28ff512e2c8061cfae510e073466f4f5d5bb9ca9d27e3a5e333a63846',
    '015_m5_admin_standing_serialization.up.sql': 'a3b1514ee65703d29b3becf78ef338e8966eb0ee12550ecd5e1f19d357154f4e',
    '015_m5_admin_standing_serialization.down.sql': 'c065b4129bf5499b762d76288b89bd9358845dd274f2eda6484d367b98822e3c',
    '016_m5_tenant_session_ordering.up.sql': 'e5633336da5376a747d05aabac21b73ca9ebcf4743a9436081c58322ac07e9be',
    '016_m5_tenant_session_ordering.down.sql': 'acf8a95610c97c8dca496da6fad4a3618a49a7268a9a82237ecb5849040728a6',
    '017_m7a_customer_directory.up.sql': '1fea57a1c4bdba7efdb5da0f34893879a6b8aa741c1f117b2dcf63259f85d66d',
    '017_m7a_customer_directory.down.sql': '8e6b095959670d2c53d139be3a3c00f4c06544b72c264d6febf4373ef67eb440',
  };
  for (const [name, digest] of Object.entries(PINNED)) {
    assert.equal(createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex'), digest, name);
  }

  // (a)-(c), (e): the inventory and its attributes, read back from the catalog.
  const routines = await owner`select p.proname as name, p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
      (select coalesce(array_agg(pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable) order by 1), '{}')
         from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where g.grantee <> p.proowner) as grants
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_mint'::regnamespace order by p.proname`;
  const PINNED_PATH = ['search_path=pg_catalog, pg_temp'];
  assert.deepEqual(routines.map((r) => ({ ...r })), [
    { name: 'hmac_sha256', definer: false, volatility: 'i', config: PINNED_PATH, grants: [] },
    { name: 'm7a_customer_page_v2', definer: true, volatility: 's', config: [...PINNED_PATH, 'row_security=off'], grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'm7a_issuer_key_check', definer: true, volatility: 's', config: PINNED_PATH, grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'm7a_session_create', definer: true, volatility: 'v', config: PINNED_PATH, grants: ['tmpos_app:EXECUTE:f'] },
    { name: 'mint_message', definer: false, volatility: 'i', config: PINNED_PATH, grants: [] },
  ]);
  const relations = await owner`select c.relname as name, c.relkind as kind, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      (select coalesce(array_agg(g.grantee::regrole::text), '{}')
         from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g where g.grantee <> c.relowner) as grants,
      (select count(*)::int from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attacl is not null) as column_grants,
      (select count(*)::int from pg_catalog.pg_policy p where p.polrelid = c.oid) as policies
    from pg_catalog.pg_class c where c.relnamespace = 'tmpos_mint'::regnamespace order by c.relname`;
  assert.deepEqual(relations.map((r) => ({ ...r })), [
    { name: 'issuer_key', kind: 'r', rls: true, forced: false, grants: [], column_grants: 0, policies: 0 },
    { name: 'issuer_key_pkey', kind: 'i', rls: false, forced: false, grants: [], column_grants: 0, policies: 0 },
    { name: 'tenant_session', kind: 'r', rls: true, forced: false, grants: [], column_grants: 0, policies: 0 },
    { name: 'tenant_session_expiry_idx', kind: 'i', rls: false, forced: false, grants: [], column_grants: 0, policies: 0 },
    { name: 'tenant_session_pkey', kind: 'i', rls: false, forced: false, grants: [], column_grants: 0, policies: 0 },
  ]);
  const [schema] = await owner`select (select coalesce(array_agg(pg_catalog.format('%s:%s:%s', g.grantee::regrole, g.privilege_type, g.is_grantable)), '{}')
      from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
     where n.nspname = 'tmpos_mint' and g.grantee <> n.nspowner) as grants`;
  assert.deepEqual(schema.grants, ['tmpos_app:USAGE:f']);
  // (f)-(h), from the catalog's own answers.
  const [effective] = await owner`select
      pg_catalog.has_function_privilege('tmpos_app', ${CREATE_011}, 'EXECUTE') as create_011,
      pg_catalog.has_function_privilege('tmpos_app', ${PAGE_017}, 'EXECUTE') as page_017,
      pg_catalog.has_function_privilege('tmpos_app', ${HMAC}, 'EXECUTE') as hmac,
      pg_catalog.has_function_privilege('tmpos_app', ${MESSAGE}, 'EXECUTE') as message,
      pg_catalog.has_function_privilege('tmpos_app', ${MINT}, 'EXECUTE') as mint,
      pg_catalog.has_function_privilege('tmpos_app', ${PAGE_V2}, 'EXECUTE') as page_v2,
      pg_catalog.has_function_privilege('tmpos_app', ${KEY_CHECK}, 'EXECUTE') as key_check,
      (select count(*)::int from pg_catalog.pg_roles r, pg_catalog.pg_namespace n
        where n.nspname = 'tmpos_mint' and r.rolname in ('tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated')
          and pg_catalog.pg_has_role(r.oid, n.nspowner, 'MEMBER')) as owner_members,
      (select count(*)::int from pg_catalog.pg_roles r, pg_catalog.pg_class c
        where c.relnamespace = 'tmpos_mint'::regnamespace and c.relkind = 'r'
          and r.rolname in ('tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated')
          and pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')) as table_holders`;
  assert.deepEqual({ ...effective }, {
    create_011: false, page_017: false, hmac: false, message: false, mint: true, page_v2: true, key_check: true, owner_members: 0, table_holders: 0,
  });

  // The postcondition refuses each deliberate widening — inside a transaction that is rolled back — and holds without one.
  const postcondition = async (widen) => (await rolledBack('isolation level read committed', async (tx) => {
    for (const statement of widen) await tx.unsafe(statement);
    await tx.unsafe(POSTCONDITION_018).simple();
  })).code ?? null;
  const [{ me }] = await owner`select current_user as me`;
  for (const [label, widen] of [
    ['a SELECT on the key table', ['grant select on tmpos_mint.issuer_key to tmpos_app']],
    ['a column grant on the ledger', ['grant select (session_key) on tmpos_mint.tenant_session to tmpos_app']],
    ['a policy on the ledger', ['create policy m7m_probe on tmpos_mint.tenant_session for select to tmpos_app using (true)']],
    ['EXECUTE on a helper', [`grant execute on function ${HMAC} to tmpos_app`]],
    ['EXECUTE on 011\'s create again', [`grant execute on function ${CREATE_011} to tmpos_app`]],
    ['EXECUTE on 017\'s page again', [`grant execute on function ${PAGE_017} to tmpos_app`]],
    ['EXECUTE to PUBLIC on the page', [`grant execute on function ${PAGE_V2} to public`]],
    ['EXECUTE with grant option', [`grant execute on function ${MINT} to tmpos_app with grant option`]],
    ['forced row security', ['alter table tmpos_mint.issuer_key force row level security']],
    ['an extra routine', ['create function tmpos_mint.m7m_probe() returns int language sql as \'select 1\'']],
    ['membership in pg_read_all_data (an effective privilege)', ['grant pg_read_all_data to tmpos_app']],
    ['a NOINHERIT membership in the owner (SET ROLE reaches it; no privilege check shows it)',
      ['alter role tmpos_app noinherit', `grant "${me}" to tmpos_app`]],
  ]) {
    assert.equal(await postcondition(widen), '55000', `${label} is refused`);
  }
  assert.equal(await postcondition([]), null, 'the state 018 left satisfies it');
  const [after] = await owner`select pg_catalog.has_table_privilege('tmpos_app', 'tmpos_mint.issuer_key', 'SELECT') as granted,
    (select rolinherit from pg_catalog.pg_roles where rolname = 'tmpos_app') as inherits`;
  assert.deepEqual({ ...after }, { granted: false, inherits: true }, 'the widenings did not survive');
});

/** design-B §9: every routine the runtime login may execute in a tmpos_* schema after 018 — 29, by name — and 019's create: 30. */
const LOGIN_ROUTINES = [
  'tmpos_admission.m5_admit_platform_session',
  'tmpos_command.m5_revalidate_platform_authority', 'tmpos_command.m5_tenant_display_name_update_v2', 'tmpos_command.m5_tenant_status_change',
  'tmpos_customer_write.m7a_customer_create',
  'tmpos_directory.m5_tenant_directory_page',
  'tmpos_identity.m5_resolve_principal', 'tmpos_identity.m5_revalidate_principal_context',
  'tmpos_internal.m6_command_enqueue', 'tmpos_internal.m6_command_fence', 'tmpos_internal.m6_idempotency_acquire',
  'tmpos_internal.m6_idempotency_complete', 'tmpos_internal.m6_outbox_acknowledge', 'tmpos_internal.m6_outbox_claim',
  'tmpos_internal.m6_outbox_dead_letter', 'tmpos_internal.m6_outbox_retry', 'tmpos_internal.m6_store_probe',
  'tmpos_mint.m7a_customer_page_v2', 'tmpos_mint.m7a_issuer_key_check', 'tmpos_mint.m7a_session_create',
  'tmpos_rate_limit.m6_rate_limit_consume', 'tmpos_rate_limit.m6_rate_limit_probe', 'tmpos_rate_limit.m6_rate_limit_reclaim',
  'tmpos_session.m5_admit_tenant_session', 'tmpos_session.m5_admit_tenant_session_v2', 'tmpos_session.m5_hold_tenant_standing',
  'tmpos_session.m5_session_get', 'tmpos_session.m5_session_revoke', 'tmpos_session.m5_session_revoke_principal',
  'tmpos_session.m5_session_touch',
];

test('M7M-02: the login\'s own privileges by every grant path: exactly the 30 tmpos_* routines, two appends and two columns, and no other table or column write', async () => {
  // Every routine outside the catalogs the login may execute, by any path.
  const executable = await runtime`select n.nspname || '.' || p.proname as name, p.prosecdef as definer
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema') and pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
     order by 1`;
  assert.equal(LOGIN_ROUTINES.length, 30);
  assert.deepEqual(executable.filter((r) => r.name.startsWith('tmpos_')).map((r) => r.name), LOGIN_ROUTINES);
  // Outside tmpos_*: only public's routines (pgcrypto's and 001-005's trigger helpers), each SECURITY INVOKER — it runs
  // with the login's own privileges, so it reaches nothing the login could not reach directly.
  for (const r of executable.filter((x) => !x.name.startsWith('tmpos_'))) {
    assert.ok(r.name.startsWith('public.') && r.definer === false, `${r.name}: an invoker routine in public`);
  }

  // J1 — THE LOGIN'S OWN TABLE AND COLUMN PRIVILEGES, by every grant path (a direct grant, PUBLIC, an inherited role, a
  // predefined role): two appends and two display-name columns, and nothing else. WHAT THIS DOES NOT SHOW: what the
  // SECURITY DEFINER routines above write with their owners' privileges. They still write: 009's and 010's commands
  // write public.tenant (010's status change decides no authority), and others write sessions, idempotency records, the
  // outbox, rate-limit buckets and 018's ledger. M7M-02c scans their source for the four identity tables.
  const writes = await runtime`select n.nspname || '.' || c.relname || ':' || p.priv as w
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv)
     where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema')
       and pg_catalog.has_table_privilege(c.oid, p.priv)
     order by 1`;
  assert.deepEqual(writes.map((r) => r.w), ['public.audit_event:INSERT', 'public.store:INSERT']);
  // Column grants: an INSERT or UPDATE on a column of a table, view or foreign table the login cannot write whole (a
  // relation-level one is above).
  const columns = await runtime`select n.nspname || '.' || c.relname || '.' || a.attname || ':' || p.priv as col
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      cross join (values ('INSERT'), ('UPDATE')) as p(priv)
     where c.relkind in ('r', 'p', 'v', 'f') and n.nspname not in ('pg_catalog', 'information_schema')
       and pg_catalog.has_column_privilege(c.oid, a.attnum, p.priv) and not pg_catalog.has_table_privilege(c.oid, p.priv)
     order by 1`;
  assert.deepEqual(columns.map((r) => r.col), ['public.store.store_name:UPDATE', 'public.tenant.legal_name:UPDATE']);
  const AUTHORITY = ['public.app_user', 'public.platform_identity', 'public.identity_link', 'public.user_membership', 'public.tenant',
    'public.store', 'tmpos_session.session', 'tmpos_session.tenant_grant_version', 'tmpos_admission.platform_authority_version',
    'tmpos_mint.issuer_key', 'tmpos_mint.tenant_session'];
  for (const table of AUTHORITY) {
    const [row] = await runtime`select pg_catalog.has_table_privilege(${table}::regclass, 'UPDATE')
      or pg_catalog.has_table_privilege(${table}::regclass, 'DELETE') or pg_catalog.has_table_privilege(${table}::regclass, 'TRUNCATE') as w`;
    assert.equal(row.w, false, `${table}: no UPDATE, DELETE or TRUNCATE`);
  }
  // No object of its own in 018's schema, and no temporary object anywhere.
  assert.equal(await codeOf(runtime.unsafe('create table tmpos_mint.m7m_probe (x int)')), '42501');
  assert.equal(await codeOf(runtime.unsafe('create temporary table m7m_probe (x int)')), '42501');
});

test('M7M-02c: a source tripwire, not a proof: no plain-text write of an account, identity, link or membership table in the source of a routine the login executes, one they name, or a trigger', async () => {
  // M7M-02 reads privileges, and a SECURITY DEFINER routine writes with its owner's, which no privilege check shows. This
  // reads SOURCE instead (prosrc, and for a SQL-standard BEGIN ATOMIC body, which prosrc does not hold, the deparsed
  // prosqlbody): every routine outside the catalogs the login may execute, and every trigger function, closed over every
  // routine whose name appears in the source of one already in the set, must hold no INSERT INTO, UPDATE, DELETE FROM,
  // MERGE INTO or TRUNCATE naming app_user, platform_identity, identity_link or user_membership (any schema, any case),
  // and no TRUNCATE naming one of them anywhere in its target list. It cannot see a table named through dynamic SQL,
  // COPY, a C routine's code, a foreign-key cascade (internal RI triggers are excluded), or a comment between two
  // keywords: it trips on the next migration that adds such a write in plain text, and proves nothing beyond that.
  const WRITES = String.raw`\y(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?)\s+(only\s+)?("?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?(app_user|platform_identity|identity_link|user_membership)\y`;
  // A TRUNCATE takes a list: conservatively, any of the four names before the statement's ';' (or the end) trips it.
  const TRUNCATES = String.raw`\ytruncate\y[^;]*\y(app_user|platform_identity|identity_link|user_membership)\y`;
  // The patterns catch the shapes they must and nothing else, so the empty answer below is not a blind scan.
  const shapes = await owner`select t.s ~* ${WRITES} or t.s ~* ${TRUNCATES} as hit from (values (1, 'INSERT INTO public.app_user (x) values (1)'),
      (2, 'update "user_membership" m set x = 1'), (3, E'delete from\n    identity_link where true'),
      (4, 'MERGE INTO tmpos.platform_identity p using q on true'), (5, 'update only public."app_user" set x = 1'),
      (6, 'TRUNCATE TABLE public.user_membership'), (7, 'select 1 from public.app_user for update'),
      (8, 'update public.tenant set x = 1'), (9, 'insert into app_user_archive values (1)'),
      (10, 'TRUNCATE public.harmless, public.app_user'), (11, 'truncate table public.harmless, tmpos.other restart identity; select 1 from app_user')) as t(n, s) order by t.n`;
  assert.deepEqual(shapes.map((r) => r.hit), [true, true, true, true, true, true, false, false, false, true, false]);

  const tripwire = (sql) => sql`with recursive
      routine as (
        select p.oid, n.nspname || '.' || p.proname as name, p.proname,
               p.prosrc || coalesce(case when p.prosqlbody is not null then pg_catalog.pg_get_function_sqlbody(p.oid) end, '') as src
          from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'),
      reach(oid) as (
        select r.oid from routine r where pg_catalog.has_function_privilege(${RUNTIME_LOGIN}::name, r.oid, 'EXECUTE')
           or r.oid in (select t.tgfoid from pg_catalog.pg_trigger t where not t.tgisinternal)
        union
        select callee.oid from reach c join routine caller on caller.oid = c.oid
          join routine callee on pg_catalog.strpos(caller.src, callee.proname) > 0)
    select r.name, r.src ~* ${WRITES} or r.src ~* ${TRUNCATES} as writes from routine r where r.oid in (select oid from reach) order by 1`;
  const reachable = await tripwire(owner);
  const names = reachable.map((r) => r.name);
  assert.ok(LOGIN_ROUTINES.every((name) => names.includes(name)), 'every routine the login executes is scanned');
  assert.ok(['tmpos_session.m5_session_create', 'tmpos_customer.m7a_customer_page'].every((name) => names.includes(name)),
    'and the routines 018\'s definers call by name, which the login cannot execute');
  assert.deepEqual(reachable.filter((r) => r.writes).map((r) => r.name), [], 'no scanned routine\'s source writes the four tables');

  // The scan reads a BEGIN ATOMIC body, whose prosrc is empty: a probe the login may execute, created and rolled back.
  const probe = await rolledBack('isolation level read committed', async (tx) => {
    await tx.unsafe(`create function public.m7m_atomic_probe() returns void language sql begin atomic delete from public.app_user where false; end`);
    await tx.unsafe(`grant execute on function public.m7m_atomic_probe() to ${RUNTIME_LOGIN}`);
    const [{ prosrc }] = await tx`select p.prosrc ~* ${WRITES} as prosrc from pg_catalog.pg_proc p where p.oid = 'public.m7m_atomic_probe()'::regprocedure`;
    return { prosrc, flagged: (await tripwire(tx)).filter((r) => r.writes).map((r) => r.name) };
  });
  assert.deepEqual(probe.value, { prosrc: false, flagged: ['public.m7m_atomic_probe'] }, JSON.stringify(probe));
  const [{ gone }] = await owner`select pg_catalog.to_regprocedure('public.m7m_atomic_probe()') is null as gone`;
  assert.equal(gone, true, 'the probe did not persist');
});

test('M7M-03: the vectors: RFC 4231 in SQL, a 65-byte key refused, and design-B §4\'s message, proof and fingerprint byte for byte', async () => {
  for (const [issuer, data, expected] of RFC4231) {
    const [{ h }] = await owner`select encode(tmpos_mint.hmac_sha256(${issuer}::bytea, ${data}::bytea), 'hex') as h`;
    assert.equal(h, expected, `RFC 4231 with a ${issuer.length}-byte key`);
    assert.equal(createHmac('sha256', issuer).update(data).digest('hex'), expected, 'and Node agrees');
  }
  assert.equal(await codeOf(owner`select tmpos_mint.hmac_sha256(${randomBytes(65)}::bytea, 'x'::bytea)`), '22023', 'a 65-byte key raises');
  const [{ h: block }] = await owner`select encode(tmpos_mint.hmac_sha256(${Buffer.alloc(64, 7)}::bytea, 'x'::bytea), 'hex') as h`;
  assert.equal(block, createHmac('sha256', Buffer.alloc(64, 7)).update('x').digest('hex'), 'a 64-byte key is one block, unhashed');

  const { handle, record: r, expiresAt, issuer } = VECTOR;
  const [{ m }] = await owner`select tmpos_mint.mint_message(${handle}, ${r.audience}, ${r.authProvider}, ${r.authProviderUid},
    ${r.principalKey}, ${r.securityVersion}, ${r.authenticatedAt}::bigint, ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint,
    ${r.validatedAt}::bigint, ${expiresAt}::bigint) as m`;
  assert.equal(m.toString('utf8'), VECTOR.message, 'the SQL message');
  assert.equal(m.length, 182);
  assert.deepEqual(mintMessage(handle, r, expiresAt), m, 'this suite\'s netstrings produce the same bytes');
  const [{ p, f }] = await owner`select encode(tmpos_mint.hmac_sha256(${issuer}::bytea, ${m}::bytea), 'hex') as p,
    encode(tmpos_mint.hmac_sha256(${issuer}::bytea, convert_to('tmpos-tenant-issuer-key-fingerprint:v1', 'UTF8')), 'hex') as f`;
  assert.deepEqual([p, f], [VECTOR.proof, VECTOR.fingerprint], 'the SQL proof and fingerprint');
  assert.deepEqual([proofOf(issuer, handle, r, expiresAt).toString('hex'), fingerprintOf(issuer).toString('hex')], [VECTOR.proof, VECTOR.fingerprint],
    'Node\'s createHmac');
  // Any NULL but authenticated_at makes no message; authenticated_at NULL is the empty netstring.
  const [{ none }] = await owner`select tmpos_mint.mint_message('k', 'tenant', 'firebase', 'u', 'p', 'v', 1, 1, 1, 1, null) is null as none`;
  assert.equal(none, true);
});

test('M7M-03b: the runtime\'s tenantMintProof (postgresSessionStore.ts) is the same construction, and the database accepts it', async () => {
  const { tenantMintProof } = await import('../../server/persistence/postgresSessionStore.ts');
  assert.equal(typeof tenantMintProof, 'function', 'postgresSessionStore.ts exports tenantMintProof');
  const { handle, record: r, expiresAt, issuer } = VECTOR;
  assert.equal(Buffer.from(tenantMintProof(issuer, handle, r, expiresAt)).toString('hex'), VECTOR.proof, 'the recorded vector');
  const key = newKey();
  const live = record(A_USER, Date.now(), { authenticatedAt: null });
  const exp = live.createdAt + HOUR;
  const proof = Buffer.from(tenantMintProof(issuerNow, key, live, exp));
  assert.deepEqual(proof, proofOf(issuerNow, key, live, exp), 'a live record, authenticatedAt null');
  assert.equal(await mintAs(runtime, key, live, exp, proof), 'created', 'the database accepts the runtime\'s proof');
  await reads(key, T_A, SEED_A, 'and the session reads');
});

test('M7M-04: key custody: the login cannot touch the key, the ledger or a helper; the key check answers only four words', async () => {
  for (const statement of [
    'select * from tmpos_mint.issuer_key', 'update tmpos_mint.issuer_key set singleton = true', 'delete from tmpos_mint.issuer_key',
    'truncate tmpos_mint.issuer_key', 'select * from tmpos_mint.tenant_session', 'update tmpos_mint.tenant_session set expires_at = 1',
    'delete from tmpos_mint.tenant_session', 'truncate tmpos_mint.tenant_session',
  ]) {
    assert.equal(await codeOf(runtime.unsafe(statement)), '42501', `the runtime login is refused: ${statement}`);
  }
  assert.equal(await codeOf(runtime`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${randomBytes(32)})`), '42501');
  assert.equal(await codeOf(runtime`insert into tmpos_mint.tenant_session values (${newKey()}, ${randomBytes(32)}, ${randomBytes(32)}, 1)`), '42501');
  assert.equal(await codeOf(runtime`select tmpos_mint.hmac_sha256('\\x00'::bytea, '\\x00'::bytea)`), '42501');
  assert.equal(await codeOf(runtime`select tmpos_mint.mint_message('k', 'tenant', 'firebase', 'u', 'p', 'v', 1, 1, 1, 1, 2)`), '42501');

  // The table's own CHECKs: one row, 32-64 bytes.
  assert.equal(await codeOf(owner`insert into tmpos_mint.issuer_key (singleton, key) values (false, ${randomBytes(32)})`), '23514');
  for (const n of [31, 65]) {
    assert.equal(await codeOf(owner`update tmpos_mint.issuer_key set key = ${randomBytes(n)}`), '23514', `a ${n}-byte key`);
  }

  await owner`delete from tmpos_mint.issuer_key`;
  try {
    assert.equal(await keyCheck(fingerprintOf(K)), 'absent');
  } finally {
    await install(K);
  }
  assert.equal(await keyCheck(fingerprintOf(K)), 'match');
  assert.equal(await keyCheck(fingerprintOf(randomBytes(32))), 'mismatch');
  assert.equal(await keyCheck(randomBytes(32)), 'mismatch', 'the key itself is not its fingerprint');
  for (const bad of [null, randomBytes(31), randomBytes(33)]) assert.equal(await keyCheck(bad), 'invalid');
});

// ---------------------------------------------------------------------------
// M7M-05..08: the mint's refusals, CH1's levers, the fail-closed matrix, the differential
// ---------------------------------------------------------------------------

/** The session keys and provider UIDs of the argument cases below: none may reach the server log. */
const ARGUMENT_CASE_VALUES = new Set();

test('M7M-05: every mint refusal writes nothing: 011 closed, forged or altered proofs refused, and every argument checked first on BOTH branches', async () => {
  /** `fn` answers `expected`, and neither the ledger nor the session table changed. */
  const unchanged = async (label, fn, expected) => {
    const before = await counts();
    assert.equal(await fn(), expected, label);
    assert.deepEqual(await counts(), before, `${label}: nothing written`);
  };
  const base = (over = {}) => {
    const key = newKey();
    const r = record(A_USER, Date.now(), over);
    return { key, r, e: r.createdAt + HOUR };
  };

  await unchanged('011\'s create as the runtime login', () => codeOf(runtime`select tmpos_session.m5_session_create(${newKey()}::text,
    'tenant', 'firebase', ${A_USER.uid}::text, ${principalKeyOf(A_USER.principal)}::text, 'v', 1::bigint, 1::bigint, 1::bigint, 1::bigint, 2::bigint)`), '42501');

  // Proofs: forged, under another key, and a valid proof over values other than those sent — each of the ten.
  {
    const { key, r, e } = base();
    const valid = proofOf(K, key, r, e);
    await unchanged('a random proof', () => mintAs(runtime, key, r, e, randomBytes(32)), 'refused');
    await unchanged('a proof under another key', () => mintAs(runtime, key, r, e, proofOf(randomBytes(32), key, r, e)), 'refused');
    for (const [label, sent] of [
      ['session key', [`${key}x`, r, e]],
      ['provider', [key, { ...r, authProvider: 'google' }, e]],
      ['provider uid', [key, { ...r, authProviderUid: `${r.authProviderUid}x` }, e]],
      ['principal key', [key, { ...r, principalKey: `${r.principalKey}x` }, e]],
      ['security version', [key, { ...r, securityVersion: `${r.securityVersion}x` }, e]],
      ['authenticated at', [key, { ...r, authenticatedAt: r.authenticatedAt - 1 }, e]],
      ['created at', [key, { ...r, createdAt: r.createdAt - 1 }, e]],
      ['last seen at', [key, { ...r, lastSeenAt: r.lastSeenAt + 1 }, e]],
      ['validated at', [key, { ...r, validatedAt: r.validatedAt + 1 }, e]],
      ['expires at', [key, r, e - 1]],
    ]) {
      await unchanged(`a valid proof, ${label} altered`, () => mintAs(runtime, ...sent, valid), 'refused');
    }
    await unchanged('a valid proof, audience altered to admin', () => mintAs(runtime, key, { ...r, audience: 'admin' }, e, valid), 'invalid');
    await unchanged('no proof on a tenant record', () => mintAs(runtime, key, r, e, null), 'invalid');
    await unchanged('a 31-byte proof', () => mintAs(runtime, key, r, e, valid.subarray(0, 31)), 'invalid');
    await unchanged('an unknown audience', () => mintAs(runtime, key, { ...r, audience: 'platform' }, e, valid), 'invalid');
    const long = r.createdAt + TENANT_LIFETIME + 1;
    await unchanged('a lifetime over eight hours', () => mintAs(runtime, key, r, long, proofOf(K, key, r, long)), 'invalid');
    const ahead = record(A_USER, Date.now() + 120_000);
    await unchanged('created two minutes ahead of the database clock', () => mintAs(runtime, key, ahead, ahead.createdAt + HOUR,
      proofOf(K, key, ahead, ahead.createdAt + HOUR)), 'invalid');
    await owner`delete from tmpos_mint.issuer_key`;
    try {
      await unchanged('no key installed', () => mintAs(runtime, key, r, e, valid), 'refused');
    } finally {
      await install(K);
    }
    assert.equal(await mintAs(runtime, key, r, e, valid), 'created', 'the unaltered call mints');
    await reads(key, T_A, SEED_A, 'and reads');
  }

  // D2: an argument 011's table would refuse is 'invalid' on BOTH branches — with a valid proof over it on the tenant's —
  // and writes nothing, so no caller value can reach a constraint violation's DETAIL.
  const at = Date.now();
  const cases = [
    ['last_seen_at before created_at (J5)', { lastSeenAt: at - 10_000 }],
    ['validated_at before created_at', { validatedAt: at - 1 }],
    ['a session key with a space', {}, (k) => `${k} x`],
    ['an empty session key', {}, () => ''],
    ['a 129-character session key', {}, (k) => `${k}${'k'.repeat(129 - k.length)}`],
    ['a NULL session key', {}, () => null],
    ['an upper-case provider', { authProvider: 'Firebase' }],
    ['an empty provider', { authProvider: '' }],
    ['an empty provider uid', { authProviderUid: '' }],
    ['a 129-character provider uid', { authProviderUid: `${A_USER.uid}${'u'.repeat(129 - A_USER.uid.length)}` }],
    ['a NULL provider uid', { authProviderUid: null }],
    ['a principal key with a space', { principalKey: 'with space' }],
    ['an empty security version', { securityVersion: '' }],
    ['a 129-character security version', { securityVersion: 'v'.repeat(129) }],
    ['a NULL security version', { securityVersion: null }],
    ['authenticated_at 0', { authenticatedAt: 0 }],
    ['authenticated_at past the safe integers', { authenticatedAt: 2 ** 53 }],
    ['created_at 0', { createdAt: 0 }],
    ['a NULL created_at', { createdAt: null }],
    ['last_seen_at 0', { lastSeenAt: 0 }],
    ['a NULL validated_at', { validatedAt: null }],
    ['expires_at equal to created_at', {}, undefined, (r) => r.createdAt],
    ['expires_at past the safe integers', {}, undefined, () => 2 ** 53],
    ['a NULL expires_at', {}, undefined, () => null],
  ];
  for (const [label, over, keyOf = (k) => k, expiresOf = (r) => r.createdAt + HOUR] of cases) {
    const generated = newKey();
    const key = keyOf(generated);
    const r = record(A_USER, at, over);
    const e = expiresOf(r);
    ARGUMENT_CASE_VALUES.add(generated);
    if (typeof r.authProviderUid === 'string' && r.authProviderUid.length >= 8) ARGUMENT_CASE_VALUES.add(r.authProviderUid);
    await unchanged(`tenant, ${label}`, () => mintAs(runtime, key, r, e, proofOf(K, key, r, e)), 'invalid');
    await unchanged(`admin, ${label}`, () => mintAs(runtime, key, { ...r, audience: 'admin' }, e, null), 'invalid');
  }

  // A taken key: by a tenant row, by an admin row, and a captured mint replayed after its session ended.
  const first = await mint(A_USER, HOUR);
  assert.equal(first.outcome, 'created');
  const again = record(A_USER, Date.now() + 1);
  await unchanged('a key a tenant row holds', () => mintAs(runtime, first.key, again, again.createdAt + HOUR,
    proofOf(K, first.key, again, again.createdAt + HOUR)), 'conflict');
  const adminKey = newKey();
  const adminRecord = record(A_USER, Date.now(), { audience: 'admin' });
  assert.equal(await mintAs(runtime, adminKey, adminRecord, adminRecord.createdAt + HOUR, null), 'created', 'the unproven admin branch');
  const onAdmin = record(A_USER);
  await unchanged('a key an admin row holds', () => mintAs(runtime, adminKey, onAdmin, onAdmin.createdAt + HOUR,
    proofOf(K, adminKey, onAdmin, onAdmin.createdAt + HOUR)), 'conflict');
  await runtime`select tmpos_session.m5_session_revoke(${first.key}::text)`;
  await unchanged('the captured mint replayed after its session was revoked (the ledger outlives it)',
    () => mintAs(runtime, first.key, first.r, first.expiresAt, proofOf(K, first.key, first.r, first.expiresAt)), 'conflict');
  await denied(first.key, 'and the replay revived no read');

  // What the old prototype let through to the server log (J5): the disposable cluster's log holds none of these values.
  if (cluster !== null) {
    const log = readFileSync(`${cluster.root}/postgres.log`, 'utf8');
    const leaked = [...ARGUMENT_CASE_VALUES, K.toString('hex'), K.toString('base64')].filter((v) => log.includes(v));
    assert.deepEqual(leaked, [], 'no session key, provider uid or issuer key in the server log');
  }
});

test('M7M-06: CH1\'s direct-call levers: 017\'s page is closed to the login, and v2 answers only \'denied\' for any key not minted and live', async () => {
  // The full tuple the login can still build for B, from the resolver and the admission read.
  const [a] = await runtime`select actor_id, security_version, memberships from tmpos_session.m5_admit_tenant_session_v2('firebase', ${B_USER.uid})`;
  const grant = a.memberships.find((m) => m.scopeType === 'tenant');
  const [{ security_version: resolved }] = await runtime`select security_version from tmpos_identity.m5_resolve_principal('firebase', ${B_USER.uid})`;
  assert.equal(resolved, a.security_version);
  assert.equal(await codeOf(runtime`select * from tmpos_customer.m7a_customer_page(${a.actor_id}::uuid, ${a.security_version}::text,
    ${grant.membershipId}::uuid, ${grant.roleId}::text, ${grant.tenantId}::uuid, null::uuid, 101::integer)`), '42501', 'the K1 lever is closed');

  await denied(newKey(), 'a random key');
  await denied('~'.repeat(128), 'a 128-character printable key');
  assert.deepEqual(await page('has space'), [{ ...DENIED, o_outcome: 'invalid' }], 'a malformed key');
  // A session row written before 018 (by the owner here), under A: no ledger row, so nothing.
  const legacy = newKey();
  const now = Date.now();
  KEYS.add(legacy);
  await owner`insert into tmpos_session.session (session_key, audience, auth_provider, auth_provider_uid, principal_key, security_version,
      authenticated_at, created_at, last_seen_at, validated_at, expires_at)
    values (${legacy}, 'tenant', 'firebase', ${A_USER.uid}, ${principalKeyOf(A_USER.principal)}, 't2:legacy', ${now}, ${now}, ${now}, ${now}, ${now + HOUR})`;
  await denied(legacy, 'a legacy pre-018 tenant row');
  const adminKey = newKey();
  const adminRecord = record(A_USER, now, { audience: 'admin' });
  assert.equal(await mintAs(runtime, adminKey, adminRecord, now + HOUR, null), 'created');
  await denied(adminKey, 'an admin-audience key minted through the admin branch');
  const own = await mint(A_USER);
  await reads(own.key, T_A, SEED_A, 'A\'s own minted key');
  await runtime`select tmpos_session.m5_session_revoke(${own.key}::text)`;
  await denied(own.key, 'A\'s own key after m5_session_revoke');

  // The RLS context the login sets itself (critic C2) still discloses B's membership rows — a recorded residual — and
  // still reaches no customer: the table and 017's page are refused, and v2 takes no tenant.
  const disclosed = await runtime.begin(async (tx) => {
    await tx`select pg_catalog.set_config('app.tenant_id', ${T_B}, true), pg_catalog.set_config('app.scope_type', 'tenant', true)`;
    return tx`select membership_id from public.user_membership where tenant_id = ${T_B}`;
  });
  assert.ok(disclosed.length >= 1, 'the self-set context still reads B\'s memberships (R6)');
  assert.equal(await codeOf(runtime.begin(async (tx) => {
    await tx`select pg_catalog.set_config('app.tenant_id', ${T_B}, true), pg_catalog.set_config('app.scope_type', 'tenant', true)`;
    return tx`select count(*) from tmpos_customer.customer`;
  })), '42501', 'and no customer row');
});

test('M7M-06b: the read\'s audience and expiry clauses each deny on their own: an admin row with a valid ledger row, and a moved expiry', async () => {
  // TA-1. An admin-audience row under A, and a ledger row the OWNER writes for it that passes every other clause: A's
  // standing digest now, the installed key's digest, the row's own expiry. Only the audience clause denies it, as the
  // control shows: the same row relabelled 'tenant' reads.
  const adminKey = newKey();
  const at = Date.now();
  const adminRecord = record(A_USER, at, { audience: 'admin' });
  assert.equal(await mintAs(runtime, adminKey, adminRecord, at + HOUR, null), 'created');
  await owner`insert into tmpos_mint.tenant_session (session_key, standing_digest, issuer_digest, expires_at)
    select ${adminKey}, pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')),
           (select pg_catalog.sha256(k.key) from tmpos_mint.issuer_key k where k.singleton), ${at + HOUR}::bigint
      from tmpos_session.m5_admit_tenant_session_v2('firebase', ${A_USER.uid}) r`;
  await denied(adminKey, 'an admin row with a ledger row valid in every other respect');
  await owner`update tmpos_session.session set audience = 'tenant' where session_key = ${adminKey}`;
  await reads(adminKey, T_A, SEED_A, 'control: the same rows with audience tenant read');

  // TA-2. A minted tenant session whose row's expiry the owner moves, later or earlier and still ahead, is denied: the
  // row must carry the ledger's own expiry. Moved back, it reads again.
  const s = await mint(A_USER);
  await reads(s.key, T_A, SEED_A, 'minted: reads');
  for (const moved of [s.expiresAt + HOUR, s.expiresAt - 60_000]) {
    await owner`update tmpos_session.session set expires_at = ${moved}::bigint where session_key = ${s.key}`;
    await denied(s.key, `the row's expiry moved by ${moved - s.expiresAt} ms`);
  }
  await owner`update tmpos_session.session set expires_at = ${s.expiresAt}::bigint where session_key = ${s.key}`;
  await reads(s.key, T_A, SEED_A, 'control: the ledger\'s expiry restored, it reads');
});

test('M7M-07: every standing change fails closed on a minted session, reactivation never revives it, and a fresh mint reads again', async () => {
  const setStatus = (table, key, id, status) => owner.unsafe(`update ${table} set status = $1 where ${key} = $2`, [status, id]);
  /** Mint and read; change; denied; revert; still denied; a fresh mint reads (or is denied, when `fresh` says so). */
  const round = async (label, who, tenant, ids, change, revert, fresh = 'reads') => {
    const s = await mint(who);
    assert.equal(s.outcome, 'created', label);
    await reads(s.key, tenant, ids, `${label}: before`);
    await change();
    await denied(s.key, `${label}: after the change`);
    if (revert !== null) {
      await revert();
      await denied(s.key, `${label}: reverted, the old session stays denied`);
    }
    const next = await mint(who);
    assert.equal(next.outcome, 'created', `${label}: a fresh mint`);
    if (fresh === 'reads') await reads(next.key, tenant, ids, `${label}: a fresh mint reads`);
    else await denied(next.key, `${label}: a fresh mint is denied too`);
  };

  await round('grant suspended', GRANT_USER, T_A, SEED_A,
    () => owner`update user_membership set status = 'suspended' where internal_user_id = ${GRANT_USER.id}`,
    () => owner`update user_membership set status = 'active' where internal_user_id = ${GRANT_USER.id}`);
  await round('account suspended', ACCOUNT_USER, T_A, SEED_A,
    () => setStatus('app_user', 'internal_user_id', ACCOUNT_USER.id, 'suspended'),
    () => setStatus('app_user', 'internal_user_id', ACCOUNT_USER.id, 'active'));
  await round('tenant suspended', TENANT_USER, T_SUSPEND, SEED_SUSPEND,
    () => setStatus('tenant', 'tenant_id', T_SUSPEND, 'suspended'),
    () => setStatus('tenant', 'tenant_id', T_SUSPEND, 'active'));
  await round('role manager -> technician', ROLE_USER, T_A, SEED_A,
    () => owner`update user_membership set role_id = 'technician' where internal_user_id = ${ROLE_USER.id}`, null);
  await round('an identity link added', LINK_USER, T_A, SEED_A, async () => {
    const supabaseUid = `m7m-link-sb-${SUFFIX}`;
    await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('supabase', ${supabaseUid})`;
    await owner`insert into identity_link (internal_user_id, firebase_auth_provider_uid, supabase_auth_provider_uid)
      values (${LINK_USER.id}, ${LINK_USER.uid}, ${supabaseUid})`;
  }, null);
  await round('a second tenant grant added (ambiguous)', SECOND_USER, T_A, SEED_A,
    () => owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${SECOND_USER.id}, ${T_C}, null, 'tenant', 'manager', 'active')`, null, 'denied');
  await round('revoke_principal', REVOKED_USER, T_A, SEED_A,
    () => runtime`select tmpos_session.m5_session_revoke_principal('tenant', ${principalKeyOf(REVOKED_USER.principal)}::text)`, null);

  // A store-only actor mints (the mint requires no tenant grant) and reads nothing.
  const store = await mint(STORE_ONLY);
  assert.equal(store.outcome, 'created');
  await denied(store.key, 'a store-only actor');

  // Absolute expiry on the DATABASE clock: the stamps the login can slide do not extend it.
  const short = await mint(EXPIRE_USER, 4_000, Date.now() - 500);
  await reads(short.key, T_A, SEED_A, 'short-lived: before expiry');
  const [{ o: touched }] = await runtime`select tmpos_session.m5_session_touch(${short.key}::text, 'lastSeenAt', ${Date.now() + HOUR}::bigint) as o`;
  assert.equal(touched, 'updated');
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, short.expiresAt - Date.now()) + 250));
  await denied(short.key, 'past expires_at on the database clock, whatever last_seen_at says');
  // A record stamped years ago mints (the port's conformance records do) and reads nothing.
  const old = await mint(EXPIRE_USER, HOUR, Date.UTC(2023, 10, 14));
  assert.equal(old.outcome, 'created', 'a past record mints');
  await denied(old.key, 'and reads nothing');
});

test('M7M-08: for the authority v2 derives, its answers equal 017\'s page run as the owner: pages, walks, cursors, limits, empty', async () => {
  /** The tuple v2 derives, read by the owner from 016's answer: exactly one tenant grant. */
  const tupleOf = async (who) => {
    const [a] = await owner`select actor_id, security_version, memberships from tmpos_session.m5_admit_tenant_session_v2('firebase', ${who.uid})`;
    const grants = a.memberships.filter((m) => m.scopeType === 'tenant');
    assert.equal(grants.length, 1);
    return { actor: a.actor_id, version: a.security_version, membership: grants[0].membershipId, role: grants[0].roleId, tenant: grants[0].tenantId };
  };
  const ownerPage = async (t, after, limit) => (await owner`select o_outcome, o_tenant_id, o_customer_id, o_name
    from tmpos_customer.m7a_customer_page(${t.actor}::uuid, ${t.version}::text, ${t.membership}::uuid, ${t.role}::text, ${t.tenant}::uuid,
      ${after}::uuid, ${limit}::integer)`).map((r) => ({ ...r }));
  const same = async (s, t, after, limit, label) => {
    const [mine, theirs] = [await page(s.key, after, limit), await ownerPage(t, after, limit)];
    assert.deepEqual(mine, theirs, label);
    return mine;
  };

  const b = await mint(B_USER);
  const tb = await tupleOf(B_USER);
  assert.equal(tb.tenant, T_B);
  for (const limit of [1, 50, 100, 101]) assert.equal((await same(b, tb, null, limit, `limit ${limit}`)).length, limit);
  for (const limit of [101, 7]) {
    const walked = [];
    let after = null;
    for (let guard = 0; guard < 50; guard++) {
      const rows = await same(b, tb, after, limit, `walk at ${limit}, page ${guard + 1}`);
      walked.push(...rows);
      if (rows.length < limit) break;
      after = rows.at(-1).o_customer_id;
    }
    assert.deepEqual(walked.map((r) => r.o_customer_id).sort(), [...SEED_B].sort(), `walk at ${limit}: every B customer once`);
    assert.ok(walked.every((r) => r.o_outcome === 'customer' && r.o_tenant_id === T_B));
  }
  assert.deepEqual(await same(b, tb, SEED_A[0], 10, 'another tenant\'s customer'), [{ ...DENIED, o_outcome: 'cursor_unknown' }]);
  const [gone] = await seed(T_B, [`Gone ${SUFFIX}`]);
  await owner`delete from tmpos_customer.customer where customer_id = ${gone}`;
  assert.deepEqual(await same(b, tb, gone, 10, 'a deleted customer'), [{ ...DENIED, o_outcome: 'cursor_unknown' }]);
  for (const limit of [0, 102, null]) {
    assert.deepEqual(await same(b, tb, null, limit, `limit ${limit}`), [{ ...DENIED, o_outcome: 'invalid' }]);
  }
  const empty = await mint(EMPTY_USER);
  assert.deepEqual(await same(empty, await tupleOf(EMPTY_USER), null, 50, 'an empty tenant'), []);
  const c = await mint(await actor('c-user', [tenantGrant(T_C, 'sales_staff')]));
  await reads(c.key, T_C, SEED_C, 'C reads exactly C');
});

// ---------------------------------------------------------------------------
// M7M-09..10: rollback; concurrency, rotation and removal, the admin branch
// ---------------------------------------------------------------------------

/** What the startup preflight answered while the database held 017's grants again (M7M-09), judged in M7M-02b. */
let preflightAt017 = null;

async function runtimePreflight() {
  const { createPostgresStartupPreflight } = await import('../../server/persistence/postgresStartupPreflight.ts');
  const preflight = createPostgresStartupPreflight({ client });
  return { runtimeLogin: await preflight.runtimeLogin(signal()), migrationLedger: await preflight.migrationLedger(signal()) };
}

test('M7M-09: 018 down refuses under REPEATABLE READ and while the key or the ledger holds a row; clean, it restores 017\'s exact grants and re-applies', async () => {
  const RC = 'isolation level read committed';
  const withKey = await rolledBack(RC, (tx) => tx.unsafe(DOWN_018).simple());
  assert.equal(withKey.code, '55000');
  assert.match(withKey.message, /still holds a row/);
  assert.ok((await counts()).ledger > 0, 'the suite\'s minted sessions are in the ledger');
  const withLedger = await rolledBack(RC, async (tx) => {
    await tx`delete from tmpos_mint.issuer_key`;
    await tx.unsafe(DOWN_018).simple();
  });
  assert.equal(withLedger.code, '55000', 'the ledger alone keeps it refusing');
  for (const isolation of ['isolation level repeatable read', 'isolation level serializable']) {
    const refused = await rolledBack(isolation, async (tx) => {
      await tx`delete from tmpos_mint.issuer_key`;
      await tx`delete from tmpos_mint.tenant_session`;
      await tx.unsafe(DOWN_018).simple();
    });
    assert.equal(refused.code, '55000', isolation);
    assert.match(refused.message, /READ COMMITTED/, `${isolation}: refused for its isolation, not for a row`);
  }

  // Clean, under READ COMMITTED: it removes only its own objects, restores the two ACL items exactly as a fresh 017
  // apply writes them, and 018 applies again over the result — all rolled back here.
  const clean = await rolledBack(RC, async (tx) => {
    await tx`delete from tmpos_mint.issuer_key`;
    await tx`delete from tmpos_mint.tenant_session`;
    await tx.unsafe(DOWN_018).simple();
    const [state] = await tx`select pg_catalog.to_regnamespace('tmpos_mint') is null as gone,
        pg_catalog.has_function_privilege('tmpos_app', ${CREATE_011}, 'EXECUTE') as create_011,
        pg_catalog.has_function_privilege('tmpos_app', ${PAGE_017}, 'EXECUTE') as page_017,
        (select proacl::text from pg_catalog.pg_proc where oid = ${CREATE_011}::regprocedure) as acl_011,
        (select proacl::text from pg_catalog.pg_proc where oid = ${PAGE_017}::regprocedure) as acl_017,
        pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is not null as s016`;
    // 017 rolled back and applied afresh in the same transaction: its page's ACL is the one 018's down restored.
    await tx`delete from tmpos_customer.customer`;
    await tx.unsafe(DOWN_017).simple();
    await tx.unsafe(UP_017).simple();
    const [{ fresh }] = await tx`select proacl::text as fresh from pg_catalog.pg_proc where oid = ${PAGE_017}::regprocedure`;
    await tx.unsafe(UP_018).simple();
    const [{ closed }] = await tx`select not pg_catalog.has_function_privilege('tmpos_app', ${PAGE_017}, 'EXECUTE')
      and not pg_catalog.has_function_privilege('tmpos_app', ${CREATE_011}, 'EXECUTE') as closed`;
    return { ...state, fresh, closed };
  });
  assert.equal(clean.code, undefined, JSON.stringify(clean));
  const [{ me }] = await owner`select current_user as me`;
  assert.deepEqual(clean.value, {
    gone: true, create_011: true, page_017: true, acl_011: `{${me}=X/${me},tmpos_app=X/${me}}`, acl_017: clean.value.fresh, s016: true,
    fresh: `{${me}=X/${me},tmpos_app=X/${me}}`, closed: true,
  });

  // Committed, as a real rollback would be: the owner empties the key and the ledger, the down runs, and the runtime
  // built for 018 has no mint left to call (its logins answer 503). The preflight's verdict on 017's grants is kept
  // for M7M-02b. Then 018 applies again and the key is reinstalled.
  await owner`delete from tmpos_mint.issuer_key`;
  await owner`delete from tmpos_mint.tenant_session`;
  await owner.begin(RC, (tx) => tx.unsafe(DOWN_018).simple());
  try {
    const r = record(A_USER);
    assert.equal(await codeOf(mintAs(runtime, newKey(), r, r.createdAt + HOUR, null)), '3F000', 'no tmpos_mint schema to call');
    preflightAt017 = await runtimePreflight().catch((err) => ({ error: String(err?.message ?? err) }));
  } finally {
    await owner.begin((tx) => tx.unsafe(UP_018).simple());
    await install(K);
  }
  const s = await mint(A_USER);
  assert.equal(s.outcome, 'created', 're-applied, the mint works');
  await reads(s.key, T_A, SEED_A, 're-applied, the read works');
});

test('M7M-09b: 017 rolled back beneath 018 leaves the read raising for a live session; 017 re-applied over it re-grants the old page, which the startup preflight refuses (rolled back)', async () => {
  const live = await mint(A_USER);
  assert.equal(live.outcome, 'created');
  const out = await rolledBack('isolation level read committed', async (tx) => {
    const v2 = (key) => tx`select o_outcome from tmpos_mint.m7a_customer_page_v2(${key}::text, null::uuid, 101::integer)`;
    // The grants the preflight approves are the whole chain's (001-025): 020, 021, 022, 023, 024 and 025 applied first, in this same
    // rolled-back transaction, so the only grant it can refuse below is 017's page re-granted (v2 is called as the owner).
    await tx.unsafe(UP_020).simple();
    await tx.unsafe(UP_021).simple();
    await tx.unsafe(UP_022).simple();
    await tx.unsafe(UP_023).simple();
    await tx.unsafe(UP_024).simple();
    await tx.unsafe(UP_025).simple();
    await tx`delete from tmpos_customer.customer`;
    await tx.unsafe(DOWN_017).simple();
    // 017's rollback does not know about 018: tmpos_mint stays, and the read raises once it reaches 017's page.
    const beneath = await tx.savepoint((sp) => sp`select o_outcome from tmpos_mint.m7a_customer_page_v2(${live.key}::text, null::uuid, 101::integer)`)
      .then(() => null, (err) => err.code);
    const [{ o_outcome: unminted }] = await v2(newKey());
    await tx.unsafe(UP_017).simple();
    const over = (await v2(live.key)).length;
    const [{ regranted }] = await tx`select pg_catalog.has_function_privilege('tmpos_app', ${PAGE_017}, 'EXECUTE') as regranted`;
    // The real preflight, run as the runtime login on this transaction's uncommitted state.
    await tx.unsafe(`set local session authorization ${RUNTIME_LOGIN}`);
    const { createPostgresStartupPreflight } = await import('../../server/persistence/postgresStartupPreflight.ts');
    const preflight = createPostgresStartupPreflight({ client: { transaction: (_signal, _bounds, fn) => fn(tx) } });
    return { beneath, unminted, over, regranted, runtimeLogin: await preflight.runtimeLogin(signal()) };
  });
  assert.deepEqual(out.value, {
    beneath: '3F000', unminted: 'denied', over: 0, regranted: true, runtimeLogin: ['role_privilege_unexpected'],
  }, JSON.stringify(out));
  await reads(live.key, T_A, SEED_A, 'rolled back: the live session reads as before');
});

test('M7M-10: concurrent identical mints create once; rotating the key denies older sessions and deleting it denies all; the admin branch stays unproven', async () => {
  // Two concurrent mints of ONE key with the IDENTICAL proof (R9b): exactly one is created, and one ledger row remains.
  {
    const key = newKey();
    const r = record(A_USER);
    const e = r.createdAt + HOUR;
    const proof = proofOf(K, key, r, e);
    const outcomes = await Promise.all([0, 1].map(() => mintAs(runtime, key, r, e, proof).catch((err) => err.code)));
    assert.deepEqual(outcomes.filter((o) => o === 'created').length, 1, JSON.stringify(outcomes));
    assert.ok(outcomes.every((o) => o === 'created' || o === 'conflict' || o === '23505'), JSON.stringify(outcomes));
    const [{ ledger, sessions }] = await owner`select (select count(*)::int from tmpos_mint.tenant_session where session_key = ${key}) as ledger,
      (select count(*)::int from tmpos_session.session where session_key = ${key}) as sessions`;
    assert.deepEqual({ ledger, sessions }, { ledger: 1, sessions: 1 }, 'no orphan ledger row');
  }
  // Interleaved: the second waits on the first's ledger row. Committed, it is 'conflict'; rolled back, the waiting call
  // mints — a proof whose login rolled back stays a bearer until its expiry (J6, recorded: R10's logging class).
  const blocked = new Error('m7m: the first mint rolls back');
  for (const firstCommits of [true, false]) {
    const key = newKey();
    const r = record(A_USER);
    const e = r.createdAt + HOUR;
    const proof = proofOf(K, key, r, e);
    let second;
    const first = runtime.begin(async (tx) => {
      assert.equal(await mintAs(tx, key, r, e, proof), 'created');
      second = mintAs(runtime, key, r, e, proof);
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!firstCommits) throw blocked;
    });
    await (firstCommits ? first : assert.rejects(first, (err) => err === blocked));
    assert.equal(await second, firstCommits ? 'conflict' : 'created', firstCommits ? 'after a commit' : 'after a rollback');
  }

  // D1: rotation denies every session minted under the old key, and the old proof is refused; a fresh mint under the new
  // key reads; deleting the key denies every read and every mint.
  const old = await mint(B_USER);
  await reads(old.key, T_B, SEED_B, 'minted under the suite key');
  const K2 = randomBytes(32);
  await install(K2);
  issuerNow = K2;
  try {
    await denied(old.key, 'rotated: the old-key session is denied');
    assert.equal(await mintAs(runtime, old.key, old.r, old.expiresAt, proofOf(K, old.key, old.r, old.expiresAt)), 'refused', 'the old proof is refused');
    const fresh = await mint(B_USER);
    assert.equal(fresh.outcome, 'created');
    await reads(fresh.key, T_B, SEED_B, 'a fresh mint under the new key reads');
    assert.deepEqual([await keyCheck(fingerprintOf(K2)), await keyCheck(fingerprintOf(K))], ['match', 'mismatch']);

    await owner`delete from tmpos_mint.issuer_key`;
    await denied(fresh.key, 'no key: the new-key session is denied');
    await denied(old.key, 'no key: the old-key session is denied');
    assert.equal((await mint(B_USER)).outcome, 'refused', 'no key: no mint');
    assert.equal(await keyCheck(fingerprintOf(K2)), 'absent');
  } finally {
    await install(K);
    issuerNow = K;
  }
  const back = await mint(B_USER);
  await reads(back.key, T_B, SEED_B, 'the suite key reinstalled: a fresh mint reads');

  // The admin branch is 011's create behind the argument check: malformed is 'invalid' and writes nothing.
  const bad = record(PLATFORM_ONLY, Date.now(), { audience: 'admin', validatedAt: 1 });
  const before = await counts();
  assert.equal(await mintAs(runtime, newKey(), bad, bad.createdAt + HOUR, null), 'invalid');
  assert.deepEqual(await counts(), before);

  // R4 EVIDENCE, RECORDED NOT FIXED (DA-37): the login alone writes an admin session row under an identifier it chose,
  // with the witness the platform admission answers for a real administrator, and a real admin boundary over a real
  // socket serves it. The modules other workers change in this stage are imported here, so one in flight fails only this.
  const { createApp, createBoundedServer, createReadinessState } = await import('../../server/runtime/app.ts');
  const { sessionPaths } = await import('../../server/runtime/routes.ts');
  const { createPostgresSessionStore } = await import('../../server/persistence/postgresSessionStore.ts');
  const { createPostgresPlatformAdmission } = await import('../../server/persistence/postgresPlatformAdmission.ts');
  const { createAdmittedPlatformAuthorizer, createPlatformSessionAdmission } = await import('../../server/composition/platformAuthorization.ts');
  const { createMemoryRateLimiter, testRequestLimits } = await import('../../server/runtime/rateLimiter.testkit.ts');
  const admission = createPlatformSessionAdmission({ admission: createPostgresPlatformAdmission({ client }) });
  const standing = await admission.admit(PLATFORM_ONLY.principal, 'admin', signal());
  assert.equal(standing.admitted, true, 'a real administrator');
  const id = randomBytes(32).toString('base64url');
  const at = Date.now();
  const forged = record(PLATFORM_ONLY, at, { audience: 'admin', securityVersion: standing.securityVersion });
  assert.equal(await mintAs(runtime, digestOf(id), forged, at + HOUR, null), 'created', 'the login wrote an admin row it chose');
  await denied(digestOf(id), 'it reads no customer');
  const logs = [];
  let clock = Date.now();
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness,
    log: { log: (line) => logs.push(line) },
    routes: [],
    limits: testRequestLimits({ limiter: createMemoryRateLimiter({ now: () => (clock += 3_600_001) }) }),
    sessions: {
      admin: {
        trustedOrigins: [ADMIN_ORIGIN],
        verifier: Object.freeze({ verify: async () => null }),
        admission,
        authorizer: createAdmittedPlatformAuthorizer(),
        store: createPostgresSessionStore({ client }),
      },
    },
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path: sessionPaths('admin').current,
        headers: { cookie: `${SESSION_COOKIES.admin}=${id}` }, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200, 'R4: an app-minted admin session is presentable on an admin boundary');
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  assert.ok(logs.length > 0 && logs.every((line) => !line.includes(id) && !line.includes(digestOf(id))), 'no identifier or key in a log line');
});

// ---------------------------------------------------------------------------
// M7M-12, M7M-02b: the standing digest's rendering; the startup preflight's verdict
// ---------------------------------------------------------------------------

test('M7M-12: the standing digest is pinned to PostgreSQL\'s record and jsonb rendering, and no caller setting moves it', async () => {
  // A fixed synthetic answer with 016 v2's column types in its order. If record_out or jsonb_out ever render it
  // differently, every minted session's reads are denied until its user signs in again (R8): this pin says so first.
  const [{ text, digest }] = await owner`with fixed as (select row('resolved'::text, '00000000-0000-4000-8000-000000000001'::uuid,
      'active'::text, null::text, 'sv-fixed'::text,
      '[{"membershipId": "00000000-0000-4000-8000-000000000003", "scopeType": "tenant", "tenantId": "00000000-0000-4000-8000-000000000002", "storeId": null, "roleId": "manager", "tenantStatus": "active", "storeStatus": null, "tenantAccessVersion": "7", "storeAccessVersion": null}]'::jsonb,
      '3'::text, '5'::text) as r)
    select r::text as text, encode(sha256(convert_to(r::text, 'UTF8')), 'hex') as digest from fixed`;
  const PINNED_TEXT = '(resolved,00000000-0000-4000-8000-000000000001,active,,sv-fixed,"[{""roleId"": ""manager"", ""storeId"": null, ""tenantId"": ""00000000-0000-4000-8000-000000000002"", ""scopeType"": ""tenant"", ""storeStatus"": null, ""membershipId"": ""00000000-0000-4000-8000-000000000003"", ""tenantStatus"": ""active"", ""storeAccessVersion"": null, ""tenantAccessVersion"": ""7""}]",3,5)';
  assert.equal(text, PINNED_TEXT);
  assert.equal(digest, createHash('sha256').update(PINNED_TEXT).digest('hex'));

  // A real mint records exactly SHA-256 of 016 v2's row as text.
  const s = await mint(A_USER);
  const [{ standing, rendered }] = await owner`select m.standing_digest as standing,
      (select r::text from tmpos_session.m5_admit_tenant_session_v2('firebase', ${A_USER.uid}) r) as rendered
    from tmpos_mint.tenant_session m where m.session_key = ${s.key}`;
  assert.deepEqual(standing, createHash('sha256').update(rendered).digest(), 'the ledger holds the digest of 016\'s answer');

  // J3: the caller's rendering settings, hostile both at mint and at read, move nothing.
  const hostile = async (tx) => {
    for (const setting of [`datestyle = 'SQL, DMY'`, `intervalstyle = 'sql_standard'`, 'extra_float_digits = -15', `bytea_output = 'escape'`,
      `timezone = 'Pacific/Kiritimati'`]) {
      await tx.unsafe(`set local ${setting}`);
    }
  };
  const readUnder = await runtime.begin(async (tx) => {
    await hostile(tx);
    return (await tx`select o_outcome, o_tenant_id, o_customer_id from tmpos_mint.m7a_customer_page_v2(${s.key}::text, null::uuid, 101::integer)`)
      .map((r) => ({ ...r }));
  });
  assert.deepEqual(readUnder.map((r) => r.o_customer_id).sort(), [...SEED_A].sort(), 'read under hostile settings');
  const key = newKey();
  const r = record(A_USER);
  const e = r.createdAt + HOUR;
  const minted = await runtime.begin(async (tx) => {
    await hostile(tx);
    return mintAs(tx, key, r, e, proofOf(K, key, r, e));
  });
  assert.equal(minted, 'created');
  await reads(key, T_A, SEED_A, 'minted under hostile settings, read under the defaults');
});

test('M7M-02b: the real startup preflight accepts the login after 018, and refused 017\'s grants (needs the preflight pins for 018)', async () => {
  // The preflight now requires the whole chain, 001-025 (M7A-CUSTOMERS-P3-R1, -P4, -P6, -P7, -P8): at this file's 019 it
  // refuses exactly the missing 020-025 — their ledger rows and grants — and 019's create / 018's page_v2 grants 020 revokes.
  const at019 = await runtimePreflight();
  assert.deepEqual(at019, { runtimeLogin: ['role_privilege_missing', 'role_privilege_unexpected'], migrationLedger: ['migration_missing'] },
    `at 019 the preflight refuses the missing 020-025: ${JSON.stringify(at019)}`);
  // 020, 021, 022, 023, 024 and 025 applied through the same trusted executor (the full file port), judged, then rolled back to this file's chain.
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const report = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
    assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 400));
  } finally {
    await handle.dispose();
  }
  try {
    assert.deepEqual(await runtimePreflight(), { runtimeLogin: [], migrationLedger: [] },
      'postgresStartupPreflight.ts REQUIRED_MIGRATIONS and APPROVED_ROLE_GRANTS carry 018 (and, since P3-R1, 019 and 020; since P4, 021 and 022; since P6, 023; since P7, 024; since P8, 025)');
  } finally {
    assert.deepEqual((await rollBackAbove(owner, MIG_DIR, '019')).rolledBack, ['025', '024', '023', '022', '021', '020'], 'newest first: 025, 024, 023, 022, 021, then 020');
  }
  assert.ok(preflightAt017 !== null, 'M7M-09 captured the 017-era answer');
  // 018 rolled back: both categories. The codes name categories, not grants; which grants moved (011's create and 017's
  // page back, the mint's routines and schema gone) is M7M-09's own check. DA-100's "017 re-applied over 018" state is
  // M7M-09b's: unexpected alone.
  assert.deepEqual(preflightAt017.runtimeLogin, ['role_privilege_missing', 'role_privilege_unexpected'],
    `the 017-era grants are refused: ${JSON.stringify(preflightAt017)}`);
});
