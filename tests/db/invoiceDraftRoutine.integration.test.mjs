// Phase 4.0 M7B-INVOICES-P1 — store-owned invoice drafts against REAL PostgreSQL: migration 028 (schema tmpos_invoice_draft,
// its two tables and three SECURITY DEFINER routines, the two referenced UNIQUE constraints and the audit subject column)
// exercised as the runtime's own non-owner login, every call bound exactly as the production adapter binds it.
//
// WHAT IS PROVEN (each test's title carries the stage brief's acceptance criteria it evidences).
//   IDR-01 (AC-16) 001-031 applied clean by the trusted executor, every ledger checksum the pinned one; 028's postcondition
//          re-proven over the applied state and refusing every widening it names; a second apply refused.
//   IDR-02 (AC-16) the inventory, the foreign keys and the ACL: two RLS tables with no policy and no runtime privilege by any
//          path (the login's direct read and write are 42501), composite NO ACTION foreign keys to store, customer and
//          header through the new UNIQUE constraints, three pinned SECURITY DEFINER routines — since 031 (M7B-INVOICES-P1-R3)
//          the page and the get EXECUTE-able by tmpos_app alone, the create by its owner alone, and 031's guarded save by
//          tmpos_app alone (the save every other test calls).
//   IDR-03 (AC-01 AC-06) a manager's store grant saves a draft at its store: the header (draft, USD, version 1, the line count,
//          the numeric subtotal, the database's microsecond creation time, the creating actor) and every line in order
//          (position, description, quantity, unit price, total) exactly; the reads answer it with the trusted tenant and
//          store on every row; the routine writes no audit record, outbox event or idempotency row, and (031) of role rows only
//          the Customers NULL anchor.
//   IDR-04 (AC-01 AC-02 AC-04) real store authority: two stores of one tenant and a second tenant — a grant at one store
//          never reaches the other, nor another tenant's store, a missing store or a store row nobody holds a grant at; a
//          tenant-only actor, two roles at one store and a grant naming another tenant's store are refused; the owner's
//          Full reaches only the store it holds a grant at; a custom role cannot even be a membership. Every refusal writes
//          nothing — no draft, line or role row — and the reads disclose no foreign draft (one not_found, one cursor_unknown).
//   IDR-05 (AC-03) the persisted Invoices View/Create thresholds and the Customers View corequisite decide, in both
//          directions, with owner-edited levels (technician, sales_staff, manager), the owner Full throughout — each read
//          (the page AND the get, which always agree) exactly the store's draft or exactly the denial, each save exactly
//          applied or exactly refused; sales_staff's Invoices taken View -> None -> View closes and reopens both reads.
//   IDR-06 (AC-05) a missing and another tenant's customer: one identical customer_not_found answer, decided before any
//          write (not even a role row); a tenant_mismatch precondition likewise.
//   IDR-07 (AC-06) every invalid argument raises invalid_parameter_value with a fixed message that never carries the value,
//          writing nothing; the tables' own CHECKs and composite foreign keys refuse an owner's direct out-of-contract row.
//   IDR-08 (AC-12) pagination: equal creation times (one transaction's now()) walked at every page size neither drop nor
//          repeat a draft, newest first then id; a draft saved later comes first; an unknown, another store's or another
//          tenant's anchor is one cursor_unknown; the page bound is 1-51.
//   IDR-09 (AC-01 AC-10) statuses: a read-only account, tenant or store reads but cannot save; a suspended store denies
//          everything to a session minted before it; and the whole matrix — account, tenant and store each at active,
//          trialing, overdue, read_only, suspended and pending_activation, on a session minted AFTER the change (never a
//          stale standing): active and trialing save and read; overdue and read_only read an existing draft (page and get)
//          but cannot save, writing nothing; suspended and pending_activation are denied all three.
//   IDR-13 (AC-10 AC-03) the create's re-decision on the LOCKED levels (its step 12): an owner's narrowing that commits
//          after the create's unlocked decision, while the create waits on it (a pg_locks barrier; under 031's save, on 030's
//          key, which the narrowing's level write holds EXCLUSIVE), refuses it
//          with nothing written; the same narrowing rolled back instead lets the same create save.
//   IDR-10 (AC-16) the parity of every SQL restatement (the defaults for both domains, the owner literal, the ordering).
//   IDR-11 (AC-16) the rollback and the upgrade: 028's down refused while not applied, while a draft or a line exists and
//          while an audit record names a draft; 027's down refused while 028 is applied; with nothing retained, 028 rolled
//          back through the executor's own path — 027's exact store, customer and audit inventory restored, the Invoices
//          lock anchors only 028's create made removed and every versioned or levelled row kept, the 001-031 runtime then
//          refused by the startup preflight — and the 027 database, holding customers and role configuration, upgraded to
//          028 by the trusted executor with every row unchanged.
//   IDR-12 (AC-16 R7) the lock order, live for BOTH files: each is run while another transaction holds its tables one at a
//          time, and waits on exactly that table holding ACCESS EXCLUSIVE on exactly the tables before it in R7's creators'
//          order — the down on its seven (store, role levels, level versions, customer, draft, lines, audit) with its guard
//          not yet run; the up, over the applied 028, on the five that exist before it (store, role levels, level versions,
//          customer, audit) with its preconditions not yet run (released, they refuse it: 028 already exists). A table or
//          schema the locks name that is missing is the file's own refusal (55000), never a raw 42P01 or 3F000; and on the
//          database WITHOUT 028 (rolled back through its down and ledger row, then restored) the down still waits on each
//          table it reaches before any check, is refused 55000 "not applied" and keeps none of the locks it took.
//          Statically, for both files, the lock block is the first statement after the transaction settings — no block,
//          read or check before it — holding only the locks, in that order, and the handler; every check and the first
//          change come after it.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and
// randomly suffixed; every id and key is made at run time. It rolls 028 back, with 029, 030 and 031 above it (and restores all four: IDR-11 and
// IDR-12), so on a shared service it runs after every step that applies 028 and before the HTTP suite. It leaves 028, 029, 030 and 031 applied, the
// ledger 001-031, the issuer key row and limiter fingerprint it found, and NO draft, line, audit subject, Invoices lock anchor,
// session, mint-ledger row or login of its own; its synthetically named identities, tenants, stores, memberships and
// customers stay, as every suite's do (no customer it made is referenced by a draft once it ends).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { REQUIRED_MIGRATIONS, createPostgresStartupPreflight } from '../../server/persistence/postgresStartupPreflight.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { TENANT_ORDERING, TENANT_ROLE_PERMISSION_DEFAULTS } from '../../server/platform-identity/permissionCatalog.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.up.sql`, 'utf8');
const DOWN_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.down.sql`, 'utf8');
const DOWN_027 = readFileSync(`${MIG_DIR}/027_m7b_store_access.down.sql`, 'utf8');
/**
 * M7B-INVOICES-P2: 029 (the draft edit) adds a routine, a trigger and its function to 028's schema and widens 028's version
 * CHECK, which 028's exact postcondition does not know; 028's own surface is therefore judged with 029's committed down run
 * first, in the same rolled-back transaction (no draft here is ever edited), and 028's rollback now follows 029's.
 */
const DOWN_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.down.sql`, 'utf8');
/** M7B-INVOICES-P2-R1: 030 (the Invoices level guard and the guarded edit, in its own schema) sits above 029 and rolls back first. */
const DOWN_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R3: 031 (the guarded draft save, in 030's schema) sits above 030 and rolls back first. */
const DOWN_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.down.sql`, 'utf8');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_028 = UP_028.slice(UP_028.lastIndexOf('do $$'));
const CREATE = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
/**
 * M7B-INVOICES-P1-R3: migration 031's guarded save — 028's create re-issued in 030's schema, holding 030's key SHARED through
 * both sealed outcomes, with no Invoices lock anchor. 031 revokes the login's EXECUTE on 028's create and grants this one, so
 * the runtime login (and this file, binding exactly as the adapter binds) calls this routine; 028's stays installed, pinned.
 */
const CREATE_V2 = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
const PAGE = 'tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)';
const GET = 'tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)';
const MIGRATOR = { purpose: 'migration', migratorRef: 'idr-migrator', runtimeRef: 'idr-runtime' };
const LOCK_KEY = 528_528;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_idr_probe';
const HOUR = 3_600_000;
const MAX = 9007199254740991;
const ROLLBACK = new Error('idr: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const REFUSED = Object.freeze({ o_outcome: 'refused', o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null });
const PAGE_NULLS = Object.freeze({ o_tenant_id: null, o_store_id: null, o_draft_id: null, o_customer_id: null, o_status: null, o_currency: null,
  o_line_count: null, o_subtotal_cents: null, o_created_at: null });
const GET_NULLS = Object.freeze({ ...PAGE_NULLS, o_version: null, o_position: null, o_description: null, o_quantity: null, o_unit_price_cents: null,
  o_line_total_cents: null });
const MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (027's suite's)
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

const TARGET = resolveDisposableTarget('IDR');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}
const connect = (user, max) => testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

const owner = connect(undefined, 4);
let runtime = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let issuerKeyBefore;

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

/** Everything this suite wrote that a later rollback of 028 (or 026) would refuse over: drafts, lines, anchors, subjects. */
async function cleanDrafts() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    const [{ applied }] = await sql`select pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft') is not null as applied`;
    if (applied) {
      const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
      if (drafts.length > 0) {
        // 002's append-only trigger is lifted for this one update and put back in exactly the mode it was found in.
        const [{ mode }] = await sql`select tgenabled as mode from pg_catalog.pg_trigger
          where tgrelid = 'public.audit_event'::regclass and tgname = 'trg_audit_event_reject_mutation'`;
        const restore = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' }[mode];
        assert.ok(restore, `the append-only trigger's mode is known: ${mode}`);
        await sql.unsafe('alter table public.audit_event disable trigger trg_audit_event_reject_mutation');
        await sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`;
        await sql.unsafe(`alter table public.audit_event ${restore} trg_audit_event_reject_mutation`);
      }
      await sql`delete from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`;
    }
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    await step(cleanDrafts);
    // A failed IDR-11 may have left 028 (and 029, 030 and 031 above it) rolled back: the executor applies them again.
    await step(async () => {
      if (!(await owner`select exists (select 1 from public.schema_migrations where version = '031') as applied`)[0].applied) {
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
    if (runtime) await step(() => runtime.end({ timeout: 5 }));
    await step(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
    await step(() => owner.unsafe(`do $$ begin
      if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
    end $$;`));
    await step(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
    await step(async () => {
      const [state] = await owner`select
          pg_catalog.to_regnamespace('tmpos_invoice_draft') is not null as schema_028,
          exists (select 1 from public.schema_migrations where version = '028') as ledger_028,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, { schema_028: true, ledger_028: true, drafts: 0, subjects: 0, anchors: 0, sessions: 0, login: false },
        'left as found: 028 applied and recorded, nothing of this suite\'s retained');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IDR teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: every migration in the directory (001-031), a real non-owner runtime login, the issuer key installed by the owner
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

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`idr-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IDR ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `idr-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${accountStatus})`;
  const memberships_ = [];
  for (const m of memberships) {
    const [{ membership_id: mid }] = await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, ${m.store ?? null}, ${m.scope}, ${m.role}, ${m.status ?? 'active'}) returning membership_id`;
    memberships_.push(mid);
  }
  UIDS.push(uid);
  return { id, uid, label, memberships: memberships_, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const storeGrant = (tenant, store, role, status) => ({ scope: 'store', tenant, store, role, ...(status === undefined ? {} : { status }) });
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
/** The tenant owner's stored level for `role` on `domain` (020's table, as the role-level suites write it). */
const setLevel = (tenant, role, domain, level) => owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;

// ---------------------------------------------------------------------------
// the runtime login's calls, bound exactly as postgresInvoiceDrafts.ts binds them
// ---------------------------------------------------------------------------

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:idr', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
});
async function mint(who, { lifetime = 8 * HOUR } = {}) {
  const key = newKey();
  const r = record(who);
  const expiresAt = r.createdAt + lifetime;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${proofOf(ISSUER_KEY, key, r, expiresAt)}::bytea) as outcome`;
  assert.equal(outcome, 'created', `a tenant session for ${who.uid}`);
  return key;
}
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const sumOf = (lines) => lines.reduce((s, l) => s + BigInt(l.quantity) * BigInt(l.unitPriceCents), 0n);
/** The create (031's, CREATE_V2), as the mutator binds it; `lines` a JS array (serialized once, as the adapter does) or raw jsonb text. */
async function create(key, store, tenant, customer, lines, { draft = randomUUID(), subtotal, db = runtime } = {}) {
  const text = typeof lines === 'string' ? lines : JSON.stringify(lines);
  const total = subtotal ?? String(sumOf(lines));
  const rows = await db`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id
    from tmpos_invoice_edit.m7b_invoice_draft_create_v2(${key}::text, ${store}::uuid, ${draft}::uuid, ${tenant}::uuid, ${customer}::uuid,
      ${text}::text::jsonb, ${String(total)}::bigint)`;
  return { draft, rows: rows.map((r) => ({ ...r })) };
}
const page = async (key, tenant, store, { after = null, limit = 21, db = runtime } = {}) => (await db`select o_outcome, o_tenant_id, o_store_id,
    o_draft_id, o_customer_id, o_status, o_currency, o_line_count, o_subtotal_cents, o_created_at
  from tmpos_invoice_draft.m7b_invoice_draft_page(${key}::text, ${tenant}::uuid, ${store}::uuid, ${after}::uuid, ${limit}::integer)`).map((r) => ({ ...r }));
const get = async (key, tenant, store, draft) => (await runtime`select o_outcome, o_tenant_id, o_store_id, o_draft_id, o_customer_id, o_status,
    o_currency, o_version, o_created_at, o_line_count, o_subtotal_cents, o_position, o_description, o_quantity, o_unit_price_cents, o_line_total_cents
  from tmpos_invoice_draft.m7b_invoice_draft_get(${key}::text, ${tenant}::uuid, ${store}::uuid, ${draft}::uuid)`).map((r) => ({ ...r }));
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
const applied = (who, tenant, store) => ({ o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id, o_membership_id: who.memberships[0] });

/** What a scope holds now: drafts, lines and role rows of its tenant(s), and every draft-subject audit record. */
async function footprint(tenants) {
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as drafts,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as lines,
    (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${tenants}::uuid[]))::int as roles,
    (select count(*) from public.audit_event where subject_invoice_draft_id is not null)::int as subjects,
    (select count(*) from tmpos_internal.outbox_event)::int as events,
    (select count(*) from tmpos_internal.idempotency_record)::int as records`;
  return { ...r };
}
/** Runs `fn` in an owner transaction that is always rolled back: { value } or the { code, message } it raised. */
async function rolledBack(fn) {
  let out;
  await assert.rejects(owner.begin(RC, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}

// The scene every authority test reads: tenant A with two stores and a store row nobody holds, tenant B with one store.
const T_A = await newTenant('a');
const T_B = await newTenant('b');
const S_A1 = await newStore(T_A, `A1 ${SUFFIX}`);
const S_A2 = await newStore(T_A, `A2 ${SUFFIX}`);
const S_ORPHAN = await newStore(T_A, `Orphan ${SUFFIX}`);
const S_B1 = await newStore(T_B, `B1 ${SUFFIX}`);
const C_A = await newCustomer(T_A, 'a');
const C_B = await newCustomer(T_B, 'b');
const LINES = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 2, 4_500), line('Tempered glass ' + String.fromCodePoint(0x1f4f1), 3, 0)];

