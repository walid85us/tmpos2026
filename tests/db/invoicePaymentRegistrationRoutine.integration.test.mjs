// Phase 4.0 M7B-PAYMENTS-P2 PRQ-1 — payment registration against REAL, crash-durable PostgreSQL: migration 037 (the
// registration table and its durable unresolved slot, the owner-installed proof key bound to a strictly increasing generation,
// the register, proof, record v2, attempts and settle routines, the key probe, and the revoke of 036's v1 record), exercised as
// the runtime's own non-owner login, every call bound as a production adapter would bind it.
//
// WHAT IS PROVEN (each title names its case):
//   IRR-01 001-037 by the trusted executor; the ledger exactly REQUIRED_MIGRATIONS, 037's checksum its up bytes; the
//          postcondition re-run holds; a second up refused with its fixed text.
//   IRR-02 the down while EMPTY restores 036's catalog (v1 record EXECUTE to tmpos_app again, every 037 object gone); 036's
//          down while 037 is applied fails (2BP01); the up applies again to the same catalog.
//   IRR-03 privileges: the six routines EXECUTE to tmpos_app beside the owner and nothing else of 037 nor 036's v1 record,
//          018's HMAC or 034's reader; no runtime role holds any privilege on the three tables; the login refused (42501).
//   IRR-04 the happy path: register (one audit), the proof from another connection equals an independent HMAC, the same
//          proof again, record v2 -> EXACTLY ONE payment row and ONE payment audit row, the registration recorded, the list,
//          version-checked settlement (conflict, applied, unchanged), the slot released.
//   IRR-05 the same transaction and a savepoint: proof not_found, record not_found; after COMMIT both work.
//   IRR-06 a rolled-back registration: proof and record not_found, nothing left.
//   IRR-07 PRE-FLUSH ISSUANCE REFUSED: the registering connection commits with synchronous_commit=off and the WAL writer slowed;
//          the proof ANSWERS (not_durable, NULLs) within the bounded p_wait_ms (never a raise), the registration unchanged;
//          p_wait_ms 0 is the same strict comparison; null, -1 and 1001 are invalid_parameter_value; after a durable commit it issues.
//   IRR-08 mismatched attempt id, registration id, proof, session or actor: one not_found, NO ledger or audit write.
//   IRR-09 key missing: register, proof and record raise 55000 writing nothing; the probe, the list and settle keep working.
//   IRR-10 key rotation: the old registration unsendable (proof and record not_found), the slot held (conflict) until settled;
//          reinstalling retired bytes, a non-increasing generation and any history change refused by the database.
//   IRR-11 concurrent record and settlement, both orders, serialized on the issued header: exactly one outcome.
//   IRR-12 secrets: with the caller's debug_print_* and print_strict_params raised, no key, proof, session key or digest in any
//          notice, error text or audit row; the registration table stores none.
//   IRR-13 decision order and refusals: refused, tenant_mismatch, not_found, invalid_state (voided, withdrawn attempt), denied;
//          another staff member's attempt id registers as a fresh one; REPEATABLE READ refused.
//   IRR-14 037's down refuses (55000) while a registration exists, changing nothing.
//
// DISPOSABLE ONLY, DURABLE: the harness's crash-durable cluster (fsync, full_page_writes, synchronous_commit on). It leaves
// 001-037 applied, NO registration, payment, registration audit record, proof key, session, login or fixture of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient } from './localPostgres.harness.mjs';
import { rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { REQUIRED_MIGRATIONS } from '../../server/persistence/postgresStartupPreflight.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const mig = (name) => readFileSync(`${MIG_DIR}/${name}`, 'utf8');
const UP_037 = mig('037_m7b_invoice_payment_registration.up.sql');
const DOWN_037 = mig('037_m7b_invoice_payment_registration.down.sql');
const DOWN_036 = mig('036_m7b_invoice_payment.down.sql');
const SHA_UP_037 = createHash('sha256').update(readFileSync(`${MIG_DIR}/037_m7b_invoice_payment_registration.up.sql`)).digest('hex');
const POSTCONDITION_037 = UP_037.slice(UP_037.lastIndexOf('do $$'));

const NS = 'tmpos_invoice_payment';
const REGISTER = `${NS}.m7b_invoice_payment_register(text, uuid, uuid, uuid, uuid, uuid, uuid)`;
const PROOF = `${NS}.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid, integer)`;
/** The proof's signature before O1 (no p_wait_ms): gone. */
const PROOF_V0 = `${NS}.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid)`;
const RECORD2 = `${NS}.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)`;
const ATTEMPTS = `${NS}.m7b_invoice_payment_attempts(text, uuid, uuid, uuid, uuid, integer)`;
const SETTLE = `${NS}.m7b_invoice_payment_settle(text, uuid, uuid, uuid, uuid, bigint, uuid)`;
const PROBE = `${NS}.m7b_payment_proof_key_probe()`;
const ROUTINES = [REGISTER, PROOF, RECORD2, ATTEMPTS, SETTLE, PROBE];
const RECORD1 = `${NS}.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)`;
const OWNER_ONLY = [RECORD1, `${NS}.m7b_payment_writer(text, uuid)`, `${NS}.m7b_payment_levels_ok(uuid, text)`,
  `${NS}.m7b_payment_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint)`,
  `${NS}.m7b_invoice_payment_registration_guard()`, `${NS}.m7b_invoice_payment_registration_truncate_guard()`,
  `${NS}.m7b_payment_proof_key_install_guard()`, `${NS}.m7b_payment_proof_key_shape_guard()`,
  `${NS}.m7b_payment_proof_key_generation_guard()`];
const REG_TABLE = `${NS}.invoice_payment_registration`;
const KEY_TABLE = `${NS}.payment_proof_key`;
const GEN_TABLE = `${NS}.payment_proof_key_generation`;
const TABLES = [REG_TABLE, KEY_TABLE, GEN_TABLE];
const MIGRATOR = { purpose: 'migration', migratorRef: 'irr-migrator', runtimeRef: 'irr-runtime' };
const LOCK_KEY = 529_637;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_irr_probe';
const HOUR = 3_600_000;
const ROLLBACK = new Error('irr: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIONS_037 = ['store.invoice_payment.register', 'store.invoice_payment.settle'];
const SETTINGS_SET_FN = 'tmpos_invoice_issue.m7b_issuing_settings_set';
const CREATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_create_v3';
const ISSUE_FN = 'tmpos_invoice_issue.m7b_invoice_issue';
const VOID2_FN = `${NS}.m7b_invoice_void_v2`;

// ---------------------------------------------------------------------------
// the mint construction and the proof construction, computed here independently
// ---------------------------------------------------------------------------
const netstring = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from(`${b.length}:`), b, Buffer.from(',')]); };
const mintMessage = (key, r, expiresAt) => Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion,
    r.authenticatedAt === null ? '' : r.authenticatedAt, r.createdAt, r.lastSeenAt, r.validatedAt, expiresAt].map((v) => netstring(String(v)))]);
const mintProof = (issuer, key, r, expiresAt) => createHmac('sha256', issuer).update(mintMessage(key, r, expiresAt)).digest();
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
const uuidBytes = (u) => Buffer.from(u.replace(/-/g, ''), 'hex');
const int8 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const sessionDigest = (key) => createHash('sha256').update(Buffer.from(key, 'utf8')).digest();
/** HMAC-SHA-256 over 037's fixed-width message, as the proof routine computes it. */
const proofFor = (pk, generation, { registration, actor, tenant, store, invoice, attempt, sessionKey }) => createHmac('sha256', pk)
  .update(Buffer.concat([Buffer.from('tmpos-m7b-payment-registration-proof:v1', 'utf8'), Buffer.from([0]),
    ...[registration, actor, tenant, store, invoice, attempt].map(uuidBytes), sessionDigest(sessionKey), int8(generation)]))
  .digest('hex');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------
const TARGET = resolveDisposableTarget('IRR', { durable: true });
const cluster = TARGET.cluster ?? null;
assertDisposableTestDsn(TARGET.dsn);
const DATABASE = new URL(TARGET.dsn).pathname.slice(1);
const connect = (user, max, extra = {}) => testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {}, ...extra });

const owner = connect(undefined, 6);
let runtime = null; // the runtime login, synchronous commit as configured (on)
let registrar = null; // the runtime login, ONE connection with synchronous_commit = off (a permitted direct caller)
let issuer = null; // the runtime login, ONE connection that asks for proofs
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
let issuerKeyBefore;
let PK = null; // { key: Buffer, generation: bigint } — the proof key installed now

async function trustedApply(through) {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET.dsn));
  try {
    const port = createNodeFsPort(MIG_DIR, MIG_REL);
    return await runTrustedApply({
      fsPort: through === undefined ? port : { ...port, list: () => port.list().filter((n) => n.slice(0, 3) <= through) },
      adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW,
      deadlineMs: 300_000,
    });
  } finally {
    await handle.dispose();
  }
}
const applied037 = async () => (await owner`select pg_catalog.to_regclass(${REG_TABLE}) is not null as e`)[0].e;
const downCommitted = (file, version) => owner.begin(RC, async (tx) => {
  await tx.unsafe(file).simple();
  await tx`delete from public.schema_migrations where version = ${version}`;
});
/** The owner installs a fresh proof key under the next generation (an upsert: a rotation when one is installed). */
async function installProofKey(bytes = randomBytes(32)) {
  const [{ g }] = await owner`select (coalesce(pg_catalog.max(generation), 0) + 1)::text as g from tmpos_invoice_payment.payment_proof_key_generation`;
  await owner`insert into tmpos_invoice_payment.payment_proof_key (singleton, key, generation) values (true, ${bytes}, ${g}::bigint)
    on conflict (singleton) do update set key = excluded.key, generation = excluded.generation`;
  PK = { key: bytes, generation: BigInt(g) };
  return PK;
}

