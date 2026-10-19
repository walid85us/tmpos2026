// Phase 4.0 M7B-INVOICES-VOID-P1 — voiding an issued store invoice against REAL PostgreSQL: migration 035 (schema
// tmpos_invoice_void: the append-only void record and its ENABLE ALWAYS guards, the session-bound void routine, the
// lifecycle-aware v2 issued reads, the revoked 034 reads and the rollback-order anchor), exercised as the runtime's own
// non-owner login, every call bound as the production adapter binds it (every bigint as decimal text). Each title names the
// VOID ids of docs/phase-4/13 §8 and the contract's R-* tags (.workflow/m7b-void-p1/scratch/contract.md §8) it evidences.
//
// WHAT IS PROVEN.
//   IVR-01 (VOID-14 a h) 001-035 by the trusted executor (035 applied on its own over 034), the ledger exactly 001-035, 035's
//          checksum its up bytes; the postcondition re-run holds and refuses each widening it names, each with its exact message
//          (every clause of the postcondition; (e) is reachable only with (d)'s two clauses out of the way, and is shown to refuse
//          there); each newer widening's negative control pins the EXACT outcome of the postcondition without its clause (the next
//          refusal, code and full text, until acceptance); a second up refused.
//   IVR-02 (VOID-14 c e, R-DB-5) 034's down while 035 is applied over an empty issuing state fails 2BP01 changing nothing;
//          035's down outside READ COMMITTED refused; a clean 035 down restores 034's catalog exactly (ACLs, the audit comment,
//          internal triggers, dependencies) — equal to a FRESH 034 apply's, so a shared service's earlier down hides no
//          residue — and tmpos_app executes 034's reads again; 034's down then passes; 035 re-applies to the first apply's
//          catalog. 035 names no 016 function (R-GATE-1, 034's precedent): the anchor records exactly 034's page and get,
//          no 035 object depends on tmpos_session, and 016's down run raw beneath 017-035 is not refused by 035.
//   IVR-03 (VOID-14 f, R-DB-7) the up refuses every wrong predecessor state with its own fixed text, changing nothing; it
//          judges objects only (R-GATE-2): a short, dirty or unfinished ledger over 034's exact objects applies, while at
//          033 and a second apply are still refused over a 001-019 ledger; the up's privilege and forced-RLS preconditions
//          (016's hold and admission EXECUTE, ownership or inheritance of the tables, forced row security) each refuse. Controls:
//          forced row security applies without its check; the stand-in controls pin only the exact ORDER of refusals (not that a
//          removed check is behaviourally necessary: the stand-in cannot apply the up without CREATE, which the server refuses).
//   IVR-04 (VOID-14 b e) the up over issued invoices with lines keeps every row image (row, xmin, ctid); 034's down then
//          fails 55000 at its data guard, changing nothing.
//   IVR-05 (R-SEC-01, VOID-14) the exact surface: six functions and attributes, ACLs, the table's privileges and row
//          security, the schema grant; the login refused (42501) on the table, the helpers and 034's page and get.
//   IVR-06 (VOID-01, D-VOID-2) the authority matrix on stored levels: applied exactly at Invoices >= Approve AND Customers
//          >= View (store_owner Full), refused for Manage, Approve without Customers View, every other level, read-only and
//          non-write statuses, a tenant grant, a grant elsewhere and an unknown role; nothing written when refused; and no
//          creator shortcut: the actor who issued the invoice, lowered below either level, is refused like anyone else.
//   IVR-07 (VOID-02, contract §3) isolation — another store's, another tenant's and a missing invoice are one not_found
//          shape — and the routine's decision order (a session or grant refusal AND a level refusal both before
//          tenant_mismatch), nothing written by any refusal.
//   IVR-08 (VOID-04, R-BR-09, VOID-15 database part) the exact transaction delta (one void row, nothing else), the record's
//          values, the version cases, the six reason codes in the CHECK's (and the server enum's) order, every malformed
//          argument raised before anything; the next issue at the store unaffected.
//   IVR-09 (VOID-03 R-SEC-02) the sign-in bounds at the routine: live cases deterministic against an earlier database
//          clock reading, and the routine's own step-6 predicate evaluated at a fixed clock at each exact bound.
//   IVR-10 (VOID-03) revocation, levels, expiry and sign-in age WHILE the void waits: on key 530030 held EXCLUSIVE by a
//          level update, on the header held FOR UPDATE, at 016's hold — each wait first seen in pg_locks; nothing written;
//          and the other way round: a level narrowing started after the void's re-read waits for the void's COMMIT.
//   IVR-11 (VOID-06 VOID-04) two voids of one invoice from two sessions: exactly one applied, the other invalid_state (or,
//          the first rolled back, applied with voided_at after the wait); REPEATABLE READ and SERIALIZABLE refused.
//   IVR-12 (R-BR-11) negative control: IVR-11's race against a scratch copy of the routine without step 7 fails (the
//          primary key's raise, not the sealed invalid_state); the real routine passes the same check.
//   IVR-13 (R-BR-08) caller-set GUCs and session settings do not change the routine's decision or the reads' encoding.
//   IVR-14 (VOID-14 i) the guards as the table owner, normal and replica: UPDATE (a no-op included), DELETE and TRUNCATE of a
//          void record refused; a back-dated, foreign-scope or unknown insert refused; the voided header undeletable; and the
//          routine's own void of an invoice dated after the database clock (R-M4) refused, nothing written.
//   IVR-15 (VOID-10 database part) page_v2/get_v2 equal 034's page/get row for row, plus the lifecycle columns.
//   IVR-16 (VOID-14 d, R-M3) 035's down refuses over one void record, and over one store.invoice.void audit record alone,
//          changing nothing; neither present, it passes (rolled back); and R-DB-2: a void applied but uncommitted holds the
//          down at its first lock, and the void's commit then refuses it; the up and the down take every lock before a check.
//
// NOT PROVEN HERE: the HTTP command path (audit record, completion, replay, lease) is invoiceVoidHttp's; the exact sign-in
// bounds on a LIVE frozen clock need libfaketime under the server, which a supplied CI service cannot take — IVR-09 pins them
// on the routine's own predicate instead (and live on the deterministic side of each bound).
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys. Every fixture is synthetic and randomly suffixed. On a shared service it rolls 035 back at setup
// through its own committed down (which refuses over any void record or void audit record: R-DB-1) and re-applies it by the
// trusted executor. It leaves 001-035 applied and recorded, every guard trigger ALWAYS, the issuer key row it found, and NO
// void record, store.invoice.void audit record, settings, counter, issued invoice, draft, role row, session, mint-ledger row,
// scratch schema or login of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { TENANT_ORDERING, TENANT_ROLE_PERMISSION_DEFAULTS } from '../../server/platform-identity/permissionCatalog.ts';
import { principalKeyOf, RECENT_AUTH_MAX_AGE_MS } from '../../server/runtime/sessions.ts';
import { INVOICE_VOID_REASON_CODES } from '../../server/runtime/invoiceVoid.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const mig = (name) => readFileSync(`${MIG_DIR}/${name}`, 'utf8');
const DOWN_016 = mig('016_m5_tenant_session_ordering.down.sql');
const UP_034 = mig('034_m7b_invoice_issue.up.sql');
const DOWN_034 = mig('034_m7b_invoice_issue.down.sql');
const UP_035 = mig('035_m7b_invoice_void.up.sql');
const DOWN_035 = mig('035_m7b_invoice_void.down.sql');
const SHA_UP_035 = createHash('sha256').update(readFileSync(`${MIG_DIR}/035_m7b_invoice_void.up.sql`)).digest('hex');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_035 = UP_035.slice(UP_035.lastIndexOf('do $$'));
/** Section 9's comment on 034's audit column, and 034's own (034 up), read from the files. */
const commentIn = (file) => /comment on column public\.audit_event\.subject_issued_invoice_id is\s+'((?:[^']|'')*)';/.exec(file)[1].replace(/''/g, "'");
const AUDIT_COMMENT_035 = commentIn(UP_035);
const AUDIT_COMMENT_034 = commentIn(UP_034);
/**
 * `post` (a postcondition) with the refusals of the named clauses turned into no-ops: a clause is named by the start of its
 * message in the file's own quoting. IVR-01's negative controls and IVR-03's controls run a widening or a perturbation against such a copy, in memory.
 */
const without = (post, ...clauses) => clauses.reduce((p, clause) => {
  const refusal = new RegExp(`raise exception '[a-z0-9 ]+ refused: ${clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^;]*;`);
  assert.match(p, refusal, `a refusal starting ${clause}`);
  return p.replace(refusal, 'null;');
}, post);

const NS = 'tmpos_invoice_void';
/** The routine under test, by name: the single place it is named. */
const VOID_FN = `${NS}.m7b_invoice_void`;
const PAGE_V2_FN = `${NS}.m7b_issued_invoice_page_v2`;
const GET_V2_FN = `${NS}.m7b_issued_invoice_get_v2`;
const VOID = `${VOID_FN}(text, uuid, uuid, uuid, bigint, text)`;
const PAGE_V2 = `${PAGE_V2_FN}(text, uuid, uuid, uuid, uuid, integer)`;
const GET_V2 = `${GET_V2_FN}(text, uuid, uuid, uuid)`;
const ROUTINES = [VOID, PAGE_V2, GET_V2];
const ANCHOR = `${NS}.m7b_invoice_void_prerequisites()`;
const GUARD_FN = `${NS}.m7b_invoice_void_guard()`;
const TRUNCATE_FN = `${NS}.m7b_invoice_void_truncate_guard()`;
const UNGRANTED = [GUARD_FN, TRUNCATE_FN, ANCHOR];
const VOID_TABLE = `${NS}.issued_invoice_void`;
const PAGE_034_FN = 'tmpos_invoice_issue.m7b_issued_invoice_page';
const GET_034_FN = 'tmpos_invoice_issue.m7b_issued_invoice_get';
const PAGE_034 = `${PAGE_034_FN}(text, uuid, uuid, uuid, uuid, integer)`;
const GET_034 = `${GET_034_FN}(text, uuid, uuid, uuid)`;
const KEPT_034 = ['tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid)',
  'tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer)',
  'tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid)', 'tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid)'];
const ISSUE_FN = 'tmpos_invoice_issue.m7b_invoice_issue';
const SETTINGS_SET_FN = 'tmpos_invoice_issue.m7b_issuing_settings_set';
const CREATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_create_v3';
const UPDATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_update_v2';
const DISCARD_FN = 'tmpos_invoice_discard.m7b_invoice_draft_discard';
const GUARD_CLASS = 530_030;
const MIGRATOR = { purpose: 'migration', migratorRef: 'ivr-migrator', runtimeRef: 'ivr-runtime' };
const LOCK_KEY = 529_635;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ivr_probe';
/** The negative controls' scratch schema (IVR-06, IVR-10, IVR-12): a patched copy of the routine, never 035 itself. */
const NC = `ivr_nc_${SUFFIX}`;
/** IVR-03's stand-in applying principal (a role that is not a superuser), created and gone inside a rolled-back transaction. */
const APPLIER = `ivr_applier_${SUFFIX}`;
const HOUR = 3_600_000;
const ROLLBACK = new Error('ivr: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
/** sessions.ts MAX_CLOCK_SKEW_MS (not exported): a sign-in at most this far ahead of the clock is not taken as tampered. */
const MAX_CLOCK_SKEW_MS = 5_000;
/** The SQLSTATE PostgreSQL's ri_triggers raise for a RESTRICT foreign key's refusal: foreign_key_violation. */
const FK_RESTRICT = '23503';
const EDITABLE = ['manager', 'technician', 'sales_staff'];
const LEVELS = [...TENANT_ORDERING];
const VOID_GUARDS = [[VOID_TABLE, 'trg_issued_invoice_void_guard']];
const ISSUE_GUARDS = [['tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_guard'], ['tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_guard'],
  ['tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_guard'], ['tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_guard']];
const AUDIT_TRIGGER = [['public.audit_event', 'trg_audit_event_reject_mutation']];
const DRAFT_TERMINAL = [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']];

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

const TARGET = resolveDisposableTarget('IVR');
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
let issuerKeyBefore;
let roleCheckDef = null;

/** The trusted executor over the migration files (THROUGH `through` when named; every file when not). */
async function trustedApply(through) {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const port = createNodeFsPort(MIG_DIR, MIG_REL);
    return await runTrustedApply({
      fsPort: through === undefined ? port : portThrough(port, through), adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 300_000,
    });
  } finally {
    await handle.dispose();
  }
}
const ledgerHas = async (v) => (await owner`select exists (select 1 from public.schema_migrations where version = ${v}) as e`)[0].e;
const applied035 = async () => (await owner`select pg_catalog.to_regnamespace('tmpos_invoice_void') is not null as e`)[0].e;
/** 035's down committed with its ledger row (migrationsThrough.mjs rollBackAbove's shape). Refuses over any void evidence. */
const down035 = () => owner.begin(RC, async (tx) => {
  await tx.unsafe(DOWN_035).simple();
  await tx`delete from public.schema_migrations where version = '035'`;
});

const TRIGGER_MODE = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' };
/** Runs `fn()` inside `tx` with the named triggers lifted, each put back in exactly the mode it was found in before `tx` ends. */
async function withTriggersLifted(tx, triggers, fn) {
  const modes = [];
  for (const [rel, name] of triggers) {
    if ((await tx`select pg_catalog.to_regclass(${rel}) is not null as e`)[0].e === false) continue;
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
/** Everything this suite wrote: void records first (their key RESTRICTs the header), then issuing rows, drafts and role rows. */
async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    if ((await sql`select pg_catalog.to_regclass(${VOID_TABLE}) is not null as e`)[0].e) {
      await withTriggersLifted(sql, VOID_GUARDS, () => sql`delete from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${TENANTS}::uuid[])`);
    }
    await withTriggersLifted(sql, ISSUE_GUARDS, async () => {
      await sql`delete from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${TENANTS}::uuid[])`;
    });
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    if (drafts.length > 0) {
      await withTriggersLifted(sql, AUDIT_TRIGGER, () => sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`);
      await withTriggersLifted(sql, DRAFT_TERMINAL, async () => {
        await sql`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = any(${drafts}::uuid[])`;
        await sql`delete from tmpos_invoice_draft.invoice_draft where draft_id = any(${drafts}::uuid[])`;
      });
    }
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}
/** Every issuing row and void evidence in the whole database (034's and 035's rollbacks need none). */
async function globalIssuing() {
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_issue.store_issuing_settings)::int as settings,
    (select count(*) from tmpos_invoice_issue.store_invoice_counter)::int as counters,
    (select count(*) from tmpos_invoice_issue.issued_invoice)::int as invoices,
    (select count(*) from tmpos_invoice_draft.invoice_draft where status = 'issued')::int as issued,
    (select count(*) from public.audit_event where subject_issued_invoice_id is not null or subject_store_id is not null)::int as subjects,
    (select count(*) from public.audit_event where action_id = 'store.invoice.void')::int as void_audits`;
  return { ...r };
}
const NO_ISSUING = Object.freeze({ settings: 0, counters: 0, invoices: 0, issued: 0, subjects: 0, void_audits: 0 });
const globalVoids = async () => ((await applied035())
  ? Number((await owner`select count(*)::int as n from tmpos_invoice_void.issued_invoice_void`)[0].n) : 0);

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    await step(() => owner.unsafe(`drop schema if exists ${NC} cascade`));
    // A failed migration case may have left 035 rolled back: the executor applies it again.
    await step(async () => {
      if (!(await ledgerHas('035'))) {
        const report = await trustedApply();
        assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
      }
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
    // R-DB-1: CI runs every database suite on ONE service, and 035's down refuses over any void evidence — none is left.
    await step(async () => {
      const [state] = await owner`select
          (select pg_catalog.string_agg(version, ',' order by version) from public.schema_migrations) as ledger,
          pg_catalog.to_regprocedure(${VOID}) is not null as routine_035,
          (select pg_catalog.string_agg(t.v, ',' order by t.v collate "C") from (select g.tgrelid::regclass::text || '.' || g.tgname::text || ':' || g.tgenabled::text as v
             from pg_catalog.pg_trigger g where not g.tgisinternal and g.tgrelid = any (array['tmpos_invoice_void.issued_invoice_void'::regclass,
               'tmpos_invoice_issue.issued_invoice'::regclass, 'tmpos_invoice_issue.issued_invoice_line'::regclass,
               'tmpos_invoice_issue.store_invoice_counter'::regclass, 'tmpos_invoice_issue.store_issuing_settings'::regclass]::oid[])) t) as triggers,
          (select count(*) from tmpos_invoice_void.issued_invoice_void)::int as voids_anywhere,
          (select count(*) from public.audit_event where action_id = 'store.invoice.void')::int as void_audits_anywhere,
          (select count(*) from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[]))::int as invoices,
          (select count(*) from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${TENANTS}::uuid[]))::int as settings,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where tenant_id = any(${TENANTS}::uuid[]))::int as audits,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as roles,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.user_membership'::regclass and conname = 'user_membership_role_scope_chk') as role_check,
          pg_catalog.to_regnamespace(${NC}) is null as no_scratch,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, {
        ledger: Array.from({ length: 35 }, (_, i) => String(i + 1).padStart(3, '0')).join(','), routine_035: true,
        triggers: ['tmpos_invoice_void.issued_invoice_void.trg_issued_invoice_void_guard:A', 'tmpos_invoice_void.issued_invoice_void.trg_issued_invoice_void_truncate:A',
          'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_commit_check:A', 'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_guard:A',
          'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_truncate:A', 'tmpos_invoice_issue.issued_invoice_line.trg_issued_invoice_line_guard:A',
          'tmpos_invoice_issue.issued_invoice_line.trg_issued_invoice_line_truncate:A', 'tmpos_invoice_issue.store_invoice_counter.trg_store_invoice_counter_guard:A',
          'tmpos_invoice_issue.store_invoice_counter.trg_store_invoice_counter_truncate:A', 'tmpos_invoice_issue.store_issuing_settings.trg_store_issuing_settings_guard:A',
          'tmpos_invoice_issue.store_issuing_settings.trg_store_issuing_settings_truncate:A'].sort().join(','),
        voids_anywhere: 0, void_audits_anywhere: 0, invoices: 0, settings: 0, drafts: 0, audits: 0, roles: 0, sessions: 0,
        role_check: true, no_scratch: true, login: false,
      }, 'left as found: 001-035 applied and recorded, every guard ALWAYS, no void evidence anywhere, nothing of this suite\'s retained');
    });
    await step(() => above035.restore());
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IVR teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: 034 (a shared service's 035 rolled back through its own down), the catalog at 034, then 035 by the trusted executor
// ---------------------------------------------------------------------------

/**
 * A top-level setup step. A top-level throw ends a node:test file without its 'exit' handlers (exit code 7), so the
 * harness's stop hook never runs and the cluster would outlive the file: a failed step stops it here, then rethrows.
 */
async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await (runtime ?? owner).end({ timeout: 5 }).catch(() => {});
    await owner.end({ timeout: 5 }).catch(() => {});
    if (cluster) cluster.stop();
    throw err;
  }
}

let above035;
let ME;
await setupStep(async () => {
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
  await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
  // Anything above 035 (none today) is rolled back and restored by the teardown; a shared service's 035 is rolled back here
  // and applied again below (its down refuses, failing the suite loudly, if an earlier step left a void record or void audit
  // record).
  above035 = await rollBackAbove(owner, MIG_DIR, '035');
  if (await applied035()) await down035();
  const apply034 = await trustedApply('034');
  assert.equal(apply034.outcome, 'complete', JSON.stringify(apply034).slice(0, 300));
  await owner.unsafe(`do $$ begin
    if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
  end $$;`);
  await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  runtime = connect(RUNTIME_LOGIN, 4);
  issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
  if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
  await installTestIssuerKey(owner, ISSUER_KEY);
  ME = (await owner`select current_user::text as me`)[0].me;
});

/** The catalog of every object 034 and 035 touch, oid-free (IIR's catalogOf plus 035's schema and every dependency on 034). */
async function catalogOf() {
  const [r] = await owner`with rels as (
      select c.oid from pg_catalog.pg_class c
       where c.oid = any (array['tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass, 'public.store'::regclass,
                               'tmpos_customer.customer'::regclass, 'public.audit_event'::regclass, 'public.tenant'::regclass]::oid[])
          or c.relnamespace = pg_catalog.to_regnamespace('tmpos_invoice_issue') or c.relnamespace = pg_catalog.to_regnamespace('tmpos_invoice_void'))
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
                         where d.adrelid = a.attrelid and d.adnum = a.attnum), '-') || ':' || a.attcollation::regcollation::text
                    || ':' || coalesce(a.attacl::text, '-') || ':' || coalesce(pg_catalog.md5(pg_catalog.col_description(a.attrelid, a.attnum)), '-')
                  order by a.attrelid::regclass::text collate "C", a.attnum) from pg_catalog.pg_attribute a
                 where a.attrelid in (select oid from rels) and a.attnum > 0 and not a.attisdropped),
    'indexes', (select pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(x.indexrelid) order by pg_catalog.pg_get_indexdef(x.indexrelid) collate "C")
                  from pg_catalog.pg_index x where x.indrelid in (select oid from rels)),
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
    -- A toast table's name carries its table's oid (pg_toast_<oid>): masked, so a fresh 034 apply compares equal.
    'depends_on_034', (select pg_catalog.jsonb_agg(x.v order by x.v collate "C") from (
                         select pg_catalog.regexp_replace((pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)).identity, '^pg_toast\\.pg_toast_[0-9]+$', 'pg_toast.pg_toast_<oid>') || ' -> '
                                || (pg_catalog.pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).identity || ':' || d.deptype::text as v
                           from pg_catalog.pg_depend d
                          where ((d.refclassid = 'pg_catalog.pg_proc'::regclass and d.refobjid in (select p.oid from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_issue'::regnamespace))
                                 or (d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid in (select c.oid from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_issue'::regnamespace)))
                            and (pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)).schema is distinct from 'tmpos_invoice_issue') x),
    'ledger', (select pg_catalog.string_agg(version || ':' || checksum || ':' || dirty::text, ',' order by version) from public.schema_migrations)
  ) as snap`;
  return r.snap;
}
const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

const [S034, ISSUING_AT_034, applyReport, S035] = await setupStep(async () => {
  const at034 = await catalogOf();
  const issuing = await globalIssuing();
  const report = await trustedApply();
  return [at034, issuing, report, await catalogOf()];
});

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ivr-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IVR ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `ivr-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${accountStatus})`;
  const ms = [];
  for (const m of memberships) {
    const [{ membership_id: mid }] = await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, ${m.store ?? null}, ${m.scope}, ${m.role}, ${m.status ?? 'active'}) returning membership_id`;
    ms.push(mid);
  }
  UIDS.push(uid);
  return { id, uid, label, memberships: ms, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
/** The tenant owner's stored level for `role` on `domain` (020's table; its triggers take key 530030 EXCLUSIVE). */
const setLevel = (tenant, role, domain, level, db = owner) => db`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;
const clearLevels = (tenant) => owner`delete from tmpos_role.tenant_role_level where tenant_id = ${tenant}`;

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:ivr', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
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
/** The database clock in epoch ms (floored), the one the routine judges by. */
const dbNowMs = async () => Number((await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint::text as t`)[0].t);
/** Sets a session row's sign-in time as the owner (a forged row, R-BR-08): epoch ms, or NULL. */
const setAuth = (key, at) => owner`update tmpos_session.session set authenticated_at = ${at === null ? null : String(at)}::bigint where session_key = ${key}`;

const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const sumOf = (lines) => lines.reduce((s, l) => s + BigInt(l.quantity) * BigInt(l.unitPriceCents), 0n);
const LINES = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 2, 4_500), line('Tempered glass', 3, 0)];
const SETTINGS = Object.freeze({ legalName: 'IVR Legal Name LLC', storeName: 'IVR Store', postalAddress: '1 Main St\nSuite 2\nSpringfield',
  taxRegistrationId: 'TAX-IVR-1', taxMode: 'exclusive_rate', taxRate: 8875 });