// ===========================================================================
// IDR-01..02: the migration, the inventory and the ACL
// ===========================================================================

test('IDR-01 (AC-16): 001-031 applied clean, every checksum the pinned one; 028\'s postcondition holds and refuses every widening it names; a second apply is refused', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 31 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'every ledger checksum is the pinned one');
  assert.equal(ledger[27].checksum, createHash('sha256').update(UP_028).digest('hex'), '028\'s checksum is its up bytes');
  assert.equal((await rolledBack(async (tx) => { await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(POSTCONDITION_028).simple(); })).code, undefined,
    'the applied state satisfies the postcondition (031, 030 and 029 rolled back above it)');
  const on029 = await rolledBack((tx) => tx.unsafe(POSTCONDITION_028).simple());
  assert.equal(on029.code, '55000', `029 applied: 028's exact inventory sees 029's routines and trigger (${JSON.stringify(on029)})`);
  for (const [label, widen] of [
    ['EXECUTE to PUBLIC', `grant execute on function ${CREATE} to public`],
    ['EXECUTE to the audit writer', `grant execute on function ${PAGE} to tmpos_audit_writer`],
    ['a grantable EXECUTE', `grant execute on function ${GET} to tmpos_app with grant option`],
    ['USAGE to PUBLIC', 'grant usage on schema tmpos_invoice_draft to public'],
    ['SELECT on the drafts to tmpos_app', 'grant select on tmpos_invoice_draft.invoice_draft to tmpos_app'],
    ['INSERT on the lines to tmpos_app', 'grant insert on tmpos_invoice_draft.invoice_draft_line to tmpos_app'],
    ['a column grant', 'grant select (description) on tmpos_invoice_draft.invoice_draft_line to anon'],
    ['a policy', 'create policy p on tmpos_invoice_draft.invoice_draft for select to tmpos_app using (true)'],
    ['forced row security', 'alter table tmpos_invoice_draft.invoice_draft force row level security'],
    ['a third table', 'create table tmpos_invoice_draft.extra (x integer)'],
    ['a fourth routine', 'create function tmpos_invoice_draft.extra() returns integer language sql as \'select 1\''],
    ['a stable create', `alter function ${CREATE} stable`],
    ['an invoker read', `alter function ${PAGE} security invoker`],
    ['a cascading foreign key', 'alter table tmpos_invoice_draft.invoice_draft_line drop constraint invoice_draft_line_draft_fkey, add constraint invoice_draft_line_draft_fkey foreign key (draft_id, tenant_id, store_id) references tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id) on delete cascade'],
    ['a relaxed CHECK', 'alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_currency_chk'],
    ['the audit column granted', 'grant select (subject_invoice_draft_id) on public.audit_event to tmpos_app'],
  ]) {
    const out = await rolledBack(async (tx) => { await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(widen); await tx.unsafe(POSTCONDITION_028).simple(); });
    assert.equal(out.code, '55000', `${label}: refused (${JSON.stringify(out)})`);
    assert.match(out.message, /migration 028 refused/, label);
  }
  const again = await rolledBack((tx) => tx.unsafe(UP_028).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /already exists/);
});

