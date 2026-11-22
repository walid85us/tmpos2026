// Phase 4.0 M7B-CREDITNOTES credit activity read — migration 039's routine tmpos_invoice_credit_note.m7b_store_credit_activity
// against REAL, crash-durable PostgreSQL: the layer-D rows of doc 18 §13, exercised as the runtime's own non-owner login, every
// call bound as a production adapter would bind it. Each title starts with its acceptance id.
//
// AUTHORED 2026-11-18 UNDER DOC 18 §15(a) (step 2: the database suite first). WRITTEN — NOT RUN: the owner paused tests, database
// execution, QA and CI on 2026-11-18. NO RESULT HERE IS EVIDENCE until §15(b) runs it on a disposable database and records it.
//
//   CA-18  039 up and down: ledger 001..039; 038's down fails (2BP01) while 039 is applied; 039's down leaves 038 unchanged (its
//          catalog read before and after the down) and on its approved baseline (nineteen routine ACLs, the preflight's 038 lines),
//          refuses (55000) on a baseline breach and on a 038 definition changed during it, and refuses, changing nothing, while 039
//          is not applied; up again. (The preflight's refusal of a fake next row is the moved '040'
//          fixture in productionEntryPreflight / tenantEntry, not repeated here.)
//   CA-17  EXECUTE on the routine: tmpos_app only; the anchor: nobody; the preflight's approved grant list carries the routine.
//   CA-19  read-only: STABLE, SECURITY DEFINER, pinned settings; a call assigns no transaction id, writes no row (audit_event
//          included), takes no row or advisory lock (ACCESS SHARE only, gone at transaction end). §6.2 step 5: exactly 14 columns.
//   CA-40  p_limit: null, 0, 52 raise 22023; 1 and 51 bound the page; nothing written in any case.
//   CA-01  newest number first; 51 asked of 120 gives 51; an empty store gives no row.
//   CA-02  another store of the tenant: its notes never appear; its id for this owner is denied.
//   CA-03  another tenant, or a p_expected_tenant mismatch: one denied row with NULLs.
//   CA-04  a manager at Invoices Full (and technician, sales staff, a tenant-scope owner): denied.
//   CA-07  cursor walk over 123 notes, page of 50 with 51 asked: strictly descending, no repeat, no gap, ends.
//   CA-09  a cursor of another store, another tenant, or a random uuid: one cursor_unknown row; a denied caller's cursor is never
//          read (denied wins, whatever the cursor).
//   CA-11  withdrawn note: withdrawal populated (not before issue, closed reason, the withdrawer's name, not the issuer's when a
//          second owner withdraws); active note: withdrawal null; a voided invoice's withdrawn notes appear.
// (CA-12's long-name and control-character cases are not in this step's list; not covered here.)
//
// DISPOSABLE ONLY, DURABLE (CA-11 issues real credit notes, whose proofs need fsync on). Leaves 001-039 applied and no credit note,
// withdrawal, registration, credit-note audit row, customer, session, login or proof key of its own. Failure output carries only outcome
// words, numbers, booleans and validated SQLSTATEs, never a key or database error text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, installTestPaymentProofKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { APPROVED_ROLE_GRANTS, REQUIRED_MIGRATIONS } from '../../server/persistence/postgresStartupPreflight.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const migFile = (name) => readFileSync(`${MIG_DIR}/${name}`, 'utf8'); // read at use: a missing file fails its test, not the load
const DOWN_038 = () => migFile('038_m7b_invoice_credit_note.down.sql');
const DOWN_039 = () => migFile('039_m7b_store_credit_activity.down.sql');
const CN = 'tmpos_invoice_credit_note';
const PAY = 'tmpos_invoice_payment';
const ACTIVITY = `${CN}.m7b_store_credit_activity(text, uuid, uuid, uuid, integer)`;
const ANCHOR = `${CN}.m7b_store_credit_activity_prerequisites()`;
const ACTIVITY_GRANT_LINE = 'tmpos_app|a|function|tmpos_invoice_credit_note.m7b_store_credit_activity(pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,integer)|EXECUTE';
// 038's ten routines tmpos_app executes (038 up :2754-2763); 039's down must leave each with exactly the owner's and tmpos_app's EXECUTE.
const GRANTED_038 = [`${CN}.m7b_invoice_credit_note_register(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)`,
  `${CN}.m7b_invoice_credit_note_registration_proof(text, uuid, uuid, uuid, uuid, integer)`,
  `${CN}.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)`,
  `${CN}.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer)`,
  `${CN}.m7b_invoice_credit_note_settle(text, uuid, uuid, uuid, uuid, bigint, uuid)`,
  `${CN}.m7b_invoice_credit_note_withdraw(text, uuid, uuid, uuid, uuid, bigint, text, uuid)`,
  `${CN}.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer)`,
  `${PAY}.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer)`,
  `${PAY}.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)`,
  `${PAY}.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text)`];
// 038's other nine functions, each the owner's alone (038 up :2729-2737; its postcondition (b), :2769-2772).
const OWNED_038 = ['counter_guard()', 'registration_guard()', 'guard()', 'withdrawal_guard()', 'truncate_guard()', 'payment_barrier()',
  'void_barrier()', 'registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint, bigint, text)', 'prerequisites()']
  .map((s) => `${CN}.m7b_invoice_credit_note_${s}`);
const TABLES_038 = ['invoice_credit_note_counter', 'invoice_credit_note_registration', 'invoice_credit_note', 'invoice_credit_note_withdrawal'];
// Doc 18 §6.1: the fourteen result columns, in order, with their types (§6.2 step 5: nothing else, no actor id, email, registration id).
const COLUMNS = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_credit_note_id', 'o_credit_note_number', 'o_invoice_id', 'o_invoice_number',
  'o_gross_cents', 'o_reason_code', 'o_issued_at', 'o_issued_by_name', 'o_withdrawn_at', 'o_withdrawal_reason_code', 'o_withdrawn_by_name'];
const RESULT_TYPE = 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_credit_note_id uuid, o_credit_note_number bigint, '
  + 'o_invoice_id uuid, o_invoice_number bigint, o_gross_cents bigint, o_reason_code text, o_issued_at text, o_issued_by_name text, '
  + 'o_withdrawn_at text, o_withdrawal_reason_code text, o_withdrawn_by_name text)';
const DEFINER_CONFIG = ['search_path=pg_catalog, pg_temp', 'row_security=off', 'debug_print_parse=off', 'debug_print_rewritten=off',
  'debug_print_plan=off'];
const TIME_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'; // 038's c_format (038 up :1893), the list's and the lookup's
const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const WITHDRAWAL_REASONS = ['entered_in_error', 'wrong_amount', 'wrong_invoice']; // 038 up :360
const CN_ACTIONS = ['store.invoice_credit_note.register', 'store.invoice_credit_note.issue', 'store.invoice_credit_note.settle',
  'store.invoice_credit_note.withdraw'];
const MIGRATOR = { purpose: 'migration', migratorRef: 'sca-migrator', runtimeRef: 'sca-runtime' };
const LOCK_KEY = 529_641;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_sca_probe';
const HOUR = 3_600_000;
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const ROLLBACK = new Error('sca: roll back');

// ---- secret-safe failure output (as invoiceCreditNoteRoutine :72-77) ----
const isSqlState = (code) => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code);
const safeCode = (e) => (e?.code === undefined || e?.code === null ? 'none' : isSqlState(e.code) ? e.code : 'unknown');
// Keeps a validated SQLSTATE as `code` (so codeOf still reads it through a sealed error); drops message, query and parameters.
const sealed = (label, e) => Object.assign(new Error(`${label}: ${isSqlState(e?.code) ? `SQLSTATE ${e.code}` : 'failed'}`),
  isSqlState(e?.code) ? { code: e.code } : {});
const seal = (label) => (e) => { throw sealed(label, e); };
async function errorOf(p) { try { await p; return null; } catch (e) { return e; } }
const codeOf = async (p) => { const e = await errorOf(p); return e === null ? 'ok' : safeCode(e); };
/** Runs `sql` in a READ COMMITTED transaction on `db` and always rolls it back; answers 'ran' or the SQLSTATE it raised. */
const ranOrCode = async (db, sql) => {
  const e = await db.begin(RC, async (tx) => { await tx.unsafe(sql).simple(); throw ROLLBACK; }).then(() => null, (x) => x);
  return e === ROLLBACK ? 'ran' : safeCode(e);
};

