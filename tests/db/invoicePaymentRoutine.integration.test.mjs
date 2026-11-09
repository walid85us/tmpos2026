// Phase 4.0 M7B-PAYMENTS-P1 — recording payments against an issued store invoice against REAL PostgreSQL: migration 036
// (schema tmpos_invoice_payment: the append-only payment and reversal records and their ENABLE ALWAYS guards, the record and
// reverse routines that write their own audit record, the replacement void m7b_invoice_void_v2, the payments read, the audit
// table's payment subject and card-data CHECK, and the rollback-order anchor), exercised as the runtime's own non-owner login,
// every call bound as a production adapter binds it (every bigint as decimal text). Each title names the PAY ids of
// docs/phase-4/15 §12.8 it evidences.
//
// WHAT IS PROVEN.
//   IPR-01 (PAY-13) 001-036 by the trusted executor (036 applied on its own over 035), the ledger exactly 001-036 and equal to
//          the startup preflight's pinned chain, 036's checksum its up bytes; the postcondition re-run holds and refuses each
//          widening it names with its exact message; a second up refused with its fixed text, changing nothing.
//   IPR-02 (PAY-13) the up refuses every wrong predecessor it names with its own fixed text (035 absent, 035's void ACL
//          widened or narrowed, a card-data key already in audit metadata, the audit column already present, outside READ
//          COMMITTED), changing nothing; it judges objects only (R-GATE-2): a ledger without 035's row over 035's exact
//          objects applies.
//   IPR-03 (PAY-13) 035's down while 036 is applied fails 2BP01; 036's down outside READ COMMITTED refused; a clean 036 down
//          restores 035's catalog exactly (035's void ACL owner + tmpos_app again), equal to a FRESH 035 apply's, and tmpos_app
//          executes 035's void again; 036 re-applies to the first apply's catalog. The anchor names only 035's void and v2 get.
//   IPR-04 (PAY-13) the exact surface: function ACLs, the tables' privileges and row security; the login refused (42501) on
//          both tables, the guards, the anchor and 035's void.
//   IPR-05 (PAY-02 PAY-07) the authority matrix on stored levels (Invoices >= Approve AND Customers >= View) for the record
//          and the reversal, the decision order (a level refusal before tenant_mismatch before not_found) and isolation:
//          another store's, another tenant's and a missing invoice are one not_found; nothing written by any refusal.
//   IPR-06 (PAY-01 PAY-07 PAY-10) the arithmetic (full, partial, mixed methods, Total 0, the 9007199254740991 bound in numeric),
//          the exact delta of an applied record (one payment, one audit record, no outbox or idempotency row) and every
//          argument refusal's fixed text, raised before anything is read.
//   IPR-07 (PAY-04) precedence after the header lock: already_recorded before invalid_state before amount_exceeds_remaining;
//          an attempt is already_recorded after its payment's reversal and on a voided invoice; the same attempt on another
//          invoice is independent.
//   IPR-08 (PAY-03 PAY-07) the reversal: not_found for another invoice's or a missing payment, invalid_state once reversed
//          (also for version 2), conflict for version 2 on an active payment, version 2 answered when applied, argument
//          refusals; one reversal per payment.
//   IPR-09 (PAY-02) the reversal's recent sign-in at the routine (live, and its own predicate at a fixed clock: exactly 600000
//          ms holds, 600001 refuses, 5000 ms ahead holds, 5001 refuses, NULL refuses); the record needs no recent sign-in.
//   IPR-10 (PAY-12) m7b_invoice_void_v2 refuses payments_recorded while an unreversed payment exists (before the version),
//          voids once every payment is reversed, invalid_state on a voided invoice; a record on it is invalid_state.
//   IPR-11 (PAY-07 PAY-08) exactly one audit record per applied record and reversal with §12.4's values, none on a refusal.
//   IPR-12 (PAY-08) an owner BEFORE INSERT trigger on audit_event that returns NULL, or raises, makes the record and the
//          reversal raise and commits no payment or reversal.
//   IPR-13 (PAY-06) REPEATABLE READ and SERIALIZABLE refused (55000) by the record, the reversal and the void v2 before
//          anything is read.
//   IPR-14 (PAY-05) two sessions recording against one invoice behind a third session's header lock: exactly one applied,
//          the other amount_exceeds_remaining; record vs void in both orders, each wait seen on the issued header.
//   IPR-15 (PAY-03) the guards as the table owner, normal and replica: UPDATE, DELETE and TRUNCATE refused; back-dated and
//          foreign-scope inserts refused; stamped exactly at the issue (or the recording) admitted.
//   IPR-16 (PAY-11) the payments read: denied, not_found, cursor_unknown, a null-cursor read with payments present, totals over
//          the complete history across pages, the five status words, the empty page, the limit's range, no staff id; a voided
//          invoice holding an unreversed payment and unreversed payments above the Total raise XX001 (built rolled back).
//   IPR-17 (PAY-14) the audit CHECK refuses the metadata keys cvv, cvc, track1, track2 and pinBlock.
//   IPR-18 (PAY-13) 036's down refuses, changing nothing, with one payment, with a reversal alone, with a payment-action audit
//          record alone and with an audit record naming a payment alone; with none it passes (rolled back).
//   IPR-19 (PAY-02) edited grants after a wait: the manager's record and reversal take the issued header, then wait SHARED on
//          key 530030 held EXCLUSIVE by an uncommitted level narrowing; it commits and the re-read refuses, nothing written.
//   IPR-20 (PAY-02) a session that expires while the record waits on the issued header: refused after the wait, nothing written.
//   IPR-21 (PAY-02) session and standing changes at a direct call: an expired session, a suspended account and a suspended
//          membership refuse the record and the reversal, nothing written (each actor's record and reversal applied before).
//
// NOT PROVEN HERE: the HTTP command path (idempotency, replay, completion, the chain's step-up) is invoicePaymentHttp's.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys. Every fixture is synthetic and randomly suffixed. On a shared service it rolls 036 back at setup
// through its own committed down (which refuses over any payment evidence) and re-applies it by the trusted executor. It leaves
// 001-036 applied and recorded, every guard trigger ALWAYS, the issuer key row it found, and NO payment, reversal, payment
// audit record, void record, settings, counter, issued invoice, draft, role row, session, mint-ledger row, scratch schema or
// login of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { portThrough, rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { TENANT_ORDERING, TENANT_ROLE_PERMISSION_DEFAULTS } from '../../server/platform-identity/permissionCatalog.ts';
import { REQUIRED_MIGRATIONS } from '../../server/persistence/postgresStartupPreflight.ts';
import { principalKeyOf, RECENT_AUTH_MAX_AGE_MS } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const mig = (name) => readFileSync(`${MIG_DIR}/${name}`, 'utf8');
const DOWN_035 = mig('035_m7b_invoice_void.down.sql');
const UP_036 = mig('036_m7b_invoice_payment.up.sql');
const DOWN_036 = mig('036_m7b_invoice_payment.down.sql');
const SHA_UP_036 = createHash('sha256').update(readFileSync(`${MIG_DIR}/036_m7b_invoice_payment.up.sql`)).digest('hex');
/** The up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_036 = UP_036.slice(UP_036.lastIndexOf('do $$'));

const NS = 'tmpos_invoice_payment';
const RECORD_FN = `${NS}.m7b_invoice_payment_record`;
const REVERSE_FN = `${NS}.m7b_invoice_payment_reverse`;
const VOID2_FN = `${NS}.m7b_invoice_void_v2`;
const READ_FN = `${NS}.m7b_invoice_payments_get`;
const RECORD = `${RECORD_FN}(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)`;
const REVERSE = `${REVERSE_FN}(text, uuid, uuid, uuid, uuid, bigint, text, uuid)`;
const VOID2 = `${VOID2_FN}(text, uuid, uuid, uuid, bigint, text)`;
const READ = `${READ_FN}(text, uuid, uuid, uuid, uuid, integer)`;
const ROUTINES = [RECORD, REVERSE, VOID2, READ];
const ANCHOR = `${NS}.m7b_invoice_payment_prerequisites()`;
const GUARDS = [`${NS}.m7b_invoice_payment_guard()`, `${NS}.m7b_invoice_payment_truncate_guard()`,
  `${NS}.m7b_invoice_payment_reversal_guard()`, `${NS}.m7b_invoice_payment_reversal_truncate_guard()`];
const PAY_TABLE = `${NS}.invoice_payment`;
const REV_TABLE = `${NS}.invoice_payment_reversal`;
const VOID_035_FN = 'tmpos_invoice_void.m7b_invoice_void';
const VOID_035 = `${VOID_035_FN}(text, uuid, uuid, uuid, bigint, text)`;
const GET_V2 = 'tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)';
const ISSUE_FN = 'tmpos_invoice_issue.m7b_invoice_issue';
const SETTINGS_SET_FN = 'tmpos_invoice_issue.m7b_issuing_settings_set';
const CREATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_create_v3';
const MIGRATOR = { purpose: 'migration', migratorRef: 'ipr-migrator', runtimeRef: 'ipr-runtime' };
const LOCK_KEY = 529_636;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ipr_probe';
/** The scratch schema of IPR-12's audit triggers: never 036 itself. */
const NC = `ipr_nc_${SUFFIX}`;
const HOUR = 3_600_000;
const ROLLBACK = new Error('ipr: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
/** sessions.ts MAX_CLOCK_SKEW_MS (not exported): a sign-in at most this far ahead of the clock is not taken as tampered. */
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX = 9007199254740991n;
const EDITABLE = ['manager', 'technician', 'sales_staff'];
const LEVELS = [...TENANT_ORDERING];
const PAYMENT_GUARDS = [[PAY_TABLE, 'trg_invoice_payment_guard'], [REV_TABLE, 'trg_invoice_payment_reversal_guard']];
const VOID_GUARDS = [['tmpos_invoice_void.issued_invoice_void', 'trg_issued_invoice_void_guard']];
const ISSUE_GUARDS = [['tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_guard'], ['tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_guard'],
  ['tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_guard'], ['tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_guard']];
const AUDIT_TRIGGER = [['public.audit_event', 'trg_audit_event_reject_mutation']];
const DRAFT_TERMINAL = [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']];
const PAYMENT_ACTIONS = ['store.invoice_payment.record', 'store.invoice_payment.reverse'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WIRE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

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

const TARGET = resolveDisposableTarget('IPR');
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
const applied036 = async () => (await owner`select pg_catalog.to_regnamespace(${NS}) is not null as e`)[0].e;
/** A committed down with its ledger row (migrationsThrough.mjs rollBackAbove's shape). */
const downCommitted = (file, version) => owner.begin(RC, async (tx) => {
  await tx.unsafe(file).simple();
  await tx`delete from public.schema_migrations where version = ${version}`;
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
/** Everything this suite wrote: payment audit records, reversals and payments first, then void records, issuing rows, drafts and role rows. */
async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    await withTriggersLifted(sql, AUDIT_TRIGGER, () => sql`delete from public.audit_event where tenant_id = any(${TENANTS}::uuid[])`);
    if ((await sql`select pg_catalog.to_regclass(${PAY_TABLE}) is not null as e`)[0].e) {
      await withTriggersLifted(sql, PAYMENT_GUARDS, async () => {
        await sql`delete from tmpos_invoice_payment.invoice_payment_reversal where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_payment.invoice_payment where tenant_id = any(${TENANTS}::uuid[])`;
      });
    }
    await withTriggersLifted(sql, VOID_GUARDS, () => sql`delete from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${TENANTS}::uuid[])`);
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
/** Every payment evidence in the whole database (036's rollback needs none). */
async function globalPayments() {
  if (!(await applied036())) return { payments: 0, reversals: 0, audits: 0 };
  const [r] = await owner`select (select count(*) from tmpos_invoice_payment.invoice_payment)::int as payments,
    (select count(*) from tmpos_invoice_payment.invoice_payment_reversal)::int as reversals,
    (select count(*) from public.audit_event where action_id = any(${PAYMENT_ACTIONS}::text[]) or subject_invoice_payment_id is not null)::int as audits`;
  return { ...r };
}
const NO_PAYMENTS = Object.freeze({ payments: 0, reversals: 0, audits: 0 });

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    await step(async () => {
      await owner.unsafe('drop trigger if exists ipr_audit_fault on public.audit_event');
      await owner.unsafe(`drop schema if exists ${NC} cascade`);
    });
    // A failed migration case may have left 036 (or 035) rolled back: the executor applies it again.
    await step(async () => {
      if (!(await ledgerHas('036'))) {
        const report = await trustedApply('036');
        assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
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
    // CI runs every database suite on ONE service, and 036's down refuses over any payment evidence — none is left.
    await step(async () => {
      const [state] = await owner`select
          (select pg_catalog.string_agg(version, ',' order by version) from public.schema_migrations) as ledger,
          (select pg_catalog.string_agg(t.v, ',' order by t.v collate "C") from (select g.tgrelid::regclass::text || '.' || g.tgname::text || ':' || g.tgenabled::text as v
             from pg_catalog.pg_trigger g where not g.tgisinternal and g.tgrelid = any (array['tmpos_invoice_payment.invoice_payment'::regclass,
               'tmpos_invoice_payment.invoice_payment_reversal'::regclass, 'tmpos_invoice_void.issued_invoice_void'::regclass,
               'tmpos_invoice_issue.issued_invoice'::regclass]::oid[])) t) as triggers,
          (select count(*) from tmpos_invoice_payment.invoice_payment)::int as payments_anywhere,
          (select count(*) from tmpos_invoice_payment.invoice_payment_reversal)::int as reversals_anywhere,
          (select count(*) from public.audit_event where action_id = any(${PAYMENT_ACTIONS}::text[]) or subject_invoice_payment_id is not null)::int as payment_audits_anywhere,
          (select count(*) from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${TENANTS}::uuid[]))::int as voids,
          (select count(*) from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[]))::int as invoices,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where tenant_id = any(${TENANTS}::uuid[]))::int as audits,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as roles,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          exists (select 1 from pg_catalog.pg_trigger where tgname = 'ipr_audit_fault') as fault,
          pg_catalog.to_regnamespace(${NC}) is null as no_scratch,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, {
        ledger: Array.from({ length: 36 }, (_, i) => String(i + 1).padStart(3, '0')).join(','),
        triggers: ['tmpos_invoice_payment.invoice_payment.trg_invoice_payment_guard:A', 'tmpos_invoice_payment.invoice_payment.trg_invoice_payment_truncate:A',
          'tmpos_invoice_payment.invoice_payment_reversal.trg_invoice_payment_reversal_guard:A', 'tmpos_invoice_payment.invoice_payment_reversal.trg_invoice_payment_reversal_truncate:A',
          'tmpos_invoice_void.issued_invoice_void.trg_issued_invoice_void_guard:A', 'tmpos_invoice_void.issued_invoice_void.trg_issued_invoice_void_truncate:A',
          'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_commit_check:A', 'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_guard:A',
          'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_truncate:A'].sort().join(','),
        payments_anywhere: 0, reversals_anywhere: 0, payment_audits_anywhere: 0, voids: 0, invoices: 0, drafts: 0, audits: 0, roles: 0, sessions: 0,
        fault: false, no_scratch: true, login: false,
      }, 'left as found: 001-036 applied and recorded, every guard ALWAYS, no payment evidence anywhere, nothing of this suite\'s retained');
    });
    await step(() => above036.restore());
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IPR teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: 035 (a shared service's 036 rolled back through its own down), the catalog at 035, then 036 by the trusted executor
// ---------------------------------------------------------------------------

/** A top-level setup step: a failed step stops the cluster here, then rethrows (a top-level throw skips the exit handlers). */
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

let above036;
let ME;
await setupStep(async () => {
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
  await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
  // Anything above 036 (none today) is rolled back and restored by the teardown; a shared service's 036 is rolled back here and
  // applied again below (its down refuses, failing the suite loudly, if an earlier step left payment evidence).
  above036 = await rollBackAbove(owner, MIG_DIR, '036');
  if (await applied036()) await downCommitted(DOWN_036, '036');
  const apply035 = await trustedApply('035');
  assert.equal(apply035.outcome, 'complete', JSON.stringify(apply035).slice(0, 300));
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

/** The catalog of every object 034, 035 and 036 touch, oid-free. */
async function catalogOf() {
  const [r] = await owner`with rels as (
      select c.oid from pg_catalog.pg_class c
       where c.oid = any (array['tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass, 'public.store'::regclass,
                               'tmpos_customer.customer'::regclass, 'public.audit_event'::regclass, 'public.tenant'::regclass]::oid[])
          or c.relnamespace = pg_catalog.to_regnamespace('tmpos_invoice_issue') or c.relnamespace = pg_catalog.to_regnamespace('tmpos_invoice_void')
          or c.relnamespace = pg_catalog.to_regnamespace('tmpos_invoice_payment'))
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
                  order by a.attrelid::regclass::text collate "C", a.attname collate "C") from pg_catalog.pg_attribute a
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
    -- A toast table's name carries its table's oid (pg_toast_<oid>): masked, so a fresh apply compares equal.
    'depends_on_034_035', (select pg_catalog.jsonb_agg(x.v order by x.v collate "C") from (
                         select pg_catalog.regexp_replace((pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)).identity, '^pg_toast\\.pg_toast_[0-9]+$', 'pg_toast.pg_toast_<oid>') || ' -> '
                                || (pg_catalog.pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).identity || ':' || d.deptype::text as v
                           from pg_catalog.pg_depend d
                          where ((d.refclassid = 'pg_catalog.pg_proc'::regclass and d.refobjid in (select p.oid from pg_catalog.pg_proc p
                                    where p.pronamespace in (pg_catalog.to_regnamespace('tmpos_invoice_issue'), pg_catalog.to_regnamespace('tmpos_invoice_void'))))
                                 or (d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid in (select c.oid from pg_catalog.pg_class c
                                    where c.relnamespace in (pg_catalog.to_regnamespace('tmpos_invoice_issue'), pg_catalog.to_regnamespace('tmpos_invoice_void')))))
                            and (pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)).schema is distinct from (pg_catalog.pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).schema) x),
    'ledger', (select pg_catalog.string_agg(version || ':' || checksum || ':' || dirty::text, ',' order by version) from public.schema_migrations)
  ) as snap`;
  return r.snap;
}
const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

const [S035, PAYMENTS_AT_SETUP, applyReport, S036] = await setupStep(async () => {
  const at035 = await catalogOf();
  const report = await trustedApply('036'); // through 036 only: 037 (M7B-PAYMENTS-P2) revokes the v1 record this suite proves; rollBackAbove restores it
  return [at035, await globalPayments(), report, await catalogOf()];
});

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ipr-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IPR ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `ipr-${label}-${SUFFIX}`;
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
  securityVersion: 't2:ipr', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
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
/** The database clock in epoch ms (floored), the one the routines judge by. */
const dbNowMs = async () => Number((await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint::text as t`)[0].t);
/** Sets a session row's sign-in time as the owner: epoch ms, or NULL. */
const setAuth = (key, at) => owner`update tmpos_session.session set authenticated_at = ${at === null ? null : String(at)}::bigint where session_key = ${key}`;

const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const sumOf = (lines) => lines.reduce((s, l) => s + BigInt(l.quantity) * BigInt(l.unitPriceCents), 0n);
const LINES = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 2, 4_500), line('Tempered glass', 3, 0)];
const SETTINGS = Object.freeze({ legalName: 'IPR Legal Name LLC', storeName: 'IPR Store', postalAddress: '1 Main St\nSuite 2\nSpringfield',
  taxRegistrationId: 'TAX-IPR-1', taxMode: 'exclusive_rate', taxRate: 8875 });
async function settingsSet(key, store, tenant, { taxMode = SETTINGS.taxMode, taxRate = SETTINGS.taxRate } = {}) {
  const [row] = await runtime.unsafe(`select o_outcome from ${SETTINGS_SET_FN}($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
    [key, store, tenant, '0', SETTINGS.legalName, SETTINGS.storeName, SETTINGS.postalAddress, SETTINGS.taxRegistrationId, taxMode, taxRate]);
  assert.equal(row.o_outcome, 'applied', 'the store\'s issuing settings, version 1');
}
/** 032's save then 034's issue, as their mutators bind them: the issued invoice id. */
async function issueOne(key, store, tenant, customer, lines = LINES) {
  const draft = randomUUID();
  const [c] = await runtime.unsafe(`select o_outcome from ${CREATE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [key, store, draft, tenant, customer, JSON.stringify(lines), String(sumOf(lines))]);
  assert.equal(c.o_outcome, 'applied', 'the draft saved');
  const invoice = randomUUID();
  const [i] = await runtime.unsafe(`select o_outcome from ${ISSUE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [key, store, draft, tenant, '1', '1', '1', invoice]);
  assert.equal(i.o_outcome, 'applied', 'the draft issued');
  return invoice;
}
/**
 * A fresh tenant with two stores and a customer; a store owner per store, a manager at the first store and a tenant owner
 * (a tenant grant, for the settings), each with a live session; both stores' settings written; `invoices` issued at the
 * first store by its owner. `f.issue(store, lines)` issues one more.
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
  f.issue = (store = S, lines = LINES) => issueOne(store === S ? f.kBoss : f.kBoss2, store, T, C, lines);
  f.inv = [];
  for (let i = 0; i < invoices; i += 1) f.inv.push(await f.issue());
  return f;
}
/** Another actor of `role` at the scene's first store, with a live session of its own. */
async function member(f, label, role) {
  const who = await actor(`${f.label}-${label}-${role}`, [storeGrant(f.T, f.S, role)]);
  return { who, key: await mint(who) };
}
const totalOf = async (invoice) => BigInt((await owner`select total_cents::text as t from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice}`)[0].t);

// ---------------------------------------------------------------------------
// the runtime login's calls, bound as the production adapters bind them
// ---------------------------------------------------------------------------

const RECORD_COLS = 'o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_payment_id, o_invoice_id, o_audit_event_id';
const REVERSE_COLS = 'o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_payment_id, o_audit_event_id';
const VOID_COLS = 'o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id';
const READ_KEYS = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_status', 'o_currency', 'o_total_cents', 'o_due_cents', 'o_applied_cents',
  'o_remaining_cents', 'o_payment_status', 'o_payment_id', 'o_attempt_id', 'o_amount_cents', 'o_method', 'o_recorded_at', 'o_reversed_at', 'o_reason_code'];
/** The record, as its mutator binds it: the amount as decimal text. */
async function recordCall(key, { store, invoice, tenant, payment = randomUUID(), attempt = randomUUID(), amount, method = 'cash', corr = randomUUID(), db = runtime }) {
  return (await db.unsafe(`select ${RECORD_COLS} from ${RECORD_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8::text, $9::uuid)`,
    [key, store, invoice, tenant, payment, attempt, amount === null ? null : String(amount), method, corr])).map((r) => ({ ...r }));
}
async function reverseCall(key, { store, invoice, payment, tenant, version = 1, reason = 'recorded_in_error', corr = randomUUID(), db = runtime }) {
  return (await db.unsafe(`select ${REVERSE_COLS} from ${REVERSE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::text, $8::uuid)`,
    [key, store, invoice, payment, tenant, version === null ? null : String(version), reason, corr])).map((r) => ({ ...r }));
}
async function void2Call(key, { store, invoice, tenant, version = 1, reason = 'issued_in_error', db = runtime, fn = VOID2_FN }) {
  return (await db.unsafe(`select ${VOID_COLS} from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`,
    [key, store, invoice, tenant, version === null ? null : String(version), reason])).map((r) => ({ ...r }));
}
async function readCall(key, { tenant, store, invoice, after = null, limit = 51, db = runtime }) {
  return (await db.unsafe(`select * from ${READ_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [key, tenant, store, invoice, after, limit === null ? null : limit])).map((r) => ({ ...r }));
}
const NO_REC = (word) => [{ o_outcome: word, o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_payment_id: null, o_invoice_id: null, o_audit_event_id: null }];
const NO_REV = (word) => [{ o_outcome: word, o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: null, o_payment_id: null, o_audit_event_id: null }];
const NO_VOID = (word) => [{ o_outcome: word, o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: null, o_invoice_id: null }];
const VOIDED = (who, tenant, store, invoice) => [{ o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id,
  o_membership_id: who.memberships[0], o_version: '2', o_invoice_id: invoice }];
/** An applied record's row: every value but the audit event id exact, that one a canonical uuid; answers the event id. */
function assertRecorded(rows, who, tenant, store, payment, invoice, label = 'applied') {
  assert.equal(rows.length, 1, label);
  const { o_audit_event_id: event, ...rest } = rows[0];
  assert.deepEqual(rest, { o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id, o_membership_id: who.memberships[0],
    o_payment_id: payment, o_invoice_id: invoice }, label);
  assert.match(event, UUID_RE, `${label}: the audit event id`);
  return event;
}
function assertReversed(rows, who, tenant, store, payment, label = 'reversed') {
  assert.equal(rows.length, 1, label);
  const { o_audit_event_id: event, ...rest } = rows[0];
  assert.deepEqual(rest, { o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id, o_membership_id: who.memberships[0],
    o_version: '2', o_payment_id: payment }, label);
  assert.match(event, UUID_RE, `${label}: the audit event id`);
  return event;
}
/** Records `amount` at the scene's first store as `who` (the store owner by default): answers the ids. */
async function pay(f, invoice, amount, { who = f.boss, key = f.kBoss, method = 'cash', attempt = randomUUID(), store = f.S } = {}) {
  const payment = randomUUID();
  const corr = randomUUID();
  const event = assertRecorded(await recordCall(key, { store, invoice, tenant: f.T, payment, attempt, amount, method, corr }), who, f.T, store, payment, invoice);
  return { payment, attempt, corr, event };
}
async function unpay(f, invoice, payment, { who = f.boss, key = f.kBoss, reason = 'recorded_in_error' } = {}) {
  const corr = randomUUID();
  const event = assertReversed(await reverseCall(key, { store: f.S, invoice, payment, tenant: f.T, reason, corr }), who, f.T, f.S, payment);
  return { corr, event };
}
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
const paymentsOf = async (invoice) => (await owner`select p.payment_id, p.attempt_id, p.amount_cents::text as amount, p.method, p.recorded_by,
    to_char(p.recorded_at at time zone 'UTC', ${UTC_FORMAT}) as at, r.reason_code, r.reversed_by
  from tmpos_invoice_payment.invoice_payment p left join tmpos_invoice_payment.invoice_payment_reversal r on r.payment_id = p.payment_id
  where p.invoice_id = ${invoice} order by p.recorded_at, p.payment_id`).map((r) => ({ ...r }));
const auditOf = async (payment) => (await owner`select pg_catalog.to_jsonb(a) as j from public.audit_event a where a.subject_invoice_payment_id = ${payment} order by a.occurred_at, a.event_id`).map((r) => r.j);

/** Every row a payment routine could touch, exactly (row, xmin, ctid; a write moves xmin and ctid), and every global append-only count. */
async function stateOf(tenants) {
  const q = async (rel, where = 'r.tenant_id = any($1::uuid[])', arg = tenants) => ((await owner`select pg_catalog.to_regclass(${rel}) is not null as e`)[0].e
    ? (await owner.unsafe(`select pg_catalog.to_jsonb(r)::text as row, r.xmin::text as xmin, r.ctid::text as ctid from ${rel} r where ${where} order by 1`, [arg]))
      .map((x) => `${x.row} ${x.xmin} ${x.ctid}`)
    : []);
  const [c] = await owner`select (select count(*) from public.audit_event)::int as audits_anywhere,
    (select count(*) from tmpos_internal.outbox_event)::int as events_anywhere,
    (select count(*) from tmpos_internal.idempotency_record)::int as records_anywhere`;
  return {
    drafts: await q('tmpos_invoice_draft.invoice_draft'), roles: await q('tmpos_role.tenant_role_level'),
    invoices: await q('tmpos_invoice_issue.issued_invoice'), invoiceLines: await q('tmpos_invoice_issue.issued_invoice_line'),
    counters: await q('tmpos_invoice_issue.store_invoice_counter'), voids: await q('tmpos_invoice_void.issued_invoice_void'),
    payments: await q(PAY_TABLE), reversals: await q(REV_TABLE), audits: await q('public.audit_event'),
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
  const SP = new Error('ipr: roll the savepoint back');
  try {
    await tx.savepoint(async (sp) => { await fn(sp); throw SP; });
  } catch (err) {
    if (err === SP) return 'accepted';
    return { code: err.code, message: String(err.message) };
  }
  return 'unreachable';
}
const asTmposApp = (sql, params) => rolledBack(async (tx) => { await tx`set local role tmpos_app`; return (await tx.unsafe(sql, params)).map((r) => ({ ...r })); });
const asLogin = (sql, params) => errorOf(runtime.unsafe(sql, params));

// ---------------------------------------------------------------------------
// race levers: polling on observable lock state, never on time
// ---------------------------------------------------------------------------

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
const blockers = async (pid) => (pid === null ? [] : (await owner`select pg_catalog.pg_blocking_pids(${pid}) as b`)[0].b);
const blockedBy = async (pid, holder) => holder !== null && (await blockers(pid)).includes(holder);
const rowWaitOn = async (pid) => (await owner`select l.relation::regclass::text as rel from pg_catalog.pg_locks l
  where l.pid = ${pid} and l.locktype = 'tuple'`).map((r) => r.rel);
/** 030's guard key class, as 034's issue and 036's routines take it. */
const GUARD_CLASS = 530_030;
const waitsFor = async (pid) => (await owner`select l.locktype::text as locktype, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted order by 1, 2`).map((r) => [r.locktype, r.mode]);
const advisoryWait = async (pid) => (await owner`select l.classid::int as class, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted and l.locktype = 'advisory'`).map((r) => ({ ...r }));
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
const grantsOf = async (signature) => (await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.grantor::regrole::text as grantor, g.is_grantable as grantable
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${signature}::regprocedure`)
  .map((x) => ({ ...x })).sort((a, b) => (`${a.grantee}/${a.priv}` < `${b.grantee}/${b.priv}` ? -1 : 1));
const EXECUTE_BY = (...grantees) => grantees.map((grantee) => ({ grantee, priv: 'EXECUTE', grantor: ME, grantable: false }))
  .sort((a, b) => (a.grantee < b.grantee ? -1 : 1));

const T_OTHER = await setupStep(async () => {
  assert.deepEqual(Object.fromEntries(EDITABLE.map((r) => [r, [TENANT_ROLE_PERMISSION_DEFAULTS[r].invoices, TENANT_ROLE_PERMISSION_DEFAULTS[r].customers]])),
    { manager: ['full', 'full'], technician: ['view', 'view'], sales_staff: ['create', 'create'] }, 'the catalog\'s Invoices and Customers defaults the cases rely on');
  assert.deepEqual(LEVELS, ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'], 'the catalog\'s ordering');
  return newTenant('other');
});

// ===========================================================================
// IPR-01..04: the migration, its rollback and its surface
// ===========================================================================

test('IPR-01 (PAY-13): 001-036 applied by the trusted executor — 036 alone over 035, the ledger exactly 001-036 and the startup preflight\'s pinned chain, 036\'s checksum its up bytes; the postcondition re-run holds and refuses each widening it names with its exact text; the up a second time refused with its fixed text, changing nothing', async () => {
  assert.deepEqual(PAYMENTS_AT_SETUP, NO_PAYMENTS, 'no payment evidence anywhere at setup');
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  assert.deepEqual(applyReport.applied, ['036'], 'the executor applied 036 alone, over 001-035');
  const ledger = (await owner`select version, checksum, dirty, finished_at is not null as finished from public.schema_migrations order by version`).map((r) => ({ ...r }));
  assert.deepEqual(ledger.map((x) => x.version), Array.from({ length: 36 }, (_, i) => String(i + 1).padStart(3, '0')));
  assert.ok(ledger.every((x) => x.dirty === false && x.finished), 'every row clean and finished');
  assert.equal(ledger[35].checksum, SHA_UP_036, '036\'s checksum is its up bytes');
  assert.deepEqual(ledger.map((x) => [x.version, x.checksum]), REQUIRED_MIGRATIONS.slice(0, 36).map((m) => [m.version, m.checksum]), 'the ledger is the startup preflight\'s pinned chain through 036');
  assert.deepEqual(diffKeys(S036, await catalogOf()), [], 'the catalog as the apply left it');
  assert.ok('value' in await rolledBack((tx) => tx.unsafe(POSTCONDITION_036).simple()), 'the postcondition holds');
  const R = (m) => `migration 036 refused: ${m}`;
  const CONTENTS = R(`schema ${NS} does not hold exactly this file's functions and relations, or it or a table is not owned by the applying principal or carries no comment`);
  const SCHEMA_GRANT = R(`schema ${NS} carries an unexpected grant or lacks an expected one`);
  const FN_SHAPE = (v) => R(`a function of schema ${NS} is not the one its section declares (${v})`);
  const FN_GRANT = (v) => R(`an unexpected grant remains on a function of schema ${NS} or on 035's void, or an entry is missing (${v})`);
  const EXEC_PATH = (v) => R(`a runtime role can execute a function this file does not grant it (035's void included), or tmpos_app cannot execute a routine (${v})`);
  const TABLE_PRIV = (v) => R(`${v} holds a privilege on a payment table, or row security is not enabled without policy and unforced, or a table or column carries a grant`);
  const TRIGGERS = R('a trigger of the payment tables is not exactly the one declared');
  const TABLE_SHAPE = R('a payment table\'s columns, keys, CHECKs or foreign keys are not exactly section 5\'s');
  const ANCHOR_DEPS = R('the rollback-order anchor does not record exactly one dependency on each 035 function it names');
  const AUDIT = R('the audit table\'s payment subject, its index or the card-data CHECK is not the one section 7 declares');
  const P = PAY_TABLE;
  const widenings = {
    extraFunction: [`create function ${NS}.extra() returns integer language sql as 'select 1'`, CONTENTS],
    extraTable: [`create table ${NS}.extra (x integer)`, CONTENTS],
    schemaCommentDropped: [`comment on schema ${NS} is null`, CONTENTS],
    schemaToAudit: [`grant usage on schema ${NS} to tmpos_audit_writer`, SCHEMA_GRANT],
    recordInvoker: [`alter function ${RECORD} security invoker`, FN_SHAPE('m7b_invoice_payment_record')],
    readVolatile: [`alter function ${READ} volatile`, FN_SHAPE('m7b_invoice_payments_get')],
    void035Regranted: [`grant execute on function ${VOID_035} to tmpos_app`, FN_GRANT('m7b_invoice_void tmpos_app:EXECUTE')],
    recordToPublic: [`grant execute on function ${RECORD} to public`, FN_GRANT('m7b_invoice_payment_record -:EXECUTE')],
    guardToApp: [`grant execute on function ${GUARDS[0]} to tmpos_app`, FN_GRANT('m7b_invoice_payment_guard tmpos_app:EXECUTE')],
    anchorToAudit: [`grant execute on function ${ANCHOR} to tmpos_audit_writer`, FN_GRANT('m7b_invoice_payment_prerequisites tmpos_audit_writer:EXECUTE')],
    readRevoked: [`revoke execute on function ${READ} from tmpos_app`, FN_GRANT('none listed')],
    executeByMembership: ['grant tmpos_app to tmpos_audit_writer', EXEC_PATH('tmpos_audit_writer m7b_invoice_payment_record, tmpos_audit_writer m7b_invoice_payment_reverse, tmpos_audit_writer m7b_invoice_payments_get, tmpos_audit_writer m7b_invoice_void_v2')],
    tableGrantToApp: [`grant select on ${P} to tmpos_app`, TABLE_PRIV('tmpos_app')],
    columnGrant: [`grant select (reason_code) on ${REV_TABLE} to tmpos_audit_writer`, TABLE_PRIV('tmpos_audit_writer')],
    rlsForced: [`alter table ${P} force row level security`, TABLE_PRIV('a role')],
    rlsOff: [`alter table ${REV_TABLE} disable row level security`, TABLE_PRIV('a role')],
    policy: [`create policy ipr_p on ${P} for select to tmpos_app using (true)`, TABLE_PRIV('a role')],
    guardOrigin: [`alter table ${P} enable trigger trg_invoice_payment_guard`, TRIGGERS],
    truncateDisabled: [`alter table ${REV_TABLE} disable trigger trg_invoice_payment_reversal_truncate`, TRIGGERS],
    recordedByNullable: [`alter table ${P} alter column recorded_by drop not null`, TABLE_SHAPE],
    methodCheckWidened: [`alter table ${P} drop constraint invoice_payment_method_chk, add constraint invoice_payment_method_chk check (method in ('cash', 'external_card_terminal', 'cheque'))`, TABLE_SHAPE],
    amountCheckWidened: [`alter table ${P} drop constraint invoice_payment_amount_chk, add constraint invoice_payment_amount_chk check (amount_cents between 0 and 9007199254740991)`, TABLE_SHAPE],
    reasonCheckWidened: [`alter table ${REV_TABLE} drop constraint invoice_payment_reversal_reason_code_chk, add constraint invoice_payment_reversal_reason_code_chk check (reason_code in ('recorded_in_error', 'refund'))`, TABLE_SHAPE],
    fkCascade: [`alter table ${P} drop constraint invoice_payment_invoice_fkey, add constraint invoice_payment_invoice_fkey foreign key (invoice_id, tenant_id, store_id) references tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id) on delete cascade on update restrict`, TABLE_SHAPE],
    anchorWithoutDependencies: [`create or replace function ${ANCHOR} returns boolean language sql stable set search_path = pg_catalog, pg_temp begin atomic select true; end`, ANCHOR_DEPS],
    auditCommentDropped: ['comment on column public.audit_event.subject_invoice_payment_id is null', AUDIT],
    auditCheckDropped: ['alter table public.audit_event drop constraint audit_event_metadata_no_card_data_keys_chk', AUDIT],
    auditIndexDropped: ['drop index public.idx_audit_event_subject_invoice_payment_occurred', AUDIT],
  };
  for (const [k, [sql, message]] of Object.entries(widenings)) {
    const r = await rolledBack(async (tx) => { await tx.unsafe(sql); await tx.unsafe(POSTCONDITION_036).simple(); });
    assert.deepEqual(r, { code: '55000', message }, `${k}: the exact refusal`);
  }
  // Negative control for (g)'s definition pin: with it replaced by a bare count of the nine constraints (the clause it
  // replaced), each widened CHECK of the same name is accepted — the definitions are what refuse them.
  const DEFS = /\n {5}-- Every key, CHECK and foreign key by its definition[^\n]*\n {5}or \(select pg_catalog\.string_agg[\s\S]*?\n {8}is distinct from\n {8}'[^\n]*'\n/;
  assert.match(POSTCONDITION_036, DEFS, '(g) pins the constraint definitions');
  const COUNT_ONLY = POSTCONDITION_036.replace(DEFS, '\n     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k where k.conrelid in (v_pay, v_rev)) <> 9\n');
  for (const k of ['methodCheckWidened', 'amountCheckWidened', 'reasonCheckWidened']) {
    const v = await rolledBack(async (tx) => { await tx.unsafe(widenings[k][0]); await tx.unsafe(COUNT_ONLY).simple(); });
    assert.ok('value' in v, `${k}: a count-only (g) accepts it (${JSON.stringify(v)})`);
  }
  const rows = await stateOf(TENANTS);
  const again = await rolledBack((tx) => tx.unsafe(UP_036).simple());
  assert.deepEqual(again, { code: '55000', message: 'migration 036 refused: schema tmpos_invoice_payment already exists' });
  assert.deepEqual(diffKeys(S036, await catalogOf()), []);
  assert.deepEqual(await stateOf(TENANTS), rows);
});

test('IPR-02 (PAY-13, R-GATE-2): the up refuses every wrong predecessor it names with its fixed text, changing nothing — 035 rolled back, 035\'s void ACL widened or narrowed, a card-data key already in audit metadata, the audit column already present, REPEATABLE READ — and judges objects only: a ledger without 035\'s row over 035\'s exact objects applies', async () => {
  const f = await scene('pred');
  const R = (m) => `migration 036 refused: ${m}`;
  const NOT_035 = R('migration 035 is not applied exactly (its void and its ACL, its v2 get, its void table with its two guards, or its anchor)');
  const overDown = (perturb) => rolledBack(async (tx) => {
    await tx.unsafe(DOWN_036).simple();
    await perturb(tx);
    await tx.unsafe(UP_036).simple();
    return 'applied';
  });
  const cases = {
    at034: [async (tx) => { await tx.unsafe(DOWN_035).simple(); },
      R('public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, a draft table, a table of tmpos_invoice_issue, tmpos_invoice_void.issued_invoice_void or public.audit_event is missing (migrations 002, 017, 020, 021, 028, 034 and 035 must be applied first)')],
    voidToPublic: [(tx) => tx.unsafe(`grant execute on function ${VOID_035} to public`), NOT_035],
    voidFromApp: [(tx) => tx.unsafe(`revoke execute on function ${VOID_035} from tmpos_app`), NOT_035],
    voidGuardOrigin: [(tx) => tx.unsafe('alter table tmpos_invoice_void.issued_invoice_void enable trigger trg_issued_invoice_void_guard'), NOT_035],
    cardKeyInAudit: [(tx) => tx`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
        reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, metadata)
      values (${`ipr-audit-${randomUUID()}`}, ${f.boss.id}, 'store', ${f.T}, ${f.S}, 'store.invoice.void', 'void_issued_invoices', 'allow',
        'invoice_void_other', 'Issued invoice voided. Reason: Other reason.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1',
        'durable_compliance_event', ${{ cvv: '123' }})`,
    R('an existing audit record\'s metadata carries a card-data key the new CHECK refuses')],
    auditColumnPresent: [(tx) => tx.unsafe('alter table public.audit_event add column subject_invoice_payment_id uuid'),
      R('public.audit_event already carries an addition of this file, or lacks a column the payment routines write')],
  };
  const before = await catalogOf();
  const rows = await stateOf(TENANTS);
  for (const [k, [perturb, message]] of Object.entries(cases)) {
    assert.deepEqual(await overDown(perturb), { code: '55000', message }, k);
  }
  // Outside READ COMMITTED: the up's isolation check comes before its existence check (over the applied 036).
  for (const iso of ['isolation level repeatable read', 'isolation level serializable']) {
    assert.deepEqual(await rolledBack((tx) => tx.unsafe(UP_036).simple(), iso),
      { code: '55000', message: R('it must run under READ COMMITTED, so that its checks see every committed row') }, iso);
  }
  // R-GATE-2: no ledger clause — 035's ledger row gone, 035's objects exact: the up applies.
  assert.deepEqual(await overDown((tx) => tx`delete from public.schema_migrations where version = '035'`), { value: 'applied' }, 'a short ledger over 035\'s exact objects applies');
  assert.deepEqual(diffKeys(before, await catalogOf()), [], 'nothing changed');
  assert.deepEqual(await stateOf(TENANTS), rows);
});

test('IPR-03 (PAY-13): 035\'s down while 036 is applied fails 2BP01; 036\'s down outside READ COMMITTED refused; a clean 036 down restores 035\'s catalog exactly (035\'s void ACL owner and tmpos_app), equal to a FRESH 035 apply\'s, and tmpos_app executes 035\'s void again; 036 re-applies to the first apply\'s catalog; the anchor names only 035\'s void and v2 get, and no 036 object depends on tmpos_session', async () => {
  assert.deepEqual(await globalPayments(), NO_PAYMENTS, 'no payment evidence anywhere (CI order: every earlier suite cleaned up)');
  assert.equal(Number((await owner`select count(*)::int as n from tmpos_invoice_void.issued_invoice_void`)[0].n), 0, 'no void record anywhere');
  const d035 = await rolledBack((tx) => tx.unsafe(DOWN_035).simple());
  assert.equal(d035.code, '2BP01', `035's down fails on the dependency: ${JSON.stringify(d035)}`);
  assert.deepEqual(diffKeys(S036, await catalogOf()), [], 'nothing changed');
  assert.equal((await owner`select pg_catalog.string_agg(d.refobjid::regprocedure::text, ', ' order by d.refobjid::regprocedure::text collate "C") as deps
      from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objsubid = 0 and d.objid = ${ANCHOR}::text::regprocedure
       and d.refclassid in ('pg_catalog.pg_proc'::regclass, 'pg_catalog.pg_class'::regclass) and d.deptype = 'n'`)[0].deps,
    'tmpos_invoice_void.m7b_invoice_void(text,uuid,uuid,uuid,bigint,text), tmpos_invoice_void.m7b_issued_invoice_get_v2(text,uuid,uuid,uuid)',
    'the anchor names 035\'s void and v2 get, and no other migration\'s function');
  assert.equal((await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_depend d
      where ((d.refclassid = 'pg_catalog.pg_proc'::regclass and d.refobjid in (select p.oid from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_session'::regnamespace))
             or (d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid in (select c.oid from pg_catalog.pg_class c where c.relnamespace = 'tmpos_session'::regnamespace)))
        and (pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)).schema = ${NS}`)[0].n, 0, 'no 036 object depends on a tmpos_session object');
  for (const iso of ['isolation level repeatable read', 'isolation level serializable']) {
    assert.deepEqual(await rolledBack((tx) => tx.unsafe(DOWN_036).simple(), iso),
      { code: '55000', message: 'migration 036 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row' }, iso);
  }
  await downCommitted(DOWN_036, '036');
  try {
    const afterDown = await catalogOf();
    assert.deepEqual(diffKeys(S035, afterDown), [], '035\'s catalog exactly, as at setup');
    assert.deepEqual(await grantsOf(VOID_035), EXECUTE_BY(ME, 'tmpos_app'), '035\'s void: the owner\'s EXECUTE and tmpos_app\'s again');
    const u = randomUUID();
    assert.deepEqual((await asTmposApp(`select o_outcome from ${VOID_035_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, 1, 'other')`, ['k', u, u, u])).value,
      [{ o_outcome: 'refused' }], 'tmpos_app executes 035\'s void again');
    // On a shared service S035 was itself taken after an earlier 036 down: judged against a FRESH 035 apply as well.
    assert.deepEqual((await rollBackAbove(owner, MIG_DIR, '034')).rolledBack, ['035'], '035\'s down, committed');
    const fresh035 = await trustedApply('035');
    assert.deepEqual([fresh035.outcome, fresh035.applied], ['complete', ['035']], JSON.stringify(fresh035).slice(0, 300));
    assert.deepEqual(diffKeys(afterDown, await catalogOf()), [], 'after 036\'s down: a fresh 035 apply\'s catalog, every section');
  } finally {
    const r = await trustedApply('036');
    assert.deepEqual([r.outcome, r.applied], ['complete', ['036']], JSON.stringify(r).slice(0, 300));
  }
  assert.deepEqual(diffKeys(S036, await catalogOf()), [], 're-applied: the first apply\'s catalog');
});

test('IPR-04 (PAY-13): the exact surface — the four routines EXECUTE to tmpos_app beside the owner, the guards and the anchor the owner\'s alone, 035\'s void the owner\'s alone; both tables row-secured without policy and without a runtime privilege; the login refused (42501) on both tables, a guard, the anchor and 035\'s void', async () => {
  for (const fn of ROUTINES) assert.deepEqual(await grantsOf(fn), EXECUTE_BY(ME, 'tmpos_app'), fn);
  for (const fn of [...GUARDS, ANCHOR, VOID_035]) assert.deepEqual(await grantsOf(fn), EXECUTE_BY(ME), fn);
  assert.deepEqual(await grantsOf(GET_V2), EXECUTE_BY(ME, 'tmpos_app'), '035\'s v2 get stays the runtime\'s (the read calls it)');
  const tables = (await owner`select c.oid::regclass::text as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      (select count(*) from pg_catalog.pg_policy y where y.polrelid = c.oid)::int as policies,
      pg_catalog.has_table_privilege('tmpos_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as app,
      pg_catalog.has_table_privilege('tmpos_audit_writer', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as audit
    from pg_catalog.pg_class c where c.relnamespace = ${NS}::regnamespace and c.relkind = 'r' order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(tables, [PAY_TABLE, REV_TABLE].map((t) => ({ t, rls: true, forced: false, policies: 0, app: false, audit: false })));
  const u = randomUUID();
  for (const [label, sql, params] of [
    ['the payment table', `select 1 from ${PAY_TABLE}`, []], ['the reversal table', `select 1 from ${REV_TABLE}`, []],
    ['a guard', `select ${GUARDS[1].replace('()', '')}()`, []], ['the anchor', `select ${ANCHOR}`, []],
    ['035\'s void', `select o_outcome from ${VOID_035_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, 1, 'other')`, ['k', u, u, u]],
  ]) {
    const e = await asLogin(sql, params);
    assert.equal(e?.code, '42501', `${label}: ${JSON.stringify(e)}`);
  }
});

// ===========================================================================
// IPR-05..10: the routines' decisions
// ===========================================================================

test('IPR-05 (PAY-02 PAY-07): the authority matrix on stored levels — applied exactly at Invoices >= Approve AND Customers >= View (store_owner Full) for the record and the reversal; refused for Manage, Approve without Customers View, the technician\'s and sales staff\'s defaults, a tenant grant and a grant at another store; a level refusal before tenant_mismatch before not_found; another store\'s, another tenant\'s and a missing invoice one not_found; nothing written by a refusal', async () => {
  const f = await scene('authz', { invoices: 1 });
  const other = await scene('authz-other', { invoices: 1 });
  const atS2 = await f.issue(f.S2);
  const inv = f.inv[0];
  const tech = await member(f, 'tech', 'technician');
  const sales = await member(f, 'sales', 'sales_staff');
  const tenantOwner = { who: f.own, key: f.kOwn };
  const rec = (key, args = {}) => recordCall(key, { store: f.S, invoice: inv, tenant: f.T, amount: 1, ...args });
  const refusedNothingWritten = async (label, call, want) => {
    const before = await stateOf([f.T, other.T]);
    assert.deepEqual(await call(), want, label);
    assert.deepEqual(await stateOf([f.T, other.T]), before, `${label}: nothing written`);
  };
  await refusedNothingWritten('technician (Invoices View)', () => rec(tech.key), NO_REC('refused'));
  await refusedNothingWritten('sales staff (Invoices Create)', () => rec(sales.key), NO_REC('refused'));
  await refusedNothingWritten('a tenant grant', () => rec(tenantOwner.key), NO_REC('refused'));
  await refusedNothingWritten('a grant at another store', () => rec(f.kBoss2), NO_REC('refused'));
  await refusedNothingWritten('another tenant\'s owner', () => rec(other.kBoss), NO_REC('refused'));
  await setLevel(f.T, 'manager', 'invoices', 'manage');
  await refusedNothingWritten('manager at Invoices Manage', () => rec(f.kManager), NO_REC('refused'));
  await setLevel(f.T, 'manager', 'invoices', 'approve');
  await setLevel(f.T, 'manager', 'customers', 'none');
  await refusedNothingWritten('manager at Approve without Customers View', () => rec(f.kManager), NO_REC('refused'));
  // Decision order: a level refusal before tenant_mismatch, tenant_mismatch before not_found.
  await refusedNothingWritten('a level refusal before tenant_mismatch', () => rec(f.kManager, { tenant: T_OTHER }), NO_REC('refused'));
  await setLevel(f.T, 'manager', 'customers', 'view');
  const p1 = randomUUID();
  assertRecorded(await rec(f.kManager, { payment: p1 }), f.manager, f.T, f.S, p1, inv, 'manager at Approve with Customers View');
  await setLevel(f.T, 'technician', 'invoices', 'approve');
  const p2 = randomUUID();
  assertRecorded(await rec(tech.key, { payment: p2 }), tech.who, f.T, f.S, p2, inv, 'technician raised to Approve (Customers View by default)');
  await refusedNothingWritten('tenant_mismatch', () => rec(f.kBoss, { tenant: T_OTHER }), NO_REC('tenant_mismatch'));
  await refusedNothingWritten('tenant_mismatch before not_found', () => rec(f.kBoss, { tenant: T_OTHER, invoice: randomUUID() }), NO_REC('tenant_mismatch'));
  for (const [label, invoice] of [['another store\'s invoice', atS2], ['another tenant\'s invoice', other.inv[0]], ['a missing invoice', randomUUID()]]) {
    await refusedNothingWritten(`record: ${label}`, () => rec(f.kBoss, { invoice }), NO_REC('not_found'));
    await refusedNothingWritten(`reversal: ${label}`, () => reverseCall(f.kBoss, { store: f.S, invoice, payment: p1, tenant: f.T }), NO_REV('not_found'));
  }
  // The reversal's authority is the same pair of levels.
  await refusedNothingWritten('reversal: sales staff', () => reverseCall(sales.key, { store: f.S, invoice: inv, payment: p1, tenant: f.T }), NO_REV('refused'));
  await refusedNothingWritten('reversal: a level refusal before tenant_mismatch', () => reverseCall(sales.key, { store: f.S, invoice: inv, payment: p1, tenant: T_OTHER }), NO_REV('refused'));
  await refusedNothingWritten('reversal: tenant_mismatch', () => reverseCall(f.kBoss, { store: f.S, invoice: inv, payment: p1, tenant: T_OTHER }), NO_REV('tenant_mismatch'));
  await setLevel(f.T, 'manager', 'invoices', 'manage');
  await refusedNothingWritten('reversal: manager at Manage', () => reverseCall(f.kManager, { store: f.S, invoice: inv, payment: p1, tenant: f.T }), NO_REV('refused'));
  await setLevel(f.T, 'manager', 'invoices', 'full');
  assertReversed(await reverseCall(f.kManager, { store: f.S, invoice: inv, payment: p1, tenant: f.T }), f.manager, f.T, f.S, p1, 'reversal: manager at Full');
  assertReversed(await reverseCall(tech.key, { store: f.S, invoice: inv, payment: p2, tenant: f.T }), tech.who, f.T, f.S, p2, 'reversal: technician at Approve');
  await clearLevels(f.T);
});

test('IPR-06 (PAY-01 PAY-07 PAY-10): the arithmetic — full, partial, mixed methods, over the remaining refused, Total 0 refuses any amount, 9007199254740991 admitted as an argument and applied in full on a Total of 9007199254740991, the sum in numeric; an applied record writes exactly one payment and one audit record (no outbox or idempotency row); every argument refusal raises its fixed text before anything is read', async () => {
  const f = await scene('arith', { invoices: 3 });
  const [full, partial, mixed] = f.inv;
  const T1 = await totalOf(full);
  // The exact delta of one applied record.
  const before = await stateOf([f.T]);
  const one = await pay(f, full, T1);
  const after = await stateOf([f.T]);
  assert.deepEqual(diffKeys(before, after).sort(), ['audits', 'audits_anywhere', 'payments'], 'one payment and one audit record, nothing else');
  assert.equal(after.payments.length, before.payments.length + 1);
  assert.equal(after.audits.length, before.audits.length + 1);
  assert.equal(after.audits_anywhere, before.audits_anywhere + 1);
  assert.deepEqual([after.events_anywhere, after.records_anywhere], [before.events_anywhere, before.records_anywhere], 'no outbox or idempotency row');
  const [row] = await paymentsOf(full);
  assert.deepEqual({ ...row, at: undefined }, { payment_id: one.payment, attempt_id: one.attempt, amount: String(T1), method: 'cash', recorded_by: f.boss.id, at: undefined, reason_code: null, reversed_by: null });
  assert.match(row.at, WIRE_TIME_RE);
  assert.deepEqual(await recordCall(f.kBoss, { store: f.S, invoice: full, tenant: f.T, amount: 1 }), NO_REC('amount_exceeds_remaining'), 'paid in full: one cent more refused');
  // Partial, then the exact remainder.
  const T2 = await totalOf(partial);
  await pay(f, partial, T2 - 100n);
  assert.deepEqual(await recordCall(f.kBoss, { store: f.S, invoice: partial, tenant: f.T, amount: 101 }), NO_REC('amount_exceeds_remaining'), 'one cent over the remainder');
  await pay(f, partial, 100n);
  // Mixed methods.
  const T3 = await totalOf(mixed);
  await pay(f, mixed, 500n, { method: 'cash' });
  await pay(f, mixed, T3 - 500n, { method: 'external_card_terminal' });
  assert.deepEqual((await paymentsOf(mixed)).map((r) => [r.method, r.amount]), [['cash', '500'], ['external_card_terminal', String(T3 - 500n)]]);
  // Total 0.
  const zero = await f.issue(f.S, [line('No charge', 1, 0)]);
  assert.equal(await totalOf(zero), 0n);
  assert.deepEqual(await recordCall(f.kBoss, { store: f.S, invoice: zero, tenant: f.T, amount: 1 }), NO_REC('amount_exceeds_remaining'), 'Total 0: nothing can be recorded');
  // The 2^53 - 1 bound: admitted as an argument (refused by the arithmetic, never by overflow) and applied on a Total that large.
  assert.deepEqual(await recordCall(f.kBoss, { store: f.S, invoice: zero, tenant: f.T, amount: MAX }), NO_REC('amount_exceeds_remaining'), '9007199254740991 admitted as an argument');
  const S0 = await newStore(f.T, `arith-none ${SUFFIX}`);
  const boss0 = await actor('arith-owner0', [storeGrant(f.T, S0, 'store_owner')]);
  const k0 = await mint(boss0);
  await settingsSet(f.kOwn, S0, f.T, { taxMode: 'none', taxRate: null });
  const big = await issueOne(k0, S0, f.T, f.C, [line('Everything', 1, Number(MAX))]);
  assert.equal(await totalOf(big), MAX, 'a Total of 9007199254740991');
  await pay(f, big, MAX - 1n, { who: boss0, key: k0, store: S0 });
  assert.deepEqual(await recordCall(k0, { store: S0, invoice: big, tenant: f.T, amount: 2 }), NO_REC('amount_exceeds_remaining'), 'the sum 2^53 compared in numeric');
  await pay(f, big, 1n, { who: boss0, key: k0, store: S0 });
  // Every argument refusal: its fixed text, before anything is read (a valid call's other arguments).
  const base = { store: f.S, invoice: mixed, tenant: f.T, amount: 1 };
  const MAL = { code: '22023', message: 'migration 036 record: an argument is malformed' };
  const AMOUNT = { code: '22023', message: 'migration 036 record: the amount is out of range' };
  const METHOD = { code: '22023', message: 'migration 036 record: the method is not one of the closed list' };
  const CORR = { code: '22023', message: 'migration 036 record: the correlation id is not a version-4 uuid' };
  const bad = {
    nullKey: [null, {}, MAL], spaceKey: ['a b', {}, MAL], longKey: ['k'.repeat(129), {}, MAL], nullStore: [f.kBoss, { store: null }, MAL],
    nullInvoice: [f.kBoss, { invoice: null }, MAL], nullTenant: [f.kBoss, { tenant: null }, MAL], nullPayment: [f.kBoss, { payment: null }, MAL],
    nullAttempt: [f.kBoss, { attempt: null }, MAL], zero: [f.kBoss, { amount: 0 }, AMOUNT], negative: [f.kBoss, { amount: -1 }, AMOUNT],
    over: [f.kBoss, { amount: MAX + 1n }, AMOUNT], nullAmount: [f.kBoss, { amount: null }, AMOUNT], card: [f.kBoss, { method: 'card' }, METHOD],
    capital: [f.kBoss, { method: 'Cash' }, METHOD], nullMethod: [f.kBoss, { method: null }, METHOD], nullCorr: [f.kBoss, { corr: null }, CORR],
    v1Corr: [f.kBoss, { corr: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }, CORR], nilCorr: [f.kBoss, { corr: '00000000-0000-0000-0000-000000000000' }, CORR],
  };
  const rows = await stateOf([f.T]);
  for (const [k, [key, args, want]] of Object.entries(bad)) assert.deepEqual(await errorOf(recordCall(key, { ...base, ...args })), want, k);
  assert.deepEqual(await stateOf([f.T]), rows, 'no refusal wrote anything');
});

test('IPR-07 (PAY-04): precedence after the header lock — already_recorded before invalid_state before amount_exceeds_remaining; an attempt answers already_recorded after its payment\'s reversal and on a voided invoice; the same attempt on another invoice is a different attempt', async () => {
  const f = await scene('prec', { invoices: 2 });
  const [A, B] = f.inv;
  const TA = await totalOf(A);
  const x = await pay(f, A, TA);
  const nothing = async (label, call, want) => {
    const before = await stateOf([f.T]);
    assert.deepEqual(await call(), want, label);
    assert.deepEqual(await stateOf([f.T]), before, `${label}: nothing written`);
  };
  await nothing('the attempt again, over the remaining: already_recorded first', () => recordCall(f.kBoss, { store: f.S, invoice: A, tenant: f.T, attempt: x.attempt, amount: TA }), NO_REC('already_recorded'));
  await nothing('the attempt again with a new payment id and another method', () => recordCall(f.kManager, { store: f.S, invoice: A, tenant: f.T, attempt: x.attempt, amount: 1, method: 'external_card_terminal' }), NO_REC('already_recorded'));
  await unpay(f, A, x.payment);
  await nothing('after its reversal: still already_recorded', () => recordCall(f.kBoss, { store: f.S, invoice: A, tenant: f.T, attempt: x.attempt, amount: 1 }), NO_REC('already_recorded'));
  assert.deepEqual(await void2Call(f.kBoss, { store: f.S, invoice: A, tenant: f.T }), VOIDED(f.boss, f.T, f.S, A), 'every payment reversed: the void applies');
  await nothing('on the voided invoice: already_recorded before invalid_state', () => recordCall(f.kBoss, { store: f.S, invoice: A, tenant: f.T, attempt: x.attempt, amount: 1 }), NO_REC('already_recorded'));
  await nothing('a new attempt on the voided invoice, over any remaining: invalid_state before amount_exceeds_remaining', () => recordCall(f.kBoss, { store: f.S, invoice: A, tenant: f.T, amount: TA + 1n }), NO_REC('invalid_state'));
  await nothing('a new attempt within the Total on the voided invoice: invalid_state', () => recordCall(f.kBoss, { store: f.S, invoice: A, tenant: f.T, amount: 1 }), NO_REC('invalid_state'));
  // The same attempt id on another invoice is a different attempt.
  const y = await pay(f, B, 7n, { attempt: x.attempt });
  assert.deepEqual((await paymentsOf(B)).map((r) => [r.payment_id, r.attempt_id]), [[y.payment, x.attempt]]);
  await nothing('and on B it is now recorded too', () => recordCall(f.kBoss, { store: f.S, invoice: B, tenant: f.T, attempt: x.attempt, amount: 1 }), NO_REC('already_recorded'));
});

test('IPR-08 (PAY-03 PAY-07): the reversal — not_found for another invoice\'s and a missing payment, invalid_state once reversed (also for version 2), conflict for version 2 on an active payment, version 2 answered when applied; one reversal per payment; every argument refusal raises its fixed text before anything is read', async () => {
  const f = await scene('rev', { invoices: 2 });
  const [A, B] = f.inv;
  const a = await pay(f, A, 10n);
  const b = await pay(f, B, 20n);
  const nothing = async (label, args, want) => {
    const before = await stateOf([f.T]);
    assert.deepEqual(await reverseCall(f.kBoss, { store: f.S, tenant: f.T, ...args }), want, label);
    assert.deepEqual(await stateOf([f.T]), before, `${label}: nothing written`);
  };
  await nothing('another invoice\'s payment under the path invoice', { invoice: A, payment: b.payment }, NO_REV('not_found'));
  await nothing('a missing payment', { invoice: A, payment: randomUUID() }, NO_REV('not_found'));
  await nothing('version 2 on an active payment', { invoice: A, payment: a.payment, version: 2 }, NO_REV('conflict'));
  const before = await stateOf([f.T]);
  const r = await unpay(f, A, a.payment, { reason: 'wrong_amount' });
  const after = await stateOf([f.T]);
  assert.deepEqual(diffKeys(before, after).sort(), ['audits', 'audits_anywhere', 'reversals'], 'one reversal and one audit record, nothing else');
  assert.match(r.event, UUID_RE);
  assert.deepEqual((await paymentsOf(A)).map((x) => [x.payment_id, x.reason_code, x.reversed_by]), [[a.payment, 'wrong_amount', f.boss.id]], 'the payment stays, its reversal beside it');
  await nothing('already reversed', { invoice: A, payment: a.payment }, NO_REV('invalid_state'));
  await nothing('already reversed, version 2: invalid_state before conflict', { invoice: A, payment: a.payment, version: 2 }, NO_REV('invalid_state'));
  assert.equal(Number((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment_reversal where payment_id = ${a.payment}`)[0].n), 1, 'one reversal per payment');
  // Every reason code, in its order, is admitted (and recorded with its own audit text in IPR-11).
  const REASONS = ['recorded_in_error', 'wrong_amount', 'wrong_method', 'wrong_invoice', 'duplicate', 'other'];
  for (const reason of REASONS) {
    const p = await pay(f, B, 1n);
    await unpay(f, B, p.payment, { reason });
  }
  assert.deepEqual((await paymentsOf(B)).slice(1).map((x) => x.reason_code), REASONS);
  const base = { store: f.S, invoice: B, payment: b.payment, tenant: f.T };
  const MAL = { code: '22023', message: 'migration 036 reverse: an argument is malformed' };
  const VERSION = { code: '22023', message: 'migration 036 reverse: the expected version is out of range' };
  const REASON = { code: '22023', message: 'migration 036 reverse: the reason code is not one of the closed list' };
  const CORR = { code: '22023', message: 'migration 036 reverse: the correlation id is not a version-4 uuid' };
  const bad = {
    nullKey: [null, {}, MAL], tabKey: ['a\tb', {}, MAL], nullStore: [f.kBoss, { store: null }, MAL], nullInvoice: [f.kBoss, { invoice: null }, MAL],
    nullPayment: [f.kBoss, { payment: null }, MAL], nullTenant: [f.kBoss, { tenant: null }, MAL], v0: [f.kBoss, { version: 0 }, VERSION],
    vMax: [f.kBoss, { version: MAX }, VERSION], vNull: [f.kBoss, { version: null }, VERSION], refund: [f.kBoss, { reason: 'refund' }, REASON],
    nullReason: [f.kBoss, { reason: null }, REASON], voidReason: [f.kBoss, { reason: 'issued_in_error' }, REASON], nullCorr: [f.kBoss, { corr: null }, CORR],
    v1Corr: [f.kBoss, { corr: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }, CORR],
  };
  const rows = await stateOf([f.T]);
  for (const [k, [key, args, want]] of Object.entries(bad)) assert.deepEqual(await errorOf(reverseCall(key, { ...base, ...args })), want, k);
  assert.deepEqual(await stateOf([f.T]), rows, 'no refusal wrote anything');
  assert.deepEqual(await reverseCall(f.kBoss, { ...base, version: MAX - 1n }), NO_REV('conflict'), '9007199254740990 is in range (and not 1): conflict');
});

test('IPR-09 (PAY-02): the reversal\'s recent sign-in at the routine — live: NULL refused, 600001 ms older than an earlier clock reading refused, exactly 5000 ms ahead applied, inside the window applied, more than 5000 ms ahead refused; its own step-7 predicate, read from its source and evaluated at a fixed clock: exactly 600000 ms holds, 600001 refuses, exactly 5000 ms ahead holds, 5001 refuses, NULL refuses; the record needs no recent sign-in', async () => {
  const f = await scene('signin', { invoices: 1 });
  const inv = f.inv[0];
  const payments = [];
  for (let i = 0; i < 4; i += 1) payments.push((await pay(f, inv, 1n)).payment);
  const run = async (label, authAt, want) => {
    await setAuth(f.kBoss, authAt);
    const payment = payments[0];
    const before = await stateOf([f.T]);
    const got = await reverseCall(f.kBoss, { store: f.S, invoice: inv, payment, tenant: f.T });
    if (want === 'applied') {
      assertReversed(got, f.boss, f.T, f.S, payment, label);
      payments.shift();
    } else {
      assert.deepEqual(got, NO_REV(want), label);
      assert.deepEqual(await stateOf([f.T]), before, `${label}: nothing written`);
    }
  };
  await run('authenticated_at NULL', null, 'refused');
  await run('600001 ms older than an earlier reading', (await dbNowMs()) - (RECENT_AUTH_MAX_AGE_MS + 1), 'refused');
  await run('exactly 5000 ms ahead of an earlier reading', (await dbNowMs()) + MAX_CLOCK_SKEW_MS, 'applied');
  await run('inside the window (8 s margin)', (await dbNowMs()) - RECENT_AUTH_MAX_AGE_MS + 8_000, 'applied');
  await run('13000 ms ahead (a forged, future sign-in)', (await dbNowMs()) + MAX_CLOCK_SKEW_MS + 8_000, 'refused');
  await run('10 minutes and 5 s old', (await dbNowMs()) - RECENT_AUTH_MAX_AGE_MS - 5_000, 'refused');
  // The record judges no sign-in (D-PAY-6 A): a NULL one still records.
  await setAuth(f.kBoss, null);
  await pay(f, inv, 1n);
  await setAuth(f.kBoss, await dbNowMs());
  const [{ src }] = await owner`select p.prosrc as src from pg_catalog.pg_proc p where p.oid = ${REVERSE}::regprocedure`;
  const STEP = /v_clock := pg_catalog\.clock_timestamp\(\);\s+v_now := pg_catalog\.floor\(extract\(epoch from v_clock\) \* 1000\)::bigint;\s+if ([\s\S]+?) then\s+return query select 'refused'/g;
  const found = [...src.matchAll(STEP)];
  assert.equal(found.length, 1, 'one sign-in block: one clock_timestamp() reading, then one refusal predicate');
  const predicate = found[0][1];
  assert.equal(predicate.replace(/\s+/g, ' '), `v_now >= v_session.expires_at or v_session.authenticated_at is null or pg_catalog.to_timestamp(v_session.authenticated_at / 1000.0) > v_clock + interval '${MAX_CLOCK_SKEW_MS} milliseconds' or v_clock > pg_catalog.to_timestamp((v_session.authenticated_at + ${RECENT_AUTH_MAX_AGE_MS}) / 1000.0)`,
    'the predicate names sessions.ts\'s bounds');
  const at = (s) => { const k = src.indexOf(s); assert.ok(k >= 0, s); return k; };
  const order = [at('for update;'), at('from tmpos_invoice_payment.invoice_payment p\n   where p.payment_id = p_payment_id'), at('pg_advisory_xact_lock_shared(530030'), found[0].index,
    at('if exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p_payment_id) then'),
    at('if p_expected_version is distinct from 1::bigint then'), at('insert into tmpos_invoice_payment.invoice_payment_reversal')];
  assert.deepEqual(order, [...order].sort((x, y) => x - y), 'header lock, payment, key, sign-in, existence, version, write — in that order');
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
    'exactly 5000 ms ahead': [C, F + HOUR, F + MAX_CLOCK_SKEW_MS, false],
    '5001 ms ahead': [C, F + HOUR, F + MAX_CLOCK_SKEW_MS + 1, true],
    'NULL': [C, F + HOUR, null, true],
    'expires at the clock': [C, F, F, true],
  };
  for (const [label, [clock, expires, authAt, refused]] of Object.entries(bounds)) {
    assert.equal(await evaluate(clock, expires, authAt), refused, `the predicate at a fixed clock: ${label}`);
  }
});

test('IPR-10 (PAY-12): m7b_invoice_void_v2 — payments_recorded while an unreversed payment exists (before the version: a version 2 is still payments_recorded), nothing written; every payment reversed, it voids; on a voided invoice invalid_state (before the version); a record on it is invalid_state; 035\'s void is no longer the runtime\'s', async () => {
  const f = await scene('void2', { invoices: 2 });
  const [A, B] = f.inv;
  const p1 = await pay(f, A, 3n);
  const p2 = await pay(f, A, 4n, { method: 'external_card_terminal' });
  const nothing = async (label, call, want) => {
    const before = await stateOf([f.T]);
    assert.deepEqual(await call(), want, label);
    assert.deepEqual(await stateOf([f.T]), before, `${label}: nothing written`);
  };
  await nothing('two active payments', () => void2Call(f.kBoss, { store: f.S, invoice: A, tenant: f.T }), NO_VOID('payments_recorded'));
  await nothing('version 2 with an active payment: payments_recorded first', () => void2Call(f.kBoss, { store: f.S, invoice: A, tenant: f.T, version: 2 }), NO_VOID('payments_recorded'));
  await unpay(f, A, p1.payment);
  await nothing('one still active', () => void2Call(f.kManager, { store: f.S, invoice: A, tenant: f.T }), NO_VOID('payments_recorded'));
  await unpay(f, A, p2.payment, { reason: 'duplicate' });
  await nothing('all reversed, version 2: conflict', () => void2Call(f.kBoss, { store: f.S, invoice: A, tenant: f.T, version: 2 }), NO_VOID('conflict'));
  assert.deepEqual(await void2Call(f.kBoss, { store: f.S, invoice: A, tenant: f.T, reason: 'wrong_customer' }), VOIDED(f.boss, f.T, f.S, A), 'every payment reversed: voided');
  await nothing('already void', () => void2Call(f.kManager, { store: f.S, invoice: A, tenant: f.T }), NO_VOID('invalid_state'));
  await nothing('already void, version 2: invalid_state first', () => void2Call(f.kBoss, { store: f.S, invoice: A, tenant: f.T, version: 2 }), NO_VOID('invalid_state'));
  await nothing('a record on the voided invoice', () => recordCall(f.kBoss, { store: f.S, invoice: A, tenant: f.T, amount: 1 }), NO_REC('invalid_state'));
  assert.deepEqual(await void2Call(f.kBoss, { store: f.S, invoice: B, tenant: f.T }), VOIDED(f.boss, f.T, f.S, B), 'never paid: voided');
  const e = await errorOf(runtime.unsafe(`select o_outcome from ${VOID_035_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, 1, 'other')`, [f.kBoss, f.S, B, f.T]));
  assert.equal(e?.code, '42501', `the login cannot execute 035's void: ${JSON.stringify(e)}`);
  assert.deepEqual(await errorOf(void2Call(f.kBoss, { store: f.S, invoice: B, tenant: f.T, reason: 'recorded_in_error' })),
    { code: '22023', message: 'migration 036 void: the reason code is not one of the closed list' }, 'the void\'s own six reasons');
});

// ===========================================================================
// IPR-11..13: the audit record and the isolation level
// ===========================================================================

test('IPR-11 (PAY-07 PAY-08): exactly one audit record per applied record and reversal, with §12.4\'s values (action, permission, reason code, sentence, source, evaluator, evidence level, empty metadata, the payment the only subject, the correlation id as request_id), and none on any refusal', async () => {
  const f = await scene('audit', { invoices: 1 });
  const inv = f.inv[0];
  const subjects = (j) => Object.fromEntries(Object.entries(j).filter(([k]) => k.startsWith('subject_') && k !== 'subject_invoice_payment_id'));
  const expect = (who, action, permission, reasonCode, sentence, payment, corr, event) => ({
    event_id: event, request_id: corr, trace_id: null, actor_internal_user_id: who.id, actor_auth_provider: null, on_behalf_of_internal_user_id: null,
    scope_type: 'store', tenant_id: f.T, store_id: f.S, action_id: action, required_permission: permission, decision: 'allow', reason_code: reasonCode,
    human_readable_reason: sentence, result_status: 'succeeded', source_of_truth: 'invoice_payment_routine', evaluated_by: 'm7b_invoice_payment_routine@v1',
    evidence_level: 'durable_compliance_event', metadata: {}, subject_invoice_payment_id: payment,
  });
  const check = async (payment, rows) => {
    const got = await auditOf(payment);
    assert.equal(got.length, rows.length, 'one audit record per applied routine call');
    got.forEach((j, i) => {
      const want = rows[i];
      for (const [k, v] of Object.entries(want)) assert.deepEqual(j[k], v, `${want.action_id}: ${k}`);
      assert.ok(Object.values(subjects(j)).every((v) => v === null), `${want.action_id}: the payment is its only subject (${JSON.stringify(subjects(j))})`);
    });
  };
  const c = await pay(f, inv, 5n, { method: 'cash' });
  const k = await pay(f, inv, 6n, { method: 'external_card_terminal', who: f.manager, key: f.kManager });
  const RECORD_ROW = (who, method, label, x) => expect(who, 'store.invoice_payment.record', 'record_invoice_payments', `invoice_payment_recorded_${method}`,
    `Payment recorded against an issued invoice. Method: ${label}.`, x.payment, x.corr, x.event);
  await check(c.payment, [RECORD_ROW(f.boss, 'cash', 'Cash', c)]);
  await check(k.payment, [RECORD_ROW(f.manager, 'external_card_terminal', 'Card on a separate terminal', k)]);
  const LABELS = { recorded_in_error: 'Recorded by mistake', wrong_amount: 'Wrong amount', wrong_method: 'Wrong method', wrong_invoice: 'Wrong invoice',
    duplicate: 'Payment recorded twice', other: 'Other reason' };
  for (const [reason, label] of Object.entries(LABELS)) {
    const x = await pay(f, inv, 1n);
    const r = await unpay(f, inv, x.payment, { reason });
    await check(x.payment, [RECORD_ROW(f.boss, 'cash', 'Cash', x), expect(f.boss, 'store.invoice_payment.reverse', 'reverse_invoice_payments', `invoice_payment_reversed_${reason}`,
      `Recorded payment reversed. Reason: ${label}.`, x.payment, r.corr, r.event)]);
  }
  // Refusals write no audit record.
  const audits = Number((await owner`select count(*)::int as n from public.audit_event where tenant_id = ${f.T}`)[0].n);
  const refusals = [
    () => recordCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt: c.attempt, amount: 1 }),
    () => recordCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, amount: MAX }),
    () => recordCall(f.kBoss, { store: f.S, invoice: randomUUID(), tenant: f.T, amount: 1 }),
    () => recordCall(f.kBoss, { store: f.S, invoice: inv, tenant: T_OTHER, amount: 1 }),
    () => recordCall('no-such-session', { store: f.S, invoice: inv, tenant: f.T, amount: 1 }),
    () => reverseCall(f.kBoss, { store: f.S, invoice: inv, payment: c.payment, tenant: f.T, version: 2 }),
    () => reverseCall(f.kBoss, { store: f.S, invoice: inv, payment: randomUUID(), tenant: f.T }),
  ];
  for (const call of refusals) assert.notEqual((await call())[0].o_outcome, 'applied');
  assert.equal(Number((await owner`select count(*)::int as n from public.audit_event where tenant_id = ${f.T}`)[0].n), audits, 'no refusal wrote an audit record');
});

test('IPR-12 (PAY-08): an owner BEFORE INSERT trigger on public.audit_event that returns NULL makes the record and the reversal raise their fixed text and commits no payment or reversal; one that raises does the same with its own error', async () => {
  const f = await scene('fault', { invoices: 1 });
  const inv = f.inv[0];
  const kept = await pay(f, inv, 2n);
  await owner.unsafe(`create schema ${NC}`);
  await owner.unsafe(`create function ${NC}.drop_audit() returns trigger language plpgsql as $$ begin return null; end $$`);
  await owner.unsafe(`create function ${NC}.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'ipr: audit refused' using errcode = 'P0001'; end $$`);
  try {
    for (const [fn, recordWant, reverseWant] of [
      ['drop_audit', { code: 'P0002', message: 'migration 036 record: the audit record was not written exactly once' }, { code: 'P0002', message: 'migration 036 reverse: the audit record was not written exactly once' }],
      ['fail_audit', { code: 'P0001', message: 'ipr: audit refused' }, { code: 'P0001', message: 'ipr: audit refused' }],
    ]) {
      await owner.unsafe(`create trigger ipr_audit_fault before insert on public.audit_event for each row execute function ${NC}.${fn}()`);
      try {
        const before = await stateOf([f.T]);
        const payment = randomUUID();
        assert.deepEqual(await errorOf(recordCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, payment, amount: 1 })), recordWant, `${fn}: the record raises`);
        assert.deepEqual(await errorOf(reverseCall(f.kBoss, { store: f.S, invoice: inv, payment: kept.payment, tenant: f.T })), reverseWant, `${fn}: the reversal raises`);
        assert.deepEqual(await stateOf([f.T]), before, `${fn}: no payment, reversal or audit record committed`);
        assert.equal(Number((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where payment_id = ${payment}`)[0].n), 0);
      } finally {
        await owner.unsafe('drop trigger if exists ipr_audit_fault on public.audit_event');
      }
    }
  } finally {
    await owner.unsafe(`drop schema if exists ${NC} cascade`);
  }
  // The trigger gone, the same calls apply.
  await pay(f, inv, 1n);
  await unpay(f, inv, kept.payment);
});

test('IPR-13 (PAY-06): REPEATABLE READ and SERIALIZABLE are refused (55000, fixed text) by the record, the reversal and the void v2 before anything is read — even for a session key that does not exist', async () => {
  const f = await scene('iso', { invoices: 1 });
  const inv = f.inv[0];
  const p = await pay(f, inv, 1n);
  const before = await stateOf([f.T]);
  for (const iso of ['isolation level repeatable read', 'isolation level serializable']) {
    for (const key of [f.kBoss, 'no-such-session']) {
      assert.deepEqual(await errorOf(runtime.begin(iso, (tx) => recordCall(key, { store: f.S, invoice: inv, tenant: f.T, amount: 1, db: tx }))),
        { code: '55000', message: 'migration 036 record: it must run under READ COMMITTED, so that its checks see what committed before its locks' }, `${iso}: record`);
      assert.deepEqual(await errorOf(runtime.begin(iso, (tx) => reverseCall(key, { store: f.S, invoice: inv, payment: p.payment, tenant: f.T, db: tx }))),
        { code: '55000', message: 'migration 036 reverse: it must run under READ COMMITTED, so that its checks see what committed before its locks' }, `${iso}: reverse`);
      assert.deepEqual(await errorOf(runtime.begin(iso, (tx) => void2Call(key, { store: f.S, invoice: inv, tenant: f.T, db: tx }))),
        { code: '55000', message: 'migration 036 void: it must run under READ COMMITTED, so that its checks see what committed before its locks' }, `${iso}: void v2`);
    }
  }
  assert.deepEqual(await stateOf([f.T]), before, 'nothing written');
});

// ===========================================================================
// IPR-14..15: the races and the guards
// ===========================================================================

test('IPR-14 (PAY-05): two sessions recording against one invoice behind a third session\'s header lock — exactly one applied, the other amount_exceeds_remaining, the Total never exceeded; record vs void in both orders — the second waits on the issued header and answers payments_recorded or invalid_state', async () => {
  const f = await scene('race', { invoices: 3 });
  const [A, B, C] = f.inv;
  const TA = await totalOf(A);
  const amount = TA / 2n + 1n;
  const holder = holding(owner, (tx) => tx`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${A} for update`);
  let a = null;
  let b = null;
  try {
    await until(() => holder.ready, 'the third session holds the header');
    const pa = randomUUID();
    const pb = randomUUID();
    a = running(runtime, (tx) => recordCall(f.kBoss, { store: f.S, invoice: A, tenant: f.T, payment: pa, amount, db: tx }));
    b = running(runtime, (tx) => recordCall(f.kManager, { store: f.S, invoice: A, tenant: f.T, payment: pb, amount, db: tx, method: 'external_card_terminal' }));
    await until(async () => (await blockers(a.pid)).length > 0 && (await blockers(b.pid)).length > 0, 'both records wait');
    for (const r of [a, b]) {
      const by = await blockers(r.pid);
      assert.ok(by.every((pid) => [holder.pid, a.pid, b.pid].includes(pid)), `each waits on the holder or the other record only (${by})`);
    }
    assert.ok((await blockedBy(a.pid, holder.pid)) || (await blockedBy(b.pid, holder.pid)), 'the header holder is the barrier');
    holder.release('rollback');
    await holder.done;
    const ra = finished(await a.done, 'record A').value;
    const rb = finished(await b.done, 'record B').value;
    const outcomes = [ra[0].o_outcome, rb[0].o_outcome].sort();
    assert.deepEqual(outcomes, ['amount_exceeds_remaining', 'applied'], 'exactly one applied, the other refused');
    const loser = ra[0].o_outcome === 'applied' ? rb : ra;
    assert.deepEqual(loser, NO_REC('amount_exceeds_remaining'));
    const rows = await paymentsOf(A);
    assert.equal(rows.length, 1, 'one payment');
    assert.ok(BigInt(rows[0].amount) <= TA, 'the Total is not exceeded');
  } finally { await settle(holder, a, b); }
  // Record first, then the void: the void waits on the header and, the record committed, answers payments_recorded.
  {
    const rec = holding(runtime, (tx) => recordCall(f.kBoss, { store: f.S, invoice: B, tenant: f.T, amount: 1, db: tx }));
    let v = null;
    try {
      await until(() => rec.ready || rec.out !== undefined, 'the record applied, uncommitted');
      assert.equal(rec.value[0].o_outcome, 'applied');
      v = running(runtime, (tx) => void2Call(f.kManager, { store: f.S, invoice: B, tenant: f.T, db: tx }));
      await until(() => blockedBy(v.pid, rec.pid), 'the void waits behind the record');
      assert.deepEqual(await rowWaitOn(v.pid), ['tmpos_invoice_issue.issued_invoice'], 'on the issued header');
      rec.release('commit');
      finished(await rec.done, 'the record');
      assert.deepEqual(finished(await v.done, 'the void').value, NO_VOID('payments_recorded'), 'the void sees the committed payment');
    } finally { await settle(rec, v); }
    assert.equal(Number((await owner`select count(*)::int as n from tmpos_invoice_void.issued_invoice_void where invoice_id = ${B}`)[0].n), 0, 'not voided');
  }
  // The void first, then the record: the record waits on the header and, the void committed, answers invalid_state.
  {
    const v = holding(runtime, (tx) => void2Call(f.kBoss, { store: f.S, invoice: C, tenant: f.T, db: tx }));
    let rec = null;
    try {
      await until(() => v.ready || v.out !== undefined, 'the void applied, uncommitted');
      assert.deepEqual(v.value, VOIDED(f.boss, f.T, f.S, C));
      rec = running(runtime, (tx) => recordCall(f.kManager, { store: f.S, invoice: C, tenant: f.T, amount: 1, db: tx }));
      await until(() => blockedBy(rec.pid, v.pid), 'the record waits behind the void');
      assert.deepEqual(await rowWaitOn(rec.pid), ['tmpos_invoice_issue.issued_invoice'], 'on the issued header');
      v.release('commit');
      finished(await v.done, 'the void');
      assert.deepEqual(finished(await rec.done, 'the record').value, NO_REC('invalid_state'), 'the record sees the committed void');
    } finally { await settle(v, rec); }
    assert.deepEqual(await paymentsOf(C), [], 'no payment on the voided invoice');
  }
});

test('IPR-15 (PAY-03): the guards as the table owner, in normal and replica mode — UPDATE (a no-op included), DELETE and TRUNCATE of payments and reversals refused (23001, fixed text); a payment back-dated before the issue, naming another store or tenant, or an unknown invoice refused; a reversal back-dated before its recording or naming another invoice\'s payment refused; stamped exactly at the issue (or the recording) admitted', async () => {
  const f = await scene('guards', { invoices: 2 });
  const other = await scene('guards-other', { invoices: 1 });
  const [A, B] = f.inv;
  const p = await pay(f, A, 3n);
  const q = await pay(f, B, 4n);
  await unpay(f, B, q.payment);
  const before = await stateOf([f.T, other.T]);
  const NEVER_P = 'migration 036: a payment record is never updated or deleted';
  const NEVER_R = 'migration 036: a payment reversal is never updated or deleted';
  const SCOPE_P = 'migration 036: a payment record names an issued invoice of its own tenant and store';
  const SCOPE_R = 'migration 036: a payment reversal names a payment of its own invoice, tenant and store';
  const cases = {};
  for (const replica of [false, true]) {
    const tag = replica ? 'replica' : 'origin';
    const run = (sql, params = []) => rolledBack(async (tx) => { if (replica) await tx`set local session_replication_role = replica`; await tx.unsafe(sql, params); });
    cases[`${tag}:payment update`] = [await run(`update ${PAY_TABLE} set amount_cents = 1 where payment_id = $1`, [p.payment]), NEVER_P];
    cases[`${tag}:payment noop`] = [await run(`update ${PAY_TABLE} set method = method where payment_id = $1`, [p.payment]), NEVER_P];
    cases[`${tag}:payment delete`] = [await run(`delete from ${PAY_TABLE} where payment_id = $1`, [p.payment]), NEVER_P];
    cases[`${tag}:payment truncate`] = [await run(`truncate ${PAY_TABLE}, ${REV_TABLE}`), 'migration 036: payment records are never truncated'];
    cases[`${tag}:reversal update`] = [await run(`update ${REV_TABLE} set reason_code = 'other' where payment_id = $1`, [q.payment]), NEVER_R];
    cases[`${tag}:reversal delete`] = [await run(`delete from ${REV_TABLE} where payment_id = $1`, [q.payment]), NEVER_R];
    cases[`${tag}:reversal truncate`] = [await run(`truncate ${REV_TABLE}`), 'migration 036: payment reversals are never truncated'];
    const payIns = (select, params) => run(`insert into ${PAY_TABLE} (payment_id, tenant_id, store_id, invoice_id, attempt_id, amount_cents, method, recorded_at, recorded_by) ${select}`, params);
    const fromHeader = (at) => `select pg_catalog.gen_random_uuid(), i.tenant_id, i.store_id, i.invoice_id, pg_catalog.gen_random_uuid(), 1, 'cash', ${at}, $2
      from tmpos_invoice_issue.issued_invoice i where i.invoice_id = $1`;
    cases[`${tag}:payment backdated`] = [await payIns(fromHeader("i.issued_at - interval '1 microsecond'"), [A, f.boss.id]), 'migration 036: a payment record is stamped at or after its invoice\'s issue'];
    const values = (invoice, tenant, store) => payIns(`values (pg_catalog.gen_random_uuid(), $2, $3, $1, pg_catalog.gen_random_uuid(), 1, 'cash', now(), $4)`, [invoice, tenant, store, f.boss.id]);
    cases[`${tag}:payment foreign store`] = [await values(A, f.T, f.S2), SCOPE_P];
    cases[`${tag}:payment foreign tenant`] = [await values(A, other.T, f.S), SCOPE_P];
    cases[`${tag}:payment unknown invoice`] = [await values(randomUUID(), f.T, f.S), SCOPE_P];
    const atIssue = await payIns(fromHeader('i.issued_at'), [A, f.boss.id]);
    assert.ok('value' in atIssue, `${tag}: a payment stamped exactly at the issue is admitted: ${JSON.stringify(atIssue)}`);
    const revIns = (select, params) => run(`insert into ${REV_TABLE} (payment_id, tenant_id, store_id, invoice_id, reason_code, reversed_at, reversed_by) ${select}`, params);
    const fromPayment = (invoice, at) => `select p.payment_id, p.tenant_id, p.store_id, ${invoice}, 'other', ${at}, $2 from ${PAY_TABLE} p where p.payment_id = $1`;
    cases[`${tag}:reversal backdated`] = [await revIns(fromPayment('p.invoice_id', "p.recorded_at - interval '1 microsecond'"), [p.payment, f.boss.id]), 'migration 036: a payment reversal is stamped at or after its payment\'s recording'];
    cases[`${tag}:reversal of another invoice`] = [await revIns(fromPayment(`'${B}'::uuid`, 'now()'), [p.payment, f.boss.id]), SCOPE_R];
    const atRecording = await revIns(fromPayment('p.invoice_id', 'p.recorded_at'), [p.payment, f.boss.id]);
    assert.ok('value' in atRecording, `${tag}: a reversal stamped exactly at the recording is admitted: ${JSON.stringify(atRecording)}`);
  }
  for (const [k, [v, message]] of Object.entries(cases)) assert.deepEqual(v, { code: '23001', message }, k);
  assert.deepEqual(await stateOf([f.T, other.T]), before, 'every refused or rolled-back write changed nothing');
});

// ===========================================================================
// IPR-16..18: the read, the audit CHECK, the rollback's refusals
// ===========================================================================

test('IPR-16 (PAY-11): the payments read — denied and not_found as 035\'s v2 get answers them, cursor_unknown, an explicit null-cursor read with payments present, the amounts and the word over the complete history on every page, paging with p_limit, the empty page, the five status words, the limit\'s range, the UTC encoding, and never a staff identifier; a voided invoice holding an unreversed payment, and unreversed payments above the Total, raise XX001 with their fixed texts (built in a rolled-back owner transaction, the guards lifted)', async () => {
  const f = await scene('read', { invoices: 4 });
  const other = await scene('read-other', { invoices: 1 });
  const [A, none, full, gone] = f.inv;
  const atS2 = await f.issue(f.S2);
  const TA = await totalOf(A);
  const p1 = await pay(f, A, 100n);
  const p2 = await pay(f, A, 200n, { method: 'external_card_terminal' });
  const p3 = await pay(f, A, 300n);
  await unpay(f, A, p2.payment, { reason: 'wrong_method' });
  const head = (invoice, status, total, due, applied, word) => ({ o_outcome: 'payments', o_tenant_id: f.T, o_store_id: f.S, o_invoice_id: invoice, o_status: status,
    o_currency: 'USD', o_total_cents: String(total), o_due_cents: String(due), o_applied_cents: String(applied), o_remaining_cents: String(due - applied), o_payment_status: word });
  const EMPTY = { o_payment_id: null, o_attempt_id: null, o_amount_cents: null, o_method: null, o_recorded_at: null, o_reversed_at: null, o_reason_code: null };
  const stored = new Map((await owner`select p.payment_id, to_char(p.recorded_at at time zone 'UTC', ${UTC_FORMAT}) as at,
      to_char(r.reversed_at at time zone 'UTC', ${UTC_FORMAT}) as rat from tmpos_invoice_payment.invoice_payment p
      left join tmpos_invoice_payment.invoice_payment_reversal r on r.payment_id = p.payment_id where p.invoice_id = ${A}`).map((r) => [r.payment_id, r]));
  const payRow = (x, amount, method, reason = null) => ({ o_payment_id: x.payment, o_attempt_id: x.attempt, o_amount_cents: String(amount), o_method: method,
    o_recorded_at: stored.get(x.payment).at, o_reversed_at: reason === null ? null : stored.get(x.payment).rat, o_reason_code: reason });
  const H = head(A, 'issued', TA, TA, 400n, 'recorded_partly');
  const all = [payRow(p1, 100n, 'cash'), payRow(p2, 200n, 'external_card_terminal', 'wrong_method'), payRow(p3, 300n, 'cash')].map((r) => ({ ...H, ...r }));
  // The explicit null-cursor read with payments present (p_after_payment_id NULL).
  const first = await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A, after: null });
  assert.deepEqual(first, all, 'every payment, oldest first, each carrying the complete history\'s amounts');
  assert.deepEqual(Object.keys(first[0]), READ_KEYS, 'exactly these columns: never recorded_by, reversed_by or an audit field');
  for (const r of first) {
    assert.match(r.o_recorded_at, WIRE_TIME_RE);
    assert.ok(!Object.values(r).includes(f.boss.id), 'no staff identifier in any column');
  }
  // Paging: the amounts are the complete history's on every page.
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A, limit: 2 }), all.slice(0, 2), 'the first page of two');
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A, after: p2.payment, limit: 2 }), all.slice(2), 'after the second: the third');
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A, after: p1.payment, limit: 1 }), all.slice(1, 2), 'a page of one');
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A, after: p3.payment }), [{ ...H, ...EMPTY }], 'past the last: one row, no payment');
  // cursor_unknown: a random id, and another invoice's payment.
  const q = await pay(f, full, 1n);
  const UNKNOWN = [{ o_outcome: 'cursor_unknown', ...Object.fromEntries(READ_KEYS.slice(1).map((k) => [k, null])) }];
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A, after: randomUUID() }), UNKNOWN, 'an unknown cursor');
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A, after: q.payment }), UNKNOWN, 'another invoice\'s payment as the cursor');
  // The words.
  const Tn = await totalOf(none);
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: none }), [{ ...head(none, 'issued', Tn, Tn, 0n, 'no_payment_recorded'), ...EMPTY }]);
  const Tf = await totalOf(full);
  await pay(f, full, Tf - 1n);
  assert.deepEqual((await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: full })).map((r) => [r.o_applied_cents, r.o_remaining_cents, r.o_payment_status]),
    [[String(Tf), '0', 'recorded_in_full'], [String(Tf), '0', 'recorded_in_full']]);
  const zero = await f.issue(f.S, [line('No charge', 1, 0)]);
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: zero }), [{ ...head(zero, 'issued', 0n, 0n, 0n, 'nothing_due'), ...EMPTY }]);
  const Tg = await totalOf(gone);
  const g = await pay(f, gone, 9n);
  await unpay(f, gone, g.payment, { reason: 'wrong_invoice' });
  assert.deepEqual(await void2Call(f.kBoss, { store: f.S, invoice: gone, tenant: f.T }), VOIDED(f.boss, f.T, f.S, gone));
  const voided = await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: gone });
  assert.equal(voided.length, 1, 'the voided invoice keeps its history');
  assert.deepEqual({ ...voided[0], o_recorded_at: undefined, o_reversed_at: undefined },
    { ...head(gone, 'voided', Tg, 0n, 0n, 'voided'), o_payment_id: g.payment, o_attempt_id: g.attempt, o_amount_cents: '9', o_method: 'cash',
      o_recorded_at: undefined, o_reversed_at: undefined, o_reason_code: 'wrong_invoice' }, 'voided: due, applied and remaining 0, the reversed payment listed');
  assert.match(voided[0].o_reversed_at, WIRE_TIME_RE);
  // The authority is 035's v2 get's: read-only levels read; another tenant's session denied; missing and another store's not_found.
  const tech = await member(f, 'reader', 'technician');
  assert.deepEqual((await readCall(tech.key, { tenant: f.T, store: f.S, invoice: A })).map((r) => r.o_payment_id), [p1.payment, p2.payment, p3.payment], 'Invoices View reads');
  await setLevel(f.T, 'technician', 'invoices', 'none');
  const DENIED = [{ o_outcome: 'denied', ...Object.fromEntries(READ_KEYS.slice(1).map((k) => [k, null])) }];
  const NOT_FOUND = [{ o_outcome: 'not_found', ...Object.fromEntries(READ_KEYS.slice(1).map((k) => [k, null])) }];
  assert.deepEqual(await readCall(tech.key, { tenant: f.T, store: f.S, invoice: A }), DENIED, 'Invoices none: denied');
  await clearLevels(f.T);
  assert.deepEqual(await readCall(other.kBoss, { tenant: f.T, store: f.S, invoice: A }), DENIED, 'another tenant\'s session: denied');
  assert.deepEqual(await readCall('no-such-session', { tenant: f.T, store: f.S, invoice: A }), DENIED, 'no session: denied');
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: randomUUID() }), NOT_FOUND, 'a missing invoice');
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: atS2 }), NOT_FOUND, 'another store\'s invoice');
  assert.deepEqual(await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: other.inv[0] }), NOT_FOUND, 'another tenant\'s invoice');
  for (const limit of [0, 52, null]) {
    assert.deepEqual(await errorOf(readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A, limit })),
      { code: '22023', message: 'migration 036 read: the limit is out of range' }, `limit ${limit}`);
  }
  // §12.4: a read that finds an unreversed payment on a voided invoice, or applied above due, raises rather than hide it. Neither
  // state is reachable through the routines: each is built as the owner, the guards lifted, in a transaction that rolls back.
  const corrupt = (invoice, build) => rolledBack(async (tx) => {
    await withTriggersLifted(tx, [...PAYMENT_GUARDS, ...VOID_GUARDS], () => build(tx));
    return readCall(f.kBoss, { tenant: f.T, store: f.S, invoice, db: tx });
  });
  assert.deepEqual({
    voidedWithActive: await corrupt(A, (tx) => tx`insert into tmpos_invoice_void.issued_invoice_void (invoice_id, tenant_id, store_id, reason_code, voided_at, voided_by)
      values (${A}, ${f.T}, ${f.S}, 'other', now(), ${f.boss.id})`),
    aboveTotal: await corrupt(none, (tx) => tx`insert into tmpos_invoice_payment.invoice_payment (payment_id, tenant_id, store_id, invoice_id, attempt_id, amount_cents, method, recorded_at, recorded_by)
      values (${randomUUID()}, ${f.T}, ${f.S}, ${none}, ${randomUUID()}, ${String(Tn)}, 'cash', now(), ${f.boss.id}),
             (${randomUUID()}, ${f.T}, ${f.S}, ${none}, ${randomUUID()}, '1', 'external_card_terminal', now(), ${f.boss.id})`),
  }, {
    voidedWithActive: { code: 'XX001', message: 'migration 036 read: a voided invoice holds an unreversed payment' },
    aboveTotal: { code: 'XX001', message: 'migration 036 read: the unreversed payments exceed the invoice\'s Total' },
  }, 'each integrity fault raised with its fixed text, never answered');
  // A read writes nothing.
  const before = await stateOf([f.T]);
  await readCall(f.kBoss, { tenant: f.T, store: f.S, invoice: A });
  assert.deepEqual(await stateOf([f.T]), before, 'the read wrote nothing');
});

test('IPR-17 (PAY-14): the audit CHECK refuses the metadata keys cvv, cvc, track1, track2 and pinBlock (23514), and admits the same words as values', async () => {
  const f = await scene('card');
  const insert = (tx, metadata) => tx`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
      reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, metadata)
    values (${`ipr-audit-${randomUUID()}`}, ${f.boss.id}, 'store', ${f.T}, ${f.S}, 'store.invoice.void', 'void_issued_invoices', 'allow',
      'invoice_void_other', 'Issued invoice voided. Reason: Other reason.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1',
      'durable_compliance_event', ${metadata})`;
  for (const key of ['cvv', 'cvc', 'track1', 'track2', 'pinBlock']) {
    const r = await rolledBack((tx) => insert(tx, { [key]: 'x', note: 'ok' }));
    assert.deepEqual(r, { code: '23514', message: 'new row for relation "audit_event" violates check constraint "audit_event_metadata_no_card_data_keys_chk"' }, key);
  }
  const ok = await rolledBack((tx) => insert(tx, { note: 'cvv cvc track1 track2 pinBlock' }));
  assert.ok('value' in ok, `the words as values are admitted: ${JSON.stringify(ok)}`);
});

test('IPR-18 (PAY-13, D-PAY-9): 036\'s down refuses (55000, fixed text), changing nothing, while one payment exists; with only a reversal left; with only one payment-action audit record; with only one audit record naming a payment; and with none of them it passes (rolled back)', async () => {
  const f = await scene('down', { invoices: 1 });
  const inv = f.inv[0];
  const p = await pay(f, inv, 2n);
  await unpay(f, inv, p.payment);
  const before = await catalogOf();
  const rows = await stateOf(TENANTS);
  const R = (m) => `migration 036 rollback refused: ${m}`;
  assert.deepEqual(await rolledBack((tx) => tx.unsafe(DOWN_036).simple()), { code: '55000', message: R('a payment record exists, and a rollback never removes one') }, 'one payment');
  const evidence = await rolledBack(async (tx) => {
    const out = {};
    // A reversal alone: its payment removed in replica mode (the foreign key's trigger skipped) with the guards lifted.
    await tx`set local session_replication_role = replica`;
    await withTriggersLifted(tx, PAYMENT_GUARDS, () => tx`delete from tmpos_invoice_payment.invoice_payment`);
    await tx`set local session_replication_role = origin`;
    // ...and alone indeed: every payment audit record removed too, inside the savepoint the attempt rolls back.
    out.reversalOnly = await attempt(tx, async (sp) => {
      await withTriggersLifted(sp, AUDIT_TRIGGER, () => sp`delete from public.audit_event where action_id = any(${PAYMENT_ACTIONS}::text[]) or subject_invoice_payment_id is not null`);
      assert.equal(Number((await sp`select count(*)::int as n from public.audit_event where action_id = any(${PAYMENT_ACTIONS}::text[]) or subject_invoice_payment_id is not null`)[0].n), 0);
      assert.equal(Number((await sp`select count(*)::int as n from tmpos_invoice_payment.invoice_payment`)[0].n), 0);
      await sp.unsafe(DOWN_036).simple();
    });
    await withTriggersLifted(tx, PAYMENT_GUARDS, () => tx`delete from tmpos_invoice_payment.invoice_payment_reversal`);
    // Audit evidence alone: every payment audit record kept, nothing else.
    out.auditOnly = await attempt(tx, (sp) => sp.unsafe(DOWN_036).simple());
    await withTriggersLifted(tx, AUDIT_TRIGGER, () => tx`delete from public.audit_event where action_id = any(${PAYMENT_ACTIONS}::text[]) or subject_invoice_payment_id is not null`);
    out.none = await attempt(tx, (sp) => sp.unsafe(DOWN_036).simple());
    const ins = (db, action, subject) => db`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
        reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_invoice_payment_id)
      values (${`ipr-audit-${randomUUID()}`}, ${f.boss.id}, 'store', ${f.T}, ${f.S}, ${action}, 'record_invoice_payments', 'allow',
        'invoice_payment_recorded_cash', 'Payment recorded against an issued invoice. Method: Cash.', 'succeeded', 'invoice_payment_routine',
        'm7b_invoice_payment_routine@v1', 'durable_compliance_event', ${subject})`;
    out.actionOnly = await attempt(tx, async (sp) => { await ins(sp, 'store.invoice_payment.record', null); await sp.unsafe(DOWN_036).simple(); });
    out.subjectOnly = await attempt(tx, async (sp) => { await ins(sp, 'store.invoice.void', p.payment); await sp.unsafe(DOWN_036).simple(); });
    return out;
  });
  const AUDIT = R('an audit record of a payment action, or naming a payment, exists');
  assert.deepEqual(evidence.value, {
    reversalOnly: { code: '55000', message: R('a payment reversal exists, and a rollback never removes one') },
    auditOnly: { code: '55000', message: AUDIT },
    none: 'accepted',
    actionOnly: { code: '55000', message: AUDIT },
    subjectOnly: { code: '55000', message: AUDIT },
  }, JSON.stringify(evidence));
  assert.deepEqual(diffKeys(before, await catalogOf()), [], 'nothing changed');
  assert.deepEqual(await stateOf(TENANTS), rows);
});

// ===========================================================================
// IPR-19..21: what changes while a routine waits, or before a direct call (PAY-02)
// ===========================================================================

test('IPR-19 (PAY-02): edited grants after a wait — the manager\'s record and reversal take the issued header, then wait SHARED on key 530030 held EXCLUSIVE by an uncommitted owner level narrowing (Invoices -> Manage, Customers -> none); the narrowing commits and the re-read of both levels under the key refuses, nothing written — each wait first seen in pg_locks', async () => {
  const f = await scene('edited', { invoices: 1 });
  const inv = f.inv[0];
  const { payment } = await pay(f, inv, 1n);
  const routines = {
    record: [(db) => recordCall(f.kManager, { store: f.S, invoice: inv, tenant: f.T, amount: 1, db }), NO_REC('refused')],
    reversal: [(db) => reverseCall(f.kManager, { store: f.S, invoice: inv, payment, tenant: f.T, db }), NO_REV('refused')],
  };
  for (const [routine, [call, want]] of Object.entries(routines)) {
    for (const [domain, level] of [['invoices', 'manage'], ['customers', 'none']]) {
      const label = `${routine}, ${domain} -> ${level}`;
      await clearLevels(f.T);
      const narrowing = holding(owner, (tx) => setLevel(f.T, 'manager', domain, level, tx));
      let r = null;
      try {
        await until(() => narrowing.ready, `${label}: the narrowing held`);
        r = running(runtime, (tx) => call(tx));
        await until(async () => r.out !== undefined || (await blockedBy(r.pid, narrowing.pid)), `${label}: the ${routine} waits behind the narrowing`);
        assert.equal(r.out, undefined, `${label}: answered without waiting on the key (${JSON.stringify(r.out)})`);
        assert.deepEqual(await waitsFor(r.pid), [['advisory', 'ShareLock']], `${label}: on the advisory key, SHARED`);
        assert.deepEqual(await advisoryWait(r.pid), [{ class: GUARD_CLASS, mode: 'ShareLock' }], `${label}: key 530030`);
        assert.equal(await rowHeld('tmpos_invoice_issue.issued_invoice', 'invoice_id', inv), true, `${label}: having taken the issued header`);
        const before = await stateOf([f.T]);
        narrowing.release('commit');
        finished(await narrowing.done, `${label}: the narrowing`);
        assert.deepEqual(finished(await r.done, `${label}: the ${routine}`).value, want, `${label}: refused by the re-read under the key`);
        assert.deepEqual({ ...(await stateOf([f.T])), roles: before.roles }, before, `${label}: nothing written`);
      } finally { await settle(narrowing, r); }
    }
  }
  await clearLevels(f.T);
});

test('IPR-20 (PAY-02): a session that expires while the record waits on the issued header — a store owner\'s short session minted once a third session holds the header, the record seen waiting there before the expiry and still waiting after it; released, it is refused after the wait, nothing written (the lifetime adaptive, a discarded attempt itself exactly the refusal)', async (t) => {
  const f = await scene('expiry', { invoices: 1 });
  const inv = f.inv[0];
  const short = await member(f, 'short', 'store_owner');
  const LIFETIMES = [3_000, 6_000, 12_000];
  for (const [n, life] of LIFETIMES.entries()) {
    const holder = holding(owner, (tx) => tx`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${inv} for update`);
    let r = null;
    try {
      await until(() => holder.ready, 'the header held');
      // The expiry set on the DATABASE clock, the one the routine judges by.
      const key = await mint(short.who, { lifetime: life + (await dbNowMs()) - Date.now() });
      const expires = Number((await owner`select expires_at::text as e from tmpos_session.session where session_key = ${key}`)[0].e);
      const before = await stateOf([f.T]);
      r = running(runtime, (tx) => recordCall(key, { store: f.S, invoice: inv, tenant: f.T, amount: 1, db: tx }));
      await until(async () => r.out !== undefined || (await blockedBy(r.pid, holder.pid)), 'the record waits on the header');
      // Valid only if the record was seen waiting at a database time before its session's expiry.
      const engaged = r.out === undefined && (await dbNowMs()) < expires;
      if (engaged) {
        assert.deepEqual(await rowWaitOn(r.pid), ['tmpos_invoice_issue.issued_invoice'], 'the wait is on the issued header');
        await until(async () => (await dbNowMs()) > expires + 50, 'the session expired', life + 6_000);
        assert.equal(await blockedBy(r.pid, holder.pid), true, 'still waiting on the header once its session had expired');
      }
      holder.release('rollback');
      await holder.done;
      // Engaged or discarded, the answer is exactly the refusal and nothing is written: a retry never hides another answer.
      assert.deepEqual(finished(await r.done, 'the record').value, NO_REC('refused'), engaged ? 'refused after the wait' : 'the discarded attempt');
      assert.deepEqual(await stateOf([f.T]), before, 'nothing written');
      if (engaged) {
        t.diagnostic(`IPR-20: the session expired during the wait on attempt ${n + 1} of ${LIFETIMES.length} (lifetime ${life} ms)`);
        return;
      }
      t.diagnostic(`IPR-20: attempt ${n + 1} of ${LIFETIMES.length} did not engage (lifetime ${life} ms)`);
    } finally { await settle(holder, r); }
  }
  throw new Error(`lever did not engage: the session expired during the wait, in ${LIFETIMES.length} attempts`);
});

test('IPR-21 (PAY-02): session and standing changes at a direct call — an expired session (its minted expiry passed on the database clock), a suspended account and a suspended membership: the record and the reversal refused, nothing written; each changed actor\'s record and reversal applied before its change', async () => {
  const f = await scene('standing', { invoices: 1 });
  const inv = f.inv[0];
  const { payment } = await pay(f, inv, 1n);
  const expired = await member(f, 'expired', 'store_owner');
  const expiredKey = await mint(expired.who, { lifetime: 1_500 + (await dbNowMs()) - Date.now() });
  const [{ e }] = await owner`select expires_at::text as e from tmpos_session.session where session_key = ${expiredKey}`;
  const accountOff = await member(f, 'account', 'store_owner');
  const grantOff = await member(f, 'grant', 'store_owner');
  for (const m of [accountOff, grantOff]) {
    const p = await pay(f, inv, 1n, { who: m.who, key: m.key });
    await unpay(f, inv, p.payment, { who: m.who, key: m.key });
  }
  assert.equal((await owner`update app_user set status = 'suspended' where internal_user_id = ${accountOff.who.id} returning 1`).length, 1);
  assert.equal((await owner`update user_membership set status = 'suspended' where membership_id = ${grantOff.who.memberships[0]} returning 1`).length, 1);
  await until(async () => (await dbNowMs()) > Number(e) + 50, 'the short session expired', 6_000);
  const before = await stateOf([f.T]);
  const got = {};
  for (const [label, key] of [['an expired session', expiredKey], ['a suspended account', accountOff.key], ['a suspended membership', grantOff.key]]) {
    got[`record: ${label}`] = await recordCall(key, { store: f.S, invoice: inv, tenant: f.T, amount: 1 });
    got[`reversal: ${label}`] = await reverseCall(key, { store: f.S, invoice: inv, payment, tenant: f.T });
  }
  assert.deepEqual(got, Object.fromEntries(Object.keys(got).map((k) => [k, k.startsWith('record') ? NO_REC('refused') : NO_REV('refused')])), 'each refused');
  assert.deepEqual(await stateOf([f.T]), before, 'nothing written');
});
