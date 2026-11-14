// =============================================================================
// M7B-PAYMENTS-P1 — the invoice payment routes over the REAL composed tenant entry (IPH)
// =============================================================================
//
// What this suite proves, over startTenantEntry and a disposable PostgreSQL with every migration in the directory applied
// (036 included), through the same trusted executor and the same assertDisposableTestDsn as the other tests/db suites:
//
//   * the record (POST /api/v1/stores/{storeId}/invoices/{id}/payments): the exact sealed 201
//     {"payment":{"id","invoiceId","attemptId","amountCents","method"}} with no Location; its same-key replay byte for byte
//     (Idempotent-Replayed: true); the same key with other bytes or another invoice the 422; a new key reusing an attempt on
//     the same invoice the sealed 409 already_recorded (also after that payment's reversal, and before every other word); the
//     same attempt on another invoice a different attempt; the sealed 409 amount_exceeds_remaining (the 2^53 − 1 bound
//     included; a Total of 0); a voided invoice the sealed 409 invalid_state; two recordings released together from a lock
//     barrier on the issued header (both seen waiting) never exceed the Total;
//   * the reversal (POST …/payments/{paymentId}/reversal): the exact sealed 200 {"payment":{"id","invoiceId","status"}}, its
//     replay, the sealed 409 invalid_state once reversed, the chain's 403 step_up_required past 10 minutes before any key, a
//     payment of another invoice or a missing one the 404; two reversals of one payment under different keys released
//     together from the header barrier: one 200, one sealed 409 invalid_state, one reversal and one audit record; the
//     winner's key resent once its record is aged past retention runs again: the sealed 409 invalid_state, nothing written;
//     the same key sent while the first waits on the header is the 503 idempotency_unavailable (its record fenced), then the
//     first's stored 200 replays; a stale expectedTenant the unsealed 409 write_conflict, its key then request_in_progress;
//   * the void (changed): an unreversed payment is the sealed 409 payments_recorded; after its reversal the void applies; a
//     void queued behind a record on the issued header answers payments_recorded;
//   * the read (GET …/payments): exactly { invoice, amounts, paymentStatus, payments, nextCursor } in that order, the amounts
//     and word over the complete history, pages of 50 oldest first with the cursor, the 400s for any other query or an
//     unknown cursor, no staff identifier, audit field or correlation id;
//   * the planner's 400 after the key, the target's 400 before it, the stale expectedTenant's unsealed 409 write_conflict,
//     the eligibility routes (action-only), another store's and another tenant's invoice the one 404 with nothing written;
//   * exactly one audit record per success — written by 036's routine, the payment its subject — and none per refusal; no
//     outbox row ever; the issued list and detail bytes unchanged by any payment;
//   * the suite ends with no payment, reversal or payment audit record anywhere (036's rollback needs none).
//
// M7B-PAYMENTS-P2 (PRQ-1, migration 037) — WHAT CHANGED: 037 revokes the runtime's v1 record, so every record here is record v2
// THROUGH A REGISTRATION: prepare() registers the attempt (POST …/payment-registrations), reads its proof back (GET
// …/payment-registration-proof?registration=<id>) and the record's body is exactly { expectedTenant, registrationId, attemptId,
// amountCents, method, registrationProof }. A recorded or refused registration holds its actor's slot on the invoice, so
// prepare() first settles the actor's earlier one (POST …/payment-settlement: version 2 once recorded, 1 while open). The
// record's audit record now names its registration as a second subject. The cluster is durable (the proof routine needs fsync
// on) and the owner installs a proof key out of band before the entry starts (it refuses without one). Every case keeps its
// intent; the registration's own refusals, replay isolation and fail-closed paths are proved by the IRH suite.
//
// It never touches a managed or remote database. Run: npx tsx scripts/run-db-tests.mjs tests/db/invoicePaymentHttp.integration.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry, TENANT_SHIPPING_ROUTES } from '../../server/entry/tenantEntry.ts';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';
import { INVOICE_PAYMENT_METHODS, INVOICE_PAYMENT_REVERSAL_REASON_CODES, INVOICE_PAYMENTS_PAGE_SIZE } from '../../server/runtime/invoicePayments.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'iph-migrator', runtimeRef: 'iph-runtime' };
const LOCK_KEY = 529_538;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_iph_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';

const RECORD_ACTION = 'store.invoice_payment.record';
const REVERSE_ACTION = 'store.invoice_payment.reverse';
const PAYMENT_ACTIONS = [RECORD_ACTION, REVERSE_ACTION];
/** 037's registration and settlement actions (routine-audited, the registration their subject). */
const REGISTRATION_ACTIONS = ['store.invoice_payment.register', 'store.invoice_payment.settle'];
const REG_TABLE = 'tmpos_invoice_payment.invoice_payment_registration';
const VOID_ACTION = 'store.invoice.void';
const PAY_TABLE = 'tmpos_invoice_payment.invoice_payment';
const REV_TABLE = 'tmpos_invoice_payment.invoice_payment_reversal';
const VOID_TABLE = 'tmpos_invoice_void.issued_invoice_void';
const SEND_TIMEOUT_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WIRE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const PROOF_RE = /^[0-9a-f]{64}$/;

// Secret-safe failure output: node:test prints a failing assertion's actual/expected and a thrown error's detail, so proofs,
// keys and bodies are compared before asserting and only booleans, a status, a sealed error word or a SQLSTATE reach output.
/** A SQLSTATE: five upper-case letters or digits, at least one a digit (so never a bare word such as a name). */
const isSqlState = (code) => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code);
/** An error's SQLSTATE once validated; 'none' without one, 'unknown' otherwise — never its message, detail, hint or cause. */
const safeCode = (e) => (e?.code === undefined || e?.code === null ? 'none' : isSqlState(e.code) ? e.code : 'unknown');
/** A PostgreSQL error reduced to its SQLSTATE (no message, detail or cause); an error without one passes unchanged only when it
 * carries no cause, detail, hint or where and is no AggregateError (an assertion's), else only its constructor name. */
function sealDbError(label, e) {
  if (isSqlState(e?.code)) return new Error(`${label}: SQLSTATE ${e.code}`);
  const bare = e instanceof Error && !(e instanceof AggregateError)
    && e.cause === undefined && e.detail === undefined && e.hint === undefined && e.where === undefined;
  if (bare) return e;
  const name = typeof e?.constructor?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.constructor.name) ? e.constructor.name : 'unknown';
  return new Error(`${label}: failed (${name})`);
}
/** The error word of a sealed { error[, requestId] } body (a short lower-case word, so never a proof or key), else null. */
function sealedWord(body) {
  try {
    const b = JSON.parse(body);
    const keys = b !== null && typeof b === 'object' ? Object.keys(b) : [];
    return keys.includes('error') && keys.every((k) => k === 'error' || k === 'requestId') && /^[a-z][a-z_]{0,39}$/.test(b.error) ? b.error : null;
  } catch {
    return null;
  }
}
/** A reply as a failure message may show it: the status and the sealed error word — never the raw body. */
const replyNote = (reply) => { const word = sealedWord(reply.body); return `status ${reply.status}${word === null ? '' : ` ${word}`}`; };
/** A reply's JSON body; a body that is not JSON fails with its status alone (a JSON.parse error would quote the body). */
function parseBody(reply, label) {
  try {
    return JSON.parse(reply.body);
  } catch {
    throw new Error(`${label}: response body is not JSON (${replyNote(reply)})`);
  }
}
const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
/** A canonical lowercase uuid the outbox's aggregate-id shape refuses (version 0): the planner's 400 after the key. */
const NIL = '00000000-0000-0000-0000-000000000000';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** A non-canonical spelling of a canonical uuid: upper-cased, or (an id with no a–f digit) its first digit an upper-case A. */
const upper = (id) => (/[a-f]/.test(id) ? id.toUpperCase() : `A${id.slice(1)}`);

assert.equal(RECENT_AUTH_MAX_AGE_MS, 600_000, 'the recent sign-in is 10 minutes');
assert.equal(INVOICE_PAYMENTS_PAGE_SIZE, 50, 'a page holds at most 50 payments');
assert.deepEqual([...INVOICE_PAYMENT_METHODS], ['cash', 'external_card_terminal']);
assert.deepEqual([...INVOICE_PAYMENT_REVERSAL_REASON_CODES], ['recorded_in_error', 'wrong_amount', 'wrong_method', 'wrong_invoice', 'duplicate', 'other']);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

// Durable (M7B-PAYMENTS-P2): 037's proof routine refuses with fsync off, and every record now needs a proof.
const TARGET = resolveDisposableTarget('IPH', { durable: true });
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
const owner = testClient(TARGET, { max: 4, onnotice: () => {} });
const DROP_RUNTIME_LOGIN = `do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then
    perform pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = '${RUNTIME_LOGIN}';
    drop owned by ${RUNTIME_LOGIN};
    drop role ${RUNTIME_LOGIN};
  end if;
end $$;`;

