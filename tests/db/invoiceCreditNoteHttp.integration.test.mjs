// =============================================================================
// M7B-CREDITNOTES-P1 (doc 16, migration 038) — credit notes over the REAL composed tenant entry (ICH)
// =============================================================================
//
// An independent HTTP acceptance suite for doc 16 §8, over startTenantEntry and a DURABLE disposable PostgreSQL (fsync,
// full_page_writes and synchronous_commit on; the registration proof refuses fsync off) with every migration in the directory
// applied (038 included) and the owner-installed proof key in place. Each test names the acceptance rows it evidences:
//
//   ICH-00 (scope)      the shipping table carries the seven credit-note routes with their body and idempotency;
//   ICH-01 (CN-10c, CN-13, CN-23, CN-33 owner half) a real store-scope store_owner registers, fetches the proof, issues, lists,
//          looks up, settles (confirms) and withdraws within the sign-in window; each mutation writes EXACTLY one routine audit
//          row, the list and lookup write none; the withdrawal raises remaining and a second one is invalid_state;
//   ICH-02 (CN-10b, CN-33 others half) on the SAME invoice and store, a manager with Invoices Full (shown able to register and
//          settle a payment) gets 403 on every credit-note mutation and recovery route, nothing written; the manager's list has
//          no name fields;
//   ICH-03 (CN-10)      a tenant-scope owner, a technician and a sales_staff member are refused every mutation and recovery
//          route; their list answers exactly as the issued-invoice detail read (view_issued_invoices); a store-scope owner whose
//          store is read_only or overdue is refused, and registers again once the store is active;
//   ICH-04 (CN-05)      same session, key and bytes replay (Idempotent-Replayed: true); a sign-in older than 10 minutes (staged
//          through the database clock) is 403 step_up_required before idempotency; a narrowed role or a suspended grant is
//          401/403, never a replay; a renewed session is 422 idempotency_key_reused on the session-bound routes while the
//          withdrawal (not session-bound) replays; a same key in progress is 409 request_in_progress; nothing new written;
//   ICH-05 (CN-06)      same key, other body → 422; an open registration presented with another grossCents or reason → sealed
//          write_conflict; an issued one → sealed already_issued, the first amount stands;
//   ICH-06 (CN-07a HTTP part, CN-11) release then a late issue → invalid_state; confirm then a late issue → already_issued; the
//          sign-in lapsing between register and issue → 403 step_up_required on register, issue and withdrawal while proof,
//          lookup and settlement still answer; after reauthentication the issue (and a settled registration) → not_found, the
//          owner releases and registers again; a second owner of the store neither sees nor settles the first one's attempt;
//   ICH-07 (CN-09)      another store's, another tenant's and a missing invoice → the same 404 and log reason on every route,
//          nothing written but the commands' leases;
//   ICH-08 (CN-12)      a missing or wrong session CSRF header → 403 with the CSRF reason (not the authorizer's) for the owner
//          and the manager alike, before any lease;
//   ICH-09 (CN-15, CN-24) the payments read carries creditedCents; a payment above what the credits leave is sealed
//          amount_exceeds_remaining and the payment at the cap records; a credit on a fully paid invoice is refused;
//   ICH-10 (CN-16, CN-25) void with an active payment and credit → payments_recorded first; with a credit only →
//          credit_notes_recorded; after the withdrawal the void succeeds; a withdrawal, a late issue and a new registration on
//          the voided invoice → invalid_state; the voided payments read is all zero;
//   ICH-11 (CN-34 HTTP seam) NOT ATTEMPTED: the stale-call cutover variant over HTTP stays UNVERIFIED per doc 16 §8 (CN-34s2).
//
// It never touches a managed or remote database. Cleanup lifts 038's guards inside one owner transaction and removes every
// credit note, withdrawal, registration and credit-note audit row it created, so 038's down can still run afterwards.
// Run: flock <lock> env TMPDIR=/tmp node_modules/.bin/tsx scripts/run-db-tests.mjs tests/db/invoiceCreditNoteHttp.integration.test.mjs

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
import { RECENT_AUTH_MAX_AGE_MS, REAUTHENTICATE_HEADER, REAUTHENTICATE_VALUE, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'ich-migrator', runtimeRef: 'ich-runtime' };
const LOCK_KEY = 529_541;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ich_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';
const CN = 'tmpos_invoice_credit_note';
const PAY = 'tmpos_invoice_payment';
const A = Object.freeze({
  register: 'store.invoice_credit_note.register', issue: 'store.invoice_credit_note.issue',
  settle: 'store.invoice_credit_note.settle', withdraw: 'store.invoice_credit_note.withdraw',
});
const CN_ACTIONS = Object.values(A);
const SEND_TIMEOUT_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Synthetic invoice X of doc 16 §5: subtotal 10,000 at 8.875 % → tax 888, Total 10,888. */
const TOTAL = 10_888;

// Secret-safe failure output: proofs, keys, cookies and bodies are compared before asserting; only booleans, a status, a sealed
// error word or a SQLSTATE reach a failure message.
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

const TARGET = resolveDisposableTarget('ICH', { durable: true });
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
const PROOFS = new Set();
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

// Copied from tests/db/invoicePaymentRegistrationRoutine.integration.test.mjs:174-187.
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

/** Everything this suite's tenants hold, in ONE owner transaction with the guards lifted only inside it. */
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
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(sealDbError('ICH teardown step', err)); } };
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
    // 038's down refuses while ANY credit note, withdrawal, registration or credit-note audit row exists: none may remain.
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
        (select checksum from public.schema_migrations where version = '038')
          = ${REQUIRED_MIGRATIONS.find((m) => m.version === '038').checksum}::text as ledger_restored`;
      assert.deepEqual({ ...state }, { notes: 0, withdrawals: 0, registrations: 0, cn_audits: 0, audits: 0, keys: 0, latest: '038', ledger_restored: true },
        'no credit-note evidence anywhere (038\'s down can run), nothing of this suite left');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'ICH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (raw) {
    const err = sealDbError('ICH setup', raw);
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'ICH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

await setupStep(async () => {
  const [settings] = await owner`select pg_catalog.current_setting('fsync') as fsync, pg_catalog.current_setting('synchronous_commit') as sc,
    pg_catalog.current_setting('full_page_writes') as fpw`;
  assert.deepEqual({ ...settings }, { fsync: 'on', sc: 'on', fpw: 'on' }, 'a durable cluster: the proof routine refuses fsync off');
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
  assert.equal(latest, '038', 'migrations through 038 are applied');
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
  await installTestIssuerKey(owner, ISSUER_KEY).catch((e) => { throw new Error(`ICH issuer key install failed: SQLSTATE ${safeCode(e)}`); });
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
  IDEMPOTENCY_KEY: IDEMPOTENCY_KEY.toString('base64url'),
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', project_id: 'ich-test-project', client_email: 'ich-test@ich-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
  }),
});

function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}
function send(port, method, path, headers, body) {
  const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
  const framed = method === 'GET' ? { ...headers } : { 'content-length': String(payload?.length ?? 0), ...headers };
  return new Promise((resolve, reject) => {
    // A fresh loopback source per request: the per-client request budget never decides an answer here.
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: framed, agent: false, localAddress: randomLoopback() }, (res) => {
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
/** The chain's or a handler's unsealed refusal: exactly { error, requestId }, never replayed. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${replyNote(reply)}`);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${replyNote(reply)}`);
  assert.ok(body.error === error, `${label}: refusal word ${sealedWord(reply.body) ?? '(not a sealed word)'} (expected ${error})`);
  assert.equal(reply.headers['idempotent-replayed'], undefined, `${label}: never a replay`);
  assertBaseline(reply, label);
}
/** A sealed 409: exactly { "error": word } — no requestId. */
function sealedOf(reply, word, label, { replayed = false } = {}) {
  assert.equal(reply.status, 409, `${label}: ${replyNote(reply)} (expected sealed ${word})`);
  assert.ok(reply.body === JSON.stringify({ error: word }), `${label}: the exact sealed body (${replyNote(reply)}, expected ${word})`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newTenant(label) {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ich-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(id);
  return id;
}
async function newStore(tenant, name) {
  return (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`${name} ${SUFFIX}`}, 'active') returning store_id`)[0].store_id;
}
async function newCustomer(tenant, label) {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`ICH ${label} ${SUFFIX}`})`;
  return id;
}
/** A staff member (tests/qa/interactive/fixtures.mjs:99-104): identity, active app_user (optionally named), the memberships. */
async function actor(label, memberships, { displayName = null } = {}) {
  const uid = `ich-${label}-${SUFFIX}`;
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
/** A store-scope store_owner: exactly one active (store, store_owner) membership at `store`, tenant_id the store's tenant. */
const storeOwner = (w, label, store = w.S, displayName = `ICH ${label} ${SUFFIX}`) =>
  actor(`${w.label}-${label}`, [storeGrant(w.T, store, 'store_owner')], { displayName });
const RATE_8875 = Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: 8875 });
const sellerOf = (label) => ({
  legalName: `ICH ${label} legal ${SUFFIX}`, storeName: `ICH ${label} shop ${SUFFIX}`,
  postalAddress: `ICH ${label} street ${SUFFIX}\nICH city`, taxRegistrationId: `ICH-${label}-${SUFFIX}`, tax: RATE_8875,
});

/** What `tenants` hold now: credit-note rows, numbers, the four audit kinds, payments, voids, completions of `keys`, leases. */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = any(${tenants}::uuid[]))::int as rg,
    (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_registration where tenant_id = any(${tenants}::uuid[]) and acknowledged_at is not null)::int as rs,
    (select count(*) from tmpos_invoice_credit_note.invoice_credit_note where tenant_id = any(${tenants}::uuid[]))::int as cn,
    (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal where tenant_id = any(${tenants}::uuid[]))::int as wd,
    (select coalesce(sum(last_number), 0) from tmpos_invoice_credit_note.invoice_credit_note_counter where tenant_id = any(${tenants}::uuid[]))::int as nb,
    (select count(*) from public.audit_event where action_id = ${A.register} and tenant_id = any(${tenants}::uuid[]))::int as ra,
    (select count(*) from public.audit_event where action_id = ${A.issue} and tenant_id = any(${tenants}::uuid[]))::int as ia,
    (select count(*) from public.audit_event where action_id = ${A.settle} and tenant_id = any(${tenants}::uuid[]))::int as sa,
    (select count(*) from public.audit_event where action_id = ${A.withdraw} and tenant_id = any(${tenants}::uuid[]))::int as wa,
    (select count(*) from tmpos_invoice_payment.invoice_payment where tenant_id = any(${tenants}::uuid[]))::int as p,
    (select count(*) from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${tenants}::uuid[]))::int as v,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from public.audit_event)::int as aa,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le`;
  return { RG: r.rg, RS: r.rs, CN: r.cn, WD: r.wd, NB: r.nb, RA: r.ra, IA: r.ia, SA: r.sa, WA: r.wa, P: r.p, V: r.v, K: r.k, AA: r.aa, OO: r.oo, LE: r.le };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const NOTHING = Object.freeze({ RG: 0, RS: 0, CN: 0, WD: 0, NB: 0, RA: 0, IA: 0, SA: 0, WA: 0, P: 0, V: 0, K: 0, AA: 0, OO: 0, LE: 0 });