test('IDR-02 (AC-16): two RLS tables with no policy and no runtime privilege by any path; composite NO ACTION foreign keys through the new UNIQUEs; 028\'s three pinned definers, its create closed to the login and 031\'s guarded save the login alone may execute', async () => {
  // 028's three (029's edit routine and trigger function in the same schema are proven by invoiceDraftEditRoutine IDE-02).
  const fns = (await owner`select p.proname::text as name, p.prosecdef, p.provolatile::text as volatility, p.proconfig, p.proacl::text as acl
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
      and p.proname in ('m7b_invoice_draft_create', 'm7b_invoice_draft_get', 'm7b_invoice_draft_page') order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(fns.map((f) => [f.name, f.prosecdef, f.volatility, f.proconfig]), [
    ['m7b_invoice_draft_create', true, 'v', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
    ['m7b_invoice_draft_get', true, 's', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
    ['m7b_invoice_draft_page', true, 's', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
  ]);
  // M7B-INVOICES-P1-R3: 031 closed 028's create to the login (its ACL the owner's EXECUTE alone) and gave it 031's guarded save;
  // 028's page and get stay the login's.
  for (const [sig, login] of [[CREATE, false], [CREATE_V2, true], [PAGE, true], [GET, true]]) {
    const [can] = await owner`select pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${sig}::regprocedure, 'EXECUTE') as login,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${sig}::regprocedure, 'EXECUTE') as audit,
      pg_catalog.has_function_privilege('anon', ${sig}::regprocedure, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${sig}::regprocedure, 'EXECUTE') as authenticated`;
    assert.deepEqual({ ...can }, { login, audit: false, anon: false, authenticated: false }, sig);
  }
  const [{ me }] = await owner`select current_user as me`;
  assert.equal((await owner`select proacl::text as acl from pg_catalog.pg_proc where oid = ${CREATE}::regprocedure`)[0].acl, `{${me}=X/${me}}`,
    '028\'s create: exactly the owner\'s EXECUTE (031)');
  assert.equal((await errorOf(runtime`select o_outcome from tmpos_invoice_draft.m7b_invoice_draft_create(${newKey()}::text, ${randomUUID()}::uuid,
    ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, '[]'::jsonb, 0::bigint)`))?.code, '42501', 'the login cannot call 028\'s create');
  const tables = (await owner`select c.relname::text as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced, c.relacl::text as acl,
      (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid)::int as policies
    from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_draft'::regnamespace and c.relkind = 'r' order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(tables.map((t) => [t.name, t.rls, t.forced, t.policies]), [['invoice_draft', true, false, 0], ['invoice_draft_line', true, false, 0]]);
  for (const t of ['tmpos_invoice_draft.invoice_draft', 'tmpos_invoice_draft.invoice_draft_line']) {
    const [p] = await owner`select pg_catalog.has_table_privilege(${RUNTIME_LOGIN}, ${t}::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as any_priv,
      pg_catalog.has_any_column_privilege(${RUNTIME_LOGIN}, ${t}::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') as any_column`;
    assert.deepEqual({ ...p }, { any_priv: false, any_column: false }, `${t}: the login reaches it only through the routines`);
  }
  assert.equal((await errorOf(runtime`select count(*) from tmpos_invoice_draft.invoice_draft`))?.code, '42501', 'no direct read');
  assert.equal((await errorOf(runtime`insert into tmpos_invoice_draft.invoice_draft_line (draft_id) values (${randomUUID()})`))?.code, '42501', 'no direct write');
  const fks = (await owner`select c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def from pg_catalog.pg_constraint c
    where c.conrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and c.contype = 'f' order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(fks, [
    { name: 'invoice_draft_customer_fkey', def: 'FOREIGN KEY (tenant_id, customer_id) REFERENCES tmpos_customer.customer(tenant_id, customer_id)' },
    { name: 'invoice_draft_line_draft_fkey', def: 'FOREIGN KEY (draft_id, tenant_id, store_id) REFERENCES tmpos_invoice_draft.invoice_draft(draft_id, tenant_id, store_id)' },
    { name: 'invoice_draft_store_fkey', def: 'FOREIGN KEY (tenant_id, store_id) REFERENCES store(tenant_id, store_id)' },
  ], 'composite, NO ACTION (no ON DELETE / ON UPDATE clause)');
  const uniques = (await owner`select c.conrelid::regclass::text as rel, c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def
    from pg_catalog.pg_constraint c where c.conname in ('store_tenant_store_key', 'customer_tenant_customer_key') order by 2`).map((r) => ({ ...r }));
  assert.deepEqual(uniques, [
    { rel: 'tmpos_customer.customer', name: 'customer_tenant_customer_key', def: 'UNIQUE (tenant_id, customer_id)' },
    { rel: 'store', name: 'store_tenant_store_key', def: 'UNIQUE (tenant_id, store_id)' },
  ]);
  const [audit] = await owner`select a.atttypid::regtype::text as type, a.attnotnull, a.atthasdef,
      pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_draft_occurred') is not null as indexed
    from pg_catalog.pg_attribute a where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id'`;
  assert.deepEqual({ ...audit }, { type: 'uuid', attnotnull: false, atthasdef: false, indexed: true });
});

// ===========================================================================
// IDR-03..06: saving, and the authority it needs
// ===========================================================================

test('IDR-03 (AC-01 AC-06): a store grant saves a draft at its store — the header and every line exactly, the reads answering it under the trusted tenant and store; the routine writes no audit, event or idempotency row', async () => {
  const manager = await actor('manager', [storeGrant(T_A, S_A1, 'manager')]);
  const key = await mint(manager);
  const before = await footprint([T_A]);
  const { draft, rows } = await create(key, S_A1, T_A, C_A, LINES);
  assert.deepEqual(rows, [applied(manager, T_A, S_A1)]);
  const after = await footprint([T_A]);
  assert.deepEqual([after.drafts - before.drafts, after.lines - before.lines, after.subjects - before.subjects, after.events - before.events,
    after.records - before.records], [1, 3, 0, 0, 0], 'one draft, three lines, and no audit, event or idempotency row: the runtime appends those');
  // M7B-INVOICES-P1-R3 (031): the save anchors the role's Customers row only (NULL: the default); the Invoices level is held by
  // 030's key, so no Invoices row is made to exist.
  assert.equal(after.roles - before.roles, 1, 'the role\'s Customers lock anchor made to exist (NULL: the default), and no Invoices row');
  assert.deepEqual((await owner`select domain, level from tmpos_role.tenant_role_level where tenant_id = ${T_A} and role_id = 'manager' order by domain`).map((r) => ({ ...r })),
    [{ domain: 'customers', level: null }], 'exactly the Customers NULL anchor');
  const [header] = await owner`select tenant_id, store_id, customer_id, status, currency, version::text as version, line_count, subtotal_cents::text as subtotal,
      created_by, created_at <= pg_catalog.clock_timestamp() as past from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`;
  assert.deepEqual({ ...header }, { tenant_id: T_A, store_id: S_A1, customer_id: C_A, status: 'draft', currency: 'USD', version: '1', line_count: 3,
    subtotal: String(12_999 + 9_000), created_by: manager.id, past: true }, 'the server derived the status, currency, version, subtotal, time and creator');
  const lines = (await owner`select position, description, quantity::text as q, unit_price_cents::text as p, line_total_cents::text as t, tenant_id, store_id
    from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft} order by position`).map((r) => ({ ...r }));
  assert.deepEqual(lines, LINES.map((l, i) => ({ position: i + 1, description: l.description, q: String(l.quantity), p: String(l.unitPriceCents),
    t: String(l.quantity * l.unitPriceCents), tenant_id: T_A, store_id: S_A1 })), 'in order, the description exactly as sent (inner whitespace and astral kept)');
  const got = await get(key, T_A, S_A1, draft);
  assert.equal(got.length, 3);
  assert.match(got[0].o_created_at, MICROS, 'UTC with microseconds');
  assert.deepEqual(got.map((r) => [r.o_outcome, r.o_tenant_id, r.o_store_id, r.o_draft_id, r.o_customer_id, r.o_status, r.o_currency, r.o_version, r.o_line_count, r.o_subtotal_cents]),
    Array(3).fill(['draft', T_A, S_A1, draft, C_A, 'draft', 'USD', '1', 3, '21999']));
  assert.deepEqual(got.map((r) => [r.o_position, r.o_description, r.o_quantity, r.o_unit_price_cents, r.o_line_total_cents]),
    LINES.map((l, i) => [i + 1, l.description, String(l.quantity), String(l.unitPriceCents), String(l.quantity * l.unitPriceCents)]));
  const listed = await page(key, T_A, S_A1);
  assert.deepEqual(listed.map((r) => [r.o_outcome, r.o_tenant_id, r.o_store_id, r.o_draft_id, r.o_customer_id, r.o_line_count, r.o_subtotal_cents, r.o_created_at]),
    [['draft', T_A, S_A1, draft, C_A, 3, '21999', got[0].o_created_at]]);
  // The largest amounts the API exposes are exact: one line at 2^53 - 1 and a sum of exactly 2^53 - 1.
  const big = await create(key, S_A1, T_A, C_A, [line('Max', MAX, 1)]);
  assert.equal(big.rows[0].o_outcome, 'applied');
  assert.deepEqual((await get(key, T_A, S_A1, big.draft)).map((r) => [r.o_subtotal_cents, r.o_quantity, r.o_line_total_cents]), [[String(MAX), String(MAX), String(MAX)]]);
  const fifty = Array.from({ length: 50 }, (_, i) => line(`L${i + 1}`, 1, i === 0 ? MAX - 49 : 1));
  const many = await create(key, S_A1, T_A, C_A, fifty);
  assert.equal(many.rows[0].o_outcome, 'applied');
  assert.deepEqual((await get(key, T_A, S_A1, many.draft)).map((r) => r.o_position), Array.from({ length: 50 }, (_, i) => i + 1), 'fifty lines in order');
});