async function settingsSet(key, store, tenant) {
  const [row] = await runtime.unsafe(`select o_outcome from ${SETTINGS_SET_FN}($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
    [key, store, tenant, '0', SETTINGS.legalName, SETTINGS.storeName, SETTINGS.postalAddress, SETTINGS.taxRegistrationId, SETTINGS.taxMode, SETTINGS.taxRate]);
  assert.equal(row.o_outcome, 'applied', 'the store\'s issuing settings, version 1');
}
/** 032's save then 034's issue, as their mutators bind them: the issued invoice and its source draft. */
async function issueOne(key, store, tenant, customer, lines = LINES) {
  const draft = randomUUID();
  const [c] = await runtime.unsafe(`select o_outcome from ${CREATE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [key, store, draft, tenant, customer, JSON.stringify(lines), String(sumOf(lines))]);
  assert.equal(c.o_outcome, 'applied', 'the draft saved');
  const invoice = randomUUID();
  const [i] = await runtime.unsafe(`select o_outcome from ${ISSUE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [key, store, draft, tenant, '1', '1', '1', invoice]);
  assert.equal(i.o_outcome, 'applied', 'the draft issued');
  return { invoice, draft };
}
/**
 * A fresh tenant with two stores and a customer; a store owner per store, a manager at the first store and a tenant owner
 * (a tenant grant, for the settings), each with a live session; both stores' settings written; `invoices` issued at the
 * first store by its owner. `f.issue(store)` issues one more.
 */
async function scene(label, { invoices = 0 } = {}) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label}-a ${SUFFIX}`);
  const S2 = await newStore(T, `${label}-b ${SUFFIX}`);
  const C = await newCustomer(T, label);
  const boss = await actor(`${label}-owner`, [storeGrant(T, S, 'store_owner')]);
  const boss2 = await actor(`${label}-owner2`, [storeGrant(T, S2, 'store_owner')]);
  const manager = await actor(`${label}-manager`, [storeGrant(T, S, 'manager')]);
  const own = await actor(`${label}-tenant-owner`, [tenantGrant(T, 'store_owner')]);
  const f = { label, T, S, S2, C, boss, boss2, manager, own, kBoss: await mint(boss), kBoss2: await mint(boss2), kManager: await mint(manager), kOwn: await mint(own) };
  await settingsSet(f.kOwn, S, T);
  await settingsSet(f.kOwn, S2, T);
  f.issued = [];
  f.issue = async (store = S) => {
    const one = await issueOne(store === S ? f.kBoss : f.kBoss2, store, T, C);
    f.issued.push(one);
    return one.invoice;
  };
  for (let i = 0; i < invoices; i += 1) await f.issue();
  f.inv = f.issued.map((x) => x.invoice);
  return f;
}
/** Another actor of `role` at the scene's first store, with a live session of its own. */
async function member(f, label, role, accountStatus = 'active') {
  const who = await actor(`${f.label}-${label}-${role}`, [storeGrant(f.T, f.S, role)], accountStatus);
  return { who, key: await mint(who) };
}

// ---------------------------------------------------------------------------
// the runtime login's calls, bound as the production adapters bind them
// ---------------------------------------------------------------------------

const VOID_COLS = 'o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id';
/** The void (VOID_FN, or `fn`), as INVOICE_VOID_MUTATOR binds it: the version as decimal text. */
async function voidCall(key, { store, invoice, tenant, version = 1, reason = 'issued_in_error', db = runtime, fn = VOID_FN }) {
  return (await db.unsafe(`select ${VOID_COLS} from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`,
    [key, store, invoice, tenant, version === null ? null : String(version), reason])).map((r) => ({ ...r }));
}
const NO = (word) => [{ o_outcome: word, o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: null, o_invoice_id: null }];
const APPLIED = (who, tenant, store, invoice) => [{ o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id,
  o_membership_id: who.memberships[0], o_version: '2', o_invoice_id: invoice }];
/**
 * A scratch copy of the void routine in schema NC (`db` is the owner or a transaction of it), changed by `patch` on its
 * definition; answers its name. The negative controls' subject — never 035's own routine, which stays as it is.
 */
async function scratchVoid(db, patch) {
  const [{ def }] = await db`select pg_catalog.pg_get_functiondef(${VOID}::regprocedure) as def`;
  const HEAD = 'CREATE OR REPLACE FUNCTION tmpos_invoice_void.m7b_invoice_void(';
  assert.ok(def.startsWith(HEAD), def.slice(0, 80));
  await db.unsafe(`create schema ${NC}`);
  await db.unsafe(patch(def).replace(HEAD, `CREATE FUNCTION ${NC}.m7b_invoice_void(`));
  return `${NC}.m7b_invoice_void`;
}
/** `def` with `from` (a string, or a global regex whose `to` may use $1) replaced by `to`; `from` must occur exactly `count` times, so a patch that misses fails loudly. */
const patchOnce = (def, from, to, count = 1) => {
  assert.equal(typeof from === 'string' ? def.split(from).length - 1 : [...def.matchAll(from)].length, count, `the patch target occurs ${count} time(s): ${String(from).slice(0, 70)}`);
  return typeof from === 'string' ? def.replaceAll(from, () => to) : def.replaceAll(from, to);
};
/** A creator shortcut at both level checks (steps 2 and 5): the actor who issued the invoice is never refused for its levels. */
const issuerShortcut = (def) => patchOnce(def, /if (coalesce\(pg_catalog\.array_position\(c_levels,[\s\S]*?< pg_catalog\.array_position\(c_levels, 'view'\)) then/g,
  `if not exists (select 1 from tmpos_invoice_issue.issued_invoice h where h.invoice_id = p_invoice_id and h.issued_by = v_admission.actor_id)
       and ($1) then`, 2);
/** The shared key given up right after the re-read, before COMMIT: a session-level lock, then its unlock. */
const keyReleasedEarly = (def) => patchOnce(def, /perform pg_catalog\.pg_advisory_xact_lock_shared\((530030, [^;]*)\);([\s\S]*?domain = 'customers';\n)/g,
  'perform pg_catalog.pg_advisory_lock_shared($1);$2    perform pg_catalog.pg_advisory_unlock_shared($1);\n');
const page = async (fn, key, tenant, store, { after = null, source = null, limit = 51, db = runtime } = {}) =>
  (await db.unsafe(`select * from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`, [key, tenant, store, after, source, limit])).map((r) => ({ ...r }));
const getInvoice = async (fn, key, tenant, store, invoice, { db = runtime } = {}) =>
  (await db.unsafe(`select * from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid)`, [key, tenant, store, invoice])).map((r) => ({ ...r }));
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
const voidRowOf = async (invoice) => (await owner`select v.tenant_id, v.store_id, v.reason_code, v.voided_by,
    to_char(v.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, v.voided_at >= i.issued_at as after_issue
  from tmpos_invoice_void.issued_invoice_void v join tmpos_invoice_issue.issued_invoice i on i.invoice_id = v.invoice_id
  where v.invoice_id = ${invoice}`).map((r) => ({ ...r }));
const dbNowText = async () => (await owner`select to_char(pg_catalog.clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)[0].t;

/** Every row a void could touch, exactly (row, xmin, ctid; a write moves xmin and ctid), and every global append-only count. */
async function stateOf(tenants) {
  const q = async (rel, where = 'r.tenant_id = any($1::uuid[])', arg = tenants) => ((await owner`select pg_catalog.to_regclass(${rel}) is not null as e`)[0].e
    ? (await owner.unsafe(`select pg_catalog.to_jsonb(r)::text as row, r.xmin::text as xmin, r.ctid::text as ctid from ${rel} r where ${where} order by 1`, [arg]))
      .map((x) => `${x.row} ${x.xmin} ${x.ctid}`)
    : []);
  const [c] = await owner`select (select count(*) from public.audit_event)::int as audits_anywhere,
    (select count(*) from tmpos_internal.outbox_event)::int as events_anywhere,
    (select count(*) from tmpos_internal.idempotency_record)::int as records_anywhere`;
  return {
    drafts: await q('tmpos_invoice_draft.invoice_draft'), lines: await q('tmpos_invoice_draft.invoice_draft_line'),
    customers: await q('tmpos_customer.customer'), stores: await q('public.store'), roles: await q('tmpos_role.tenant_role_level'),
    settings: await q('tmpos_invoice_issue.store_issuing_settings'), counters: await q('tmpos_invoice_issue.store_invoice_counter'),
    invoices: await q('tmpos_invoice_issue.issued_invoice'), invoiceLines: await q('tmpos_invoice_issue.issued_invoice_line'),
    audits: await q('public.audit_event'), voids: await q(VOID_TABLE),
    sessions: await q('tmpos_session.session', 'r.auth_provider_uid = any($1::text[])', UIDS),
    ...c,
  };
}
/** Runs `fn` in an owner transaction that is always rolled back: { value } or the { code, message } it raised. */
async function rolledBack(fn, isolation = RC) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}
/** Inside `tx`: `fn(sp)` in a savepoint that is always rolled back — 'accepted', or the { code, message } it raised. */
async function attempt(tx, fn) {
  const SP = new Error('ivr: roll the savepoint back');
  try {
    await tx.savepoint(async (sp) => { await fn(sp); throw SP; });
  } catch (err) {
    if (err === SP) return 'accepted';
    return { code: err.code, message: String(err.message) };
  }
  return 'unreachable';
}
const asTmposApp = (sql, params) => rolledBack(async (tx) => { await tx`set local role tmpos_app`; return (await tx.unsafe(sql, params)).map((r) => ({ ...r })); });

// ---------------------------------------------------------------------------
// race levers: polling on observable lock state, never on time (IIR's)
// ---------------------------------------------------------------------------

/** Thrown by a retryable lever when its attempt could not engage (not a failure of the thing proven): the caller may try again. */
class NotEngaged extends Error {}
async function until(probe, what, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`lever did not engage: ${what}`);
}
/** A transaction that runs `fn` and holds everything it took, uncommitted, until `release('commit' | 'rollback')`. */
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
/** A statement in its own transaction (committed when it answers), its backend pid exposed as soon as it is known. */
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
const waitsFor = async (pid) => (await owner`select l.locktype::text as locktype, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted order by 1, 2`).map((r) => [r.locktype, r.mode]);
const advisoryWait = async (pid) => (await owner`select l.classid::int as class, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted and l.locktype = 'advisory'`).map((r) => ({ ...r }));
const rowWaitOn = async (pid) => (await owner`select l.relation::regclass::text as rel from pg_catalog.pg_locks l
  where l.pid = ${pid} and l.locktype = 'tuple' and l.granted`).map((r) => r.rel);
const rowHeld = async (rel, column, id) => (await errorOf(owner.begin(RC, (tx) => tx.unsafe(`select 1 from ${rel} where ${column} = $1 for update nowait`, [id]))))?.code === '55P03';
function finished(out, label, how = 'committed') {
  assert.notEqual(out.code, '40P01', `${label}: a deadlock (${JSON.stringify(out)})`);
  assert.equal(out.outcome, how, `${label}: ${JSON.stringify(out)}`);
  return out;
}
async function settle(...levers) {
  for (const l of levers) {
    if (l === null || l === undefined) continue;
    if (typeof l.release === 'function') l.release('rollback');
    await l.done;
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const grantsOf = async (signature) => (await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.grantor::regrole::text as grantor, g.is_grantable as grantable
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${signature}::regprocedure`)
  .map((x) => ({ ...x })).sort((a, b) => (`${a.grantee}/${a.priv}` < `${b.grantee}/${b.priv}` ? -1 : 1));
const EXECUTE_BY = (...grantees) => grantees.map((grantee) => ({ grantee, priv: 'EXECUTE', grantor: ME, grantable: false }))
  .sort((a, b) => (a.grantee < b.grantee ? -1 : 1));

// The tenant every 'tenant_mismatch' names, and the catalog defaults the cases rely on.
const T_OTHER = await setupStep(async () => {
  assert.deepEqual(Object.fromEntries(EDITABLE.map((r) => [r, [TENANT_ROLE_PERMISSION_DEFAULTS[r].invoices, TENANT_ROLE_PERMISSION_DEFAULTS[r].customers]])),
    { manager: ['full', 'full'], technician: ['view', 'view'], sales_staff: ['create', 'create'] }, 'the catalog\'s Invoices and Customers defaults the cases rely on');
  assert.deepEqual(LEVELS, ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'], 'the catalog\'s ordering');
  return newTenant('other');
});

// ===========================================================================
// IVR-01..05: the migration, its rollback and its surface
// ===========================================================================

test('IVR-01 (VOID-14 a h): 001-035 applied by the trusted executor — 035 alone over 034, the ledger exactly 001-035, each clean and finished, 035\'s checksum its up bytes; the postcondition re-run holds and refuses every widening it names; the up a second time refused with its fixed text, changing nothing; every widening is pinned to its exact message, and the newer ones carry a negative control that pins the exact outcome of the postcondition without their clause (the next refusal, then acceptance once every shadowing clause is out too)', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  assert.deepEqual(applyReport.applied, ['035'], 'the executor applied 035 alone, over 001-034');
  const ledger = (await owner`select version, checksum, dirty, finished_at is not null as finished from public.schema_migrations order by version`).map((r) => ({ ...r }));
  assert.deepEqual(ledger.map((x) => x.version), Array.from({ length: 35 }, (_, i) => String(i + 1).padStart(3, '0')));
  assert.ok(ledger.every((x) => x.dirty === false && x.finished), 'every row clean and finished');
  assert.equal(ledger[34].checksum, SHA_UP_035, '035\'s checksum is its up bytes');
  assert.deepEqual(diffKeys(S035, await catalogOf()), [], 'the catalog as the apply left it');
  assert.ok('value' in await rolledBack((tx) => tx.unsafe(POSTCONDITION_035).simple()), 'the postcondition holds');
  const T = VOID_TABLE;
  // Each widening's exact refusal, by the postcondition clause (a)-(j) of 035's up that targets it (034's IIR-01 form). The
  // trailing [clause, next] steps are its negative control, run against the postcondition WITHOUT the clauses named so far (each
  // step removes one more): `next` is the EXACT refusal of whatever clause shadowed it (code 55000 and the full text), or null
  // when the postcondition then ACCEPTS the widening. The last step of every control is null.
  const R = (m) => `migration 035 refused: ${m}`;
  const CONTENTS = R(`schema ${NS} does not hold exactly this file's functions and relations, or it or the table is not owned by the applying principal or carries no comment`);
  const SCHEMA_GRANT = (v) => R(`schema ${NS} carries an unexpected grant or lacks an expected one (${v}), or tmpos_app cannot use it`);
  const FN_SHAPE = (v) => R(`a function of schema ${NS} is not the one its section declares (language, security, volatility, settings, owner, comment, arguments or result: ${v})`);
  const FN_GRANT = (v) => R(`an unexpected grant remains on a function of schema ${NS} or on 034's routines, or an entry is missing (${v})`);
  const EXEC_PATH = (v) => R(`a runtime role can execute a function this file does not grant it (034's page or get included), or tmpos_app cannot execute a routine (${v})`);
  const TABLE_PRIV = (v) => R(`${v} holds a privilege on the void table, or its row security is not enabled without policy and unforced`);
  const TABLE_ACL = (v) => R(`the void table carries a grant beyond its owner's, its owner's own privileges are not the default ones, or a column carries a grant (${v})`);
  const MEMBER = (v) => R(`${v} is a member of the owner of schema ${NS} or of an object in it`);
  const TRIGGERS = (v) => R(`a trigger of the void table, or of 034's issued header, is not exactly the one declared (${v})`);
  const TABLE_SHAPE = R(`the void table's columns, primary key or reason CHECK are not exactly section 5's`);
  const FK_SHAPE = R(`the void table's foreign key is not exactly section 5's (onto 034's scope key, ON DELETE RESTRICT ON UPDATE RESTRICT, validated)`);
  const ANCHOR_DEPS = R(`the rollback-order anchor does not record exactly one dependency on each function it names, or a v2 read does not record its dependency on 034's read or the void table`);
  const AUDIT_COMMENT = R(`public.audit_event.subject_issued_invoice_id does not carry section 9's comment`);
  const TRIGGER_LIST = (guard, truncate) => `trg_issued_invoice_void_guard:${GUARD_FN}:31:${guard}, trg_issued_invoice_void_truncate:${TRUNCATE_FN}:34:${truncate}`;
  // The start of each clause's refusal, in the source's own quoting (an apostrophe doubled), as `without` reads it.
  const CLAUSE = {
    contents: `schema ${NS} does not hold exactly`, fnShape: `a function of schema ${NS} is not the one`, execPath: 'a runtime role can execute a function',
    tablePriv: '% holds a privilege on the void table', member: '% is a member of the owner', tableShape: "the void table''s columns, primary key", fkShape: "the void table''s foreign key",
    anchorDeps: 'the rollback-order anchor does not record',
  };
  const REASON_CHECK = 'issued_invoice_void_reason_code_chk';
  const FK = 'issued_invoice_void_invoice_fkey';
  const FK_ON = 'foreign key (invoice_id, tenant_id, store_id) references tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id)';
  const widenings = {
    ownerSelectRevoked: [`revoke select on ${T} from current_user`, TABLE_ACL('an owner entry or a column grant')],
    tableGrantToApp: [`grant select on ${T} to tmpos_app`, TABLE_PRIV('tmpos_app')],
    columnGrant: [`grant select (reason_code) on ${T} to tmpos_audit_writer`, TABLE_PRIV('tmpos_audit_writer')],
    rlsForced: [`alter table ${T} force row level security`, TABLE_PRIV('no role')],
    rlsOff: [`alter table ${T} disable row level security`, TABLE_PRIV('no role')],
    policy: [`create policy ivr_p on ${T} for select to tmpos_app using (true)`, TABLE_PRIV('no role')],
    pageRegranted: [`grant execute on function ${PAGE_034} to tmpos_app`, FN_GRANT('m7b_issued_invoice_page tmpos_app:EXECUTE')],
    getRegranted: [`grant execute on function ${GET_034} to tmpos_app`, FN_GRANT('m7b_issued_invoice_get tmpos_app:EXECUTE')],
    voidToPublic: [`grant execute on function ${VOID} to public`, FN_GRANT('m7b_invoice_void -:EXECUTE')],
    voidToAudit: [`grant execute on function ${VOID} to tmpos_audit_writer`, FN_GRANT('m7b_invoice_void tmpos_audit_writer:EXECUTE')],
    guardToApp: [`grant execute on function ${GUARD_FN} to tmpos_app`, FN_GRANT('m7b_invoice_void_guard tmpos_app:EXECUTE')],
    anchorToApp: [`grant execute on function ${ANCHOR} to tmpos_app`, FN_GRANT('m7b_invoice_void_prerequisites tmpos_app:EXECUTE')],
    getV2Revoked: [`revoke execute on function ${GET_V2} from tmpos_app`, FN_GRANT('none listed')],
    schemaToAudit: [`grant usage on schema ${NS} to tmpos_audit_writer`, SCHEMA_GRANT('tmpos_audit_writer:USAGE')],
    guardOrigin: [`alter table ${T} enable trigger trg_issued_invoice_void_guard`, TRIGGERS(TRIGGER_LIST('O', 'A'))],
    truncateDisabled: [`alter table ${T} disable trigger trg_issued_invoice_void_truncate`, TRIGGERS(TRIGGER_LIST('A', 'D'))],
    auditComment: [`comment on column public.audit_event.subject_issued_invoice_id is 'x'`, AUDIT_COMMENT],
    // (a) another function, relation or type in the schema, or its comment gone
    extraFunction: [`create function ${NS}.extra() returns integer language sql as 'select 1'`, CONTENTS, [CLAUSE.contents, FN_SHAPE('extra')], [CLAUSE.fnShape, null]],
    extraTable: [`create table ${NS}.extra (x integer)`, CONTENTS, [CLAUSE.contents, null]],
    extraType: [`create type ${NS}.extra_t as enum ('a')`, CONTENTS, [CLAUSE.contents, null]],
    schemaCommentDropped: [`comment on schema ${NS} is null`, CONTENTS, [CLAUSE.contents, null]],
    // (b) the void routine's security and volatility
    voidInvoker: [`alter function ${VOID} security invoker`, FN_SHAPE('m7b_invoice_void'), [CLAUSE.fnShape, null]],
    voidStable: [`alter function ${VOID} stable`, FN_SHAPE('m7b_invoice_void'), [CLAUSE.fnShape, null]],
    // (d) EXECUTE by membership alone, no ACL entry changed: the audit writer a member of tmpos_app
    executeByMembership: [`grant tmpos_app to tmpos_audit_writer`,
      EXEC_PATH('tmpos_audit_writer m7b_invoice_void, tmpos_audit_writer m7b_issued_invoice_get_v2, tmpos_audit_writer m7b_issued_invoice_page_v2'), [CLAUSE.execPath, null]],
    // (e) tmpos_app a member of the owner — shadowed by (d)'s two clauses, which refuse first: as a member it inherits EXECUTE on every function of the owner and every privilege on the table
    // (the control walks them: without (d)'s EXECUTE clause the privilege clause refuses next, without both (e) itself, and with (e) out too it is accepted)
    appMemberOfOwner: [`grant "${ME}" to tmpos_app`,
      EXEC_PATH('tmpos_app m7b_invoice_void_guard, tmpos_app m7b_invoice_void_prerequisites, tmpos_app m7b_invoice_void_truncate_guard, tmpos_app m7b_issued_invoice_get, tmpos_app m7b_issued_invoice_page'),
      [CLAUSE.execPath, TABLE_PRIV('tmpos_app')], [CLAUSE.tablePriv, MEMBER('tmpos_app')], [CLAUSE.member, null]],
    // (g) the reason CHECK dropped or widened, a column altered
    reasonCheckDropped: [`alter table ${T} drop constraint ${REASON_CHECK}`, TABLE_SHAPE, [CLAUSE.tableShape, null]],
    reasonCheckWidened: [`alter table ${T} drop constraint ${REASON_CHECK}, add constraint ${REASON_CHECK} check (reason_code in (${[...INVOICE_VOID_REASON_CODES, 'refund'].map((c) => `'${c}'`).join(', ')}))`, TABLE_SHAPE, [CLAUSE.tableShape, null]],
    voidedByNullable: [`alter table ${T} alter column voided_by drop not null`, TABLE_SHAPE, [CLAUSE.tableShape, null]],
    // (h) the key replaced: cascading, or not validated
    fkCascade: [`alter table ${T} drop constraint ${FK}, add constraint ${FK} ${FK_ON} on delete cascade on update restrict`, FK_SHAPE, [CLAUSE.fkShape, null]],
    fkNotValid: [`alter table ${T} drop constraint ${FK}, add constraint ${FK} ${FK_ON} on delete restrict on update restrict not valid`, FK_SHAPE, [CLAUSE.fkShape, null]],
    // (i) the anchor replaced by a SQL-standard body that names nothing (same attributes, ACL and comment: only its dependencies are lost)
    anchorWithoutDependencies: [`create or replace function ${ANCHOR} returns boolean language sql stable set search_path = pg_catalog, pg_temp begin atomic select true; end`, ANCHOR_DEPS, [CLAUSE.anchorDeps, null]],
    // ...and by a plain-string body, which (b) sees first: its section declares a SQL-standard one
    anchorPlainBody: [`create or replace function ${ANCHOR} returns boolean language sql stable set search_path = pg_catalog, pg_temp as 'select true'`, FN_SHAPE('m7b_invoice_void_prerequisites')],
  };
  const out = {};
  for (const [k, [sql, message, ...steps]] of Object.entries(widenings)) {
    const r = await rolledBack(async (tx) => { await tx.unsafe(sql); await tx.unsafe(POSTCONDITION_035).simple(); });
    assert.equal(r.code, '55000', `${k}: ${JSON.stringify(r)}`);
    assert.match(r.message, /^migration 035 refused: /, k);
    assert.equal(r.message, message, `${k}: the exact refusal`);
    out[k] = r.message.slice(0, 80);
    // Negative control, in memory: the same widening against the postcondition WITHOUT the clause that refuses it — and, step by step,
    // without each clause that then refuses it — gives the exact next refusal, and finally acceptance.
    const gone = [];
    for (const [clause, next] of steps) {
      gone.push(clause);
      const v = await rolledBack(async (tx) => { await tx.unsafe(sql); await tx.unsafe(without(POSTCONDITION_035, ...gone)).simple(); });
      if (next === null) assert.ok('value' in v, `${k}: without ${gone.length} clause(s) the postcondition accepts it (${JSON.stringify(v)})`);
      else assert.deepEqual(v, { code: '55000', message: next }, `${k}: without ${gone.length} clause(s), the exact next refusal`);
    }
    if (steps.length > 0) assert.equal(steps.at(-1)[1], null, `${k}: its control ends in acceptance`);
  }
  // (e) itself: appMemberOfOwner's control above is refused by (e) once (d)'s two clauses are out of the way ({ 55000, MEMBER('tmpos_app') }),
  // and accepted with (e) removed too.
  // (h) the up again, over an applied 035: its own fixed text, nothing changed.
  const rows = await stateOf(TENANTS);
  const again = await rolledBack((tx) => tx.unsafe(UP_035).simple());
  assert.deepEqual(again, { code: '55000', message: 'migration 035 refused: schema tmpos_invoice_void already exists' });
  assert.deepEqual(diffKeys(S035, await catalogOf()), []);
  assert.deepEqual(await stateOf(TENANTS), rows);
});

test('IVR-02 (VOID-14 c e, R-DB-2 R-DB-5): 034\'s down while 035 is applied over an empty issuing state fails 2BP01 on the dependency, changing nothing; 035\'s down outside READ COMMITTED refused; a clean 035 down restores 034\'s catalog exactly (every ACL, the audit comment, the internal triggers, every dependency), equal to a fresh 034 apply\'s, and tmpos_app executes 034\'s page and get again; 034\'s down then passes (rolled back, then committed for the fresh apply); 035 re-applies to the first apply\'s catalog', async () => {
  assert.deepEqual(ISSUING_AT_034, NO_ISSUING, 'the service held no issuing data or void audit record at setup (CI order: every earlier suite cleaned up)');
  assert.deepEqual(await globalIssuing(), NO_ISSUING, 'still none');
  const d034 = await rolledBack((tx) => tx.unsafe(DOWN_034).simple());
  assert.equal(d034.code, '2BP01', `034's down fails on the dependency: ${JSON.stringify(d034)}`);
  assert.deepEqual(diffKeys(S035, await catalogOf()), [], 'nothing changed');
  // R-GATE-1 (034's precedent: its anchor names only 033's): the anchor records exactly 034's page and get and nothing
  // else, no 035 object records a dependency on any tmpos_session object, and 016's down — run raw beneath 017-035 as the
  // tenant suites run it, their tenant sessions removed inside the same rolled-back transaction — is not refused by 035.
  assert.equal((await owner`select pg_catalog.string_agg(d.refobjid::regprocedure::text, ', ' order by d.refobjid::regprocedure::text collate "C") as deps
      from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objsubid = 0 and d.objid = ${ANCHOR}::text::regprocedure
       and d.refclassid in ('pg_catalog.pg_proc'::regclass, 'pg_catalog.pg_class'::regclass) and d.deptype = 'n'`)[0].deps,
    'tmpos_invoice_issue.m7b_issued_invoice_get(text,uuid,uuid,uuid), tmpos_invoice_issue.m7b_issued_invoice_page(text,uuid,uuid,uuid,uuid,integer)',
    'the anchor names 034\'s page and get, and no other migration\'s function');
  assert.equal((await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_depend d
      where ((d.refclassid = 'pg_catalog.pg_proc'::regclass and d.refobjid in (select p.oid from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_session'::regnamespace))
             or (d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid in (select c.oid from pg_catalog.pg_class c where c.relnamespace = 'tmpos_session'::regnamespace)))
        and (pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)).schema = ${NS}`)[0].n, 0, 'no 035 object depends on a tmpos_session object');
  const d016 = await rolledBack(async (tx) => {
    await tx`delete from tmpos_session.session where audience = 'tenant'`;
    await tx.unsafe(DOWN_016).simple();
    return 'rolled back';
  });
  assert.deepEqual(d016, { value: 'rolled back' }, `016's down is not refused by 035: ${JSON.stringify(d016)}`);
  assert.deepEqual(diffKeys(S035, await catalogOf()), [], 'nothing changed');
  for (const iso of ['isolation level repeatable read', 'isolation level serializable']) {
    const r = await rolledBack((tx) => tx.unsafe(DOWN_035).simple(), iso);
    assert.deepEqual(r, { code: '55000', message: 'migration 035 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row' }, iso);
  }
  await down035();
  try {
    const afterDown = await catalogOf();
    assert.deepEqual(diffKeys(S034, afterDown), [], '034\'s catalog exactly, as at setup');
    const u = randomUUID();
    assert.deepEqual((await asTmposApp(`select o_outcome from ${PAGE_034_FN}($1::text, $2::uuid, $3::uuid, null, null, 1)`, ['k', u, u])).value, [{ o_outcome: 'denied' }]);
    assert.deepEqual((await asTmposApp(`select o_outcome from ${GET_034_FN}($1::text, $2::uuid, $3::uuid, $4::uuid)`, ['k', u, u, u])).value, [{ o_outcome: 'denied' }]);
    assert.equal((await owner`select pg_catalog.col_description('public.audit_event'::regclass, (select attnum from pg_catalog.pg_attribute
      where attrelid = 'public.audit_event'::regclass and attname = 'subject_issued_invoice_id')) as c`)[0].c, AUDIT_COMMENT_034, '034\'s comment, word for word');
    assert.ok('value' in await rolledBack((tx) => tx.unsafe(DOWN_034).simple()), '035 rolled back, 034\'s down passes');
    // On a shared service S034 was itself taken after an earlier 035 down, so it would carry any residue of that down too:
    // the down is judged against a FRESH 034 apply instead (IIR-03's model), 034 rolled back committed and applied again.
    assert.deepEqual((await rollBackAbove(owner, MIG_DIR, '033')).rolledBack, ['034'], '034\'s down, committed');
    const fresh034 = await trustedApply('034');
    assert.deepEqual([fresh034.outcome, fresh034.applied], ['complete', ['034']], JSON.stringify(fresh034).slice(0, 300));
    assert.deepEqual(diffKeys(afterDown, await catalogOf()), [], 'after 035\'s down: a fresh 034 apply\'s catalog, every section');
  } finally {
    const r = await trustedApply();
    assert.deepEqual([r.outcome, r.applied], ['complete', ['035']], JSON.stringify(r).slice(0, 300));
  }
  assert.deepEqual(diffKeys(S035, await catalogOf()), [], 're-applied: the first apply\'s catalog');
});

test('IVR-03 (VOID-14 f, R-DB-7, R-GATE-2): the up refuses every wrong predecessor state with its own fixed text, changing nothing — outside READ COMMITTED, at 033, 034\'s page grant revoked or widened, the scope key reshaped, the audit comment or a 034 guard altered, the schema present; it judges objects only, never the ledger: 034 missing, dirty or unfinished in it, or a ledger cut back to 001-019, applies over 034\'s exact objects, while at 033 and a second apply are still refused over that 001-019 ledger; a clean finished 035 row with no 035 objects is not judged; the up\'s privilege preconditions refuse with their own text — 016\'s hold and admission EXECUTE and the ownership or inheritance of the tables (as a stand-in applier, a superuser passing both), and forced row security — each with a control: forced row security applies without its check, while the stand-in controls pin only the exact order of refusals (without the hold-EXECUTE check the ownership clause refuses next; without the ownership check the stand-in is refused only later, by the server\'s CREATE privilege on the database) and do not claim that either removed check is behaviourally necessary', async () => {
  const before = await catalogOf();
  const rows = await stateOf(TENANTS);
  /** In one rolled-back transaction: 035 rolled back by its own down, the state perturbed, then the up. */
  const at034 = (perturb, up = UP_035) => rolledBack(async (tx) => {
    await tx.unsafe(DOWN_035).simple();
    await tx`delete from public.schema_migrations where version = '035'`;
    await perturb(tx);
    await tx.unsafe(up).simple();
    return 'applied';
  });
  const nothing = async () => {};
  const READ_COMMITTED = 'migration 035 refused: it must run under READ COMMITTED, so that its checks see every committed row';
  const AT_033 = 'migration 035 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event or a table of tmpos_invoice_issue is missing (migrations 002, 017, 020, 021, 028 and 034 must be applied first)';
  const SCHEMA_PRESENT = 'migration 035 refused: schema tmpos_invoice_void already exists';
  /** tenantSessionMint's shape: a ledger cut back to 001-019 beneath objects through 035 (its raw re-apply of 020-035). */
  const SHORT_LEDGER = (tx) => tx`delete from public.schema_migrations where version > '019'`;
  const EXACT_034 = 'migration 035 refused: migration 034 is not applied exactly (the issued header\'s scope key, issue time or triggers in their exact shape and mode, or the issued reads)';
  const READS_034 = 'migration 035 refused: 034\'s issued page or get is not exactly as 034 left it (arguments, result, attributes, owned by the applying principal, its ACL the owner\'s EXECUTE and tmpos_app\'s alone)';
  const COMMENT_034 = 'migration 035 refused: public.audit_event.subject_issued_invoice_id does not carry 034\'s comment exactly';
  // Thunks, run one at a time: each takes the up's and the down's ACCESS EXCLUSIVE locks.
  const cases = {
    repeatableRead: [() => rolledBack(async (tx) => { await tx.unsafe(UP_035).simple(); }, 'isolation level repeatable read'), READ_COMMITTED],
    pageRevoked: [() => at034((tx) => tx.unsafe(`revoke execute on function ${PAGE_034} from tmpos_app`)), READS_034],
    getWidened: [() => at034((tx) => tx.unsafe(`grant execute on function ${GET_034} to tmpos_audit_writer`)), READS_034],
    scopeKeyReshaped: [() => at034(async (tx) => {
      await tx.unsafe('alter table tmpos_invoice_issue.issued_invoice_line drop constraint issued_invoice_line_invoice_fkey');
      await tx.unsafe('alter table tmpos_invoice_issue.issued_invoice drop constraint issued_invoice_scope_key');
      await tx.unsafe('alter table tmpos_invoice_issue.issued_invoice add constraint issued_invoice_scope_key unique (tenant_id, invoice_id, store_id)');
    }), EXACT_034],
    issueGuardOrigin: [() => at034((tx) => tx.unsafe('alter table tmpos_invoice_issue.issued_invoice enable trigger trg_issued_invoice_guard')), EXACT_034],
    auditComment: [() => at034((tx) => tx.unsafe(`comment on column public.audit_event.subject_issued_invoice_id is 'x'`)), COMMENT_034],
    schemaPresent: [() => at034((tx) => tx.unsafe(`create schema ${NS}`)), SCHEMA_PRESENT],
    at033: [() => at034(async (tx) => { await tx.unsafe(DOWN_034).simple(); await tx`delete from public.schema_migrations where version = '034'`; }), AT_033],
    // The objects still decide over a short ledger: a wrong predecessor and a second apply are refused there too.
    at033ShortLedger: [() => at034(async (tx) => { await SHORT_LEDGER(tx); await tx.unsafe(DOWN_034).simple(); }), AT_033],
    secondApplyShortLedger: [() => rolledBack(async (tx) => { await SHORT_LEDGER(tx); await tx.unsafe(UP_035).simple(); }), SCHEMA_PRESENT],
  };
  const out = {};
  for (const [k, [run, message]] of Object.entries(cases)) {
    const r = await run();
    assert.deepEqual(r, { code: '55000', message }, `${k}: ${JSON.stringify(r)}`);
    out[k] = message.slice(0, 60);
  }
  // The control: the same rolled-back path with nothing perturbed applies, and so does one with a clean finished '035' row
  // (the trusted executor's in-flight marker is not judged: the objects decide).
  assert.deepEqual(await at034(nothing), { value: 'applied' }, 'unperturbed, the up applies');
  assert.deepEqual(await at034((tx) => tx`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
    values ('035', 'x', false, now(), now())`), { value: 'applied' }, 'a clean 035 row with no 035 objects applies');
  // R-GATE-2 (034's precedent): the trusted executor and the startup preflight own the ledger, so every ledger perturbation
  // over 034's exact objects applies — the refusal of a wrong predecessor or a second apply is the objects' (above).
  const ledgerApplies = {
    ledgerMissing034: (tx) => tx`delete from public.schema_migrations where version = '034'`,
    ledgerDirty034: (tx) => tx`update public.schema_migrations set dirty = true where version = '034'`,
    ledgerUnfinished034: (tx) => tx`update public.schema_migrations set finished_at = null where version = '034'`,
    ledgerAt019: SHORT_LEDGER,
  };
  for (const [k, perturb] of Object.entries(ledgerApplies)) {
    assert.deepEqual(await at034(perturb), { value: 'applied' }, `${k}: the ledger is not 035's to judge`);
  }
  // R-DB-7, the up's privilege preconditions (T4), each refused with its own fixed text (42501): 016's hold and admission EXECUTE for
  // the applying principal, its ownership or inheritance of the tables the definers read or lock, and forced row security on one of
  // them. A superuser passes the first two whatever the ACLs say, so they are judged as a stand-in applier: a role that is not a
  // superuser, the owner of 034's page and get (the up requires its own principal to own them) and holding what the locks and the
  // object checks before the clause need — created and gone inside the rolled-back transaction, like every perturbation here.
  const NO_HOLD = 'migration 035 refused: the applying principal cannot execute 034\'s issued page and get, which the v2 reads call, or 016\'s hold and admission read, which the void calls, or use the schemas they read';
  const NO_OWNERSHIP = 'migration 035 refused: the applying principal neither owns nor inherits the owner of a table the definers read or lock, or one has forced row security';
  const standIn = ({ hold, inherits = false }) => async (tx) => {
    await tx.unsafe(`create role ${APPLIER} nologin nosuperuser`);
    for (const schema of ['tmpos_role', 'tmpos_role_edit', 'tmpos_customer', 'tmpos_invoice_draft', 'tmpos_invoice_issue', 'tmpos_session', 'tmpos_mint']) {
      await tx.unsafe(`grant usage on schema ${schema} to ${APPLIER}`);
    }
    await tx.unsafe(`grant all on public.store, public.audit_event, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer,
      tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, tmpos_invoice_issue.store_issuing_settings, tmpos_invoice_issue.store_invoice_counter,
      tmpos_invoice_issue.issued_invoice, tmpos_invoice_issue.issued_invoice_line to ${APPLIER}`);
    await tx.unsafe(`alter function ${PAGE_034} owner to ${APPLIER}`);
    await tx.unsafe(`alter function ${GET_034} owner to ${APPLIER}`);
    if (hold) await tx.unsafe(`grant execute on function tmpos_session.m5_hold_tenant_standing(text, text), tmpos_session.m5_admit_tenant_session_v2(text, text) to ${APPLIER}`);
    if (inherits) {
      await tx.unsafe(`grant "${ME}" to ${APPLIER}`);
      await tx.unsafe(`grant create on database "${DATABASE}" to ${APPLIER}`);
    }
    await tx.unsafe(`set local role ${APPLIER}`);
  };
  const forceRls = (tx) => tx.unsafe('alter table public.store force row level security');
  const privilegeCases = {
    noHoldExecute: [() => at034(standIn({ hold: false })), NO_HOLD],
    notOwnerOrInheriting: [() => at034(standIn({ hold: true })), NO_OWNERSHIP],
    forcedRowSecurity: [() => at034(forceRls), NO_OWNERSHIP],
  };
  for (const [k, [run, message]] of Object.entries(privilegeCases)) {
    const r = await run();
    assert.deepEqual(r, { code: '42501', message }, `${k}: ${JSON.stringify(r)}`);
  }
  assert.equal((await owner`select count(*)::int as n from pg_catalog.pg_roles where rolname = ${APPLIER}`)[0].n, 0, 'the stand-in applier was rolled back with the rest');
  // Controls, in memory: the same perturbation against an up WITHOUT the check, each pinned to its exact observed outcome (code and full
  // text). Forced row security: without its check the up APPLIES over a forced-RLS table. The two stand-in controls below pin only the
  // exact ORDER of refusals and claim nothing more: the stand-in holds no CREATE on the database, so even with these checks out it is
  // refused by the server and never applies the up; with the ownership check out it is refused only LATER, by the server's own refusal
  // of the schema's creation (42501 permission denied for database), which no clause of the up raises. They do not show that the removed check is
  // behaviourally necessary; the inheriting stand-in's acceptance at the end is a different principal's, not the removed-check run.
  const UP_NO_RLS_CHECK = patchOnce(UP_035, ' or c.relforcerowsecurity)', ' or false)');
  assert.deepEqual(await at034(forceRls, UP_NO_RLS_CHECK), { value: 'applied' }, 'without its forced-row-security check, the up applies over a forced-RLS table');
  const UP_NO_HOLD_CHECK = without(UP_035, "the applying principal cannot execute 034''s issued page and get");
  const NO_CREATE = { code: '42501', message: `permission denied for database ${DATABASE}` };
  const OWNERSHIP_CHECK = "(not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)";
  const OWNERSHIP_GONE = '(c.relforcerowsecurity)';
  assert.deepEqual(await at034(standIn({ hold: false }), UP_NO_HOLD_CHECK), { code: '42501', message: NO_OWNERSHIP }, 'order: without its hold-EXECUTE check, the stand-in is refused next by the ownership clause, with that clause\'s own text');
  const UP_NO_OWNERSHIP_CHECK = patchOnce(UP_035, OWNERSHIP_CHECK, OWNERSHIP_GONE);
  assert.deepEqual(await at034(standIn({ hold: true }), UP_NO_OWNERSHIP_CHECK), NO_CREATE, 'order: without its ownership check, the stand-in is refused only later, by the server\'s CREATE privilege (42501 permission denied for database), not applied');
  assert.deepEqual(await at034(standIn({ hold: false }), patchOnce(UP_NO_HOLD_CHECK, OWNERSHIP_CHECK, OWNERSHIP_GONE)), NO_CREATE, 'order: without either check, the stand-in is refused only by the server\'s CREATE privilege, the same refusal, not applied');
  // ...and inheriting the owner's privileges (a member of it, able to create in the database) satisfies both: that principal applies the up.
  assert.deepEqual(await at034(standIn({ hold: false, inherits: true })), { value: 'applied' }, 'a different stand-in, which inherits the owner and can create in the database, applies the up (not the removed-check run)');
  assert.deepEqual(diffKeys(before, await catalogOf()), [], 'nothing changed');
  assert.deepEqual(await stateOf(TENANTS), rows);
});

test('IVR-04 (VOID-14 b e): the up over issued invoices with lines (two stores, two tenants) keeps every header, line, counter, settings, draft, customer, store, role and audit row byte-identical (row, xmin, ctid) and the catalog equal to the first apply\'s; 034\'s down then fails 55000 at its own data guard, changing nothing', async () => {
  await down035();
  let f; let g; let R0;
  try {
    f = await scene('upgrade', { invoices: 4 });
    await f.issue(f.S2);
    g = await scene('upgrade-other', { invoices: 2 });
    R0 = await stateOf([f.T, g.T]);
    assert.equal(R0.invoices.length, 7);
    assert.equal(R0.invoiceLines.length, 7 * LINES.length);
  } finally {
    const r = await trustedApply();
    assert.deepEqual([r.outcome, r.applied], ['complete', ['035']], JSON.stringify(r).slice(0, 300));
  }
  const tenants = [f.T, g.T];
  assert.deepEqual(await stateOf(tenants), R0, 'every row image unchanged by the apply');
  assert.deepEqual(diffKeys(S035, await catalogOf()), []);
  const d034 = await rolledBack((tx) => tx.unsafe(DOWN_034).simple());
  assert.equal(d034.code, '55000', JSON.stringify(d034));
  assert.match(d034.message, /^migration 034 rollback refused: issuing settings/);
  assert.deepEqual(await stateOf(tenants), R0);
  assert.deepEqual(diffKeys(S035, await catalogOf()), []);
  // The upgraded invoices void (035 over data it did not see issued).
  assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T }), APPLIED(f.boss, f.T, f.S, f.inv[0]));
});

test('IVR-05 (R-SEC-01, VOID-14): the exact surface — six functions with their declared language, security, volatility, settings, result and comment; the owner\'s and tmpos_app\'s non-grantable EXECUTE on the three routines and the owner\'s alone elsewhere; 034\'s page and get the owner\'s alone, its four other routines unchanged; nothing for PUBLIC, anon, authenticated or tmpos_audit_writer; no table privilege by any path, row security on and unforced, no policy; schema USAGE to tmpos_app alone; the login refused (42501) on the table, the helpers and 034\'s page and get; the v2 reads answer one \'denied\' row', async () => {
  const fns = (await owner`select p.proname::text as name, l.lanname::text as lang, p.prosecdef as definer, p.provolatile::text as vol, p.proconfig as config,
      p.prorettype::regtype::text as returns, p.proretset as set, p.proisstrict as strict, p.prosqlbody is not null as sql_body, p.proowner::regrole::text as owner,
      pg_catalog.obj_description(p.oid, 'pg_proc') is not null as commented
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang where p.pronamespace = 'tmpos_invoice_void'::regnamespace`).map((r) => ({ ...r }));
  const PINNED = ['search_path=pg_catalog, pg_temp', 'row_security=off'];
  const PATH = ['search_path=pg_catalog, pg_temp'];
  const fn = (lang, definer, vol, config, returns, set, sqlBody = false) => ({ lang, definer, vol, config, returns, set, strict: false, sql_body: sqlBody, owner: ME, commented: true });
  assert.deepEqual(Object.fromEntries(fns.map(({ name, ...rest }) => [name, rest])), {
    m7b_invoice_void: fn('plpgsql', true, 'v', PINNED, 'record', true),
    m7b_issued_invoice_page_v2: fn('sql', true, 's', PINNED, 'record', true, true),
    m7b_issued_invoice_get_v2: fn('sql', true, 's', PINNED, 'record', true, true),
    m7b_invoice_void_guard: fn('plpgsql', false, 'v', PINNED, 'trigger', false),
    m7b_invoice_void_truncate_guard: fn('plpgsql', false, 'v', PATH, 'trigger', false),
    m7b_invoice_void_prerequisites: fn('sql', false, 's', PATH, 'boolean', false, true),
  }, 'schema tmpos_invoice_void: exactly the six functions, each as declared');
  assert.equal((await owner`select pg_catalog.pg_get_function_result(${VOID}::regprocedure) as r`)[0].r,
    'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_actor_id uuid, o_membership_id uuid, o_version bigint, o_invoice_id uuid)');
  for (const sig of ROUTINES) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME, 'tmpos_app'), `${sig}: the owner's and tmpos_app's EXECUTE`);
  for (const sig of [...UNGRANTED, PAGE_034, GET_034]) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME), `${sig}: the owner's alone`);
  for (const sig of KEPT_034) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME, 'tmpos_app'), `${sig}: unchanged by 035`);
  for (const sig of [...ROUTINES, ...UNGRANTED, PAGE_034, GET_034]) {
    const [can] = await owner`select pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${sig}::regprocedure, 'EXECUTE') as login,
      pg_catalog.has_function_privilege('tmpos_app', ${sig}::regprocedure, 'EXECUTE') as app,
      pg_catalog.has_function_privilege('public', ${sig}::regprocedure, 'EXECUTE') as public,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${sig}::regprocedure, 'EXECUTE') as audit,
      pg_catalog.has_function_privilege('anon', ${sig}::regprocedure, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${sig}::regprocedure, 'EXECUTE') as authenticated`;
    const granted = ROUTINES.includes(sig);
    assert.deepEqual({ ...can }, { login: granted, app: granted, public: false, audit: false, anon: false, authenticated: false }, sig);
  }
  const [{ v }] = await owner`select pg_catalog.current_setting('server_version_num')::int as v`;
  const PRIVS = `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER${v >= 170000 ? ', MAINTAIN' : ''}`;
  for (const role of [RUNTIME_LOGIN, 'tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated', 'public']) {
    const [p] = await owner`select pg_catalog.has_table_privilege(${role}, ${VOID_TABLE}::regclass, ${PRIVS}) as t,
      pg_catalog.has_any_column_privilege(${role}, ${VOID_TABLE}::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') as c`;
    assert.deepEqual({ ...p }, { t: false, c: false }, `${role} on the void table`);
    if (role !== 'public') {
      assert.equal((await owner`select pg_catalog.pg_has_role(${role}, ${ME}, 'MEMBER') as m`)[0].m, false, `${role} is not a member of the owner`);
    }
  }
  const [shape] = await owner`select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
    (select count(*) from pg_catalog.pg_policy y where y.polrelid = c.oid)::int as policies,
    (select pg_catalog.count(*) from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g where g.grantee <> c.relowner)::int as foreign_entries,
    (select count(*) from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attacl is not null)::int as column_grants
    from pg_catalog.pg_class c where c.oid = ${VOID_TABLE}::regclass`;
  assert.deepEqual({ ...shape }, { rls: true, forced: false, policies: 0, foreign_entries: 0, column_grants: 0 }, 'row security on, unforced, no policy, no grant');
  assert.deepEqual((await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.is_grantable as grantable
    from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
    where n.oid = 'tmpos_invoice_void'::regnamespace and g.grantee <> n.nspowner order by 1, 2`).map((r) => ({ ...r })),
  [{ grantee: 'tmpos_app', priv: 'USAGE', grantable: false }], 'the schema\'s one grant beyond its owner\'s');
  // The table's shape: the closed reason list in the server enum's order (contract §2), the key onto 034's scope key.
  const defs = Object.fromEntries((await owner`select conname::text as n, pg_catalog.pg_get_constraintdef(oid) as d from pg_catalog.pg_constraint
    where conrelid = ${VOID_TABLE}::regclass`).map((r) => [r.n, r.d]));
  assert.deepEqual(defs, {
    issued_invoice_void_pkey: 'PRIMARY KEY (invoice_id)',
    issued_invoice_void_invoice_fkey: 'FOREIGN KEY (invoice_id, tenant_id, store_id) REFERENCES tmpos_invoice_issue.issued_invoice(invoice_id, tenant_id, store_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
    issued_invoice_void_reason_code_chk: `CHECK ((reason_code = ANY (ARRAY[${INVOICE_VOID_REASON_CODES.map((c) => `'${c}'::text`).join(', ')}])))`,
  });
  assert.deepEqual([...INVOICE_VOID_REASON_CODES], ['issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts', 'wrong_seller_details', 'duplicate', 'other']);
  assert.deepEqual((await owner`select tgname::text as n, tgtype::int as t, tgenabled::text as e from pg_catalog.pg_trigger where tgrelid = ${VOID_TABLE}::regclass
    and not tgisinternal order by 1`).map((r) => ({ ...r })), [{ n: 'trg_issued_invoice_void_guard', t: 31, e: 'A' }, { n: 'trg_issued_invoice_void_truncate', t: 34, e: 'A' }]);
  assert.equal((await owner`select pg_catalog.col_description('public.audit_event'::regclass, (select attnum from pg_catalog.pg_attribute
    where attrelid = 'public.audit_event'::regclass and attname = 'subject_issued_invoice_id')) as c`)[0].c, AUDIT_COMMENT_035, 'section 9\'s comment');
  // The login, as the enforcement boundary.
  const u = randomUUID();
  for (const [label, sql] of [
    ['read the void table', `select 1 from ${VOID_TABLE} limit 1`],
    ['insert a void record', `insert into ${VOID_TABLE} (invoice_id, tenant_id, store_id, reason_code, voided_at, voided_by) values ('${u}', '${u}', '${u}', 'other', now(), '${u}')`],
    ['delete void records', `delete from ${VOID_TABLE}`],
    ['the anchor', `select ${ANCHOR}`],
    ['the row guard', `select ${GUARD_FN}`],
    ['the truncate guard', `select ${TRUNCATE_FN}`],
    ['034\'s page', `select * from ${PAGE_034_FN}('k', '${u}', '${u}', null, null, 1)`],
    ['034\'s get', `select * from ${GET_034_FN}('k', '${u}', '${u}', '${u}')`],
  ]) assert.equal((await errorOf(runtime.unsafe(sql)))?.code, '42501', `the login cannot ${label}`);
  assert.equal((await asTmposApp(`select * from ${PAGE_034_FN}($1::text, $2::uuid, $3::uuid, null, null, 1)`, ['k', u, u])).code, '42501', 'tmpos_app itself: 034\'s page');
  assert.equal((await asTmposApp(`select * from ${GET_034_FN}($1::text, $2::uuid, $3::uuid, $4::uuid)`, ['k', u, u, u])).code, '42501', 'tmpos_app itself: 034\'s get');
  const pv = await page(PAGE_V2_FN, 'k', u, u, { limit: 1 });
  const gv = await getInvoice(GET_V2_FN, 'k', u, u, u);
  assert.deepEqual([pv.length, pv[0].o_outcome, pv[0].o_status], [1, 'denied', null]);
  assert.deepEqual([gv.length, gv[0].o_outcome, gv[0].o_status, gv[0].o_voided_at, gv[0].o_reason_code], [1, 'denied', null, null, null]);
  assert.equal((await owner.unsafe(`select ${ANCHOR} as v`))[0].v, true, 'the anchor answers true');
});

// ===========================================================================
// IVR-06..10: authority, isolation, the delta, the sign-in, and what changes while the void waits
// ===========================================================================

test('IVR-06 (VOID-01, D-VOID-2): the authority matrix over real sessions — applied exactly at Invoices >= Approve AND Customers >= View (store_owner Full; the stored level decides, never the role name; active and trialing statuses), refused for Invoices Manage, Approve without Customers View, every other level, a read-only actor, tenant or store, a suspended grant, a tenant grant only, a grant at another store and an unknown role; nothing written when refused; the issuer of the invoice, lowered below Invoices Approve or below Customers View, is refused like anyone else (no creator shortcut), with a negative control', async () => {
  const f = await scene('authority');
  const tech = await member(f, 'm', 'technician');
  const sales = await member(f, 'm', 'sales_staff');
  const roActor = await member(f, 'ro', 'store_owner', 'read_only');
  const trialActor = await member(f, 'tr', 'store_owner', 'trialing');
  const elsewhere = await actor('authority-elsewhere', [storeGrant(f.T, f.S2, 'manager')]);
  const kElsewhere = await mint(elsewhere);
  const tenantManager = await actor('authority-tgrant-mgr', [tenantGrant(f.T, 'manager')]);
  const kTenantManager = await mint(tenantManager);
  let applied = 0;
  /** One case on a fresh invoice: applied with the actor's record, or the refusal with every row image unchanged. */
  const decide = async (label, key, who, expect, { g = f, store = g.S, tenant = g.T, invoice: given } = {}) => {
    const invoice = given ?? await g.issue();
    const before = await stateOf([g.T]);
    const out = await voidCall(key, { store, invoice, tenant });
    if (expect === 'applied') {
      applied += 1;
      assert.deepEqual(out, APPLIED(who, g.T, store, invoice), `${label}: applied`);
      assert.deepEqual((await voidRowOf(invoice)).map((r) => [r.voided_by, r.tenant_id, r.store_id]), [[who.id, g.T, store]], `${label}: the record names the actor`);
    } else {
      assert.deepEqual(out, NO(expect), `${label}: ${expect}`);
      assert.deepEqual(await stateOf([g.T]), before, `${label}: nothing written`);
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
  await setLevel(f.T, 'manager', 'customers', 'none');
  await decide('a manager at Approve without Customers View', f.kManager, f.manager, 'refused');
  await setLevel(f.T, 'manager', 'invoices', 'manage');
  await setLevel(f.T, 'manager', 'customers', 'full');
  await decide('a manager at Invoices Manage (Customers Full)', f.kManager, f.manager, 'refused');
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
  // D-VOID-2, no creator shortcut (T2): the actor who ISSUED the invoice is judged by its levels like anyone else. A store owner's
  // levels are never stored and cannot be lowered, so the issuer is an editable role: the manager issues, is lowered, and is refused.
  const issuedByManager = async () => {
    const one = await issueOne(f.kManager, f.S, f.T, f.C);
    f.issued.push(one);
    assert.equal((await owner`select issued_by from tmpos_invoice_issue.issued_invoice where invoice_id = ${one.invoice}`)[0].issued_by, f.manager.id, 'the manager issued it');
    return one.invoice;
  };
  for (const [label, domain, level] of [['Invoices Manage', 'invoices', 'manage'], ['Customers none', 'customers', 'none']]) {
    const mine = await issuedByManager();
    await setLevel(f.T, 'manager', domain, level);
    await decide(`the issuer of the invoice, lowered to ${label}: refused, nothing written`, f.kManager, f.manager, 'refused', { invoice: mine });
    await clearLevels(f.T);
    await decide(`the same issuer at its defaults again voids the same invoice (only its levels refused it)`, f.kManager, f.manager, 'applied', { invoice: mine });
  }
  // Negative control: a scratch copy of the routine WITH a creator shortcut voids the lowered issuer's own invoice (rolled back); the real one refuses.
  const shortcutTarget = await issuedByManager();
  await setLevel(f.T, 'manager', 'invoices', 'manage');
  assert.deepEqual(await rolledBack(async (tx) => voidCall(f.kManager, { store: f.S, invoice: shortcutTarget, tenant: f.T, db: tx, fn: await scratchVoid(tx, issuerShortcut) })),
    { value: APPLIED(f.manager, f.T, f.S, shortcutTarget) }, 'with a creator shortcut the lowered issuer voids its own invoice');
  assert.deepEqual(await voidCall(f.kManager, { store: f.S, invoice: shortcutTarget, tenant: f.T }), NO('refused'), 'the real routine refuses it');
  await clearLevels(f.T);
  await decide('a read-only actor (store_owner)', roActor.key, roActor.who, 'refused');
  await decide('a trialing actor (store_owner)', trialActor.key, trialActor.who, 'applied');
  await decide('a tenant grant only (store_owner)', f.kOwn, f.own, 'refused');
  await decide('a manager on a tenant grant only', kTenantManager, tenantManager, 'refused');
  await decide('a grant at another store, naming this store', kElsewhere, elsewhere, 'refused');
  await decide('a grant at another store, naming its own store with this store\'s invoice', kElsewhere, elsewhere, 'not_found', { store: f.S2 });
  // Statuses: sessions minted after the change (a status is part of the standing).
  for (const [label, tag, set, expect] of [
    ['a read-only tenant', 'rotenant', (g) => owner`update tenant set status = 'read_only' where tenant_id = ${g.T}`, 'refused'],
    ['a read-only store', 'rostore', (g) => owner`update store set status = 'read_only' where store_id = ${g.S}`, 'refused'],
    ['an overdue tenant', 'odtenant', (g) => owner`update tenant set status = 'overdue' where tenant_id = ${g.T}`, 'refused'],
    ['a suspended grant', 'suspended', (g) => owner`update user_membership set status = 'suspended' where membership_id = ${g.boss.memberships[0]}`, 'refused'],
    ['a trialing tenant and store', 'trialing', async (g) => {
      await owner`update tenant set status = 'trialing' where tenant_id = ${g.T}`;
      await owner`update store set status = 'trialing' where store_id = ${g.S}`;
    }, 'applied'],
  ]) {
    const g = await scene(`authority-${tag}`, { invoices: 1 });
    await set(g);
    await decide(label, await mint(g.boss), g.boss, expect, { g, invoice: g.inv[0] });
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
  assert.equal(Number((await owner`select count(*)::int as n from tmpos_invoice_void.issued_invoice_void where tenant_id = ${f.T}`)[0].n), applied - 1,
    'one record per applied case at this tenant (the trialing case is its own tenant)');
});

test('IVR-07 (VOID-02, contract §3): isolation — another store\'s, another tenant\'s and a missing invoice answer one identical not_found row; a store the actor holds no grant at is refused; and the decision order — refused before tenant_mismatch before not_found before the sign-in after the locks before invalid_state before conflict — each refusal writing nothing', async () => {
  const f = await scene('isolation', { invoices: 3 });
  const J = await f.issue(f.S2);
  const other = await scene('isolation-foreign', { invoices: 1 });
  const tech = await member(f, 'order', 'technician');
  await setLevel(f.T, 'manager', 'invoices', 'manage');
  assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: f.inv[2], tenant: f.T }), APPLIED(f.boss, f.T, f.S, f.inv[2]), 'one invoice voided first');
  const before = await stateOf([f.T, other.T]);
  const cases = [
    ['another store\'s invoice, naming this store', f.kBoss, { store: f.S, invoice: J, tenant: f.T }, 'not_found'],
    ['another tenant\'s invoice', f.kBoss, { store: f.S, invoice: other.inv[0], tenant: f.T }, 'not_found'],
    ['a missing invoice', f.kBoss, { store: f.S, invoice: randomUUID(), tenant: f.T }, 'not_found'],
    ['another tenant\'s invoice, naming its store', f.kBoss, { store: other.S, invoice: other.inv[0], tenant: other.T }, 'refused'],
    ['another store\'s invoice, naming its store (no grant there)', f.kBoss, { store: f.S2, invoice: J, tenant: f.T }, 'refused'],
    ['the other store\'s owner, naming its store with this store\'s invoice', f.kBoss2, { store: f.S2, invoice: f.inv[0], tenant: f.T }, 'not_found'],
    ['another tenant\'s owner naming this store', other.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T }, 'refused'],
    ['an expectedTenant not the grant\'s', f.kBoss, { store: f.S, invoice: f.inv[0], tenant: T_OTHER }, 'tenant_mismatch'],
    // the order
    ['tenant_mismatch before not_found', f.kBoss, { store: f.S, invoice: randomUUID(), tenant: T_OTHER }, 'tenant_mismatch'],
    ['tenant_mismatch before invalid_state', f.kBoss, { store: f.S, invoice: f.inv[2], tenant: T_OTHER }, 'tenant_mismatch'],
    ['refused (unknown session) before tenant_mismatch', 'no-such-key', { store: f.S, invoice: f.inv[0], tenant: T_OTHER }, 'refused'],
    // step 2 (the levels) before step 3 (the tenant): the grant is good, the level is not
    ['refused (a technician at its View / View default) before tenant_mismatch', tech.key, { store: f.S, invoice: f.inv[0], tenant: T_OTHER }, 'refused'],
    ['refused (a manager stored at Invoices Manage) before tenant_mismatch', f.kManager, { store: f.S, invoice: f.inv[0], tenant: T_OTHER }, 'refused'],
    ['not_found before conflict', f.kBoss, { store: f.S, invoice: randomUUID(), tenant: f.T, version: 2 }, 'not_found'],
    ['invalid_state before conflict', f.kBoss, { store: f.S, invoice: f.inv[2], tenant: f.T, version: 2 }, 'invalid_state'],
  ];
  const shapes = {};
  for (const [label, key, args, want] of cases) {
    const out = await voidCall(key, args);
    assert.deepEqual(out, NO(want), label);
    (shapes[want] ??= []).push(JSON.stringify(out));
  }
  assert.equal(new Set(shapes.not_found).size, 1, 'missing, another store\'s and another tenant\'s: one shape');
  // The sign-in is judged after the locks: a stale sign-in still answers not_found for a missing invoice (step 4 first) and
  // refused for an already-void one (step 6 before step 7).
  await setAuth(f.kBoss, (await dbNowMs()) - 700_000);
  assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: randomUUID(), tenant: f.T }), NO('not_found'), 'a stale sign-in: not_found first');
  assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: f.inv[2], tenant: f.T }), NO('refused'), 'a stale sign-in before invalid_state');
  assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T, version: 2 }), NO('refused'), 'a stale sign-in before conflict');
  await setAuth(f.kBoss, await dbNowMs());
  const after = await stateOf([f.T, other.T]);
  assert.deepEqual({ ...after, sessions: before.sessions }, before, 'nothing written by any refusal (only the forged sign-in moved)');
});

test('IVR-08 (VOID-04, R-BR-09, VOID-15 database part): the exact delta — one void record and nothing else (every header, line, counter, settings, draft, customer, role, session and audit row unchanged; no audit, outbox or idempotency row anywhere); the record\'s tenant, store, reason, actor and time; the versions (2 on an issued invoice conflicts writing nothing; 1 applies at version 2; then 1 and 2 are invalid_state); each of the six reason codes; every malformed argument raised (22023) before anything; the next issue at the store takes the next number', async () => {
  const f = await scene('delta', { invoices: 9 });
  const [{ last: counterBefore }] = await owner`select last_number::text as last from tmpos_invoice_issue.store_invoice_counter where store_id = ${f.S}`;
  const before = await stateOf([f.T]);
  const t0 = await dbNowText();
  assert.deepEqual(await voidCall(f.kManager, { store: f.S, invoice: f.inv[0], tenant: f.T, reason: 'wrong_customer' }), APPLIED(f.manager, f.T, f.S, f.inv[0]),
    'the manager (an editable role: the key and the re-read) voids');
  const t1 = await dbNowText();
  const after = await stateOf([f.T]);
  assert.deepEqual({ ...after, voids: before.voids }, before, 'nothing but the void table changed');
  assert.equal(after.voids.length, before.voids.length + 1, 'one void record');
  const [rec] = await voidRowOf(f.inv[0]);
  assert.deepEqual({ ...rec, at: undefined }, { tenant_id: f.T, store_id: f.S, reason_code: 'wrong_customer', voided_by: f.manager.id, at: undefined, after_issue: true });
  assert.ok(t0 <= rec.at && rec.at <= t1, `voided_at on the database clock during the call: ${t0} <= ${rec.at} <= ${t1}`);
  // Versions (contract §3): conflict is decided after the existence check and writes nothing.
  const n0 = (await stateOf([f.T])).voids.length;
  const seq = [];
  for (const [version, want] of [[2, 'conflict'], [1, 'applied'], [1, 'invalid_state'], [2, 'invalid_state']]) {
    const got = await voidCall(f.kBoss, { store: f.S, invoice: f.inv[1], tenant: f.T, version, reason: 'other' });
    assert.deepEqual(got, want === 'applied' ? APPLIED(f.boss, f.T, f.S, f.inv[1]) : NO(want), `expected ${version}`);
    seq.push(`${version}:${got[0].o_outcome}`);
  }
  assert.deepEqual(seq, ['2:conflict', '1:applied', '1:invalid_state', '2:invalid_state']);
  assert.equal((await stateOf([f.T])).voids.length, n0 + 1, 'only the applied call wrote');
  // Every reason code of the closed list, in the server enum's order.
  for (const [i, code] of INVOICE_VOID_REASON_CODES.entries()) {
    assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: f.inv[2 + i], tenant: f.T, reason: code }), APPLIED(f.boss, f.T, f.S, f.inv[2 + i]), code);
    assert.equal((await voidRowOf(f.inv[2 + i]))[0].reason_code, code);
  }
  // Malformed arguments: each raises 22023 with fixed text (never the value) before anything is read, locked or written —
  // even with an unknown session key or outside READ COMMITTED (the argument rule first).
  const ARG = 'migration 035 void: an argument is malformed';
  const RANGE = 'migration 035 void: the expected version is out of range';
  const REASON = 'migration 035 void: the reason code is not one of the closed list';
  const target = { store: f.S, invoice: f.inv[8], tenant: f.T };
  const n1 = (await stateOf([f.T])).voids.length;
  const raises = [
    ['an unknown reason', f.kBoss, { reason: 'typo' }, REASON], ['a reason in another case', f.kBoss, { reason: 'Other' }, REASON],
    ['an empty reason', f.kBoss, { reason: '' }, REASON], ['a NULL reason', f.kBoss, { reason: null }, REASON],
    ['a free-text reason', f.kBoss, { reason: 'Customer asked nicely' }, REASON],
    ['version 0', f.kBoss, { version: 0 }, RANGE], ['version -1', f.kBoss, { version: -1 }, RANGE],
    ['version 2^53-1', f.kBoss, { version: '9007199254740991' }, RANGE], ['a NULL version', f.kBoss, { version: null }, RANGE],
    ['a NULL key', null, {}, ARG], ['an empty key', '', {}, ARG], ['a key with a space', 'has space', {}, ARG],
    ['a 129-character key', 'k'.repeat(129), {}, ARG], ['a non-ASCII key', 'clé', {}, ARG],
    ['a NULL store', f.kBoss, { store: null }, ARG], ['a NULL invoice', f.kBoss, { invoice: null }, ARG], ['a NULL tenant', f.kBoss, { tenant: null }, ARG],
    ['an unknown session with an unknown reason', 'no-such-key', { reason: 'typo' }, REASON],
  ];
  for (const [label, key, args, message] of raises) {
    assert.deepEqual(await errorOf(voidCall(key, { ...target, ...args })), { code: '22023', message }, label);
  }
  const rr = await errorOf(runtime.begin('isolation level repeatable read', (tx) => voidCall(f.kBoss, { ...target, reason: 'typo', db: tx })));
  assert.deepEqual(rr, { code: '22023', message: REASON }, 'the argument rule runs before the isolation check');
  assert.deepEqual(await voidCall('k'.repeat(128), target), NO('refused'), 'a 128-character key is well formed (an unknown session)');
  assert.deepEqual(await voidCall(f.kBoss, { ...target, version: '9007199254740990' }), NO('conflict'), 'version 2^53-2 is in range (a conflict)');
  assert.equal((await stateOf([f.T])).voids.length, n1, 'no raise wrote');
  // VOID-15 at the database: the issue at the same store is unaffected — the next number follows, the voided invoices' source
  // drafts stay issued and their numbers, snapshots and counter are untouched.
  const next = await f.issue();
  const [{ n }] = await owner`select number::text as n from tmpos_invoice_issue.issued_invoice where invoice_id = ${next}`;
  assert.equal(n, String(Number(counterBefore) + 1), 'the next issue takes the next number');
  assert.deepEqual((await owner`select distinct status from tmpos_invoice_draft.invoice_draft where draft_id = any(${f.issued.slice(0, 8).map((x) => x.draft)}::uuid[])`).map((r) => r.status), ['issued']);
});

test('IVR-09 (VOID-03 R-SEC-02, R-BR-08): the recent sign-in at the routine — live: NULL refused; 600001 ms older than an earlier database clock reading refused; exactly 5000 ms ahead of one applied; inside the window applied; more than 5000 ms ahead refused (the forged row); and the routine\'s own step-6 predicate, read from its source and evaluated at a fixed clock: exactly 600000 ms old passes and 600001 refuses, exactly 5000 ms ahead passes and 5001 refuses, NULL refuses, the expiry at the clock refuses', async () => {
  const f = await scene('signin', { invoices: 6 });
  let i = 0;
  const run = async (label, authAt, want) => {
    await setAuth(f.kBoss, authAt);
    const invoice = f.inv[i];
    const before = await stateOf([f.T]);
    const got = await voidCall(f.kBoss, { store: f.S, invoice, tenant: f.T });
    assert.deepEqual(got, want === 'applied' ? APPLIED(f.boss, f.T, f.S, invoice) : NO(want), label);
    if (want === 'applied') i += 1;
    else assert.deepEqual({ ...(await stateOf([f.T])), sessions: before.sessions }, before, `${label}: nothing written`);
  };
  await run('authenticated_at NULL', null, 'refused');
  // Deterministic against a reading F taken BEFORE the call: the routine's clock is at or after F.
  await run('600001 ms older than an earlier reading (1 ms past the bound)', (await dbNowMs()) - (RECENT_AUTH_MAX_AGE_MS + 1), 'refused');
  await run('exactly 5000 ms ahead of an earlier reading', (await dbNowMs()) + MAX_CLOCK_SKEW_MS, 'applied');
  await run('inside the window (8 s margin)', (await dbNowMs()) - RECENT_AUTH_MAX_AGE_MS + 8_000, 'applied');
  await run('13000 ms ahead (a forged, future sign-in; the call well under 8 s)', (await dbNowMs()) + MAX_CLOCK_SKEW_MS + 8_000, 'refused');
  await run('10 minutes and 5 s old', (await dbNowMs()) - RECENT_AUTH_MAX_AGE_MS - 5_000, 'refused');
  await setAuth(f.kBoss, await dbNowMs());
  await run('a fresh sign-in', await dbNowMs(), 'applied');
  // The exact bounds, on the routine's own source: step 6's statements, then its predicate evaluated at a fixed clock.
  const [{ src }] = await owner`select p.prosrc as src from pg_catalog.pg_proc p where p.oid = ${VOID}::regprocedure`;
  const STEP6 = /v_clock := pg_catalog\.clock_timestamp\(\);\s+v_now := pg_catalog\.floor\(extract\(epoch from v_clock\) \* 1000\)::bigint;\s+if ([\s\S]+?) then\s+return query select 'refused'/g;
  const found = [...src.matchAll(STEP6)];
  assert.equal(found.length, 1, 'one step-6 block: one clock_timestamp() reading, then one refusal predicate');
  const predicate = found[0][1];
  assert.equal(predicate.replace(/\s+/g, ' '), `v_now >= v_session.expires_at or v_session.authenticated_at is null or pg_catalog.to_timestamp(v_session.authenticated_at / 1000.0) > v_clock + interval '${MAX_CLOCK_SKEW_MS} milliseconds' or v_clock > pg_catalog.to_timestamp((v_session.authenticated_at + ${RECENT_AUTH_MAX_AGE_MS}) / 1000.0)`,
    'the predicate names sessions.ts\'s bounds');
  // Its place: after the header FOR UPDATE and the key, before the existence check, the version and the write.
  const at = (s) => { const k = src.indexOf(s); assert.ok(k >= 0, s); return k; };
  const order = [at('for update;'), at('pg_advisory_xact_lock_shared(530030'), found[0].index,
    at('if exists (select 1 from tmpos_invoice_void.issued_invoice_void v where v.invoice_id = p_invoice_id) then'),
    at('if p_expected_version is distinct from 1::bigint then'), at('insert into tmpos_invoice_void.issued_invoice_void')];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'header lock, key, sign-in, existence, version, write — in that order');
  assert.equal(src.slice(found[0].index).includes('statement_timestamp'), false);
  const F = Date.parse('2026-01-01T00:00:00.000Z');
  const evaluate = async (clock, expires, authAt) => (await owner.unsafe(`select (${predicate}) as refused
      from (select $1::text::timestamptz as v_clock) c
      cross join lateral (select pg_catalog.floor(extract(epoch from c.v_clock) * 1000)::bigint as v_now) n
      cross join (select $2::bigint as expires_at, $3::bigint as authenticated_at) as v_session`,
  [clock, String(expires), authAt === null ? null : String(authAt)]))[0].refused;
  const C = '2026-01-01 00:00:00+00';
  const bounds = {
    'exactly 600000 ms old': [C, F + HOUR, F - RECENT_AUTH_MAX_AGE_MS, false],
    '600001 ms old': [C, F + HOUR, F - RECENT_AUTH_MAX_AGE_MS - 1, true],
    'exactly 600000 ms old, the clock 1 µs later': ['2026-01-01 00:00:00.000001+00', F + HOUR, F - RECENT_AUTH_MAX_AGE_MS, true],
    'exactly 5000 ms ahead': [C, F + HOUR, F + MAX_CLOCK_SKEW_MS, false],
    '5001 ms ahead': [C, F + HOUR, F + MAX_CLOCK_SKEW_MS + 1, true],
    'NULL': [C, F + HOUR, null, true],
    'now': [C, F + HOUR, F, false],
    'expires at the clock': [C, F, F, true],
    'expires 1 ms after the clock': [C, F + 1, F, false],
  };
  for (const [label, [clock, expires, authAt, refused]] of Object.entries(bounds)) {
    assert.equal(await evaluate(clock, expires, authAt), refused, `step 6 at a fixed clock: ${label}`);
  }
});

test('IVR-10 (VOID-03): what changes WHILE the void waits decides it — on key 530030 held EXCLUSIVE by an uncommitted level update (Invoices -> Manage, Customers -> none: committed refused, rolled back applied); on the issued header held FOR UPDATE while a level narrowing commits, while the session expires, and while the sign-in ages past 10 minutes (released in time: applied); and at 016\'s hold while a grant suspension or a session revocation commits — each wait first seen in pg_locks, nothing written by a refusal; and the other way round, a level narrowing started after the void\'s re-read waits on key 530030 for the void\'s COMMIT, with a negative control', async (t) => {
  const f = await scene('waits', { invoices: 9 });
  const inv = [...f.inv];
  const holdHeader = (invoice) => holding(owner, (tx) => tx`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice} for update`);
  // (1) Key 530030: the level writer's trigger takes it EXCLUSIVE; the manager's void takes the header, then waits SHARED.
  for (const [domain, level, ending] of [['invoices', 'manage', 'commit'], ['customers', 'none', 'commit'], ['invoices', 'manage', 'rollback']]) {
    const invoice = inv.shift();
    const label = `${domain} -> ${level}, ${ending}`;
    await clearLevels(f.T);
    const narrowing = holding(owner, (tx) => setLevel(f.T, 'manager', domain, level, tx));
    let voiding = null;
    try {
      await until(() => narrowing.ready, `${label}: the narrowing held`);
      voiding = running(runtime, (tx) => voidCall(f.kManager, { store: f.S, invoice, tenant: f.T, db: tx }));
      await until(() => blockedBy(voiding.pid, narrowing.pid), `${label}: the void waits behind the narrowing`);
      assert.deepEqual(await waitsFor(voiding.pid), [['advisory', 'ShareLock']], `${label}: on the advisory key, SHARED`);
      assert.deepEqual(await advisoryWait(voiding.pid), [{ class: GUARD_CLASS, mode: 'ShareLock' }], `${label}: key 530030`);
      assert.equal(await rowHeld('tmpos_invoice_issue.issued_invoice', 'invoice_id', invoice), true, `${label}: having taken the header`);
      const before = await stateOf([f.T]);
      const released = await dbNowText();
      narrowing.release(ending);
      finished(await narrowing.done, `${label}: the narrowing`, ending === 'commit' ? 'committed' : 'rolled back');
      const out = finished(await voiding.done, `${label}: the void`).value;
      if (ending === 'commit') {
        assert.deepEqual(out, NO('refused'), `${label}: refused by the re-read under the key`);
        assert.deepEqual({ ...(await stateOf([f.T])), roles: before.roles }, before, `${label}: nothing written`);
      } else {
        assert.deepEqual(out, APPLIED(f.manager, f.T, f.S, invoice), `${label}: applied`);
        assert.ok((await voidRowOf(invoice))[0].at >= released, `${label}: voided_at after the wait`);
      }
    } finally { await settle(narrowing, voiding); }
  }
  await clearLevels(f.T);
  // (1b) The other way round (doc 13, "a narrowing started after the void's level re-read waits for its COMMIT"): the manager's void
  // is applied and held uncommitted after its step 5, and a narrowing in a second owner transaction waits on key 530030 (the void's
  // SHARED, its EXCLUSIVE) until the void ends; committed, the void stays applied and the narrowing then takes effect.
  const levers = [];
  const narrowDuringVoid = async (invoice, fn) => {
    const voiding = holding(owner, (tx) => voidCall(f.kManager, { store: f.S, invoice, tenant: f.T, db: tx, fn }));
    levers.push(voiding);
    await until(() => voiding.ready || voiding.out !== undefined, 'the manager\'s void applied, uncommitted');
    assert.deepEqual(voiding.value, APPLIED(f.manager, f.T, f.S, invoice), 'the void applied, held after its level re-read');
    const narrowing = running(owner, (tx) => setLevel(f.T, 'manager', 'invoices', 'manage', tx));
    levers.push(narrowing);
    return { voiding, narrowing };
  };
  try {
    const invoice = await f.issue();
    const held = await narrowDuringVoid(invoice, VOID_FN);
    await until(() => blockedBy(held.narrowing.pid, held.voiding.pid), 'the narrowing waits behind the uncommitted void');
    assert.deepEqual(await waitsFor(held.narrowing.pid), [['advisory', 'ExclusiveLock']], 'on the advisory key, EXCLUSIVE');
    assert.deepEqual(await advisoryWait(held.narrowing.pid), [{ class: GUARD_CLASS, mode: 'ExclusiveLock' }], 'key 530030');
    assert.equal(held.narrowing.out, undefined, 'not through while the void is uncommitted');
    held.voiding.release('commit');
    finished(await held.voiding.done, 'the void');
    finished(await held.narrowing.done, 'the narrowing, once the void committed');
    assert.deepEqual((await voidRowOf(invoice)).map((r) => [r.voided_by, r.reason_code]), [[f.manager.id, 'issued_in_error']], 'the void stays applied');
    assert.equal((await owner`select level from tmpos_role.tenant_role_level where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices'`)[0].level, 'manage', 'and the narrowing took effect after it');
    assert.deepEqual(await voidCall(f.kManager, { store: f.S, invoice: await f.issue(), tenant: f.T }), NO('refused'), 'the narrowed manager\'s next void is refused');
  } finally { await settle(...levers.splice(0)); }
  await clearLevels(f.T);
  // Negative control: a scratch copy of the routine that gives the shared key up right after its re-read lets the narrowing through
  // while the void is still uncommitted.
  try {
    const held = await narrowDuringVoid(await f.issue(), await scratchVoid(owner, keyReleasedEarly));
    await until(() => held.narrowing.out !== undefined, 'the narrowing went through the released key');
    assert.equal(held.narrowing.out.outcome, 'committed', JSON.stringify(held.narrowing.out));
    assert.equal(held.voiding.out, undefined, 'while the void was still uncommitted');
  } finally {
    await settle(...levers.splice(0));
    await owner.unsafe(`drop schema if exists ${NC} cascade`);
  }
  await clearLevels(f.T);
  /**
   * The header held FOR UPDATE by a second session; the void (key, invoice) waits on it; `during()` runs; then the release. A `retryable`
   * attempt may be DISCARDED (answered before it was seen waiting, or `during()` throws NotEngaged): it is then still awaited to
   * completion and must be exactly the expiry refusal with the state unchanged, before NotEngaged reaches the caller — any other
   * answer, or an error, fails at once and is never retried away.
   */
  const behindHeader = async (label, keyOf, invoice, during, want, who, { retryable = false } = {}) => {
    const holder = holdHeader(invoice);
    let voiding = null;
    try {
      await until(() => holder.ready, `${label}: the header held`);
      const key = typeof keyOf === 'function' ? await keyOf() : keyOf;
      const untouched = retryable ? await stateOf([f.T]) : null;
      voiding = running(runtime, (tx) => voidCall(key, { store: f.S, invoice, tenant: f.T, db: tx }));
      const discard = async (why) => {
        holder.release('rollback');
        await holder.done;
        const out = finished(await voiding.done, `${label}: the discarded attempt (${why})`).value;
        assert.deepEqual(out, NO('refused'), `${label}: the discarded attempt (${why}) is exactly the expiry refusal`);
        assert.deepEqual(await stateOf([f.T]), untouched, `${label}: the discarded attempt (${why}) wrote nothing`);
        throw new NotEngaged(`${why}; the discarded attempt was exactly the expiry refusal and wrote nothing`);
      };
      // A retryable attempt that is answered before it is ever seen waiting did not engage (its session was gone before the wait).
      await until(async () => (await blockedBy(voiding.pid, holder.pid)) || (retryable && voiding.out !== undefined), `${label}: the void waits on the header`);
      if (retryable && voiding.out !== undefined) await discard('answered before it was seen waiting on the header');
      assert.deepEqual(await waitsFor(voiding.pid), [['transactionid', 'ShareLock']], `${label}: a row lock wait`);
      assert.deepEqual(await rowWaitOn(voiding.pid), ['tmpos_invoice_issue.issued_invoice'], `${label}: the wait is on the issued header`);
      try { await during({ voiding, holder }); } catch (err) {
        if (retryable && err instanceof NotEngaged) await discard(err.message);
        throw err;
      }
      const before = await stateOf([f.T]);
      holder.release('rollback');
      await holder.done;
      const out = finished(await voiding.done, `${label}: the void`).value;
      if (want === 'applied') assert.deepEqual(out, APPLIED(who, f.T, f.S, invoice), `${label}: applied`);
      else {
        assert.deepEqual(out, NO(want), `${label}: ${want}`);
        assert.deepEqual(await stateOf([f.T]), before, `${label}: nothing written`);
      }
    } finally { await settle(holder, voiding); }
  };
  // (2) A narrowing commits while the manager's void waits at the header (before the key): the re-read refuses.
  await behindHeader('a narrowing committed during the header wait', f.kManager, inv.shift(),
    async () => { await setLevel(f.T, 'manager', 'invoices', 'manage'); }, 'refused');
  await clearLevels(f.T);
  // (3) The session expires during the wait: step 6 re-checks the expiry after the locks. The short session is minted only once the
  // header is held, to live a given time of the DATABASE clock (the clock that judges it); a loaded host can still be slower than
  // that to bring the void to the header, so the lever is ADAPTIVE: an attempt is valid only if the void was seen waiting on the
  // header (pg_locks) at a database time BEFORE the session's expiry, and one that was not (answered first, or seen too late) is
  // retried with the lifetime doubled, at most three attempts. A discarded attempt is never a free pass: it is awaited to completion and
  // must itself be exactly the expiry refusal ('refused', the all-NULL row) with the state unchanged, and any other answer or an error
  // propagates at once, so a retry cannot hide a wrong result. A valid attempt proves what it names: the wait engaged, the session
  // expired during it on the database clock (the void still waiting after the expiry), and the answer is 'refused', nothing written.
  // (An owner UPDATE of expires_at once the void waits cannot do this: the routine holds the session row FOR SHARE until commit.)
  const short = await member(f, 'short', 'store_owner');
  const shortInvoice = inv.shift();
  const LIFETIMES = [3_000, 6_000, 12_000];
  let shortExpires;
  for (const [attempt, life] of LIFETIMES.entries()) {
    try {
      await behindHeader('the session expired during the wait', async () => {
        const shortKey = await mint(short.who, { lifetime: life + (await dbNowMs()) - Date.now() });
        [{ e: shortExpires }] = await owner`select expires_at::text as e from tmpos_session.session where session_key = ${shortKey}`;
        return shortKey;
      }, shortInvoice, async ({ voiding, holder }) => {
        // Read after the wait was seen: if that is still before the expiry, the void was waiting before its session expired.
        if ((await dbNowMs()) >= Number(shortExpires)) throw new NotEngaged(`the void was seen waiting only after its session's expiry (${life} ms)`);
        await until(async () => (await dbNowMs()) > Number(shortExpires) + 50, 'the session expired', life + 6_000);
        assert.equal(await blockedBy(voiding.pid, holder.pid), true, 'the void was still waiting on the header when its session had expired');
      }, 'refused', undefined, { retryable: true });
      t.diagnostic(`IVR-10 (3): the session expired during the wait on attempt ${attempt + 1} of ${LIFETIMES.length} (lifetime ${life} ms)`);
      break;
    } catch (err) {
      if (!(err instanceof NotEngaged)) throw err;
      t.diagnostic(`IVR-10 (3): attempt ${attempt + 1} of ${LIFETIMES.length} did not engage (lifetime ${life} ms): ${err.message}`);
      if (attempt === LIFETIMES.length - 1) throw new Error(`lever did not engage: the session expired during the wait, in ${LIFETIMES.length} attempts: ${err.message}`);
    }
  }
  // (4) The sign-in ages past 10 minutes during the wait; the control, released before the bound, applies.
  let authAt = (await dbNowMs()) - RECENT_AUTH_MAX_AGE_MS + 2_000;
  await setAuth(f.kBoss, authAt);
  await behindHeader('the sign-in aged past 10 minutes during the wait', f.kBoss, inv.shift(),
    () => until(async () => (await dbNowMs()) > authAt + RECENT_AUTH_MAX_AGE_MS + 50, 'the sign-in aged out', 6_000), 'refused');
  authAt = (await dbNowMs()) - RECENT_AUTH_MAX_AGE_MS + 6_000;
  await setAuth(f.kBoss, authAt);
  await behindHeader('the same, released before the bound', f.kBoss, inv.shift(), async () => {}, 'applied', f.boss);
  await setAuth(f.kBoss, await dbNowMs());
  // (5) 016's hold: the actor's account row held; the void waits there; a revocation commits meanwhile; released, refused.
  for (const [label, revoke] of [['a grant suspension', (m) => owner`update user_membership set status = 'suspended' where membership_id = ${m.who.memberships[0]} returning 1`],
    ['a session revocation', (m) => owner`select tmpos_session.m5_session_revoke(${m.key}::text) as r`]]) {
    const invoice = inv.shift();
    const m = await member(f, label.split(' ').at(-1), 'store_owner');
    const holder = holding(owner, (tx) => tx`select 1 from public.app_user where internal_user_id = ${m.who.id} for update`);
    let voiding = null;
    try {
      await until(() => holder.ready, `${label}: the account row held`);
      voiding = running(runtime, (tx) => voidCall(m.key, { store: f.S, invoice, tenant: f.T, db: tx }));
      await until(() => blockedBy(voiding.pid, holder.pid), `${label}: the void waits at 016's hold`);
      assert.deepEqual(await waitsFor(voiding.pid), [['transactionid', 'ShareLock']]);
      assert.deepEqual(await rowWaitOn(voiding.pid), ['app_user'], 'the wait is on the account row, at 016\'s hold');
      assert.equal((await revoke(m)).length, 1, `${label}: committed while the void waits`);
      const before = await stateOf([f.T]);
      holder.release('rollback');
      await holder.done;
      assert.deepEqual(finished(await voiding.done, `${label}: the void`).value, NO('refused'), `${label}: refused`);
      assert.deepEqual(await stateOf([f.T]), before, `${label}: nothing written`);
    } finally { await settle(holder, voiding); }
  }
  assert.deepEqual(inv, [], 'every invoice used');
});

