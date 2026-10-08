// Phase 4.0 M7B-INVOICES-P2 — editing a saved store invoice draft against REAL PostgreSQL: migration 029 (the version CHECK
// widened under its own name, the immutability trigger and its function, the session-bound edit routine
// tmpos_invoice_draft.m7b_invoice_draft_update) exercised as the runtime's own non-owner login, every call bound as the
// production adapter binds it (the lines serialized once as jsonb text, every bigint as decimal text).
//
// WHAT IS PROVEN (each title carries the stage brief's acceptance criteria it evidences).
//   IDE-01 (AC-18) 001-029 applied clean by the trusted executor, every ledger checksum the pinned one; 029's postcondition
//          re-proven over the applied state and refusing every widening it names; a second apply refused.
//   IDE-02 (AC-18 AC-05) the exact surface: the edit routine VOLATILE SECURITY DEFINER pinned, EXECUTE held by its owner and
//          tmpos_app alone (non-grantable); the trigger function SECURITY INVOKER, EXECUTE held by its owner alone; one ENABLE
//          ALWAYS BEFORE UPDATE row trigger; the widened CHECK; no table or column grant beyond the owner's; the login's direct
//          SELECT, INSERT, UPDATE and DELETE on both tables refused (42501).
//   IDE-03 (AC-05) a real edit replaces the customer and the ordered lines (add, remove, reorder, edit), the line count and
//          the subtotal and steps the version by one, atomically, while draft_id, tenant, store, status, currency, created_at
//          and created_by stay; the routine writes no audit, outbox or idempotency row; a manager's change makes its Invoices
//          lock anchor (NULL) exist and no Customers row; the store owner's makes none; another draft of the same store and
//          one of another store stay byte for byte (rows, xmin, ctid).
//   IDE-04 (AC-05 D8) the trigger refuses an owner's UPDATE of each immutable column and any version move other than +0/+1,
//          also under session_replication_role = replica; the CHECKs refuse status and currency.
//   IDE-05 (AC-06) a current-version no-op answers 'unchanged' with the current version and writes nothing: the header's
//          bytes, xmin and ctid and every line's identical; equal totals with other lines, and a reorder, are changes.
//   IDE-06 (AC-07) a stale version conflicts with other contents AND with contents equal to the stored ones, writing nothing.
//   IDE-07 (DA-36 AC-10) every sealed or rolled-back answer — conflict, invalid_state, unchanged, not_found (missing,
//          other-store, other-tenant draft; missing and other-tenant customer), refused, tenant_mismatch — is reached with
//          NOTHING written, not even a role anchor, for a role that had no stored row before the call.
//   IDE-08 (AC-15) every bound at the runtime's own constants (server/runtime/invoiceDrafts.ts:111-114; commandTransaction.ts
//          :124): description, quantity, price, line total, sum, subtotal, line count and expected version refused with
//          22023 and a fixed message carrying no value, writing nothing; each limit itself admitted; the version's top end
//          (2^53 - 2 -> 2^53 - 1) and the CHECK beyond it; outside READ COMMITTED, 55000.
//   IDE-09 (AC-09 D7) the REAL get, blocked between its header and its lines statements by a holder of ACCESS EXCLUSIVE on
//          the line table (condition: the getter's UNGRANTED AccessShareLock on exactly that relation beside the holder's
//          granted AccessExclusiveLock), returns the complete EARLIER draft after the holder commits a replacement through the
//          real edit routine; a test-only VOLATILE copy of the same body under the same interleave returns a MIXED draft.
//   IDE-10 (AC-08 AC-07) two distinct actors edit one version: the second waits on the header lock — an ungranted
//          transactionid ShareLock behind the first's transaction, holding the tuple lock on the header table — then
//          conflicts (also with the first's very contents: a stale no-op), never not_found; the first rolled back, it applies.
//   IDE-11 (AC-14 AC-03) an owner's narrowing of the Invoices level to Create committed while the edit waits on the role row
//          (after taking the header) refuses it with nothing written; rolled back, the edit applies; edit first, the
//          narrowing waits for its COMMIT and governs only later edits; a narrowing committed while a stale edit or a current
//          no-op waits on the header still gets the sealed conflict / unchanged, nothing written (only the change path
//          re-decides on the locked role row).
//   IDE-12 (AC-14) a grant suspended and a store made read-only, each before (the edit waits in 016's hold, then is refused,
//          nothing written) and after (the change waits for the edit's COMMIT).
//   IDE-13 (AC-15 AC-18) the parity of every SQL restatement (defaults, owner literal, editable set, ordering, Edit
//          threshold, 017's description regexes), no raw invisible code point, and both files' lock blocks first, in the
//          writers' order, before every check and change.
//   IDE-15 (DA-36) the one write a refusal can follow: step 10's NULL anchor, for a role with no row, refused because the
//          session expired while the anchor's lock waited — present only inside the refusing transaction; rolled back,
//          nothing remains. (It runs before IDE-13 and IDE-14.)
//   IDE-14 (AC-18) the rollback and the upgrade, over an edited draft of its own: 029's down refused while not applied and
//          while a draft is at version > 1
//          (everything unchanged), and — locks first — refused when an edit it waited for commits; retained edit audit and
//          outbox rows do not block it; with no edited draft it restores 028's contract exactly (CHECK, no trigger or function,
//          three routines, 028's comments, 028's own postcondition) and the 001-029 runtime refuses that database; the 028
//          database holding drafts and role configuration upgrades to 029 with every row unchanged and edits at once.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys. Every fixture is synthetic and randomly suffixed; every id and key is made at run time. It rolls 029
// back and restores it (IDE-14), so on a shared service it runs after every step that rolls 028 back. It leaves 029 applied,
// the ledger 001-029, the issuer key row it found, and NO draft, line, audit subject, role row, session, mint-ledger row,
// throwaway schema or login of its own.
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
import {
  INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS, INVOICE_DRAFT_MAX_AMOUNT, INVOICE_DRAFT_MAX_LINES,
} from '../../server/runtime/invoiceDrafts.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.up.sql`, 'utf8');
const UP_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.up.sql`, 'utf8');
const DOWN_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.down.sql`, 'utf8');
/** Each up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_028 = UP_028.slice(UP_028.lastIndexOf('do $$'));
const POSTCONDITION_029 = UP_029.slice(UP_029.lastIndexOf('do $$'));
const CREATE = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
const PAGE = 'tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)';
const GET = 'tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)';
const UPDATE = 'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)';
const IMMUTABLE = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()';
const MIGRATOR = { purpose: 'migration', migratorRef: 'ide-migrator', runtimeRef: 'ide-runtime' };
const LOCK_KEY = 529_529;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ide_probe';
const SCRATCH_SCHEMA = `ide_volatile_${SUFFIX}`;
const HOUR = 3_600_000;
/** The runtime's amount bound (invoiceDrafts.ts:114) and its expected-version bound (commandTransaction.ts:124). */
const MAX = INVOICE_DRAFT_MAX_AMOUNT;
const MAX_EXPECTED = Number.MAX_SAFE_INTEGER - 1;
const ROLLBACK = new Error('ide: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const NULLS = Object.freeze({ o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: null });
const answer = (outcome) => ({ o_outcome: outcome, ...NULLS });
const REFUSED = answer('refused');
/**
 * The seven tables 028's rollback locks, in the order the runtime's writers take them (R7): 029's up and down lock the same,
 * first.
 */
const WRITERS_ORDER = ['public.store', 'tmpos_role.tenant_role_level', 'tmpos_role_edit.role_level_version', 'tmpos_customer.customer',
  'tmpos_invoice_draft.invoice_draft', 'tmpos_invoice_draft.invoice_draft_line', 'public.audit_event'];

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (027's and 028's suites')
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
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('IDE');
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

/** Everything this suite wrote that a later rollback of 029, 028 or 026 would refuse over: drafts, lines, anchors, subjects. */
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
    await step(() => owner.unsafe(`drop schema if exists ${SCRATCH_SCHEMA} cascade`));
    await step(cleanDrafts);
    // A failed IDE-14 may have left 029 rolled back: the executor applies it again.
    await step(async () => {
      if (!(await owner`select exists (select 1 from public.schema_migrations where version = '029') as applied`)[0].applied) {
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
          pg_catalog.to_regprocedure(${UPDATE}) is not null as routine_029,
          exists (select 1 from public.schema_migrations where version = '029') as ledger_029,
          pg_catalog.to_regnamespace(${SCRATCH_SCHEMA}) is null as no_scratch,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, { routine_029: true, ledger_029: true, no_scratch: true, drafts: 0, subjects: 0, anchors: 0, sessions: 0, login: false },
        'left as found: 029 applied and recorded, nothing of this suite\'s retained');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IDE teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: every migration in the directory (001-029), a real non-owner runtime login, the issuer key installed by the owner
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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ide-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IDE ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `ide-${label}-${SUFFIX}`;
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
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
/** The tenant owner's stored level for `role` on `domain` (020's table, as the role-level suites write it). */
const setLevel = (tenant, role, domain, level) => owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;

// ---------------------------------------------------------------------------
// the runtime login's calls, bound as postgresInvoiceDrafts.ts binds them
// ---------------------------------------------------------------------------

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:ide', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
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
/** 028's create, as its mutator binds it. */
async function create(key, store, tenant, customer, lines, { db = runtime } = {}) {
  const draft = randomUUID();
  const [row] = await db`select o_outcome from tmpos_invoice_draft.m7b_invoice_draft_create(${key}::text, ${store}::uuid, ${draft}::uuid,
    ${tenant}::uuid, ${customer}::uuid, ${JSON.stringify(lines)}::text::jsonb, ${String(sumOf(lines))}::bigint)`;
  assert.equal(row.o_outcome, 'applied', 'the draft saved');
  return draft;
}
/** 029's edit, bound as the update mutator binds it; `lines` a JS array (serialized once) or raw jsonb text. */
async function edit(key, store, tenant, draft, version, customer, lines, { subtotal, db = runtime } = {}) {
  const text = typeof lines === 'string' ? lines : JSON.stringify(lines);
  const total = subtotal ?? String(sumOf(lines));
  return (await db`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version
    from tmpos_invoice_draft.m7b_invoice_draft_update(${key}::text, ${store}::uuid, ${draft}::uuid, ${tenant}::uuid, ${String(version)}::bigint,
      ${customer}::uuid, ${text}::text::jsonb, ${String(total)}::bigint)`).map((r) => ({ ...r }));
}
const get = async (key, tenant, store, draft, db = runtime, fn = 'tmpos_invoice_draft.m7b_invoice_draft_get') => (await db.unsafe(
  `select o_outcome, o_draft_id, o_customer_id, o_version, o_line_count, o_subtotal_cents, o_position, o_description, o_quantity, o_unit_price_cents
     from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid)`, [key, tenant, store, draft])).map((r) => ({ ...r }));
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
const done = (outcome, who, tenant, store, version) => ({ o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id,
  o_membership_id: who.memberships[0], o_version: String(version) });

/** What a scope holds now: drafts, lines and role rows of its tenant(s); every audit record (and those naming a draft), every outbox event and every idempotency record. */
async function footprint(tenants, db = owner) {
  const [r] = await db`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as drafts,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as lines,
    (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${tenants}::uuid[]))::int as roles,
    (select count(*) from tmpos_role_edit.role_level_version where tenant_id = any(${tenants}::uuid[]))::int as versions,
    (select count(*) from public.audit_event where subject_invoice_draft_id is not null)::int as subjects,
    (select count(*) from public.audit_event)::int as audits,
    (select count(*) from tmpos_internal.outbox_event)::int as events,
    (select count(*) from tmpos_internal.idempotency_record)::int as records`;
  return { ...r };
}
/** A draft's exact stored state: the header's and each line's row, xmin and ctid (a write would move xmin and ctid). */
async function stateOf(draft, db = owner) {
  const header = (await db`select pg_catalog.to_jsonb(d) as row, d.xmin::text as xmin, d.ctid::text as ctid
    from tmpos_invoice_draft.invoice_draft d where d.draft_id = ${draft}`).map((r) => ({ ...r }));
  const lines = (await db`select pg_catalog.to_jsonb(l) as row, l.xmin::text as xmin, l.ctid::text as ctid
    from tmpos_invoice_draft.invoice_draft_line l where l.draft_id = ${draft} order by l.position`).map((r) => ({ ...r }));
  return { header, lines };
}
/** The header's business columns and its ordered lines, as stored. */
async function contentOf(draft, db = owner) {
  const [h] = await db`select draft_id, tenant_id, store_id, customer_id, status, currency, version::text as version, line_count,
      subtotal_cents::text as subtotal, created_at::text as created_at, created_by
    from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`;
  const lines = (await db`select position, description, quantity::text as q, unit_price_cents::text as p, line_total_cents::text as t
    from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft} order by position`).map((r) => ({ ...r }));
  return { header: h === undefined ? null : { ...h }, lines };
}
const linesAs = (lines) => lines.map((l, i) => ({ position: i + 1, description: l.description, q: String(l.quantity), p: String(l.unitPriceCents),
  t: String(BigInt(l.quantity) * BigInt(l.unitPriceCents)) }));
/** Runs `fn` in an owner transaction that is always rolled back: { value } or the { code, message } it raised. */
async function rolledBack(fn) {
  let out;
  await assert.rejects(owner.begin(RC, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}
/** Polls `probe` until it answers truthy, or fails after `ms` (10 s): a lever that never engaged is a failure, never a pass. */
async function until(probe, what, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`lever did not engage: ${what}`);
}
/**
 * A transaction on `db` that runs `fn` and then holds everything it took, uncommitted, until `release('commit')` or
 * `release('rollback')`; released to commit, it first runs `then(tx, value)` (if given) in the same transaction. `pid` is
 * its backend; `ready` turns true once `fn` has answered (so a blocked `fn` is never ready).
 */
function holding(db, fn, then = null) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = { pid: null, ready: false, release: (how) => release(how) };
  h.done = db.begin(RC, async (tx) => {
    h.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    const value = await fn(tx);
    h.ready = true;
    if ((await gate) === 'rollback') throw ROLLBACK;
    return then === null ? value : then(tx, value);
  }).then((value) => ({ outcome: 'committed', value }),
    (err) => (err === ROLLBACK ? { outcome: 'rolled back' } : { outcome: 'failed', code: err.code, message: String(err.message) }));
  return h;
}
/** A statement on `db` in its own transaction, its backend pid exposed as soon as it is known. */
function running(db, fn) {
  const r = { pid: null };
  r.done = db.begin(RC, async (tx) => {
    r.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    return fn(tx);
  }).then((value) => ({ outcome: 'committed', value }), (err) => ({ outcome: 'failed', code: err.code, message: String(err.message) }));
  return r;
}
const blockedBy = async (pid, holder) => pid !== null && holder !== null
  && (await owner`select pg_catalog.pg_blocking_pids(${pid}) as b`)[0].b.includes(holder);
const waitingIn = async (pid) => (await owner`select (select count(*) from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted)::int as waiting,
  (select a.query from pg_catalog.pg_stat_activity a where a.pid = ${pid}) as query`)[0];
/** Every lock `pid` holds or waits for, and the transaction ids `holder` holds (its own and its subtransactions'). */
async function lockWaitOf(pid, holder) {
  const holderXids = (await owner`select l.transactionid::text as xid from pg_catalog.pg_locks l
    where l.pid = ${holder} and l.locktype = 'transactionid' and l.mode = 'ExclusiveLock' and l.granted`).map((r) => r.xid);
  const locks = (await owner`select l.locktype::text as locktype, l.mode::text as mode, l.granted, l.transactionid::text as xid,
      l.relation::regclass::text as rel
    from pg_catalog.pg_locks l where l.pid = ${pid}`).map((r) => ({ ...r }));
  return { holderXids, locks, ungranted: locks.filter((l) => !l.granted), tuples: locks.filter((l) => l.locktype === 'tuple') };
}
/** The database clock, in epoch milliseconds (the routine's own reading). */
const dbNow = async () => BigInt((await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint::text as now`)[0].now);

// The scene: tenant A with two stores, tenant B with one; customers in each.
const T_A = await newTenant('a');
const T_B = await newTenant('b');
const S_A1 = await newStore(T_A, `A1 ${SUFFIX}`);
const S_A2 = await newStore(T_A, `A2 ${SUFFIX}`);
const S_B1 = await newStore(T_B, `B1 ${SUFFIX}`);
const C_A = await newCustomer(T_A, 'a');
const C_A2 = await newCustomer(T_A, 'a2');
const C_B = await newCustomer(T_B, 'b');
const LINES = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 2, 4_500), line('Tempered glass ' + String.fromCodePoint(0x1f4f1), 3, 0)];

/** A fresh tenant, store, two customers, its store owner (no role row ever) and a manager, and one saved draft. */
async function scene(label, { managerLevel } = {}) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label} ${SUFFIX}`);
  const C1 = await newCustomer(T, `${label}-1`);
  const C2 = await newCustomer(T, `${label}-2`);
  const boss = await actor(`${label}-owner`, [storeGrant(T, S, 'store_owner')]);
  const manager = await actor(`${label}-manager`, [storeGrant(T, S, 'manager')]);
  if (managerLevel !== undefined) await setLevel(T, 'manager', 'invoices', managerLevel);
  const kBoss = await mint(boss);
  const kManager = await mint(manager);
  const draft = await create(kBoss, S, T, C1, LINES);
  return { T, S, C1, C2, boss, manager, kBoss, kManager, draft };
}

// ===========================================================================
// IDE-01..02: the migration, the surface and the ACL
// ===========================================================================

test('IDE-01 (AC-18): 001-029 applied clean, every checksum the pinned one; 029\'s postcondition holds and refuses every widening it names; a second apply is refused', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 29 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'every ledger checksum is the pinned one');
  assert.equal(ledger[28].checksum, createHash('sha256').update(UP_029).digest('hex'), '029\'s checksum is its up bytes');
  assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_029).simple())).code, undefined, 'the applied state satisfies the postcondition');
  for (const [label, widen] of [
    ['EXECUTE to PUBLIC', `grant execute on function ${UPDATE} to public`],
    ['EXECUTE to the audit writer', `grant execute on function ${UPDATE} to tmpos_audit_writer`],
    ['a grantable EXECUTE', `grant execute on function ${UPDATE} to tmpos_app with grant option`],
    ['the trigger function to tmpos_app', `grant execute on function ${IMMUTABLE} to tmpos_app`],
    ['a stable edit', `alter function ${UPDATE} stable`],
    ['an invoker edit', `alter function ${UPDATE} security invoker`],
    ['an edit with row security on', `alter function ${UPDATE} reset row_security`],
    ['a definer trigger function', `alter function ${IMMUTABLE} security definer`],
    ['the trigger enabled for origin sessions only', 'alter table tmpos_invoice_draft.invoice_draft enable trigger trg_invoice_draft_immutable'],
    ['the trigger disabled', 'alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable'],
    ['a second trigger', `create trigger extra before delete on tmpos_invoice_draft.invoice_draft_line for each row execute function ${IMMUTABLE}`],
    ['the trigger dropped', 'drop trigger trg_invoice_draft_immutable on tmpos_invoice_draft.invoice_draft'],
    ['a relaxed version CHECK', 'alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_version_chk, add constraint invoice_draft_version_chk check (version >= 1)'],
    ['an unvalidated version CHECK', 'alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_version_chk, add constraint invoice_draft_version_chk check (version between 1 and 9007199254740991) not valid'],
    ['a sixth routine', 'create function tmpos_invoice_draft.extra() returns integer language sql as \'select 1\''],
    ['SELECT on the drafts to tmpos_app', 'grant select on tmpos_invoice_draft.invoice_draft to tmpos_app'],
    ['UPDATE on the lines to tmpos_app', 'grant update on tmpos_invoice_draft.invoice_draft_line to tmpos_app'],
    ['a column grant', 'grant update (customer_id) on tmpos_invoice_draft.invoice_draft to authenticated'],
    ['the audit subject\'s comment reverted', 'comment on column public.audit_event.subject_invoice_draft_id is \'x\''],
    ['a draft table\'s comment reverted', 'comment on table tmpos_invoice_draft.invoice_draft_line is \'x\''],
  ]) {
    const out = await rolledBack(async (tx) => { await tx.unsafe(widen); await tx.unsafe(POSTCONDITION_029).simple(); });
    assert.equal(out.code, '55000', `${label}: refused (${JSON.stringify(out)})`);
    assert.match(out.message, /^migration 029 refused/, label);
  }
  const again = await rolledBack((tx) => tx.unsafe(UP_029).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /^migration 029 refused: the edit routine, the trigger function or a trigger on the draft tables already exists$/);
});

