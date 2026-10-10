// Phase 4.0 M7B-INVOICES-P1 — the stores a tenant session may act at, against REAL PostgreSQL: migration 027 (schema
// tmpos_store_access, the one STABLE SECURITY DEFINER routine m7b_store_directory) exercised as the runtime's own non-owner
// login, and GET /api/v1/stores through the REAL tenant entry over loopback HTTP.
//
// WHAT IS PROVEN.
//   STA-01 001-032 applied clean, every ledger checksum the pinned one; 027's postcondition re-proven over the applied state
//          and refusing every widening it names (tmpos_app made a member of the owner among them); a second apply refused,
//          and an apply over a chain missing 026's routine, 016's admission read or 002's membership table refused.
//   STA-02 the inventory and ACL: one STABLE plpgsql SECURITY DEFINER routine pinned to pg_catalog, pg_temp with
//          row_security off; its ACL exactly the owner's and a non-grantable EXECUTE for tmpos_app (no PUBLIC entry); the
//          schema's exactly the owner's and tmpos_app's USAGE; the runtime login executes it, tmpos_audit_writer, anon and
//          authenticated cannot.
//   STA-03 discovery over two stores of one tenant, a store of a second (overdue) tenant and a third tenant the actor holds
//          nothing in: exactly the usable stores, each with its own tenant, name (or null, last) and read-only flag, in
//          ("C" name, id) order; suspended and pending stores, a store of a suspended tenant and an invited grant left out;
//          the third tenant's store never appears.
//   STA-04 exactly one grant per store: two roles at one store leave that store out (ambiguous), the actor's other store stays.
//   STA-05 a tenant-only actor reads NO row (a valid session, no store; no inheritance); a tenant grant beside a store grant
//          contributes nothing; a store grant naming a store of ANOTHER tenant than its own is never answered.
//   STA-06 a read-only account sees its stores read-only; the flag is the widest of account, tenant and store.
//   STA-07 refusals: an unknown, revoked, expired or unminted key, a key minted under another issuer key, and any standing
//          change since the mint (a grant added, a store suspended, the account suspended) are one 'denied' row, as are a
//          session whose expiry the owner moved after the mint and an ADMIN-audience session (with or without a ledger row);
//          a malformed key is 'invalid'; the routine writes and locks nothing.
//   STA-08 027's down: refused while not applied, while 028 itself is applied (M7B-INVOICES-P1), and — 028 rolled back in
//          the same rolled-back transaction — while 028's schema tmpos_invoice_draft or the audit subject column of 028
//          exists, but NOT for a relation of 028's table names in another schema; committed otherwise through the executor's
//          own path (028 rolled back above it) — the schema gone, 026's surface byte for byte as before, the 026 runtime
//          login refused by the startup preflight — then restored, the preflight accepting again.
//   STA-09 the status matrix: each of the six statuses on the account, the tenant and the store axis, with a session minted
//          at that standing, answers exactly what the runtime's own lifecycle decision (tenantState.ts decideTenantState)
//          says — a writable row, a read-only row, no row, or (the account axis) one 'denied' row.
//   STA-10 one unservable name degrades its own entry, never the answer: an empty and a 257-character name are served as
//          NULL, last, by id, beside the normal one; 256 characters (astral ones too) are served, 257 astral ones are not.
//   STAH-01 over HTTP through the real tenant entry: ready with 027's probe; 401 without a session; 403 without the session
//          CSRF token (and with another session's); a store-only actor served exactly { stores: [{ id, tenantId, name,
//          readOnly }] }, no-store and the baseline headers; a tenant-only actor an empty list; any query a 400; reads
//          write no audit, outbox or idempotency row; the store's (empty) draft list is served (M7B-INVOICES-P1, 028); a grant
//          change ends the session; unservable names served as null; the session's idle window NOT slid by the directory
//          (an authorized read slides it); POST /api/v1/stores a 404; an administrative session's key under the tenant
//          cookie a 401.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic
// and randomly suffixed; every key is random bytes made here. It leaves the shared service with 027 and 028 applied, the
// ledger 001-032, the issuer key row and limiter fingerprint it found, no session or mint-ledger row of its own and its
// login dropped; its synthetically named identities, tenants, stores and memberships stay, as every suite's do. It writes no
// invoice draft; STA-08 rolls 028 back with 027 (refused while a draft exists), so on a shared service it runs before every
// step that stores one.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { REQUIRED_MIGRATIONS, createPostgresStartupPreflight } from '../../server/persistence/postgresStartupPreflight.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { principalKeyOf, SESSION_COOKIES, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { decideTenantState } from '../../server/runtime/tenantState.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.up.sql`, 'utf8');
const DOWN_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.down.sql`, 'utf8');
/** M7B-INVOICES-P1: 028 (invoice drafts) sits above 027 and rolls back before it. */
const DOWN_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.down.sql`, 'utf8');
/** M7B-INVOICES-P2: 029 (the draft edit) lives in 028's schema and rolls back before it. */
const DOWN_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.down.sql`, 'utf8');
/** M7B-INVOICES-P2-R1: 030 (the Invoices level guard and the guarded edit, in its own schema) sits above 029 and rolls back first. */
const DOWN_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R3: 031 (the guarded draft save, in 030's schema) sits above 030 and rolls back first. */
const DOWN_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R4: 032 (the Customers authority of the guarded draft save, in 030's schema) sits above 031 and rolls back first. */
const DOWN_032 = readFileSync(`${MIG_DIR}/032_m7b_invoice_create_customers_authority.down.sql`, 'utf8');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_027 = UP_027.slice(UP_027.lastIndexOf('do $$'));
const DIRECTORY = 'tmpos_store_access.m7b_store_directory(text)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'sta-migrator', runtimeRef: 'sta-runtime' };
const LOCK_KEY = 527_527;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_sta_probe';
const HOUR = 3_600_000;
const ROLLBACK = new Error('sta: roll the proof back');
const RC = 'isolation level read committed';
const DENIED = Object.freeze({ o_outcome: 'denied', o_store_id: null, o_tenant_id: null, o_store_name: null, o_read_only: null });
const INVALID = Object.freeze({ ...DENIED, o_outcome: 'invalid' });
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';
const STORES_PATH = '/api/v1/stores';
const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);

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
/** A fresh session key in the runtime's shape: the SHA-256 of 32 random bytes' identifier. */
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('STA');
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
const connect = (user, max) => testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, installs the keys, writes the fixtures and observes. RLS does not restrict it. */
const owner = connect(undefined, 4);
let runtime = null;
const UIDS = [];
const KEYS = new Set();
let issuerKeyBefore;
let rateLimitFingerprintBefore;

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

test.after(async () => {
  // Every step runs even when an earlier one throws; what failed is collected and the postconditions are then checked.
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    // A failed STA-08 may have left 027 (and 028, 029, 030, 031 and 032 above it) rolled back: the executor applies them again.
    await step(async () => {
      if ((await owner`select pg_catalog.to_regnamespace('tmpos_store_access') is null as absent`)[0].absent
        || (await owner`select pg_catalog.to_regnamespace('tmpos_invoice_draft') is null as absent`)[0].absent
        || !(await owner`select exists (select 1 from public.schema_migrations where version = '032') as applied`)[0].applied) {
        const report = await trustedApply();
        assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
      }
    });
    if (UIDS.length > 0) {
      await step(async () => {
        for (const row of await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`) KEYS.add(row.session_key);
      });
    }
    if (KEYS.size > 0) await step(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
    if (UIDS.length > 0) await step(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
    if (issuerKeyBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_mint.issuer_key where singleton`;
        if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
      }));
    }
    if (rateLimitFingerprintBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_rate_limit.key_fingerprint where singleton`;
        if (rateLimitFingerprintBefore !== null) {
          await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
            values (${rateLimitFingerprintBefore.singleton}, ${rateLimitFingerprintBefore.fingerprint}, ${rateLimitFingerprintBefore.registered_at}::text::timestamptz)`;
        }
      }));
    }
    if (runtime) await step(() => runtime.end({ timeout: 5 }));
    await step(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
    await step(() => owner.unsafe(`do $$ begin
      if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
    end $$;`));
    await step(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
    await step(async () => {
      const [state] = await owner`select
          pg_catalog.to_regnamespace('tmpos_store_access') is not null as schema_027,
          exists (select 1 from public.schema_migrations where version = '027') as ledger_027,
          pg_catalog.to_regnamespace('tmpos_invoice_draft') is not null as schema_028,
          exists (select 1 from public.schema_migrations where version = '028') as ledger_028,
          exists (select 1 from public.schema_migrations where version = '029') as ledger_029,
          exists (select 1 from public.schema_migrations where version = '030') as ledger_030,
          exists (select 1 from public.schema_migrations where version = '031') as ledger_031,
          exists (select 1 from public.schema_migrations where version = '032') as ledger_032,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, { schema_027: true, ledger_027: true, schema_028: true, ledger_028: true, ledger_029: true, ledger_030: true, ledger_031: true, ledger_032: true, sessions: 0, login: false },
        'left as found: 027 and 028 applied and recorded, no session of this suite, the probe login dropped');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'STA teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: every migration in the directory (001-032), a real non-owner runtime login, the keys installed by the owner
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
const applyReport = await trustedApply();

await owner.unsafe(`do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
end $$;`);
await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
runtime = connect(RUNTIME_LOGIN, 3);

issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
await installTestIssuerKey(owner, ISSUER_KEY);
{
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  rateLimitFingerprintBefore = rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(RATE_KEY)})`;
  });
}

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') =>
  (await owner`insert into tenant (display_name, status) values (${`sta-${label}-${SUFFIX}`}, ${status}) returning tenant_id`)[0].tenant_id;
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;

/** A synthetic actor: an identity, an account of `accountStatus`, and the given memberships ({ scope, tenant, store, role, status }). */
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `sta-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${accountStatus})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, ${m.store ?? null}, ${m.scope}, ${m.role}, ${m.status ?? 'active'})`;
  }
  UIDS.push(uid);
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  return { id, uid, token, label, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const storeGrant = (tenant, store, role, status) => ({ scope: 'store', tenant, store, role, ...(status === undefined ? {} : { status }) });
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });

const TOKENS = new Map();
const T_A = await newTenant('a');
const T_B = await newTenant('b', 'overdue');
const T_C = await newTenant('c');
const T_D = await newTenant('d', 'suspended');
const S_ALPHA = await newStore(T_A, `Alpha ${SUFFIX}`);
const S_BETA = await newStore(T_A, `Beta ${SUFFIX}`, 'read_only');
const S_UNNAMED = await newStore(T_A, null);
const S_SUSPENDED = await newStore(T_A, `Suspended ${SUFFIX}`, 'suspended');
const S_PENDING = await newStore(T_A, `Pending ${SUFFIX}`, 'pending_activation');
const S_GAMMA = await newStore(T_B, `Gamma ${SUFFIX}`);
const S_DELTA = await newStore(T_C, `Delta ${SUFFIX}`);
const S_EPSILON = await newStore(T_D, `Epsilon ${SUFFIX}`);
/** A store row of tenant A that nobody holds a grant at: existing proves nothing. */
const S_ORPHAN = await newStore(T_A, `Orphan ${SUFFIX}`);

const MULTI = await actor('multi', [
  storeGrant(T_A, S_ALPHA, 'manager'), storeGrant(T_A, S_BETA, 'technician'), storeGrant(T_A, S_UNNAMED, 'sales_staff'),
  storeGrant(T_B, S_GAMMA, 'manager'), storeGrant(T_A, S_SUSPENDED, 'manager'), storeGrant(T_A, S_PENDING, 'manager'),
  storeGrant(T_D, S_EPSILON, 'manager'), storeGrant(T_A, S_ORPHAN, 'manager', 'invited'),
]);
const AMBIGUOUS = await actor('ambiguous', [storeGrant(T_A, S_ALPHA, 'manager'), storeGrant(T_A, S_ALPHA, 'technician'), storeGrant(T_A, S_BETA, 'sales_staff')]);
const TENANT_ONLY = await actor('tenant-only', [tenantGrant(T_A, 'store_owner')]);
const MIXED = await actor('mixed', [tenantGrant(T_A, 'store_owner'), storeGrant(T_C, S_DELTA, 'technician')]);
/** A store grant naming tenant A but a store of tenant C: storable (002's FK names the store alone), never answered. */
const MISMATCH = await actor('mismatch', [storeGrant(T_A, S_DELTA, 'manager'), storeGrant(T_A, S_ALPHA, 'technician')]);
const READ_ONLY_ACCOUNT = await actor('read-only-account', [storeGrant(T_A, S_ALPHA, 'manager'), storeGrant(T_C, S_DELTA, 'manager')], 'read_only');
const STORE_ONLY = await actor('store-only', [storeGrant(T_A, S_ALPHA, 'sales_staff'), storeGrant(T_C, S_DELTA, 'technician')]);
/** Three stores of tenant C: an empty name, a 257-character one and a normal one (public.store.store_name has no CHECK). */
const S_EMPTY_NAME = await newStore(T_C, '');
const S_LONG_NAME = await newStore(T_C, 'x'.repeat(257));
const S_NORMAL_NAME = await newStore(T_C, `Normal ${SUFFIX}`);
const BAD_NAMES = await actor('bad-names', [
  storeGrant(T_C, S_EMPTY_NAME, 'manager'), storeGrant(T_C, S_LONG_NAME, 'technician'), storeGrant(T_C, S_NORMAL_NAME, 'sales_staff'),
]);
/** What BAD_NAMES reads: the normal store, then the two unservable names as null, ordered by id. */
const BAD_NAMES_ORDER = [S_NORMAL_NAME, ...[S_EMPTY_NAME, S_LONG_NAME].sort()];

// ---------------------------------------------------------------------------
// the runtime login's calls
// ---------------------------------------------------------------------------

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:sta', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
});
/** A tenant session for `who`, minted as the runtime login under `issuer`, live for `lifetime` ms. */
async function mint(who, { lifetime = 8 * HOUR, issuer = ISSUER_KEY } = {}) {
  const key = newKey();
  const r = record(who);
  const expiresAt = r.createdAt + lifetime;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${proofOf(issuer, key, r, expiresAt)}::bytea) as outcome`;
  assert.equal(outcome, 'created', `a tenant session for ${who.uid}`);
  return key;
}
/** 027's routine, called directly as the runtime login (or on `db`). */
const directory = async (key, db = runtime) => (await db`select o_outcome, o_store_id, o_tenant_id, o_store_name, o_read_only
  from tmpos_store_access.m7b_store_directory(${key}::text)`).map((r) => ({ ...r }));