// ---- the session mint (invoiceCreditNoteRoutine :80-84) ----
const netstring = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from(`${b.length}:`), b, Buffer.from(',')]); };
const mintProof = (issuer, key, r, expiresAt) => createHmac('sha256', issuer).update(Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion, r.authenticatedAt, r.createdAt, r.lastSeenAt,
    r.validatedAt, expiresAt].map((v) => netstring(String(v)))])).digest();
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

// ---- cluster lifecycle (invoiceCreditNoteRoutine :99-127, through 039) ----
const TARGET = resolveDisposableTarget('SCA', { durable: true });
const cluster = TARGET.cluster ?? null;
assertDisposableTestDsn(TARGET.dsn);
const DATABASE = new URL(TARGET.dsn).pathname.slice(1);
const connect = (user, max) => testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });
const owner = connect(undefined, 4);
let runtime = null;
let prover = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let issuerKeyBefore;
let above039;
let ME;

async function trustedApply(through) {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET.dsn));
  try {
    const port = createNodeFsPort(MIG_DIR, MIG_REL);
    return await runTrustedApply({
      fsPort: { ...port, list: () => port.list().filter((n) => n.slice(0, 3) <= through) },
      adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW,
      deadlineMs: 300_000,
    });
  } finally {
    await handle.dispose();
  }
}
const applied039 = async () => (await owner`select pg_catalog.to_regprocedure(${ACTIVITY}) is not null as e`)[0].e;
const applied038 = async () => (await owner`select pg_catalog.to_regnamespace(${CN}) is not null as e`)[0].e;
const down039 = () => owner.begin(RC, async (tx) => {
  await tx.unsafe(DOWN_039()).simple();
  await tx`delete from public.schema_migrations where version = '039'`;
});
const ledgerVersions = async () => (await owner`select version from public.schema_migrations order by version`).map((r) => r.version);
const through = (n) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(3, '0'));
/** The function's EXECUTE grantees from its explicit or default ACL, sorted (invoiceCreditNoteMigrationSmoke :82-84). */
const grantees = async (sig) => (await owner`select pg_catalog.string_agg(g.grantee::regrole::text, ',' order by g.grantee::regrole::text) as g
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
  where p.oid = ${sig}::regprocedure and g.privilege_type = 'EXECUTE'`)[0].g;
const withApp = () => [ME, 'tmpos_app'].sort().join(',');
/**
 * 038's catalog as this test reads it (doc 18 §9.2: "038's tables are unchanged"), written apart from the down's own record: the
 * schema; each relation in it with its columns, constraints, indexes and triggers; every 038 routine (the schema's functions but
 * 039's two, and the three replacements in tmpos_invoice_payment) with its definition; and the barrier triggers on other tables.
 */
const catalog038 = async () => (await owner`select pg_catalog.jsonb_build_object(
    'schema', (select pg_catalog.jsonb_build_array(n.nspowner::regrole::text, n.nspacl::text, pg_catalog.obj_description(n.oid, 'pg_namespace'))
                 from pg_catalog.pg_namespace n where n.nspname = ${CN}),
    'relations', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name', c.relname, 'kind', c.relkind, 'owner', c.relowner::regrole::text, 'acl', c.relacl::text, 'rls', c.relrowsecurity,
        'force', c.relforcerowsecurity, 'options', c.reloptions, 'comment', pg_catalog.obj_description(c.oid, 'pg_class'),
        'storage', pg_catalog.jsonb_build_array(c.relpersistence, c.relam::int, c.reltablespace::int, c.relreplident),
        'columns', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attnum, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
                       a.attnotnull, a.attidentity, a.attgenerated, a.attcollation::int, pg_catalog.pg_get_expr(d.adbin, d.adrelid), a.attstorage,
                       a.attcompression, a.attstattarget, a.attacl::text, pg_catalog.col_description(c.oid, a.attnum)) order by a.attnum)
                      from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                     where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
        'constraints', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(k.conname, pg_catalog.pg_get_constraintdef(k.oid), k.condeferrable,
                          k.condeferred, k.convalidated, pg_catalog.obj_description(k.oid, 'pg_constraint')) order by k.conname)
                          from pg_catalog.pg_constraint k where k.conrelid = c.oid),
        'indexes', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.pg_get_indexdef(i.indexrelid), i.indisclustered, i.indisreplident)
                      order by pg_catalog.pg_get_indexdef(i.indexrelid))
                      from pg_catalog.pg_index i where i.indrelid = c.oid),
        'triggers', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled,
                       pg_catalog.obj_description(t.oid, 'pg_trigger')) order by t.tgname)
                       from pg_catalog.pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal),
        'policies', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(o.polname, o.polcmd, o.polpermissive, o.polroles::text,
                       pg_catalog.pg_get_expr(o.polqual, o.polrelid), pg_catalog.pg_get_expr(o.polwithcheck, o.polrelid)) order by o.polname)
                       from pg_catalog.pg_policy o where o.polrelid = c.oid),
        'rules', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.pg_get_ruledef(r.oid), r.ev_enabled) order by r.rulename)
                    from pg_catalog.pg_rewrite r where r.ev_class = c.oid),
        'statistics', (select pg_catalog.jsonb_agg(pg_catalog.pg_get_statisticsobjdef(s.oid) order by s.stxname)
                         from pg_catalog.pg_statistic_ext s where s.stxrelid = c.oid)) order by c.relname)
        from pg_catalog.pg_class c where c.relnamespace = ${CN}::regnamespace),
    'routines', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.oid::regprocedure::text, p.proowner::regrole::text, p.proacl::text,
                   pg_catalog.obj_description(p.oid, 'pg_proc'), pg_catalog.pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p
       where (p.pronamespace = ${CN}::regnamespace and p.proname not in ('m7b_store_credit_activity', 'm7b_store_credit_activity_prerequisites'))
          or (p.pronamespace = ${PAY}::regnamespace and p.proname in ('m7b_invoice_payment_record_v3', 'm7b_invoice_void_v3', 'm7b_invoice_payments_get_v2'))),
    'barriers', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled)
                   order by t.tgrelid::regclass::text, t.tgname)
        from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid = t.tgfoid join pg_catalog.pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and p.pronamespace = ${CN}::regnamespace and c.relnamespace <> ${CN}::regnamespace)
  ) as s`)[0].s;

const TRIGGER_MODE = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' };
/** invoiceCreditNoteRoutine :137-149: disable, run, restore each trigger's own mode, in the caller's transaction. */
async function withTriggersLifted(tx, triggers, fn) {
  const modes = [];
  for (const [rel, name] of triggers) {
    if ((await tx`select pg_catalog.to_regclass(${rel}) is not null as e`)[0].e === false) continue;
    const [found] = await tx`select tgenabled as mode from pg_catalog.pg_trigger where tgrelid = ${rel}::regclass and tgname = ${name}`;
    if (found === undefined) continue;
    modes.push([rel, name, TRIGGER_MODE[found.mode]]);
    await tx.unsafe(`alter table ${rel} disable trigger ${name}`);
  }
  const value = await fn();
  for (const [rel, name, restore] of modes) await tx.unsafe(`alter table ${rel} ${restore} ${name}`);
  return value;
}
const CN_GUARDS = [[`${CN}.invoice_credit_note_withdrawal`, 'trg_invoice_credit_note_withdrawal_guard'],
  [`${CN}.invoice_credit_note_registration`, 'trg_invoice_credit_note_registration_guard'], [`${CN}.invoice_credit_note`, 'trg_invoice_credit_note_guard'],
  [`${CN}.invoice_credit_note_counter`, 'trg_invoice_credit_note_counter_guard']];

