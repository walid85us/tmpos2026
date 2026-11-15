// Phase 4.0 M7B-CREDITNOTES-P1 — the credit-note routines of migration 038 against REAL, crash-durable PostgreSQL: an
// INDEPENDENT acceptance suite for doc 16's §8 matrix at the database layer (the routines exercised as the runtime's own
// non-owner login, every call bound as a production adapter would bind it). Each title names its acceptance id.
//
//   ICR-01 (CN-24, CN-25)   the retired record v2, void v2 and payments read are not executable by tmpos_app (42501); the
//                           replacements are.
//   ICR-02 (CN-13, CN-07a)  register -> proof (an independent HMAC) -> issue -> lookup -> settle -> list -> withdraw: exactly
//                           one audit row per success with its kind, permission, reason and subject columns; none per refusal.
//   ICR-03 (CN-18, CN-15, CN-24)  §5 E1-E5 through the routines, exact cents and words (E3 through record v3, E4 refused).
//   ICR-04 (CN-18, CN-23, CN-16, CN-25)  §5 E6-E10 (a second withdrawal invalid_state; E8; E9 through void v3).
//   ICR-05 (CN-18)          §5 E11, E12, E14, E16 (lower clamp), E17 (upper clamp).
//   ICR-06 (CN-01, CN-18 E13)  a concurrent credit and payment, both orders, on separate connections behind a barrier.
//   ICR-07 (CN-02)          a concurrent credit and void, both orders.
//   ICR-08 (CN-03)          a concurrent credit and payment reversal, both orders.
//   ICR-09 (CN-32)          the amounts read is one snapshot under a concurrent withdrawal plus payment.
//   ICR-10 (CN-04)          duplicate attempts: same session already_issued (before voided and the bound); renewed session
//                           not_found; a second store-scope owner's same attempt id already_issued at issue, also after a
//                           withdrawal; another invoice's attempt independent.
//   ICR-11 (CN-06)          changed gross or reason on an open registration -> conflict; on an issued one -> already_issued.
//   ICR-12 (CN-07a)         release then a late issue -> invalid_state; confirm then a late issue -> already_issued; a refused
//                           issue leaves the registration open and blocks a second registration (conflict) until released.
//   ICR-13 (CN-07a)         a payment proof is never accepted for a credit note, nor a credit-note proof by record v3.
//   ICR-14 (CN-07a, CN-10, CN-10b)  two owners cannot see or settle each other's registrations; manager, technician,
//                           sales staff, tenant-scope owner and a demoted owner refused/denied; reads follow view_issued_invoices.
//   ICR-15 (CN-07a)         renewed session -> not_found while the lookup and settlement resolve it; a proof-key rotation;
//                           the lookup's 24-hour window for settled rows.
//   ICR-16 (CN-08)          any isolation but READ COMMITTED -> 55000, nothing written.
//   ICR-17 (CN-09)          another store's or tenant's invoice is the missing invoice's answer; nothing written.
//   ICR-18 (CN-10)          tenant read_only/overdue, store read_only/overdue/suspended refused, each with an active-owner
//                           positive control; trialing allowed.
//   ICR-19 (CN-11)          expiry and sign-in judged on one clock reading AFTER the last wait (header; counter; header).
//   ICR-20 (CN-14)          issued header, lines, invoice counter, payments and reversals byte-identical around credits.
//   ICR-21 (CN-16)          a voided invoice: withdrawal invalid_state, an open registration's issue invalid_state.
//   ICR-22 (CN-17)          a seeded property test of the split and its invariants.
//   ICR-23 (CN-17)          a forced invariant violation raises data_corrupted (XX001, fixed text).
//   ICR-24 (CN-22)          numbering: per store from 1, a refusal uses none, concurrent issues distinct, withdrawal keeps it.
//   ICR-25 (CN-33)          staff names to the store-scope store owner only; absent for anyone else; no id; no other read.
//   ICR-26 (CN-35)          forced corruption makes the amounts read raise data_corrupted.
//   ICR-27 (§4, CN-18)      an issued invoice with Total 0: a credit is amount_exceeds_remaining, nothing written, nothing_due.
//   ICR-28 (CN-18 E15)      option B's net-entered rounding (pure) against option A through the routine.
//
// DISPOSABLE ONLY, DURABLE (proofs need fsync on). Leaves 001-038 applied and no credit note, withdrawal, credit-note
// registration, credit-note audit row, payment, session, login or proof key of its own. Failure output never carries a
// proof, key or database error text: only outcome words, numbers, booleans and validated SQLSTATEs.
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
const MIGRATOR = { purpose: 'migration', migratorRef: 'icr-migrator', runtimeRef: 'icr-runtime' };
const LOCK_KEY = 529_639;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_icr_probe';
const HOUR = 3_600_000;
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const ROLLBACK = new Error('icr: roll back');
const CN_ACTIONS = ['store.invoice_credit_note.register', 'store.invoice_credit_note.issue', 'store.invoice_credit_note.settle',
  'store.invoice_credit_note.withdraw'];

// ---- secret-safe failure output (1cd8097): only SQLSTATEs, never a message, detail, proof or key ----
const isSqlState = (code) => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code);
const safeCode = (e) => (e?.code === undefined || e?.code === null ? 'none' : isSqlState(e.code) ? e.code : 'unknown');
const sealed = (label, e) => new Error(`${label}: ${isSqlState(e?.code) ? `SQLSTATE ${e.code}` : 'failed'}`);
async function errorOf(p) { try { await p; return null; } catch (e) { return e; } }
const codeOf = async (p) => { const e = await errorOf(p); return e === null ? 'ok' : safeCode(e); };

// ---- the independent constructions (mint, proofs) ----
const netstring = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from(`${b.length}:`), b, Buffer.from(',')]); };
const mintProof = (issuer, key, r, expiresAt) => createHmac('sha256', issuer).update(Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion, r.authenticatedAt, r.createdAt, r.lastSeenAt,
    r.validatedAt, expiresAt].map((v) => netstring(String(v)))])).digest();
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
const uuidBytes = (u) => Buffer.from(u.replace(/-/g, ''), 'hex');
const int8 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const digestOf = (key) => createHash('sha256').update(Buffer.from(key, 'utf8')).digest();
/** 038's credit-note proof message, built here from doc 16 / ROUTINES.md, never from the routine. */
const cnProofFor = (pk, gen, m) => createHmac('sha256', pk).update(Buffer.concat([
  Buffer.from('tmpos-m7b-invoice-credit-note-registration-proof:v1', 'utf8'), Buffer.from([0]),
  ...[m.registration, m.actor, m.tenant, m.store, m.invoice, m.attempt].map(uuidBytes), digestOf(m.sessionKey), int8(gen),
  int8(m.gross), Buffer.from(m.reason, 'utf8')])).digest('hex');
/** 037's payment proof message. */
const payProofFor = (pk, gen, m) => createHmac('sha256', pk).update(Buffer.concat([
  Buffer.from('tmpos-m7b-payment-registration-proof:v1', 'utf8'), Buffer.from([0]),
  ...[m.registration, m.actor, m.tenant, m.store, m.invoice, m.attempt].map(uuidBytes), digestOf(m.sessionKey), int8(gen)])).digest('hex');

// ---- cluster lifecycle ----
const TARGET = resolveDisposableTarget('ICR', { durable: true });
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
let above038;
let PK = null; // the payment proof key bytes installed now (037's key, reused by 038)
let GEN = null; // its generation

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
async function installProofKey() {
  PK = randomBytes(32);
  await installTestPaymentProofKey(owner, PK);
  GEN = BigInt((await owner`select generation::text as g from tmpos_invoice_payment.payment_proof_key where singleton`)[0].g);
}

const TRIGGER_MODE = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' };
/** invoicePaymentRegistrationRoutine's withTriggersLifted: disable, run, restore each trigger's own mode, in the caller's tx. */
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

async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    await withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']],
      () => sql`delete from public.audit_event where tenant_id = any(${TENANTS}::uuid[])`);
    if (await applied038()) {
      await withTriggersLifted(sql, CN_GUARDS, async () => {
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`update tmpos_invoice_credit_note.invoice_credit_note_registration set credit_note_id = null where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = any(${TENANTS}::uuid[])`;
        await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = any(${TENANTS}::uuid[])`;
      });
    }
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
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(sealed('ICR teardown step', err)); } };
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
    // Postcondition: no credit-note evidence anywhere, so 038's down (refusing while evidence exists) still runs for later suites.
    await step(async () => {
      const [s] = await owner`select (select count(*) from tmpos_invoice_credit_note.invoice_credit_note)::int as notes,
          (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal)::int as withdrawals,
          (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration)::int as registrations,
          (select count(*) from public.audit_event where action_id = any(${CN_ACTIONS}::text[])
             or subject_invoice_credit_note_id is not null or subject_invoice_credit_note_registration_id is not null)::int as audits,
          (select count(*) from tmpos_invoice_payment.payment_proof_key)::int as keys`;
      assert.deepEqual({ ...s }, { notes: 0, withdrawals: 0, registrations: 0, audits: 0, keys: 0 }, 'ICR left no credit-note evidence');
      const down = await owner.begin(RC, async (tx) => { await tx.unsafe(DOWN_038).simple(); throw ROLLBACK; }).then(() => null, (e) => e);
      assert.equal(down === ROLLBACK ? 'ran' : safeCode(down), 'ran', '038\'s down runs (rolled back here) once the suite is clean');
    });
    await step(() => above038?.restore());
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'ICR teardown failed');
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
    runtime = connect(RUNTIME_LOGIN, 4);
    prover = connect(RUNTIME_LOGIN, 1);
    issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
    if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
    await installTestIssuerKey(owner, ISSUER_KEY);
    await installProofKey();
    return report;
  } catch (err) {
    for (const c of [runtime, prover, owner]) if (c) await c.end({ timeout: 5 }).catch(() => {});
    if (cluster) cluster.stop();
    throw sealed('ICR setup', err);
  }
})();

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
async function actor(label, grants, displayName = null) {
  const uid = `icr-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status, display_name) values (${id}, 'active', ${displayName})`;
  const memberships = [];
  for (const g of grants) {
    const [{ membership_id: mid }] = await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${g.tenant}, ${g.store ?? null}, ${g.scope}, ${g.role}, 'active') returning membership_id`;
    memberships.push(mid);
  }
  UIDS.push(uid);
  return { id, uid, memberships, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
/** A tenant session for `who`; `authenticatedAt` (ms) may lie in the past (CN-11), the session itself is created now. */
async function mint(who, { authenticatedAt } = {}) {
  const key = newKey();
  const at = Date.now();
  const r = { audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
    securityVersion: 't2:icr', authenticatedAt: authenticatedAt ?? at, createdAt: at, lastSeenAt: at, validatedAt: at };
  const expiresAt = at + 8 * HOUR;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${mintProof(ISSUER_KEY, key, r, expiresAt)}::bytea) as outcome`.catch((e) => { throw sealed('ICR mint', e); });
  assert.equal(outcome, 'created', 'a tenant session');
  return key;
}
async function settingsSet(key, store, tenant, rate) {
  const [row] = await runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_issuing_settings_set($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
    [key, store, tenant, '0', 'ICR Legal Name LLC', 'ICR Store', '1 Main St\nSpringfield', 'TAX-ICR-1', rate === null ? 'none' : 'exclusive_rate', rate])
    .catch((e) => { throw sealed('ICR settings', e); });
  assert.equal(row.o_outcome, 'applied', 'the store\'s issuing settings');
}
/** Synthetic invoice X (doc 16 §5): subtotal 10,000 at 8.875 % -> tax 888, Total 10,888. */
const X_LINES = [{ description: 'Repair', quantity: 1, unitPriceCents: 10_000 }];
const X_TOTAL = 10_888;
const lineOf = (cents) => [{ description: 'Service', quantity: 1, unitPriceCents: cents }];

/** A fresh tenant: stores at the given rates (null = tax mode none), the first is S; S2 another store with its own owner. */
async function scene(label, { rates = [8875], tenantStatus = 'active', extraOwners = 0 } = {}) {
  const [{ tenant_id: T }] = await owner`insert into tenant (display_name, status) values (${`icr-${label}-${SUFFIX}`}, ${tenantStatus}) returning tenant_id`;
  TENANTS.push(T);
  const stores = [];
  for (let i = 0; i < rates.length; i += 1) {
    stores.push((await owner`insert into store (tenant_id, store_name, status) values (${T}, ${`icr ${label} ${i} ${SUFFIX}`}, 'active') returning store_id`)[0].store_id);
  }
  const S = stores[0];
  const S2 = (await owner`insert into store (tenant_id, store_name, status) values (${T}, ${`icr ${label} other ${SUFFIX}`}, 'active') returning store_id`)[0].store_id;
  const C = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${C}, ${T}, ${`ICR ${label} ${SUFFIX}`})`;
  const a = {
    boss: await actor(`${label}-owner`, stores.map((s) => storeGrant(T, s, 'store_owner')), `ICR Owner ${label}`),
    boss2: await actor(`${label}-owner2`, [storeGrant(T, S, 'store_owner')], null),
    manager: await actor(`${label}-manager`, [storeGrant(T, S, 'manager')], `ICR Manager ${label}`),
    tech: await actor(`${label}-tech`, [storeGrant(T, S, 'technician')], `ICR Tech ${label}`),
    sales: await actor(`${label}-sales`, [storeGrant(T, S, 'sales_staff')], `ICR Sales ${label}`),
    own: await actor(`${label}-tenant-owner`, [{ scope: 'tenant', tenant: T, role: 'store_owner' }], `ICR Tenant Owner ${label}`),
    bossB: await actor(`${label}-ownerB`, [storeGrant(T, S2, 'store_owner')], `ICR Owner B ${label}`),
  };
  for (let i = 0; i < extraOwners; i += 1) a[`owner${i + 3}`] = await actor(`${label}-owner${i + 3}`, [storeGrant(T, S, 'store_owner')], null);
  const k = {};
  for (const [name, who] of Object.entries(a)) k[name] = await mint(who);
  for (let i = 0; i < stores.length; i += 1) await settingsSet(k.own, stores[i], T, rates[i]);
  await settingsSet(k.own, S2, T, 8875);
  return { label, T, S, S2, stores, C, a, k };
}
async function invoice(f, { store = f.S, key = store === f.S2 ? f.k.bossB : f.k.boss, lines = X_LINES } = {}) {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
  const draft = randomUUID();
  const [c] = await runtime.unsafe(`select o_outcome from tmpos_invoice_edit.m7b_invoice_draft_create_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [key, store, draft, f.T, f.C, JSON.stringify(lines), String(subtotal)]).catch((e) => { throw sealed('ICR draft', e); });
  assert.equal(c.o_outcome, 'applied', 'draft saved');
  const id = randomUUID();
  const [i] = await runtime.unsafe(`select o_outcome from tmpos_invoice_issue.m7b_invoice_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [key, store, draft, f.T, '1', '1', '1', id]).catch((e) => { throw sealed('ICR issue invoice', e); });
  assert.equal(i.o_outcome, 'applied', 'invoice issued');
  return id;
}

// ---------------------------------------------------------------------------
// the runtime login's calls: [sql, params] builders, usable on a pool or inside a held transaction
// ---------------------------------------------------------------------------
const Q = {
  register: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_register($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8::text, $9::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.registration, a.attempt, String(a.gross), a.reason, a.corr ?? randomUUID()]],
  proof: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [k, a.store, a.invoice, a.tenant, a.registration, a.wait ?? 1000]],
  issue: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_issue($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.cn ?? randomUUID(), a.registration, a.attempt, String(a.gross), a.reason, a.proof, a.corr ?? randomUUID()]],
  attempts: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_attempts($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [k, a.store, a.tenant, a.afterInvoice ?? null, a.afterAttempt ?? null, a.limit ?? 51]],
  settle: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_settle($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.attempt, String(a.version), a.corr ?? randomUUID()]],
  withdraw: (k, a) => [`select * from ${CN}.m7b_invoice_credit_note_withdraw($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::text, $8::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.cn, String(a.version ?? 1), a.wreason ?? 'wrong_amount', a.corr ?? randomUUID()]],
  list: (k, a) => [`select * from ${CN}.m7b_invoice_credit_notes_list($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [k, a.tenant, a.store, a.invoice, a.after ?? null, a.limit ?? 51]],
  amounts: (k, a) => [`select * from ${PAY}.m7b_invoice_payments_get_v2($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [k, a.tenant, a.store, a.invoice, null, 51]],
  payRegister: (k, a) => [`select * from ${PAY}.m7b_invoice_payment_register($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.registration, a.attempt, randomUUID()]],
  payProof: (k, a) => [`select * from ${PAY}.m7b_invoice_payment_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [k, a.store, a.invoice, a.tenant, a.registration, 1000]],
  record: (k, a) => [`select * from ${PAY}.m7b_invoice_payment_record_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.payment ?? randomUUID(), a.registration, a.attempt, String(a.amount), 'cash', a.proof, randomUUID()]],
  paySettle: (k, a) => [`select * from ${PAY}.m7b_invoice_payment_settle($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::uuid)`,
    [k, a.store, a.invoice, a.tenant, a.attempt, String(a.version), randomUUID()]],
  reverse: (k, a) => [`select * from ${PAY}.m7b_invoice_payment_reverse($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::text, $8::uuid)`,
    [k, a.store, a.invoice, a.payment, a.tenant, '1', 'recorded_in_error', randomUUID()]],
  void3: (k, a) => [`select * from ${PAY}.m7b_invoice_void_v3($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`,
    [k, a.store, a.invoice, a.tenant, '1', 'issued_in_error']],
};
const run = async (db, [sql, params]) => (await db.unsafe(sql, params)).map((r) => ({ ...r }));
const one = async (db, q) => (await run(db, q))[0];
const word = async (db, q) => (await one(db, q)).o_outcome;