const TRIGGER_MODE = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' };
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
async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    await withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']],
      () => sql`delete from public.audit_event where tenant_id = any(${TENANTS}::uuid[])`);
    await withTriggersLifted(sql, [[REG_TABLE, 'trg_invoice_payment_registration_guard']],
      () => sql`delete from tmpos_invoice_payment.invoice_payment_registration where tenant_id = any(${TENANTS}::uuid[])`);
    await withTriggersLifted(sql, [[`${NS}.invoice_payment`, 'trg_invoice_payment_guard'], [`${NS}.invoice_payment_reversal`, 'trg_invoice_payment_reversal_guard']], async () => {
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
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}
const setWalWriterDelay = async (value) => {
  if (value === null) await owner`alter system reset wal_writer_delay`;
  else await owner.unsafe(`alter system set wal_writer_delay = '${value}'`);
  await owner`select pg_catalog.pg_reload_conf()`;
  await new Promise((r) => setTimeout(r, 300));
};

let above037;
test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    await step(() => setWalWriterDelay(null));
    await step(async () => { if (!(await applied037())) { const r = await trustedApply(); assert.equal(r.outcome, 'complete'); } });
    await step(cleanAll);
    await step(() => owner`delete from tmpos_invoice_payment.payment_proof_key where singleton`);
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
    for (const c of [runtime, registrar, issuer]) if (c) await step(() => c.end({ timeout: 5 }));
    await step(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
    await step(() => owner.unsafe(`do $$ begin
      if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
    end $$;`));
    await step(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
    await step(async () => {
      const [state] = await owner`select
          (select pg_catalog.string_agg(version, ',' order by version) from public.schema_migrations) as ledger,
          (select count(*) from tmpos_invoice_payment.invoice_payment_registration)::int as registrations,
          (select count(*) from tmpos_invoice_payment.invoice_payment)::int as payments,
          (select count(*) from tmpos_invoice_payment.payment_proof_key)::int as keys,
          (select count(*) from public.audit_event where action_id = any(${ACTIONS_037}::text[]) or subject_invoice_payment_registration_id is not null)::int as audits,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, {
        ledger: Array.from({ length: 37 }, (_, i) => String(i + 1).padStart(3, '0')).join(','),
        registrations: 0, payments: 0, keys: 0, audits: 0, login: false,
      }, 'left as found: 001-037 applied, no registration, payment, proof key, registration audit or login of this suite');
    });
    await step(() => above037?.restore());
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IRR teardown: a cleanup step or postcondition failed');
});

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    for (const c of [runtime, registrar, issuer, owner]) if (c) await c.end({ timeout: 5 }).catch(() => {});
    if (cluster) cluster.stop();
    throw err;
  }
}

let ME;
const APPLY_REPORT = await setupStep(async () => {
  const [{ fsync }] = await owner`select pg_catalog.current_setting('fsync') as fsync`;
  assert.equal(fsync, 'on', 'the durable harness: fsync on');
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
  await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
  above037 = await rollBackAbove(owner, MIG_DIR, '037');
  if (await applied037()) await downCommitted(DOWN_037, '037');
  const report = await trustedApply();
  await owner.unsafe(`do $$ begin
    if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
  end $$;`);
  await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  runtime = connect(RUNTIME_LOGIN, 4);
  registrar = connect(RUNTIME_LOGIN, 1);
  issuer = connect(RUNTIME_LOGIN, 1);
  await registrar`set synchronous_commit = off`;
  issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
  if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
  await installTestIssuerKey(owner, ISSUER_KEY);
  ME = (await owner`select current_user::text as me`)[0].me;
  await installProofKey();
  return report;
});

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------
const newTenant = async (label) => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`irr-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name) => (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, 'active') returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IRR ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships) {
  const uid = `irr-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  const ms = [];
  for (const m of memberships) {
    const [{ membership_id: mid }] = await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active') returning membership_id`;
    ms.push(mid);
  }
  UIDS.push(uid);
  return { id, uid, label, memberships: ms, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
async function mint(who, { lifetime = 8 * HOUR } = {}) {
  const key = newKey();
  const at = Date.now();
  const r = { audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
    securityVersion: 't2:irr', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at };
  const expiresAt = r.createdAt + lifetime;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${mintProof(ISSUER_KEY, key, r, expiresAt)}::bytea) as outcome`;
  assert.equal(outcome, 'created', `a tenant session for ${who.uid}`);
  return key;
}
const LINES = [{ description: 'Screen replacement', quantity: 1, unitPriceCents: 12_999 }, { description: 'Labour', quantity: 2, unitPriceCents: 4_500 }];
const TOTAL = 12_999 + 2 * 4_500;
async function settingsSet(key, store, tenant) {
  const [row] = await runtime.unsafe(`select o_outcome from ${SETTINGS_SET_FN}($1::text, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::text, $9::text, $10::integer)`,
    [key, store, tenant, '0', 'IRR Legal Name LLC', 'IRR Store', '1 Main St\nSpringfield', 'TAX-IRR-1', 'exclusive_rate', 8875]);
  assert.equal(row.o_outcome, 'applied', 'the store\'s issuing settings');
}
async function issueOne(key, store, tenant, customer) {
  const draft = randomUUID();
  const [c] = await runtime.unsafe(`select o_outcome from ${CREATE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [key, store, draft, tenant, customer, JSON.stringify(LINES), String(TOTAL)]);
  assert.equal(c.o_outcome, 'applied', 'the draft saved');
  const invoice = randomUUID();
  const [i] = await runtime.unsafe(`select o_outcome from ${ISSUE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8::uuid)`,
    [key, store, draft, tenant, '1', '1', '1', invoice]);
  assert.equal(i.o_outcome, 'applied', 'the draft issued');
  return invoice;
}
/** A fresh tenant with two stores, a store owner per store, a manager and a technician at the first, a tenant owner; `invoices` issued. */
async function scene(label, { invoices = 1 } = {}) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label}-a ${SUFFIX}`);
  const S2 = await newStore(T, `${label}-b ${SUFFIX}`);
  const C = await newCustomer(T, label);
  const boss = await actor(`${label}-owner`, [storeGrant(T, S, 'store_owner')]);
  const boss2 = await actor(`${label}-owner2`, [storeGrant(T, S2, 'store_owner')]);
  const manager = await actor(`${label}-manager`, [storeGrant(T, S, 'manager')]);
  const tech = await actor(`${label}-tech`, [storeGrant(T, S, 'technician')]);
  const own = await actor(`${label}-tenant-owner`, [tenantGrant(T, 'store_owner')]);
  const f = { label, T, S, S2, C, boss, boss2, manager, tech, own,
    kBoss: await mint(boss), kBoss2: await mint(boss2), kManager: await mint(manager), kTech: await mint(tech), kOwn: await mint(own) };
  await settingsSet(f.kOwn, S, T);
  await settingsSet(f.kOwn, S2, T);
  f.issue = (store = S) => issueOne(store === S ? f.kBoss : f.kBoss2, store, T, C);
  f.inv = [];
  for (let i = 0; i < invoices; i += 1) f.inv.push(await f.issue());
  return f;
}

// ---------------------------------------------------------------------------
// the runtime login's calls
// ---------------------------------------------------------------------------
const plain = async (p) => (await p).map((r) => ({ ...r }));
const registerCall = (key, { store, invoice, tenant, registration = randomUUID(), attempt = randomUUID(), corr = randomUUID(), db = runtime }) =>
  plain(db.unsafe(`select * from ${NS}.m7b_invoice_payment_register($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid)`,
    [key, store, invoice, tenant, registration, attempt, corr]));
const proofCall = (key, { store, invoice, tenant, registration, wait = 1000, db = issuer }) =>
  plain(db.unsafe(`select * from ${NS}.m7b_invoice_payment_registration_proof($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [key, store, invoice, tenant, registration, wait]));
const recordCall = (key, { store, invoice, tenant, payment = randomUUID(), registration, attempt, amount = 1000, method = 'cash', proof, corr = randomUUID(), db = runtime }) =>
  plain(db.unsafe(`select * from ${NS}.m7b_invoice_payment_record_v2($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::bigint, $9::text, $10::text, $11::uuid)`,
    [key, store, invoice, tenant, payment, registration, attempt, String(amount), method, proof, corr]));
const attemptsCall = (key, { store, tenant, afterInvoice = null, afterAttempt = null, limit = 51, db = runtime }) =>
  plain(db.unsafe(`select * from ${NS}.m7b_invoice_payment_attempts($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer)`,
    [key, store, tenant, afterInvoice, afterAttempt, limit]));
const settleCall = (key, { store, invoice, tenant, attempt, version, corr = randomUUID(), db = runtime }) =>
  plain(db.unsafe(`select * from ${NS}.m7b_invoice_payment_settle($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::uuid)`,
    [key, store, invoice, tenant, attempt, String(version), corr]));
const probeCall = (db = runtime) => plain(db`select * from tmpos_invoice_payment.m7b_payment_proof_key_probe()`);

const NO8 = (word, cols) => [Object.fromEntries([['o_outcome', word], ...cols.map((c) => [c, null])])];
const REG_COLS = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_registration_id', 'o_invoice_id', 'o_audit_event_id'];
const REC_COLS = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_payment_id', 'o_invoice_id', 'o_audit_event_id'];
const SET_COLS = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id', 'o_audit_event_id'];
const PRF_COLS = ['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_registration_id', 'o_attempt_id', 'o_proof'];
const NO_REG = (w) => NO8(w, REG_COLS);
const NO_REC = (w) => NO8(w, REC_COLS);
const NO_SET = (w) => NO8(w, SET_COLS);
const NO_PRF = (w) => NO8(w, PRF_COLS);

/** Registers a fresh attempt of `who` (the store owner by default) on `invoice`; answers its ids and session. */
async function registered(f, invoice, { who = f.boss, key = f.kBoss, attempt = randomUUID(), store = f.S, db = runtime } = {}) {
  const registration = randomUUID();
  const corr = randomUUID();
  const rows = await registerCall(key, { store, invoice, tenant: f.T, registration, attempt, corr, db });
  assert.equal(rows.length, 1);
  const { o_audit_event_id: event, ...rest } = rows[0];
  assert.deepEqual(rest, { o_outcome: 'applied', o_tenant_id: f.T, o_store_id: store, o_actor_id: who.id, o_membership_id: who.memberships[0],
    o_registration_id: registration, o_invoice_id: invoice }, 'registered');
  assert.match(event, UUID_RE);
  return { registration, attempt, key, who, store, invoice, event, corr };
}
const expected = (f, r, pk = PK) => proofFor(pk.key, pk.generation, { registration: r.registration, actor: r.who.id, tenant: f.T, store: r.store,
  invoice: r.invoice, attempt: r.attempt, sessionKey: r.key });
async function proofOf(f, r, { key = r.key, db = issuer, wait = 1000 } = {}) {
  const rows = await proofCall(key, { store: r.store, invoice: r.invoice, tenant: f.T, registration: r.registration, wait, db });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { o_outcome: 'proof', o_tenant_id: f.T, o_store_id: r.store, o_invoice_id: r.invoice, o_registration_id: r.registration,
    o_attempt_id: r.attempt, o_proof: expected(f, r) }, 'the proof, equal to the independent HMAC');
  return rows[0].o_proof;
}
const recordWith = (f, r, proof, { key = r.key, ...extra } = {}) => recordCall(key, { store: r.store, invoice: r.invoice, tenant: f.T,
  registration: r.registration, attempt: r.attempt, proof, ...extra });
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? null,
  hint: err.hint ?? null, where: err.where ?? null }));