/** invoiceCreditNoteRoutine :154-191: every row this suite's tenants own, guards lifted inside the one transaction only. */
async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    await withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']], async () => {
      await sql`delete from public.audit_event where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`update public.audit_event set subject_customer_id = null
        where subject_customer_id in (select customer_id from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]))`;
    });
    if (await applied038()) {
      await withTriggersLifted(sql, CN_GUARDS, async () => {
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`update tmpos_invoice_credit_note.invoice_credit_note_registration set credit_note_id = null where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = any(${TENANTS}::uuid[])`;
      });
    }
    await withTriggersLifted(sql, [['tmpos_invoice_void.issued_invoice_void', 'trg_issued_invoice_void_guard']],
      () => sql`delete from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${TENANTS}::uuid[])`);
    await withTriggersLifted(sql, [['tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_guard'], ['tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_guard'],
      ['tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_guard'], ['tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_guard']], async () => {
      await sql`delete from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${TENANTS}::uuid[])`;
    });
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    if (drafts.length > 0) {
      await withTriggersLifted(sql, [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']], async () => {
        await sql`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = any(${drafts}::uuid[])`;
        await sql`delete from tmpos_invoice_draft.invoice_draft where draft_id = any(${drafts}::uuid[])`;
      });
    }
    // Last, once no draft or issued invoice names them (invoiceCreditNoteHttp :241): 023's down refuses while any customer has a creation time.
    await sql`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(sealed('SCA teardown step', err)); } };
  try {
    await step(cleanAll);
    await step(async () => { if (!(await applied039())) assert.equal((await trustedApply('039')).outcome, 'complete'); });
    await step(() => owner`delete from tmpos_invoice_payment.payment_proof_key where singleton`);
    if (UIDS.length > 0) {
      await step(async () => { for (const r of await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`) KEYS.add(r.session_key); });
    }
    if (KEYS.size > 0) await step(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
    if (UIDS.length > 0) await step(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
    if (issuerKeyBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_mint.issuer_key where singleton`;
        if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
      }));
    }
    for (const c of [runtime, prover]) if (c) await step(() => c.end({ timeout: 5 }));
    await step(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
    await step(() => owner.unsafe(`do $$ begin if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if; end $$;`));
    await step(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
    // Postcondition: no credit-note evidence anywhere, so later suites' 038 down (refusing while evidence exists) still runs.
    await step(async () => assert.deepEqual(await evidence(), { notes: 0, withdrawals: 0, registrations: 0, audits: 0 }, 'SCA left no credit-note evidence'));
    await step(() => above039?.restore());
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'SCA teardown failed');
});

/** Every credit-note row and credit-note audit row in the database (038's down refuses while any exists). */
async function evidence() {
  const [s] = await owner`select (select count(*) from tmpos_invoice_credit_note.invoice_credit_note)::int as notes,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal)::int as withdrawals,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration)::int as registrations,
      (select count(*) from public.audit_event where action_id = any(${CN_ACTIONS}::text[])
         or subject_invoice_credit_note_id is not null or subject_invoice_credit_note_registration_id is not null)::int as audits`;
  return { ...s };
}

const APPLY = await (async () => {
  try {
    assert.equal((await owner`select pg_catalog.current_setting('fsync') as f`)[0].f, 'on', 'the durable harness: fsync on');
    await owner.unsafe(`do $$ begin
      if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;`);
    await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
    await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
    above039 = await rollBackAbove(owner, MIG_DIR, '039');
    const report = await trustedApply('039');
    await owner.unsafe(`do $$ begin if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if; end $$;`);
    await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
    await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
    await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
    await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
    runtime = connect(RUNTIME_LOGIN, 4);
    prover = connect(RUNTIME_LOGIN, 1);
    issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
    if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
    await installTestIssuerKey(owner, ISSUER_KEY);
    await installTestPaymentProofKey(owner, randomBytes(32));
    ME = (await owner`select current_user::text as me`)[0].me;
    return report;
  } catch (err) {
    for (const c of [runtime, prover, owner]) if (c) await c.end({ timeout: 5 }).catch(() => {});
    if (cluster) cluster.stop();
    throw sealed('SCA setup', err);
  }
})();

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic; invoiceCreditNoteRoutine :268-347)
// ---------------------------------------------------------------------------
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
async function actor(label, grants, displayName = null) {
  const uid = `sca-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`
    .catch(seal('SCA actor'));
  await owner`insert into app_user (internal_user_id, status, display_name) values (${id}, 'active', ${displayName})`.catch(seal('SCA actor'));
  const memberships = [];
  for (const g of grants) {
    const [{ membership_id: mid }] = await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${g.tenant}, ${g.store ?? null}, ${g.scope}, ${g.role}, 'active') returning membership_id`.catch(seal('SCA actor'));
    memberships.push(mid);
  }
  UIDS.push(uid);
  return { id, uid, memberships, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
async function mint(who) {
  const key = newKey();
  const at = Date.now();
  const r = { audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
    securityVersion: 't2:sca', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at };
  const expiresAt = at + 8 * HOUR;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${mintProof(ISSUER_KEY, key, r, expiresAt)}::bytea) as outcome`.catch((e) => { throw sealed('SCA mint', e); });
  assert.equal(outcome, 'created', 'a tenant session');
  return key;
}
async function settingsSet(key, store, tenant) {
  const [row] = await runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_issuing_settings_set($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
    [key, store, tenant, '0', 'SCA Legal Name LLC', 'SCA Store', '1 Main St\nSpringfield', 'TAX-SCA-1', 'exclusive_rate', 8875])
    .catch((e) => { throw sealed('SCA settings', e); });
  assert.equal(row.o_outcome, 'applied', 'the store\'s issuing settings');
}
/**
 * A fresh tenant with store S (owner `boss`, a second owner `boss2` with no display name, a manager, a technician, sales staff)
 * and store S2 of the same tenant (owner `bossB`), plus a tenant-scope owner `own` (settings only). Every actor has a session.
 */
async function scene(label) {
  const [{ tenant_id: T }] = await owner`insert into tenant (display_name, status) values (${`sca-${label}-${SUFFIX}`}, 'active') returning tenant_id`
    .catch(seal('SCA scene'));
  TENANTS.push(T);
  const S = (await owner`insert into store (tenant_id, store_name, status) values (${T}, ${`sca ${label} ${SUFFIX}`}, 'active') returning store_id`
    .catch(seal('SCA scene')))[0].store_id;
  const S2 = (await owner`insert into store (tenant_id, store_name, status) values (${T}, ${`sca ${label} other ${SUFFIX}`}, 'active') returning store_id`
    .catch(seal('SCA scene')))[0].store_id;
  const C = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${C}, ${T}, ${`SCA ${label} ${SUFFIX}`})`.catch(seal('SCA scene'));
  const a = {
    boss: await actor(`${label}-owner`, [storeGrant(T, S, 'store_owner')], `SCA Owner ${label}`),
    boss2: await actor(`${label}-owner2`, [storeGrant(T, S, 'store_owner')], null),
    manager: await actor(`${label}-manager`, [storeGrant(T, S, 'manager')], `SCA Manager ${label}`),
    tech: await actor(`${label}-tech`, [storeGrant(T, S, 'technician')], `SCA Tech ${label}`),
    sales: await actor(`${label}-sales`, [storeGrant(T, S, 'sales_staff')], `SCA Sales ${label}`),
    own: await actor(`${label}-tenant-owner`, [{ scope: 'tenant', tenant: T, role: 'store_owner' }], `SCA Tenant Owner ${label}`),
    bossB: await actor(`${label}-ownerB`, [storeGrant(T, S2, 'store_owner')], `SCA Owner B ${label}`),
  };
  const k = {};
  for (const [name, who] of Object.entries(a)) k[name] = await mint(who);
  await settingsSet(k.own, S, T);
  await settingsSet(k.own, S2, T);
  return { label, T, S, S2, C, a, k };
}
const X_LINES = [{ description: 'Repair', quantity: 1, unitPriceCents: 10_000 }]; // Total 10,888 at 8.875 %
async function invoice(f, { store = f.S, key = store === f.S2 ? f.k.bossB : f.k.boss } = {}) {
  const draft = randomUUID();
  const [c] = await runtime.unsafe(`select o_outcome from tmpos_invoice_edit.m7b_invoice_draft_create_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [key, store, draft, f.T, f.C, JSON.stringify(X_LINES), '10000']).catch((e) => { throw sealed('SCA draft', e); });
  assert.equal(c.o_outcome, 'applied', 'draft saved');
  const id = randomUUID();
  const [i] = await runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_invoice_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [key, store, draft, f.T, '1', '1', '1', id]).catch((e) => { throw sealed('SCA issue invoice', e); });
  assert.equal(i.o_outcome, 'applied', 'invoice issued');
  return id;
}