/** Register + proof (committed, durable) for a credit of `gross`; nothing issued yet. */
async function prepareCredit(f, invoice, gross, { reason = 'pricing_error', key = f.k.boss, store = f.S } = {}) {
  const a = { store, invoice, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), gross, reason, cn: randomUUID(), key };
  assert.equal(await word(runtime, Q.register(key, a)), 'applied', 'credit registered');
  const p = await one(prover, Q.proof(key, a));
  assert.equal(p.o_outcome, 'proof', 'credit-note proof');
  a.proof = p.o_proof;
  return a;
}
async function settleCredit(a, outcome) {
  assert.equal(await word(runtime, Q.settle(a.key, { ...a, version: outcome === 'applied' ? 2 : 1 })), 'applied', 'credit registration settled');
}
/** A whole credit: register, proof, issue, then settle the registration (confirm or release). */
async function credit(f, invoice, gross, opts = {}) {
  const a = await prepareCredit(f, invoice, gross, opts);
  a.outcome = await word(runtime, Q.issue(a.key, a));
  if (opts.settle !== false) await settleCredit(a, a.outcome);
  return a;
}
async function preparePay(f, invoice, amount, { key = f.k.boss2, store = f.S } = {}) {
  const a = { store, invoice, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), amount, payment: randomUUID(), key };
  assert.equal(await word(runtime, Q.payRegister(key, a)), 'applied', 'payment registered');
  const p = await one(prover, Q.payProof(key, a));
  assert.equal(p.o_outcome, 'proof', 'payment proof');
  a.proof = p.o_proof;
  return a;
}
async function settlePay(a, outcome) {
  assert.equal(await word(runtime, Q.paySettle(a.key, { ...a, version: outcome === 'applied' ? 2 : 1 })), 'applied', 'payment registration settled');
}
async function pay(f, invoice, amount, opts = {}) {
  const a = await preparePay(f, invoice, amount, opts);
  a.outcome = await word(runtime, Q.record(a.key, a));
  await settlePay(a, a.outcome);
  return a;
}
const withdraw = (f, a, wreason = 'wrong_amount', key = f.k.boss) => word(runtime, Q.withdraw(key, { ...a, wreason }));
async function amounts(f, invoice, { key = f.k.boss, store = f.S } = {}) {
  const r = await one(runtime, Q.amounts(key, { tenant: f.T, store, invoice }));
  assert.equal(r.o_outcome, 'payments', 'the amounts read answers');
  return { credited: Number(r.o_credited_cents), paid: Number(r.o_applied_cents), remaining: Number(r.o_remaining_cents), word: r.o_payment_status,
    due: Number(r.o_due_cents) };
}
const am = (credited, paid, remaining, w) => ({ credited, paid, remaining, word: w });
const pick = ({ credited, paid, remaining, word: w }) => ({ credited, paid, remaining, word: w });
async function cnRow(id) {
  const [r] = await owner`select credit_note_number::int as n, gross_cents::int as g, tax_cents::int as t, net_cents::int as net
    from tmpos_invoice_credit_note.invoice_credit_note where credit_note_id = ${id}`;
  return r === undefined ? null : { ...r };
}
const split = async (id) => { const r = await cnRow(id); return r === null ? null : { t: r.t, net: r.net }; };
async function writes(T) {
  const [r] = await owner`select (select count(*) from tmpos_invoice_credit_note.invoice_credit_note where tenant_id = ${T})::int as notes,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where tenant_id = ${T})::int as withdrawals,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = ${T})::int as registrations,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = ${T} and acknowledged_at is not null)::int as settled,
      (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = ${T} and credit_note_id is not null)::int as linked,
      (select coalesce(sum(last_number), 0) from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = ${T})::int as numbers,
      (select count(*) from tmpos_invoice_payment.invoice_payment where tenant_id = ${T})::int as payments,
      (select count(*) from tmpos_invoice_void.issued_invoice_void where tenant_id = ${T})::int as voids,
      (select count(*) from public.audit_event where tenant_id = ${T})::int as audits`;
  return { ...r };
}
async function auditRow(id) {
  const [r] = await owner`select action_id, required_permission, reason_code, decision, result_status, scope_type, source_of_truth, evaluated_by,
      metadata::text as metadata, actor_internal_user_id as actor, store_id, subject_invoice_credit_note_id as cn,
      subject_invoice_credit_note_registration_id as reg
    from public.audit_event where event_id = ${id}`;
  return r === undefined ? null : { ...r };
}
const AUDIT_FIXED = { decision: 'allow', result_status: 'succeeded', scope_type: 'store', source_of_truth: 'invoice_credit_note_routine',
  evaluated_by: 'm7b_invoice_credit_note_routine@v1', metadata: '{}' };

// ---------------------------------------------------------------------------
// race levers (invoicePaymentRoutine :655-693): polling observable lock state, never a sleep standing in for an order
// ---------------------------------------------------------------------------
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
  }).then((value) => ({ outcome: 'committed', value }),
    (err) => (err === ROLLBACK ? { outcome: 'rolled back' } : { outcome: 'failed', code: safeCode(err) }));
  h.done.then((out) => { h.out = out; });
  return h;
}
/** A statement in its own transaction (committed when it answers), its backend pid exposed as soon as it is known. */
function running(db, fn) {
  const r = { pid: null, out: undefined };
  r.done = db.begin(RC, async (tx) => {
    r.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    return fn(tx);
  }).then((value) => ({ outcome: 'committed', value }), (err) => ({ outcome: 'failed', code: safeCode(err) }));
  r.done.then((out) => { r.out = out; });
  return r;
}
const blockers = async (pid) => (pid === null ? [] : (await owner`select pg_catalog.pg_blocking_pids(${pid}) as b`)[0].b);
const blockedBy = async (pid, holder) => holder !== null && (await blockers(pid)).includes(holder);
const rowWaitOn = async (pid) => (await owner`select l.relation::regclass::text as rel from pg_catalog.pg_locks l
  where l.pid = ${pid} and l.locktype = 'tuple'`).map((r) => r.rel);
const waitsFor = async (pid) => (await owner`select l.locktype::text as locktype, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted order by 1, 2`).map((r) => [r.locktype, r.mode]);
const tx1 = (q) => (tx) => tx.unsafe(q[0], q[1]).then((rows) => rows.map((r) => ({ ...r })));
function finished(out, label) {
  assert.equal(out.outcome, 'committed', `${label}: ${out.outcome}${out.code ? ` (SQLSTATE ${out.code})` : ''}`);
  return out.value[0].o_outcome;
}
/** Runs `first` held open, then `second` until it is seen waiting on `first`'s backend, then commits `first`. */
async function race(first, second, label) {
  const h = holding(runtime, tx1(first));
  try {
    await until(() => h.ready || h.out !== undefined, `${label}: the first call holds`);
    assert.ok(h.ready, `${label}: the first call answered inside its transaction`);
    const r = running(runtime, tx1(second));
    await until(async () => r.out !== undefined || (r.pid !== null && await blockedBy(r.pid, h.pid)), `${label}: the second call waits on the first`);
    assert.equal(r.out, undefined, `${label}: the second call waited (did not answer before the first committed)`);
    h.release('commit');
    return [finished(await h.done, `${label} first`), finished(await r.done, `${label} second`)];
  } finally {
    h.release('rollback');
  }
}

