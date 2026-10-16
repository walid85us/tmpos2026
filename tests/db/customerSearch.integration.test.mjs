// Phase 4.0 M7A-CUSTOMERS-P8 — the customer name search against REAL PostgreSQL: migration 025 (schema
// tmpos_customer_search: m7a_customer_search, STABLE, SECURITY DEFINER), exercised as the runtime's own non-owner login
// (tmpos_app + tmpos_audit_writer) and, end to end, through GET /api/v1/customers?q= on the tenant entry
// (server/entry/tenantEntry.ts, startTenantEntry) composed exactly as server/entry/tenantMain.ts composes it but for its
// construction (a supervised kernel over the cluster as the non-owner login, a synthetic bearer-token map, 127.0.0.1:0).
//
// WHAT IS PROVEN.
//   M7CS-01 001-024 applied and populated first (customers with and without contacts, a legacy NULL creation time, an
//           edited row at version 2), then 025 applied over them by the SAME trusted executor, its checksum the sha256 of
//           its up bytes; its postcondition re-proven and refusing the widenings it names; a second apply refused;
//   M7CS-02 the upgrade rewrites no row (every column and xmin byte-identical); the routine is plpgsql, STABLE, SECURITY
//           DEFINER, pinned to pg_catalog, pg_temp with row_security off, owned with its schema by the applier; the login
//           executes it and uses its schema; no other runtime role, and not PUBLIC, executes it; the login still holds
//           nothing on the customer table; a planted search path changes nothing; the real preflight accepts the login;
//   M7CS-03 rollback: in a rolled-back transaction 025's down leaves exactly the 001-024 surface; refused while a 001-024
//           customer read is withdrawn; committed, every customer row byte-identical, the P8 preflight refuses the 024
//           database, a second down is refused, and the trusted executor re-applies 025 over the same rows;
//   M7CS-04 matching: whole, partial, case-insensitive ASCII and non-ASCII ('É'/'é', 'ß'/'SS'), '%', '_' and '\' literal,
//           a 200-code-point text, no match as no row; a match beyond the first unfiltered page; every malformed argument
//           (empty, 201 code points, a control, a Bidi control, a bad key, a null tenant, a limit outside 1-101) 'invalid';
//   M7CS-05 pagination: 130 matches among 180 customers, duplicate names included, walked at page sizes 1, 50 and 100 —
//           by the routine and by the production adapter — with no duplicate or omission, in (name, id) byte order, ties
//           by id; a continuation anchored on a non-matching customer; 'cursor_unknown' for another tenant's and a deleted id;
//   M7CS-06 authority: two tenants holding identical names never see each other's rows; the role's current level (an
//           owner's narrowing below View denies, View and above read); every standing the list's routine denies — read-only
//           and overdue tenants and accounts admitted, suspensions, a revoked and an expired session denied — denied here
//           exactly as page_v3 denies it; a wrong expected tenant and an unknown key denied;
//   M7CS-07 the production adapter and probe over the real login: a search page, refusals, a probe that is true and false
//           once EXECUTE is withdrawn;
//   M7CS-08 HTTP: the response shape and headers; the filtered cursor round trip under another spelling of the same text;
//           the cursor refused once the text changes; the unfiltered list unchanged (both cursor kinds refused across);
//           every q refusal a 400 with no echo in the body or any log line; the 4096 bound; a foreign anchor a 400;
//   M7CS-09 HTTP: a role below View is a 403 (at sign-in and after an owner's narrowing), and no search writes a customer,
//           audit, outbox or idempotency row.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster
// this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. On a shared service
// it first rolls 025 back with its own committed down file (no data guard: 025 holds no data), so its customers are seeded
// on 001-024 exactly as a deployed database holds them, then applies 025 through the trusted executor. It never rolls back
// 024 or earlier, so it can run after the customer edit's HTTP step (which leaves 024 non-rollbackable). Every fixture is
// synthetic and randomly suffixed. It leaves 025, 026, 027 and 028 applied, the issuer key row and limiter fingerprint it found, no customer,
// session, ledger or role-level row of its own, and its login dropped; its tenants and identities stay, as every suite's do.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import { REQUIRED_MIGRATIONS, createPostgresStartupPreflight } from '../../server/persistence/postgresStartupPreflight.ts';
import { createPostgresCustomerDirectory, probeCustomerSearch } from '../../server/persistence/postgresCustomerDirectory.ts';
import { tenantMintProof } from '../../server/persistence/postgresSessionStore.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { principalKeyOf, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import {
  CUSTOMER_DIRECTORY_PATH, decodeCustomerSearchCursor, encodeCustomerCursor, encodeCustomerSearchCursor,
} from '../../server/runtime/customerDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_025 = readFileSync(`${MIG_DIR}/025_m7a_customer_search.up.sql`, 'utf8');
const DOWN_025 = readFileSync(`${MIG_DIR}/025_m7a_customer_search.down.sql`, 'utf8');
/** M5-INVOICES-AUTH-P1: 026 sits above 025 and is rolled back first wherever a proof needs exactly the 001-024 surface. */
const DOWN_026 = readFileSync(`${MIG_DIR}/026_m5_invoice_role_levels.down.sql`, 'utf8');
/** M7B-INVOICES-P1: 027 (store discovery) sits above 026 and is rolled back before it. */
const DOWN_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.down.sql`, 'utf8');
/** M7B-INVOICES-P1: 028 (invoice drafts) sits above 027 and is rolled back before it. */
const DOWN_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.down.sql`, 'utf8');
/** M7B-INVOICES-P2: 029 (the draft edit) lives in 028's schema and rolls back before it. */
const DOWN_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.down.sql`, 'utf8');
/** M7B-INVOICES-P2-R1: 030 (the Invoices level guard and the guarded edit, in its own schema) sits above 029 and rolls back first. */
const DOWN_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R3: 031 (the guarded draft save, in 030's schema) sits above 030 and rolls back first. */
const DOWN_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R4: 032 (the Customers authority of the guarded draft save, in 030's schema) sits above 031 and rolls back first. */
const DOWN_032 = readFileSync(`${MIG_DIR}/032_m7b_invoice_create_customers_authority.down.sql`, 'utf8');
/** M7B-INVOICES-DISCARD-P1: 033 (the draft discard, in its own schema tmpos_invoice_discard) sits above 032: it rolls back first. */
const DOWN_033 = readFileSync(`${MIG_DIR}/033_m7b_invoice_draft_discard.down.sql`, 'utf8');
/** M7B-INVOICES-ISSUE-P1: 034 (invoice issuing, in its own schema tmpos_invoice_issue) sits above 033: it rolls back first. */
const DOWN_034 = readFileSync(`${MIG_DIR}/034_m7b_invoice_issue.down.sql`, 'utf8');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_025 = UP_025.slice(UP_025.lastIndexOf('do $$'));
const SEARCH = 'tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer)';
const PAGE_V3 = 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)';
const PROFILE_024 = 'tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7cs-migrator', runtimeRef: 'm7cs-runtime' };
const LOCK_KEY = 528_533;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7cs_probe';
const HOUR = 3_600_000;
const ROLLBACK = new Error('m7cs: roll the proof back');
const RC = 'isolation level read committed';
const NULLS = Object.freeze({ o_tenant_id: null, o_customer_id: null, o_name: null });
const signal = () => AbortSignal.timeout(10_000);
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';
/** Made in this process, never written anywhere: the limiter's key, the tenant issuer key and the tenant command key. */
const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);
/** A text no other value in this file shares: an echo of it in a body or a log line would be seen. */
const CANARY = `Qcanary${SUFFIX}`;

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M7CS');
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

/** The owner: applies the migrations, installs the keys, writes the fixtures. RLS does not restrict it. */
const owner = connect(undefined, 4);
let runtime = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let issuerKeyBefore;
let rateLimitFingerprintBefore;

/** Applies every migration not yet in the ledger through the trusted executor (`port` narrows what it sees). */
async function trustedApply(port = createNodeFsPort(MIG_DIR, MIG_REL)) {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    return await runTrustedApply({
      fsPort: port, adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

test.after(async () => {
  const swallow = async (fn) => { try { await fn(); } catch { /* an earlier failure left less to clean */ } };
  if (TENANTS.length > 0) await swallow(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
  if (TENANTS.length > 0) await swallow(() => owner`update tenant set status = 'active' where tenant_id = any(${TENANTS}::uuid[]) and status <> 'active'`);
  if (UIDS.length > 0) {
    await swallow(async () => {
      for (const row of await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`) KEYS.add(row.session_key);
    });
  }
  if (KEYS.size > 0) await swallow(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
  if (UIDS.length > 0) await swallow(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
  // Every customer this file made, edited or not: a later suite's rollback of 024 refuses while any customer is edited.
  if (TENANTS.length > 0) await swallow(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
  // The shared service is left with 025, 026, 027, 028, 029, 030, 031, 032, 033 and 034 applied, whatever failed above: the executor applies them if not.
  await swallow(async () => {
    const [{ applied }] = await owner`select exists (select 1 from public.schema_migrations where version = '034') as applied`;
    if (!applied) await trustedApply();
  });
  if (issuerKeyBefore !== undefined) {
    await swallow(() => owner.begin(async (sql) => {
      await sql`delete from tmpos_mint.issuer_key where singleton`;
      if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
    }));
  }
  if (rateLimitFingerprintBefore !== undefined) {
    await swallow(() => owner.begin(async (sql) => {
      await sql`delete from tmpos_rate_limit.key_fingerprint where singleton`;
      if (rateLimitFingerprintBefore !== null) {
        await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
          values (${rateLimitFingerprintBefore.singleton}, ${rateLimitFingerprintBefore.fingerprint}, ${rateLimitFingerprintBefore.registered_at}::text::timestamptz)`;
      }
    }));
  }
  if (runtime) await runtime.end({ timeout: 5 });
  await swallow(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
  await swallow(() => owner.unsafe(`drop owned by ${RUNTIME_LOGIN}`));
  await swallow(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: 001-024 (025 rolled back on a shared service), a real non-owner runtime login, the keys, customers, then 025
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

// On a shared service an earlier step applied 025: its own committed down file removes it. On a fresh cluster there is
// nothing to roll back.
const rolledBackAtSetup = (await rollBackAbove(owner, MIG_DIR, '024')).rolledBack;
const applyThrough024 = await trustedApply(portThrough(createNodeFsPort(MIG_DIR, MIG_REL), '024'));

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

issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
await installTestIssuerKey(owner, ISSUER_KEY);
rateLimitFingerprintBefore = await (async () => {
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  return rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
})();
await owner.begin(async (sql) => {
  await sql`delete from tmpos_rate_limit.key_fingerprint`;
  await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(RATE_KEY)})`;
});

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7cs-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
/** A synthetic actor: an identity, an account of `status`, and the given tenant grants; a bearer token for the entry. */
async function actor(label, grants, status = 'active') {
  const uid = `m7cs-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const g of grants) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${g.tenant}, null, 'tenant', ${g.role}, 'active')`;
  }
  UIDS.push(uid);
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  const [m] = grants.length === 0 ? [] : await owner`select membership_id from user_membership where internal_user_id = ${id} and tenant_id = ${grants[0].tenant}`;
  return { id, uid, token, label, membership: m?.membership_id ?? null, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const TOKENS = new Map();

/** A tenant session for `who`, minted as the runtime login under ISSUER_KEY, live for `lifetime` ms. Answers the key. */
async function mint(who, lifetime = HOUR) {
  const key = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const at = Date.now();
  const r = { audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
    securityVersion: 't2:m7cs', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at };
  const expiresAt = at + lifetime;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${tenantMintProof(ISSUER_KEY, key, r, expiresAt)}::bytea) as outcome`;
  assert.equal(outcome, 'created', `a tenant session for ${who.uid}`);
  return key;
}

/** Customers inserted by the owner in one statement: [{ id, name }] (ids random). */
async function seed(tenant, names) {
  const ids = names.map(() => randomUUID());
  if (names.length > 0) {
    await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name)
      select x.id, ${tenant}::uuid, x.name from unnest(${ids}::uuid[], ${names}::text[]) as x(id, name)`;
  }
  return names.map((name, i) => ({ id: ids[i], name }));
}

/** 025's routine as the runtime login (or on `db`): its rows, plain. */
const search = async (key, tenant, q, after = null, limit = 101, db = runtime) =>
  (await db`select o_outcome, o_tenant_id, o_customer_id, o_name
    from tmpos_customer_search.m7a_customer_search(${key}::text, ${tenant}::uuid, ${q}::text, ${after}::uuid, ${limit}::integer)`).map((r) => ({ ...r }));
/** 020's list routine as the runtime login: its rows, plain. */
const pageV3 = async (key, after = null, limit = 101) =>
  (await runtime`select o_outcome, o_tenant_id, o_customer_id, o_name
    from tmpos_role.m7a_customer_page_v3(${key}::text, ${after}::uuid, ${limit}::integer)`).map((r) => ({ ...r }));
const namesOf = (rows) => rows.map((r) => r.o_name);
const one = (outcome) => [{ o_outcome: outcome, ...NULLS }];

/** The routine's page order, computed here independently: name as UTF-8 bytes, then id (lowercase hex text order). */
const pageOrder = (a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** JavaScript's default full uppercase — the same mapping as the ICU root locale's for every name this file uses. */
const matches = (name, q) => name.toUpperCase().includes(q.toUpperCase());

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
/**
 * The database surface 025 could touch, as one comparable value: every tmpos_* schema and its ACL; every routine there,
 * its source digest, configuration and ACL; 017's table's columns, constraints, indexes and ACLs. Read under one fixed
 * search path.
 */
const surface = (db) => ('savepoint' in db ? db.savepoint.bind(db) : db.begin.bind(db))(async (sp) => {
  await sp.unsafe('set local search_path = pg_catalog, pg_temp');
  return {
    schemas: (await sp`select n.nspname::text as name, n.nspacl::text as acl from pg_catalog.pg_namespace n
      where n.nspname like 'tmpos\\_%' order by 1`).map((r) => ({ ...r })),
    routines: (await sp`select p.oid::regprocedure::text as routine, pg_catalog.md5(p.prosrc) as src, p.proconfig::text as config, p.proacl::text as acl
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname like 'tmpos\\_%' order by 1`).map((r) => ({ ...r })),
    columns: (await sp`select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attacl::text as acl
      from pg_catalog.pg_attribute a where a.attrelid = 'tmpos_customer.customer'::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`).map((r) => ({ ...r })),
    constraints: (await sp`select c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def from pg_catalog.pg_constraint c
      where c.conrelid = 'tmpos_customer.customer'::regclass order by 1`).map((r) => ({ ...r })),
    indexes: (await sp`select pg_catalog.pg_get_indexdef(x.indexrelid) as def from pg_catalog.pg_index x
      where x.indrelid = 'tmpos_customer.customer'::regclass order by 1`).map((r) => r.def),
    tableAcl: (await sp`select c.relacl::text as acl from pg_catalog.pg_class c where c.oid = 'tmpos_customer.customer'::regclass`)[0].acl,
    roles: (await sp`select r.rolname::text as name from pg_catalog.pg_roles r where r.rolname like 'tmpos\\_%' order by 1`).map((r) => r.name),
  };
});

// ---------------------------------------------------------------------------
// the populated 001-024 state, then 025
// ---------------------------------------------------------------------------

const T_UP = await newTenant('upgrade');
const UPGRADED = [];
for (const [name, phone, email, legacy] of [
  [`Legacy Zed ${SUFFIX}`, null, null, true], [`Ada Lovelace ${SUFFIX}`, '+1 555 0100', 'ada@example.test', false],
  [`Name Only ${SUFFIX}`, null, null, false], [`Émile ${SUFFIX}`, null, 'emile@example.test', false],
]) {
  const id = randomUUID();
  if (legacy) await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, created_at) values (${id}, ${T_UP}, ${name}, null)`;
  else await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, phone, email) values (${id}, ${T_UP}, ${name}, ${phone}, ${email})`;
  UPGRADED.push(id);
}
// One row as an edit leaves it (024's version moved): 025 holds no data and must neither refuse nor touch it.
await owner`update tmpos_customer.customer set row_version = 2 where customer_id = ${UPGRADED[1]}`;
const rowsOf = async (ids) => (await owner`select customer_id, tenant_id, name, phone, email,
    (extract(epoch from created_at) * 1000000)::bigint::text as created_us, row_version::text as row_version, xmin::text as xmin
  from tmpos_customer.customer where customer_id = any(${ids}::uuid[]) order by customer_id`).map((r) => ({ ...r }));
const ROWS_024 = await rowsOf(UPGRADED);
const SURFACE_024 = await surface(owner);

// Now 025, by the same trusted executor, over those rows.
const applyReport = await trustedApply();

// ===========================================================================
// M7CS-01..03: the migration, the upgrade over populated rows, the privileges, the rollback
// ===========================================================================

test('M7CS-01: 025 applied by the trusted executor over a populated 001-024, its checksum its up bytes; its postcondition holds and refuses the widenings it names; a second apply is refused', async () => {
  assert.equal(applyThrough024.outcome, 'complete', JSON.stringify(applyThrough024).slice(0, 400));
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  assert.deepEqual(applyReport.applied, ['025', '026', '027', '028', '029', '030', '031', '032', '033', '034'], `025 applied over the populated 001-024 chain, and 026, 027, 028, 029, 030, 031, 032, 033 and 034 above it (M5-INVOICES-AUTH-P1, M7B-INVOICES-P1, -P2, -P2-R1, -P1-R3, -P1-R4, M7B-INVOICES-DISCARD-P1, M7B-INVOICES-ISSUE-P1) (rolled back at setup: ${JSON.stringify(rolledBackAtSetup)})`);
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 34 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.equal(ledger[24].checksum, createHash('sha256').update(readFileSync(`${MIG_DIR}/025_m7a_customer_search.up.sql`)).digest('hex'));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'the ledger records the pinned chain');
  assert.equal((await rolledBack(RC, (tx) => tx.unsafe(POSTCONDITION_025).simple())).code, undefined, 'the postcondition holds as applied');
  for (const [label, widen, pattern] of [
    ['EXECUTE to the audit writer', `grant execute on function ${SEARCH} to tmpos_audit_writer`, /unexpected direct grant/],
    ['EXECUTE to PUBLIC', `grant execute on function ${SEARCH} to public`, /unexpected direct grant/],
    ['EXECUTE to authenticated', `grant execute on function ${SEARCH} to authenticated`, /unexpected direct grant/],
    ['a grantable EXECUTE', `grant execute on function ${SEARCH} to tmpos_app with grant option`, /unexpected direct grant/],
    ['USAGE to the audit writer', 'grant usage on schema tmpos_customer_search to tmpos_audit_writer', /carries an unexpected grant/],
    ['a second routine', 'create function tmpos_customer_search.extra() returns integer language sql as $$ select 1 $$', /exactly the one routine/],
    ['a table beside it', 'create table tmpos_customer_search.extra (x integer)', /exactly the one routine/],
    ['the routine made VOLATILE', `alter function ${SEARCH} volatile`, /plpgsql STABLE SECURITY DEFINER/],
    ['the routine made SECURITY INVOKER', `alter function ${SEARCH} security invoker`, /plpgsql STABLE SECURITY DEFINER/],
    ['its search path reset', `alter function ${SEARCH} reset search_path`, /plpgsql STABLE SECURITY DEFINER/],
    ['a table grant', 'grant select on tmpos_customer.customer to tmpos_app', /holds a privilege on tmpos_customer\.customer/],
    ['a column grant', 'grant select (name) on tmpos_customer.customer to tmpos_app', /holds a privilege on tmpos_customer\.customer|column grant/],
    ['a column grant to another role', 'grant select (name) on tmpos_customer.customer to authenticated', /column grant/],
    ['017\'s page given to the login', 'grant execute on function tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer) to tmpos_app', /can execute 017's page/],
    ['the login a member of the owner', 'do $$ begin execute pg_catalog.format(\'grant %I to tmpos_app\', current_user); end $$', /member of the owner|holds a privilege on tmpos_customer\.customer/],
  ]) {
    const out = await rolledBack(RC, async (tx) => {
      await tx.unsafe(widen);
      await tx.unsafe(POSTCONDITION_025).simple();
    });
    assert.equal(out.code, '55000', `${label}: ${JSON.stringify(out)}`);
    assert.match(out.message, pattern, label);
  }
  const again = await rolledBack(RC, (tx) => tx.unsafe(UP_025).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /migration 025 refused: schema tmpos_customer_search already exists/);
  // Without 024 under it, or without the ICU collation, it refuses with a stated reason (both in a rolled-back transaction).
  const without024 = await rolledBack(RC, async (tx) => {
    await tx.unsafe(DOWN_025).simple();
    await tx.unsafe(`alter function ${PROFILE_024} rename to m7a_customer_profile_moved`);
    await tx.unsafe(UP_025).simple();
  });
  assert.equal(without024.code, '55000', JSON.stringify(without024));
  assert.match(without024.message, /migration 025 refused: migration 024 must be applied first/);
  const withoutIcu = await rolledBack(RC, async (tx) => {
    await tx.unsafe(DOWN_025).simple();
    await tx.unsafe('alter collation pg_catalog."und-x-icu" rename to "und-x-icu-moved"');
    await tx.unsafe(UP_025).simple();
  });
  assert.equal(withoutIcu.code, '55000', JSON.stringify(withoutIcu));
  assert.match(withoutIcu.message, /migration 025 refused: the ICU root collation pg_catalog."und-x-icu" is absent/);
});

test('M7CS-02: no row rewritten; the routine is a pinned STABLE SECURITY DEFINER owned with its schema; only the login executes it; the login still holds nothing on the table; the real preflight accepts the login and the ledger', async () => {
  assert.deepEqual(await rowsOf(UPGRADED), ROWS_024, 'every column byte-identical, and the same tuple (xmin): no row was rewritten');
  assert.equal(ROWS_024.filter((r) => r.row_version === '2').length, 1, 'an edited row is applied over as it is');
  const [p] = await owner`select
    pg_catalog.has_function_privilege('tmpos_app', ${SEARCH}, 'EXECUTE') as app_search,
    pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_search', 'USAGE') as app_usage,
    pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${SEARCH}, 'EXECUTE') as login_search,
    pg_catalog.has_function_privilege('tmpos_audit_writer', ${SEARCH}, 'EXECUTE') as writer_search,
    pg_catalog.has_function_privilege('anon', ${SEARCH}, 'EXECUTE') as anon_search,
    pg_catalog.has_function_privilege('authenticated', ${SEARCH}, 'EXECUTE') as authenticated_search,
    pg_catalog.has_function_privilege('public', ${SEARCH}, 'EXECUTE') as public_search,
    pg_catalog.has_schema_privilege('public', 'tmpos_customer_search', 'USAGE') as public_usage,
    pg_catalog.has_table_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as app_table,
    pg_catalog.has_any_column_privilege('tmpos_app', 'tmpos_customer.customer', 'SELECT, INSERT, UPDATE, REFERENCES') as app_columns,
    pg_catalog.has_function_privilege('tmpos_app', ${PAGE_V3}, 'EXECUTE') as app_page_v3`;
  assert.deepEqual({ ...p }, {
    app_search: true, app_usage: true, login_search: true, writer_search: false, anon_search: false, authenticated_search: false,
    public_search: false, public_usage: false, app_table: false, app_columns: false, app_page_v3: true,
  });
  const [config] = await owner`select p.proconfig::text as config, p.provolatile::text as volatility, p.prosecdef as definer,
      l.lanname::text as language, p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) as owned,
      n.nspowner = p.proowner as schema_owned, p.proacl::text as acl, n.nspacl::text as schema_acl
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.oid = ${SEARCH}::regprocedure`;
  assert.deepEqual({ ...config, acl: undefined, schema_acl: undefined }, {
    config: '{"search_path=pg_catalog, pg_temp",row_security=off}', volatility: 's', definer: true, language: 'plpgsql',
    owned: true, schema_owned: true, acl: undefined, schema_acl: undefined,
  });
  assert.match(config.acl, /tmpos_app=X\//, 'EXECUTE to tmpos_app');
  assert.doesNotMatch(config.acl, /(^|[{,])=X\//, 'no PUBLIC EXECUTE');
  assert.doesNotMatch(config.schema_acl, /(^|[{,])=U\//, 'no PUBLIC USAGE');
  for (const statement of ['select name from tmpos_customer.customer limit 1', 'select * from tmpos_customer.m7a_customer_page(null, null, null, null, null, null, 1)']) {
    assert.equal((await errorOf(runtime.unsafe(statement)))?.code, '42501', statement);
  }
  // A hostile search path planted by the caller changes nothing: the routine pins its own.
  const owner1 = await actor('hostile', [{ tenant: T_UP, role: 'store_owner' }]);
  const key = await mint(owner1);
  const hostile = await rolledBack(RC, async (tx) => {
    await tx.unsafe('create schema m7cs_hostile');
    await tx.unsafe('create function m7cs_hostile.upper(text) returns text language sql as $$ select \'%\'::text $$');
    await tx.unsafe('create function m7cs_hostile.char_length(text) returns integer language sql as $$ select 1 $$');
    await tx.unsafe('grant usage on schema m7cs_hostile to public');
    return (await asRuntime(tx, async (sp) => {
      await sp.unsafe('set local search_path = m7cs_hostile, pg_catalog');
      return { long: await search(key, T_UP, 'x'.repeat(201), null, 101, sp), match: namesOf(await search(key, T_UP, 'zed', null, 101, sp)) };
    }));
  });
  assert.deepEqual(hostile.value?.value, { long: one('invalid'), match: [`Legacy Zed ${SUFFIX}`] }, `a planted search path is ignored: ${JSON.stringify(hostile)}`);
  const verdict = await rolledBack(RC, (tx) => preflightOn(tx));
  assert.deepEqual(verdict.value, { runtimeLogin: [], migrationLedger: [] }, JSON.stringify(verdict));
});

test('M7CS-03: 025\'s down leaves exactly the 001-024 surface and every row byte-identical; refused while a 001-024 read is withdrawn or once applied away; committed, the P8 preflight refuses the 024 database and the executor re-applies 025 over the same rows', async () => {
  const down = await rolledBack(RC, async (tx) => {
    await tx.unsafe(DOWN_034).simple();
    await tx.unsafe(DOWN_033).simple();
    await tx.unsafe(DOWN_032).simple();
    await tx.unsafe(DOWN_031).simple();
    await tx.unsafe(DOWN_030).simple();
    await tx.unsafe(DOWN_029).simple();
    await tx.unsafe(DOWN_028).simple();
    await tx.unsafe(DOWN_027).simple();
    await tx.unsafe(DOWN_026).simple();
    await tx.unsafe(DOWN_025).simple();
    return { surface: await surface(tx), again: await errorOf(tx.savepoint((sp) => sp.unsafe(DOWN_025).simple())) };
  });
  assert.deepEqual(down.value?.surface, SURFACE_024, `exactly the 001-024 surface: ${JSON.stringify(down).slice(0, 300)}`);
  assert.equal(down.value?.again?.code, '55000', 'a second down refuses');
  assert.match(down.value?.again?.message ?? '', /migration 025 rollback refused: migration 025 is not applied/);
  for (const [label, withdraw, pattern] of [
    ['024\'s profile read withdrawn', `revoke execute on function ${PROFILE_024} from tmpos_app`, /no longer executes a 001-024 customer routine/],
    ['020\'s page_v3 withdrawn', `revoke execute on function ${PAGE_V3} from tmpos_app`, /no longer executes a 001-024 customer routine/],
    ['a table grant made while 025 was applied', 'grant select on tmpos_customer.customer to tmpos_app', /holds a privilege on tmpos_customer\.customer/],
    ['a column grant made while 025 was applied', 'grant select (name) on tmpos_customer.customer to authenticated', /column grant/],
  ]) {
    const out = await rolledBack(RC, async (tx) => {
      await tx.unsafe(withdraw);
      await tx.unsafe(DOWN_025).simple();
    });
    assert.equal(out.code, '55000', `${label}: ${JSON.stringify(out)}`);
    assert.match(out.message, pattern, label);
  }
  // Committed: the ledger's own row with it (rollBackAbove), then the trusted executor applies it again.
  const later = await rollBackAbove(owner, MIG_DIR, '024');
  assert.deepEqual(later.rolledBack, ['034', '033', '032', '031', '030', '029', '028', '027', '026', '025'], 'newest first: 034 above 033 above 032 above 031 above 030 above 029 above 028 above 027 above 026 above 025');
  try {
    assert.deepEqual(await surface(owner), SURFACE_024, 'committed: the 001-024 surface');
    assert.deepEqual(await rowsOf(UPGRADED), ROWS_024, 'committed: every customer row byte-identical, the edited one included');
    assert.deepEqual((await rolledBack(RC, (tx) => preflightOn(tx))).value,
      { runtimeLogin: ['role_privilege_missing'], migrationLedger: ['migration_missing'] }, 'the P8 runtime refuses the 024 database');
  } finally {
    const reapplied = await trustedApply();
    assert.equal(reapplied.outcome, 'complete', JSON.stringify(reapplied).slice(0, 400));
    assert.deepEqual(reapplied.applied, ['025', '026', '027', '028', '029', '030', '031', '032', '033', '034']);
  }
  assert.deepEqual(await rowsOf(UPGRADED), ROWS_024, 're-applied: every row byte-identical');
  assert.equal((await rolledBack(RC, (tx) => tx.unsafe(POSTCONDITION_025).simple())).code, undefined, 're-applied: the postcondition holds');
  assert.deepEqual((await rolledBack(RC, (tx) => preflightOn(tx))).value, { runtimeLogin: [], migrationLedger: [] });
});

// ===========================================================================
// M7CS-04..07: matching, pagination, authority, the production adapter
// ===========================================================================

// The matching tenant: a fixed set of names, and 60 fillers so that one name sorts beyond the first unfiltered page.
const T_M = await newTenant('match');
const MATCH_NAMES = ['Ada Lovelace', 'ada byron', 'ADA KING', 'Grace Hopper', 'Émile Zola', 'émile durand', 'Straße Nord', 'STRASSE SÜD',
  'strasse west', 'A%B', 'A_B', 'A\\B', 'AxB', 'AB', '100% Cotton', 'Zed Unique', `${'Ł'.repeat(199)}\u{1F600}`];
const FILLERS = Array.from({ length: 60 }, (_, i) => `Filler ${String(i).padStart(2, '0')}`);
const M_ROWS = await seed(T_M, [...MATCH_NAMES, ...FILLERS]);
const OWNER_M = await actor('owner-m', [{ tenant: T_M, role: 'store_owner' }]);
const KEY_M = await mint(OWNER_M);

test('M7CS-04: matching — whole, partial, case-insensitive ASCII and non-ASCII (É/é, ß/SS), %, _ and \\ literal, 200 code points, no match as no row; a match beyond the first unfiltered page; every malformed argument is one invalid row', async () => {
  const expect = async (q, names, label = q) => {
    const rows = await search(KEY_M, T_M, q);
    assert.deepEqual(namesOf(rows), names, label);
    for (const r of rows) assert.deepEqual([r.o_outcome, r.o_tenant_id], ['customer', T_M], `${label}: the derived tenant's rows`);
    // The routine and this file's independent model agree, in the routine's order.
    assert.deepEqual(names, M_ROWS.filter((c) => matches(c.name, q)).sort(pageOrder).map((c) => c.name), `${label}: the model agrees`);
  };
  await expect('Ada Lovelace', ['Ada Lovelace'], 'the whole name');
  await expect('love', ['Ada Lovelace'], 'a part');
  await expect('ada', ['ADA KING', 'Ada Lovelace', 'ada byron'], 'case-insensitive ASCII, in byte order');
  await expect('ADA K', ['ADA KING']);
  await expect('é', ['Émile Zola', 'émile durand'], '\'é\' finds \'É\'');
  await expect('ÉMILE', ['Émile Zola', 'émile durand'], '\'É\' finds \'é\'');
  await expect('ss', ['STRASSE SÜD', 'Straße Nord', 'strasse west'], '\'ss\' finds \'ß\'');
  await expect('ß', ['STRASSE SÜD', 'Straße Nord', 'strasse west'], '\'ß\' finds \'SS\'');
  await expect('straße', ['STRASSE SÜD', 'Straße Nord', 'strasse west']);
  await expect('süd', ['STRASSE SÜD'], 'a non-ASCII letter in the text');
  await expect('%', ['100% Cotton', 'A%B'], '% is literal');
  await expect('a%b', ['A%B'], '% is literal between letters: not AxB, not AB');
  await expect('_', ['A_B'], '_ is literal');
  await expect('a_b', ['A_B'], '_ is literal between letters: not AxB');
  await expect('\\', ['A\\B'], '\\ is literal');
  await expect('a\\b', ['A\\B']);
  await expect('\\%', [], 'an escaped percent is two literal characters');
  await expect('%%', []);
  await expect(`${'ł'.repeat(199)}\u{1F600}`, [`${'Ł'.repeat(199)}\u{1F600}`], 'a 200-code-point text');
  await expect('nobody here', [], 'no match is no row at all');
  // A match beyond the first unfiltered page: 'Zed Unique' is not on the list's default first page, and is found.
  const firstPage = await pageV3(KEY_M, null, 50);
  assert.equal(firstPage.length, 50);
  assert.ok(!namesOf(firstPage).includes('Zed Unique'), 'beyond the first unfiltered page (control)');
  await expect('unique', ['Zed Unique'], 'a match beyond the first unfiltered page');
  // Every malformed argument is exactly one 'invalid' row, decided before the session is read.
  for (const [label, args] of [
    ['an empty text', [KEY_M, T_M, '', null, 5]], ['a null text', [KEY_M, T_M, null, null, 5]],
    ['201 code points', [KEY_M, T_M, 'x'.repeat(201), null, 5]], ['201 astral code points', [KEY_M, T_M, '\u{1F600}'.repeat(201), null, 5]],
    ['a C0 control', [KEY_M, T_M, 'a\u0001b', null, 5]], ['a TAB', [KEY_M, T_M, 'a\tb', null, 5]], ['DEL', [KEY_M, T_M, 'a\u007fb', null, 5]],
    ['a C1 control', [KEY_M, T_M, 'a\u0085b', null, 5]], ['U+2028', [KEY_M, T_M, 'a b', null, 5]], ['U+2029', [KEY_M, T_M, 'a b', null, 5]],
    ['RLO', [KEY_M, T_M, 'a‮b', null, 5]], ['ALM', [KEY_M, T_M, 'a؜b', null, 5]], ['FSI', [KEY_M, T_M, 'a⁨b', null, 5]],
    ['a null key', [null, T_M, 'ada', null, 5]], ['a key with a space', ['a b', T_M, 'ada', null, 5]], ['a 129-character key', ['k'.repeat(129), T_M, 'ada', null, 5]],
    ['a null tenant', [KEY_M, null, 'ada', null, 5]], ['limit 0', [KEY_M, T_M, 'ada', null, 0]], ['limit 102', [KEY_M, T_M, 'ada', null, 102]],
    ['a null limit', [KEY_M, T_M, 'ada', null, null]],
  ]) assert.deepEqual(await search(...args), one('invalid'), label);
  // Edge whitespace is not refused at the routine (the runtime trims it); a text that is only spaces matches names with one.
  assert.deepEqual(namesOf(await search(KEY_M, T_M, ' ')), M_ROWS.filter((c) => c.name.includes(' ')).sort(pageOrder).map((c) => c.name));
  assert.deepEqual(await search(KEY_M, T_M, 'ada', null, 1), [{ o_outcome: 'customer', o_tenant_id: T_M, o_customer_id: M_ROWS[2].id, o_name: 'ADA KING' }], 'limit 1');
});

// The pagination tenant: 130 matching customers (40 with one duplicated name, 60 uppercase, 30 lowercase) among 180.
const T_P = await newTenant('pages');
const P_ROWS = await seed(T_P, [
  ...Array.from({ length: 40 }, () => 'Match Dup'),
  ...Array.from({ length: 60 }, (_, i) => `Match ${String(i).padStart(3, '0')}`),
  ...Array.from({ length: 30 }, (_, i) => `match lower ${String(i).padStart(3, '0')}`),
  ...Array.from({ length: 50 }, (_, i) => `Other ${String(i).padStart(3, '0')}`),
]);
const OWNER_P = await actor('owner-p', [{ tenant: T_P, role: 'store_owner' }]);
const KEY_P = await mint(OWNER_P);
const P_MATCH = P_ROWS.filter((c) => matches(c.name, 'match')).sort(pageOrder);

/** Every page of `q` at page size `size`, asking limit + 1 as the adapter does: the ids in the order they were served. */
async function walk(key, tenant, q, size, after = null) {
  const out = [];
  let anchor = after;
  for (let pages = 0; pages < 1_000; pages++) {
    const rows = await search(key, tenant, q, anchor, size + 1);
    assert.ok(rows.every((r) => r.o_outcome === 'customer' && r.o_tenant_id === tenant), JSON.stringify(rows[0]));
    const page = rows.slice(0, size);
    out.push(...page.map((r) => r.o_customer_id));
    if (rows.length <= size) return out;
    anchor = page[page.length - 1].o_customer_id;
  }
  throw new Error('walk did not end');
}

test('M7CS-05: pagination — 130 matches with duplicate names walked at sizes 1, 50 and 100 with no duplicate or omission, in (name, id) byte order, ties by id; an anchor that does not match positions the page; another tenant\'s and a deleted id are cursor_unknown', async () => {
  assert.equal(P_MATCH.length, 130);
  for (const size of [1, 50, 100]) {
    const ids = await walk(KEY_P, T_P, 'match', size);
    assert.equal(new Set(ids).size, ids.length, `size ${size}: no customer twice`);
    assert.deepEqual(ids, P_MATCH.map((c) => c.id), `size ${size}: every match once, in (name, id) byte order`);
  }
  const dups = P_MATCH.filter((c) => c.name === 'Match Dup').map((c) => c.id);
  assert.deepEqual(dups, [...dups].sort(), 'equal names in id order (deterministic ties)');
  // A page boundary inside the duplicates continues by id.
  const [, second] = [await search(KEY_P, T_P, 'match dup', null, 11), await search(KEY_P, T_P, 'match dup', dups[9], 11)];
  assert.deepEqual(second.map((r) => r.o_customer_id), dups.slice(10, 21), 'a continuation inside equal names');
  // The anchor need not match: its CURRENT (name, id) positions the page. 'Other 010' sorts before every lowercase match.
  const other = P_ROWS.find((c) => c.name === 'Other 010');
  assert.deepEqual((await search(KEY_P, T_P, 'match', other.id)).map((r) => r.o_customer_id),
    P_MATCH.filter((c) => pageOrder(c, other) > 0).map((c) => c.id), 'after a non-matching anchor');
  assert.equal(P_MATCH.filter((c) => pageOrder(c, other) > 0).length, 30, 'the lowercase matches (control)');
  // A renamed anchor positions the next page by its current name.
  const anchor = P_MATCH[5];
  const renamed = await rolledBack(RC, async (tx) => {
    await tx`update tmpos_customer.customer set name = 'match lower 015x' where customer_id = ${anchor.id}`;
    return (await asRuntime(tx, (sp) => search(KEY_P, T_P, 'match', anchor.id, 101, sp))).value;
  });
  const model = P_ROWS.map((c) => (c.id === anchor.id ? { ...c, name: 'match lower 015x' } : c)).filter((c) => matches(c.name, 'match')).sort(pageOrder);
  const moved = model.findIndex((c) => c.id === anchor.id);
  assert.deepEqual((renamed.value ?? []).map((r) => r.o_customer_id), model.slice(moved + 1).map((c) => c.id), `positioned at the anchor's current name: ${JSON.stringify(renamed).slice(0, 200)}`);
  // cursor_unknown: a customer of another tenant, and an id that was deleted.
  assert.deepEqual(await search(KEY_P, T_P, 'match', M_ROWS[0].id), one('cursor_unknown'), 'another tenant\'s customer');
  assert.deepEqual(await search(KEY_P, T_P, 'match', randomUUID()), one('cursor_unknown'), 'an id no customer has');
  const [gone] = await seed(T_P, ['Match Gone']);
  await owner`delete from tmpos_customer.customer where customer_id = ${gone.id}`;
  assert.deepEqual(await search(KEY_P, T_P, 'match', gone.id), one('cursor_unknown'), 'a deleted customer');
  // And a denial wins over an unknown cursor: no position is told to a caller the authority refuses.
  assert.deepEqual(await search(KEY_P, T_M, 'match', gone.id), one('denied'));
});

test('M7CS-06: authority — identical names in two tenants never cross; the current level decides (an owner\'s narrowing below View denies); every standing is decided exactly as the list\'s routine decides it; a wrong expected tenant and an unknown key are denied', async () => {
  const T_X = await newTenant('twin-x');
  const T_Y = await newTenant('twin-y');
  const [x1] = await seed(T_X, [`Twin Name ${SUFFIX}`]);
  const [y1] = await seed(T_Y, [`Twin Name ${SUFFIX}`]);
  const ownerX = await actor('owner-x', [{ tenant: T_X, role: 'store_owner' }]);
  const ownerY = await actor('owner-y', [{ tenant: T_Y, role: 'store_owner' }]);
  const keyX = await mint(ownerX);
  const keyY = await mint(ownerY);
  assert.deepEqual(await search(keyX, T_X, 'twin'), [{ o_outcome: 'customer', o_tenant_id: T_X, o_customer_id: x1.id, o_name: x1.name }]);
  assert.deepEqual(await search(keyY, T_Y, 'twin'), [{ o_outcome: 'customer', o_tenant_id: T_Y, o_customer_id: y1.id, o_name: y1.name }]);
  assert.deepEqual(await search(keyX, T_Y, 'twin'), one('denied'), 'another tenant named as expected: a precondition, never a selector');
  assert.deepEqual(await search(keyX, T_X, 'twin', y1.id), one('cursor_unknown'), 'another tenant\'s customer as the anchor');
  assert.deepEqual(await search(createHash('sha256').update(randomUUID()).digest('base64url'), T_X, 'twin'), one('denied'), 'an unknown key');
  // The role's current Customers level.
  const role = async (label, roleId, level) => {
    const tenant = await newTenant(`lvl-${label}`);
    await seed(tenant, [`Level ${label}`]);
    if (level !== undefined) await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${tenant}, ${roleId}, 'customers', ${level}, now())`;
    const who = await actor(`lvl-${label}`, [{ tenant, role: roleId }]);
    return { tenant, who, key: await mint(who) };
  };
  for (const [label, roleId, level, allowed] of [
    ['technician-default', 'technician', undefined, true], ['sales-default', 'sales_staff', undefined, true], ['manager-default', 'manager', undefined, true],
    ['technician-none', 'technician', 'none', false], ['manager-none', 'manager', 'none', false], ['sales-none', 'sales_staff', 'none', false],
    ['technician-view', 'technician', 'view', true], ['sales-view', 'sales_staff', 'view', true],
  ]) {
    const f = await role(label, roleId, level);
    const rows = await search(f.key, f.tenant, 'level');
    assert.deepEqual(rows.map((r) => r.o_outcome), allowed ? ['customer'] : ['denied'], label);
    assert.deepEqual((await pageV3(f.key)).map((r) => r.o_outcome), allowed ? ['customer'] : ['denied'], `${label}: the list's routine agrees`);
  }
  // An owner's narrowing after the session was minted is seen at once.
  const narrowed = await role('narrowed', 'manager');
  assert.equal((await search(narrowed.key, narrowed.tenant, 'level')).length, 1);
  await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${narrowed.tenant}, 'manager', 'customers', 'none', now())`;
  assert.deepEqual(await search(narrowed.key, narrowed.tenant, 'level'), one('denied'), 'narrowed below View after sign-in');
  // Every standing, decided exactly as page_v3 decides it.
  const standing = async (label, { status = 'active', account = 'active', after } = {}, lifetime = HOUR) => {
    const tenant = await newTenant(`st-${label}`, status);
    await seed(tenant, [`Standing ${label}`]);
    const who = await actor(`st-${label}`, [{ tenant, role: 'store_owner' }], account);
    const key = await mint(who, lifetime);
    if (after) await after({ tenant, who, key });
    return { tenant, key };
  };
  const SHORT = 3_000;
  const cases = [
    ['active', {}, 'customer'], ['trialing tenant', { status: 'trialing' }, 'customer'], ['read-only tenant', { status: 'read_only' }, 'customer'],
    ['overdue tenant', { status: 'overdue' }, 'customer'], ['read-only account', { account: 'read_only' }, 'customer'],
    ['overdue account', { account: 'overdue' }, 'customer'],
    ['tenant suspended after sign-in', { after: (f) => owner`update tenant set status = 'suspended' where tenant_id = ${f.tenant}` }, 'denied'],
    ['account suspended after sign-in', { after: (f) => owner`update app_user set status = 'suspended' where internal_user_id = ${f.who.id}` }, 'denied'],
    ['session revoked', { after: (f) => runtime`select tmpos_session.m5_session_revoke(${f.key}::text)` }, 'denied'],
    ['grant suspended', { after: (f) => owner`update user_membership set status = 'suspended' where internal_user_id = ${f.who.id}` }, 'denied'],
  ];
  // The control is read at once after minting, so the cases' round trips below cannot run the short lifetime out first.
  const expiring = await standing('expired', {}, SHORT);
  assert.deepEqual((await search(expiring.key, expiring.tenant, 'standing')).map((r) => r.o_outcome), ['customer'], 'live before expiry (control)');
  for (const [label, opts, outcome] of cases) {
    const f = await standing(label.replace(/\W+/g, '-'), opts);
    const searched = (await search(f.key, f.tenant, 'standing')).map((r) => r.o_outcome);
    const listed = (await pageV3(f.key)).map((r) => r.o_outcome);
    assert.deepEqual(searched, [outcome], `${label}: the search`);
    assert.deepEqual(listed, searched, `${label}: exactly as the list's routine`);
  }
  for (const until = Date.now() + SHORT + 2_000; Date.now() < until;) await delay(100);
  assert.deepEqual(await search(expiring.key, expiring.tenant, 'standing'), one('denied'), 'an expired session');
  assert.deepEqual(await pageV3(expiring.key), one('denied'), 'an expired session: the list agrees');
});

test('M7CS-07: the production directory adapter over the real login dispatches a search to 025 and walks its pages; refusals pass through; its probe is true, and with EXECUTE withdrawn its probe is false and a search a throw', async () => {
  const scope = Object.freeze({ actor: OWNER_P.id, securityVersion: 'sv', scope: 'tenant', tenant: T_P, store: null,
    membershipId: OWNER_P.membership, roleId: 'store_owner', limitation: 'none' });
  const kernel = Object.freeze({ transaction: (_s, _b, work) => runtime.begin(RC, (tx) => work(tx)), end: async () => {} });
  const adapter = createPostgresCustomerDirectory({ client: kernel });
  for (const limit of [1, 50, 100]) {
    const seen = [];
    let after = null;
    for (let pages = 0; ; pages++) {
      assert.ok(pages < Math.ceil(P_MATCH.length / limit), `limit ${limit}: the walk ends`);
      const page = await adapter.page(scope, KEY_P, { after, limit, search: 'MATCH' }, signal());
      assert.equal(page.outcome, 'page');
      seen.push(...page.customers.map((c) => c.id));
      if (!page.hasMore) break;
      after = page.customers[page.customers.length - 1].id;
    }
    assert.deepEqual(seen, P_MATCH.map((c) => c.id), `limit ${limit}: the adapter's walk`);
  }
  assert.deepEqual(await adapter.page(scope, KEY_P, { after: M_ROWS[0].id, limit: 5, search: 'match' }, signal()), { outcome: 'cursor_unknown' });
  assert.deepEqual(await adapter.page({ ...scope, tenant: T_M }, KEY_P, { after: null, limit: 5, search: 'match' }, signal()), { outcome: 'denied' },
    'the scope\'s tenant is a precondition');
  assert.deepEqual(await adapter.page(scope, KEY_P, { after: null, limit: 5, search: 'nobody' }, signal()), { outcome: 'page', customers: [], hasMore: false });
  assert.equal(await probeCustomerSearch(kernel, signal()), true);
  const withdrawn = await rolledBack(RC, async (tx) => {
    await tx.unsafe(`revoke execute on function ${SEARCH} from tmpos_app`);
    await tx.unsafe(`set local session authorization ${RUNTIME_LOGIN}`);
    const on = Object.freeze({ transaction: (_s, _b, work) => tx.savepoint((sp) => work(sp)), end: async () => {} });
    const probed = await probeCustomerSearch(on, signal());
    const read = await errorOf(createPostgresCustomerDirectory({ client: on }).page(scope, KEY_P, { after: null, limit: 5, search: 'match' }, signal()));
    return { probed, read: read?.code ?? read?.message ?? null };
  });
  assert.deepEqual(withdrawn.value, { probed: false, read: '42501' }, JSON.stringify(withdrawn));
});

// ===========================================================================
// M7CS-08..09: GET /api/v1/customers?q= over real loopback HTTP, the tenant entry composed as production composes it
// ===========================================================================

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
    type: 'service_account', project_id: 'm7cs-test-project', client_email: 'm7cs-test@m7cs-test-project.iam.gserviceaccount.com',
    private_key: FIREBASE_PRIVATE_KEY,
  }),
});

/** A random 127.x.y.z loopback source, never the trusted proxy: each request is its own limiter subject. */
function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}
function send(port, method, path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false, localAddress: randomLoopback() }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    request.on('error', reject);
    request.setTimeout(20_000, () => request.destroy(new Error(`no reply: ${method}`)));
    request.end();
  });
}
/** The baseline headers every reply carries, the HSTS one included (the tenant entry serves with hsts: true). */
function assertBaseline(reply, label) {
  assert.equal(reply.headers['strict-transport-security'], HSTS_HEADER.value, `${label}: HSTS`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(reply.headers[name.toLowerCase()], value, `${label}: ${name}`);
}
/** A refusal is the fixed `{ error, requestId }` and nothing else, carries the baseline headers, and echoes nothing. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  assert.ok(!reply.body.toLowerCase().includes('canary'), `${label}: the search text is not echoed`);
  assertBaseline(reply, label);
}
/** A page: exactly { customers: [{ id, name }], nextCursor }, no-store, the baseline headers. */
function pageOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['customers', 'nextCursor'], label);
  for (const c of body.customers) assert.deepEqual(Object.keys(c), ['id', 'name'], label);
  assert.match(reply.headers['cache-control'] ?? '', /no-store/, `${label}: no-store`);
  assertBaseline(reply, label);
  return body;
}