const row = (store, tenant, name, readOnly) => ({ o_outcome: 'store', o_store_id: store, o_tenant_id: tenant, o_store_name: name, o_read_only: readOnly });
const errorOf = (p) => p.then(() => null, (err) => ({ code: err.code, message: String(err.message) }));

/** Runs `fn` in an owner transaction that is always rolled back. Answers { value } or the { code, message } it raised. */
async function rolledBack(isolation, fn) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}

/** Every object 026 owns, as a comparable value: each routine's complete definition, owner and ACL, the schema's ACL, the CHECKs. */
async function surface026() {
  const routines = await owner`select p.oid::regprocedure::text as fn, pg_catalog.pg_get_functiondef(p.oid) as def,
      p.proacl::text as acl, p.proowner::regrole::text as owner
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role_invoice'::regnamespace order by p.oid::regprocedure::text collate "C"`;
  const schema = await owner`select n.nspacl::text as acl from pg_catalog.pg_namespace n where n.nspname = 'tmpos_role_invoice'`;
  const checks = await owner`select k.conrelid::regclass::text as rel, k.conname::text as name, pg_catalog.pg_get_constraintdef(k.oid) as def
    from pg_catalog.pg_constraint k where k.conrelid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_role_edit.role_level_version'::regclass)
     and k.contype = 'c' order by k.conname::text collate "C"`;
  return JSON.parse(JSON.stringify({ routines, schema, checks }));
}

