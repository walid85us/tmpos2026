// =============================================================================
// M7B credit activity (docs/phase-4/18, migration 039) — the store-wide credit-activity read over the REAL composed tenant entry (SCH)
// =============================================================================
//
// WRITTEN — NOT RUN. Authored in the doc 18 implementation slice under a local-authoring-only constraint: no test, typecheck,
// build, database or CI run has executed this file. Every acceptance row below is PLANNED — NOT RUN until an approved run.
// Registered in CI (2026-11-19, execution pending); tests/quality/migration-executor-containment.test.mjs lists it.
//
// An independent HTTP acceptance suite for doc 18 §5 (GET /api/v1/stores/{storeId}/credit-notes, D-CA-1 A: the owner-only
// view_store_credit_activity), over startTenantEntry and a DURABLE disposable PostgreSQL (the credit-note proof refuses fsync
// off) with every migration in the directory applied (039 included) and the owner-installed proof key in place. Each test names
// the doc 18 §13 rows whose H (HTTP through the tenant entry) part it evidences:
//
//   SCH-00 (scope)               the shipping table carries the activity route, bodiless, no idempotency;
//   SCH-01 (CA-01, CA-07, CA-08, CA-38 H)  empty store → 200 []/null; a 120-note walk 50/50/20, strictly newest number
//          first, no repeat, no gap, ends null; a note issued between pages on no later page and first after a reload; a
//          "Show more" page served with a newer status than the loaded page 1;
//   SCH-02 (CA-02, CA-03, CA-09, CA-33)  another store's and another tenant's notes never appear; their store ids and an id
//          that exists nowhere are 403 with one body shape, never 404; their cursors and a random one are 400 with one body
//          shape (only requestId differs) — the malformed query's shape too; a denied caller's cursor is never evaluated;
//   SCH-03 (CA-04, CA-34 H)      a manager at Invoices Full, a technician, a sales_staff member (defaults) and the tenant-scope
//          owner → 403 at authorization; the same roles under owner-edited Invoices levels → 403 (the role decides);
//   SCH-04 (CA-05, A)            the store owner of a read-only or overdue tenant or store → 403 at authorization; the direct
//          routine call with that live session's key still answers (residual (a), recorded, not prevented);
//   SCH-05 (CA-06, CA-46 H read route only)  a suspended or pending tenant or store → 401 session_admission_denied (session
//          loss), never rows; the live-session 403 of a status change is a race, UNCOVERED; a trialing tenant's
//          session still reaches the read; an unregistered route is 404 with no session while a sessionless request to the
//          served route on the same host is 401. The write-setting parts of CA-46 (the three write routes, the switch) are OUT
//          OF SCOPE of this slice: the write setting is not built (doc 18 §6.6, D-CA-14 A, PENDING);
//   SCH-06 (CA-11)               a withdrawn note carries its withdrawal (not before issue, closed reason, name); an active note
//          null; a voided invoice's withdrawn note stays listed;
//   SCH-07 (CA-12 H)             a null display name → null; exactly 1,000 characters served; over 1,000 or a control character
//          → 503 for the page (the page below it still answers);
//   SCH-08 (CA-13)               the session CSRF header missing, repeated or another session's → 403 before authorization;
//   SCH-09 (CA-14 H)             401 after sign-out; the per-client request limit → 429 with Retry-After, nothing stored;
//   SCH-10 (CA-15a, CA-15b H PARTIAL, CA-16 H)  a role change between pages, a narrowed role and a moved store grant → 401
//          session_version_mismatch (session loss), never rows; the "still admitted, then 403" branches are races, UNCOVERED
//          at H; CA-15b's permission denial under a live session is SCH-03 (403 authz_denied) and SCA-U3 ('denied' → 403);
//   SCH-11 (CA-23 H)             two store-scope owners' notes on ONE invoice, seeded by owner SQL (historical data, not created
//          through the product): each owner's view shows both with each issuer's name;
//   SCH-12 (CA-10 H, CA-38 H)    a bare `?`, an empty, uppercase, braced or non-uuid `after`, a second key, a repeated `after`,
//          any `limit`, `cursor` or `before` → 400 store_credit_activity_query_invalid, before any routine call.
//
// It never touches a managed or remote database. Cleanup lifts 038's guards inside one owner transaction and removes every
// credit note, withdrawal, registration and credit-note audit row it created, so 038's and 039's downs can still run afterwards.
// Run (when approved): flock <lock> env TMPDIR=/tmp node_modules/.bin/tsx scripts/run-db-tests.mjs tests/db/storeCreditActivityHttp.integration.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, installTestPaymentProofKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry, TENANT_SHIPPING_ROUTES } from '../../server/entry/tenantEntry.ts';
import { REQUIRED_MIGRATIONS } from '../../server/persistence/postgresStartupPreflight.ts';
import { SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { RATE_LIMITS } from '../../server/runtime/rateLimit.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'sch-migrator', runtimeRef: 'sch-runtime' };
const LOCK_KEY = 529_647;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_sch_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';
const CN = 'tmpos_invoice_credit_note';
const PAY = 'tmpos_invoice_payment';
const CN_ACTIONS = ['store.invoice_credit_note.register', 'store.invoice_credit_note.issue', 'store.invoice_credit_note.settle', 'store.invoice_credit_note.withdraw'];
const SEND_TIMEOUT_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The routine's UTC text with microseconds (doc 18 §5.2; 039's format). */
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ISSUE_REASONS = ['pricing_error', 'service_issue', 'goodwill', 'billing_error'];
const WITHDRAWAL_REASONS = ['entered_in_error', 'wrong_amount', 'wrong_invoice'];

// Secret-safe failure output: cookies, CSRF tokens, session keys, proofs and bodies never reach a failure message; only a
// status, a sealed error word, a log reason (a closed word) or a SQLSTATE do.
const isSqlState = (code) => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code);
const safeCode = (e) => (e?.code === undefined || e?.code === null ? 'none' : isSqlState(e.code) ? e.code : 'unknown');
function sealDbError(label, e) {
  if (isSqlState(e?.code)) return new Error(`${label}: SQLSTATE ${e.code}`);
  const bare = e instanceof Error && !(e instanceof AggregateError)
    && e.cause === undefined && e.detail === undefined && e.hint === undefined && e.where === undefined;
  if (bare) return e;
  const name = typeof e?.constructor?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.constructor.name) ? e.constructor.name : 'unknown';
  return new Error(`${label}: failed (${name})`);
}
function sealedWord(body) {
  try {
    const b = JSON.parse(body);
    const keys = b !== null && typeof b === 'object' ? Object.keys(b) : [];
    return keys.includes('error') && keys.every((k) => k === 'error' || k === 'requestId') && /^[a-z][a-z_]{0,39}$/.test(b.error) ? b.error : null;
  } catch {
    return null;
  }
}
const replyNote = (reply) => { const word = sealedWord(reply.body); return `status ${reply.status}${word === null ? '' : ` ${word}`}`; };
function parseBody(reply, label) {
  try {
    return JSON.parse(reply.body);
  } catch {
    throw new Error(`${label}: response body is not JSON (${replyNote(reply)})`);
  }
}

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('SCH', { durable: true });
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
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);
const KEYRING = createIdempotencyKeyring(IDEMPOTENCY_KEY);
const scopeOf = (key, principal) => KEYRING.operationOf(key, principal, {
  method: 'POST', path: '/', audience: 'tenant', tenant: null, store: null, actor: null, body: new Uint8Array(0),
}).scope;

// Copied from tests/db/invoiceCreditNoteHttp.integration.test.mjs:180-198 (itself from the payment registration routine suite).
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
const CN_GUARDS = [[`${CN}.invoice_credit_note_withdrawal`, 'trg_invoice_credit_note_withdrawal_guard'],
  [`${CN}.invoice_credit_note_registration`, 'trg_invoice_credit_note_registration_guard'], [`${CN}.invoice_credit_note`, 'trg_invoice_credit_note_guard'],
  [`${CN}.invoice_credit_note_counter`, 'trg_invoice_credit_note_counter_guard']];