test('IDE-02 (AC-18 AC-05): the edit routine a pinned VOLATILE definer only tmpos_app may execute; the trigger function an invoker nobody may execute; one ENABLE ALWAYS BEFORE UPDATE row trigger; the widened CHECK; no new table grant; the login\'s direct writes refused', async () => {
  const fns = (await owner`select p.proname::text as name, p.prosecdef, p.provolatile::text as volatility, p.proconfig, l.lanname::text as lang
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
    where p.pronamespace = 'tmpos_invoice_draft'::regnamespace order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(fns.map((f) => [f.name, f.lang, f.prosecdef, f.volatility, f.proconfig]), [
    ['m7b_invoice_draft_create', 'plpgsql', true, 'v', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
    ['m7b_invoice_draft_get', 'plpgsql', true, 's', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
    ['m7b_invoice_draft_immutable', 'plpgsql', false, 'v', ['search_path=pg_catalog, pg_temp']],
    ['m7b_invoice_draft_page', 'plpgsql', true, 's', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
    ['m7b_invoice_draft_update', 'plpgsql', true, 'v', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
  ]);
  // EXACT grantees, read from the ACL itself (owner aside): the routine's one non-grantable EXECUTE to tmpos_app, the trigger
  // function's none.
  const grantees = async (sig) => (await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.is_grantable as grantable
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
    where p.oid = ${sig}::regprocedure and g.grantee <> p.proowner order by 1, 2`).map((r) => ({ ...r }));
  assert.deepEqual(await grantees(UPDATE), [{ grantee: 'tmpos_app', priv: 'EXECUTE', grantable: false }]);
  assert.deepEqual(await grantees(IMMUTABLE), [], 'no grantee at all, PUBLIC included');
  for (const [sig, login] of [[UPDATE, true], [IMMUTABLE, false]]) {
    const [can] = await owner`select pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${sig}::regprocedure, 'EXECUTE') as login,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${sig}::regprocedure, 'EXECUTE') as audit,
      pg_catalog.has_function_privilege('anon', ${sig}::regprocedure, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${sig}::regprocedure, 'EXECUTE') as authenticated`;
    assert.deepEqual({ ...can }, { login, audit: false, anon: false, authenticated: false }, sig);
  }
  const triggers = (await owner`select g.tgrelid::regclass::text as rel, g.tgname::text as name, g.tgfoid::regprocedure::text as fn, g.tgtype::int as type,
      g.tgenabled::text as enabled from pg_catalog.pg_trigger g
    where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and not g.tgisinternal`).map((r) => ({ ...r }));
  assert.deepEqual(triggers, [{ rel: 'tmpos_invoice_draft.invoice_draft', name: 'trg_invoice_draft_immutable', fn: 'tmpos_invoice_draft.m7b_invoice_draft_immutable()',
    type: 19, enabled: 'A' }], 'BEFORE (2) UPDATE (16) ROW (1), ALWAYS');
  const [check] = await owner`select pg_catalog.pg_get_constraintdef(k.oid) as def, k.convalidated from pg_catalog.pg_constraint k
    where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk'`;
  assert.deepEqual({ ...check }, { def: 'CHECK (((version >= 1) AND (version <= \'9007199254740991\'::bigint)))', convalidated: true });
  // No table grant beyond the owner's, on either table or any column; the login reaches neither by any path.
  const acls = (await owner`select c.relname::text as rel, g.grantee::regrole::text as grantee from pg_catalog.pg_class c,
      pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
    where c.relnamespace = 'tmpos_invoice_draft'::regnamespace and c.relkind = 'r' and g.grantee <> c.relowner`).map((r) => ({ ...r }));
  assert.deepEqual(acls, []);
  for (const t of ['tmpos_invoice_draft.invoice_draft', 'tmpos_invoice_draft.invoice_draft_line']) {
    const [p] = await owner`select pg_catalog.has_table_privilege(${RUNTIME_LOGIN}, ${t}::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as any_priv,
      pg_catalog.has_any_column_privilege(${RUNTIME_LOGIN}, ${t}::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') as any_column`;
    assert.deepEqual({ ...p }, { any_priv: false, any_column: false }, `${t}: the login reaches it only through the routines`);
  }
  const draft = await create(await mint(await actor('surface', [storeGrant(T_A, S_A1, 'store_owner')])), S_A1, T_A, C_A, LINES);
  for (const [label, attempt] of [
    ['SELECT the drafts', runtime`select count(*) from tmpos_invoice_draft.invoice_draft`],
    ['INSERT a draft', runtime`insert into tmpos_invoice_draft.invoice_draft (draft_id) values (${randomUUID()})`],
    ['UPDATE a draft', runtime`update tmpos_invoice_draft.invoice_draft set customer_id = ${C_A2} where draft_id = ${draft}`],
    ['DELETE a draft', runtime`delete from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`],
    ['INSERT a line', runtime`insert into tmpos_invoice_draft.invoice_draft_line (draft_id) values (${draft})`],
    ['UPDATE a line', runtime`update tmpos_invoice_draft.invoice_draft_line set quantity = 2 where draft_id = ${draft}`],
    ['DELETE a line', runtime`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft}`],
  ]) {
    assert.equal((await errorOf(attempt))?.code, '42501', `the login cannot ${label}`);
  }
  assert.equal((await errorOf(runtime`select tmpos_invoice_draft.m7b_invoice_draft_immutable()`))?.code, '42501', 'nor call the trigger function');
});