const rowOf = async (registration) => (await owner`select pg_catalog.to_jsonb(g) - 'session_digest' as j, g.xmin::text as xmin, g.ctid::text as ctid
  from tmpos_invoice_payment.invoice_payment_registration g where g.registration_id = ${registration}`).map((x) => ({ ...x }))[0] ?? null;
/** Every row of the tenant a 037 routine could write (row, xmin, ctid) and the global audit and payment counts. */
async function writesOf(tenant) {
  const q = async (rel) => (await owner.unsafe(`select pg_catalog.to_jsonb(r)::text || ' ' || r.xmin::text || ' ' || r.ctid::text as v from ${rel} r where r.tenant_id = $1 order by 1`, [tenant])).map((x) => x.v);
  const [c] = await owner`select (select count(*) from public.audit_event)::int as audits, (select count(*) from tmpos_invoice_payment.invoice_payment)::int as payments,
    (select count(*) from tmpos_invoice_payment.invoice_payment_registration)::int as registrations`;
  return { regs: await q(REG_TABLE), payments: await q(`${NS}.invoice_payment`), audits: await q('public.audit_event'), ...c };
}
const grantsOf = async (signature) => (await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.grantor::regrole::text as grantor, g.is_grantable as grantable
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${signature}::regprocedure`)
  .map((x) => ({ ...x })).sort((a, b) => (`${a.grantee}/${a.priv}` < `${b.grantee}/${b.priv}` ? -1 : 1));
const EXECUTE_BY = (...grantees) => grantees.map((grantee) => ({ grantee, priv: 'EXECUTE', grantor: ME, grantable: false })).sort((a, b) => (a.grantee < b.grantee ? -1 : 1));
async function rolledBack(fn, isolation = RC) {
  let out;
  await assert.rejects(owner.begin(isolation, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}
/** The form a node tree (debug_print_*) gives a constant's bytes: decimal, space-separated. */
const decimalBytes = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b)).join(''); // outDatum prints each byte as a signed char (compared without spaces)
/** JSON-encoded texts with ALL whitespace removed: a pretty-printed tree wraps its lines even inside a number. */
const flat = (texts) => texts.join('').replace(/(?:\\[nrt]|\s)+/g, '');
/** Like rolledBack, but answers the whole error (code, message, detail, hint, where) or null. */
async function fullRefusal(fn) {
  let out;
  await assert.rejects(owner.begin(RC, async (tx) => {
    out = await fn(tx).then(() => null, (e) => ({ code: e.code, message: String(e.message), detail: e.detail ?? null, hint: e.hint ?? null, where: e.where ?? null }));
    throw ROLLBACK;
  }), (e) => e === ROLLBACK);
  return out;
}
/** No byte string (hex, \\x-hex or base64) of `secrets` appears anywhere in `value`. */
function assertNoBytes(value, secrets, label) {
  const text = JSON.stringify(value);
  for (const b of secrets) assert.ok(!text.includes(b.toString('hex')) && !text.includes(b.toString('base64')), `${label}: the captured error carries secret bytes (hex or base64); output withheld`);
}
/** A catalog fingerprint of schema tmpos_invoice_payment and the audit table's columns, oid-free. */
async function catalogOf() {
  const [r] = await owner`select pg_catalog.jsonb_build_object(
    'functions', (select pg_catalog.jsonb_agg(p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, '-') || ':' || coalesce(p.proconfig::text, '-')
                    || ':' || pg_catalog.md5(coalesce(p.prosrc, '')) order by p.oid::regprocedure::text collate "C")
                   from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_payment'::regnamespace),
    'relations', (select pg_catalog.jsonb_agg(c.relname::text || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '-') order by c.relname collate "C")
                   from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_payment'::regnamespace),
    'audit', (select pg_catalog.jsonb_agg(a.attname::text order by a.attnum) from pg_catalog.pg_attribute a
               where a.attrelid = 'public.audit_event'::regclass and a.attnum > 0 and not a.attisdropped)) as c`;
  return r.c;
}

// ===========================================================================
// IRR-01..03: the migration, its rollback and its surface
// ===========================================================================

test('IRR-01: 001-037 by the trusted executor, the ledger exactly REQUIRED_MIGRATIONS, 037\'s checksum its up bytes; the postcondition re-run holds; a second up refused with its fixed text', async () => {
  assert.equal(APPLY_REPORT.outcome, 'complete', JSON.stringify(APPLY_REPORT).slice(0, 300));
  const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => r.version), Array.from({ length: 37 }, (_, i) => String(i + 1).padStart(3, '0')));
  assert.equal(ledger[36].checksum, SHA_UP_037, '037\'s ledger checksum is the sha256 of its up bytes');
  assert.deepEqual(ledger.map((r) => [r.version, r.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the startup preflight\'s pinned chain');
  await owner.unsafe(POSTCONDITION_037);
  const again = await rolledBack((tx) => tx.unsafe(UP_037).simple());
  assert.deepEqual(again, { code: '55000', message: 'migration 037 refused: an object of this file already exists' });
});

test('IRR-02: the down while EMPTY restores 036\'s catalog exactly (v1 record EXECUTE to tmpos_app again, every 037 object gone); 036\'s down while 037 is applied fails 2BP01; the up applies again to the same catalog', async () => {
  const before = await catalogOf();
  const blocked = await rolledBack((tx) => tx.unsafe(DOWN_036).simple());
  assert.equal(blocked.code, '2BP01', `036's down while 037 is applied: ${JSON.stringify(blocked)}`);
  assert.deepEqual(await grantsOf(RECORD1), EXECUTE_BY(ME), '037 applied: the v1 record is the owner\'s alone');
  await downCommitted(DOWN_037, '037');
  assert.deepEqual(await grantsOf(RECORD1), EXECUTE_BY(ME, 'tmpos_app'), 'rolled back: 036\'s two entries again');
  const [gone] = await owner`select pg_catalog.to_regclass(${REG_TABLE}) is null and pg_catalog.to_regclass(${KEY_TABLE}) is null
      and pg_catalog.to_regclass(${GEN_TABLE}) is null
      and not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = 'public.audit_event'::regclass
                       and a.attname = 'subject_invoice_payment_registration_id' and not a.attisdropped)
      and (select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_payment'::regnamespace) = 9 as g`;
  assert.equal(gone.g, true, 'every 037 object gone, 036\'s nine functions left');
  const report = await trustedApply();
  assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
  assert.deepEqual(await catalogOf(), before, 're-applied: the same catalog');
  await installProofKey(); // the down removed the installed key with its table
});

test('IRR-03: privileges — the six routines EXECUTE to tmpos_app beside the owner; the v1 record, helpers, guards, 018\'s HMAC and 034\'s reader not tmpos_app\'s; no runtime role holds any table privilege; the login is refused (42501)', async () => {
  for (const sig of ROUTINES) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME, 'tmpos_app'), sig);
  for (const sig of OWNER_ONLY) assert.deepEqual(await grantsOf(sig), EXECUTE_BY(ME), sig);
  assert.equal((await owner`select pg_catalog.to_regprocedure(${PROOF_V0})::text as p`)[0].p, null, 'the proof without p_wait_ms no longer exists');
  const fn = async (role, sig) => (await owner`select pg_catalog.has_function_privilege(${role}, ${sig}::regprocedure, 'EXECUTE') as e`)[0].e;
  for (const sig of ROUTINES) assert.equal(await fn('tmpos_app', sig), true, sig);
  for (const sig of [...OWNER_ONLY, 'tmpos_mint.hmac_sha256(bytea, bytea)', 'tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)']) {
    assert.equal(await fn('tmpos_app', sig), false, `tmpos_app cannot execute ${sig}`);
  }
  for (const role of ['tmpos_audit_writer', 'anon', 'authenticated']) for (const sig of [...ROUTINES, ...OWNER_ONLY]) assert.equal(await fn(role, sig), false, `${role} ${sig}`);
  for (const role of ['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated', RUNTIME_LOGIN]) {
    for (const t of TABLES) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const [{ e }] = await owner`select pg_catalog.has_table_privilege(${role}, ${t}::regclass, ${priv}) as e`;
        assert.equal(e, false, `${role} ${priv} on ${t}`);
      }
    }
  }
  const [rls] = await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_class c where c.oid = any(${TABLES}::regclass[]) and c.relrowsecurity and not c.relforcerowsecurity`;
  assert.equal(rls.n, 3, 'row security enabled, unforced, on the three tables');
  for (const sql of [`select * from ${KEY_TABLE}`, `select * from ${GEN_TABLE}`, `select * from ${REG_TABLE}`,
    `select tmpos_mint.hmac_sha256('\\x00'::bytea, '\\x00'::bytea)`,
    `select * from ${NS}.m7b_invoice_payment_record('k', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}', 1, 'cash', '${randomUUID()}')`]) {
    const err = await errorOf(runtime.unsafe(sql));
    assert.equal(err?.code, '42501', `the login is refused: ${sql.slice(0, 60)}`);
  }
  assert.deepEqual(await probeCall(), [{ o_present: true, o_generation: String(PK.generation) }], 'the probe: present and the generation only');
});

// ===========================================================================
// IRR-04..07: issuance, recording and durability
// ===========================================================================