/** Everything this suite's tenants hold, in ONE owner transaction with the guards lifted only inside it (the ICH suite's cleanAll). */
async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin('isolation level read committed', async (sql) => {
    await withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']], async () => {
      await sql`delete from public.audit_event where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`update public.audit_event set subject_issued_invoice_id = null
        where subject_issued_invoice_id in (select invoice_id from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_invoice_draft_id = null
        where subject_invoice_draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_store_id = null
        where subject_store_id in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_customer_id = null
        where subject_customer_id in (select customer_id from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]))`;
    });
    await withTriggersLifted(sql, CN_GUARDS, async () => {
      await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`update tmpos_invoice_credit_note.invoice_credit_note_registration set credit_note_id = null where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_credit_note.invoice_credit_note where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = any(${TENANTS}::uuid[])`;
    });
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
    await withTriggersLifted(sql, [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']], async () => {
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
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(sealDbError('SCH teardown step', err)); } };
  try {
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
    // 038's down refuses while ANY credit-note evidence exists; 039's is pinned by the preflight: none may remain, 039 unchanged.
    await step(async () => {
      const [state] = await owner`select
        (select count(*) from tmpos_invoice_credit_note.invoice_credit_note)::int as notes,
        (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal)::int as withdrawals,
        (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration)::int as registrations,
        (select count(*) from public.audit_event where action_id = any(${CN_ACTIONS}::text[]) or subject_invoice_credit_note_id is not null
           or subject_invoice_credit_note_registration_id is not null)::int as cn_audits,
        (select count(*) from public.audit_event where tenant_id = any(${TENANTS}::uuid[]))::int as audits,
        (select count(*) from tmpos_invoice_payment.payment_proof_key)::int as keys,
        (select max(version) from public.schema_migrations) as latest,
        (select checksum from public.schema_migrations where version = '039')
          = ${REQUIRED_MIGRATIONS.find((m) => m.version === '039')?.checksum ?? null}::text as ledger_pinned`;
      assert.deepEqual({ ...state }, { notes: 0, withdrawals: 0, registrations: 0, cn_audits: 0, audits: 0, keys: 0, latest: '039', ledger_pinned: true },
        'no credit-note evidence anywhere (038\'s and 039\'s downs can run), 039 as the preflight pins it, nothing of this suite left');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'SCH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (raw) {
    const err = sealDbError('SCH setup', raw);
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'SCH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// setup (the ICH suite's, through 039)
// ---------------------------------------------------------------------------

await setupStep(async () => {
  const [settings] = await owner`select pg_catalog.current_setting('fsync') as fsync, pg_catalog.current_setting('synchronous_commit') as sc,
    pg_catalog.current_setting('full_page_writes') as fpw`;
  assert.deepEqual({ ...settings }, { fsync: 'on', sc: 'on', fpw: 'on' }, 'a durable cluster: the credit-note proof routine refuses fsync off');
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
  const [{ latest }] = await owner`select max(version) as latest from public.schema_migrations`;
  assert.equal(latest, '039', 'migrations through 039 are applied');
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
  await installTestIssuerKey(owner, ISSUER_KEY).catch((e) => { throw new Error(`SCH issuer key install failed: SQLSTATE ${safeCode(e)}`); });
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_payment.payment_proof_key`)[0].n, 0, 'no proof key before this suite installs one');
  assert.equal(await installTestPaymentProofKey(owner), true, 'the owner-installed proof key (037\'s, reused by 038)');
});

// ---------------------------------------------------------------------------
// identity, configuration, requests
// ---------------------------------------------------------------------------

const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) { const err = new Error('unknown_token'); err.code = 'auth/invalid-id-token'; throw err; }
    return { uid: rec.uid, authTime: Math.floor(Date.now() / 1000), secondFactor: 'totp' };
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
  TMPOS_CREDIT_NOTE_WRITES: 'on', // doc 18 §6.6 (D-CA-14 A): required by the tenant entry
  IDEMPOTENCY_KEY: IDEMPOTENCY_KEY.toString('base64url'),
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', project_id: 'sch-test-project', client_email: 'sch-test@sch-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
  }),
});

function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}
/** A request from a fresh loopback source unless `localAddress` names one (the per-client limit decides nothing otherwise). */
function send(port, method, path, headers, body, { localAddress = randomLoopback() } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
  const framed = method === 'GET' ? { ...headers } : { 'content-length': String(payload?.length ?? 0), ...headers };
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: framed, agent: false, localAddress }, (res) => {
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
/** The chain's or the handler's refusal: exactly { error, requestId }, never replayed. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${replyNote(reply)}`);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${replyNote(reply)}`);
  assert.ok(body.error === error, `${label}: refusal word ${sealedWord(reply.body) ?? '(not a sealed word)'} (expected ${error})`);
  assert.equal(reply.headers['idempotent-replayed'], undefined, `${label}: never a replay`);
  assertBaseline(reply, label);
}
/** The refusal's body with its requestId masked: two refusals of one shape compare equal (doc 18 CA-09, CA-33). */
const shapeOf = (reply) => JSON.stringify({ ...parseBody(reply, 'shape'), requestId: '-' });

// ---------------------------------------------------------------------------
// fixtures (the ICH suite's)
// ---------------------------------------------------------------------------

async function newTenant(label) {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`sch-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(id);
  return id;
}
async function newStore(tenant, name) {
  return (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`${name} ${SUFFIX}`}, 'active') returning store_id`)[0].store_id;
}
async function newCustomer(tenant, label) {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`SCH ${label} ${SUFFIX}`})`;
  return id;
}
/** A staff member: identity, active app_user (optionally named), the memberships. */
async function actor(label, memberships, { displayName = null } = {}) {
  const uid = `sch-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status, display_name) values (${id}, 'active', ${displayName})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  UIDS.push(uid);
  return { id, uid, token, label, displayName, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
/** A store-scope store_owner: exactly one active (store, store_owner) membership at `store`. */
const storeOwner = (w, label, store = w.S, displayName = `SCH ${label} ${SUFFIX}`) =>
  actor(`${w.label}-${label}`, [storeGrant(w.T, store, 'store_owner')], { displayName });
const RATE_8875 = Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: 8875 });
const sellerOf = (label) => ({
  legalName: `SCH ${label} legal ${SUFFIX}`, storeName: `SCH ${label} shop ${SUFFIX}`,
  postalAddress: `SCH ${label} street ${SUFFIX}\nSCH city`, taxRegistrationId: `SCH-${label}-${SUFFIX}`, tax: RATE_8875,
});
/** An owner-edited level (tests/db/invoiceDraftCreateAuthorityHttp.integration.test.mjs:494's form). */
const setLevel = (tenant, role, domain, level) => owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;

/**
 * What a read must leave unchanged: the credit-note rows and counters of `tenants`, every credit-note audit row, every outbox
 * event and every idempotency lease. (Session bookkeeping a refused request may cause — a revocation — is the chain's, not
 * the read's, and is not counted; doc 18 CA-19 proves "no row in any table" for the routine at the D layer.)
 */