test('IDR-04 (AC-01 AC-02 AC-04): a grant reaches its own store alone — never the tenant\'s other store, another tenant\'s, a missing or ungranted store; tenant-only, ambiguous and mismatched grants refused; the owner\'s Full stops at its store; nothing written', async () => {
  const atA1 = await actor('at-a1', [storeGrant(T_A, S_A1, 'manager')]);
  const ownerA1 = await actor('owner-a1', [storeGrant(T_A, S_A1, 'store_owner')]);
  const tenantOnly = await actor('tenant-only', [tenantGrant(T_A, 'store_owner')]);
  const ambiguous = await actor('ambiguous', [storeGrant(T_A, S_A1, 'manager'), storeGrant(T_A, S_A1, 'technician')]);
  // A grant naming tenant A at tenant B's store (storable: 002's key names the store alone) beside a consistent one.
  const mismatch = await actor('mismatch', [storeGrant(T_A, S_B1, 'manager'), storeGrant(T_A, S_A2, 'technician')]);
  const atB1 = await actor('at-b1', [storeGrant(T_B, S_B1, 'manager')]);
  const kA1 = await mint(atA1);
  const kOwner = await mint(ownerA1);
  const { draft: own } = await create(kA1, S_A1, T_A, C_A, LINES);
  const { draft: other } = await create(await mint(atB1), S_B1, T_B, C_B, LINES);
  const before = await footprint([T_A, T_B]);
  for (const [label, key, store, tenant, customer] of [
    ['the tenant\'s other store', kA1, S_A2, T_A, C_A], ['another tenant\'s store', kA1, S_B1, T_B, C_B], ['another tenant\'s store, own tenant named', kA1, S_B1, T_A, C_A],
    ['a missing store', kA1, randomUUID(), T_A, C_A], ['a store row nobody holds a grant at', kA1, S_ORPHAN, T_A, C_A],
    ['the owner at a store it holds no grant at', kOwner, S_A2, T_A, C_A], ['a tenant-only owner', await mint(tenantOnly), S_A1, T_A, C_A],
    ['two roles at one store', await mint(ambiguous), S_A1, T_A, C_A], ['a grant naming another tenant\'s store', await mint(mismatch), S_B1, T_A, C_A],
    ['the same, at the store\'s own tenant', await mint(mismatch), S_B1, T_B, C_B],
  ]) {
    assert.deepEqual((await create(key, store, tenant, customer, LINES)).rows, [REFUSED], label);
    assert.deepEqual(await page(key, tenant, store), [{ o_outcome: 'denied', ...PAGE_NULLS }], `${label}: the page`);
    assert.deepEqual(await get(key, tenant, store, own), [{ o_outcome: 'denied', ...GET_NULLS }], `${label}: the get`);
  }
  assert.deepEqual(await footprint([T_A, T_B]), before, 'every refusal wrote nothing — no draft, line or role row');
  assert.equal((await create(kOwner, S_A1, T_A, C_A, LINES)).rows[0].o_outcome, 'applied', 'the owner\'s Full at the store it holds');
  // A foreign draft through the actor's own store: one not_found, one cursor_unknown, nothing disclosed.
  assert.deepEqual(await get(kA1, T_A, S_A1, other), [{ o_outcome: 'not_found', ...GET_NULLS }], 'another tenant\'s draft');
  assert.deepEqual(await get(kA1, T_A, S_A1, randomUUID()), [{ o_outcome: 'not_found', ...GET_NULLS }], 'a missing draft: the same answer');
  assert.deepEqual(await page(kA1, T_A, S_A1, { after: other }), [{ o_outcome: 'cursor_unknown', ...PAGE_NULLS }], 'another tenant\'s anchor');
  assert.deepEqual(await page(kA1, T_A, S_A1, { after: randomUUID() }), [{ o_outcome: 'cursor_unknown', ...PAGE_NULLS }], 'an unknown anchor');
  assert.ok(!(await page(kA1, T_A, S_A1)).some((r) => r.o_draft_id === other), 'the page holds only its own store\'s drafts');
  // A store-A2 draft is invisible at A1 too: another store of the SAME tenant.
  const atA2 = await actor('at-a2', [storeGrant(T_A, S_A2, 'manager')]);
  const kA2 = await mint(atA2);
  const { draft: a2 } = await create(kA2, S_A2, T_A, C_A, LINES);
  assert.deepEqual(await get(kA1, T_A, S_A1, a2), [{ o_outcome: 'not_found', ...GET_NULLS }], 'another store\'s draft, same tenant');
  assert.deepEqual(await page(kA1, T_A, S_A1, { after: a2 }), [{ o_outcome: 'cursor_unknown', ...PAGE_NULLS }], 'another store\'s anchor');
  assert.deepEqual((await get(kA2, T_A, S_A2, a2)).length, 3, 'control: its own store reads it');
  // A browser-only custom role has no server authority: it cannot even be a membership.
  assert.equal((await errorOf(owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${atA1.id}, ${T_A}, ${S_A1}, 'store', 'shift_lead', 'active')`))?.code, '23514', 'a custom role id is refused by the membership CHECK');
});

test('IDR-05 (AC-03): the persisted Invoices View/Create thresholds and the Customers View corequisite decide the save, the page and the get, both directions, with owner-edited levels; the owner is Full throughout', async () => {
  const T = await newTenant('levels');
  const S = await newStore(T, `Levels ${SUFFIX}`);
  const C = await newCustomer(T, 'levels');
  const tech = await actor('tech', [storeGrant(T, S, 'technician')]);
  const sales = await actor('sales', [storeGrant(T, S, 'sales_staff')]);
  const manager = await actor('mgr', [storeGrant(T, S, 'manager')]);
  const storeOwner = await actor('owner', [storeGrant(T, S, 'store_owner')]);
  const kTech = await mint(tech);
  const kSales = await mint(sales);
  const kMgr = await mint(manager);
  const kOwner = await mint(storeOwner);
  // The owner (Full) saves one draft first, so a granted read always has a draft to answer: a read is then EXACTLY a page of
  // the store's draft (and EXACTLY the seed's reopen) and a refusal EXACTLY the denial — never an empty page or another
  // outcome taken for either.
  const seed = await create(kOwner, S, T, C, LINES);
  assert.deepEqual(seed.rows, [applied(storeOwner, T, S)], 'the seed');
  const can = async (who, key) => {
    const made = (await create(key, S, T, C, LINES)).rows;
    const saved = made.length === 1 && made[0].o_outcome === 'applied';
    assert.deepEqual(made, [saved ? applied(who, T, S) : REFUSED], `${who.label}: a save is exactly applied or exactly refused`);
    const rows = await page(key, T, S, { limit: 1 });
    const read = !(rows.length === 1 && rows[0].o_outcome === 'denied');
    if (read) assert.deepEqual(rows.map((r) => [r.o_outcome, r.o_tenant_id, r.o_store_id]), [['draft', T, S]], `${who.label}: a read is exactly the store's page`);
    else assert.deepEqual(rows, [{ o_outcome: 'denied', ...PAGE_NULLS }], `${who.label}: a refused read is exactly the denial`);
    // The get (the reopen) decides on the same Invoices View threshold: exactly the seed's lines, or exactly the denial —
    // and always the page's verdict, so every expectation below holds for both reads.
    const got = await get(key, T, S, seed.draft);
    const reopened = !(got.length === 1 && got[0].o_outcome === 'denied');
    if (reopened) {
      assert.deepEqual(got.map((r) => [r.o_outcome, r.o_tenant_id, r.o_store_id, r.o_draft_id, r.o_position, r.o_description]),
        LINES.map((l, i) => ['draft', T, S, seed.draft, i + 1, l.description]), `${who.label}: a reopen is exactly the seed`);
    } else {
      assert.deepEqual(got, [{ o_outcome: 'denied', ...GET_NULLS }], `${who.label}: a refused reopen is exactly the denial`);
    }
    assert.equal(reopened, read, `${who.label}: the get and the page agree`);
    return { create: saved, read };
  };
  assert.deepEqual(await can(tech, kTech), { create: false, read: true }, 'technician default: Invoices View');
  assert.deepEqual(await can(sales, kSales), { create: true, read: true }, 'sales_staff default: Invoices Create, Customers Create');
  assert.deepEqual(await can(manager, kMgr), { create: true, read: true }, 'manager default: Full');
  await setLevel(T, 'technician', 'invoices', 'create');
  assert.deepEqual(await can(tech, kTech), { create: true, read: true }, 'the owner raises technician Invoices to Create: it saves');
  await setLevel(T, 'technician', 'customers', 'none');
  assert.deepEqual(await can(tech, kTech), { create: false, read: true }, 'Customers None: the corequisite refuses the save, the read stands');
  await setLevel(T, 'sales_staff', 'invoices', 'view');
  assert.deepEqual(await can(sales, kSales), { create: false, read: true }, 'the owner lowers sales_staff Invoices to View');
  await setLevel(T, 'sales_staff', 'invoices', 'none');
  assert.deepEqual(await can(sales, kSales), { create: false, read: false }, 'and to None: no read either');
  await setLevel(T, 'sales_staff', 'invoices', 'view');
  assert.deepEqual(await can(sales, kSales), { create: false, read: true }, 'and back to View: the page and the get answer again');
  await setLevel(T, 'manager', 'invoices', 'edit');
  await setLevel(T, 'manager', 'customers', 'view');
  assert.deepEqual(await can(manager, kMgr), { create: true, read: true }, 'Edit and View: above both thresholds');
  for (const [domain, level] of [['invoices', 'none'], ['customers', 'none']]) await setLevel(T, 'manager', domain, level);
  assert.deepEqual(await can(storeOwner, kOwner), { create: true, read: true }, 'the owner is Full, never stored');
  // An edit of ANOTHER tenant's levels moves nothing here.
  await setLevel(T_A, 'technician', 'invoices', 'none');
  assert.deepEqual(await can(tech, kTech), { create: false, read: true }, 'tenant isolation of the levels');
});

test('IDR-06 (AC-05): a missing and another tenant\'s customer are one identical customer_not_found, decided before any write — no draft, line or role row; a tenant_mismatch likewise', async () => {
  const T = await newTenant('customers');
  const S = await newStore(T, `Customers ${SUFFIX}`);
  const who = await actor('cnf', [storeGrant(T, S, 'manager')]);
  const key = await mint(who);
  const before = await footprint([T, T_A, T_B]);
  const missing = await create(key, S, T, randomUUID(), LINES);
  const foreign = await create(key, S, T, C_A, LINES);
  assert.deepEqual(missing.rows, [{ o_outcome: 'customer_not_found', o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null }]);
  assert.deepEqual(foreign.rows, missing.rows, 'byte for byte the same answer');
  const mismatched = await create(key, S, T_A, await newCustomer(T, 'cnf-own'), LINES);
  assert.deepEqual(mismatched.rows, [{ ...REFUSED, o_outcome: 'tenant_mismatch' }], 'the expected tenant is not the store\'s');
  const after = await footprint([T, T_A, T_B]);
  assert.deepEqual({ ...after, records: before.records, events: before.events }, { ...before }, 'nothing written — not even the role lock rows');
  const C = await newCustomer(T, 'cnf-ok');
  assert.equal((await create(key, S, T, C, LINES)).rows[0].o_outcome, 'applied', 'control: a customer of the store\'s tenant');
});

// ===========================================================================
// IDR-07: inputs
// ===========================================================================

test('IDR-07 (AC-06): every invalid argument raises 22023 with a fixed message carrying no value, writing nothing; the tables\' own CHECKs and composite keys refuse an owner\'s out-of-contract row', async () => {
  const who = await actor('inputs', [storeGrant(T_A, S_A1, 'manager')]);
  const key = await mint(who);
  const before = await footprint([T_A]);
  const secret = `SECRET-${SUFFIX}`;
  const cases = [
    ['no lines', '[]'], ['not an array', JSON.stringify({ lines: LINES })], ['51 lines', JSON.stringify(Array.from({ length: 51 }, () => line('x', 1, 1)))],
    ['an extra key', JSON.stringify([{ ...line(secret, 1, 1), position: 1 }])], ['a missing key', JSON.stringify([{ description: secret, quantity: 1 }])],
    ['a line that is no object', JSON.stringify([secret])], ['a numeric description', JSON.stringify([{ description: 5, quantity: 1, unitPriceCents: 1 }])],
    ['an empty description', JSON.stringify([line('', 1, 1)])], ['257 characters', JSON.stringify([line('x'.repeat(257), 1, 1)])],
    ['a control', JSON.stringify([line(`${secret}\u0007`, 1, 1)])], ['a Bidi control', JSON.stringify([line(`${secret}‮`, 1, 1)])],
    ['a line separator', JSON.stringify([line(`${secret} x`, 1, 1)])], ['edge whitespace', JSON.stringify([line(` ${secret}`, 1, 1)])],
    ['quantity 0', JSON.stringify([line(secret, 0, 1)])], ['a negative quantity', JSON.stringify([line(secret, -1, 1)])],
    ['a fractional quantity', '[{"description":"x","quantity":1.5,"unitPriceCents":1}]'], ['a quantity of 1.0', '[{"description":"x","quantity":1.0,"unitPriceCents":1}]'],
    ['a string quantity', '[{"description":"x","quantity":"1","unitPriceCents":1}]'], ['a quantity above 2^53 - 1', `[{"description":"x","quantity":${MAX + 1},"unitPriceCents":0}]`],
    ['a negative price', JSON.stringify([line(secret, 1, -1)])], ['a fractional price', '[{"description":"x","quantity":1,"unitPriceCents":0.5}]'],
    ['a product above 2^53 - 1', JSON.stringify([line(secret, 2, Math.ceil(MAX / 2))])],
    ['a sum above 2^53 - 1', JSON.stringify([line(secret, 1, MAX), line(secret, 1, 1)])],
  ];
  for (const [label, text] of cases) {
    const out = await errorOf(create(key, S_A1, T_A, C_A, text, { subtotal: '1' }));
    assert.equal(out?.code, '22023', `${label}: ${JSON.stringify(out)}`);
    assert.ok(!out.message.includes(secret) && !out.message.includes(SUFFIX), `${label}: the message names the field, never the value`);
  }
  for (const [label, subtotal] of [['a subtotal not the sum', '1'], ['a negative subtotal', '-1'], ['a subtotal above 2^53 - 1', String(MAX + 1)]]) {
    assert.equal((await errorOf(create(key, S_A1, T_A, C_A, LINES, { subtotal })))?.code, '22023', label);
  }
  for (const [label, args] of [['a null key', [null, S_A1, T_A, C_A]], ['a malformed key', ['a b', S_A1, T_A, C_A]], ['a null store', [key, null, T_A, C_A]],
    ['a null tenant', [key, S_A1, null, C_A]], ['a null customer', [key, S_A1, T_A, null]]]) {
    assert.equal((await errorOf(create(args[0], args[1], args[2], args[3], LINES)))?.code, '22023', label);
  }
  assert.equal((await errorOf(runtime.begin('isolation level repeatable read', (tx) => create(key, S_A1, T_A, C_A, LINES, { db: tx }))))?.code, '55000',
    'outside READ COMMITTED the create refuses');
  assert.deepEqual(await footprint([T_A]), before, 'nothing was written by any refusal');
  // The tables refuse what the routine would never write, whoever writes it.
  const { draft } = await create(key, S_A1, T_A, C_A, LINES);
  for (const [label, statement, code] of [
    ['a total that is not quantity x price', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft_line values (${draft}, ${T_A}, ${S_A1}, 10, 'x', 2, 3, 5)`, '23514'],
    ['a line under another store', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft_line values (${draft}, ${T_A}, ${S_A2}, 10, 'x', 1, 1, 1)`, '23503'],
    ['a line under another tenant', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft_line values (${draft}, ${T_B}, ${S_A1}, 10, 'x', 1, 1, 1)`, '23503'],
    ['position 51', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft_line values (${draft}, ${T_A}, ${S_A1}, 51, 'x', 1, 1, 1)`, '23514'],
    ['a description with a control', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft_line values (${draft}, ${T_A}, ${S_A1}, 10, ${'a\u0001'}, 1, 1, 1)`, '23514'],
    ['a draft at a store of another tenant', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
      values (${randomUUID()}, ${T_A}, ${S_B1}, ${C_A}, 'draft', 'USD', 1, 1, 0, ${who.id})`, '23503'],
    ['a draft naming another tenant\'s customer', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
      values (${randomUUID()}, ${T_A}, ${S_A1}, ${C_B}, 'draft', 'USD', 1, 1, 0, ${who.id})`, '23503'],
    ['an issued draft', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
      values (${randomUUID()}, ${T_A}, ${S_A1}, ${C_A}, 'issued', 'USD', 1, 1, 0, ${who.id})`, '23514'],
    ['euros', (tx) => tx`insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
      values (${randomUUID()}, ${T_A}, ${S_A1}, ${C_A}, 'draft', 'EUR', 1, 1, 0, ${who.id})`, '23514'],
    ['a store moved to another tenant while it holds drafts', (tx) => tx`update public.store set tenant_id = ${T_B} where store_id = ${S_A1}`, '23503'],
    ['a customer deleted while a draft names it', (tx) => tx`delete from tmpos_customer.customer where customer_id = ${C_A}`, '23503'],
  ]) {
    assert.equal((await rolledBack(statement)).code, code, label);
  }
});

// ===========================================================================
// IDR-08..09: pagination and statuses
// ===========================================================================

test('IDR-08 (AC-12): equal creation times walked at every page size neither drop nor repeat, newest first then id; a later draft comes first; foreign and unknown anchors are one cursor_unknown; the bound is 1-51', async () => {
  const T = await newTenant('pages');
  const S = await newStore(T, `Pages ${SUFFIX}`);
  const S2 = await newStore(T, `Pages two ${SUFFIX}`);
  const C = await newCustomer(T, 'pages');
  const who = await actor('pages', [storeGrant(T, S, 'manager')]);
  const elsewhere = await actor('pages-2', [storeGrant(T, S2, 'manager')]);
  const key = await mint(who);
  // Seven drafts in ONE transaction: one now(), so every created_at is equal and only the id orders them.
  const tied = await runtime.begin(RC, async (tx) => {
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push((await create(key, S, T, C, [line(`Tie ${i}`, 1, i)], { db: tx })).draft);
    return ids;
  });
  const [{ distinct }] = await owner`select count(distinct created_at)::int as distinct from tmpos_invoice_draft.invoice_draft where draft_id = any(${tied}::uuid[])`;
  assert.equal(distinct, 1, 'one creation time for all seven');
  const later = (await create(key, S, T, C, [line('Later', 1, 1)])).draft;
  const expected = [later, ...[...tied].sort().reverse()];
  for (const size of [1, 2, 3, 8]) {
    const seen = [];
    let after = null;
    for (let guard = 0; guard < 20; guard++) {
      const rows = await page(key, T, S, { after, limit: size + 1 });
      assert.ok(rows.every((r) => r.o_outcome === 'draft' && r.o_tenant_id === T && r.o_store_id === S), `size ${size}: every row names the trusted scope`);
      const served = rows.slice(0, size);
      seen.push(...served.map((r) => r.o_draft_id));
      if (rows.length <= size) break;
      after = served.at(-1).o_draft_id;
    }
    assert.deepEqual(seen, expected, `page size ${size}: every draft once, newest first then id descending`);
  }
  const otherDraft = (await create(await mint(elsewhere), S2, T, C, LINES)).draft;
  assert.deepEqual(await page(key, T, S, { after: otherDraft }), [{ o_outcome: 'cursor_unknown', ...PAGE_NULLS }], 'another store\'s anchor, same tenant');
  for (const limit of [0, 52, -1]) assert.deepEqual(await page(key, T, S, { limit }), [{ o_outcome: 'invalid', ...PAGE_NULLS }], `limit ${limit}`);
  assert.equal((await page(key, T, S, { limit: 51 })).length, 8, 'limit 51 is the bound');
});

test('IDR-09 (AC-01 AC-10): a read-only account, tenant or store reads but cannot save; a suspended store refuses everything; every account, tenant and store status on a session minted after it — active and trialing save and read, overdue and read_only read an existing draft but cannot save, suspended and pending_activation are denied', async () => {
  const T = await newTenant('status');
  const T_RO = await newTenant('status-ro', 'read_only');
  const S = await newStore(T, `Status ${SUFFIX}`);
  const S_RO = await newStore(T, `Status ro ${SUFFIX}`, 'read_only');
  const S_T_RO = await newStore(T_RO, `Status t-ro ${SUFFIX}`);
  const C = await newCustomer(T, 'status');
  const C_RO = await newCustomer(T_RO, 'status-ro');
  for (const [label, who, store, tenant, customer] of [
    ['a read-only account', await actor('acct-ro', [storeGrant(T, S, 'manager')], 'read_only'), S, T, C],
    ['a read-only store', await actor('store-ro', [storeGrant(T, S_RO, 'manager')]), S_RO, T, C],
    ['a read-only tenant', await actor('tenant-ro', [storeGrant(T_RO, S_T_RO, 'manager')]), S_T_RO, T_RO, C_RO],
  ]) {
    const key = await mint(who);
    assert.deepEqual((await create(key, store, tenant, customer, LINES)).rows, [REFUSED], `${label}: no save`);
    assert.deepEqual(await page(key, tenant, store), [], `${label}: an (empty) page — a read`);
  }
  const who = await actor('suspended', [storeGrant(T, S, 'manager')]);
  const key = await mint(who);
  const { draft } = await create(key, S, T, C, LINES);
  await owner`update store set status = 'suspended' where store_id = ${S}`;
  try {
    // The standing moved (the store's access version): every call refuses; a fresh session cannot be admitted at it either.
    assert.deepEqual((await create(key, S, T, C, LINES)).rows, [REFUSED]);
    assert.deepEqual(await page(key, T, S), [{ o_outcome: 'denied', ...PAGE_NULLS }]);
    assert.deepEqual(await get(key, T, S, draft), [{ o_outcome: 'denied', ...GET_NULLS }]);
  } finally {
    await owner`update store set status = 'active' where store_id = ${S}`;
  }
  // THE MATRIX. Each case its own tenant, store, customer and manager, a draft seeded while everything is active; then ONE
  // axis set to the status and a session minted AFTER it, so the standing is current and each routine's own status branch —
  // never a stale digest — decides. Statuses: 002's vocabulary for all three.
  for (const axis of ['account', 'tenant', 'store']) {
    for (const status of ['active', 'trialing', 'overdue', 'read_only', 'suspended', 'pending_activation']) {
      const label = `${axis} ${status}`;
      const MT = await newTenant(`m-${axis}-${status}`);
      const MS = await newStore(MT, `Matrix ${axis} ${status} ${SUFFIX}`);
      const MC = await newCustomer(MT, `m-${axis}-${status}`);
      const who = await actor(`m-${axis}-${status}`, [storeGrant(MT, MS, 'manager')]);
      const seeded = await create(await mint(who), MS, MT, MC, LINES);
      assert.deepEqual(seeded.rows, [applied(who, MT, MS)], `${label}: seeded while active`);
      if (axis === 'account') await owner`update app_user set status = ${status} where internal_user_id = ${who.id}`;
      else if (axis === 'tenant') await owner`update tenant set status = ${status} where tenant_id = ${MT}`;
      else await owner`update store set status = ${status} where store_id = ${MS}`;
      const fresh = await mint(who);
      const write = status === 'active' || status === 'trialing';
      const read = write || status === 'overdue' || status === 'read_only';
      const before = await footprint([MT]);
      const made = await create(fresh, MS, MT, MC, LINES);
      assert.deepEqual(made.rows, [write ? applied(who, MT, MS) : REFUSED], `${label}: the save`);
      if (!write) assert.deepEqual(await footprint([MT]), before, `${label}: the refused save wrote nothing`);
      const listed = await page(fresh, MT, MS);
      if (read) {
        assert.deepEqual(listed.map((r) => [r.o_outcome, r.o_tenant_id, r.o_store_id]), (write ? [0, 1] : [0]).map(() => ['draft', MT, MS]), `${label}: the page`);
        assert.deepEqual(listed.map((r) => r.o_draft_id).sort(), (write ? [seeded.draft, made.draft] : [seeded.draft]).sort(), `${label}: exactly its drafts`);
      } else {
        assert.deepEqual(listed, [{ o_outcome: 'denied', ...PAGE_NULLS }], `${label}: the page is denied`);
      }
      const got = await get(fresh, MT, MS, seeded.draft);
      if (read) {
        assert.deepEqual(got.map((r) => [r.o_outcome, r.o_tenant_id, r.o_store_id, r.o_draft_id, r.o_position, r.o_description]),
          LINES.map((l, i) => ['draft', MT, MS, seeded.draft, i + 1, l.description]), `${label}: the existing draft reopens`);
      } else {
        assert.deepEqual(got, [{ o_outcome: 'denied', ...GET_NULLS }], `${label}: the get is denied`);
      }
    }
  }
});

// ===========================================================================
// IDR-13: the create's re-decision on the locked levels (its step 12)
// ===========================================================================

test('IDR-13 (AC-10 AC-03): an owner\'s narrowing committed after the create\'s unlocked decision, while the create waits on that role row, is refused by the re-decision on the locked value — nothing written; rolled back instead, the same create saves', async () => {
  const T = await newTenant('redecide');
  const S = await newStore(T, `Redecide ${SUFFIX}`);
  const C = await newCustomer(T, 'redecide');
  const tech = await actor('redecide', [storeGrant(T, S, 'technician')]);
  // Both of the role's rows exist (so the create's step 11 inserts nothing), Invoices at Create and Customers at View: the
  // unlocked decision (step 8) admits the save.
  await setLevel(T, 'technician', 'customers', 'view');
  await setLevel(T, 'technician', 'invoices', 'create');
  const key = await mint(tech);
  // The control first (rolled back: the level stays Create, so the same create saves), then the narrowing committed.
  for (const [ending, expected] of [['rollback', [applied(tech, T, S)]], ['commit', [REFUSED]]]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let holderPid = null;
    const holder = owner.begin(RC, async (tx) => {
      const [{ pid: own }] = await tx`select pg_catalog.pg_backend_pid() as pid`;
      // The owner's narrowing, uncommitted: the Invoices row updated (and held FOR UPDATE) to View.
      await tx`update tmpos_role.tenant_role_level set level = 'view', updated_at = now() where tenant_id = ${T} and role_id = 'technician' and domain = 'invoices'`;
      holderPid = own;
      if ((await gate) === 'rollback') throw ROLLBACK;
    }).then(() => 'committed', (err) => (err === ROLLBACK ? 'rolled back' : `failed ${err.code}`));
    try {
      await until(() => holderPid !== null, `${ending}: the narrowing held, uncommitted`);
      const before = await footprint([T]);
      let pid = null;
      const pending = runtime.begin(RC, async (tx) => {
        pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
        return create(key, S, T, C, LINES, { db: tx });
      });
      // THE BARRIER: the create is blocked by the narrowing's transaction. Nothing before its step 11 touches that row (its
      // step 8 reads it unlocked, on its snapshot), so it has already decided on the committed Create and waits. Under 031's
      // save (M7B-INVOICES-P1-R3) the wait is on 030's key, which the narrowing's level write took EXCLUSIVE (030's trigger):
      // the save takes it SHARED at its step 10b and then reads the level afresh; it no longer locks the Invoices row.
      await until(async () => pid !== null && (await owner`select pg_catalog.pg_blocking_pids(${pid}) as blockers`)[0].blockers.includes(holderPid),
        `${ending}: the create waiting on the narrowed row`);
      const [{ waiting, query }] = await owner`select (select count(*) from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted)::int as waiting,
          (select a.query from pg_catalog.pg_stat_activity a where a.pid = ${pid}) as query`;
      assert.equal(waiting, 1, `${ending}: one ungranted lock`);
      assert.match(query, /m7b_invoice_draft_create/, `${ending}: inside the create`);
      release(ending);
      assert.equal(await holder, ending === 'commit' ? 'committed' : 'rolled back');
      const { rows } = await pending;
      assert.deepEqual(rows, expected, `${ending}: the create's answer on the locked value`);
      const after = await footprint([T]);
      assert.deepEqual([after.drafts - before.drafts, after.lines - before.lines, after.roles - before.roles],
        ending === 'commit' ? [0, 0, 0] : [1, LINES.length, 0], `${ending}: ${ending === 'commit' ? 'nothing written' : 'the draft and its lines'}`);
    } finally {
      release('rollback');
      await holder.catch(() => {});
    }
  }
  assert.equal((await owner`select level from tmpos_role.tenant_role_level where tenant_id = ${T} and role_id = 'technician' and domain = 'invoices'`)[0].level,
    'view', 'the committed narrowing stands');
});

// ===========================================================================
// IDR-10: parity of every SQL restatement
// ===========================================================================

test('IDR-10 (AC-16 AC-06): every SQL restatement in 028 — the defaults of both domains, the owner literal, the editable set and the ordering — equals the catalog; the description CHECK is 017\'s name CHECK at 256 characters, restated exactly by the create, with no raw invisible code point in either file', async () => {
  const EDITABLE = ['manager', 'technician', 'sales_staff'];
  for (const domain of ['invoices', 'customers']) {
    assert.deepEqual(Object.fromEntries(EDITABLE.map((r) => [r, TENANT_ROLE_PERMISSION_DEFAULTS[r][domain]])), { manager: 'full', technician: 'view', sales_staff: 'create' },
      `the catalog's ${domain} defaults this parity pins`);
  }
  const restated = (source, label, expect) => {
    const cases = [...source.matchAll(/case v_role ((?:when '[a-z_]+' then '[a-z]+' )+)end/g)]
      .map((m) => Object.fromEntries([...m[1].matchAll(/when '([a-z_]+)' then '([a-z]+)'/g)].map((p) => [p[1], p[2]])));
    assert.equal(cases.length, expect.cases, `${label}: every default restatement found`);
    for (const c of cases) assert.deepEqual(c, { manager: 'full', technician: 'view', sales_staff: 'create' }, `${label}: the defaults`);
    const owners = [...source.matchAll(/v_role = '([a-z_]+)'/g)].map((m) => m[1]);
    assert.equal(owners.length, expect.owners, `${label}: every owner literal found`);
    for (const o of owners) assert.equal(o, 'store_owner', label);
    const sets = [...source.matchAll(/v_role in \(([^)]*)\)/g)].map((m) => m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort());
    assert.equal(sets.length, expect.sets, `${label}: every editable set found`);
    for (const s of sets) assert.deepEqual(s, [...EDITABLE].sort(), label);
    const orderings = [...source.matchAll(/array\[('none'[^\]]*)\]/g)].map((m) => m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
    assert.equal(orderings.length, expect.orderings, `${label}: every ordering found`);
    for (const o of orderings) assert.deepEqual(o, [...TENANT_ORDERING], label);
  };
  const installed = async (signature) => (await owner`select pg_catalog.pg_get_functiondef(${signature}::regprocedure) as source`)[0].source;
  restated(await installed(CREATE), 'the installed create', { cases: 4, owners: 1, sets: 2, orderings: 1 });
  restated(await installed(PAGE), 'the installed page', { cases: 1, owners: 1, sets: 1, orderings: 1 });
  restated(await installed(GET), 'the installed get', { cases: 1, owners: 1, sets: 1, orderings: 1 });
  restated(UP_028, 'the up file', { cases: 6, owners: 3, sets: 4, orderings: 3 });
  // 017's three plain-text regexes (R7), proven on the INSTALLED definitions rather than asserted: the line's description
  // CHECK, normalized (its column for 017's, its 256 for 017's 200), is 017's customer-name CHECK exactly, and the create's
  // step 0 restates exactly its three regexes.
  const regexesOf = (def) => [...def.matchAll(/!~ '((?:[^']|'')*)'::text/g)].map((m) => m[1]);
  const defOf = async (rel, name) => (await owner`select pg_catalog.pg_get_constraintdef(k.oid) as def from pg_catalog.pg_constraint k
    where k.conrelid = ${rel}::regclass and k.conname = ${name}`)[0].def;
  const descriptionDef = await defOf('tmpos_invoice_draft.invoice_draft_line', 'invoice_draft_line_description_chk');
  const nameDef = await defOf('tmpos_customer.customer', 'customer_name_chk');
  assert.equal(regexesOf(nameDef).length, 3, `017's three regexes found: ${nameDef}`);
  assert.deepEqual(regexesOf(descriptionDef), regexesOf(nameDef), 'the three regexes, byte for byte');
  assert.equal(descriptionDef, nameDef.replace(/\bname\b/g, 'description').replace('<= 200)', '<= 256)'), 'the whole CHECK, normalized');
  const createSource = await installed(CREATE);
  for (const regex of regexesOf(nameDef)) assert.ok(createSource.includes(`v_text !~ '${regex}'`), `the create's step 0 restates ${regex}`);
  // Neither file spells a raw control, Bidi, separator or invisible format code point: 017's \uXXXX escapes only.
  for (const [label, file] of [['up', UP_028], ['down', DOWN_028]]) {
    assert.doesNotMatch(file, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u, `028 ${label}`);
  }
});

