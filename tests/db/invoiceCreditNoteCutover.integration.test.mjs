// Phase 4.0 M7B-CREDITNOTES-P1 — migration 038's cutover, rollback and pre-038 payment registrations against REAL,
// crash-durable PostgreSQL. Written independently of the migration as its acceptance (doc 16 §8 rows CN-21, CN-34, CN-34s1,
// CN-34s2, CN-36; "038 cutover (CN-34)" and the recovery contract's Rollback and "Payment registrations created before 038").
//
//   ICC-01 [CN-34 (iii)] the apply waits on a caller holding the issued header FOR UPDATE and fails on the runner's lock
//          timeout; the catalog unchanged (the runner's dirty ledger marker named, then cleared); the apply then completes.
//   ICC-02 [CN-34 (i)]   AFTER the migration: a committed credit of 2,000, then 037's retained record_v2 called by the
//          routines' owner (who keeps EXECUTE) with a payment of 9,000 on a Total of 9,799: 23000 with fixed text, nothing written.
//   ICC-03 [CN-34 (ii)]  AFTER the migration: 036's retained void_v2 by the owner on an invoice with an active credit: 23000,
//          no void row, nothing written.
//   ICC-04 [CN-21]       the down refuses (55000, fixed text), catalog, ACLs and data byte-identical, for one fixture per kind
//          of evidence: a registration; a credit note; a withdrawal; an audit row of each of the four actions; an audit row
//          naming either subject column.
//   ICC-05 [CN-21]       with only payment-registration evidence (037's rows and audit rows) the down runs: EXECUTE on
//          record_v2, void_v2 and payments_get restored exactly (asserted ACLs).
//   ICC-06 [CN-34 (iv)]  the down drops the barrier triggers: the payment and void tables' trigger sets equal the strings 036
//          itself pins (read from 036's up file).
//   ICC-07 [CN-34s1, CN-34s2] 038 locks none of app_user, platform_identity, the session tables, tenant_session or issuer_key:
//          it applies while another transaction holds every one of them ACCESS EXCLUSIVE.
//   ICC-08 [CN-34s1]     the stale PAYMENT call at the seam: admitted before 038, paused at 016's hold on its actor's app_user
//          row; 038 applies while it is still blocked; a credit commits; released, it fails 23000 with fixed text, nothing of
//          its own written; earlier residue named; the counterfactual (barrier lifted, in the lifting transaction) would commit
//          and break I-CN.
//   ICC-09 [CN-34s2]     the stale VOID call at the seam, the same staging with 036's void_v2.
//   ICC-10 [CN-36]       a payment registration created before 038 completes after it through record_v3 under the
//          credit-aware cap (one amount_exceeds_remaining where record_v2 would have recorded, shown in a lifting transaction),
//          then records and settles; another pre-038 registration is released after 038.
//   ICC-11 [CN-36]       after a clean rollback, a pre-038 registration completes through record_v2 again.
//
// DISPOSABLE ONLY, DURABLE (proofs need fsync on). Teardown removes every credit-note row, payment, registration, audit row,
// session, login and fixture of its own (guards lifted in the deleting transaction only). Rolls back anything applied above
// 038 (039) at setup, runs on 001-038, and re-applies it at teardown, so the ledger ends as it began.
// No sleep decides an outcome: every wait is a lock wait observed in pg_locks / pg_blocking_pids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, installTestPaymentProofKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const DOWN_038 = readFileSync(`${MIG_DIR}/038_m7b_invoice_credit_note.down.sql`, 'utf8');
const UP_036 = readFileSync(`${MIG_DIR}/036_m7b_invoice_payment.up.sql`, 'utf8');
// 036's own pinned trigger sets (036 up :1904 and :147), read from 036's file, never from 038's down.
const PINNED_PAY_036 = /'(tmpos_invoice_payment\.invoice_payment:trg_invoice_payment_guard:[^']*)'/.exec(UP_036)?.[1];
const PINNED_VOID_036 = /is distinct from '(trg_issued_invoice_void_guard:[^']*)'/.exec(UP_036)?.[1];
const CN = 'tmpos_invoice_credit_note';
const PAY = 'tmpos_invoice_payment';
const RECORD2 = `${PAY}.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)`;
const VOID2 = `${PAY}.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)`;
const GET1 = `${PAY}.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)`;
const RETIRED = [RECORD2, VOID2, GET1];
const ACL_OWNER_ONLY = 'owner/EXECUTE/f/t';
const ACL_RESTORED = 'owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t';
const BARRIER_PAY = 'trg_invoice_payment_credit_note_barrier';
const BARRIER_VOID = 'trg_issued_invoice_void_credit_note_barrier';
const REC2_TEXT = 'migration 037 record: the payment is not one the payment table admits';
const VOID2_TEXT = 'migration 036 void: the void record is not one the void table admits';
const DOWN_TEXT = {
  creditNote: 'migration 038 rollback refused: a credit note or a credit-note withdrawal exists, and a rollback never removes one',
  registration: 'migration 038 rollback refused: a credit-note registration exists, and a rollback never removes one',
  audit: 'migration 038 rollback refused: an audit record of a credit-note action, or naming a credit note or a credit-note registration, exists',
};
const MIGRATOR = { purpose: 'migration', migratorRef: 'icc-migrator', runtimeRef: 'icc-runtime' };
const LOCK_KEY = 529_640;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_icc_probe';
const HOUR = 3_600_000;
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const ROLLBACK = new Error('icc: roll back');

// Secret-safe output: only SQLSTATEs, booleans, outcome words, counts and hashes ever reach an assertion message.
const isSqlState = (code) => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code);
const safeCode = (e) => (e?.code === undefined || e?.code === null ? 'none' : isSqlState(e.code) ? e.code : 'unknown');
const sealed = (label, e) => new Error(`${label}: ${isSqlState(e?.code) ? `SQLSTATE ${e.code}` : `failed (${e instanceof Error ? e.constructor.name : 'unknown'})`}`);
/** A refusal reduced to { code, fixed } (fixed: the message is exactly `text`); 'ran' when the promise resolved. */
const refusal = async (p, text) => p.then(() => ({ code: 'ran', fixed: false }), (e) => (e === ROLLBACK ? { code: 'ran', fixed: false }
  : { code: safeCode(e), fixed: e?.message === text }));