async function footprint(tenants) {
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_credit_note.invoice_credit_note where tenant_id = any(${tenants}::uuid[]))::int as cn,
    (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where tenant_id = any(${tenants}::uuid[]))::int as wd,
    (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = any(${tenants}::uuid[]))::int as rg,
    (select coalesce(sum(last_number), 0) from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = any(${tenants}::uuid[]))::int as nb,
    (select count(*) from public.audit_event where action_id = any(${CN_ACTIONS}::text[]) or subject_invoice_credit_note_id is not null
       or subject_invoice_credit_note_registration_id is not null)::int as ca,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le`;
  return { ...r };
}
/** Runs the reads in `fn` and asserts they wrote nothing (doc 18 §6.2 item 6: no row, no audit, no key). */
async function readsOnly(tenants, label, fn) {
  const before = await footprint(tenants);
  const value = await fn();
  assert.deepEqual(await footprint(tenants), before, `${label}: the read wrote nothing`);
  return value;
}

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

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
  const unsafe = (s, method, path, body, key) => {
    USED_KEYS.push({ key, principal: s.principal });
    return send(port, method, path, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf, 'idempotency-key': key,
    }, JSON.stringify(body));
  };
  const inv = (w, invoice) => `/api/v1/stores/${w.S}/invoices/${invoice}`;
  const ctx = {
    port, lines,
    /** A GET: `s` null is sessionless; `headers` override, `drop` removes named headers; `from` pins the client address. */
    read: (s, path, { headers = {}, drop = [], from } = {}) => {
      const all = { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers };
      for (const name of drop) delete all[name];
      return send(port, 'GET', path, all, undefined, from === undefined ? {} : { localAddress: from });
    },
    /** The activity read (doc 18 §5.1) of `store`, with an optional raw query (`?…`). */
    activity: (s, store, query = '', opts) => ctx.read(s, `/api/v1/stores/${store}/credit-notes${query}`, opts),
    settings: (s, store) => ctx.read(s, `/api/v1/issuing-settings/${store}`),
    putSettings: (s, store, body, key = randomUUID()) => unsafe(s, 'PUT', `/api/v1/issuing-settings/${store}`, body, key),
    save: (s, store, body, key = randomUUID()) => unsafe(s, 'POST', `/api/v1/stores/${store}/invoice-drafts`, body, key),
    issueDraft: (s, store, id, body, key = randomUUID()) => unsafe(s, 'POST', `/api/v1/stores/${store}/invoice-drafts/${id}/issue`, body, key),
    register: (s, w, invoice, body, key = randomUUID()) => unsafe(s, 'POST', `${inv(w, invoice)}/credit-note-registrations`, body, key),
    proof: (s, w, invoice, registration) => ctx.read(s, `${inv(w, invoice)}/credit-note-registration-proof?registration=${registration}`),
    issue: (s, w, invoice, body, key = randomUUID()) => unsafe(s, 'POST', `${inv(w, invoice)}/credit-notes`, body, key),
    settle: (s, w, invoice, body, key = randomUUID()) => unsafe(s, 'POST', `${inv(w, invoice)}/credit-note-settlement`, body, key),
    withdraw: (s, w, invoice, cn, body, key = randomUUID()) => unsafe(s, 'POST', `${inv(w, invoice)}/credit-notes/${cn}/withdrawal`, body, key),
    voidInvoice: (s, w, invoice, body, key = randomUUID()) => unsafe(s, 'POST', `${inv(w, invoice)}/void`, body, key),
    logout: (s) => send(port, 'POST', sessionPaths('tenant').logout, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf,
    }, undefined),
    /** The request's one log line's reason word, or '-'. */
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
    throw sealDbError('SCH case', err);
  } finally {
    if (codes.length === 0) {
      proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; codes.length === 0 && Date.now() < until;) await delay(10);
    }
    if (!failed) assert.equal(codes.length, 1, 'the entry exited within 5 s of SIGTERM');
  }
}
/** A sign-in through the tenant entry (the ICH suite's). An account signs in at most five times in five minutes. */
async function signIn(ctx, who) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${who.token}`,
  }, undefined);
  assert.equal(reply.status, 200, `login ${who.label}: ${replyNote(reply)}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const csrf = parseBody(reply, `login ${who.label}`).csrfToken;
  const key = createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
  KEYS.add(key);
  return { cookie, csrf, principal: who.principal, key, who };
}
/** A fresh tenant: store S, a customer, a tenant-scope owner (boss) who writes S's issuing settings, a store manager. */
async function world(ctx, label) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label.toUpperCase()} store`);
  const C = await newCustomer(T, label);
  const boss = await actor(`${label}-boss`, [tenantGrant(T, 'store_owner')]);
  const mgr = await actor(`${label}-mgr`, [storeGrant(T, S, 'manager')]);
  const w = { label, T, S, C, boss, mgr };
  w.sb = await signIn(ctx, boss);
  w.settingsVersion = await configure(ctx, w.sb, T, S, label);
  w.sm = await signIn(ctx, mgr);
  return w;
}
async function configure(ctx, sb, T, S, label) {
  const read = await ctx.settings(sb, S);
  assert.equal(read.status, 200, `settings read: ${replyNote(read)}`);
  const version = parseBody(read, 'settings read').issuingSettings.version;
  const put = await ctx.putSettings(sb, S, { expectedTenant: T, expectedVersion: version, ...sellerOf(label) });
  assert.equal(put.status, 200, `settings PUT: ${replyNote(put)}`);
  return version + 1;
}
/** A draft saved and issued by `s` at `w`'s store: the issued invoice id (Total 10,888). */
async function issueOne(ctx, s, w, label) {
  const saved = await ctx.save(s, w.S, { expectedTenant: w.T, customerId: w.C, currency: 'USD', lines: [{ description: `SCH ${label} ${SUFFIX}`, quantity: 1, unitPriceCents: 10_000 }] });
  assert.equal(saved.status, 201, `${label}: the seed save: ${replyNote(saved)}`);
  const draft = parseBody(saved, `${label}: the seed save`).draft.id;
  const issued = await ctx.issueDraft(s, w.S, draft, { expectedTenant: w.T, expectedVersion: 1, expectedSettingsVersion: w.settingsVersion, expectedCustomerVersion: 1 });
  assert.equal(issued.status, 201, `${label}: the issue: ${replyNote(issued)}`);
  const invoice = parseBody(issued, `${label}: the issue`).invoice.id;
  assert.match(invoice, UUID_RE);
  return invoice;
}
/** register → proof → issue → confirm, over HTTP, by `s` (a store-scope owner): the new credit note's id. The proof is never printed. */
async function credited(ctx, s, w, invoice, gross, label, reason = 'pricing_error') {
  const attemptId = randomUUID();
  const reg = await ctx.register(s, w, invoice, { expectedTenant: w.T, attemptId, grossCents: gross, reason });
  assert.equal(reg.status, 201, `${label}: register: ${replyNote(reg)}`);
  const registrationId = parseBody(reg, `${label}: register`).registration.id;
  const pr = await ctx.proof(s, w, invoice, registrationId);
  assert.equal(pr.status, 200, `${label}: proof: ${replyNote(pr)}`);
  const registrationProof = parseBody(pr, `${label}: proof`).proof;
  const iss = await ctx.issue(s, w, invoice, { expectedTenant: w.T, registrationId, attemptId, grossCents: gross, reason, registrationProof });
  assert.equal(iss.status, 201, `${label}: issue: ${replyNote(iss)}`);
  const creditNote = parseBody(iss, `${label}: issue`).creditNote.id;
  assert.match(creditNote, UUID_RE);
  // Confirm, so the owner's slot on the invoice is free again (038: one unsettled registration per owner and invoice).
  const st = await ctx.settle(s, w, invoice, { expectedTenant: w.T, attemptId, expectedVersion: 2 });
  assert.equal(st.status, 200, `${label}: confirm: ${replyNote(st)}`);
  return creditNote;
}
const withdrawBody = (w, reason = 'wrong_amount') => ({ expectedTenant: w.T, expectedVersion: 1, reason });

/**
 * DB-seeded credit notes (the ICH suite's seedNotes, generalized): `n` confirmed notes of `who` on `invoice` at `w`'s store,
 * numbered on from the store's counter, issued 1..n microseconds after the invoice; the `withdrawn` (1-based) withdrawn by
 * `who` at their issue time. Inside ONE owner transaction with 038's guards lifted; cleanAll removes them with the tenant.
 * Returns the ids in number order (index k holds number last+k+1).
 */
async function seedNotes(w, invoice, who, n, withdrawn = [], { reason = 'goodwill', gross = 1 } = {}) {
  const regs = Array.from({ length: n }, () => randomUUID());
  const attempts = Array.from({ length: n }, () => randomUUID());
  const notes = Array.from({ length: n }, () => randomUUID());
  await owner.begin(async (sql) => withTriggersLifted(sql, CN_GUARDS, async () => {
    const [{ last }] = await sql`select coalesce((select c.last_number from tmpos_invoice_credit_note.invoice_credit_note_counter c
      where c.tenant_id = ${w.T} and c.store_id = ${w.S}), 0)::int as last`;
    await sql`insert into tmpos_invoice_credit_note.invoice_credit_note_registration (registration_id, tenant_id, store_id, invoice_id,
        registered_by, attempt_id, gross_cents, reason_code, session_digest, key_generation, registered_xact, registered_at, acknowledged_at)
      select s.r, ${w.T}, ${w.S}, ${invoice}, ${who.id}, s.a, ${gross}, ${reason}, pg_catalog.sha256(pg_catalog.convert_to(s.r::text, 'UTF8')),
        (select k.generation from tmpos_invoice_payment.payment_proof_key k where k.singleton), pg_catalog.pg_current_xact_id(),
        i.issued_at + s.n * interval '1 microsecond', i.issued_at + s.n * interval '1 microsecond'
      from unnest(${regs}::uuid[], ${attempts}::uuid[]) with ordinality as s(r, a, n)
      join tmpos_invoice_issue.issued_invoice i on i.invoice_id = ${invoice}`;
    await sql`insert into tmpos_invoice_credit_note.invoice_credit_note (credit_note_id, tenant_id, store_id, invoice_id, attempt_id, registration_id,
        credit_note_number, gross_cents, tax_cents, net_cents, reason_code, issued_at, issued_by)
      select s.c, g.tenant_id, g.store_id, g.invoice_id, g.attempt_id, g.registration_id, ${last}::bigint + s.n, g.gross_cents, 0, g.gross_cents, g.reason_code,
        g.registered_at, g.registered_by
      from unnest(${regs}::uuid[], ${notes}::uuid[]) with ordinality as s(r, c, n)
      join tmpos_invoice_credit_note.invoice_credit_note_registration g on g.registration_id = s.r`;
    await sql`update tmpos_invoice_credit_note.invoice_credit_note_registration g set credit_note_id = c.credit_note_id
      from tmpos_invoice_credit_note.invoice_credit_note c where c.registration_id = g.registration_id and g.registration_id = any(${regs}::uuid[])`;
    await sql`insert into tmpos_invoice_credit_note.invoice_credit_note_withdrawal (credit_note_id, tenant_id, store_id, invoice_id, reason_code,
        withdrawn_at, withdrawn_by)
      select c.credit_note_id, c.tenant_id, c.store_id, c.invoice_id, 'entered_in_error', c.issued_at, c.issued_by
      from tmpos_invoice_credit_note.invoice_credit_note c where c.credit_note_id = any(${withdrawn.map((k) => notes[k - 1])}::uuid[])`;
    await sql`insert into tmpos_invoice_credit_note.invoice_credit_note_counter (tenant_id, store_id, last_number) values (${w.T}, ${w.S}, ${last + n})
      on conflict (tenant_id, store_id) do update set last_number = excluded.last_number`;
  }));
  return notes;
}