// ===========================================================================
// IDR-11: the rollback and the upgrade (last: it deletes this suite's drafts first)
// ===========================================================================

async function surfaceOf027() {
  const constraints = async (rel) => (await owner`select c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def from pg_catalog.pg_constraint c
    where c.conrelid = ${rel}::regclass and c.contype <> 'n' order by 1`).map((r) => ({ ...r }));
  const indexes = async (rel) => (await owner`select i.relname::text as name from pg_catalog.pg_index x join pg_catalog.pg_class i on i.oid = x.indexrelid
    where x.indrelid = ${rel}::regclass order by 1`).map((r) => r.name);
  const columns = async (rel) => (await owner`select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type from pg_catalog.pg_attribute a
    where a.attrelid = ${rel}::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`).map((r) => `${r.name} ${r.type}`);
  const routines = (await owner`select p.oid::regprocedure::text as fn, pg_catalog.md5(p.prosrc) as src, p.proacl::text as acl
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname like 'tmpos\\_%' order by 1`).map((r) => ({ ...r }));
  const schemas = (await owner`select n.nspname::text as name, n.nspacl::text as acl from pg_catalog.pg_namespace n where n.nspname like 'tmpos\\_%' order by 1`).map((r) => ({ ...r }));
  return {
    store: { constraints: await constraints('public.store'), indexes: await indexes('public.store'), columns: await columns('public.store') },
    customer: { constraints: await constraints('tmpos_customer.customer'), indexes: await indexes('tmpos_customer.customer') },
    audit: { columns: await columns('public.audit_event'), indexes: await indexes('public.audit_event') },
    routines, schemas,
  };
}
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

