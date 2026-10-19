// Phase 4.0 M7B-INVOICES-DISCARD-P1 — discarding a saved store invoice draft against REAL PostgreSQL: migration 033 (the
// terminal 'discarded' state under 028's status CHECK name, the session-bound discard routine
// tmpos_invoice_discard.m7b_invoice_draft_discard that decides the role's Invoices level at Manage under migration 030's
// advisory key, the open-only reads m7b_invoice_draft_page_v2 and m7b_invoice_draft_get_v2, the two ENABLE ALWAYS terminal
// triggers on the header and on the lines, the partial index of the open page, and the rollback-order anchor
// m7b_invoice_discard_prerequisites whose recorded dependencies refuse 032's, 030's, 029's and 028's rollbacks while 033 is
// applied), exercised as the runtime's own non-owner login, every call bound as the production adapter binds it (every bigint
// as decimal text). The routine under test is DISCARD_FN, the single place it is named. Each title carries the DSC ids of
// docs/phase-4/11 §7 it evidences.
//
// WHAT IS PROVEN.
//   IDD-01 (DSC-17) 001-033 applied clean by the trusted executor (033's ledger checksum its up bytes); 033's postcondition
//          re-proven over the applied state and refusing every widening it names; the up refused when applied again and when
//          032 is not applied; the down refused outside READ COMMITTED.
//   IDD-02 (DSC-17 DSC-15) the exact surface: the schema's six functions, their attributes and complete ACLs (tmpos_app's one
//          non-grantable EXECUTE on the discard and the two reads, nothing on the trigger functions or the anchor), 028's page
//          and get now its owner's alone and refused to the login (42501), the two triggers' exact shapes (BEFORE ROW INSERT
//          UPDATE DELETE, ALWAYS), the CHECK and the index, the anchor's six dependency rows, and the login's direct table
//          writes refused (42501: the enforcement boundary).
//   IDD-03 (DSC-02) the threshold at the routine: a manager stored at none, view, create or edit is refused, at manage, approve
//          or full the discard applies; store_owner applies; the default manager (no row) applies; the default technician
//          (View) and sales_staff (Create) are refused; a technician the owner raised to Manage applies — the stored level
//          decides, never the role's name.
//   IDD-04 (DSC-06) a stale version conflicts and writes nothing: the header's row, xmin and ctid, every line, no role or
//          version row, no audit, outbox or idempotency row; the current version then applies, the version stepped by one and
//          nothing else of the header or its lines changed.
//   IDD-05 (DSC-10, DA-36) a discarded draft answers invalid_state whatever version is named (current, stale, ahead), for the
//          store owner and the manager, writing nothing; the edit answers invalid_state too; every refusal (refused,
//          tenant_mismatch, not_found for a missing, another store's and another tenant's draft) writes nothing and makes no
//          role row; every argument refused with 22023 and a fixed message; outside READ COMMITTED 55000.
//   IDD-06 (DSC-07 DSC-08) edit and discard of one draft serialize on the header: the edit first — the discard waits on the
//          header, then conflicts (rolled back instead: it applies); the discard first — the edit waits, then answers
//          invalid_state (rolled back instead: it applies); two discards — the second waits, then invalid_state.
//   IDD-07 (DSC-03) an owner's narrowing Manage -> Edit held uncommitted makes a discard wait on the role's KEY after taking
//          the header; committed it is REFUSED with nothing written, rolled back it applies; a widening Manage -> Full
//          committed while it waits applies; the discard first, the narrowing waits on the key and governs only later discards.
//   IDD-08 (DSC-04) a session that expires while the discard waits on the header, and one that expires while it waits on the
//          key, are REFUSED by the clock read after the wait (the database clock, never a guess), nothing written.
//   IDD-09 (DSC-16) the terminal guards through owner paths (and as a replica): discarded -> draft, any update of a discarded
//          header (a no-op included), a status change with another column change, a version step other than +1, a line insert,
//          update or delete under a discarded header, a delete of a discarded header and an insert of a discarded header are
//          refused (23001); an open draft stays editable and deletable by the owner; an owner's line write waits for a discard
//          holding the header and is refused once it commits.
//   IDD-10 (DSC-15) the v2 reads: a discarded draft is absent from every page, the page otherwise equal to 028's; a cursor
//          naming a discarded draft still pages; get_v2 of it answers 028's exact not_found row, of an open draft 028's rows.
//   IDD-11 (DSC-26) no deadlock against level writers: a discard holding the key (applied and conflict) and 026's REAL
//          Invoices setter or 021's REAL Customers setter, in both orders, each finish — every wait first seen in pg_locks.
//   IDD-12 (DSC-17 DSC-02) parity and text: the discard's steps 1-7 are 030's update_v2's code lines character for character
//          with Manage in place of Edit; page_v2 and get_v2 are 028's bodies with exactly one predicate each; every level
//          restatement equals the catalog; the installed bodies are the file's; the key precedes the state and version
//          decisions in the outermost block; both files lock the seven tables first; the exact change lists; the planner serves
//          the open page from the partial index.
//   IDD-13 (DSC-17) the upgrade, the rollback and the order: over drafts at versions 1-3 with stored overrides and edit audit
//          records, 032 -> 033 changes no row; edit, save and discard then work; the down is refused while a discarded draft
//          exists (catalog and rows unchanged); without one it restores the 032-era contract exactly (CHECK, grants, no schema,
//          trigger or index; 032's postcondition holds; 028's reads executable by the login again) and 033 re-applies equal;
//          with 033 applied 032's, 030's, 029's and 028's downs are refused by the anchor (2BP01) and 031's by its
//          postcondition — and with the anchor dropped 032's down completes (the control).
//   IDD-14 (DSC-10 DSC-03 DSC-15 DSC-16, negative controls) each inside a rolled-back owner transaction: the discard without
//          its state check answers conflict for a discarded draft; without its key it applies at once under a held narrowing;
//          the reads without their filter serve the discarded draft; without the line trigger a discarded draft's line changes.
//
// M7B-INVOICES-ISSUE-P1: this file proves 033 on the chain it was written for. Migration 034 widens the status CHECK, rebinds
// trg_invoice_draft_terminal to its own function and anchors 033's down, so 033's own postcondition, trigger functions, messages
// and rollback do not hold above it. The chain is therefore applied only THROUGH 033 (migrationsThrough.mjs, as the older suites
// do): a shared service's 034 (and 035 above it, M7B-INVOICES-VOID-P1) is rolled back first (it refuses over issued data, and none exists where this step runs) and put
// back, with its exact ledger row, by the teardown. 034 itself is proved by invoiceIssueRoutine and invoiceIssueHttp, and the
// discard over the full chain by invoiceDraftDiscardHttp.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file creates
// and destroys. Every fixture is synthetic and randomly suffixed; every id and key is made at run time. It rolls 033 back and
// re-applies it (IDD-13), so on a shared service it runs where suites that leave no discarded draft ran before it. It leaves
// 001-033 applied and recorded (and a shared service's 034 back, as it found it), both terminal triggers enabled ALWAYS, the issuer key row it found, and NO draft (discarded or
// open), line, audit subject or synthetic audit record, role row, session, mint-ledger row or login of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { TENANT_ORDERING, TENANT_ROLE_PERMISSION_DEFAULTS } from '../../server/platform-identity/permissionCatalog.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const mig = (name) => readFileSync(`${MIG_DIR}/${name}`, 'utf8');
const UP_028 = mig('028_m7b_invoice_drafts.up.sql');
const DOWN_028 = mig('028_m7b_invoice_drafts.down.sql');
const DOWN_029 = mig('029_m7b_invoice_draft_edit.down.sql');
const UP_030 = mig('030_m7b_invoice_edit_authority.up.sql');
const DOWN_030 = mig('030_m7b_invoice_edit_authority.down.sql');
const DOWN_031 = mig('031_m7b_invoice_create_authority.down.sql');
const UP_032 = mig('032_m7b_invoice_create_customers_authority.up.sql');
const DOWN_032 = mig('032_m7b_invoice_create_customers_authority.down.sql');
const UP_033 = mig('033_m7b_invoice_draft_discard.up.sql');
const DOWN_033 = mig('033_m7b_invoice_draft_discard.down.sql');
/** Each up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_032 = UP_032.slice(UP_032.lastIndexOf('do $$'));
const POSTCONDITION_033 = UP_033.slice(UP_033.lastIndexOf('do $$'));

/** The routine under test, by name: the single place it is named. */
const DISCARD_FN = 'tmpos_invoice_discard.m7b_invoice_draft_discard';
const DISCARD = `${DISCARD_FN}(text, uuid, uuid, uuid, bigint)`;
const PAGE_V2_FN = 'tmpos_invoice_discard.m7b_invoice_draft_page_v2';
const GET_V2_FN = 'tmpos_invoice_discard.m7b_invoice_draft_get_v2';
const PAGE_V2 = `${PAGE_V2_FN}(text, uuid, uuid, uuid, integer)`;
const GET_V2 = `${GET_V2_FN}(text, uuid, uuid, uuid)`;
const HEADER_GUARD = 'tmpos_invoice_discard.m7b_invoice_draft_terminal()';
const LINE_GUARD = 'tmpos_invoice_discard.m7b_invoice_draft_line_terminal()';
const ANCHOR = 'tmpos_invoice_discard.m7b_invoice_discard_prerequisites()';
const PAGE_028_FN = 'tmpos_invoice_draft.m7b_invoice_draft_page';
const GET_028_FN = 'tmpos_invoice_draft.m7b_invoice_draft_get';
const PAGE_028 = `${PAGE_028_FN}(text, uuid, uuid, uuid, integer)`;
const GET_028 = `${GET_028_FN}(text, uuid, uuid, uuid)`;
const CREATE_028 = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
/** 032's save and 030's edit, as the runtime calls them since 032. */
const CREATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_create_v3';
const UPDATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_update_v2';
const GUARD_CLASS = 530_030;
const MIGRATOR = { purpose: 'migration', migratorRef: 'idd-migrator', runtimeRef: 'idd-runtime' };
const LOCK_KEY = 529_533;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_idd_probe';
const HOUR = 3_600_000;
const ROLLBACK = new Error('idd: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const NULLS = Object.freeze({ o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: null });
const answer = (outcome) => ({ o_outcome: outcome, ...NULLS });
const REFUSED = answer('refused');
const EDITABLE = ['manager', 'technician', 'sales_staff'];
/** 030's seven tables in the writers' order: 033's up and down lock exactly these, first. */
const WRITERS_ORDER = ['public.store', 'tmpos_role.tenant_role_level', 'tmpos_role_edit.role_level_version', 'tmpos_customer.customer',
  'tmpos_invoice_draft.invoice_draft', 'tmpos_invoice_draft.invoice_draft_line', 'public.audit_event'];
const TERMINAL_TRIGGERS = [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']];

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (027's, 028's and 030's suites')
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

const TARGET = resolveDisposableTarget('IDD');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);
const connect = (user, max) => testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

const owner = connect(undefined, 6);
let runtime = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
/** IDD-13's synthetic audit records (request ids), removed by the teardown with the append-only trigger lifted. */
const SYNTHETIC_AUDITS = [];
let issuerKeyBefore;

/** The trusted executor over the migration files THROUGH 033 (034 and later hidden): this file proves 033 on the chain it was written for. */
async function trustedApply() {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    return await runTrustedApply({
      fsPort: portThrough(createNodeFsPort(MIG_DIR, MIG_REL), '033'), adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

const TRIGGER_MODE = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' };
/** Runs `fn()` inside `tx` with the named triggers lifted, each put back in exactly the mode it was found in before `tx` ends. */
async function withTriggersLifted(tx, triggers, fn) {
  const modes = [];
  for (const [rel, name] of triggers) {
    const [found] = await tx`select tgenabled as mode from pg_catalog.pg_trigger where tgrelid = ${rel}::regclass and tgname = ${name}`;
    if (found === undefined) continue;
    const restore = TRIGGER_MODE[found.mode];
    assert.ok(restore, `${name}'s mode is known: ${found.mode}`);
    modes.push([rel, name, restore]);
    await tx.unsafe(`alter table ${rel} disable trigger ${name}`);
  }
  const value = await fn();
  for (const [rel, name, restore] of modes) await tx.unsafe(`alter table ${rel} ${restore} ${name}`);
  return value;
}
const AUDIT_TRIGGER = [['public.audit_event', 'trg_audit_event_reject_mutation']];
/** Removes this suite's drafts (discarded and open), their lines and audit subjects — the terminal triggers lifted in this one transaction. */
async function removeDrafts(sql, drafts) {
  if (drafts.length === 0) return;
  await withTriggersLifted(sql, AUDIT_TRIGGER, () => sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`);
  await withTriggersLifted(sql, TERMINAL_TRIGGERS, async () => {
    await sql`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = any(${drafts}::uuid[])`;
    await sql`delete from tmpos_invoice_draft.invoice_draft where draft_id = any(${drafts}::uuid[])`;
  });
}
/** Everything this suite wrote that 033's, 029's or 028's rollback would refuse over: drafts, lines, subjects, synthetic audit records, role rows. */
async function cleanDrafts() {
  await owner.begin(RC, async (sql) => {
    if (SYNTHETIC_AUDITS.length > 0) {
      await withTriggersLifted(sql, AUDIT_TRIGGER, () => sql`delete from public.audit_event where request_id = any(${SYNTHETIC_AUDITS}::text[])`);
    }
    if (TENANTS.length === 0) return;
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    await removeDrafts(sql, drafts);
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    // A failed IDD-13 may have left 033 rolled back: the executor applies it again (no discarded draft can exist without it).
    await step(async () => {
      if (!(await owner`select exists (select 1 from public.schema_migrations where version = '033') as applied`)[0].applied) {
        const report = await trustedApply();
        assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
      }
    });
    await step(cleanDrafts);
    // M7B-INVOICES-ISSUE-P1: a shared service's 034 (and 035), rolled back at setup, is put back with its exact ledger row (nothing to do on a fresh cluster).
    await step(() => above033.restore());
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
          exists (select 1 from public.schema_migrations where version = '033') as ledger_033,
          pg_catalog.to_regprocedure(${DISCARD}) is not null as routine_033,
          (select pg_catalog.string_agg(g.tgname::text || ':' || g.tgenabled::text, ',' order by g.tgname) from pg_catalog.pg_trigger g
            where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and not g.tgisinternal) as triggers,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
          (select count(*) from public.audit_event where request_id = any(${SYNTHETIC_AUDITS}::text[]))::int as synthetic,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as roles,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, { ledger_033: true, routine_033: true,
        triggers: 'trg_invoice_draft_immutable:A,trg_invoice_draft_line_terminal:A,trg_invoice_draft_terminal:A',
        drafts: 0, subjects: 0, synthetic: 0, roles: 0, sessions: 0, login: false },
      'left as found: 033 applied and recorded, its triggers ALWAYS, nothing of this suite\'s retained');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IDD teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: the chain THROUGH 033 (001-033; a shared service's 034 rolled back first), a real non-owner runtime login, the issuer key installed by the owner
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
// 034 and 035 (when an earlier step of a shared service applied them) are rolled back through their own committed downs and ledger rows, newest
// first, and restored by the teardown; on a fresh cluster there is nothing above 033 and the restore does nothing.
const above033 = await rollBackAbove(owner, MIG_DIR, '033');
const applyReport = await trustedApply();
await owner.unsafe(`do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
end $$;`);
await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
runtime = connect(RUNTIME_LOGIN, 4);
issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
await installTestIssuerKey(owner, ISSUER_KEY);
const [{ me: ME }] = await owner`select current_user::text as me`;

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`idd-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IDD ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `idd-${label}-${SUFFIX}`;
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
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
/** The tenant owner's stored level for `role` on `domain` (020's table, as the role-level suites write it). */
const setLevel = (tenant, role, domain, level) => owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;

// ---------------------------------------------------------------------------
// the runtime login's calls, bound as the production adapters bind them
// ---------------------------------------------------------------------------

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:idd', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
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
const LINES = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 2, 4_500), line('Tempered glass', 3, 0)];
/** 032's save, as its mutator binds it: the new draft's id. */
async function create(key, store, tenant, customer, lines = LINES, { db = runtime } = {}) {
  const draft = randomUUID();
  const [row] = await db.unsafe(`select o_outcome from ${CREATE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [key, store, draft, tenant, customer, JSON.stringify(lines), String(sumOf(lines))]);
  assert.equal(row.o_outcome, 'applied', 'the draft saved');
  return draft;
}
/** 030's edit v2, as the update mutator binds it. */
async function edit(key, store, tenant, draft, version, customer, lines, { db = runtime } = {}) {
  return (await db.unsafe(`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version
    from ${UPDATE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::uuid, $7::text::jsonb, $8::bigint)`,
  [key, store, draft, tenant, String(version), customer, JSON.stringify(lines), String(sumOf(lines))])).map((r) => ({ ...r }));
}
/** The discard (DISCARD_FN; `fn` names another with the same signature), as the discard mutator binds it. */
async function discard(key, store, tenant, draft, version, { db = runtime, fn = DISCARD_FN } = {}) {
  return (await db.unsafe(`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version
    from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint)`,
  [key, store, draft, tenant, version === null ? null : String(version)])).map((r) => ({ ...r }));
}
/** The page (page_v2 unless `fn` names 028's): every column but the tenant and store. */
const page = async (key, tenant, store, after, limit = 51, { db = runtime, fn = PAGE_V2_FN } = {}) => (await db.unsafe(
  `select o_outcome, o_draft_id, o_customer_id, o_status, o_currency, o_line_count, o_subtotal_cents, o_created_at
     from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::integer)`, [key, tenant, store, after, limit])).map((r) => ({ ...r }));
/** The get (get_v2 unless `fn` names 028's): every column. */
const get = async (key, tenant, store, draft, { db = runtime, fn = GET_V2_FN } = {}) => (await db.unsafe(
  `select * from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid)`, [key, tenant, store, draft])).map((r) => ({ ...r }));
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? null }));
const done = (who, tenant, store, version) => ({ o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id,
  o_membership_id: who.memberships[0], o_version: String(version) });
/** 026's Invoices setter, the REAL writer, as the runtime login (or on `db`). */
const setInvoices = async (key, role, level, tenant, version, db = runtime) => (await db`select o_outcome, o_level, o_version
  from tmpos_role_invoice.m7a_invoice_role_level_set(${key}::text, ${role}::text, ${level}::text, ${tenant}::uuid, ${String(version)}::bigint)`)
  .map((r) => ({ ...r, o_version: r.o_version === null ? null : Number(r.o_version) }));
/** 021's Customers setter, the REAL writer of a Customers level, as the runtime login (or on `db`). */
const setCustomers = async (key, role, level, tenant, version, db = runtime) => (await db`select o_outcome, o_level, o_version
  from tmpos_role_edit.m7a_role_level_set_v2(${key}::text, ${role}::text, 'customers'::text, ${level}::text, ${tenant}::uuid, ${String(version)}::bigint)`)
  .map((r) => ({ ...r, o_version: r.o_version === null ? null : Number(r.o_version) }));
/** The edit counter of (tenant, role, domain) a setter reviews: 0 while there is no version row. */
const versionRowOf = async (tenant, role, domain) => Number((await owner`select coalesce((select v.version from tmpos_role_edit.role_level_version v
  where v.tenant_id = ${tenant} and v.role_id = ${role} and v.domain = ${domain}), 0)::text as version`)[0].version);

/** What a scope holds now: drafts, lines and role rows of its tenant(s); every audit record, outbox event and idempotency record. */
async function footprint(tenants, db = owner) {
  const [r] = await db`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as drafts,
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]) and status = 'discarded')::int as discarded,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as lines,
    (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${tenants}::uuid[]))::int as roles,
    (select count(*) from tmpos_role_edit.role_level_version where tenant_id = any(${tenants}::uuid[]))::int as versions,
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
/** The role rows and edit counters of a tenant exactly as stored, row versions (xmin) included. */
async function rolesOf(tenant, db = owner) {
  return {
    roles: (await db`select role_id, domain, level, xmin::text as xmin from tmpos_role.tenant_role_level where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
    versions: (await db`select role_id, domain, version::text as version, xmin::text as xmin from tmpos_role_edit.role_level_version where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
  };
}
const versionOf = async (draft) => Number((await owner`select version::text as v from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`)[0].v);
const statusOf = async (draft) => (await owner`select status from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`)[0]?.status ?? null;
/** Runs `fn` in an owner transaction that is always rolled back: { value } or the { code, message, detail } it raised. */
async function rolledBack(fn, isolation = RC) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? null }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}