const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
const USED_KEYS = [];
let rateLimitFingerprintBefore;
let issuerKeyBefore;
const RATE_KEY = randomBytes(32);
/** The payment proof key the owner installs out of band (037: never by a migration); removed again by the teardown. */
const PROOF_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);
const KEYRING = createIdempotencyKeyring(IDEMPOTENCY_KEY);
/** The record scope a key and principal own (it binds nothing else). */
const scopeOf = (key, principal) => KEYRING.operationOf(key, principal, {
  method: 'POST', path: '/', audience: 'tenant', tenant: null, store: null, actor: null, body: new Uint8Array(0),
}).scope;

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
const PAYMENT_GUARDS = [[PAY_TABLE, 'trg_invoice_payment_guard'], [REV_TABLE, 'trg_invoice_payment_reversal_guard']];
const VOID_GUARDS = [[VOID_TABLE, 'trg_issued_invoice_void_guard']];
const ISSUE_GUARDS = [
  ['tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_guard'],
  ['tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_guard'],
  ['tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_guard'],
  ['tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_guard'],
];
const DRAFT_TERMINAL = [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']];

/**
 * Everything this suite's tenants hold, in ONE owner transaction with the guards lifted only inside it: their audit records
 * (the payment, reversal, void, issue, settings and session ones) and every other audit subject naming one of their drafts,
 * invoices, stores or customers; reversals before payments, payments before void records, void records before issued
 * invoices (each foreign key restricts); then issuing rows, drafts, customers and role rows.
 */
async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin('isolation level read committed', async (sql) => {
    await withTriggersLifted(sql, AUDIT_TRIGGER, async () => {
      await sql`delete from public.audit_event where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`update public.audit_event set subject_invoice_draft_id = null
        where subject_invoice_draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_issued_invoice_id = null
        where subject_issued_invoice_id in (select invoice_id from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_store_id = null
        where subject_store_id in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_customer_id = null
        where subject_customer_id in (select customer_id from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]))`;
    });
    // 037's registrations reference payments: they go first, every one of their own guards lifted inside this transaction.
    const registrationGuards = (await sql`select tgname::text as name from pg_catalog.pg_trigger where tgrelid = ${REG_TABLE}::regclass and not tgisinternal`)
      .map((r) => [REG_TABLE, r.name]);
    await withTriggersLifted(sql, registrationGuards,
      () => sql`delete from tmpos_invoice_payment.invoice_payment_registration where tenant_id = any(${TENANTS}::uuid[])`);
    await withTriggersLifted(sql, PAYMENT_GUARDS, async () => {
      await sql`delete from tmpos_invoice_payment.invoice_payment_reversal where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_payment.invoice_payment where tenant_id = any(${TENANTS}::uuid[])`;
    });
    await withTriggersLifted(sql, VOID_GUARDS, () => sql`delete from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${TENANTS}::uuid[])`);
    await withTriggersLifted(sql, ISSUE_GUARDS, async () => {
      await sql`delete from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${TENANTS}::uuid[])`;
    });
    await withTriggersLifted(sql, DRAFT_TERMINAL, async () => {
      await sql`delete from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`;
    });
    await sql`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(sealDbError('IPH teardown step', err)); } };
  try {
    // The events this suite's draft saves enqueued (a payment, a reversal, an issue and a void enqueue none).
    if (TENANTS.length > 0) {
      await step(() => owner`delete from tmpos_internal.outbox_event where event_type in ('invoice_draft.created', 'invoice_draft.updated')
        and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`);
    }
    await step(cleanAll);
    await step(() => owner`delete from tmpos_invoice_payment.payment_proof_key where singleton`);
    if (UIDS.length > 0) {
      await step(async () => {
        for (const row of await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`) KEYS.add(row.session_key);
      });
    }
    if (KEYS.size > 0) await step(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
    if (UIDS.length > 0) await step(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
    if (USED_KEYS.length > 0) {
      await step(() => owner`delete from tmpos_internal.idempotency_record
        where scope = any(${[...new Set(USED_KEYS.map(({ key, principal }) => scopeOf(key, principal)))]}::text[])`);
    }
    await step(() => owner.unsafe(DROP_RUNTIME_LOGIN));
    if (rateLimitFingerprintBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_rate_limit.key_fingerprint where singleton`;
        if (rateLimitFingerprintBefore !== null) {
          await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
            values (${rateLimitFingerprintBefore.singleton}, ${rateLimitFingerprintBefore.fingerprint}, ${rateLimitFingerprintBefore.registered_at}::text::timestamptz)`;
        }
      }));
    }
    if (issuerKeyBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_mint.issuer_key where singleton`;
        if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
      }));
    }
    await step(async () => {
      const [state] = await owner`select
        (select count(*) from tmpos_invoice_payment.invoice_payment)::int as payments,
        (select count(*) from tmpos_invoice_payment.invoice_payment_reversal)::int as reversals,
        (select count(*) from public.audit_event where action_id = any(${PAYMENT_ACTIONS}::text[]) or subject_invoice_payment_id is not null)::int as payment_audits,
        (select count(*) from tmpos_invoice_payment.invoice_payment_registration)::int as registrations,
        (select count(*) from public.audit_event where action_id = any(${REGISTRATION_ACTIONS}::text[]) or subject_invoice_payment_registration_id is not null)::int as registration_audits,
        (select count(*) from tmpos_invoice_payment.payment_proof_key)::int as proof_keys,
        (select pg_catalog.bool_and(g.tgenabled = 'A') from pg_catalog.pg_trigger g where g.tgrelid = ${REG_TABLE}::regclass and not g.tgisinternal) as registration_guards_always,
        (select count(*) from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${TENANTS}::uuid[]))::int as voids,
        (select count(*) from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[]))::int as invoices,
        (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
        (select count(*) from public.audit_event where tenant_id = any(${TENANTS}::uuid[]))::int as audits,
        (select max(version) from public.schema_migrations) as latest,
        (select pg_catalog.string_agg(g.tgname::text || ':' || g.tgenabled::text, ',' order by g.tgname) from pg_catalog.pg_trigger g
          where g.tgrelid in (${PAY_TABLE}::regclass, ${REV_TABLE}::regclass) and not g.tgisinternal) as triggers`;
      assert.deepEqual({ ...state }, {
        payments: 0, reversals: 0, payment_audits: 0, registrations: 0, registration_audits: 0, proof_keys: 0, registration_guards_always: true,
        voids: 0, invoices: 0, drafts: 0, audits: 0, latest: '037',
        triggers: ['trg_invoice_payment_guard:A', 'trg_invoice_payment_reversal_guard:A', 'trg_invoice_payment_reversal_truncate:A', 'trg_invoice_payment_truncate:A'].join(','),
      }, 'no payment, reversal, registration, proof key or payment/registration audit record anywhere, nothing of this suite left, and every payment and registration guard ALWAYS again');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IPH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (raw) {
    const err = sealDbError('IPH setup', raw);
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'IPH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

await setupStep(async () => {
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
  await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const report = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
    assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 400));
  } finally {
    await handle.dispose();
  }
  const [{ applied }] = await owner`select count(*)::int as applied from public.schema_migrations where version in ('034', '035', '036', '037')`;
  assert.equal(applied, 4, 'migrations 034-037 are applied: the issuing, the void, the payments and the registrations');
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  rateLimitFingerprintBefore = rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(RATE_KEY)})`;
  });
  const issuer = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
  issuerKeyBefore = issuer === null ? null : Buffer.from(issuer);
  await installTestIssuerKey(owner, ISSUER_KEY).catch((e) => { throw new Error(`IPH issuer key install failed: SQLSTATE ${safeCode(e)}`); });
  // The owner's out-of-band proof key install (037), under the next generation: the entry refuses to start without one.
  const [{ g }] = await owner`select (coalesce(pg_catalog.max(generation), 0) + 1)::text as g from tmpos_invoice_payment.payment_proof_key_generation`;
  await owner`insert into tmpos_invoice_payment.payment_proof_key (singleton, key, generation) values (true, ${PROOF_KEY}, ${g}::bigint)
    on conflict (singleton) do update set key = excluded.key, generation = excluded.generation`
    .catch((e) => { throw new Error(`IPH proof key install failed: SQLSTATE ${safeCode(e)}`); });
});

// ---------------------------------------------------------------------------
// identity, configuration, requests
// ---------------------------------------------------------------------------

/** token -> { uid, authAgeMs? }: the provider's authentication time is now unless a case ages it. */
const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) { const err = new Error('unknown_token'); err.code = 'auth/invalid-id-token'; throw err; }
    return { uid: rec.uid, authTime: Math.floor((Date.now() - (rec.authAgeMs ?? 0)) / 1000), secondFactor: 'totp' };
  },
});
const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ENV = Object.freeze({
  NODE_ENV: 'production',
  PORT: '8443',
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  DATABASE_CA_CERT: tls.rootCertificates[0],
  RATE_LIMIT_KEY: RATE_KEY.toString('base64url'),
  TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
  SESSION_ADMIN_ORIGINS: ADMIN_ORIGIN,
  SESSION_TENANT_ORIGINS: TENANT_ORIGIN,
  TENANT_SESSION_ISSUER_KEY: ISSUER_KEY.toString('base64url'),
  IDEMPOTENCY_KEY: IDEMPOTENCY_KEY.toString('base64url'),
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', project_id: 'iph-test-project', client_email: 'iph-test@iph-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
  }),
});

function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}

function send(port, method, path, headers, body, { localAddress } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
  const framed = method === 'GET' ? { ...headers } : { 'content-length': String(payload?.length ?? 0), ...headers };
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, method, path, headers: framed, agent: false };
    if (localAddress) options.localAddress = localAddress;
    const request = http.request(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    request.on('error', reject);
    request.setTimeout(SEND_TIMEOUT_MS, () => request.destroy(new Error(`no reply within ${SEND_TIMEOUT_MS} ms: ${method} ${path.split('?')[0]}`)));
    request.end(payload);
  });
}
function assertBaseline(reply, label) {
  assert.equal(reply.headers['strict-transport-security'], HSTS_HEADER.value, `${label}: HSTS`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(reply.headers[name.toLowerCase()], value, `${label}: ${name}`);
  assert.equal(reply.headers['cache-control'], 'no-store', `${label}: no-store`);
}
/** The chain's own unsealed refusal: exactly { error, requestId }, never replayed. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${replyNote(reply)}`);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${replyNote(reply)}`);
  assert.ok(body.error === error, `${label}: refusal word ${sealedWord(reply.body) ?? '(not a sealed word)'}`);
  assert.equal(reply.headers['idempotent-replayed'], undefined, `${label}: never a replay`);
  assertBaseline(reply, label);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newTenant(label) {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`iph-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(id);
  return id;
}
async function newStore(tenant, name) {
  return (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`${name} ${SUFFIX}`}, 'active') returning store_id`)[0].store_id;
}
const NAMES = new Map();
async function newCustomer(tenant, label) {
  const id = randomUUID();
  const name = `IPH ${label} ${SUFFIX}`;
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${name})`;
  NAMES.set(id, name);
  return id;
}
async function actor(label, memberships) {
  const uid = `iph-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  UIDS.push(uid);
  return { id, uid, token, label, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const RATE_8875 = Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: 8875 });
function sellerOf(label) {
  return {
    legalName: `IPH ${label} legal ${SUFFIX}`, storeName: `IPH ${label} shop ${SUFFIX}`,
    postalAddress: `IPH ${label} street ${SUFFIX}\nIPH city`, taxRegistrationId: `IPH-${label}-${SUFFIX}`, tax: RATE_8875,
  };
}
/** The Total a subtotal derives under the 8875 rate (doc 12 §10.8, BigInt). */
const totalOf = (subtotal) => subtotal + Number((BigInt(subtotal) * 8875n + 50_000n) / 100_000n);
const subtotalOf = (lines) => lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
/** Record v2's body for a registration { registrationId, attemptId, proof } (prepare(), or unregistered() for one no row backs). */
const recordBody = (tenant, reg, amountCents, method = 'cash') => ({
  expectedTenant: tenant, registrationId: reg.registrationId, attemptId: reg.attemptId, amountCents, method, registrationProof: reg.proof,
});
/** A well-formed registration and proof that name nothing (the planner accepts them; the routine never finds them). */
const unregistered = (attemptId = randomUUID()) => ({ registrationId: randomUUID(), attemptId, proof: randomBytes(32).toString('hex') });
const reverseBody = (tenant, reasonCode) => ({ expectedTenant: tenant, reasonCode });
const voidBody = (tenant, reasonCode) => ({ expectedTenant: tenant, reasonCode });

/**
 * What a case's tenants hold now — payments, reversals, payment and reversal audit records, void records and void audit
 * records, their stores' outbox rows — the sealed completions of its keys, and across the database every audit record,
 * outbox row, completion and open lease.
 */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_payment.invoice_payment where tenant_id = any(${tenants}::uuid[]))::int as p,
    (select count(*) from tmpos_invoice_payment.invoice_payment_reversal where tenant_id = any(${tenants}::uuid[]))::int as r,
    (select count(*) from public.audit_event where action_id = ${RECORD_ACTION} and tenant_id = any(${tenants}::uuid[]))::int as pa,
    (select count(*) from public.audit_event where action_id = ${REVERSE_ACTION} and tenant_id = any(${tenants}::uuid[]))::int as ra,
    (select count(*) from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${tenants}::uuid[]))::int as v,
    (select count(*) from public.audit_event where action_id = ${VOID_ACTION} and tenant_id = any(${tenants}::uuid[]))::int as va,
    (select count(*) from tmpos_internal.outbox_event where payload ->> 'storeId' in (select store_id::text from public.store where tenant_id = any(${tenants}::uuid[])))::int as o,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from public.audit_event)::int as aa,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as c,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le,
    (select count(*) from tmpos_invoice_payment.invoice_payment_registration where tenant_id = any(${tenants}::uuid[]))::int as g,
    (select count(*) from public.audit_event where action_id = any(${REGISTRATION_ACTIONS}::text[]) and tenant_id = any(${tenants}::uuid[]))::int as ga`;
  return { P: r.p, R: r.r, PA: r.pa, RA: r.ra, V: r.v, VA: r.va, O: r.o, K: r.k, AA: r.aa, OO: r.oo, C: r.c, LE: r.le, G: r.g, GA: r.ga };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
// G / GA (M7B-PAYMENTS-P2): the case's registrations and their register/settle audit records — written only by prepare(),
// which every case calls BEFORE it takes its `before`, so a record, a refusal or a read moves neither.
const NOTHING = Object.freeze({ P: 0, R: 0, PA: 0, RA: 0, V: 0, VA: 0, O: 0, K: 0, AA: 0, OO: 0, C: 0, LE: 0, G: 0, GA: 0 });
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
const COMPLETION_ONLY = Object.freeze({ ...NOTHING, K: 1, C: 1 });
/** One applied record: one payment, ONE audit record (036's routine), one completion — no outbox row, nothing else. */
const ONE_RECORD = Object.freeze({ ...NOTHING, P: 1, PA: 1, AA: 1, K: 1, C: 1 });
/** One applied reversal: one reversal record, ONE audit record, one completion — no outbox row. */
const ONE_REVERSAL = Object.freeze({ ...NOTHING, R: 1, RA: 1, AA: 1, K: 1, C: 1 });
/** One applied void: one void record, one void audit record (the store's TypeScript path, unchanged), one completion. */
const ONE_VOID = Object.freeze({ ...NOTHING, V: 1, VA: 1, AA: 1, K: 1, C: 1 });

async function leaseOpen(key, principal) {
  const [row] = await owner`select response is null as open from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`;
  return row?.open === true;
}
const recordsOf = async (key, principal) => (await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`)[0].n;
/** The payment as stored (null: none), recorded_at in the wire's encoding. */
async function paymentRowOf(payment) {
  const [row] = await owner`select payment_id, tenant_id, store_id, invoice_id, attempt_id, amount_cents::text as amount_cents, method, recorded_by,
    pg_catalog.to_char(recorded_at at time zone 'UTC', ${UTC_FORMAT}) as recorded_at from tmpos_invoice_payment.invoice_payment where payment_id = ${payment}`;
  return row === undefined ? null : { ...row };
}
/** The reversal as stored (null: none), reversed_at in the wire's encoding. */
async function reversalRowOf(payment) {
  const [row] = await owner`select payment_id, tenant_id, store_id, invoice_id, reason_code, reversed_by,
    pg_catalog.to_char(reversed_at at time zone 'UTC', ${UTC_FORMAT}) as reversed_at from tmpos_invoice_payment.invoice_payment_reversal where payment_id = ${payment}`;
  return row === undefined ? null : { ...row };
}
/** The audit records naming `payment`, oldest first. */
const auditOf = async (payment) => (await owner`select action_id, required_permission, actor_internal_user_id, tenant_id, store_id, scope_type, decision,
  result_status, request_id, subject_issued_invoice_id, subject_store_id, subject_invoice_payment_registration_id from public.audit_event where subject_invoice_payment_id = ${payment}
  order by occurred_at, event_id`).map((r) => ({ ...r }));
/** Per audit record naming `payment`, every OTHER subject column that is not null (the payment must be the only subject). */
const otherSubjectsOf = async (payment) => (await owner`select pg_catalog.to_jsonb(a) as j from public.audit_event a
  where a.subject_invoice_payment_id = ${payment} order by a.occurred_at, a.event_id`)
  .map((r) => Object.entries(r.j).filter(([k, v]) => k.startsWith('subject_') && k !== 'subject_invoice_payment_id' && v !== null).map(([k]) => k));

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

/** The runtime's pool, dialing the disposable target as the least-privilege runtime login (no relay: no case cuts a byte). */
const databaseClient = () => createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 4, idle_timeout: 0, user: RUNTIME_LOGIN,
});

async function withEntry(fn) {
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const log = { log: (l) => { lines.push(l); } };
  const result = await startTenantEntry({
    env: ENV, construction: { databaseClient, tokenVerifier: VERIFIER, listen: () => ({ port: 0, host: '127.0.0.1' }) },
    proc, exit: (code) => { codes.push(code); }, log,
  });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  const port = result.address.port;
  const from = randomLoopback();
  const unsafe = (s, method, path, body, key, headers) => {
    if (s?.principal !== undefined) USED_KEYS.push({ key, principal: s.principal });
    return send(port, method, path, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), 'idempotency-key': key, ...headers,
    }, typeof body === 'string' ? body : JSON.stringify(body), { localAddress: from });
  };
  const drafts = (store) => `/api/v1/stores/${store}/invoice-drafts`;
  const invoices = (store) => `/api/v1/stores/${store}/invoices`;
  const ctx = {
    port, from, lines,
    read: (s, path) => send(port, 'GET', path, { host: TENANT_HOST, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }, undefined, { localAddress: from }),
    invoices: (s, store) => ctx.read(s, invoices(store)),
    invoice: (s, store, id) => ctx.read(s, `${invoices(store)}/${id}`),
    payments: (s, store, id, query = '') => ctx.read(s, `${invoices(store)}/${id}/payments${query}`),
    paymentEligibility: (s, store, id) => ctx.read(s, `${invoices(store)}/${id}/payment-eligibility`),
    reversalEligibility: (s, store, id) => ctx.read(s, `${invoices(store)}/${id}/payment-reversal-eligibility`),
    settings: (s, store) => ctx.read(s, `/api/v1/issuing-settings/${store}`),
    save: (s, store, body, { key = randomUUID() } = {}) => unsafe(s, 'POST', drafts(store), body, key, {}),
    issue: (s, store, id, body, { key = randomUUID() } = {}) => unsafe(s, 'POST', `${drafts(store)}/${id}/issue`, body, key, {}),
    putSettings: (s, store, body, { key = randomUUID() } = {}) => unsafe(s, 'PUT', `/api/v1/issuing-settings/${store}`, body, key, {}),
    // A 201 marks the actor's slot on the invoice recorded (prepare() then settles it at version 2).
    record: async (s, store, id, body, { key = randomUUID() } = {}) => {
      const reply = await unsafe(s, 'POST', `${invoices(store)}/${id}/payments`, body, key, {});
      if (reply.status === 201) recordedSlot(s, id, body);
      return reply;
    },
    register: (s, store, id, body, { key = randomUUID() } = {}) => unsafe(s, 'POST', `${invoices(store)}/${id}/payment-registrations`, body, key, {}),
    proof: (s, store, id, registration) => ctx.read(s, `${invoices(store)}/${id}/payment-registration-proof?registration=${registration}`),
    settle: (s, store, id, body, { key = randomUUID() } = {}) => unsafe(s, 'POST', `${invoices(store)}/${id}/payment-settlement`, body, key, {}),
    reverse: (s, store, id, payment, body, { key = randomUUID() } = {}) => unsafe(s, 'POST', `${invoices(store)}/${id}/payments/${payment}/reversal`, body, key, {}),
    voidInvoice: (s, store, id, body, { key = randomUUID() } = {}) => unsafe(s, 'POST', `${invoices(store)}/${id}/void`, body, key, {}),
    reason: (reply) => {
      const found = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
        .filter((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id']);
      assert.equal(found.length, 1, 'exactly one log line for the request');
      return found[0].reason ?? '-';
    },
  };
  let failed = false;
  try {
    return await fn(ctx);
  } catch (err) {
    failed = true;
    throw sealDbError('IPH case', err);
  } finally {
    const early = codes.length;
    if (early === 0) {
      proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; codes.length === 0 && Date.now() < until;) await delay(10);
    }
    // A case's own failure stays the reported one; otherwise an entry that exited early or did not close is a failure, not a leak.
    if (!failed) {
      assert.equal(early, 0, 'the entry did not exit on its own during the case');
      assert.equal(codes.length, 1, 'the entry exited within 5 s of SIGTERM');
    }
  }
}
async function signIn(ctx, who, { token = who.token } = {}) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${replyNote(reply)}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const csrf = parseBody(reply, `login ${who.label}`).csrfToken;
  KEYS.add(createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url'));
  return { cookie, csrf, principal: who.principal };
}
/** A token whose provider authentication time is `ageMs` ago (a stale sign-in past 10 minutes). */
function agedToken(who, ageMs) {
  const token = `${who.token}-aged-${randomUUID().slice(0, 8)}`;
  TOKENS.set(token, { uid: who.uid, authAgeMs: ageMs });
  return token;
}
/** The owner's settings write at the version its read reports; the new version. */
async function configure(ctx, sb, tenant, store, seller) {
  const read = await ctx.settings(sb, store);
  assert.equal(read.status, 200, `the owner's settings read: ${replyNote(read)}`);
  const version = parseBody(read, 'the owner\'s settings read').issuingSettings.version;
  const reply = await ctx.putSettings(sb, store, { expectedTenant: tenant, expectedVersion: version, ...seller });
  assert.equal(reply.status, 200, `the owner's settings PUT: ${replyNote(reply)}`);
  return version + 1;
}
/** One store of a fresh tenant with its owner (tenant grant), a manager and a sales_staff (store grants) and a customer. */
async function world(label) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label.toUpperCase()} store`);
  const C = await newCustomer(T, label);
  const boss = await actor(`${label}-boss`, [tenantGrant(T, 'store_owner')]);
  const mgr = await actor(`${label}-mgr`, [storeGrant(T, S, 'manager')]);
  const staff = await actor(`${label}-staff`, [storeGrant(T, S, 'sales_staff')]);
  return { label, T, S, C, boss, mgr, staff };
}
/** The tenant owner signs in on `ctx` and writes the store's issuing settings once (the 8875 rate). */
async function ready(ctx, w) {
  w.sb = await signIn(ctx, w.boss);
  w.settingsVersion = await configure(ctx, w.sb, w.T, w.S, sellerOf(w.label));
  return w;
}
/** A draft saved and issued by `s` at `w`'s store; { invoice, draft, total }. */
async function issueOne(ctx, s, w, label, lines = [line(`IPH ${label} ${SUFFIX}`, 1, 100)]) {
  const saved = await ctx.save(s, w.S, { expectedTenant: w.T, customerId: w.C, currency: 'USD', lines });
  assert.equal(saved.status, 201, `${label}: the seed save: ${replyNote(saved)}`);
  const draft = parseBody(saved, `${label}: the seed save`).draft.id;
  const issued = await ctx.issue(s, w.S, draft, { expectedTenant: w.T, expectedVersion: 1, expectedSettingsVersion: w.settingsVersion, expectedCustomerVersion: 1 });
  assert.equal(issued.status, 201, `${label}: the issue: ${replyNote(issued)}`);
  const invoice = parseBody(issued, `${label}: the issue`).invoice.id;
  assert.match(invoice, UUID_RE);
  return { invoice, draft, total: totalOf(subtotalOf(lines)) };
}

/** Each actor's unsettled registration per invoice (037's slot): { registrationId, attemptId, recorded }. */
const SLOTS = new Map();
const slotOf = (s, invoice) => `${s.principal.authProviderUid}|${invoice}`;
function recordedSlot(s, invoice, body) {
  const slot = SLOTS.get(slotOf(s, invoice));
  if (slot !== undefined && slot.registrationId === JSON.parse(typeof body === 'string' ? body : JSON.stringify(body)).registrationId) slot.recorded = true;
}
/**
 * Record v2's precondition (M7B-PAYMENTS-P2): `s`'s actor registers `attemptId` on `invoice` and reads its proof back — after
 * settling that actor's earlier unsettled registration on the invoice (the slot), version 2 once recorded, 1 while open.
 * Returns { registrationId, attemptId, proof } for recordBody. Every case calls it before taking its `before`.
 */
async function prepare(ctx, s, tenant, store, invoice, attemptId = randomUUID()) {
  const held = SLOTS.get(slotOf(s, invoice));
  if (held !== undefined) {
    const settled = await ctx.settle(s, store, invoice, { expectedTenant: tenant, attemptId: held.attemptId, expectedVersion: held.recorded ? 2 : 1 });
    assert.equal(settled.status, 200, `the slot's settlement: ${replyNote(settled)}`);
    SLOTS.delete(slotOf(s, invoice));
  }
  const registered = await ctx.register(s, store, invoice, { expectedTenant: tenant, attemptId });
  assert.equal(registered.status, 201, `the registration: ${replyNote(registered)}`);
  const registrationId = parseBody(registered, 'the registration').registration.id;
  assert.ok(registered.body === JSON.stringify({ registration: { id: registrationId, invoiceId: invoice, attemptId, state: 'open' } }), `the registration's sealed 201 (${replyNote(registered)})`);
  // ONE proof GET: the port itself commits a not_durable first attempt and asks once more (O1); a 503 here is a failure.
  const read = await ctx.proof(s, store, invoice, registrationId);
  assert.equal(read.status, 200, `the proof: ${replyNote(read)} ${read.status === 200 ? '' : ctx.reason(read)}`);
  const { registration, proof } = parseBody(read, 'the proof');
  assert.deepEqual(registration, { id: registrationId, invoiceId: invoice, attemptId }, 'the proof names its registration');
  assert.ok(typeof proof === 'string' && PROOF_RE.test(proof), 'the proof: 64 lowercase hex digits (value withheld)');
  SLOTS.set(slotOf(s, invoice), { registrationId, attemptId, recorded: false });
  return { registrationId, attemptId, proof };
}