test('IDR-11 (AC-16): 028\'s down refuses while a draft, a line or a draft-naming audit record exists (and when not applied), 027\'s while 028 is applied; with nothing retained it restores 027 exactly; the 027 database upgrades to 028 with every row unchanged', async () => {
  // Refusals first, each inside a transaction rolled back after it: a draft exists (this suite made several).
  const withDrafts = await rolledBack((tx) => tx.unsafe(DOWN_028).simple());
  assert.equal(withDrafts.code, '55000');
  assert.match(withDrafts.message, /an invoice draft exists/);
  const below027 = await rolledBack((tx) => tx.unsafe(DOWN_027).simple());
  assert.equal(below027.code, '55000');
  assert.match(below027.message, /an invoice draft object of migration 028 exists/, '027 cannot be rolled back beneath 028');
  // Every draft of this suite gone: the drafts no longer block, but an audit record naming one still does.
  await cleanDrafts();
  const anchors = await newTenant('anchors');
  // An Invoices lock anchor 028's create would leave (NULL, no version row), and two rows that are an owner's choice.
  await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${anchors}, 'technician', 'invoices', null, now())`;
  await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${anchors}, 'manager', 'customers', null, now())`;
  const subject = await rolledBack(async (tx) => {
    await tx`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
        reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_invoice_draft_id)
      values (${randomUUID()}, null, 'store', ${T_A}, ${S_A1}, 'store.invoice_draft.create', 'create_invoice_drafts', 'allow', 'command_committed',
        'IDR synthetic record.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1', 'durable_compliance_event', ${randomUUID()})`;
    await tx.unsafe(DOWN_028).simple();
  });
  assert.equal(subject.code, '55000', JSON.stringify(subject));
  assert.match(subject.message, /an audit record names an invoice draft/);
  const twice = await rolledBack(async (tx) => { await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(DOWN_028).simple(); await tx.unsafe(DOWN_028).simple(); });
  assert.equal(twice.code, '55000');
  assert.match(twice.message, /migration 028 is not applied/);
  // The executor's own path: 028's down and its ledger row.
  const withAll = await surfaceOf027();
  assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'control: the 001-031 runtime is accepted');
  const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '027');
  let restored = false;
  try {
    assert.deepEqual(undone, ['031', '030', '029', '028'], 'only 028 (and 029, 030 and 031 above it, M7B-INVOICES-P2, -P2-R1 and -P1-R3) sits above 027');
    const at027 = await surfaceOf027();
    assert.ok(!at027.store.constraints.some((c) => c.name === 'store_tenant_store_key'), 'the store UNIQUE gone');
    assert.ok(!at027.customer.constraints.some((c) => c.name === 'customer_tenant_customer_key'), 'the customer UNIQUE gone');
    assert.deepEqual(at027.customer.indexes, ['customer_pkey', 'customer_tenant_page_idx'], '017\'s two indexes again');
    assert.ok(!at027.audit.columns.some((c) => c.startsWith('subject_invoice_draft_id')) && !at027.audit.indexes.includes('idx_audit_event_subject_invoice_draft_occurred'));
    assert.ok(!at027.schemas.some((s) => s.name === 'tmpos_invoice_draft' || s.name === 'tmpos_invoice_edit')
      && !at027.routines.some((r) => r.fn.startsWith('tmpos_invoice_draft.') || r.fn.startsWith('tmpos_invoice_edit.')));
    // Everything else — every other constraint, index and column of the three tables, every other routine's source and ACL,
    // every schema — byte for byte as before.
    // 028's objects, and the two schemas above it (029's routines live in 028's; 030's, with the guard function, in tmpos_invoice_edit).
    const OURS = new Set(['store_tenant_store_key', 'customer_tenant_customer_key', 'idx_audit_event_subject_invoice_draft_occurred', 'subject_invoice_draft_id uuid', 'tmpos_invoice_draft', 'tmpos_invoice_edit']);
    const keep = (list) => list.filter((x) => !OURS.has(typeof x === 'string' ? x : x.name)
      && !(typeof x === 'object' && 'fn' in x && (x.fn.startsWith('tmpos_invoice_draft.') || x.fn.startsWith('tmpos_invoice_edit.'))));
    const strip = (v) => ({
      store: { constraints: keep(v.store.constraints), indexes: keep(v.store.indexes), columns: keep(v.store.columns) },
      customer: { constraints: keep(v.customer.constraints), indexes: keep(v.customer.indexes) },
      audit: { columns: keep(v.audit.columns), indexes: keep(v.audit.indexes) },
      routines: keep(v.routines), schemas: keep(v.schemas),
    });
    assert.deepEqual(strip(at027), at027, 'nothing of 028 is left');
    assert.deepEqual(at027, strip(withAll), 'and nothing else changed');
    assert.deepEqual((await owner`select role_id, domain, level from tmpos_role.tenant_role_level where tenant_id = ${anchors} order by 1, 2`).map((r) => ({ ...r })),
      [{ role_id: 'manager', domain: 'customers', level: null }], 'the Invoices lock anchor removed; a Customers anchor (020\'s kind) kept');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: ['role_privilege_missing'], migrationLedger: ['migration_missing'] },
      'the 001-031 runtime refuses the 027 database: its grants and its ledger');
    // THE UPGRADE: a 027 database holding customers and role configuration, upgraded by the trusted executor.
    await setLevel(anchors, 'sales_staff', 'customers', 'view');
    const customer = await newCustomer(anchors, 'upgrade');
    const rowsBefore = (await owner`select customer_id, tenant_id, name, row_version::text as v, created_at::text as c from tmpos_customer.customer
      where tenant_id = any(${TENANTS}::uuid[]) order by 1`).map((r) => ({ ...r }));
    const levelsBefore = (await owner`select tenant_id, role_id, domain, level, updated_at::text as u from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]) order by 1, 2, 3`).map((r) => ({ ...r }));
    const upgrade = await trustedApply();
    assert.deepEqual([upgrade.outcome, upgrade.applied], ['complete', ['028', '029', '030', '031']], JSON.stringify(upgrade).slice(0, 300));
    restored = true;
    assert.deepEqual((await owner`select customer_id, tenant_id, name, row_version::text as v, created_at::text as c from tmpos_customer.customer
      where tenant_id = any(${TENANTS}::uuid[]) order by 1`).map((r) => ({ ...r })), rowsBefore, 'every customer row unchanged');
    assert.deepEqual((await owner`select tenant_id, role_id, domain, level, updated_at::text as u from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]) order by 1, 2, 3`).map((r) => ({ ...r })),
      levelsBefore, 'every role level unchanged');
    const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
    assert.deepEqual(ledger.map((r) => [r.version, r.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the ledger is 001-031 again');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'accepted again');
    assert.equal((await rolledBack(async (tx) => { await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); await tx.unsafe(POSTCONDITION_028).simple(); })).code, undefined,
      'the upgraded state satisfies the postcondition (031, 030 and 029 rolled back above it)');
    // The upgraded database saves at once, over the customer that existed before it.
    const S = await newStore(anchors, `Upgrade ${SUFFIX}`);
    const who = await actor('upgrade', [storeGrant(anchors, S, 'sales_staff')]);
    assert.equal((await create(await mint(who), S, anchors, customer, LINES)).rows[0].o_outcome, 'applied');
  } finally {
    if (!restored) await restore();
  }
});

