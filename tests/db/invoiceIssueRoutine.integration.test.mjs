// Phase 4.0 M7B-INVOICES-ISSUE-P1 — issuing a saved store invoice draft against REAL PostgreSQL: migration 034 (schema
// tmpos_invoice_issue: per-store issuing settings and number counter, the immutable issued invoice and its lines, their
// ENABLE ALWAYS guards and the deferred commit check, the draft's terminal 'issued' state under 033's CHECK and trigger names,
// the two audit subjects, the six session-bound routines and the rollback-order anchor), exercised as the runtime's own
// non-owner login, every call bound as the production adapter binds it (every bigint as decimal text). Each title names the
// ISS ids of docs/phase-4/12 §7 and the brief's ACs it evidences.
//
// WHAT IS PROVEN.
//   IIR-01 (ISS-20, AC-11) 001-034 applied by the trusted executor, the ledger exactly 001-034 (034's checksum its up bytes);
//          034's postcondition holds and refuses every widening it names; the up refused again and over an inexact 033; a
//          clean down then up passes (rolled back); the down refused outside READ COMMITTED.
//   IIR-02 (AC-11) the up over open, edited and discarded drafts made at 033 keeps every row byte-identical (row, xmin, ctid)
//          and the catalog equal to the first apply's; the upgraded drafts then issue, and a discarded one is invalid_state.
//   IIR-03 (ISS-20) a clean 034 down leaves a catalog identical to a fresh 033 apply's; 033's down then succeeds; 034
//          re-applies to the first apply's catalog (the chain restored).
//   IIR-04 (ISS-20, D-ISS-7) 034's down refuses, changing nothing, over one settings row, the first write's settings and
//          counter, one issued invoice with its issued draft, an issued draft alone, and one audit record naming an issued
//          invoice or a store.
//   IIR-05 (ISS-20) 033's down refuses while 034 is applied; dropping each 033 function the anchor names fails 2BP01; the
//          anchor dropped, the drop passes (the control).
//   IIR-06 (ISS-21) the exact surface: eighteen functions and their attributes and ACLs; tmpos_app EXECUTE on the six only;
//          nothing for PUBLIC, anon, authenticated or tmpos_audit_writer; no table privilege by any path; schema USAGE only for
//          tmpos_app; the login refused on every table and helper (42501).
//   IIR-07 (ISS-11, AC-05) the tax formula: SQL (through issued rows and through the CHECK) equals BigInt for the fixed
//          vectors, the largest valid totals at rates 0, 1 and 100000 issue exactly and one cent more is refused.
//   IIR-08 (ISS-01 ISS-02 ISS-04, AC-03) the authority matrix: applied exactly at Invoices >= Approve with Customers >= View;
//          the preview answers the same; nothing written when refused.
//   IIR-09 (ISS-07 ISS-12, AC-02) the decision order, every refusal writing nothing.
//   IIR-10 (ISS-12 ISS-12b, AC-02) an explicit 0 rate and 'none' are distinct in the preview, the snapshot and the settings.
//   IIR-11 (ISS-09) numbering per store from 1; a rolled-back issue consumes no number.
//   IIR-12 (ISS-03 ISS-05 ISS-06 ISS-09, AC-07) races, each wait first seen in pg_locks.
//   IIR-13 (ISS-13, AC-10) the guards as the table owner, normal and replica.
//   IIR-14 (AC-10) 030's edit and 033's discard answer invalid_state on an issued draft; 033's reads never serve it.
//   IIR-15 (ISS-14, AC-04) a settings write and a customer rename after issue leave the snapshot unchanged.
//   IIR-16 (ISS-25, AC-02) the settings routine: authority, versions, concurrency, text refusals.
//   IIR-17 (ISS-15, AC-04) the reads: order, cursors, the sourceDraft filter, authority, preview parity, no actor.
//
// THE CHAIN IT WAS WRITTEN FOR (M7B-INVOICES-VOID-P1). This file proves 034 as the head: 035 (the invoice void) revokes tmpos_app's
// EXECUTE on 034's page and get, adds two internal foreign-key triggers to issued_invoice and makes 034's own down fail on the
// dependency, so on a shared service where an earlier step applied 035 it is rolled back through its own committed down and
// ledger row at setup (rollBackAbove, newest first) and put back, with its exact ledger row, by the teardown; the executor in
// this file applies THROUGH 034 only. On a fresh cluster there is nothing above 034 and the restore does nothing. 035's own
// behaviour (and its rollback, which refuses over a void record) is the void routine suite's.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file creates
// and destroys. Every fixture is synthetic and randomly suffixed. It rolls 034 (and once 033) back and re-applies it, so on a
// shared service it needs no issuing data and no discarded draft of another suite. It leaves 001-034 applied and recorded (035 put
// back above it when it found it), every
// guard trigger ALWAYS, the issuer key row it found, and NO settings, counter, issued invoice, issued line, draft, audit record,
// role row, session, mint-ledger row, fault trigger or login of its own.
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
const UP_033 = mig('033_m7b_invoice_draft_discard.up.sql');
const DOWN_033 = mig('033_m7b_invoice_draft_discard.down.sql');
const UP_034 = mig('034_m7b_invoice_issue.up.sql');
const DOWN_034 = mig('034_m7b_invoice_issue.down.sql');
/** Each up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_033 = UP_033.slice(UP_033.lastIndexOf('do $$'));
const POSTCONDITION_034 = UP_034.slice(UP_034.lastIndexOf('do $$'));

const NS = 'tmpos_invoice_issue';
const SETTINGS_GET_FN = `${NS}.m7b_issuing_settings_get`;
const SETTINGS_SET_FN = `${NS}.m7b_issuing_settings_set`;
const PREVIEW_FN = `${NS}.m7b_invoice_issue_preview`;
/** The routine under test, by name: the single place it is named. */
const ISSUE_FN = `${NS}.m7b_invoice_issue`;
const PAGE_FN = `${NS}.m7b_issued_invoice_page`;
const GET_FN = `${NS}.m7b_issued_invoice_get`;
const SETTINGS_GET = `${SETTINGS_GET_FN}(text, uuid, uuid)`;
const SETTINGS_SET = `${SETTINGS_SET_FN}(text, uuid, uuid, bigint, text, text, text, text, text, integer)`;
const PREVIEW = `${PREVIEW_FN}(text, uuid, uuid, uuid)`;
const ISSUE = `${ISSUE_FN}(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid)`;
const PAGE = `${PAGE_FN}(text, uuid, uuid, uuid, uuid, integer)`;
const GET = `${GET_FN}(text, uuid, uuid, uuid)`;
const ROUTINES = [SETTINGS_GET, SETTINGS_SET, PREVIEW, ISSUE, PAGE, GET];
const TAX = `${NS}.m7b_invoice_tax_cents(bigint, integer)`;
const ANCHOR = `${NS}.m7b_invoice_issue_prerequisites()`;
/** The twelve functions granted to nobody. */
const UNGRANTED = [`${NS}.m7b_issue_text_ok(text, integer)`, `${NS}.m7b_issue_postal_address_ok(text)`, TAX,
  `${NS}.m7b_issue_store_reader(text, uuid, uuid, boolean, text)`, `${NS}.m7b_issuing_settings_guard()`, `${NS}.m7b_invoice_counter_guard()`,
  `${NS}.m7b_issued_invoice_guard()`, `${NS}.m7b_issued_invoice_line_guard()`, `${NS}.m7b_issue_truncate_guard()`,
  `${NS}.m7b_issued_invoice_commit_check()`, `${NS}.m7b_invoice_draft_terminal_v2()`, ANCHOR];
const DISCARD_FN = 'tmpos_invoice_discard.m7b_invoice_draft_discard';
const PAGE_V2_FN = 'tmpos_invoice_discard.m7b_invoice_draft_page_v2';
const GET_V2_FN = 'tmpos_invoice_discard.m7b_invoice_draft_get_v2';
const PAGE_028_FN = 'tmpos_invoice_draft.m7b_invoice_draft_page';
const GET_028_FN = 'tmpos_invoice_draft.m7b_invoice_draft_get';
const CREATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_create_v3';
const UPDATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_update_v2';
/** The five 033 functions the anchor names. */
const ANCHORED = ['tmpos_invoice_discard.m7b_invoice_draft_terminal()', 'tmpos_invoice_discard.m7b_invoice_draft_line_terminal()',
  `${DISCARD_FN}(text, uuid, uuid, uuid, bigint)`, `${PAGE_V2_FN}(text, uuid, uuid, uuid, integer)`, `${GET_V2_FN}(text, uuid, uuid, uuid)`];
const GUARD_CLASS = 530_030;
const SETTINGS_CLASS = 530_034;
const MIGRATOR = { purpose: 'migration', migratorRef: 'iir-migrator', runtimeRef: 'iir-runtime' };
const LOCK_KEY = 529_535;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_iir_probe';
const FAULT = `iir_fault_${SUFFIX.replace(/-/g, '')}`;
const HOUR = 3_600_000;
const ROLLBACK = new Error('iir: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const MAX = 9_007_199_254_740_991n;
const MAX_N = 9_007_199_254_740_991;
/** The tax of a subtotal at a rate in thousandths of a percent, in BigInt (doc 12 §10.8). */
const taxOf = (s, r) => (BigInt(s) * BigInt(r) + 50_000n) / 100_000n;
const EDITABLE = ['manager', 'technician', 'sales_staff'];
const LEVELS = [...TENANT_ORDERING];
const DRAFT_TABLES = ['tmpos_invoice_draft.invoice_draft', 'tmpos_invoice_draft.invoice_draft_line'];
const ISSUE_TABLES = [`${NS}.store_issuing_settings`, `${NS}.store_invoice_counter`, `${NS}.issued_invoice`, `${NS}.issued_invoice_line`];
/** 034's foreign keys onto existing tables (034 file, section 6). */
const FKS_034 = ['issued_invoice_customer_fkey', 'issued_invoice_draft_fkey', 'issued_invoice_store_fkey', 'store_invoice_counter_store_fkey',
  'store_issuing_settings_store_fkey'];

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (the routine suites')
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

const TARGET = resolveDisposableTarget('IIR');
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
/** Synthetic audit records (request ids), removed with the append-only trigger lifted. */
const SYNTHETIC_AUDITS = [];
let issuerKeyBefore;
let roleCheckDef = null;

/** The trusted executor over the migration files THROUGH `through` (034 when not named: 035 and later are hidden, this file proves 034 as the head). */
async function trustedApply(through = '034') {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const port = createNodeFsPort(MIG_DIR, MIG_REL);
    return await runTrustedApply({
      fsPort: portThrough(port, through), adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 300_000,
    });
  } finally {
    await handle.dispose();
  }
}
const ledgerHas = async (v) => (await owner`select exists (select 1 from public.schema_migrations where version = ${v}) as e`)[0].e;
const applied034 = async () => (await owner`select pg_catalog.to_regclass('tmpos_invoice_issue.issued_invoice') is not null as e`)[0].e;

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
const DRAFT_TERMINAL = [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']];
const DRAFT_IMMUTABLE = [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_immutable']];
const ISSUE_GUARDS = [[`${NS}.issued_invoice_line`, 'trg_issued_invoice_line_guard'], [`${NS}.issued_invoice`, 'trg_issued_invoice_guard'],
  [`${NS}.store_invoice_counter`, 'trg_store_invoice_counter_guard'], [`${NS}.store_issuing_settings`, 'trg_store_issuing_settings_guard']];
/** Removes the issuing rows of `tenants` with the guards lifted in this one transaction: invoices and lines, counters and settings. */
async function removeIssuing(sql, tenants, { invoices = true, settings = true } = {}) {
  await withTriggersLifted(sql, ISSUE_GUARDS, async () => {
    if (invoices) {
      await sql`delete from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${tenants}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.issued_invoice where tenant_id = any(${tenants}::uuid[])`;
    }
    if (settings) {
      await sql`delete from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${tenants}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${tenants}::uuid[])`;
    }
  });
}
/** Removes drafts (open, discarded, issued), their lines and audit subjects — the terminal triggers lifted in this one transaction. */
async function removeDrafts(sql, drafts) {
  if (drafts.length === 0) return;
  await withTriggersLifted(sql, AUDIT_TRIGGER, () => sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`);
  await withTriggersLifted(sql, DRAFT_TERMINAL, async () => {
    await sql`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = any(${drafts}::uuid[])`;
    await sql`delete from tmpos_invoice_draft.invoice_draft where draft_id = any(${drafts}::uuid[])`;
  });
}
/** Everything this suite wrote that 034's or 033's rollback would refuse over, and its role rows. */
async function cleanAll() {
  await owner.begin(RC, async (sql) => {
    if (SYNTHETIC_AUDITS.length > 0) {
      await withTriggersLifted(sql, AUDIT_TRIGGER, () => sql`delete from public.audit_event where request_id = any(${SYNTHETIC_AUDITS}::text[])`);
    }
    if (TENANTS.length === 0) return;
    if ((await sql`select pg_catalog.to_regclass('tmpos_invoice_issue.issued_invoice') is not null as e`)[0].e) await removeIssuing(sql, TENANTS);
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    await removeDrafts(sql, drafts);
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}
/** Every issuing row in the whole database (a rollback of 034 needs none), or null when 034 is not applied. */
async function globalIssuing() {
  if (!(await applied034())) return null;
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_issue.store_issuing_settings)::int as settings,
    (select count(*) from tmpos_invoice_issue.store_invoice_counter)::int as counters,
    (select count(*) from tmpos_invoice_issue.issued_invoice)::int as invoices,
    (select count(*) from tmpos_invoice_issue.issued_invoice_line)::int as lines,
    (select count(*) from tmpos_invoice_draft.invoice_draft where status = 'issued')::int as issued,
    (select count(*) from public.audit_event where subject_issued_invoice_id is not null or subject_store_id is not null)::int as subjects`;
  return { ...r };
}
const NO_ISSUING = Object.freeze({ settings: 0, counters: 0, invoices: 0, lines: 0, issued: 0, subjects: 0 });

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    // A failed IIR-02/IIR-03 may have left 034 (or 033) rolled back: the executor applies the missing files again.
    await step(async () => {
      if (!(await ledgerHas('034'))) {
        const report = await trustedApply();
        assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
      }
    });
    await step(async () => {
      if (await applied034()) await owner.unsafe(`drop trigger if exists ${FAULT} on tmpos_invoice_issue.store_invoice_counter`);
      await owner.unsafe(`drop function if exists public.${FAULT}()`);
    });
    await step(async () => {
      const [{ present }] = await owner`select exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.user_membership'::regclass
        and conname = 'user_membership_role_scope_chk') as present`;
      if (!present && roleCheckDef !== null) {
        await owner`delete from user_membership where role_id = 'shift_lead' and tenant_id = any(${TENANTS}::uuid[])`;
        await owner.unsafe(`alter table public.user_membership add constraint user_membership_role_scope_chk ${roleCheckDef}`);
      }
    });
    await step(cleanAll);
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
          exists (select 1 from public.schema_migrations where version = '034') as ledger_034,
          pg_catalog.to_regprocedure(${ISSUE}) is not null as routine_034,
          (select pg_catalog.string_agg(t.v, ',' order by t.v collate "C") from (select g.tgrelid::regclass::text || '.' || g.tgname::text || ':' || g.tgenabled::text as v
             from pg_catalog.pg_trigger g where not g.tgisinternal and g.tgrelid = any (array['tmpos_invoice_draft.invoice_draft'::regclass,
               'tmpos_invoice_draft.invoice_draft_line'::regclass, 'tmpos_invoice_issue.store_issuing_settings'::regclass,
               'tmpos_invoice_issue.store_invoice_counter'::regclass, 'tmpos_invoice_issue.issued_invoice'::regclass,
               'tmpos_invoice_issue.issued_invoice_line'::regclass]::oid[])) t) as triggers,
          (select count(*) from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${TENANTS}::uuid[]))::int as settings,
          (select count(*) from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${TENANTS}::uuid[]))::int as counters,
          (select count(*) from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[]))::int as invoices,
          (select count(*) from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${TENANTS}::uuid[]))::int as lines,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where tenant_id = any(${TENANTS}::uuid[])
             or request_id = any(${SYNTHETIC_AUDITS}::text[]))::int as audits,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as roles,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.user_membership'::regclass and conname = 'user_membership_role_scope_chk') as role_check,
          pg_catalog.to_regproc(${`public.${FAULT}`}) is null as no_fault,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, {
        ledger_034: true, routine_034: true,
        triggers: ['tmpos_invoice_draft.invoice_draft.trg_invoice_draft_immutable:A', 'tmpos_invoice_draft.invoice_draft.trg_invoice_draft_terminal:A',
          'tmpos_invoice_draft.invoice_draft_line.trg_invoice_draft_line_terminal:A', 'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_commit_check:A',
          'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_guard:A', 'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_truncate:A',
          'tmpos_invoice_issue.issued_invoice_line.trg_issued_invoice_line_guard:A', 'tmpos_invoice_issue.issued_invoice_line.trg_issued_invoice_line_truncate:A',
          'tmpos_invoice_issue.store_invoice_counter.trg_store_invoice_counter_guard:A', 'tmpos_invoice_issue.store_invoice_counter.trg_store_invoice_counter_truncate:A',
          'tmpos_invoice_issue.store_issuing_settings.trg_store_issuing_settings_guard:A', 'tmpos_invoice_issue.store_issuing_settings.trg_store_issuing_settings_truncate:A',
        ].sort().join(','),
        settings: 0, counters: 0, invoices: 0, lines: 0, drafts: 0, audits: 0, roles: 0, sessions: 0, role_check: true, no_fault: true, login: false,
      }, 'left as found: 034 applied and recorded, every guard ALWAYS, nothing of this suite\'s retained');
    });
    // M7B-INVOICES-VOID-P1: a shared service's 035, rolled back at setup, is put back with its exact ledger row (nothing to do on a fresh cluster).
    await step(() => above034.restore());
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IIR teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: the chain through 034 (035 rolled back when present), a real non-owner runtime login, the issuer key installed by the owner
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
// 035 (when an earlier step of a shared service applied it) is rolled back through its own committed down and ledger row, and
// restored by the teardown; on a fresh cluster there is nothing above 034 and the restore does nothing.
const above034 = await rollBackAbove(owner, MIG_DIR, '034');
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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`iir-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IIR ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `iir-${label}-${SUFFIX}`;
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
const setLevel = (tenant, role, domain, level, db = owner) => db`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;
const clearLevels = (tenant) => owner`delete from tmpos_role.tenant_role_level where tenant_id = ${tenant}`;

// ---------------------------------------------------------------------------
// the runtime login's calls, bound as the production adapters bind them
// ---------------------------------------------------------------------------

const big = (v) => (v === null || v === undefined ? null : String(v));
const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:iir', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
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
const SUBTOTAL = sumOf(LINES); // 21999
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
/** 033's discard, as the discard mutator binds it. */
async function discard(key, store, tenant, draft, version, { db = runtime } = {}) {
  return (await db.unsafe(`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version
    from ${DISCARD_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint)`, [key, store, draft, tenant, String(version)])).map((r) => ({ ...r }));
}
const DRAFT_DONE = (who, tenant, store, version) => ({ o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id,
  o_membership_id: who.memberships[0], o_version: String(version) });
const DRAFT_NO = (word) => ({ o_outcome: word, o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: null });

const SETTINGS = Object.freeze({ legalName: 'IIR Legal Name LLC', storeName: 'IIR Store', postalAddress: '1 Main St\nSuite 2\nSpringfield',
  taxRegistrationId: 'TAX-IIR-1', taxMode: 'exclusive_rate', taxRate: 8875 });