/** A refusal that rolled back after the key (a 404, a 503 or an unsealed 409): nothing but the attempt's lease. */
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
/** A sealed 409: only its idempotency completion commits. */
const COMPLETION_ONLY = Object.freeze({ ...NOTHING, K: 1 });
/** Runs `fn` and asserts what it wrote against `want` (keys: the idempotency keys whose completions count). */
async function writes(tenants, keys, want, label, fn) {
  const before = await counts(tenants, keys);
  const value = await fn();
  assert.deepEqual(delta(await counts(tenants, keys), before), want, `${label}: what it wrote`);
  return value;
}
const keyOf = (s, key) => [{ key, principal: s.principal }];

const AUDIT_FIXED = Object.freeze({ decision: 'allow', result_status: 'succeeded', scope_type: 'store', source_of_truth: 'invoice_credit_note_routine',
  evaluated_by: 'm7b_invoice_credit_note_routine@v1', metadata: '{}' });
/** The credit-note audit rows of `action` naming exactly these subjects. */
async function auditsOf(tenant, action, { cn = null, reg = null }) {
  return (await owner`select action_id, required_permission, reason_code, decision, result_status, scope_type, source_of_truth, evaluated_by,
      metadata::text as metadata, actor_internal_user_id as actor, store_id, subject_invoice_credit_note_id as cn,
      subject_invoice_credit_note_registration_id as reg
    from public.audit_event where tenant_id = ${tenant} and action_id = ${action}
      and subject_invoice_credit_note_id is not distinct from ${cn}::uuid and subject_invoice_credit_note_registration_id is not distinct from ${reg}::uuid`)
    .map((r) => ({ ...r }));
}
async function assertOneAudit(w, action, subjects, want, label) {
  const rows = await auditsOf(w.T, action, subjects);
  assert.equal(rows.length, 1, `${label}: exactly one ${action} audit row for its subjects`);
  assert.deepEqual(rows[0], { action_id: action, ...AUDIT_FIXED, store_id: w.S, cn: subjects.cn ?? null, reg: subjects.reg ?? null, ...want }, `${label}: the audit row`);
}

/** The session's sign-in aged to `ageMs` before the DATABASE clock; true when it is now older than the 10-minute window. */
async function ageSession(s, ageMs) {
  const rows = await owner`update tmpos_session.session
      set authenticated_at = (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint - ${ageMs}::bigint
    where session_key = ${s.key}
    returning authenticated_at < (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint - ${RECENT_AUTH_MAX_AGE_MS}::bigint as stale`;
  assert.equal(rows.length, 1, 'the session row is found');
  return rows[0].stale;
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
  /** A POST: `drop` removes named headers, `headers` overrides them (the CSRF cases). */
  const unsafe = (s, path, body, key, { headers = {}, drop = [] } = {}) => {
    USED_KEYS.push({ key, principal: s.principal });
    const all = {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf, 'idempotency-key': key, ...headers,
    };
    for (const name of drop) delete all[name];
    return send(port, 'POST', path, all, typeof body === 'string' ? body : JSON.stringify(body));
  };
  const inv = (w, invoice) => `/api/v1/stores/${w.S}/invoices/${invoice}`;
  const ctx = {
    port, lines,
    read: (s, path) => send(port, 'GET', path, { host: TENANT_HOST, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }),
    settings: (s, store) => ctx.read(s, `/api/v1/issuing-settings/${store}`),
    putSettings: (s, store, body, key = randomUUID()) => {
      USED_KEYS.push({ key, principal: s.principal });
      return send(port, 'PUT', `/api/v1/issuing-settings/${store}`, {
        host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
        cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf, 'idempotency-key': key,
      }, JSON.stringify(body));
    },
    save: (s, store, body, key = randomUUID()) => unsafe(s, `/api/v1/stores/${store}/invoice-drafts`, body, key),
    issueDraft: (s, store, id, body, key = randomUUID()) => unsafe(s, `/api/v1/stores/${store}/invoice-drafts/${id}/issue`, body, key),
    detail: (s, w, invoice) => ctx.read(s, inv(w, invoice)),
    // credit notes (WIRE §1-§7)
    register: (s, w, invoice, body, key = randomUUID(), opts) => unsafe(s, `${inv(w, invoice)}/credit-note-registrations`, body, key, opts),
    proof: (s, w, invoice, registration) => ctx.read(s, `${inv(w, invoice)}/credit-note-registration-proof?registration=${registration}`),
    issue: (s, w, invoice, body, key = randomUUID(), opts) => unsafe(s, `${inv(w, invoice)}/credit-notes`, body, key, opts),
    attempts: (s, w, query = '') => ctx.read(s, `/api/v1/stores/${w.S}/credit-note-attempts${query}`),
    settle: (s, w, invoice, body, key = randomUUID(), opts) => unsafe(s, `${inv(w, invoice)}/credit-note-settlement`, body, key, opts),
    withdraw: (s, w, invoice, cn, body, key = randomUUID(), opts) => unsafe(s, `${inv(w, invoice)}/credit-notes/${cn}/withdrawal`, body, key, opts),
    list: (s, w, invoice, query = '') => ctx.read(s, `${inv(w, invoice)}/credit-notes${query}`),
    // payments and void (WIRE §8)
    payRegister: (s, w, invoice, body, key = randomUUID()) => unsafe(s, `${inv(w, invoice)}/payment-registrations`, body, key),
    payProof: (s, w, invoice, registration) => ctx.read(s, `${inv(w, invoice)}/payment-registration-proof?registration=${registration}`),
    payRecord: (s, w, invoice, body, key = randomUUID()) => unsafe(s, `${inv(w, invoice)}/payments`, body, key),
    paySettle: (s, w, invoice, body, key = randomUUID()) => unsafe(s, `${inv(w, invoice)}/payment-settlement`, body, key),
    payments: (s, w, invoice) => ctx.read(s, `${inv(w, invoice)}/payments`),
    voidInvoice: (s, w, invoice, body, key = randomUUID()) => unsafe(s, `${inv(w, invoice)}/void`, body, key),
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
    throw sealDbError('ICH case', err);
  } finally {
    if (codes.length === 0) {
      proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; codes.length === 0 && Date.now() < until;) await delay(10);
    }
    if (!failed) assert.equal(codes.length, 1, 'the entry exited within 5 s of SIGTERM');
  }
}
/** A sign-in through the tenant entry (IVH-01's path, tests/db/invoiceVoidHttp.integration.test.mjs:784). Budget: an account
 * may sign in at most five times in five minutes (runtime/rateLimit.ts loginAccount), so every case uses its own actors. */