/** The record's sealed 201: exactly { "payment": { id, invoiceId, attemptId, amountCents, method } }, no Location; the payment id. */
function recordedOf(reply, invoice, attemptId, amountCents, method, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${replyNote(reply)}`);
  const id = parseBody(reply, label)?.payment?.id;
  assert.ok(UUID_RE.test(String(id)), `${label}: the runtime's new payment id`);
  assert.ok(reply.body === JSON.stringify({ payment: { id, invoiceId: invoice, attemptId, amountCents, method } }), `${label}: the exact sealed body (${replyNote(reply)})`);
  assert.equal(reply.headers.location, undefined, `${label}: no Location`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
  return id;
}
/** The reversal's sealed 200: exactly { "payment": { id, invoiceId, "status": "reversed" } }, no Location. */
function reversedOf(reply, payment, invoice, label, { replayed = false } = {}) {
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  assert.equal(reply.body, JSON.stringify({ payment: { id: payment, invoiceId: invoice, status: 'reversed' } }), `${label}: the exact sealed body`);
  assert.equal(reply.headers.location, undefined, `${label}: no Location`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
/** A sealed 409: exactly { "error": word } — no requestId. */
function sealedOf(reply, word, label, { replayed = false } = {}) {
  assert.equal(reply.status, 409, `${label}: ${replyNote(reply)}`);
  assert.ok(reply.body === JSON.stringify({ error: word }), `${label}: the exact sealed body (${replyNote(reply)})`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
function verdictOf(reply, label) {
  assertBaseline(reply, label);
  if (reply.status === 200) {
    assert.equal(reply.body, '{"eligibility":"allowed"}', `${label}: exactly the closed positive body`);
    return 'allowed';
  }
  assertRefusal(reply, 403, 'forbidden', label);
  return 'forbidden';
}
/** The payments read's 200: exactly { invoice, amounts, paymentStatus, payments, nextCursor }, each member's keys in order. */
function paymentsOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  assertBaseline(reply, label);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body), ['invoice', 'amounts', 'paymentStatus', 'payments', 'nextCursor'], `${label}: the five members in order`);
  assert.deepEqual(Object.keys(body.invoice), ['id', 'status'], label);
  assert.deepEqual(Object.keys(body.amounts), ['currency', 'dueCents', 'appliedCents', 'remainingCents'], label);
  assert.equal(body.amounts.currency, 'USD', label);
  for (const p of body.payments) {
    assert.deepEqual(Object.keys(p), ['id', 'attemptId', 'amountCents', 'method', 'recordedAt', 'reversal'], `${label}: a payment's keys`);
    assert.match(p.recordedAt, WIRE_TIME_RE, `${label}: the issued reads' time encoding`);
    if (p.reversal !== null) {
      assert.deepEqual(Object.keys(p.reversal), ['reversedAt', 'reasonCode'], `${label}: a reversal's keys`);
      assert.match(p.reversal.reversedAt, WIRE_TIME_RE, label);
    }
  }
  return body;
}
const amounts = (dueCents, appliedCents) => ({ currency: 'USD', dueCents, appliedCents, remainingCents: dueCents - appliedCents });
/** The wire's payment from the OWNER's rows (the read's projection, nothing else). */
async function wirePaymentOf(payment) {
  const p = await paymentRowOf(payment);
  const r = await reversalRowOf(payment);
  return {
    id: p.payment_id, attemptId: p.attempt_id, amountCents: Number(p.amount_cents), method: p.method, recordedAt: p.recorded_at,
    reversal: r === null ? null : { reversedAt: r.reversed_at, reasonCode: r.reason_code },
  };
}
/** The detail's bytes for `invoice` and the store's WHOLE issued list page as `s` reads them now (the invoice on it). */
async function issuedBytesOf(ctx, s, store, invoice) {
  const detail = await ctx.invoice(s, store, invoice);
  assert.equal(detail.status, 200, `the detail: ${replyNote(detail)}`);
  const list = await ctx.invoices(s, store);
  assert.equal(list.status, 200, `the list: ${replyNote(list)}`);
  assert.ok(parseBody(list, 'the list').invoices.some((i) => i.id === invoice), 'the invoice is on its store\'s list');
  return { detail: detail.body, list: list.body };
}

// ===========================================================================
// IPH-00: the shipping table
// ===========================================================================

test('IPH-00 (doc 15 §12.5 Composition; M7B-PAYMENTS-P2): the tenant entry ships exactly 40 routes, the five payment routes and 037\'s four registration routes among them with their body and idempotency', () => {
  assert.equal(TENANT_SHIPPING_ROUTES.length, 40);
  const served = TENANT_SHIPPING_ROUTES.map((r) => `${r.method} ${r.path} ${r.body} ${r.idempotency}`);
  for (const want of [
    'GET /api/v1/stores/{storeId}/invoices/{id}/payment-eligibility none none',
    'POST /api/v1/stores/{storeId}/invoices/{id}/payments json required',
    'GET /api/v1/stores/{storeId}/invoices/{id}/payment-reversal-eligibility none none',
    'POST /api/v1/stores/{storeId}/invoices/{id}/payments/{paymentId}/reversal json required',
    'GET /api/v1/stores/{storeId}/invoices/{id}/payments none none',
    'POST /api/v1/stores/{storeId}/invoices/{id}/void json required',
    'POST /api/v1/stores/{storeId}/invoices/{id}/payment-registrations json required',
    'GET /api/v1/stores/{storeId}/invoices/{id}/payment-registration-proof none none',
    'POST /api/v1/stores/{storeId}/invoices/{id}/payment-settlement json required',
    'GET /api/v1/stores/{storeId}/payment-attempts none none',
  ]) assert.ok(served.includes(want), want);
});

// ===========================================================================
// IPH-01: the record
// ===========================================================================

test('IPH-01 (PAY-01, PAY-04, PAY-08, PAY-10, PAY-11): the record (v2, through a registration) — the exact sealed 201 with no Location, one payment naming its actor, ONE audit record written by 037\'s routine (the payment and its registration its only subjects) and its completion, no outbox row; the same-key replay byte for byte; the same key with other bytes or another invoice the 422; a new key reusing the attempt the sealed already_recorded (before amount_exceeds_remaining), its own replay sealed; the same attempt on another invoice a new payment; amount_exceeds_remaining; mixed methods to recorded_in_full; the read\'s amounts and word over the history; the issued list and detail bytes unchanged', async () => {
  const w = await world('iph01');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph01', [line(`IPH iph01 ${SUFFIX}`, 2, 1000)]);
    const y = await issueOne(ctx, s, w, 'iph01 other');
    assert.equal(x.total, 2178, 'the Total: 2,000 + 8.875% tax');
    const issued = await issuedBytesOf(ctx, s, w.S, x.invoice);
    assert.equal(verdictOf(await ctx.paymentEligibility(s, w.S, x.invoice), 'the record eligibility'), 'allowed');
    assert.deepEqual(paymentsOf(await ctx.payments(s, w.S, x.invoice), 'before any payment'), {
      invoice: { id: x.invoice, status: 'issued' }, amounts: amounts(2178, 0), paymentStatus: 'no_payment_recorded', payments: [], nextCursor: null,
    });
    // (1) The first payment.
    const A = randomUUID();
    const ra = await prepare(ctx, s, w.T, w.S, x.invoice, A);
    const key = randomUUID();
    const keys = [{ key, principal: w.mgr.principal }];
    const body = JSON.stringify(recordBody(w.T, ra, 1000, 'cash'));
    let before = await counts([w.T], keys);
    const first = await ctx.record(s, w.S, x.invoice, body, { key });
    const p1 = recordedOf(first, x.invoice, A, 1000, 'cash', 'the first payment');
    assert.deepEqual(delta(await counts([w.T], keys), before), ONE_RECORD, 'one payment, one audit record, one completion, no outbox row');
    const row = await paymentRowOf(p1);
    assert.deepEqual({ ...row, recorded_at: undefined }, {
      payment_id: p1, tenant_id: w.T, store_id: w.S, invoice_id: x.invoice, attempt_id: A, amount_cents: '1000', method: 'cash', recorded_by: w.mgr.id, recorded_at: undefined,
    }, 'the payment as stored, naming its actor');
    const audits = await auditOf(p1);
    assert.equal(audits.length, 1, 'exactly one audit record');
    // 037: the record's audit record names its registration as the second subject, and nothing else.
    assert.deepEqual(await otherSubjectsOf(p1), [['subject_invoice_payment_registration_id']], 'the payment and its registration the record\'s only subjects');
    assert.deepEqual({ ...audits[0], request_id: undefined }, {
      action_id: RECORD_ACTION, required_permission: 'record_invoice_payments', actor_internal_user_id: w.mgr.id, tenant_id: w.T, store_id: w.S,
      scope_type: 'store', decision: 'allow', result_status: 'succeeded', request_id: undefined, subject_issued_invoice_id: null, subject_store_id: null,
      subject_invoice_payment_registration_id: ra.registrationId,
    }, 'the routine\'s audit record, the payment and its registration its only subjects');
    assert.match(audits[0].request_id, UUID_RE, 'the command\'s correlation id');
    // (2) The same key and bytes: the sealed 201 replayed; other bytes or another invoice: the 422.
    before = await counts([w.T], keys);
    const replay = await ctx.record(s, w.S, x.invoice, body, { key });
    recordedOf(replay, x.invoice, A, 1000, 'cash', 'the same-key replay', { replayed: true });
    assert.ok(replay.body === first.body, `the recorded bytes (${replyNote(replay)})`);
    assertRefusal(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, 999, 'cash')), { key }), 422, 'idempotency_key_reused', 'the same key, another amount');
    assertRefusal(await ctx.record(s, w.S, y.invoice, body, { key }), 422, 'idempotency_key_reused', 'the same key and bytes, another invoice');
    assert.deepEqual(delta(await counts([w.T], keys), before), NOTHING, 'the replay and the 422s wrote nothing');
    // (3) A new key reusing the attempt (its recorded registration and proof): the sealed already_recorded — before the amount (above the remaining here).
    for (const [label, amount] of [['the same amount', 1000], ['an amount above the remaining', 2000]]) {
      const again = randomUUID();
      const againKeys = [{ key: again, principal: w.mgr.principal }];
      before = await counts([w.T], againKeys);
      const reused = await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, amount, 'external_card_terminal')), { key: again });
      sealedOf(reused, 'already_recorded', `a new key reusing the attempt, ${label}`);
      assert.deepEqual(delta(await counts([w.T], againKeys), before), COMPLETION_ONLY, `${label}: the sealed refusal's completion alone`);
      before = await counts([w.T], againKeys);
      sealedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, amount, 'external_card_terminal')), { key: again }), 'already_recorded', `${label}: its replay`, { replayed: true });
      assert.deepEqual(delta(await counts([w.T], againKeys), before), NOTHING);
    }
    // (4) The same attempt on another invoice is a different attempt (its own registration there).
    const ry = await prepare(ctx, s, w.T, w.S, y.invoice, A);
    let k = randomUUID();
    before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    const py = recordedOf(await ctx.record(s, w.S, y.invoice, JSON.stringify(recordBody(w.T, ry, 50, 'cash')), { key: k }), y.invoice, A, 50, 'cash', 'the attempt on another invoice');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), ONE_RECORD);
    // (5) Above the remaining (1,178): the sealed amount_exceeds_remaining; exactly the remaining: applied, by card. (Each a new
    //     attempt with its own registration; prepare() confirms or withdraws the one before it.)
    const r5 = await prepare(ctx, s, w.T, w.S, x.invoice);
    k = randomUUID();
    before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    sealedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, r5, 1179)), { key: k }), 'amount_exceeds_remaining', 'one cent above the remaining');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), COMPLETION_ONLY);
    const B = randomUUID();
    const rb = await prepare(ctx, s, w.T, w.S, x.invoice, B);
    k = randomUUID();
    before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    const p2 = recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, rb, 1178, 'external_card_terminal')), { key: k }),
      x.invoice, B, 1178, 'external_card_terminal', 'exactly the remaining, by card');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), ONE_RECORD);
    const r6 = await prepare(ctx, s, w.T, w.S, x.invoice);
    k = randomUUID();
    before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    sealedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, r6, 1)), { key: k }), 'amount_exceeds_remaining', 'one cent on a fully recorded invoice');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), COMPLETION_ONLY);
    // (6) The read: both payments oldest first, the amounts and the word over the complete history.
    const read = paymentsOf(await ctx.payments(s, w.S, x.invoice), 'after the payments');
    assert.deepEqual(read, {
      invoice: { id: x.invoice, status: 'issued' }, amounts: amounts(2178, 2178), paymentStatus: 'recorded_in_full',
      payments: [await wirePaymentOf(p1), await wirePaymentOf(p2)], nextCursor: null,
    });
    assert.deepEqual(paymentsOf(await ctx.payments(s, w.S, y.invoice), 'the other invoice'), {
      invoice: { id: y.invoice, status: 'issued' }, amounts: amounts(y.total, 50), paymentStatus: 'recorded_partly', payments: [await wirePaymentOf(py)], nextCursor: null,
    });
    // (7) The issued list and detail answers are byte-identical to before any payment.
    assert.deepEqual(await issuedBytesOf(ctx, s, w.S, x.invoice), issued, 'the issued reads unchanged by payments');
  });
});