/** 034's settings write, as the settings mutator binds it. */
async function settingsSet(key, { store, tenant, version, s = SETTINGS, db = runtime }) {
  return (await db.unsafe(`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version
    from ${SETTINGS_SET_FN}($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
  [key, store, tenant, big(version), s.legalName, s.storeName, s.postalAddress, s.taxRegistrationId, s.taxMode, s.taxRate])).map((r) => ({ ...r }));
}
const SET_DONE = DRAFT_DONE;
const SET_NO = DRAFT_NO;
const settingsGet = async (key, tenant, store, { db = runtime } = {}) =>
  (await db.unsafe(`select * from ${SETTINGS_GET_FN}($1::text, $2::uuid, $3::uuid)`, [key, tenant, store])).map((r) => ({ ...r }));
const GET_NULLS = { o_tenant_id: null, o_store_id: null, o_version: null, o_legal_name: null, o_store_name: null, o_postal_address: null,
  o_tax_registration_id: null, o_tax_mode: null, o_tax_rate: null };
const SETTINGS_ROW = (tenant, store, version, s = SETTINGS) => ({ o_outcome: 'settings', o_tenant_id: tenant, o_store_id: store, o_version: String(version),
  o_legal_name: s.legalName, o_store_name: s.storeName, o_postal_address: s.postalAddress, o_tax_registration_id: s.taxRegistrationId,
  o_tax_mode: s.taxMode, o_tax_rate: s.taxRate });

const ISSUE_COLS = 'o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id, o_customer_id, o_number';
/** The issue (ISSUE_FN), as the issue mutator binds it: every bigint as decimal text. */
async function issue(key, { store, tenant, draft, version = 1, sv = 1, cv = 1, invoice = randomUUID(), db = runtime }) {
  return (await db.unsafe(`select ${ISSUE_COLS} from ${ISSUE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [key, store, draft, tenant, big(version), big(sv), big(cv), invoice])).map((r) => ({ ...r }));
}
const ISSUE_NO = (word) => ({ o_outcome: word, o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: null,
  o_invoice_id: null, o_customer_id: null, o_number: null });
const ISSUED = (who, f, { version = 2, invoice, number, customer = f.C1 }) => ({ o_outcome: 'applied', o_tenant_id: f.T, o_store_id: f.S,
  o_actor_id: who.id, o_membership_id: who.memberships[0], o_version: String(version), o_invoice_id: invoice, o_customer_id: customer, o_number: String(number) });
const preview = async (key, tenant, store, draft, { db = runtime } = {}) =>
  (await db.unsafe(`select * from ${PREVIEW_FN}($1::text, $2::uuid, $3::uuid, $4::uuid)`, [key, tenant, store, draft])).map((r) => ({ ...r }));
const page = async (key, tenant, store, { after = null, source = null, limit = 51, db = runtime } = {}) =>
  (await db.unsafe(`select * from ${PAGE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`, [key, tenant, store, after, source, limit])).map((r) => ({ ...r }));
const getInvoice = async (key, tenant, store, invoice, { db = runtime } = {}) =>
  (await db.unsafe(`select * from ${GET_FN}($1::text, $2::uuid, $3::uuid, $4::uuid)`, [key, tenant, store, invoice])).map((r) => ({ ...r }));
/** 033's page_v2 and get_v2 (or 028's, the owner's only, with `fn`). */
const pageV2 = async (key, tenant, store, { db = runtime, fn = PAGE_V2_FN } = {}) => (await db.unsafe(
  `select o_outcome, o_draft_id, o_status from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::integer)`, [key, tenant, store, null, 51])).map((r) => ({ ...r }));
const getV2 = async (key, tenant, store, draft, { db = runtime, fn = GET_V2_FN } = {}) => (await db.unsafe(
  `select * from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid)`, [key, tenant, store, draft])).map((r) => ({ ...r }));
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? null }));
const outcomes = (rows) => rows.map((r) => r.o_outcome);

/** What a scope holds now: settings, counters and invoices (with row versions), invoice lines; every audit, outbox and idempotency row. */
async function issuingOf(tenants) {
  const rows = async (rel, cols) => (await owner.unsafe(`select ${cols}, r.xmin::text as xmin, r.ctid::text as ctid from ${rel} r
    where r.tenant_id = any($1::uuid[]) order by 1`, [tenants])).map((x) => ({ ...x }));
  const [c] = await owner`select
    (select count(*) from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${tenants}::uuid[]))::int as lines,
    (select count(*) from public.audit_event)::int as audits,
    (select count(*) from tmpos_internal.outbox_event)::int as events,
    (select count(*) from tmpos_internal.idempotency_record)::int as records`;
  return {
    settings: await rows(`${NS}.store_issuing_settings`, 'r.store_id::text as store, r.version::text as version'),
    counters: await rows(`${NS}.store_invoice_counter`, 'r.store_id::text as store, r.last_number::text as last'),
    invoices: await rows(`${NS}.issued_invoice`, 'r.invoice_id::text as invoice, r.number::text as number'),
    ...c,
  };
}
/** A draft's exact stored state: the header's and each line's row, xmin and ctid (a write would move xmin and ctid). */
async function stateOf(draft) {
  const header = (await owner`select pg_catalog.to_jsonb(d) as row, d.xmin::text as xmin, d.ctid::text as ctid
    from tmpos_invoice_draft.invoice_draft d where d.draft_id = ${draft}`).map((r) => ({ ...r }));
  const lines = (await owner`select pg_catalog.to_jsonb(l) as row, l.xmin::text as xmin, l.ctid::text as ctid
    from tmpos_invoice_draft.invoice_draft_line l where l.draft_id = ${draft} order by l.position`).map((r) => ({ ...r }));
  return { header, lines };
}
/** The issuing state of `tenants` and the stored state of `drafts`, for "nothing written". */
const footprint = async (tenants, drafts = []) => ({ issuing: await issuingOf(tenants), drafts: await Promise.all(drafts.map(stateOf)) });
const draftOf = async (draft) => ({ ...(await owner`select status, version::text as version from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`)[0] });
const counterOf = async (store) => (await owner`select last_number::text as n from tmpos_invoice_issue.store_invoice_counter where store_id = ${store}`)[0]?.n ?? null;
const invoicesOfDraft = async (draft) => (await owner`select invoice_id from tmpos_invoice_issue.issued_invoice where source_draft_id = ${draft}`).map((r) => r.invoice_id);
const customerVersionOf = async (customer) => Number((await owner`select row_version::text as v from tmpos_customer.customer where customer_id = ${customer}`)[0].v);
/** Runs `fn` in an owner transaction that is always rolled back: { value } or the { code, message, detail } it raised. */
async function rolledBack(fn, isolation = RC) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? null }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}
/** Inside `tx`: `fn(sp)` in a savepoint that is always rolled back — 'accepted' when it succeeded, else the SQLSTATE it raised. */
async function attempt(tx, fn) {
  const SP = new Error('iir: roll the savepoint back');
  try {
    await tx.savepoint(async (sp) => { await fn(sp); throw SP; });
  } catch (err) {
    if (err === SP) return 'accepted';
    return err.code ?? String(err.message);
  }
  return 'unreachable';
}
/**
 * A synthetic audit record as the command transaction would write one (removed by the teardown): an issue's at store scope
 * naming `invoice`, or a settings write's at tenant scope naming the store `subjectStore`.
 */
async function syntheticAudit(tenant, { invoice = null, store = null, subjectStore = null }) {
  const id = `iir-audit-${randomUUID()}`;
  SYNTHETIC_AUDITS.push(id);
  const issueRecord = invoice !== null;
  await owner`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
      reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_issued_invoice_id, subject_store_id)
    values (${id}, ${randomUUID()}, ${issueRecord ? 'store' : 'tenant'}, ${tenant}, ${issueRecord ? store : null},
      ${issueRecord ? 'store.invoice.issue' : 'tenant.issuing_settings.update'}, ${issueRecord ? 'issue_invoices' : 'edit_issuing_settings'}, 'allow',
      'command_committed', 'IIR synthetic record.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1', 'durable_compliance_event',
      ${invoice}, ${subjectStore})`;
  return id;
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
/** The ungranted advisory lock `pid` waits for: its class (classid) and mode. */
const advisoryWait = async (pid) => (await owner`select l.classid::int as class, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted and l.locktype = 'advisory'`).map((r) => ({ ...r }));
/** The relation of the row `pid` waits on: a waiter for a row lock holds that tuple's lock (granted) while it waits on the xid. */
const rowWaitOn = async (pid) => (await owner`select l.relation::regclass::text as rel from pg_catalog.pg_locks l
  where l.pid = ${pid} and l.locktype = 'tuple' and l.granted`).map((r) => r.rel);
/** A row is held FOR UPDATE (or written) by someone: a third session cannot take it NOWAIT. */
const rowHeld = async (rel, column, id) => (await errorOf(owner.begin(RC, (tx) => tx.unsafe(`select 1 from ${rel} where ${column} = $1 for update nowait`, [id]))))?.code === '55P03';
/** Neither a deadlock victim nor any other failure: the transaction ended as `how`. */
function finished(out, label, how = 'committed') {
  assert.notEqual(out.code, '40P01', `${label}: a deadlock (${JSON.stringify(out)})`);
  assert.equal(out.outcome, how, `${label}: ${JSON.stringify(out)}`);
  return out;
}
/** Releases a lever (if it was started) and waits for it, so a failed case never leaves a transaction open. */
async function settle(...levers) {
  for (const l of levers) {
    if (l === null || l === undefined) continue;
    if (typeof l.release === 'function') l.release('rollback');
    await l.done;
  }
}
const grantsOf = async (signature) => (await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.grantor::regrole::text as grantor, g.is_grantable as grantable
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${signature}::regprocedure`)
  .map((x) => ({ ...x })).sort((a, b) => (`${a.grantee}/${a.priv}` < `${b.grantee}/${b.priv}` ? -1 : 1));
const EXECUTE_BY = (...grantees) => grantees.map((grantee) => ({ grantee, priv: 'EXECUTE', grantor: ME, grantable: false }))
  .sort((a, b) => (a.grantee < b.grantee ? -1 : 1));

/** The catalog of every object 034 touches or creates, with no oid in it (the drafts, stores, customers, audit table, every tmpos schema). */
async function catalogOf() {
  const [r] = await owner`with rels as (
      select c.oid from pg_catalog.pg_class c
       where c.oid = any (array['tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass, 'public.store'::regclass,
                               'tmpos_customer.customer'::regclass, 'public.audit_event'::regclass, 'public.tenant'::regclass]::oid[])
          or c.relnamespace = pg_catalog.to_regnamespace('tmpos_invoice_issue'))
    select pg_catalog.jsonb_build_object(
    'schemas', (select pg_catalog.jsonb_agg(n.nspname::text || ':' || coalesce(n.nspacl::text, '-') || ':' || coalesce(pg_catalog.md5(pg_catalog.obj_description(n.oid, 'pg_namespace')), '-')
                  order by n.nspname collate "C") from pg_catalog.pg_namespace n where n.nspname like 'tmpos%'),
    'constraints', (select pg_catalog.jsonb_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_catalog.pg_get_constraintdef(k.oid) || ':' || k.convalidated::text
                      order by k.conrelid::regclass::text collate "C", k.conname collate "C")
                      from pg_catalog.pg_constraint k where k.conrelid in (select oid from rels)),
    'triggers', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('rel', g.tgrelid::regclass::text,
                      'name', case when g.tgisinternal then 'internal:' || coalesce((select k.conname::text from pg_catalog.pg_constraint k where k.oid = g.tgconstraint), '?') else g.tgname::text end,
                      'fn', g.tgfoid::regprocedure::text, 'type', g.tgtype, 'enabled', g.tgenabled, 'attr', g.tgattr::text, 'qual', g.tgqual is null,
                      'comment', pg_catalog.obj_description(g.oid, 'pg_trigger'), 'deferrable', g.tgdeferrable, 'deferred', g.tginitdeferred)
                    order by g.tgrelid::regclass::text collate "C", g.tgisinternal, g.tgname::text collate "C", g.tgfoid::regprocedure::text collate "C")
                   from pg_catalog.pg_trigger g where g.tgrelid in (select oid from rels)),
    'columns', (select pg_catalog.jsonb_agg(a.attrelid::regclass::text || '.' || a.attname::text || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
                    || ':' || a.atthasdef::text || ':' || coalesce((select pg_catalog.pg_get_expr(d.adbin, d.adrelid) from pg_catalog.pg_attrdef d
                         where d.adrelid = a.attrelid and d.adnum = a.attnum), '-') || ':' || pg_catalog.format_type(a.atttypid, null) || ':' || a.attcollation::regcollation::text
                    || ':' || coalesce(a.attacl::text, '-') || ':' || coalesce(pg_catalog.md5(pg_catalog.col_description(a.attrelid, a.attnum)), '-')
                  order by a.attrelid::regclass::text collate "C", a.attnum) from pg_catalog.pg_attribute a
                 where a.attrelid in (select oid from rels) and a.attnum > 0 and not a.attisdropped),
    'indexes', (select pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(x.indexrelid) order by pg_catalog.pg_get_indexdef(x.indexrelid) collate "C")
                  from pg_catalog.pg_index x where x.indrelid in (select oid from rels)),
    'draft_relations', (select pg_catalog.jsonb_agg(c.relname::text || ':' || c.relkind::text order by c.relname collate "C") from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_draft'::regnamespace),
    'functions', (select pg_catalog.jsonb_agg(p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, '-') || ':' || coalesce(p.proconfig::text, '-') || ':' || p.provolatile::text
                      || ':' || p.prosecdef::text || ':' || pg_catalog.md5(coalesce(p.prosrc, '')) || ':' || coalesce(pg_catalog.md5(pg_catalog.obj_description(p.oid, 'pg_proc')), '-')
                      || ':' || pg_catalog.pg_get_function_result(p.oid) || ':' || l.lanname::text || ':' || p.proisstrict::text || ':' || p.proparallel::text
                      || ':' || p.proowner::regrole::text || ':' || coalesce(pg_catalog.md5(pg_catalog.pg_get_function_sqlbody(p.oid)), '-')
                    order by p.oid::regprocedure::text collate "C")
                   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace join pg_catalog.pg_language l on l.oid = p.prolang
                  where n.nspname like 'tmpos%'),
    'relations', (select pg_catalog.jsonb_agg(c.oid::regclass::text || ':' || c.relkind::text || ':' || c.relowner::regrole::text || ':' || coalesce(pg_catalog.md5(pg_catalog.obj_description(c.oid, 'pg_class')), '-')
                    order by c.oid::regclass::text collate "C") from pg_catalog.pg_class c where c.oid in (select oid from rels)),
    'tmpos_app_exec', (select pg_catalog.jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text collate "C")
                         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                        where n.nspname like 'tmpos%' and pg_catalog.has_function_privilege('tmpos_app', p.oid, 'EXECUTE')),
    'tables', (select pg_catalog.jsonb_agg(c.oid::regclass::text || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text || ':' || coalesce(c.relacl::text, '-')
                   order by c.oid::regclass::text collate "C")
                 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                where c.relkind = 'r' and (n.nspname like 'tmpos%' or n.nspname = 'public')),
    'ledger', (select pg_catalog.string_agg(version || ':' || checksum, ',' order by version) from public.schema_migrations)
  ) as snap`;
  return r.snap;
}
const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
/** Every row of a scope that 034's apply or rollback could touch, exactly: row, xmin and ctid. */
async function rowsOf(tenants) {
  const q = async (rel) => ((await owner`select pg_catalog.to_regclass(${rel}) is not null as e`)[0].e
    ? (await owner.unsafe(`select pg_catalog.to_jsonb(r)::text as row, r.xmin::text as xmin, r.ctid::text as ctid from ${rel} r where r.tenant_id = any($1::uuid[]) order by 1`, [tenants]))
      .map((x) => `${x.row} ${x.xmin} ${x.ctid}`)
    : []);
  return {
    drafts: await q('tmpos_invoice_draft.invoice_draft'), lines: await q('tmpos_invoice_draft.invoice_draft_line'),
    customers: await q('tmpos_customer.customer'), stores: await q('public.store'), roles: await q('tmpos_role.tenant_role_level'),
    settings: await q(`${NS}.store_issuing_settings`), counters: await q(`${NS}.store_invoice_counter`),
    invoices: await q(`${NS}.issued_invoice`), invoiceLines: await q(`${NS}.issued_invoice_line`), audits: await q('public.audit_event'),
  };
}

// ---------------------------------------------------------------------------
// the scenes
// ---------------------------------------------------------------------------

/**
 * A fresh tenant, store and two customers; a store owner and a manager (store grants) and a tenant owner (one tenant grant),
 * each with a live session; the store's issuing settings written by the tenant owner (unless `settings` is null); `drafts`
 * drafts saved by the store owner for the first customer.
 */
async function scene(label, { settings = SETTINGS, drafts = 1, lines = LINES } = {}) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label} ${SUFFIX}`);
  const C1 = await newCustomer(T, `${label}-1`);
  const C2 = await newCustomer(T, `${label}-2`);
  const boss = await actor(`${label}-owner`, [storeGrant(T, S, 'store_owner')]);
  const manager = await actor(`${label}-manager`, [storeGrant(T, S, 'manager')]);
  const own = await actor(`${label}-tenant-owner`, [tenantGrant(T, 'store_owner')]);
  const f = { label, T, S, C1, C2, boss, manager, own, kBoss: await mint(boss), kManager: await mint(manager), kOwn: await mint(own), sv: 0, drafts: [] };
  if (settings !== null) {
    assert.deepEqual(await settingsSet(f.kOwn, { store: S, tenant: T, version: 0, s: settings }), [SET_DONE(own, T, S, 1)], `${label}: settings v1`);
    f.sv = 1;
  }
  for (let i = 0; i < drafts; i += 1) f.drafts.push(await create(f.kBoss, S, T, C1, lines));
  f.draft = f.drafts[0];
  return f;
}
/** Another actor of `role` at the scene's store, with a live session of its own. */
async function member(f, label, role, accountStatus = 'active') {
  const who = await actor(`${f.label}-${label}-${role}`, [storeGrant(f.T, f.S, role)], accountStatus);
  return { who, key: await mint(who) };
}
/** The issue's arguments for draft `draft` of scene `f` at its current settings version. */
const at = (f, draft, extra = {}) => ({ store: f.S, tenant: f.T, draft, sv: f.sv, ...extra });
/** Sets a counter as the table owner (the guard lifted in this committed transaction). */
const forceCounter = (store, last) => owner.begin(RC, (sql) => withTriggersLifted(sql, [[`${NS}.store_invoice_counter`, 'trg_store_invoice_counter_guard']],
  () => sql`update tmpos_invoice_issue.store_invoice_counter set last_number = ${String(last)}::bigint where store_id = ${store}`));
/** Sets a draft's version as the table owner (029's step rule lifted in this committed transaction). */
const forceVersion = (draft, version) => owner.begin(RC, (sql) => withTriggersLifted(sql, DRAFT_IMMUTABLE,
  () => sql`update tmpos_invoice_draft.invoice_draft set version = ${String(version)}::bigint where draft_id = ${draft}`));
/** Renames a customer as the table owner, its row_version stepped (024's edit's effect). */
const rename = (customer, name, db = owner) => db`update tmpos_customer.customer set name = ${name}, row_version = row_version + 1 where customer_id = ${customer} returning row_version::text as v`;

// The tenant every 'tenant_mismatch' names (a real tenant the actors hold no grant in), and the catalog the cases rely on.
const T_OTHER = await newTenant('other');
assert.deepEqual(Object.fromEntries(EDITABLE.map((r) => [r, [TENANT_ROLE_PERMISSION_DEFAULTS[r].invoices, TENANT_ROLE_PERMISSION_DEFAULTS[r].customers]])),
  { manager: ['full', 'full'], technician: ['view', 'view'], sales_staff: ['create', 'create'] }, 'the catalog\'s Invoices and Customers defaults the cases rely on');
assert.deepEqual(LEVELS, ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'], 'the catalog\'s ordering');
const firstCatalog = await catalogOf();

// ===========================================================================
// IIR-01..06: the migration, its rollback and its surface
// ===========================================================================