async function signIn(ctx, who, { headers = {} } = {}) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${who.token}`, ...headers,
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
/** A draft saved and issued by `s` at `w`'s store: the issued invoice id. Total 10,888 (doc 16 §5's X). */
async function issueOne(ctx, s, w, label) {
  const saved = await ctx.save(s, w.S, { expectedTenant: w.T, customerId: w.C, currency: 'USD', lines: [{ description: `ICH ${label} ${SUFFIX}`, quantity: 1, unitPriceCents: 10_000 }] });
  assert.equal(saved.status, 201, `${label}: the seed save: ${replyNote(saved)}`);
  const draft = parseBody(saved, `${label}: the seed save`).draft.id;
  const issued = await ctx.issueDraft(s, w.S, draft, { expectedTenant: w.T, expectedVersion: 1, expectedSettingsVersion: w.settingsVersion, expectedCustomerVersion: 1 });
  assert.equal(issued.status, 201, `${label}: the issue: ${replyNote(issued)}`);
  const invoice = parseBody(issued, `${label}: the issue`).invoice.id;
  assert.match(invoice, UUID_RE);
  return invoice;
}

// --- credit-note request bodies and answers -------------------------------------------------------------------------------

const regBody = (w, attemptId, grossCents, reason = 'pricing_error') => ({ expectedTenant: w.T, attemptId, grossCents, reason });
const issueBody = (w, r, over = {}) => ({
  expectedTenant: w.T, registrationId: r.registration, attemptId: r.attempt, grossCents: r.gross, reason: r.reason, registrationProof: r.proof, ...over,
});
const settleBody = (w, attemptId, expectedVersion) => ({ expectedTenant: w.T, attemptId, expectedVersion });
const withdrawBody = (w, reason = 'wrong_amount') => ({ expectedTenant: w.T, expectedVersion: 1, reason });

function registeredOf(reply, invoice, attemptId, grossCents, reason, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${replyNote(reply)}`);
  const id = parseBody(reply, label)?.registration?.id;
  assert.ok(UUID_RE.test(String(id)), `${label}: a new registration id`);
  assert.ok(reply.body === JSON.stringify({ registration: { id, invoiceId: invoice, attemptId, grossCents, reason, state: 'open' } }),
    `${label}: the exact sealed body, never a proof (${replyNote(reply)})`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
  return id;
}
function proofOf(reply, r, invoice, label) {
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  const proof = parseBody(reply, label)?.proof;
  assert.ok(PROOF_RE.test(String(proof)), `${label}: 64 lowercase hex digits (value withheld)`);
  assert.ok(reply.body === JSON.stringify({ registration: { id: r.registration, invoiceId: invoice, attemptId: r.attempt }, proof }), `${label}: the exact body`);
  assertBaseline(reply, label);
  PROOFS.add(proof);
  return proof;
}
function issuedOf(reply, invoice, r, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${replyNote(reply)}`);
  const id = parseBody(reply, label)?.creditNote?.id;
  assert.ok(UUID_RE.test(String(id)), `${label}: a new credit note id`);
  assert.ok(reply.body === JSON.stringify({ creditNote: { id, invoiceId: invoice, attemptId: r.attempt, grossCents: r.gross, reason: r.reason } }),
    `${label}: the exact sealed body, no number (${replyNote(reply)})`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
  return id;
}
function settledOf(reply, invoice, attemptId, state, label, { replayed = false } = {}) {
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  assert.ok(reply.body === JSON.stringify({ settlement: { invoiceId: invoice, attemptId, state } }), `${label}: the exact sealed body (${replyNote(reply)})`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
function withdrawnOf(reply, invoice, cn, label, { replayed = false } = {}) {
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  assert.ok(reply.body === JSON.stringify({ creditNote: { id: cn, invoiceId: invoice, status: 'withdrawn' } }), `${label}: the exact sealed body (${replyNote(reply)})`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
/** The list's 200 for `invoice`: its notes (keys checked by the caller). */
function notesOf(reply, invoice, label) {
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  assertBaseline(reply, label);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body), ['invoice', 'creditNotes', 'nextCursor'], `${label}: the answer's keys`);
  assert.deepEqual(body.invoice, { id: invoice }, label);
  assert.equal(body.nextCursor, null, label);
  for (const n of body.creditNotes) {
    assert.match(n.issuedAt, TIME_RE, `${label}: issuedAt`);
    assert.equal(n.grossCents, n.taxCents + n.netCents, `${label}: gross = tax + net`);
    if (n.withdrawal !== null) assert.match(n.withdrawal.withdrawnAt, TIME_RE, `${label}: withdrawnAt`);
  }
  return body.creditNotes;
}
const OWNER_NOTE_KEYS = ['id', 'number', 'grossCents', 'taxCents', 'netCents', 'reason', 'issuedAt', 'issuedByName', 'withdrawal'];
const OTHER_NOTE_KEYS = ['id', 'number', 'grossCents', 'taxCents', 'netCents', 'reason', 'issuedAt', 'withdrawal'];
/** The caller's attempts at `w`'s store (the 200's exact keys). */
async function attemptsOf(ctx, s, w, label) {
  const reply = await ctx.attempts(s, w);
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  assertBaseline(reply, label);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body), ['attempts', 'nextCursor'], label);
  for (const a of body.attempts) {
    assert.deepEqual(Object.keys(a), ['invoiceId', 'invoiceNumber', 'attemptId', 'state', 'version', 'registeredAt', 'settledAt', 'grossCents', 'reason', 'creditNote'], `${label}: an attempt's keys`);
    assert.match(a.registeredAt, TIME_RE, label);
  }
  assert.ok(![...PROOFS].some((p) => reply.body.includes(p)), `${label}: never a proof`);
  return body.attempts;
}
/** The payments read's amounts and word (WIRE §8, the exact key order). */
async function amountsOf(ctx, s, w, invoice, label) {
  const reply = await ctx.payments(s, w, invoice);
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body.amounts), ['currency', 'dueCents', 'creditedCents', 'appliedCents', 'remainingCents'], `${label}: the amounts' keys in order`);
  const { currency, dueCents, creditedCents, appliedCents, remainingCents } = body.amounts;
  return { currency, due: dueCents, credited: creditedCents, applied: appliedCents, remaining: remainingCents, status: body.paymentStatus };
}

/** register → proof for `s` at `invoice`: { registration, attempt, gross, reason, proof }. */
async function registeredWithProof(ctx, s, w, invoice, gross, label, { reason = 'pricing_error', attempt = randomUUID(), key = randomUUID() } = {}) {
  const registration = registeredOf(await ctx.register(s, w, invoice, regBody(w, attempt, gross, reason), key), invoice, attempt, gross, reason, `${label}: register`);
  const r = { registration, attempt, gross, reason, key };
  r.proof = proofOf(await ctx.proof(s, w, invoice, registration), r, invoice, `${label}: proof`);
  return r;
}
/** register → proof → issue: the registration with its credit note id. */
async function credited(ctx, s, w, invoice, gross, label, opts) {
  const r = await registeredWithProof(ctx, s, w, invoice, gross, label, opts);
  r.creditNote = issuedOf(await ctx.issue(s, w, invoice, issueBody(w, r)), invoice, r, `${label}: issue`);
  return r;
}
/** A payment registration with its proof (037's flow); `record(amount, key)` posts the record. */
async function paymentReady(ctx, s, w, invoice, label) {
  const attempt = randomUUID();
  const reg = await ctx.payRegister(s, w, invoice, { expectedTenant: w.T, attemptId: attempt });
  assert.equal(reg.status, 201, `${label}: payment register: ${replyNote(reg)}`);
  const registration = parseBody(reg, label).registration.id;
  const pr = await ctx.payProof(s, w, invoice, registration);
  assert.equal(pr.status, 200, `${label}: payment proof: ${replyNote(pr)}`);
  const proof = parseBody(pr, label).proof;
  PROOFS.add(proof);
  return {
    registration, attempt,
    record: (amountCents, key = randomUUID()) => ctx.payRecord(s, w, invoice,
      { expectedTenant: w.T, registrationId: registration, attemptId: attempt, amountCents, method: 'cash', registrationProof: proof }, key),
  };
}
async function paid(ctx, s, w, invoice, amountCents, label) {
  const p = await paymentReady(ctx, s, w, invoice, label);
  const reply = await p.record(amountCents);
  assert.equal(reply.status, 201, `${label}: payment record: ${replyNote(reply)}`);
  return p;
}
const voidBody = (w) => ({ expectedTenant: w.T, reasonCode: 'wrong_seller_details' });

// ===========================================================================
// ICH-00: the shipping table
// ===========================================================================

test('ICH-00 (doc 16 §8 scope): the tenant entry ships the seven credit-note routes with their body and idempotency', (t) => {
  const served = TENANT_SHIPPING_ROUTES.map((r) => `${r.method} ${r.path} ${r.body} ${r.idempotency}`);
  for (const want of [
    'POST /api/v1/stores/{storeId}/invoices/{id}/credit-note-registrations json required',
    'GET /api/v1/stores/{storeId}/invoices/{id}/credit-note-registration-proof none none',
    'POST /api/v1/stores/{storeId}/invoices/{id}/credit-notes json required',
    'GET /api/v1/stores/{storeId}/credit-note-attempts none none',
    'POST /api/v1/stores/{storeId}/invoices/{id}/credit-note-settlement json required',
    'POST /api/v1/stores/{storeId}/invoices/{id}/credit-notes/{creditNoteId}/withdrawal json required',
    'GET /api/v1/stores/{storeId}/invoices/{id}/credit-notes none none',
  ]) assert.ok(served.includes(want), want);
});

// ===========================================================================
// ICH-01 / ICH-02: the owner's path and the manager's denials on ONE invoice and store
// ===========================================================================

/** ICH-01's world, invoice and second credit note, reused by ICH-02 (CN-10c: "run on the same invoice and store as CN-10b"). */
const SHARED = {};