// ===========================================================================
// IVR-11..13: the race, its negative control, forged settings
// ===========================================================================

/**
 * Two voids of one fresh invoice from two sessions of two actors (016's hold serializes one actor's): the store owner's
 * applied and held uncommitted, the manager's waiting on the header; then the first ends as `ending`. Answers what happened.
 */
async function raceTwoVoids(f, ending, fn = VOID_FN) {
  const invoice = await f.issue();
  const first = holding(runtime, (tx) => voidCall(f.kBoss, { store: f.S, invoice, tenant: f.T, db: tx, fn }));
  let second = null;
  try {
    await until(() => first.ready || first.out !== undefined, 'the first void applied, uncommitted');
    assert.deepEqual(first.value, APPLIED(f.boss, f.T, f.S, invoice), 'the first void applies');
    second = running(runtime, (tx) => voidCall(f.kManager, { store: f.S, invoice, tenant: f.T, db: tx, fn, reason: 'duplicate' }));
    await until(() => blockedBy(second.pid, first.pid), 'the second void waits on the header');
    assert.deepEqual(await waitsFor(second.pid), [['transactionid', 'ShareLock']], 'a row lock wait');
    assert.deepEqual(await rowWaitOn(second.pid), ['tmpos_invoice_issue.issued_invoice'], 'the wait is on the issued header');
    const released = await dbNowText();
    first.release(ending);
    finished(await first.done, 'the first void', ending === 'commit' ? 'committed' : 'rolled back');
    return { invoice, second: await second.done, records: await voidRowOf(invoice), released };
  } finally { await settle(first, second); }
}
/** The race's contract (VOID-06): exactly one transition, the loser sealed as invalid_state; rolled back, the second applies after the wait. */
function checkRace(f, r, ending) {
  if (ending === 'commit') {
    assert.deepEqual(r.second, { outcome: 'committed', value: NO('invalid_state') }, 'the second void: invalid_state');
    assert.deepEqual(r.records.map((x) => [x.voided_by, x.reason_code]), [[f.boss.id, 'issued_in_error']], 'exactly one record: the first\'s');
  } else {
    assert.deepEqual(r.second, { outcome: 'committed', value: APPLIED(f.manager, f.T, f.S, r.invoice) }, 'the second void applies');
    assert.deepEqual(r.records.map((x) => [x.voided_by, x.reason_code]), [[f.manager.id, 'duplicate']], 'exactly one record: the second\'s');
    assert.ok(r.records[0].at >= r.released, `voided_at after the lock wait (${r.records[0].at} >= ${r.released})`);
  }
}