// ===========================================================================
// IPH-02: refusals before and after the key
// ===========================================================================

test('IPH-02 (PAY-01 input refusals, PAY-02, PAY-04): a body outside the closed shape (an extra or missing key, a card-shaped field, amount 0, 2^53, a string or fraction, an unknown method, a non-canonical attempt or tenant) is the planner\'s 400 after the key with nothing else written; 2^53 − 1 passes the planner and is the sealed amount_exceeds_remaining; a non-canonical invoice id is the 400 before any key, the nil uuid the planner\'s 400 after it; a stale expectedTenant is the unsealed 409 write_conflict (rolled back, the lease kept) — before the missing invoice\'s 404; a sales_staff default is the 403 before any key and its eligibility forbidden', async () => {
  const w = await world('iph02');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph02');
    const valid = recordBody(w.T, unregistered(), 10, 'cash');
    const { registrationId: rid, registrationProof: rproof } = valid;
    for (const [label, body] of [
      ['an extra key', { ...valid, note: 'x' }],
      ['a card-shaped field', { ...valid, cvv: '123' }],
      ['an actor', { ...valid, actor: w.mgr.id }],
      ['a version', { ...valid, expectedVersion: 1 }],
      ['no method', { expectedTenant: w.T, registrationId: rid, attemptId: valid.attemptId, amountCents: 10, registrationProof: rproof }],
      // M7B-PAYMENTS-P2: record v2 names its registration and proof exactly.
      ['the v1 body (no registration, no proof)', { expectedTenant: w.T, attemptId: valid.attemptId, amountCents: 10, method: 'cash' }],
      ['no registration id', { ...valid, registrationId: undefined }],
      ['no proof', { ...valid, registrationProof: undefined }],
      ['an upper-case registration id', { ...valid, registrationId: upper(rid) }],
      ['an upper-case proof', { ...valid, registrationProof: rproof.toUpperCase() }],
      ['a short proof', { ...valid, registrationProof: rproof.slice(2) }],
      ['a proof as a number', { ...valid, registrationProof: 7 }],
      ['amount 0', { ...valid, amountCents: 0 }],
      ['a negative amount', { ...valid, amountCents: -1 }],
      ['2^53', `{"expectedTenant":"${w.T}","registrationId":"${rid}","attemptId":"${valid.attemptId}","amountCents":9007199254740992,"method":"cash","registrationProof":"${rproof}"}`],
      ['a string amount', { ...valid, amountCents: '10' }],
      ['a fraction', { ...valid, amountCents: 10.5 }],
      ['an unknown method', { ...valid, method: 'card' }],
      ['a method label', { ...valid, method: 'Cash' }],
      ['an upper-case attempt', { ...valid, attemptId: upper(valid.attemptId) }],
      ['an upper-case tenant', { ...valid, expectedTenant: upper(w.T) }],
      ['an empty object', {}],
      ['an array', [valid]],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: w.mgr.principal }];
      const before = await counts([w.T], keys);
      const reply = await ctx.record(s, w.S, x.invoice, typeof body === 'string' ? body : JSON.stringify(body), { key });
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'command_request_invalid', `${label}: the planner's refusal`);
      assert.deepEqual(delta(await counts([w.T], keys), before), LEASE_ONLY, `${label}: the lease acquired, nothing else`);
    }
    // 2^53 − 1 is a valid amount: the routine's sealed refusal, not the planner's (a real registration, so the routine decides).
    const rmax = await prepare(ctx, s, w.T, w.S, x.invoice);
    let key = randomUUID();
    let before = await counts([w.T], [{ key, principal: w.mgr.principal }]);
    sealedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, rmax, MAX_SAFE)), { key }), 'amount_exceeds_remaining', '2^53 − 1');
    assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.mgr.principal }]), before), COMPLETION_ONLY);
    // The targets.
    for (const [label, id, status, reason, written] of [
      ['an upper-case invoice id', upper(x.invoice), 400, 'command_target_invalid', NOTHING],
      ['the nil uuid', NIL, 400, 'command_request_invalid', LEASE_ONLY],
    ]) {
      key = randomUUID();
      before = await counts([w.T], [{ key, principal: w.mgr.principal }]);
      const reply = await ctx.record(s, w.S, id, JSON.stringify(valid), { key });
      assertRefusal(reply, status, 'invalid_request', label);
      assert.equal(ctx.reason(reply), reason, label);
      assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.mgr.principal }]), before), written, label);
    }
    // A stale expectedTenant: the unsealed 409, rolled back, the lease kept — the tenant decided before the invoice header.
    const other = await newTenant('iph02-other');
    for (const [label, tenant, invoice] of [['another tenant', other, x.invoice], ['a tenant that does not exist', randomUUID(), x.invoice], ['another tenant, a missing invoice', other, randomUUID()]]) {
      key = randomUUID();
      before = await counts([w.T], [{ key, principal: w.mgr.principal }]);
      const reply = await ctx.record(s, w.S, invoice, JSON.stringify(recordBody(tenant, rmax, 10)), { key });
      assertRefusal(reply, 409, 'write_conflict', label);
      assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.mgr.principal }]), before), LEASE_ONLY, `${label}: rolled back, the lease kept`);
      assert.equal(await leaseOpen(key, w.mgr.principal), true, label);
    }
    // A sales_staff default holds Invoices below approve: forbidden, before any key, for the POST and its eligibility.
    const st = await signIn(ctx, w.staff);
    assert.equal(verdictOf(await ctx.paymentEligibility(st, w.S, x.invoice), 'the staff record eligibility'), 'forbidden');
    assert.equal(verdictOf(await ctx.reversalEligibility(st, w.S, x.invoice), 'the staff reversal eligibility'), 'forbidden');
    key = randomUUID();
    before = await counts([w.T], [{ key, principal: w.staff.principal }]);
    assertRefusal(await ctx.record(st, w.S, x.invoice, JSON.stringify(valid), { key }), 403, 'forbidden', 'the staff record');
    assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.staff.principal }]), before), NOTHING);
    assert.equal(await recordsOf(key, w.staff.principal), 0, 'refused before any key');
    assert.deepEqual(paymentsOf(await ctx.payments(s, w.S, x.invoice), 'nothing recorded').payments, []);
  });
});