test('ICH-01 (CN-10c, CN-13 HTTP, CN-23, CN-33 owner half): a real store-scope store_owner registers, gets the proof, issues, lists, looks up, settles and withdraws over HTTP within the sign-in window — each succeeds; each mutation writes EXACTLY one routine audit row, the list and lookup none; the withdrawal raises remaining (E6) and a second withdrawal is invalid_state', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich01');
    const so = await storeOwner(w, 'so');
    const s = await signIn(ctx, so);
    const x = await issueOne(ctx, w.sm, w, 'ich01 x');
    Object.assign(SHARED, { w, so, s, x });

    // register
    const r = { attempt: randomUUID(), gross: 2000, reason: 'pricing_error' };
    const k1 = randomUUID();
    r.registration = await writes([w.T], keyOf(s, k1), { ...NOTHING, RG: 1, RA: 1, AA: 1, K: 1 }, 'CN-10c register',
      async () => registeredOf(await ctx.register(s, w, x, regBody(w, r.attempt, r.gross, r.reason), k1), x, r.attempt, r.gross, r.reason, 'CN-10c register'));
    await assertOneAudit(w, A.register, { reg: r.registration },
      { required_permission: 'issue_invoice_credit_notes', reason_code: 'invoice_credit_note_attempt_registered', actor: so.id }, 'CN-13 register');

    // proof (a read: nothing written)
    r.proof = await writes([w.T], [], NOTHING, 'CN-10c proof', async () => proofOf(await ctx.proof(s, w, x, r.registration), r, x, 'CN-10c proof'));

    // issue
    const k2 = randomUUID();
    r.creditNote = await writes([w.T], keyOf(s, k2), { ...NOTHING, CN: 1, NB: 1, IA: 1, AA: 1, K: 1 }, 'CN-10c issue',
      async () => issuedOf(await ctx.issue(s, w, x, issueBody(w, r), k2), x, r, 'CN-10c issue'));
    await assertOneAudit(w, A.issue, { cn: r.creditNote, reg: r.registration },
      { required_permission: 'issue_invoice_credit_notes', reason_code: 'invoice_credit_note_issued_pricing_error', actor: so.id }, 'CN-13 issue');

    // list (owner: names present) — nothing written
    const notes = await writes([w.T], [], NOTHING, 'CN-10c list', async () => notesOf(await ctx.list(s, w, x), x, 'CN-10c list'));
    assert.equal(notes.length, 1, 'one credit note listed');
    assert.deepEqual(Object.keys(notes[0]), OWNER_NOTE_KEYS, 'CN-33: the owner sees issuedByName');
    assert.deepEqual({ ...notes[0], issuedAt: '-' }, {
      id: r.creditNote, number: 1, grossCents: 2000, taxCents: 163, netCents: 1837, reason: 'pricing_error', issuedAt: '-', issuedByName: so.displayName, withdrawal: null,
    }, 'E1: number 1, tax 163, net 1,837, the issuing owner\'s display name');

    // lookup — nothing written
    const attempts = await writes([w.T], [], NOTHING, 'CN-10c lookup', () => attemptsOf(ctx, s, w, 'CN-10c lookup'));
    assert.ok(!JSON.stringify(attempts).includes(r.registration), 'the lookup never carries a registration id');
    const mine = attempts.filter((a) => a.attemptId === r.attempt);
    assert.equal(mine.length, 1, 'the attempt is listed once');
    assert.deepEqual([mine[0].invoiceId, mine[0].state, mine[0].version, mine[0].settledAt, mine[0].grossCents, mine[0].reason, mine[0].creditNote?.id, mine[0].creditNote?.withdrawnAt],
      [x, 'issued', 2, null, 2000, 'pricing_error', r.creditNote, null], 'issued at version 2, bound gross and reason, its credit note');
    assert.ok(Number.isInteger(mine[0].invoiceNumber) && mine[0].invoiceNumber >= 1, 'the invoice number');

    // settlement: confirm the issued attempt
    const k3 = randomUUID();
    await writes([w.T], keyOf(s, k3), { ...NOTHING, RS: 1, SA: 1, AA: 1, K: 1 }, 'CN-10c settle',
      async () => settledOf(await ctx.settle(s, w, x, settleBody(w, r.attempt, 2), k3), x, r.attempt, 'confirmed', 'CN-10c settle'));
    await assertOneAudit(w, A.settle, { reg: r.registration },
      { required_permission: 'recover_invoice_credit_notes', reason_code: 'invoice_credit_note_attempt_confirmed', actor: so.id }, 'CN-13 settle');
    assert.deepEqual(await amountsOf(ctx, s, w, x, 'after the credit'),
      { currency: 'USD', due: TOTAL, credited: 2000, applied: 0, remaining: 8888, status: 'no_payment_recorded' }, 'E1: 2,000 / 0 / 8,888');

    // withdrawal
    const k4 = randomUUID();
    await writes([w.T], keyOf(s, k4), { ...NOTHING, WD: 1, WA: 1, AA: 1, K: 1 }, 'CN-10c withdraw',
      async () => withdrawnOf(await ctx.withdraw(s, w, x, r.creditNote, withdrawBody(w, 'wrong_amount'), k4), x, r.creditNote, 'CN-10c withdraw'));
    await assertOneAudit(w, A.withdraw, { cn: r.creditNote },
      { required_permission: 'withdraw_invoice_credit_notes', reason_code: 'invoice_credit_note_withdrawn_wrong_amount', actor: so.id }, 'CN-13 withdraw');
    const [after] = notesOf(await ctx.list(s, w, x), x, 'the list after the withdrawal');
    assert.deepEqual({ ...after.withdrawal, withdrawnAt: '-' }, { withdrawnAt: '-', reason: 'wrong_amount', withdrawnByName: so.displayName },
      'CN-33: the withdrawing owner\'s name; the number kept');
    assert.equal(after.number, 1, 'the withdrawn note keeps its number');
    // CN-23: the withdrawal raises remaining; a second one is invalid_state with nothing but its completion.
    assert.deepEqual(await amountsOf(ctx, s, w, x, 'after the withdrawal'),
      { currency: 'USD', due: TOTAL, credited: 0, applied: 0, remaining: TOTAL, status: 'no_payment_recorded' }, 'E6: remaining back to 10,888');
    const k5 = randomUUID();
    await writes([w.T], keyOf(s, k5), COMPLETION_ONLY, 'CN-23 second withdrawal',
      async () => sealedOf(await ctx.withdraw(s, w, x, r.creditNote, withdrawBody(w, 'entered_in_error'), k5), 'invalid_state', 'CN-23 second withdrawal'));

    // E6's re-issue: credit 1,500 → tax 122, net 1,378, number 2; remaining 9,388.
    const r2 = await credited(ctx, s, w, x, 1500, 'E6 re-issue', { reason: 'service_issue' });
    const listed = notesOf(await ctx.list(s, w, x), x, 'the list after the re-issue');
    assert.deepEqual(listed.map((n) => [n.id, n.number, n.grossCents, n.taxCents, n.netCents, n.withdrawal === null]),
      [[r.creditNote, 1, 2000, 163, 1837, false], [r2.creditNote, 2, 1500, 122, 1378, true]], 'E6: the new credit (tax 122, net 1,378), numbered 2');
    assert.deepEqual(await amountsOf(ctx, s, w, x, 'after the re-issue'),
      { currency: 'USD', due: TOTAL, credited: 1500, applied: 0, remaining: 9388, status: 'no_payment_recorded' }, 'E6: 1,500 / 0 / 9,388');
    SHARED.r2 = r2;
  });
});

test('ICH-02 (CN-10b, CN-33 others half): on ICH-01\'s invoice and store, a manager with Invoices Full (who registers and settles a payment) gets 403 on every credit-note mutation and recovery route with nothing written; the manager\'s list carries no name fields', async () => {
  assert.ok(SHARED.r2 !== undefined, 'ICH-01 ran to completion (its invoice and credit note are the subjects here)');
  const { w, x, r2 } = SHARED;
  await withEntry(async (ctx) => {
    const m = w.sm;
    // The manager holds the payment keys: a payment registration on the same invoice, released.
    const p = await paymentReady(ctx, m, w, x, 'CN-10b control');
    const rel = await ctx.paySettle(m, w, x, { expectedTenant: w.T, attemptId: p.attempt, expectedVersion: 1 });
    assert.equal(rel.status, 200, `CN-10b control: the manager settles his payment registration: ${replyNote(rel)}`);
    // Every credit-note mutation and recovery route, with real ids: 403 forbidden from the chain, before any key.
    for (const [label, call] of [
      ['register', () => ctx.register(m, w, x, regBody(w, randomUUID(), 100))],
      ['proof', () => ctx.proof(m, w, x, r2.registration)],
      ['issue', () => ctx.issue(m, w, x, issueBody(w, r2))],
      ['attempts', () => ctx.attempts(m, w)],
      ['settlement', () => ctx.settle(m, w, x, settleBody(w, r2.attempt, 2))],
      ['withdrawal', () => ctx.withdraw(m, w, x, r2.creditNote, withdrawBody(w))],
    ]) {
      await writes([w.T], [], NOTHING, `CN-10b ${label}`, async () => assertRefusal(await call(), 403, 'forbidden', `CN-10b the manager's ${label}`));
    }
    // The list follows view_issued_invoices: the manager reads it, without any name field (CN-33).
    const notes = notesOf(await ctx.list(m, w, x), x, 'CN-33 the manager\'s list');
    assert.equal(notes.length, 2, 'both notes');
    for (const n of notes) {
      assert.deepEqual(Object.keys(n), OTHER_NOTE_KEYS, 'CN-33: issuedByName absent (not null) for a manager');
      if (n.withdrawal !== null) assert.deepEqual(Object.keys(n.withdrawal), ['withdrawnAt', 'reason'], 'CN-33: withdrawnByName absent for a manager');
    }
    assert.ok(!notes.some((n) => JSON.stringify(n).includes(SHARED.so.id)), 'never a staff id');
  });
});

// ===========================================================================
// ICH-03: CN-10
// ===========================================================================