// --- the activity's 200 ------------------------------------------------------------------------------------------------------

const PAGE_KEYS = ['creditNotes', 'nextCursor', 'store'];
const ITEM_KEYS = ['grossCents', 'id', 'invoiceId', 'invoiceNumber', 'issuedAt', 'issuedByName', 'number', 'reason', 'withdrawal'];
const WITHDRAWAL_KEYS = ['reason', 'withdrawnAt', 'withdrawnByName'];
/**
 * One page of the activity's 200 for `store` (doc 18 §5.2), every invariant the H layer can see: exactly these key sets (no tax,
 * no net, never an actor id), store.id the path's store, at most 50 items, strictly newest number first, ids unique, times in
 * the routine's microsecond UTC text, closed reasons, a withdrawal not before its issue, names a string or null (always
 * present), and nextCursor null or the last served id.
 */
function activityPageOf(reply, store, label) {
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  assertBaseline(reply, label);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body).sort(), PAGE_KEYS, `${label}: the answer's keys`);
  assert.deepEqual(body.store, { id: store }, `${label}: store.id is the path's store`);
  assert.ok(Array.isArray(body.creditNotes) && body.creditNotes.length <= 50, `${label}: at most 50 served`);
  const ids = new Set();
  let previous = Number.POSITIVE_INFINITY;
  for (const n of body.creditNotes) {
    assert.deepEqual(Object.keys(n).sort(), ITEM_KEYS, `${label}: an item's keys`);
    assert.ok(UUID_RE.test(n.id) && UUID_RE.test(n.invoiceId) && !ids.has(n.id), `${label}: canonical, unique ids`);
    ids.add(n.id);
    assert.ok(Number.isSafeInteger(n.number) && n.number >= 1 && n.number < previous, `${label}: strictly newest number first`);
    previous = n.number;
    assert.ok(Number.isSafeInteger(n.invoiceNumber) && n.invoiceNumber >= 1 && Number.isSafeInteger(n.grossCents) && n.grossCents >= 1, `${label}: positive integers`);
    assert.ok(ISSUE_REASONS.includes(n.reason) && TIME_RE.test(n.issuedAt), `${label}: a closed reason and the routine's time text`);
    assert.ok(n.issuedByName === null || typeof n.issuedByName === 'string', `${label}: the issuer's name present, a string or null`);
    if (n.withdrawal !== null) {
      assert.deepEqual(Object.keys(n.withdrawal).sort(), WITHDRAWAL_KEYS, `${label}: the withdrawal's keys`);
      assert.ok(TIME_RE.test(n.withdrawal.withdrawnAt) && n.withdrawal.withdrawnAt >= n.issuedAt, `${label}: withdrawn not before issued`);
      assert.ok(WITHDRAWAL_REASONS.includes(n.withdrawal.reason), `${label}: a closed withdrawal reason`);
      assert.ok(n.withdrawal.withdrawnByName === null || typeof n.withdrawal.withdrawnByName === 'string', `${label}: the withdrawer's name present`);
    }
  }
  const last = body.creditNotes[body.creditNotes.length - 1];
  assert.ok(body.nextCursor === null || (last !== undefined && body.nextCursor === last.id), `${label}: nextCursor null or the last served id`);
  return body;
}
/** A refusal with its logged reason. */
function refusedWith(ctx, reply, status, error, reason, label) {
  assertRefusal(reply, status, error, label);
  assert.equal(ctx.reason(reply), reason, `${label}: the logged reason`);
}
const range = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

// ===========================================================================
// SCH-00: the shipping table
// ===========================================================================

test('SCH-00 (doc 18 §5.1 scope): the tenant entry ships GET /api/v1/stores/{storeId}/credit-notes as a bodiless session read with no idempotency', () => {
  const served = TENANT_SHIPPING_ROUTES.map((r) => `${r.method} ${r.path} ${r.access} ${r.body} ${r.idempotency}`);
  assert.ok(served.includes('GET /api/v1/stores/{storeId}/credit-notes session none none'), 'the activity read is served');
  assert.ok(served.includes('GET /api/v1/stores/{storeId}/invoices/{id}/credit-notes session none none'), 'beside the per-invoice list, no collision');
});

// ===========================================================================
// SCH-01: CA-01, CA-07, CA-08, CA-38 (H)
// ===========================================================================