test('IVR-11 (VOID-06 VOID-04): two voids of one invoice from two sessions — the second waits on the issued header (pg_locks); the first committed, the second is invalid_state and exactly one record exists (the first\'s); the first rolled back, the second applies with voided_at after the wait; REPEATABLE READ and SERIALIZABLE refused (55000) before anything', async () => {
  const f = await scene('race', { invoices: 1 });
  for (const ending of ['commit', 'rollback']) checkRace(f, await raceTwoVoids(f, ending), ending);
  const before = await stateOf([f.T]);
  for (const iso of ['isolation level repeatable read', 'isolation level serializable']) {
    const e = await errorOf(runtime.begin(iso, (tx) => voidCall(f.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T, db: tx })));
    assert.deepEqual(e, { code: '55000', message: 'migration 035 void: it must run under READ COMMITTED, so that its checks see what committed before its locks' }, iso);
  }
  assert.deepEqual(await stateOf([f.T]), before, 'nothing written');
});

test('IVR-12 (R-BR-11, negative control): IVR-11\'s race against a scratch copy of the routine WITHOUT step 7\'s existence check fails — the second void reaches the insert and the primary key raises (23000), never the sealed invalid_state — and a sequential second void raises alike; the real routine passes the same check', async () => {
  const f = await scene('control', { invoices: 1 });
  const [{ def }] = await owner`select pg_catalog.pg_get_functiondef(${VOID}::regprocedure) as def`;
  const STEP7 = /\n\s*if exists \(select 1 from tmpos_invoice_void\.issued_invoice_void v where v\.invoice_id = p_invoice_id\) then\s+return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;\s+return;\s+end if;/g;
  assert.equal([...def.matchAll(STEP7)].length, 1, 'step 7 found exactly once');
  const HEAD = 'CREATE OR REPLACE FUNCTION tmpos_invoice_void.m7b_invoice_void(';
  assert.ok(def.startsWith(HEAD), def.slice(0, 80));
  const patched = def.replace(STEP7, '\n  -- IVR-12: step 7 removed').replace(HEAD, `CREATE FUNCTION ${NC}.m7b_invoice_void(`);
  await owner.unsafe(`create schema ${NC}`);
  try {
    await owner.unsafe(patched);
    await owner.unsafe(`revoke all on function ${NC}.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text) from public`);
    await owner.unsafe(`grant usage on schema ${NC} to ${RUNTIME_LOGIN}`);
    await owner.unsafe(`grant execute on function ${NC}.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text) to ${RUNTIME_LOGIN}`);
    const broken = await raceTwoVoids(f, 'commit', `${NC}.m7b_invoice_void`);
    assert.throws(() => checkRace(f, broken, 'commit'), assert.AssertionError, 'the race check fails without step 7');
    assert.deepEqual(broken.second, { outcome: 'failed', code: '23000', message: 'migration 035 void: the void record is not one the void table admits' },
      'the second void fell through to the primary key');
    assert.equal(broken.records.length, 1, 'the primary key still allows one record');
    assert.deepEqual(await errorOf(voidCall(f.kManager, { store: f.S, invoice: broken.invoice, tenant: f.T, fn: `${NC}.m7b_invoice_void` })),
      { code: '23000', message: 'migration 035 void: the void record is not one the void table admits' }, 'a sequential second void raises alike');
  } finally {
    await owner.unsafe(`drop schema if exists ${NC} cascade`);
  }
  checkRace(f, await raceTwoVoids(f, 'commit'), 'commit');
  assert.deepEqual(await voidCall(f.kManager, { store: f.S, invoice: f.inv[0], tenant: f.T }), APPLIED(f.manager, f.T, f.S, f.inv[0]));
  assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T }), NO('invalid_state'), 'the real routine: a sequential second void is invalid_state');
});