test('IIR-01 (ISS-20, AC-11): 001-034 applied by the trusted executor, the ledger exactly 001-034 with 034\'s checksum its up bytes; 034\'s postcondition holds and refuses every widening it names; the up refused again and over an inexact 033; a clean down then up passes; the down refused outside READ COMMITTED', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 34 }, (_, i) => [String(i + 1).padStart(3, '0'), false]), 'exactly 001-034');
  assert.equal(ledger[33].checksum, createHash('sha256').update(UP_034).digest('hex'), '034\'s checksum is its up bytes');
  assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_034).simple())).code, undefined, 'the applied state satisfies 034\'s postcondition');
  // Each widening's exact refusal, by the postcondition clause (a)-(j) of 034's up that targets it, or by the earlier one that shadows it.
  const R = (s) => `migration 034 refused: ${s}`;
  const CONTENTS = R(`schema ${NS} does not hold exactly this file's functions and relations, or it or a table is not owned by the applying principal`);
  const SCHEMA_GRANT = (v) => R(`schema ${NS} carries an unexpected grant or lacks an expected one (${v}), or tmpos_app cannot use it`);
  const FN_SHAPE = (v) => R(`a function of schema ${NS} is not the one its section declares (language, security, volatility, settings, owner, comment, arguments or result: ${v})`);
  const FN_GRANT = (v) => R(`an unexpected grant remains on a function of schema ${NS}, or an entry is missing (${v})`);
  const TABLE_PRIV = (v) => R(`${v} holds a privilege on a table of schema ${NS}, or a table's row security is not enabled without policy and unforced`);
  const TRIGGERS = (v) => R(`a trigger of the issuing tables or of the drafts is not exactly the one this file declares (${v})`);
  const AUDIT_SUBJECTS = R('the audit subjects are not the nullable uuids, indexes and writer reach section 9 declares, or a column of the audit table carries a grant');
  const ISSUE_TRIGGERS = [
    `${NS}.issued_invoice.trg_issued_invoice_commit_check:${NS}.m7b_issued_invoice_commit_check():5:A`,
    `${NS}.issued_invoice.trg_issued_invoice_guard:${NS}.m7b_issued_invoice_guard():31:A`, `${NS}.issued_invoice.trg_issued_invoice_truncate:${NS}.m7b_issue_truncate_guard():34:A`,
    `${NS}.issued_invoice_line.trg_issued_invoice_line_guard:${NS}.m7b_issued_invoice_line_guard():31:A`,
    `${NS}.issued_invoice_line.trg_issued_invoice_line_truncate:${NS}.m7b_issue_truncate_guard():34:A`,
    `${NS}.store_invoice_counter.trg_store_invoice_counter_guard:${NS}.m7b_invoice_counter_guard():31:A`,
    `${NS}.store_invoice_counter.trg_store_invoice_counter_truncate:${NS}.m7b_issue_truncate_guard():34:A`,
    `${NS}.store_issuing_settings.trg_store_issuing_settings_guard:${NS}.m7b_issuing_settings_guard():31:A`,
    `${NS}.store_issuing_settings.trg_store_issuing_settings_truncate:${NS}.m7b_issue_truncate_guard():34:A`,
  ].join(', ');
  for (const [label, widen, expected] of [
    ['issue EXECUTE to PUBLIC', `grant execute on function ${ISSUE} to public`, FN_GRANT('m7b_invoice_issue -:EXECUTE')],
    ['preview EXECUTE to the audit writer', `grant execute on function ${PREVIEW} to tmpos_audit_writer`, FN_GRANT('m7b_invoice_issue_preview tmpos_audit_writer:EXECUTE')],
    ['a grantable page EXECUTE', `grant execute on function ${PAGE} to tmpos_app with grant option`, FN_GRANT('m7b_issued_invoice_page tmpos_app:EXECUTE')],
    ['get EXECUTE revoked from tmpos_app', `revoke execute on function ${GET} from tmpos_app`, FN_GRANT('none listed')],
    ['the tax function to tmpos_app', `grant execute on function ${TAX} to tmpos_app`, FN_GRANT('m7b_invoice_tax_cents tmpos_app:EXECUTE')],
    ['the anchor to anon', `grant execute on function ${ANCHOR} to anon`, FN_GRANT('m7b_invoice_issue_prerequisites anon:EXECUTE')],
    ['SELECT on the issued invoices to tmpos_app', `grant select on ${NS}.issued_invoice to tmpos_app`, TABLE_PRIV('tmpos_app')],
    ['INSERT on the issued lines to authenticated', `grant insert on ${NS}.issued_invoice_line to authenticated`, TABLE_PRIV('authenticated')],
    ['a column grant on the audit table', 'grant select (subject_store_id) on public.audit_event to tmpos_app', AUDIT_SUBJECTS],
    ['USAGE on the schema to PUBLIC', `grant usage on schema ${NS} to public`, SCHEMA_GRANT('-:USAGE')],
    ['CREATE on the schema to tmpos_app', `grant create on schema ${NS} to tmpos_app`, SCHEMA_GRANT('tmpos_app:CREATE')],
    // (e)'s membership clause is shadowed by (d): as a member, tmpos_app inherits EXECUTE on every function of the owner.
    ['tmpos_app a member of the owner', `grant "${ME}" to tmpos_app`, R('a runtime role can execute a function this file does not grant it, or tmpos_app cannot execute a routine (tmpos_app m7b_invoice_counter_guard, tmpos_app m7b_invoice_draft_terminal_v2, tmpos_app m7b_invoice_issue_prerequisites, tmpos_app m7b_invoice_tax_cents, tmpos_app m7b_issue_postal_address_ok, tmpos_app m7b_issue_store_reader, tmpos_app m7b_issue_text_ok, tmpos_app m7b_issue_truncate_guard, tmpos_app m7b_issued_invoice_commit_check, tmpos_app m7b_issued_invoice_guard, tmpos_app m7b_issued_invoice_line_guard, tmpos_app m7b_issuing_settings_guard)')],
    ['a stable issue', `alter function ${ISSUE} stable`, FN_SHAPE('m7b_invoice_issue')],
    ['an invoker issue', `alter function ${ISSUE} security invoker`, FN_SHAPE('m7b_invoice_issue')],
    ['an invoker settings write', `alter function ${SETTINGS_SET} security invoker`, FN_SHAPE('m7b_issuing_settings_set')],
    ['a volatile page', `alter function ${PAGE} volatile`, FN_SHAPE('m7b_issued_invoice_page')],
    ['a reader with row security on', `alter function ${NS}.m7b_issue_store_reader(text, uuid, uuid, boolean, text) reset row_security`, FN_SHAPE('m7b_issue_store_reader')],
    ['a definer header guard', `alter function ${NS}.m7b_issued_invoice_guard() security definer`, FN_SHAPE('m7b_issued_invoice_guard')],
    ['an invoker commit check', `alter function ${NS}.m7b_issued_invoice_commit_check() security invoker`, FN_SHAPE('m7b_issued_invoice_commit_check')],
    ['the header guard disabled', `alter table ${NS}.issued_invoice disable trigger trg_issued_invoice_guard`, TRIGGERS(ISSUE_TRIGGERS.replace('m7b_issued_invoice_guard():31:A', 'm7b_issued_invoice_guard():31:D'))],
    ['the counter guard for origin sessions only', `alter table ${NS}.store_invoice_counter enable trigger trg_store_invoice_counter_guard`, TRIGGERS(ISSUE_TRIGGERS.replace('m7b_invoice_counter_guard():31:A', 'm7b_invoice_counter_guard():31:O'))],
    ['the line truncate guard dropped', `drop trigger trg_issued_invoice_line_truncate on ${NS}.issued_invoice_line`, TRIGGERS(ISSUE_TRIGGERS.replace(`, ${NS}.issued_invoice_line.trg_issued_invoice_line_truncate:${NS}.m7b_issue_truncate_guard():34:A`, ''))],
    ['a second header trigger', `create trigger extra before delete on ${NS}.issued_invoice for each row execute function ${NS}.m7b_issued_invoice_guard()`, TRIGGERS(`${NS}.issued_invoice.extra:${NS}.m7b_issued_invoice_guard():11:O, ${ISSUE_TRIGGERS}`)],
    ['the draft terminal trigger\'s comment changed', 'comment on trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft is \'changed\'', TRIGGERS(ISSUE_TRIGGERS)],
    ['the draft terminal trigger rebound to 033\'s function', `drop trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft;
      create trigger trg_invoice_draft_terminal before insert or update or delete on tmpos_invoice_draft.invoice_draft for each row execute function tmpos_invoice_discard.m7b_invoice_draft_terminal();
      alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_terminal;
      comment on trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft is 'Phase 4.0 M7b (migration 033): the terminal discarded state of an invoice draft header (tmpos_invoice_discard.m7b_invoice_draft_terminal). Enabled ALWAYS.'`, TRIGGERS(ISSUE_TRIGGERS)],
    ['an unvalidated status CHECK', 'alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_status_chk, add constraint invoice_draft_status_chk check (status in (\'draft\', \'discarded\', \'issued\')) not valid', R('invoice_draft_status_chk is not the widened CHECK, or schema tmpos_invoice_draft does not hold exactly 033\'s relations')],
    ['a function in the schema', `create function ${NS}.extra() returns integer language sql as 'select 1'`, CONTENTS],
    ['a relation in the schema', `create table ${NS}.extra (x integer)`, CONTENTS],
    ['a type in the schema', `create type ${NS}.extra_t as enum ('a')`, CONTENTS],
    ['row security off on the settings', `alter table ${NS}.store_issuing_settings disable row level security`, TABLE_PRIV('no role')],
    ['forced row security on the counter', `alter table ${NS}.store_invoice_counter force row level security`, TABLE_PRIV('no role')],
    ['a policy on the issued invoices', `create policy extra on ${NS}.issued_invoice using (true)`, TABLE_PRIV('no role')],
    ['an audit subject with a default', 'alter table public.audit_event alter column subject_store_id set default pg_catalog.gen_random_uuid()', AUDIT_SUBJECTS],
    ['an audit subject index dropped', 'drop index public.idx_audit_event_subject_store_occurred', AUDIT_SUBJECTS],
    ['a cascading foreign key', `alter table ${NS}.issued_invoice drop constraint issued_invoice_customer_fkey, add constraint issued_invoice_customer_fkey foreign key (tenant_id, customer_id) references tmpos_customer.customer (tenant_id, customer_id) on delete cascade`, R('a foreign key of the issuing tables is not ON DELETE RESTRICT ON UPDATE RESTRICT, or the commit check is not deferred')],
    // (j)'s dependency clause is shadowed by (b): the replaced anchor's own shape no longer matches its section.
    ['the anchor without its dependencies', `create or replace function ${ANCHOR} returns boolean language sql stable set search_path = pg_catalog, pg_temp as 'select true'`, FN_SHAPE('m7b_invoice_issue_prerequisites')],
    // (b) itself checks the schema comment; it names no function, so its message falls back to 'a signature'.
    ['the schema comment dropped', `comment on schema ${NS} is null`, FN_SHAPE('a signature')],
    ['the issue\'s comment dropped', `comment on function ${ISSUE} is null`, FN_SHAPE('m7b_invoice_issue')],
  ]) {
    const out = await rolledBack(async (tx) => { await tx.unsafe(widen).simple(); await tx.unsafe(POSTCONDITION_034).simple(); });
    assert.equal(out.code, '55000', `${label}: refused (${JSON.stringify(out)})`);
    assert.equal(out.message, expected, `${label}: the exact refusal`);
  }
  const again = await rolledBack((tx) => tx.unsafe(UP_034).simple());
  assert.deepEqual([again.code, again.message], ['55000', 'migration 034 refused: schema tmpos_invoice_issue or an audit subject column or index of this file already exists']);
  // Inside one rolled-back transaction: every issuing row cleared (so the down can run whatever another suite left), the down,
  // then the up over an inexact 033 (its terminal trigger for origin sessions only) — and, as the control, the up over 033 exactly.
  const clear = async (tx) => {
    await withTriggersLifted(tx, AUDIT_TRIGGER, () => tx`update public.audit_event set subject_issued_invoice_id = null, subject_store_id = null
      where subject_issued_invoice_id is not null or subject_store_id is not null`);
    await withTriggersLifted(tx, ISSUE_GUARDS, async () => {
      for (const t of ['issued_invoice_line', 'issued_invoice', 'store_invoice_counter', 'store_issuing_settings']) await tx.unsafe(`delete from ${NS}.${t}`);
    });
    await withTriggersLifted(tx, DRAFT_TERMINAL, async () => {
      await tx`delete from tmpos_invoice_draft.invoice_draft_line where draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where status = 'issued')`;
      await tx`delete from tmpos_invoice_draft.invoice_draft where status = 'issued'`;
    });
  };
  const inexact = await rolledBack(async (tx) => {
    await clear(tx);
    await tx.unsafe(DOWN_034).simple();
    await tx.unsafe('alter table tmpos_invoice_draft.invoice_draft enable trigger trg_invoice_draft_terminal');
    await tx.unsafe(UP_034).simple();
  });
  assert.deepEqual([inexact.code, inexact.message], ['55000', 'migration 034 refused: migration 033 is not applied exactly (its functions, its widened status CHECK, or its terminal triggers in their exact shape, mode and comment)'],
    JSON.stringify(inexact));
  assert.deepEqual(await rolledBack(async (tx) => { await clear(tx); await tx.unsafe(DOWN_034).simple(); await tx.unsafe(UP_034).simple(); return 'passed'; }),
    { value: 'passed' }, 'a clean down then up, rolled back: the up\'s own postcondition passes there too');
  const repeatable = await rolledBack((tx) => tx.unsafe(DOWN_034).simple(), 'isolation level repeatable read');
  assert.deepEqual([repeatable.code, repeatable.message], ['55000', 'migration 034 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row']);
  assert.deepEqual(await catalogOf(), firstCatalog, 'every proof rolled back: the catalog unchanged');
});

test('IIR-02 (AC-11): the up over open, edited and discarded drafts made at 033 keeps every row byte-identical (row, xmin, ctid) and the catalog equal to the first apply\'s; the upgraded drafts then issue, a discarded one is invalid_state', async () => {
  await cleanAll();
  assert.deepEqual(await globalIssuing(), NO_ISSUING, 'no issuing data anywhere: 034\'s down can run');
  const down = await rollBackAbove(owner, MIG_DIR, '033');
  assert.deepEqual(down.rolledBack, ['034'], '034 rolled back by its own down');
  assert.equal(await applied034(), false);
  // At 033: an open draft, an edited one (version 2) and a discarded one, by the chain's own routines.
  const T = await newTenant('upgrade');
  const S = await newStore(T, `upgrade ${SUFFIX}`);
  const C1 = await newCustomer(T, 'upgrade-1');
  const C2 = await newCustomer(T, 'upgrade-2');
  const boss = await actor('upgrade-owner', [storeGrant(T, S, 'store_owner')]);
  const own = await actor('upgrade-tenant-owner', [tenantGrant(T, 'store_owner')]);
  const kBoss = await mint(boss);
  const open = await create(kBoss, S, T, C1);
  const edited = await create(kBoss, S, T, C1);
  assert.deepEqual(await edit(kBoss, S, T, edited, 1, C2, [line('Upgrade edit', 2, 350)]), [DRAFT_DONE(boss, T, S, 2)]);
  const gone = await create(kBoss, S, T, C1);
  assert.deepEqual(await discard(kBoss, S, T, gone, 1), [DRAFT_DONE(boss, T, S, 2)]);
  // One audit row in 033's shape (syntheticAudit's insert without 034's two subject columns), removed by cleanAll like IIR-04's.
  const preAudit = `iir-audit-${randomUUID()}`;
  SYNTHETIC_AUDITS.push(preAudit);
  await owner`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
      reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_invoice_draft_id)
    values (${preAudit}, ${randomUUID()}, 'store', ${T}, ${S}, 'store.invoice_draft.discard', 'discard_invoice_drafts', 'allow',
      'command_committed', 'IIR synthetic record.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1', 'durable_compliance_event', ${gone})`;
  const rows = await rowsOf([T]);
  assert.equal(rows.drafts.length, 3);
  assert.equal(rows.audits.length, 1, 'one pre-034 audit row, so the audit half of the comparison is not vacuous');
  // An audit row as { row, xmin, ctid }, with 034's two new keys dropped only when NULL (any value would fail the comparison).
  const auditOf = (s) => {
    const [json, xmin, ctid] = s.split(/ (?=\S+ \S+$)| (?=\S+$)/); // rowsOf's `${row} ${xmin} ${ctid}`: the last two tokens
    const row = JSON.parse(json);
    for (const k of ['subject_store_id', 'subject_issued_invoice_id']) if (k in row && row[k] === null) delete row[k];
    return { row, xmin, ctid };
  };
  const report = await trustedApply();
  assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
  assert.deepEqual((await owner`select version from public.schema_migrations order by version`).map((r) => r.version),
    Array.from({ length: 34 }, (_, i) => String(i + 1).padStart(3, '0')), 'the ledger exactly 001-034 again');
  const after = await rowsOf([T]);
  assert.deepEqual({ ...after, audits: [] }, { ...rows, audits: [] }, 'the up changed no row: drafts and lines (row, xmin, ctid), customers, store and role rows');
  assert.deepEqual(after.audits.map(auditOf), rows.audits.map(auditOf), 'the pre-034 audit row is unchanged (row, xmin, ctid) beyond its two new NULL subjects');
  const raw = JSON.parse(after.audits[0].split(/ (?=\S+ \S+$)/)[0]);
  assert.deepStrictEqual([raw.subject_store_id, raw.subject_issued_invoice_id], [null, null], 'the two new subjects are present and NULL on it');
  const catalog = await catalogOf();
  assert.deepEqual(diffKeys(catalog, firstCatalog), [], 'the re-applied catalog equals the first apply\'s');
  // The upgraded drafts under 034.
  const kOwn = await mint(own);
  assert.deepEqual(await settingsSet(kOwn, { store: S, tenant: T, version: 0 }), [SET_DONE(own, T, S, 1)]);
  const f = { T, S, C1, C2 };
  const i1 = randomUUID();
  assert.deepEqual(await issue(kBoss, { store: S, tenant: T, draft: open, invoice: i1 }), [ISSUED(boss, f, { invoice: i1, number: 1 })], 'the open draft issues');
  const i2 = randomUUID();
  assert.deepEqual(await issue(kBoss, { store: S, tenant: T, draft: edited, version: 2, invoice: i2 }), [ISSUED(boss, f, { version: 3, invoice: i2, number: 2, customer: C2 })], 'the edited draft issues at its version');
  assert.deepEqual(await issue(kBoss, { store: S, tenant: T, draft: gone, version: 2 }), [ISSUE_NO('invalid_state')], 'the discarded draft is invalid_state');
});