// ---------------------------------------------------------------------------
// race levers: polling on observable lock state, never on time
// ---------------------------------------------------------------------------

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
 * `release('rollback')`. `pid` is its backend; `ready` turns true once `fn` has answered (so a blocked `fn` is never ready).
 */
function holding(db, fn) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = { pid: null, ready: false, release: (how) => release(how) };
  h.done = db.begin(RC, async (tx) => {
    h.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    const value = await fn(tx);
    h.ready = true;
    h.value = value;
    if ((await gate) === 'rollback') throw ROLLBACK;
    return value;
  }).then((value) => ({ outcome: 'committed', value }),
    (err) => (err === ROLLBACK ? { outcome: 'rolled back' } : { outcome: 'failed', code: err.code, message: String(err.message) }));
  h.done.then((out) => { h.out = out; });
  return h;
}
/** A statement on `db` in its own transaction (committed when it answers), its backend pid exposed as soon as it is known. */
function running(db, fn) {
  const r = { pid: null, out: undefined };
  r.done = db.begin(RC, async (tx) => {
    r.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    return fn(tx);
  }).then((value) => ({ outcome: 'committed', value }), (err) => ({ outcome: 'failed', code: err.code, message: String(err.message) }));
  r.done.then((out) => { r.out = out; });
  return r;
}
const blockedBy = async (pid, holder) => pid !== null && holder !== null
  && (await owner`select pg_catalog.pg_blocking_pids(${pid}) as b`)[0].b.includes(holder);