// ===========================================================================
// IDE-03..07: the edit, its no-op, its conflicts and the answers that write nothing
// ===========================================================================

test('IDE-03 (AC-05): a real edit replaces the customer and the ordered lines, the line count and the subtotal, and steps the version by one — atomically; the id, tenant, store, status, currency, creation time and creator stay; no audit, outbox or idempotency row', async () => {
  const s = await scene('change');
  // Neighbours the edit must leave byte for byte: another draft in the SAME store and one in ANOTHER store of the tenant (the
  // lines' DELETE and INSERT and the header's UPDATE are each scoped by draft, tenant and store).
  const sibling = await create(s.kBoss, s.S, s.T, s.C1, [line('Sibling', 2, 300), line('Sibling two', 1, 1)]);
  const S2 = await newStore(s.T, `change-2 ${SUFFIX}`);
  const elsewhere = await create(await mint(await actor('change-owner-2', [storeGrant(s.T, S2, 'store_owner')])), S2, s.T, s.C1, LINES);
  const neighbours = async () => ({ sibling: await stateOf(sibling), elsewhere: await stateOf(elsewhere) });
  const untouched = await neighbours();
  assert.equal(untouched.sibling.lines.length + untouched.elsewhere.lines.length, 5);
  const before = await contentOf(s.draft);
  assert.equal(before.header.version, '1');
  const prints = await footprint([s.T]);
  assert.equal(prints.roles, 0, 'the store owner\'s save made no role row; the manager has none');
  // 1 -> 2: another customer; the three lines reordered, one edited, one added.
  const v2 = [line('Labour  (1 hr)', 3, 4_500), line('Screen replacement', 1, 13_999), LINES[2], line('Case', 1, 2_000)];
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, v2), [done('applied', s.manager, s.T, s.S, 2)]);
  const at2 = await contentOf(s.draft);
  const fixed = ({ draft_id, tenant_id, store_id, status, currency, created_at, created_by }) => ({ draft_id, tenant_id, store_id, status, currency, created_at, created_by });
  assert.deepEqual(fixed(at2.header), fixed(before.header), 'the id, tenant, store, status, currency, creation time and creator stay');
  assert.deepEqual([at2.header.customer_id, at2.header.version, at2.header.line_count, at2.header.subtotal],
    [s.C2, '2', 4, String(sumOf(v2))], 'the customer, version, count and subtotal move together');
  assert.deepEqual(at2.lines, linesAs(v2), 'positions 1..n in the order sent');
  const after2 = await footprint([s.T]);
  assert.deepEqual([after2.drafts - prints.drafts, after2.lines - prints.lines, after2.audits - prints.audits, after2.subjects - prints.subjects,
    after2.events - prints.events, after2.records - prints.records], [0, 1, 0, 0, 0, 0], 'one line more, and no audit, event or idempotency row: the runtime appends those');
  assert.deepEqual(await neighbours(), untouched, 'the same store\'s other draft and the other store\'s draft: header and lines byte for byte, same xmin and ctid');
  assert.deepEqual((await owner`select role_id, domain, level from tmpos_role.tenant_role_level where tenant_id = ${s.T}`).map((r) => ({ ...r })),
    [{ role_id: 'manager', domain: 'invoices', level: null }], 'the change path made the manager\'s Invoices lock anchor (NULL: the default) exist, and no Customers row');
  // 2 -> 3: lines removed down to one, the same customer.
  const v3 = [line('Diagnostics', 1, 0)];
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 2, s.C2, v3), [done('applied', s.manager, s.T, s.S, 3)]);
  assert.deepEqual(await contentOf(s.draft), { header: { ...at2.header, version: '3', line_count: 1, subtotal: '0' }, lines: linesAs(v3) });
  // 3 -> 4: the store owner (no role row) back to the first customer and fifty lines; still no role row of its own.
  const fifty = Array.from({ length: INVOICE_DRAFT_MAX_LINES }, (_, i) => line(`L${i + 1}`, 1, i === 0 ? MAX - (INVOICE_DRAFT_MAX_LINES - 1) : 1));
  assert.deepEqual(await edit(s.kBoss, s.S, s.T, s.draft, 3, s.C1, fifty), [done('applied', s.boss, s.T, s.S, 4)]);
  const at4 = await contentOf(s.draft);
  assert.deepEqual([at4.header.customer_id, at4.header.version, at4.header.line_count, at4.header.subtotal], [s.C1, '4', 50, String(MAX)]);
  assert.deepEqual(at4.lines, linesAs(fifty));
  assert.equal((await footprint([s.T])).roles, 1, 'the owner\'s edit made no role row');
  assert.deepEqual(await neighbours(), untouched, 'after three edits, still byte for byte');
  // The real get answers exactly the stored edit.
  const got = await get(s.kManager, s.T, s.S, s.draft);
  assert.deepEqual(got.map((r) => [r.o_outcome, r.o_customer_id, r.o_version, r.o_line_count, r.o_subtotal_cents]), Array(50).fill(['draft', s.C1, '4', 50, String(MAX)]));
  assert.deepEqual(got.map((r) => [r.o_position, r.o_description, r.o_quantity, r.o_unit_price_cents]),
    fifty.map((l, i) => [i + 1, l.description, String(l.quantity), String(l.unitPriceCents)]));
});