// ---------------------------------------------------------------------------
// forced rows (CN-17 invariant, CN-35): written past the guards with withTriggersLifted, removed the same way
// ---------------------------------------------------------------------------
let FORCED_N = 900_000;
async function forceCredit(f, invoice, { gross, tax, net }) {
  const reg = randomUUID();
  const cn = randomUUID();
  const attempt = randomUUID();
  FORCED_N += 1;
  const n = FORCED_N;
  await owner.begin(RC, (tx) => withTriggersLifted(tx, CN_GUARDS, async () => {
    await tx`insert into tmpos_invoice_credit_note.invoice_credit_note_registration (registration_id, tenant_id, store_id, invoice_id,
        registered_by, attempt_id, gross_cents, reason_code, session_digest, key_generation, registered_xact, registered_at)
      values (${reg}, ${f.T}, ${f.S}, ${invoice}, ${randomUUID()}, ${attempt}, ${gross}, 'goodwill', ${randomBytes(32)}, 1,
        pg_catalog.pg_current_xact_id(), pg_catalog.clock_timestamp())`;
    await tx`insert into tmpos_invoice_credit_note.invoice_credit_note (credit_note_id, tenant_id, store_id, invoice_id, attempt_id,
        registration_id, credit_note_number, gross_cents, tax_cents, net_cents, reason_code, issued_at, issued_by)
      values (${cn}, ${f.T}, ${f.S}, ${invoice}, ${attempt}, ${reg}, ${n}, ${gross}, ${tax}, ${net}, 'goodwill', pg_catalog.clock_timestamp(), ${randomUUID()})`;
  })).catch((e) => { throw sealed('ICR forced credit', e); });
  return { reg, cn };
}
async function unforce({ reg, cn }) {
  await owner.begin(RC, (tx) => withTriggersLifted(tx, CN_GUARDS, async () => {
    await tx`delete from tmpos_invoice_credit_note.invoice_credit_note where credit_note_id = ${cn}`;
    await tx`delete from tmpos_invoice_credit_note.invoice_credit_note_registration where registration_id = ${reg}`;
  })).catch((e) => { throw sealed('ICR unforce', e); });
}

const RETIRED = [`${PAY}.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)`,
  `${PAY}.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)`, `${PAY}.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)`];
const GRANTED = [`${CN}.m7b_invoice_credit_note_register(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)`,
  `${CN}.m7b_invoice_credit_note_registration_proof(text, uuid, uuid, uuid, uuid, integer)`,
  `${CN}.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)`,
  `${CN}.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer)`,
  `${CN}.m7b_invoice_credit_note_settle(text, uuid, uuid, uuid, uuid, bigint, uuid)`,
  `${CN}.m7b_invoice_credit_note_withdraw(text, uuid, uuid, uuid, uuid, bigint, text, uuid)`,
  `${CN}.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer)`,
  `${PAY}.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer)`,
  `${PAY}.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)`,
  `${PAY}.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text)`];