const queryOf = async (pid) => (await owner`select a.query from pg_catalog.pg_stat_activity a where a.pid = ${pid}`)[0]?.query ?? null;
/** The ungranted locks `pid` waits for, as [locktype, mode] pairs. */
const waitsFor = async (pid) => (await owner`select l.locktype::text as locktype, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted order by 1, 2`).map((r) => [r.locktype, r.mode]);
/** The database clock, in epoch milliseconds (the routine's own reading). */
const dbNow = async () => BigInt((await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint::text as now`)[0].now);
/** The guard key of (tenant, role) as the database computes it: hashtext of 'tenant/role', an int4 (pg_locks.objid, read as int4). */
const guardKey = async (tenant, role) => (await owner`select pg_catalog.hashtext(${tenant}::text || '/' || ${role}::text) as k`)[0].k;
/** Every guard-class advisory lock `pid` holds or waits for: class, key (int4), objsubid, mode, granted — ordered. */
const guardLocksOf = async (pid) => (await owner`select l.classid::int as class, l.objid::int as key, l.objsubid::int as sub, l.mode::text as mode, l.granted
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' and l.classid::int = ${GUARD_CLASS} order by 2, 4, 5`).map((r) => ({ ...r }));
/** The guard lock a participant holds or waits for on (tenant, role): ShareLock (a discard) or ExclusiveLock (a writer). */
const guardLock = async (tenant, role, mode, granted = true) => ({ class: GUARD_CLASS, key: await guardKey(tenant, role), sub: 2, mode, granted });
/** The header of `draft` is held FOR UPDATE by someone: a third session cannot take it NOWAIT. */
const headerHeld = async (draft) => (await errorOf(owner.begin(RC, (tx) => tx`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${draft} for update nowait`)))?.code === '55P03';
/** Neither a deadlock victim nor any other failure: the transaction ended as `how`. */
function finished(out, label, how = 'committed') {
  assert.notEqual(out.code, '40P01', `${label}: a deadlock (${JSON.stringify(out)})`);
  assert.equal(out.outcome, how, `${label}: ${JSON.stringify(out)}`);
  return out;
}
/** A routine's body as a migration file declares it (between its `as $$` and the closing `$$;`). */
const routineBody = (file, schema, name) => {
  const at = file.indexOf(`create function ${schema}.${name}(`);
  assert.ok(at >= 0, `${schema}.${name} is declared`);
  const start = file.indexOf('as $$', at) + 'as $$'.length;
  return file.slice(start, file.indexOf('$$;', start));
};
/** A routine's whole `create function ... $$;` statement in a migration file. */
const routineStatement = (file, schema, name) => {
  const at = file.indexOf(`create function ${schema}.${name}(`);
  assert.ok(at >= 0, `${schema}.${name} is declared`);
  return file.slice(at, file.indexOf('$$;', file.indexOf('as $$', at) + 5) + 3);
};
const codeOf = (body) => body.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
/** A routine's complete ACL in aclexplode form (the owner's implicit entry included). */
const grantsOf = async (signature, db = owner) => (await db`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.grantor::regrole::text as grantor, g.is_grantable as grantable
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${signature}::regprocedure`)
  .map((x) => ({ ...x })).sort((a, b) => (`${a.grantee}/${a.priv}` < `${b.grantee}/${b.priv}` ? -1 : 1));
const EXECUTE_BY = (...grantees) => grantees.map((grantee) => ({ grantee, priv: 'EXECUTE', grantor: ME, grantable: false }))
  .sort((a, b) => (a.grantee < b.grantee ? -1 : 1));
/** The catalog facts 033 and its rollback touch, without oids: the CHECK, triggers, indexes, the two schemas' functions and ACLs, 028's reads' ACLs, the ledger. */
async function catalogOf() {
  const [c] = await owner`select
    (select pg_catalog.string_agg(pg_catalog.format('%s %s %s', k.conname, k.convalidated, pg_catalog.pg_get_constraintdef(k.oid)), ' | ' order by k.conname)
       from pg_catalog.pg_constraint k where k.conrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
        and k.contype <> 'n') as constraints,
    (select pg_catalog.string_agg(pg_catalog.format('%s %s %s %s', g.tgrelid::regclass, g.tgname, g.tgtype, g.tgenabled), ' | ' order by g.tgname)
       from pg_catalog.pg_trigger g where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
        and not g.tgisinternal) as triggers,
    (select pg_catalog.string_agg(pg_catalog.pg_get_indexdef(x.indexrelid), ' | ' order by pg_catalog.pg_get_indexdef(x.indexrelid))
       from pg_catalog.pg_index x where x.indrelid = 'tmpos_invoice_draft.invoice_draft'::regclass) as indexes,
    (select pg_catalog.string_agg(pg_catalog.format('%s %s %s %s %s %s', p.oid::regprocedure, pg_catalog.md5(coalesce(p.prosrc, '')),
         p.proacl, p.proconfig, p.provolatile, p.prosecdef), ' | ' order by p.oid::regprocedure::text)
       from pg_catalog.pg_proc p where p.pronamespace in (select n.oid from pg_catalog.pg_namespace n
        where n.nspname in ('tmpos_invoice_draft', 'tmpos_invoice_edit', 'tmpos_invoice_discard'))) as functions,
    (select pg_catalog.string_agg(pg_catalog.format('%s %s', n.nspname, n.nspacl), ' | ' order by n.nspname)
       from pg_catalog.pg_namespace n where n.nspname in ('tmpos_invoice_draft', 'tmpos_invoice_edit', 'tmpos_invoice_discard')) as schemas,
    (select pg_catalog.string_agg(version || ':' || checksum, ',' order by version) from public.schema_migrations) as ledger`;
  return { ...c };
}

// ---------------------------------------------------------------------------
// the scenes
// ---------------------------------------------------------------------------

/** A fresh tenant, store, two customers, its store owner (store grant: no role row ever) and a manager with sessions, and `drafts` saved drafts. */
async function scene(label, { managerLevel, drafts = 1 } = {}) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label} ${SUFFIX}`);
  const C1 = await newCustomer(T, `${label}-1`);
  const C2 = await newCustomer(T, `${label}-2`);
  const boss = await actor(`${label}-owner`, [storeGrant(T, S, 'store_owner')]);
  const manager = await actor(`${label}-manager`, [storeGrant(T, S, 'manager')]);
  if (managerLevel !== undefined) await setLevel(T, 'manager', 'invoices', managerLevel);
  const kBoss = await mint(boss);
  const kManager = await mint(manager);
  const ids = [];
  for (let i = 0; i < drafts; i += 1) ids.push(await create(kBoss, S, T, C1));
  return { T, S, C1, C2, boss, manager, kBoss, kManager, draft: ids[0], drafts: ids };
}
/** Another actor of `role` at the scene's store, with a live session of its own. */
async function member(f, label, role) {
  const who = await actor(`${label}-${role}`, [storeGrant(f.T, f.S, role)]);
  return { who, key: await mint(who) };
}
/** A third operator: a store owner with EXACTLY ONE tenant-scope grant on `tenant` (026's and 021's setters demand it), with a live session. */
async function tenantOwner(tenant, label) {
  const who = await actor(`${label}-tenant-owner`, [tenantGrant(tenant, 'store_owner')]);
  return { who, key: await mint(who) };
}

// The tenant every 'tenant_mismatch' names (a real tenant the actors hold no grant in), and the catalog the cases rely on.
const T_OTHER = await newTenant('other');
assert.deepEqual(Object.fromEntries(EDITABLE.map((r) => [r, TENANT_ROLE_PERMISSION_DEFAULTS[r].invoices])), { manager: 'full', technician: 'view', sales_staff: 'create' },
  'the catalog\'s Invoices defaults the cases rely on');
assert.deepEqual([...TENANT_ORDERING], ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'], 'the catalog\'s ordering');

// ===========================================================================
// IDD-01..02: the migration, the surface and the ACL
// ===========================================================================

test('IDD-01 (DSC-17): 001-033 applied clean by the trusted executor, 033\'s ledger checksum its up bytes; 033\'s postcondition holds over the applied state and refuses every widening it names; the up is refused when applied again and when 032 is not applied; the down is refused outside READ COMMITTED', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 33 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.equal(ledger[32].checksum, createHash('sha256').update(UP_033).digest('hex'), '033\'s checksum is its up bytes');
  assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_033).simple())).code, undefined, 'the applied state satisfies 033\'s postcondition');
  for (const [label, widen] of [
    ['discard EXECUTE to PUBLIC', `grant execute on function ${DISCARD} to public`],
    ['discard EXECUTE to the audit writer', `grant execute on function ${DISCARD} to tmpos_audit_writer`],
    ['a grantable discard EXECUTE', `grant execute on function ${DISCARD} to tmpos_app with grant option`],
    ['discard EXECUTE revoked from tmpos_app', `revoke execute on function ${DISCARD} from tmpos_app`],
    ['page_v2 EXECUTE to anon', `grant execute on function ${PAGE_V2} to anon`],
    ['get_v2 EXECUTE revoked from tmpos_app', `revoke execute on function ${GET_V2} from tmpos_app`],
    ['028\'s page back to tmpos_app', `grant execute on function ${PAGE_028} to tmpos_app`],
    ['028\'s get back to tmpos_app', `grant execute on function ${GET_028} to tmpos_app`],
    ['the header guard to tmpos_app', `grant execute on function ${HEADER_GUARD} to tmpos_app`],
    ['the line guard to PUBLIC', `grant execute on function ${LINE_GUARD} to public`],
    ['the anchor to tmpos_app', `grant execute on function ${ANCHOR} to tmpos_app`],
    ['a stable discard', `alter function ${DISCARD} stable`],
    ['an invoker discard', `alter function ${DISCARD} security invoker`],
    ['a discard with row security on', `alter function ${DISCARD} reset row_security`],
    ['a volatile page_v2', `alter function ${PAGE_V2} volatile`],
    ['a definer header guard', `alter function ${HEADER_GUARD} security definer`],
    ['a line guard with row security on', `alter function ${LINE_GUARD} reset row_security`],
    ['the header trigger disabled', 'alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_terminal'],
    ['the line trigger enabled for origin sessions only', 'alter table tmpos_invoice_draft.invoice_draft_line enable trigger trg_invoice_draft_line_terminal'],
    ['the line trigger dropped', 'drop trigger trg_invoice_draft_line_terminal on tmpos_invoice_draft.invoice_draft_line'],
    ['029\'s trigger disabled', 'alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable'],
    ['a second header trigger', `create trigger extra before delete on tmpos_invoice_draft.invoice_draft for each row execute function ${HEADER_GUARD}`],
    ['a seventh function in the schema', 'create function tmpos_invoice_discard.extra() returns integer language sql as \'select 1\''],
    ['a relation in the schema', 'create table tmpos_invoice_discard.extra (x integer)'],
    ['USAGE on the schema to PUBLIC', 'grant usage on schema tmpos_invoice_discard to public'],
    ['CREATE on the schema to tmpos_app', 'grant create on schema tmpos_invoice_discard to tmpos_app'],
    ['a relaxed status CHECK', 'alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_status_chk, add constraint invoice_draft_status_chk check (status in (\'draft\', \'discarded\', \'issued\'))'],
    ['an unvalidated status CHECK', 'alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_status_chk, add constraint invoice_draft_status_chk check (status in (\'draft\', \'discarded\')) not valid'],
    ['the partial index dropped', 'drop index tmpos_invoice_draft.invoice_draft_open_page_idx'],
    ['the anchor without its dependencies', `create or replace function ${ANCHOR} returns boolean language sql stable set search_path = pg_catalog, pg_temp as 'select true'`],
    ['SELECT on the drafts to tmpos_app', 'grant select on tmpos_invoice_draft.invoice_draft to tmpos_app'],
    ['the schema comment dropped', 'comment on schema tmpos_invoice_discard is null'],
    ['the discard\'s comment dropped', `comment on function ${DISCARD} is null`],
  ]) {
    const out = await rolledBack(async (tx) => { await tx.unsafe(widen); await tx.unsafe(POSTCONDITION_033).simple(); });
    assert.equal(out.code, '55000', `${label}: refused (${JSON.stringify(out)})`);
    assert.match(out.message, /^migration 033 refused/, label);
  }
  const again = await rolledBack((tx) => tx.unsafe(UP_033).simple());
  assert.equal(again.code, '55000');
  assert.equal(again.message, 'migration 033 refused: schema tmpos_invoice_discard, the index invoice_draft_open_page_idx, a terminal trigger or the widened status CHECK already exists');
  // 032 not applied: 033 and 032 rolled back inside one rolled-back transaction (no discarded draft exists yet), then the up.
  const without032 = await rolledBack(async (tx) => { await tx.unsafe(DOWN_033).simple(); await tx.unsafe(DOWN_032).simple(); await tx.unsafe(UP_033).simple(); });
  assert.equal(without032.code, '55000', JSON.stringify(without032));
  assert.equal(without032.message, 'migration 033 refused: migration 032 must be applied first (its save routine, its Customers guard and trigger, and 030\'s edit routine, guard and trigger)');
  // A clean down and up inside one rolled-back transaction: the up's own postcondition passes there too.
  assert.equal((await rolledBack(async (tx) => { await tx.unsafe(DOWN_033).simple(); await tx.unsafe(UP_033).simple(); })).code, undefined, 'down then up, rolled back');
  const repeatable = await rolledBack((tx) => tx.unsafe(DOWN_033).simple(), 'isolation level repeatable read');
  assert.equal(repeatable.code, '55000');
  assert.equal(repeatable.message, 'migration 033 rollback refused: it must run under READ COMMITTED, so that its check sees every committed draft');
});

test('IDD-02 (DSC-17 DSC-15): the exact surface — six functions and their attributes; tmpos_app\'s one non-grantable EXECUTE on the discard and the two reads and nothing on the guards or the anchor; 028\'s page and get the owner\'s alone and refused to the login; both triggers BEFORE ROW INSERT UPDATE DELETE, ALWAYS; the CHECK and the index; the anchor\'s six dependency rows; the login\'s direct table writes refused', async () => {
  const fns = (await owner`select p.proname::text as name, l.lanname::text as lang, p.prosecdef as definer, p.provolatile::text as vol, p.proconfig as config,
      p.prorettype::regtype::text as returns, p.proowner = n.nspowner as owner_is_schema_owner, p.prosqlbody is not null as sql_body,
      pg_catalog.obj_description(p.oid, 'pg_proc') is not null as commented
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.pronamespace = 'tmpos_invoice_discard'::regnamespace order by p.proname::text collate "C"`).map((r) => ({ ...r }));
  const PINNED = ['search_path=pg_catalog, pg_temp', 'row_security=off'];
  assert.deepEqual(fns.map((f) => [f.name, f.lang, f.definer, f.vol, f.config, f.returns, f.owner_is_schema_owner, f.sql_body, f.commented]), [
    ['m7b_invoice_discard_prerequisites', 'sql', false, 's', ['search_path=pg_catalog, pg_temp'], 'boolean', true, true, true],
    ['m7b_invoice_draft_discard', 'plpgsql', true, 'v', PINNED, 'record', true, false, true],
    ['m7b_invoice_draft_get_v2', 'plpgsql', true, 's', PINNED, 'record', true, false, true],
    ['m7b_invoice_draft_line_terminal', 'plpgsql', false, 'v', PINNED, 'trigger', true, false, true],
    ['m7b_invoice_draft_page_v2', 'plpgsql', true, 's', PINNED, 'record', true, false, true],
    ['m7b_invoice_draft_terminal', 'plpgsql', false, 'v', ['search_path=pg_catalog, pg_temp'], 'trigger', true, false, true],
  ], 'schema tmpos_invoice_discard: exactly the six functions');
  assert.equal((await owner`select count(*)::int as n from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_discard'::regnamespace`)[0].n, 0, 'and no relation');
  for (const sig of [DISCARD, PAGE_V2, GET_V2]) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME, 'tmpos_app'), `${sig}: the owner's and tmpos_app's EXECUTE`);
  for (const sig of [HEADER_GUARD, LINE_GUARD, ANCHOR, PAGE_028, GET_028, CREATE_028]) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME), `${sig}: the owner's alone`);
  for (const [sig, login] of [[DISCARD, true], [PAGE_V2, true], [GET_V2, true], [HEADER_GUARD, false], [LINE_GUARD, false], [ANCHOR, false], [PAGE_028, false], [GET_028, false]]) {
    const [can] = await owner`select pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${sig}::regprocedure, 'EXECUTE') as login,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${sig}::regprocedure, 'EXECUTE') as audit,
      pg_catalog.has_function_privilege('anon', ${sig}::regprocedure, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${sig}::regprocedure, 'EXECUTE') as authenticated`;
    assert.deepEqual({ ...can }, { login, audit: false, anon: false, authenticated: false }, sig);
  }
  assert.deepEqual((await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.is_grantable as grantable
    from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
    where n.oid = 'tmpos_invoice_discard'::regnamespace and g.grantee <> n.nspowner order by 1, 2`).map((r) => ({ ...r })),
  [{ grantee: 'tmpos_app', priv: 'USAGE', grantable: false }], 'the schema\'s one grant beyond its owner\'s: USAGE to tmpos_app');
  // The login: 028's two reads, the guards and the anchor refused (42501); the v2 reads and the discard it executes.
  const f = await scene('surface');
  for (const [label, call] of [
    ['028\'s page', () => page(f.kBoss, f.T, f.S, null, 51, { fn: PAGE_028_FN })],
    ['028\'s get', () => get(f.kBoss, f.T, f.S, f.draft, { fn: GET_028_FN })],
    ['the header guard', () => runtime`select tmpos_invoice_discard.m7b_invoice_draft_terminal()`],
    ['the line guard', () => runtime`select tmpos_invoice_discard.m7b_invoice_draft_line_terminal()`],
    ['the anchor', () => runtime`select tmpos_invoice_discard.m7b_invoice_discard_prerequisites()`],
  ]) assert.equal((await errorOf(call()))?.code, '42501', `the login cannot execute ${label}`);
  assert.equal((await page(f.kBoss, f.T, f.S, null)).length, 1, 'page_v2 it executes');
  assert.equal((await get(f.kBoss, f.T, f.S, f.draft)).length, LINES.length, 'get_v2 it executes');
  // The enforcement boundary: the login holds no privilege on either table, so every direct write is refused before any trigger.
  for (const [label, sql] of [
    ['an UPDATE of the header', () => runtime`update tmpos_invoice_draft.invoice_draft set status = 'discarded', version = version + 1 where draft_id = ${f.draft}`],
    ['a DELETE of the header', () => runtime`delete from tmpos_invoice_draft.invoice_draft where draft_id = ${f.draft}`],
    ['an INSERT of a line', () => runtime`insert into tmpos_invoice_draft.invoice_draft_line (draft_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
      values (${f.draft}, ${f.T}, ${f.S}, 9, 'x', 1, 1, 1)`],
    ['a DELETE of a line', () => runtime`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = ${f.draft}`],
    ['a SELECT of the header', () => runtime`select status from tmpos_invoice_draft.invoice_draft where draft_id = ${f.draft}`],
  ]) assert.equal((await errorOf(sql()))?.code, '42501', `the login: ${label} refused`);
  // The triggers. tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31; 029's ROW 1 + BEFORE 2 + UPDATE 16 = 19.
  assert.deepEqual((await owner`select g.tgrelid::regclass::text as rel, g.tgname::text as name, g.tgfoid::regprocedure::text as fn, g.tgtype::int as type,
      g.tgenabled::text as enabled, g.tgattr::text as cols, g.tgqual is null as no_when
    from pg_catalog.pg_trigger g where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
      and not g.tgisinternal order by g.tgname::text collate "C"`).map((r) => ({ ...r })), [
    { rel: 'tmpos_invoice_draft.invoice_draft', name: 'trg_invoice_draft_immutable', fn: 'tmpos_invoice_draft.m7b_invoice_draft_immutable()', type: 19, enabled: 'A', cols: '', no_when: true },
    { rel: 'tmpos_invoice_draft.invoice_draft_line', name: 'trg_invoice_draft_line_terminal', fn: LINE_GUARD, type: 31, enabled: 'A', cols: '', no_when: true },
    { rel: 'tmpos_invoice_draft.invoice_draft', name: 'trg_invoice_draft_terminal', fn: HEADER_GUARD, type: 31, enabled: 'A', cols: '', no_when: true },
  ]);
  const [shape] = await owner`select
    (select pg_catalog.pg_get_constraintdef(k.oid) from pg_catalog.pg_constraint k where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk' and k.convalidated) as chk,
    pg_catalog.pg_get_indexdef('tmpos_invoice_draft.invoice_draft_open_page_idx'::regclass) as idx`;
  assert.deepEqual({ ...shape }, { chk: 'CHECK ((status = ANY (ARRAY[\'draft\'::text, \'discarded\'::text])))',
    idx: 'CREATE INDEX invoice_draft_open_page_idx ON tmpos_invoice_draft.invoice_draft USING btree (tenant_id, store_id, created_at DESC, draft_id DESC) WHERE (status = \'draft\'::text)' });
  // The anchor's recorded dependencies: one NORMAL row per predecessor (beside its schema's).
  assert.deepEqual((await owner`select case when d.refclassid = 'pg_catalog.pg_proc'::regclass then d.refobjid::regprocedure::text else d.refobjid::regclass::text end as ref, d.deptype::text as type
    from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = ${ANCHOR}::regprocedure
      and d.refclassid in ('pg_catalog.pg_proc'::regclass, 'pg_catalog.pg_class'::regclass) order by 1`).map((r) => ({ ...r })), [
    { ref: 'tmpos_invoice_draft.invoice_draft', type: 'n' },
    { ref: 'tmpos_invoice_draft.invoice_draft_line', type: 'n' },
    { ref: 'tmpos_invoice_draft.m7b_invoice_draft_immutable()', type: 'n' },
    { ref: 'tmpos_invoice_edit.m7b_invoice_draft_create_v3(text,uuid,uuid,uuid,uuid,jsonb,bigint)', type: 'n' },
    { ref: 'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint)', type: 'n' },
    { ref: 'tmpos_invoice_edit.m7b_invoice_level_guard()', type: 'n' },
  ], 'the anchor depends on exactly the six predecessors it names');
  assert.equal((await owner`select tmpos_invoice_discard.m7b_invoice_discard_prerequisites() as v`)[0].v, true, 'the anchor answers true');
});

// ===========================================================================
// IDD-03..05: the decisions at the routine
// ===========================================================================

test('IDD-03 (DSC-02): the Manage threshold at the routine — a manager stored at none, view, create or edit is refused, at manage, approve or full applies; store_owner applies; the default manager applies; the default technician and sales_staff are refused; a technician raised to Manage applies', async () => {
  const f = await scene('threshold', { drafts: 6 });
  const tech = await member(f, 'threshold', 'technician');
  const sales = await member(f, 'threshold', 'sales_staff');
  const pending = [...f.drafts];
  // The default manager (no stored row: catalog Full).
  assert.deepEqual((await rolesOf(f.T)).roles, [], 'no role row at all');
  let d = pending.shift();
  assert.deepEqual(await discard(f.kManager, f.S, f.T, d, 1), [done(f.manager, f.T, f.S, 2)], 'the default manager (Full) applies');
  // The default technician (View) and sales_staff (Create): refused, nothing written.
  d = pending[0];
  const before = await stateOf(d);
  const prints = await footprint([f.T]);
  assert.deepEqual(await discard(tech.key, f.S, f.T, d, 1), [REFUSED], 'the default technician (View) is refused');
  assert.deepEqual(await discard(sales.key, f.S, f.T, d, 1), [REFUSED], 'the default sales_staff (Create) is refused');
  for (const level of ['none', 'view', 'create', 'edit']) {
    await setLevel(f.T, 'manager', 'invoices', level);
    assert.deepEqual(await discard(f.kManager, f.S, f.T, d, 1), [REFUSED], `a manager stored at ${level} is refused`);
  }
  assert.deepEqual(await stateOf(d), before, 'the refusals wrote nothing to the draft');
  const business = ({ drafts, discarded, lines, audits, events, records }) => ({ drafts, discarded, lines, audits, events, records });
  assert.deepEqual(business(await footprint([f.T])), business(prints), 'and nothing else (the owner\'s own level and version rows aside)');
  for (const level of ['manage', 'approve', 'full']) {
    await setLevel(f.T, 'manager', 'invoices', level);
    d = pending.shift();
    assert.deepEqual(await discard(f.kManager, f.S, f.T, d, 1), [done(f.manager, f.T, f.S, 2)], `a manager stored at ${level} applies`);
  }
  d = pending.shift();
  assert.deepEqual(await discard(f.kBoss, f.S, f.T, d, 1), [done(f.boss, f.T, f.S, 2)], 'store_owner (Full, never stored) applies');
  await setLevel(f.T, 'technician', 'invoices', 'manage');
  d = pending.shift();
  assert.deepEqual(await discard(tech.key, f.S, f.T, d, 1), [done(tech.who, f.T, f.S, 2)], 'a technician the owner raised to Manage applies');
  assert.deepEqual(pending, []);
  assert.equal((await footprint([f.T])).discarded, 6, 'six drafts discarded');
});

test('IDD-04 (DSC-06): a stale version conflicts and writes nothing — the header\'s row, xmin and ctid, every line, no role or version row, no audit, outbox or idempotency row; the current version then applies, stepping the version once and changing nothing else', async () => {
  const f = await scene('stale');
  assert.deepEqual(await edit(f.kBoss, f.S, f.T, f.draft, 1, f.C2, [line('Edited once', 2, 50)]), [done(f.boss, f.T, f.S, 2)], 'an edit moved the draft to version 2');
  const before = await stateOf(f.draft);
  const prints = await footprint([f.T]);
  const roles = await rolesOf(f.T);
  for (const stale of [1, 3, 99]) {
    for (const [who, key] of [['store owner', f.kBoss], ['manager (no stored row)', f.kManager]]) {
      assert.deepEqual(await discard(key, f.S, f.T, f.draft, stale), [answer('conflict')], `${who} at version ${stale}: conflict`);
    }
  }
  assert.deepEqual(await stateOf(f.draft), before, 'the header (row, xmin, ctid) and every line unchanged');
  assert.deepEqual(await footprint([f.T]), prints, 'no row of any kind written');
  assert.deepEqual(await rolesOf(f.T), roles, 'no role row, no version row');
  const [h0] = (await owner`select to_jsonb(d) - 'status' - 'version' as rest from tmpos_invoice_draft.invoice_draft d where draft_id = ${f.draft}`);
  assert.deepEqual(await discard(f.kManager, f.S, f.T, f.draft, 2), [done(f.manager, f.T, f.S, 3)], 'the current version applies: 2 -> 3');
  const [h1] = (await owner`select to_jsonb(d) - 'status' - 'version' as rest, d.status, d.version::text as version from tmpos_invoice_draft.invoice_draft d where draft_id = ${f.draft}`);
  assert.deepEqual([h1.status, h1.version], ['discarded', '3']);
  assert.deepEqual(h1.rest, h0.rest, 'every other header column unchanged');
  assert.deepEqual((await stateOf(f.draft)).lines, before.lines, 'every line unchanged (row, xmin, ctid)');
  const after = await footprint([f.T]);
  assert.deepEqual(after, { ...prints, discarded: prints.discarded + 1 }, 'the routine wrote the header alone: no line, role, audit, outbox or idempotency row');
  assert.deepEqual(await rolesOf(f.T), roles, 'and no role or version row');
});

test('IDD-05 (DSC-10, DA-36): a discarded draft answers invalid_state whatever version is named, for the store owner and the manager, writing nothing; the edit answers invalid_state; every refusal writes nothing and makes no role row; every argument refused with 22023; outside READ COMMITTED 55000', async () => {
  const f = await scene('terminal', { drafts: 2 });
  const other = await scene('terminal-other');
  const otherStore = await newStore(f.T, `terminal second ${SUFFIX}`);
  assert.deepEqual(await discard(f.kBoss, f.S, f.T, f.draft, 1), [done(f.boss, f.T, f.S, 2)]);
  const before = await stateOf(f.draft);
  const prints = await footprint([f.T, other.T]);
  const roles = await rolesOf(f.T);
  for (const version of [2, 1, 3, 9_007_199_254_740_990]) {
    for (const [who, key] of [['store owner', f.kBoss], ['manager', f.kManager]]) {
      assert.deepEqual(await discard(key, f.S, f.T, f.draft, version), [answer('invalid_state')], `${who}, version ${version}: invalid_state (before the version)`);
    }
  }
  assert.deepEqual(await edit(f.kBoss, f.S, f.T, f.draft, 2, f.C1, LINES), [answer('invalid_state')], 'the edit of a discarded draft: invalid_state');
  // Every refusal of the routine, and not_found alike for a missing, another store's and another tenant's draft.
  const open = f.drafts[1];
  const draftElsewhere = await create(f.kBoss, f.S, f.T, f.C1); // a draft of THIS store, named at another store below
  await setLevel(f.T, 'manager', 'invoices', 'edit');
  for (const [label, call, expected] of [
    ['a manager at Edit', () => discard(f.kManager, f.S, f.T, open, 1), REFUSED],
    ['a store with no grant', () => discard(f.kBoss, otherStore, f.T, open, 1), REFUSED],
    ['an unknown session', () => discard(newKey(), f.S, f.T, open, 1), REFUSED],
    ['tenant_mismatch', () => discard(f.kBoss, f.S, T_OTHER, open, 1), answer('tenant_mismatch')],
    ['a missing draft', () => discard(f.kBoss, f.S, f.T, randomUUID(), 1), answer('not_found')],
    ['another tenant\'s draft', () => discard(f.kBoss, f.S, f.T, other.draft, 1), answer('not_found')],
  ]) assert.deepEqual(await call(), [expected], label);
  // Another store's draft: the actor's grant at that other store names this store's draft id.
  const elsewhere = await actor('terminal-two-stores', [storeGrant(f.T, otherStore, 'store_owner')]);
  assert.deepEqual(await discard(await mint(elsewhere), otherStore, f.T, draftElsewhere, 1), [answer('not_found')], 'another store\'s draft: not_found');
  // Read-only standing refuses (a write status is required of the store, the tenant and the account), and a suspended grant.
  const ro = await scene('terminal-read-only', { drafts: 1 });
  for (const [label, set, reset] of [
    ['a read-only store', () => owner`update store set status = 'read_only' where store_id = ${ro.S}`, () => owner`update store set status = 'active' where store_id = ${ro.S}`],
    ['a read-only tenant', () => owner`update tenant set status = 'read_only' where tenant_id = ${ro.T}`, () => owner`update tenant set status = 'active' where tenant_id = ${ro.T}`],
    ['a suspended grant', () => owner`update user_membership set status = 'suspended' where membership_id = ${ro.boss.memberships[0]}`,
      () => owner`update user_membership set status = 'active' where membership_id = ${ro.boss.memberships[0]}`],
  ]) {
    await set();
    const roBefore = await stateOf(ro.draft);
    assert.deepEqual(await discard(await mint(ro.boss), ro.S, ro.T, ro.draft, 1), [REFUSED], `${label}: refused`);
    assert.deepEqual(await stateOf(ro.draft), roBefore, `${label}: nothing written`);
    await reset();
  }
  assert.deepEqual(await discard(await mint(ro.boss), ro.S, ro.T, ro.draft, 1), [done(ro.boss, ro.T, ro.S, 2)], 'restored to writable: the discard applies');
  await owner`delete from tmpos_role.tenant_role_level where tenant_id = ${f.T}`;
  assert.deepEqual(await stateOf(f.draft), before, 'the discarded draft unchanged');
  assert.deepEqual(await footprint([f.T, other.T]), { ...prints, drafts: prints.drafts + 1, lines: prints.lines + LINES.length },
    'nothing written but the one draft this case saved (the owner\'s Edit row removed again)');
  assert.deepEqual(await rolesOf(f.T), roles, 'no role or version row made by any refusal');
  assert.equal(await statusOf(open), 'draft', 'the open draft stays open');
  // Arguments: a fixed message naming the field, never the value; nothing read, locked or written.
  for (const [label, args, message] of [
    ['a null session key', [null, f.S, f.T, open, 1], 'migration 033 discard: an argument is malformed'],
    ['a malformed session key', ['bad key', f.S, f.T, open, 1], 'migration 033 discard: an argument is malformed'],
    ['a null store', [f.kBoss, null, f.T, open, 1], 'migration 033 discard: an argument is malformed'],
    ['a null draft', [f.kBoss, f.S, f.T, null, 1], 'migration 033 discard: an argument is malformed'],
    ['a null tenant', [f.kBoss, f.S, null, open, 1], 'migration 033 discard: an argument is malformed'],
    ['a null version', [f.kBoss, f.S, f.T, open, null], 'migration 033 discard: the expected version is not one the draft table can advance'],
    ['version 0', [f.kBoss, f.S, f.T, open, 0], 'migration 033 discard: the expected version is not one the draft table can advance'],
    ['version 2^53 - 1', [f.kBoss, f.S, f.T, open, 9_007_199_254_740_991], 'migration 033 discard: the expected version is not one the draft table can advance'],
  ]) {
    const [key, store, tenant, draft, version] = args;
    const err = await errorOf(discard(key, store, tenant, draft, version));
    assert.deepEqual([err?.code, err?.message], ['22023', message], label);
  }
  let rr = null;
  await assert.rejects(runtime.begin('isolation level repeatable read', async (tx) => {
    rr = await errorOf(discard(f.kBoss, f.S, f.T, open, 1, { db: tx }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  assert.deepEqual([rr?.code, rr?.message], ['55000', 'migration 033 discard: it must run under READ COMMITTED, so that its checks see what committed before its locks']);
  assert.equal(await statusOf(open), 'draft');
});

// ===========================================================================
// IDD-06..08: orderings, held authority and the clock
// ===========================================================================

test('IDD-06 (DSC-07 DSC-08): edit and discard serialize on the header — the edit first: the discard waits, then conflicts (rolled back: it applies); the discard first: the edit waits, then answers invalid_state (rolled back: it applies); two discards: the second waits, then invalid_state', async () => {
  const f = await scene('race', { managerLevel: 'full', drafts: 5 });
  const NEXT = [line('Raced', 1, 1)];
  // The edit (manager) first, the discard (store owner: another actor, so 016's hold does not serialize them) behind it.
  for (const [draft, ending] of [[f.drafts[0], 'commit'], [f.drafts[1], 'rollback']]) {
    const editing = holding(runtime, (tx) => edit(f.kManager, f.S, f.T, draft, 1, f.C2, NEXT, { db: tx }));
    let discarding = null;
    try {
      await until(() => editing.ready, `${ending}: the edit applied, uncommitted`);
      discarding = running(runtime, (tx) => discard(f.kBoss, f.S, f.T, draft, 1, { db: tx }));
      await until(() => blockedBy(discarding.pid, editing.pid), `${ending}: the discard waits on the header behind the edit`);
      assert.deepEqual(await waitsFor(discarding.pid), [['transactionid', 'ShareLock']], `${ending}: a row lock wait (the header FOR UPDATE)`);
      assert.match(await queryOf(discarding.pid), /m7b_invoice_draft_discard/);
      editing.release(ending);
      finished(await editing.done, `${ending}: the edit`, ending === 'commit' ? 'committed' : 'rolled back');
      const out = finished(await discarding.done, `${ending}: the discard`);
      if (ending === 'commit') {
        assert.deepEqual(out.value, [answer('conflict')], 'the edit committed v2: the discard naming v1 conflicts, never not_found');
        assert.deepEqual([await statusOf(draft), await versionOf(draft)], ['draft', 2], 'the edit\'s change stands');
      } else {
        assert.deepEqual(out.value, [done(f.boss, f.T, f.S, 2)], 'the edit rolled back: the discard applies');
      }
    } finally {
      editing.release('rollback');
      await editing.done;
      if (discarding !== null) await discarding.done;
    }
  }
  // The discard (store owner) first, the edit (manager) behind it.
  for (const [draft, ending] of [[f.drafts[2], 'commit'], [f.drafts[3], 'rollback']]) {
    const discarding = holding(runtime, (tx) => discard(f.kBoss, f.S, f.T, draft, 1, { db: tx }));
    let editing = null;
    try {
      await until(() => discarding.ready, `${ending}: the discard applied, uncommitted`);
      assert.deepEqual(discarding.value, [done(f.boss, f.T, f.S, 2)]);
      editing = running(runtime, (tx) => edit(f.kManager, f.S, f.T, draft, 1, f.C2, NEXT, { db: tx }));
      await until(() => blockedBy(editing.pid, discarding.pid), `${ending}: the edit waits on the header behind the discard`);
      assert.deepEqual(await waitsFor(editing.pid), [['transactionid', 'ShareLock']]);
      discarding.release(ending);
      finished(await discarding.done, `${ending}: the discard`, ending === 'commit' ? 'committed' : 'rolled back');
      const out = finished(await editing.done, `${ending}: the edit`);
      assert.deepEqual(out.value, ending === 'commit' ? [answer('invalid_state')] : [done(f.manager, f.T, f.S, 2)],
        ending === 'commit' ? 'the discard committed: the edit answers invalid_state' : 'the discard rolled back: the edit applies');
    } finally {
      discarding.release('rollback');
      await discarding.done;
      if (editing !== null) await editing.done;
    }
  }
  // Two discards of one draft by two actors: the second waits on the header, then answers invalid_state; one transition.
  const draft = f.drafts[4];
  const first = holding(runtime, (tx) => discard(f.kBoss, f.S, f.T, draft, 1, { db: tx }));
  let second = null;
  try {
    await until(() => first.ready, 'the first discard applied, uncommitted');
    second = running(runtime, (tx) => discard(f.kManager, f.S, f.T, draft, 1, { db: tx }));
    await until(() => blockedBy(second.pid, first.pid), 'the second discard waits on the header');
    first.release('commit');
    finished(await first.done, 'the first discard');
    assert.deepEqual(finished(await second.done, 'the second discard').value, [answer('invalid_state')], 'the second: invalid_state');
    assert.equal(await versionOf(draft), 2, 'exactly one transition');
  } finally {
    first.release('rollback');
    await first.done;
    if (second !== null) await second.done;
  }
});

test('IDD-07 (DSC-03): an owner\'s narrowing Manage -> Edit held uncommitted makes the discard wait on the role\'s KEY after it took the header; committed it is REFUSED with nothing written, rolled back it applies; a widening Manage -> Full committed while it waits applies; the discard first, the narrowing waits on the key and governs only later discards', async () => {
  const f = await scene('narrow', { managerLevel: 'manage', drafts: 5 });
  const change = (level) => async (tx) => {
    await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices' for update`;
    return tx`update tmpos_role.tenant_role_level set level = ${level}, updated_at = now()
      where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices' returning level`;
  };
  for (const [draft, level, ending, expected] of [
    [f.drafts[0], 'edit', 'commit', 'refused'],
    [f.drafts[1], 'edit', 'rollback', 'applied'],
    [f.drafts[2], 'full', 'commit', 'applied'],
  ]) {
    await setLevel(f.T, 'manager', 'invoices', 'manage');
    const label = `${level} ${ending}`;
    const writer = holding(owner, change(level));
    let discarding = null;
    try {
      await until(() => writer.ready, `${label}: the level change held, uncommitted`);
      assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')], `${label}: the writer holds the key EXCLUSIVE`);
      const before = await stateOf(draft);
      const prints = await footprint([f.T]);
      discarding = running(runtime, (tx) => discard(f.kManager, f.S, f.T, draft, 1, { db: tx }));
      await until(() => blockedBy(discarding.pid, writer.pid), `${label}: the discard waits behind the writer`);
      assert.deepEqual(await waitsFor(discarding.pid), [['advisory', 'ShareLock']], `${label}: on the advisory key, SHARED — not a role row`);
      assert.deepEqual(await guardLocksOf(discarding.pid), [await guardLock(f.T, 'manager', 'ShareLock', false)], `${label}: the manager's key, ungranted`);
      assert.equal(await headerHeld(draft), true, `${label}: having already taken the header FOR UPDATE`);
      writer.release(ending);
      finished(await writer.done, `${label}: the writer`, ending === 'commit' ? 'committed' : 'rolled back');
      const out = finished(await discarding.done, `${label}: the discard`);
      if (expected === 'refused') {
        assert.deepEqual(out.value, [REFUSED], `${label}: refused by the fresh read after the key`);
        assert.deepEqual(await stateOf(draft), before, `${label}: nothing written`);
        assert.deepEqual(await footprint([f.T]), prints, `${label}: no row of any kind`);
      } else {
        assert.deepEqual(out.value, [done(f.manager, f.T, f.S, 2)], `${label}: applied`);
      }
    } finally {
      writer.release('rollback');
      await writer.done;
      if (discarding !== null) await discarding.done;
    }
  }
  // The discard first: it holds the key SHARED until its COMMIT; the narrowing waits on it, and governs only later discards.
  await setLevel(f.T, 'manager', 'invoices', 'manage');
  const discarding = holding(runtime, (tx) => discard(f.kManager, f.S, f.T, f.drafts[3], 1, { db: tx }));
  let writer = null;
  try {
    await until(() => discarding.ready, 'the discard applied, uncommitted');
    assert.deepEqual(await guardLocksOf(discarding.pid), [await guardLock(f.T, 'manager', 'ShareLock')], 'the discard holds the key SHARED');
    writer = running(owner, change('edit'));
    await until(() => blockedBy(writer.pid, discarding.pid), 'the narrowing waits behind the discard');
    assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], 'on the key, EXCLUSIVE');
    discarding.release('commit');
    assert.deepEqual(finished(await discarding.done, 'the discard').value, [done(f.manager, f.T, f.S, 2)]);
    finished(await writer.done, 'the narrowing');
  } finally {
    discarding.release('rollback');
    await discarding.done;
    if (writer !== null) await writer.done;
  }
  assert.deepEqual(await discard(f.kManager, f.S, f.T, f.drafts[4], 1), [REFUSED], 'the next discard meets the narrowing');
});