test('IDE-04 (AC-05 D8): the trigger refuses an owner\'s UPDATE of the id, tenant, store, creation time or creator and any version move but +0 or +1 — also as a replica; the CHECKs refuse status and currency', async () => {
  const s = await scene('immutable');
  const other = await newStore(s.T, `immutable-other ${SUFFIX}`);
  const IMMUTABLE_MESSAGE = 'migration 029: an invoice draft\'s id, tenant, store, creation time and creator never change';
  const VERSION_MESSAGE = 'migration 029: an invoice draft\'s version stays or advances by exactly one';
  const before = await stateOf(s.draft);
  for (const [label, change, code, message] of [
    ['draft_id', (tx) => tx`update tmpos_invoice_draft.invoice_draft set draft_id = ${randomUUID()} where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['tenant_id', (tx) => tx`update tmpos_invoice_draft.invoice_draft set tenant_id = ${T_B} where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['store_id', (tx) => tx`update tmpos_invoice_draft.invoice_draft set store_id = ${other} where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['created_at', (tx) => tx`update tmpos_invoice_draft.invoice_draft set created_at = created_at - interval '1 microsecond' where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['created_by', (tx) => tx`update tmpos_invoice_draft.invoice_draft set created_by = ${randomUUID()} where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['version + 2', (tx) => tx`update tmpos_invoice_draft.invoice_draft set version = version + 2 where draft_id = ${s.draft}`, '23001', VERSION_MESSAGE],
    ['version - 1 (to 0)', (tx) => tx`update tmpos_invoice_draft.invoice_draft set version = version - 1 where draft_id = ${s.draft}`, '23001', VERSION_MESSAGE],
    ['status', (tx) => tx`update tmpos_invoice_draft.invoice_draft set status = 'issued' where draft_id = ${s.draft}`, '23514', null],
    ['currency', (tx) => tx`update tmpos_invoice_draft.invoice_draft set currency = 'EUR' where draft_id = ${s.draft}`, '23514', null],
  ]) {
    for (const replica of [false, true]) {
      const out = await rolledBack(async (tx) => {
        if (replica) await tx`set local session_replication_role = replica`;
        return change(tx);
      });
      assert.equal(out.code, code, `${label}${replica ? ' (replica)' : ''}: refused (${JSON.stringify(out)})`);
      if (message !== null) assert.equal(out.message, message, `${label}: the fixed message`);
    }
  }
  // Admitted: +1, +0 and the editable columns — the routine's own shape (each rolled back).
  for (const [label, change] of [
    ['version + 1', (tx) => tx`update tmpos_invoice_draft.invoice_draft set version = version + 1 where draft_id = ${s.draft} returning version::text as v`],
    ['version unchanged', (tx) => tx`update tmpos_invoice_draft.invoice_draft set version = version, line_count = line_count where draft_id = ${s.draft} returning version::text as v`],
    ['customer, count and subtotal', (tx) => tx`update tmpos_invoice_draft.invoice_draft set customer_id = ${s.C2} where draft_id = ${s.draft} returning version::text as v`],
  ]) {
    const out = await rolledBack(change);
    assert.equal(out.code, undefined, `${label}: admitted (${JSON.stringify(out)})`);
    assert.equal(out.value.length, 1, label);
  }
  assert.deepEqual(await stateOf(s.draft), before, 'every proof rolled back');
});

test('IDE-05 (AC-06): a current-version no-op answers unchanged with the current version and writes nothing — the header\'s and every line\'s bytes, xmin and ctid identical; equal totals with other lines, and a reorder, are changes', async () => {
  const s = await scene('noop');
  const prints = await footprint([s.T]);
  const before = await stateOf(s.draft);
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C1, LINES), [done('unchanged', s.manager, s.T, s.S, 1)]);
  assert.deepEqual(await stateOf(s.draft), before, 'nothing written: same row bytes, xmin and ctid, header and lines');
  assert.deepEqual(await footprint([s.T]), prints, 'no role anchor, line, audit, event or record');
  // Equal totals, other lines: the same subtotal by another split — a change.
  const split = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 1, 9_000), line('Tempered glass ' + String.fromCodePoint(0x1f4f1), 3, 0)];
  assert.equal(sumOf(split), sumOf(LINES), 'the same subtotal');
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C1, split), [done('applied', s.manager, s.T, s.S, 2)]);
  // A reorder of the very same lines: a change.
  const reordered = [split[2], split[0], split[1]];
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 2, s.C1, reordered), [done('applied', s.manager, s.T, s.S, 3)]);
  assert.deepEqual((await contentOf(s.draft)).lines, linesAs(reordered));
  // The customer alone: a change. Then the no-op again, at version 4.
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 3, s.C2, reordered), [done('applied', s.manager, s.T, s.S, 4)]);
  const at4 = await stateOf(s.draft);
  const prints4 = await footprint([s.T]);
  assert.deepEqual(await edit(s.kBoss, s.S, s.T, s.draft, 4, s.C2, reordered), [done('unchanged', s.boss, s.T, s.S, 4)]);
  assert.deepEqual(await stateOf(s.draft), at4);
  assert.deepEqual(await footprint([s.T]), prints4);
  // A line differing only in its description's case, its quantity or its price is a change; and one line fewer is.
  for (const [label, lines] of [
    ['description', [{ ...reordered[0], description: reordered[0].description.toUpperCase() }, reordered[1], reordered[2]]],
    ['quantity', [reordered[0], { ...reordered[1], quantity: 2 }, reordered[2]]],
    ['price', [reordered[0], reordered[1], { ...reordered[2], unitPriceCents: 9_001 }]],
    ['a line fewer', reordered.slice(0, 2)],
  ]) {
    const [{ v }] = await owner`select version::text as v from tmpos_invoice_draft.invoice_draft where draft_id = ${s.draft}`;
    const rows = await edit(s.kManager, s.S, s.T, s.draft, Number(v), s.C2, lines);
    assert.deepEqual(rows, [done('applied', s.manager, s.T, s.S, Number(v) + 1)], label);
  }
});

test('IDE-06 (AC-07): a stale version conflicts — with other contents and with contents equal to the stored ones — and writes nothing', async () => {
  const s = await scene('stale');
  const v2 = [line('Other', 1, 1)];
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, v2), [done('applied', s.manager, s.T, s.S, 2)]);
  const prints = await footprint([s.T]);
  const at2 = await stateOf(s.draft);
  for (const [label, customer, lines, version] of [
    ['stale, other contents', s.C1, LINES, 1],
    ['stale, the stored contents exactly (a stale no-op)', s.C2, v2, 1],
    ['ahead of the stored version', s.C2, v2, 3],
  ]) {
    assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, version, customer, lines), [answer('conflict')], label);
    assert.deepEqual(await stateOf(s.draft), at2, `${label}: nothing written`);
    assert.deepEqual(await footprint([s.T]), prints, `${label}: no anchor, line, audit, event or record`);
  }
});

test('IDE-07 (DA-36 AC-10): every sealed or rolled-back answer — conflict, invalid_state, unchanged, not_found, refused, tenant_mismatch — is reached with NOTHING written, not even a role anchor, for a role that had no stored row', async () => {
  const s = await scene('nothing');
  const S2 = await newStore(s.T, `nothing-2 ${SUFFIX}`);
  const boss2 = await actor('nothing-owner-2', [storeGrant(s.T, S2, 'store_owner')]);
  const draftAtS2 = await create(await mint(boss2), S2, s.T, s.C1, LINES);
  const bossB = await actor('nothing-owner-b', [storeGrant(T_B, S_B1, 'store_owner')]);
  const draftAtB = await create(await mint(bossB), S_B1, T_B, C_B, LINES);
  const technician = await actor('nothing-technician', [storeGrant(s.T, s.S, 'technician')]);
  const salesStaff = await actor('nothing-sales', [storeGrant(s.T, s.S, 'sales_staff')]);
  const kTech = await mint(technician);
  const kSales = await mint(salesStaff);
  const watched = [s.T, T_B];
  const roleRows = async (db = owner) => (await db`select count(*)::int as n from tmpos_role.tenant_role_level where tenant_id = ${s.T}`)[0].n;
  assert.equal(await roleRows(), 0, 'no stored role row for the manager, technician or sales staff: every decision below is on a default');
  const NEW = [line('New', 1, 1)];
  for (const [label, call, expected] of [
    ['conflict', () => edit(s.kManager, s.S, s.T, s.draft, 2, s.C2, NEW), answer('conflict')],
    ['unchanged', () => edit(s.kManager, s.S, s.T, s.draft, 1, s.C1, LINES), done('unchanged', s.manager, s.T, s.S, 1)],
    ['not_found: a missing draft', () => edit(s.kManager, s.S, s.T, randomUUID(), 1, s.C2, NEW), answer('not_found')],
    ['not_found: the tenant\'s other store\'s draft', () => edit(s.kManager, s.S, s.T, draftAtS2, 1, s.C2, NEW), answer('not_found')],
    ['not_found: another tenant\'s draft', () => edit(s.kManager, s.S, s.T, draftAtB, 1, s.C2, NEW), answer('not_found')],
    ['not_found: a missing customer', () => edit(s.kManager, s.S, s.T, s.draft, 1, randomUUID(), NEW), answer('not_found')],
    ['not_found: another tenant\'s customer', () => edit(s.kManager, s.S, s.T, s.draft, 1, C_B, NEW), answer('not_found')],
    ['refused: the technician (default View)', () => edit(kTech, s.S, s.T, s.draft, 1, s.C2, NEW), REFUSED],
    ['refused: the sales staff (default Create)', () => edit(kSales, s.S, s.T, s.draft, 1, s.C2, NEW), REFUSED],
    ['refused: a store the manager holds no grant at', () => edit(s.kManager, S2, s.T, draftAtS2, 1, s.C2, NEW), REFUSED],
    ['refused: an unknown session', () => edit(newKey(), s.S, s.T, s.draft, 1, s.C2, NEW), REFUSED],
    ['tenant_mismatch', () => edit(s.kManager, s.S, T_B, s.draft, 1, s.C2, NEW), answer('tenant_mismatch')],
  ]) {
    const prints = await footprint(watched);
    const states = [await stateOf(s.draft), await stateOf(draftAtS2), await stateOf(draftAtB)];
    assert.deepEqual(await call(), [expected], label);
    assert.deepEqual(await footprint(watched), prints, `${label}: no draft, line, role row, version, audit, event or record`);
    assert.deepEqual([await stateOf(s.draft), await stateOf(draftAtS2), await stateOf(draftAtB)], states, `${label}: every draft byte for byte`);
    assert.equal(await roleRows(), 0, `${label}: no role anchor`);
  }
  // invalid_state: unreachable while 028's CHECK pins the status, so it is shown inside one owner transaction that drops the
  // CHECK, moves the status and calls the same routine as the session's caller would — all rolled back.
  const out = await rolledBack(async (tx) => {
    await tx`alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_status_chk`;
    await tx`update tmpos_invoice_draft.invoice_draft set status = 'issued' where draft_id = ${s.draft}`;
    const prints = await footprint(watched, tx);
    const state = await stateOf(s.draft, tx);
    const rows = await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, NEW, { db: tx });
    return { rows, same: { prints: await footprint(watched, tx), state: await stateOf(s.draft, tx) }, was: { prints, state }, roles: await roleRows(tx) };
  });
  assert.equal(out.code, undefined, JSON.stringify(out));
  assert.deepEqual(out.value.rows, [answer('invalid_state')]);
  assert.deepEqual(out.value.same, out.value.was, 'invalid_state: nothing written');
  assert.equal(out.value.roles, 0, 'invalid_state: no role anchor');
  // The change path, by contrast, makes exactly the manager's Invoices anchor exist.
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, NEW), [done('applied', s.manager, s.T, s.S, 2)]);
  assert.equal(await roleRows(), 1);
});

// ===========================================================================
// IDE-08: the SQL bounds, at the runtime's own limits
// ===========================================================================

test('IDE-08 (AC-15): every bound refused with 22023 and a fixed message at the runtime\'s own limits, writing nothing; each limit itself admitted; the version\'s top end; outside READ COMMITTED, 55000', async () => {
  const s = await scene('bounds');
  const N = INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS;
  const at = (description, quantity = 1, price = 1) => `[{"description":${JSON.stringify(description)},"quantity":${quantity},"unitPriceCents":${price}}]`;
  const M = 'migration 029 update: ';
  const BAD = [
    ['a malformed key', { key: '' }, `${M}an argument is malformed`],
    ['an expected version of 0', { version: 0 }, `${M}the expected version is not one the draft table can advance`],
    ['an expected version of 2^53 - 1', { version: MAX }, `${M}the expected version is not one the draft table can advance`],
    ['a negative subtotal', { lines: at('x', 1, 0), subtotal: '-1' }, `${M}the subtotal is not a whole number from 0 to 9007199254740991`],
    ['a subtotal of 2^53', { lines: at('x', 1, 0), subtotal: String(MAX + 1) }, `${M}the subtotal is not a whole number from 0 to 9007199254740991`],
    ['lines not an array', { lines: '{"description":"x","quantity":1,"unitPriceCents":1}', subtotal: '1' }, `${M}the lines are not an array`],
    ['no line', { lines: '[]', subtotal: '0' }, `${M}there are not 1 to 50 lines`],
    [`${INVOICE_DRAFT_MAX_LINES + 1} lines`, { lines: JSON.stringify(Array.from({ length: INVOICE_DRAFT_MAX_LINES + 1 }, () => line('x', 1, 1))), subtotal: String(INVOICE_DRAFT_MAX_LINES + 1) },
      `${M}there are not 1 to 50 lines`],
    ['an extra line key', { lines: '[{"description":"x","quantity":1,"unitPriceCents":1,"lineTotalCents":1}]', subtotal: '1' },
      `${M}a line is not exactly a description, a quantity and a unit price`],
    ['a missing line key', { lines: '[{"description":"x","quantity":1}]', subtotal: '0' }, `${M}a line is not exactly a description, a quantity and a unit price`],
    ['a quantity as a string', { lines: '[{"description":"x","quantity":"1","unitPriceCents":1}]', subtotal: '1' }, `${M}a line field has the wrong type`],
    [`a description of ${N + 1} characters`, { lines: at('d'.repeat(N + 1)) }, `${M}a line description is not one the line table admits`],
    ['an empty description', { lines: at('') }, `${M}a line description is not one the line table admits`],
    ['an edge space', { lines: at(' Opaque description') }, `${M}a line description is not one the line table admits`],
    ['a control character', { lines: at('Opaque\u0007description') }, `${M}a line description is not one the line table admits`],
    ['a Bidi_Control', { lines: at('Opaque\u202edescription') }, `${M}a line description is not one the line table admits`],
    ['a quantity of 0', { lines: at('x', 0, 1), subtotal: '0' }, `${M}a line quantity is not a whole number from 1 to 9007199254740991`],
    ['a quantity of 2^53', { lines: at('x', MAX + 1, 0), subtotal: '0' }, `${M}a line quantity is not a whole number from 1 to 9007199254740991`],
    ['a fractional quantity', { lines: at('x', '1.5', 0), subtotal: '0' }, `${M}a line quantity is not a whole number from 1 to 9007199254740991`],
    ['a negative price', { lines: at('x', 1, -1), subtotal: '0' }, `${M}a line unit price is not a whole number of cents from 0 to 9007199254740991`],
    ['a price of 2^53', { lines: at('x', 1, MAX + 1), subtotal: '0' }, `${M}a line unit price is not a whole number of cents from 0 to 9007199254740991`],
    ['a line total above 2^53 - 1', { lines: at('x', 2, 2 ** 52), subtotal: '0' }, `${M}a line total is above 9007199254740991`],
    ['a sum above 2^53 - 1', { lines: JSON.stringify([line('x', 1, MAX), line('y', 1, 1)]), subtotal: '0' }, `${M}the lines' sum is above 9007199254740991`],
    ['a subtotal that is not the sum', { lines: at('x', 2, 3), subtotal: '5' }, `${M}the subtotal is not the sum of the line totals`],
  ];
  const prints = await footprint([s.T]);
  const state = await stateOf(s.draft);
  for (const [label, o, message] of BAD) {
    const lines = o.lines ?? at('x');
    const out = await errorOf(edit(o.key ?? s.kManager, s.S, s.T, s.draft, o.version ?? 1, s.C2, lines, { subtotal: o.subtotal ?? '1' }));
    assert.deepEqual(out, { code: '22023', message }, label);
    assert.doesNotMatch(out.message, /Opaque|9007199254740992|1\.5/, `${label}: the message carries no value`);
  }
  assert.deepEqual(await footprint([s.T]), prints, 'no refusal wrote anything');
  assert.deepEqual(await stateOf(s.draft), state);
  // Each limit itself is admitted: 256 code points (an astral one counted once), 50 lines, the largest quantity and price.
  const limits = [
    [`a description of ${N} code points`, [line('d'.repeat(N - 1) + String.fromCodePoint(0x1f4f1), 1, 1)]],
    ['the largest quantity', [line('q', MAX, 1)]],
    ['the largest price', [line('p', 1, MAX)]],
    [`${INVOICE_DRAFT_MAX_LINES} lines summing to 2^53 - 1`, Array.from({ length: INVOICE_DRAFT_MAX_LINES }, (_, i) => line(`L${i}`, 1, i === 0 ? MAX - (INVOICE_DRAFT_MAX_LINES - 1) : 1))],
    ['a zero price', [line('z', 1, 0)]],
  ];
  for (const [i, [label, lines]] of limits.entries()) {
    assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, i + 1, s.C2, lines), [done('applied', s.manager, s.T, s.S, i + 2)], label);
    assert.deepEqual((await contentOf(s.draft)).lines, linesAs(lines), `${label}: stored exactly`);
  }
  // The version's top end: a draft at 2^53 - 2 (set by the owner with the trigger lifted, in a transaction rolled back)
  // advances to 2^53 - 1; the expected version 2^53 - 1 is then refused before anything is read; the CHECK refuses beyond.
  const top = await rolledBack(async (tx) => {
    await tx`alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable`;
    await tx`update tmpos_invoice_draft.invoice_draft set version = ${String(MAX_EXPECTED)}::bigint where draft_id = ${s.draft}`;
    await tx`alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_immutable`;
    const rows = await edit(s.kManager, s.S, s.T, s.draft, MAX_EXPECTED, s.C1, LINES, { db: tx });
    const beyond = await errorOf(edit(s.kManager, s.S, s.T, s.draft, MAX, s.C1, LINES, { db: tx }));
    return { rows, beyond };
  });
  assert.equal(top.code, undefined, JSON.stringify(top));
  assert.deepEqual(top.value.rows, [done('applied', s.manager, s.T, s.S, MAX)], '2^53 - 2 -> 2^53 - 1, exact');
  assert.equal(top.value.beyond?.code, '22023', 'a draft at 2^53 - 1 can never be edited');
  const overflow = await rolledBack(async (tx) => {
    await tx`alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable`;
    await tx`update tmpos_invoice_draft.invoice_draft set version = ${String(MAX + 1)}::bigint where draft_id = ${s.draft}`;
  });
  assert.equal(overflow.code, '23514', 'the CHECK refuses a version above 2^53 - 1');
  const zero = await rolledBack(async (tx) => {
    await tx`alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable`;
    await tx`update tmpos_invoice_draft.invoice_draft set version = 0 where draft_id = ${s.draft}`;
  });
  assert.equal(zero.code, '23514', 'and one below 1');
  // Outside READ COMMITTED, before anything is read.
  for (const level of ['repeatable read', 'serializable']) {
    const out = await errorOf(runtime.begin(`isolation level ${level}`, (tx) => edit(s.kManager, s.S, s.T, s.draft, 6, s.C1, LINES, { db: tx })));
    assert.deepEqual(out, { code: '55000', message: `${M}it must run under READ COMMITTED, so that its checks see what committed before its locks` }, level);
  }
});


// ===========================================================================
// IDE-09: the consistent read (D7)
// ===========================================================================

test('IDE-09 (AC-09 D7): the REAL get, blocked between its header and its lines by an ACCESS EXCLUSIVE holder that then commits a replacement through the edit routine, answers the complete EARLIER draft; a VOLATILE copy of the same body, same interleave, answers a MIXED one', async () => {
  const s = await scene('snapshot');
  // The negative control: the installed get's own definition, with its schema and its volatility the only differences.
  const [{ def, src }] = await owner`select pg_catalog.pg_get_functiondef(${GET}::regprocedure) as def, p.prosrc as src
    from pg_catalog.pg_proc p where p.oid = ${GET}::regprocedure`;
  assert.equal(def.split('\n STABLE SECURITY DEFINER\n').length, 2, 'the installed get is STABLE SECURITY DEFINER');
  assert.equal(def.split('CREATE OR REPLACE FUNCTION tmpos_invoice_draft.m7b_invoice_draft_get(').length, 2);
  const copy = def.replace('CREATE OR REPLACE FUNCTION tmpos_invoice_draft.m7b_invoice_draft_get(', `CREATE FUNCTION ${SCRATCH_SCHEMA}.m7b_invoice_draft_get(`)
    .replace('\n STABLE SECURITY DEFINER\n', '\n VOLATILE SECURITY DEFINER\n');
  await owner.unsafe(`create schema ${SCRATCH_SCHEMA}`);
  try {
    await owner.unsafe(copy);
    const [{ same }] = await owner.unsafe(`select p.prosrc = $1 and p.provolatile = 'v' as same from pg_catalog.pg_proc p
      where p.oid = '${SCRATCH_SCHEMA}.m7b_invoice_draft_get(text, uuid, uuid, uuid)'::regprocedure`, [src]);
    assert.equal(same, true, 'the copy is the same body, VOLATILE');

    /**
     * One interleave: a holder takes ACCESS EXCLUSIVE on the line table (and nothing the get reads before its lines); a
     * getter starts — its statement's snapshot taken now — reads the header and blocks on the lines; once that is SEEN in
     * pg_locks, the holder replaces the header and the lines through the real edit routine, as its owner, in the same
     * transaction, and commits; the getter then finishes.
     */
    const interleave = async (label, getter, version, customer, lines) => {
      const holder = holding(owner, (tx) => tx`lock table tmpos_invoice_draft.invoice_draft_line in access exclusive mode`,
        (tx) => edit(s.kManager, s.S, s.T, s.draft, version, customer, lines, { db: tx }));
      let reading = null;
      try {
        await until(() => holder.ready, `${label}: the line table held`);
        reading = running(getter.db, (tx) => get(s.kManager, s.T, s.S, s.draft, tx, getter.fn));
        // THE CONDITION: the getter's one ungranted lock is an AccessShareLock on exactly invoice_draft_line, the relation the
        // holder holds AccessExclusiveLock on. A generic wait_event 'Lock' would not do: it could be admission work.
        await until(async () => reading.pid !== null && (await owner`select
            (select count(*) from pg_catalog.pg_locks l where l.pid = ${reading.pid} and not l.granted)::int = 1
            and exists (select 1 from pg_catalog.pg_locks l where l.pid = ${reading.pid} and not l.granted and l.locktype = 'relation'
                          and l.relation = 'tmpos_invoice_draft.invoice_draft_line'::regclass and l.mode = 'AccessShareLock')
            and exists (select 1 from pg_catalog.pg_locks l where l.pid = ${holder.pid} and l.granted and l.locktype = 'relation'
                          and l.relation = 'tmpos_invoice_draft.invoice_draft_line'::regclass and l.mode = 'AccessExclusiveLock') as ok`)[0].ok,
        `${label}: the getter waits on the line table alone, after its header read`);
      } catch (err) {
        holder.release('rollback');
        await holder.done;
        if (reading !== null) await reading.done;
        throw err;
      }
      holder.release('commit');
      assert.deepEqual(await holder.done, { outcome: 'committed', value: [done('applied', s.manager, s.T, s.S, version + 1)] },
        `${label}: the replacement committed while the getter waited`);
      const read = await reading.done;
      assert.equal(read.outcome, 'committed', JSON.stringify(read));
      return read.value;
    };
    const shape = (rows) => ({
      header: [...new Set(rows.map((r) => JSON.stringify([r.o_outcome, r.o_draft_id, r.o_customer_id, r.o_version, r.o_line_count, r.o_subtotal_cents])))].map((j) => JSON.parse(j)),
      lines: rows.map((r) => [r.o_position, r.o_description, r.o_quantity, r.o_unit_price_cents]),
    });
    const whole = (customer, version, lines) => ({ header: [['draft', s.draft, customer, String(version), lines.length, String(sumOf(lines))]],
      lines: lines.map((l, i) => [i + 1, l.description, String(l.quantity), String(l.unitPriceCents)]) });
    const R1 = [line('Replacement one', 2, 700), line('Replacement two', 1, 50)];
    const R2 = [line('Third A', 1, 1), line('Third B', 1, 2), line('Third C', 1, 3), line('Third D', 1, 4)];

    // The REAL routine, as the runtime login calls it: the complete earlier draft, header and lines of one instant.
    const real = await interleave('the real get', { db: runtime, fn: 'tmpos_invoice_draft.m7b_invoice_draft_get' }, 1, s.C2, R1);
    assert.deepEqual(shape(real), whole(s.C1, 1, LINES), 'the real get: version 1 whole');
    assert.deepEqual(shape(await get(s.kManager, s.T, s.S, s.draft)), whole(s.C2, 2, R1), 'read after the commit: version 2 whole');

    // The VOLATILE control, same interleave: version 2's header (customer, count, subtotal) over version 3's four lines.
    const mixed = await interleave('the VOLATILE copy', { db: owner, fn: `${SCRATCH_SCHEMA}.m7b_invoice_draft_get` }, 2, s.C1, R2);
    assert.deepEqual(shape(mixed), { header: whole(s.C2, 2, R1).header, lines: whole(s.C1, 3, R2).lines },
      'the VOLATILE copy mixes two saved versions: the interleave really happens');
    assert.deepEqual(shape(await get(s.kManager, s.T, s.S, s.draft)), whole(s.C1, 3, R2), 'read after the commit: version 3 whole');
  } finally {
    await owner.unsafe(`drop schema if exists ${SCRATCH_SCHEMA} cascade`);
  }
});

// ===========================================================================
// IDE-10..12: ordering against concurrent writers, by lock waits
// ===========================================================================

/** The draft's stored version, as a number. */
const versionOf = async (draft) => Number((await owner`select version::text as v from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`)[0].v);
/** The counts a refused or conflicting edit must leave as they were (role-level versions excluded: an owner's level edit moves them). */
const writes = async (tenants) => { const { versions, ...rest } = await footprint(tenants); void versions; return rest; };

test('IDE-10 (AC-08 AC-07): two distinct actors edit one version — the second waits on the header, then conflicts, also when it sends the first\'s very contents (a stale no-op), never not_found; the first rolled back instead, the second applies', async () => {
  // The manager's Invoices row stored up front (Full), so the first edit's change path never makes a role row and the
  // second's "wrote nothing" is read against counts the first's commit does not move (every round's contents are one line).
  const s = await scene('header', { managerLevel: 'full' });
  for (const [i, [label, ending, sameAsFirst, expected]] of [
    ['the first rolled back', 'rollback', false, 'applied'],
    ['the first committed, other contents', 'commit', false, 'conflict'],
    ['the first committed, its very contents', 'commit', true, 'conflict'],
  ].entries()) {
    const v = await versionOf(s.draft);
    // Contents new to the draft each round, so the first edit is a real change every time.
    const FIRST = [line(`First editor ${i}`, 1, 100)];
    const second = sameAsFirst ? FIRST : [line(`Second editor ${i}`, 2, 100)];
    const first = holding(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, v, s.C2, FIRST, { db: tx }));
    let waiter = null;
    try {
      await until(() => first.ready, `${label}: the first edit applied, uncommitted`);
      const prints = await writes([s.T]);
      // The store owner: a distinct actor, so 016's hold (one actor's account FOR UPDATE) does not serialize the two.
      waiter = running(runtime, (tx) => edit(s.kBoss, s.S, s.T, s.draft, v, s.C2, second, { db: tx }));
      await until(() => blockedBy(waiter.pid, first.pid), `${label}: the second edit waits for the first`);
      const w = await waitingIn(waiter.pid);
      assert.equal(w.waiting, 1, `${label}: one ungranted lock`);
      assert.match(w.query, /m7b_invoice_draft_update/, `${label}: inside the edit`);
      // WHAT it waits on: an ungranted transactionid ShareLock on a transaction id the FIRST edit holds (its own, or a
      // subtransaction's: the routine's write blocks run as subtransactions), while holding the heavyweight tuple lock on a
      // row of the draft header table — the header FOR UPDATE, never 016's hold, a role row or the customer.
      const firstXids = (await owner`select l.transactionid::text as xid from pg_catalog.pg_locks l
        where l.pid = ${first.pid} and l.locktype = 'transactionid' and l.mode = 'ExclusiveLock' and l.granted`).map((r) => r.xid);
      const waits = (await owner`select l.locktype::text as locktype, l.mode::text as mode, l.granted, l.transactionid::text as xid,
          l.relation::regclass::text as rel
        from pg_catalog.pg_locks l where l.pid = ${waiter.pid} and (not l.granted or l.locktype = 'tuple')`).map((r) => ({ ...r }));
      const ungranted = waits.filter((l) => !l.granted);
      assert.deepEqual(ungranted.map((l) => [l.locktype, l.mode]), [['transactionid', 'ShareLock']], `${label}: ${JSON.stringify(waits)}`);
      assert.ok(firstXids.includes(ungranted[0].xid), `${label}: behind the first edit's transaction (${ungranted[0].xid} in ${firstXids})`);
      assert.deepEqual(waits.filter((l) => l.locktype === 'tuple').map((l) => [l.rel, l.granted]), [['tmpos_invoice_draft.invoice_draft', true]],
        `${label}: holding the tuple lock on the draft header`);
      first.release(ending);
      const firstOut = await first.done;
      assert.deepEqual(firstOut, ending === 'commit'
        ? { outcome: 'committed', value: [done('applied', s.manager, s.T, s.S, v + 1)] } : { outcome: 'rolled back' });
      const out = await waiter.done;
      assert.equal(out.outcome, 'committed', JSON.stringify(out));
      if (expected === 'conflict') {
        assert.deepEqual(out.value, [answer('conflict')], `${label}: the second re-read the committed version — a conflict, not not_found`);
        assert.equal(await versionOf(s.draft), v + 1, `${label}: the first's edit alone`);
        assert.deepEqual((await contentOf(s.draft)).lines, linesAs(FIRST));
        assert.deepEqual(await writes([s.T]), prints, `${label}: the second wrote nothing`);
      } else {
        assert.deepEqual(out.value, [done('applied', s.boss, s.T, s.S, v + 1)], label);
        assert.deepEqual((await contentOf(s.draft)).lines, linesAs(second));
      }
    } finally {
      first.release('rollback');
      await first.done;
      if (waiter !== null) await waiter.done;
    }
  }
});

test('IDE-11 (AC-14 AC-03): an owner\'s narrowing of Invoices to Create committed while the edit waits on the role row — after taking the header — refuses it, nothing written; rolled back, the edit applies; edit first, the narrowing waits for its COMMIT and governs only later edits', async () => {
  const s = await scene('narrow', { managerLevel: 'edit' });
  const NEXT = [line('Narrowing', 1, 1)];
  // The owner's narrowing as 026's set takes it: the role row FOR UPDATE, then the level written (021's trigger moves its version).
  const narrow = async (tx) => {
    await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${s.T} and role_id = 'manager' and domain = 'invoices' for update`;
    return tx`update tmpos_role.tenant_role_level set level = 'create', updated_at = now()
      where tenant_id = ${s.T} and role_id = 'manager' and domain = 'invoices' returning level`;
  };
  // The narrowing held first: the control (rolled back) and then committed.
  for (const ending of ['rollback', 'commit']) {
    const v = await versionOf(s.draft);
    const narrowing = holding(owner, narrow);
    let editing = null;
    try {
      await until(() => narrowing.ready, `${ending}: the narrowing held, uncommitted`);
      const before = await stateOf(s.draft);
      const prints = await writes([s.T]);
      // Contents new to the draft each round: a no-op would answer at step 9 and never reach the role row.
      editing = running(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, v, s.C2, [line(`Narrowing ${ending}`, 1, 1)], { db: tx }));
      // THE BARRIER: the edit has decided on the committed Edit (step 3, unlocked) and waits to lock that role row (step 10).
      await until(() => blockedBy(editing.pid, narrowing.pid), `${ending}: the edit waits on the narrowed role row`);
      const w = await waitingIn(editing.pid);
      assert.equal(w.waiting, 1, `${ending}: one ungranted lock`);
      assert.match(w.query, /m7b_invoice_draft_update/, `${ending}: inside the edit`);
      // ...having already taken the header FOR UPDATE (header before role row): a third session cannot take it.
      const nowait = await errorOf(owner.begin(RC, (tx) => tx`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${s.draft} for update nowait`));
      assert.equal(nowait?.code, '55P03', `${ending}: the waiting edit holds the header`);
      narrowing.release(ending);
      assert.equal((await narrowing.done).outcome, ending === 'commit' ? 'committed' : 'rolled back');
      const out = await editing.done;
      if (ending === 'commit') {
        assert.deepEqual(out.value, [REFUSED], 'the re-decision on the locked value refuses');
        assert.deepEqual(await stateOf(s.draft), before, 'nothing written');
        assert.deepEqual(await writes([s.T]), prints);
      } else {
        assert.deepEqual(out.value, [done('applied', s.manager, s.T, s.S, v + 1)], 'rolled back: the same edit applies');
      }
    } finally {
      narrowing.release('rollback');
      await narrowing.done;
      if (editing !== null) await editing.done;
    }
  }
  assert.equal((await owner`select level from tmpos_role.tenant_role_level where tenant_id = ${s.T} and role_id = 'manager' and domain = 'invoices'`)[0].level, 'create');
  // The edit first: the owner's narrowing waits for its COMMIT (the edit's FOR SHARE), and governs only later edits.
  await setLevel(s.T, 'manager', 'invoices', 'edit');
  const v = await versionOf(s.draft);
  const editHold = holding(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, v, s.C1, LINES, { db: tx }));
  let narrowing = null;
  try {
    await until(() => editHold.ready, 'the edit applied, uncommitted');
    narrowing = running(owner, narrow);
    await until(() => blockedBy(narrowing.pid, editHold.pid), 'the narrowing waits for the edit');
    editHold.release('commit');
    assert.deepEqual(await editHold.done, { outcome: 'committed', value: [done('applied', s.manager, s.T, s.S, v + 1)] });
    assert.equal((await narrowing.done).outcome, 'committed');
  } finally {
    editHold.release('rollback');
    await editHold.done;
    if (narrowing !== null) await narrowing.done;
  }
  assert.equal(await versionOf(s.draft), v + 1, 'the edit committed first');
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, v + 1, s.C2, NEXT), [REFUSED], 'the next edit meets the narrowing');

  // The sealed answers rest on step 3's UNLOCKED decision. With the header held by another session, a stale edit and a
  // current no-op each pass step 3 at Edit and wait on the header; the owner's narrowing to Create then COMMITS; released,
  // each still answers its sealed conflict / unchanged with nothing written — only the change path re-decides on the locked
  // role row (the barriers above race exactly that path).
  for (const [label, version, expected] of [['a stale edit', v, answer('conflict')], ['a current no-op', v + 1, done('unchanged', s.manager, s.T, s.S, v + 1)]]) {
    await setLevel(s.T, 'manager', 'invoices', 'edit');
    const header = holding(owner, (tx) => tx`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${s.draft} for update`);
    let waiting = null;
    try {
      await until(() => header.ready, `${label}: the header held`);
      const before = await stateOf(s.draft);
      const prints = await writes([s.T]);
      waiting = running(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, version, s.C1, LINES, { db: tx }));
      await until(() => blockedBy(waiting.pid, header.pid), `${label}: past step 3, waiting on the header`);
      // The exact barrier (IDE-10's): an ungranted transactionid ShareLock on the header holder's transaction, while holding
      // the tuple lock on the draft header table — the edit is at step 5, past step 3's unlocked decision.
      const wait = await lockWaitOf(waiting.pid, header.pid);
      assert.deepEqual(wait.ungranted.map((l) => [l.locktype, l.mode]), [['transactionid', 'ShareLock']], `${label}: ${JSON.stringify(wait.locks)}`);
      assert.ok(wait.holderXids.includes(wait.ungranted[0].xid), `${label}: behind the header holder's transaction`);
      assert.deepEqual(wait.tuples.map((l) => [l.rel, l.granted]), [['tmpos_invoice_draft.invoice_draft', true]], `${label}: holding the header's tuple lock`);
      await narrow(owner);
      header.release('rollback');
      await header.done;
      const out = await waiting.done;
      assert.deepEqual(out.value, [expected], `${label}: the sealed answer, despite the narrowing committed after step 3`);
      assert.deepEqual(await stateOf(s.draft), before, `${label}: nothing written`);
      assert.deepEqual(await writes([s.T]), prints, `${label}: no anchor, audit, event or record`);
    } finally {
      header.release('rollback');
      await header.done;
      if (waiting !== null) await waiting.done;
    }
  }
});