// ===========================================================================
// IPH-03: the reversal
// ===========================================================================


test('IPH-03 (PAY-03, PAY-04, PAY-08): the reversal — a sign-in older than 10 minutes is the chain\'s 403 step_up_required before any key while its action-only eligibility answers allowed; a fresh one reverses with the exact sealed 200 (one reversal record naming its actor, ONE audit record, its completion, no outbox row); its replay, the stale replay stopped by the step-up first, the same key with another reason or target the 422; a new key the sealed invalid_state; a payment of another invoice and a missing payment the rolled-back 404, the nil ids the planner\'s 400 and an upper-case one the 400 before any key; a reason outside the six the planner\'s 400; the attempt retried after its reversal the sealed already_recorded; the read shows the reversal and the restored remaining, which records again', async () => {
  const w = await world('iph03');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph03');
    const y = await issueOne(ctx, s, w, 'iph03 other');
    assert.equal(x.total, 109);
    const A = randomUUID();
    const ra = await prepare(ctx, s, w.T, w.S, x.invoice, A);
    const p = recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, 100))), x.invoice, A, 100, 'cash', 'the payment');
    const Q = randomUUID();
    const rq = await prepare(ctx, s, w.T, w.S, y.invoice, Q);
    const q = recordedOf(await ctx.record(s, w.S, y.invoice, JSON.stringify(recordBody(w.T, rq, 9))), y.invoice, Q, 9, 'cash', 'the other invoice\'s payment');
    // (1) A stale sign-in: the eligibility is action-only (and target-blind); the POST is the step-up before any key.
    const stale = await signIn(ctx, w.mgr, { token: agedToken(w.mgr, RECENT_AUTH_MAX_AGE_MS + 60_000) });
    assert.equal(verdictOf(await ctx.reversalEligibility(stale, w.S, x.invoice), 'the stale session\'s reversal eligibility'), 'allowed');
    assert.equal(verdictOf(await ctx.reversalEligibility(s, w.S, randomUUID()), 'a missing invoice\'s reversal eligibility'), 'allowed', 'target-blind');
    const key = randomUUID();
    const keys = [{ key, principal: w.mgr.principal }];
    const body = JSON.stringify(reverseBody(w.T, 'wrong_amount'));
    let before = await counts([w.T], keys);
    const refused = await ctx.reverse(stale, w.S, x.invoice, p, body, { key });
    assertRefusal(refused, 403, 'step_up_required', 'the reversal from a stale sign-in');
    assert.equal(ctx.reason(refused), 'recent_auth_required', 'the chain\'s step-up');
    assert.deepEqual(delta(await counts([w.T], keys), before), NOTHING, 'the stale reversal: nothing written');
    assert.equal(await recordsOf(key, w.mgr.principal), 0, 'refused before any key');
    // (2) A fresh sign-in reverses.
    before = await counts([w.T], keys);
    const first = await ctx.reverse(s, w.S, x.invoice, p, body, { key });
    reversedOf(first, p, x.invoice, 'the reversal');
    assert.deepEqual(delta(await counts([w.T], keys), before), ONE_REVERSAL, 'one reversal record, one audit record, one completion, no outbox row');
    const rev = await reversalRowOf(p);
    assert.deepEqual({ ...rev, reversed_at: undefined }, {
      payment_id: p, tenant_id: w.T, store_id: w.S, invoice_id: x.invoice, reason_code: 'wrong_amount', reversed_by: w.mgr.id, reversed_at: undefined,
    }, 'the reversal as stored, naming its actor');
    const audits = await auditOf(p);
    assert.deepEqual(audits.map((a) => [a.action_id, a.required_permission, a.actor_internal_user_id, a.tenant_id, a.store_id, a.result_status]), [
      [RECORD_ACTION, 'record_invoice_payments', w.mgr.id, w.T, w.S, 'succeeded'],
      [REVERSE_ACTION, 'reverse_invoice_payments', w.mgr.id, w.T, w.S, 'succeeded'],
    ], 'the record\'s and the reversal\'s audit records, the payment their subject');
    assert.notEqual(audits[0].request_id, audits[1].request_id, 'each command its own correlation id');
    // 037: the record's audit record also names its registration; the reversal's names the payment alone.
    assert.deepEqual(await otherSubjectsOf(p), [['subject_invoice_payment_registration_id'], []], 'the payment each record\'s only subject beside the record\'s registration');
    assert.deepEqual(audits.map((a) => a.subject_invoice_payment_registration_id), [ra.registrationId, null], 'the record\'s registration');
    // (3) The replay; the stale replay stopped by the step-up first; the same key with another reason or target the 422.
    before = await counts([w.T], keys);
    const replay = await ctx.reverse(s, w.S, x.invoice, p, body, { key });
    reversedOf(replay, p, x.invoice, 'the same-key replay', { replayed: true });
    assert.equal(replay.body, first.body);
    assertRefusal(await ctx.reverse(stale, w.S, x.invoice, p, body, { key }), 403, 'step_up_required', 'the same-key replay from the stale session');
    assertRefusal(await ctx.reverse(s, w.S, x.invoice, p, JSON.stringify(reverseBody(w.T, 'other')), { key }), 422, 'idempotency_key_reused', 'the same key, another reason');
    assertRefusal(await ctx.reverse(s, w.S, y.invoice, q, body, { key }), 422, 'idempotency_key_reused', 'the same key and bytes, another invoice and payment');
    assertRefusal(await ctx.reverse(s, w.S, x.invoice, q, body, { key }), 422, 'idempotency_key_reused', 'the same key and bytes, another payment');
    assert.deepEqual(delta(await counts([w.T], keys), before), NOTHING, 'the replays and the 422s wrote nothing');
    assert.equal(await reversalRowOf(q), null, 'the other payment untouched');
    // (4) A new key on the reversed payment: the sealed invalid_state.
    let k = randomUUID();
    before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    sealedOf(await ctx.reverse(s, w.S, x.invoice, p, JSON.stringify(reverseBody(w.T, 'duplicate')), { key: k }), 'invalid_state', 'already reversed');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), COMPLETION_ONLY);
    // (5) The targets: a payment of another invoice and a missing one are the rolled-back 404; the nil ids and upper-case ones the 400s.
    for (const [label, invoice, payment, status, error, reason, written] of [
      ['another invoice\'s payment', x.invoice, q, 404, 'not_found', null, LEASE_ONLY],
      ['a payment under another invoice\'s path', y.invoice, p, 404, 'not_found', null, LEASE_ONLY],
      ['a missing payment', x.invoice, randomUUID(), 404, 'not_found', null, LEASE_ONLY],
      ['the nil payment id', x.invoice, NIL, 400, 'invalid_request', 'command_request_invalid', LEASE_ONLY],
      ['the nil invoice id', NIL, p, 400, 'invalid_request', 'command_request_invalid', LEASE_ONLY],
      ['an upper-case payment id', x.invoice, upper(q), 400, 'invalid_request', 'command_target_invalid', NOTHING],
      ['an upper-case invoice id', upper(y.invoice), q, 400, 'invalid_request', 'command_target_invalid', NOTHING],
    ]) {
      k = randomUUID();
      before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
      const reply = await ctx.reverse(s, w.S, invoice, payment, JSON.stringify(reverseBody(w.T, 'other')), { key: k });
      assertRefusal(reply, status, error, label);
      if (reason !== null) assert.equal(ctx.reason(reply), reason, label);
      assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), written, `${label}: written`);
    }
    assert.equal(await reversalRowOf(q), null, 'the other payment still unreversed');
    // (6) The body: exactly { expectedTenant, reasonCode }, the code one of the six.
    for (const [label, b] of [
      ['a void reason code', reverseBody(w.T, 'issued_in_error')],
      ['a label for its code', reverseBody(w.T, 'Other reason')],
      ['a re-cased code', reverseBody(w.T, 'Duplicate')],
      ['a version', { ...reverseBody(w.T, 'other'), expectedVersion: 1 }],
      ['an amount', { ...reverseBody(w.T, 'other'), amountCents: 9 }],
      ['no tenant', { reasonCode: 'other' }],
    ]) {
      k = randomUUID();
      before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
      const reply = await ctx.reverse(s, w.S, y.invoice, q, JSON.stringify(b), { key: k });
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'command_request_invalid', label);
      assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), LEASE_ONLY, label);
    }
    // (7) The attempt retried after its reversal is still the sealed already_recorded.
    k = randomUUID();
    before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    sealedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, 100)), { key: k }), 'already_recorded', 'the attempt retried after its reversal');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), COMPLETION_ONLY);
    // (8) The read keeps the history: the reversal shown, nothing applied, the remaining restored — and recordable again.
    assert.deepEqual(paymentsOf(await ctx.payments(s, w.S, x.invoice), 'after the reversal'), {
      invoice: { id: x.invoice, status: 'issued' }, amounts: amounts(109, 0), paymentStatus: 'no_payment_recorded', payments: [await wirePaymentOf(p)], nextCursor: null,
    });
    assert.equal((await wirePaymentOf(p)).reversal.reasonCode, 'wrong_amount');
    const C = randomUUID();
    const rc = await prepare(ctx, s, w.T, w.S, x.invoice, C);
    const p3 = recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, rc, 109, 'external_card_terminal'))), x.invoice, C, 109, 'external_card_terminal', 'the full Total after the reversal');
    assert.deepEqual(paymentsOf(await ctx.payments(s, w.S, x.invoice), 'recorded in full again'), {
      invoice: { id: x.invoice, status: 'issued' }, amounts: amounts(109, 109), paymentStatus: 'recorded_in_full',
      payments: [await wirePaymentOf(p), await wirePaymentOf(p3)], nextCursor: null,
    });
  });
});