test('IVR-13 (R-BR-08): caller-set GUCs and session settings (an actor, tenant, store and sign-in claim, a JWT claim, role, search_path, timezone, row_security) do not change the routine\'s decision — it reads only the session row — nor the reads\' UTC encoding', async () => {
  const f = await scene('gucs', { invoices: 2 });
  const other = await scene('gucs-other');
  const GUCS = async (tx) => {
    await tx`select set_config('tmpos.actor', ${other.boss.id}, true), set_config('tmpos.tenant_id', ${other.T}, true),
      set_config('tmpos.store_id', ${other.S}, true), set_config('tmpos.authenticated_at', ${String(Date.now())}, true),
      set_config('request.jwt.claims', '{"sub":"x","role":"service_role"}', true), set_config('role', 'tmpos_app', true),
      set_config('search_path', 'public, pg_temp', true), set_config('timezone', 'Pacific/Kiritimati', true),
      set_config('row_security', 'on', true)`;
  };
  const inTx = (key, args) => runtime.begin(RC, async (tx) => { await GUCS(tx); return voidCall(key, { ...args, db: tx }); });
  const args = { store: f.S, invoice: f.inv[0], tenant: f.T };
  await setAuth(f.kBoss, null);
  assert.deepEqual(await inTx(f.kBoss, args), NO('refused'), 'a NULL sign-in stays refused whatever the GUCs claim');
  await setAuth(f.kBoss, await dbNowMs());
  assert.deepEqual(await inTx(other.kBoss, args), NO('refused'), 'another tenant\'s session stays refused at this store');
  assert.deepEqual(await inTx(f.kBoss, { ...args, reason: 'wrong_seller_details' }), APPLIED(f.boss, f.T, f.S, f.inv[0]), 'the session row\'s actor, tenant and store');
  assert.deepEqual((await voidRowOf(f.inv[0])).map((r) => [r.voided_by, r.tenant_id, r.store_id]), [[f.boss.id, f.T, f.S]]);
  const gv = await runtime.begin(RC, async (tx) => { await GUCS(tx); return getInvoice(GET_V2_FN, f.kBoss, f.T, f.S, f.inv[0], { db: tx }); });
  const [{ at }] = await voidRowOf(f.inv[0]);
  assert.ok(gv.length === LINES.length && gv.every((r) => r.o_status === 'voided' && r.o_voided_at === at), 'UTC encoding under another timezone');
  const pv = await runtime.begin(RC, async (tx) => { await GUCS(tx); return page(PAGE_V2_FN, f.kBoss, f.T, f.S, { db: tx }); });
  assert.deepEqual(pv.map((r) => [r.o_invoice_id, r.o_status]), [[f.inv[1], 'issued'], [f.inv[0], 'voided']]);
});