// ===========================================================================
test('ICR-01 (CN-24, CN-25): the retired record v2, void v2 and payments read are not executable by tmpos_app; the replacements are', async () => {
  assert.equal(APPLY.outcome, 'complete', 'migrations through 038 applied');
  for (const sig of RETIRED) {
    assert.equal((await owner`select pg_catalog.has_function_privilege('tmpos_app', ${sig}::regprocedure, 'EXECUTE') as x`)[0].x, false, `${sig}: tmpos_app holds no EXECUTE`);
  }
  for (const sig of GRANTED) {
    assert.equal((await owner`select pg_catalog.has_function_privilege('tmpos_app', ${sig}::regprocedure, 'EXECUTE') as x`)[0].x, true, `${sig}: tmpos_app holds EXECUTE`);
  }
  const u = () => randomUUID();
  assert.equal(await codeOf(runtime.unsafe(`select * from ${PAY}.m7b_invoice_payment_record_v2($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`,
    ['k', u(), u(), u(), u(), u(), u(), '1', 'cash', '0'.repeat(64), u()])), '42501', 'record v2 refused to the runtime login');
  assert.equal(await codeOf(runtime.unsafe(`select * from ${PAY}.m7b_invoice_void_v2($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`,
    ['k', u(), u(), u(), '1', 'issued_in_error'])), '42501', 'void v2 refused to the runtime login');
  assert.equal(await codeOf(runtime.unsafe(`select * from ${PAY}.m7b_invoice_payments_get($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    ['k', u(), u(), u(), null, 51])), '42501', '036\'s payments read refused to the runtime login');
});

test('ICR-02 (CN-13, CN-07a): the happy path, exactly one audit row per success with its kind, permission, reason and subjects; none per refusal', async () => {
  const f = await scene('happy');
  const inv = await invoice(f);
  const base = await writes(f.T);
  const a = { store: f.S, invoice: inv, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), gross: 2000, reason: 'service_issue', cn: randomUUID() };
  const reg = await one(runtime, Q.register(f.k.boss, a));
  assert.deepEqual({ o: reg.o_outcome, t: reg.o_tenant_id, s: reg.o_store_id, actor: reg.o_actor_id, m: reg.o_membership_id, r: reg.o_registration_id, i: reg.o_invoice_id },
    { o: 'applied', t: f.T, s: f.S, actor: f.a.boss.id, m: f.a.boss.memberships[0], r: a.registration, i: inv }, 'registered');
  assert.deepEqual(await auditRow(reg.o_audit_event_id), { ...AUDIT_FIXED, action_id: 'store.invoice_credit_note.register', required_permission: 'issue_invoice_credit_notes',
    reason_code: 'invoice_credit_note_attempt_registered', actor: f.a.boss.id, store_id: f.S, cn: null, reg: a.registration }, 'the register audit row');

  const p = await one(prover, Q.proof(f.k.boss, a));
  assert.deepEqual({ o: p.o_outcome, r: p.o_registration_id, at: p.o_attempt_id }, { o: 'proof', r: a.registration, at: a.attempt }, 'the proof');
  const expected = cnProofFor(PK, GEN, { registration: a.registration, actor: f.a.boss.id, tenant: f.T, store: f.S, invoice: inv, attempt: a.attempt,
    sessionKey: f.k.boss, gross: 2000, reason: 'service_issue' });
  assert.ok(p.o_proof === expected, 'the proof equals an independent HMAC over doc 16\'s credit-note message (value withheld)');
  assert.ok((await one(prover, Q.proof(f.k.boss, a))).o_proof === expected, 'the same proof again');
  a.proof = p.o_proof;

  const iss = await one(runtime, Q.issue(f.k.boss, a));
  assert.deepEqual({ o: iss.o_outcome, c: iss.o_credit_note_id, i: iss.o_invoice_id, actor: iss.o_actor_id }, { o: 'applied', c: a.cn, i: inv, actor: f.a.boss.id }, 'issued');
  assert.deepEqual(await auditRow(iss.o_audit_event_id), { ...AUDIT_FIXED, action_id: 'store.invoice_credit_note.issue', required_permission: 'issue_invoice_credit_notes',
    reason_code: 'invoice_credit_note_issued_service_issue', actor: f.a.boss.id, store_id: f.S, cn: a.cn, reg: a.registration }, 'the issue audit row names both subjects');
  assert.deepEqual(await cnRow(a.cn), { n: 1, g: 2000, t: 163, net: 1837 }, 'number 1 and E1\'s split');

  const look = await run(runtime, Q.attempts(f.k.boss, { store: f.S, tenant: f.T }));
  assert.equal(look.length, 1, 'one attempt listed');
  assert.deepEqual({ o: look[0].o_outcome, i: look[0].o_invoice_id, at: look[0].o_attempt_id, st: look[0].o_state, v: look[0].o_version, g: look[0].o_gross_cents,
    r: look[0].o_reason_code, c: look[0].o_credit_note_id, issued: look[0].o_issued_at !== null, w: look[0].o_withdrawn_at },
  { o: 'attempt', i: inv, at: a.attempt, st: 'issued', v: '2', g: '2000', r: 'service_issue', c: a.cn, issued: true, w: null }, 'the lookup: issued, version 2');

  const set = await one(runtime, Q.settle(f.k.boss, { ...a, version: 2 }));
  assert.deepEqual({ o: set.o_outcome, v: set.o_version }, { o: 'applied', v: '3' }, 'confirmed');
  assert.deepEqual(await auditRow(set.o_audit_event_id), { ...AUDIT_FIXED, action_id: 'store.invoice_credit_note.settle', required_permission: 'recover_invoice_credit_notes',
    reason_code: 'invoice_credit_note_attempt_confirmed', actor: f.a.boss.id, store_id: f.S, cn: null, reg: a.registration }, 'the settle audit row');
  const again = await one(runtime, Q.settle(f.k.boss, { ...a, version: 2 }));
  assert.deepEqual({ o: again.o_outcome, v: again.o_version, e: again.o_audit_event_id }, { o: 'unchanged', v: '3', e: null }, 'the same settlement: unchanged, no audit');
  assert.equal(await word(runtime, Q.settle(f.k.boss, { ...a, version: 1 })), 'conflict', 'the other settlement: conflict');
  assert.equal((await run(runtime, Q.attempts(f.k.boss, { store: f.S, tenant: f.T })))[0].o_state, 'confirmed', 'the lookup: confirmed');

  const list = await run(runtime, Q.list(f.k.boss, { tenant: f.T, store: f.S, invoice: inv }));
  assert.deepEqual(list.map((r) => [r.o_outcome, r.o_credit_note_id, r.o_credit_note_number, r.o_gross_cents, r.o_tax_cents, r.o_net_cents, r.o_reason_code, r.o_withdrawn_at]),
    [['credit_notes', a.cn, '1', '2000', '163', '1837', 'service_issue', null]], 'the list');

  const wd = await one(runtime, Q.withdraw(f.k.boss, { ...a, wreason: 'wrong_invoice' }));
  assert.deepEqual({ o: wd.o_outcome, c: wd.o_credit_note_id }, { o: 'applied', c: a.cn }, 'withdrawn');
  assert.deepEqual(await auditRow(wd.o_audit_event_id), { ...AUDIT_FIXED, action_id: 'store.invoice_credit_note.withdraw', required_permission: 'withdraw_invoice_credit_notes',
    reason_code: 'invoice_credit_note_withdrawn_wrong_invoice', actor: f.a.boss.id, store_id: f.S, cn: a.cn, reg: null }, 'the withdraw audit row');
  const after = await writes(f.T);
  assert.equal(after.audits - base.audits, 4, 'register, issue, settle, withdraw: four audit rows in all');
  assert.ok((await run(runtime, Q.attempts(f.k.boss, { store: f.S, tenant: f.T })))[0].o_withdrawn_at !== null, 'the lookup shows the withdrawal');

  // Refusals of every routine: no audit row, nothing written.
  const refusals = [
    [Q.register(f.k.manager, { ...a, registration: randomUUID(), attempt: randomUUID() }), 'refused'],
    [Q.register(f.k.boss, { ...a, tenant: f.S2, registration: randomUUID(), attempt: randomUUID() }), 'tenant_mismatch'],
    [Q.register(f.k.boss, { ...a, invoice: randomUUID(), registration: randomUUID(), attempt: randomUUID() }), 'not_found'],
    [Q.issue(f.k.boss, { ...a, cn: randomUUID() }), 'already_issued'],
    [Q.issue(f.k.boss, { ...a, cn: randomUUID(), proof: 'f'.repeat(64) }), 'not_found'],
    [Q.settle(f.k.boss, { ...a, version: 1 }), 'conflict'],
    [Q.settle(f.k.boss, { ...a, attempt: randomUUID(), version: 1 }), 'not_found'],
    [Q.withdraw(f.k.boss, a), 'invalid_state'],
    [Q.withdraw(f.k.boss, { ...a, version: 2 }), 'invalid_state'], // already withdrawn precedes the version check
    [Q.withdraw(f.k.boss, { ...a, cn: randomUUID() }), 'not_found'],
  ];
  for (const [q, w] of refusals) assert.equal(await word(runtime, q), w, `refusal ${w}`);
  assert.deepEqual(await writes(f.T), after, 'refusals wrote nothing: no audit row, registration, credit note, withdrawal or number');
});

test('ICR-03 (CN-18 E1-E5, CN-15, CN-24): §5 E1-E5 through the routines, exact cents and words', async () => {
  const f = await scene('e1to5');
  // E1 unpaid credit
  let x = await invoice(f);
  let c = await credit(f, x, 2000);
  assert.equal(c.outcome, 'applied', 'E1 issued');
  assert.deepEqual(await split(c.cn), { t: 163, net: 1837 }, 'E1 split');
  assert.deepEqual(pick(await amounts(f, x)), am(2000, 0, 8888, 'no_payment_recorded'), 'E1 amounts');
  // E2 partly paid, then credit
  x = await invoice(f);
  assert.equal((await pay(f, x, 5000)).outcome, 'applied', 'E2 pay 5,000');
  c = await credit(f, x, 3000);
  assert.equal(c.outcome, 'applied', 'E2 issued');
  assert.deepEqual(await split(c.cn), { t: 245, net: 2755 }, 'E2 split');
  assert.deepEqual(pick(await amounts(f, x)), am(3000, 5000, 2888, 'recorded_partly'), 'E2 amounts');
  // E3 credit, then a payment at the cap (record v3 counts credits: CN-24)
  x = await invoice(f);
  assert.equal((await credit(f, x, 2000)).outcome, 'applied', 'E3 credit 2,000');
  assert.equal((await pay(f, x, 9000)).outcome, 'amount_exceeds_remaining', 'E3 pay 9,000 refused by the credit-aware cap');
  assert.equal((await pay(f, x, 8888)).outcome, 'applied', 'E3 pay 8,888 recorded');
  assert.deepEqual(pick(await amounts(f, x)), am(2000, 8888, 0, 'settled_by_payment_and_credit'), 'E3 amounts');
  // E4 fully paid (CN-15)
  x = await invoice(f);
  assert.equal((await pay(f, x, X_TOTAL)).outcome, 'applied', 'E4 pay 10,888');
  const before4 = await writes(f.T);
  c = await credit(f, x, 1);
  assert.equal(c.outcome, 'amount_exceeds_remaining', 'E4 credit 1 refused');
  assert.equal(await cnRow(c.cn), null, 'E4 no credit note');
  assert.equal((await writes(f.T)).numbers, before4.numbers, 'E4 no number used');
  assert.deepEqual(pick(await amounts(f, x)), am(0, X_TOTAL, 0, 'recorded_in_full'), 'E4 amounts');
  // E5 two credits to the full Total
  x = await invoice(f);
  const c1 = await credit(f, x, 4000);
  const c2 = await credit(f, x, 6888);
  assert.deepEqual([c1.outcome, c2.outcome], ['applied', 'applied'], 'E5 both issued');
  assert.deepEqual([await split(c1.cn), await split(c2.cn)], [{ t: 326, net: 3674 }, { t: 562, net: 6326 }], 'E5 taxes 326 + 562 = 888, nets 3,674 + 6,326');
  assert.deepEqual(pick(await amounts(f, x)), am(X_TOTAL, 0, 0, 'credited_in_full'), 'E5 amounts');
});

test('ICR-04 (CN-18 E6-E10, CN-23, CN-16, CN-25): §5 E6-E10 through the routines', async () => {
  const f = await scene('e6to10', { rates: [8875, null] });
  // E6 withdraw, then re-issue (CN-23: a second withdrawal is invalid_state)
  let x = await invoice(f);
  const c6 = await credit(f, x, 2000);
  assert.deepEqual(await split(c6.cn), { t: 163, net: 1837 }, 'E6 first credit');
  assert.equal(await withdraw(f, c6, 'wrong_amount'), 'applied', 'E6 withdrawn');
  assert.deepEqual(pick(await amounts(f, x)), am(0, 0, X_TOTAL, 'no_payment_recorded'), 'E6 after the withdrawal remaining is 10,888');
  const c6b = await credit(f, x, 1500);
  assert.deepEqual(await split(c6b.cn), { t: 122, net: 1378 }, 'E6 new credit');
  assert.deepEqual(pick(await amounts(f, x)), am(1500, 0, 9388, 'no_payment_recorded'), 'E6 amounts');
  const pre = await writes(f.T);
  assert.equal(await withdraw(f, c6, 'wrong_amount'), 'invalid_state', 'CN-23 a second withdrawal');
  assert.deepEqual(await writes(f.T), pre, 'CN-23 nothing written');
  // E7 credit above remaining
  x = await invoice(f);
  assert.equal((await pay(f, x, 5000)).outcome, 'applied', 'E7 pay 5,000');
  const pre7 = await writes(f.T);
  const c7 = await prepareCredit(f, x, 6000);
  const out7 = await word(runtime, Q.issue(f.k.boss, c7));
  assert.equal(out7, 'amount_exceeds_remaining', 'E7 credit 6,000 refused');
  const [{ issueAudits }] = await owner`select count(*)::int as "issueAudits" from public.audit_event where subject_invoice_credit_note_registration_id = ${c7.registration}
    and action_id = 'store.invoice_credit_note.issue'`;
  const post7 = await writes(f.T);
  assert.deepEqual({ notes: post7.notes, numbers: post7.numbers, issueAudits, audits: post7.audits - pre7.audits },
    { notes: pre7.notes, numbers: pre7.numbers, issueAudits: 0, audits: 1 }, 'E7 no credit note, number or issue audit row (only the register row)');
  await settleCredit(c7, out7);
  assert.deepEqual(pick(await amounts(f, x)), am(0, 5000, 5888, 'recorded_partly'), 'E7 amounts');
  // E8 voided invoice (CN-16)
  x = await invoice(f);
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: x, tenant: f.T })), 'applied', 'E8 void');
  assert.equal(await word(runtime, Q.register(f.k.boss, { store: f.S, invoice: x, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), gross: 500, reason: 'goodwill' })),
    'invalid_state', 'E8 credit 500 on a voided invoice');
  const a8 = await amounts(f, x);
  assert.deepEqual({ ...pick(a8), due: a8.due }, { ...am(0, 0, 0, 'voided'), due: 0 }, 'E8 amounts 0/0/0');
  // E9 void with an active credit (CN-25 through void v3)
  x = await invoice(f);
  const c9 = await credit(f, x, 2000);
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: x, tenant: f.T })), 'credit_notes_recorded', 'E9 first void');
  const w9 = await writes(f.T);
  assert.equal(await word(runtime, Q.withdraw(f.k.boss, { ...c9, version: 2 })), 'conflict', 'a withdrawal at a version other than 1: conflict');
  assert.deepEqual(await writes(f.T), w9, 'nothing written');
  assert.equal(await withdraw(f, c9, 'entered_in_error'), 'applied', 'E9 withdrawn');
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: x, tenant: f.T })), 'applied', 'E9 then voided');
  assert.deepEqual(pick(await amounts(f, x)), am(0, 0, 0, 'voided'), 'E9 amounts');
  // CN-25: with a payment and a credit both active, payments_recorded answers first.
  x = await invoice(f);
  await pay(f, x, 1000);
  await credit(f, x, 1000);
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: x, tenant: f.T })), 'payments_recorded', 'payments_recorded precedes credit_notes_recorded');
  // E10 tax mode none
  const none = f.stores[1];
  x = await invoice(f, { store: none });
  const c10 = await credit(f, x, 2500, { store: none });
  assert.equal(c10.outcome, 'applied', 'E10 issued');
  assert.deepEqual(await split(c10.cn), { t: 0, net: 2500 }, 'E10 tax 0');
  assert.deepEqual(pick(await amounts(f, x, { store: none })), am(2500, 0, 7500, 'no_payment_recorded'), 'E10 amounts');
});

test('ICR-05 (CN-18 E11, E12, E14, E16, E17): the 1-cent credit, three credits to the Total, a reversal after a credit, both clamps', async () => {
  const f = await scene('e11to17', { rates: [8875, 100000, 25000, 50000] });
  const [, s100, s25, s50] = f.stores;
  // E11
  let x = await invoice(f);
  const sevenths = [];
  for (let i = 0; i < 7; i += 1) sevenths.push(await split((await credit(f, x, 1)).cn));
  assert.deepEqual(sevenths, [...Array(6).fill({ t: 0, net: 1 }), { t: 1, net: 0 }], 'E11 the first six tax 0, the seventh tax 1 net 0');
  assert.deepEqual(pick(await amounts(f, x)), am(7, 0, 10881, 'no_payment_recorded'), 'E11 X amounts');
  const y = await invoice(f, { store: s100, lines: lineOf(1) });
  assert.deepEqual(await split((await credit(f, y, 1, { store: s100 })).cn), { t: 1, net: 0 }, 'E11 subtotal 1 at 100 %: tax 1, net 0');
  // E12
  x = await invoice(f);
  const twelve = [];
  for (const g of [3629, 3629, 3630]) twelve.push(await split((await credit(f, x, g)).cn));
  assert.deepEqual(twelve, [{ t: 296, net: 3333 }, { t: 296, net: 3333 }, { t: 296, net: 3334 }], 'E12 taxes 296 x 3 = 888');
  assert.deepEqual(pick(await amounts(f, x)), am(X_TOTAL, 0, 0, 'credited_in_full'), 'E12 amounts');
  // E14
  x = await invoice(f);
  const p14 = await pay(f, x, 8000);
  assert.equal((await credit(f, x, 2888)).outcome, 'applied', 'E14 credit 2,888');
  assert.deepEqual(pick(await amounts(f, x)), am(2888, 8000, 0, 'settled_by_payment_and_credit'), 'E14 before the reversal');
  assert.equal(await word(runtime, Q.reverse(f.k.boss2, p14)), 'applied', 'E14 reversed');
  assert.deepEqual(pick(await amounts(f, x)), am(2888, 0, 8000, 'no_payment_recorded'), 'E14 after the reversal');
  // E16 the lower clamp: subtotal 4 at 25 % -> tax 1, Total 5
  x = await invoice(f, { store: s25, lines: lineOf(4) });
  const e16 = [];
  const first = await credit(f, x, 2, { store: s25 });
  e16.push(await split(first.cn));
  e16.push(await split((await credit(f, x, 1, { store: s25 })).cn));
  assert.equal(await withdraw(f, first), 'applied', 'E16 withdraw the first');
  e16.push(await split((await credit(f, x, 1, { store: s25 })).cn));
  e16.push(await split((await credit(f, x, 1, { store: s25 })).cn));
  assert.deepEqual(e16, [{ t: 0, net: 2 }, { t: 1, net: 0 }, { t: 0, net: 1 }, { t: 0, net: 1 }], 'E16 the clamp sets tax 0 (unclamped -1), then the share returns');
  assert.deepEqual(pick(await amounts(f, x, { store: s25 })), am(3, 0, 2, 'no_payment_recorded'), 'E16 amounts');
  // E17 the upper clamp: subtotal 5 at 50 % -> tax 3, Total 8
  x = await invoice(f, { store: s50, lines: lineOf(5) });
  const e17 = [];
  e17.push(await split((await credit(f, x, 1, { store: s50 })).cn));
  const three = await credit(f, x, 3, { store: s50 });
  e17.push(await split(three.cn));
  e17.push(await split((await credit(f, x, 2, { store: s50 })).cn));
  assert.equal(await withdraw(f, three), 'applied', 'E17 withdraw the 3');
  e17.push(await split((await credit(f, x, 1, { store: s50 })).cn));
  assert.deepEqual(e17, [{ t: 0, net: 1 }, { t: 2, net: 1 }, { t: 0, net: 2 }, { t: 1, net: 0 }], 'E17 the clamp sets tax 1 (unclamped 2), net 0');
  assert.deepEqual(pick(await amounts(f, x, { store: s50 })), am(4, 0, 4, 'no_payment_recorded'), 'E17 amounts');
});

test('ICR-06 (CN-01, CN-18 E13): a credit of 6,000 and a payment of 6,000 at once, both orders: exactly one commits', async () => {
  const f = await scene('race-pay');
  for (const order of ['credit first', 'payment first']) {
    const x = await invoice(f);
    const c = await prepareCredit(f, x, 6000);
    const p = await preparePay(f, x, 6000);
    const qc = Q.issue(f.k.boss, c);
    const qp = Q.record(f.k.boss2, p);
    const [w1, w2] = await race(order === 'credit first' ? qc : qp, order === 'credit first' ? qp : qc, order);
    const [cw, pw] = order === 'credit first' ? [w1, w2] : [w2, w1];
    assert.deepEqual({ cw, pw }, order === 'credit first' ? { cw: 'applied', pw: 'amount_exceeds_remaining' } : { cw: 'amount_exceeds_remaining', pw: 'applied' },
      `${order}: the second is sealed amount_exceeds_remaining`);
    if (cw === 'applied') assert.deepEqual(await split(c.cn), { t: 489, net: 5511 }, `${order}: E13's split`);
    await settleCredit(c, cw);
    await settlePay(p, pw);
    const s = await amounts(f, x);
    assert.equal(s.remaining, 4888, `${order}: 4,888 remaining either way`);
    assert.ok(s.credited + s.paid <= X_TOTAL, `${order}: I-CN credited + paid <= total`);
  }
});

test('ICR-07 (CN-02): a credit and a void at once, both orders', async () => {
  const f = await scene('race-void');
  let x = await invoice(f);
  let c = await prepareCredit(f, x, 2000);
  const [ci, vo] = await race(Q.issue(f.k.boss, c), Q.void3(f.k.boss2, { store: f.S, invoice: x, tenant: f.T }), 'credit first');
  assert.deepEqual({ ci, vo }, { ci: 'applied', vo: 'credit_notes_recorded' }, 'credit first: the void answers credit_notes_recorded');
  await settleCredit(c, ci);
  assert.deepEqual(pick(await amounts(f, x)), am(2000, 0, 8888, 'no_payment_recorded'), 'credit first: not voided');
  x = await invoice(f);
  c = await prepareCredit(f, x, 2000);
  const [vo2, ci2] = await race(Q.void3(f.k.boss2, { store: f.S, invoice: x, tenant: f.T }), Q.issue(f.k.boss, c), 'void first');
  assert.deepEqual({ vo2, ci2 }, { vo2: 'applied', ci2: 'invalid_state' }, 'void first: the credit answers invalid_state');
  assert.equal(await cnRow(c.cn), null, 'void first: no credit note');
  await settleCredit(c, ci2);
  assert.deepEqual(pick(await amounts(f, x)), am(0, 0, 0, 'voided'), 'void first: voided');
});

test('ICR-08 (CN-03): a credit and a payment reversal at once, both orders: I-CN holds and both answers are sealed', async () => {
  const f = await scene('race-reverse');
  // Before the reversal remaining is 2,888, so a credit of 3,000 fits only after it.
  let x = await invoice(f);
  let p = await pay(f, x, 8000);
  let c = await prepareCredit(f, x, 3000);
  const [ci, rv] = await race(Q.issue(f.k.boss, c), Q.reverse(f.k.boss2, p), 'credit first');
  assert.deepEqual({ ci, rv }, { ci: 'amount_exceeds_remaining', rv: 'applied' }, 'credit first: the credit is refused on the payment, the reversal applies');
  await settleCredit(c, ci);
  let s = await amounts(f, x);
  assert.deepEqual(pick(s), am(0, 0, X_TOTAL, 'no_payment_recorded'), 'credit first: amounts');
  x = await invoice(f);
  p = await pay(f, x, 8000);
  c = await prepareCredit(f, x, 3000);
  const [rv2, ci2] = await race(Q.reverse(f.k.boss2, p), Q.issue(f.k.boss, c), 'reversal first');
  assert.deepEqual({ rv2, ci2 }, { rv2: 'applied', ci2: 'applied' }, 'reversal first: the credit re-reads after its lock and applies');
  assert.deepEqual(await split(c.cn), { t: 245, net: 2755 }, 'reversal first: the split');
  await settleCredit(c, ci2);
  s = await amounts(f, x);
  assert.deepEqual(pick(s), am(3000, 0, 7888, 'no_payment_recorded'), 'reversal first: amounts');
  assert.ok(s.credited + s.paid <= X_TOTAL, 'I-CN');
});

test('ICR-09 (CN-32): the amounts read returns one snapshot while a withdrawal and a payment commit underneath it', async () => {
  const f = await scene('snapshot');
  const x = await invoice(f);
  const c = await credit(f, x, 2000);
  const p = await preparePay(f, x, 3000);
  // The read's snapshot is taken when its statement starts; it then waits on 035's issued lines (which neither writer touches).
  const lock = holding(owner, (tx) => tx.unsafe('lock table tmpos_invoice_issue.issued_invoice_line in access exclusive mode'));
  try {
    await until(() => lock.ready, 'the line table is held');
    const read = running(runtime, tx1(Q.amounts(f.k.manager, { tenant: f.T, store: f.S, invoice: x })));
    await until(async () => read.out !== undefined || (read.pid !== null && await blockedBy(read.pid, lock.pid)), 'the read waits inside its statement');
    assert.equal(read.out, undefined, 'the read is waiting');
    assert.equal(await withdraw(f, c), 'applied', 'a withdrawal commits under the read');
    const rec = await word(runtime, Q.record(p.key, p));
    assert.equal(rec, 'applied', 'a payment commits under the read');
    assert.ok(await blockedBy(read.pid, lock.pid), 'the read is still waiting after both committed');
    lock.release('rollback');
    const out = await read.done;
    assert.equal(out.outcome, 'committed', 'the read answered');
    const r = out.value[0];
    assert.deepEqual({ credited: Number(r.o_credited_cents), paid: Number(r.o_applied_cents), remaining: Number(r.o_remaining_cents), word: r.o_payment_status,
      rows: out.value.length, payment: r.o_payment_id }, { ...am(2000, 0, 8888, 'no_payment_recorded'), rows: 1, payment: null },
    'one snapshot: the amounts, word and page from before both writes, never a mixture');
    await settlePay(p, rec);
  } finally {
    lock.release('rollback');
  }
  assert.deepEqual(pick(await amounts(f, x)), am(0, 3000, 7888, 'recorded_partly'), 'a fresh read sees both');
});

test('ICR-10 (CN-04): duplicate attempts — same session, renewed session, a second owner, another invoice', async () => {
  const f = await scene('dup');
  const x = await invoice(f);
  // Same session: the issued registration presented again (a new idempotency key = a new call) -> already_issued, before the bound.
  const a = await credit(f, x, X_TOTAL, { settle: false });
  assert.equal(a.outcome, 'applied', 'credited in full');
  const w0 = await writes(f.T);
  assert.equal(await word(runtime, Q.issue(f.k.boss, { ...a, cn: randomUUID() })), 'already_issued', 'same session, remaining 0: already_issued before the bound');
  // Renewed session: the same presentation -> not_found (the session digest).
  const renewed = await mint(f.a.boss);
  assert.equal(await word(runtime, Q.issue(renewed, { ...a, cn: randomUUID() })), 'not_found', 'renewed session: not_found');
  // Withdraw it and void the invoice: still already_issued, before voided.
  assert.equal(await withdraw(f, a), 'applied', 'withdrawn');
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: x, tenant: f.T })), 'applied', 'voided');
  const w1 = await writes(f.T);
  assert.equal(await word(runtime, Q.issue(f.k.boss, { ...a, cn: randomUUID() })), 'already_issued', 'same session on a voided invoice: already_issued before voided');
  assert.deepEqual({ ...(await writes(f.T)), audits: 0 }, { ...w1, audits: 0 }, 'nothing written');
  assert.equal(w1.audits - w0.audits, 1, 'only the withdrawal\'s audit row since the credit');
  await settleCredit(a, 'applied');

  // A second store-scope owner registering the same attempt id on another invoice Z.
  const z = await invoice(f);
  const first = await credit(f, z, 1000);
  assert.equal(first.outcome, 'applied', 'the first owner credits Z');
  const dupe = { store: f.S, invoice: z, tenant: f.T, registration: randomUUID(), attempt: first.attempt, gross: 1000, reason: 'pricing_error',
    cn: randomUUID(), key: f.k.boss2 };
  assert.equal(await word(runtime, Q.register(f.k.boss2, dupe)), 'applied', 'the second owner registers the same attempt id (own rows only)');
  dupe.proof = (await one(prover, Q.proof(f.k.boss2, dupe))).o_proof;
  const wz = await writes(f.T);
  assert.equal(await word(runtime, Q.issue(f.k.boss2, dupe)), 'already_issued', 'the second owner\'s issue: already_issued');
  assert.equal(await withdraw(f, first), 'applied', 'the first credit withdrawn');
  assert.equal(await word(runtime, Q.issue(f.k.boss2, { ...dupe, cn: randomUUID() })), 'already_issued', 'still already_issued after a withdrawal');
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: z, tenant: f.T })), 'applied', 'Z voided');
  assert.equal(await word(runtime, Q.issue(f.k.boss2, { ...dupe, cn: randomUUID() })), 'already_issued', 'the taken attempt id precedes voided');
  const wz2 = await writes(f.T);
  assert.deepEqual({ notes: wz2.notes, numbers: wz2.numbers }, { notes: wz.notes, numbers: wz.numbers }, 'no second credit note or number for the attempt');
  await settleCredit(dupe, 'refused');
  // Another invoice's attempt is independent.
  const y = await invoice(f);
  const indep = { store: f.S, invoice: y, tenant: f.T, registration: randomUUID(), attempt: first.attempt, gross: 500, reason: 'goodwill', cn: randomUUID(), key: f.k.boss };
  assert.equal(await word(runtime, Q.register(f.k.boss, indep)), 'applied', 'the same attempt id registers on another invoice');
  indep.proof = (await one(prover, Q.proof(f.k.boss, indep))).o_proof;
  assert.equal(await word(runtime, Q.issue(f.k.boss, indep)), 'applied', 'and issues there');
  await settleCredit(indep, 'applied');
});