const sealOut = (out, text) => (out.outcome === 'failed' ? { code: isSqlState(out.code) ? out.code : 'unknown', fixed: out.message === text }
  : { code: out.outcome, fixed: false });

const netstring = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from(`${b.length}:`), b, Buffer.from(',')]); };
const mintProof = (issuer, key, r, expiresAt) => createHmac('sha256', issuer).update(Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion, r.authenticatedAt, r.createdAt, r.lastSeenAt,
    r.validatedAt, expiresAt].map((v) => netstring(String(v)))])).digest();
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------
const TARGET = resolveDisposableTarget('ICC', { durable: true });
const cluster = TARGET.cluster ?? null;
assertDisposableTestDsn(TARGET.dsn);
const DATABASE = new URL(TARGET.dsn).pathname.slice(1);
const connect = (user, max) => testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });
const owner = connect(undefined, 6);
let runtime = null; // the runtime login (tmpos_app member), as the production adapter connects
let prover = null; // the runtime login, ONE connection that asks for proofs after the register committed
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let issuerKeyBefore;
let above038;

/** The trusted runner, 001..`through`, on its own executor connection; `statementTimeoutMs` sets its server-side lock_timeout
 * (half of it, migrationExecutor.ts:1499), so a queued apply fails rather than waits. */
async function trustedApply(through, statementTimeoutMs) {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET.dsn), statementTimeoutMs === undefined ? {} : { statementTimeoutMs });
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
const applied038 = async (db = owner) => (await db`select pg_catalog.to_regnamespace(${CN}) is not null as e`)[0].e;
const down038 = () => owner.begin(RC, async (tx) => {
  await tx.unsafe(DOWN_038).simple();
  await tx`delete from public.schema_migrations where version = '038'`;
});
const clearDirty038 = () => owner`delete from public.schema_migrations where version = '038' and dirty returning version`;

const TRIGGER_MODE = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' };
/** Runs fn with the named triggers disabled INSIDE the caller's transaction (ALTER TABLE, SHARE ROW EXCLUSIVE), then restores
 * each trigger's own mode in the same transaction. */
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