test('IIR-03 (ISS-20): a clean 034 down leaves a catalog identical to a fresh 033 apply\'s; 033\'s down then succeeds; 034 re-applies to the first apply\'s catalog', async () => {
  await cleanAll();
  assert.deepEqual(await globalIssuing(), NO_ISSUING, 'no issuing data anywhere');
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_draft.invoice_draft where status <> 'draft'`)[0].n, 0, 'no discarded draft anywhere: 033\'s down can run');
  const before = await catalogOf();
  assert.deepEqual(diffKeys(before, firstCatalog), [], 'starting from the first apply\'s catalog');
  const down034 = await rollBackAbove(owner, MIG_DIR, '033');
  assert.deepEqual(down034.rolledBack, ['034']);
  const afterDown = await catalogOf();
  assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_033).simple())).code, undefined, '033\'s own postcondition holds again');
  const down033 = await rollBackAbove(owner, MIG_DIR, '032');
  assert.deepEqual(down033.rolledBack, ['033'], '033\'s down succeeds after 034\'s');
  const report033 = await trustedApply('033');
  assert.equal(report033.outcome, 'complete', JSON.stringify(report033).slice(0, 300));
  const fresh = await catalogOf();
  assert.deepEqual(diffKeys(afterDown, fresh), [], 'every catalog section after 034\'s down equals a fresh 033 apply\'s');
  assert.deepEqual(afterDown, fresh);
  assert.ok(!afterDown.schemas.some((s) => s.startsWith('tmpos_invoice_issue:')), 'no schema tmpos_invoice_issue');
  assert.ok(!afterDown.columns.some((c) => /subject_(issued_invoice|store)_id/.test(c)), 'no audit subject of 034');
  const report034 = await trustedApply();
  assert.equal(report034.outcome, 'complete', JSON.stringify(report034).slice(0, 300));
  const reapplied = await catalogOf();
  assert.deepEqual(diffKeys(reapplied, firstCatalog), [], 'the chain restored: 034 re-applied to the first apply\'s catalog');
});

test('IIR-04 (ISS-20, D-ISS-7): 034\'s down refuses atomically, changing nothing (catalog and rows identical, audit rows kept), over one settings row, the first write\'s settings and counter, one issued invoice with its issued draft, an issued draft alone, and one audit record naming an issued invoice or a store', async () => {
  await cleanAll();
  assert.deepEqual(await globalIssuing(), NO_ISSUING, 'each case below is the only issuing data');
  const f = await scene('down-guard', { settings: null, drafts: 1 });
  const DATA = 'migration 034 rollback refused: issuing settings, an invoice counter, an issued invoice or an issued draft exists, and a rollback never deletes them';
  const AUDIT = 'migration 034 rollback refused: an audit record names an issued invoice or a store';
  const refusesDown = async (label, expected, message) => {
    assert.deepEqual(await globalIssuing(), { ...NO_ISSUING, ...expected }, `${label}: the only issuing data`);
    const catalog = await catalogOf();
    const rows = await rowsOf([f.T]);
    const out = await rolledBack((tx) => tx.unsafe(DOWN_034).simple());
    assert.deepEqual([out.code, out.message], ['55000', message], `${label}: the down refuses (${JSON.stringify(out)})`);
    const viaExecutor = await errorOf(rollBackAbove(owner, MIG_DIR, '033'));
    assert.deepEqual([viaExecutor?.code, viaExecutor?.message], ['55000', message], `${label}: the ledgered rollback refuses the same way`);
    assert.deepEqual(await catalogOf(), catalog, `${label}: the catalog and the ledger unchanged`);
    assert.deepEqual(await rowsOf([f.T]), rows, `${label}: every row unchanged, audit rows kept`);
  };
  // (1) One settings row and nothing else (the owner's insert: no counter).
  await owner`insert into tmpos_invoice_issue.store_issuing_settings (tenant_id, store_id, version, legal_name, store_name, postal_address, tax_mode)
    values (${f.T}, ${f.S}, 1, 'IIR Legal', 'IIR Store', 'IIR address', 'none')`;
  await refusesDown('one settings row', { settings: 1 }, DATA);
  await owner.begin(RC, (sql) => removeIssuing(sql, [f.T], { invoices: false }));
  // (2) The first write's settings and counter.
  assert.deepEqual(await settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 0 }), [SET_DONE(f.own, f.T, f.S, 1)]);
  f.sv = 1;
  await refusesDown('the first write\'s settings and counter', { settings: 1, counters: 1 }, DATA);
  // (3) One issued invoice and its issued draft — the settings and counter then removed, so only those remain.
  const invoice = randomUUID();
  assert.deepEqual(await issue(f.kBoss, { ...at(f, f.draft), invoice }), [ISSUED(f.boss, f, { invoice, number: 1 })]);
  await owner.begin(RC, (sql) => removeIssuing(sql, [f.T], { invoices: false }));
  await refusesDown('one issued invoice and its issued draft', { invoices: 1, lines: LINES.length, issued: 1 }, DATA);
  // (4) The issued draft alone (its invoice and lines removed).
  await owner.begin(RC, (sql) => removeIssuing(sql, [f.T], { settings: false }));
  await refusesDown('an issued draft alone', { issued: 1 }, DATA);
  await owner.begin(RC, (sql) => removeDrafts(sql, [f.draft]));
  // (5) One audit record naming an issued invoice; (6) one naming a store.
  for (const [label, subject, expected] of [['an audit record naming an issued invoice', { invoice: randomUUID(), store: f.S }, { subjects: 1 }],
    ['an audit record naming a store', { subjectStore: f.S }, { subjects: 1 }]]) {
    const id = await syntheticAudit(f.T, subject);
    await refusesDown(label, expected, AUDIT);
    assert.equal((await owner`select count(*)::int as n from public.audit_event where request_id = ${id}`)[0].n, 1, `${label}: the record kept`);
    await owner.begin(RC, (sql) => withTriggersLifted(sql, AUDIT_TRIGGER, () => sql`delete from public.audit_event where request_id = ${id}`));
  }
  assert.deepEqual(await globalIssuing(), NO_ISSUING, 'every case removed again');
  assert.equal(await ledgerHas('034'), true, '034 still applied and recorded');
});

test('IIR-05 (ISS-20): 033\'s down refuses while 034 is applied (55000, its own prerequisites); dropping each 033 function the anchor names fails 2BP01 on the anchor; with the anchor dropped the drop passes', async () => {
  const out = await rolledBack((tx) => tx.unsafe(DOWN_033).simple());
  assert.deepEqual([out.code, out.message], ['55000', 'migration 033 rollback refused: migration 033 is not applied (schema tmpos_invoice_discard, a function, a terminal trigger, the open page index or the widened status CHECK is missing)'],
    JSON.stringify(out));
  for (const fn of ANCHORED) {
    const [{ text }] = await owner`select ${fn}::regprocedure::text as text`;
    const drop = await rolledBack((tx) => tx.unsafe(`drop function ${fn}`));
    assert.deepEqual([drop.code, drop.message], ['2BP01', `cannot drop function ${text} because other objects depend on it`], `${fn}: ${JSON.stringify(drop)}`);
    assert.ok(String(drop.detail).split('\n').includes(`function ${ANCHOR.replace(/\(\)$/, '')}() depends on function ${text}`), `${fn}: the anchor is named (${drop.detail})`);
  }
  const control = await rolledBack(async (tx) => {
    await tx.unsafe(`drop function ${ANCHOR}`);
    await tx.unsafe('drop function tmpos_invoice_discard.m7b_invoice_draft_terminal()');
    await tx.unsafe(`drop function ${DISCARD_FN}(text, uuid, uuid, uuid, bigint)`);
    return 'dropped';
  });
  assert.deepEqual(control, { value: 'dropped' }, 'the anchor dropped: 033\'s functions drop (the anchor is what refused)');
});

test('IIR-06 (ISS-21, BRIEF §7): the exact surface — eighteen functions with their declared language, return type, strictness, security, volatility and settings, each commented; tmpos_app\'s one non-grantable EXECUTE on the six routines and nothing on the twelve others; nothing for PUBLIC, anon, authenticated or tmpos_audit_writer; no table privilege by any path; schema USAGE only for tmpos_app; the login refused on every table and helper', async () => {
  const fns = (await owner`select p.proname::text as name, l.lanname::text as lang, p.prosecdef as definer, p.provolatile::text as vol, p.proconfig as config,
      p.prorettype::regtype::text as returns, p.proisstrict as strict, p.prosqlbody is not null as sql_body, p.proowner = n.nspowner as owner_is_schema_owner,
      pg_catalog.obj_description(p.oid, 'pg_proc') is not null as commented
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.pronamespace = 'tmpos_invoice_issue'::regnamespace`).map((r) => ({ ...r }));
  const PINNED = ['search_path=pg_catalog, pg_temp', 'row_security=off'];
  const PATH = ['search_path=pg_catalog, pg_temp'];
  const fn = (lang, definer, vol, config, returns, { strict = false, sqlBody = false } = {}) =>
    ({ lang, definer, vol, config, returns, strict, sql_body: sqlBody, owner_is_schema_owner: true, commented: true });
  const expected = {
    m7b_issuing_settings_get: fn('plpgsql', true, 's', PINNED, 'record'),
    m7b_issuing_settings_set: fn('plpgsql', true, 'v', PINNED, 'record'),
    m7b_invoice_issue_preview: fn('plpgsql', true, 's', PINNED, 'record'),
    m7b_invoice_issue: fn('plpgsql', true, 'v', PINNED, 'record'),
    m7b_issued_invoice_page: fn('plpgsql', true, 's', PINNED, 'record'),
    m7b_issued_invoice_get: fn('plpgsql', true, 's', PINNED, 'record'),
    m7b_issue_text_ok: fn('sql', false, 'i', PATH, 'boolean', { sqlBody: true }),
    m7b_issue_postal_address_ok: fn('sql', false, 'i', PATH, 'boolean', { sqlBody: true }),
    m7b_invoice_tax_cents: fn('sql', false, 'i', PATH, 'numeric', { strict: true, sqlBody: true }),
    m7b_issue_store_reader: fn('plpgsql', false, 's', PINNED, 'record'),
    m7b_issuing_settings_guard: fn('plpgsql', false, 'v', PINNED, 'trigger'),
    m7b_invoice_counter_guard: fn('plpgsql', false, 'v', PINNED, 'trigger'),
    m7b_issued_invoice_guard: fn('plpgsql', false, 'v', PINNED, 'trigger'),
    m7b_issued_invoice_line_guard: fn('plpgsql', false, 'v', PINNED, 'trigger'),
    m7b_issue_truncate_guard: fn('plpgsql', false, 'v', PATH, 'trigger'),
    m7b_issued_invoice_commit_check: fn('plpgsql', true, 'v', PINNED, 'trigger'),
    m7b_invoice_draft_terminal_v2: fn('plpgsql', false, 'v', PINNED, 'trigger'),
    m7b_invoice_issue_prerequisites: fn('sql', false, 's', PATH, 'boolean', { sqlBody: true }),
  };
  assert.deepEqual(Object.fromEntries(fns.map(({ name, ...rest }) => [name, rest])), expected, 'schema tmpos_invoice_issue: exactly the eighteen functions, each as declared');
  for (const sig of ROUTINES) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME, 'tmpos_app'), `${sig}: the owner's and tmpos_app's EXECUTE`);
  for (const sig of UNGRANTED) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME), `${sig}: the owner's alone`);
  for (const sig of [...ROUTINES, ...UNGRANTED]) {
    const [can] = await owner`select pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${sig}::regprocedure, 'EXECUTE') as login,
      pg_catalog.has_function_privilege('tmpos_app', ${sig}::regprocedure, 'EXECUTE') as app,
      pg_catalog.has_function_privilege('public', ${sig}::regprocedure, 'EXECUTE') as public,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${sig}::regprocedure, 'EXECUTE') as audit,
      pg_catalog.has_function_privilege('anon', ${sig}::regprocedure, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${sig}::regprocedure, 'EXECUTE') as authenticated`;
    const granted = ROUTINES.includes(sig);
    assert.deepEqual({ ...can }, { login: granted, app: granted, public: false, audit: false, anon: false, authenticated: false }, sig);
  }
  // Tables: no privilege of any kind for any runtime role or PUBLIC, by any path (MAINTAIN included where the server has it);
  // row security on, not forced, no policy; each table's ACL its owner's alone.
  const [{ v }] = await owner`select pg_catalog.current_setting('server_version_num')::int as v`;
  const PRIVS = `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER${v >= 170000 ? ', MAINTAIN' : ''}`;
  for (const rel of ISSUE_TABLES) {
    for (const role of [RUNTIME_LOGIN, 'tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated', 'public']) {
      const [p] = await owner`select pg_catalog.has_table_privilege(${role}, ${rel}::regclass, ${PRIVS}) as t,
        pg_catalog.has_any_column_privilege(${role}, ${rel}::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') as c`;
      assert.deepEqual({ ...p }, { t: false, c: false }, `${role} on ${rel}`);
    }
    const [shape] = await owner`select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      (select count(*) from pg_catalog.pg_policy y where y.polrelid = c.oid)::int as policies,
      (select pg_catalog.count(*) from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g where g.grantee <> c.relowner)::int as foreign_entries
      from pg_catalog.pg_class c where c.oid = ${rel}::regclass`;
    assert.deepEqual({ ...shape }, { rls: true, forced: false, policies: 0, foreign_entries: 0 }, `${rel}: row security on, unforced, no policy, no grant`);
  }
  assert.deepEqual((await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.is_grantable as grantable
    from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
    where n.oid = 'tmpos_invoice_issue'::regnamespace and g.grantee <> n.nspowner order by 1, 2`).map((r) => ({ ...r })),
  [{ grantee: 'tmpos_app', priv: 'USAGE', grantable: false }], 'the schema\'s one grant beyond its owner\'s: USAGE to tmpos_app');
  for (const role of ['tmpos_audit_writer', 'anon', 'authenticated', 'public']) {
    assert.equal((await owner`select pg_catalog.has_schema_privilege(${role}, 'tmpos_invoice_issue', 'USAGE, CREATE') as u`)[0].u, false, `${role}: no schema privilege`);
  }
  // The login, as the enforcement boundary: every table refused (42501) before any trigger; every helper refused.
  for (const rel of ISSUE_TABLES) {
    assert.equal((await errorOf(runtime.unsafe(`select 1 from ${rel} limit 1`)))?.code, '42501', `the login cannot read ${rel}`);
    assert.equal((await errorOf(runtime.unsafe(`delete from ${rel}`)))?.code, '42501', `the login cannot delete from ${rel}`);
  }
  for (const [label, sql] of [
    ['the tax function', `select ${NS}.m7b_invoice_tax_cents(1, 1)`],
    ['the text rule', `select ${NS}.m7b_issue_text_ok('x', 1)`],
    ['the address rule', `select ${NS}.m7b_issue_postal_address_ok('x')`],
    ['the read authority', `select * from ${NS}.m7b_issue_store_reader('k', '${T_OTHER}', '${randomUUID()}', false, 'view')`],
    ['the anchor', `select ${ANCHOR}`],
    ['a guard', `select ${NS}.m7b_issued_invoice_guard()`],
    ['the commit check', `select ${NS}.m7b_issued_invoice_commit_check()`],
    ['the draft terminal function', `select ${NS}.m7b_invoice_draft_terminal_v2()`],
  ]) assert.equal((await errorOf(runtime.unsafe(sql)))?.code, '42501', `the login cannot execute ${label}`);
  assert.equal((await owner.unsafe(`select ${ANCHOR} as v`))[0].v, true, 'the anchor answers true');
});

// ===========================================================================
// IIR-07: the tax formula
// ===========================================================================

test('IIR-07 (ISS-11, AC-05): the tax formula — SQL through issued rows and through the CHECK equals BigInt: 1999 x 8875 -> 177, 10 x 5000 -> 1, two 10-cent lines at 5000 -> 1 not 2, a 0 rate -> 0, 9007199254740991 x 1 -> 90071992547 (refused), 1000000000050001 x 99999 exactly; the largest valid totals at rates 0, 1 and 100000 issue exactly and one cent more is refused', async () => {
  const f = await scene('tax', { drafts: 0 });
  let rate = SETTINGS.taxRate;
  let number = 0;
  const atRate = async (r) => {
    if (r === rate) return;
    assert.deepEqual(await settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: f.sv, s: { ...SETTINGS, taxRate: r } }), [SET_DONE(f.own, f.T, f.S, f.sv + 1)]);
    f.sv += 1;
    rate = r;
  };
  /** Issues one draft of `lines` at rate `r`; the preview, the answer and the stored header agree with BigInt. */
  const issuedAt = async (r, lines) => {
    await atRate(r);
    const draft = await create(f.kBoss, f.S, f.T, f.C1, lines);
    const s = sumOf(lines);
    const tax = taxOf(s, r);
    const p = await preview(f.kBoss, f.T, f.S, draft);
    assert.deepEqual(p.map((x) => [x.o_outcome, x.o_subtotal_cents, x.o_tax_cents, x.o_total_cents, x.o_tax_rate]), lines.map(() => ['line', String(s), String(tax), String(s + tax), r]),
      `preview ${s} x ${r}`);
    const invoice = randomUUID();
    number += 1;
    assert.deepEqual(await issue(f.kBoss, { ...at(f, draft), invoice }), [ISSUED(f.boss, f, { invoice, number })], `issue ${s} x ${r}`);
    const [row] = await owner`select subtotal_cents::text as s, tax_cents::text as t, total_cents::text as total, tax_rate as r, tax_mode as mode
      from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice}`;
    assert.deepEqual({ ...row }, { s: String(s), t: String(tax), total: String(s + tax), r, mode: 'exclusive_rate' }, `the stored header ${s} x ${r}`);
    return { tax, total: s + tax };
  };
  /** A draft of `lines` at rate `r` is refused as out of range by the preview and the issue, writing nothing. */
  const refusedAt = async (r, lines) => {
    await atRate(r);
    const draft = await create(f.kBoss, f.S, f.T, f.C1, lines);
    assert.ok(sumOf(lines) + taxOf(sumOf(lines), r) > MAX, 'BigInt agrees the total is out of range');
    const before = await footprint([f.T], [draft]);
    assert.deepEqual(outcomes(await preview(f.kBoss, f.T, f.S, draft)), ['amount_out_of_range']);
    assert.deepEqual(await issue(f.kBoss, at(f, draft)), [ISSUE_NO('amount_out_of_range')]);
    assert.deepEqual(await footprint([f.T], [draft]), before, 'nothing written');
  };
  assert.deepEqual((await issuedAt(8_875, [line('Screen', 1, 1_999)])).tax, 177n, '1999 x 8875 -> 177');
  assert.deepEqual((await issuedAt(5_000, [line('Half cent', 1, 10)])).tax, 1n, '10 x 5000 -> 1: the half-cent tie rounds up');
  assert.equal(taxOf(10, 5_000) + taxOf(10, 5_000), 2n, 'per-line rounding of the next vector would give 2');
  assert.deepEqual((await issuedAt(5_000, [line('Ten', 1, 10), line('Ten again', 1, 10)])).tax, 1n, 'two 10-cent lines at 5000 -> 1: tax on the subtotal, once');
  assert.deepEqual(await issuedAt(0, LINES), { tax: 0n, total: SUBTOTAL }, 'an explicit 0 rate -> 0');
  // The largest valid totals: the greatest S with S + tax(S, R) <= 2^53 - 1, found in BigInt, issues exactly; S + 1 is refused.
  const largest = (r) => {
    let lo = 0n;
    let hi = MAX;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (mid + taxOf(mid, r) <= MAX) lo = mid; else hi = mid - 1n; }
    return lo;
  };
  for (const [r, s, total] of [[0, MAX, MAX], [1, 9_007_109_183_649_155n, MAX], [100_000, 4_503_599_627_370_495n, 9_007_199_254_740_990n]]) {
    assert.equal(largest(r), s, `the largest valid subtotal at ${r}`);
    assert.equal((await issuedAt(r, [line('Largest', 1, Number(s))])).total, total, `rate ${r}: the largest valid total ${total} issues exactly`);
    if (s < MAX) await refusedAt(r, [line('One cent more', 1, Number(s + 1n))]);
  }
  assert.equal(taxOf(MAX, 1), 90_071_992_547n);
  await refusedAt(1, [line('Maximum', 1, MAX_N)]);
  // Pure expressions: the SQL formula (granted to nobody; the owner's call) against BigInt — and the double-precision formula,
  // which is one cent high on the second vector, as the control that the vector discriminates.
  for (const [s, r] of [[1_999n, 8_875], [10n, 5_000], [20n, 5_000], [MAX, 1], [1_000_000_000_050_001n, 99_999], [MAX, 100_000], [MAX, 0], [0n, 100_000]]) {
    const [{ t }] = await owner.unsafe(`select ${TAX.replace('(bigint, integer)', '')}($1::bigint, $2::integer)::text as t`, [String(s), r]);
    assert.equal(t, String(taxOf(s, r)), `div(${s} x ${r} + 50000, 100000)`);
  }
  assert.equal(taxOf(1_000_000_000_050_001n, 99_999), 999_990_000_050_000n);
  assert.equal(Math.floor((1_000_000_000_050_001 * 99_999 + 50_000) / 100_000), 999_990_000_050_001, 'the double-precision formula is one cent high there');
  // Through the CHECK alone (the header guard lifted in a rolled-back owner transaction, every attempt in a savepoint): the
  // formula's tax is accepted, one cent either side is refused, a NULL tax under a rate and a tax under 'none' are refused.
  const draft = await create(f.kBoss, f.S, f.T, f.C1);
  const [cust] = await owner`select name, row_version::text as v from tmpos_customer.customer where customer_id = ${f.C1}`;
  const header = (sp, { s, r, mode = 'exclusive_rate', tax, total }) => sp.unsafe(`insert into tmpos_invoice_issue.issued_invoice
      (invoice_id, tenant_id, store_id, number, snapshot_version, source_draft_id, source_draft_version, settings_version, customer_id, customer_version,
       customer_name, legal_name, store_name, postal_address, tax_registration_id, currency, line_count, subtotal_cents, tax_mode, tax_rate, tax_cents,
       total_cents, issued_at, issued_by)
    values ($1::uuid, $2::uuid, $3::uuid, 900, 1, $4::uuid, 1, 1, $5::uuid, $6::bigint, $7::text, 'L', 'S', 'A', null, 'USD', 1, $8::bigint, $9::text,
       $10::integer, $11::bigint, $12::bigint, pg_catalog.now(), $13::uuid)`,
  [randomUUID(), f.T, f.S, draft, f.C1, cust.v, cust.name, String(s), mode, r, big(tax), String(total), randomUUID()]);
  const checks = await rolledBack((tx) => withTriggersLifted(tx, [[`${NS}.issued_invoice`, 'trg_issued_invoice_guard']], async () => {
    const out = [];
    for (const [s, r] of [[1_999n, 8_875], [10n, 5_000], [20n, 5_000], [SUBTOTAL, 0], [1_000_000_000_050_001n, 99_999], [9_007_109_183_649_155n, 1],
      [4_503_599_627_370_495n, 100_000]]) {
      const t = taxOf(s, r);
      out.push([`${s} x ${r}`, await attempt(tx, (sp) => header(sp, { s, r, tax: t, total: s + t })),
        await attempt(tx, (sp) => header(sp, { s, r, tax: t + 1n, total: s + t + 1n })),
        await attempt(tx, (sp) => header(sp, { s, r, tax: t - 1n, total: s + t - 1n }))]);
    }
    out.push(['a NULL tax under a rate', await attempt(tx, (sp) => header(sp, { s: 100n, r: 8_875, tax: null, total: 100n }))]);
    out.push(['a total other than subtotal + tax', await attempt(tx, (sp) => header(sp, { s: 1_999n, r: 8_875, tax: 177n, total: 2_177n }))]);
    out.push(['a tax under none', await attempt(tx, (sp) => header(sp, { s: 100n, r: null, mode: 'none', tax: 0n, total: 100n }))]);
    out.push(['a rate under none', await attempt(tx, (sp) => header(sp, { s: 100n, r: 0, mode: 'none', tax: null, total: 100n }))]);
    out.push(['none, total = subtotal', await attempt(tx, (sp) => header(sp, { s: 100n, r: null, mode: 'none', tax: null, total: 100n }))]);
    return out;
  }));
  assert.deepEqual(checks.value, [
    ['1999 x 8875', 'accepted', '23514', '23514'], ['10 x 5000', 'accepted', '23514', '23514'], ['20 x 5000', 'accepted', '23514', '23514'],
    [`${SUBTOTAL} x 0`, 'accepted', '23514', '23514'], ['1000000000050001 x 99999', 'accepted', '23514', '23514'],
    ['9007109183649155 x 1', 'accepted', '23514', '23514'], ['4503599627370495 x 100000', 'accepted', '23514', '23514'],
    ['a NULL tax under a rate', '23514'], ['a total other than subtotal + tax', '23514'], ['a tax under none', '23514'], ['a rate under none', '23514'],
    ['none, total = subtotal', 'accepted'],
  ], `the CHECK re-derives the tax (${JSON.stringify(checks)})`);
});

// ===========================================================================
// IIR-08..11: authority, decision order, tax modes, numbering
// ===========================================================================

test('IIR-08 (ISS-01 ISS-02 ISS-04, AC-03): the authority matrix over real sessions — applied exactly at Invoices >= Approve with Customers >= View (store_owner Full; the stored level decides, never the role name), refused for every other role, level, read-only actor, tenant or store, a tenant grant only, a grant at another store and an unknown role; the preview answers alike; nothing written when refused', async () => {
  const f = await scene('authority', { drafts: 0 });
  const tech = await member(f, 'm', 'technician');
  const sales = await member(f, 'm', 'sales_staff');
  const roActor = await member(f, 'ro', 'store_owner', 'read_only');
  const S2 = await newStore(f.T, `authority second ${SUFFIX}`);
  const elsewhere = await actor('authority-elsewhere', [storeGrant(f.T, S2, 'manager')]);
  const kElsewhere = await mint(elsewhere);
  const tenantManager = await actor('authority-tgrant-mgr', [tenantGrant(f.T, 'manager')]);
  const kTenantManager = await mint(tenantManager);
  let number = 0;
  /** One case: a fresh draft; the preview's outcome; then the issue — applied with the next number, or refused writing nothing. */
  const decide = async (label, key, who, expect, { store = f.S, tenant = f.T, draft: given } = {}) => {
    const draft = given ?? await create(f.kBoss, f.S, f.T, f.C1);
    const before = await footprint([f.T], [draft]);
    const p = await preview(key, tenant, store, draft);
    const invoice = randomUUID();
    const out = await issue(key, { store, tenant, draft, sv: f.sv, invoice });
    if (expect === 'applied') {
      assert.deepEqual(outcomes(p), LINES.map(() => 'line'), `${label}: the preview serves the draft`);
      number += 1;
      assert.deepEqual(out, [ISSUED(who, f, { invoice, number })], `${label}: applied`);
    } else {
      assert.deepEqual(outcomes(p), [expect === 'not_found' ? 'not_found' : 'denied'], `${label}: the preview refuses alike`);
      assert.deepEqual(out, [ISSUE_NO(expect)], `${label}: ${expect}`);
      assert.deepEqual(await footprint([f.T], [draft]), before, `${label}: nothing written`);
    }
  };
  await decide('store_owner (Full, never stored)', f.kBoss, f.boss, 'applied');
  await decide('the default manager (Full / Full)', f.kManager, f.manager, 'applied');
  for (const level of LEVELS) {
    await setLevel(f.T, 'manager', 'invoices', level);
    await decide(`a manager stored at Invoices ${level}`, f.kManager, f.manager, ['approve', 'full'].includes(level) ? 'applied' : 'refused');
  }
  await clearLevels(f.T);
  for (const level of LEVELS) {
    await setLevel(f.T, 'manager', 'customers', level);
    await decide(`a manager (Invoices Full) stored at Customers ${level}`, f.kManager, f.manager, level === 'none' ? 'refused' : 'applied');
  }
  await clearLevels(f.T);
  await setLevel(f.T, 'manager', 'invoices', 'approve');
  await setLevel(f.T, 'manager', 'customers', 'view');
  await decide('a manager at exactly Approve and View', f.kManager, f.manager, 'applied');
  await clearLevels(f.T);
  await decide('the default technician (View / View)', tech.key, tech.who, 'refused');
  await decide('the default sales_staff (Create / Create)', sales.key, sales.who, 'refused');
  await setLevel(f.T, 'technician', 'invoices', 'approve');
  await decide('a technician raised to Approve (Customers View by default)', tech.key, tech.who, 'applied');
  await setLevel(f.T, 'technician', 'customers', 'none');
  await decide('that technician with Customers none', tech.key, tech.who, 'refused');
  await setLevel(f.T, 'sales_staff', 'invoices', 'full');
  await decide('a sales_staff raised to Full (Customers Create by default)', sales.key, sales.who, 'applied');
  await clearLevels(f.T);
  await decide('a read-only actor (store_owner)', roActor.key, roActor.who, 'refused');
  await decide('a tenant grant only (store_owner)', f.kOwn, f.own, 'refused');
  await decide('a manager on a tenant grant only', kTenantManager, tenantManager, 'refused');
  await decide('a grant at another store, naming this store', kElsewhere, elsewhere, 'refused');
  await decide('a grant at another store, naming its own store with this store\'s draft', kElsewhere, elsewhere, 'not_found', { store: S2 });
  const other = await scene('authority-foreign', { drafts: 1 });
  await decide('another tenant\'s draft', f.kBoss, f.boss, 'not_found', { draft: other.draft });
  await decide('a missing draft', f.kBoss, f.boss, 'not_found', { draft: randomUUID() });
  await decide('an expectedTenant not the grant\'s', f.kBoss, f.boss, 'tenant_mismatch', { tenant: T_OTHER });
  // Read-only tenant and read-only store: sessions minted after the change (a status is part of the standing).
  for (const [label, tag, set] of [['a read-only tenant', 'rotenant', (g) => owner`update tenant set status = 'read_only' where tenant_id = ${g.T}`],
    ['a read-only store', 'rostore', (g) => owner`update store set status = 'read_only' where store_id = ${g.S}`],
    ['a suspended grant', 'suspended', (g) => owner`update user_membership set status = 'suspended' where membership_id = ${g.boss.memberships[0]}`]]) {
    const g = await scene(`authority-${tag}`, { drafts: 1 });
    await set(g);
    const key = await mint(g.boss);
    const before = await footprint([g.T], [g.draft]);
    assert.deepEqual(outcomes(await preview(key, g.T, g.S, g.draft)), ['denied'], `${label}: the preview denied`);
    assert.deepEqual(await issue(key, at(g, g.draft)), [ISSUE_NO('refused')], `${label}: refused`);
    assert.deepEqual(await footprint([g.T], [g.draft]), before, `${label}: nothing written`);
  }
  // An unknown role: the membership CHECK refuses one; planted with it lifted (and restored exactly), it has no authority.
  const planted = await actor('authority-planted', []);
  assert.equal((await errorOf(owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${planted.id}, ${f.T}, ${f.S}, 'store', 'shift_lead', 'active')`))?.code, '23514', 'a custom role id is refused by the membership CHECK');
  roleCheckDef = (await owner`select pg_catalog.pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint
    where conrelid = 'public.user_membership'::regclass and conname = 'user_membership_role_scope_chk'`)[0].def;
  await owner.unsafe('alter table public.user_membership drop constraint user_membership_role_scope_chk');
  try {
    const [{ membership_id: mid }] = await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${planted.id}, ${f.T}, ${f.S}, 'store', 'shift_lead', 'active') returning membership_id`;
    planted.memberships.push(mid);
    await decide('an unknown role (shift_lead) planted past the CHECK', await mint(planted), planted, 'refused');
  } finally {
    await owner`delete from user_membership where internal_user_id = ${planted.id}`;
    await owner.unsafe(`alter table public.user_membership add constraint user_membership_role_scope_chk ${roleCheckDef}`);
  }
  assert.equal((await owner`select pg_catalog.pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint
    where conrelid = 'public.user_membership'::regclass and conname = 'user_membership_role_scope_chk'`)[0].def, roleCheckDef, 'the CHECK restored exactly');
  assert.equal(await counterOf(f.S), String(number), `${number} issues applied, numbered 1..${number}`);
});

test('IIR-09 (ISS-07 ISS-12, AC-02): the decision order and no-write refusals — not open (discarded, issued) is invalid_state before configuration and versions; no settings is issuing_not_configured before versions; a stale or future draft, settings or customer version conflicts; a total over 2^53-1 and a counter at 2^53-1 are amount_out_of_range after the versions; each leaves the counter, the draft, the issued tables and the audit table unchanged; every argument raises 22023; outside READ COMMITTED 55000', async () => {
  const f = await scene('order', { drafts: 4 });
  const [dDisc, dIssued, dOpen] = f.drafts;
  const dBig = await create(f.kBoss, f.S, f.T, f.C1, [line('Maximum', 1, MAX_N)]);
  const bare = await scene('order-bare', { settings: null, drafts: 2 });
  const full = await scene('order-full', { drafts: 1 });
  assert.deepEqual(await discard(f.kManager, f.S, f.T, dDisc, 1), [DRAFT_DONE(f.manager, f.T, f.S, 2)]);
  assert.deepEqual(await discard(bare.kManager, bare.S, bare.T, bare.drafts[1], 1), [DRAFT_DONE(bare.manager, bare.T, bare.S, 2)]);
  const invoice = randomUUID();
  assert.deepEqual(await issue(f.kBoss, { ...at(f, dIssued), invoice }), [ISSUED(f.boss, f, { invoice, number: 1 })]);
  const tech = await member(f, 'order', 'technician');
  const tenants = [f.T, bare.T, full.T];
  const drafts = [dDisc, dIssued, dOpen, dBig, bare.drafts[0], bare.drafts[1], full.draft];
  const expectNothing = async (label, call, expected) => {
    const before = await footprint(tenants, drafts);
    assert.deepEqual(await call(), [ISSUE_NO(expected)], label);
    assert.deepEqual(await footprint(tenants, drafts), before, `${label}: nothing written (counter, drafts, issued tables, audit)`);
  };
  // Authority, then the tenant precondition, then not_found, before any state is read.
  await expectNothing('a technician (View) naming an issued draft: refused first', () => issue(tech.key, at(f, dIssued, { version: 2 })), 'refused');
  await expectNothing('a technician (View) naming another tenant: refused before the tenant precondition', () => issue(tech.key, at(f, dOpen, { tenant: T_OTHER })), 'refused');
  await expectNothing('a tenant mismatch naming a discarded draft', () => issue(f.kBoss, at(f, dDisc, { tenant: T_OTHER, version: 2 })), 'tenant_mismatch');
  await expectNothing('a tenant mismatch naming a missing draft: before not_found', () => issue(f.kBoss, at(f, randomUUID(), { tenant: T_OTHER })), 'tenant_mismatch');
  await expectNothing('a missing draft', () => issue(f.kBoss, at(f, randomUUID())), 'not_found');
  // Not open: invalid_state whatever the versions, before configuration.
  for (const [label, args] of [['discarded, current versions', at(f, dDisc, { version: 2 })], ['discarded, stale versions', at(f, dDisc, { version: 1, sv: 9, cv: 9 })],
    ['issued, current versions', at(f, dIssued, { version: 2 })], ['issued, its old version', at(f, dIssued, { version: 1 })]]) {
    await expectNothing(`${label}: invalid_state`, () => issue(f.kBoss, args), 'invalid_state');
  }
  await expectNothing('discarded at a store without settings: invalid_state before configuration',
    () => issue(bare.kBoss, at(bare, bare.drafts[1], { version: 2, sv: 1 })), 'invalid_state');
  // No settings: issuing_not_configured, before any version.
  await expectNothing('no settings, current draft version', () => issue(bare.kBoss, at(bare, bare.drafts[0], { sv: 1 })), 'issuing_not_configured');
  await expectNothing('no settings, stale draft, settings and customer versions', () => issue(bare.kBoss, at(bare, bare.drafts[0], { version: 5, sv: 3, cv: 3 })), 'issuing_not_configured');
  assert.deepEqual(outcomes(await preview(bare.kBoss, bare.T, bare.S, bare.drafts[0])), ['issuing_not_configured'], 'the preview: issuing_not_configured');
  // Versions: the draft (stale and future), the settings (stale and future), the customer (stale and future).
  assert.deepEqual(await edit(f.kBoss, f.S, f.T, dOpen, 1, f.C1, [line('Edited', 1, 500)]), [DRAFT_DONE(f.boss, f.T, f.S, 2)]);
  await expectNothing('a stale draft version', () => issue(f.kBoss, at(f, dOpen, { version: 1 })), 'conflict');
  await expectNothing('a future draft version', () => issue(f.kBoss, at(f, dOpen, { version: 3 })), 'conflict');
  assert.deepEqual(await settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 1 }), [SET_DONE(f.own, f.T, f.S, 2)]);
  f.sv = 2;
  await expectNothing('a stale settings version', () => issue(f.kBoss, at(f, dOpen, { version: 2, sv: 1 })), 'conflict');
  await expectNothing('a future settings version', () => issue(f.kBoss, at(f, dOpen, { version: 2, sv: 3 })), 'conflict');
  assert.equal((await rename(f.C1, `IIR order renamed ${SUFFIX}`))[0].v, '2');
  await expectNothing('a stale customer version', () => issue(f.kBoss, at(f, dOpen, { version: 2, cv: 1 })), 'conflict');
  await expectNothing('a future customer version', () => issue(f.kBoss, at(f, dOpen, { version: 2, cv: 3 })), 'conflict');
  // Amounts after versions: a total over 2^53 - 1 is out of range only once every version holds.
  await expectNothing('a total over 2^53 - 1 at a stale draft version: conflict first', () => issue(f.kBoss, at(f, dBig, { version: 2, cv: 2 })), 'conflict');
  await expectNothing('a total over 2^53 - 1 at a stale customer version: conflict first', () => issue(f.kBoss, at(f, dBig, { cv: 1 })), 'conflict');
  await expectNothing('a total over 2^53 - 1', () => issue(f.kBoss, at(f, dBig, { cv: 2 })), 'amount_out_of_range');
  assert.deepEqual(outcomes(await preview(f.kBoss, f.T, f.S, dBig)), ['amount_out_of_range']);
  // The counter at 2^53 - 1: out of range, decided under the counter, after every version.
  await forceCounter(full.S, MAX);
  await expectNothing('a counter at 2^53 - 1 with a stale draft version: conflict first', () => issue(full.kBoss, at(full, full.draft, { version: 2 })), 'conflict');
  await expectNothing('a counter at 2^53 - 1', () => issue(full.kBoss, at(full, full.draft)), 'amount_out_of_range');
  assert.deepEqual(outcomes(await preview(full.kBoss, full.T, full.S, full.draft)), ['amount_out_of_range'], 'the preview: amount_out_of_range');
  // The open draft at its current versions then applies (the refusals left it issuable).
  const later = randomUUID();
  assert.deepEqual(await issue(f.kBoss, { ...at(f, dOpen, { version: 2, cv: 2 }), invoice: later }), [ISSUED(f.boss, f, { version: 3, invoice: later, number: 2 })]);
  // Arguments: a fixed message naming the field, never the value; nothing read, locked or written.
  const good = at(f, dBig, { cv: 2 });
  for (const [label, args, message] of [
    ['a null session key', [null, good], 'migration 034 issue: an argument is malformed'],
    ['a malformed session key', ['bad key', good], 'migration 034 issue: an argument is malformed'],
    ['a null store', [f.kBoss, { ...good, store: null }], 'migration 034 issue: an argument is malformed'],
    ['a null draft', [f.kBoss, { ...good, draft: null }], 'migration 034 issue: an argument is malformed'],
    ['a null tenant', [f.kBoss, { ...good, tenant: null }], 'migration 034 issue: an argument is malformed'],
    ['a null invoice id', [f.kBoss, { ...good, invoice: null }], 'migration 034 issue: an argument is malformed'],
    ['a null version', [f.kBoss, { ...good, version: null }], 'migration 034 issue: the expected version is not one the draft table can advance'],
    ['version 0', [f.kBoss, { ...good, version: 0 }], 'migration 034 issue: the expected version is not one the draft table can advance'],
    ['version 2^53 - 1', [f.kBoss, { ...good, version: MAX }], 'migration 034 issue: the expected version is not one the draft table can advance'],
    ['settings version 0', [f.kBoss, { ...good, sv: 0 }], 'migration 034 issue: the expected settings or customer version is out of range'],
    ['settings version 2^53', [f.kBoss, { ...good, sv: MAX + 1n }], 'migration 034 issue: the expected settings or customer version is out of range'],
    ['a null customer version', [f.kBoss, { ...good, cv: null }], 'migration 034 issue: the expected settings or customer version is out of range'],
  ]) {
    const err = await errorOf(issue(args[0], args[1]));
    assert.deepEqual([err?.code, err?.message], ['22023', message], label);
  }
  let rr = null;
  await assert.rejects(runtime.begin('isolation level repeatable read', async (tx) => {
    rr = await errorOf(issue(f.kBoss, { ...good, db: tx }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  assert.deepEqual([rr?.code, rr?.message], ['55000', 'migration 034 issue: it must run under READ COMMITTED, so that its checks see what committed before its locks']);
});

test('IIR-10 (ISS-12 ISS-12b, AC-02): both tax modes — an explicit 0 rate (a tax line of 0) and none (no rate, no tax, total = subtotal) are distinguishable in the settings, the preview and the issued snapshot', async () => {
  const zero = await scene('mode-zero', { settings: { ...SETTINGS, taxRate: 0 } });
  const none = await scene('mode-none', { settings: { ...SETTINGS, taxMode: 'none', taxRate: null, taxRegistrationId: null } });
  assert.deepEqual(await settingsGet(zero.kOwn, zero.T, zero.S), [SETTINGS_ROW(zero.T, zero.S, 1, { ...SETTINGS, taxRate: 0 })]);
  assert.deepEqual(await settingsGet(none.kOwn, none.T, none.S), [SETTINGS_ROW(none.T, none.S, 1, { ...SETTINGS, taxMode: 'none', taxRate: null, taxRegistrationId: null })]);
  const amounts = (rows) => rows.map((r) => [r.o_tax_mode, r.o_tax_rate, r.o_tax_cents, r.o_subtotal_cents, r.o_total_cents]);
  assert.deepEqual(amounts(await preview(zero.kBoss, zero.T, zero.S, zero.draft)), LINES.map(() => ['exclusive_rate', 0, '0', String(SUBTOTAL), String(SUBTOTAL)]), 'a 0 rate: a tax of 0');
  assert.deepEqual(amounts(await preview(none.kBoss, none.T, none.S, none.draft)), LINES.map(() => ['none', null, null, String(SUBTOTAL), String(SUBTOTAL)]), 'none: no rate, no tax');
  const zi = randomUUID();
  const ni = randomUUID();
  assert.deepEqual(await issue(zero.kBoss, { ...at(zero, zero.draft), invoice: zi }), [ISSUED(zero.boss, zero, { invoice: zi, number: 1 })]);
  assert.deepEqual(await issue(none.kBoss, { ...at(none, none.draft), invoice: ni }), [ISSUED(none.boss, none, { invoice: ni, number: 1 })]);
  assert.deepEqual(amounts(await getInvoice(zero.kBoss, zero.T, zero.S, zi)), LINES.map(() => ['exclusive_rate', 0, '0', String(SUBTOTAL), String(SUBTOTAL)]), 'the 0-rate snapshot');
  assert.deepEqual(amounts(await getInvoice(none.kBoss, none.T, none.S, ni)), LINES.map(() => ['none', null, null, String(SUBTOTAL), String(SUBTOTAL)]), 'the none snapshot');
  assert.deepEqual((await getInvoice(none.kBoss, none.T, none.S, ni))[0].o_tax_registration_id, null, 'no tax registration id recorded under none here');
  const stored = (await owner`select tax_mode, tax_rate, tax_cents::text as tax, total_cents::text as total from tmpos_invoice_issue.issued_invoice
    where invoice_id = any(${[zi, ni]}::uuid[]) order by tax_mode`).map((r) => ({ ...r }));
  assert.deepEqual(stored, [{ tax_mode: 'exclusive_rate', tax_rate: 0, tax: '0', total: String(SUBTOTAL) }, { tax_mode: 'none', tax_rate: null, tax: null, total: String(SUBTOTAL) }]);
});

test('IIR-11 (ISS-09): numbering — the first two issues at a store get 1 and 2, another store starts at 1; an issue rolled back by an owner fault trigger raising after the counter update leaves the counter unchanged and writes nothing, and the next issue takes that same number', async () => {
  const f = await scene('numbers', { drafts: 4 });
  const g = await scene('numbers-other', { drafts: 1 });
  assert.equal(await counterOf(f.S), '0', 'the first write created the counter at 0');
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  assert.deepEqual(await issue(f.kBoss, { ...at(f, f.drafts[0]), invoice: ids[0] }), [ISSUED(f.boss, f, { invoice: ids[0], number: 1 })], 'the first issue: 1');
  assert.deepEqual(await issue(f.kManager, { ...at(f, f.drafts[1]), invoice: ids[1] }), [ISSUED(f.manager, f, { invoice: ids[1], number: 2 })], 'the second: 2');
  const gi = randomUUID();
  assert.deepEqual(await issue(g.kBoss, { ...at(g, g.draft), invoice: gi }), [ISSUED(g.boss, g, { invoice: gi, number: 1 })], 'another store starts at 1');
  assert.deepEqual([await counterOf(f.S), await counterOf(g.S)], ['2', '1']);
  await owner.unsafe(`create function public.${FAULT}() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
    begin raise exception 'iir: a fault after the counter update'; end $$`);
  try {
    await owner.unsafe(`create trigger ${FAULT} after update on tmpos_invoice_issue.store_invoice_counter for each row
      when (new.store_id = '${f.S}'::uuid) execute function public.${FAULT}()`);
    const before = await footprint([f.T, g.T], f.drafts);
    const fault = await errorOf(issue(f.kBoss, { ...at(f, f.drafts[2]), invoice: ids[2] }));
    assert.deepEqual([fault?.code, fault?.message], ['P0001', 'iir: a fault after the counter update'], 'the issue raised after its counter update');
    assert.deepEqual(await footprint([f.T, g.T], f.drafts), before, 'rolled back: the counter, the drafts and the issued tables unchanged');
    assert.equal(await counterOf(f.S), '2', 'the counter unchanged');
  } finally {
    await owner.unsafe(`drop trigger if exists ${FAULT} on tmpos_invoice_issue.store_invoice_counter`);
    await owner.unsafe(`drop function if exists public.${FAULT}()`);
  }
  assert.deepEqual(await issue(f.kBoss, { ...at(f, f.drafts[2]), invoice: ids[2] }), [ISSUED(f.boss, f, { invoice: ids[2], number: 3 })], 'the next issue takes the same number, 3');
  assert.deepEqual(await issue(f.kBoss, { ...at(f, f.drafts[3]), invoice: ids[3] }), [ISSUED(f.boss, f, { invoice: ids[3], number: 4 })]);
  assert.deepEqual((await owner`select number::text as n from tmpos_invoice_issue.issued_invoice where store_id = ${f.S} order by number`).map((r) => r.n), ['1', '2', '3', '4'],
    'no gap and no duplicate');
});

// ===========================================================================
// IIR-12: races
// ===========================================================================

test('IIR-12 (ISS-03 ISS-05 ISS-06 ISS-09, AC-07): races, deterministic — issue vs issue on one draft; issue vs edit and vs discard in both orders; two issues of one store serialize at the counter in commit order; an issue waiting on the customer row while a rename commits, behind a settings write, on key 530030 while a level narrowing commits, and at 016\'s hold while a revocation commits — each wait first seen in pg_locks, nothing partial', async () => {
  const f = await scene('race', { drafts: 20 });
  const d = [...f.drafts];
  let number = 0;
  const invoiceCount = async () => (await owner`select count(*)::int as n from tmpos_invoice_issue.issued_invoice where store_id = ${f.S}`)[0].n;
  const consistent = async (label) => {
    assert.equal(await counterOf(f.S), String(number), `${label}: the counter at the last number`);
    assert.equal(await invoiceCount(), number, `${label}: one invoice per number`);
  };
  // (1) Issue vs issue on one draft (two actors, so 016's hold does not serialize them): one applied, one invalid_state, one invoice.
  {
    const draft = d.shift();
    const a = randomUUID();
    const first = holding(runtime, (tx) => issue(f.kBoss, { ...at(f, draft), invoice: a, db: tx }));
    let second = null;
    try {
      await until(() => first.ready || first.out !== undefined, 'the first issue applied, uncommitted');
      assert.deepEqual(first.value, [ISSUED(f.boss, f, { invoice: a, number: number + 1 })]);
      second = running(runtime, (tx) => issue(f.kManager, { ...at(f, draft), db: tx }));
      await until(() => blockedBy(second.pid, first.pid), 'the second issue waits on the header');
      assert.deepEqual(await waitsFor(second.pid), [['transactionid', 'ShareLock']], 'a row lock wait');
      assert.deepEqual(await rowWaitOn(second.pid), ['tmpos_invoice_draft.invoice_draft'], 'the wait is on the header');
      assert.match(await queryOf(second.pid), /m7b_invoice_issue/);
      first.release('commit');
      finished(await first.done, 'the first issue');
      number += 1;
      assert.deepEqual(finished(await second.done, 'the second issue').value, [ISSUE_NO('invalid_state')], 'the second: invalid_state');
      assert.deepEqual(await invoicesOfDraft(draft), [a], 'exactly one invoice');
      await consistent('issue vs issue');
    } finally { await settle(first, second); }
  }
  // (2) Issue vs edit and (3) issue vs discard — the other first: it wins at the header, the issue waits and loses (conflict /
  // invalid_state); rolled back instead, the issue applies. The issue first: the other waits and answers invalid_state; rolled
  // back instead, the other applies and no number is used.
  const others = [
    ['edit', (tx, draft) => edit(f.kManager, f.S, f.T, draft, 1, f.C1, [line('Raced', 1, 1)], { db: tx }), 'conflict', DRAFT_DONE(f.manager, f.T, f.S, 2)],
    ['discard', (tx, draft) => discard(f.kManager, f.S, f.T, draft, 1, { db: tx }), 'invalid_state', DRAFT_DONE(f.manager, f.T, f.S, 2)],
  ];
  for (const [name, call, loses, wins] of others) {
    for (const ending of ['commit', 'rollback']) {
      const draft = d.shift();
      const label = `the ${name} first, ${ending}`;
      const other = holding(runtime, (tx) => call(tx, draft));
      let issuing = null;
      const invoice = randomUUID();
      try {
        await until(() => other.ready, `${label}: the ${name} applied, uncommitted`);
        assert.deepEqual(other.value, [wins]);
        issuing = running(runtime, (tx) => issue(f.kBoss, { ...at(f, draft), invoice, db: tx }));
        await until(() => blockedBy(issuing.pid, other.pid), `${label}: the issue waits on the header`);
        assert.deepEqual(await waitsFor(issuing.pid), [['transactionid', 'ShareLock']]);
        assert.deepEqual(await rowWaitOn(issuing.pid), ['tmpos_invoice_draft.invoice_draft'], 'the wait is on the header');
        other.release(ending);
        finished(await other.done, `${label}: the ${name}`, ending === 'commit' ? 'committed' : 'rolled back');
        const out = finished(await issuing.done, `${label}: the issue`).value;
        if (ending === 'commit') {
          assert.deepEqual(out, [ISSUE_NO(loses)], `${label}: the issue answers ${loses}`);
          assert.deepEqual(await invoicesOfDraft(draft), [], `${label}: no invoice`);
        } else {
          number += 1;
          assert.deepEqual(out, [ISSUED(f.boss, f, { invoice, number })], `${label}: the issue applies`);
        }
        await consistent(label);
      } finally { await settle(other, issuing); }
    }
    for (const ending of ['commit', 'rollback']) {
      const draft = d.shift();
      const label = `the issue first, ${ending}, then the ${name}`;
      const invoice = randomUUID();
      const issuing = holding(runtime, (tx) => issue(f.kBoss, { ...at(f, draft), invoice, db: tx }));
      let other = null;
      try {
        await until(() => issuing.ready, `${label}: the issue applied, uncommitted`);
        assert.deepEqual(issuing.value, [ISSUED(f.boss, f, { invoice, number: number + 1 })]);
        other = running(runtime, (tx) => call(tx, draft));
        await until(() => blockedBy(other.pid, issuing.pid), `${label}: the ${name} waits on the header`);
        assert.deepEqual(await waitsFor(other.pid), [['transactionid', 'ShareLock']]);
        assert.deepEqual(await rowWaitOn(other.pid), ['tmpos_invoice_draft.invoice_draft'], 'the wait is on the header');
        issuing.release(ending);
        finished(await issuing.done, `${label}: the issue`, ending === 'commit' ? 'committed' : 'rolled back');
        const out = finished(await other.done, `${label}: the ${name}`).value;
        if (ending === 'commit') {
          number += 1;
          assert.deepEqual(out, [DRAFT_NO('invalid_state')], `${label}: the ${name} answers invalid_state`);
          assert.deepEqual(await draftOf(draft), { status: 'issued', version: '2' });
        } else {
          assert.deepEqual(out, [wins], `${label}: the ${name} applies`);
          assert.deepEqual(await invoicesOfDraft(draft), [], `${label}: no invoice, no number used`);
        }
        await consistent(label);
      } finally { await settle(issuing, other); }
    }
  }
  // (4) Two issues of one store on different drafts serialize at the counter: the second waits on the counter row, then takes
  // the next number, issued later; rolled back instead, it takes the first's number.
  for (const ending of ['commit', 'rollback']) {
    const [d1, d2] = [d.shift(), d.shift()];
    const [a, b] = [randomUUID(), randomUUID()];
    const label = `two issues at the counter, the first ${ending}`;
    const first = holding(runtime, (tx) => issue(f.kBoss, { ...at(f, d1), invoice: a, db: tx }));
    let second = null;
    try {
      await until(() => first.ready, `${label}: the first applied, uncommitted`);
      second = running(runtime, (tx) => issue(f.kManager, { ...at(f, d2), invoice: b, db: tx }));
      await until(() => blockedBy(second.pid, first.pid), `${label}: the second waits behind the first`);
      assert.deepEqual(await waitsFor(second.pid), [['transactionid', 'ShareLock']], `${label}: a row lock wait`);
      assert.deepEqual(await rowWaitOn(second.pid), ['tmpos_invoice_issue.store_invoice_counter'], 'the wait is on the counter row');
      assert.equal(await rowHeld('tmpos_invoice_draft.invoice_draft', 'draft_id', d2), true, `${label}: the second holds its own header (it waits past it, at the counter)`);
      first.release(ending);
      finished(await first.done, `${label}: the first`, ending === 'commit' ? 'committed' : 'rolled back');
      if (ending === 'commit') number += 1;
      const out = finished(await second.done, `${label}: the second`).value;
      number += 1;
      assert.deepEqual(out, [ISSUED(f.manager, f, { invoice: b, number })], `${label}: the second takes ${number}`);
      if (ending === 'commit') {
        const times = (await owner`select o.number::text as n, o.issued_at < p.issued_at as earlier from tmpos_invoice_issue.issued_invoice o, tmpos_invoice_issue.issued_invoice p
          where o.invoice_id = ${a} and p.invoice_id = ${b}`).map((r) => ({ ...r }));
        assert.deepEqual(times, [{ n: String(number - 1), earlier: true }], `${label}: numbers and issue times in commit order`);
      } else {
        assert.deepEqual(await invoicesOfDraft(d1), [], `${label}: the rolled-back first left nothing`);
      }
      await consistent(label);
    } finally { await settle(first, second); }
  }
  // (5) The customer row: a rename held uncommitted; the issue waits on it FOR SHARE, then conflicts on the new version.
  {
    const draft = d.shift();
    const renaming = holding(owner, (tx) => rename(f.C1, `IIR race renamed ${SUFFIX}`, tx));
    let issuing = null;
    try {
      await until(() => renaming.ready, 'the rename held');
      const cv = await customerVersionOf(f.C1);
      issuing = running(runtime, (tx) => issue(f.kBoss, { ...at(f, draft, { cv }), db: tx }));
      await until(() => blockedBy(issuing.pid, renaming.pid), 'the issue waits on the customer row');
      assert.deepEqual(await waitsFor(issuing.pid), [['transactionid', 'ShareLock']]);
      assert.deepEqual(await rowWaitOn(issuing.pid), ['tmpos_customer.customer'], 'the wait is on the customer row');
      assert.equal(await rowHeld('tmpos_invoice_draft.invoice_draft', 'draft_id', draft), true, 'having taken the header');
      renaming.release('commit');
      finished(await renaming.done, 'the rename');
      assert.deepEqual(finished(await issuing.done, 'the issue').value, [ISSUE_NO('conflict')], 'the rename committed: conflict');
      await consistent('the customer rename');
    } finally { await settle(renaming, issuing); }
  }
  // (6) The settings row: a settings write held uncommitted; the issue waits on it FOR SHARE, then conflicts on the new version.
  {
    const draft = d.shift();
    const writing = holding(runtime, (tx) => settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: f.sv, db: tx }));
    let issuing = null;
    try {
      await until(() => writing.ready, 'the settings write applied, uncommitted');
      assert.deepEqual(writing.value, [SET_DONE(f.own, f.T, f.S, f.sv + 1)]);
      issuing = running(runtime, (tx) => issue(f.kBoss, { ...at(f, draft, { cv: 2 }), db: tx }));
      await until(() => blockedBy(issuing.pid, writing.pid), 'the issue waits behind the settings write');
      assert.deepEqual(await waitsFor(issuing.pid), [['transactionid', 'ShareLock']]);
      assert.deepEqual(await rowWaitOn(issuing.pid), ['tmpos_invoice_issue.store_issuing_settings'], 'the wait is on the settings row');
      writing.release('commit');
      finished(await writing.done, 'the settings write');
      f.sv += 1;
      assert.deepEqual(finished(await issuing.done, 'the issue').value, [ISSUE_NO('conflict')], 'the settings committed: conflict');
      await consistent('the settings write');
    } finally { await settle(writing, issuing); }
  }
  // (7) Key 530030: a level narrowing (Invoices Approve -> Manage; Customers -> none) held uncommitted; a manager's issue waits on
  // the key SHARED after taking the header; committed, it is refused; rolled back, it applies.
  for (const [domain, level, ending] of [['invoices', 'manage', 'commit'], ['customers', 'none', 'commit'], ['invoices', 'manage', 'rollback']]) {
    const draft = d.shift();
    const label = `${domain} -> ${level}, ${ending}`;
    await setLevel(f.T, 'manager', 'invoices', 'approve');
    await owner`delete from tmpos_role.tenant_role_level where tenant_id = ${f.T} and role_id = 'manager' and domain = 'customers'`;
    const narrowing = holding(owner, (tx) => setLevel(f.T, 'manager', domain, level, tx));
    let issuing = null;
    const invoice = randomUUID();
    try {
      await until(() => narrowing.ready, `${label}: the narrowing held`);
      issuing = running(runtime, (tx) => issue(f.kManager, { ...at(f, draft, { cv: 2 }), invoice, db: tx }));
      await until(() => blockedBy(issuing.pid, narrowing.pid), `${label}: the issue waits behind the narrowing`);
      assert.deepEqual(await waitsFor(issuing.pid), [['advisory', 'ShareLock']], `${label}: on the advisory key, SHARED`);
      assert.deepEqual(await advisoryWait(issuing.pid), [{ class: GUARD_CLASS, mode: 'ShareLock' }], `${label}: key 530030`);
      assert.equal(await rowHeld('tmpos_invoice_draft.invoice_draft', 'draft_id', draft), true, `${label}: having taken the header`);
      const before = await footprint([f.T], [draft]);
      narrowing.release(ending);
      finished(await narrowing.done, `${label}: the narrowing`, ending === 'commit' ? 'committed' : 'rolled back');
      const out = finished(await issuing.done, `${label}: the issue`).value;
      if (ending === 'commit') {
        assert.deepEqual(out, [ISSUE_NO('refused')], `${label}: refused by the re-read under the key`);
        assert.deepEqual(await footprint([f.T], [draft]), before, `${label}: nothing written`);
      } else {
        number += 1;
        assert.deepEqual(out, [ISSUED(f.manager, f, { invoice, number })], `${label}: applied`);
      }
      await consistent(label);
    } finally { await settle(narrowing, issuing); }
  }
  await clearLevels(f.T);
  // (8) 016's hold: the actor's account row held; the issue waits there; a grant suspension or a session revocation commits
  // meanwhile; released, the issue is refused, nothing written.
  for (const [label, revoke] of [['a grant suspension', (m) => owner`update user_membership set status = 'suspended' where membership_id = ${m.who.memberships[0]} returning 1`],
    ['a session revocation', (m) => owner`select tmpos_session.m5_session_revoke(${m.key}::text) as r`]]) {
    const draft = d.shift();
    const m = await member(f, label.split(' ').at(-1), 'manager');
    const holder = holding(owner, (tx) => tx`select 1 from public.app_user where internal_user_id = ${m.who.id} for update`);
    let issuing = null;
    try {
      await until(() => holder.ready, `${label}: the account row held`);
      issuing = running(runtime, (tx) => issue(m.key, { ...at(f, draft, { cv: 2 }), db: tx }));
      await until(() => blockedBy(issuing.pid, holder.pid), `${label}: the issue waits at 016's hold`);
      assert.deepEqual(await waitsFor(issuing.pid), [['transactionid', 'ShareLock']]);
      assert.deepEqual(await rowWaitOn(issuing.pid), ['app_user'], 'the wait is on the account row, at 016\'s hold');
      const before = await footprint([f.T], [draft]);
      assert.equal((await revoke(m)).length, 1, `${label}: committed while the issue waits`);
      holder.release('rollback');
      await holder.done;
      assert.deepEqual(finished(await issuing.done, `${label}: the issue`).value, [ISSUE_NO('refused')], `${label}: refused`);
      assert.deepEqual(await footprint([f.T], [draft]), before, `${label}: nothing written`);
      await consistent(label);
    } finally { await settle(holder, issuing); }
  }
  assert.deepEqual(d, [], 'every draft used');
});