// ===========================================================================
// IDR-12: the lock order (R7)
// ===========================================================================

/**
 * The seven tables 028's rollback locks, in the order the runtime's writers take them (R7; the down file's step 2): 016's hold
 * reads stores; a create holds the role rows (Customers then Invoices) and an owner's edit writes their version row; then the
 * customer, the draft and its lines; the audit record last.
 */
const WRITERS_ORDER = ['public.store', 'tmpos_role.tenant_role_level', 'tmpos_role_edit.role_level_version', 'tmpos_customer.customer',
  'tmpos_invoice_draft.invoice_draft', 'tmpos_invoice_draft.invoice_draft_line', 'public.audit_event'];
/** The five of them that exist before 028's up runs, in the same order: what the up locks (R7; the up file's step 2). */
const UP_ORDER = ['public.store', 'tmpos_role.tenant_role_level', 'tmpos_role_edit.role_level_version', 'tmpos_customer.customer', 'public.audit_event'];
/** The relation locks `pid` holds or waits for among WRITERS_ORDER (UP_ORDER is a subset), schema-qualified (no search_path involved). */
const locksOf = async (pid) => (await owner`select n.nspname || '.' || c.relname as rel, l.mode, l.granted
    from pg_catalog.pg_locks l join pg_catalog.pg_class c on c.oid = l.relation join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where l.pid = ${pid} and l.locktype = 'relation'`).map((r) => ({ ...r })).filter((l) => WRITERS_ORDER.includes(l.rel));