/** Start one tenant entry, hand the test its port and captured log lines, then stop it. */
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
/** A tenant login: { cookie, csrf }. */
async function signIn(port, who) {
  const reply = await send(port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${who.token}`, 'content-length': '0',
  });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  return { cookie: reply.headers['set-cookie'][0].split('; ')[0], csrf: JSON.parse(reply.body).csrfToken };
}
const list = (port, s, query) => send(port, 'GET', query === undefined ? CUSTOMER_DIRECTORY_PATH : `${CUSTOMER_DIRECTORY_PATH}?${query}`,
  { host: TENANT_HOST, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf });

/** C/A/O/K: customer rows, audit rows, outbox rows and idempotency rows, all of them. */
const rowCounts = async () => ({ ...(await owner`select
  (select count(*) from tmpos_customer.customer)::int as c, (select count(*) from public.audit_event)::int as a,
  (select count(*) from tmpos_internal.outbox_event)::int as o, (select count(*) from tmpos_internal.idempotency_record)::int as k`)[0] });

test('M7CS-08: over HTTP — the page shape and headers, the filtered cursor round trip under another spelling of the same text, the cursor refused once the text changes, the unfiltered list unchanged, every q refusal a 400 with no echo, the 4096 bound', async () => {
  await withEntry(async ({ port, lines }) => {
    assert.equal((await send(port, 'GET', '/readiness', { host: TENANT_HOST })).status, 200, 'ready: the reads probe asks 025\'s routine too');
    const s = await signIn(port, OWNER_P);
    // Measured after the sign-in, which writes its own session audit record: from here only searches run.
    const before = await rowCounts();
    // A filtered walk at limit=7, each continuation sent under another spelling of the same applied text.
    const spellings = ['q=match', 'q=+match+', 'q=match%20', 'q=%09match'];
    const seen = [];
    let next = null;
    for (let i = 0; i < 30; i++) {
      const body = pageOf(await list(port, s, `${spellings[i % spellings.length]}&limit=7${next === null ? '' : `&cursor=${next}`}`), `page ${i}`);
      seen.push(...body.customers);
      if (body.nextCursor === null) break;
      assert.match(body.nextCursor, /^[A-Za-z0-9_-]{44}$/, 'a filtered cursor');
      assert.equal(decodeCustomerSearchCursor(body.nextCursor, 'match'), body.customers.at(-1).id, 'bound to the applied text');
      next = body.nextCursor;
    }
    assert.deepEqual(seen, P_MATCH.map((c) => ({ id: c.id, name: c.name })), 'every match once, in page order, id and name only');
    // The text changed under a continuation: refused. The unfiltered list and its cursor are exactly as before.
    const filtered = encodeCustomerSearchCursor(P_MATCH[6].id, 'match');
    assertRefusal(await list(port, s, `q=matc&cursor=${filtered}`), 400, 'invalid_request', 'another text');
    assertRefusal(await list(port, s, `q=MATCH&cursor=${filtered}`), 400, 'invalid_request', 'another case is another text');
    assertRefusal(await list(port, s, `cursor=${filtered}`), 400, 'invalid_request', 'a filtered cursor without a search');
    assertRefusal(await list(port, s, `q=match&cursor=${encodeCustomerCursor(P_MATCH[6].id)}`), 400, 'invalid_request', 'an unfiltered cursor with a search');
    assertRefusal(await list(port, s, `q=match&cursor=${encodeCustomerSearchCursor(M_ROWS[0].id, 'match')}`), 400, 'invalid_request', 'another tenant\'s anchor');
    const unfiltered = pageOf(await list(port, s, 'limit=3'), 'unfiltered');
    const all = [...P_ROWS].sort(pageOrder);
    assert.deepEqual(unfiltered.customers, all.slice(0, 3).map((c) => ({ id: c.id, name: c.name })));
    assert.equal(unfiltered.nextCursor, encodeCustomerCursor(all[2].id), 'the unfiltered cursor kind, unchanged');
    const blank = pageOf(await list(port, s, `q=+&limit=3&cursor=${unfiltered.nextCursor}`), 'a blank search');
    assert.deepEqual(blank.customers, all.slice(3, 6).map((c) => ({ id: c.id, name: c.name })), 'a blank search is the unfiltered list, its cursor included');
    // Every q refusal: the bounded 400, no echo.
    const encoded = encodeURIComponent(CANARY);
    for (const [label, query] of [
      ['a control character', `q=${encoded}%00`], ['a Bidi control', `q=${encoded}%E2%80%AE`], ['201 characters', `q=${encoded}${'x'.repeat(201)}`],
      ['a malformed escape', `q=${encoded}%E`], ['an encoded lone surrogate', `q=${encoded}%ED%A0%80`], ['a repeated q', `q=${encoded}&q=${encoded}`],
      ['q without =', `q&limit=2`], ['an unknown key', `q=${encoded}&name=${encoded}`], ['4097 characters', `q=${encoded}${'+'.repeat(4097)}`],
    ]) assertRefusal(await list(port, s, query), 400, 'invalid_request', label);
    const atBound = `q=${'+'.repeat(4096 - 'q=match'.length)}match`;
    assert.equal(atBound.length, 4096);
    assert.equal(pageOf(await list(port, s, `${atBound}`), '4096 characters').customers.length, 50, 'a 4096-character query is read');
    // A search that matches nothing is a 200 with no customer — never a refusal.
    assert.deepEqual(pageOf(await list(port, s, `q=${encoded}`), 'no match'), { customers: [], nextCursor: null });
    // The scan below is vacuous unless the refusals above were logged: at least one line, and the parse refusal among them.
    assert.ok(lines.length > 0, 'the refusals were logged');
    assert.ok(lines.some((line) => line.includes('customer_directory_query_invalid')), 'a parse refusal was logged');
    for (const line of lines) assert.ok(!line.toLowerCase().includes('canary') && !line.includes('q='), `no log line carries the search: ${line.slice(0, 160)}`);
    assert.deepEqual(await rowCounts(), before, 'no customer, audit, outbox or idempotency row was written by a search');
  });
});

test('M7CS-09: over HTTP — a role below View is a 403 at sign-in and after an owner\'s narrowing; a View role reads; no search writes a row', async () => {
  const T_L = await newTenant('http-level');
  await seed(T_L, ['Leveled One', 'Leveled Two']);
  await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${T_L}, 'technician', 'customers', 'none', now())`;
  const tech = await actor('http-tech', [{ tenant: T_L, role: 'technician' }]);
  const sales = await actor('http-sales', [{ tenant: T_L, role: 'sales_staff' }]);
  await withEntry(async ({ port }) => {
    const narrowed = await signIn(port, tech);
    const reader = await signIn(port, sales);
    const before = await rowCounts();
    assertRefusal(await list(port, narrowed, 'q=leveled'), 403, 'forbidden', 'technician narrowed to none');
    assert.deepEqual(pageOf(await list(port, reader, 'q=two'), 'sales_staff at its default').customers.map((c) => c.name), ['Leveled Two']);
    await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${T_L}, 'sales_staff', 'customers', 'none', now())`;
    assertRefusal(await list(port, reader, 'q=two'), 403, 'forbidden', 'narrowed after sign-in');
    assertRefusal(await list(port, reader, `q=two&cursor=${encodeCustomerSearchCursor(randomUUID(), 'two')}`), 403, 'forbidden', 'the authority before the cursor');
    assert.deepEqual(await rowCounts(), before, 'no row written');
  });
});