// ===========================================================================
// IIR-13..15: the guards, the old routines, the snapshot
// ===========================================================================

test('IIR-13 (ISS-13, AC-10): the guards as the table owner, in normal and replica mode — UPDATE, DELETE and TRUNCATE of issued headers, lines, settings and counter refused; forged headers refused; a line insert into an issued invoice refused; draft -> issued without its invoice refused; an invoice without its lines (or its draft move, or its counter) refused at COMMIT; deleting the tenant, store, customer or source draft refused, never cascading', async () => {
  const f = await scene('guards', { drafts: 2 });
  const [dIssued, dOpen] = f.drafts;
  const INV = randomUUID();
  assert.deepEqual(await issue(f.kBoss, { ...at(f, dIssued), invoice: INV }), [ISSUED(f.boss, f, { invoice: INV, number: 1 })]);
  const bareStore = await newStore(f.T, `guards bare ${SUFFIX}`);
  const foreignStore = await newStore(T_OTHER, `guards foreign ${SUFFIX}`);
  const M = {
    header: 'migration 034: an issued invoice is never updated or deleted',
    line: 'migration 034: a line of an issued invoice is never updated or deleted',
    within: 'migration 034: a line of an issued invoice lies within its header\'s line count',
    sameLine: 'migration 034: a line of an issued invoice is its open source draft\'s line at the same position',
    source: 'migration 034: an issued invoice is made only from its source draft, open at the reviewed version',
    seller: 'migration 034: an issued invoice records its store\'s issuing settings at the reviewed version',
    customer: 'migration 034: an issued invoice records its customer at the reviewed version',
    next: 'migration 034: an issued invoice takes its store\'s next number',
    settingsInsert: 'migration 034: a store\'s issuing settings are created at version 1, for a store of their tenant',
    settingsDelete: 'migration 034: a store\'s issuing settings are never deleted',
    settingsMove: 'migration 034: a store\'s issuing settings move by exactly one version, in the same tenant and store',
    counterInsert: 'migration 034: a store\'s invoice counter is created at 0, beside its issuing settings',
    counterDelete: 'migration 034: a store\'s invoice counter is never deleted',
    counterMove: 'migration 034: a store\'s invoice counter moves by exactly one, to the number of an issued invoice of that store',
    truncate: 'migration 034: issuing settings, counters and issued invoices are never truncated',
    draftTerminal: 'migration 034: an issued invoice draft is terminal and admits no update',
    draftDelete: 'migration 034: an issued invoice draft is never deleted',
    draftMove: 'migration 034: an open invoice draft moves to issued only at the next version, with nothing else changed, over its issued invoice',
    draftLine: 'migration 033: a line of a discarded invoice draft never changes',
    draftInsert: 'migration 033: an invoice draft is saved open (status draft) only',
    // The deferred check's one fixed text, read from the up file (the counter rule's wording is the file's to state).
    commit: /raise exception '(migration 034: an issued invoice commits only (?:[^']|'')*)'/.exec(UP_034)[1].replace(/''/g, '\''),
  };
  assert.match(M.commit, /^migration 034: an issued invoice commits only with all of its lines, its draft issued at the next version and its store's counter at /);
  /** A header insert for `draft` from its real sources (the counter's next number), with `over` replacing any column. */
  const headerOf = async (draft, over = {}) => {
    const [d] = await owner`select tenant_id, store_id, version::text as version, customer_id, currency, line_count, subtotal_cents::text as subtotal
      from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`;
    const [s] = await owner`select version::text as version, legal_name, store_name, postal_address, tax_registration_id, tax_mode, tax_rate
      from tmpos_invoice_issue.store_issuing_settings where store_id = ${d.store_id}`;
    const [c] = await owner`select name, row_version::text as version from tmpos_customer.customer where customer_id = ${d.customer_id}`;
    const tax = s.tax_mode === 'none' ? null : taxOf(d.subtotal, s.tax_rate);
    return { invoice_id: randomUUID(), tenant_id: d.tenant_id, store_id: d.store_id, number: String(BigInt(await counterOf(d.store_id)) + 1n),
      source_draft_id: draft, source_draft_version: d.version, settings_version: s.version, customer_id: d.customer_id, customer_version: c.version,
      customer_name: c.name, legal_name: s.legal_name, store_name: s.store_name, postal_address: s.postal_address, tax_registration_id: s.tax_registration_id,
      currency: d.currency, line_count: d.line_count, subtotal_cents: d.subtotal, tax_mode: s.tax_mode, tax_rate: s.tax_rate, tax_cents: big(tax),
      total_cents: String(BigInt(d.subtotal) + (tax ?? 0n)), issued_by: randomUUID(), ...over };
  };
  const insertHeader = (tx, h) => tx.unsafe(`insert into tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id, number, snapshot_version,
      source_draft_id, source_draft_version, settings_version, customer_id, customer_version, customer_name, legal_name, store_name, postal_address,
      tax_registration_id, currency, line_count, subtotal_cents, tax_mode, tax_rate, tax_cents, total_cents, issued_at, issued_by)
    values ($1::uuid, $2::uuid, $3::uuid, $4::bigint, 1, $5::uuid, $6::bigint, $7::bigint, $8::uuid, $9::bigint, $10::text, $11::text, $12::text, $13::text,
      $14::text, $15::text, $16::integer, $17::bigint, $18::text, $19::integer, $20::bigint, $21::bigint, pg_catalog.now(), $22::uuid)`,
  [h.invoice_id, h.tenant_id, h.store_id, h.number, h.source_draft_id, h.source_draft_version, h.settings_version, h.customer_id, h.customer_version,
    h.customer_name, h.legal_name, h.store_name, h.postal_address, h.tax_registration_id, h.currency, h.line_count, h.subtotal_cents, h.tax_mode, h.tax_rate,
    h.tax_cents, h.total_cents, h.issued_by]);
  /** The draft's lines copied under invoice `invoice`, as the issue copies them. */
  const copyLines = (tx, invoice, draft) => tx`insert into tmpos_invoice_issue.issued_invoice_line (invoice_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
    select ${invoice}::uuid, l.tenant_id, l.store_id, l.position, l.description, l.quantity, l.unit_price_cents, l.line_total_cents
      from tmpos_invoice_draft.invoice_draft_line l where l.draft_id = ${draft} order by l.position`;
  const forged = {
    issuedSource: await headerOf(dIssued),
    wrongNumber: await headerOf(dOpen, { number: '7' }),
    staleSettings: await headerOf(dOpen, { settings_version: '2' }),
    otherSeller: await headerOf(dOpen, { legal_name: 'Forged Seller LLC' }),
    otherCustomerName: await headerOf(dOpen, { customer_name: 'Forged Customer' }),
    staleDraft: await headerOf(dOpen, { source_draft_version: '2' }),
  };
  const statements = [
    ['an issued header updated', `update ${NS}.issued_invoice set customer_name = 'Forged' where invoice_id = '${INV}'`, M.header],
    ['an issued header updated to itself', `update ${NS}.issued_invoice set number = number where invoice_id = '${INV}'`, M.header],
    ['an issued header deleted', `delete from ${NS}.issued_invoice where invoice_id = '${INV}'`, M.header],
    ['an issued line updated', `update ${NS}.issued_invoice_line set description = 'Forged' where invoice_id = '${INV}' and position = 1`, M.line],
    ['an issued line updated to itself', `update ${NS}.issued_invoice_line set quantity = quantity where invoice_id = '${INV}'`, M.line],
    ['an issued line deleted', `delete from ${NS}.issued_invoice_line where invoice_id = '${INV}' and position = 3`, M.line],
    ['a line inserted beyond the line count', `insert into ${NS}.issued_invoice_line (invoice_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
      values ('${INV}', '${f.T}', '${f.S}', 4, 'Added', 1, 1, 1)`, M.within],
    ['a line inserted at a used position (the draft issued)', `insert into ${NS}.issued_invoice_line (invoice_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
      values ('${INV}', '${f.T}', '${f.S}', 1, 'Screen replacement', 1, 12999, 12999)`, M.sameLine],
    ['a line under a header of another store', `insert into ${NS}.issued_invoice_line (invoice_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
      values ('${INV}', '${f.T}', '${bareStore}', 1, 'Added', 1, 1, 1)`, M.within],
    ['settings deleted', `delete from ${NS}.store_issuing_settings where store_id = '${f.S}'`, M.settingsDelete],
    ['settings two versions on', `update ${NS}.store_issuing_settings set version = version + 2 where store_id = '${f.S}'`, M.settingsMove],
    ['settings changed at the same version', `update ${NS}.store_issuing_settings set legal_name = 'Forged' where store_id = '${f.S}'`, M.settingsMove],
    ['settings moved to another tenant', `update ${NS}.store_issuing_settings set tenant_id = '${T_OTHER}', version = version + 1 where store_id = '${f.S}'`, M.settingsMove],
    ['settings with another creation time', `update ${NS}.store_issuing_settings set created_at = created_at - interval '1 day', version = version + 1 where store_id = '${f.S}'`, M.settingsMove],
    ['settings inserted at version 2', `insert into ${NS}.store_issuing_settings (tenant_id, store_id, version, legal_name, store_name, postal_address, tax_mode)
      values ('${f.T}', '${bareStore}', 2, 'L', 'S', 'A', 'none')`, M.settingsInsert],
    ['settings for a store of another tenant', `insert into ${NS}.store_issuing_settings (tenant_id, store_id, version, legal_name, store_name, postal_address, tax_mode)
      values ('${f.T}', '${foreignStore}', 1, 'L', 'S', 'A', 'none')`, M.settingsInsert],
    ['the counter advanced with no invoice of that number', `update ${NS}.store_invoice_counter set last_number = last_number + 1 where store_id = '${f.S}'`, M.counterMove],
    ['the counter moved back', `update ${NS}.store_invoice_counter set last_number = last_number - 1 where store_id = '${f.S}'`, M.counterMove],
    ['the counter updated to itself', `update ${NS}.store_invoice_counter set last_number = last_number where store_id = '${f.S}'`, M.counterMove],
    ['the counter deleted', `delete from ${NS}.store_invoice_counter where store_id = '${f.S}'`, M.counterDelete],
    ['a counter without settings', `insert into ${NS}.store_invoice_counter (tenant_id, store_id, last_number) values ('${f.T}', '${bareStore}', 0)`, M.counterInsert],
    ['a counter created above 0', `insert into ${NS}.store_invoice_counter (tenant_id, store_id, last_number) values ('${f.T}', '${bareStore}', 5)`, M.counterInsert],
    ['the issued draft updated', `update tmpos_invoice_draft.invoice_draft set customer_id = '${f.C2}' where draft_id = '${dIssued}'`, M.draftTerminal],
    ['the issued draft back to draft', `update tmpos_invoice_draft.invoice_draft set status = 'draft', version = version + 1 where draft_id = '${dIssued}'`, M.draftTerminal],
    ['the issued draft updated to itself', `update tmpos_invoice_draft.invoice_draft set version = version where draft_id = '${dIssued}'`, M.draftTerminal],
    ['the issued draft deleted', `delete from tmpos_invoice_draft.invoice_draft where draft_id = '${dIssued}'`, M.draftDelete],
    ['a line of the issued draft changed', `update tmpos_invoice_draft.invoice_draft_line set description = 'Forged' where draft_id = '${dIssued}' and position = 1`, M.draftLine],
    ['an open draft -> issued without its invoice', `update tmpos_invoice_draft.invoice_draft set status = 'issued', version = version + 1 where draft_id = '${dOpen}'`, M.draftMove],
    ['an open draft -> issued at the same version', `update tmpos_invoice_draft.invoice_draft set status = 'issued' where draft_id = '${dOpen}'`, M.draftMove],
    ['a draft inserted as issued', `insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
      values ('${randomUUID()}', '${f.T}', '${f.S}', '${f.C1}', 'issued', 'USD', 2, 1, 1, '${randomUUID()}')`, M.draftInsert],
    ['the issued header truncated', `truncate ${NS}.issued_invoice cascade`, M.truncate],
    ['the issued lines truncated', `truncate ${NS}.issued_invoice_line`, M.truncate],
    ['the counter truncated', `truncate ${NS}.store_invoice_counter`, M.truncate],
    ['the settings truncated', `truncate ${NS}.store_issuing_settings cascade`, M.truncate],
  ];
  const forgedCases = [['a forged header over the issued draft', forged.issuedSource, M.source], ['a forged header at the wrong number', forged.wrongNumber, M.next],
    ['a forged header at a stale settings version', forged.staleSettings, M.seller], ['a forged header with another seller', forged.otherSeller, M.seller],
    ['a forged header with another customer name', forged.otherCustomerName, M.customer], ['a forged header at a stale draft version', forged.staleDraft, M.source]];
  const before = await footprint([f.T], f.drafts);
  for (const replica of [false, true]) {
    const mode = replica ? 'replica: ' : '';
    const replicate = (tx) => (replica ? tx.unsafe('set local session_replication_role = replica') : Promise.resolve());
    for (const [label, sql, message] of statements) {
      const out = await rolledBack(async (tx) => { await replicate(tx); await tx.unsafe(sql); });
      assert.deepEqual([out.code, out.message], ['23001', message], `${mode}${label} (${JSON.stringify(out)})`);
    }
    for (const [label, h, message] of forgedCases) {
      const out = await rolledBack(async (tx) => { await replicate(tx); await insertHeader(tx, h); });
      assert.deepEqual([out.code, out.message], ['23001', message], `${mode}${label} (${JSON.stringify(out)})`);
    }
    // The admitted path's pieces pass the row guards; the deferred check refuses at COMMIT unless the issue is complete.
    for (const [label, steps] of [
      ['an invoice without its lines', async (tx, h) => { await insertHeader(tx, h); await tx`update tmpos_invoice_issue.store_invoice_counter set last_number = last_number + 1 where store_id = ${f.S}`;
        await tx`update tmpos_invoice_draft.invoice_draft set status = 'issued', version = version + 1 where draft_id = ${dOpen}`; }],
      ['an invoice whose draft stays open', async (tx, h) => { await insertHeader(tx, h); await copyLines(tx, h.invoice_id, dOpen);
        await tx`update tmpos_invoice_issue.store_invoice_counter set last_number = last_number + 1 where store_id = ${f.S}`; }],
      ['an invoice whose counter never moves', async (tx, h) => { await insertHeader(tx, h); await copyLines(tx, h.invoice_id, dOpen);
        await tx`update tmpos_invoice_draft.invoice_draft set status = 'issued', version = version + 1 where draft_id = ${dOpen}`; }],
    ]) {
      const h = await headerOf(dOpen);
      const out = await errorOf(owner.begin(RC, async (tx) => { await replicate(tx); await steps(tx, h); }));
      assert.deepEqual([out?.code, out?.message], ['23001', M.commit], `${mode}${label}: refused at COMMIT (${JSON.stringify(out)})`);
    }
    // The control: the complete issue by hand commits only rolled back here (the row guards and the CHECKs admit it).
    const h = await headerOf(dOpen);
    const control = await rolledBack(async (tx) => {
      await replicate(tx);
      await insertHeader(tx, h);
      await copyLines(tx, h.invoice_id, dOpen);
      await tx`update tmpos_invoice_issue.store_invoice_counter set last_number = last_number + 1 where store_id = ${f.S}`;
      await tx`update tmpos_invoice_draft.invoice_draft set status = 'issued', version = version + 1 where draft_id = ${dOpen}`;
      await tx.unsafe('set constraints all immediate');
      return 'admitted';
    });
    assert.deepEqual(control, { value: 'admitted' }, `${mode}the complete issue's writes pass every guard and the commit check`);
  }
  assert.deepEqual(await footprint([f.T], f.drafts), before, 'every attempt refused or rolled back: nothing written');
  // Deletion never cascades through an issued row (normal mode: foreign keys fire there). The source draft is refused by its
  // terminal trigger, and with it lifted by 034's own key; the store, the customer and the tenant, with every OTHER foreign key
  // onto them removed in the rolled-back transaction, by one of 034's RESTRICT keys.
  const fkFailure = (out, label, names) => {
    assert.equal(out.code, '23503', `${label}: a foreign-key refusal (${JSON.stringify(out)})`);
    const name = /violates foreign key constraint "([^"]+)"/.exec(out.message)?.[1];
    assert.ok(names.includes(name), `${label}: refused by 034's key ${names.join(' | ')} (${out.message})`);
  };
  assert.deepEqual(Object.values(await rolledBack((tx) => tx`delete from tmpos_invoice_draft.invoice_draft where draft_id = ${dIssued}`)).slice(0, 2),
    ['23001', M.draftDelete], 'the source draft: its terminal trigger refuses');
  fkFailure(await rolledBack((tx) => withTriggersLifted(tx, DRAFT_TERMINAL, async () => {
    await tx`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = ${dIssued}`;
    await tx`delete from tmpos_invoice_draft.invoice_draft where draft_id = ${dIssued}`;
  })), 'the source draft, its trigger lifted', ['issued_invoice_draft_fkey']);
  const dropOthers = async (tx, targets) => {
    for (const k of await tx`select k.conname::text as name, k.conrelid::regclass::text as rel from pg_catalog.pg_constraint k
      where k.contype = 'f' and k.confrelid = any(${targets}::regclass[]) and k.confdeltype in ('a', 'r') and not (k.conname = any(${FKS_034}::text[]))`) {
      await tx.unsafe(`alter table ${k.rel} drop constraint ${k.name}`);
    }
  };
  for (const [label, targets, del, names] of [
    ['the store', ['public.store'], (tx) => tx`delete from public.store where store_id = ${f.S}`, ['issued_invoice_store_fkey', 'store_issuing_settings_store_fkey', 'store_invoice_counter_store_fkey']],
    ['the customer', ['tmpos_customer.customer'], (tx) => tx`delete from tmpos_customer.customer where customer_id = ${f.C1}`, ['issued_invoice_customer_fkey']],
    ['the tenant', ['public.tenant', 'public.store', 'tmpos_customer.customer'], (tx) => tx`delete from public.tenant where tenant_id = ${f.T}`,
      ['issued_invoice_store_fkey', 'store_issuing_settings_store_fkey', 'store_invoice_counter_store_fkey']],
  ]) {
    const plain = await rolledBack((tx) => del(tx));
    assert.equal(plain.code, '23503', `${label}: refused (${JSON.stringify(plain)})`);
    fkFailure(await rolledBack(async (tx) => { await dropOthers(tx, targets); await del(tx); }), `${label}, every other key removed`, names);
  }
  assert.deepEqual(await footprint([f.T], f.drafts), before, 'the deletions rolled back');
  assert.deepEqual((await getInvoice(f.kBoss, f.T, f.S, INV)).length, LINES.length, 'the issued invoice intact');
});