test('ICH-03 (CN-10): a tenant-scope owner, a technician and a sales_staff member are refused every credit-note mutation and recovery route with nothing written while the store-scope owner\'s identical request succeeds in the same iteration; their list answers exactly as the issued-invoice detail read; a store or tenant that is read_only or overdue refuses the owner\'s register, issue and withdrawal, and the same owner succeeds once it is active', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich03');
    const so = await storeOwner(w, 'so');
    const s = await signIn(ctx, so);
    const tech = await actor('ich03-tech', [storeGrant(w.T, w.S, 'technician')]);
    const sales = await actor('ich03-sales', [storeGrant(w.T, w.S, 'sales_staff')]);
    for (const [who, sess] of [['the tenant-scope owner', w.sb], ['a technician', await signIn(ctx, tech)], ['a sales_staff member', await signIn(ctx, sales)]]) {
      const x = await issueOne(ctx, w.sm, w, `ich03 ${who}`);
      const r = { attempt: randomUUID(), gross: 700, reason: 'pricing_error' };
      const denied = async (label, call) => writes([w.T], [], NOTHING, `CN-10 ${who} ${label}`,
        async () => assertRefusal(await call(sess), 403, 'forbidden', `CN-10 ${who}'s ${label}`));
      // Each refusal is followed by the SAME request from the store-scope owner, which succeeds.
      await denied('register', (q) => ctx.register(q, w, x, regBody(w, r.attempt, r.gross, r.reason)));
      r.registration = registeredOf(await ctx.register(s, w, x, regBody(w, r.attempt, r.gross, r.reason)), x, r.attempt, r.gross, r.reason, `control ${who}: register`);
      await denied('proof', (q) => ctx.proof(q, w, x, r.registration));
      r.proof = proofOf(await ctx.proof(s, w, x, r.registration), r, x, `control ${who}: proof`);
      await denied('issue', (q) => ctx.issue(q, w, x, issueBody(w, r)));
      r.creditNote = issuedOf(await ctx.issue(s, w, x, issueBody(w, r)), x, r, `control ${who}: issue`);
      await denied('attempts', (q) => ctx.attempts(q, w));
      assert.ok((await attemptsOf(ctx, s, w, `control ${who}: attempts`)).some((a) => a.attemptId === r.attempt), `control ${who}: the owner's lookup lists the attempt`);
      await denied('settlement', (q) => ctx.settle(q, w, x, settleBody(w, r.attempt, 2)));
      settledOf(await ctx.settle(s, w, x, settleBody(w, r.attempt, 2)), x, r.attempt, 'confirmed', `control ${who}: settlement`);
      await denied('withdrawal', (q) => ctx.withdraw(q, w, x, r.creditNote, withdrawBody(w)));
      withdrawnOf(await ctx.withdraw(s, w, x, r.creditNote, withdrawBody(w)), x, r.creditNote, `control ${who}: withdrawal`);
      const list = await ctx.list(sess, w, x);
      const detail = await ctx.detail(sess, w, x);
      assert.equal(list.status, detail.status, `CN-10 ${who}: the list follows view_issued_invoices (list ${replyNote(list)}, detail ${replyNote(detail)})`);
      if (list.status === 200) {
        for (const n of notesOf(list, x, `CN-33 ${who}'s list`)) assert.deepEqual(Object.keys(n), OTHER_NOTE_KEYS, `CN-33 ${who}: no name field`);
      }
    }
    // Account status of the store and of the tenant. A status change ends the affected sessions, so every phase signs in
    // afresh, and every iteration has its own owner (an account signs in at most five times in five minutes). The owner
    // issues the iteration's invoice itself (the manager's session would be ended by the first change).
    for (const [kind, status] of [['store', 'read_only'], ['store', 'overdue'], ['tenant', 'read_only'], ['tenant', 'overdue']]) {
      const label = `${kind} ${status}`;
      const oi = await storeOwner(w, `${kind}-${status}`);
      const s0 = await signIn(ctx, oi);
      const xi = await issueOne(ctx, s0, w, `ich03 ${label}`);
      const a = await credited(ctx, s0, w, xi, 300, `${label} withdrawal subject`);
      settledOf(await ctx.settle(s0, w, xi, settleBody(w, a.attempt, 2)), xi, a.attempt, 'confirmed', `${label}: free the slot`);
      const b = await registeredWithProof(ctx, s0, w, xi, 200, `${label} issue subject`);
      const setStatus = (to) => (kind === 'store' ? owner`update store set status = ${to} where store_id = ${w.S}` : owner`update tenant set status = ${to} where tenant_id = ${w.T}`);
      await setStatus(status);
      try {
        const sx = await signIn(ctx, oi);
        for (const [route, call] of [
          ['register', () => ctx.register(sx, w, xi, regBody(w, randomUUID(), 100))],
          ['issue', () => ctx.issue(sx, w, xi, issueBody(w, b))],
          ['withdrawal', () => ctx.withdraw(sx, w, xi, a.creditNote, withdrawBody(w))],
        ]) {
          await writes([w.T], [], NOTHING, `CN-10 ${label} ${route}`, async () => assertRefusal(await call(), 403, 'forbidden', `CN-10 ${label}: the owner's ${route}`));
        }
        const list = await ctx.list(sx, w, xi);
        const detail = await ctx.detail(sx, w, xi);
        assert.equal(list.status, detail.status, `CN-10 ${label}: the list follows view_issued_invoices (list ${replyNote(list)}, detail ${replyNote(detail)})`);
      } finally {
        await setStatus('active');
      }
      // Positive control in the same iteration: the same owner, the account active again, does the same three requests.
      const sy = await signIn(ctx, oi);
      settledOf(await ctx.settle(sy, w, xi, settleBody(w, b.attempt, 1)), xi, b.attempt, 'released', `control ${label}: the old session's registration released`);
      const c = await registeredWithProof(ctx, sy, w, xi, 100, `control ${label}: register`);
      issuedOf(await ctx.issue(sy, w, xi, issueBody(w, c)), xi, c, `control ${label}: issue`);
      withdrawnOf(await ctx.withdraw(sy, w, xi, a.creditNote, withdrawBody(w)), xi, a.creditNote, `control ${label}: withdrawal`);
    }
  });
});

// ===========================================================================
// ICH-04: CN-05
// ===========================================================================