test('SCH-01 (CA-01 H, CA-07 H, CA-08 H, CA-38 H traversal): an empty store is 200 with [] and null; 120 seeded notes walk 50 + 50 + 20 strictly newest number first, every note once, ending null; a note issued between pages appears on no later page and first after a reload; a "Show more" page is served with a newer status than the loaded page 1; nothing written by any read', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch01');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);

    // CA-01: the empty store.
    const empty = await readsOnly([w.T], 'CA-01 empty', () => ctx.activity(s, w.S));
    assert.deepEqual(activityPageOf(empty, w.S, 'CA-01 empty'), { store: { id: w.S }, creditNotes: [], nextCursor: null }, 'CA-01: an empty store');

    // CA-07: 120 notes, two of them withdrawn.
    const x = await issueOne(ctx, w.sm, w, 'sch01 x');
    const seeded = await seedNotes(w, x, o, 120, [3, 77]);
    const p1 = activityPageOf(await readsOnly([w.T], 'CA-07 page 1', () => ctx.activity(s, w.S)), w.S, 'CA-07 page 1');
    assert.deepEqual([p1.creditNotes.length, p1.nextCursor], [50, p1.creditNotes[49]?.id], 'CA-01: 50 served of 51 asked, nextCursor the 50th id');
    assert.deepEqual(p1.creditNotes.map((n) => n.number), range(120, 71), 'CA-07 page 1: 120..71');

    // CA-08: a note issued over HTTP between page 1 and page 2.
    const between = await credited(ctx, s, w, x, 500, 'CA-08 the note issued between pages');
    const p2 = activityPageOf(await ctx.activity(s, w.S, `?after=${p1.nextCursor}`), w.S, 'CA-07 page 2');
    assert.deepEqual([p2.creditNotes.length, p2.nextCursor], [50, p2.creditNotes[49]?.id], 'CA-07 page 2: 50 and a cursor');
    assert.deepEqual(p2.creditNotes.map((n) => n.number), range(70, 21), 'CA-07 page 2: 70..21, continuing below page 1');
    const p3 = activityPageOf(await ctx.activity(s, w.S, `?after=${p2.nextCursor}`), w.S, 'CA-07 page 3');
    assert.deepEqual([p3.creditNotes.map((n) => n.number), p3.nextCursor], [range(20, 1), null], 'CA-07 page 3: 20..1, then the end');
    const walked = [...p1.creditNotes, ...p2.creditNotes, ...p3.creditNotes];
    assert.deepEqual(walked.map((n) => n.id), [...seeded].reverse(), 'CA-07: every seeded note exactly once, no repeat, no gap, newest first');
    assert.ok(!walked.some((n) => n.id === between), 'CA-08: the note issued during the traversal is on no later page');
    assert.ok(walked.every((n) => n.invoiceId === x && n.issuedByName === o.displayName && n.grossCents === 1 && n.reason === 'goodwill'),
      'every row names its invoice, its issuer and its amount');
    assert.deepEqual(walked.filter((n) => n.withdrawal !== null).map((n) => [n.number, n.withdrawal.reason, n.withdrawal.withdrawnByName]),
      [[77, 'entered_in_error', o.displayName], [3, 'entered_in_error', o.displayName]], 'withdrawn notes stay listed with their withdrawal');
    assert.equal(new Set(walked.map((n) => n.invoiceNumber)).size, 1, 'one invoice, one invoice number');

    // CA-08: a reload (a new traversal) shows the new note first.
    const reload = activityPageOf(await ctx.activity(s, w.S), w.S, 'CA-08 reload');
    assert.deepEqual([reload.creditNotes[0]?.id, reload.creditNotes[0]?.number, reload.creditNotes[0]?.grossCents, reload.creditNotes[0]?.reason,
      reload.creditNotes[0]?.issuedByName, reload.creditNotes[0]?.withdrawal], [between, 121, 500, 'pricing_error', o.displayName, null],
    'CA-08: the new note is first after a reload, numbered on from the seeded series');
    assert.deepEqual(reload.creditNotes.map((n) => n.number), range(121, 72), 'CA-38: page 1 of the new traversal replaces the loaded chain');

    // CA-38: a note on page 2 withdrawn after page 1 loaded is served withdrawn on page 2; the loaded page 1 is not rewritten.
    const onPage1 = reload.creditNotes.find((n) => n.number === 100);
    const onPage2 = seeded[59]; // number 60, on the next page
    assert.equal(onPage1.withdrawal, null, 'CA-38: number 100 is active as page 1 was loaded');
    for (const [label, cn] of [['number 60', onPage2], ['number 100', onPage1.id]]) {
      const reply = await ctx.withdraw(s, w, x, cn, withdrawBody(w));
      assert.equal(reply.status, 200, `CA-38 the withdrawal of ${label}: ${replyNote(reply)}`);
    }
    const next = activityPageOf(await ctx.activity(s, w.S, `?after=${reload.nextCursor}`), w.S, 'CA-38 Show more');
    const sixty = next.creditNotes.find((n) => n.number === 60);
    assert.deepEqual([sixty?.id, sixty?.withdrawal?.reason, sixty?.withdrawal?.withdrawnByName], [onPage2, 'wrong_amount', o.displayName],
      'CA-38: the Show more page is served with the newer status');
    assert.deepEqual(next.creditNotes.map((n) => n.number), range(71, 22), 'CA-38: the Show more page continues strictly below page 1');
    const again = activityPageOf(await ctx.activity(s, w.S), w.S, 'CA-38 a new traversal');
    assert.equal(again.creditNotes.find((n) => n.number === 100)?.withdrawal?.reason, 'wrong_amount', 'CA-38: a new traversal shows number 100 withdrawn');
  });
});

// ===========================================================================
// SCH-02: CA-02, CA-03, CA-09, CA-33
// ===========================================================================

test('SCH-02 (CA-02 H, CA-03 H, CA-09 H, CA-33): another store\'s and another tenant\'s notes never appear; another store of the tenant, a store of another tenant and a store that exists nowhere are each 403 at authorization with one body shape, never 404; a cursor of another store, of another tenant, or a random uuid is 400 with the malformed query\'s shape (only requestId differs); a denied caller\'s cursor is never evaluated', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch02');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'sch02 x');
    const mine = await seedNotes(w, x, o, 2);
    // A second store of the same tenant with its own owner and notes.
    const S2 = await newStore(w.T, 'SCH02 second store');
    const w2 = { ...w, S: S2 };
    w2.settingsVersion = await configure(ctx, w.sb, w.T, S2, 'sch02 s2');
    const o2 = await storeOwner(w, 'o2', S2);
    const s2 = await signIn(ctx, o2);
    const x2 = await issueOne(ctx, s2, w2, 'sch02 x2');
    const theirs = await seedNotes(w2, x2, o2, 3);
    // Another tenant with its own store, owner and notes.
    const b = await world(ctx, 'sch02b');
    const ob = await storeOwner(b, 'ob');
    const sb = await signIn(ctx, ob);
    const xb = await issueOne(ctx, b.sm, b, 'sch02b x');
    const foreign = await seedNotes(b, xb, ob, 2);
    const tenants = [w.T, b.T];

    await readsOnly(tenants, 'SCH-02 every read', async () => {
      // CA-02: this store's notes only; the other store's and tenant's never.
      const page = activityPageOf(await ctx.activity(s, w.S), w.S, 'CA-02 this store');
      assert.deepEqual(page.creditNotes.map((n) => n.id), [...mine].reverse(), 'CA-02: exactly this store\'s notes');
      assert.deepEqual(activityPageOf(await ctx.activity(s2, S2), S2, 'control: the other store\'s owner').creditNotes.map((n) => n.id), [...theirs].reverse(),
        'control: the other store\'s owner reads its own three');
      assert.deepEqual(activityPageOf(await ctx.activity(sb, b.S), b.S, 'control: the other tenant\'s owner').creditNotes.map((n) => n.id), [...foreign].reverse(),
        'control: the other tenant\'s owner reads its own two');

      // CA-02, CA-03, CA-33: another store, another tenant's store, a store that exists nowhere — one 403, never 404.
      const denied = [];
      for (const [label, store] of [['CA-02 another store of the tenant', S2], ['CA-03 a store of another tenant', b.S], ['CA-33 a store that exists nowhere', randomUUID()]]) {
        const reply = await ctx.activity(s, store);
        refusedWith(ctx, reply, 403, 'forbidden', 'authz_denied', label);
        denied.push(reply);
      }
      assert.ok(denied.every((r) => shapeOf(r) === shapeOf(denied[0]) && r.headers['content-type'] === denied[0].headers['content-type']),
        'CA-33: the same status, error word and body shape for all three (only requestId differs)');

      // CA-09: cursors that name no note of this tenant and store, and a malformed one — one 400 shape.
      const bad = [];
      for (const [label, query, reason] of [
        ['CA-09 a cursor of another store', `?after=${theirs[0]}`, 'store_credit_activity_cursor_unknown'],
        ['CA-09 a cursor of another tenant', `?after=${foreign[0]}`, 'store_credit_activity_cursor_unknown'],
        ['CA-09 a random uuid', `?after=${randomUUID()}`, 'store_credit_activity_cursor_unknown'],
        ['CA-09 a malformed query', '?after=CN-1', 'store_credit_activity_query_invalid'],
      ]) {
        const reply = await ctx.activity(s, w.S, query);
        refusedWith(ctx, reply, 400, 'invalid_request', reason, label);
        bad.push(reply);
      }
      assert.ok(bad.every((r) => shapeOf(r) === shapeOf(bad[0])), 'CA-09: unknown and foreign cursors answer exactly as a malformed query (only requestId differs)');
      // A valid cursor of this store still answers (control).
      assert.deepEqual(activityPageOf(await ctx.activity(s, w.S, `?after=${mine[1]}`), w.S, 'control: this store\'s cursor').creditNotes.map((n) => n.id), [mine[0]]);

      // CA-09: a denied caller's cursor is never evaluated — 403 at authorization, never the cursor's 400.
      refusedWith(ctx, await ctx.activity(w.sm, w.S, `?after=${randomUUID()}`), 403, 'forbidden', 'authz_denied', 'CA-09 the manager with an unknown cursor');
      refusedWith(ctx, await ctx.activity(s, S2, `?after=${theirs[0]}`), 403, 'forbidden', 'authz_denied', 'CA-09 another store with that store\'s own cursor');
      refusedWith(ctx, await ctx.activity(s, b.S, `?after=${randomUUID()}`), 403, 'forbidden', 'authz_denied', 'CA-09 another tenant\'s store with an unknown cursor');
    });
  });
});

// ===========================================================================
// SCH-03: CA-04, CA-34 (H)
// ===========================================================================