/** Every credit-note row and credit-note audit row of this suite's tenants (counters too when `counters`). Test-only. */
async function purgeCnIn(sql, counters = false) {
  if (TENANTS.length === 0 || !(await applied038(sql))) return;
  await withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']], () => sql`delete from public.audit_event
    where tenant_id = any(${TENANTS}::uuid[]) and (action_id like 'store.invoice_credit_note.%'
      or subject_invoice_credit_note_id is not null or subject_invoice_credit_note_registration_id is not null)`);
  await withTriggersLifted(sql, [[`${CN}.invoice_credit_note_withdrawal`, 'trg_invoice_credit_note_withdrawal_guard']],
    () => sql`delete from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where tenant_id = any(${TENANTS}::uuid[])`);
  await withTriggersLifted(sql, [[`${CN}.invoice_credit_note_registration`, 'trg_invoice_credit_note_registration_guard'],
    [`${CN}.invoice_credit_note`, 'trg_invoice_credit_note_guard']], async () => {
    await sql`update tmpos_invoice_credit_note.invoice_credit_note_registration set credit_note_id = null where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_invoice_credit_note.invoice_credit_note where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = any(${TENANTS}::uuid[])`;
  });
  if (counters) {
    await withTriggersLifted(sql, [[`${CN}.invoice_credit_note_counter`, 'trg_invoice_credit_note_counter_guard']],
      () => sql`delete from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = any(${TENANTS}::uuid[])`);
  }
}
const purgeCn = () => owner.begin(RC, (sql) => purgeCnIn(sql));
async function ensureApplied() {
  if (await applied038()) return;
  await clearDirty038();
  const report = await trustedApply('038');
  assert.equal(report.outcome, 'complete', `038 applies (${report.code})`);
}
async function ensureDown() {
  if (!(await applied038())) return;
  await purgeCn();
  await down038();
  assert.equal(await applied038(), false, 'rolled back to 037');
}

async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    await withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']],
      () => sql`delete from public.audit_event where tenant_id = any(${TENANTS}::uuid[])`);
    await purgeCnIn(sql, true);
    await withTriggersLifted(sql, [[`${PAY}.invoice_payment_registration`, 'trg_invoice_payment_registration_guard']],
      () => sql`delete from tmpos_invoice_payment.invoice_payment_registration where tenant_id = any(${TENANTS}::uuid[])`);
    await withTriggersLifted(sql, [[`${PAY}.invoice_payment`, 'trg_invoice_payment_guard'], [`${PAY}.invoice_payment_reversal`, 'trg_invoice_payment_reversal_guard']], async () => {
      await sql`delete from tmpos_invoice_payment.invoice_payment_reversal where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_payment.invoice_payment where tenant_id = any(${TENANTS}::uuid[])`;
    });
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
  });
}

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(sealed('ICC teardown step', err)); } };
  try {
    await step(cleanAll);
    await step(async () => { if (!(await applied038())) { await clearDirty038(); assert.equal((await trustedApply('038')).outcome, 'complete'); } });
    await step(async () => {
      const [{ n }] = await owner`select ((select count(*) from tmpos_invoice_credit_note.invoice_credit_note) + (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal)
        + (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration))::int as n`;
      assert.equal(n, 0, 'teardown: no credit-note evidence remains');
    });
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
    await step(() => above038?.restore());
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'ICC teardown failed');
});

const APPLY = await (async () => {
  try {
    assert.equal((await owner`select pg_catalog.current_setting('fsync') as f`)[0].f, 'on', 'the durable harness: fsync on');
    await owner.unsafe(`do $$ begin
      if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;`);
    await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
    await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
    above038 = await rollBackAbove(owner, MIG_DIR, '038');
    const report = await trustedApply('038');
    await owner.unsafe(`do $$ begin if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if; end $$;`);
    await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
    await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
    await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
    await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
    runtime = connect(RUNTIME_LOGIN, 3);
    prover = connect(RUNTIME_LOGIN, 1);
    issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
    if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
    await installTestIssuerKey(owner, ISSUER_KEY);
    await installTestPaymentProofKey(owner);
    return report;
  } catch (err) {
    for (const c of [runtime, prover, owner]) if (c) await c.end({ timeout: 5 }).catch(() => {});
    if (cluster) cluster.stop();
    throw sealed('ICC setup', err);
  }
})();

// ---------------------------------------------------------------------------
// lock levers (the patterns of invoicePaymentRoutine.integration.test.mjs :655-693 and invoiceIssueRoutine :603-614)
// ---------------------------------------------------------------------------
/** Polls a lock-state probe (pg_locks / pg_blocking_pids); never decides an outcome by elapsed time. */
async function until(probe, what, ms = 15_000) {
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
    if ((await gate) === 'rollback') throw ROLLBACK;
    return value;
  }).then(() => ({ outcome: 'committed' }), (err) => (err === ROLLBACK ? { outcome: 'rolled back' } : { outcome: 'failed', code: err.code }));
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
const waitsFor = async (pid) => (await owner`select l.locktype::text as locktype, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted order by 1, 2`).map((r) => [r.locktype, r.mode]);
const rowWaitOn = async (pid) => (await owner`select l.relation::regclass::text as rel from pg_catalog.pg_locks l
  where l.pid = ${pid} and l.locktype = 'tuple' and l.granted`).map((r) => r.rel);
async function settle(...hs) {
  for (const h of hs) if (h && h.out === undefined) { h.release?.('rollback'); await h.done; }
}

// ---------------------------------------------------------------------------
// catalog and data footprints (hashes only: never row values in an assertion message)
// ---------------------------------------------------------------------------
async function catalog() {
  const [r] = await owner.unsafe(`select
    (select md5(coalesce(string_agg(format('%s|%s', n.nspname, n.nspacl), ',' order by n.nspname collate "C"), ''))
       from pg_catalog.pg_namespace n where n.nspname ~ '^tmpos_' or n.nspname = 'public') as namespaces,
    (select md5(coalesce(string_agg(format('%s|%s|%s', c.oid::regclass, c.relkind, c.relacl), ',' order by c.oid::regclass::text collate "C"), ''))
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname ~ '^tmpos_' or n.nspname = 'public') as relations,
    (select md5(coalesce(string_agg(format('%s|%s|%s|%s', a.attrelid::regclass, a.attname, a.atttypid::regtype, a.attnotnull), ',' order by a.attrelid::regclass::text collate "C", a.attnum), ''))
       from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where (n.nspname ~ '^tmpos_' or n.nspname = 'public') and a.attnum > 0 and not a.attisdropped) as columns,
    (select md5(coalesce(string_agg(format('%s|%s|%s|%s|%s', p.oid::regprocedure, p.proacl, md5(p.prosrc), p.prosecdef, p.proconfig), ',' order by p.oid::regprocedure::text collate "C"), ''))
       from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname ~ '^tmpos_' or n.nspname = 'public') as routines,
    (select md5(coalesce(string_agg(format('%s|%s|%s|%s|%s', g.tgrelid::regclass, g.tgname, g.tgfoid::regprocedure, g.tgtype, g.tgenabled), ',' order by g.tgrelid::regclass::text collate "C", g.tgname::text collate "C"), ''))
       from pg_catalog.pg_trigger g where not g.tgisinternal) as triggers,
    (select md5(coalesce(string_agg(t::text, ',' order by t::text collate "C"), '')) from public.schema_migrations t) as ledger`);
  return { ...r };
}
const FOOT = ['tmpos_invoice_issue.issued_invoice', 'tmpos_invoice_issue.issued_invoice_line', 'tmpos_invoice_issue.store_invoice_counter',
  `${PAY}.invoice_payment`, `${PAY}.invoice_payment_reversal`, `${PAY}.invoice_payment_registration`, 'tmpos_invoice_void.issued_invoice_void',
  'public.audit_event', `${CN}.invoice_credit_note`, `${CN}.invoice_credit_note_withdrawal`, `${CN}.invoice_credit_note_registration`,
  `${CN}.invoice_credit_note_counter`];
/** Per table: `count:md5(rows)` over this suite's tenants ('absent' when the table does not exist). */
async function footprint() {
  const out = {};
  for (const rel of FOOT) {
    if ((await owner`select pg_catalog.to_regclass(${rel}) is not null as e`)[0].e === false) { out[rel] = 'absent'; continue; }
    const [r] = await owner.unsafe(`select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text collate "C")), '') as h
      from ${rel} t where t.tenant_id = any($1::uuid[])`, [TENANTS]);
    out[rel] = `${r.n}:${r.h}`;
  }
  return out;
}
const aclOf = async (sig) => (await owner`select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s/%s', case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end,
    g.privilege_type, g.is_grantable, g.grantor = p.proowner), ';' order by case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end collate "C") as a
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${sig}::regprocedure`)[0].a;
async function triggerSets() {
  const [r] = await owner`select
    (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', g.tgrelid::regclass::text, g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
       order by g.tgname::text collate "C") from pg_catalog.pg_trigger g
      where g.tgrelid in ('tmpos_invoice_payment.invoice_payment'::regclass, 'tmpos_invoice_payment.invoice_payment_reversal'::regclass) and not g.tgisinternal) as pay,
    (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
       order by g.tgname::text collate "C") from pg_catalog.pg_trigger g
      where g.tgrelid = 'tmpos_invoice_void.issued_invoice_void'::regclass and not g.tgisinternal) as void`;
  return { ...r };
}

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic) and the routines, bound as a production adapter binds them
// ---------------------------------------------------------------------------
async function actor(label, tenant, store, scope, role) {
  const uid = `icc-${label}-${SUFFIX}-${randomUUID().slice(0, 6)}`;
  const [{ internal_user_id: id }] = await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${id}, ${tenant}, ${store}, ${scope}, ${role}, 'active')`;
  UIDS.push(uid);
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
async function mint(who) {
  const key = newKey();
  const at = Date.now();
  const r = { audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
    securityVersion: 't2:icc', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at };
  const expiresAt = at + 8 * HOUR;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${mintProof(ISSUER_KEY, key, r, expiresAt)}::bytea) as outcome`;
  assert.equal(outcome, 'created', 'session minted');
  return key;
}
// One line of 9,000 at 8.875 % exclusive: tax div(9,000 x 8,875 + 50,000, 100,000) = 799; Total 9,799. A credit of 2,000 plus a
// payment of 9,000 (11,000) exceeds it, while the payment alone (9,000) does not.
const LINES = [{ description: 'Screen replacement', quantity: 1, unitPriceCents: 9_000 }];
const SUBTOTAL = 9_000;
const TOTAL = 9_799;
const CREDIT = 2_000;
const PAYMENT = 9_000;
/** A tenant, a store, two store-scope store owners (B issues and credits; A records or voids), a tenant-scope owner for the
 * issuing settings, and one issued invoice of Total 9,799. Uses only routines of 034 and earlier, so it runs at 037 or 038. */
async function scene() {
  const [{ tenant_id: T }] = await owner`insert into tenant (display_name, status) values (${`icc-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(T);
  const [{ store_id: S }] = await owner`insert into store (tenant_id, store_name, status) values (${T}, ${`icc ${SUFFIX}`}, 'active') returning store_id`;
  const C = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${C}, ${T}, ${`ICC ${SUFFIX}`})`;
  const B = await actor('b', T, S, 'store', 'store_owner');
  const A = await actor('a', T, S, 'store', 'store_owner');
  const own = await actor('tenant-owner', T, null, 'tenant', 'store_owner');
  B.key = await mint(B);
  A.key = await mint(A);
  const kOwn = await mint(own);
  const [s] = await runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_issuing_settings_set($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
    [kOwn, S, T, '0', 'ICC Legal Name LLC', 'ICC Store', '1 Main St\nSpringfield', 'TAX-ICC-1', 'exclusive_rate', 8875]);
  assert.equal(s.o_outcome, 'applied', 'issuing settings');
  const draft = randomUUID();
  const [c] = await runtime.unsafe(`select o_outcome from tmpos_invoice_edit.m7b_invoice_draft_create_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [B.key, S, draft, T, C, JSON.stringify(LINES), String(SUBTOTAL)]);
  assert.equal(c.o_outcome, 'applied', 'draft saved');
  const invoice = randomUUID();
  const [i] = await runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_invoice_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [B.key, S, draft, T, '1', '1', '1', invoice]);
  assert.equal(i.o_outcome, 'applied', 'invoice issued');
  const [{ total }] = await owner`select total_cents::int as total from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice}`;
  assert.equal(total, TOTAL, 'the invoice Total is 9,799');
  return { T, S, A, B, invoice };
}

// 037's payment registration (register, then the proof from another connection after COMMIT).
async function payRegister(f, who) {
  const registration = randomUUID();
  const attempt = randomUUID();
  const [r] = await runtime.unsafe(`select o_outcome from ${PAY}.m7b_invoice_payment_register($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid)`,
    [who.key, f.S, f.invoice, f.T, registration, attempt, randomUUID()]);
  assert.equal(r.o_outcome, 'applied', 'payment registered');
  const [p] = await prover.unsafe(`select o_outcome, o_proof from ${PAY}.m7b_invoice_payment_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [who.key, f.S, f.invoice, f.T, registration, 1000]);
  assert.equal(p.o_outcome, 'proof', 'the payment proof issues');
  return { who, registration, attempt, proof: p.o_proof };
}
const payProofAgain = async (f, reg) => (await prover.unsafe(`select o_outcome, o_proof from ${PAY}.m7b_invoice_payment_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
  [reg.who.key, f.S, f.invoice, f.T, reg.registration, 1000]))[0];
const recordSql = (fn) => `select o_outcome from ${PAY}.${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`;
const recordArgs = (f, reg, amount, payment = randomUUID()) => [reg.who.key, f.S, f.invoice, f.T, payment, reg.registration, reg.attempt, String(amount), 'cash', reg.proof, randomUUID()];
const voidSql = `select o_outcome from ${PAY}.m7b_invoice_void_v2($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`;
const voidArgs = (f, who) => [who.key, f.S, f.invoice, f.T, '1', 'issued_in_error'];
const paySettle = async (f, reg, version) => (await runtime.unsafe(`select o_outcome, o_version from ${PAY}.m7b_invoice_payment_settle($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::uuid)`,
  [reg.who.key, f.S, f.invoice, f.T, reg.attempt, String(version), randomUUID()]))[0];
const openPaymentRegistration = async (reg) => (await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment_registration
  where registration_id = ${reg.registration} and payment_id is null and acknowledged_at is null`)[0].n === 1;

// 038's credit-note writers (B, the store-scope store owner).
async function cnRegister(f, who, gross = CREDIT, reason = 'pricing_error') {
  // PRECONDITION: before the registration, the proving backend runs 038's proof routine once for an unregistered id (it can only
  // answer not_found, asserted). After a 038 down and up, the first call on a backend compiles the routine and reads its TOAST
  // rows, pruning the dead ones the down left: xid-less WAL its own transaction writes before it samples its target, which only a
  // later flush covers (037's documented self-prune, which the adapter meets with one fresh transaction). Here that prune lands
  // before the registration, whose COMMIT flushes it, so cnIssue's real call writes no such prune ahead of its own target.
  // Without it ICC-02's proof answered not_durable after its 1,000 ms in CI-order replays of run 43741302186 (a prune of
  // pg_toast_1255 block 31).
  const [warm] = await prover.unsafe(`select o_outcome, pg_catalog.pg_backend_pid() as pid from ${CN}.m7b_invoice_credit_note_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [who.key, f.S, f.invoice, f.T, randomUUID(), 0]);
  assert.equal(warm.o_outcome, 'not_found', 'the proof routine resolved on the proving backend before the registration');
  const registration = randomUUID();
  const attempt = randomUUID();
  const [r] = await runtime.unsafe(`select o_outcome from ${CN}.m7b_invoice_credit_note_register($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8::text, $9::uuid)`,
    [who.key, f.S, f.invoice, f.T, registration, attempt, String(gross), reason, randomUUID()]);
  assert.equal(r.o_outcome, 'applied', 'credit-note registered');
  return { who, registration, attempt, gross: String(gross), reason, proverPid: warm.pid };
}
async function cnIssue(f, reg) {
  const [pr] = await prover.unsafe(`select o_outcome, o_proof, pg_catalog.pg_backend_pid() as pid from ${CN}.m7b_invoice_credit_note_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [reg.who.key, f.S, f.invoice, f.T, reg.registration, 1000]);
  assert.equal(pr.pid, reg.proverPid, 'the proof is asked on the backend that resolved the routine before the registration');
  assert.equal(pr.o_outcome, 'proof', 'the credit-note proof issues');
  const creditNote = randomUUID();
  const [iss] = await runtime.unsafe(`select o_outcome from ${CN}.m7b_invoice_credit_note_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`,
    [reg.who.key, f.S, f.invoice, f.T, creditNote, reg.registration, reg.attempt, reg.gross, reg.reason, pr.o_proof, randomUUID()]);
  assert.equal(iss.o_outcome, 'applied', 'credit note issued');
  return creditNote;
}
const credit = async (f) => cnIssue(f, await cnRegister(f, f.B));
async function cnWithdraw(f, creditNote) {
  const [w] = await runtime.unsafe(`select o_outcome from ${CN}.m7b_invoice_credit_note_withdraw($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::text, $8::uuid)`,
    [f.B.key, f.S, f.invoice, f.T, creditNote, '1', 'wrong_amount', randomUUID()]);
  assert.equal(w.o_outcome, 'applied', 'credit note withdrawn');
}
async function cnSettle(f, reg, version) {
  const [s] = await runtime.unsafe(`select o_outcome from ${CN}.m7b_invoice_credit_note_settle($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::uuid)`,
    [reg.who.key, f.S, f.invoice, f.T, reg.attempt, String(version), randomUUID()]);
  assert.equal(s.o_outcome, 'applied', 'credit-note registration settled');
}
/** Active credited + unreversed paid, and the Total, read in `db`'s own snapshot. */
const sums = async (db, f) => ({ ...(await db`select
  (select coalesce(sum(c.gross_cents), 0) from tmpos_invoice_credit_note.invoice_credit_note c where c.invoice_id = ${f.invoice}
     and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w where w.credit_note_id = c.credit_note_id))::int as credited,
  (select coalesce(sum(p.amount_cents), 0) from tmpos_invoice_payment.invoice_payment p where p.invoice_id = ${f.invoice}
     and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id))::int as paid,
  (select total_cents from tmpos_invoice_issue.issued_invoice where invoice_id = ${f.invoice})::int as total`)[0] });

// =============================================================================================================================
test('ICC-01 [CN-34 (iii)]: the apply waits on a caller holding the issued header and fails cleanly on the runner\'s lock timeout', async (t) => {
  assert.equal(APPLY.outcome, 'complete', `001-038 applied at setup (${APPLY.code})`);
  await ensureDown();
  const f = await scene();
  const before = await catalog();
  const header = holding(owner, (tx) => tx`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${f.invoice} for update`);
  let applier = null;
  try {
    await until(() => header.ready, 'the issued header held FOR UPDATE');
    // statement_timeout 4 s, so the runner's server-side lock_timeout is 2 s (migrationExecutor.ts:1499).
    const apply = trustedApply('038', 4_000);
    applier = await until(async () => (await owner`select a.pid from pg_catalog.pg_stat_activity a
      where a.pid <> ${header.pid} and ${header.pid} = any(pg_catalog.pg_blocking_pids(a.pid))`)[0]?.pid, 'the apply queues behind the header holder');
    assert.deepEqual(await waitsFor(applier), [['relation', 'AccessExclusiveLock']], 'the apply waits for ACCESS EXCLUSIVE');
    assert.deepEqual((await owner`select l.relation::regclass::text as rel from pg_catalog.pg_locks l where l.pid = ${applier} and not l.granted`).map((r) => r.rel),
      ['tmpos_invoice_issue.issued_invoice'], 'on the issued header, its first lock');
    assert.equal(await blockedBy(applier, header.pid), true, 'blocked by the caller holding the header');
    const report = await apply;
    t.diagnostic(`apply while the header is held: outcome=${report.outcome} code=${report.code}`);
    assert.equal(report.outcome, 'failed', 'the apply fails rather than waits forever');
    assert.equal(header.out, undefined, 'the caller still holds the header: the apply gave up, it did not wait it out');
  } finally { await settle(header); }
  assert.equal(await applied038(), false, 'nothing of 038 exists');
  for (const sig of RETIRED) assert.equal(await aclOf(sig), ACL_RESTORED, `037's catalog intact: ${sig.split('(')[0]}`);
  const dirty = await clearDirty038();
  t.diagnostic(`the runner's dirty ledger marker for 038 after the failed apply: ${dirty.length === 1 ? 'present (cleared by the test)' : 'absent'}`);
  assert.deepEqual(await catalog(), before, 'catalog, ACLs, triggers and ledger byte-identical to before the failed apply (dirty marker cleared)');
  assert.equal((await trustedApply('038')).outcome, 'complete', 'with the header free, the apply completes');
});

test('ICC-02 [CN-34 (i)]: AFTER the migration, the retained record_v2 called by the routines\' owner with 9,000 over a 2,000 credit fails 23000, nothing written', async () => {
  await ensureApplied();
  const f = await scene();
  await credit(f);
  const reg = await payRegister(f, f.A);
  assert.equal(await aclOf(RECORD2), ACL_OWNER_ONLY, 'record_v2: the owner alone keeps EXECUTE');
  assert.deepEqual(await sums(owner, f), { credited: CREDIT, paid: 0, total: TOTAL }, 'a committed credit of 2,000 on a Total of 9,799');
  const before = await footprint();
  const out = await refusal(owner.begin(RC, (tx) => tx.unsafe(recordSql('m7b_invoice_payment_record_v2'), recordArgs(f, reg, PAYMENT))), REC2_TEXT);
  assert.deepEqual(out, { code: '23000', fixed: true }, 'record_v2 meets the barrier: 23000 with its fixed text');
  assert.deepEqual(await footprint(), before, 'no payment, audit, registration or header change');
  assert.equal(await openPaymentRegistration(reg), true, 'the registration stays open');
});

test('ICC-03 [CN-34 (ii)]: AFTER the migration, the retained void_v2 called by the routines\' owner on an invoice with an active credit fails 23000, no void row', async () => {
  await ensureApplied();
  const f = await scene();
  await credit(f);
  assert.equal(await aclOf(VOID2), ACL_OWNER_ONLY, 'void_v2: the owner alone keeps EXECUTE');
  const before = await footprint();
  const out = await refusal(owner.begin(RC, (tx) => tx.unsafe(voidSql, voidArgs(f, f.A))), VOID2_TEXT);
  assert.deepEqual(out, { code: '23000', fixed: true }, 'void_v2 meets the barrier: 23000 with its fixed text');
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_void.issued_invoice_void where invoice_id = ${f.invoice}`)[0].n, 0, 'no void row');
  assert.deepEqual(await footprint(), before, 'nothing written');
});

test('ICC-04 [CN-21]: the down refuses, changing nothing, while any kind of credit-note evidence exists (one fixture per kind)', async (t) => {
  await ensureApplied();
  await purgeCn();
  const f = await scene();
  // Source rows for the audit fixtures: one real lifecycle (register -> issue -> settle confirmed -> withdraw) and one 037
  // payment registration (its audit row, not credit-note evidence, is the template for the subject-column fixtures).
  const r1 = await cnRegister(f, f.B);
  const cn1 = await cnIssue(f, r1);
  await cnSettle(f, r1, 2);
  await cnWithdraw(f, cn1);
  await payRegister(f, f.A);
  const saved = Object.fromEntries((await owner`select a.action_id, pg_catalog.row_to_json(a)::text as j from public.audit_event a
    where a.tenant_id = ${f.T} and (a.action_id like 'store.invoice_credit_note.%' or a.action_id = 'store.invoice_payment.register')`).map((r) => [r.action_id, r.j]));
  for (const k of ['register', 'issue', 'settle', 'withdraw']) assert.ok(`store.invoice_credit_note.${k}` in saved, `an audit row of ${k} was written`);
  assert.ok('store.invoice_payment.register' in saved, 'a payment-registration audit row was written');
  const [{ pk }] = await owner`select a.attname::text as pk from pg_catalog.pg_index i join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.audit_event'::regclass and i.indisprimary`;
  const insertAudit = (row) => owner.begin(RC, (sql) => withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']],
    () => sql`insert into public.audit_event select * from pg_catalog.json_populate_record(null::public.audit_event, ${JSON.stringify(row)}::text::json)`));
  const deleteCnAudit = () => owner.begin(RC, (sql) => withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']],
    () => sql`delete from public.audit_event where tenant_id = ${f.T} and (action_id like 'store.invoice_credit_note.%'
      or subject_invoice_credit_note_id is not null or subject_invoice_credit_note_registration_id is not null)`));
  const nulled = (action) => ({ ...JSON.parse(saved[action]), subject_invoice_credit_note_id: null, subject_invoice_credit_note_registration_id: null });
  const fixtures = [
    ['a credit-note registration (no credit note, no audit row)', 'registration', async () => { await cnRegister(f, f.B); await deleteCnAudit(); }],
    ['a credit note (with its registration, no audit row)', 'creditNote', async () => { await credit(f); await deleteCnAudit(); }],
    ['a withdrawal (with its credit note and registration, no audit row)', 'creditNote', async () => {
      const r = await cnRegister(f, f.B); const cn = await cnIssue(f, r); await cnSettle(f, r, 2); await cnWithdraw(f, cn); await deleteCnAudit();
      const [{ n }] = await owner`select count(*)::int as n from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where credit_note_id = ${cn}`;
      assert.equal(n, 1, 'the withdrawal exists');
    }],
    ...['register', 'issue', 'settle', 'withdraw'].map((k) => [`an audit row of store.invoice_credit_note.${k} alone (subject columns null)`, 'audit',
      () => insertAudit(nulled(`store.invoice_credit_note.${k}`))]),
    ['a payment-registration audit row naming a credit note (subject_invoice_credit_note_id)', 'audit',
      () => insertAudit({ ...nulled('store.invoice_payment.register'), [pk]: randomUUID(), subject_invoice_credit_note_id: randomUUID() })],
    ['a payment-registration audit row naming a credit-note registration (subject_invoice_credit_note_registration_id)', 'audit',
      () => insertAudit({ ...nulled('store.invoice_payment.register'), [pk]: randomUUID(), subject_invoice_credit_note_registration_id: randomUUID() })],
  ];
  for (const [label, expected, stage] of fixtures) {
    await purgeCn();
    await stage();
    const cat = await catalog();
    const foot = await footprint();
    const acl = await Promise.all(RETIRED.map(aclOf));
    const out = await refusal(owner.begin(RC, async (tx) => { await tx.unsafe(DOWN_038).simple(); await tx`delete from public.schema_migrations where version = '038'`; }), DOWN_TEXT[expected]);
    t.diagnostic(`${label}: ${out.code}${out.fixed ? ' (fixed text)' : ''}`);
    assert.deepEqual(out, { code: '55000', fixed: true }, `${label}: the down refuses with its ${expected} text`);
    assert.equal(await applied038(), true, `${label}: 038 still applied`);
    assert.deepEqual(await catalog(), cat, `${label}: catalog, ACLs, triggers and ledger byte-identical`);
    assert.deepEqual(await Promise.all(RETIRED.map(aclOf)), acl, `${label}: the retired routines' ACLs unchanged`);
    assert.deepEqual(await footprint(), foot, `${label}: every row byte-identical`);
  }
  await purgeCn();
});

test('ICC-05 [CN-21]: with only payment-registration evidence, the down runs and restores EXECUTE on record_v2, void_v2 and payments_get exactly', async () => {
  await ensureApplied();
  await purgeCn();
  const f = await scene();
  const reg = await payRegister(f, f.A);
  assert.equal((await paySettle(f, reg, 1)).o_outcome, 'applied', 'a payment registration released (its settle audit row too)');
  const [ev] = await owner`select (select count(*) from public.audit_event where action_id like 'store.invoice_payment.%')::int as pay_audit,
    (select count(*) from tmpos_invoice_payment.invoice_payment_registration)::int as pay_reg,
    ((select count(*) from tmpos_invoice_credit_note.invoice_credit_note) + (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal)
      + (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration)
      + (select count(*) from public.audit_event where action_id like 'store.invoice_credit_note.%' or subject_invoice_credit_note_id is not null
          or subject_invoice_credit_note_registration_id is not null))::int as cn`;
  assert.ok(ev.pay_audit >= 2 && ev.pay_reg >= 1, 'payment-registration rows and their audit rows exist');
  assert.equal(ev.cn, 0, 'no credit-note evidence');
  for (const sig of RETIRED) assert.equal(await aclOf(sig), ACL_OWNER_ONLY, `applied: ${sig.split('(')[0]} is the owner's alone`);
  const out = await refusal(down038(), '');
  assert.deepEqual(out, { code: 'ran', fixed: false }, 'the down runs (payment-registration audit rows do not block it)');
  assert.equal(await applied038(), false, 'schema tmpos_invoice_credit_note gone');
  for (const sig of RETIRED) assert.equal(await aclOf(sig), ACL_RESTORED, `rolled back: ${sig.split('(')[0]} exactly owner + tmpos_app EXECUTE`);
  await ensureApplied();
});

test('ICC-06 [CN-34 (iv)]: the down drops the barrier triggers; the payment and void tables\' trigger sets equal 036\'s pinned sets again', async () => {
  assert.ok(PINNED_PAY_036 && PINNED_VOID_036, '036\'s pinned trigger strings read from its up file');
  await ensureApplied();
  const applied = await triggerSets();
  assert.ok(applied.pay.includes(BARRIER_PAY) && applied.void.includes(BARRIER_VOID), 'applied: both barrier triggers present');
  await ensureDown();
  assert.deepEqual(await triggerSets(), { pay: PINNED_PAY_036, void: PINNED_VOID_036 }, '036\'s pinned trigger sets exactly');
  assert.equal((await owner`select count(*)::int as n from pg_catalog.pg_trigger where tgname in (${BARRIER_PAY}, ${BARRIER_VOID})`)[0].n, 0, 'no barrier trigger anywhere');
  await ensureApplied();
});

test('ICC-07 [CN-34s1, CN-34s2]: 038 locks none of app_user, platform_identity, the session tables, tenant_session or issuer_key', async (t) => {
  await ensureDown();
  const held = (await owner`select c.oid::regclass::text as rel from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and (n.nspname in ('tmpos_session', 'tmpos_mint') or c.oid in ('public.app_user'::regclass, 'public.platform_identity'::regclass))
    order by 1`).map((r) => r.rel);
  for (const rel of ['app_user', 'platform_identity', 'tmpos_session.session', 'tmpos_mint.tenant_session', 'tmpos_mint.issuer_key']) {
    assert.ok(held.includes(rel), `${rel} is among the held relations`);
  }
  t.diagnostic(`held ACCESS EXCLUSIVE during the apply: ${held.join(', ')}`);
  const h = holding(owner, async (tx) => { for (const rel of held) await tx.unsafe(`lock table ${rel} in access exclusive mode`); });
  try {
    await until(() => h.ready, 'every listed relation held ACCESS EXCLUSIVE');
    const report = await trustedApply('038', 6_000); // lock_timeout 3 s: any lock on a held relation would fail the apply
    assert.equal(report.outcome, 'complete', `038 applies while all of them are held (${report.code})`);
    assert.equal(h.out, undefined, 'the holder still holds them: the apply took no lock on any');
  } finally { await settle(h); }
});

/** The CN-34s1 / CN-34s2 staging: A's `call` admitted before 038 and paused at 016's hold on A's app_user row; 038 applied
 * while A is still blocked; B's credit committed. Returns the paused call's outcome after release and the footprint taken
 * after B's credit and before the release. */
async function staleAtSeam(t, f, call) {
  assert.equal(await applied038(), false, 'staged before 038');
  const hold = holding(owner, (tx) => tx`select 1 from public.app_user where internal_user_id = ${f.A.id} for update`);
  let a = null;
  try {
    await until(() => hold.ready, 'A\'s app_user row held (016\'s hold)');
    a = running(runtime, call);
    await until(() => blockedBy(a.pid, hold.pid), 'A waits at 016\'s hold');
    assert.deepEqual(await waitsFor(a.pid), [['transactionid', 'ShareLock']], 'A waits on a row lock');
    assert.deepEqual(await rowWaitOn(a.pid), ['app_user'], 'the wait is on the account row, at 016\'s hold');
    const report = await trustedApply('038', 20_000); // its own connection; lock_timeout 10 s
    assert.equal(report.outcome, 'complete', `038 applied while A waits (${report.code})`);
    assert.equal(a.out, undefined, 'A has not answered');
    assert.equal(await blockedBy(a.pid, hold.pid), true, 'the apply completed while A is still blocked');
    for (const sig of RETIRED) assert.equal(await aclOf(sig), ACL_OWNER_ONLY, 'tmpos_app no longer holds EXECUTE (A was admitted before)');
    await credit(f); // B, the store-scope owner, issues a credit of 2,000 and commits
    assert.deepEqual(await sums(owner, f), { credited: CREDIT, paid: 0, total: TOTAL }, 'B\'s credit committed');
    const after = await footprint();
    hold.release('rollback');
    await hold.done;
    const out = await a.done;
    t.diagnostic(`A after release: ${out.outcome} ${isSqlState(out.code) ? out.code : ''}`);
    return { out, after };
  } finally { await settle(hold); if (a) await a.done; }
}

test('ICC-08 [CN-34s1]: a stale record_v2 admitted before 038, paused at 016\'s hold, meets the barrier after a credit commits', async (t) => {
  await ensureDown();
  const f = await scene();
  const reg = await payRegister(f, f.A); // committed before 038: A's open registration, its register audit row, its proof
  const { out, after } = await staleAtSeam(t, f, (tx) => tx.unsafe(recordSql('m7b_invoice_payment_record_v2'), recordArgs(f, reg, PAYMENT)));
  assert.deepEqual(sealOut(out, REC2_TEXT), { code: '23000', fixed: true }, 'A fails 23000 with record_v2\'s fixed text');
  assert.deepEqual(await footprint(), after, 'nothing from A: header, payments, credits, counters, registrations and audit byte-identical except B\'s credit');
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where invoice_id = ${f.invoice}`)[0].n, 0, 'no payment');
  // Residue committed EARLIER, in other transactions, named and not counted as A's:
  assert.equal(await openPaymentRegistration(reg), true, 'residue: A\'s registration, open and unchanged');
  const [aud] = await owner`select count(*) filter (where action_id = 'store.invoice_payment.register')::int as reg,
    count(*) filter (where action_id <> 'store.invoice_payment.register')::int as other
    from public.audit_event where tenant_id = ${f.T} and actor_internal_user_id = ${f.A.id}`;
  assert.deepEqual({ ...aud }, { reg: 1, other: 0 }, 'residue: A\'s one register audit row; no audit row of A\'s call');
  const again = await payProofAgain(f, reg);
  assert.deepEqual({ outcome: again.o_outcome, same: again.o_proof === reg.proof }, { outcome: 'proof', same: true }, 'residue: the proof is still valid');
  // The counterfactual, in a lifting transaction (not on A's connection): without the barrier the stale payment commits.
  const cf = await owner.begin(RC, async (tx) => withTriggersLifted(tx, [[`${PAY}.invoice_payment`, BARRIER_PAY]], async () => {
    const [r] = await tx.unsafe(recordSql('m7b_invoice_payment_record_v2'), recordArgs(f, reg, PAYMENT));
    const s = await sums(tx, f);
    throw Object.assign(new Error('icc: counterfactual'), { seen: { outcome: r.o_outcome, breaksICN: s.credited + s.paid > s.total, ...s } });
  })).catch((e) => e.seen ?? { failed: safeCode(e) });
  assert.deepEqual(cf, { outcome: 'applied', breaksICN: true, credited: CREDIT, paid: PAYMENT, total: TOTAL },
    'counterfactual: with the barrier lifted, record_v2 records 9,000 and credited + paid exceeds the Total (I-CN broken)');
  assert.deepEqual(await footprint(), after, 'the counterfactual rolled back');
});

test('ICC-09 [CN-34s2]: a stale void_v2 admitted before 038, paused at 016\'s hold, meets the barrier after a credit commits', async (t) => {
  await ensureDown();
  const f = await scene();
  const { out, after } = await staleAtSeam(t, f, (tx) => tx.unsafe(voidSql, voidArgs(f, f.A)));
  assert.deepEqual(sealOut(out, VOID2_TEXT), { code: '23000', fixed: true }, 'A\'s void fails 23000 with void_v2\'s fixed text');
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_void.issued_invoice_void where invoice_id = ${f.invoice}`)[0].n, 0, 'no void row');
  assert.deepEqual(await footprint(), after, 'no other change');
  const cf = await owner.begin(RC, async (tx) => withTriggersLifted(tx, [['tmpos_invoice_void.issued_invoice_void', BARRIER_VOID]], async () => {
    const [r] = await tx.unsafe(voidSql, voidArgs(f, f.A));
    const [{ voided }] = await tx`select count(*)::int as voided from tmpos_invoice_void.issued_invoice_void where invoice_id = ${f.invoice}`;
    const s = await sums(tx, f);
    throw Object.assign(new Error('icc: counterfactual'), { seen: { outcome: r.o_outcome, voided, activeCredit: s.credited } });
  })).catch((e) => e.seen ?? { failed: safeCode(e) });
  assert.deepEqual(cf, { outcome: 'applied', voided: 1, activeCredit: CREDIT },
    'counterfactual: with the barrier lifted, void_v2 voids an invoice holding an active credit note');
  assert.deepEqual(await footprint(), after, 'the counterfactual rolled back');
});