// ===========================================================================
// IPH-04: the void
// ===========================================================================

test('IPH-04 (PAY-12, PAY-09, D-PAY-5): the void — an unreversed payment is the sealed 409 payments_recorded (its completion alone; its replay sealed), still while one of two remains; once both are reversed the void applies under a new key (one void record, the void\'s own audit record, no outbox row) while the earlier key still replays payments_recorded; a voided invoice records nothing — a new attempt (registered before the void) the sealed invalid_state (also above the remaining: voided is decided first), a reused attempt the sealed already_recorded (decided before voided); the read answers voided with nothing due and the reversed history; the issued detail and list answers unchanged by the payments and, once voided, differ only by the void\'s own fields', async () => {
  const w = await world('iph04');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph04');
    const issued = await issuedBytesOf(ctx, s, w.S, x.invoice);
    const A = randomUUID();
    const B = randomUUID();
    const ra = await prepare(ctx, s, w.T, w.S, x.invoice, A);
    const p1 = recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, 50))), x.invoice, A, 50, 'cash', 'the first payment');
    const rb = await prepare(ctx, s, w.T, w.S, x.invoice, B);
    const p2 = recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, rb, 59, 'external_card_terminal'))), x.invoice, B, 59, 'external_card_terminal', 'the second payment');
    assert.deepEqual(await issuedBytesOf(ctx, s, w.S, x.invoice), issued, 'the issued reads unchanged by payments');
    const vbody = JSON.stringify(voidBody(w.T, 'duplicate'));
    // (1) The void refused while a payment is unreversed.
    const vk = randomUUID();
    let before = await counts([w.T], [{ key: vk, principal: w.mgr.principal }]);
    sealedOf(await ctx.voidInvoice(s, w.S, x.invoice, vbody, { key: vk }), 'payments_recorded', 'the void with two payments');
    assert.deepEqual(delta(await counts([w.T], [{ key: vk, principal: w.mgr.principal }]), before), COMPLETION_ONLY, 'the sealed refusal\'s completion alone');
    before = await counts([w.T], [{ key: vk, principal: w.mgr.principal }]);
    sealedOf(await ctx.voidInvoice(s, w.S, x.invoice, vbody, { key: vk }), 'payments_recorded', 'its replay', { replayed: true });
    assert.deepEqual(delta(await counts([w.T], [{ key: vk, principal: w.mgr.principal }]), before), NOTHING);
    reversedOf(await ctx.reverse(s, w.S, x.invoice, p1, JSON.stringify(reverseBody(w.T, 'recorded_in_error'))), p1, x.invoice, 'the first reversal');
    let k = randomUUID();
    before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    sealedOf(await ctx.voidInvoice(s, w.S, x.invoice, vbody, { key: k }), 'payments_recorded', 'the void with one payment left');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), COMPLETION_ONLY);
    reversedOf(await ctx.reverse(s, w.S, x.invoice, p2, JSON.stringify(reverseBody(w.T, 'wrong_method'))), p2, x.invoice, 'the second reversal');
    // A new attempt registered (open) BEFORE the void: 037 refuses a registration on a voided invoice, so only one opened
    // before it can ever reach the record afterwards.
    const rn = await prepare(ctx, s, w.T, w.S, x.invoice);
    // (2) Every payment reversed: the void applies; the first key still replays its sealed refusal.
    k = randomUUID();
    before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    const voided = await ctx.voidInvoice(s, w.S, x.invoice, vbody, { key: k });
    assert.equal(voided.status, 200, `the void: ${replyNote(voided)}`);
    assert.equal(voided.body, `{"invoice":{"id":"${x.invoice}","status":"voided"}}`, 'the void\'s sealed 200');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), ONE_VOID, 'one void, its own audit record, no outbox row');
    sealedOf(await ctx.voidInvoice(s, w.S, x.invoice, vbody, { key: vk }), 'payments_recorded', 'the first key\'s replay after the void', { replayed: true });
    // (3) Recording on the voided invoice.
    for (const [label, reg, amount, word] of [
      ['a new attempt', rn, 1, 'invalid_state'],
      ['a new attempt above the remaining', rn, MAX_SAFE, 'invalid_state'],
      ['a reused attempt', ra, 50, 'already_recorded'],
    ]) {
      k = randomUUID();
      before = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
      sealedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, reg, amount)), { key: k }), word, `the voided invoice, ${label}`);
      assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), before), COMPLETION_ONLY, label);
    }
    sealedOf(await ctx.reverse(s, w.S, x.invoice, p2, JSON.stringify(reverseBody(w.T, 'other'))), 'invalid_state', 'a reversed payment of the voided invoice');
    // (4) The read: voided, nothing due, the reversed history kept.
    assert.deepEqual(paymentsOf(await ctx.payments(s, w.S, x.invoice), 'the voided invoice'), {
      invoice: { id: x.invoice, status: 'voided' }, amounts: amounts(0, 0), paymentStatus: 'voided',
      payments: [await wirePaymentOf(p1), await wirePaymentOf(p2)], nextCursor: null,
    });
    // (5) The issued reads once voided: the status and the void's member alone differ.
    const [{ voided_at: voidedAt }] = await owner`select pg_catalog.to_char(voided_at at time zone 'UTC', ${UTC_FORMAT}) as voided_at from tmpos_invoice_void.issued_invoice_void where invoice_id = ${x.invoice}`;
    const now = await issuedBytesOf(ctx, s, w.S, x.invoice);
    const detail = JSON.parse(issued.detail);
    detail.invoice.status = 'voided';
    detail.invoice.void = { voidedAt, reasonCode: 'duplicate' };
    assert.equal(now.detail, JSON.stringify(detail), 'the detail: the void\'s fields alone');
    const list = JSON.parse(issued.list);
    list.invoices = list.invoices.map((i) => (i.id === x.invoice ? { ...i, status: 'voided' } : i));
    assert.equal(now.list, JSON.stringify(list), 'the whole list page: the invoice\'s status alone');
  });
});

// ===========================================================================
// IPH-05: isolation
// ===========================================================================