test('IDD-08 (DSC-04; real database clock): an 8 s session that expires while the discard waits on the header, and one that expires while it waits on the key, are REFUSED by the clock read after the wait — nothing written, no role row', async () => {
  const headerCase = async () => {
    const f = await scene('late-header');
    const key = await mint(f.manager, { lifetime: 8_000 });
    const [{ expires }] = await owner`select expires_at::text as expires from tmpos_session.session where session_key = ${key}`;
    const holder = holding(owner, (tx) => tx`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${f.draft} for update`);
    let discarding = null;
    try {
      await until(() => holder.ready, 'header: the header held FOR UPDATE');
      const before = await stateOf(f.draft);
      const prints = await footprint([f.T]);
      discarding = running(runtime, (tx) => discard(key, f.S, f.T, f.draft, 1, { db: tx }));
      await until(() => blockedBy(discarding.pid, holder.pid), 'header: the discard waits on the header');
      assert.deepEqual(await waitsFor(discarding.pid), [['transactionid', 'ShareLock']], 'header: a row lock wait');
      assert.ok(await dbNow() < BigInt(expires), 'header: the session is live at the barrier');
      await until(async () => (await dbNow()) >= BigInt(expires), 'header: the session expired while the discard waited', 20_000);
      holder.release('rollback');
      await holder.done;
      assert.deepEqual(finished(await discarding.done, 'header: the discard').value, [REFUSED], 'header: refused by the clock after the header');
      assert.deepEqual(await stateOf(f.draft), before, 'header: nothing written');
      assert.deepEqual(await footprint([f.T]), prints, 'header: no row of any kind');
    } finally {
      holder.release('rollback');
      await holder.done;
      if (discarding !== null) await discarding.done;
    }
  };
  const keyCase = async () => {
    const f = await scene('late-key');
    const key = await mint(f.manager, { lifetime: 8_000 });
    const [{ expires }] = await owner`select expires_at::text as expires from tmpos_session.session where session_key = ${key}`;
    // A writer's uncommitted FIRST INSERT of a non-NULL level (030's trigger: the key EXCLUSIVE). Rolled back, the default
    // (Full) governs again, so nothing but the clock read after the wait can refuse the discard.
    const holder = holding(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${f.T}, 'manager', 'invoices', 'full', now())`);
    let discarding = null;
    try {
      await until(() => holder.ready, 'key: the writer\'s first insertion held');
      assert.deepEqual(await guardLocksOf(holder.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')]);
      const before = await stateOf(f.draft);
      const prints = await footprint([f.T]);
      discarding = running(runtime, (tx) => discard(key, f.S, f.T, f.draft, 1, { db: tx }));
      await until(() => blockedBy(discarding.pid, holder.pid), 'key: the discard waits on the key');
      assert.deepEqual(await waitsFor(discarding.pid), [['advisory', 'ShareLock']], 'key: on the advisory key');
      assert.equal(await headerHeld(f.draft), true, 'key: holding the header');
      assert.ok(await dbNow() < BigInt(expires), 'key: the session is live at the barrier');
      await until(async () => (await dbNow()) >= BigInt(expires), 'key: the session expired while the discard waited', 20_000);
      holder.release('rollback');
      await holder.done;
      assert.deepEqual(finished(await discarding.done, 'key: the discard').value, [REFUSED], 'key: refused by the clock after the key');
      assert.deepEqual(await stateOf(f.draft), before, 'key: nothing written');
      assert.deepEqual(await footprint([f.T]), prints, 'key: no row of any kind');
      assert.deepEqual(await rolesOf(f.T), { roles: [], versions: [] }, 'key: no role row, no version row');
    } finally {
      holder.release('rollback');
      await holder.done;
      if (discarding !== null) await discarding.done;
    }
  };
  await Promise.all([headerCase(), keyCase()]);
});

// ===========================================================================
// IDD-09..10: the terminal guards and the reads
// ===========================================================================

test('IDD-09 (DSC-16): the terminal guards through owner paths and as a replica — discarded -> draft, any update of a discarded header, a status change with another column change, a version step other than +1, a line insert, update or delete under a discarded header, a delete of a discarded header and an insert of a discarded header are refused (23001); an open draft stays editable and deletable; an owner\'s line write waits for a discard holding the header and is refused once it commits', async () => {
  const f = await scene('guards', { drafts: 4 });
  const [discarded, open, held, heldBack] = f.drafts;
  assert.deepEqual(await discard(f.kBoss, f.S, f.T, discarded, 1), [done(f.boss, f.T, f.S, 2)]);
  const TERMINAL = 'migration 033: a discarded invoice draft is terminal and admits no update';
  const MOVES = 'migration 033: an open invoice draft moves only to discarded, at the next version, with nothing else changed';
  const LINE = 'migration 033: a line of a discarded invoice draft never changes';
  const header = (draft, set) => `update tmpos_invoice_draft.invoice_draft set ${set} where draft_id = '${draft}'`;
  const before = await stateOf(discarded);
  for (const replica of [false, true]) {
    for (const [label, sql, code, message] of [
      ['discarded -> draft', header(discarded, "status = 'draft', version = version + 1"), '23001', TERMINAL],
      ['discarded -> draft, version kept', header(discarded, "status = 'draft'"), '23001', TERMINAL],
      ['a no-op update of a discarded header', header(discarded, 'version = version'), '23001', TERMINAL],
      ['a customer change of a discarded header', header(discarded, `customer_id = '${f.C2}'`), '23001', TERMINAL],
      ['a second discard by hand', header(discarded, "status = 'discarded', version = version + 1"), '23001', TERMINAL],
      ['draft -> discarded with the subtotal changed', header(open, "status = 'discarded', version = version + 1, subtotal_cents = subtotal_cents + 1"), '23001', MOVES],
      ['draft -> discarded with the customer changed', header(open, `status = 'discarded', version = version + 1, customer_id = '${f.C2}'`), '23001', MOVES],
      ['draft -> discarded with the line count changed', header(open, "status = 'discarded', version = version + 1, line_count = 1"), '23001', MOVES],
      ['draft -> discarded at the same version', header(open, "status = 'discarded'"), '23001', MOVES],
      ['draft -> discarded two versions on', header(open, "status = 'discarded', version = version + 2"), '23001', null],
      ['a line inserted under a discarded header', `insert into tmpos_invoice_draft.invoice_draft_line (draft_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
        values ('${discarded}', '${f.T}', '${f.S}', 9, 'Added', 1, 1, 1)`, '23001', LINE],
      ['a line updated under a discarded header', `update tmpos_invoice_draft.invoice_draft_line set description = 'Changed' where draft_id = '${discarded}' and position = 1`, '23001', LINE],
      ['a no-op line update under a discarded header', `update tmpos_invoice_draft.invoice_draft_line set description = description where draft_id = '${discarded}'`, '23001', LINE],
      ['a line deleted under a discarded header', `delete from tmpos_invoice_draft.invoice_draft_line where draft_id = '${discarded}' and position = 3`, '23001', LINE],
      ['a line moved from an open draft onto a discarded one', `update tmpos_invoice_draft.invoice_draft_line set draft_id = '${discarded}', position = 9 where draft_id = '${open}' and position = 1`, '23001', LINE],
      ['a discarded header deleted', `delete from tmpos_invoice_draft.invoice_draft where draft_id = '${discarded}'`, '23001', 'migration 033: a discarded invoice draft is never deleted'],
      ['a discarded header inserted', `insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
        values ('${randomUUID()}', '${f.T}', '${f.S}', '${f.C1}', 'discarded', 'USD', 2, 1, 1, '${randomUUID()}')`, '23001', 'migration 033: an invoice draft is saved open (status draft) only'],
    ]) {
      const out = await rolledBack(async (tx) => {
        if (replica) await tx.unsafe('set local session_replication_role = replica');
        await tx.unsafe(sql);
      });
      assert.equal(out.code, code, `${replica ? 'replica: ' : ''}${label}: refused (${JSON.stringify(out)})`);
      if (message !== null) assert.equal(out.message, message, label);
    }
  }
  assert.deepEqual(await stateOf(discarded), before, 'the discarded draft unchanged');
  // An open draft stays open to the owner: its header edited, its lines changed, the whole draft deleted (each rolled back), and
  // the one admitted transition (draft -> discarded at version + 1, nothing else changed) passes the trigger.
  for (const [label, statements] of [
    ['an open header edited', [header(open, `customer_id = '${f.C2}', version = version + 1`)]],
    ['an open draft\'s line changed', [`update tmpos_invoice_draft.invoice_draft_line set description = 'Owner fix' where draft_id = '${open}' and position = 1`]],
    ['an open draft\'s line added', [`insert into tmpos_invoice_draft.invoice_draft_line (draft_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
      values ('${open}', '${f.T}', '${f.S}', 9, 'Added', 1, 1, 1)`]],
    ['an open draft deleted', [`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = '${open}'`, `delete from tmpos_invoice_draft.invoice_draft where draft_id = '${open}'`]],
    ['the admitted transition', [header(open, "status = 'discarded', version = version + 1")]],
  ]) {
    const out = await rolledBack(async (tx) => { for (const s of statements) await tx.unsafe(s); return 'passed'; });
    assert.deepEqual(out, { value: 'passed' }, label);
  }
  // The line trigger reads the header FOR SHARE: an owner's line write waits for a discard holding it, then re-reads the status.
  for (const [draft, ending] of [[held, 'commit'], [heldBack, 'rollback']]) {
    const discarding = holding(runtime, (tx) => discard(f.kBoss, f.S, f.T, draft, 1, { db: tx }));
    let writing = null;
    try {
      await until(() => discarding.ready, `${ending}: the discard applied, uncommitted`);
      writing = holding(owner, (tx) => tx`update tmpos_invoice_draft.invoice_draft_line set description = description where draft_id = ${draft} and position = 1`);
      await until(() => blockedBy(writing.pid, discarding.pid), `${ending}: the owner's line write waits behind the discard`);
      assert.deepEqual(await waitsFor(writing.pid), [['transactionid', 'ShareLock']], `${ending}: on the header row the discard holds`);
      discarding.release(ending);
      finished(await discarding.done, `${ending}: the discard`, ending === 'commit' ? 'committed' : 'rolled back');
      if (ending === 'commit') {
        const out = await writing.done;
        assert.deepEqual([out.outcome, out.code, out.message], ['failed', '23001', LINE], 'committed: the line write is refused on the re-read status');
      } else {
        await until(() => writing.ready || writing.out !== undefined, 'rolled back: the line write answered');
        assert.equal(writing.ready, true, `rolled back: the line write passes (${JSON.stringify(writing.out)})`);
        writing.release('rollback');
        await writing.done;
      }
    } finally {
      discarding.release('rollback');
      await discarding.done;
      if (writing !== null) { writing.release('rollback'); await writing.done; }
    }
  }
});

test('IDD-10 (DSC-15): the v2 reads — a discarded draft is absent from every page, the page otherwise equal to 028\'s; a cursor naming a discarded draft still pages; get_v2 of it answers 028\'s exact not_found row, of an open draft 028\'s rows; a store whose drafts are all discarded pages empty', async () => {
  const f = await scene('reads', { drafts: 5 });
  // Newest first: f.drafts[4] .. f.drafts[0]. Discard the second newest and the oldest.
  const order = [...f.drafts].reverse();
  for (const d of [order[1], order[4]]) assert.deepEqual(await discard(f.kBoss, f.S, f.T, d, 1), [done(f.boss, f.T, f.S, 2)]);
  const v2 = await page(f.kBoss, f.T, f.S, null);
  assert.deepEqual(v2.map((r) => r.o_draft_id), [order[0], order[2], order[3]], 'the open drafts, newest first; the discarded absent');
  assert.ok(v2.every((r) => r.o_outcome === 'draft' && r.o_status === 'draft'), 'every served row is an open draft');
  const all028 = await page(f.kBoss, f.T, f.S, null, 51, { db: owner, fn: PAGE_028_FN });
  assert.deepEqual(all028.map((r) => r.o_draft_id), order, '028\'s page (the owner\'s only) serves all five');
  assert.deepEqual(v2, all028.filter((r) => r.o_status === 'draft'), 'page_v2 is 028\'s page without the discarded rows, column for column');
  assert.deepEqual(all028.filter((r) => r.o_status !== 'draft').map((r) => r.o_draft_id), [order[1], order[4]]);
  // Bounded pages and cursors: a limit of 1 walks the open drafts; a cursor naming a DISCARDED draft pages from its place.
  assert.deepEqual((await page(f.kBoss, f.T, f.S, null, 1)).map((r) => r.o_draft_id), [order[0]]);
  assert.deepEqual((await page(f.kBoss, f.T, f.S, order[0], 1)).map((r) => r.o_draft_id), [order[2]], 'after the newest: the next open one');
  assert.deepEqual((await page(f.kBoss, f.T, f.S, order[1], 51)).map((r) => r.o_draft_id), [order[2], order[3]], 'a cursor naming a discarded draft still pages');
  assert.deepEqual(await page(f.kBoss, f.T, f.S, order[4], 51), [], 'a cursor naming the oldest (discarded): nothing after it');
  assert.deepEqual((await page(f.kBoss, f.T, f.S, randomUUID(), 51)).map((r) => r.o_outcome), ['cursor_unknown'], 'an unknown cursor: cursor_unknown');
  // get_v2: a discarded draft is 028's not_found, exactly; an open one is 028's rows, exactly.
  const missing = await get(f.kBoss, f.T, f.S, randomUUID(), { db: owner, fn: GET_028_FN });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].o_outcome, 'not_found');
  assert.deepEqual(await get(f.kBoss, f.T, f.S, order[1]), missing, 'a discarded draft: exactly 028\'s not_found row');
  assert.deepEqual(await get(f.kManager, f.T, f.S, order[4]), missing, 'for the manager too');
  assert.equal((await get(f.kBoss, f.T, f.S, order[1], { db: owner, fn: GET_028_FN }))[0].o_status, 'discarded', '028\'s get (the owner\'s only) still serves it');
  assert.deepEqual(await get(f.kBoss, f.T, f.S, order[0]), await get(f.kBoss, f.T, f.S, order[0], { db: owner, fn: GET_028_FN }), 'an open draft: 028\'s rows, column for column');
  assert.equal((await get(f.kBoss, f.T, f.S, order[0])).length, LINES.length);
  // A store holding only discarded drafts pages empty — never a fault.
  const g = await scene('reads-all-gone', { drafts: 2 });
  for (const d of g.drafts) assert.deepEqual(await discard(g.kBoss, g.S, g.T, d, 1), [done(g.boss, g.T, g.S, 2)]);
  assert.deepEqual(await page(g.kBoss, g.T, g.S, null), [], 'no open draft: no row');
  assert.deepEqual((await page(g.kManager, g.T, g.S, g.drafts[0])), [], 'a cursor naming one of them: no row');
});