test('ICR-11 (CN-06): changed gross or reason -> conflict on an open registration, already_issued on an issued one; nothing written', async () => {
  const f = await scene('bound');
  const x = await invoice(f);
  const a = await prepareCredit(f, x, 2000, { reason: 'pricing_error' });
  const w0 = await writes(f.T);
  assert.equal(await word(runtime, Q.issue(f.k.boss, { ...a, gross: 2001 })), 'conflict', 'another gross: conflict');
  assert.equal(await word(runtime, Q.issue(f.k.boss, { ...a, reason: 'goodwill' })), 'conflict', 'another reason: conflict');
  assert.deepEqual(await writes(f.T), w0, 'nothing written');
  assert.equal(await word(runtime, Q.issue(f.k.boss, a)), 'applied', 'the bound values issue');
  assert.equal(await word(runtime, Q.issue(f.k.boss, { ...a, gross: 2001, cn: randomUUID() })), 'already_issued', 'another gross on the issued registration: already_issued');
  assert.equal((await cnRow(a.cn)).g, 2000, 'the first amount stands');
  await settleCredit(a, 'applied');
});

test('ICR-12 (CN-07a): release then a late issue, confirm then a late issue, a refused issue keeps its registration open', async () => {
  const f = await scene('late');
  const x = await invoice(f);
  // Release, then the late issue -> invalid_state.
  const r = await prepareCredit(f, x, 1000);
  const rel = await one(runtime, Q.settle(f.k.boss, { ...r, version: 1 }));
  assert.equal(rel.o_outcome, 'applied', 'released');
  assert.equal((await auditRow(rel.o_audit_event_id)).reason_code, 'invoice_credit_note_attempt_released', 'the release audit reason');
  assert.equal(await word(runtime, Q.issue(f.k.boss, r)), 'invalid_state', 'a late issue after release: invalid_state');
  assert.equal(await cnRow(r.cn), null, 'no credit note');
  // Confirm, then a late issue -> already_issued.
  const c = await prepareCredit(f, x, 1000);
  assert.equal(await word(runtime, Q.issue(f.k.boss, c)), 'applied', 'issued');
  assert.equal(await word(runtime, Q.settle(f.k.boss, { ...c, version: 2 })), 'applied', 'confirmed');
  assert.equal(await word(runtime, Q.issue(f.k.boss, { ...c, cn: randomUUID() })), 'already_issued', 'a late issue after confirmation: already_issued');
  // A refused issue leaves the registration open and blocks a second registration until released.
  const big = await prepareCredit(f, x, 20_000);
  assert.equal(await word(runtime, Q.issue(f.k.boss, big)), 'amount_exceeds_remaining', 'refused by the bound');
  const rows = await run(runtime, Q.attempts(f.k.boss, { store: f.S, tenant: f.T }));
  const mine = rows.find((row) => row.o_attempt_id === big.attempt);
  assert.deepEqual({ st: mine?.o_state, v: mine?.o_version }, { st: 'open', v: '1' }, 'the refused attempt is still open');
  const next = { store: f.S, invoice: x, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), gross: 100, reason: 'goodwill' };
  assert.equal(await word(runtime, Q.register(f.k.boss, next)), 'conflict', 'a second registration: conflict');
  await settleCredit(big, 'refused');
  assert.equal(await word(runtime, Q.register(f.k.boss, next)), 'applied', 'after the release it registers');
  assert.equal(await word(runtime, Q.settle(f.k.boss, { ...next, version: 1 })), 'applied', 'released again');
});