/** The startup preflight's ledger and login answers, as the runtime login over a fresh kernel. */
async function preflightVerdict() {
  const client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 1, idle_timeout: 0, user: RUNTIME_LOGIN,
  });
  try {
    const preflight = createPostgresStartupPreflight({ client });
    const signal = AbortSignal.timeout(20_000);
    return { runtimeLogin: await preflight.runtimeLogin(signal), migrationLedger: await preflight.migrationLedger(signal) };
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// STA-01..02: the migration, the inventory and the ACL
// ---------------------------------------------------------------------------

test('STA-01: 001-032 applied clean, every checksum the pinned one; 027\'s postcondition holds and refuses every widening it names; a second apply is refused', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 32 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'every ledger checksum is the pinned one');
  assert.equal(ledger[26].checksum, createHash('sha256').update(UP_027).digest('hex'), '027\'s checksum is its up bytes');
  assert.equal((await rolledBack(RC, (tx) => tx.unsafe(POSTCONDITION_027).simple())).code, undefined, 'the applied state satisfies the postcondition');
  for (const [label, widen] of [
    ['EXECUTE to PUBLIC', `grant execute on function ${DIRECTORY} to public`],
    ['EXECUTE to the audit writer', `grant execute on function ${DIRECTORY} to tmpos_audit_writer`],
    ['EXECUTE to anon', `grant execute on function ${DIRECTORY} to anon`],
    ['a grantable EXECUTE', `grant execute on function ${DIRECTORY} to tmpos_app with grant option`],
    ['USAGE to PUBLIC', 'grant usage on schema tmpos_store_access to public'],
    ['CREATE to tmpos_app', 'grant create on schema tmpos_store_access to tmpos_app'],
    ['a table in the schema', 'create table tmpos_store_access.extra (x integer)'],
    ['a second routine', 'create function tmpos_store_access.extra() returns integer language sql as \'select 1\''],
    ['a volatile routine', `alter function ${DIRECTORY} volatile`],
    ['an invoker routine', `alter function ${DIRECTORY} security invoker`],
    ['tmpos_app made a member of something', 'grant anon to tmpos_app'],
  ]) {
    const out = await rolledBack(RC, async (tx) => { await tx.unsafe(widen); await tx.unsafe(POSTCONDITION_027).simple(); });
    assert.equal(out.code, '55000', `${label}: refused (${JSON.stringify(out)})`);
    assert.match(out.message, /migration 027 refused/, label);
  }
  // (g): the runtime role made a MEMBER of the owner would hold everything the owner holds — refused by name.
  const member = await rolledBack(RC, async (tx) => {
    await tx.unsafe('do $$ begin execute pg_catalog.format(\'grant %I to tmpos_app\', current_user); end $$');
    await tx.unsafe(POSTCONDITION_027).simple();
  });
  assert.equal(member.code, '55000', JSON.stringify(member));
  assert.match(member.message, /migration 027 refused: tmpos_app is a member of the owner/);
  const again = await rolledBack(RC, (tx) => tx.unsafe(UP_027).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /schema tmpos_store_access already exists/);
  // Over a chain missing what it builds on, the up file refuses with a stated reason (028 and then 027 rolled back first —
  // M7B-INVOICES-P1: 027's down refuses while 028 is applied — all rolled back).
  for (const [label, remove, pattern] of [
    ['026\'s routine missing', 'alter function tmpos_role_invoice.m7a_invoice_role_level_states(uuid) rename to m7a_states_moved',
      /migration 027 refused: migration 026 must be applied first/],
    ['016\'s admission read missing', 'alter function tmpos_session.m5_admit_tenant_session_v2(text, text) rename to m5_admit_moved',
      /migration 027 refused: the session table, the mint ledger, the issuer key, 016's admission or 002's tables are missing/],
    ['002\'s membership table missing', 'alter table public.user_membership rename to user_membership_moved',
      /migration 027 refused: the session table, the mint ledger, the issuer key, 016's admission or 002's tables are missing/],
  ]) {
    const out = await rolledBack(RC, async (tx) => {
      await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(DOWN_028).simple(); await tx.unsafe(DOWN_027).simple(); await tx.unsafe(remove); await tx.unsafe(UP_027).simple();
    });
    assert.equal(out.code, '55000', `${label}: ${JSON.stringify(out)}`);
    assert.match(out.message, pattern, label);
  }
  assert.ok(!(await owner`select pg_catalog.to_regnamespace('tmpos_store_access') is null as absent`)[0].absent, 'every refusal rolled back: 027 in place');
});