// ===========================================================================
// IDD-11: no deadlock against the level writers
// ===========================================================================

test('IDD-11 (DSC-26): no deadlock against the level writers — a discard holding the key (applied, and a sealed conflict) and 026\'s REAL Invoices setter or 021\'s REAL Customers setter, in both orders, each finish; every wait first seen in pg_locks', async (t) => {
  for (const [domain, set] of [['invoices', setInvoices], ['customers', setCustomers]]) {
    await t.test(`${domain}: the discard first (applied and conflict) — the setter waits on the key, then both finish`, async () => {
      for (const sealed of ['applied', 'conflict']) {
        const f = await scene(`dl-${domain}-${sealed}`, { managerLevel: 'manage' });
        const own = await tenantOwner(f.T, `dl-${domain}-${sealed}`);
        const version = sealed === 'applied' ? 1 : 5;
        const held = holding(runtime, (tx) => discard(f.kManager, f.S, f.T, f.draft, version, { db: tx }));
        let writer = null;
        try {
          await until(() => held.ready || held.out !== undefined, `${sealed}: the discard answered, its transaction open`);
          assert.deepEqual(held.value, sealed === 'applied' ? [done(f.manager, f.T, f.S, 2)] : [answer('conflict')]);
          assert.deepEqual(await guardLocksOf(held.pid), [await guardLock(f.T, 'manager', 'ShareLock')], `${sealed}: the discard holds the key SHARED`);
          const reviewed = await versionRowOf(f.T, 'manager', domain);
          writer = running(runtime, (tx) => set(own.key, 'manager', 'view', f.T, reviewed, tx));
          await until(() => blockedBy(writer.pid, held.pid), `${sealed}: the setter waits behind the discard`);
          assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], `${sealed}: on the key, EXCLUSIVE — nothing else`);
          held.release('commit');
          finished(await held.done, `${sealed}: the discard`);
          const out = finished(await writer.done, `${sealed}: the setter`);
          assert.deepEqual(out.value, [{ o_outcome: 'applied', o_level: 'view', o_version: reviewed + 1 }], `${sealed}: the setter applied`);
        } finally {
          held.release('rollback');
          await held.done;
          if (writer !== null) await writer.done;
        }
      }
    });
    await t.test(`${domain}: the setter first — the discard waits on the key, then both finish (on the committed levels)`, async () => {
      const f = await scene(`dl-${domain}-w`, { managerLevel: 'manage' });
      const own = await tenantOwner(f.T, `dl-${domain}-w`);
      const reviewed = await versionRowOf(f.T, 'manager', domain);
      const writer = holding(runtime, (tx) => set(own.key, 'manager', domain === 'invoices' ? 'approve' : 'none', f.T, reviewed, tx));
      let discarding = null;
      try {
        await until(() => writer.ready || writer.out !== undefined, 'the setter\'s change held, uncommitted');
        assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')], 'the setter holds the key EXCLUSIVE');
        discarding = running(runtime, (tx) => discard(f.kManager, f.S, f.T, f.draft, 1, { db: tx }));
        await until(() => blockedBy(discarding.pid, writer.pid), 'the discard waits behind the setter');
        assert.deepEqual(await waitsFor(discarding.pid), [['advisory', 'ShareLock']], 'at the guard: the key, SHARED');
        assert.equal(await headerHeld(f.draft), true, 'having taken the header first');
        writer.release('commit');
        finished(await writer.done, 'the setter');
        assert.deepEqual(finished(await discarding.done, 'the discard').value, [done(f.manager, f.T, f.S, 2)],
          domain === 'invoices' ? 'Approve admits the discard' : 'the Customers level does not decide a discard');
      } finally {
        writer.release('rollback');
        await writer.done;
        if (discarding !== null) await discarding.done;
      }
    });
  }
});