test('SCH-03 (CA-04 H, CA-34 H): a manager at Invoices Full, a technician, a sales_staff member at their catalog defaults and the tenant-scope owner are 403 at authorization; with the owner\'s edits (the manager below View, the technician and sales_staff at Full) still 403 — the role decides; the store-scope owner\'s identical read is 200 throughout', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch03');
    const o = await storeOwner(w, 'o');
    const x = await issueOne(ctx, w.sm, w, 'sch03 x');
    await seedNotes(w, x, o, 1);
    const tech = await actor('sch03-tech', [storeGrant(w.T, w.S, 'technician')]);
    const sales = await actor('sch03-sales', [storeGrant(w.T, w.S, 'sales_staff')]);
    const so = await signIn(ctx, o);
    const roles = [['a manager (Invoices Full by default)', w.mgr], ['a technician (Invoices View)', tech], ['a sales_staff member (Invoices Create)', sales]];
    // Every sign-in happens before the measured window (a sign-in writes its own session rows).
    const atDefaults = [['a manager (Invoices Full by default)', w.sm], ['a technician (Invoices View)', await signIn(ctx, tech)],
      ['a sales_staff member (Invoices Create)', await signIn(ctx, sales)], ['the tenant-scope owner (no store grant)', w.sb]];
    await readsOnly([w.T], 'CA-34 defaults', async () => {
      for (const [who, sess] of atDefaults) {
        refusedWith(ctx, await ctx.activity(sess, w.S), 403, 'forbidden', 'authz_denied', `CA-04/CA-34 ${who} at the defaults`);
        assert.equal(activityPageOf(await ctx.activity(so, w.S), w.S, `control beside ${who}`).creditNotes.length, 1, `control beside ${who}: the owner reads`);
      }
    });
    // The owner's edits of each role's Invoices level (row 5: below View; and Full, which is not owner-only).
    await setLevel(w.T, 'manager', 'invoices', 'none');
    await setLevel(w.T, 'technician', 'invoices', 'full');
    await setLevel(w.T, 'sales_staff', 'invoices', 'full');
    const so2 = await signIn(ctx, o);
    const edited = [];
    for (const [who, account] of roles) edited.push([who, await signIn(ctx, account)]);
    await readsOnly([w.T], 'CA-34 edited levels', async () => {
      for (const [who, sess] of edited) {
        refusedWith(ctx, await ctx.activity(sess, w.S), 403, 'forbidden', 'authz_denied', `CA-34 ${who} under an owner-edited Invoices level`);
        assert.equal(activityPageOf(await ctx.activity(so2, w.S), w.S, `control beside ${who} (edited)`).creditNotes.length, 1, `control beside ${who}: the owner reads`);
      }
    });
  });
});

// ===========================================================================
// SCH-04: CA-05 (D-CA-1 A)
// ===========================================================================

test('SCH-04 (CA-05 H, D-CA-1 A): the store owner of a read-only or overdue store or tenant is 403 at authorization, nothing written, while the direct routine call with that live session\'s key still answers (residual (a), recorded); the same owner reads again once the account is active', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch04');
    for (const [kind, status] of [['store', 'read_only'], ['store', 'overdue'], ['tenant', 'read_only'], ['tenant', 'overdue']]) {
      const label = `${kind} ${status}`;
      const oi = await storeOwner(w, `${kind}-${status}`);
      const s0 = await signIn(ctx, oi);
      const xi = await issueOne(ctx, s0, w, `sch04 ${label}`);
      await seedNotes(w, xi, oi, 1);
      assert.ok(activityPageOf(await ctx.activity(s0, w.S), w.S, `control ${label}: active`).creditNotes.length >= 1);
      const setStatus = (to) => (kind === 'store' ? owner`update store set status = ${to} where store_id = ${w.S}` : owner`update tenant set status = ${to} where tenant_id = ${w.T}`);
      await setStatus(status);
      try {
        // A status change ends the affected sessions (the admission witness moved): sign in afresh under the new status.
        const sx = await signIn(ctx, oi);
        await readsOnly([w.T], `CA-05 ${label}`, async () => {
          refusedWith(ctx, await ctx.activity(sx, w.S), 403, 'forbidden', 'authz_denied', `CA-05 ${label}: the owner's read (D-CA-1 A)`);
        });
        // Residual (a) (doc 18 §8.3; D10:1676 (a)): 039 admits read statuses, so a direct call with a live key still answers.
        // Recorded here, not prevented: the HTTP read is the only path the product offers.
        const direct = await owner`select o_outcome from tmpos_invoice_credit_note.m7b_store_credit_activity(${sx.key}::text, ${w.T}::uuid, ${w.S}::uuid, null::uuid, 51)`;
        assert.ok(direct.length >= 1 && direct.every((r) => r.o_outcome === 'credit_note'), `CA-05 ${label}: residual (a) — the direct call answers rows`);
      } finally {
        await setStatus('active');
      }
      const sy = await signIn(ctx, oi);
      assert.ok(activityPageOf(await ctx.activity(sy, w.S), w.S, `control ${label}: active again`).creditNotes.length >= 1, `control ${label}: the owner reads again`);
    }
  });
});

// ===========================================================================
// SCH-05: CA-06, CA-46 (H, the read route only)
// ===========================================================================

test('SCH-05 (CA-06 H, CA-46 H read route only): a suspended or pending tenant or store ends the owner\'s session: 401 session_admission_denied, never rows; a trialing tenant\'s session still reaches the read; an unregistered route is 404 with no session while a sessionless request to the served route is 401, on the same host, also while the tenant is suspended. The write-setting parts of CA-46 are out of scope (the setting is not built)', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch05');
    const x = await issueOne(ctx, w.sm, w, 'sch05 x');
    const seeder = await storeOwner(w, 'seeder');
    await seedNotes(w, x, seeder, 2);
    const setStatus = (kind, to) => (kind === 'store' ? owner`update store set status = ${to} where store_id = ${w.S}` : owner`update tenant set status = ${to} where tenant_id = ${w.T}`);
    for (const [kind, status] of [['tenant', 'suspended'], ['tenant', 'pending_activation'], ['store', 'suspended'], ['store', 'pending_activation']]) {
      const label = `${kind} ${status}`;
      const oi = await storeOwner(w, `${kind}-${status}`);
      const si = await signIn(ctx, oi);
      assert.equal(activityPageOf(await ctx.activity(si, w.S), w.S, `control ${label}: active`).creditNotes.length, 2);
      await setStatus(kind, status);
      try {
        await readsOnly([w.T], `CA-06 ${label}`, async () => {
          const reply = await ctx.activity(si, w.S);
          // SESSION LOSS, not a permission denial (doc 18 §8.4 rows 10a/10b as corrected): tenant admission is re-read on every
          // request (sessions.ts:133-136); the status drops the owner's only grant, so admission is refused
          // (postgresTenantAdmission.ts:236) and every session of the principal ends (sessions.ts:636-638). A 403 under a live
          // session would need the status to change between the session's admission read and the authorizer's own: a race,
          // not constructible here, so UNCOVERED.
          refusedWith(ctx, reply, 401, 'unauthenticated', 'session_admission_denied', `CA-06 ${label}`);
          if (kind === 'tenant' && status === 'suspended') {
            // CA-46: the surface an apply window relies on, with the tenant suspended.
            assertRefusal(await ctx.read(null, `/api/v1/stores/${w.S}/credit-notes`), 401, 'unauthenticated', 'CA-46 sessionless, served route, tenant suspended');
            assertRefusal(await ctx.read(null, `/api/v1/stores/${w.S}/credit-activity`), 404, 'not_found', 'CA-46 sessionless, unregistered route, tenant suspended');
          }
        });
      } finally {
        await setStatus(kind, 'active');
      }
    }
    // CA-46: a trialing tenant's session still reaches the read (row 1: active or trialing → 200).
    await setStatus('tenant', 'trialing');
    try {
      const ot = await storeOwner(w, 'trialing');
      const st = await signIn(ctx, ot);
      assert.equal(activityPageOf(await ctx.activity(st, w.S), w.S, 'CA-46 trialing').creditNotes.length, 2, 'CA-46: a trialing tenant\'s owner reads');
    } finally {
      await setStatus('tenant', 'active');
    }
    // CA-46: an unregistered route vs a sessionless request to the served route, tenant active.
    assertRefusal(await ctx.read(null, `/api/v1/stores/${w.S}/credit-activity`), 404, 'not_found', 'CA-46 an unregistered route, no session');
    assertRefusal(await ctx.read(null, `/api/v1/stores/${w.S}/credit-notes/x`), 404, 'not_found', 'CA-46 a trailing segment, no session');
    assertRefusal(await ctx.read(null, `/api/v1/stores/${w.S}/credit-notes`), 401, 'unauthenticated', 'CA-46 the served route, no session');
  });
});