test('ICC-10 [CN-36]: a payment registration created before 038 completes after it through record_v3 under the credit-aware cap, and settles', async (t) => {
  await ensureDown();
  const f = await scene();
  const ra = await payRegister(f, f.A); // before 038
  const rb = await payRegister(f, f.B); // before 038, released after it
  const report = await trustedApply('038');
  assert.equal(report.outcome, 'complete', `038 applied (${report.code})`);
  await credit(f);
  const before = await footprint();
  const [refused] = await runtime.unsafe(recordSql('m7b_invoice_payment_record_v3'), recordArgs(f, ra, PAYMENT));
  assert.equal(refused.o_outcome, 'amount_exceeds_remaining', 'record_v3 refuses 9,000: 2,000 credited + 9,000 > 9,799');
  assert.deepEqual(await footprint(), before, 'the refusal writes nothing');
  assert.equal(await openPaymentRegistration(ra), true, 'the pre-038 registration stays open');
  // Where record_v2 would have recorded: its payments-only cap admits 9,000 (shown with the barrier lifted, rolled back).
  const cf = await owner.begin(RC, async (tx) => withTriggersLifted(tx, [[`${PAY}.invoice_payment`, BARRIER_PAY]], async () => {
    const [r] = await tx.unsafe(recordSql('m7b_invoice_payment_record_v2'), recordArgs(f, ra, PAYMENT));
    throw Object.assign(new Error('icc: counterfactual'), { seen: r.o_outcome });
  })).catch((e) => e.seen ?? `failed ${safeCode(e)}`);
  assert.equal(cf, 'applied', 'record_v2 would have recorded the same 9,000');
  const AMOUNT = TOTAL - CREDIT; // 7,799: exactly what remains
  const [ok] = await runtime.unsafe(recordSql('m7b_invoice_payment_record_v3'), recordArgs(f, ra, AMOUNT));
  assert.equal(ok.o_outcome, 'applied', 'record_v3 records what remains with the pre-038 proof');
  assert.deepEqual(await sums(owner, f), { credited: CREDIT, paid: AMOUNT, total: TOTAL }, 'credited + paid = Total');
  assert.deepEqual({ ...(await paySettle(f, ra, 2)) }, { o_outcome: 'applied', o_version: '3' }, 'the recorded pre-038 registration settles (confirmed)');
  assert.deepEqual({ ...(await paySettle(f, rb, 1)) }, { o_outcome: 'applied', o_version: '3' }, 'the unused pre-038 registration settles (withdrawn)');
  t.diagnostic('record_v3 refused amount_exceeds_remaining where record_v2 would have recorded; then applied and settled');
});

test('ICC-11 [CN-36]: after a clean rollback, a payment registration created before 038 completes through record_v2 again', async () => {
  await ensureDown();
  const f = await scene();
  const reg = await payRegister(f, f.A); // before 038
  assert.equal((await trustedApply('038')).outcome, 'complete', '038 applied');
  assert.equal(await aclOf(RECORD2), ACL_OWNER_ONLY, 'while applied, tmpos_app cannot call record_v2');
  await ensureDown(); // clean: no credit-note evidence; the payment registration and its audit row do not block it
  assert.equal(await aclOf(RECORD2), ACL_RESTORED, 'rolled back: tmpos_app may call record_v2 again');
  const [r] = await runtime.unsafe(recordSql('m7b_invoice_payment_record_v2'), recordArgs(f, reg, PAYMENT));
  assert.equal(r.o_outcome, 'applied', 'the pre-038 registration completes through record_v2');
  assert.deepEqual({ ...(await paySettle(f, reg, 2)) }, { o_outcome: 'applied', o_version: '3' }, 'and settles');
  await ensureApplied();
});