// ===========================================================================
// IVR-14..16: the guards, the reads, the rollback's refusals
// ===========================================================================

test('IVR-14 (VOID-14 i): the guards as the table owner, in normal and replica mode — UPDATE (a no-op included), DELETE and TRUNCATE of void records refused (23001, fixed text); an insert back-dated before the issue, naming another store or tenant, or an unknown invoice refused (the guard, where the foreign key does not fire); stamped at the issue time admitted; the voided header undeletable, by its guard and by the RESTRICT key; the routine\'s own void of an invoice dated after the database clock raises its fixed integrity text, nothing written (R-M4), with a negative control', async () => {
  const f = await scene('guards', { invoices: 2 });
  const other = await scene('guards-other', { invoices: 1 });
  assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T }), APPLIED(f.boss, f.T, f.S, f.inv[0]));
  const before = await stateOf([f.T, other.T]);
  const T = VOID_TABLE;
  const NEVER = 'migration 035: a void record is never updated or deleted';
  const SCOPE = 'migration 035: a void record names an issued invoice of its own tenant and store';
  const cases = {};
  for (const replica of [false, true]) {
    const tag = replica ? 'replica' : 'origin';
    const run = (sql, params = []) => rolledBack(async (tx) => { if (replica) await tx`set local session_replication_role = replica`; await tx.unsafe(sql, params); });
    cases[`${tag}:update`] = [await run(`update ${T} set reason_code = 'other' where invoice_id = $1`, [f.inv[0]]), NEVER];
    cases[`${tag}:noop`] = [await run(`update ${T} set reason_code = reason_code where invoice_id = $1`, [f.inv[0]]), NEVER];
    cases[`${tag}:voidedBy`] = [await run(`update ${T} set voided_by = $2 where invoice_id = $1`, [f.inv[0], f.manager.id]), NEVER];
    cases[`${tag}:delete`] = [await run(`delete from ${T} where invoice_id = $1`, [f.inv[0]]), NEVER];
    cases[`${tag}:truncate`] = [await run(`truncate ${T}`), 'migration 035: void records are never truncated'];
    const insert = (select) => run(`insert into ${T} (invoice_id, tenant_id, store_id, reason_code, voided_at, voided_by) ${select}`, [f.inv[1], f.boss.id]);
    cases[`${tag}:backdated`] = [await insert(`select i.invoice_id, i.tenant_id, i.store_id, 'other', i.issued_at - interval '1 microsecond', $2
      from tmpos_invoice_issue.issued_invoice i where i.invoice_id = $1`), 'migration 035: a void record is stamped at or after its invoice\'s issue'];
    cases[`${tag}:nullTime`] = [await rolledBack(async (tx) => {
      if (replica) await tx`set local session_replication_role = replica`;
      await tx.unsafe(`alter table ${T} alter column voided_at drop not null`);
      await tx.unsafe(`insert into ${T} (invoice_id, tenant_id, store_id, reason_code, voided_at, voided_by)
        select i.invoice_id, i.tenant_id, i.store_id, 'other', null, $2 from tmpos_invoice_issue.issued_invoice i where i.invoice_id = $1`, [f.inv[1], f.boss.id]);
    }), 'migration 035: a void record is stamped at or after its invoice\'s issue'];
    const values = (invoice, tenant, store) => run(`insert into ${T} (invoice_id, tenant_id, store_id, reason_code, voided_at, voided_by)
      values ($1, $2, $3, 'other', now(), $4)`, [invoice, tenant, store, f.boss.id]);
    cases[`${tag}:foreignStore`] = [await values(f.inv[1], f.T, f.S2), SCOPE];
    cases[`${tag}:foreignTenant`] = [await values(f.inv[1], other.T, f.S), SCOPE];
    cases[`${tag}:unknownInvoice`] = [await values(randomUUID(), f.T, f.S), SCOPE];
    const atIssue = await insert(`select i.invoice_id, i.tenant_id, i.store_id, 'other', i.issued_at, $2 from tmpos_invoice_issue.issued_invoice i where i.invoice_id = $1`);
    assert.ok('value' in atIssue, `${tag}: stamped exactly at the issue time is admitted: ${JSON.stringify(atIssue)}`);
    // The voided header: 034's ALWAYS guard refuses its deletion in either mode.
    const del = await run('delete from tmpos_invoice_issue.issued_invoice where invoice_id = $1', [f.inv[0]]);
    assert.equal(del.code, '23001', `${tag}: the voided header's deletion refused by 034's guard: ${JSON.stringify(del)}`);
  }
  for (const [k, [v, message]] of Object.entries(cases)) assert.deepEqual(v, { code: '23001', message }, k);
  // 034's header and line guards lifted (origin) and the lines removed, so only the void record's key references the header:
  // its RESTRICT refuses the header's deletion and its key change; the never-voided header's pass the same way (the control).
  for (const [label, sql] of [['deletion', 'delete from tmpos_invoice_issue.issued_invoice where invoice_id = $1'],
    ['key change', 'update tmpos_invoice_issue.issued_invoice set invoice_id = pg_catalog.gen_random_uuid() where invoice_id = $1']]) {
    const lifted = (invoice) => rolledBack((tx) => withTriggersLifted(tx, ISSUE_GUARDS.slice(0, 2), async () => {
      await tx`delete from tmpos_invoice_issue.issued_invoice_line where invoice_id = ${invoice}`;
      return tx.unsafe(sql, [invoice]);
    }));
    const r = await lifted(f.inv[0]);
    assert.equal(r.code, FK_RESTRICT, `${label} of the voided header with 034's guards lifted: ${JSON.stringify(r)}`);
    assert.match(r.message, /issued_invoice_void_invoice_fkey/, label);
    const control = await lifted(f.inv[1]);
    assert.ok('value' in control, `the control: the never-voided header's ${label} passes: ${JSON.stringify(control)}`);
  }
  assert.deepEqual(await stateOf([f.T, other.T]), before, 'every refused or rolled-back write changed nothing');
  // R-M4 / R-DB-6, through the routine itself (T6): an invoice dated AFTER the database clock (a clock stepped backwards, or a failover
  // to a host behind) cannot be voided — the guard refuses the back-dated record, the routine answers its fixed integrity text, and
  // nothing is written. The fixture is the owner's: a real issued invoice moved into the future with 034's header guard lifted.
  const h = await scene('future', { invoices: 1 });
  const dated = h.inv[0];
  await owner.begin(RC, (tx) => withTriggersLifted(tx, [ISSUE_GUARDS[1]], () => tx`update tmpos_invoice_issue.issued_invoice
    set issued_at = pg_catalog.clock_timestamp() + interval '1 hour' where invoice_id = ${dated}`));
  assert.equal((await owner`select issued_at > pg_catalog.clock_timestamp() as future from tmpos_invoice_issue.issued_invoice where invoice_id = ${dated}`)[0].future, true, 'the fixture is dated after the database clock');
  const beforeFuture = await stateOf([h.T]);
  assert.deepEqual(await errorOf(voidCall(h.kBoss, { store: h.S, invoice: dated, tenant: h.T })),
    { code: '23000', message: 'migration 035 void: the void record is not one the void table admits' }, 'the void raises the fixed integrity text');
  assert.deepEqual(await stateOf([h.T]), beforeFuture, 'nothing written');
  assert.deepEqual(await voidRowOf(dated), [], 'no void record');
  // Negative control: a scratch guard WITHOUT the "not before its issue" rule lets the same void apply (in a rolled-back transaction).
  const [{ def: guardDef }] = await owner`select pg_catalog.pg_get_functiondef(${GUARD_FN}::regprocedure) as def`;
  const lenient = patchOnce(guardDef, ' or new.voided_at < v_issued_at', '');
  assert.deepEqual(await rolledBack(async (tx) => { await tx.unsafe(lenient); return voidCall(h.kBoss, { store: h.S, invoice: dated, tenant: h.T, db: tx }); }),
    { value: APPLIED(h.boss, h.T, h.S, dated) }, 'without the rule the void of a future-dated invoice applies');
  assert.deepEqual(await stateOf([h.T]), beforeFuture, 'and nothing of it remains');
  // The fixture removed: its lines and header, with the guards lifted and put back as found.
  await owner.begin(RC, (tx) => withTriggersLifted(tx, ISSUE_GUARDS.slice(0, 2), async () => {
    await tx`delete from tmpos_invoice_issue.issued_invoice_line where invoice_id = ${dated}`;
    await tx`delete from tmpos_invoice_issue.issued_invoice where invoice_id = ${dated}`;
  }));
  assert.equal((await owner`select (select count(*) from tmpos_invoice_issue.issued_invoice where invoice_id = ${dated})::int as n`)[0].n, 0, 'the fixture is removed');
  assert.deepEqual((await owner`select g.tgrelid::regclass::text as rel, g.tgenabled::text as mode from pg_catalog.pg_trigger g
    where g.tgname in ('trg_issued_invoice_guard', 'trg_issued_invoice_line_guard', 'trg_issued_invoice_void_guard') order by 1`).map((r) => [r.rel, r.mode]),
  [['tmpos_invoice_issue.issued_invoice', 'A'], ['tmpos_invoice_issue.issued_invoice_line', 'A'], ['tmpos_invoice_void.issued_invoice_void', 'A']], 'the guards are ALWAYS again');
});

