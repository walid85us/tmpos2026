// Phase 4.0 M7B-CREDITNOTES-P1 — migration 038 SMOKE against REAL, crash-durable PostgreSQL (the full acceptance suites are
// separate). Exercised as the runtime's own non-owner login, every call bound as a production adapter would bind it.
//
//   ICS-01 001-038 by the trusted executor; the down while EMPTY restores 037's and 036's catalog (tmpos_app's EXECUTE on
//          record v2, void v2 and the payments read, 036's pinned trigger sets); the up applies again.
//   ICS-02 one store-scope store owner on one invoice: register -> proof (another connection, after COMMIT; that connection
//          resolved the routine before the registration, see ICS-02) -> issue; the payments read v2 shows the credit;
//          withdraw; the read shows it gone; the down refuses (55000) while evidence exists.
//
// DISPOSABLE ONLY, DURABLE (proofs need fsync on). It leaves 001-038 applied and no credit note, registration, session, login
// or fixture of its own.
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
const CN = 'tmpos_invoice_credit_note';
const PAY = 'tmpos_invoice_payment';
const RETIRED = [`${PAY}.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)`,
  `${PAY}.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)`, `${PAY}.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)`];
const MIGRATOR = { purpose: 'migration', migratorRef: 'ics-migrator', runtimeRef: 'ics-runtime' };
const LOCK_KEY = 529_638;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ics_probe';
const HOUR = 3_600_000;
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const ROLLBACK = new Error('ics: roll back');
const isSqlState = (code) => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code);
const sealed = (label, e) => new Error(`${label}: ${isSqlState(e?.code) ? `SQLSTATE ${e.code}` : 'failed'}`);

const netstring = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from(`${b.length}:`), b, Buffer.from(',')]); };
const mintProof = (issuer, key, r, expiresAt) => createHmac('sha256', issuer).update(Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion, r.authenticatedAt, r.createdAt, r.lastSeenAt,
    r.validatedAt, expiresAt].map((v) => netstring(String(v)))])).digest();
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

const TARGET = resolveDisposableTarget('ICS', { durable: true });
const cluster = TARGET.cluster ?? null;
assertDisposableTestDsn(TARGET.dsn);
const DATABASE = new URL(TARGET.dsn).pathname.slice(1);
const connect = (user, max) => testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });
const owner = connect(undefined, 3);
let runtime = null;
let prover = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let issuerKeyBefore;
let above038;
let ME;
const ME_ONLY = () => ME;
const withApp = async () => [ME, 'tmpos_app'].sort().join(',');

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
const applied038 = async () => (await owner`select pg_catalog.to_regnamespace(${CN}) is not null as e`)[0].e;
const down038 = () => owner.begin(RC, async (tx) => {
  await tx.unsafe(DOWN_038).simple();
  await tx`delete from public.schema_migrations where version = '038'`;
});
const grantees = async (sig) => (await owner`select pg_catalog.string_agg(g.grantee::regrole::text, ',' order by g.grantee::regrole::text) as g
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
  where p.oid = ${sig}::regprocedure and g.privilege_type = 'EXECUTE'`)[0].g;
const TRIGGER_MODE = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' };
/** Runs fn with one trigger disabled inside the caller's transaction, then restores the trigger's own mode. */
async function lifted(tx, rel, trg, fn) {
  const [found] = await tx`select tgenabled as mode from pg_catalog.pg_trigger where tgrelid = ${rel}::regclass and tgname = ${trg}`;
  assert.ok(found !== undefined, `trigger ${trg} on ${rel}`);
  await tx.unsafe(`alter table ${rel} disable trigger ${trg}`);
  await fn();
  await tx.unsafe(`alter table ${rel} ${TRIGGER_MODE[found.mode]} ${trg}`);
}