test('IRR-04: the happy path — register, the proof (an independent HMAC; the same again), record v2 -> EXACTLY ONE payment row and ONE payment audit row, the registration recorded; the list; settle 1 conflicts, 2 applies, 2 again unchanged; the slot released', async () => {
  const f = await scene('happy');
  const inv = f.inv[0];
  const r = await registered(f, inv);
  const regAudit = await owner`select action_id, reason_code, subject_invoice_payment_registration_id as reg, subject_invoice_payment_id as pay, metadata
    from public.audit_event where event_id = ${r.event}`;
  assert.deepEqual(regAudit.map((x) => ({ ...x })), [{ action_id: 'store.invoice_payment.register', reason_code: 'invoice_payment_attempt_registered', reg: r.registration, pay: null, metadata: {} }]);
  // The slot: another attempt (or the same) on this invoice conflicts while this one is unsettled.
  assert.deepEqual(await registerCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T }), NO_REG('conflict'));
  assert.deepEqual(await registerCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt: r.attempt }), NO_REG('conflict'));
  const proof = await proofOf(f, r);
  assert.equal(await proofOf(f, r), proof, 'a lost proof answer: the same proof again, nothing written');
  const payment = randomUUID();
  const before = await writesOf(f.T);
  const rec = await recordWith(f, r, proof, { payment, amount: 5000 });
  assert.equal(rec.length, 1);
  const { o_audit_event_id: event, ...rest } = rec[0];
  assert.deepEqual(rest, { o_outcome: 'applied', o_tenant_id: f.T, o_store_id: f.S, o_actor_id: f.boss.id, o_membership_id: f.boss.memberships[0], o_payment_id: payment, o_invoice_id: inv });
  const after = await writesOf(f.T);
  assert.equal(after.payments, before.payments + 1, 'exactly ONE payment row');
  assert.equal(after.audits, before.audits + 1, 'exactly ONE audit row');
  const payRows = await owner`select payment_id, attempt_id, amount_cents::text as amount, recorded_by from tmpos_invoice_payment.invoice_payment where invoice_id = ${inv}`;
  assert.deepEqual(payRows.map((x) => ({ ...x })), [{ payment_id: payment, attempt_id: r.attempt, amount: '5000', recorded_by: f.boss.id }]);
  const payAudit = await owner`select event_id, action_id, subject_invoice_payment_registration_id as reg, evaluated_by from public.audit_event where subject_invoice_payment_id = ${payment}`;
  assert.deepEqual(payAudit.map((x) => ({ ...x })), [{ event_id: event, action_id: 'store.invoice_payment.record', reg: r.registration, evaluated_by: 'm7b_invoice_payment_routine@v2' }], 'ONE payment audit entry');
  assert.equal((await rowOf(r.registration)).j.payment_id, payment, 'the registration recorded by exactly this payment');
  // A replay of the same record: already_recorded, nothing written; the proof is no longer served (not open).
  const mid = await writesOf(f.T);
  assert.deepEqual(await recordWith(f, r, proof, { payment, amount: 5000 }), NO_REC('already_recorded'));
  assert.deepEqual(await proofCall(r.key, { store: f.S, invoice: inv, tenant: f.T, registration: r.registration }), NO_PRF('not_found'));
  assert.deepEqual(await writesOf(f.T), mid, 'nothing written by the replay or the proof');
  // The list: recorded, version 2, the payment; never the registration id.
  const list = await attemptsCall(f.kBoss, { store: f.S, tenant: f.T });
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], o_registered_at: typeof list[0].o_registered_at, o_recorded_at: typeof list[0].o_recorded_at }, {
    o_outcome: 'attempt', o_tenant_id: f.T, o_store_id: f.S, o_invoice_id: inv, o_invoice_number: list[0].o_invoice_number, o_attempt_id: r.attempt,
    o_state: 'recorded', o_version: '2', o_registered_at: 'string', o_settled_at: null, o_payment_id: payment, o_amount_cents: '5000', o_method: 'cash',
    o_recorded_at: 'string', o_reversed_at: null, o_reason_code: null });
  assert.ok(!JSON.stringify(list).includes(r.registration), 'the list never carries the registration id');
  // Settlement, version-checked.
  assert.deepEqual(await settleCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt: r.attempt, version: 1 }), NO_SET('conflict'));
  const s = await settleCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt: r.attempt, version: 2 });
  assert.equal(s[0].o_outcome, 'applied');
  assert.equal(s[0].o_version, '3');
  const settleAudit = await owner`select action_id, reason_code from public.audit_event where event_id = ${s[0].o_audit_event_id}`;
  assert.deepEqual(settleAudit.map((x) => ({ ...x })), [{ action_id: 'store.invoice_payment.settle', reason_code: 'invoice_payment_attempt_confirmed' }]);
  const beforeRepeat = await writesOf(f.T);
  const again = await settleCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt: r.attempt, version: 2 });
  assert.deepEqual(again.map((x) => [x.o_outcome, x.o_version, x.o_audit_event_id]), [['unchanged', '3', null]]);
  assert.deepEqual(await writesOf(f.T), beforeRepeat, 'unchanged writes nothing');
  assert.deepEqual((await attemptsCall(f.kBoss, { store: f.S, tenant: f.T })).map((x) => [x.o_state, x.o_version]), [['confirmed', '3']]);
  // Released: a new attempt registers; the settled attempt id itself is already_recorded.
  assert.deepEqual(await registerCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt: r.attempt }), NO_REG('already_recorded'));
  await registered(f, inv);
});