/**
 * `n` confirmed credit notes on `invoice` at `store`, issued by `who`, numbered on from the store's counter, written by owner SQL in
 * ONE transaction with 038's row guards lifted inside it only (invoiceCreditNoteHttp's seedNotes, DB51, with the store a parameter).
 * Gross 1 cent each (tax 0, net 1). The notes' ids, oldest (lowest number) first.
 */
async function seedNotes(f, invoiceId, who, n, { store = f.S } = {}) {
  const regs = Array.from({ length: n }, () => randomUUID());
  const attempts = Array.from({ length: n }, () => randomUUID());
  const notes = Array.from({ length: n }, () => randomUUID());
  await owner.begin(RC, async (sql) => withTriggersLifted(sql, CN_GUARDS, async () => {
    const [{ last }] = await sql`select coalesce((select c.last_number from tmpos_invoice_credit_note.invoice_credit_note_counter c
      where c.tenant_id = ${f.T} and c.store_id = ${store}), 0)::int as last`;
    await sql`insert into tmpos_invoice_credit_note.invoice_credit_note_registration (registration_id, tenant_id, store_id, invoice_id,
        registered_by, attempt_id, gross_cents, reason_code, session_digest, key_generation, registered_xact, registered_at, acknowledged_at)
      select s.r, ${f.T}, ${store}, ${invoiceId}, ${who.id}, s.a, 1, 'goodwill', pg_catalog.sha256(pg_catalog.convert_to(s.r::text, 'UTF8')),
        (select k.generation from tmpos_invoice_payment.payment_proof_key k where k.singleton), pg_catalog.pg_current_xact_id(),
        i.issued_at + s.n * interval '1 microsecond', i.issued_at + s.n * interval '1 microsecond'
      from unnest(${regs}::uuid[], ${attempts}::uuid[]) with ordinality as s(r, a, n)
      join tmpos_invoice_issue.issued_invoice i on i.invoice_id = ${invoiceId}`;
    await sql`insert into tmpos_invoice_credit_note.invoice_credit_note (credit_note_id, tenant_id, store_id, invoice_id, attempt_id, registration_id,
        credit_note_number, gross_cents, tax_cents, net_cents, reason_code, issued_at, issued_by)
      select s.c, g.tenant_id, g.store_id, g.invoice_id, g.attempt_id, g.registration_id, ${last}::bigint + s.n, 1, 0, 1, g.reason_code,
        g.registered_at, g.registered_by
      from unnest(${regs}::uuid[], ${notes}::uuid[]) with ordinality as s(r, c, n)
      join tmpos_invoice_credit_note.invoice_credit_note_registration g on g.registration_id = s.r`;
    await sql`update tmpos_invoice_credit_note.invoice_credit_note_registration g set credit_note_id = c.credit_note_id
      from tmpos_invoice_credit_note.invoice_credit_note c where c.registration_id = g.registration_id and g.registration_id = any(${regs}::uuid[])`;
    await sql`insert into tmpos_invoice_credit_note.invoice_credit_note_counter (tenant_id, store_id, last_number) values (${f.T}, ${store}, ${last + n})
      on conflict (tenant_id, store_id) do update set last_number = excluded.last_number`;
  })).catch((e) => { throw sealed('SCA seed notes', e); });
  return notes;
}

// ---- real credit notes through 038's routines (invoiceCreditNoteRoutine :352-404), for CA-11 ----
const run = async (db, [sql, params]) => (await db.unsafe(sql, params).catch(seal('SCA call'))).map((r) => ({ ...r }));
const one = async (db, q) => (await run(db, q))[0];
const word = async (db, q) => (await one(db, q)).o_outcome;
const Q = {
  register: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_register($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8::text, $9::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.registration, a.attempt, String(a.gross), a.reason, randomUUID()]],
  proof: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [k, a.store, a.invoice, a.tenant, a.registration, a.wait ?? 1000]],
  issue: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.cn, a.registration, a.attempt, String(a.gross), a.reason, a.proof, randomUUID()]],
  settle: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_settle($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.attempt, String(a.version), randomUUID()]],
  withdraw: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_withdraw($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::text, $8::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.cn, '1', a.wreason, randomUUID()]],
  void3: (k, a) => [`select * from ${PAY}.m7b_invoice_void_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`,
    [k, a.store, a.invoice, a.tenant, '1', 'issued_in_error']],
};
/** A whole credit by `boss`: register, proof (the one-connection prover), issue, confirm. */
async function credit(f, invoiceId, gross, reason = 'pricing_error') {
  const a = { store: f.S, invoice: invoiceId, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), gross, reason, cn: randomUUID() };
  // invoiceCreditNoteMigrationSmoke ICS-02's precondition: the prover resolves the proof routine (an unregistered id, not_found)
  // before the registration, so the real proof call writes no WAL of its own ahead of its target (CA-18's rolled-back downs
  // leave dead catalog rows a first lookup would prune).
  assert.equal(await word(prover, Q.proof(f.k.boss, { ...a, registration: randomUUID(), wait: 0 })), 'not_found', 'proof routine warmed');
  assert.equal(await word(runtime, Q.register(f.k.boss, a)), 'applied', 'credit registered');
  const p = await one(prover, Q.proof(f.k.boss, a));
  assert.equal(p.o_outcome, 'proof', 'credit-note proof');
  a.proof = p.o_proof;
  assert.equal(await word(runtime, Q.issue(f.k.boss, a)), 'applied', 'credit note issued');
  assert.equal(await word(runtime, Q.settle(f.k.boss, { ...a, version: 2 })), 'applied', 'registration confirmed');
  return a;
}
const withdraw = (f, a, wreason, key = f.k.boss) => word(runtime, Q.withdraw(key, { ...a, wreason }));

// ---------------------------------------------------------------------------
// the routine under test, bound as the adapter binds it (doc 18 §6.6: PGCN:350-367's shape)
// ---------------------------------------------------------------------------
const activitySql = `select * from ${CN}.m7b_store_credit_activity($1::text, $2::uuid, $3::uuid, $4::uuid, $5::integer)`;
const activityArgs = (key, tenant, store, after = null, limit = 51) => [key, tenant, store, after, limit];
const activity = async (key, tenant, store, { after = null, limit = 51, db = runtime } = {}) =>
  (await db.unsafe(activitySql, activityArgs(key, tenant, store, after, limit)).catch(seal('SCA activity'))).map((r) => ({ ...r }));
const nullsBut = (outcome) => Object.fromEntries(COLUMNS.map((c) => [c, c === 'o_outcome' ? outcome : null]));
/** One row, its outcome `outcome`, every other column null: the routine's 'denied' and 'cursor_unknown' answers. */
const assertSingle = (rows, outcome, label) => assert.deepEqual(rows, [nullsBut(outcome)], `${label}: one ${outcome} row with NULLs`);
const numbersOf = (rows) => rows.map((r) => Number(r.o_credit_note_number));