test('IDE-12 (AC-14): a grant suspended or a store made read-only first — the edit waits in 016\'s hold, then is refused with nothing written (rolled back instead: it applies); the edit first — the change waits for its COMMIT and refuses only later edits', async () => {
  const NEXT = [line('Ordered', 1, 1)];
  for (const [label, change] of [
    ['grant', (s) => (tx) => tx`update user_membership set status = 'suspended' where membership_id = ${s.manager.memberships[0]} returning status`],
    ['store', (s) => (tx) => tx`update store set status = 'read_only' where store_id = ${s.S} returning status`],
  ]) {
    for (const ending of ['rollback', 'commit']) {
      const s = await scene(`${label}-first-${ending}`);
      const changing = holding(owner, change(s));
      let editing = null;
      try {
        await until(() => changing.ready, `${label} ${ending}: the change held`);
        const before = await stateOf(s.draft);
        const prints = await writes([s.T]);
        editing = running(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, NEXT, { db: tx }));
        await until(() => blockedBy(editing.pid, changing.pid), `${label} ${ending}: the edit waits on the changed row`);
        const w = await waitingIn(editing.pid);
        assert.equal(w.waiting, 1, `${label} ${ending}: one ungranted lock`);
        assert.match(w.query, /m7b_invoice_draft_update/);
        changing.release(ending);
        await changing.done;
        const out = await editing.done;
        if (ending === 'commit') {
          assert.deepEqual(out.value, [REFUSED], `${label}: refused once the change committed`);
          assert.deepEqual(await stateOf(s.draft), before, `${label}: nothing written`);
          assert.deepEqual(await writes([s.T]), prints, `${label}: no role anchor either`);
        } else {
          assert.deepEqual(out.value, [done('applied', s.manager, s.T, s.S, 2)], `${label}: rolled back, the edit applies`);
        }
      } finally {
        changing.release('rollback');
        await changing.done;
        if (editing !== null) await editing.done;
      }
    }
    const s = await scene(`${label}-after`);
    const editHold = holding(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, NEXT, { db: tx }));
    let changing = null;
    try {
      await until(() => editHold.ready, `${label} after: the edit applied, uncommitted`);
      changing = running(owner, change(s));
      await until(() => blockedBy(changing.pid, editHold.pid), `${label} after: the change waits for the edit`);
      editHold.release('commit');
      assert.deepEqual(await editHold.done, { outcome: 'committed', value: [done('applied', s.manager, s.T, s.S, 2)] });
      assert.equal((await changing.done).outcome, 'committed');
    } finally {
      editHold.release('rollback');
      await editHold.done;
      if (changing !== null) await changing.done;
    }
    assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 2, s.C1, LINES), [REFUSED], `${label}: the next edit meets the change`);
  }
});