test('IRR-05: the same transaction and a savepoint — the proof is not_found and the record (with the correct proof) not_found; after COMMIT, another transaction gets the proof and records', async () => {
  const f = await scene('sametx');
  const inv = f.inv[0];
  let r;
  let top;
  await runtime.begin(RC, async (tx) => {
    r = await registered(f, inv, { db: tx });
    top = (await tx`select pg_catalog.pg_current_xact_id()::text as x`)[0].x;
    assert.deepEqual(await proofCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, registration: r.registration, db: tx }), NO_PRF('not_found'), 'same transaction');
    await tx.savepoint(async (sp) => {
      assert.deepEqual(await proofCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, registration: r.registration, db: sp }), NO_PRF('not_found'), 'inside a savepoint');
      assert.deepEqual(await recordWith(f, r, expected(f, r), { db: sp }), NO_REC('not_found'), 'record inside a savepoint');
    });
    assert.deepEqual(await recordWith(f, r, expected(f, r), { db: tx }), NO_REC('not_found'), 'record in the registering transaction');
  });
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where invoice_id = ${inv}`)[0].n, 0, 'no payment from the registering transaction');
  const [x] = await owner`select g.registered_xact::text as x, g.xmin::text as xmin from tmpos_invoice_payment.invoice_payment_registration g where g.registration_id = ${r.registration}`;
  assert.equal(x.x, top, 'registered_xact is the registering TOP-LEVEL transaction');
  assert.notEqual(x.xmin, top, 'the row\'s xmin is the routine\'s subtransaction (its insert runs in an exception block): xmin would not do');
  const proof = await proofOf(f, r);
  assert.equal((await recordWith(f, r, proof))[0].o_outcome, 'applied', 'after COMMIT, from another transaction');
});

test('IRR-06: a rolled-back registration — proof and record not_found, no row, no audit; the slot is free', async () => {
  const f = await scene('rollback');
  const inv = f.inv[0];
  let r;
  await assert.rejects(runtime.begin(RC, async (tx) => { r = await registered(f, inv, { db: tx }); throw ROLLBACK; }), (e) => e === ROLLBACK);
  assert.deepEqual(await proofCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, registration: r.registration }), NO_PRF('not_found'));
  assert.deepEqual(await recordWith(f, r, expected(f, r)), NO_REC('not_found'));
  assert.equal(await rowOf(r.registration), null);
  const [{ n }] = await owner`select count(*)::int as n from public.audit_event where subject_invoice_payment_registration_id = ${r.registration} or event_id = ${r.event}`;
  assert.equal(n, 0);
  await registered(f, inv, { attempt: r.attempt });
});

test('IRR-07: PRE-FLUSH ISSUANCE REFUSED — the registering connection commits with synchronous_commit=off and the WAL writer slowed; the proof ANSWERS (not_durable, NULLs) within the bounded p_wait_ms, writing nothing and never raising; p_wait_ms 0 is the same strict comparison without a wait; p_wait_ms null, -1 or 1001 is invalid_parameter_value; after a durable commit the retried proof issues (p_wait_ms 0 included)', async () => {
  const f = await scene('preflush', { invoices: 1 });
  const inv = f.inv[0];
  assert.equal((await registrar`select pg_catalog.current_setting('synchronous_commit') as s`)[0].s, 'off');
  for (const wait of [null, -1, 1001]) {
    const err = await errorOf(proofCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, registration: randomUUID(), wait }));
    assert.deepEqual({ code: err?.code, message: err?.message }, { code: '22023', message: 'migration 037 proof: an argument is malformed' }, `p_wait_ms ${wait}`);
  }
  await setWalWriterDelay('10s');
  let caught = null;
  try {
    for (let i = 0; i < 40 && caught === null; i += 1) {
      const r = await registered(f, inv, { db: registrar });
      const row = await rowOf(r.registration);
      const t0 = Date.now();
      const rows = await proofCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, registration: r.registration });
      const waited = Date.now() - t0;
      if (rows[0]?.o_outcome === 'not_durable') {
        assert.deepEqual(rows, NO_PRF('not_durable'), 'the answer: not_durable, every other column NULL');
        assert.ok(waited >= 1000 && waited < 2000, `the answer is bounded by p_wait_ms: ${waited} ms`);
        assert.deepEqual(await rowOf(r.registration), row, 'the answer did not alter the registration');
        const t1 = Date.now();
        assert.deepEqual(await proofCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, registration: r.registration, wait: 0 }), NO_PRF('not_durable'),
          'p_wait_ms 0: the same strict comparison');
        assert.ok(Date.now() - t1 < 500, `p_wait_ms 0 does not wait: ${Date.now() - t1} ms`);
        assert.deepEqual(await rowOf(r.registration), row, 'still unaltered');
        caught = r;
      } else {
        // Flushed already (the WAL writer or another commit ran): withdraw it (a durable commit) and try again.
        assert.equal(rows[0]?.o_outcome, 'proof', 'otherwise the proof');
        assert.equal((await settleCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt: r.attempt, version: 1 }))[0].o_outcome, 'applied');
      }
    }
    assert.ok(caught !== null, 'a visible-but-unflushed registration was answered not_durable');
    // An unrelated durable commit (it writes WAL, so its commit is flushed synchronously) flushes past the registration.
    await owner`select pg_catalog.pg_logical_emit_message(true, 'irr-flush', 'x')`;
    assert.equal(await proofOf(f, caught, { wait: 0 }), await proofOf(f, caught), 'issued at once with p_wait_ms 0, the same proof');
  } finally {
    await setWalWriterDelay(null);
  }
});

// ===========================================================================
// IRR-08..11: binding, key loss and rotation, concurrency
// ===========================================================================

test('IRR-08: mismatched attempt id, registration id, proof, session or actor — one not_found each, NO ledger or audit write; the matching record then applies', async () => {
  const f = await scene('mismatch', { invoices: 2 });
  const [i0, i1] = f.inv;
  const rA = await registered(f, i0);
  const pA = await proofOf(f, rA);
  const rB = await registered(f, i1, { attempt: rA.attempt });
  const pB = await proofOf(f, rB);
  const otherBossKey = await mint(f.boss); // the same staff member's replacement session
  const before = await writesOf(f.T);
  const cases = [
    ['another attempt id', () => recordWith(f, rA, pA, { attempt: randomUUID() })],
    ['another registration id', () => recordWith(f, rA, pA, { registration: randomUUID() })],
    ['another registration\'s id and proof', () => recordWith(f, rA, pB, { registration: rB.registration })],
    ['a wrong proof', () => recordWith(f, rA, '0'.repeat(64))],
    ['the proof on another invoice', () => recordWith(f, rB, pA)],
    ['a replacement session', () => recordWith(f, rA, pA, { key: otherBossKey })],
    ['another staff member', () => recordCall(f.kManager, { store: f.S, invoice: i0, tenant: f.T, registration: rA.registration, attempt: rA.attempt, proof: pA })],
  ];
  for (const [label, call] of cases) assert.deepEqual(await call(), NO_REC('not_found'), label);
  assert.deepEqual(await proofCall(otherBossKey, { store: f.S, invoice: i0, tenant: f.T, registration: rA.registration }), NO_PRF('not_found'), 'proof from a replacement session');
  assert.deepEqual(await proofCall(f.kBoss, { store: f.S, invoice: i1, tenant: f.T, registration: rA.registration }), NO_PRF('not_found'), 'proof on another invoice');
  assert.deepEqual(await writesOf(f.T), before, 'no ledger, registration or audit write by any mismatch');
  assert.equal((await recordWith(f, rA, pA))[0].o_outcome, 'applied');
});

test('IRR-09: key missing — register, proof and record raise 55000 writing nothing; the probe answers absent; the list and settle keep working; a new key restores issuance', async () => {
  const f = await scene('nokey', { invoices: 2 });
  const [i0, i1] = f.inv;
  const r = await registered(f, i0);
  const proof = await proofOf(f, r);
  await owner`delete from tmpos_invoice_payment.payment_proof_key where singleton`;
  try {
    assert.deepEqual(await probeCall(), [{ o_present: false, o_generation: null }]);
    const before = await writesOf(f.T);
    const regErr = await errorOf(registerCall(f.kBoss, { store: f.S, invoice: i1, tenant: f.T }));
    assert.deepEqual([regErr?.code, regErr?.message], ['55000', 'migration 037 register: the payment proof key is not installed']);
    assert.equal((await errorOf(proofCall(f.kBoss, { store: f.S, invoice: i0, tenant: f.T, registration: r.registration })))?.message, 'migration 037 proof: the payment proof key is not installed');
    assert.equal((await errorOf(recordWith(f, r, proof)))?.message, 'migration 037 record: the payment proof key is not installed');
    assert.deepEqual(await writesOf(f.T), before, 'nothing written');
    assert.deepEqual((await attemptsCall(f.kBoss, { store: f.S, tenant: f.T })).map((x) => [x.o_attempt_id, x.o_state]), [[r.attempt, 'open']], 'the list works');
    assert.equal((await settleCall(f.kBoss, { store: f.S, invoice: i0, tenant: f.T, attempt: r.attempt, version: 1 }))[0].o_outcome, 'applied', 'settle works');
  } finally {
    await installProofKey();
  }
  const r2 = await registered(f, i1);
  assert.equal((await recordWith(f, r2, await proofOf(f, r2)))[0].o_outcome, 'applied', 'a new key restores issuance');
});

test('IRR-10: key rotation — the old registration is unsendable (proof and record not_found under either key), its slot held until settled; reinstalling retired bytes (zero-padded included), a non-increasing generation, a malformed key (fixed text, no key bytes) and any history change are refused by the database', async () => {
  const f = await scene('rotate', { invoices: 1 });
  const inv = f.inv[0];
  const old = PK;
  const r = await registered(f, inv);
  const pOld = await proofOf(f, r);
  const fresh = await installProofKey(); // an UPDATE of the singleton: the rotation
  assert.equal(fresh.generation, old.generation + 1n);
  assert.deepEqual(await probeCall(), [{ o_present: true, o_generation: String(fresh.generation) }]);
  const before = await writesOf(f.T);
  assert.deepEqual(await proofCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, registration: r.registration }), NO_PRF('not_found'), 'the old registration is unsendable');
  assert.deepEqual(await recordWith(f, r, pOld), NO_REC('not_found'), 'the old proof');
  assert.deepEqual(await recordWith(f, r, expected(f, r, { key: fresh.key, generation: old.generation })), NO_REC('not_found'), 'the new key, the old generation');
  assert.deepEqual(await recordWith(f, r, expected(f, r, fresh)), NO_REC('not_found'), 'the new key and generation: the registration is the old one\'s');
  assert.deepEqual(await registerCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T }), NO_REG('conflict'), 'the slot is held');
  assert.deepEqual(await writesOf(f.T), before, 'nothing written');
  assert.deepEqual((await attemptsCall(f.kBoss, { store: f.S, tenant: f.T })).map((x) => [x.o_attempt_id, x.o_state, x.o_version]), [[r.attempt, 'open', '1']]);
  assert.equal((await settleCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt: r.attempt, version: 1 }))[0].o_outcome, 'applied');
  const r2 = await registered(f, inv);
  assert.equal((await recordWith(f, r2, await proofOf(f, r2)))[0].o_outcome, 'applied', 'a new registration under the new generation records');
  // The database refuses to revive a retired generation, however the owner tries.
  const high = fresh.generation;
  const refusals = [
    ['retired bytes, a higher generation', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set key = ${old.key}, generation = ${String(high + 5n)}::bigint where singleton`, 'migration 037: a payment proof key that was ever installed is never installed again'],
    ['retired bytes after removal', async (tx) => { await tx`delete from tmpos_invoice_payment.payment_proof_key`; await tx`insert into tmpos_invoice_payment.payment_proof_key (key, generation) values (${old.key}, ${String(high + 9n)}::bigint)`; }, 'migration 037: a payment proof key that was ever installed is never installed again'],
    ['the current bytes again', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set generation = ${String(high + 1n)}::bigint where singleton`, 'migration 037: a payment proof key that was ever installed is never installed again'],
    ['new bytes, the same generation', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set key = ${randomBytes(32)} where singleton`, 'migration 037: a payment proof key is installed only under a generation above every earlier one'],
    ['new bytes, a lower generation', async (tx) => { await tx`delete from tmpos_invoice_payment.payment_proof_key`; await tx`insert into tmpos_invoice_payment.payment_proof_key (key, generation) values (${randomBytes(32)}, ${String(old.generation)}::bigint)`; }, 'migration 037: a payment proof key is installed only under a generation above every earlier one'],
    ['a history row changed', (tx) => tx`update tmpos_invoice_payment.payment_proof_key_generation set key_digest = ${randomBytes(32)} where generation = ${String(old.generation)}::bigint`, 'migration 037: an installed payment proof key generation is never changed or removed'],
    ['a history row removed', (tx) => tx`delete from tmpos_invoice_payment.payment_proof_key_generation where generation = ${String(old.generation)}::bigint`, 'migration 037: an installed payment proof key generation is never changed or removed'],
    ['the history truncated', (tx) => tx`truncate tmpos_invoice_payment.payment_proof_key_generation`, 'migration 037: an installed payment proof key generation is never changed or removed'],
  ];
  for (const [label, fn, message] of refusals) assert.deepEqual(await rolledBack(fn), { code: '23001', message }, label);
  // A retired (or the current) key with zero bytes appended is the same HMAC key (018 pads to the 64-byte block): refused.
  const zeros = (n) => Buffer.alloc(n);
  for (const [label, bytes] of [['retired bytes + one zero byte', Buffer.concat([old.key, zeros(1)])],
    ['retired bytes zero-padded to 64', Buffer.concat([old.key, zeros(64 - old.key.length)])],
    ['current bytes + one zero byte', Buffer.concat([fresh.key, zeros(1)])]]) {
    assert.deepEqual(await rolledBack((tx) => tx`update tmpos_invoice_payment.payment_proof_key set key = ${bytes}, generation = ${String(high + 7n)}::bigint where singleton`),
      { code: '23001', message: 'migration 037: a payment proof key that was ever installed is never installed again' }, label);
  }
  const [{ d }] = await owner`select key_digest as d from tmpos_invoice_payment.payment_proof_key_generation where generation = ${String(fresh.generation)}::bigint`;
  assert.deepEqual(d, createHash('sha256').update(Buffer.concat([fresh.key, zeros(64 - fresh.key.length)])).digest(), 'the history digest is over the zero-padded 64-byte block');
  // A malformed install raises the shape guard's fixed text before any NOT NULL or CHECK constraint could echo the row (the key).
  const SHAPE = 'migration 037: a payment proof key is the one row, 32 to 64 bytes, under a generation from 1 to 2^53 - 1';
  const b31 = randomBytes(31), b65 = randomBytes(65), b32 = randomBytes(32);
  const malformed = [
    ['a 31-byte key', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set key = ${b31}, generation = ${String(high + 3n)}::bigint where singleton`],
    ['a 65-byte key', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set key = ${b65}, generation = ${String(high + 3n)}::bigint where singleton`],
    ['a NULL key', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set key = null where singleton`],
    ['a NULL generation', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set generation = null where singleton`],
    ['generation 0', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set generation = 0 where singleton`],
    ['generation 2^53', (tx) => tx`update tmpos_invoice_payment.payment_proof_key set generation = 9007199254740992 where singleton`],
    ['singleton false', async (tx) => { await tx`delete from tmpos_invoice_payment.payment_proof_key`; await tx`insert into tmpos_invoice_payment.payment_proof_key (singleton, key, generation) values (false, ${b32}, ${String(high + 3n)}::bigint)`; }],
    ['singleton NULL', async (tx) => { await tx`delete from tmpos_invoice_payment.payment_proof_key`; await tx`insert into tmpos_invoice_payment.payment_proof_key (singleton, key, generation) values (null, ${b32}, ${String(high + 3n)}::bigint)`; }],
    ['an upsert to a NULL generation', (tx) => tx`insert into tmpos_invoice_payment.payment_proof_key (singleton, key, generation) values (true, ${b32}, ${String(high + 3n)}::bigint)
      on conflict (singleton) do update set generation = null`],
  ];
  for (const [label, fn] of malformed) {
    const err = await fullRefusal(fn);
    assert.deepEqual([err?.code, err?.message, err?.detail, err?.hint], ['23001', SHAPE, null, null], `${label}: expected the fixed 23001 shape refusal, got SQLSTATE ${err?.code ?? 'none'} (output withheld)`);
    assertNoBytes(err, [b31, b65, b32, fresh.key, old.key], label);
  }
  assert.deepEqual(await probeCall(), [{ o_present: true, o_generation: String(fresh.generation) }], 'the installed key unchanged by every refusal');
});

test('IRR-11: concurrent record and settlement, both orders, serialized on the issued header — record first: settle 1 conflicts, 2 applies, one payment; settle first: the record is invalid_state, no payment', async () => {
  const f = await scene('race', { invoices: 2 });
  const second = connect(RUNTIME_LOGIN, 2);
  try {
    // (a) the record holds the header; the settlement waits on it, then sees the payment.
    const r = await registered(f, f.inv[0]);
    const proof = await proofOf(f, r);
    let release;
    const gate = new Promise((res) => { release = res; });
    let holderPid = null;
    let holderReturned = false;
    const held = runtime.begin(RC, async (tx) => {
      holderPid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
      const out = await recordWith(f, r, proof, { db: tx });
      holderReturned = true; // the record has returned; its locks are held until this COMMIT
      await gate;
      return out;
    });
    // The waiter starts only once the holder's routine call has RETURNED (not merely begun).
    while (!holderReturned) await new Promise((res) => setTimeout(res, 10));
    let waiterPid = null;
    const waiting = second.begin(RC, async (tx) => {
      waiterPid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
      return settleCall(f.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T, attempt: r.attempt, version: 1, db: tx });
    });
    for (let i = 0; i < 500; i += 1) {
      if (waiterPid !== null && (await owner`select ${holderPid}::int = any(pg_catalog.pg_blocking_pids(${waiterPid}::int)) as b`)[0].b) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok((await owner`select ${holderPid}::int = any(pg_catalog.pg_blocking_pids(${waiterPid}::int)) as b`)[0].b, 'the settlement waits on the record');
    release();
    assert.equal((await held)[0].o_outcome, 'applied');
    assert.deepEqual(await waiting, NO_SET('conflict'), 'the settlement re-reads after the wait: recorded, so version 1 conflicts');
    assert.equal((await settleCall(f.kBoss, { store: f.S, invoice: f.inv[0], tenant: f.T, attempt: r.attempt, version: 2 }))[0].o_outcome, 'applied');
    assert.equal((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where invoice_id = ${f.inv[0]}`)[0].n, 1, 'exactly one payment');

    // (b) the settlement holds the header; the record waits, then sees the withdrawal.
    const r2 = await registered(f, f.inv[1]);
    const proof2 = await proofOf(f, r2);
    let release2;
    const gate2 = new Promise((res) => { release2 = res; });
    let holder2 = null;
    let holder2Returned = false;
    const held2 = runtime.begin(RC, async (tx) => {
      holder2 = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
      const out = await settleCall(f.kBoss, { store: f.S, invoice: f.inv[1], tenant: f.T, attempt: r2.attempt, version: 1, db: tx });
      holder2Returned = true; // the settlement has returned; its locks are held until this COMMIT
      await gate2;
      return out;
    });
    while (!holder2Returned) await new Promise((res) => setTimeout(res, 10));
    let waiter2 = null;
    const waiting2 = second.begin(RC, async (tx) => {
      waiter2 = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
      return recordWith(f, r2, proof2, { db: tx });
    });
    for (let i = 0; i < 500; i += 1) {
      if (waiter2 !== null && (await owner`select ${holder2}::int = any(pg_catalog.pg_blocking_pids(${waiter2}::int)) as b`)[0].b) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok((await owner`select ${holder2}::int = any(pg_catalog.pg_blocking_pids(${waiter2}::int)) as b`)[0].b, 'the record waits on the settlement');
    release2();
    assert.equal((await held2)[0].o_outcome, 'applied');
    assert.deepEqual(await waiting2, NO_REC('invalid_state'), 'the record re-reads after the wait: withdrawn');
    assert.equal((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where invoice_id = ${f.inv[1]}`)[0].n, 0, 'no payment');
  } finally {
    await second.end({ timeout: 5 });
  }
});

// ===========================================================================
// IRR-12..14: secrets, refusals, rollback guard
// ===========================================================================

test('IRR-12: secrets — with the caller\'s debug_print_* on, client_min_messages debug5 and plpgsql.print_strict_params on, no key, proof, session key or session digest appears in ANY notice or error text (the secrets reach the routines through settings, so the caller\'s own statements carry none and nothing is exempt) or audit row; the registration table stores none', async () => {
  const f = await scene('secret', { invoices: 2 });
  const notices = [];
  const loud = connect(RUNTIME_LOGIN, 1, { onnotice: (n) => notices.push(JSON.stringify(n)) });
  const LOUD = 'set client_min_messages = debug5; set debug_print_plan = on; set debug_print_parse = on; set debug_print_rewritten = on; set plpgsql.print_strict_params = on';
  const QUIET = 'set debug_print_plan = off; set debug_print_parse = off; set debug_print_rewritten = off; set client_min_messages = warning';
  // A secret is placed in a custom setting while nothing prints; the routines then read it through current_setting(), which is
  // STABLE and never folded into the caller's plan — so the caller's own statement text and trees carry no secret.
  const quietly = async (name, value) => {
    await loud.unsafe(QUIET).simple();
    await loud`select pg_catalog.set_config(${name}, ${value}, false)`;
    await loud.unsafe(LOUD).simple();
  };
  const K = "pg_catalog.current_setting('irr.k')";
  try {
    await loud.unsafe(LOUD).simple();
    await loud`select 1 as control`;
    assert.ok(notices.some((n) => n.includes('plan')), 'positive control: this session prints plans to the client');
    const canary = `irr-canary-${randomUUID()}`;
    await loud.unsafe('select $1::text as echo', [canary]);
    assert.ok(flat(notices).includes(decimalBytes(Buffer.from(canary, 'utf8'))), 'positive control: a value the caller passes IS echoed (a plan prints a constant as its decimal bytes), so the scan below can see one');
    await quietly('irr.k', f.kBoss);
    notices.length = 0;
    const registration = randomUUID();
    const attempt = randomUUID();
    const r = { registration, attempt, key: f.kBoss, who: f.boss, store: f.S, invoice: f.inv[0] };
    const [reg] = await plain(loud.unsafe(`select * from ${NS}.m7b_invoice_payment_register(${K}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)`,
      [f.S, f.inv[0], f.T, registration, attempt, randomUUID()]));
    assert.equal(reg.o_outcome, 'applied');
    const [prf] = await plain(loud.unsafe(`select * from ${NS}.m7b_invoice_payment_registration_proof(${K}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1000)`,
      [f.S, f.inv[0], f.T, registration]));
    const proof = prf.o_proof;
    assert.equal(proof, expected(f, r));
    const record = (proofSql, extra = []) => plain(loud.unsafe(`select * from ${NS}.m7b_invoice_payment_record_v2(${K}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8::text, ${proofSql}, $9::uuid)`,
      [f.S, f.inv[0], f.T, randomUUID(), registration, attempt, '1000', 'cash', randomUUID(), ...extra]));
    const errors = [];
    errors.push(await errorOf(record('$10::text', ['Z'.repeat(64)])));
    errors.push(await errorOf(record('$10::text', ['a'.repeat(63)])));
    assert.deepEqual(await record('$10::text', ['0'.repeat(64)]), NO_REC('not_found'));
    await quietly('irr.p', proof);
    assert.equal((await record("pg_catalog.current_setting('irr.p')"))[0].o_outcome, 'applied');
    await owner`delete from tmpos_invoice_payment.payment_proof_key where singleton`;
    try {
      errors.push(await errorOf(loud.unsafe(`select * from ${NS}.m7b_invoice_payment_register(${K}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)`,
        [f.S, f.inv[1], f.T, randomUUID(), randomUUID(), randomUUID()])));
      errors.push(await errorOf(loud.unsafe(`select * from ${NS}.m7b_invoice_payment_registration_proof(${K}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1000)`,
        [f.S, f.inv[0], f.T, registration])));
    } finally {
      await installProofKey();
    }
    const allNotices = flat(notices);
    assert.ok(notices.length > 0 && allNotices.includes('plan'), 'the calls themselves were traced');
    const keyHex = PK.key.toString('hex');
    const secrets = { proof, key: keyHex, keyB64: PK.key.toString('base64'), sessionKey: f.kBoss, digest: sessionDigest(f.kBoss).toString('hex'),
      digestB64: sessionDigest(f.kBoss).toString('base64'), issuer: ISSUER_KEY.toString('hex') };
    const audits = (await owner`select pg_catalog.to_jsonb(a)::text as t from public.audit_event a where a.tenant_id = ${f.T}`).map((x) => x.t).join('\n');
    const regRows = (await owner`select pg_catalog.to_jsonb(g)::text as t from tmpos_invoice_payment.invoice_payment_registration g where g.tenant_id = ${f.T}`).map((x) => x.t).join('\n');
    const errorText = JSON.stringify(errors);
    assert.ok(errors.every((e) => e !== null && ['22023', '55000'].includes(e.code)), errorText);
    for (const [name, value] of Object.entries(secrets)) {
      assert.ok(!audits.includes(value), `${name} is in no audit row`);
      assert.ok(!errorText.includes(value), `${name} is in no error text`);
      assert.ok(!allNotices.includes(value), `${name} is in no notice (none exempt)`);
    }
    // A node tree prints a constant as its decimal bytes: no secret's bytes, in that form, in any notice or error either.
    for (const [name, bytes] of Object.entries({ proof: Buffer.from(proof, 'utf8'), key: PK.key, sessionKey: Buffer.from(f.kBoss, 'utf8'),
      digest: sessionDigest(f.kBoss), issuer: ISSUER_KEY })) {
      assert.ok(!flat(notices).includes(decimalBytes(bytes)) && !flat([errorText]).includes(decimalBytes(bytes)), `${name}'s bytes are in no notice or error`);
    }
    assert.ok(!regRows.includes(proof) && !regRows.includes(keyHex) && !regRows.includes(f.kBoss), 'the registration row holds no proof, key or session key');
    const [cols] = await owner`select pg_catalog.string_agg(a.attname::text, ',' order by a.attnum) as c from pg_catalog.pg_attribute a
      where a.attrelid = ${REG_TABLE}::regclass and a.attnum > 0 and not a.attisdropped`;
    assert.equal(cols.c, 'registration_id,tenant_id,store_id,invoice_id,registered_by,attempt_id,session_digest,key_generation,registered_xact,registered_at,payment_id,acknowledged_at');
  } finally {
    await loud.end({ timeout: 5 });
  }
});