// ===========================================================================
// SCH-06: CA-11
// ===========================================================================

test('SCH-06 (CA-11 H): a withdrawn note carries its withdrawal (not before its issue, a closed reason, the withdrawer\'s name); an active note has withdrawal null; a voided invoice\'s withdrawn note stays listed', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch06');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'sch06 x');
    const first = await credited(ctx, s, w, x, 300, 'CA-11 first');
    const second = await credited(ctx, s, w, x, 200, 'CA-11 second', 'billing_error');
    const withdrawn = await ctx.withdraw(s, w, x, first, withdrawBody(w, 'wrong_amount'));
    assert.equal(withdrawn.status, 200, `CA-11 the withdrawal: ${replyNote(withdrawn)}`);
    // A voided invoice: its one note withdrawn, then the invoice voided (the void refuses an active credit note).
    const v = await issueOne(ctx, w.sm, w, 'sch06 v');
    const onVoided = await credited(ctx, s, w, v, 100, 'CA-11 on the voided invoice', 'service_issue');
    const wv = await ctx.withdraw(s, w, v, onVoided, withdrawBody(w, 'wrong_invoice'));
    assert.equal(wv.status, 200, `CA-11 the voided invoice's withdrawal: ${replyNote(wv)}`);
    const voided = await ctx.voidInvoice(w.sm, w, v, { expectedTenant: w.T, reasonCode: 'wrong_seller_details' });
    assert.equal(voided.status, 200, `CA-11 the void: ${replyNote(voided)}`);

    const page = activityPageOf(await readsOnly([w.T], 'CA-11', () => ctx.activity(s, w.S)), w.S, 'CA-11');
    assert.deepEqual(page.creditNotes.map((n) => [n.id, n.number, n.invoiceId, n.grossCents, n.reason, n.issuedByName]), [
      [onVoided, 3, v, 100, 'service_issue', o.displayName],
      [second, 2, x, 200, 'billing_error', o.displayName],
      [first, 1, x, 300, 'pricing_error', o.displayName],
    ], 'CA-11: newest first, each with its own invoice, amount, reason and issuer');
    const [nv, n2, n1] = page.creditNotes;
    assert.equal(n2.withdrawal, null, 'CA-11: the active note has withdrawal null');
    assert.deepEqual([n1.withdrawal?.reason, n1.withdrawal?.withdrawnByName, n1.withdrawal?.withdrawnAt >= n1.issuedAt], ['wrong_amount', o.displayName, true],
      'CA-11: the withdrawn note carries its withdrawal');
    assert.deepEqual([nv.withdrawal?.reason, nv.withdrawal?.withdrawnByName], ['wrong_invoice', o.displayName], 'CA-11: the voided invoice\'s withdrawn note stays listed');
    assert.notEqual(n1.invoiceNumber, nv.invoiceNumber, 'two invoices, two invoice numbers');
  });
});

// ===========================================================================
// SCH-07: CA-12 (H)
// ===========================================================================

test('SCH-07 (CA-12 H): an issuer with no display name is served null; a name of exactly 1,000 characters is served; a name over 1,000 characters or with a control character fails its page with 503 (logged store_credit_activity_answer_invalid) while the page below it still answers', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch07');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'sch07 x');
    // Issuers seeded by owner SQL; the READER's own account is never edited (an app_user change moves its session's version).
    const issuer = async (label, displayName) => actor(`sch07-${label}`, [storeGrant(w.T, w.S, 'store_owner')], { displayName });
    const thousand = 'T'.repeat(1000);
    const [atBound] = await seedNotes(w, x, await issuer('thousand', thousand), 1);
    const [nameless] = await seedNotes(w, x, await issuer('nameless', null), 1);
    await readsOnly([w.T], 'CA-12 names', async () => {
      const page = activityPageOf(await ctx.activity(s, w.S), w.S, 'CA-12 null and 1,000');
      assert.deepEqual(page.creditNotes.map((n) => [n.id, n.issuedByName]), [[nameless, null], [atBound, thousand]],
        'CA-12: null stays null (never absent); exactly 1,000 characters are served');
    });
    const [tooLong] = await seedNotes(w, x, await issuer('long', 'L'.repeat(1001)), 1);
    await readsOnly([w.T], 'CA-12 over the bound', async () => {
      refusedWith(ctx, await ctx.activity(s, w.S), 503, 'service_unavailable', 'store_credit_activity_answer_invalid', 'CA-12 a name over 1,000 characters');
      assert.deepEqual(activityPageOf(await ctx.activity(s, w.S, `?after=${tooLong}`), w.S, 'CA-12 below the long name').creditNotes.map((n) => n.id),
        [nameless, atBound], 'CA-12: the page below the bad name still answers');
    });
    const [control] = await seedNotes(w, x, await issuer('control', `Ctl\u0007${SUFFIX}`), 1);
    await readsOnly([w.T], 'CA-12 control character', async () => {
      refusedWith(ctx, await ctx.activity(s, w.S), 503, 'service_unavailable', 'store_credit_activity_answer_invalid', 'CA-12 a control character');
      refusedWith(ctx, await ctx.activity(s, w.S, `?after=${control}`), 503, 'service_unavailable', 'store_credit_activity_answer_invalid',
        'CA-12 the next page still holds the long name');
      assert.equal(activityPageOf(await ctx.activity(s, w.S, `?after=${tooLong}`), w.S, 'CA-12 below both').creditNotes.length, 2);
    });
  });
});

// ===========================================================================
// SCH-08: CA-13
// ===========================================================================

test('SCH-08 (CA-13): the session CSRF header missing, repeated or another session\'s → 403 forbidden with the CSRF reason, before authorization (the manager gets the CSRF reason, not the authorizer\'s), its body an authorization 403\'s, nothing written', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch08');
    const o = await storeOwner(w, 'o');
    const o2 = await storeOwner(w, 'o2');
    const s = await signIn(ctx, o);
    const s2 = await signIn(ctx, o2);
    const x = await issueOne(ctx, w.sm, w, 'sch08 x');
    await seedNotes(w, x, o, 1);
    const authz = await ctx.activity(w.sm, w.S);
    refusedWith(ctx, authz, 403, 'forbidden', 'authz_denied', 'an authorization 403 (the manager, its own token)');
    await readsOnly([w.T], 'CA-13', async () => {
      for (const [who, sess, other] of [['the owner', s, s2.csrf], ['the manager', w.sm, s.csrf]]) {
        for (const [mode, opts, reason] of [
          ['missing', { drop: [SESSION_CSRF_HEADER] }, 'csrf_session_missing'],
          ['repeated', { headers: { [SESSION_CSRF_HEADER]: [sess.csrf, sess.csrf] } }, 'csrf_session_duplicate'],
          ['another session\'s', { headers: { [SESSION_CSRF_HEADER]: other } }, 'csrf_session_invalid'],
        ]) {
          const reply = await ctx.activity(sess, w.S, '', opts);
          refusedWith(ctx, reply, 403, 'forbidden', reason, `CA-13 ${who}, CSRF ${mode}`);
          assert.ok(shapeOf(reply) === shapeOf(authz) && reply.headers['content-type'] === authz.headers['content-type'],
            `CA-13 ${who}, CSRF ${mode}: the body and type of an authorization 403`);
        }
      }
    });
    assert.equal(activityPageOf(await ctx.activity(s, w.S), w.S, 'control: the owner with its own token').creditNotes.length, 1);
  });
});

// ===========================================================================
// SCH-09: CA-14 (H)
// ===========================================================================