/** The expected row of every credit note of (tenant, store), from the tables themselves (owner SQL), keyed by credit-note id. */
async function truth(T, S) {
  const rows = await owner`select c.credit_note_id, c.tenant_id, c.store_id, c.credit_note_number::text as n, c.invoice_id, i.number::text as inv,
      c.gross_cents::text as g, c.reason_code::text as reason, pg_catalog.to_char(c.issued_at at time zone 'UTC', ${TIME_FORMAT}) as issued_at,
      ui.display_name::text as issued_by, pg_catalog.to_char(w.withdrawn_at at time zone 'UTC', ${TIME_FORMAT}) as withdrawn_at,
      w.reason_code::text as wreason, case when w.credit_note_id is not null then uw.display_name::text end as withdrawn_by
    from tmpos_invoice_credit_note.invoice_credit_note c
    join tmpos_invoice_issue.issued_invoice i on i.invoice_id = c.invoice_id and i.tenant_id = c.tenant_id and i.store_id = c.store_id
    left join tmpos_invoice_credit_note.invoice_credit_note_withdrawal w on w.credit_note_id = c.credit_note_id
    left join public.app_user ui on ui.internal_user_id = c.issued_by
    left join public.app_user uw on uw.internal_user_id = w.withdrawn_by
    where c.tenant_id = ${T} and c.store_id = ${S}`.catch(seal('SCA truth'));
  return new Map(rows.map((r) => [r.credit_note_id, {
    o_outcome: 'credit_note', o_tenant_id: r.tenant_id, o_store_id: r.store_id, o_credit_note_id: r.credit_note_id, o_credit_note_number: r.n,
    o_invoice_id: r.invoice_id, o_invoice_number: r.inv, o_gross_cents: r.g, o_reason_code: r.reason, o_issued_at: r.issued_at,
    o_issued_by_name: r.issued_by, o_withdrawn_at: r.withdrawn_at, o_withdrawal_reason_code: r.wreason, o_withdrawn_by_name: r.withdrawn_by,
  }]));
}

/** Rows of every table a write could touch, and the database-wide audit count: equal before and after proves nothing written. */
async function footprint() {
  const [r] = await owner`select (select count(*) from tmpos_invoice_credit_note.invoice_credit_note)::int as notes,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal)::int as withdrawals,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration)::int as registrations,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration where acknowledged_at is not null)::int as settled,
      (select coalesce(sum(last_number), 0) from tmpos_invoice_credit_note.invoice_credit_note_counter)::int as numbers,
      (select count(*) from tmpos_invoice_issue.issued_invoice)::int as invoices,
      (select count(*) from tmpos_invoice_void.issued_invoice_void)::int as voids,
      (select count(*) from tmpos_invoice_payment.invoice_payment)::int as payments,
      (select count(*) from public.audit_event)::int as audits,
      (select count(*) from tmpos_internal.idempotency_record)::int as idempotency`;
  return { ...r };
}
/**
 * Calls the routine inside one READ COMMITTED transaction on the runtime login and, in that same transaction, reads what the call
 * left behind: its transaction id (null = no write and no row lock), this transaction's own write counters, and its locks.
 */
async function insideOneCall(key, tenant, store, opts = {}) {
  return runtime.begin(RC, async (tx) => {
    // The write counters also hold this backend's earlier, not yet reported transactions (the setup's): count the change across the call.
    const [b] = await tx`select (select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from pg_catalog.pg_stat_xact_all_tables)::int as tuples`;
    const rows = (await tx.unsafe(activitySql, activityArgs(key, tenant, store, opts.after ?? null, opts.limit ?? 51))).map((r) => ({ ...r }));
    const [x] = await tx`select pg_catalog.pg_current_xact_id_if_assigned()::text as xid, pg_catalog.pg_backend_pid() as pid,
        (select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from pg_catalog.pg_stat_xact_all_tables)::int as tuples`;
    const locks = (await tx`select l.locktype::text as locktype, l.mode::text as mode, l.granted, l.relation::regclass::text as rel
      from pg_catalog.pg_locks l where l.pid = pg_catalog.pg_backend_pid()`).map((l) => ({ ...l }));
    return { rows, xid: x.xid, pid: x.pid, tuples: x.tuples - b.tuples, locks };
  }).catch(seal('SCA one call'));
}

// ===========================================================================
// CA-18 runs first: 038's down needs a database with no credit-note evidence to reach its drops (it refuses on evidence first).
// ===========================================================================
test('CA-18: 039 up and down on the disposable database — ledger 001..039, 038\'s down 2BP01 while 039 is applied, the down leaves 038 unchanged and on its approved baseline (a baseline breach or a 038 definition changed mid-down refuses it), refuses while 039 is not applied, up again', async () => {
  assert.equal(APPLY.outcome, 'complete', JSON.stringify(APPLY).slice(0, 300));
  assert.deepEqual(await ledgerVersions(), through(39), 'the ledger is exactly 001..039 after the up');
  const pinned = REQUIRED_MIGRATIONS.find((m) => m.version === '039');
  assert.ok(pinned !== undefined, 'the preflight pins 039');
  assert.equal((await owner`select checksum from public.schema_migrations where version = '039'`)[0].checksum, pinned.checksum,
    'the applied 039 is the file the preflight pins');
  assert.equal(await applied039(), true, 'the routine exists');
  assert.equal((await owner`select pg_catalog.to_regprocedure(${ANCHOR}) is not null as e`)[0].e, true, 'the anchor exists');
  // The anchor names 038's two tables and its list as reg* constants, and nothing else outside pg_catalog (doc 18 §9.1 item 4).
  const deps = (await owner`select pg_catalog.pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) as o
    from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = ${ANCHOR}::regprocedure and d.deptype = 'n'
      and d.refclassid in ('pg_catalog.pg_class'::regclass, 'pg_catalog.pg_proc'::regclass)
    `).map((r) => r.o).sort();
  assert.deepEqual(deps, [
    'function tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text,uuid,uuid,uuid,uuid,integer)',
    'table tmpos_invoice_credit_note.invoice_credit_note',
    'table tmpos_invoice_credit_note.invoice_credit_note_withdrawal',
  ], 'the anchor\'s recorded dependencies');

  // 038's down reaches its drops only on a database with no credit-note evidence; then the anchor refuses it.
  assert.deepEqual(await evidence(), { notes: 0, withdrawals: 0, registrations: 0, audits: 0 }, 'precondition: no credit-note evidence');
  assert.equal(await ranOrCode(owner, DOWN_038()), '2BP01', '038\'s down fails on 039\'s objects while 039 is applied');
  assert.equal(await applied039(), true, 'and changed nothing');

  // The approved baseline the down checks 038's nineteen routines against (doc 18 §9.2): the preflight's 038 lines for the ten,
  // no line for the nine.
  const preflightLines = (sig) => APPROVED_ROLE_GRANTS.filter((l) => l.includes(`|function|${sig.slice(0, sig.indexOf('('))}(`));
  // The preflight's spelling of a signature: no spaces, text/uuid/bytea qualified with pg_catalog (integer and bigint are not).
  const preflightSig = (sig) => sig.replace(/\s+/g, '').replace(/\b(text|uuid|bytea)\b/g, 'pg_catalog.$1');
  for (const sig of GRANTED_038) {
    assert.deepEqual(preflightLines(sig), [`tmpos_app|a|function|${preflightSig(sig)}|EXECUTE`],
      `the preflight approves exactly tmpos_app's EXECUTE on ${sig}, and no other grant on that name`);
  }
  for (const sig of OWNED_038) assert.equal(preflightLines(sig).length, 0, `the preflight approves no grant on ${sig}`);

  // The down's postcondition refuses (55000), changing nothing, when 038 is off its approved baseline before the down ...
  await owner.unsafe(`grant execute on function ${OWNED_038[2]} to tmpos_app`).catch(seal('SCA baseline breach'));
  try {
    assert.equal(await ranOrCode(owner, DOWN_039()), '55000', 'a 038 function off its approved ACL refuses 039\'s down');
  } finally {
    await owner.unsafe(`revoke execute on function ${OWNED_038[2]} from tmpos_app`).catch(seal('SCA baseline restore'));
  }
  assert.equal(await applied039(), true, 'the refused down changed nothing');
  // ... and when a 038 definition changes while the down runs: at each drop an event trigger re-comments a 038 table, so the
  // record the down takes before its drops differs from the catalog after them. Event triggers need the disposable cluster's
  // superuser (CI's POSTGRES_USER is one).
  assert.equal((await owner`select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user`)[0].rolsuper, true,
    'precondition: the owner login is the disposable cluster\'s superuser');
  await owner.unsafe(`create function public.sca_tamper_038() returns event_trigger language plpgsql as $f$
      begin comment on table ${CN}.invoice_credit_note_counter is 'sca tamper'; end $f$;
    create event trigger sca_tamper_038 on sql_drop execute function public.sca_tamper_038();`).simple().catch(seal('SCA tamper set'));
  try {
    assert.equal(await ranOrCode(owner, DOWN_039()), '55000', 'a 038 definition changed during the down refuses it');
  } finally {
    await owner.unsafe('drop event trigger if exists sca_tamper_038; drop function if exists public.sca_tamper_038();').simple()
      .catch(seal('SCA tamper clear'));
  }
  assert.equal(await applied039(), true, 'the refused down changed nothing');

  // 039's down: the routine and the anchor gone, 038 unchanged and on its approved baseline.
  const kept = await catalog038();
  assert.ok(kept.relations.length >= TABLES_038.length && kept.routines.length === 19, 'precondition: the record holds 038\'s relations and its nineteen routines');
  try {
    await down039().catch(seal('SCA 039 down'));
    assert.deepEqual(await ledgerVersions(), through(38), 'the ledger is 001..038 after the down');
    const [gone] = await owner`select count(*)::int as n from pg_catalog.pg_proc p
      where p.pronamespace = ${CN}::regnamespace and p.proname in ('m7b_store_credit_activity', 'm7b_store_credit_activity_prerequisites')`;
    assert.equal(gone.n, 0, 'no routine or anchor of 039 remains in the schema');
    assert.deepEqual(await catalog038(), kept, '038\'s schema, relations, triggers and routines are exactly as before the down');
    const [fns] = await owner`select count(*)::int as n from pg_catalog.pg_proc p where p.pronamespace = ${CN}::regnamespace`;
    assert.equal(fns.n, 16, '038\'s sixteen functions in the schema (038 up :2850)');
    for (const sig of GRANTED_038) assert.equal(await grantees(sig), withApp(), `after the down: ${sig} is the owner's and tmpos_app's exactly`);
    for (const sig of OWNED_038) assert.equal(await grantees(sig), ME, `after the down: ${sig} is the owner's alone`);
    for (const t of TABLES_038) {
      assert.equal((await owner`select pg_catalog.to_regclass(${`${CN}.${t}`}) is not null as e`)[0].e, true, `038's table ${t} is present`);
    }

    // The down again, while 039 is not applied: refused, changing nothing (55000 is the house refusal, 038 down :45-46).
    const before = await owner`select p.oid::regprocedure::text as f, p.proacl::text as acl from pg_catalog.pg_proc p
      where p.pronamespace = ${CN}::regnamespace order by 1`;
    assert.equal(await ranOrCode(owner, DOWN_039()), '55000', '039\'s down refuses while 039 is not applied');
    assert.deepEqual(await owner`select p.oid::regprocedure::text as f, p.proacl::text as acl from pg_catalog.pg_proc p
      where p.pronamespace = ${CN}::regnamespace order by 1`, before, 'the refused down changed nothing');
    assert.deepEqual(await ledgerVersions(), through(38), 'nor the ledger');
    // With 039 gone, 038's down runs again under its own rule (run here and rolled back).
    assert.equal(await ranOrCode(owner, DOWN_038()), 'ran', '038\'s down is possible again once 039 is rolled back (rolled back here)');

    // Up again.
    assert.equal((await trustedApply('039')).outcome, 'complete', 'the up applies again');
    assert.deepEqual(await ledgerVersions(), through(39), 'the ledger is 001..039 again');
    assert.equal(await applied039(), true, 'the routine is back');
  } finally {
    // A failure after the down must not leave 039 missing for every later row; on the passing path 039 is back and this does nothing.
    if (!(await applied039())) await trustedApply('039').catch(seal('SCA 039 re-apply'));
  }
  // Not repeated here: the preflight refusing a fake next ledger row is the '040' fixture moved by doc 18 §1 rule 5 into
  // tests/db/productionEntryPreflight.integration.test.mjs and tests/db/tenantEntry.integration.test.mjs.
});