test('STA-02: one STABLE SECURITY DEFINER routine, its ACL exactly the owner\'s and tmpos_app\'s EXECUTE (no PUBLIC), the schema tmpos_app\'s USAGE alone', async () => {
  const [fn] = await owner`select p.prosecdef, p.provolatile::text as volatility, p.proconfig, l.lanname::text as language,
      (select pg_catalog.count(*) from pg_catalog.pg_proc q where q.pronamespace = 'tmpos_store_access'::regnamespace)::int as routines
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang where p.oid = ${DIRECTORY}::regprocedure`;
  assert.deepEqual({ ...fn }, { prosecdef: true, volatility: 's', proconfig: ['search_path=pg_catalog, pg_temp', 'row_security=off'], language: 'plpgsql', routines: 1 });
  const acl = (await owner`select case when g.grantee = 0 then 'PUBLIC' when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end as grantee,
      g.privilege_type::text as privilege, g.is_grantable as grantable
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
    where p.oid = ${DIRECTORY}::regprocedure order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(acl, [{ grantee: 'owner', privilege: 'EXECUTE', grantable: false }, { grantee: 'tmpos_app', privilege: 'EXECUTE', grantable: false }],
    'no PUBLIC entry, no other grantee');
  const schema = (await owner`select case when g.grantee = n.nspowner then 'owner' when g.grantee = 0 then 'PUBLIC' else g.grantee::regrole::text end as grantee,
      g.privilege_type::text as privilege
    from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
    where n.nspname = 'tmpos_store_access' and g.grantee <> n.nspowner order by 1, 2`).map((r) => ({ ...r }));
  assert.deepEqual(schema, [{ grantee: 'tmpos_app', privilege: 'USAGE' }]);
  const [can] = await owner`select
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${DIRECTORY}::regprocedure, 'EXECUTE') as login,
      pg_catalog.has_function_privilege('tmpos_app', ${DIRECTORY}::regprocedure, 'EXECUTE') as app,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${DIRECTORY}::regprocedure, 'EXECUTE') as audit,
      pg_catalog.has_function_privilege('anon', ${DIRECTORY}::regprocedure, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${DIRECTORY}::regprocedure, 'EXECUTE') as authenticated`;
  assert.deepEqual({ ...can }, { login: true, app: true, audit: false, anon: false, authenticated: false });
  // The login reaches the session table and the stores only through the routine.
  assert.equal((await errorOf(runtime`select count(*) from tmpos_session.session`))?.code, '42501', 'no direct read of the session table');
  assert.equal((await errorOf(runtime`select count(*) from tmpos_mint.tenant_session`))?.code, '42501', 'nor of the mint ledger');
});

// ---------------------------------------------------------------------------
// STA-03..06: discovery
// ---------------------------------------------------------------------------

test('STA-03: exactly the usable stores across two tenants, each with its tenant, name (null last) and read-only flag, in ("C" name, id) order; a third tenant\'s store never appears', async () => {
  const key = await mint(MULTI);
  assert.deepEqual(await directory(key), [
    row(S_ALPHA, T_A, `Alpha ${SUFFIX}`, false),
    row(S_BETA, T_A, `Beta ${SUFFIX}`, true), // the store is read_only
    row(S_GAMMA, T_B, `Gamma ${SUFFIX}`, true), // the tenant is overdue
    row(S_UNNAMED, T_A, null, false), // an unnamed store sorts last
  ], 'suspended, pending, suspended-tenant and invited-grant stores are left out');
  const answered = (await directory(key)).map((r) => r.o_store_id);
  for (const absent of [S_DELTA, S_SUSPENDED, S_PENDING, S_EPSILON, S_ORPHAN]) assert.ok(!answered.includes(absent), absent);
  // Equal names order by id: two stores of one name, both granted.
  const twinA = await newStore(T_C, `Twin ${SUFFIX}`);
  const twinB = await newStore(T_C, `Twin ${SUFFIX}`);
  const twins = await actor('twins', [storeGrant(T_C, twinA, 'manager'), storeGrant(T_C, twinB, 'manager')]);
  const [first, second] = [twinA, twinB].sort();
  assert.deepEqual(await directory(await mint(twins)), [row(first, T_C, `Twin ${SUFFIX}`, false), row(second, T_C, `Twin ${SUFFIX}`, false)]);
  // Byte order, not a locale's: an uppercase name sorts before a lowercase one.
  const lower = await newStore(T_C, `a-lower ${SUFFIX}`);
  const upper = await newStore(T_C, `Z-upper ${SUFFIX}`);
  const cased = await actor('cased', [storeGrant(T_C, lower, 'manager'), storeGrant(T_C, upper, 'manager')]);
  assert.deepEqual((await directory(await mint(cased))).map((r) => r.o_store_id), [upper, lower]);
});

test('STA-04: exactly one usable grant per store — two roles at one store leave that store out; the other store stays', async () => {
  assert.deepEqual(await directory(await mint(AMBIGUOUS)), [row(S_BETA, T_A, `Beta ${SUFFIX}`, true)]);
});

test('STA-05: a tenant-only actor reads no row; a tenant grant contributes nothing beside a store grant; a grant naming another tenant\'s store is never answered', async () => {
  assert.deepEqual(await directory(await mint(TENANT_ONLY)), [], 'a valid session, no store: no inheritance');
  assert.deepEqual(await directory(await mint(MIXED)), [row(S_DELTA, T_C, `Delta ${SUFFIX}`, false)], 'only the store grant');
  assert.deepEqual(await directory(await mint(MISMATCH)), [row(S_ALPHA, T_A, `Alpha ${SUFFIX}`, false)],
    'the grant naming tenant A at tenant C\'s store is left out; the consistent one stays');
});

test('STA-06: a read-only account sees every one of its stores read-only — the widest of account, tenant and store', async () => {
  assert.deepEqual(await directory(await mint(READ_ONLY_ACCOUNT)), [
    row(S_ALPHA, T_A, `Alpha ${SUFFIX}`, true), row(S_DELTA, T_C, `Delta ${SUFFIX}`, true),
  ]);
  assert.deepEqual(await directory(await mint(STORE_ONLY)), [
    row(S_ALPHA, T_A, `Alpha ${SUFFIX}`, false), row(S_DELTA, T_C, `Delta ${SUFFIX}`, false),
  ], 'control: the same stores, writable, for an active account');
});

test('STA-09: the status matrix — every status on the account, the tenant and the store axis answers exactly the runtime\'s own lifecycle decision, with a session minted at that standing', async () => {
  const STATUSES = ['active', 'trialing', 'overdue', 'read_only', 'suspended', 'pending_activation'];
  /** decideTenantState's answer as 027's row for `store`: writable, read-only, or none. */
  const expected = (decision, store, tenant, name) => (decision === 'denied' ? [] : [row(store, tenant, name, decision === 'read_only')]);
  // A control store every tenant- and store-axis actor also holds, so its admission resolves whatever the subject's status.
  const control = await newStore(T_C, `Matrix control ${SUFFIX}`);
  const controlRow = row(control, T_C, `Matrix control ${SUFFIX}`, false);
  const host = await newTenant('matrix-host');
  for (const status of STATUSES) {
    // The account axis: one active store at an active tenant; the account's own status decides (one 'denied' row, not none).
    const account = await actor(`matrix-account-${status}`, [storeGrant(T_C, control, 'manager')], status);
    const accountDecision = decideTenantState(status, null);
    assert.deepEqual(await directory(await mint(account)), accountDecision === 'denied' ? [DENIED] : expected(accountDecision, control, T_C, `Matrix control ${SUFFIX}`),
      `account ${status} (${accountDecision})`);
    // The tenant axis: a store of a tenant at `status`, beside the control.
    const tenant = await newTenant(`matrix-tenant-${status}`, status);
    const atTenant = await newStore(tenant, `Matrix tenant ${status} ${SUFFIX}`);
    const byTenant = await actor(`matrix-tenant-${status}`, [storeGrant(tenant, atTenant, 'manager'), storeGrant(T_C, control, 'technician')]);
    const tenantDecision = decideTenantState(status, 'active');
    assert.deepEqual(await directory(await mint(byTenant)), [controlRow, ...expected(tenantDecision, atTenant, tenant, `Matrix tenant ${status} ${SUFFIX}`)],
      `tenant ${status} (${tenantDecision})`);
    // The store axis: a store at `status` of an active tenant, beside the control.
    const atStore = await newStore(host, `Matrix store ${status} ${SUFFIX}`, status);
    const byStore = await actor(`matrix-store-${status}`, [storeGrant(host, atStore, 'sales_staff'), storeGrant(T_C, control, 'manager')]);
    const storeDecision = decideTenantState('active', status);
    assert.deepEqual(await directory(await mint(byStore)), [controlRow, ...expected(storeDecision, atStore, host, `Matrix store ${status} ${SUFFIX}`)],
      `store ${status} (${storeDecision})`);
  }
  // Non-vacuity: the matrix crossed all three decisions on each axis.
  for (const decide of [(x) => decideTenantState(x, null), (x) => decideTenantState(x, 'active'), (x) => decideTenantState('active', x)]) {
    assert.deepEqual([...new Set(STATUSES.map(decide))].sort(), ['active', 'denied', 'read_only']);
  }
});

test('STA-10: one unservable store name degrades its own entry, never the answer — an empty and a 257-character name are served as null, last, by id', async () => {
  const [first, second] = [S_EMPTY_NAME, S_LONG_NAME].sort();
  assert.deepEqual(await directory(await mint(BAD_NAMES)), [
    row(S_NORMAL_NAME, T_C, `Normal ${SUFFIX}`, false), row(first, T_C, null, false), row(second, T_C, null, false),
  ]);
  // The edge is the runtime's own rule (isServableStoreName: 1-256 characters), in characters, not bytes or UTF-16 units.
  const astral = '\u{1F600}';
  const edge = [['x'.repeat(256), true], [astral.repeat(256), true], [astral.repeat(257), false], [`${'x'.repeat(255)}${astral}`, true]];
  const stores = [];
  for (const [name] of edge) stores.push(await newStore(T_C, name));
  const who = await actor('name-edges', stores.map((store) => storeGrant(T_C, store, 'manager')));
  const served = new Map((await directory(await mint(who))).map((r) => [r.o_store_id, r.o_store_name]));
  assert.equal(served.size, edge.length, 'every store is answered');
  edge.forEach(([name, kept], i) => assert.equal(served.get(stores[i]), kept ? name : null, `${Array.from(name).length} characters`));
});

// ---------------------------------------------------------------------------
// STA-07: refusals
// ---------------------------------------------------------------------------

test('STA-07: unknown, revoked, expired, unminted, foreign-issuer and stale-standing keys are one denied row; a malformed key is invalid; nothing is written or locked', async () => {
  assert.deepEqual(await directory(newKey()), [DENIED], 'an unknown key');
  for (const bad of ['', ' ', 'k'.repeat(129), 'a b', 'é'.repeat(4)]) assert.deepEqual(await directory(bad), [INVALID], JSON.stringify(bad));
  assert.deepEqual((await runtime`select o_outcome from tmpos_store_access.m7b_store_directory(null::text)`).map((r) => r.o_outcome), ['invalid'], 'a null key');
  // Revoked: the session row gone.
  const revoked = await mint(STORE_ONLY);
  await owner`delete from tmpos_session.session where session_key = ${revoked}`;
  assert.deepEqual(await directory(revoked), [DENIED], 'a revoked session');
  // Expired.
  const expired = await mint(STORE_ONLY, { lifetime: 1 });
  await delay(20);
  assert.deepEqual(await directory(expired), [DENIED], 'an expired session');
  // Unminted: a session row with no mint-ledger row cannot be made by the runtime; the owner deletes the ledger row.
  const unminted = await mint(STORE_ONLY);
  await owner`delete from tmpos_mint.tenant_session where session_key = ${unminted}`;
  assert.deepEqual(await directory(unminted), [DENIED], 'a session with no mint-ledger row');
  // Minted under the installed key, then the key rotated: the digest no longer matches.
  const rotated = await mint(STORE_ONLY);
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_mint.issuer_key where singleton`;
    await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${randomBytes(32)})`;
  });
  try {
    assert.deepEqual(await directory(rotated), [DENIED], 'a session minted under another issuer key');
  } finally {
    await installTestIssuerKey(owner, ISSUER_KEY);
  }
  assert.deepEqual((await directory(rotated)).length, 2, 'control: the same key reads again under its own issuer key');
  // Stale standing: a grant added, a store suspended, the account suspended — each after the mint.
  const stale = await actor('stale', [storeGrant(T_A, S_ALPHA, 'manager')]);
  const grantMoved = await mint(stale);
  assert.deepEqual(await directory(grantMoved), [row(S_ALPHA, T_A, `Alpha ${SUFFIX}`, false)], 'control');
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${stale.id}, ${T_C}, ${S_DELTA}, 'store', 'manager', 'active')`;
  assert.deepEqual(await directory(grantMoved), [DENIED], 'a grant added since the mint');
  const storeMoved = await mint(stale);
  assert.equal((await directory(storeMoved)).length, 2, 'control: a fresh session reads both stores');
  const lone = await newStore(T_C, `Lone ${SUFFIX}`);
  const solo = await actor('solo', [storeGrant(T_C, lone, 'manager')]);
  const soloKey = await mint(solo);
  await owner`update store set status = 'suspended' where store_id = ${lone}`;
  assert.deepEqual(await directory(soloKey), [DENIED], 'the store suspended since the mint');
  const account = await actor('account', [storeGrant(T_C, S_DELTA, 'manager')]);
  const accountKey = await mint(account);
  await owner`update app_user set status = 'suspended' where internal_user_id = ${account.id}`;
  assert.deepEqual(await directory(accountKey), [DENIED], 'the account suspended since the mint');
  // The mint binding: a session whose expiry moved after the mint (only the owner can write it) is not the minted one.
  const moved = await mint(STORE_ONLY, { lifetime: HOUR });
  assert.equal((await directory(moved)).length, 2, 'control: the minted session reads both stores');
  await owner`update tmpos_session.session set expires_at = expires_at + 1000 where session_key = ${moved}`;
  assert.deepEqual(await directory(moved), [DENIED], 'the expiry moved since the mint');
  // An ADMINISTRATIVE session of the same principal: 018's admin branch writes no ledger row, so it is no minted tenant
  // session — and given one by the owner, with the very digests a tenant mint of this standing holds, its audience still denies.
  const adminKey = newKey();
  KEYS.add(adminKey);
  const a = { ...record(STORE_ONLY), audience: 'admin' };
  const adminExpires = a.createdAt + 10 * 60_000;
  const [{ outcome: adminOutcome }] = await runtime`select tmpos_mint.m7a_session_create(${adminKey}::text, ${a.audience}::text, ${a.authProvider}::text,
    ${a.authProviderUid}::text, ${a.principalKey}::text, ${a.securityVersion}::text, ${a.authenticatedAt}::bigint,
    ${a.createdAt}::bigint, ${a.lastSeenAt}::bigint, ${a.validatedAt}::bigint, ${adminExpires}::bigint, null::bytea) as outcome`;
  assert.equal(adminOutcome, 'created', 'an administrative session of the same principal');
  assert.deepEqual(await directory(adminKey), [DENIED], 'an administrative session: no mint-ledger row');
  const twin = await mint(STORE_ONLY);
  await owner`insert into tmpos_mint.tenant_session (session_key, standing_digest, issuer_digest, expires_at)
    select ${adminKey}, m.standing_digest, m.issuer_digest, ${adminExpires} from tmpos_mint.tenant_session m where m.session_key = ${twin}`;
  assert.deepEqual(await directory(adminKey), [DENIED], 'an administrative session given a matching ledger row: its audience denies');
  assert.equal((await directory(twin)).length, 2, 'control: the tenant session whose digests it copied reads both stores');
  // A read writes and locks nothing: inside one transaction, after the call, the runtime holds no row lock.
  await runtime.begin(async (tx) => {
    await directory(await mint(STORE_ONLY), tx);
    const pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    const locks = await owner`select locktype, mode from pg_catalog.pg_locks where pid = ${pid} and locktype in ('tuple', 'transactionid') and granted`;
    assert.deepEqual(locks.map((l) => ({ ...l })), [], 'no row lock and no transaction id: nothing was written or locked');
  });
});