test('IPH-05 (PAY-02, R-K3): isolation — another store\'s, another tenant\'s and a missing invoice are ONE 404 for the record (decided before the attempt: a foreign invoice\'s own recorded attempt never leaks already_recorded) and the reversal (rolled back, the lease open, nothing written) and for the read; a store the actor holds no grant at and another tenant\'s store are the 403 before any key for every payment route; the foreign payments untouched', async () => {
  const T = await newTenant('iph05');
  const T2 = await newTenant('iph05-other');
  const S1 = await newStore(T, 'IPH05 one');
  const S2 = await newStore(T, 'IPH05 two');
  const S3 = await newStore(T, 'IPH05 ungranted');
  const X = await newStore(T2, 'IPH05 foreign');
  const C = await newCustomer(T, 'iph05');
  const C2 = await newCustomer(T2, 'iph05-foreign');
  const who = await actor('iph05', [storeGrant(T, S1, 'manager'), storeGrant(T, S2, 'manager')]);
  const foreign = await actor('iph05-foreign', [storeGrant(T2, X, 'manager')]);
  const boss = await actor('iph05-boss', [tenantGrant(T, 'store_owner')]);
  const boss2 = await actor('iph05-boss2', [tenantGrant(T2, 'store_owner')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const sf = await signIn(ctx, foreign);
    const sb = await signIn(ctx, boss);
    const at = (tenant, store, customer, settingsVersion) => ({ T: tenant, S: store, C: customer, settingsVersion });
    const w1 = at(T, S1, C, await configure(ctx, sb, T, S1, sellerOf('iph05 one')));
    const w2 = at(T, S2, C, await configure(ctx, sb, T, S2, sellerOf('iph05 two')));
    const wX = at(T2, X, C2, await configure(ctx, await signIn(ctx, boss2), T2, X, sellerOf('iph05 foreign')));
    const i1 = await issueOne(ctx, s, w1, 'iph05 at S1');
    const i2 = await issueOne(ctx, s, w2, 'iph05 at S2');
    const iX = await issueOne(ctx, sf, wX, 'iph05 at X');
    const a2 = randomUUID();
    const r2 = await prepare(ctx, s, T, S2, i2.invoice, a2);
    const p2 = recordedOf(await ctx.record(s, S2, i2.invoice, JSON.stringify(recordBody(T, r2, 5))), i2.invoice, a2, 5, 'cash', 'a payment at S2');
    const aX = randomUUID();
    const rX = await prepare(ctx, sf, T2, X, iX.invoice, aX);
    const pX = recordedOf(await ctx.record(sf, X, iX.invoice, JSON.stringify(recordBody(T2, rX, 7))), iX.invoice, aX, 7, 'cash', 'a payment at X');
    const rows = { [p2]: await paymentRowOf(p2), [pX]: await paymentRowOf(pX) };
    // (1) The record and the reversal at S1: one 404, rolled back, the lease open, nothing written.
    const shapes = [];
    const cases = [
      ['record: a missing invoice', (key) => ctx.record(s, S1, randomUUID(), JSON.stringify(recordBody(T, unregistered(), 1)), { key })],
      ['record: another store\'s invoice', (key) => ctx.record(s, S1, i2.invoice, JSON.stringify(recordBody(T, unregistered(), 1)), { key })],
      ['record: another tenant\'s invoice', (key) => ctx.record(s, S1, iX.invoice, JSON.stringify(recordBody(T, unregistered(), 1)), { key })],
      // The header's 404 is decided before the attempt: each foreign invoice's OWN recorded attempt — sent with its real
      // registration and proof — never leaks already_recorded.
      ['record: another store\'s invoice, its own recorded attempt', (key) => ctx.record(s, S1, i2.invoice, JSON.stringify(recordBody(T, r2, 5)), { key })],
      ['record: another tenant\'s invoice, its own recorded attempt', (key) => ctx.record(s, S1, iX.invoice, JSON.stringify(recordBody(T, rX, 7)), { key })],
      ['reversal: another store\'s invoice and payment', (key) => ctx.reverse(s, S1, i2.invoice, p2, JSON.stringify(reverseBody(T, 'other')), { key })],
      ['reversal: another tenant\'s invoice and payment', (key) => ctx.reverse(s, S1, iX.invoice, pX, JSON.stringify(reverseBody(T, 'other')), { key })],
      ['reversal: another store\'s payment under this store\'s invoice', (key) => ctx.reverse(s, S1, i1.invoice, p2, JSON.stringify(reverseBody(T, 'other')), { key })],
    ];
    for (const [label, call] of cases) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T, T2], keys);
      const r = await call(key);
      assertRefusal(r, 404, 'not_found', label);
      shapes.push(Buffer.byteLength(r.body));
      assert.deepEqual(delta(await counts([T, T2], keys), before), LEASE_ONLY, `${label}: rolled back, nothing but the open lease`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease open`);
    }
    assert.equal(new Set(shapes).size, 1, `one 404 shape: ${JSON.stringify(shapes)}`);
    // (2) The read at S1: the same 404 for each, nothing written.
    for (const [label, invoice] of [['a missing invoice', randomUUID()], ['another store\'s invoice', i2.invoice], ['another tenant\'s invoice', iX.invoice]]) {
      const before = await counts([T, T2]);
      const r = await ctx.payments(s, S1, invoice);
      assertRefusal(r, 404, 'not_found', `the read: ${label}`);
      assert.equal(ctx.reason(r), 'invoice_payments_not_found', label);
      assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, `the read: ${label}`);
    }
    // (3) A store with no grant, another tenant's store: the 403 before any key for every payment route.
    for (const [label, store, invoice] of [['an ungranted store', S3, i1.invoice], ['another tenant\'s store', X, iX.invoice]]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T, T2], keys);
      assertRefusal(await ctx.record(s, store, invoice, JSON.stringify(recordBody(T, unregistered(), 1)), { key }), 403, 'forbidden', `${label}: record`);
      assertRefusal(await ctx.reverse(s, store, invoice, pX, JSON.stringify(reverseBody(T, 'other')), { key }), 403, 'forbidden', `${label}: reversal`);
      assertRefusal(await ctx.payments(s, store, invoice), 403, 'forbidden', `${label}: read`);
      assert.equal(verdictOf(await ctx.paymentEligibility(s, store, invoice), `${label}: record eligibility`), 'forbidden');
      assert.equal(verdictOf(await ctx.reversalEligibility(s, store, invoice), `${label}: reversal eligibility`), 'forbidden');
      assert.deepEqual(delta(await counts([T, T2], keys), before), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(key, who.principal), 0, `${label}: refused before any key`);
    }
    // (4) The foreign payments untouched, each read at its own store.
    assert.deepEqual({ [p2]: await paymentRowOf(p2), [pX]: await paymentRowOf(pX) }, rows, 'the foreign payments untouched');
    assert.deepEqual([await reversalRowOf(p2), await reversalRowOf(pX)], [null, null]);
    assert.equal(paymentsOf(await ctx.payments(s, S2, i2.invoice), 'S2\'s own read').amounts.appliedCents, 5);
    assert.equal(paymentsOf(await ctx.payments(sf, X, iX.invoice), 'X\'s own read').amounts.appliedCents, 7);
  });
});

// ===========================================================================
// IPH-06: the read's pages
// ===========================================================================

test('IPH-06 (PAY-11): the read pages 50 payments oldest first by (recorded time, payment id), the cursor the last id of a full page; every page carries the complete history\'s amounts and word; a cursor at the last payment is an empty last page; an unknown cursor (also another invoice\'s payment) and any other query are the 400; the reads write nothing and carry no staff identifier, audit field or correlation id', async () => {
  const w = await world('iph06');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph06');
    const y = await issueOne(ctx, s, w, 'iph06 other');
    const aY = randomUUID();
    const rY = await prepare(ctx, s, w.T, w.S, y.invoice, aY);
    const pY = recordedOf(await ctx.record(s, w.S, y.invoice, JSON.stringify(recordBody(w.T, rY, 1))), y.invoice, aY, 1, 'cash', 'the other invoice\'s payment');
    const N = INVOICE_PAYMENTS_PAGE_SIZE + 2;
    const ids = [];
    const keys = [];
    let before = await counts([w.T]);
    for (let i = 0; i < N; i++) {
      const key = randomUUID();
      keys.push({ key, principal: w.mgr.principal });
      const attempt = randomUUID();
      const method = INVOICE_PAYMENT_METHODS[i % 2];
      const reg = await prepare(ctx, s, w.T, w.S, x.invoice, attempt);
      ids.push(recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, reg, 1, method)), { key }), x.invoice, attempt, 1, method, `payment ${i + 1}`));
    }
    const after = await counts([w.T]);
    // 037: N registrations, N register audit records and N − 1 settle (confirm) audit records between them.
    assert.deepEqual({ P: after.P - before.P, PA: after.PA - before.PA, O: after.O - before.O, OO: after.OO - before.OO, G: after.G - before.G, GA: after.GA - before.GA },
      { P: N, PA: N, O: 0, OO: 0, G: N, GA: 2 * N - 1 }, 'N payments, N audit records, no outbox row; N registrations and their register and settle records');
    reversedOf(await ctx.reverse(s, w.S, x.invoice, ids[0], JSON.stringify(reverseBody(w.T, 'duplicate'))), ids[0], x.invoice, 'the first payment reversed');
    // (1) Two pages.
    before = await counts([w.T]);
    const r1 = await ctx.payments(s, w.S, x.invoice);
    const page1 = paymentsOf(r1, 'page 1');
    assert.equal(page1.payments.length, INVOICE_PAYMENTS_PAGE_SIZE, 'a full page');
    assert.equal(page1.nextCursor, page1.payments[INVOICE_PAYMENTS_PAGE_SIZE - 1].id, 'the cursor: the last id of the full page');
    const r2 = await ctx.payments(s, w.S, x.invoice, `?after=${page1.nextCursor}`);
    const page2 = paymentsOf(r2, 'page 2');
    assert.equal(page2.payments.length, N - INVOICE_PAYMENTS_PAGE_SIZE);
    assert.equal(page2.nextCursor, null, 'nothing more');
    for (const page of [page1, page2]) {
      assert.deepEqual(page.invoice, { id: x.invoice, status: 'issued' });
      assert.deepEqual(page.amounts, amounts(109, N - 1), 'the complete history\'s amounts on every page');
      assert.equal(page.paymentStatus, 'recorded_partly');
    }
    const all = [...page1.payments, ...page2.payments];
    assert.deepEqual(all.map((p) => p.id).sort(), [...ids].sort(), 'every payment exactly once');
    for (let i = 1; i < all.length; i++) {
      const [a, b] = [all[i - 1], all[i]];
      assert.ok(a.recordedAt < b.recordedAt || (a.recordedAt === b.recordedAt && a.id < b.id), `oldest first by (recorded time, id) at ${i}`);
    }
    for (const p of all) assert.deepEqual(p, await wirePaymentOf(p.id), 'the read\'s projection of the stored rows');
    assert.notEqual(all.find((p) => p.id === ids[0]).reversal, null, 'the reversal shown');
    // (2) A cursor at the last payment: an empty last page.
    const last = paymentsOf(await ctx.payments(s, w.S, x.invoice, `?after=${all[all.length - 1].id}`), 'after the last payment');
    assert.deepEqual([last.payments, last.nextCursor, last.amounts], [[], null, amounts(109, N - 1)]);
    // (3) The 400s: an unknown cursor, another invoice's payment, any other query, a non-canonical invoice id.
    for (const [label, query, reason] of [
      ['an unknown cursor', `?after=${randomUUID()}`, 'invoice_payments_cursor_unknown'],
      ['another invoice\'s payment as the cursor', `?after=${pY}`, 'invoice_payments_cursor_unknown'],
      ['a bare ?', '?', 'invoice_payments_query_invalid'],
      ['an empty cursor', '?after=', 'invoice_payments_query_invalid'],
      ['an upper-case cursor', `?after=${upper(page1.nextCursor)}`, 'invoice_payments_query_invalid'],
      ['a limit', '?limit=5', 'invoice_payments_query_invalid'],
      ['two cursors', `?after=${page1.nextCursor}&after=${page1.nextCursor}`, 'invoice_payments_query_invalid'],
      ['a cursor and another key', `?after=${page1.nextCursor}&x=1`, 'invoice_payments_query_invalid'],
      ['a re-cased key', `?After=${page1.nextCursor}`, 'invoice_payments_query_invalid'],
    ]) {
      const r = await ctx.payments(s, w.S, x.invoice, query);
      assertRefusal(r, 400, 'invalid_request', label);
      assert.equal(ctx.reason(r), reason, label);
    }
    assertRefusal(await ctx.payments(s, w.S, upper(x.invoice)), 400, 'invalid_request', 'a non-canonical invoice id');
    assert.deepEqual(delta(await counts([w.T]), before), NOTHING, 'the reads wrote nothing');
    // (4) No staff identifier, audit field or correlation id in any page.
    const text = r1.body + r2.body;
    const correlations = (await owner`select request_id::text as id from public.audit_event where subject_invoice_payment_id = any(${ids}::uuid[])`).map((r) => r.id);
    assert.equal(correlations.length, N + 1, 'N record and one reversal audit records');
    for (const secret of [w.mgr.id, w.mgr.uid, w.boss.id, w.staff.id, w.T, w.S, ...correlations]) assert.ok(!text.includes(secret), `the read carries no ${secret}`);
    for (const word of ['recorded_by', 'recordedBy', 'reversed_by', 'reversedBy', 'actor', 'requestId', 'request_id', 'audit', 'correlation']) {
      assert.ok(!text.includes(word), `the read carries no ${word}`);
    }
  });
});

// ===========================================================================
// IPH-07: the Total
// ===========================================================================

// M7B-PAYMENTS-P2: the runtime's record is 037's v2.
const RECORD_CALL = 'tmpos_invoice_payment.m7b_invoice_payment_record_v2(';
const VOID_CALL = 'tmpos_invoice_payment.m7b_invoice_void_v2(';
const ROLLBACK = Symbol('rollback');
const quietly = (p) => { p.catch(() => {}); return p; };
/** The OWNER holds `invoice`'s issued header FOR UPDATE in an open transaction until `release()` rolls it back; { pid, release }. */
async function holdHeader(invoice) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let taken;
  const held = new Promise((resolve) => { taken = resolve; });
  const done = owner.begin(async (tx) => {
    const [{ pid }] = await tx`select pg_catalog.pg_backend_pid() as pid`;
    await tx`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice} for update`;
    taken(pid);
    await gate;
    throw ROLLBACK;
  }).catch((err) => { if (err !== ROLLBACK) throw sealDbError('IPH the header holder', err); });
  const pid = await Promise.race([held, done.then(() => null)]);
  assert.ok(pid !== null, 'the owner holds the issued header');
  return { pid, release: () => { release(); return done; } };
}
/** The runtime login's backends now waiting on a lock inside `call`, each with the pids blocking it. */
const waitingIn = async (call) => (await owner`select pid, pg_catalog.pg_blocking_pids(pid) as by from pg_catalog.pg_stat_activity
  where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock' and position(${call} in query) > 0`).map((r) => ({ pid: r.pid, by: r.by }));
/** Polls the lock state until `probe` holds; fails fast once any of `pending` answers (each command has a 2 s deadline). */
async function engaged(probe, pending, what) {
  let answered = null;
  for (const p of pending) p.then((r) => { answered = replyNote(r); }, (e) => { answered = `rejected (${e?.constructor?.name ?? 'unknown'})`; });
  for (const end = Date.now() + 1_500; Date.now() < end && answered === null; await delay(5)) {
    const value = await probe();
    if (value) return value;
  }
  throw new Error(`lever did not engage: ${what}${answered === null ? '' : ` (a request answered first: ${answered})`}`);
}

test('IPH-07 (PAY-01 Total 0, PAY-05): two recordings that together exceed the Total, both seen waiting behind the owner\'s lock on the issued header (doc 15 §12.8: a lock barrier, never timing) — one applies, the other is the sealed amount_exceeds_remaining, applied never above the Total; a record and a void behind the same barrier, the record first — the void that waited is the sealed payments_recorded, nothing voided; an invoice whose Total is 0 is nothing_due and refuses even one cent', async () => {
  const w = await world('iph07');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph07');
    // Two managers: one actor's commands already queue on its own app_user row (016's standing hold), before the header.
    const mgr2 = await actor('iph07-mgr2', [storeGrant(w.T, w.S, 'manager')]);
    const s2 = await signIn(ctx, mgr2);
    const senders = [[s, w.mgr], [s2, mgr2]];
    // Each manager's own registration on the invoice (one slot each), before the barrier.
    const regs = [await prepare(ctx, s, w.T, w.S, x.invoice), await prepare(ctx, s2, w.T, w.S, x.invoice)];
    const keys = [randomUUID(), randomUUID()];
    const owned = keys.map((key, i) => ({ key, principal: senders[i][1].principal }));
    const before = await counts([w.T], owned);
    const h = await holdHeader(x.invoice);
    let pending = [];
    try {
      pending = keys.map((key, i) => quietly(ctx.record(senders[i][0], w.S, x.invoice, JSON.stringify(recordBody(w.T, regs[i], 60)), { key })));
      // Both wait: each on the holder, or (the tuple lock's queue) on the other recording; at least one on the holder.
      await engaged(async () => {
        const rows = await waitingIn(RECORD_CALL);
        const pids = [h.pid, ...rows.map((r) => r.pid)];
        return rows.length === 2 && rows.every((r) => r.by.length > 0 && r.by.every((p) => pids.includes(p))) && rows.some((r) => r.by.includes(h.pid));
      }, pending, 'both recordings waiting behind the owner\'s header lock');
    } finally { await h.release(); await Promise.allSettled(pending); }
    const replies = await Promise.all(pending);
    assert.deepEqual(replies.map((r) => r.status).sort(), [201, 409], replies.map(replyNote).join(' | '));
    sealedOf(replies.find((r) => r.status === 409), 'amount_exceeds_remaining', 'the second of two concurrent recordings');
    assert.deepEqual(delta(await counts([w.T], owned), before), { ...NOTHING, P: 1, PA: 1, AA: 1, K: 2, C: 2 }, 'one payment, one audit record, two completions');
    const read = paymentsOf(await ctx.payments(s, w.S, x.invoice), 'after the race');
    assert.deepEqual([read.amounts, read.paymentStatus, read.payments.length], [amounts(109, 60), 'recorded_partly', 1]);
    // A record and a void behind the same barrier, the record sent and seen waiting first: it takes the header first, and the
    // void, queued behind it, reads the committed payment (§12.3: the void then answers payments_recorded).
    const y = await issueOne(ctx, s, w, 'iph07 void race');
    const rk = randomUUID();
    const vk = randomUUID();
    const pair = [{ key: rk, principal: mgr2.principal }, { key: vk, principal: w.mgr.principal }];
    const A = randomUUID();
    const ra = await prepare(ctx, s2, w.T, w.S, y.invoice, A);
    const b0 = await counts([w.T], pair);
    const g = await holdHeader(y.invoice);
    let rec = null;
    let vd = null;
    try {
      rec = quietly(ctx.record(s2, w.S, y.invoice, JSON.stringify(recordBody(w.T, ra, 1)), { key: rk }));
      const [first] = await engaged(async () => {
        const rows = await waitingIn(RECORD_CALL);
        return rows.length === 1 && rows[0].by.includes(g.pid) ? rows : null;
      }, [rec], 'the record waiting on the owner\'s header lock');
      vd = quietly(ctx.voidInvoice(s, w.S, y.invoice, JSON.stringify(voidBody(w.T, 'duplicate')), { key: vk }));
      await engaged(async () => {
        const rows = await waitingIn(VOID_CALL);
        return rows.length === 1 && rows[0].by.length > 0 && rows[0].by.every((p) => p === g.pid || p === first.pid);
      }, [rec, vd], 'the void waiting behind the holder and the record');
    } finally { await g.release(); await Promise.allSettled([rec, vd].filter(Boolean)); }
    recordedOf(await rec, y.invoice, A, 1, 'cash', 'the record that took the header first');
    sealedOf(await vd, 'payments_recorded', 'the void that waited behind the record');
    assert.deepEqual(delta(await counts([w.T], pair), b0), { ...NOTHING, P: 1, PA: 1, AA: 1, K: 2, C: 2 }, 'one payment and its audit record, two completions; no void record');
    // A Total of 0.
    const z = await issueOne(ctx, s, w, 'iph07 zero', [line(`IPH iph07 zero ${SUFFIX}`, 1, 0)]);
    assert.equal(z.total, 0);
    assert.deepEqual(paymentsOf(await ctx.payments(s, w.S, z.invoice), 'a Total of 0'), {
      invoice: { id: z.invoice, status: 'issued' }, amounts: amounts(0, 0), paymentStatus: 'nothing_due', payments: [], nextCursor: null,
    });
    const rz = await prepare(ctx, s, w.T, w.S, z.invoice);
    const k = randomUUID();
    const b = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
    sealedOf(await ctx.record(s, w.S, z.invoice, JSON.stringify(recordBody(w.T, rz, 1)), { key: k }), 'amount_exceeds_remaining', 'one cent on a Total of 0');
    assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), b), COMPLETION_ONLY);
  });
});