test('IIR-14 (AC-10): the old routines — 030\'s edit and 033\'s discard answer invalid_state on an issued draft, whatever version; 033\'s page_v2 and get_v2 never serve it (028\'s owner-only reads still do)', async () => {
  const f = await scene('old', { drafts: 3 });
  const [issued, a, b] = f.drafts;
  const invoice = randomUUID();
  assert.deepEqual(await issue(f.kBoss, { ...at(f, issued), invoice }), [ISSUED(f.boss, f, { invoice, number: 1 })]);
  const before = await footprint([f.T], f.drafts);
  for (const version of [2, 1, 3]) {
    assert.deepEqual(await edit(f.kBoss, f.S, f.T, issued, version, f.C2, [line('After issue', 1, 1)]), [DRAFT_NO('invalid_state')], `the edit at ${version}: invalid_state`);
    assert.deepEqual(await edit(f.kManager, f.S, f.T, issued, version, f.C1, LINES), [DRAFT_NO('invalid_state')], `the manager's edit at ${version}: invalid_state`);
    assert.deepEqual(await discard(f.kBoss, f.S, f.T, issued, version), [DRAFT_NO('invalid_state')], `the discard at ${version}: invalid_state`);
    assert.deepEqual(await discard(f.kManager, f.S, f.T, issued, version), [DRAFT_NO('invalid_state')], `the manager's discard at ${version}: invalid_state`);
  }
  assert.deepEqual(await footprint([f.T], f.drafts), before, 'nothing written');
  for (const key of [f.kBoss, f.kManager]) {
    assert.deepEqual((await pageV2(key, f.T, f.S)).map((r) => [r.o_draft_id, r.o_status]), [[b, 'draft'], [a, 'draft']], 'page_v2: the open drafts only, newest first');
    const missing = await getV2(key, f.T, f.S, randomUUID());
    assert.equal(missing.length, 1);
    assert.equal(missing[0].o_outcome, 'not_found');
    assert.deepEqual(await getV2(key, f.T, f.S, issued), missing, 'get_v2 of the issued draft: exactly the not_found row');
  }
  assert.deepEqual((await pageV2(f.kBoss, f.T, f.S, { db: owner, fn: PAGE_028_FN })).map((r) => [r.o_draft_id, r.o_status]),
    [[b, 'draft'], [a, 'draft'], [issued, 'issued']], '028\'s page (the owner\'s only) still lists it, issued');
  assert.equal((await getV2(f.kBoss, f.T, f.S, issued, { db: owner, fn: GET_028_FN }))[0].o_status, 'issued');
});