test('ICH-04 (CN-05): same session, key and bytes replay with Idempotent-Replayed: true; a sign-in older than 10 minutes (database clock) is 403 step_up_required before idempotency; a narrowed role or a suspended grant is 401/403, never a replay; a renewed session is 422 idempotency_key_reused on the session-bound register and issue while the withdrawal replays; a key in progress is 409 request_in_progress; nothing new written in any case', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich04');
    const o = await storeOwner(w, 'o');
    const s1 = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'ich04 x');
    // The original register and issue, and their replays from the same session.
    const r = { attempt: randomUUID(), gross: 1200, reason: 'goodwill' };
    const regKey = randomUUID();
    const regBytes = JSON.stringify(regBody(w, r.attempt, r.gross, r.reason));
    const first = await ctx.register(s1, w, x, regBytes, regKey);
    r.registration = registeredOf(first, x, r.attempt, r.gross, r.reason, 'register');
    r.proof = proofOf(await ctx.proof(s1, w, x, r.registration), r, x, 'proof');
    const issueKey = randomUUID();
    const issueBytes = JSON.stringify(issueBody(w, r));
    const issued = await ctx.issue(s1, w, x, issueBytes, issueKey);
    r.creditNote = issuedOf(issued, x, r, 'issue');
    const keys = [...keyOf(s1, regKey), ...keyOf(s1, issueKey)];
    await writes([w.T], keys, NOTHING, 'CN-05 same-session replays', async () => {
      const a = await ctx.register(s1, w, x, regBytes, regKey);
      assert.ok(a.status === 201 && a.body === first.body && a.headers['idempotent-replayed'] === 'true', `CN-05 register replay: the stored answer (${replyNote(a)})`);
      const b = await ctx.issue(s1, w, x, issueBytes, issueKey);
      assert.ok(b.status === 201 && b.body === issued.body && b.headers['idempotent-replayed'] === 'true', `CN-05 issue replay: the stored sealed success (${replyNote(b)})`);
    });

    // A sign-in older than 10 minutes, staged through the database clock: the step-up before idempotency is consulted.
    assert.equal(await ageSession(s1, RECENT_AUTH_MAX_AGE_MS + 60_000), true, 'the session binds a sign-in older than 10 minutes');
    await writes([w.T], keys, NOTHING, 'CN-05 stale replays', async () => {
      for (const [label, reply] of [['register', await ctx.register(s1, w, x, regBytes, regKey)], ['issue', await ctx.issue(s1, w, x, issueBytes, issueKey)]]) {
        assertRefusal(reply, 403, 'step_up_required', `CN-05 stale ${label} replay`);
        assert.equal(ctx.reason(reply), 'recent_auth_required', `CN-05 stale ${label}: the chain's step-up`);
      }
    });
    assert.equal(await ageSession(s1, 0), false, 'the sign-in is recent again');
    const back = await ctx.issue(s1, w, x, issueBytes, issueKey);
    assert.ok(back.status === 201 && back.body === issued.body && back.headers['idempotent-replayed'] === 'true', `CN-05: recent again, the replay returns (${replyNote(back)})`);

    // A renewed session: the session-bound register and issue are 422 while the completion is retained.
    const s2 = await signIn(ctx, o);
    assert.ok(s2.key !== s1.key, 'a new session (values withheld)');
    await writes([w.T], keys, NOTHING, 'CN-05 renewed session', async () => {
      for (const [label, reply] of [['register', await ctx.register(s2, w, x, regBytes, regKey)], ['issue', await ctx.issue(s2, w, x, issueBytes, issueKey)]]) {
        assertRefusal(reply, 422, 'idempotency_key_reused', `CN-05 renewed session ${label} replay`);
        assert.ok(!reply.body.includes(r.registration) && !reply.body.includes(r.creditNote), `CN-05 ${label}: no cached body`);
      }
    });
    // The withdrawal is NOT session-bound: a renewed session replays its stored answer.
    const wKey = randomUUID();
    const wBytes = JSON.stringify(withdrawBody(w, 'entered_in_error'));
    const wd = await ctx.withdraw(s2, w, x, r.creditNote, wBytes, wKey);
    withdrawnOf(wd, x, r.creditNote, 'withdraw');
    const s3 = await signIn(ctx, o);
    await writes([w.T], keyOf(s3, wKey), NOTHING, 'CN-05 withdrawal replay from a renewed session', async () => {
      const again = await ctx.withdraw(s3, w, x, r.creditNote, wBytes, wKey);
      assert.ok(again.status === 200 && again.body === wd.body && again.headers['idempotent-replayed'] === 'true', `CN-05 the withdrawal replays (${replyNote(again)})`);
    });

    // A key in progress: an unsealed refusal (stale expectedTenant, rolled back, the lease kept), then the same key again.
    const other = await newTenant('ich04-other');
    const ipKey = randomUUID();
    const ipBytes = JSON.stringify({ ...regBody(w, randomUUID(), 300), expectedTenant: other });
    const y = await issueOne(ctx, w.sm, w, 'ich04 y');
    await writes([w.T], keyOf(s3, ipKey), LEASE_ONLY, 'CN-05 the precondition', async () => {
      const reply = await ctx.register(s3, w, y, ipBytes, ipKey);
      assertRefusal(reply, 409, 'write_conflict', 'CN-05 stale expectedTenant');
      assert.equal(ctx.reason(reply), 'transaction_precondition_failed', 'the precondition, rolled back');
    });
    await writes([w.T], keyOf(s3, ipKey), NOTHING, 'CN-05 in progress', async () => {
      assertRefusal(await ctx.register(s3, w, y, ipBytes, ipKey), 409, 'request_in_progress', 'CN-05 the same key within the lease');
    });

    // Revoked authority: a role narrowed after the register, and a grant suspended — 401 or 403, never the stored answer.
    for (const [label, change] of [
      ['role narrowed to manager', (who) => owner`update user_membership set role_id = 'manager' where internal_user_id = ${who.id}`],
      ['grant suspended', (who) => owner`update user_membership set status = 'suspended' where internal_user_id = ${who.id}`],
    ]) {
      const who = await storeOwner(w, label.split(' ')[0]);
      const sw = await signIn(ctx, who);
      const z = await issueOne(ctx, w.sm, w, `ich04 ${label}`);
      const k = randomUUID();
      const bytes = JSON.stringify(regBody(w, randomUUID(), 400));
      assert.equal((await ctx.register(sw, w, z, bytes, k)).status, 201, `${label}: the original register`);
      await change(who);
      await writes([w.T], keyOf(sw, k), NOTHING, `CN-05 ${label}`, async () => {
        const reply = await ctx.register(sw, w, z, bytes, k);
        assert.ok((reply.status === 401 || reply.status === 403) && reply.headers['idempotent-replayed'] === undefined,
          `CN-05 ${label}: 401 or 403, never a replay (${replyNote(reply)})`);
      });
    }
  });
});

// ===========================================================================
// ICH-05: CN-06
// ===========================================================================

test('ICH-05 (CN-06): same key with another body → 422 idempotency_key_reused, nothing written; a new key presenting an open registration with another grossCents or reason → sealed write_conflict; an issued registration → sealed already_issued, the first amount standing', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich05');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'ich05 x');
    const regKey = randomUUID();
    const r = await registeredWithProof(ctx, s, w, x, 2500, 'ich05', { key: regKey });
    await writes([w.T], keyOf(s, regKey), NOTHING, 'CN-06 register, same key other bytes', async () => {
      assertRefusal(await ctx.register(s, w, x, regBody(w, r.attempt, 2501, r.reason), regKey), 422, 'idempotency_key_reused', 'CN-06 register other body');
    });
    for (const [label, over] of [['another grossCents', { grossCents: 2600 }], ['another reason', { reason: 'billing_error' }]]) {
      const k = randomUUID();
      await writes([w.T], keyOf(s, k), COMPLETION_ONLY, `CN-06 open, ${label}`, async () => {
        sealedOf(await ctx.issue(s, w, x, issueBody(w, r, over), k), 'write_conflict', `CN-06 open registration, ${label}`);
      });
    }
    const issueKey = randomUUID();
    r.creditNote = issuedOf(await ctx.issue(s, w, x, issueBody(w, r), issueKey), x, r, 'the bound issue');
    await writes([w.T], keyOf(s, issueKey), NOTHING, 'CN-06 issue, same key other bytes', async () => {
      assertRefusal(await ctx.issue(s, w, x, issueBody(w, r, { grossCents: 2600 }), issueKey), 422, 'idempotency_key_reused', 'CN-06 issue other body');
    });
    for (const [label, over] of [['the same bytes', {}], ['another grossCents', { grossCents: 2600 }]]) {
      const k = randomUUID();
      await writes([w.T], keyOf(s, k), COMPLETION_ONLY, `CN-06 issued, ${label}`, async () => {
        sealedOf(await ctx.issue(s, w, x, issueBody(w, r, over), k), 'already_issued', `CN-06 issued registration, ${label}`);
      });
    }
    const notes = notesOf(await ctx.list(s, w, x), x, 'CN-06 list');
    assert.deepEqual(notes.map((n) => [n.id, n.grossCents]), [[r.creditNote, 2500]], 'CN-06: one note, the first amount stands');
  });
});

// ===========================================================================
// ICH-06: CN-07a (HTTP part) and CN-11
// ===========================================================================

test('ICH-06 (CN-07a HTTP part, CN-11): release then a late issue → invalid_state; confirm then a late issue → already_issued; a sign-in lapsing between register and issue → 403 step_up_required on register, issue and withdrawal while proof, lookup and settlement answer; after reauthentication the issue and a settled registration → not_found; the owner releases and registers again; a second owner neither sees nor settles the first one\'s attempt', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich06');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'ich06 x');

    // (a) release, then a late issue.
    const r1 = await registeredWithProof(ctx, s, w, x, 1000, 'r1');
    settledOf(await ctx.settle(s, w, x, settleBody(w, r1.attempt, 1)), x, r1.attempt, 'released', 'r1 released');
    const k1 = randomUUID();
    await writes([w.T], keyOf(s, k1), COMPLETION_ONLY, 'CN-07a late issue after release',
      async () => sealedOf(await ctx.issue(s, w, x, issueBody(w, r1), k1), 'invalid_state', 'CN-07a late issue after release'));
    assertRefusal(await ctx.proof(s, w, x, r1.registration), 404, 'not_found', 'a released registration has no proof');

    // (b) confirm, then a late issue.
    const r2 = await credited(ctx, s, w, x, 1000, 'r2');
    settledOf(await ctx.settle(s, w, x, settleBody(w, r2.attempt, 2)), x, r2.attempt, 'confirmed', 'r2 confirmed');
    const k2 = randomUUID();
    await writes([w.T], keyOf(s, k2), COMPLETION_ONLY, 'CN-07a late issue after confirmation',
      async () => sealedOf(await ctx.issue(s, w, x, issueBody(w, r2), k2), 'already_issued', 'CN-07a late issue after confirmation'));

    // (c) a sign-in lapsing between register and issue.
    const r3 = await registeredWithProof(ctx, s, w, x, 500, 'r3');
    assert.equal(await ageSession(s, RECENT_AUTH_MAX_AGE_MS + 60_000), true, 'the sign-in is now older than 10 minutes');
    for (const [label, call] of [
      ['issue', () => ctx.issue(s, w, x, issueBody(w, r3))],
      ['register', () => ctx.register(s, w, x, regBody(w, randomUUID(), 100))],
      ['withdrawal', () => ctx.withdraw(s, w, x, r2.creditNote, withdrawBody(w))],
    ]) {
      await writes([w.T], [], NOTHING, `CN-11 stale ${label}`, async () => {
        const reply = await call();
        assertRefusal(reply, 403, 'step_up_required', `CN-11 stale ${label}`);
        assert.equal(ctx.reason(reply), 'recent_auth_required', `CN-11 stale ${label}: the chain's step-up`);
      });
    }
    // The recovery key needs no recent sign-in.
    assert.ok(proofOf(await ctx.proof(s, w, x, r3.registration), r3, x, 'CN-11 stale proof') === r3.proof, 'CN-11: the proof from a stale sign-in (value withheld)');
    const listed = await attemptsOf(ctx, s, w, 'CN-11 stale lookup');
    const byAttempt = Object.fromEntries(listed.map((a) => [a.attemptId, a]));
    assert.deepEqual([r1, r2, r3].map((r) => [byAttempt[r.attempt]?.state, byAttempt[r.attempt]?.version]), [['released', 3], ['confirmed', 3], ['open', 1]],
      'CN-11: the lookup from a stale sign-in shows released, confirmed and open');
    assert.ok(byAttempt[r2.attempt].settledAt !== null && byAttempt[r2.attempt].creditNote?.id === r2.creditNote, 'the confirmed attempt names its credit note');
    await writes([w.T], [], NOTHING, 'CN-11 stale settlement (unchanged)', async () => {
      settledOf(await ctx.settle(s, w, x, settleBody(w, r2.attempt, 2)), x, r2.attempt, 'confirmed', 'CN-11 settlement from a stale sign-in');
    });

    // After reauthentication (a new session digest): the issue and a settled registration are not_found.
    const sF = await signIn(ctx, o, { headers: { cookie: s.cookie, [REAUTHENTICATE_HEADER]: REAUTHENTICATE_VALUE } });
    assert.ok(sF.key !== s.key, 'the reauthentication rotated the session (values withheld)');
    for (const [label, r] of [['the lapsed open registration', r3], ['a confirmed registration', r2]]) {
      const k = randomUUID();
      await writes([w.T], keyOf(sF, k), LEASE_ONLY, `CN-07a after reauthentication, ${label}`,
        async () => assertRefusal(await ctx.issue(sF, w, x, issueBody(w, r), k), 404, 'not_found', `CN-07a after reauthentication, ${label}`));
    }
    assertRefusal(await ctx.proof(sF, w, x, r3.registration), 404, 'not_found', 'the proof from another session');
    // The owner releases the lapsed registration and registers again.
    settledOf(await ctx.settle(sF, w, x, settleBody(w, r3.attempt, 1)), x, r3.attempt, 'released', 'CN-07a the lapsed registration released');
    const r4 = await credited(ctx, sF, w, x, 500, 'r4 after the release');

    // A second owner of the store: the first owner's attempts are invisible and unsettleable.
    const o2 = await storeOwner(w, 'o2');
    const s2 = await signIn(ctx, o2);
    const theirs = await attemptsOf(ctx, s2, w, 'the second owner\'s lookup');
    assert.ok(!theirs.some((a) => [r1, r2, r3, r4].some((r) => r.attempt === a.attemptId)), 'CN-07a: no attempt of the first owner listed');
    const k5 = randomUUID();
    await writes([w.T], keyOf(s2, k5), LEASE_ONLY, 'CN-07a the second owner settles the first one\'s attempt',
      async () => assertRefusal(await ctx.settle(s2, w, x, settleBody(w, r4.attempt, 2), k5), 404, 'not_found', 'CN-07a another owner\'s settlement'));
    assertRefusal(await ctx.proof(s2, w, x, r4.registration), 404, 'not_found', 'CN-07a another owner\'s proof');
  });
});