test('IVR-15 (VOID-10 database part, D-VOID-3): page_v2 and get_v2 answer 034\'s page and get row for row and in 034\'s order (cursors over voided anchors, limits, the sourceDraft filter finding a voided invoice, cursor_unknown, denied readers, another tenant, both anchors raising), plus the lifecycle: \'voided\' with voided_at in o_issued_at\'s encoding (never before it) and the reason code on every line row of a voided invoice, (\'issued\', NULL, NULL) otherwise, NULLs on a refusal row; no read returns the voiding actor', async () => {
  const f = await scene('reads', { invoices: 8 });
  const J = await f.issue(f.S2);
  const other = await scene('reads-other', { invoices: 1 });
  const tech = await member(f, 'reader', 'technician');
  const voided = new Map([[f.inv[0], 'issued_in_error'], [f.inv[2], 'duplicate'], [f.inv[3], 'other'], [f.inv[7], 'wrong_lines_or_amounts']]);
  for (const [invoice, reason] of voided) assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice, tenant: f.T, reason }), APPLIED(f.boss, f.T, f.S, invoice));
  const strip = (rows, extra) => rows.map((r) => { const o = { ...r }; for (const k of extra) delete o[k]; return o; });
  const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
  let compared = 0;
  const pageCase = async (label, key, tenant, store, opts) => {
    const v2 = await page(PAGE_V2_FN, key, tenant, store, opts);
    const old = await page(PAGE_034_FN, key, tenant, store, { ...opts, db: owner });
    assert.deepEqual(strip(v2, ['o_status']), old, `page ${label}: 034's answer`);
    for (const r of v2) assert.equal(r.o_status, r.o_outcome === 'invoice' ? (voided.has(r.o_invoice_id) ? 'voided' : 'issued') : null, `page ${label}: lifecycle`);
    compared += v2.length;
    return v2;
  };
  const all = await pageCase('first page', f.kBoss, f.T, f.S, {});
  assert.deepEqual(all.map((r) => r.o_invoice_id), [...f.inv].reverse(), 'number descending, voided invoices kept in place');
  await pageCase('limit 3', f.kBoss, f.T, f.S, { limit: 3 });
  await pageCase('after a voided anchor', f.kBoss, f.T, f.S, { after: f.inv[3], limit: 2 });
  await pageCase('after an issued anchor', f.kBoss, f.T, f.S, { after: f.inv[5] });
  const found = await pageCase('sourceDraft of a voided invoice', f.kBoss, f.T, f.S, { source: f.issued[2].draft });
  assert.deepEqual(found.map((r) => [r.o_invoice_id, r.o_status]), [[f.inv[2], 'voided']], '?sourceDraft= still finds the voided invoice');
  await pageCase('sourceDraft of an issued invoice', f.kBoss, f.T, f.S, { source: f.issued[1].draft });
  await pageCase('an unknown anchor', f.kBoss, f.T, f.S, { after: randomUUID() });
  await pageCase('another store\'s anchor', f.kBoss, f.T, f.S, { after: J });
  await pageCase('a technician reader (View / View)', tech.key, f.T, f.S, {});
  await pageCase('a bad key', 'bad-key', f.T, f.S, {});
  await pageCase('another tenant', f.kBoss, other.T, f.S, {});
  await pageCase('the other store', f.kBoss2, f.T, f.S2, {});
  for (const extra of [{ after: f.inv[1], source: f.issued[1].draft }, { limit: 0 }, { limit: 52 }]) {
    const a = await errorOf(page(PAGE_V2_FN, f.kBoss, f.T, f.S, extra));
    const b = await errorOf(page(PAGE_034_FN, f.kBoss, f.T, f.S, { ...extra, db: owner }));
    assert.equal(a?.code, '22023', JSON.stringify(extra));
    assert.deepEqual(a, b, `034's own raise: ${JSON.stringify(extra)}`);
  }
  const records = new Map((await owner`select invoice_id, reason_code, to_char(voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
    from tmpos_invoice_void.issued_invoice_void where tenant_id = ${f.T}`).map((r) => [r.invoice_id, r]));
  const getCase = async (label, key, tenant, store, invoice) => {
    const v2 = await getInvoice(GET_V2_FN, key, tenant, store, invoice);
    const old = await getInvoice(GET_034_FN, key, tenant, store, invoice, { db: owner });
    assert.deepEqual(strip(v2, ['o_status', 'o_voided_at', 'o_reason_code']), old, `get ${label}: 034's answer`);
    for (const r of v2) {
      const want = r.o_outcome !== 'line' ? [null, null, null]
        : voided.has(invoice) ? ['voided', records.get(invoice).at, voided.get(invoice)] : ['issued', null, null];
      assert.deepEqual([r.o_status, r.o_voided_at, r.o_reason_code], want, `get ${label}: lifecycle`);
      if (want[0] === 'voided') assert.ok(UTC.test(r.o_voided_at) && r.o_voided_at >= r.o_issued_at, `get ${label}: the encoding, not before the issue`);
      assert.equal(Object.keys(r).some((k) => /voided_by|actor/.test(k)), false, 'no actor column');
    }
    compared += v2.length;
    return v2;
  };
  for (const invoice of f.inv) assert.equal((await getCase(`invoice ${f.inv.indexOf(invoice)}`, f.kBoss, f.T, f.S, invoice)).length, LINES.length);
  await getCase('a voided invoice, read by the technician', tech.key, f.T, f.S, f.inv[0]);
  await getCase('another store\'s invoice', f.kBoss, f.T, f.S, J);
  await getCase('another tenant\'s invoice', f.kBoss, f.T, f.S, other.inv[0]);
  await getCase('a missing invoice', f.kBoss, f.T, f.S, randomUUID());
  await getCase('a bad key', 'bad-key', f.T, f.S, f.inv[0]);
  await setLevel(f.T, 'technician', 'invoices', 'none');
  const denied = await getCase('a reader at Invoices none', tech.key, f.T, f.S, f.inv[0]);
  assert.deepEqual(denied.map((r) => r.o_outcome), ['denied']);
  await pageCase('a reader at Invoices none', tech.key, f.T, f.S, {});
  await clearLevels(f.T);
  assert.ok(compared > 60, `rows compared: ${compared}`);
});