test('IRR-13: decision order and refusals — refused (a level below Approve), tenant_mismatch, not_found (another store\'s invoice), invalid_state (voided; a withdrawn attempt reused), denied reads; another staff member\'s attempt id registers as a fresh one; REPEATABLE READ refused (55000)', async () => {
  const f = await scene('order', { invoices: 2 });
  const other = await f.issue(f.S2);
  const [i0, i1] = f.inv;
  assert.deepEqual(await registerCall(f.kTech, { store: f.S, invoice: i0, tenant: f.T }), NO_REG('refused'), 'Invoices View is below Approve');
  assert.deepEqual(await attemptsCall(f.kTech, { store: f.S, tenant: f.T }), [{ ...Object.fromEntries(['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_invoice_number', 'o_attempt_id', 'o_state', 'o_version', 'o_registered_at', 'o_settled_at', 'o_payment_id', 'o_amount_cents', 'o_method', 'o_recorded_at', 'o_reversed_at', 'o_reason_code'].map((c) => [c, null])), o_outcome: 'denied' }]);
  // The list refuses a malformed session key with fixed text before anything is read, as the other four session definers do.
  for (const bad of ['', 'has space', 'x'.repeat(129), 'café', 'tab\there']) {
    const err = await errorOf(attemptsCall(bad, { store: f.S, tenant: f.T }));
    assert.deepEqual({ code: err?.code, message: err?.message }, { code: '22023', message: 'migration 037 attempts: an argument is malformed' },
      `malformed key of length ${bad.length}`);
  }
  assert.equal((await attemptsCall('x'.repeat(128), { store: f.S, tenant: f.T }))[0].o_outcome, 'denied', 'a well-formed unknown key reads as denied, not malformed');
  assert.deepEqual(await registerCall(f.kBoss, { store: f.S, invoice: i0, tenant: randomUUID() }), NO_REG('tenant_mismatch'));
  assert.deepEqual(await registerCall(f.kBoss, { store: f.S, invoice: other, tenant: f.T }), NO_REG('not_found'), 'another store\'s invoice');
  assert.deepEqual(await settleCall(f.kBoss, { store: f.S, invoice: other, tenant: f.T, attempt: randomUUID(), version: 1 }), NO_SET('not_found'));
  assert.deepEqual(await settleCall(f.kBoss, { store: f.S, invoice: i0, tenant: f.T, attempt: randomUUID(), version: 1 }), NO_SET('not_found'), 'no registration of this attempt');
  assert.deepEqual(await proofCall(f.kTech, { store: f.S, invoice: i0, tenant: f.T, registration: randomUUID() }), NO_PRF('denied'));
  // Another staff member's attempt id registers exactly as a fresh one.
  const m = await registered(f, i0, { who: f.manager, key: f.kManager });
  const b = await registered(f, i0, { attempt: m.attempt });
  // A withdrawn attempt id is not reused.
  assert.equal((await settleCall(f.kBoss, { store: f.S, invoice: i0, tenant: f.T, attempt: b.attempt, version: 1 }))[0].o_outcome, 'applied');
  assert.deepEqual(await registerCall(f.kBoss, { store: f.S, invoice: i0, tenant: f.T, attempt: b.attempt }), NO_REG('invalid_state'));
  // A recorded payment on the invoice under the manager's attempt id: the boss's record of the same attempt id is invalid_state.
  assert.equal((await recordWith(f, m, await proofOf(f, m)))[0].o_outcome, 'applied');
  const b2 = await registered(f, i0, { attempt: randomUUID() });
  assert.equal(b2.registration.length, 36);
  // A voided invoice takes no registration.
  const [v] = await runtime.unsafe(`select o_outcome from ${VOID2_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`, [f.kBoss, f.S, i1, f.T, '1', 'issued_in_error']);
  assert.equal(v.o_outcome, 'applied');
  assert.deepEqual(await registerCall(f.kBoss, { store: f.S, invoice: i1, tenant: f.T }), NO_REG('invalid_state'), 'voided');
  for (const [label, call] of [
    ['register', (tx) => registerCall(f.kBoss, { store: f.S, invoice: i0, tenant: f.T, db: tx })],
    ['proof', (tx) => proofCall(f.kBoss, { store: f.S, invoice: i0, tenant: f.T, registration: b2.registration, db: tx })],
    ['record', (tx) => recordWith(f, b2, '0'.repeat(64), { db: tx })],
    ['settle', (tx) => settleCall(f.kBoss, { store: f.S, invoice: i0, tenant: f.T, attempt: b2.attempt, version: 1, db: tx })],
  ]) {
    const err = await errorOf(runtime.begin('isolation level repeatable read', call));
    assert.equal(err?.code, '55000', `${label} under REPEATABLE READ: expected 55000, got SQLSTATE ${err?.code ?? 'none'} (output withheld)`);
  }
});