// ---------------------------------------------------------------------------
// STA-08: the rollback
// ---------------------------------------------------------------------------

test('STA-08: 027\'s down refuses while not applied or while an invoice draft object of 028 exists — matched exactly — and otherwise removes exactly 027, leaving 026 as it was; restored, the runtime is accepted again', async () => {
  const before026 = await surface026();
  // M7B-INVOICES-P1: 028 itself is applied above 027, so 027's down refuses as it stands; each fake below is judged with
  // 028 rolled back first (its own down, in the same rolled-back transaction), so it is the fake alone that refuses.
  const real = await rolledBack(RC, (tx) => tx.unsafe(DOWN_027).simple());
  assert.equal(real.code, '55000', `028 applied: refused (${JSON.stringify(real)})`);
  assert.match(real.message, /migration 027 rollback refused: an invoice draft object of migration 028 exists/);
  // 028's own objects, by their exact names: its schema (with or without its tables) and the audit subject column.
  for (const [label, fake] of [
    ['028\'s schema', 'create schema tmpos_invoice_draft'],
    ['028\'s schema with its two tables', 'create schema tmpos_invoice_draft; create table tmpos_invoice_draft.invoice_draft (draft_id uuid); create table tmpos_invoice_draft.invoice_draft_line (draft_id uuid)'],
    ['the audit subject column', 'alter table public.audit_event add column subject_invoice_draft_id uuid'],
  ]) {
    const out = await rolledBack(RC, async (tx) => { await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(DOWN_028).simple(); await tx.unsafe(fake).simple(); await tx.unsafe(DOWN_027).simple(); });
    assert.equal(out.code, '55000', `${label}: refused (${JSON.stringify(out)})`);
    assert.match(out.message, /migration 027 rollback refused: an invoice draft object of migration 028 exists/, label);
  }
  // A relation that merely shares 028's table names, in a schema that is not 028's, is not 028's: the rollback proceeds
  // (028 itself rolled back first in the same rolled-back transaction, as above).
  for (const [label, unrelated] of [
    ['an invoice_draft table in public', 'create table public.invoice_draft (draft_id uuid)'],
    ['both table names in an unrelated schema', 'create schema sta_unrelated; create table sta_unrelated.invoice_draft (draft_id uuid); create table sta_unrelated.invoice_draft_line (draft_id uuid)'],
  ]) {
    const out = await rolledBack(RC, async (tx) => {
      await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple();
      await tx.unsafe(DOWN_028).simple();
      await tx.unsafe(unrelated).simple();
      await tx.unsafe(DOWN_027).simple();
      return (await tx`select pg_catalog.to_regnamespace('tmpos_store_access') is null as gone`)[0].gone;
    });
    assert.deepEqual(out, { value: true }, `${label}: rolled back, not refused (${JSON.stringify(out)})`);
  }
  assert.ok(!(await owner`select pg_catalog.to_regnamespace('tmpos_store_access') is null as absent`)[0].absent, 'each refusal left 027 in place');
  const twice = await rolledBack(RC, async (tx) => { await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(DOWN_028).simple(); await tx.unsafe(DOWN_027).simple(); await tx.unsafe(DOWN_027).simple(); });
  assert.equal(twice.code, '55000');
  assert.match(twice.message, /migration 027 is not applied/);
  // The executor's own path: the down file and the ledger row, then restored.
  assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'control: the 001-032 runtime is accepted');
  const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '026');
  try {
    assert.deepEqual(undone, ['032', '031', '030', '029', '028', '027'], 'only 027 (and 028, 029, 030, 031 and 032 above it, M7B-INVOICES-P1, -P2, -P2-R1, -P1-R3 and -P1-R4) sits above 026');
    const [state] = await owner`select pg_catalog.to_regnamespace('tmpos_store_access') is null as gone,
      (select max(version) from public.schema_migrations) as newest`;
    assert.deepEqual({ ...state }, { gone: true, newest: '026' });
    assert.deepEqual(await surface026(), before026, '026\'s routines, grants, schema and CHECKs byte for byte as before');
    const at026 = await preflightVerdict();
    assert.deepEqual(at026, { runtimeLogin: ['role_privilege_missing'], migrationLedger: ['migration_missing'] },
      'this runtime refuses the 026 database: its grants and its ledger');
    assert.ok(['3F000', '42883'].includes((await errorOf(runtime`select * from tmpos_store_access.m7b_store_directory(${newKey()}::text)`))?.code), 'the routine is gone');
  } finally {
    await restore();
  }
  assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'restored: accepted again');
  assert.equal((await rolledBack(RC, (tx) => tx.unsafe(POSTCONDITION_027).simple())).code, undefined, 'the restored state satisfies the postcondition');
  assert.deepEqual(await directory(await mint(STORE_ONLY)), [row(S_ALPHA, T_A, `Alpha ${SUFFIX}`, false), row(S_DELTA, T_C, `Delta ${SUFFIX}`, false)]);
});