test('ICR-13 (CN-07a): a payment proof is never accepted for a credit note, nor a credit-note proof by record v3', async () => {
  const f = await scene('labels');
  const x = await invoice(f);
  const c = await prepareCredit(f, x, 1000);
  const p = await preparePay(f, x, 500, { key: f.k.boss });
  const cnFields = { registration: c.registration, actor: f.a.boss.id, tenant: f.T, store: f.S, invoice: x, attempt: c.attempt, sessionKey: f.k.boss };
  const payFields = { registration: p.registration, actor: f.a.boss.id, tenant: f.T, store: f.S, invoice: x, attempt: p.attempt, sessionKey: f.k.boss };
  assert.ok(c.proof === cnProofFor(PK, GEN, { ...cnFields, gross: 1000, reason: 'pricing_error' }), 'the credit-note proof is the credit-note message\'s HMAC');
  assert.ok(p.proof === payProofFor(PK, GEN, payFields), 'the payment proof is 037\'s message\'s HMAC');
  const w0 = await writes(f.T);
  assert.equal(await word(runtime, Q.issue(f.k.boss, { ...c, proof: payProofFor(PK, GEN, cnFields) })), 'not_found', 'a payment-label proof over the credit-note registration: not_found');
  assert.equal(await word(runtime, Q.issue(f.k.boss, { ...c, proof: p.proof })), 'not_found', 'the payment registration\'s proof: not_found');
  assert.equal(await word(runtime, Q.record(f.k.boss, { ...p, proof: cnProofFor(PK, GEN, { ...payFields, gross: 500, reason: 'pricing_error' }) })), 'not_found',
    'a credit-note-label proof over the payment registration: not_found at record v3');
  assert.equal(await word(runtime, Q.record(f.k.boss, { ...p, proof: c.proof })), 'not_found', 'the credit-note registration\'s proof at record v3: not_found');
  assert.deepEqual(await writes(f.T), w0, 'nothing written');
  assert.equal(await word(runtime, Q.issue(f.k.boss, c)), 'applied', 'the right proof issues');
  assert.equal(await word(runtime, Q.record(f.k.boss, p)), 'applied', 'the right proof records');
  await settleCredit(c, 'applied');
  await settlePay(p, 'applied');
  // Not the registering transaction: inside it, the proof and an issue carrying a valid independent proof are both not_found.
  const same = { store: f.S, invoice: x, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), gross: 700, reason: 'goodwill', cn: randomUUID() };
  const w1 = await writes(f.T);
  let words = null;
  const end = await runtime.begin(RC, async (tx) => {
    const r = await one(tx, Q.register(f.k.boss, same));
    const pr = await one(tx, Q.proof(f.k.boss, same));
    const proof = cnProofFor(PK, GEN, { registration: same.registration, actor: f.a.boss.id, tenant: f.T, store: f.S, invoice: x, attempt: same.attempt,
      sessionKey: f.k.boss, gross: 700, reason: 'goodwill' });
    const is = await one(tx, Q.issue(f.k.boss, { ...same, proof }));
    words = [r.o_outcome, pr.o_outcome, is.o_outcome];
    throw ROLLBACK;
  }).then(() => null, (e) => e);
  assert.equal(end === ROLLBACK ? 'rolled back' : safeCode(end), 'rolled back', 'the probe transaction rolled back');
  assert.deepEqual(words, ['applied', 'not_found', 'not_found'], 'same transaction: proof and issue not_found');
  assert.deepEqual(await writes(f.T), w1, 'nothing left');
});

test('ICR-14 (CN-07a, CN-10, CN-10b): owner-only — a second owner, manager, technician, sales staff, tenant-scope and demoted owners', async () => {
  const f = await scene('authz', { extraOwners: 1 });
  const x = await invoice(f);
  const done = await credit(f, x, 1000);
  const open = await prepareCredit(f, x, 500);
  const w0 = await writes(f.T);
  // Two owners of one store cannot see or settle each other's registrations.
  assert.deepEqual(await run(runtime, Q.attempts(f.k.boss2, { store: f.S, tenant: f.T })), [], 'the second owner\'s lookup lists none of the first\'s');
  assert.equal(await word(runtime, Q.settle(f.k.boss2, { ...open, version: 1 })), 'not_found', 'the second owner cannot settle it');
  assert.equal(await word(prover, Q.proof(f.k.boss2, open)), 'not_found', 'nor take its proof');
  // Every other role, and the tenant-scope owner, at every routine.
  for (const who of ['manager', 'tech', 'sales', 'own']) {
    const k = f.k[who];
    const fresh = { ...open, registration: randomUUID(), attempt: randomUUID() };
    assert.equal(await word(runtime, Q.register(k, fresh)), 'refused', `${who}: register refused`);
    assert.equal(await word(runtime, Q.issue(k, { ...open, cn: randomUUID() })), 'refused', `${who}: issue refused`);
    assert.equal(await word(prover, Q.proof(k, open)), 'denied', `${who}: proof denied`);
    assert.equal(await word(runtime, Q.attempts(k, { store: f.S, tenant: f.T })), 'denied', `${who}: lookup denied`);
    assert.equal(await word(runtime, Q.settle(k, { ...open, version: 1 })), 'refused', `${who}: settle refused`);
    assert.equal(await word(runtime, Q.withdraw(k, done)), 'refused', `${who}: withdraw refused`);
  }
  assert.deepEqual(await writes(f.T), w0, 'nothing written by any refusal');
  // The manager records payments (Invoices Full) but credits nothing.
  assert.equal((await pay(f, x, 100, { key: f.k.manager })).outcome, 'applied', 'the manager records a payment');
  // Reads follow view_issued_invoices: manager, technician, sales staff read the list; the tenant-scope owner has no store route.
  for (const who of ['manager', 'tech', 'sales']) assert.equal(await word(runtime, Q.list(f.k[who], { tenant: f.T, store: f.S, invoice: x })), 'credit_notes', `${who}: list read`);
  assert.equal(await word(runtime, Q.list(f.k.own, { tenant: f.T, store: f.S, invoice: x })), 'denied', 'tenant-scope owner: list denied');
  // A demoted owner: a registration made while owner, then the membership becomes manager.
  const d = await prepareCredit(f, x, 300, { key: f.k.owner3 });
  await owner`update user_membership set role_id = 'manager' where membership_id = ${f.a.owner3.memberships[0]}`;
  const demoted = await mint(f.a.owner3);
  assert.equal(await word(prover, Q.proof(demoted, d)), 'denied', 'demoted: proof denied');
  assert.equal(await word(runtime, Q.attempts(demoted, { store: f.S, tenant: f.T })), 'denied', 'demoted: lookup denied');
  assert.equal(await word(runtime, Q.settle(demoted, { ...d, version: 1 })), 'refused', 'demoted: settle refused');
  assert.equal(await word(runtime, Q.issue(demoted, d)), 'refused', 'demoted: issue refused');
  assert.equal(await word(runtime, Q.issue(f.k.owner3, d)), 'refused', 'demoted: the old session refused too');
  assert.equal(await cnRow(d.cn), null, 'no credit note');
  await settleCredit(open, 'refused');
});

test('ICR-15 (CN-07a): a renewed session, a proof-key rotation and the lookup\'s 24-hour window', async () => {
  const f = await scene('recover');
  const x = await invoice(f);
  // Issued but unconfirmed, then a renewed session: not_found at issue; the lookup and settlement still resolve it.
  const a = await prepareCredit(f, x, 1000);
  assert.equal(await word(runtime, Q.issue(f.k.boss, a)), 'applied', 'issued');
  const renewed = await mint(f.a.boss);
  assert.equal(await word(runtime, Q.issue(renewed, { ...a, cn: randomUUID() })), 'not_found', 'renewed session: not_found, not its state word');
  const look = (await run(runtime, Q.attempts(renewed, { store: f.S, tenant: f.T }))).find((r) => r.o_attempt_id === a.attempt);
  assert.deepEqual({ st: look?.o_state, c: look?.o_credit_note_id }, { st: 'issued', c: a.cn }, 'the renewed lookup shows it issued');
  assert.equal(await word(runtime, Q.settle(renewed, { ...a, version: 2 })), 'applied', 'the renewed settlement confirms it');
  assert.equal(await word(runtime, Q.issue(renewed, { ...a, cn: randomUUID() })), 'not_found', 'a settled registration from the renewed session: not_found');
  // A proof-key rotation: an open registration answers not_found until released; settlement still releases it.
  const b = await prepareCredit(f, x, 500);
  await installProofKey();
  assert.equal(await word(prover, Q.proof(f.k.boss, b)), 'not_found', 'after rotation: proof not_found');
  assert.equal(await word(runtime, Q.issue(f.k.boss, b)), 'not_found', 'after rotation: issue not_found');
  const fresh = { store: f.S, invoice: x, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), gross: 400, reason: 'goodwill', cn: randomUUID(), key: f.k.boss };
  assert.equal(await word(runtime, Q.register(f.k.boss, fresh)), 'conflict', 'the stranded registration still holds the slot');
  assert.equal(await word(runtime, Q.settle(f.k.boss, { ...b, version: 1 })), 'applied', 'settlement releases it');
  assert.equal(await word(runtime, Q.register(f.k.boss, fresh)), 'applied', 'then a fresh registration');
  const fp = await one(prover, Q.proof(f.k.boss, fresh));
  assert.ok(fp.o_proof === cnProofFor(PK, GEN, { registration: fresh.registration, actor: f.a.boss.id, tenant: f.T, store: f.S, invoice: x, attempt: fresh.attempt,
    sessionKey: f.k.boss, gross: 400, reason: 'goodwill' }), 'under the new key and generation');
  fresh.proof = fp.o_proof;
  assert.equal(await word(runtime, Q.issue(f.k.boss, fresh)), 'applied', 'and it issues');
  // The 24-hour window: settled rows aged 23 h are listed, 25 h are not; an unsettled row is listed whatever its age.
  await owner.begin(RC, (tx) => withTriggersLifted(tx, [[`${CN}.invoice_credit_note_registration`, 'trg_invoice_credit_note_registration_guard']], async () => {
    await tx`update tmpos_invoice_credit_note.invoice_credit_note_registration set registered_at = now() - interval '26 hours', acknowledged_at = now() - interval '23 hours'
      where tenant_id = ${f.T} and attempt_id = ${a.attempt}`;
    await tx`update tmpos_invoice_credit_note.invoice_credit_note_registration set registered_at = now() - interval '26 hours', acknowledged_at = now() - interval '25 hours'
      where tenant_id = ${f.T} and attempt_id = ${b.attempt}`;
    await tx`update tmpos_invoice_credit_note.invoice_credit_note_registration set registered_at = now() - interval '48 hours'
      where tenant_id = ${f.T} and attempt_id = ${fresh.attempt}`;
  }));
  const listed = (await run(runtime, Q.attempts(f.k.boss, { store: f.S, tenant: f.T }))).map((r) => r.o_attempt_id);
  assert.deepEqual({ a23: listed.includes(a.attempt), b25: listed.includes(b.attempt), open48: listed.includes(fresh.attempt) },
    { a23: true, b25: false, open48: true }, 'the lookup: settled within 24 h, and every unsettled row');
  await settleCredit(fresh, 'applied');
});

test('ICR-16 (CN-08): any isolation but READ COMMITTED -> 55000 before anything is read, nothing written', async () => {
  const f = await scene('iso');
  const x = await invoice(f);
  const done = await credit(f, x, 1000);
  const open = await prepareCredit(f, x, 500);
  const p = await preparePay(f, x, 100);
  const w0 = await writes(f.T);
  const calls = {
    register: Q.register(f.k.boss, { ...open, registration: randomUUID(), attempt: randomUUID() }), issue: Q.issue(f.k.boss, open),
    proof: Q.proof(f.k.boss, open), settle: Q.settle(f.k.boss, { ...open, version: 1 }), withdraw: Q.withdraw(f.k.boss, done),
    record_v3: Q.record(p.key, p), void_v3: Q.void3(f.k.boss, { store: f.S, invoice: x, tenant: f.T }),
  };
  for (const level of ['repeatable read', 'serializable']) {
    for (const [name, q] of Object.entries(calls)) {
      assert.equal(await codeOf(runtime.begin(`isolation level ${level}`, (tx) => tx.unsafe(q[0], q[1]))), '55000', `${name} under ${level}: 55000`);
    }
  }
  assert.deepEqual(await writes(f.T), w0, 'nothing written');
  await settleCredit(open, 'refused');
  await settlePay(p, 'refused');
});

test('ICR-17 (CN-09): another store\'s or tenant\'s invoice answers as a missing one; nothing written', async () => {
  const f = await scene('cross');
  const g = await scene('cross-other');
  const x = await invoice(f);
  const y = await invoice(f);
  const c = await credit(f, x, 1000);
  const open = await prepareCredit(f, x, 500);
  const missing = randomUUID();
  const w0 = [await writes(f.T), await writes(g.T)];
  const base = { registration: randomUUID(), attempt: randomUUID(), gross: 100, reason: 'goodwill', proof: '0'.repeat(64), cn: randomUUID() };
  // [label, key, store, tenant, invoice]
  const cases = [
    ['missing invoice', f.k.boss, f.S, f.T, missing],
    ['another store\'s invoice', f.k.bossB, f.S2, f.T, x],
    ['another tenant\'s invoice', g.k.boss, g.S, g.T, x],
  ];
  for (const [label, k, store, tenant, invoice] of cases) {
    const a = { ...base, store, tenant, invoice };
    assert.equal(await word(runtime, Q.register(k, a)), 'not_found', `${label}: register`);
    assert.equal(await word(runtime, Q.issue(k, a)), 'not_found', `${label}: issue`);
    assert.equal(await word(runtime, Q.settle(k, { ...a, attempt: open.attempt, version: 1 })), 'not_found', `${label}: settle`);
    assert.equal(await word(runtime, Q.withdraw(k, { ...a, cn: c.cn })), 'not_found', `${label}: withdraw`);
    assert.equal(await word(prover, Q.proof(k, { ...a, registration: open.registration })), 'not_found', `${label}: proof`);
    assert.equal(await word(runtime, Q.list(k, a)), 'not_found', `${label}: list`);
    assert.equal(await word(runtime, Q.amounts(k, a)), 'not_found', `${label}: amounts`);
  }
  assert.equal(await word(runtime, Q.register(g.k.boss, { ...base, store: g.S, tenant: f.T, invoice: x })), 'tenant_mismatch', 'expectedTenant is a precondition');
  assert.equal(await word(runtime, Q.withdraw(f.k.boss, { ...c, invoice: y })), 'not_found', 'a credit note of another invoice: not_found');
  assert.deepEqual([await writes(f.T), await writes(g.T)], w0, 'nothing written in either tenant');
  await settleCredit(open, 'refused');
});