// ===========================================================================
// IDD-12: parity and text
// ===========================================================================

test('IDD-12 (DSC-17 DSC-02): the discard\'s steps 1-7 are 030\'s update_v2\'s code lines with Manage for Edit; page_v2 and get_v2 are 028\'s bodies with exactly one predicate each; every restatement equals the catalog; the installed bodies are the file\'s; the key precedes the state and version decisions in the outermost block; both files lock the seven first; the exact change lists; the open page is served from the partial index', async () => {
  const restated = (source, label, expect) => {
    const cases = [...source.matchAll(/case v_role ((?:when '[a-z_]+' then '[a-z]+' )+)end/g)]
      .map((m) => Object.fromEntries([...m[1].matchAll(/when '([a-z_]+)' then '([a-z]+)'/g)].map((p) => [p[1], p[2]])));
    assert.equal(cases.length, expect.cases, `${label}: every default restatement found`);
    for (const c of cases) assert.deepEqual(c, Object.fromEntries(EDITABLE.map((r) => [r, TENANT_ROLE_PERMISSION_DEFAULTS[r].invoices])), `${label}: the catalog defaults`);
    assert.deepEqual([...source.matchAll(/v_role = '([a-z_]+)'/g)].map((m) => m[1]), Array(expect.owners).fill('store_owner'), `${label}: the owner literal`);
    const sets = [...source.matchAll(/v_role in \(([^)]*)\)/g)].map((m) => m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort());
    assert.deepEqual(sets, Array(expect.sets).fill([...EDITABLE].sort()), `${label}: the editable set`);
    const orderings = [...source.matchAll(/array\[('none'[^\]]*)\]/g)].map((m) => m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')));
    assert.deepEqual(orderings, Array(expect.orderings).fill([...TENANT_ORDERING]), `${label}: the ordering`);
    assert.deepEqual([...source.matchAll(/array_position\(c_levels, '([a-z]+)'\)/g)].map((m) => m[1]), Array(expect.thresholds).fill(expect.threshold), `${label}: the threshold`);
  };
  const def = async (sig) => (await owner`select pg_catalog.pg_get_functiondef(${sig}::regprocedure) as source`)[0].source;
  restated(await def(DISCARD), 'the installed discard', { cases: 2, owners: 1, sets: 2, orderings: 1, thresholds: 2, threshold: 'manage' });
  restated(routineBody(UP_033, 'tmpos_invoice_discard', 'm7b_invoice_draft_discard'), 'the discard in the file', { cases: 2, owners: 1, sets: 2, orderings: 1, thresholds: 2, threshold: 'manage' });
  for (const sig of [PAGE_V2, GET_V2]) restated(await def(sig), sig, { cases: 1, owners: 1, sets: 1, orderings: 1, thresholds: 1, threshold: 'view' });
  for (const sig of [DISCARD, PAGE_V2, GET_V2]) assert.doesNotMatch(await def(sig), /'customers'/, `${sig} never reads the Customers level`);
  // The installed bodies are the file's, character for character.
  const proSrc = async (sig) => (await owner`select p.prosrc as src from pg_catalog.pg_proc p where p.oid = ${sig}::regprocedure`)[0].src;
  for (const [sig, name] of [[DISCARD, 'm7b_invoice_draft_discard'], [PAGE_V2, 'm7b_invoice_draft_page_v2'], [GET_V2, 'm7b_invoice_draft_get_v2'],
    [HEADER_GUARD, 'm7b_invoice_draft_terminal'], [LINE_GUARD, 'm7b_invoice_draft_line_terminal']]) {
    assert.equal(await proSrc(sig), routineBody(UP_033, 'tmpos_invoice_discard', name), `${name}: the installed body is the file's`);
  }
  // The discard's steps 1-7 ARE 030's update_v2's, code line for code line, the two thresholds Manage for Edit.
  const span = (body, from, to) => {
    const lines = body.split('\n');
    const a = lines.findIndex((l) => l.startsWith(from));
    const b = lines.findIndex((l, i) => i > a && l.startsWith(to));
    assert.ok(a >= 0 && b > a, `${from} .. ${to}`);
    return codeOf(lines.slice(a, b).join('\n'));
  };
  const v2 = span(routineBody(UP_030, 'tmpos_invoice_edit', 'm7b_invoice_draft_update_v2'), '  -- 1. The caller', '  -- 8. The replacement customer');
  const mine = span(routineBody(UP_033, 'tmpos_invoice_discard', 'm7b_invoice_draft_discard'), '  -- 1. The caller', '  -- 8. The discard');
  const THRESHOLD = "       < pg_catalog.array_position(c_levels, 'edit') then";
  assert.equal(v2.filter((l) => l === THRESHOLD).length, 2, 'update_v2 decides Edit twice (steps 3 and 5b)');
  assert.deepEqual(mine, v2.map((l) => (l === THRESHOLD ? "       < pg_catalog.array_position(c_levels, 'manage') then" : l)),
    'steps 1-7: update_v2\'s code lines character for character, Manage in place of Edit');
  // The order inside the discard (comments stripped), in its outermost block: header FOR UPDATE, the key, the clock, the level,
  // invalid_state, conflict, then the one UPDATE (the only BEGIN ... EXCEPTION block, after every decision).
  const code = codeOf(routineBody(UP_033, 'tmpos_invoice_discard', 'm7b_invoice_draft_discard')).join('\n');
  const at = (needle) => { const i = code.indexOf(needle); assert.ok(i >= 0 && code.indexOf(needle, i + 1) === -1, `${needle}: once`); return i; };
  const order = [at('     for update;'), at('    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || \'/\' || v_role));'),
    at("return query select 'invalid_state'"), at("return query select 'conflict'"), at('    update tmpos_invoice_draft.invoice_draft d'), at("return query select 'applied'")];
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'header, key, invalid_state, conflict, the UPDATE, applied — in that order');
  assert.equal(code.split('\n').filter((l) => /^\s*exception$/.test(l)).length, 1, 'one exception handler');
  assert.equal(code.split('\n').filter((l) => /^\s+begin$/.test(l)).length, 1, 'one nested block');
  assert.ok(code.indexOf('\n  begin\n') > order[3], 'the only nested block follows every decision');
  const levelReads = [...code.matchAll(/from tmpos_role\.tenant_role_level l[^;]*;/g)].map((m) => m[0]);
  assert.equal(levelReads.length, 2, 'two level reads (steps 3 and 5b)');
  for (const read of levelReads) assert.doesNotMatch(read, /\bfor (share|update)\b/, 'each a plain read: no role row locked');
  assert.doesNotMatch(code, /insert into|delete from|tmpos_customer|invoice_draft_line|tmpos_role_edit/, 'no row inserted or deleted, no customer, no line, no version row');
  // The key expression is 030's guard function's, the same pair (tenant, role).
  assert.ok(UP_030.includes('pg_catalog.pg_advisory_xact_lock(530030, pg_catalog.hashtext(new.tenant_id::text || \'/\' || new.role_id))'), '030\'s writer key');
  // page_v2 and get_v2: 028's bodies with exactly one predicate each.
  const diff = (a, b) => {
    const A = codeOf(a);
    const B = codeOf(b);
    let i = 0;
    while (i < A.length && A[i] === B[i]) i += 1;
    let j = 0;
    while (j < A.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j += 1;
    return { removed: A.slice(i, A.length - j), added: B.slice(i, B.length - j) };
  };
  assert.deepEqual(diff(routineBody(UP_028, 'tmpos_invoice_draft', 'm7b_invoice_draft_page'), routineBody(UP_033, 'tmpos_invoice_discard', 'm7b_invoice_draft_page_v2')),
    { removed: [], added: ["       and d.status = 'draft'"] }, 'page_v2: 028\'s page plus the served rows\' predicate');
  assert.deepEqual(diff(routineBody(UP_028, 'tmpos_invoice_draft', 'm7b_invoice_draft_get'), routineBody(UP_033, 'tmpos_invoice_discard', 'm7b_invoice_draft_get_v2')),
    { removed: ['     and d.store_id = p_expected_store;'], added: ['     and d.store_id = p_expected_store', "     and d.status = 'draft';"] }, 'get_v2: 028\'s get plus the point read\'s predicate');
  const pageCode = codeOf(routineBody(UP_033, 'tmpos_invoice_discard', 'm7b_invoice_draft_page_v2')).join('\n');
  assert.ok(/where d\.draft_id = p_after_draft_id\n {7}and d\.tenant_id = v_tenant\n {7}and d\.store_id = p_expected_store;/.test(pageCode), 'the cursor anchor stays status-blind');
  // No raw invisible code point; no replacement, dynamic SQL or CASCADE in either file's code.
  for (const [label, file] of [['up', UP_033], ['down', DOWN_033]]) {
    assert.doesNotMatch(file, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u, `033 ${label}`);
    assert.doesNotMatch(codeOf(file).join('\n'), /create or replace|\bexecute '|\bexecute format|cascade/i, `033 ${label}: no replacement, dynamic SQL or CASCADE`);
  }
  // Both files: the lock block first after the settings, the seven in the writers' order, before every check and change.
  const statements = (file) => file.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
  for (const [label, file, raise] of [
    ['up', UP_033, /^ {4}raise exception 'migration 033 refused: [^']* is missing \(migrations 002, 017, 020, 021 and 028 must be applied first\)'$/],
    ['down', DOWN_033, /^ {4}raise exception 'migration 033 rollback refused: migration 033 is not applied \([^']*\)'$/],
  ]) {
    const want = ['set local search_path = pg_catalog, pg_temp;', 'set local row_security = off;', 'do $$', 'begin',
      ...WRITERS_ORDER.map((rel) => `  lock table ${rel} in access exclusive mode;`), 'exception', '  when undefined_table or invalid_schema_name then', raise,
      "      using errcode = 'object_not_in_prerequisite_state';", 'end', '$$;'];
    const got = statements(file).slice(0, want.length);
    want.forEach((l, i) => (l instanceof RegExp ? assert.match(got[i], l, `${label}, line ${i}`) : assert.equal(got[i], l, `${label}, line ${i}`)));
    assert.deepEqual([...file.matchAll(/^ *lock table ([a-z_.]+) in access exclusive mode;$/gm)].map((m) => m[1]), WRITERS_ORDER, `${label}: exactly the seven`);
  }
  const changes = (file) => [...file.matchAll(/^(?:alter|create|drop|insert|update|delete|grant|revoke|comment)\b[^\n]*/gm)].map((m) => m[0]);
  assert.deepEqual(changes(UP_033), [
    'create schema tmpos_invoice_discard;',
    'comment on schema tmpos_invoice_discard is',
    'revoke all on schema tmpos_invoice_discard from public, anon, authenticated, tmpos_app, tmpos_audit_writer;',
    'grant usage on schema tmpos_invoice_discard to tmpos_app;',
    'alter table tmpos_invoice_draft.invoice_draft',
    'create index invoice_draft_open_page_idx on tmpos_invoice_draft.invoice_draft (tenant_id, store_id, created_at desc, draft_id desc)',
    'comment on index tmpos_invoice_draft.invoice_draft_open_page_idx is',
    'create function tmpos_invoice_discard.m7b_invoice_draft_terminal()',
    `comment on function ${HEADER_GUARD} is`,
    'create trigger trg_invoice_draft_terminal',
    'alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_terminal;',
    'comment on trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft is',
    'create function tmpos_invoice_discard.m7b_invoice_draft_line_terminal()',
    `comment on function ${LINE_GUARD} is`,
    'create trigger trg_invoice_draft_line_terminal',
    'alter table tmpos_invoice_draft.invoice_draft_line enable always trigger trg_invoice_draft_line_terminal;',
    'comment on trigger trg_invoice_draft_line_terminal on tmpos_invoice_draft.invoice_draft_line is',
    'create function tmpos_invoice_discard.m7b_invoice_draft_discard(',
    `comment on function ${DISCARD} is`,
    'create function tmpos_invoice_discard.m7b_invoice_draft_page_v2(',
    `comment on function ${PAGE_V2} is`,
    'create function tmpos_invoice_discard.m7b_invoice_draft_get_v2(',
    `comment on function ${GET_V2} is`,
    'create function tmpos_invoice_discard.m7b_invoice_discard_prerequisites()',
    `comment on function ${ANCHOR} is`,
    `revoke all on function ${DISCARD} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke all on function ${PAGE_V2} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke all on function ${GET_V2} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke all on function ${HEADER_GUARD} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke all on function ${LINE_GUARD} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke all on function ${ANCHOR} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke execute on function ${PAGE_028} from tmpos_app;`,
    `revoke execute on function ${GET_028} from tmpos_app;`,
    `grant execute on function ${DISCARD} to tmpos_app;`,
    `grant execute on function ${PAGE_V2} to tmpos_app;`,
    `grant execute on function ${GET_V2} to tmpos_app;`,
  ], 'the up\'s changes, in order: no UPDATE, DELETE or INSERT of any row');
  assert.ok(UP_033.includes("alter table tmpos_invoice_draft.invoice_draft\n  drop constraint invoice_draft_status_chk,\n  add constraint invoice_draft_status_chk check (status in ('draft', 'discarded'));\n"));
  assert.deepEqual(changes(DOWN_033), [
    `drop function ${ANCHOR};`,
    'drop trigger trg_invoice_draft_line_terminal on tmpos_invoice_draft.invoice_draft_line;',
    'drop trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft;',
    `drop function ${LINE_GUARD};`,
    `drop function ${HEADER_GUARD};`,
    `revoke execute on function ${DISCARD} from tmpos_app;`,
    `revoke execute on function ${PAGE_V2} from tmpos_app;`,
    `revoke execute on function ${GET_V2} from tmpos_app;`,
    `drop function ${DISCARD};`,
    `drop function ${PAGE_V2};`,
    `drop function ${GET_V2};`,
    'drop index tmpos_invoice_draft.invoice_draft_open_page_idx;',
    'revoke usage on schema tmpos_invoice_discard from tmpos_app;',
    'drop schema tmpos_invoice_discard;',
    'alter table tmpos_invoice_draft.invoice_draft',
    `grant execute on function ${PAGE_028} to tmpos_app;`,
    `grant execute on function ${GET_028} to tmpos_app;`,
  ], 'the down\'s changes, in order: no row deleted or updated');
  assert.ok(DOWN_033.includes("alter table tmpos_invoice_draft.invoice_draft\n  drop constraint invoice_draft_status_chk,\n  add constraint invoice_draft_status_chk check (status = 'draft');\n"));
  const firstChange = (file) => Math.min(...[...file.matchAll(/^(?:alter|create|drop|insert|update|delete|grant|revoke|comment)\b/gm)].map((m) => m.index));
  assert.ok(DOWN_033.indexOf('rollback refused: an invoice draft has been discarded') < firstChange(DOWN_033), 'the down\'s data guard precedes its first change');
  // The open page's statement, as page_v2 runs it for a first page, can be served from the partial index (a rolled-back seed:
  // few open drafts among many discarded ones; sequential and bitmap scans off, so only an ordered index scan remains and the
  // planner names the index whose predicate the statement implies).
  const f = await scene('plan');
  const statement = routineBody(UP_033, 'tmpos_invoice_discard', 'm7b_invoice_draft_page_v2');
  const query = statement.slice(statement.indexOf("    select 'draft'::text, d.tenant_id"), statement.indexOf('limit p_limit;') + 'limit p_limit'.length)
    .replace(/v_tenant/g, `'${f.T}'::uuid`).replace(/p_expected_store/g, `'${f.S}'::uuid`).replace(/p_after_draft_id/g, 'null::uuid')
    .replace(/v_after/g, 'null::timestamptz').replace(/p_limit/g, '51');
  const plan = await rolledBack(async (tx) => {
    await tx`insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by, created_at)
      select gen_random_uuid(), ${f.T}, ${f.S}, ${f.C1}, 'draft', 'USD', 1, 1, 100, gen_random_uuid(), now() - (g || ' seconds')::interval from generate_series(1, 2000) g`;
    await tx`update tmpos_invoice_draft.invoice_draft set status = 'discarded', version = version + 1
      where draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = ${f.T} and created_by <> ${f.boss.id} order by created_at desc limit 1950)`;
    await tx.unsafe('analyze tmpos_invoice_draft.invoice_draft');
    await tx.unsafe('set local enable_seqscan = off');
    await tx.unsafe('set local enable_bitmapscan = off');
    return (await tx.unsafe(`explain (costs off) ${query}`)).map((r) => r['QUERY PLAN']).join('\n');
  });
  assert.match(plan.value ?? JSON.stringify(plan), /using invoice_draft_open_page_idx on invoice_draft/, `the open page uses the partial index:\n${plan.value}`);
});