// ===========================================================================
// ICH-07: CN-09
// ===========================================================================

test('ICH-07 (CN-09): REAL objects of another store and another tenant (a registration, an attempt and a credit note made by that store\'s own owner) presented against the caller\'s path store or invoice, and a missing invoice → the same 404 on every credit-note route, nothing written but the commands\' leases; the foreign objects stay untouched', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich07');
    const S2 = await newStore(w.T, 'ICH07 second store');
    const mgr2 = await actor('ich07-mgr2', [storeGrant(w.T, S2, 'manager')]);
    const w2s = { ...w, S: S2, settingsVersion: await configure(ctx, w.sb, w.T, S2, 'ich07b') };
    const otherStoreInvoice = await issueOne(ctx, await signIn(ctx, mgr2), w2s, 'ich07 other store');
    const v = await world(ctx, 'ich07t');
    const otherTenantInvoice = await issueOne(ctx, v.sm, v, 'ich07 other tenant');
    // Each foreign store's OWN owner makes a credit note (registration, attempt, credit note) and an open registration.
    const foreign = {};
    for (const [label, fw, inv] of [['store', w2s, otherStoreInvoice], ['tenant', v, otherTenantInvoice]]) {
      const fo = await storeOwner(fw, `foreign-${label}`, fw.S);
      const fs = await signIn(ctx, fo);
      const done = await credited(ctx, fs, fw, inv, 400, `ich07 foreign ${label} credit`);
      settledOf(await ctx.settle(fs, fw, inv, settleBody(fw, done.attempt, 2)), inv, done.attempt, 'confirmed', `ich07 foreign ${label} confirmed`);
      const open = await registeredWithProof(ctx, fs, fw, inv, 300, `ich07 foreign ${label} open`);
      foreign[label] = { inv, done, open, T: fw.T };
    }
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'ich07 own');
    const fake = { inv: randomUUID(), done: { creditNote: randomUUID(), attempt: randomUUID() },
      open: { registration: randomUUID(), attempt: randomUUID(), gross: 300, reason: 'pricing_error', proof: 'a'.repeat(64) } };
    // Every request uses the CALLER's path store (w.S) and the caller's body tenant.
    const routes = [
      ['register', true, (f, inv, k) => ctx.register(s, w, inv, regBody(w, f.open.attempt, 100), k)],
      ['issue', true, (f, inv, k) => ctx.issue(s, w, inv, issueBody(w, f.open), k)],
      ['settlement', true, (f, inv, k) => ctx.settle(s, w, inv, settleBody(w, f.open.attempt, 1), k)],
      ['withdrawal', true, (f, inv, k) => ctx.withdraw(s, w, inv, f.done.creditNote, withdrawBody(w), k)],
      ['proof', false, (f, inv) => ctx.proof(s, w, inv, f.open.registration)],
      ['list', false, (f, inv) => ctx.list(s, w, inv)],
    ];
    const image = async () => (await owner`select r.registration_id, r.credit_note_id, r.acknowledged_at::text as acked,
        (select count(*) from tmpos_invoice_credit_note.invoice_credit_note_withdrawal d where d.credit_note_id = r.credit_note_id)::int as withdrawn
      from tmpos_invoice_credit_note.invoice_credit_note_registration r where r.tenant_id = any(${[w.T, v.T]}::uuid[]) and r.store_id <> ${w.S}
      order by r.registration_id`).map((r) => ({ ...r }));
    const foreignBefore = await image();
    for (const [route, command, call] of routes) {
      const reasons = [];
      const cases = [
        ['another store\'s invoice with that store\'s real ids', foreign.store, foreign.store.inv, true],
        ['another tenant\'s invoice with that tenant\'s real ids', foreign.tenant, foreign.tenant.inv, true],
        ['a missing invoice', fake, fake.inv, true],
        ['the caller\'s own invoice with another store\'s real ids', foreign.store, x, false],
        ['the caller\'s own invoice with another tenant\'s real ids', foreign.tenant, x, false],
      ];
      for (const [label, f, inv, sameReason] of cases) {
        if (route === 'list' && inv === x) continue; // the caller's own list carries no foreign id
        if (route === 'register' && inv === x) continue; // a foreign attempt id on the caller's own invoice is a fresh attempt (CN-04)
        const k = randomUUID();
        await writes([w.T, v.T], command ? keyOf(s, k) : [], command ? LEASE_ONLY : NOTHING, `CN-09 ${route} ${label}`, async () => {
          const reply = await call(f, inv, k);
          assertRefusal(reply, 404, 'not_found', `CN-09 ${route}: ${label}`);
          if (sameReason) reasons.push(ctx.reason(reply));
        });
      }
      assert.equal(new Set(reasons).size, 1, `CN-09 ${route}: one log reason for the three invoices (${[...new Set(reasons)].join(', ')})`);
    }
    assert.deepEqual(await image(), foreignBefore, 'CN-09: the foreign registrations and credit notes are untouched');
  });
});

// ===========================================================================
// ICH-08: CN-12
// ===========================================================================

test('ICH-08 (CN-12): a missing or wrong x-tmpos-session-csrf on register, issue, settlement and withdrawal → 403 with the CSRF reason, for the owner and the manager alike (refused before authorization), nothing written, no lease', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich08');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    const x = await issueOne(ctx, w.sm, w, 'ich08 x');
    const r = await credited(ctx, s, w, x, 300, 'ich08 subject');
    for (const [who, sess, otherCsrf] of [['the owner', s, w.sm.csrf], ['the manager', w.sm, s.csrf]]) {
      for (const [mode, opts, reason] of [
        ['missing', { drop: [SESSION_CSRF_HEADER] }, 'csrf_session_missing'],
        ['wrong', { headers: { [SESSION_CSRF_HEADER]: otherCsrf } }, 'csrf_session_invalid'],
      ]) {
        for (const [route, call] of [
          ['register', (k) => ctx.register(sess, w, x, regBody(w, randomUUID(), 100), k, opts)],
          ['issue', (k) => ctx.issue(sess, w, x, issueBody(w, r), k, opts)],
          ['settlement', (k) => ctx.settle(sess, w, x, settleBody(w, r.attempt, 2), k, opts)],
          ['withdrawal', (k) => ctx.withdraw(sess, w, x, r.creditNote, withdrawBody(w), k, opts)],
        ]) {
          const k = randomUUID();
          await writes([w.T], keyOf(sess, k), NOTHING, `CN-12 ${who} ${mode} ${route}`, async () => {
            const reply = await call(k);
            assertRefusal(reply, 403, 'forbidden', `CN-12 ${who}, ${mode} CSRF, ${route}`);
            assert.equal(ctx.reason(reply), reason, `CN-12 ${who}, ${mode} CSRF, ${route}: the CSRF check, not the authorizer`);
          });
        }
      }
    }
  });
});

// ===========================================================================
// ICH-09: CN-15 and CN-24
// ===========================================================================