test('ICR-18 (CN-10): a tenant or store not active/trialing is refused; a trialing tenant credits', async () => {
  const t = await scene('trialing', { tenantStatus: 'trialing' });
  const tx = await invoice(t);
  const tc = await credit(t, tx, 1000);
  assert.equal(tc.outcome, 'applied', 'trialing: issued');
  assert.equal(await withdraw(t, tc), 'applied', 'trialing: withdrawn');
  const f = await scene('status');
  const x = await invoice(f);
  const ctl = await invoice(f); // the positive controls' invoice (the refusals' open registration holds the slot on x)
  const done = await credit(f, x, 1000);
  const open = await prepareCredit(f, x, 500);
  for (const [table, status] of [['tenant', 'read_only'], ['tenant', 'overdue'], ['store', 'read_only'], ['store', 'overdue'], ['store', 'suspended']]) {
    const tag = `${table} ${status}`;
    const w0 = await writes(f.T);
    if (table === 'tenant') await owner`update tenant set status = ${status} where tenant_id = ${f.T}`;
    else await owner`update store set status = ${status} where store_id = ${f.S}`;
    const k = await mint(f.a.boss); // minted under the limited standing, so only the status refuses
    assert.equal(await word(runtime, Q.register(k, { ...open, registration: randomUUID(), attempt: randomUUID() })), 'refused', `${tag}: register`);
    assert.equal(await word(runtime, Q.issue(k, open)), 'refused', `${tag}: issue`);
    assert.equal(await word(runtime, Q.withdraw(k, done)), 'refused', `${tag}: withdraw`);
    assert.equal(await word(runtime, Q.settle(k, { ...open, version: 1 })), 'refused', `${tag}: settle`);
    assert.equal(await word(prover, Q.proof(k, open)), 'denied', `${tag}: proof`);
    assert.deepEqual(await writes(f.T), w0, `${tag}: nothing written`);
    if (table === 'tenant') await owner`update tenant set status = 'active' where tenant_id = ${f.T}`;
    else await owner`update store set status = 'active' where store_id = ${f.S}`;
    // Positive control: the same owner, active again, makes the same calls (register, proof, issue, settle, withdraw).
    const k2 = await mint(f.a.boss);
    const pc = await credit(f, ctl, 10, { key: k2 });
    assert.equal(pc.outcome, 'applied', `${tag}: control — an active owner issues`);
    assert.equal(await withdraw(f, pc, 'entered_in_error', k2), 'applied', `${tag}: control — and withdraws`);
  }
  await settleCredit({ ...open, key: await mint(f.a.boss) }, 'refused'); // settlement is the actor's, not the session's
});

test('ICR-19 (CN-11): expiry and sign-in judged on one database-clock reading after the last wait', async () => {
  const f = await scene('clock', { extraOwners: 1 });
  const x = await invoice(f);
  const y = await invoice(f);
  const z = await invoice(f); // register waits on z's header, withdraw on x's: never queued behind each other
  await credit(f, y, 100); // the store's counter row exists
  const c = await credit(f, x, 200); // to be withdrawn
  // Every time below is the DATABASE clock. Each caller's sign-in is fresh by MARGIN when staged; all three calls are started
  // and seen waiting (header, header, counter) while it is still fresh, then it lapses during the waits.
  const MARGIN = 20_000;
  const dbNow = async () => Number((await owner`select (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint::text as n`)[0].n);
  const auth = (await dbNow()) - 600_000 + MARGIN;
  const kReg = await mint(f.a.boss, { authenticatedAt: auth });
  const kWd = await mint(f.a.boss2, { authenticatedAt: auth });
  const kIss = await mint(f.a.owner3, { authenticatedAt: auth });
  const a = await prepareCredit(f, y, 50, { key: kIss }); // register needs the fresh sign-in too
  const w0 = await writes(f.T);
  const header = holding(owner, (tx) => tx`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = any(${[x, z]}::uuid[]) for update`);
  const counter = holding(owner, (tx) => tx`select 1 from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = ${f.T} and store_id = ${f.S} for update`);
  try {
    await until(() => header.ready && counter.ready, 'the header and the counter row are held');
    // Three different actors, so no call waits on another's 016 hold.
    const reg = running(runtime, tx1(Q.register(kReg, { store: f.S, invoice: z, tenant: f.T, registration: randomUUID(), attempt: randomUUID(), gross: 50, reason: 'goodwill' })));
    const wd = running(runtime, tx1(Q.withdraw(kWd, c)));
    const iss = running(runtime, tx1(Q.issue(kIss, a)));
    for (const [r, h, what] of [[reg, header, 'register on the header'], [wd, header, 'withdraw on the header'], [iss, counter, 'issue on the counter']]) {
      await until(async () => r.out !== undefined || (r.pid !== null && await blockedBy(r.pid, h.pid)), `${what}: waiting`);
      assert.equal(r.out, undefined, `${what}: waiting, not answered`);
    }
    assert.ok((await rowWaitOn(iss.pid)).includes('tmpos_invoice_credit_note.invoice_credit_note_counter'), 'the issue\'s last wait is the counter row');
    assert.ok((await dbNow()) < auth + 600_000, 'all three were seen waiting while the sign-in was still fresh');
    await until(async () => (await dbNow()) > auth + 600_200, 'the sign-in lapses on the database clock', MARGIN + 20_000);
    header.release('commit');
    counter.release('commit');
    assert.deepEqual([finished(await reg.done, 'register'), finished(await wd.done, 'withdraw'), finished(await iss.done, 'issue')],
      ['refused', 'refused', 'refused'], 'each judged its sign-in after its last wait: refused');
  } finally {
    header.release('rollback');
    counter.release('rollback');
  }
  assert.deepEqual(await writes(f.T), w0, 'no registration, credit note, number, withdrawal or audit row');
  assert.equal(await word(runtime, Q.settle(kIss, { ...a, version: 1 })), 'applied', 'settlement needs no recent sign-in');
});

test('ICR-20 (CN-14): the issued header and lines, the invoice counter, payments and reversals are byte-identical around credits', async () => {
  const f = await scene('unchanged');
  const x = await invoice(f);
  const p = await pay(f, x, 1000);
  assert.equal(await word(runtime, Q.reverse(f.k.boss2, p)), 'applied', 'a reversal');
  await pay(f, x, 500);
  const snap = async () => (await owner`select
      (select row_to_json(i)::text from tmpos_invoice_issue.issued_invoice i where i.invoice_id = ${x}) as header,
      (select json_agg(l order by l.position)::text from tmpos_invoice_issue.issued_invoice_line l where l.invoice_id = ${x}) as lines,
      (select json_agg(c)::text from tmpos_invoice_issue.store_invoice_counter c where c.tenant_id = ${f.T} and c.store_id = ${f.S}) as counter,
      (select json_agg(p order by p.payment_id)::text from tmpos_invoice_payment.invoice_payment p where p.invoice_id = ${x}) as payments,
      (select json_agg(r order by r.payment_id)::text from tmpos_invoice_payment.invoice_payment_reversal r where r.invoice_id = ${x}) as reversals`)[0];
  const before = { ...(await snap()) };
  const c1 = await credit(f, x, 2000);
  assert.equal(await withdraw(f, c1), 'applied', 'withdrawn');
  await credit(f, x, 1500);
  assert.equal((await credit(f, x, 50_000)).outcome, 'amount_exceeds_remaining', 'a refusal');
  const after = { ...(await snap()) };
  for (const key of Object.keys(before)) assert.ok(before[key] !== null && before[key] === after[key], `${key}: byte-identical`);
});

test('ICR-21 (CN-16): on a voided invoice a withdrawal and an open registration\'s issue are invalid_state', async () => {
  const f = await scene('voided');
  const x = await invoice(f);
  const c = await credit(f, x, 2000);
  assert.equal(await withdraw(f, c), 'applied', 'withdrawn first (a void needs no active credit)');
  const open = await prepareCredit(f, x, 500);
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: x, tenant: f.T })), 'applied', 'voided while a registration is open');
  const w0 = await writes(f.T);
  assert.equal(await withdraw(f, c), 'invalid_state', 'withdrawal on a voided invoice: invalid_state');
  assert.equal(await word(runtime, Q.issue(f.k.boss, open)), 'invalid_state', 'the open registration\'s issue: invalid_state');
  assert.deepEqual(await writes(f.T), w0, 'nothing written');
  await settleCredit(open, 'refused');
  assert.equal(await word(runtime, Q.register(f.k.boss, { ...open, registration: randomUUID(), attempt: randomUUID() })), 'invalid_state', 'a new registration: invalid_state');
});

// ---- CN-17: a seeded property test ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const bdiv = (a, b) => (a >= 0n ? a / b : -((-a + b - 1n) / b)); // floor division for b > 0
test('ICR-22 (CN-17): a seeded property test — 0 <= t <= G, gross = net + tax, exact once-rounded share, invariants after every issue and withdrawal', async () => {
  const SEED = 0x0c4e_0038;
  const CASES = 8;
  const OPS = 9;
  const RATES = [8875, 1, 25000, 50000, 100000, 0, null];
  const f = await scene('property', { rates: RATES });
  const rnd = mulberry32(SEED);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  let checked = 0;
  for (let n = 0; n < CASES; n += 1) {
    const si = int(0, RATES.length - 1);
    const store = f.stores[si];
    const subtotal = rnd() < 0.4 ? int(1, 12) : int(13, 25_000);
    const x = await invoice(f, { store, lines: lineOf(subtotal) });
    const [h] = await owner`select total_cents::text as total, coalesce(tax_cents, 0)::text as tax, subtotal_cents::text as sub, tax_mode from tmpos_invoice_issue.issued_invoice where invoice_id = ${x}`;
    const T = BigInt(h.total);
    const TAX = BigInt(h.tax);
    const SUB = BigInt(h.sub);
    let withdrawn = false;
    const issued = [];
    for (let o = 0; o < OPS; o += 1) {
      const active = (await owner`select c.credit_note_id as id, c.gross_cents::text as g, c.tax_cents::text as t, c.net_cents::text as n
        from tmpos_invoice_credit_note.invoice_credit_note c where c.invoice_id = ${x}
          and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w where w.credit_note_id = c.credit_note_id)`)
        .map((r) => ({ id: r.id, g: BigInt(r.g), t: BigInt(r.t), n: BigInt(r.n) }));
      const aG = active.reduce((s, r) => s + r.g, 0n);
      const aT = active.reduce((s, r) => s + r.t, 0n);
      const remaining = T - aG;
      const tag = `case ${n} op ${o}`;
      if (active.length > 0 && rnd() < 0.3) {
        const victim = active[int(0, active.length - 1)];
        assert.equal(await withdraw(f, { store, invoice: x, tenant: f.T, cn: victim.id }, 'wrong_amount'), 'applied', `${tag}: withdrawn`);
        withdrawn = true;
      } else {
        const over = remaining === 0n || rnd() < 0.1;
        const G = over ? remaining + BigInt(int(1, 40)) : BigInt(int(1, Number(remaining)));
        const c = await credit(f, x, Number(G), { store });
        if (over) {
          assert.equal(c.outcome, 'amount_exceeds_remaining', `${tag}: above remaining refused`);
          continue;
        }
        assert.equal(c.outcome, 'applied', `${tag}: issued`);
        const row = await cnRow(c.cn);
        let want = h.tax_mode === 'none' ? 0n : bdiv(2n * TAX * (aG + G) + T, 2n * T) - aT;
        if (want < 0n) want = 0n;
        if (want > G) want = G;
        assert.ok(BigInt(row.t) === want, `${tag}: t is D-CN-4 A's clamp(div(2 tax (aG+G) + T, 2T) - aT, 0, G)`);
        assert.ok(row.t >= 0 && BigInt(row.t) <= G && BigInt(row.g) === G && row.g === row.t + row.net, `${tag}: 0 <= t <= G and gross = net + tax`);
        issued.push(c);
      }
      const now = (await owner`select coalesce(sum(c.gross_cents), 0)::text as g, coalesce(sum(c.tax_cents), 0)::text as t, coalesce(sum(c.net_cents), 0)::text as n
        from tmpos_invoice_credit_note.invoice_credit_note c where c.invoice_id = ${x}
          and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w where w.credit_note_id = c.credit_note_id)`)[0];
      const [g, t, net] = [BigInt(now.g), BigInt(now.t), BigInt(now.n)];
      assert.ok(t <= TAX && net <= SUB, `${tag}: active tax <= invoice tax, active net <= subtotal`);
      if (g === T) assert.ok(t === TAX, `${tag}: active gross = T makes active tax = invoice tax`);
      if (!withdrawn) assert.ok(t === (h.tax_mode === 'none' ? 0n : bdiv(2n * TAX * g + T, 2n * T)), `${tag}: without withdrawals, cumulative tax is the once-rounded share`);
      assert.equal((await amounts(f, x, { store })).remaining, Number(T - g), `${tag}: the amounts read's remaining`);
      checked += 1;
    }
  }
  assert.ok(checked >= CASES * 4, 'a bounded but non-trivial number of checked steps');
});