test('IVR-16 (VOID-14 d, R-DB-1, R-M3): 035\'s down refuses (55000, fixed text) while one void record exists, and — the records lifted in a rolled-back transaction — while one store.invoice.void audit record exists alone, each changing nothing (catalog and rows); with neither, it passes (rolled back): one-way after the first void; R-DB-2: a void applied but uncommitted holds the down at its first lock and the void\'s commit then refuses it, and the up and the down take every lock before any check, each with a negative control', async () => {
  const f = await scene('down', { invoices: 1 });
  assert.deepEqual(await voidCall(f.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T }), APPLIED(f.boss, f.T, f.S, f.inv[0]));
  assert.ok((await globalVoids()) >= 1);
  const before = await catalogOf();
  const rows = await stateOf(TENANTS);
  const withVoid = await rolledBack((tx) => tx.unsafe(DOWN_035).simple());
  assert.deepEqual(withVoid, { code: '55000', message: 'migration 035 rollback refused: a void record exists, and a rollback never deletes one' });
  assert.deepEqual(diffKeys(before, await catalogOf()), []);
  assert.deepEqual(await stateOf(TENANTS), rows);
  const auditOnly = await rolledBack(async (tx) => {
    await withTriggersLifted(tx, VOID_GUARDS, () => tx`delete from tmpos_invoice_void.issued_invoice_void`);
    const control = await attempt(tx, (sp) => sp.unsafe(DOWN_035).simple());
    await tx`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
        reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_issued_invoice_id)
      values (${`ivr-audit-${randomUUID()}`}, ${f.boss.id}, 'store', ${f.T}, ${f.S}, 'store.invoice.void', 'void_issued_invoices', 'allow',
        'invoice_void_other', 'Issued invoice voided. Reason: Other reason.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1',
        'durable_compliance_event', ${f.inv[0]})`;
    const refused = await attempt(tx, (sp) => sp.unsafe(DOWN_035).simple());
    return { control, refused };
  });
  assert.equal(auditOnly.value.control, 'accepted', `with neither, the down passes: ${JSON.stringify(auditOnly)}`);
  assert.deepEqual(auditOnly.value.refused, { code: '55000', message: 'migration 035 rollback refused: an audit record of action store.invoice.void exists' });
  assert.deepEqual(diffKeys(before, await catalogOf()), [], 'nothing changed');
  assert.deepEqual(await stateOf(TENANTS), rows);
  assert.equal(Number((await owner`select count(*)::int as n from public.audit_event where action_id = 'store.invoice.void'`)[0].n), 0, 'no void audit record left');
  // R-DB-2 (T1): the down takes its locks BEFORE any check. A void is applied but not committed, so it holds public.store (FOR SHARE) and
  // the other tables; the down in a second owner transaction waits at its FIRST lock, ACCESS EXCLUSIVE on public.store (seen in pg_locks),
  // and so cannot have read the void table; the void commits, and the down — only now past its locks — finds the committed record and
  // refuses with its fixed text, changing nothing. Every void record of this suite is removed first, with the guards lifted as
  // cleanAll lifts them, so the race's record is the only one there is.
  const lifted = (where, arg) => owner.begin(RC, (tx) => withTriggersLifted(tx, VOID_GUARDS,
    () => tx.unsafe(`delete from tmpos_invoice_void.issued_invoice_void where ${where}`, [arg])));
  await lifted('tenant_id = any($1::uuid[])', TENANTS);
  assert.equal(await globalVoids(), 0, 'no void record anywhere: only the race\'s own can refuse the down');
  const clean = await catalogOf();
  const waitsOnStore = async (pid) => (await owner`select exists (select 1 from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted
    and l.locktype = 'relation' and l.relation = 'public.store'::regclass and l.mode = 'AccessExclusiveLock') as w`)[0].w;
  const g = await scene('downrace');
  /** One race of `down` against a held void; the down's outcome once the void has committed (a down that passes is rolled back), and the void's invoice. */
  const raceDown = async (down) => {
    const invoice = await g.issue();
    const voiding = holding(runtime, (tx) => voidCall(g.kBoss, { store: g.S, invoice, tenant: g.T, db: tx }));
    let dropping = null;
    try {
      await until(() => voiding.ready || voiding.out !== undefined, 'the void applied, uncommitted');
      assert.deepEqual(voiding.value, APPLIED(g.boss, g.T, g.S, invoice), 'the void applies');
      dropping = holding(owner, (tx) => tx.unsafe(down).simple());
      await until(() => blockedBy(dropping.pid, voiding.pid), 'the down waits behind the uncommitted void');
      assert.deepEqual(await waitsFor(dropping.pid), [['relation', 'AccessExclusiveLock']], 'on an ACCESS EXCLUSIVE lock request');
      assert.equal(await waitsOnStore(dropping.pid), true, 'on public.store, the first lock of its block');
      assert.equal(dropping.out, undefined, 'it has not answered');
      voiding.release('commit');
      finished(await voiding.done, 'the void');
      await until(() => dropping.ready || dropping.out !== undefined, 'the down answered');
      return { invoice, down: dropping.ready ? 'passed' : dropping.out };
    } finally { await settle(voiding, dropping); }
  };
  const raced = await raceDown(DOWN_035);
  assert.deepEqual(raced.down, { outcome: 'failed', code: '55000', message: 'migration 035 rollback refused: a void record exists, and a rollback never deletes one' },
    'the committed void refuses the down that waited for it');
  assert.deepEqual(diffKeys(clean, await catalogOf()), [], 'the catalog is unchanged');
  assert.deepEqual((await voidRowOf(raced.invoice)).map((r) => r.voided_by), [g.boss.id], 'and the void is still there');
  await lifted('invoice_id = $1', raced.invoice);
  assert.equal(await globalVoids(), 0, 'the race\'s record removed');
  // Negative control: the same down with its void-record check moved ABOVE the lock block is not refused — it passes its check before the void
  // commits and would drop 035 over a committed record (run in a transaction that is rolled back) — and the static order check fails on it.
  const VOID_CHECK = /  if exists \(select 1 from tmpos_invoice_void\.issued_invoice_void\) then[\s\S]*?end if;\n/;
  assert.match(DOWN_035, VOID_CHECK);
  const check = VOID_CHECK.exec(DOWN_035)[0];
  const DOWN_CHECK_FIRST = patchOnce(patchOnce(DOWN_035, check, ''), 'set local row_security = off;\n', `set local row_security = off;\ndo $$\nbegin\n${check}end\n$$;\n`);
  const moved = await raceDown(DOWN_CHECK_FIRST);
  assert.equal(moved.down, 'passed', 'the down with its check first is not refused by the void it waited for');
  await lifted('invoice_id = $1', moved.invoice);
  assert.equal(await globalVoids(), 0, 'the control\'s record removed');
  assert.deepEqual(diffKeys(clean, await catalogOf()), [], 'the control rolled back: the catalog is unchanged');
  assert.deepEqual((await owner`select g.tgenabled::text as mode from pg_catalog.pg_trigger g where g.tgrelid = ${VOID_TABLE}::regclass and not g.tgisinternal order by g.tgname::text`).map((r) => r.mode),
    ['A', 'A'], 'the void table\'s guards are ALWAYS again');

  // STATIC, for the up and the down alike: the lock block is the first statement after the settings — no read or check before it — and holds
  // nothing but its locks, in the writers' order, and the handler that turns a missing table or schema into the file's refusal; no other
  // LOCK statement exists; every check comes after it (034's invoiceDraftRoutine / invoiceDraftDiscardRoutine form).
  const statements = (file) => file.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
  const WRITERS = ['public.store', 'tmpos_role.tenant_role_level', 'tmpos_role_edit.role_level_version', 'tmpos_customer.customer', 'tmpos_invoice_draft.invoice_draft',
    'tmpos_invoice_draft.invoice_draft_line', 'tmpos_invoice_issue.store_issuing_settings', 'tmpos_invoice_issue.store_invoice_counter', 'tmpos_invoice_issue.issued_invoice',
    'tmpos_invoice_issue.issued_invoice_line'];
  const UP_LOCKS = [...WRITERS, 'public.audit_event'];
  const DOWN_LOCKS = [...WRITERS, VOID_TABLE, 'public.audit_event'];
  const locksBeforeChecks = (label, file, order, raise, checks) => {
    const want = ['set local search_path = pg_catalog, pg_temp;', 'set local row_security = off;', 'do $$', 'begin', ...order.map((rel) => `  lock table ${rel} in access exclusive mode;`),
      'exception', '  when undefined_table or invalid_schema_name then', raise, "      using errcode = 'object_not_in_prerequisite_state';", 'end', '$$;'];
    const got = statements(file).slice(0, want.length);
    want.forEach((line, i) => (line instanceof RegExp ? assert.match(got[i], line, `${label}, statement ${i}`) : assert.equal(got[i], line, `${label}, statement ${i}`)));
    const code = file.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    const locks = [...code.matchAll(/^ *lock table ([a-z_.]+) in access exclusive mode;$/gm)];
    assert.deepEqual(locks.map((m) => m[1]), order, `${label}: exactly these locks, and no other LOCK statement`);
    assert.equal([...code.matchAll(/\block table\b/gi)].length, order.length, `${label}: no LOCK statement in another form`);
    const blockEnd = code.indexOf('\n$$;\n', locks.at(-1).index);
    assert.ok(blockEnd > 0, `${label}: the lock block ends`);
    for (const c of checks) assert.ok(code.indexOf(c) > blockEnd, `${label}: ${c} comes after the locks`);
  };
  const UP_RAISE = /^ {4}raise exception 'migration 035 refused: [^']* is missing \(migrations 002, 017, 020, 021, 028 and 034 must be applied first\)'$/;
  const DOWN_RAISE = /^ {4}raise exception 'migration 035 rollback refused: migration 035 is not applied \([^']*\)'$/;
  const UP_CHECKS = ['transaction_isolation', 'to_regnamespace(', 'to_regprocedure(', 'pg_get_constraintdef', 'pg_trigger', 'has_function_privilege(', 'pg_has_role(', 'already exists'];
  const DOWN_CHECKS = ['to_regnamespace(', 'to_regprocedure(', 'pg_trigger', 'transaction_isolation', 'exists (select 1 from tmpos_invoice_void.issued_invoice_void)', "a.action_id = 'store.invoice.void'"];
  locksBeforeChecks('the up', UP_035, UP_LOCKS, UP_RAISE, UP_CHECKS);
  locksBeforeChecks('the down', DOWN_035, DOWN_LOCKS, DOWN_RAISE, DOWN_CHECKS);
  assert.throws(() => locksBeforeChecks('the down with its void check first', DOWN_CHECK_FIRST, DOWN_LOCKS, DOWN_RAISE, DOWN_CHECKS), assert.AssertionError,
    'the static order check fails on the down whose check comes first');
});