async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    await lifted(sql, 'public.audit_event', 'trg_audit_event_reject_mutation', () => sql`delete from public.audit_event where tenant_id = any(${TENANTS}::uuid[])`);
    if (await applied038()) {
      await lifted(sql, `${CN}.invoice_credit_note_withdrawal`, 'trg_invoice_credit_note_withdrawal_guard',
        () => sql`delete from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where tenant_id = any(${TENANTS}::uuid[])`);
      await lifted(sql, `${CN}.invoice_credit_note_registration`, 'trg_invoice_credit_note_registration_guard', async () => {
        await sql`update tmpos_invoice_credit_note.invoice_credit_note_registration set credit_note_id = null where tenant_id = any(${TENANTS}::uuid[])`;
        await lifted(sql, `${CN}.invoice_credit_note`, 'trg_invoice_credit_note_guard',
          () => sql`delete from tmpos_invoice_credit_note.invoice_credit_note where tenant_id = any(${TENANTS}::uuid[])`);
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = any(${TENANTS}::uuid[])`;
      });
      await lifted(sql, `${CN}.invoice_credit_note_counter`, 'trg_invoice_credit_note_counter_guard',
        () => sql`delete from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = any(${TENANTS}::uuid[])`);
    }
    await lifted(sql, 'tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_guard', () => lifted(sql, 'tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_guard',
      () => lifted(sql, 'tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_guard', () => lifted(sql, 'tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_guard', async () => {
        await sql`delete from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${TENANTS}::uuid[])`;
      }))));
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    if (drafts.length > 0) {
      await lifted(sql, 'tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal', () => lifted(sql, 'tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal', async () => {
        await sql`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = any(${drafts}::uuid[])`;
        await sql`delete from tmpos_invoice_draft.invoice_draft where draft_id = any(${drafts}::uuid[])`;
      }));
    }
  });
}

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(sealed('ICS teardown step', err)); } };
  try {
    await step(cleanAll);
    await step(async () => { if (!(await applied038())) assert.equal((await trustedApply('038')).outcome, 'complete'); });
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
  if (failures.length > 0) throw new AggregateError(failures, 'ICS teardown failed');
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
    runtime = connect(RUNTIME_LOGIN, 2);
    prover = connect(RUNTIME_LOGIN, 1);
    issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
    if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
    await installTestIssuerKey(owner, ISSUER_KEY);
    await installTestPaymentProofKey(owner);
    ME = (await owner`select current_user::text as me`)[0].me;
    return report;
  } catch (err) {
    for (const c of [runtime, prover, owner]) if (c) await c.end({ timeout: 5 }).catch(() => {});
    if (cluster) cluster.stop();
    throw sealed('ICS setup', err);
  }
})();

// ---- fixtures (owner connection, synthetic) ----
async function actor(label, tenant, store, scope, role) {
  const uid = `ics-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  const [{ membership_id: mid }] = await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${id}, ${tenant}, ${store}, ${scope}, ${role}, 'active') returning membership_id`;
  UIDS.push(uid);
  return { id, uid, membership: mid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
async function mint(who) {
  const key = newKey();
  const at = Date.now();
  const r = { audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
    securityVersion: 't2:ics', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at };
  const expiresAt = at + 8 * HOUR;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${mintProof(ISSUER_KEY, key, r, expiresAt)}::bytea) as outcome`;
  assert.equal(outcome, 'created');
  return key;
}
const LINES = [{ description: 'Screen replacement', quantity: 1, unitPriceCents: 12_999 }, { description: 'Labour', quantity: 2, unitPriceCents: 4_500 }];
const SUBTOTAL = 12_999 + 2 * 4_500; // 21,999
const TAX = 1_952; // div(21,999 x 8,875 + 50,000, 100,000)
const TOTAL = SUBTOTAL + TAX; // 23,951
async function scene() {
  const [{ tenant_id: T }] = await owner`insert into tenant (display_name, status) values (${`ics-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(T);
  const [{ store_id: S }] = await owner`insert into store (tenant_id, store_name, status) values (${T}, ${`ics ${SUFFIX}`}, 'active') returning store_id`;
  const C = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${C}, ${T}, ${`ICS ${SUFFIX}`})`;
  // The store-scope store owner (one active store-scope membership at the path store) and a tenant-scope owner for settings.
  const boss = await actor('owner', T, S, 'store', 'store_owner');
  const own = await actor('tenant-owner', T, null, 'tenant', 'store_owner');
  const kBoss = await mint(boss);
  const kOwn = await mint(own);
  const [s] = await runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_issuing_settings_set($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
    [kOwn, S, T, '0', 'ICS Legal Name LLC', 'ICS Store', '1 Main St\nSpringfield', 'TAX-ICS-1', 'exclusive_rate', 8875]);
  assert.equal(s.o_outcome, 'applied', 'issuing settings');
  const draft = randomUUID();
  const [c] = await runtime.unsafe(`select o_outcome from tmpos_invoice_edit.m7b_invoice_draft_create_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [kBoss, S, draft, T, C, JSON.stringify(LINES), String(SUBTOTAL)]);
  assert.equal(c.o_outcome, 'applied', 'draft saved');
  const invoice = randomUUID();
  const [i] = await runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_invoice_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [kBoss, S, draft, T, '1', '1', '1', invoice]);
  assert.equal(i.o_outcome, 'applied', 'invoice issued');
  return { T, S, boss, kBoss, invoice };
}
const amounts = async (f) => {
  const [r] = await runtime.unsafe(`select o_outcome, o_due_cents, o_credited_cents, o_applied_cents, o_remaining_cents, o_payment_status
    from ${PAY}.m7b_invoice_payments_get_v2($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`, [f.kBoss, f.T, f.S, f.invoice, null, 51]);
  return { ...r };
};