test('IIR-15 (ISS-14, AC-04): snapshot independence — a settings write (seller, tax mode) and a customer rename after issue leave m7b_issued_invoice_get and the page row unchanged, while the preview of an open draft follows the new values', async () => {
  const f = await scene('snapshot', { drafts: 2 });
  const invoice = randomUUID();
  assert.deepEqual(await issue(f.kBoss, { ...at(f, f.draft), invoice }), [ISSUED(f.boss, f, { invoice, number: 1 })]);
  const snapshot = await getInvoice(f.kBoss, f.T, f.S, invoice);
  const listed = await page(f.kBoss, f.T, f.S);
  const NEXT = { legalName: 'IIR Renamed Seller LLC', storeName: 'IIR Renamed Store', postalAddress: '9 Other Rd', taxRegistrationId: null, taxMode: 'none', taxRate: null };
  assert.deepEqual(await settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 1, s: NEXT }), [SET_DONE(f.own, f.T, f.S, 2)]);
  assert.equal((await rename(f.C1, `IIR snapshot renamed ${SUFFIX}`))[0].v, '2');
  assert.deepEqual(await getInvoice(f.kBoss, f.T, f.S, invoice), snapshot, 'the issued snapshot unchanged, column for column');
  assert.deepEqual(await page(f.kBoss, f.T, f.S), listed, 'the page row unchanged');
  assert.deepEqual([snapshot[0].o_legal_name, snapshot[0].o_tax_mode, snapshot[0].o_tax_rate, snapshot[0].o_settings_version, snapshot[0].o_customer_version],
    [SETTINGS.legalName, 'exclusive_rate', SETTINGS.taxRate, '1', '1'], 'it records what was issued');
  assert.deepEqual(await getInvoice(f.kManager, f.T, f.S, invoice), snapshot, 'the same snapshot for another reader');
  const p = await preview(f.kBoss, f.T, f.S, f.drafts[1]);
  assert.deepEqual([p[0].o_legal_name, p[0].o_tax_mode, p[0].o_tax_cents, p[0].o_settings_version, p[0].o_customer_name, p[0].o_customer_version],
    [NEXT.legalName, 'none', null, '2', `IIR snapshot renamed ${SUFFIX}`, '2'], 'an open draft\'s preview follows the new settings and name');
});

// ===========================================================================
// IIR-16..17: the settings routine and the reads
// ===========================================================================