test('IRR-14: 037\'s down refuses (55000, fixed text) while a registration exists, changing nothing', async () => {
  const before = await catalogOf();
  const out = await rolledBack((tx) => tx.unsafe(DOWN_037).simple());
  assert.deepEqual(out, { code: '55000', message: 'migration 037 rollback refused: a payment registration exists, and a rollback never removes one' });
  assert.deepEqual(await catalogOf(), before);
  assert.equal(await applied037(), true);
});

// ===========================================================================
// IRR-15..18: record v2's refusal order and the slot, the expiry after the key's lock wait, the WAL page boundary through
// the real routines, the registration guard's fixed text
// ===========================================================================

const totalOf = async (invoice) => BigInt((await owner`select total_cents::text as t from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice}`)[0].t);
const paymentsOn = async (invoice) => (await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where invoice_id = ${invoice}`)[0].n;

test('IRR-15: record v2 refusal order — voided before amount, amount before the attempt already taken (invalid_state, another staff member\'s record of it, exactly one payment); a slot held by a recorded-but-unconfirmed registration refuses a new one (conflict); nothing written by any refusal', async () => {
  const f = await scene('recorder', { invoices: 2 });
  const [i0, i1] = f.inv;
  const total = await totalOf(i0);
  // The manager records attempt X (one cent); the store owner registered the SAME attempt id (his own) and holds its proof.
  const m = await registered(f, i0, { who: f.manager, key: f.kManager });
  const b = await registered(f, i0, { attempt: m.attempt });
  const pM = await proofOf(f, m);
  const pB = await proofOf(f, b);
  assert.equal((await recordWith(f, m, pM, { amount: 1 }))[0].o_outcome, 'applied');
  let before = await writesOf(f.T);
  assert.deepEqual(await recordWith(f, b, pB, { amount: String(total) }), NO_REC('amount_exceeds_remaining'), 'the amount is checked before the attempt id');
  assert.deepEqual(await recordWith(f, b, pB, { amount: 1 }), NO_REC('invalid_state'), 'another staff member\'s record took the attempt id');
  assert.deepEqual(await writesOf(f.T), before, 'nothing written');
  assert.equal(await paymentsOn(i0), 1, 'exactly one payment');
  // The manager's registration is recorded but unconfirmed: his slot on i0 is held.
  assert.deepEqual(await registerCall(f.kManager, { store: f.S, invoice: i0, tenant: f.T }), NO_REG('conflict'), 'recorded-but-unconfirmed holds the slot');
  assert.deepEqual(await writesOf(f.T), before, 'nothing written');
  // Over the remaining amount on an open invoice.
  const o = await registered(f, i1);
  const pO = await proofOf(f, o);
  before = await writesOf(f.T);
  assert.deepEqual(await recordWith(f, o, pO, { amount: String((await totalOf(i1)) + 1n) }), NO_REC('amount_exceeds_remaining'));
  assert.deepEqual(await writesOf(f.T), before, 'nothing written');
  // Voided after the registration: invalid_state, ahead of the amount check.
  const [v] = await runtime.unsafe(`select o_outcome from ${VOID2_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text)`, [f.kBoss, f.S, i1, f.T, '1', 'issued_in_error']);
  assert.equal(v.o_outcome, 'applied');
  before = await writesOf(f.T);
  assert.deepEqual(await recordWith(f, o, pO, { amount: String((await totalOf(i1)) + 1n) }), NO_REC('invalid_state'), 'voided, before the amount');
  assert.deepEqual(await recordWith(f, o, pO, { amount: 1 }), NO_REC('invalid_state'), 'voided');
  assert.deepEqual(await writesOf(f.T), before, 'nothing written');
  assert.equal(await paymentsOn(i1), 0);
});

test('IRR-16: the session\'s expiry is checked AFTER the proof key\'s lock wait — a register and a record that wait on a held key row while their session expires are refused, nothing written', async () => {
  const f = await scene('keywait', { invoices: 0 });
  const a = connect(RUNTIME_LOGIN, 1);
  const b = connect(RUNTIME_LOGIN, 1);
  try {
    for (const lifetime of [4_000, 8_000, 16_000]) {
      const [i0, i1] = [await f.issue(), await f.issue()]; // fresh invoices: an attempt that did not engage leaves its rows behind
      const t0 = Date.now();
      const kShort = await mint(f.boss, { lifetime });
      const expiresBy = Date.now() + lifetime;
      const r = await registered(f, i0, { key: kShort });
      const proof = await proofOf(f, r);
      const before = await writesOf(f.T);
      let release;
      const gate = new Promise((res) => { release = res; });
      let holderPid = null;
      let holding = false;
      const held = owner.begin(RC, async (tx) => {
        holderPid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
        await tx`select 1 from tmpos_invoice_payment.payment_proof_key where singleton for update`; // a rotation in progress
        holding = true;
        await gate;
        throw ROLLBACK;
      }).catch((e) => { if (e !== ROLLBACK) throw e; });
      while (!holding) await new Promise((res) => setTimeout(res, 10));
      const pids = await Promise.all([a, b].map(async (c) => (await c`select pg_catalog.pg_backend_pid() as pid`)[0].pid));
      const recording = recordWith(f, r, proof, { db: a });
      const registering = registerCall(kShort, { store: f.S, invoice: i1, tenant: f.T, db: b });
      // Both wait in a lock queue whose head is the holder (the second queues behind the first on the same key row).
      const blocked = async () => (await owner`select count(*)::int as n from pg_catalog.pg_stat_activity a
        where a.pid = any(${pids}::int[]) and a.wait_event_type = 'Lock'
          and (${holderPid}::int = any(pg_catalog.pg_blocking_pids(a.pid)) or pg_catalog.pg_blocking_pids(a.pid) && ${pids}::int[])`)[0].n === 2;
      for (let i = 0; i < 250 && !(await blocked()); i += 1) await new Promise((res) => setTimeout(res, 20));
      const engaged = (await blocked()) && Date.now() < expiresBy - 200;
      if (engaged) while (Date.now() < expiresBy + 500) await new Promise((res) => setTimeout(res, 50));
      if (engaged) assert.ok(await blocked(), 'still waiting on the key row after the expiry');
      release();
      await held;
      const [rec, reg] = [await recording, await registering];
      if (!engaged) {
        // Too slow to engage before the expiry: settle whatever happened and retry with a longer lifetime.
        console.log(`IRR-16: lifetime ${lifetime} ms did not engage (${Date.now() - t0} ms; holder ${holderPid}, waiters ${pids}, record ${JSON.stringify(rec)}, register ${JSON.stringify(reg)})`);
        continue;
      }
      assert.deepEqual(rec, NO_REC('refused'), 'the record re-checks the expiry after the key wait');
      assert.deepEqual(reg, NO_REG('refused'), 'the register re-checks the expiry after the key wait');
      assert.deepEqual(await writesOf(f.T), before, 'nothing written');
      assert.equal(await paymentsOn(i0), 0);
      return;
    }
    assert.fail('IRR-16: no lifetime engaged the wait before the expiry');
  } finally {
    await Promise.allSettled([a.end({ timeout: 5 }), b.end({ timeout: 5 })]);
  }
});

// WAL arithmetic and the landing technique of tests/db/paymentProofDurability.integration.test.mjs (PDG-04), aimed here at the
// REAL register routine's commit and the REAL proof routine.
const SHORT_PHD = 24n;
const LONG_PHD = 40n;
const bigLsn = (l) => { const [hi, lo] = String(l).split('/'); return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`); };
const fmtLsn = (n) => `${(n >> 32n).toString(16).toUpperCase()}/${(n & 0xffffffffn).toString(16).toUpperCase()}`;
async function walLayout() {
  const [{ blk, seg }] = await owner`select wal_block_size::bigint as blk, bytes_per_wal_segment::bigint as seg from pg_catalog.pg_control_init()`;
  const w = { blk: BigInt(blk), seg: BigInt(seg) };
  w.ubp = w.blk - SHORT_PHD;
  w.ubs = (w.seg / w.blk) * w.ubp - (LONG_PHD - SHORT_PHD);
  return w;
}
function bytePos(w, ptr) { // PostgreSQL's XLogRecPtrToBytePos (xlog.c)
  const segs = ptr / w.seg, off = ptr % w.seg, pages = off / w.blk, inPage = off % w.blk;
  if (pages === 0n) return segs * w.ubs + (off > 0n ? off - LONG_PHD : 0n);
  return segs * w.ubs + (w.blk - LONG_PHD) + (pages - 1n) * w.ubp + (inPage > 0n ? inPage - SHORT_PHD : 0n);
}
const insertLsnOf = async (sql) => bigLsn((await sql`select pg_catalog.pg_current_wal_insert_lsn() as l`)[0].l);
const flushLsnOf = async (sql) => bigLsn((await sql`select pg_catalog.pg_current_wal_flush_lsn() as l`)[0].l);