test('ICR-23 (CN-17): a forced invariant violation raises data_corrupted with the fixed text; nothing written', async () => {
  const f = await scene('invariant');
  const TEXT = 'migration 038 issue: the credit notes\' tax split breaks an invariant of the invoice';
  for (const [label, forced, g] of [['active tax above the invoice\'s tax', { gross: 1000, tax: 1000, net: 0 }, 100],
    ['active net above the subtotal', { gross: 10_001, tax: 0, net: 10_001 }, 1]]) {
    const x = await invoice(f);
    const rows = await forceCredit(f, x, forced);
    const a = await prepareCredit(f, x, g);
    const w0 = await writes(f.T);
    const e = await errorOf(runtime.unsafe(...Q.issue(f.k.boss, a)));
    assert.equal(safeCode(e), 'XX001', `${label}: data_corrupted`);
    assert.ok(e?.message === TEXT, `${label}: the fixed text`);
    assert.deepEqual(await writes(f.T), w0, `${label}: nothing written`);
    await settleCredit(a, 'refused');
    await unforce(rows);
  }
});

test('ICR-24 (CN-22): numbering — per store from 1, a refusal uses none, concurrent issues distinct, a withdrawal keeps its number', async () => {
  const f = await scene('numbers');
  const counter = async (store) => (await owner`select last_number::int as n from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = ${f.T} and store_id = ${store}`)[0]?.n ?? null;
  assert.equal(await counter(f.S), null, 'a store created after 038 has no counter row yet');
  const x = await invoice(f);
  assert.equal((await credit(f, x, 20_000)).outcome, 'amount_exceeds_remaining', 'a refused first issue');
  assert.equal(await counter(f.S), 0, 'the refusal committed only the empty counter row (D-CN-6)');
  const c1 = await credit(f, x, 1000);
  assert.equal((await cnRow(c1.cn)).n, 1, 'the store\'s first number is 1');
  assert.equal((await credit(f, x, 20_000)).outcome, 'amount_exceeds_remaining', 'another refusal');
  const c2 = await credit(f, x, 1000);
  assert.equal((await cnRow(c2.cn)).n, 2, 'the refusal used no number');
  // Concurrent issues in one store, on two invoices by two owners: the counter row serializes them.
  const y = await invoice(f);
  const z = await invoice(f);
  const a = await prepareCredit(f, y, 100);
  const b = await prepareCredit(f, z, 100, { key: f.k.boss2 });
  const h = holding(runtime, tx1(Q.issue(f.k.boss, a)));
  try {
    await until(() => h.ready, 'the first issue holds its number');
    const r = running(runtime, tx1(Q.issue(f.k.boss2, b)));
    await until(async () => r.out !== undefined || (r.pid !== null && await blockedBy(r.pid, h.pid)), 'the second waits');
    // Different invoices, owners and registrations: the store's counter row is the only row both write. The first UPDATEd it, so
    // the second's INSERT ... ON CONFLICT waits on the first's transaction (no tuple lock is taken for that wait).
    assert.ok((await waitsFor(r.pid)).some(([t, m]) => t === 'transactionid' && m === 'ShareLock'), 'it waits on the first transaction');
    h.release('commit');
    assert.deepEqual([finished(await h.done, 'first'), finished(await r.done, 'second')], ['applied', 'applied'], 'both issue');
  } finally { h.release('rollback'); }
  assert.deepEqual([(await cnRow(a.cn)).n, (await cnRow(b.cn)).n], [3, 4], 'distinct numbers');
  await settleCredit(a, 'applied');
  await settleCredit(b, 'applied');
  // A withdrawal keeps its number; the counter does not move.
  assert.equal(await withdraw(f, c2), 'applied', 'withdrawn');
  const listed = await run(runtime, Q.list(f.k.boss, { tenant: f.T, store: f.S, invoice: x }));
  const l2 = listed.find((r) => r.o_credit_note_id === c2.cn);
  assert.deepEqual({ n: l2?.o_credit_note_number, w: l2?.o_withdrawn_at !== null, r: l2?.o_withdrawal_reason_code }, { n: '2', w: true, r: 'wrong_amount' }, 'number 2 kept');
  assert.equal(await counter(f.S), 4, 'the counter did not move');
  // Another store's series starts at 1.
  const o = await invoice(f, { store: f.S2 });
  const cb = await credit(f, o, 100, { store: f.S2, key: f.k.bossB });
  assert.equal((await cnRow(cb.cn)).n, 1, 'per store: the other store\'s first number is 1');
});

test('ICR-25 (CN-33): staff names to the store-scope store owner only; absent for everyone else; never an id; no other read names staff', async () => {
  const f = await scene('names');
  const x = await invoice(f);
  const c1 = await credit(f, x, 1000);
  const c2 = await credit(f, x, 500, { key: f.k.boss2 });
  assert.equal(await withdraw(f, c1, 'entered_in_error', f.k.boss), 'applied', 'withdrawn by the named owner');
  const COLS = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_names_visible', 'o_credit_note_id', 'o_credit_note_number', 'o_gross_cents',
    'o_tax_cents', 'o_net_cents', 'o_reason_code', 'o_issued_at', 'o_issued_by_name', 'o_withdrawn_at', 'o_withdrawal_reason_code', 'o_withdrawn_by_name'];
  const view = async (k) => {
    const rows = await run(runtime, Q.list(k, { tenant: f.T, store: f.S, invoice: x }));
    assert.deepEqual(Object.keys(rows[0]), COLS, 'the list\'s columns');
    const ids = new Set([f.a.boss.id, f.a.boss2.id, f.a.manager.id]);
    assert.ok(rows.every((r) => Object.values(r).every((v) => !ids.has(v))), 'no actor id in any column');
    return Object.fromEntries(rows.map((r) => [r.o_credit_note_id === c1.cn ? 'c1' : 'c2',
      { visible: r.o_names_visible, issuedBy: r.o_issued_by_name, withdrawnBy: r.o_withdrawn_by_name }]));
  };
  assert.deepEqual(await view(f.k.boss), {
    c1: { visible: true, issuedBy: 'ICR Owner names', withdrawnBy: 'ICR Owner names' },
    c2: { visible: true, issuedBy: null, withdrawnBy: null },
  }, 'the store owner: names, and an owner-visible null for a staff member with none');
  for (const who of ['manager', 'tech', 'sales']) {
    assert.deepEqual(await view(f.k[who]), { c1: { visible: false, issuedBy: null, withdrawnBy: null }, c2: { visible: false, issuedBy: null, withdrawnBy: null } },
      `${who} (a direct DB read): names_visible false, both name columns null (the server omits them)`);
  }
  const amountsCols = Object.keys(await one(runtime, Q.amounts(f.k.boss, { tenant: f.T, store: f.S, invoice: x })));
  const attemptCols = Object.keys((await run(runtime, Q.attempts(f.k.boss, { store: f.S, tenant: f.T })))[0]);
  assert.deepEqual([...amountsCols, ...attemptCols].filter((c) => /name|_by|actor|email/.test(c)), [], 'no other read returns a staff name or actor');
});

test('ICR-26 (CN-35): forced corruption makes the amounts read raise data_corrupted', async () => {
  const f = await scene('corrupt');
  // A voided invoice with an active credit note.
  const x = await invoice(f);
  assert.equal(await word(runtime, Q.void3(f.k.boss, { store: f.S, invoice: x, tenant: f.T })), 'applied', 'voided');
  const r1 = await forceCredit(f, x, { gross: 100, tax: 0, net: 100 });
  let e = await errorOf(runtime.unsafe(...Q.amounts(f.k.boss, { tenant: f.T, store: f.S, invoice: x })));
  assert.equal(safeCode(e), 'XX001', 'a voided invoice holding an active credit note: data_corrupted');
  assert.ok(e?.message === 'migration 038 read: a voided invoice holds an active credit note', 'its fixed text');
  await unforce(r1);
  assert.deepEqual(pick(await amounts(f, x)), am(0, 0, 0, 'voided'), 'clean again');
  // Active credited + paid above the Total.
  const y = await invoice(f);
  assert.equal((await pay(f, y, 10_000)).outcome, 'applied', 'paid 10,000');
  const r2 = await forceCredit(f, y, { gross: 5000, tax: 0, net: 5000 });
  e = await errorOf(runtime.unsafe(...Q.amounts(f.k.boss, { tenant: f.T, store: f.S, invoice: y })));
  assert.equal(safeCode(e), 'XX001', 'credited + paid above the Total: data_corrupted');
  assert.ok(e?.message === 'migration 038 read: the active credit notes and unreversed payments exceed the invoice\'s Total', 'its fixed text');
  await unforce(r2);
  assert.deepEqual(pick(await amounts(f, y)), am(0, 10_000, 888, 'recorded_partly'), 'clean again');
});

test('ICR-27 (§4 row 1, CN-18): an issued invoice with Total 0 refuses a credit (amount_exceeds_remaining), writes nothing, reads (0,0,0,0) nothing_due', async () => {
  const f = await scene('zero');
  const x = await invoice(f, { lines: lineOf(0) });
  const [{ total }] = await owner`select total_cents::int as total from tmpos_invoice_issue.issued_invoice where invoice_id = ${x}`;
  assert.equal(total, 0, 'the invoice\'s Total is 0');
  const a = await prepareCredit(f, x, 1);
  const w0 = await writes(f.T);
  assert.equal(await word(runtime, Q.issue(f.k.boss, a)), 'amount_exceeds_remaining', 'a credit of 1 on a Total of 0: refused');
  const w1 = await writes(f.T);
  assert.deepEqual(w1, w0, 'nothing written: no credit note, number, link or audit row');
  assert.equal(await cnRow(a.cn), null, 'no credit note');
  await settleCredit(a, 'refused');
  const s = await amounts(f, x);
  assert.deepEqual({ due: s.due, ...pick(s) }, { due: 0, ...am(0, 0, 0, 'nothing_due') }, 'the amounts read: (0, 0, 0, 0), nothing_due');
});

test('ICR-28 (CN-18 E15): option B\'s net-entered rounding against option A\'s split, same gross amounts', async () => {
  // Option B (a comparison only, never implemented): each credit's tax by 034's formula on its own net.
  const R = 8875n;
  const T = 10_888n;
  const taxB = (net) => (net * R + 50_000n) / 100_000n; // div(S x R + 50000, 100000), all non-negative
  const runB = (nets) => nets.map((n) => ({ net: n, tax: taxB(n), gross: n + taxB(n) }));
  const first = runB([1n, 9_999n, 1n]);
  assert.deepEqual(first.map((c) => c.tax), [0n, 887n, 0n], 'B: taxes 0, 887 and the further net-1 credit 0');
  assert.equal(first[0].gross + first[1].gross, T - 1n, 'B: the first two leave 1 cent');
  assert.deepEqual({ net: first.reduce((s, c) => s + c.net, 0n), tax: first.reduce((s, c) => s + c.tax, 0n), gross: first.reduce((s, c) => s + c.gross, 0n) },
    { net: 10_001n, tax: 887n, gross: T }, 'B: net 10,001 and tax 887 against the invoice\'s 10,000 and 888');
  const second = runB([400n, 400n, 9_200n]);
  assert.deepEqual(second.map((c) => c.tax), [36n, 36n, 817n], 'B: taxes 36, 36, 817');
  const remainingBeforeLast = T - second[0].gross - second[1].gross;
  assert.deepEqual({ last: second[2].gross, remaining: remainingBeforeLast }, { last: 10_017n, remaining: 10_016n }, 'B: the last gross 10,017 against remaining 10,016 — refused');
  // Option A through the routine, for the same gross amounts.
  const f = await scene('e15');
  let x = await invoice(f);
  const a1 = [];
  for (const g of [1, 10_887]) a1.push((await split((await credit(f, x, g)).cn)).t);
  assert.deepEqual(a1, [0, 888], 'A: grosses 1 then 10,887 carry taxes 0 + 888');
  x = await invoice(f);
  const a2 = [];
  for (const g of [436, 436, 10_016]) a2.push((await split((await credit(f, x, g)).cn)).t);
  assert.deepEqual(a2, [36, 35, 817], 'A: grosses 436, 436, 10,016 carry taxes 36 + 35 + 817 = 888');
  assert.deepEqual(pick(await amounts(f, x)), am(10_888, 0, 0, 'credited_in_full'), 'A: the last credit fits exactly');
});