// ===========================================================================
// IDE-15: the one write a refusal can follow (DA-36, step 10)
// ===========================================================================

test('IDE-15 (DA-36): the one write a refusal can follow — step 10\'s lock anchor, made only for a role with no row, refused only when the session expired while that lock waited — exists only inside the refusing transaction; rolled back, nothing remains', async () => {
  const s = await scene('late');
  // A short-lived session for the manager (no stored role row): live through every step up to 10, expired once 10 has waited.
  // The expiry cannot be moved by an UPDATE while the edit waits: the routine compares the database clock with the
  // expires_at it read in step 1 (held in a variable), and it holds the session and mint-ledger rows FOR SHARE from step 1
  // until COMMIT, so an owner's UPDATE of either would wait for the edit and could not change the value it compares. The
  // lifetime is therefore real time, chosen generous (8 s) so the edit reaches step 10 long before it (asserted below: it is
  // seen waiting there first); the test then waits on the database clock passing the expiry — a condition, never a guess.
  const key = await mint(s.manager, { lifetime: 8_000 });
  const [{ expires }] = await owner`select expires_at::text as expires from tmpos_session.session where session_key = ${key}`;
  // An owner's uncommitted INSERT of exactly that role row: the edit's anchor INSERT ... ON CONFLICT DO NOTHING waits on it.
  const holder = holding(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (${s.T}, 'manager', 'invoices', null, now())`);
  let editing = null;
  try {
    await until(() => holder.ready, 'the owner\'s row held, uncommitted');
    const prints = await footprint([s.T]);
    const before = await stateOf(s.draft);
    // As the routine's owner, so that the refusing transaction can count its own uncommitted rows (the login reads none).
    let seen = null;
    editing = holding(owner, async (tx) => {
      seen = {
        rows: await edit(key, s.S, s.T, s.draft, 1, s.C2, [line('Late', 1, 1)], { db: tx }),
        anchors: (await tx`select role_id, domain, level from tmpos_role.tenant_role_level where tenant_id = ${s.T}`).map((r) => ({ ...r })),
        state: await stateOf(s.draft, tx),
      };
    });
    await until(() => blockedBy(editing.pid, holder.pid), 'the edit waits on the role row at step 10');
    assert.match((await waitingIn(editing.pid)).query, /m7b_invoice_draft_update/);
    // The exact barrier: the one ungranted lock is a transactionid ShareLock on the owner's uncommitted INSERT's transaction,
    // taken inside step 10's anchor INSERT (its RowExclusiveLock on the role-level table held), before step 11 (no
    // RowExclusiveLock on the line table yet).
    const wait = await lockWaitOf(editing.pid, holder.pid);
    assert.deepEqual(wait.ungranted.map((l) => [l.locktype, l.mode]), [['transactionid', 'ShareLock']], JSON.stringify(wait.locks));
    assert.ok(wait.holderXids.includes(wait.ungranted[0].xid), 'behind the owner\'s uncommitted INSERT of the role row');
    assert.ok(wait.locks.some((l) => l.rel === 'tmpos_role.tenant_role_level' && l.mode === 'RowExclusiveLock' && l.granted), 'inside step 10\'s anchor INSERT');
    assert.ok(!wait.locks.some((l) => l.rel === 'tmpos_invoice_draft.invoice_draft_line' && l.mode === 'RowExclusiveLock'), 'not yet at step 11');
    // Bracketed: the session is still live on the database clock when the edit is seen waiting at step 10 ...
    assert.ok(await dbNow() < BigInt(expires), 'the session is live at the barrier');
    // ... and the expiry then passes while it waits (a condition on the database clock, never a guess; the bound kept).
    await until(async () => (await dbNow()) >= BigInt(expires), 'the session expired while the edit waited', 20_000);
    holder.release('rollback');
    await holder.done;
    await until(() => editing.ready, 'the edit answered');
    assert.deepEqual(seen.rows, [REFUSED], 'refused at step 10\'s clock check');
    assert.deepEqual(seen.anchors, [{ role_id: 'manager', domain: 'invoices', level: null }], 'inside the refusing transaction: the anchor alone was written');
    assert.deepEqual(seen.state, before, 'and nothing of the draft');
    editing.release('rollback');
    const out = await editing.done;
    assert.equal(out.outcome, 'rolled back');
    const after = await footprint([s.T]);
    assert.deepEqual(await stateOf(s.draft), before, 'the draft untouched');
    assert.deepEqual(after, prints, 'rolled back: no anchor, line, audit, event or record remains');
  } finally {
    holder.release('rollback');
    await holder.done;
    if (editing !== null) { editing.release('rollback'); await editing.done; }
  }
});

// ===========================================================================
// IDE-13: parity of every restatement; the lock blocks
// ===========================================================================

test('IDE-13 (AC-15 AC-18): every SQL restatement in 029 — the defaults, the owner literal, the editable set, the ordering, the Edit threshold, 017\'s three description regexes — equals the catalog; no raw invisible code point; both files lock the writers\' seven first, before every check and change', async () => {
  const EDITABLE = ['manager', 'technician', 'sales_staff'];
  assert.deepEqual(Object.fromEntries(EDITABLE.map((r) => [r, TENANT_ROLE_PERMISSION_DEFAULTS[r].invoices])), { manager: 'full', technician: 'view', sales_staff: 'create' },
    'the catalog\'s Invoices defaults this parity pins');
  const restated = (source, label, expect) => {
    const cases = [...source.matchAll(/case v_role ((?:when '[a-z_]+' then '[a-z]+' )+)end/g)]
      .map((m) => Object.fromEntries([...m[1].matchAll(/when '([a-z_]+)' then '([a-z]+)'/g)].map((p) => [p[1], p[2]])));
    assert.equal(cases.length, expect.cases, `${label}: every default restatement found`);
    for (const c of cases) assert.deepEqual(c, { manager: 'full', technician: 'view', sales_staff: 'create' }, `${label}: the defaults`);
    const owners = [...source.matchAll(/v_role = '([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(owners, Array(expect.owners).fill('store_owner'), `${label}: the owner literal`);
    const sets = [...source.matchAll(/v_role in \(([^)]*)\)/g)].map((m) => m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort());
    assert.deepEqual(sets, Array(expect.sets).fill([...EDITABLE].sort()), `${label}: the editable set`);
    const orderings = [...source.matchAll(/array\[('none'[^\]]*)\]/g)].map((m) => m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')));
    assert.deepEqual(orderings, Array(expect.orderings).fill([...TENANT_ORDERING]), `${label}: the ordering`);
    const thresholds = [...source.matchAll(/array_position\(c_levels, '([a-z]+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(thresholds, Array(expect.thresholds).fill('edit'), `${label}: every threshold is Edit (no Customers corequisite, D1)`);
  };
  const installed = (await owner`select pg_catalog.pg_get_functiondef(${UPDATE}::regprocedure) as source`)[0].source;
  restated(installed, 'the installed edit', { cases: 2, owners: 1, sets: 2, orderings: 1, thresholds: 2 });
  restated(UP_029, 'the up file', { cases: 2, owners: 1, sets: 2, orderings: 1, thresholds: 2 });
  assert.doesNotMatch(installed, /'customers'/, 'the edit never reads the Customers level');
  // 017's three plain-text regexes, as the installed description CHECK carries them, restated exactly by the edit's step 0.
  const [{ def }] = await owner`select pg_catalog.pg_get_constraintdef(k.oid) as def from pg_catalog.pg_constraint k
    where k.conrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass and k.conname = 'invoice_draft_line_description_chk'`;
  const regexes = [...def.matchAll(/!~ '((?:[^']|'')*)'::text/g)].map((m) => m[1]);
  assert.equal(regexes.length, 3, def);
  for (const regex of regexes) assert.ok(installed.includes(`v_text !~ '${regex}'`), `the edit's step 0 restates ${regex}`);
  assert.ok(installed.includes(`char_length(v_text) between 1 and ${INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS}`), 'and the length bound');
  for (const [label, file] of [['up', UP_029], ['down', DOWN_029]]) {
    assert.doesNotMatch(file, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u, `029 ${label}`);
  }
  // STATIC, for both files: the lock block is the first statement after the transaction settings and holds nothing but the
  // seven locks in the writers' order and the handler; no other LOCK statement; every check and the first change after it.
  const statements = (file) => file.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
  const opensWith = (label, file, settings, raise) => {
    const want = [...settings, 'do $$', 'begin', ...WRITERS_ORDER.map((rel) => `  lock table ${rel} in access exclusive mode;`), 'exception',
      '  when undefined_table or invalid_schema_name then', raise, "      using errcode = 'object_not_in_prerequisite_state';", 'end', '$$;'];
    const got = statements(file).slice(0, want.length);
    want.forEach((l, i) => (l instanceof RegExp ? assert.match(got[i], l, `${label}, statement line ${i}`) : assert.equal(got[i], l, `${label}, statement line ${i}`)));
  };
  opensWith('the up', UP_029, ['set local search_path = pg_catalog, pg_temp;'], /^ {4}raise exception 'migration 029 refused: [^']* is missing \(migrations 002, 017, 020, 021 and 028 must be applied first\)'$/);
  opensWith('the down', DOWN_029, ['set local search_path = pg_catalog, pg_temp;', 'set local row_security = off;'],
    /^ {4}raise exception 'migration 029 rollback refused: migration 029 is not applied \([^']*\)'$/);
  const firstChange = (file) => Math.min(...[...file.matchAll(/^(?:alter|create|drop|insert|update|delete|grant|revoke|comment)\b/gm)].map((m) => m.index));
  for (const [label, file, checks] of [
    ['the up', UP_029, ['to_regprocedure(', 'to_regclass(', 'pg_constraint', 'has_function_privilege(', 'pg_has_role(', 'already exists']],
    ['the down', DOWN_029, ['to_regprocedure(', 'pg_trigger', 'transaction_isolation', 'rollback refused: an invoice draft has been edited']],
  ]) {
    const locks = [...file.matchAll(/^ *lock table ([a-z_.]+) in access exclusive mode;$/gm)];
    assert.deepEqual(locks.map((m) => m[1]), WRITERS_ORDER, `${label}: exactly the seven, in the writers' order`);
    const end = file.indexOf('\n$$;\n', locks.at(-1).index);
    assert.ok(end > 0 && end < firstChange(file), `${label}: the lock block before the first change`);
    for (const check of checks) assert.ok(file.indexOf(check) > end, `${label}: ${check} comes after the locks`);
  }
  assert.ok(DOWN_029.indexOf('rollback refused: an invoice draft has been edited') < firstChange(DOWN_029), 'the down\'s guard precedes its first change');
  // Every change either file makes, statement by statement (the first line of each): the up creates its own three objects,
  // widens the one CHECK and rewords three comments; the down removes exactly those and restores the CHECK and the comments.
  // Neither alters, replaces or re-grants an object 028 created beyond that.
  const changes = (file) => [...file.matchAll(/^(?:alter|create|drop|insert|update|delete|grant|revoke|comment)\b[^\n]*/gm)].map((m) => m[0]);
  assert.deepEqual(changes(UP_029), [
    'alter table tmpos_invoice_draft.invoice_draft',
    'comment on table tmpos_invoice_draft.invoice_draft is',
    'comment on table tmpos_invoice_draft.invoice_draft_line is',
    'create function tmpos_invoice_draft.m7b_invoice_draft_immutable()',
    'comment on function tmpos_invoice_draft.m7b_invoice_draft_immutable() is',
    'create trigger trg_invoice_draft_immutable',
    'alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_immutable;',
    'create function tmpos_invoice_draft.m7b_invoice_draft_update(',
    `comment on function ${UPDATE} is`,
    'comment on column public.audit_event.subject_invoice_draft_id is',
    `revoke all on function ${UPDATE} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke all on function ${IMMUTABLE} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `grant execute on function ${UPDATE} to tmpos_app;`,
  ], 'the up\'s changes, in order');
  assert.ok(UP_029.includes('alter table tmpos_invoice_draft.invoice_draft\n  drop constraint invoice_draft_version_chk,\n  add constraint invoice_draft_version_chk check (version between 1 and 9007199254740991);\n'));
  assert.deepEqual(changes(DOWN_029), [
    `revoke execute on function ${UPDATE} from tmpos_app;`,
    `drop function ${UPDATE};`,
    'drop trigger trg_invoice_draft_immutable on tmpos_invoice_draft.invoice_draft;',
    `drop function ${IMMUTABLE};`,
    'alter table tmpos_invoice_draft.invoice_draft',
    'comment on table tmpos_invoice_draft.invoice_draft is',
    'comment on table tmpos_invoice_draft.invoice_draft_line is',
    'comment on column public.audit_event.subject_invoice_draft_id is',
  ], 'the down\'s changes, in order');
  assert.ok(DOWN_029.includes('alter table tmpos_invoice_draft.invoice_draft\n  drop constraint invoice_draft_version_chk,\n  add constraint invoice_draft_version_chk check (version = 1);\n'));
  assert.doesNotMatch(UP_029 + DOWN_029, /create or replace|\bexecute '|\bexecute format|cascade/i, 'no replacement, no dynamic SQL, no CASCADE');
});

// ===========================================================================
// IDE-14: the rollback and the upgrade (last: it rolls 029 back and deletes this suite's drafts)
// ===========================================================================

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
/** A `comment on <target> is '...'` statement's text in a migration file, unescaped. */
const commentIn = (file, target) => {
  const m = new RegExp(`\\ncomment on ${target.replace(/\./g, '\\.')} is\\n  '((?:[^']|'')*)';\\n`).exec(file);
  assert.ok(m, `the file comments ${target}`);
  return m[1].replace(/''/g, '\'');
};
const COMMENTED = ['table tmpos_invoice_draft.invoice_draft', 'table tmpos_invoice_draft.invoice_draft_line', 'column public.audit_event.subject_invoice_draft_id'];
/** What 029 changes and what it must leave: the version CHECK, triggers, routines, comments, constraints and table ACLs. */
async function contract() {
  const [check] = await owner`select pg_catalog.pg_get_constraintdef(k.oid) as def, k.convalidated as valid from pg_catalog.pg_constraint k
    where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk'`;
  const triggers = (await owner`select g.tgname::text as name from pg_catalog.pg_trigger g
    where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and not g.tgisinternal`).map((r) => r.name);
  const routines = (await owner`select p.oid::regprocedure::text as fn, pg_catalog.md5(p.prosrc) as src, p.proacl::text as acl, p.provolatile::text as vol,
      p.prosecdef as definer, p.proconfig as config from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_draft'::regnamespace order by 1`).map((r) => ({ ...r }));
  const [comments] = await owner`select pg_catalog.obj_description('tmpos_invoice_draft.invoice_draft'::regclass, 'pg_class') as header,
      pg_catalog.obj_description('tmpos_invoice_draft.invoice_draft_line'::regclass, 'pg_class') as lines,
      pg_catalog.col_description('public.audit_event'::regclass, (select a.attnum from pg_catalog.pg_attribute a
        where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id')::integer) as subject`;
  const constraints = (await owner`select c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def, c.convalidated as valid from pg_catalog.pg_constraint c
    where c.conrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and c.contype <> 'n'
      and c.conname <> 'invoice_draft_version_chk' order by 1`).map((r) => ({ ...r }));
  const acls = (await owner`select c.relname::text as rel, c.relacl::text as acl from pg_catalog.pg_class c
    where c.relnamespace = 'tmpos_invoice_draft'::regnamespace order by 1`).map((r) => ({ ...r }));
  return { check: { ...check }, triggers, routines, comments: { ...comments }, constraints, acls };
}
/** Every row a scope holds in the draft and role tables, exactly (to_jsonb keeps created_at to the microsecond). */
async function rowsOf(tenants) {
  const q = async (rel) => (await owner.unsafe(`select pg_catalog.to_jsonb(t)::text as row from ${rel} t where t.tenant_id = any($1::uuid[]) order by 1`, [tenants])).map((r) => r.row);
  return {
    drafts: await q('tmpos_invoice_draft.invoice_draft'), lines: await q('tmpos_invoice_draft.invoice_draft_line'),
    levels: await q('tmpos_role.tenant_role_level'), versions: await q('tmpos_role_edit.role_level_version'),
  };
}