test('ICH-09 (CN-24, CN-15): after a credit the payments read carries creditedCents; a payment of 9,000 is sealed amount_exceeds_remaining and 8,888 records (E3); on a fully paid invoice a credit of 1 is sealed amount_exceeds_remaining with no note, number or audit row (E4)', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich09');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    // E3
    const p = await issueOne(ctx, w.sm, w, 'ich09 E3');
    await credited(ctx, s, w, p, 2000, 'E3 credit');
    assert.deepEqual(await amountsOf(ctx, w.sm, w, p, 'E3 after the credit'),
      { currency: 'USD', due: TOTAL, credited: 2000, applied: 0, remaining: 8888, status: 'no_payment_recorded' }, 'CN-24: creditedCents in the read');
    const pay = await paymentReady(ctx, w.sm, w, p, 'E3 payment');
    const over = randomUUID();
    await writes([w.T], keyOf(w.sm, over), COMPLETION_ONLY, 'CN-24 payment above the credits\' remaining',
      async () => sealedOf(await pay.record(9000, over), 'amount_exceeds_remaining', 'CN-24 a payment of 9,000'));
    const atCap = await pay.record(8888);
    assert.equal(atCap.status, 201, `CN-24 a payment of 8,888 at the cap records: ${replyNote(atCap)}`);
    assert.deepEqual(await amountsOf(ctx, w.sm, w, p, 'E3 at the cap'),
      { currency: 'USD', due: TOTAL, credited: 2000, applied: 8888, remaining: 0, status: 'settled_by_payment_and_credit' }, 'E3: 2,000 / 8,888 / 0');
    // E4
    const f = await issueOne(ctx, w.sm, w, 'ich09 E4');
    await paid(ctx, w.sm, w, f, TOTAL, 'E4 full payment');
    const r = await registeredWithProof(ctx, s, w, f, 1, 'E4 credit');
    const k = randomUUID();
    await writes([w.T], keyOf(s, k), COMPLETION_ONLY, 'CN-15 credit on a fully paid invoice',
      async () => sealedOf(await ctx.issue(s, w, f, issueBody(w, r), k), 'amount_exceeds_remaining', 'CN-15 credit 1 on a fully paid invoice'));
    const [open] = (await attemptsOf(ctx, s, w, 'E4 lookup')).filter((a) => a.attemptId === r.attempt);
    assert.deepEqual([open?.state, open?.version, open?.creditNote], ['open', 1, null], 'the refused issue leaves the registration open');
    const amounts = await amountsOf(ctx, s, w, f, 'E4 after');
    assert.deepEqual([amounts.credited, amounts.applied, amounts.remaining], [0, TOTAL, 0], 'E4: 0 / 10,888 / 0');
  });
});

// ===========================================================================
// ICH-10: CN-16 and CN-25
// ===========================================================================

test('ICH-10 (CN-25, CN-16): void with an active payment and credit → payments_recorded first; with a credit only → credit_notes_recorded; after the withdrawal the void succeeds (E9); then a second withdrawal, a late issue and a new registration → invalid_state (E8), and the read is all zero', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich10');
    const o = await storeOwner(w, 'o');
    const s = await signIn(ctx, o);
    // payments_recorded precedes credit_notes_recorded.
    const v1 = await issueOne(ctx, w.sm, w, 'ich10 v1');
    await credited(ctx, s, w, v1, 2000, 'v1 credit');
    await paid(ctx, w.sm, w, v1, 1000, 'v1 payment');
    const k1 = randomUUID();
    await writes([w.T], keyOf(w.sm, k1), COMPLETION_ONLY, 'CN-25 void with a payment and a credit',
      async () => sealedOf(await ctx.voidInvoice(w.sm, w, v1, voidBody(w), k1), 'payments_recorded', 'CN-25 payments_recorded first'));
    // E9
    const v2 = await issueOne(ctx, w.sm, w, 'ich10 v2');
    const ra = await credited(ctx, s, w, v2, 2000, 'v2 credit');
    settledOf(await ctx.settle(s, w, v2, settleBody(w, ra.attempt, 2)), v2, ra.attempt, 'confirmed', 'v2 credit confirmed');
    const rb = await registeredWithProof(ctx, s, w, v2, 500, 'v2 open before the void');
    const k2 = randomUUID();
    await writes([w.T], keyOf(w.sm, k2), COMPLETION_ONLY, 'CN-25 void with an active credit',
      async () => sealedOf(await ctx.voidInvoice(w.sm, w, v2, voidBody(w), k2), 'credit_notes_recorded', 'CN-25 credit_notes_recorded'));
    withdrawnOf(await ctx.withdraw(s, w, v2, ra.creditNote, withdrawBody(w, 'wrong_invoice')), v2, ra.creditNote, 'E9 withdraw');
    const k3 = randomUUID();
    const beforeVoid = await counts([w.T], keyOf(w.sm, k3));
    const voided = await ctx.voidInvoice(w.sm, w, v2, voidBody(w), k3);
    assert.equal(voided.status, 200, `E9: voided after the withdrawal: ${replyNote(voided)}`);
    const voidDelta = delta(await counts([w.T], keyOf(w.sm, k3)), beforeVoid);
    assert.deepEqual([voidDelta.V, voidDelta.CN, voidDelta.WD, voidDelta.K], [1, 0, 0, 1], 'E9: one void row, no credit-note change');
    // CN-16 on the voided invoice.
    const k4 = randomUUID();
    await writes([w.T], keyOf(s, k4), COMPLETION_ONLY, 'CN-16 withdrawal on a voided invoice',
      async () => sealedOf(await ctx.withdraw(s, w, v2, ra.creditNote, withdrawBody(w), k4), 'invalid_state', 'CN-16 withdrawal on a voided invoice'));
    const k5 = randomUUID();
    await writes([w.T], keyOf(s, k5), COMPLETION_ONLY, 'E8 late issue on a voided invoice',
      async () => sealedOf(await ctx.issue(s, w, v2, issueBody(w, rb), k5), 'invalid_state', 'E8 an open registration issued after the void'));
    settledOf(await ctx.settle(s, w, v2, settleBody(w, rb.attempt, 1)), v2, rb.attempt, 'released', 'the open registration released');
    const k6 = randomUUID();
    await writes([w.T], keyOf(s, k6), COMPLETION_ONLY, 'E8 register on a voided invoice',
      async () => sealedOf(await ctx.register(s, w, v2, regBody(w, randomUUID(), 500), k6), 'invalid_state', 'E8 register on a voided invoice'));
    const amounts = await amountsOf(ctx, s, w, v2, 'the voided read');
    assert.deepEqual([amounts.due, amounts.credited, amounts.applied, amounts.remaining], [0, 0, 0, 0], 'voided ⇒ all amounts 0');
  });
});

// ===========================================================================
// ICH-12: CN-04 over HTTP
// ===========================================================================

test('ICH-12 (CN-04 HTTP): a second store-scope owner registers the SAME attempt id on the same invoice; once the first owner\'s credit is issued the second owner\'s issue is sealed already_issued, also after that credit is withdrawn; the same attempt id on another invoice is independent', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'ich12');
    const o1 = await storeOwner(w, 'o1');
    const o2 = await storeOwner(w, 'o2');
    const s1 = await signIn(ctx, o1);
    const s2 = await signIn(ctx, o2);
    const x = await issueOne(ctx, w.sm, w, 'ich12 x');
    const y = await issueOne(ctx, w.sm, w, 'ich12 y');
    const attempt = randomUUID();
    const first = await credited(ctx, s1, w, x, 1000, 'ich12 first owner', { attempt });
    // The second owner's registration of the same attempt id on the same invoice is its own (each owner registers it once).
    const second = await registeredWithProof(ctx, s2, w, x, 1000, 'ich12 second owner', { attempt });
    assert.ok(second.registration !== first.registration, 'a distinct registration');
    sealedOf(await ctx.register(s2, w, x, regBody(w, attempt, 1000)), 'write_conflict', 'the second owner registers it only once (its slot is held)');
    const k1 = randomUUID();
    await writes([w.T], keyOf(s2, k1), COMPLETION_ONLY, 'CN-04 the second owner\'s issue',
      async () => sealedOf(await ctx.issue(s2, w, x, issueBody(w, second), k1), 'already_issued', 'CN-04 the attempt already carries a credit note'));
    withdrawnOf(await ctx.withdraw(s1, w, x, first.creditNote, withdrawBody(w)), x, first.creditNote, 'the first credit withdrawn');
    const k2 = randomUUID();
    await writes([w.T], keyOf(s2, k2), COMPLETION_ONLY, 'CN-04 after the withdrawal',
      async () => sealedOf(await ctx.issue(s2, w, x, issueBody(w, second), k2), 'already_issued', 'CN-04 still already_issued after the withdrawal'));
    // Another invoice: the same attempt id is independent.
    const other = await credited(ctx, s2, w, y, 700, 'ich12 the same attempt on another invoice', { attempt });
    const notes = notesOf(await ctx.list(s1, w, y), y, 'ich12 y list');
    assert.deepEqual(notes.map((n) => n.id), [other.creditNote], 'CN-04: the other invoice\'s credit issued');
    assert.deepEqual(notesOf(await ctx.list(s1, w, x), x, 'ich12 x list').map((n) => n.id), [first.creditNote], 'CN-04: x holds only the first credit');
  });
});

// ===========================================================================
// ICH-11: CN-34 HTTP seam — NOT ATTEMPTED
// ===========================================================================

test('ICH-11 (CN-34s1/CN-34s2 HTTP variant): the stale payment or void call at the 038 cutover seam over HTTP', {
  skip: 'NOT ATTEMPTED — not stageable over the real tenant entry; stays UNVERIFIED per doc 16 §8 CN-34s2 and the 038 cutover section',
}, () => {});