// ---------------------------------------------------------------------------
// STAH-01: GET /api/v1/stores through the real tenant entry
// ---------------------------------------------------------------------------

const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) {
      const err = new Error('unknown_token');
      err.code = 'auth/invalid-id-token';
      throw err;
    }
    return { uid: rec.uid, authTime: Math.floor(Date.now() / 1000), secondFactor: 'totp' };
  },
});
const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ENV = Object.freeze({
  NODE_ENV: 'production',
  PORT: '8443',
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  DATABASE_CA_CERT: tls.rootCertificates[0],
  RATE_LIMIT_KEY: RATE_KEY.toString('base64url'),
  TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
  SESSION_ADMIN_ORIGINS: ADMIN_ORIGIN,
  SESSION_TENANT_ORIGINS: TENANT_ORIGIN,
  TENANT_SESSION_ISSUER_KEY: ISSUER_KEY.toString('base64url'),
  IDEMPOTENCY_KEY: IDEMPOTENCY_KEY.toString('base64url'),
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', project_id: 'sta-test-project', client_email: 'sta-test@sta-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
  }),
});

function send(port, method, path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    request.on('error', reject);
    request.setTimeout(20_000, () => request.destroy(new Error(`no reply within 20 s: ${method} ${path}`)));
    request.end();
  });
}
function assertBaseline(reply, label) {
  assert.equal(reply.headers['strict-transport-security'], HSTS_HEADER.value, `${label}: HSTS`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(reply.headers[name.toLowerCase()], value, `${label}: ${name}`);
}
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  assertBaseline(reply, label);
}