test('ICS-01: 001-038 apply; the down while EMPTY restores the three EXECUTE grants and 036\'s trigger sets; the up applies again', async () => {
  assert.equal(APPLY.outcome, 'complete', JSON.stringify(APPLY).slice(0, 300));
  for (const sig of RETIRED) assert.equal(await grantees(sig), ME_ONLY(), `038 applied: ${sig} is the owner's alone`);
  await down038();
  assert.equal(await applied038(), false, 'schema tmpos_invoice_credit_note gone');
  for (const sig of RETIRED) assert.equal(await grantees(sig), await withApp(), `rolled back: ${sig} is executable by tmpos_app again`);
  const [t] = await owner`select (select count(*) from pg_catalog.pg_trigger where tgrelid = 'tmpos_invoice_payment.invoice_payment'::regclass and not tgisinternal)::int as pay,
    (select count(*) from pg_catalog.pg_trigger where tgrelid = 'tmpos_invoice_void.issued_invoice_void'::regclass and not tgisinternal)::int as void`;
  assert.deepEqual({ ...t }, { pay: 2, void: 2 }, '036\'s pinned trigger sets again (the down asserts them exactly)');
  assert.equal((await trustedApply('038')).outcome, 'complete', 'the up applies again');
});

test('ICS-02: register -> proof -> issue -> amounts -> withdraw for one store-scope store owner; the down refuses while evidence exists', async () => {
  const f = await scene();
  assert.deepEqual(await amounts(f), { o_outcome: 'payments', o_due_cents: String(TOTAL), o_credited_cents: '0', o_applied_cents: '0',
    o_remaining_cents: String(TOTAL), o_payment_status: 'no_payment_recorded' }, 'before: nothing credited');
  // PRECONDITION: the proving connection runs the proof routine once, for an unregistered id, BEFORE the registration (it can
  // only answer not_found, asserted). Everything the real call below reads before it samples its WAL target (034's reader, the
  // key, the registration table, the routine itself) is then resolved and cached on this one-connection pool, so that call
  // writes no WAL of its own ahead of its target. Without it, the real call was the first lookup of the routine after ICS-01's
  // 038 down and up, which leave the routine's previous pg_proc row dead on a page that lookup visits: it pruned that page —
  // xid-less WAL its own transaction wrote before its target, flushed only once it ends (037's documented self-prune, which the
  // adapter meets with one fresh transaction) — and answered not_durable after its 1,000 ms (CI run 43741302186).
  const [warm] = await prover.unsafe(`select o_outcome from ${CN}.m7b_invoice_credit_note_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [f.kBoss, f.S, f.invoice, f.T, randomUUID(), 0]);
  assert.equal(warm.o_outcome, 'not_found', 'the proof routine resolved on the proving connection before the registration');
  const registration = randomUUID();
  const attempt = randomUUID();
  const [reg] = await runtime.unsafe(`select o_outcome, o_registration_id from ${CN}.m7b_invoice_credit_note_register($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8::text, $9::uuid)`,
    [f.kBoss, f.S, f.invoice, f.T, registration, attempt, '2000', 'pricing_error', randomUUID()]);
  assert.deepEqual({ ...reg }, { o_outcome: 'applied', o_registration_id: registration }, 'registered');
  const [pr] = await prover.unsafe(`select o_outcome, o_attempt_id, o_proof from ${CN}.m7b_invoice_credit_note_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [f.kBoss, f.S, f.invoice, f.T, registration, 1000]);
  const [wal] = await owner`select pg_catalog.pg_current_wal_insert_lsn()::text as i, pg_catalog.pg_current_wal_flush_lsn()::text as f`;
  assert.equal(pr.o_outcome, 'proof', `the proof issues for the committed, durable registration (after the call: insert ${wal.i}, flush ${wal.f})`);
  assert.equal(pr.o_attempt_id, attempt);
  assert.ok(/^[0-9a-f]{64}$/.test(pr.o_proof), 'a 64-hex proof (value withheld)');
  const creditNote = randomUUID();
  const [iss] = await runtime.unsafe(`select o_outcome, o_credit_note_id, o_audit_event_id from ${CN}.m7b_invoice_credit_note_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`,
    [f.kBoss, f.S, f.invoice, f.T, creditNote, registration, attempt, '2000', 'pricing_error', pr.o_proof, randomUUID()]);
  assert.equal(iss.o_outcome, 'applied', 'issued');
  assert.equal(iss.o_credit_note_id, creditNote);
  const [row] = await owner`select credit_note_number::int as n, gross_cents::int as g, tax_cents::int as t, net_cents::int as net
    from tmpos_invoice_credit_note.invoice_credit_note where credit_note_id = ${creditNote}`;
  // D-CN-4 A: t = div(2 x 1,952 x 2,000 + 23,951, 2 x 23,951) = 163; net 1,837; the store's first number.
  assert.deepEqual({ ...row }, { n: 1, g: 2000, t: 163, net: 1837 }, 'number 1, the split');
  assert.deepEqual(await amounts(f), { o_outcome: 'payments', o_due_cents: String(TOTAL), o_credited_cents: '2000', o_applied_cents: '0',
    o_remaining_cents: String(TOTAL - 2000), o_payment_status: 'no_payment_recorded' }, 'after the credit');

  const blocked = await owner.begin(RC, async (tx) => { await tx.unsafe(DOWN_038).simple(); throw ROLLBACK; }).then(() => null, (e) => e);
  assert.equal(blocked === ROLLBACK ? 'ran' : blocked?.code, '55000', 'the down refuses while a credit note exists');

  // The void v3 refuses while the credit is active; the retired void v2 (the owner keeps EXECUTE) meets the barrier: 23000.
  const [v3] = await runtime.unsafe(`select o_outcome from ${PAY}.m7b_invoice_void_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`,
    [f.kBoss, f.S, f.invoice, f.T, '1', 'issued_in_error']);
  assert.equal(v3.o_outcome, 'credit_notes_recorded', 'void v3 refuses while a credit note is active');
  const stale = await owner.begin(RC, async (tx) => {
    await tx.unsafe(`select * from ${PAY}.m7b_invoice_void_v2($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`, [f.kBoss, f.S, f.invoice, f.T, '1', 'issued_in_error']);
    throw ROLLBACK;
  }).then(() => null, (e) => e);
  assert.equal(stale === ROLLBACK ? 'ran' : stale?.code, '23000', 'the retired void v2 meets the barrier: 23000, no void');
  const over = await owner.begin(RC, async (tx) => {
    await tx`insert into tmpos_invoice_payment.invoice_payment (payment_id, tenant_id, store_id, invoice_id, attempt_id, amount_cents, method, recorded_at, recorded_by)
      values (${randomUUID()}, ${f.T}, ${f.S}, ${f.invoice}, ${randomUUID()}, ${TOTAL - 1999}, 'cash', pg_catalog.clock_timestamp(), ${f.boss.id})`;
    throw ROLLBACK;
  }).then(() => null, (e) => e);
  assert.equal(over === ROLLBACK ? 'ran' : over?.code, '23001', 'a payment past the credit-aware cap meets the barrier (restrict_violation)');
  const anchored = await owner.begin(RC, async (tx) => {
    await tx.unsafe(readFileSync(`${MIG_DIR}/037_m7b_invoice_payment_registration.down.sql`, 'utf8')).simple();
    throw ROLLBACK;
  }).then(() => null, (e) => e);
  assert.equal(anchored === ROLLBACK ? 'ran' : anchored?.code, '2BP01', '037\'s down fails on 038\'s anchor (R-GATE-1)');

  const [wd] = await runtime.unsafe(`select o_outcome from ${CN}.m7b_invoice_credit_note_withdraw($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::text, $8::uuid)`,
    [f.kBoss, f.S, f.invoice, f.T, creditNote, '1', 'wrong_amount', randomUUID()]);
  assert.equal(wd.o_outcome, 'applied', 'withdrawn');
  assert.deepEqual(await amounts(f), { o_outcome: 'payments', o_due_cents: String(TOTAL), o_credited_cents: '0', o_applied_cents: '0',
    o_remaining_cents: String(TOTAL), o_payment_status: 'no_payment_recorded' }, 'after the withdrawal: remaining back to the Total');
  const [{ audits }] = await owner`select count(*)::int as audits from public.audit_event
    where tenant_id = ${f.T} and action_id like 'store.invoice_credit_note.%'`;
  assert.equal(audits, 3, 'register, issue and withdraw: one audit row each');
});