test('CA-17: EXECUTE on the routine is tmpos_app\'s only (anon, authenticated, tmpos_audit_writer, PUBLIC none); the anchor is executable by nobody; the preflight lists the routine', async () => {
  assert.equal(await grantees(ACTIVITY), withApp(), 'the routine\'s ACL: the owner and tmpos_app, nothing else');
  assert.equal(await grantees(ANCHOR), ME, 'the anchor\'s ACL: the owner alone');
  for (const sig of [ACTIVITY, ANCHOR]) {
    const [p] = await owner`select coalesce(bool_or(g.grantee = 0), false) as pub from pg_catalog.pg_proc p,
        pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${sig}::regprocedure`;
    assert.equal(p.pub, false, `${sig}: no PUBLIC entry`);
    const [{ grantOption }] = await owner`select coalesce(bool_or(g.is_grantable), false) as "grantOption" from pg_catalog.pg_proc p,
        pg_catalog.aclexplode(p.proacl) g where p.oid = ${sig}::regprocedure`;
    assert.equal(grantOption, false, `${sig}: no grant option`);
    for (const role of ['anon', 'authenticated', 'tmpos_audit_writer']) {
      const [r] = await owner`select pg_catalog.has_function_privilege(${role}, ${sig}::regprocedure, 'EXECUTE') as ok`;
      assert.equal(r.ok, false, `${role} cannot execute ${sig} by any path`);
    }
  }
  const [app] = await owner`select pg_catalog.has_function_privilege('tmpos_app', ${ACTIVITY}::regprocedure, 'EXECUTE') as routine,
      pg_catalog.has_function_privilege('tmpos_app', ${ANCHOR}::regprocedure, 'EXECUTE') as anchor`;
  assert.deepEqual({ ...app }, { routine: true, anchor: false }, 'tmpos_app executes the routine and not the anchor');
  // The runtime login reaches the anchor by no path: calling it is refused (42501).
  assert.equal(await codeOf(runtime.unsafe(`select ${CN}.m7b_store_credit_activity_prerequisites()`)), '42501', 'the runtime login cannot call the anchor');
  // The preflight (doc 18 §6.4, §9.4): exactly one approved line for the routine, none for the anchor.
  assert.equal(APPROVED_ROLE_GRANTS.filter((l) => l === ACTIVITY_GRANT_LINE).length, 1, 'the preflight\'s approved list carries the routine\'s line');
  assert.deepEqual(APPROVED_ROLE_GRANTS.filter((l) => l.includes('m7b_store_credit_activity') && l !== ACTIVITY_GRANT_LINE), [],
    'and no other line names the routine or its anchor');
});