test('IRR-17: the WAL page boundary through the REAL routines — a registration whose COMMIT ends exactly on a page boundary gets its proof within the budget while the flush is still below the raw L (no unrelated WAL rescues it)', async () => {
  const f = await scene('walpage', { invoices: 1 });
  const inv = f.inv[0];
  const w = await walLayout();
  const registerIn = (tx, attempt) => registerCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, registration: randomUUID(), attempt, db: tx });
  const withdraw = async (attempt) => assert.equal((await settleCall(f.kBoss, { store: f.S, invoice: inv, tenant: f.T, attempt, version: 1 }))[0].o_outcome, 'applied');
  // Calibrate the landing transaction's tail on the registrar: the pad message M(p) and the register path's COMMIT record C.
  const m = new Map();
  const commits = [];
  for (let p = 256; p <= 272; p += 1) {
    const attempt = randomUUID();
    let x;
    let y;
    await registrar.begin(RC, async (tx) => {
      assert.equal((await registerIn(tx, attempt))[0].o_outcome, 'applied');
      x = await insertLsnOf(tx);
      await tx`select pg_catalog.pg_logical_emit_message(true, 'irr-pad', ${'x'.repeat(p)})`;
      y = await insertLsnOf(tx);
    });
    const z = await insertLsnOf(registrar);
    m.set(p, bytePos(w, y) - bytePos(w, x));
    commits.push(bytePos(w, z) - bytePos(w, y));
    await withdraw(attempt);
  }
  let pStar = null;
  for (let p = 256; p < 272; p += 1) if (m.get(p + 1) - m.get(p) === 8n) { pStar = p; break; }
  assert.ok(pStar !== null, 'message size phase found');
  commits.sort((a, b) => Number(a - b));
  const tail = { pStar, mStar: m.get(pStar), commit: commits[commits.length >> 1] };
  for (let round = 0; round < 6; round += 1) {
    const from = await insertLsnOf(registrar);
    let target = ((from + 60_000n) / w.blk + 1n) * w.blk;
    if (target % w.seg === 0n) target += w.blk; // an ordinary page boundary, not a segment start
    const want = bytePos(w, target);
    let landed = null;
    for (let tries = 0; tries < 120 && landed === null; tries += 1) {
      const distance = want - bytePos(w, await insertLsnOf(registrar));
      const slack = tail.mStar + tail.commit + 12_000n; // room for the register's own WAL (full-page images included)
      if (distance < slack) break;
      if (distance > slack + 16_384n) {
        await registrar`select pg_catalog.pg_logical_emit_message(false, 'irr-fill', ${'x'.repeat(Number(distance - slack - 4096n))})`;
        continue;
      }
      const attempt = randomUUID();
      try {
        let reg;
        await registrar.begin(RC, async (tx) => {
          reg = await registerIn(tx, attempt);
          const need = want - bytePos(w, await insertLsnOf(tx)) - tail.commit;
          if (need < tail.mStar || (need - tail.mStar) % 8n !== 0n) throw new Error('retry');
          await tx`select pg_catalog.pg_logical_emit_message(true, 'irr-pad', ${'x'.repeat(Number(BigInt(tail.pStar) + need - tail.mStar))})`;
        });
        landed = { attempt, registration: reg[0].o_registration_id, after: await insertLsnOf(registrar) };
      } catch (e) {
        if (e.message !== 'retry') throw e;
      }
    }
    if (landed === null || landed.after !== target + SHORT_PHD) {
      console.log(`IRR-17: round ${round} missed the boundary ${fmtLsn(target)} (${landed === null ? 'not landed' : `insert ${fmtLsn(landed.after)}`}); retrying`);
      if (landed !== null) await withdraw(landed.attempt);
      continue;
    }
    const r = { registration: landed.registration, attempt: landed.attempt, key: f.kBoss, who: f.boss, store: f.S, invoice: inv };
    const t0 = Date.now();
    let proof;
    try {
      proof = await proofOf(f, r); // the real proof routine; asserts the independent HMAC
    } catch (e) {
      if ((await insertLsnOf(owner)) === target + SHORT_PHD) throw e; // no unrelated WAL: a real refusal
      console.log(`IRR-17: round ${round}: unrelated WAL during the proof (${e.message}); retrying`);
      await withdraw(r.attempt);
      continue;
    }
    const took = Date.now() - t0;
    const [after, flush] = [await insertLsnOf(owner), await flushLsnOf(owner)];
    if (after !== target + SHORT_PHD) {
      console.log(`IRR-17: round ${round}: unrelated WAL arrived (insert ${fmtLsn(after)}); retrying`);
      await withdraw(r.attempt);
      continue;
    }
    // Nothing was inserted after the commit, so the routine sampled L = target + 24 exactly; the flush never reached it.
    assert.ok(flush < target + SHORT_PHD, `issued with flush ${fmtLsn(flush)} below the raw L ${fmtLsn(target + SHORT_PHD)}`);
    assert.ok(flush >= target, 'the registration\'s commit itself is flushed');
    assert.ok(took < 1_500, `issued within the budget (${took} ms)`);
    console.log(`IRR-17: commit end ${fmtLsn(target)}, raw L ${fmtLsn(target + SHORT_PHD)}, flush ${fmtLsn(flush)}, proof in ${took} ms`);
    assert.equal((await recordWith(f, r, proof))[0].o_outcome, 'applied', 'and it records');
    return;
  }
  assert.fail('IRR-17: unrelated WAL interfered on every round');
});

test('IRR-18: the registration guard checks every mandatory column with fixed text before any NOT NULL or CHECK constraint could echo the row (the session digest)', async () => {
  const MSG = 'migration 037: a payment registration carries every mandatory column, a 32-byte session digest and a generation in range';
  const base = () => ({ registration_id: randomUUID(), tenant_id: randomUUID(), store_id: randomUUID(), invoice_id: randomUUID(),
    registered_by: randomUUID(), attempt_id: randomUUID(), session_digest: randomBytes(32), key_generation: '1', registered_xact: '1', registered_at: new Date() });
  const cases = [['a 31-byte digest', { session_digest: randomBytes(31) }], ['a 33-byte digest', { session_digest: randomBytes(33) }],
    ['a NULL digest', { session_digest: null }], ['a NULL generation', { key_generation: null }], ['generation 0', { key_generation: '0' }],
    ['a NULL transaction', { registered_xact: null }], ['a NULL registration id', { registration_id: null }], ['a NULL actor', { registered_by: null }]];
  for (const [label, patch] of cases) {
    const row = { ...base(), ...patch };
    const err = await fullRefusal((tx) => tx`insert into tmpos_invoice_payment.invoice_payment_registration
      (registration_id, tenant_id, store_id, invoice_id, registered_by, attempt_id, session_digest, key_generation, registered_xact, registered_at)
      values (${row.registration_id}, ${row.tenant_id}, ${row.store_id}, ${row.invoice_id}, ${row.registered_by}, ${row.attempt_id},
              ${row.session_digest}, ${row.key_generation}::bigint, ${row.registered_xact}::xid8, ${row.registered_at})`);
    assert.deepEqual([err?.code, err?.message, err?.detail, err?.hint], ['23001', MSG, null, null], `${label}: expected the fixed 23001 refusal, got SQLSTATE ${err?.code ?? 'none'} (output withheld)`);
    assertNoBytes(err, [row.session_digest].filter(Boolean), label);
  }
});