test('IIR-16 (ISS-25 routine level, AC-02): the settings routine — the owner on a tenant grant applies (version 1, counter 0); a manager on a tenant grant, an owner with only a store grant and a read-only tenant are refused; another tenant\'s, a suspended and a read-only store are not_found; tenant_mismatch; stale, future and first-when-exists conflict writing nothing; identical values still move the version; two concurrent first writes give one applied and one conflict; every malformed text, tax and version raises 22023; the table\'s CHECKs refuse alike', async () => {
  const f = await scene('settings', { settings: null, drafts: 0 });
  const otherStore = await newStore(T_OTHER, `settings foreign ${SUFFIX}`);
  const suspended = await newStore(f.T, `settings suspended ${SUFFIX}`, 'suspended');
  const readOnly = await newStore(f.T, `settings read-only ${SUFFIX}`, 'read_only');
  const tenantManager = await actor('settings-tenant-manager', [tenantGrant(f.T, 'manager')]);
  const kTenantManager = await mint(tenantManager);
  const nothing = async (label, call, expected) => {
    const before = await issuingOf([f.T, T_OTHER]);
    assert.deepEqual(await call(), [expected], label);
    assert.deepEqual(await issuingOf([f.T, T_OTHER]), before, `${label}: nothing written`);
  };
  assert.deepEqual(await settingsGet(f.kOwn, f.T, f.S), [{ o_outcome: 'none', ...GET_NULLS, o_tenant_id: f.T, o_store_id: f.S, o_version: '0' }], 'none yet: version 0');
  await nothing('a manager on a tenant grant', () => settingsSet(kTenantManager, { store: f.S, tenant: f.T, version: 0 }), SET_NO('refused'));
  await nothing('an owner with only a store grant', () => settingsSet(f.kBoss, { store: f.S, tenant: f.T, version: 0 }), SET_NO('refused'));
  await nothing('an unknown session', () => settingsSet(newKey(), { store: f.S, tenant: f.T, version: 0 }), SET_NO('refused'));
  await nothing('tenant_mismatch', () => settingsSet(f.kOwn, { store: f.S, tenant: T_OTHER, version: 0 }), SET_NO('tenant_mismatch'));
  await nothing('another tenant\'s store', () => settingsSet(f.kOwn, { store: otherStore, tenant: f.T, version: 0 }), SET_NO('not_found'));
  await nothing('a suspended store', () => settingsSet(f.kOwn, { store: suspended, tenant: f.T, version: 0 }), SET_NO('not_found'));
  await nothing('a read-only store (a write status is required)', () => settingsSet(f.kOwn, { store: readOnly, tenant: f.T, version: 0 }), SET_NO('not_found'));
  await nothing('a missing store', () => settingsSet(f.kOwn, { store: randomUUID(), tenant: f.T, version: 0 }), SET_NO('not_found'));
  for (const [label, key, tenant, store, expected] of [
    ['the get: a manager on a tenant grant', kTenantManager, f.T, f.S, 'denied'], ['the get: a store grant only', f.kBoss, f.T, f.S, 'denied'],
    ['the get: another tenant expected', f.kOwn, T_OTHER, f.S, 'denied'], ['the get: another tenant\'s store', f.kOwn, f.T, otherStore, 'not_found'],
    ['the get: a suspended store', f.kOwn, f.T, suspended, 'not_found'], ['the get: a missing store', f.kOwn, f.T, randomUUID(), 'not_found'],
  ]) assert.deepEqual(await settingsGet(key, tenant, store), [{ o_outcome: expected, ...GET_NULLS }], label);
  assert.deepEqual(await settingsGet(f.kOwn, f.T, readOnly), [{ o_outcome: 'none', ...GET_NULLS, o_tenant_id: f.T, o_store_id: readOnly, o_version: '0' }], 'the get: a read-only store is readable');
  // The first write: version 1 and the counter at 0, in the owner's tenant.
  assert.deepEqual(await settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 0 }), [SET_DONE(f.own, f.T, f.S, 1)], 'the owner on a tenant grant applies');
  assert.deepEqual((await owner`select s.tenant_id, s.version::text as version, k.tenant_id as counter_tenant, k.last_number::text as last
    from tmpos_invoice_issue.store_issuing_settings s join tmpos_invoice_issue.store_invoice_counter k on k.store_id = s.store_id where s.store_id = ${f.S}`).map((r) => ({ ...r })),
  [{ tenant_id: f.T, version: '1', counter_tenant: f.T, last: '0' }], 'version 1 and the counter at 0');
  assert.deepEqual(await settingsGet(f.kOwn, f.T, f.S), [SETTINGS_ROW(f.T, f.S, 1)]);
  await nothing('a first write when settings exist', () => settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 0 }), SET_NO('conflict'));
  await nothing('a future version', () => settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 2 }), SET_NO('conflict'));
  // Identical values still move the version (no no-op); then the stale one conflicts.
  const [r1] = await owner`select to_jsonb(s) - 'version' - 'updated_at' as rest from tmpos_invoice_issue.store_issuing_settings s where store_id = ${f.S}`;
  assert.deepEqual(await settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 1 }), [SET_DONE(f.own, f.T, f.S, 2)], 'identical values: a new version');
  const [r2] = await owner`select to_jsonb(s) - 'version' - 'updated_at' as rest, version::text as version from tmpos_invoice_issue.store_issuing_settings s where store_id = ${f.S}`;
  assert.deepEqual([r2.version, r2.rest], ['2', r1.rest], 'only the version (and the update time) moved');
  await nothing('a stale version', () => settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 1 }), SET_NO('conflict'));
  assert.equal(await counterOf(f.S), '0', 'a later write never touches the counter');
  // Bounds accepted: 200, 120, 8 lines of 120 (967 characters), 64; the edge characters each rule admits inside a value.
  const LONGEST = { legalName: 'L'.repeat(200), storeName: 'S'.repeat(120), postalAddress: Array(8).fill('A'.repeat(120)).join('\n'), taxRegistrationId: 'T'.repeat(64),
    taxMode: 'exclusive_rate', taxRate: 100_000 };
  assert.equal(LONGEST.postalAddress.length, 967);
  assert.deepEqual(await settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 2, s: LONGEST }), [SET_DONE(f.own, f.T, f.S, 3)], 'every bound at its maximum');
  assert.deepEqual(await settingsGet(f.kOwn, f.T, f.S), [SETTINGS_ROW(f.T, f.S, 3, LONGEST)]);
  const INNER = { ...SETTINGS, legalName: 'Inner  space and　ideographic', taxMode: 'none', taxRate: null };
  assert.deepEqual(await settingsSet(f.kOwn, { store: f.S, tenant: f.T, version: 3, s: INNER }), [SET_DONE(f.own, f.T, f.S, 4)], 'white space inside a value is admitted');
  // Two concurrent first writes of one store, by two owners of the tenant: one applied, one waits on key 530034, then conflicts.
  const second = await actor('settings-second-owner', [tenantGrant(f.T, 'store_owner')]);
  const kSecond = await mint(second);
  const S2 = await newStore(f.T, `settings concurrent ${SUFFIX}`);
  const first = holding(runtime, (tx) => settingsSet(f.kOwn, { store: S2, tenant: f.T, version: 0, db: tx }));
  let racing = null;
  try {
    await until(() => first.ready, 'the first write applied, uncommitted');
    assert.deepEqual(first.value, [SET_DONE(f.own, f.T, S2, 1)]);
    racing = running(runtime, (tx) => settingsSet(kSecond, { store: S2, tenant: f.T, version: 0, db: tx }));
    await until(() => blockedBy(racing.pid, first.pid), 'the second first write waits behind the first');
    assert.deepEqual(await advisoryWait(racing.pid), [{ class: SETTINGS_CLASS, mode: 'ExclusiveLock' }], 'on the store\'s key 530034, EXCLUSIVE');
    first.release('commit');
    finished(await first.done, 'the first write');
    assert.deepEqual(finished(await racing.done, 'the second write').value, [SET_NO('conflict')], 'the second: conflict, never a uniqueness error');
  } finally { await settle(first, racing); }
  assert.deepEqual((await owner`select (select count(*) from tmpos_invoice_issue.store_issuing_settings where store_id = ${S2})::int as s,
    (select count(*) from tmpos_invoice_issue.store_invoice_counter where store_id = ${S2})::int as k`).map((r) => ({ ...r })), [{ s: 1, k: 1 }], 'one settings row, one counter');
  // A read-only tenant: refused (the set) and denied (the get), with a session minted after the change.
  const ro = await scene('settings-read-only', { settings: null, drafts: 0 });
  await owner`update tenant set status = 'read_only' where tenant_id = ${ro.T}`;
  const kRo = await mint(ro.own);
  await nothing('a read-only tenant', () => settingsSet(kRo, { store: ro.S, tenant: ro.T, version: 0 }), SET_NO('refused'));
  assert.deepEqual(await settingsGet(kRo, ro.T, ro.S), [{ o_outcome: 'denied', ...GET_NULLS }], 'the get: a read-only tenant is denied');
  // Malformed arguments: a fixed message naming the field, never the value; nothing read, locked or written.
  const ok = { store: S2, tenant: f.T, version: 1 };
  const malformed = [];
  const field = (name, values, make) => { for (const v of values) malformed.push([`${name} ${JSON.stringify(v)}`, make(v), `migration 034 settings: ${name} is malformed`]); };
  field('the legal name', [null, '', 'L'.repeat(201), ' Lead', 'Trail ', '\tTab', 'Edge ', '　Ideo', 'Feff﻿', ' Em', 'Bell\u0007', 'Del\u007f',
    'Nel\u0085', 'Line sep', 'Para sep', 'Rlo‮', 'Lri⁦', 'Alm؜', 'Lrm‎', 'Lf\ninside'], (v) => ({ ...ok, s: { ...SETTINGS, legalName: v } }));
  field('the store name', [null, '', 'S'.repeat(121), ' Lead', 'Pdi⁩'], (v) => ({ ...ok, s: { ...SETTINGS, storeName: v } }));
  field('the postal address', [null, '', '\nA', 'A\n', 'A\n\nB', 'A\r\nB', 'A\rB', ' A', 'A\n B', 'A \nB', 'A\tB', 'A'.repeat(121), Array(9).fill('L').join('\n'),
    'A B', 'A\n‮B'], (v) => ({ ...ok, s: { ...SETTINGS, postalAddress: v } }));
  field('the tax registration id', ['', 'T'.repeat(65), ' T', 'T‮'], (v) => ({ ...ok, s: { ...SETTINGS, taxRegistrationId: v } }));
  field('the tax setting', [['exclusive_rate', null], ['exclusive_rate', -1], ['exclusive_rate', 100_001], ['none', 0], ['inclusive', 5], [null, null], ['NONE', null]],
    ([mode, rate]) => ({ ...ok, s: { ...SETTINGS, taxMode: mode, taxRate: rate } }));
  for (const v of [null, -1, MAX]) malformed.push([`the version ${v}`, { ...ok, version: v }, 'migration 034 settings: the expected version is not one the settings can advance']);
  for (const [label, args] of [['a null store', { ...ok, store: null }], ['a null tenant', { ...ok, tenant: null }]]) malformed.push([label, args, 'migration 034 settings: an argument is malformed']);
  const before = await issuingOf([f.T]);
  for (const [label, args, message] of malformed) {
    const err = await errorOf(settingsSet(f.kOwn, args));
    assert.deepEqual([err?.code, err?.message], ['22023', message], label);
  }
  for (const key of [null, 'bad key', 'k'.repeat(129)]) {
    const err = await errorOf(settingsSet(key, ok));
    assert.deepEqual([err?.code, err?.message], ['22023', 'migration 034 settings: an argument is malformed'], `the key ${JSON.stringify(key)}`);
    const read = await errorOf(settingsGet(key, f.T, f.S));
    assert.deepEqual([read?.code, read?.message], ['22023', 'migration 034 settings read: an argument is malformed'], `the get, the key ${JSON.stringify(key)}`);
  }
  assert.deepEqual(await issuingOf([f.T]), before, 'no malformed argument wrote anything');
  let rr = null;
  await assert.rejects(runtime.begin('isolation level repeatable read', async (tx) => {
    rr = await errorOf(settingsSet(f.kOwn, { ...ok, db: tx }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  assert.deepEqual([rr?.code, rr?.message], ['55000', 'migration 034 settings: it must run under READ COMMITTED, so that its checks see what committed before its locks']);
  // The table's own CHECKs refuse the same text (the owner's insert, rolled back; the guard admits a version 1 row).
  const bare = await newStore(f.T, `settings check ${SUFFIX}`);
  const tableCheck = await rolledBack(async (tx) => {
    const insert = (sp, legal, address, taxId, mode, rate) => sp`insert into tmpos_invoice_issue.store_issuing_settings
      (tenant_id, store_id, version, legal_name, store_name, postal_address, tax_registration_id, tax_mode, tax_rate)
      values (${f.T}, ${bare}, 1, ${legal}, 'Store', ${address}, ${taxId}, ${mode}, ${rate})`;
    return [await attempt(tx, (sp) => insert(sp, 'Rlo‮', 'A', null, 'none', null)), await attempt(tx, (sp) => insert(sp, 'Legal', 'A\r\nB', null, 'none', null)),
      await attempt(tx, (sp) => insert(sp, 'Legal', 'A', ' T', 'none', null)), await attempt(tx, (sp) => insert(sp, 'Legal', 'A', null, 'exclusive_rate', null)),
      await attempt(tx, (sp) => insert(sp, 'Legal', 'A', null, 'none', 0)), await attempt(tx, (sp) => insert(sp, 'Legal', 'A\nB', 'T', 'exclusive_rate', 0))];
  });
  assert.deepEqual(tableCheck.value, ['23514', '23514', '23514', '23514', '23514', 'accepted'], `the CHECKs (${JSON.stringify(tableCheck)})`);
});

test('IIR-17 (ISS-15, AC-04): the reads — the page by number descending with anchored cursors, cursor_unknown for a foreign or unknown anchor; the sourceDraft filter gives no row for an unknown, another store\'s, an open or a discarded draft; the page and the get denied below Invoices View or without Customers View, open to View readers; the preview equals the issue\'s later snapshot, answers invalid_state at version 2^53-1 and not_found for a foreign draft; no read returns the issuing actor', async () => {
  const f = await scene('reads', { drafts: 6 });
  const [d1, d2, d3, dOpen, dDisc, dPreview] = f.drafts;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, draft] of [d1, d2, d3].entries()) {
    assert.deepEqual(await issue(f.kBoss, { ...at(f, draft), invoice: ids[i] }), [ISSUED(f.boss, f, { invoice: ids[i], number: i + 1 })]);
  }
  assert.deepEqual(await discard(f.kBoss, f.S, f.T, dDisc, 1), [DRAFT_DONE(f.boss, f.T, f.S, 2)]);
  // A second store of the tenant and another tenant, each with an issued invoice.
  const S2 = await newStore(f.T, `reads second ${SUFFIX}`);
  const boss2 = await actor('reads-second-owner', [storeGrant(f.T, S2, 'store_owner')]);
  const kBoss2 = await mint(boss2);
  assert.deepEqual(await settingsSet(f.kOwn, { store: S2, tenant: f.T, version: 0 }), [SET_DONE(f.own, f.T, S2, 1)]);
  const dOther = await create(kBoss2, S2, f.T, f.C1);
  const iOther = randomUUID();
  assert.equal((await issue(kBoss2, { store: S2, tenant: f.T, draft: dOther, invoice: iOther }))[0].o_number, '1');
  const g = await scene('reads-foreign', { drafts: 1 });
  const iForeign = randomUUID();
  assert.equal((await issue(g.kBoss, { ...at(g, g.draft), invoice: iForeign }))[0].o_number, '1');
  // The page: number descending, every column; bounded; cursors anchored inside this store.
  const all = await page(f.kBoss, f.T, f.S);
  const issuedAt = Object.fromEntries((await owner`select invoice_id, to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t
    from tmpos_invoice_issue.issued_invoice where store_id = ${f.S}`).map((r) => [r.invoice_id, r.t]));
  const TOTAL = String(SUBTOTAL + taxOf(SUBTOTAL, SETTINGS.taxRate));
  assert.deepEqual(all, [[ids[2], d3, 3], [ids[1], d2, 2], [ids[0], d1, 1]].map(([invoice, draft, n]) => ({ o_outcome: 'invoice', o_tenant_id: f.T, o_store_id: f.S,
    o_invoice_id: invoice, o_number: String(n), o_source_draft_id: draft, o_customer_id: f.C1, o_customer_name: `IIR reads-1 ${SUFFIX}`, o_currency: 'USD',
    o_total_cents: TOTAL, o_issued_at: issuedAt[invoice], o_snapshot_version: 1 })), 'newest number first, every column');
  assert.ok(all.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r.o_issued_at)), 'UTC text with microseconds');
  const numbersOf = async (opts, key = f.kBoss) => (await page(key, f.T, f.S, opts)).map((r) => r.o_number);
  assert.deepEqual(await numbersOf({ limit: 1 }), ['3']);
  assert.deepEqual(await numbersOf({ after: ids[2], limit: 1 }), ['2'], 'after 3: 2');
  assert.deepEqual(await numbersOf({ after: ids[1] }), ['1'], 'after 2: 1');
  assert.deepEqual(await numbersOf({ after: ids[0] }), [], 'after 1: nothing');
  for (const [label, anchor] of [['another store\'s invoice', iOther], ['another tenant\'s invoice', iForeign], ['an unknown id', randomUUID()]]) {
    assert.deepEqual(await page(f.kBoss, f.T, f.S, { after: anchor }), [{ o_outcome: 'cursor_unknown', o_tenant_id: null, o_store_id: null, o_invoice_id: null,
      o_number: null, o_source_draft_id: null, o_customer_id: null, o_customer_name: null, o_currency: null, o_total_cents: null, o_issued_at: null,
      o_snapshot_version: null }], `a cursor naming ${label}: cursor_unknown`);
  }
  // The sourceDraft filter: the one invoice of an issued draft; no row otherwise.
  assert.deepEqual(await page(f.kBoss, f.T, f.S, { source: d2 }), [all[1]], 'the issued draft\'s invoice');
  for (const [label, source] of [['an unknown draft', randomUUID()], ['another store\'s issued draft', dOther], ['another tenant\'s issued draft', g.draft],
    ['an open draft', dOpen], ['a discarded draft', dDisc]]) {
    assert.deepEqual(await page(f.kBoss, f.T, f.S, { source }), [], `${label}: no row`);
  }
  for (const [label, opts] of [['both selectors', { after: ids[0], source: d1 }], ['a limit of 0', { limit: 0 }], ['a limit of 52', { limit: 52 }], ['a null limit', { limit: null }]]) {
    const err = await errorOf(page(f.kBoss, f.T, f.S, opts));
    assert.deepEqual([err?.code, err?.message], ['22023', 'migration 034 page: an argument is malformed'], label);
  }
  // The get: the whole snapshot, one row per line; not_found alike for a foreign and a missing id.
  const detail = await getInvoice(f.kBoss, f.T, f.S, ids[0]);
  assert.deepEqual(detail.map((r) => [r.o_outcome, r.o_number, r.o_position, r.o_description, r.o_quantity, r.o_unit_price_cents, r.o_line_total_cents]),
    LINES.map((l, i) => ['line', '1', i + 1, l.description, String(l.quantity), String(l.unitPriceCents), String(BigInt(l.quantity) * BigInt(l.unitPriceCents))]));
  for (const [label, invoice] of [['another store\'s invoice', iOther], ['another tenant\'s invoice', iForeign], ['a missing id', randomUUID()]]) {
    assert.deepEqual(outcomes(await getInvoice(f.kBoss, f.T, f.S, invoice)), ['not_found'], `the get of ${label}: not_found`);
  }
  // Read authority: Invoices >= View AND Customers >= View, a store grant at this store.
  const tech = await member(f, 'reads', 'technician');
  const sales = await member(f, 'reads', 'sales_staff');
  const readable = async (label, key, expected) => {
    assert.deepEqual(outcomes(await page(key, f.T, f.S, { limit: 1 })), [expected === 'denied' ? 'denied' : 'invoice'], `${label}: the page`);
    assert.deepEqual([...new Set(outcomes(await getInvoice(key, f.T, f.S, ids[0])))], [expected === 'denied' ? 'denied' : 'line'], `${label}: the get`);
  };
  await readable('a technician (View / View)', tech.key, 'allowed');
  assert.deepEqual(outcomes(await preview(tech.key, f.T, f.S, dOpen)), ['denied'], 'a View reader reads but cannot preview an issue');
  await readable('a sales_staff (Create / Create)', sales.key, 'allowed');
  await readable('the store owner', f.kBoss, 'allowed');
  await readable('the tenant owner (no store grant)', f.kOwn, 'denied');
  await readable('a store grant at another store', kBoss2, 'denied');
  await setLevel(f.T, 'technician', 'invoices', 'none');
  await readable('a technician below Invoices View', tech.key, 'denied');
  await setLevel(f.T, 'technician', 'invoices', 'view');
  await setLevel(f.T, 'technician', 'customers', 'none');
  await readable('a technician without Customers View', tech.key, 'denied');
  await setLevel(f.T, 'manager', 'customers', 'none');
  await readable('a manager (Invoices Full) without Customers View', f.kManager, 'denied');
  await clearLevels(f.T);
  await readable('the technician restored to its defaults', tech.key, 'allowed');
  assert.deepEqual(outcomes(await page(f.kBoss, T_OTHER, f.S)), ['denied'], 'another tenant expected: denied');
  // A read-only store: the reads serve, the preview (the issue's authority) does not.
  const ro = await scene('reads-read-only', { drafts: 2 });
  const iRo = randomUUID();
  assert.equal((await issue(ro.kBoss, { ...at(ro, ro.drafts[0]), invoice: iRo }))[0].o_outcome, 'applied');
  await owner`update store set status = 'read_only' where store_id = ${ro.S}`;
  const kRo = await mint(ro.boss);
  assert.deepEqual(outcomes(await page(kRo, ro.T, ro.S)), ['invoice'], 'a read-only store: the page serves');
  assert.deepEqual([...new Set(outcomes(await getInvoice(kRo, ro.T, ro.S, iRo)))], ['line'], 'and the get');
  assert.deepEqual(outcomes(await preview(kRo, ro.T, ro.S, ro.drafts[1])), ['denied'], 'the preview needs a write status');
  // The preview equals the issue's later snapshot, field for field.
  const p = await preview(f.kBoss, f.T, f.S, dPreview);
  const iPreview = randomUUID();
  assert.deepEqual(await issue(f.kBoss, { store: f.S, tenant: f.T, draft: p[0].o_draft_id, version: p[0].o_draft_version, sv: p[0].o_settings_version,
    cv: p[0].o_customer_version, invoice: iPreview }), [ISSUED(f.boss, f, { invoice: iPreview, number: 4 })], 'the preview\'s expected values issue');
  const snap = await getInvoice(f.kBoss, f.T, f.S, iPreview);
  const HEAD = ['customer_id', 'customer_name', 'customer_version', 'settings_version', 'legal_name', 'store_name', 'postal_address', 'tax_registration_id', 'tax_mode',
    'tax_rate', 'currency', 'line_count', 'subtotal_cents', 'tax_cents', 'total_cents', 'position', 'description', 'quantity', 'unit_price_cents', 'line_total_cents'];
  const pick = (rows) => rows.map((r) => Object.fromEntries(HEAD.map((k) => [k, r[`o_${k}`]])));
  assert.deepEqual(pick(snap), pick(p), 'every previewed field is the snapshot\'s');
  assert.deepEqual(snap.map((r) => r.o_source_draft_version), p.map((r) => r.o_draft_version), 'the snapshot records the previewed draft version');
  // The preview at version 2^53 - 1, and for drafts it must not serve.
  const dMax = await create(f.kBoss, f.S, f.T, f.C1);
  await forceVersion(dMax, MAX);
  assert.deepEqual(outcomes(await preview(f.kBoss, f.T, f.S, dMax)), ['invalid_state'], 'a draft at 2^53 - 1 cannot step: invalid_state');
  assert.deepEqual(await issue(f.kBoss, at(f, dMax, { version: MAX - 1n })), [ISSUE_NO('conflict')], 'the issue cannot name it either');
  for (const [label, store, draft] of [['another store\'s draft', f.S, dOther], ['another tenant\'s draft', f.S, g.draft], ['a missing draft', f.S, randomUUID()],
    ['a discarded draft', f.S, dDisc], ['an issued draft', f.S, d1]]) {
    assert.deepEqual(outcomes(await preview(f.kBoss, f.T, store, draft)), ['not_found'], `the preview of ${label}: not_found`);
  }
  // No read returns the issuing actor: no column of any read names it, and the stored actor is the issuer.
  for (const sig of [PAGE, GET, PREVIEW, SETTINGS_GET]) {
    const [{ result }] = await owner`select pg_catalog.pg_get_function_result(${sig}::regprocedure) as result`;
    assert.doesNotMatch(result, /issued_by|actor|membership/, `${sig} returns no actor`);
  }
  for (const row of [...all, ...detail, ...p]) assert.ok(!Object.keys(row).some((k) => /issued_by|actor/.test(k)), 'no actor key in any served row');
  assert.equal((await owner`select issued_by from tmpos_invoice_issue.issued_invoice where invoice_id = ${ids[0]}`)[0].issued_by, f.boss.id, 'the stored actor is the issuer, read by the owner only');
});