/** Polls `probe` until it answers truthy, or fails after 10 s: a lever that never engaged is a failure, never a pass. */
async function until(probe, what) {
  for (const end = Date.now() + 10_000; Date.now() < end;) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`lever did not engage: ${what}`);
}

test('IDR-12 (AC-16 R7): 028\'s down and up each take their ACCESS EXCLUSIVE locks in the creators\' order — store, role levels, level versions, customer, (the draft, its lines,) audit — as their first statements, before any check or change, proven live for both; a missing table or schema is the file\'s 55000 refusal, and on a database without 028 the down is refused so, keeping no lock', async () => {
  // LIVE: each table in turn is held (ACCESS SHARE) by another transaction; the file, started under READ COMMITTED, then
  // waits on exactly that table while holding ACCESS EXCLUSIVE on exactly the tables before it and nothing after — and has
  // not reached the check that would refuse it. For the down that is its guard (the drafts this suite left refuse it); for
  // the up, run over the APPLIED 028, its preconditions ("already exists"): had any precondition run before its locks, it
  // would have refused at once instead of waiting. Released, each proceeds to that check. `expect` judges the outcome and
  // the relation locks among the seven the file's connection still held when its refusal reached the client.
  const lockedLive = async (label, file, order, expect) => {
    for (const [i, held] of order.entries()) {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let holding = false;
      const holder = owner.begin(async (tx) => { await tx.unsafe(`lock table ${held} in access share mode`); holding = true; await gate; });
      let pid = null;
      let settled = false;
      let kept = null;
      try {
        await until(() => holding, `${label}: ${held} held`);
        const done = owner.begin(RC, async (tx) => {
          pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
          try {
            await tx.unsafe(file).simple();
          } catch (err) {
            kept = await locksOf(pid);
            throw err;
          }
          throw ROLLBACK;
        }).then(() => 'committed', (err) => (err === ROLLBACK ? 'rolled back' : `refused ${err.code}: ${err.message}`)).finally(() => { settled = true; });
        await until(async () => pid !== null && (await locksOf(pid)).some((l) => !l.granted), `${label} waiting on ${held}`);
        const locks = await locksOf(pid);
        assert.deepEqual(locks.filter((l) => l.granted && l.mode === 'AccessExclusiveLock').map((l) => l.rel).sort(), order.slice(0, i).sort(),
          `${label}, waiting on ${held}: exactly the tables before it are held`);
        assert.deepEqual(locks.filter((l) => !l.granted).map((l) => [l.rel, l.mode]), [[held, 'AccessExclusiveLock']], `${label}: it waits on ${held} alone`);
        assert.deepEqual(locks.filter((l) => order.indexOf(l.rel) > i), [], `${label}: nothing after ${held} is locked yet`);
        assert.equal(settled, false, `${label}: the check has not run — it is still waiting`);
        release();
        await holder;
        const outcome = await done;
        assert.ok(expect(outcome, kept), `${label}, ${held}: then it proceeds to its check (${outcome}; kept ${JSON.stringify(kept)})`);
      } finally {
        release();
        await holder.catch(() => {});
      }
    }
  };
  await lockedLive('the down', DOWN_028, WRITERS_ORDER, (o) => o === 'rolled back' || o.startsWith('refused 55000'));
  await lockedLive('the up', UP_028, UP_ORDER, (o) => /^refused 55000: migration 028 refused: .*already exists/.test(o));
  assert.ok((await owner`select pg_catalog.to_regnamespace('tmpos_invoice_draft') is not null as present`)[0].present, '028 still applied');

  // A MISSING TABLE OR SCHEMA meets the lock block's handler: the file's own refusal (55000), never the raw undefined_table
  // (42P01) or invalid_schema_name (3F000) the LOCK raised. The up with one of its five tables renamed away, then with the
  // schema of one renamed away; the down with a draft table renamed away (a missing draft schema is the database without
  // 028, below). Each in a transaction rolled back after it.
  const UP_MISSING = /^migration 028 refused: public\.store, tmpos_role\.tenant_role_level, tmpos_role_edit\.role_level_version, tmpos_customer\.customer or public\.audit_event is missing \(migrations 002, 017, 020 and 021 must be applied first\)$/;
  const NOT_APPLIED = /^migration 028 rollback refused: migration 028 is not applied \(/;
  for (const [label, file, hide, refusal] of [
    ['the up, public.audit_event missing (42P01)', UP_028, 'alter table public.audit_event rename to audit_event_idr', UP_MISSING],
    ['the up, schema tmpos_role_edit missing (3F000)', UP_028, 'alter schema tmpos_role_edit rename to tmpos_role_edit_idr', UP_MISSING],
    ['the down, invoice_draft_line missing (42P01)', DOWN_028, 'alter table tmpos_invoice_draft.invoice_draft_line rename to invoice_draft_line_idr', NOT_APPLIED],
  ]) {
    const out = await rolledBack(async (tx) => { await tx.unsafe(hide); await tx.unsafe(file).simple(); });
    assert.equal(out.code, '55000', `${label}: the file's refusal, never the raw error (${JSON.stringify(out)})`);
    assert.match(out.message, refusal, label);
  }

  // THE DATABASE WITHOUT 028: this suite's drafts and anchors cleared, 028 rolled back through its own down and ledger row
  // (the executor's path, as IDR-11), and its down run again there while another transaction holds each table it reaches
  // in turn — the four of the seven that exist before the missing draft schema. It waits on exactly that table holding
  // exactly the ones before it: no catalog check refused it first. Released, it takes the rest of the four, the draft
  // table's missing schema (3F000) meets the handler, and the refusal is 55000 "not applied" — never 42P01 or 3F000 — with
  // none of the locks it took still held when the refusal arrives (the block's subtransaction released them).
  await cleanDrafts();
  const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '027');
  try {
    assert.deepEqual(undone, ['031', '030', '029', '028'], 'only 028 (and 029, 030 and 031 above it) sits above 027');
    assert.ok((await owner`select pg_catalog.to_regnamespace('tmpos_invoice_draft') is null as absent`)[0].absent, 'a database without 028');
    await lockedLive('the down without 028', DOWN_028, WRITERS_ORDER.slice(0, 4),
      (o, kept) => /^refused 55000: migration 028 rollback refused: migration 028 is not applied \(/.test(o) && Array.isArray(kept) && kept.length === 0);
  } finally {
    await restore();
  }
  const [after] = await owner`select pg_catalog.to_regnamespace('tmpos_invoice_draft') is not null as present,
    (select checksum from public.schema_migrations where version = '028') as checksum`;
  assert.deepEqual({ ...after }, { present: true, checksum: REQUIRED_MIGRATIONS.find((m) => m.version === '028').checksum }, '028 applied again, its ledger row restored');

  // STATIC, for both files: the lock block is the first statement after the transaction settings — no block, read or check
  // before it — and holds nothing but its locks, in the creators' order, and the handler that turns a missing table or
  // schema into the file's refusal; no other LOCK statement exists; every check and the first change come after it.
  const statements = (file) => file.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
  const opensWith = (label, file, settings, order, raise) => {
    const want = [...settings, 'do $$', 'begin', ...order.map((rel) => `  lock table ${rel} in access exclusive mode;`), 'exception',
      '  when undefined_table or invalid_schema_name then', raise, "      using errcode = 'object_not_in_prerequisite_state';", 'end', '$$;'];
    const got = statements(file).slice(0, want.length);
    want.forEach((line, i) => (line instanceof RegExp ? assert.match(got[i], line, `${label}, statement line ${i}`) : assert.equal(got[i], line, `${label}, statement line ${i}`)));
  };
  opensWith('the down', DOWN_028, ['set local search_path = pg_catalog, pg_temp;', 'set local row_security = off;'], WRITERS_ORDER,
    /^ {4}raise exception 'migration 028 rollback refused: migration 028 is not applied \([^']*\)'$/);
  opensWith('the up', UP_028, ['set local search_path = pg_catalog, pg_temp;'], UP_ORDER,
    /^ {4}raise exception 'migration 028 refused: [^']* is missing \(migrations 002, 017, 020 and 021 must be applied first\)'$/);
  const locked = (file) => [...file.matchAll(/^ *lock table ([a-z_.]+) in access exclusive mode;$/gm)].map((m) => ({ rel: m[1], at: m.index }));
  const blockEnd = (file, locks) => file.indexOf('\n$$;\n', locks.at(-1).at);
  const firstChange = (file) => Math.min(...[...file.matchAll(/^(?:alter|create|drop|insert|update|delete|grant|revoke|comment)\b/gm)].map((m) => m.index));
  const down = locked(DOWN_028);
  assert.deepEqual(down.map((l) => l.rel), WRITERS_ORDER, 'the down locks the seven, in the creators\' order, and nothing else');
  const downEnd = blockEnd(DOWN_028, down);
  assert.ok(downEnd > 0 && downEnd < firstChange(DOWN_028) && downEnd < DOWN_028.indexOf('an invoice draft exists'), 'the down: its lock block before its guard and its first change');
  for (const check of ['to_regnamespace(', 'to_regclass(', 'to_regprocedure(', 'pg_attribute', 'pg_constraint', 'transaction_isolation']) {
    assert.ok(DOWN_028.indexOf(check) > downEnd, `the down's ${check} check comes after its locks`);
  }
  const up = locked(UP_028);
  assert.deepEqual(up.map((l) => l.rel), UP_ORDER, 'the up locks the five that exist before it, in the creators\' order, and nothing else');
  assert.deepEqual(UP_ORDER, WRITERS_ORDER.filter((rel) => !rel.startsWith('tmpos_invoice_draft.')), 'the rollback\'s seven less the two draft tables');
  const upEnd = blockEnd(UP_028, up);
  assert.ok(upEnd > 0 && upEnd < firstChange(UP_028), 'the up: its lock block before its first change');
  for (const check of ['to_regclass(', 'to_regnamespace(', 'to_regprocedure(', 'pg_attribute', 'has_function_privilege(', 'has_table_privilege(', 'pg_has_role(', 'already exists']) {
    assert.ok(UP_028.indexOf(check) > upEnd, `the up's ${check} check comes after its locks`);
  }
});