// ===========================================================================
// IDD-13: the upgrade, the rollback and the order of rollbacks
// ===========================================================================

/** Every row of a scope that 033's apply or rollback could touch, exactly: drafts, lines, role and version rows, audit records — row, xmin and ctid. */
async function rowsOf(tenants) {
  const q = async (rel, where) => (await owner.unsafe(`select pg_catalog.to_jsonb(r)::text as row, r.xmin::text as xmin, r.ctid::text as ctid from ${rel} r where ${where} order by 1`, [tenants]))
    .map((x) => `${x.row} ${x.xmin} ${x.ctid}`);
  return {
    drafts: await q('tmpos_invoice_draft.invoice_draft', 'r.tenant_id = any($1::uuid[])'),
    lines: await q('tmpos_invoice_draft.invoice_draft_line', 'r.tenant_id = any($1::uuid[])'),
    roles: await q('tmpos_role.tenant_role_level', 'r.tenant_id = any($1::uuid[])'),
    versions: await q('tmpos_role_edit.role_level_version', 'r.tenant_id = any($1::uuid[])'),
    audits: await q('public.audit_event', 'r.tenant_id = any($1::uuid[])'),
  };
}

test('IDD-13 (DSC-17): over drafts at versions 1-3 with stored overrides and edit audit records, 032 -> 033 changes no row and edit, save and discard then work; the down is refused while a discarded draft exists (nothing changed); without one it restores the 032-era contract exactly and 033 re-applies equal; with 033 applied the older downs are refused (the anchor, 2BP01; 031 its postcondition), and with the anchor dropped 032\'s down completes', async (t) => {
  // No discarded draft of this suite may stand in the way of 033's down: the earlier cases' drafts are removed first.
  await cleanDrafts();
  const applied = await catalogOf();
  let u;
  await t.test('the upgrade 032 -> 033 changes no row; edit, save and discard then work', async () => {
    const down = await rollBackAbove(owner, MIG_DIR, '032');
    assert.deepEqual(down.rolledBack, ['033'], '033 rolled back by its own down');
    u = await scene('upgrade', { managerLevel: 'approve', drafts: 3 });
    await setLevel(u.T, 'technician', 'customers', 'manage');
    assert.deepEqual(await edit(u.kBoss, u.S, u.T, u.drafts[1], 1, u.C2, [line('Upgrade edit 1', 1, 1)]), [done(u.boss, u.T, u.S, 2)]);
    assert.deepEqual(await edit(u.kBoss, u.S, u.T, u.drafts[2], 1, u.C2, [line('Upgrade edit 1', 1, 1)]), [done(u.boss, u.T, u.S, 2)]);
    assert.deepEqual(await edit(u.kManager, u.S, u.T, u.drafts[2], 2, u.C1, [line('Upgrade edit 2', 2, 3)]), [done(u.manager, u.T, u.S, 3)]);
    // An edit's audit record (as the runtime writes it), naming an edited draft.
    const audit = `idd-upgrade-${SUFFIX}`;
    SYNTHETIC_AUDITS.push(audit);
    await owner`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
        reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_invoice_draft_id)
      values (${audit}, ${u.manager.id}, 'store', ${u.T}, ${u.S}, 'store.invoice_draft.update', 'edit_invoice_drafts', 'allow', 'command_committed',
        'IDD synthetic record.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1', 'durable_compliance_event', ${u.drafts[2]})`;
    const before = await rowsOf([u.T]);
    assert.deepEqual(before.drafts.map((r) => JSON.parse(r.slice(0, r.lastIndexOf(' ', r.lastIndexOf(' ') - 1))).version).sort(), [1, 2, 3], 'drafts at versions 1, 2 and 3');
    const report = await trustedApply();
    assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
    assert.deepEqual(await rowsOf([u.T]), before, 'the apply changed no row: drafts, lines, role and version rows, audit records (row, xmin, ctid)');
    assert.deepEqual(await catalogOf(), applied, 'the re-applied catalog equals the first apply\'s');
    assert.deepEqual(await edit(u.kManager, u.S, u.T, u.drafts[2], 3, u.C2, LINES), [done(u.manager, u.T, u.S, 4)], 'an edit works');
    const saved = await create(u.kManager, u.S, u.T, u.C1);
    assert.deepEqual(await discard(u.kManager, u.S, u.T, saved, 1), [done(u.manager, u.T, u.S, 2)], 'a save and its discard work');
    assert.deepEqual(await discard(u.kManager, u.S, u.T, u.drafts[1], 2), [done(u.manager, u.T, u.S, 3)], 'a discard of an upgraded draft works');
  });
  await t.test('the down is refused while a discarded draft exists, changing nothing; without one it restores the 032-era contract exactly; 033 re-applies equal', async () => {
    const catalog = await catalogOf();
    const rows = await rowsOf([u.T]);
    const refused = await rolledBack((tx) => tx.unsafe(DOWN_033).simple());
    assert.deepEqual([refused.code, refused.message], ['55000', 'migration 033 rollback refused: an invoice draft has been discarded, and a rollback never deletes a draft or returns it to draft']);
    const viaExecutor = await errorOf(rollBackAbove(owner, MIG_DIR, '032'));
    assert.equal(viaExecutor?.code, '55000', 'the ledgered rollback refuses the same way');
    assert.deepEqual(await catalogOf(), catalog, 'the catalog and the ledger unchanged');
    assert.deepEqual(await rowsOf([u.T]), rows, 'every row unchanged');
    // The suite removes its own discarded drafts (an owner decision on a disposable database), then the down is clean.
    const gone = (await owner`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = ${u.T} and status = 'discarded'`).map((r) => r.draft_id);
    assert.equal(gone.length, 2);
    await owner.begin(RC, (tx) => removeDrafts(tx, gone));
    const open = await rowsOf([u.T]);
    const down = await rollBackAbove(owner, MIG_DIR, '032');
    assert.deepEqual(down.rolledBack, ['033']);
    assert.deepEqual(await rowsOf([u.T]), open, 'the down changed no row');
    const [c] = await owner`select
      (select pg_catalog.pg_get_constraintdef(k.oid) from pg_catalog.pg_constraint k where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk' and k.convalidated) as chk,
      pg_catalog.to_regnamespace('tmpos_invoice_discard') is null as no_schema,
      pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft_open_page_idx') is null as no_index,
      (select pg_catalog.string_agg(g.tgname::text, ',') from pg_catalog.pg_trigger g where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and not g.tgisinternal) as triggers,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${PAGE_028}::regprocedure, 'EXECUTE') as page028,
      pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${GET_028}::regprocedure, 'EXECUTE') as get028`;
    assert.deepEqual({ ...c }, { chk: 'CHECK ((status = \'draft\'::text))', no_schema: true, no_index: true, triggers: 'trg_invoice_draft_immutable', page028: true, get028: true });
    for (const sig of [PAGE_028, GET_028]) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME, 'tmpos_app'), `${sig}: 028's two entries again`);
    assert.deepEqual(await grantsOf(CREATE_028), EXECUTE_BY(ME), '028\'s create: the owner\'s alone, as 031 left it');
    assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_032).simple())).code, undefined, '032\'s postcondition holds');
    assert.equal((await page(u.kBoss, u.T, u.S, null, 51, { fn: PAGE_028_FN })).length, 2, 'the login reads through 028\'s page again');
    const report = await trustedApply();
    assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
    assert.deepEqual(await catalogOf(), applied, 'the re-applied catalog equals the first apply\'s');
    assert.deepEqual(await rowsOf([u.T]), open, 'the re-apply changed no row');
  });
  await t.test('with 033 applied the older downs are refused — 032, 030, 029 and 028 by the anchor\'s dependencies (2BP01), 031 by its postcondition — and with the anchor dropped 032\'s down completes', async () => {
    // Each in a rolled-back owner transaction whose data obstacles (every draft, line and audit subject, the terminal and
    // append-only triggers lifted there) are removed first, so the refusal is the catalog's alone.
    const clearData = async (tx) => {
      await withTriggersLifted(tx, AUDIT_TRIGGER, () => tx`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id is not null`);
      await withTriggersLifted(tx, TERMINAL_TRIGGERS, async () => {
        await tx`delete from tmpos_invoice_draft.invoice_draft_line`;
        await tx`delete from tmpos_invoice_draft.invoice_draft`;
      });
    };
    const dependsOn = (what) => `function ${ANCHOR} depends on ${what}`;
    for (const [version, file, code, message, detail] of [
      ['032', DOWN_032, '2BP01', 'cannot drop function tmpos_invoice_edit.m7b_invoice_draft_create_v3(text,uuid,uuid,uuid,uuid,jsonb,bigint) because other objects depend on it',
        dependsOn('function tmpos_invoice_edit.m7b_invoice_draft_create_v3(text,uuid,uuid,uuid,uuid,jsonb,bigint)')],
      ['031', DOWN_031, '55000', 'migration 031 rollback refused: the save routine still exists, or schema tmpos_invoice_edit does not hold exactly migration 030\'s two functions', null],
      ['030', DOWN_030, '2BP01', 'cannot drop function tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint) because other objects depend on it',
        dependsOn('function tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint)')],
      ['029', DOWN_029, '2BP01', 'cannot drop function tmpos_invoice_draft.m7b_invoice_draft_immutable() because other objects depend on it',
        dependsOn('function tmpos_invoice_draft.m7b_invoice_draft_immutable()')],
      ['028', DOWN_028, '2BP01', 'cannot drop table tmpos_invoice_draft.invoice_draft_line because other objects depend on it',
        dependsOn('table tmpos_invoice_draft.invoice_draft_line')],
    ]) {
      const out = await rolledBack(async (tx) => { await clearData(tx); await tx.unsafe(file).simple(); });
      assert.deepEqual([out.code, out.message, out.detail], [code, message, detail], `${version}'s down while 033 is applied (${JSON.stringify(out)})`);
    }
    const control = await rolledBack(async (tx) => { await clearData(tx); await tx.unsafe(`drop function ${ANCHOR}`); await tx.unsafe(DOWN_032).simple(); return 'completed'; });
    assert.deepEqual(control, { value: 'completed' }, 'the anchor dropped: 032\'s down completes (the anchor is what refused it)');
    assert.deepEqual(await catalogOf(), applied, 'every proof rolled back: the catalog unchanged');
  });
});