// ===========================================================================
// IPH-08: one reversal per payment — concurrent keys, and a key past its retention
// ===========================================================================

const REVERSE_CALL = 'tmpos_invoice_payment.m7b_invoice_payment_reverse(';
/** The owner ages a key's record past its lease and its retention, as if IDEMPOTENCY_POLICY.retentionMs had passed. */
const expireRecord = (key, principal) => owner`update tmpos_internal.idempotency_record
  set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second', expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where scope = ${scopeOf(key, principal)} returning 1`;

test('IPH-08 (PAY-03, PAY-05, PAY-08): two reversals of one payment under DIFFERENT Idempotency-Keys from two managers, both seen waiting behind the owner\'s lock on the issued header — one the sealed 200, the other the sealed 409 invalid_state; one reversal record and ONE reversal audit record (the winner\'s), two completions; the winner\'s key resent after its record is aged past retention runs again (not a replay) and is the sealed 409 invalid_state, writing no reversal and no audit record', async () => {
  const w = await world('iph08');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph08');
    // Two managers: one actor's commands already queue on its own app_user row (016's standing hold), before the header.
    const mgr2 = await actor('iph08-mgr2', [storeGrant(w.T, w.S, 'manager')]);
    const s2 = await signIn(ctx, mgr2);
    const A = randomUUID();
    const ra = await prepare(ctx, s, w.T, w.S, x.invoice, A);
    const p = recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, 100))), x.invoice, A, 100, 'cash', 'the payment');
    const senders = [[s, w.mgr, 'duplicate'], [s2, mgr2, 'wrong_amount']];
    const keys = [randomUUID(), randomUUID()];
    const owned = keys.map((key, i) => ({ key, principal: senders[i][1].principal }));
    const bodies = senders.map(([, , reason]) => JSON.stringify(reverseBody(w.T, reason)));
    const before = await counts([w.T], owned);
    const h = await holdHeader(x.invoice);
    let pending = [];
    try {
      pending = keys.map((key, i) => quietly(ctx.reverse(senders[i][0], w.S, x.invoice, p, bodies[i], { key })));
      await engaged(async () => {
        const rows = await waitingIn(REVERSE_CALL);
        const pids = [h.pid, ...rows.map((r) => r.pid)];
        return rows.length === 2 && rows.every((r) => r.by.length > 0 && r.by.every((q) => pids.includes(q))) && rows.some((r) => r.by.includes(h.pid));
      }, pending, 'both reversals waiting behind the owner\'s header lock');
    } finally { await h.release(); await Promise.allSettled(pending); }
    const replies = await Promise.all(pending);
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409], replies.map(replyNote).join(' | '));
    const won = replies.findIndex((r) => r.status === 200);
    reversedOf(replies[won], p, x.invoice, 'the reversal that took the header first');
    sealedOf(replies[1 - won], 'invalid_state', 'the second of two concurrent reversals');
    assert.deepEqual(delta(await counts([w.T], owned), before), { ...NOTHING, R: 1, RA: 1, AA: 1, K: 2, C: 2 }, 'one reversal, one audit record, two completions');
    const rev = await reversalRowOf(p);
    assert.deepEqual([rev.reason_code, rev.reversed_by], [senders[won][2], senders[won][1].id], 'the winner\'s reversal as stored');
    const reverses = () => auditOf(p).then((rows) => rows.filter((a) => a.action_id === REVERSE_ACTION).map((a) => a.actor_internal_user_id));
    assert.deepEqual(await reverses(), [senders[won][1].id], 'one reversal audit record for the payment: the winner\'s');
    // The winner's key past its retention: the record is overwritten in place and the command runs again — invalid_state.
    assert.equal((await expireRecord(keys[won], owned[won].principal)).length, 1, 'the winner\'s record aged past its retention');
    const b1 = await counts([w.T], owned);
    sealedOf(await ctx.reverse(senders[won][0], w.S, x.invoice, p, bodies[won], { key: keys[won] }), 'invalid_state', 'the winner\'s key resent after its retention');
    assert.deepEqual(delta(await counts([w.T], owned), b1), NOTHING, 'its record overwritten in place: no reversal, no audit record, no new completion');
    assert.equal(Number((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment_reversal where payment_id = ${p}`)[0].n), 1, 'still one reversal');
    assert.deepEqual(await reverses(), [senders[won][1].id], 'still one reversal audit record');
  });
});

// ===========================================================================
// IPH-09..10: the reversal's key — the same key concurrently, and a lease left by a stale tenant
// ===========================================================================

const ACQUIRE_CALL = 'tmpos_internal.m6_idempotency_acquire(';

test('IPH-09 (PAY-03, PAY-04): the same Idempotency-Key and body sent again while the first reversal waits behind the owner\'s header lock — the first\'s transaction holds its record under the fence, so the second\'s acquire waits on that row and runs out its bound: the 503 service_unavailable (idempotency_unavailable), nothing stored for it; released, the first is the sealed 200 and stored; a later same-key resend replays it (Idempotent-Replayed: true); one reversal, one reversal audit record, one completion', async () => {
  const w = await world('iph09');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph09');
    const A = randomUUID();
    const ra = await prepare(ctx, s, w.T, w.S, x.invoice, A);
    const p = recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, 100))), x.invoice, A, 100, 'cash', 'the payment');
    const key = randomUUID();
    const owned = [{ key, principal: w.mgr.principal }];
    const body = JSON.stringify(reverseBody(w.T, 'duplicate'));
    const before = await counts([w.T], owned);
    const h = await holdHeader(x.invoice);
    let first = null;
    let second = null;
    try {
      first = quietly(ctx.reverse(s, w.S, x.invoice, p, body, { key }));
      const [held] = await engaged(async () => {
        const rows = await waitingIn(REVERSE_CALL);
        return rows.length === 1 && rows[0].by.includes(h.pid) ? rows : null;
      }, [first], 'the first reversal waiting on the owner\'s header lock');
      second = quietly(ctx.reverse(s, w.S, x.invoice, p, body, { key }));
      await engaged(async () => {
        const rows = await waitingIn(ACQUIRE_CALL);
        return rows.length === 1 && rows[0].by.includes(held.pid);
      }, [first, second], 'the second\'s acquire waiting on the first\'s fenced record');
      const r2 = await second;
      assertRefusal(r2, 503, 'service_unavailable', 'the same key while the first holds its record');
      assert.equal(ctx.reason(r2), 'idempotency_unavailable', 'its acquire ran out its lock bound');
    } finally { await h.release(); await Promise.allSettled([first, second].filter(Boolean)); }
    const r1 = await first;
    reversedOf(r1, p, x.invoice, 'the first, released');
    assert.deepEqual(delta(await counts([w.T], owned), before), ONE_REVERSAL, 'one reversal, one audit record, one completion');
    const replay = await ctx.reverse(s, w.S, x.invoice, p, body, { key });
    reversedOf(replay, p, x.invoice, 'the later same-key resend', { replayed: true });
    assert.equal(replay.body, r1.body, 'the stored answer');
    assert.deepEqual(delta(await counts([w.T], owned), before), ONE_REVERSAL, 'the replay wrote nothing');
    assert.equal((await auditOf(p)).filter((a) => a.action_id === REVERSE_ACTION).length, 1, 'one reversal audit record');
  });
});

test('IPH-10 (PAY-02, PAY-03): a reversal with a stale expectedTenant is the unsealed 409 write_conflict with a requestId — rolled back, nothing stored, the lease held; the same key resent within the lease is the 409 request_in_progress, writing nothing; the payment stays unreversed', async () => {
  const w = await world('iph10');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'iph10');
    const A = randomUUID();
    const ra = await prepare(ctx, s, w.T, w.S, x.invoice, A);
    const p = recordedOf(await ctx.record(s, w.S, x.invoice, JSON.stringify(recordBody(w.T, ra, 100))), x.invoice, A, 100, 'cash', 'the payment');
    const other = await newTenant('iph10-other');
    const key = randomUUID();
    const owned = [{ key, principal: w.mgr.principal }];
    const body = JSON.stringify(reverseBody(other, 'duplicate'));
    let before = await counts([w.T], owned);
    assertRefusal(await ctx.reverse(s, w.S, x.invoice, p, body, { key }), 409, 'write_conflict', 'a stale expectedTenant');
    assert.deepEqual(delta(await counts([w.T], owned), before), LEASE_ONLY, 'rolled back, the lease kept');
    assert.equal(await leaseOpen(key, w.mgr.principal), true, 'the lease held, nothing stored');
    before = await counts([w.T], owned);
    assertRefusal(await ctx.reverse(s, w.S, x.invoice, p, body, { key }), 409, 'request_in_progress', 'the same key within the lease');
    assert.deepEqual(delta(await counts([w.T], owned), before), NOTHING, 'the retry wrote nothing');
    assert.equal(await leaseOpen(key, w.mgr.principal), true, 'still the open lease');
    assert.equal(await reversalRowOf(p), null, 'the payment unreversed');
  });
});