test('CA-19: read-only proof — STABLE, SECURITY DEFINER, pinned settings; no transaction id, no row written (audit_event included), no row or advisory lock; ACCESS SHARE released at transaction end; §6.2 step 5 columns', async () => {
  const [p] = await owner`select l.lanname::text as lang, p.prosecdef as definer, p.provolatile::text as vol, p.proretset as setof,
      p.proconfig as config, pg_catalog.pg_get_function_result(p.oid) as result, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
      pg_catalog.obj_description(p.oid, 'pg_proc') is not null as commented
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang where p.oid = ${ACTIVITY}::regprocedure`;
  assert.deepEqual({ ...p }, {
    lang: 'plpgsql', definer: true, vol: 's', setof: true, config: DEFINER_CONFIG, result: RESULT_TYPE,
    args: 'p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_after_credit_note_id uuid, p_limit integer', commented: true,
  }, 'the routine as §6.1 declares it');
  const [a] = await owner`select l.lanname::text as lang, p.prosecdef as definer, p.provolatile::text as vol, p.proconfig as config
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang where p.oid = ${ANCHOR}::regprocedure`;
  assert.deepEqual({ ...a }, { lang: 'sql', definer: false, vol: 's', config: ['search_path=pg_catalog, pg_temp'] }, 'the anchor as 038\'s (038 up :2844-2846)');

  const f = await scene('ro');
  const x = await invoice(f);
  await seedNotes(f, x, f.a.boss, 3);
  const w0 = await footprint();
  for (const [label, key, store, opts] of [['owner page', f.k.boss, f.S, {}], ['owner, limit 1', f.k.boss, f.S, { limit: 1 }],
    ['denied caller', f.k.manager, f.S, {}], ['cursor_unknown', f.k.boss, f.S, { after: randomUUID() }]]) {
    const r = await insideOneCall(key, f.T, store, opts);
    assert.ok(r.rows.length > 0, `${label}: answered`);
    assert.equal(r.xid, null, `${label}: no transaction id assigned — no row written and no row locked`);
    assert.equal(r.tuples, 0, `${label}: this transaction inserted, updated and deleted no tuple in any table`);
    const odd = r.locks.filter((l) => !((l.locktype === 'relation' && l.mode === 'AccessShareLock') || (l.locktype === 'virtualxid' && l.mode === 'ExclusiveLock')));
    assert.deepEqual(odd, [], `${label}: only ACCESS SHARE relation locks (and the transaction's own virtualxid); no advisory, tuple or transactionid lock`);
    if (label === 'owner page') {
      assert.ok(r.locks.some((l) => l.rel === `${CN}.invoice_credit_note` && l.mode === 'AccessShareLock'), 'ACCESS SHARE on the credit-note table, held to transaction end');
      const [held] = await owner`select count(*)::int as n from pg_catalog.pg_locks l where l.pid = ${r.pid} and l.locktype = 'relation'
        and l.relation = ${`${CN}.invoice_credit_note`}::regclass`;
      assert.equal(held.n, 0, 'released once the transaction ended');
    }
  }
  assert.deepEqual(await footprint(), w0, 'no row written in any table, audit_event and idempotency included');

  // §6.2 step 5: exactly the fourteen columns, and no value is an actor id.
  const rows = await activity(f.k.boss, f.T, f.S);
  assert.ok(rows.length === 3 && rows.every((r) => r.o_outcome === 'credit_note'), 'three credit_note rows');
  for (const r of rows) assert.deepEqual(Object.keys(r), COLUMNS, 'exactly §6.1\'s fourteen columns, in order');
  const ids = new Set(Object.values(f.a).map((who) => who.id));
  assert.ok(rows.every((r) => Object.values(r).every((v) => !ids.has(v))), 'no actor id in any column');
});

test('CA-40: p_limit null, 0 and 52 raise invalid_parameter_value (22023); 1 and 51 bound the page; nothing written in any case', async () => {
  const f = await scene('limit');
  const x = await invoice(f);
  await seedNotes(f, x, f.a.boss, 60);
  const w0 = await footprint();
  for (const bad of [null, 0, -1, 52]) {
    assert.equal(await codeOf(activity(f.k.boss, f.T, f.S, { limit: bad })), '22023', `p_limit ${bad}: 22023`);
  }
  // The argument check comes before the authority: a denied caller with a bad limit raises too.
  assert.equal(await codeOf(activity(f.k.manager, f.T, f.S, { limit: 52 })), '22023', 'a denied caller with p_limit 52: 22023');
  // §6.2 step 1's other arguments: a malformed session key, a null tenant or store.
  assert.equal(await codeOf(activity('not a session key', f.T, f.S)), '22023', 'a malformed session key: 22023');
  assert.equal(await codeOf(activity(f.k.boss, null, f.S)), '22023', 'a null tenant: 22023');
  assert.equal(await codeOf(activity(f.k.boss, f.T, null)), '22023', 'a null store: 22023');
  const page1 = await activity(f.k.boss, f.T, f.S, { limit: 1 });
  assert.equal(page1.length, 1, 'p_limit 1: one row of 60');
  assert.equal(page1[0].o_credit_note_number, '60', 'the newest');
  const page51 = await activity(f.k.boss, f.T, f.S, { limit: 51 });
  assert.equal(page51.length, 51, 'p_limit 51: 51 rows of 60');
  const fewer = await activity(f.k.boss, f.T, f.S, { limit: 51, after: page51[49].o_credit_note_id });
  assert.ok(fewer.length <= 51, 'never more than p_limit');
  assert.deepEqual(numbersOf(fewer), Array.from({ length: 10 }, (_, i) => 10 - i), 'the last ten after the 50th');
  assert.deepEqual(await footprint(), w0, 'nothing written by any call, raising or answering');
});

test('CA-01: the owner reads the store\'s notes newest number first; 51 asked of 120 gives 51; an empty store gives no row', async () => {
  const f = await scene('newest');
  assert.deepEqual(await activity(f.k.boss, f.T, f.S), [], 'an empty store: no row at all');
  const x = await invoice(f);
  const y = await invoice(f);
  await seedNotes(f, x, f.a.boss, 70);
  await seedNotes(f, y, f.a.boss2, 50); // numbers 71..120, another invoice, an issuer with no display name
  const rows = await activity(f.k.boss, f.T, f.S, { limit: 51 });
  assert.equal(rows.length, 51, '51 asked, 51 answered (the server serves 50 and keeps the 51st as the signal)');
  assert.deepEqual(numbersOf(rows), Array.from({ length: 51 }, (_, i) => 120 - i), 'newest number first: 120 down to 70');
  const expected = await truth(f.T, f.S);
  for (const r of rows) assert.deepEqual(r, expected.get(r.o_credit_note_id), `note ${r.o_credit_note_number}: every column as stored`);
  assert.ok(rows.every((r) => TIME_SHAPE.test(r.o_issued_at)), 'issued_at is UTC text with microseconds');
  assert.equal(rows[0].o_invoice_id, y, 'the newest notes are invoice y\'s');
  assert.equal(rows[50].o_invoice_id, x, 'number 70 is invoice x\'s');
  assert.equal(rows[0].o_issued_by_name, null, 'an issuer with no display name: null');
  assert.equal(rows[50].o_issued_by_name, 'SCA Owner newest', 'the issuer\'s display name');
  // A second store-scope owner of the same store reads the same page (doc 18 §7: one owner sees another's notes, with names).
  assert.deepEqual(await activity(f.k.boss2, f.T, f.S, { limit: 51 }), rows, 'the second owner of the store reads the same page');
});

test('CA-02: another store of the same tenant — its notes never appear; its id for this owner is denied', async () => {
  const f = await scene('stores');
  const x = await invoice(f);
  const x2 = await invoice(f, { store: f.S2 });
  const mine = await seedNotes(f, x, f.a.boss, 5);
  const theirs = await seedNotes(f, x2, f.a.bossB, 7, { store: f.S2 });
  const rows = await activity(f.k.boss, f.T, f.S);
  assert.deepEqual(rows.map((r) => r.o_credit_note_id).sort(), [...mine].sort(), 'store S answers exactly its own five notes');
  assert.ok(rows.every((r) => r.o_store_id === f.S && r.o_tenant_id === f.T), 'every row is S\'s, of T');
  assert.ok(!rows.some((r) => theirs.includes(r.o_credit_note_id)), 'none of S2\'s');
  assertSingle(await activity(f.k.boss, f.T, f.S2), 'denied', 'S\'s owner asking for S2');
  // The control: S2's own owner reads S2's seven, numbered from 1 in that store.
  assert.deepEqual(numbersOf(await activity(f.k.bossB, f.T, f.S2)), [7, 6, 5, 4, 3, 2, 1], 'S2\'s owner reads S2\'s seven');
  assertSingle(await activity(f.k.bossB, f.T, f.S), 'denied', 'S2\'s owner asking for S');
});

test('CA-03: another tenant, or a p_expected_tenant mismatch — one denied row with NULLs', async () => {
  const f = await scene('tenantA');
  const g = await scene('tenantB');
  await seedNotes(f, await invoice(f), f.a.boss, 2);
  await seedNotes(g, await invoice(g), g.a.boss, 2);
  assert.equal((await activity(f.k.boss, f.T, f.S)).length, 2, 'control: A\'s owner reads A\'s store');
  assertSingle(await activity(f.k.boss, g.T, g.S), 'denied', 'A\'s owner asking for B\'s tenant and store');
  assertSingle(await activity(f.k.boss, g.T, f.S), 'denied', 'A\'s owner, A\'s store, B\'s tenant expected (mismatch)');
  assertSingle(await activity(f.k.boss, f.T, g.S), 'denied', 'A\'s owner, A\'s tenant, B\'s store');
  assertSingle(await activity(f.k.boss, randomUUID(), f.S), 'denied', 'A\'s owner, a tenant that exists nowhere');
  assertSingle(await activity(f.k.boss, f.T, randomUUID()), 'denied', 'A\'s owner, a store that exists nowhere');
  assertSingle(await activity(g.k.boss, f.T, f.S), 'denied', 'B\'s owner asking for A\'s tenant and store');
});