test('SCH-09 (CA-14 H): after sign-out the read is 401; from one client address the request limit\'s answers are 200 and the next is 429 rate_limited with Retry-After in whole seconds within the window, nothing stored but the limiter\'s count', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch09');
    const o = await storeOwner(w, 'o');
    const x = await issueOne(ctx, w.sm, w, 'sch09 x');
    await seedNotes(w, x, o, 1);
    const s = await signIn(ctx, o);
    assert.equal(activityPageOf(await ctx.activity(s, w.S), w.S, 'control: signed in').creditNotes.length, 1);
    assert.equal((await ctx.logout(s)).status, 204, 'the sign-out');
    assertRefusal(await ctx.activity(s, w.S), 401, 'unauthenticated', 'CA-14 after sign-out');
  });
  // A fresh entry and one fixed client address that has spent nothing: only activity reads go out from it.
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch09b');
    const o = await storeOwner(w, 'o');
    const x = await issueOne(ctx, w.sm, w, 'sch09b x');
    await seedNotes(w, x, o, 1);
    const s = await signIn(ctx, o);
    const from = randomLoopback();
    const { limit, windowMs } = RATE_LIMITS.request;
    await readsOnly([w.T], 'CA-14 the limit', async () => {
      let served = 0;
      let limited = null;
      let started = null; // the bucket opens at the first answer, so the window is measured from it
      for (let i = 0; i < limit + 10 && limited === null; i++) {
        const reply = await ctx.activity(s, w.S, '', { from });
        if (started === null) started = Date.now();
        if (reply.status === 200) served += 1;
        else limited = { at: i + 1, reply };
      }
      const elapsed = Date.now() - started;
      // Timing-dependent by nature (the drafts suite's DA-60 class): the bucket opens at the first answer.
      assert.ok(elapsed < windowMs, `the run fit one ${windowMs} ms window (${elapsed} ms)`);
      assert.ok(limited !== null, 'CA-14: the limit was reached');
      assert.deepEqual([served, limited.at], [limit, limit + 1], 'CA-14: exactly the limit\'s answers, then the refusal');
      assertRefusal(limited.reply, 429, 'rate_limited', 'CA-14 the first request over the limit');
      assert.match(limited.reply.headers['retry-after'] ?? '', /^[1-9][0-9]*$/, 'CA-14: Retry-After in whole seconds');
      assert.ok(Number(limited.reply.headers['retry-after']) <= windowMs / 1000, 'CA-14: within the window');
    });
  });
});

// ===========================================================================
// SCH-10: CA-15a, CA-15b, CA-16 (H)
// ===========================================================================

test('SCH-10 (CA-15a H, CA-15b H partial: the demotion\'s refusal only, CA-16 H): a role change between pages, a narrowed role (to each other catalog role) and a store grant moved to another store each end the session — 401 session_version_mismatch, never rows', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch10');
    const seeder = await storeOwner(w, 'seeder');
    const x = await issueOne(ctx, w.sm, w, 'sch10 x');
    await seedNotes(w, x, seeder, 60);

    // CA-15a: the normal path (D17:882) — the server ends the session on a role change.
    const oa = await storeOwner(w, 'a');
    const sa = await signIn(ctx, oa);
    const p1 = activityPageOf(await ctx.activity(sa, w.S), w.S, 'CA-15a page 1');
    assert.equal(p1.creditNotes.length, 50);
    await owner`update user_membership set role_id = 'manager' where internal_user_id = ${oa.id}`;
    await readsOnly([w.T], 'CA-15a', async () => {
      // The admission witness carries each grant's role (postgresTenantAdmission.ts:200-204), so the session's security version no
      // longer matches and this session alone is revoked: sessions.ts:640-642 (`_unrevoked` only if that revoke itself fails).
      refusedWith(ctx, await ctx.activity(sa, w.S, `?after=${p1.nextCursor}`), 401, 'unauthenticated', 'session_version_mismatch',
        'CA-15a the next page after a demotion');
    });

    // CA-15b H is PARTIAL. What this covers: the refusal a demotion causes over HTTP — SESSION LOSS, 401
    // session_version_mismatch, for each other catalog role (admission is re-read on every request, sessions.ts:133-136).
    // NOT covered here (UNCOVERED at H): "a request still admitted, then 403" — it needs the role to change between the
    // session's admission read and the authorizer's or 039's own read, a race this suite cannot construct. The permission
    // denial under a LIVE session is covered separately: SCH-03 (403 authz_denied at the chain's authorization step, per role,
    // at defaults and edited levels) and SCA-U3 (the route maps 039's 'denied' to 403 store_credit_activity_denied); the
    // routine's own role denial is CA-04's D layer (tests/db/storeCreditActivityRoutine.integration.test.mjs).
    for (const role of ['manager', 'technician', 'sales_staff']) {
      const ob = await storeOwner(w, `b-${role}`);
      const sb = await signIn(ctx, ob);
      assert.equal(activityPageOf(await ctx.activity(sb, w.S), w.S, `CA-15b ${role} control`).creditNotes.length, 50);
      await owner`update user_membership set role_id = ${role} where internal_user_id = ${ob.id}`;
      await readsOnly([w.T], `CA-15b ${role}`, async () => {
        refusedWith(ctx, await ctx.activity(sb, w.S), 401, 'unauthenticated', 'session_version_mismatch', `CA-15b narrowed to ${role}`);
      });
    }

    // CA-16: the store grant moved to another store of the tenant mid-session. SESSION LOSS: the admission witness carries each
    // grant's store (postgresTenantAdmission.ts:200-204), so the security version no longer matches and the session ends
    // (sessions.ts:640-642), as doc 18 §8.2 now states. A 403 with the session still live would need the move to land between
    // the session's admission read and the authorizer's own: a race, UNCOVERED.
    const S2 = await newStore(w.T, 'SCH10 other store');
    const oc = await storeOwner(w, 'c');
    const sc = await signIn(ctx, oc);
    assert.equal(activityPageOf(await ctx.activity(sc, w.S), w.S, 'CA-16 control').creditNotes.length, 50);
    await owner`update user_membership set store_id = ${S2} where internal_user_id = ${oc.id}`;
    await readsOnly([w.T], 'CA-16', async () => {
      refusedWith(ctx, await ctx.activity(sc, w.S), 401, 'unauthenticated', 'session_version_mismatch', 'CA-16 the grant moved');
    });
  });
});

// ===========================================================================
// SCH-11: CA-23 (H)
// ===========================================================================

test('SCH-11 (CA-23 H): two notes on ONE invoice, seeded by owner SQL as issued by two store-scope owners of the store (historical data, not created through the product): each owner\'s activity view shows both, newest first, with each issuer\'s name', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch11');
    const o1 = await storeOwner(w, 'o1');
    const o2 = await storeOwner(w, 'o2');
    const x = await issueOne(ctx, w.sm, w, 'sch11 x');
    const [a] = await seedNotes(w, x, o1, 1, [], { reason: 'pricing_error', gross: 500 });
    const [b] = await seedNotes(w, x, o2, 1, [], { reason: 'pricing_error', gross: 500 });
    for (const [who, account] of [['owner 1', o1], ['owner 2', o2]]) {
      const s = await signIn(ctx, account);
      const page = activityPageOf(await readsOnly([w.T], `CA-23 ${who}`, () => ctx.activity(s, w.S)), w.S, `CA-23 ${who}`);
      assert.deepEqual(page.creditNotes.map((n) => [n.id, n.number, n.invoiceId, n.grossCents, n.reason, n.issuedByName, n.withdrawal]), [
        [b, 2, x, 500, 'pricing_error', o2.displayName, null],
        [a, 1, x, 500, 'pricing_error', o1.displayName, null],
      ], `CA-23 ${who}: both notes of the duplicate, each with its issuer's name`);
    }
  });
});

// ===========================================================================
// SCH-12: CA-10, CA-38 (H)
// ===========================================================================

test('SCH-12 (CA-10 H, CA-38 H): a bare `?`, an empty, uppercase, braced or non-uuid `after`, a second key, a repeated `after`, and any `limit`, `cursor` or `before` key → 400 invalid_request logged store_credit_activity_query_invalid, nothing written; exactly `after=<canonical uuid>` answers', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'sch12');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'sch12 x');
    const [first, second] = await seedNotes(w, x, o, 2);
    const id = second;
    await readsOnly([w.T], 'CA-10/CA-38 malformed queries', async () => {
      for (const query of [
        '?', '?after=', `?after=${id.slice(0, 35)}F`, `?after=${id.replace(/[0-9]/, 'A')}`, `?after={${id}}`, `?after=%7B${id}%7D`, '?after=CN-1',
        `?after=${id.slice(0, 35)}`, `?after=${id}&x=1`, `?x=1&after=${id}`, `?after=${id}&after=${id}`, `?after=${id}&limit=50`, '?limit=50',
        `?cursor=${id}`, `?before=${id}`, `?after=${id}&`, `?AFTER=${id}`,
      ]) {
        refusedWith(ctx, await ctx.activity(s, w.S, query), 400, 'invalid_request', 'store_credit_activity_query_invalid', `CA-10/CA-38 ${query.replace(id, '<id>')}`);
      }
    });
    assert.deepEqual(activityPageOf(await ctx.activity(s, w.S, `?after=${id}`), w.S, 'control: exactly after=<id>').creditNotes.map((n) => n.id), [first],
      'control: the canonical cursor answers the page below it');
  });
});