async function withEntry(fn) {
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const construction = {
    databaseClient: () => createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
      ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 4, idle_timeout: 0, user: RUNTIME_LOGIN,
    }),
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  const result = await startTenantEntry({ env: ENV, construction, proc, exit: (code) => codes.push(code), log: { log: (line) => lines.push(line) } });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  try {
    return await fn({ port: result.address.port, lines });
  } finally {
    if (codes.length === 0) {
      proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; codes.length === 0 && Date.now() < until;) await delay(10);
    }
  }
}
async function signIn(port, who) {
  const reply = await send(port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${who.token}`, 'content-length': '0',
  });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  return { cookie: reply.headers['set-cookie'][0].split('; ')[0], csrf: JSON.parse(reply.body).csrfToken };
}
/** The session key a cookie presents: the SHA-256 of its identifier, as the chain computes it (sessions.ts digestOf). */
const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
const stores = (port, s, { path = STORES_PATH, headers = {} } = {}) =>
  send(port, 'GET', path, { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers });
const rowCounts = async () => ({ ...(await owner`select (select count(*) from public.audit_event)::int as a,
  (select count(*) from tmpos_internal.outbox_event)::int as o, (select count(*) from tmpos_internal.idempotency_record)::int as k`)[0] });

test('STAH-01: GET /api/v1/stores through the real tenant entry — 401, the session CSRF witness, a store-only actor\'s exact list, a tenant-only actor\'s empty one, no-store, no write', async () => {
  await withEntry(async ({ port, lines }) => {
    assert.equal((await send(port, 'GET', '/readiness', { host: TENANT_HOST })).status, 200, 'ready: the reads probe asks 027\'s routine too');
    assertRefusal(await stores(port, null), 401, 'unauthenticated', 'no session');
    const storeOnly = await signIn(port, STORE_ONLY);
    const tenantOnly = await signIn(port, TENANT_ONLY);
    const before = await rowCounts();
    assertRefusal(await send(port, 'GET', STORES_PATH, { host: TENANT_HOST, cookie: storeOnly.cookie }), 403, 'forbidden', 'no session CSRF token');
    assertRefusal(await stores(port, { cookie: storeOnly.cookie, csrf: tenantOnly.csrf }), 403, 'forbidden', 'another session\'s token');
    const reply = await stores(port, storeOnly);
    assert.equal(reply.status, 200, reply.body);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assertBaseline(reply, 'the list');
    const body = JSON.parse(reply.body);
    assert.deepEqual(Object.keys(body), ['stores']);
    for (const entry of body.stores) assert.deepEqual(Object.keys(entry), ['id', 'tenantId', 'name', 'readOnly']);
    assert.deepEqual(body, { stores: [
      { id: S_ALPHA, tenantId: T_A, name: `Alpha ${SUFFIX}`, readOnly: false },
      { id: S_DELTA, tenantId: T_C, name: `Delta ${SUFFIX}`, readOnly: false },
    ] }, 'the store-only actor\'s two stores in two tenants');
    for (const word of [STORE_ONLY.id, STORE_ONLY.uid, 'sales_staff', 'technician']) assert.ok(!reply.body.includes(word), `no ${word} in the answer`);
    const none = await stores(port, tenantOnly);
    assert.equal(none.status, 200, none.body);
    assert.deepEqual(JSON.parse(none.body), { stores: [] }, 'a tenant-only actor: no store, no inheritance');
    assertRefusal(await stores(port, storeOnly, { path: `${STORES_PATH}?tenantId=${T_A}` }), 400, 'invalid_request', 'a query');
    assertRefusal(await stores(port, storeOnly, { headers: { host: 'admin.tmpos.test' } }), 404, 'not_found', 'the wrong host');
    // M7B-INVOICES-P1: 028 serves the store's draft list (tests/db/invoiceDraftsHttp.integration.test.mjs proves it); this
    // suite stores no draft, so the store-only actor's list at its sales_staff store is empty.
    const drafts = await stores(port, storeOnly, { path: `${STORES_PATH}/${S_ALPHA}/invoice-drafts` });
    assert.equal(drafts.status, 200, drafts.body);
    assert.deepEqual(JSON.parse(drafts.body), { drafts: [], nextCursor: null }, 'the draft list is served, empty');
    assert.deepEqual(await rowCounts(), before, 'reads write no audit, outbox or idempotency row');
    // A grant change after login: the chain re-asks admission, the witness moved, the session ends (401).
    const changed = await actor('stah-changed', [storeGrant(T_A, S_ALPHA, 'manager')]);
    const s = await signIn(port, changed);
    assert.equal((await stores(port, s)).status, 200);
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${changed.id}, ${T_C}, ${S_DELTA}, 'store', 'manager', 'active')`;
    assert.equal((await stores(port, s)).status, 401, 'the standing moved: the session is refused');
    const fresh = await signIn(port, changed);
    assert.equal(JSON.parse((await stores(port, fresh)).body).stores.length, 2, 'a fresh session reads both stores');
    // One unservable name degrades its own entry: served as null, last, by id — never a 503 for the whole list.
    const bad = await stores(port, await signIn(port, BAD_NAMES));
    assert.equal(bad.status, 200, bad.body);
    assert.deepEqual(JSON.parse(bad.body).stores.map((e) => [e.id, e.name]),
      BAD_NAMES_ORDER.map((id) => [id, id === S_NORMAL_NAME ? `Normal ${SUFFIX}` : null]), 'the empty and the 257-character name as null');
    // The directory declares no authorization, so its 2xx never slides the session's idle window; an authorized read does.
    // The slide lands AFTER the response (app.ts refreshes on 'finish' without awaiting), so the control runs first and
    // its observed latency sets how long the negative waits: never less than 2 s, and three times the control's latency.
    const lastSeen = async (s) => String((await owner`select last_seen_at from tmpos_session.session where session_key = ${keyOf(s.cookie)}`)[0].last_seen_at);
    const slid = await signIn(port, TENANT_ONLY);
    const slidBefore = await lastSeen(slid);
    await delay(25);
    const sent = Date.now();
    assert.equal((await stores(port, slid, { path: '/api/v1/customers' })).status, 200, 'control: an authorized customer read');
    for (const until = Date.now() + 5_000; await lastSeen(slid) === slidBefore && Date.now() < until;) await delay(20);
    assert.notEqual(await lastSeen(slid), slidBefore, 'control: an authorized 2xx slides it');
    const patience = Math.max(2_000, 3 * (Date.now() - sent));
    const idle = await signIn(port, STORE_ONLY);
    const seenBefore = await lastSeen(idle);
    await delay(25);
    assert.equal((await stores(port, idle)).status, 200);
    await delay(patience);
    assert.equal(await lastSeen(idle), seenBefore, `GET /api/v1/stores leaves the idle window where it was (${patience} ms after)`);
    // The directory is a GET and nothing else: another method on its path is no route (the terminal 404, before any session).
    assertRefusal(await send(port, 'POST', STORES_PATH, { host: TENANT_HOST, cookie: storeOnly.cookie, [SESSION_CSRF_HEADER]: storeOnly.csrf,
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-length': '0' }), 404, 'not_found', 'POST /api/v1/stores');
    // An ADMINISTRATIVE session's key presented under the tenant cookie is refused by the tenant boundary (401), whatever
    // principal it names — here the store-only actor's own.
    const adminId = randomBytes(32).toString('base64url');
    const adminKey = createHash('sha256').update(adminId).digest('base64url');
    KEYS.add(adminKey);
    const a = { ...record(STORE_ONLY), audience: 'admin' };
    const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${adminKey}::text, ${a.audience}::text, ${a.authProvider}::text,
      ${a.authProviderUid}::text, ${a.principalKey}::text, ${a.securityVersion}::text, ${a.authenticatedAt}::bigint,
      ${a.createdAt}::bigint, ${a.lastSeenAt}::bigint, ${a.validatedAt}::bigint, ${a.createdAt + 10 * 60_000}::bigint, null::bytea) as outcome`;
    assert.equal(outcome, 'created');
    assertRefusal(await stores(port, { cookie: `${SESSION_COOKIES.tenant}=${adminId}`, csrf: storeOnly.csrf }), 401, 'unauthenticated',
      'an administrative session under the tenant cookie');
    assertRefusal(await stores(port, { cookie: `${SESSION_COOKIES.admin}=${adminId}`, csrf: storeOnly.csrf }), 401, 'unauthenticated',
      'the administrative cookie itself names no tenant session');
    // No log line carries a session key, a store or a tenant.
    for (const line of lines) for (const word of [S_ALPHA, S_DELTA, T_A, T_C, adminKey, adminId]) assert.ok(!line.includes(word), `no ${word} in a log line`);
  });
});