test('CA-04: a manager at Invoices Full is denied; so are technician, sales staff and a tenant-scope owner at the store', async () => {
  const f = await scene('roles');
  await seedNotes(f, await invoice(f), f.a.boss, 3);
  // The manager passes 034's store reader at 'approve' (the most the reader asks; Invoices Full), so only the role check decides.
  const [r] = await owner`select r.o_role from tmpos_invoice_issue.m7b_issue_store_reader(${f.k.manager}, ${f.T}, ${f.S}, false, 'approve') r`
    .catch(seal('SCA store reader'));
  assert.equal(r?.o_role, 'manager', 'precondition: the manager holds Invoices at approve or more at S');
  for (const who of ['manager', 'tech', 'sales', 'own']) assertSingle(await activity(f.k[who], f.T, f.S), 'denied', who);
  assert.equal((await activity(f.k.boss, f.T, f.S)).length, 3, 'control: the store owner reads three');
});

test('CA-07: cursor walk over 123 notes, 51 asked and 50 served per page — strictly descending, no repeat, no gap, ends', async () => {
  const f = await scene('walk');
  const x = await invoice(f);
  const ids = await seedNotes(f, x, f.a.boss, 123);
  const seen = [];
  let after = null;
  let pages = 0;
  for (;;) {
    const rows = await activity(f.k.boss, f.T, f.S, { after, limit: 51 });
    pages += 1;
    assert.ok(pages <= 4, 'the walk ends');
    assert.ok(rows.every((r) => r.o_outcome === 'credit_note'), `page ${pages}: credit_note rows only`);
    const served = rows.slice(0, 50);
    seen.push(...served);
    if (rows.length <= 50) break; // no 51st row: the server answers nextCursor null
    after = served[49].o_credit_note_id; // the server's nextCursor: the 50th served id
  }
  assert.equal(pages, 3, '50 + 50 + 23');
  const numbers = numbersOf(seen);
  assert.deepEqual(numbers, Array.from({ length: 123 }, (_, i) => 123 - i), 'every number exactly once, strictly descending, no gap');
  assert.equal(new Set(seen.map((r) => r.o_credit_note_id)).size, 123, 'no id repeated');
  assert.deepEqual(new Set(seen.map((r) => r.o_credit_note_id)), new Set(ids), 'exactly the seeded notes');
  assert.deepEqual(await activity(f.k.boss, f.T, f.S, { after: seen[122].o_credit_note_id }), [], 'after the oldest: no row');
});

test('CA-09: a cursor of another store, another tenant, or a random uuid gives one cursor_unknown row; a denied caller\'s cursor is never evaluated', async () => {
  const f = await scene('cursorA');
  const g = await scene('cursorB');
  const xa = await invoice(f);
  const mine = await seedNotes(f, xa, f.a.boss, 3);
  const otherStore = await seedNotes(f, await invoice(f, { store: f.S2 }), f.a.bossB, 2, { store: f.S2 });
  const otherTenant = await seedNotes(g, await invoice(g), g.a.boss, 2);
  assert.deepEqual(numbersOf(await activity(f.k.boss, f.T, f.S, { after: mine[2] })), [2, 1], 'control: a cursor of this store pages on');
  assertSingle(await activity(f.k.boss, f.T, f.S, { after: otherStore[0] }), 'cursor_unknown', 'a note of another store of the tenant');
  assertSingle(await activity(f.k.boss, f.T, f.S, { after: otherTenant[0] }), 'cursor_unknown', 'a note of another tenant');
  assertSingle(await activity(f.k.boss, f.T, f.S, { after: randomUUID() }), 'cursor_unknown', 'a random uuid');
  assertSingle(await activity(f.k.boss, f.T, f.S, { after: xa }), 'cursor_unknown', 'an issued invoice\'s id, not a credit note\'s');
  // Denied wins: the authority comes before the cursor, whatever the cursor names.
  assertSingle(await activity(f.k.manager, f.T, f.S, { after: randomUUID() }), 'denied', 'a manager with a random cursor');
  assertSingle(await activity(f.k.manager, f.T, f.S, { after: mine[0] }), 'denied', 'a manager with a cursor of this store');
  assertSingle(await activity(f.k.boss, f.T, f.S2, { after: otherStore[0] }), 'denied', 'S\'s owner at S2 with a cursor S2 would accept');
  assertSingle(await activity(g.k.boss, f.T, f.S, { after: mine[0] }), 'denied', 'another tenant\'s owner with a cursor of this store');
  assertSingle(await activity(f.k.boss, g.T, g.S, { after: otherTenant[0] }), 'denied', 'this owner at another tenant with that tenant\'s cursor');
});

test('CA-11: a withdrawn note carries its withdrawal (not before issue, closed reason, name); an active note none; a voided invoice\'s withdrawn notes appear', async () => {
  const f = await scene('withdrawn');
  // A second store-scope owner of S with its own display name: it withdraws c1, which `boss` issued, so a routine answering the
  // issuer's name as the withdrawer's fails here (the names below are the seeded literals, not truth()'s joins).
  const other = await actor('withdrawn-owner-w', [storeGrant(f.T, f.S, 'store_owner')], 'SCA Withdrawing Owner withdrawn');
  const otherKey = await mint(other);
  const x = await invoice(f);
  const y = await invoice(f);
  const c1 = await credit(f, x, 1000);
  const c2 = await credit(f, x, 500, 'goodwill');
  assert.equal(await withdraw(f, c1, 'entered_in_error', otherKey), 'applied', 'c1 withdrawn by the second owner');
  const c3 = await credit(f, y, 700);
  assert.equal(await withdraw(f, c3, 'wrong_invoice'), 'applied', 'c3 withdrawn, then its invoice voided');
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: y, tenant: f.T })), 'applied', 'invoice y voided (no active credit)');
  const rows = await activity(f.k.boss, f.T, f.S);
  assert.deepEqual(rows.map((r) => r.o_credit_note_id), [c3.cn, c2.cn, c1.cn], 'newest number first: c3, c2, c1');
  const by = Object.fromEntries(rows.map((r) => [r.o_credit_note_id, r]));
  const expected = await truth(f.T, f.S);
  for (const r of rows) assert.deepEqual(r, expected.get(r.o_credit_note_id), `note ${r.o_credit_note_number}: every column as stored`);
  for (const [c, reason, withdrawer] of [[c1, 'entered_in_error', 'SCA Withdrawing Owner withdrawn'], [c3, 'wrong_invoice', 'SCA Owner withdrawn']]) {
    const r = by[c.cn];
    assert.ok(TIME_SHAPE.test(r.o_withdrawn_at), 'withdrawn_at is UTC text with microseconds');
    assert.ok(r.o_withdrawn_at >= r.o_issued_at, 'withdrawn not before issued (fixed-width UTC text compares in time order)');
    assert.equal(r.o_withdrawal_reason_code, reason, 'the withdrawal reason');
    assert.ok(WITHDRAWAL_REASONS.includes(r.o_withdrawal_reason_code), 'a closed reason code');
    assert.equal(r.o_withdrawn_by_name, withdrawer, 'the withdrawing owner\'s display name');
    assert.equal(r.o_issued_by_name, 'SCA Owner withdrawn', 'the issuing owner\'s display name');
  }
  assert.notEqual(by[c1.cn].o_withdrawn_by_name, by[c1.cn].o_issued_by_name, 'c1: the withdrawer\'s name, not the issuer\'s');
  assert.deepEqual([by[c2.cn].o_withdrawn_at, by[c2.cn].o_withdrawal_reason_code, by[c2.cn].o_withdrawn_by_name], [null, null, null],
    'the active note: every withdrawal column null');
  assert.equal(by[c2.cn].o_reason_code, 'goodwill', 'the active note\'s own reason');
  assert.equal(by[c3.cn].o_invoice_id, y, 'the voided invoice\'s withdrawn note appears, naming its invoice');
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_void.issued_invoice_void where invoice_id = ${y}`)[0].n, 1, 'y is voided');
});