// ===========================================================================
// IDD-14: negative controls
// ===========================================================================

test('IDD-14 (DSC-10 DSC-03 DSC-15 DSC-16, negative controls): inside rolled-back owner transactions — the discard without its state check answers conflict for a discarded draft at a wrong version; without its key it applies at once under a held narrowing; the reads without their filter serve the discarded draft; without the line trigger a discarded draft\'s line changes', async () => {
  const f = await scene('controls', { managerLevel: 'manage', drafts: 3 });
  const [discarded, open] = f.drafts;
  assert.deepEqual(await discard(f.kBoss, f.S, f.T, discarded, 1), [done(f.boss, f.T, f.S, 2)]);
  const statement = routineStatement(UP_033, 'tmpos_invoice_discard', 'm7b_invoice_draft_discard').replace(/^create function/, 'create or replace function');
  const mutant = (from, to) => { assert.equal(statement.split(from).length, 2, `${from.slice(0, 60)}: once`); return statement.replace(from, to); };
  // (1) The state check removed: a discarded draft at a stale version answers conflict, not invalid_state (DSC-10 fails).
  const STATE_CHECK = "  if v_header.status is distinct from 'draft' then\n    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;\n    return;\n  end if;\n";
  const nc1 = await rolledBack(async (tx) => {
    const real = await discard(f.kBoss, f.S, f.T, discarded, 1, { db: tx });
    await tx.unsafe(mutant(STATE_CHECK, ''));
    return { real, mutant: await discard(f.kBoss, f.S, f.T, discarded, 1, { db: tx }) };
  });
  assert.deepEqual(nc1.value, { real: [answer('invalid_state')], mutant: [answer('conflict')] }, `the state check is what answers invalid_state (${JSON.stringify(nc1)})`);
  // (2) The key removed: under a narrowing held uncommitted, the mutant applies at once — it never waits and decides on the
  // level the narrowing is about to withdraw (DSC-03 fails); the real routine waits on the key (IDD-07).
  const narrowing = holding(owner, async (tx) => {
    await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices' for update`;
    return tx`update tmpos_role.tenant_role_level set level = 'edit', updated_at = now() where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices'`;
  });
  try {
    await until(() => narrowing.ready, 'the narrowing held');
    const KEY = "    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));\n";
    const nc2 = await rolledBack(async (tx) => {
      await tx.unsafe("set local lock_timeout = '3s'");
      await tx.unsafe(mutant(KEY, ''));
      return discard(f.kManager, f.S, f.T, open, 1, { db: tx });
    });
    assert.deepEqual(nc2.value, [done(f.manager, f.T, f.S, 2)], `without the key the discard applies under the held narrowing (${JSON.stringify(nc2)})`);
    narrowing.release('commit');
    finished(await narrowing.done, 'the narrowing');
  } finally {
    narrowing.release('rollback');
    await narrowing.done;
  }
  assert.deepEqual(await discard(f.kManager, f.S, f.T, open, 1), [REFUSED], 'the real routine meets the committed narrowing');
  await setLevel(f.T, 'manager', 'invoices', 'manage');
  // (3) The reads' filter dropped: the discarded draft is served (DSC-15 fails).
  const nc3 = await rolledBack(async (tx) => {
    const real = { page: (await page(f.kBoss, f.T, f.S, null, 51, { db: tx })).map((r) => r.o_draft_id), get: (await get(f.kBoss, f.T, f.S, discarded, { db: tx })).map((r) => r.o_outcome) };
    for (const name of ['m7b_invoice_draft_page_v2', 'm7b_invoice_draft_get_v2']) {
      const s = routineStatement(UP_033, 'tmpos_invoice_discard', name).replace(/^create function/, 'create or replace function');
      const filter = name.endsWith('page_v2') ? "\n       and d.status = 'draft'" : "\n     and d.status = 'draft'";
      assert.equal(s.split(filter).length, 2, `${name}: the filter once`);
      await tx.unsafe(s.replace(filter, ''));
    }
    return { real, mutant: { page: (await page(f.kBoss, f.T, f.S, null, 51, { db: tx })).map((r) => r.o_draft_id), get: (await get(f.kBoss, f.T, f.S, discarded, { db: tx })).map((r) => r.o_status) } };
  });
  assert.ok(!nc3.value.real.page.includes(discarded) && nc3.value.real.get.join() === 'not_found', `the real reads hide it (${JSON.stringify(nc3)})`);
  assert.ok(nc3.value.mutant.page.includes(discarded), 'without the filter the page serves the discarded draft');
  assert.deepEqual(nc3.value.mutant.get, Array(LINES.length).fill('discarded'), 'without the filter the get serves it');
  // (4) The line trigger dropped: a discarded draft's line changes (DSC-16 fails).
  const LINE_UPDATE = `update tmpos_invoice_draft.invoice_draft_line set description = 'Changed after discard' where draft_id = '${discarded}' and position = 1`;
  const real4 = await rolledBack((tx) => tx.unsafe(LINE_UPDATE));
  assert.equal(real4.code, '23001', 'the real trigger refuses the line change');
  const nc4 = await rolledBack(async (tx) => {
    await tx.unsafe('drop trigger trg_invoice_draft_line_terminal on tmpos_invoice_draft.invoice_draft_line');
    return (await tx.unsafe(`${LINE_UPDATE} returning description`)).map((r) => r.description);
  });
  assert.deepEqual(nc4.value, ['Changed after discard'], `without the line trigger the discarded draft's line changes (${JSON.stringify(nc4)})`);
  assert.equal(await statusOf(discarded), 'discarded');
  assert.equal(await statusOf(open), 'draft', 'every control rolled back');
});