test('IDE-14 (AC-18): 029\'s down refused while not applied and while a draft is at version > 1 (everything unchanged), and when an edit it waited for commits; retained edit audit and outbox rows do not block it; clean, it restores 028\'s contract exactly and the 001-029 runtime refuses that database; the 028 database with drafts and role configuration upgrades to 029 unchanged', async () => {
  const UP_028_COMMENTS = COMMENTED.map((t) => commentIn(UP_028, t));
  const UP_029_COMMENTS = COMMENTED.map((t) => commentIn(UP_029, t));
  assert.deepEqual(COMMENTED.map((t) => commentIn(DOWN_029, t)), UP_028_COMMENTS, 'the down restores 028\'s three comments, character for character');
  // 1. An edited draft of its own (version 2), whatever the cases before it left: refused, nothing changed.
  const e = await scene('down-edited');
  assert.deepEqual(await edit(e.kBoss, e.S, e.T, e.draft, 1, e.C2, [line('Edited', 1, 1)]), [done('applied', e.boss, e.T, e.S, 2)]);
  const edited = [e.draft];
  const with029 = await contract();
  assert.deepEqual(Object.values(with029.comments), UP_029_COMMENTS, 'applied: 029\'s comments');
  const rowsBefore = await rowsOf(TENANTS);
  const refused = await rolledBack((tx) => tx.unsafe(DOWN_029).simple());
  assert.deepEqual(refused, { code: '55000', message: 'migration 029 rollback refused: an invoice draft has been edited (its version is above 1), and a rollback never resets a version or discards an edit' });
  assert.deepEqual(await contract(), with029, 'refused: the contract unchanged');
  assert.deepEqual(await rowsOf(TENANTS), rowsBefore, 'refused: every draft, line and role row unchanged');
  // 2. Retained edit evidence: an edit's audit record and its outbox event stay, and do not block the down once no edited
  //    draft is left (the drafts deleted here as an owner decision would delete them; all rolled back).
  const evidence = await rolledBack(async (tx) => {
    const [subject] = edited;
    await tx`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
        reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_invoice_draft_id)
      values (${randomUUID()}, null, 'store', ${T_A}, ${S_A1}, 'store.invoice_draft.update', 'edit_invoice_drafts', 'allow', 'command_committed',
        'IDE synthetic record.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1', 'durable_compliance_event', ${subject})`;
    await tx`insert into tmpos_internal.outbox_event (event_id, event_type, event_version, aggregate_type, aggregate_id, aggregate_version, correlation_id,
        payload, occurred_at, status, attempt, due_at)
      values (${randomUUID()}, 'invoice_draft.updated', 1, 'invoice_draft', ${subject}, 2, ${randomUUID()}, ${tx.json({ storeId: S_A1, customerId: C_A, lineCount: 1 })},
        pg_catalog.now(), 'pending', 0, pg_catalog.now())`;
    await tx`delete from tmpos_invoice_draft.invoice_draft_line where draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where version > 1)`;
    await tx`delete from tmpos_invoice_draft.invoice_draft where version > 1`;
    await tx.unsafe(DOWN_029).simple();
    const [kept] = await tx`select
        (select count(*) from public.audit_event where subject_invoice_draft_id = ${subject} and action_id = 'store.invoice_draft.update')::int as audit,
        (select count(*) from tmpos_internal.outbox_event where aggregate_id = ${subject} and event_type = 'invoice_draft.updated')::int as outbox,
        (select pg_catalog.pg_get_constraintdef(k.oid) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk') as def`;
    const twice = await tx.unsafe(DOWN_029).simple().then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
    return { ...kept, twice };
  });
  assert.equal(evidence.code, undefined, JSON.stringify(evidence));
  assert.deepEqual({ ...evidence.value, twice: evidence.value.twice?.code }, { audit: 1, outbox: 1, def: 'CHECK ((version = 1))', twice: '55000' },
    'the down completed over retained edit evidence and kept it; run again, it is refused (not applied)');
  assert.match(evidence.value.twice.message, /^migration 029 rollback refused: migration 029 is not applied \(/);
  // 3. Locks first: an edit running when the down starts commits first, and the guard then sees its version.
  await cleanDrafts();
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_draft.invoice_draft where version > 1`)[0].n, 0, 'no edited draft anywhere');
  const r = await scene('race');
  const editHold = holding(runtime, (tx) => edit(r.kBoss, r.S, r.T, r.draft, 1, r.C2, [line('Late edit', 1, 1)], { db: tx }));
  let down = null;
  try {
    await until(() => editHold.ready, 'the edit applied, uncommitted');
    down = running(owner, async (tx) => { await tx.unsafe(DOWN_029).simple(); throw ROLLBACK; });
    await until(() => blockedBy(down.pid, editHold.pid), 'the down waits for the running edit before it reads anything');
    editHold.release('commit');
    assert.deepEqual(await editHold.done, { outcome: 'committed', value: [done('applied', r.boss, r.T, r.S, 2)] });
    const d = await down.done;
    assert.deepEqual({ outcome: d.outcome, code: d.code }, { outcome: 'failed', code: '55000' }, JSON.stringify(d));
    assert.match(d.message, /an invoice draft has been edited/, 'the guard saw the edit that committed while the down waited');
  } finally {
    editHold.release('rollback');
    await editHold.done;
    if (down !== null) await down.done;
  }
  await cleanDrafts();
  // 4. Clean: the executor's own path — 029's down and its ledger row — restores 028's contract exactly.
  assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'control: the 001-029 runtime is accepted');
  const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '028');
  let restored = false;
  try {
    assert.deepEqual(undone, ['029'], 'only 029 sits above 028');
    const at028 = await contract();
    assert.deepEqual(at028.check, { def: 'CHECK ((version = 1))', valid: true }, '028\'s CHECK, validated');
    assert.deepEqual(at028.triggers, [], 'no trigger');
    assert.deepEqual(at028.routines, with029.routines.filter((f) => !/m7b_invoice_draft_(update|immutable)\(/.test(f.fn)),
      'exactly 028\'s three routines, each byte for byte and with its ACL as before');
    assert.equal(at028.routines.length, 3);
    // Independently of any state captured with 029 applied: each surviving routine is exactly the body 028's file declares.
    const bodyOf = (file, name) => {
      const at = file.indexOf(`create function tmpos_invoice_draft.${name}(`);
      const start = file.indexOf('as $$', at) + 'as $$'.length;
      return file.slice(start, file.indexOf('$$;', start));
    };
    assert.deepEqual((await owner`select p.proname::text as name, p.prosrc as src from pg_catalog.pg_proc p
        where p.pronamespace = 'tmpos_invoice_draft'::regnamespace order by 1`).map((r) => ({ ...r })),
      ['m7b_invoice_draft_create', 'm7b_invoice_draft_get', 'm7b_invoice_draft_page'].map((name) => ({ name, src: bodyOf(UP_028, name) })),
      '028\'s three routines, each byte for byte the body 028\'s file declares');
    assert.deepEqual(Object.values(at028.comments), UP_028_COMMENTS, '028\'s comments, as 028\'s file wrote them');
    assert.deepEqual([at028.constraints, at028.acls], [with029.constraints, with029.acls], 'every other constraint and the table ACLs unchanged');
    assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_028).simple())).code, undefined, '028\'s own postcondition holds again');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: ['role_privilege_missing'], migrationLedger: ['migration_missing'] },
      'the 001-029 runtime refuses the 028 database: its grants and its ledger');
    // 5. THE UPGRADE: a 028 database holding drafts (an owner's and a manager's) and role configuration (a stored level, the
    //    manager's save's lock anchors), upgraded by the trusted executor.
    const u = await scene('upgrade', { managerLevel: 'edit' });
    const managerDraft = await create(u.kManager, u.S, u.T, u.C2, [line('Saved at 028', 2, 250)]);
    await setLevel(u.T, 'technician', 'invoices', 'edit');
    const rows028 = await rowsOf([u.T]);
    assert.equal(rows028.drafts.length, 2);
    assert.ok(rows028.levels.length >= 2, 'role configuration and lock anchors exist at 028');
    const upgrade = await trustedApply();
    assert.deepEqual([upgrade.outcome, upgrade.applied], ['complete', ['029']], JSON.stringify(upgrade).slice(0, 300));
    restored = true;
    assert.deepEqual(await rowsOf([u.T]), rows028, 'every draft, line, level and level version unchanged: ids, ownership, created_at, contents');
    const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
    assert.deepEqual(ledger.map((x) => [x.version, x.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the ledger is 001-029 again');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'accepted again');
    assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_029).simple())).code, undefined, 'the upgraded state satisfies 029\'s postcondition');
    const reapplied = await contract();
    assert.deepEqual(reapplied, with029, 'the same contract as the fresh chain\'s');
    // The up leaves 028's routines, every other constraint and the table ACLs exactly as the 028 database held them (with the
    // down's statements, which touch none of them, this closes the chain: neither file alters an object 028 owns but the CHECK
    // and the comments).
    assert.deepEqual([reapplied.routines.filter((f) => !/m7b_invoice_draft_(update|immutable)\(/.test(f.fn)), reapplied.constraints, reapplied.acls],
      [at028.routines, at028.constraints, at028.acls], 're-applied over 028: 028\'s objects untouched');
    // The upgraded database edits at once: a draft saved at 028, by a technician the owner raised to Edit.
    const technician = await actor('upgrade-technician', [storeGrant(u.T, u.S, 'technician')]);
    assert.deepEqual(await edit(await mint(technician), u.S, u.T, managerDraft, 1, u.C1, LINES), [done('applied', technician, u.T, u.S, 2)]);
  } finally {
    if (!restored) await restore();
  }
});
