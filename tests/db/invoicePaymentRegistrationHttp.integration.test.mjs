// =============================================================================
// M7B-PAYMENTS-P2 (PRQ-1) — payment registration over the REAL composed tenant entry (IRH)
// =============================================================================
//
// What this suite proves, over startTenantEntry and a DURABLE disposable PostgreSQL (fsync, full_page_writes and
// synchronous_commit on) with every migration in the directory applied (037 included), the owner-installed payment proof key
// in place, through the same trusted executor and assertDisposableTestDsn as the other tests/db suites:
//
//   IRH-00 the shipping table carries the four PRQ-1 routes beside the record (now v2);
//   IRH-01 the happy path — register (sealed 201, no proof), the proof GET (200 { registration, proof }, no-store, the id in the
//          query only, the proof in the body only; a second GET identical, nothing written), record v2 (sealed 201): EXACTLY one
//          payment row and ONE payment audit record (037's routine; the registration its second subject), the registration's
//          payment id set; the list shows it recorded; settle 2 confirms (one settle audit), its replay and a new key 'unchanged';
//   IRH-02 D-R3-A — the same session replays a register and a record key with the original bytes (the stored answers); a
//          REPLACEMENT session replaying either key gets 422 with nothing written; with a new key the old proof is 404 (recorded
//          row and open row), its proof GET 404; the list shows both states and settlement reconciles them;
//   IRH-03 a mismatched attempt id — 404 not_found, no payment, no audit record, the registration unchanged; a flipped proof and
//          another invoice the same 404 body and log reason; the matching record then applies;
//   IRH-04 pre-flush — the proof GET is the bounded retryable 503 (no proof, nothing written) while the flush has not reached
//          the position the routine sampled after reading the registration, and the retried GET succeeds once it has;
//   IRH-05 the key removed after startup — register, proof and record are the bounded 503 with no write; the list and the
//          settlement keep answering 200;
//   IRH-06 a key generation change — the old registration is unsendable over HTTP (proof 404, record 404), a new attempt is the
//          sealed write_conflict while it holds the slot, the list and settle 1 reconcile it, then a fresh registration records;
//          reinstalling the retired bytes is refused by the database;
//   IRH-07 a concurrent record and settlement released together from a lock barrier on the issued header — exactly one of the
//          two consistent outcomes, never a payment beside a withdrawal;
//   IRH-08 startup refused while no proof key is installed (tenant_payment_proof_key_absent), nothing bound;
//   IRH-10 self-prune — a session touch landing between the GET's session read and its proof transaction (in service, the
//          previous 2xx request's after-response refresh) leaves the session page prunable and the proof transaction's own read
//          prunes it (an xid-less Heap2 PRUNE): the first attempt answers not_durable and COMMITS, the flush passes the prune only after
//          that COMMIT, and ONE fresh attempt issues — 200 within the 3 s deadline, exactly two proof transactions;
//   IRH-11 the same with the target unflushed (an unrelated in-progress transaction's WAL after the prune): the existing bounded
//          retryable 503 within the deadline, at most two proof transactions, nothing written; an explicit retry then issues;
//   IRH-09 secrets — every captured log line, this suite's idempotency rows and audit rows, and every error body hold no proof,
//          proof key or session key.
//
// It never touches a managed or remote database. Run: npx tsx scripts/run-db-tests.mjs tests/db/invoicePaymentRegistrationHttp.integration.test.mjs

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
import { SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'irh-migrator', runtimeRef: 'irh-runtime' };
const LOCK_KEY = 529_539;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_irh_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';
const NS = 'tmpos_invoice_payment';
const RECORD_ACTION = 'store.invoice_payment.record';
const REGISTER_ACTION = 'store.invoice_payment.register';
const SETTLE_ACTION = 'store.invoice_payment.settle';
const ACTIONS = [RECORD_ACTION, REGISTER_ACTION, SETTLE_ACTION, 'store.invoice_payment.reverse'];
const SEND_TIMEOUT_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;
const WIRE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

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

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('IRH', { durable: true });
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
/** The owner on ONE connection that commits asynchronously: it writes WAL the flush has not reached (IRH-04). */
const lagger = testClient(TARGET, { max: 1, onnotice: () => {}, connection: { synchronous_commit: 'off' } });
/** The runtime login on ONE connection with synchronous_commit = off: a permitted direct caller of 037's register (IRH-04). */
let registrar = null;
const DROP_RUNTIME_LOGIN = `do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then
    perform pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = '${RUNTIME_LOGIN}';
    drop owned by ${RUNTIME_LOGIN};
    drop role ${RUNTIME_LOGIN};
  end if;
end $$;`;

const UIDS = [];
const TENANTS = [];
/** Every session key (a digest) this suite's sessions hold: never in a log line, an audit row, an idempotency row or a body. */
const KEYS = new Set();
const COOKIES = new Set();
/** Every proof any response served: the same scan. */
const PROOFS = new Set();
/** Every proof key's bytes this suite installed. */
const PROOF_KEYS = [];
/** Every log line any entry wrote, and every non-2xx body any request received. */
const LINES = [];
const ERROR_BODIES = [];
const USED_KEYS = [];
let rateLimitFingerprintBefore;
let issuerKeyBefore;
const RATE_KEY = randomBytes(32);
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

/** Everything this suite's tenants hold, in ONE owner transaction with the guards lifted only inside it. */
async function cleanAll() {
  if (TENANTS.length === 0) return;
  await owner.begin('isolation level read committed', async (sql) => {
    await withTriggersLifted(sql, [['public.audit_event', 'trg_audit_event_reject_mutation']], async () => {
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
    await withTriggersLifted(sql, [[`${NS}.invoice_payment_registration`, 'trg_invoice_payment_registration_guard']],
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
    await withTriggersLifted(sql, [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']], async () => {
      await sql`delete from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`;
    });
    await sql`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

const setWalWriterDelay = async (value) => {
  if (value === null) await owner`alter system reset wal_writer_delay`;
  else await owner.unsafe(`alter system set wal_writer_delay = '${value}'`);
  await owner`select pg_catalog.pg_reload_conf()`;
  await delay(300);
};

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(sealDbError('IRH teardown step', err)); } };
  try {
    await step(() => setWalWriterDelay(null));
    if (TENANTS.length > 0) {
      await step(() => owner`delete from tmpos_internal.outbox_event where event_type in ('invoice_draft.created', 'invoice_draft.updated')
        and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`);
    }
    await step(cleanAll);
    await step(dropProbes);
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
    if (registrar) await step(() => registrar.end({ timeout: 5 }));
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
        (select count(*) from tmpos_invoice_payment.invoice_payment_registration)::int as registrations,
        (select count(*) from tmpos_invoice_payment.invoice_payment)::int as payments,
        (select count(*) from tmpos_invoice_payment.payment_proof_key)::int as keys,
        (select count(*) from public.audit_event where action_id = any(${ACTIONS}::text[]) or subject_invoice_payment_id is not null
           or subject_invoice_payment_registration_id is not null)::int as payment_audits,
        (select count(*) from public.audit_event where tenant_id = any(${TENANTS}::uuid[]))::int as audits,
        (select max(version) from public.schema_migrations) as latest,
        pg_catalog.current_setting('wal_writer_delay') as wal_writer_delay`;
      assert.deepEqual({ ...state }, { registrations: 0, payments: 0, keys: 0, payment_audits: 0, audits: 0, latest: '037', wal_writer_delay: '200ms' },
        'no registration, payment, proof key or payment audit record anywhere, nothing of this suite left, the WAL writer reset');
    });
  } finally {
    await step(() => lagger.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IRH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (raw) {
    const err = sealDbError('IRH setup', raw);
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'IRH setup failed, and so did its teardown'); });
    throw err;
  }
}

/** The owner installs fresh proof key bytes under the next generation (an upsert: a rotation when one is installed). */
async function installProofKey(bytes = randomBytes(32)) {
  const [{ g }] = await owner`select (coalesce(pg_catalog.max(generation), 0) + 1)::text as g from tmpos_invoice_payment.payment_proof_key_generation`;
  await owner`insert into tmpos_invoice_payment.payment_proof_key (singleton, key, generation) values (true, ${bytes}, ${g}::bigint)
    on conflict (singleton) do update set key = excluded.key, generation = excluded.generation`
    .catch((e) => { throw new Error(`IRH proof key install failed: SQLSTATE ${safeCode(e)}`); });
  PROOF_KEYS.push(Buffer.from(bytes));
  return { key: Buffer.from(bytes), generation: g };
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
  assert.equal(latest, '037', 'migrations through 037 are applied');
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
  registrar = testClient(TARGET, { user: RUNTIME_LOGIN, max: 1, onnotice: () => {}, connection: { synchronous_commit: 'off' } });
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  rateLimitFingerprintBefore = rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(RATE_KEY)})`;
  });
  const issuer = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
  issuerKeyBefore = issuer === null ? null : Buffer.from(issuer);
  await installTestIssuerKey(owner, ISSUER_KEY).catch((e) => { throw new Error(`IRH issuer key install failed: SQLSTATE ${safeCode(e)}`); });
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_payment.payment_proof_key`)[0].n, 0, 'no proof key before this suite installs one');
  await installProofKey();
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
    type: 'service_account', project_id: 'irh-test-project', client_email: 'irh-test@irh-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
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
      res.on('end', () => {
        const reply = { status: res.statusCode ?? 0, headers: res.headers, body: text };
        if (reply.status >= 300) ERROR_BODIES.push(text);
        resolve(reply);
      });
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
/** A sealed 409: exactly { "error": word } — no requestId. */
function sealedOf(reply, word, label, { replayed = false } = {}) {
  assert.equal(reply.status, 409, `${label}: ${replyNote(reply)}`);
  assert.ok(reply.body === JSON.stringify({ error: word }), `${label}: the exact sealed body (${replyNote(reply)})`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newTenant(label) {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`irh-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(id);
  return id;
}
async function newStore(tenant, name) {
  return (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`${name} ${SUFFIX}`}, 'active') returning store_id`)[0].store_id;
}
async function newCustomer(tenant, label) {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IRH ${label} ${SUFFIX}`})`;
  return id;
}
async function actor(label, memberships) {
  const uid = `irh-${label}-${SUFFIX}`;
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
const RATE_8875 = Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: 8875 });
const sellerOf = (label) => ({
  legalName: `IRH ${label} legal ${SUFFIX}`, storeName: `IRH ${label} shop ${SUFFIX}`,
  postalAddress: `IRH ${label} street ${SUFFIX}\nIRH city`, taxRegistrationId: `IRH-${label}-${SUFFIX}`, tax: RATE_8875,
});

/** What this suite's tenants hold now: payments, registrations, the three audit kinds, completions and leases of `keys`, all audits. */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_payment.invoice_payment where tenant_id = any(${tenants}::uuid[]))::int as p,
    (select count(*) from tmpos_invoice_payment.invoice_payment_registration where tenant_id = any(${tenants}::uuid[]))::int as g,
    (select count(*) from public.audit_event where action_id = ${RECORD_ACTION} and tenant_id = any(${tenants}::uuid[]))::int as pa,
    (select count(*) from public.audit_event where action_id = ${REGISTER_ACTION} and tenant_id = any(${tenants}::uuid[]))::int as ga,
    (select count(*) from public.audit_event where action_id = ${SETTLE_ACTION} and tenant_id = any(${tenants}::uuid[]))::int as sa,
    (select count(*) from tmpos_invoice_payment.invoice_payment_registration where tenant_id = any(${tenants}::uuid[]) and acknowledged_at is not null)::int as st,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from public.audit_event)::int as aa,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le`;
  return { P: r.p, G: r.g, PA: r.pa, GA: r.ga, SA: r.sa, ST: r.st, K: r.k, AA: r.aa, OO: r.oo, LE: r.le };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const NOTHING = Object.freeze({ P: 0, G: 0, PA: 0, GA: 0, SA: 0, ST: 0, K: 0, AA: 0, OO: 0, LE: 0 });
/** A refusal that rolled back (a 404, a 503 or an unsealed 409): nothing but the attempt's lease. */
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
/** A read: nothing at all. */
const READ_ONLY = NOTHING;
/** The registration as stored (null: none). */
async function registrationOf(id) {
  const [row] = await owner`select registration_id, tenant_id, store_id, invoice_id, registered_by, attempt_id, key_generation::text as key_generation,
    payment_id, acknowledged_at is not null as settled from tmpos_invoice_payment.invoice_payment_registration where registration_id = ${id}`;
  return row === undefined ? null : { ...row };
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
  const log = { log: (l) => { lines.push(l); LINES.push(l); } };
  const result = await startTenantEntry({
    env: ENV, construction: { databaseClient, tokenVerifier: VERIFIER, listen: () => ({ port: 0, host: '127.0.0.1' }) },
    proc, exit: (code) => { codes.push(code); }, log,
  });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  const port = result.address.port;
  const from = randomLoopback();
  const unsafe = (s, path, body, key) => {
    USED_KEYS.push({ key, principal: s.principal });
    return send(port, 'POST', path, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf, 'idempotency-key': key,
    }, typeof body === 'string' ? body : JSON.stringify(body), { localAddress: from });
  };
  const drafts = (store) => `/api/v1/stores/${store}/invoice-drafts`;
  const invoices = (store) => `/api/v1/stores/${store}/invoices`;
  const ctx = {
    port, from, lines,
    read: (s, path) => send(port, 'GET', path, { host: TENANT_HOST, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }, undefined, { localAddress: from }),
    settings: (s, store) => ctx.read(s, `/api/v1/issuing-settings/${store}`),
    putSettings: (s, store, body, key = randomUUID()) => send(port, 'PUT', `/api/v1/issuing-settings/${store}`, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf, 'idempotency-key': key,
    }, JSON.stringify(body), { localAddress: from }).finally(() => USED_KEYS.push({ key, principal: s.principal })),
    save: (s, store, body, key = randomUUID()) => unsafe(s, drafts(store), body, key),
    issue: (s, store, id, body, key = randomUUID()) => unsafe(s, `${drafts(store)}/${id}/issue`, body, key),
    register: (s, w, invoice, body, key = randomUUID()) => unsafe(s, `${invoices(w.S)}/${invoice}/payment-registrations`, body, key),
    proof: (s, w, invoice, registration) => ctx.read(s, `${invoices(w.S)}/${invoice}/payment-registration-proof?registration=${registration}`),
    record: (s, w, invoice, body, key = randomUUID()) => unsafe(s, `${invoices(w.S)}/${invoice}/payments`, body, key),
    settle: (s, w, invoice, body, key = randomUUID()) => unsafe(s, `${invoices(w.S)}/${invoice}/payment-settlement`, body, key),
    attempts: (s, w, query = '') => ctx.read(s, `/api/v1/stores/${w.S}/payment-attempts${query}`),
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
    throw sealDbError('IRH case', err);
  } finally {
    if (codes.length === 0) {
      proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; codes.length === 0 && Date.now() < until;) await delay(10);
    }
    if (!failed) assert.equal(codes.length, 1, 'the entry exited within 5 s of SIGTERM');
  }
}
async function signIn(ctx, who) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${who.token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${replyNote(reply)}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const csrf = parseBody(reply, `login ${who.label}`).csrfToken;
  const value = cookie.slice(cookie.indexOf('=') + 1);
  const key = createHash('sha256').update(value).digest('base64url');
  KEYS.add(key);
  COOKIES.add(value);
  return { cookie, csrf, principal: who.principal, key };
}
/** One store of a fresh tenant with its owner, a manager and a second manager, a customer, and the store's issuing settings. */
async function world(ctx, label) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label.toUpperCase()} store`);
  const C = await newCustomer(T, label);
  const boss = await actor(`${label}-boss`, [tenantGrant(T, 'store_owner')]);
  const mgr = await actor(`${label}-mgr`, [storeGrant(T, S, 'manager')]);
  const mgr2 = await actor(`${label}-mgr2`, [storeGrant(T, S, 'manager')]);
  const w = { label, T, S, C, boss, mgr, mgr2 };
  w.sb = await signIn(ctx, boss);
  const read = await ctx.settings(w.sb, S);
  assert.equal(read.status, 200, `settings read: ${replyNote(read)}`);
  const version = parseBody(read, 'settings read').issuingSettings.version;
  const put = await ctx.putSettings(w.sb, S, { expectedTenant: T, expectedVersion: version, ...sellerOf(label) });
  assert.equal(put.status, 200, `settings PUT: ${replyNote(put)}`);
  w.settingsVersion = version + 1;
  return w;
}
/** A draft saved and issued at `w`'s store: the issued invoice id. Total 1,089 cents (1,000 + 8.875% tax). */
async function issueOne(ctx, s, w, label) {
  const saved = await ctx.save(s, w.S, { expectedTenant: w.T, customerId: w.C, currency: 'USD', lines: [{ description: `IRH ${label} ${SUFFIX}`, quantity: 1, unitPriceCents: 1000 }] });
  assert.equal(saved.status, 201, `${label}: the seed save: ${replyNote(saved)}`);
  const draft = parseBody(saved, `${label}: the seed save`).draft.id;
  const issued = await ctx.issue(s, w.S, draft, { expectedTenant: w.T, expectedVersion: 1, expectedSettingsVersion: w.settingsVersion, expectedCustomerVersion: 1 });
  assert.equal(issued.status, 201, `${label}: the issue: ${replyNote(issued)}`);
  const invoice = parseBody(issued, `${label}: the issue`).invoice.id;
  assert.match(invoice, UUID_RE);
  return invoice;
}
const TOTAL = 1089;

/** The register's sealed 201: exactly { registration: { id, invoiceId, attemptId, state: 'open' } } — never a proof; the id. */
function registeredOf(reply, invoice, attemptId, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${replyNote(reply)}`);
  const id = parseBody(reply, label)?.registration?.id;
  assert.ok(UUID_RE.test(String(id)), `${label}: the runtime's new registration id`);
  assert.ok(reply.body === JSON.stringify({ registration: { id, invoiceId: invoice, attemptId, state: 'open' } }), `${label}: the exact sealed body (${replyNote(reply)})`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
  return id;
}
/** The proof GET's 200: exactly { registration: { id, invoiceId, attemptId }, proof } — the proof. */
function proofOf(reply, registration, invoice, attemptId, label) {
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  const proof = parseBody(reply, label)?.proof;
  assert.ok(PROOF_RE.test(String(proof)), `${label}: 64 lowercase hex digits (value withheld)`);
  assert.ok(reply.body === JSON.stringify({ registration: { id: registration, invoiceId: invoice, attemptId }, proof }), `${label}: the exact body (${replyNote(reply)})`);
  assertBaseline(reply, label);
  PROOFS.add(proof);
  return proof;
}
/** The record's sealed 201; the payment id. */
function recordedOf(reply, invoice, attemptId, amountCents, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${replyNote(reply)}`);
  const id = parseBody(reply, label)?.payment?.id;
  assert.ok(UUID_RE.test(String(id)), label);
  assert.ok(reply.body === JSON.stringify({ payment: { id, invoiceId: invoice, attemptId, amountCents, method: 'cash' } }), `${label}: the exact sealed body (${replyNote(reply)})`);
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
/** The caller's attempts at `w`'s store: { invoiceId -> [attempt] } of the 200's exact shape. */
async function attemptsOf(ctx, s, w, label) {
  const reply = await ctx.attempts(s, w);
  assert.equal(reply.status, 200, `${label}: ${replyNote(reply)}`);
  assertBaseline(reply, label);
  const body = parseBody(reply, label);
  assert.deepEqual(Object.keys(body), ['attempts', 'nextCursor'], label);
  for (const a of body.attempts) {
    assert.deepEqual(Object.keys(a), ['invoiceId', 'invoiceNumber', 'attemptId', 'state', 'version', 'registeredAt', 'settledAt', 'payment'], `${label}: an attempt's keys`);
    assert.match(a.registeredAt, WIRE_TIME_RE, label);
  }
  assert.ok(![...PROOFS].some((p) => reply.body.includes(p)), `${label}: never a proof`);
  return body.attempts;
}
const recordBody = (w, registrationId, attemptId, proof, amountCents = TOTAL) => ({
  expectedTenant: w.T, registrationId, attemptId, amountCents, method: 'cash', registrationProof: proof,
});
/** register → proof for `s` at `invoice`: { registration, attempt, proof }. */
async function registeredWithProof(ctx, s, w, invoice, label, attempt = randomUUID()) {
  const registration = registeredOf(await ctx.register(s, w, invoice, { expectedTenant: w.T, attemptId: attempt }), invoice, attempt, `${label}: register`);
  const proof = proofOf(await ctx.proof(s, w, invoice, registration), registration, invoice, attempt, `${label}: proof`);
  return { registration, attempt, proof };
}

// ===========================================================================
// IRH-00: the shipping table
// ===========================================================================

test('IRH-00: the tenant entry ships exactly 40 routes — the record (v2) and the four PRQ-1 routes with their body and idempotency', () => {
  assert.equal(TENANT_SHIPPING_ROUTES.length, 40);
  const served = TENANT_SHIPPING_ROUTES.map((r) => `${r.method} ${r.path} ${r.body} ${r.idempotency}`);
  for (const want of [
    'POST /api/v1/stores/{storeId}/invoices/{id}/payments json required',
    'POST /api/v1/stores/{storeId}/invoices/{id}/payment-registrations json required',
    'GET /api/v1/stores/{storeId}/invoices/{id}/payment-registration-proof none none',
    'POST /api/v1/stores/{storeId}/invoices/{id}/payment-settlement json required',
    'GET /api/v1/stores/{storeId}/payment-attempts none none',
  ]) assert.ok(served.includes(want), want);
});

// ===========================================================================
// IRH-01: the happy path
// ===========================================================================

test('IRH-01: register → proof GET → record v2 → settle — the sealed answers carry no proof; EXACTLY one payment row and ONE payment audit record (037\'s routine, the registration its second subject); the registration recorded then confirmed; a lost proof answer re-fetched identical with nothing written', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh01');
    const s = await signIn(ctx, w.mgr);
    const invoice = await issueOne(ctx, s, w, 'irh01');
    const attempt = randomUUID();
    const regKey = randomUUID();
    const before = await counts([w.T], [{ key: regKey, principal: s.principal }]);
    const registration = registeredOf(await ctx.register(s, w, invoice, { expectedTenant: w.T, attemptId: attempt }, regKey), invoice, attempt, 'register');
    assert.deepEqual(delta(await counts([w.T], [{ key: regKey, principal: s.principal }]), before), { ...NOTHING, G: 1, GA: 1, AA: 1, K: 1 },
      'one open registration, its ONE audit record and the completion');
    const stored = await registrationOf(registration);
    assert.deepEqual([stored.invoice_id, stored.registered_by, stored.attempt_id, stored.payment_id, stored.settled], [invoice, w.mgr.id, attempt, null, false]);

    const beforeProof = await counts([w.T]);
    const first = await ctx.proof(s, w, invoice, registration);
    const proof = proofOf(first, registration, invoice, attempt, 'the proof');
    assert.equal(first.headers['referrer-policy'], 'no-referrer', 'the registration id in the URL is never sent on');
    const again = await ctx.proof(s, w, invoice, registration);
    assert.ok(proofOf(again, registration, invoice, attempt, 'the proof again') === proof, 'B18: the lost answer re-fetched, identical (values withheld)');
    assert.deepEqual(delta(await counts([w.T]), beforeProof), READ_ONLY, 'the proof GET writes nothing');
    assert.ok(!ctx.lines.some((l) => l.includes(registration)), 'the request log never carries the query string');

    const recKey = randomUUID();
    const beforeRecord = await counts([w.T], [{ key: recKey, principal: s.principal }]);
    const payment = recordedOf(await ctx.record(s, w, invoice, recordBody(w, registration, attempt, proof), recKey), invoice, attempt, TOTAL, 'record');
    assert.deepEqual(delta(await counts([w.T], [{ key: recKey, principal: s.principal }]), beforeRecord), { ...NOTHING, P: 1, PA: 1, AA: 1, K: 1 },
      'EXACTLY one payment, ONE payment audit record, one completion');
    const audits = (await owner`select action_id, actor_internal_user_id, subject_invoice_payment_id, subject_invoice_payment_registration_id
      from public.audit_event where tenant_id = ${w.T} and action_id = ${RECORD_ACTION}`).map((r) => ({ ...r }));
    assert.deepEqual(audits, [{ action_id: RECORD_ACTION, actor_internal_user_id: w.mgr.id, subject_invoice_payment_id: payment,
      subject_invoice_payment_registration_id: registration }]);
    const [pay] = await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where invoice_id = ${invoice}`;
    assert.equal(pay.n, 1, 'one payment row on the invoice');
    assert.equal((await registrationOf(registration)).payment_id, payment, 'the registration names its payment');
    assertRefusal(await ctx.proof(s, w, invoice, registration), 404, 'not_found', 'a recorded registration has no proof');

    const [listed] = (await attemptsOf(ctx, s, w, 'the list')).filter((a) => a.attemptId === attempt);
    assert.deepEqual([listed.invoiceId, listed.state, listed.version, listed.settledAt, listed.payment.id, listed.payment.amountCents],
      [invoice, 'recorded', 2, null, payment, TOTAL]);

    const settleKey = randomUUID();
    const beforeSettle = await counts([w.T]);
    settledOf(await ctx.settle(s, w, invoice, { expectedTenant: w.T, attemptId: attempt, expectedVersion: 2 }, settleKey), invoice, attempt, 'confirmed', 'settle 2');
    assert.deepEqual(delta(await counts([w.T]), beforeSettle), { ...NOTHING, SA: 1, ST: 1, AA: 1 }, 'the slot released with ONE settle audit record');
    settledOf(await ctx.settle(s, w, invoice, { expectedTenant: w.T, attemptId: attempt, expectedVersion: 2 }, settleKey), invoice, attempt, 'confirmed', 'its replay', { replayed: true });
    const beforeRepeat = await counts([w.T]);
    settledOf(await ctx.settle(s, w, invoice, { expectedTenant: w.T, attemptId: attempt, expectedVersion: 2 }), invoice, attempt, 'confirmed', 'a new key: unchanged');
    assert.deepEqual(delta(await counts([w.T]), beforeRepeat), NOTHING, 'unchanged writes no audit record');
    sealedOf(await ctx.settle(s, w, invoice, { expectedTenant: w.T, attemptId: attempt, expectedVersion: 1 }), 'write_conflict', 'settle 1 of a confirmed one');
    const [done] = (await attemptsOf(ctx, s, w, 'the list after')).filter((a) => a.attemptId === attempt);
    assert.deepEqual([done.state, done.version], ['confirmed', 3]);
    assert.match(done.settledAt, WIRE_TIME_RE);
    assert.deepEqual(delta(await counts([w.T]), beforeRepeat), NOTHING, 'the conflict and the reads wrote nothing');
  });
});

// ===========================================================================
// IRH-02: D-R3-A
// ===========================================================================

test('IRH-02 (D-R3-A): the same session replays a register and a record key with the original bytes; a REPLACEMENT session replaying either is the 422 with nothing written; its new key with the old proof is 404 (recorded and open), its proof GET 404; the list and settlement reconcile both', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh02');
    const s1 = await signIn(ctx, w.mgr);
    const [x, y] = [await issueOne(ctx, s1, w, 'irh02 x'), await issueOne(ctx, s1, w, 'irh02 y')];
    const attempt = randomUUID();
    const regKey = randomUUID();
    const regBytes = JSON.stringify({ expectedTenant: w.T, attemptId: attempt });
    const first = await ctx.register(s1, w, x, regBytes, regKey);
    const registration = registeredOf(first, x, attempt, 'register');
    const replayed = await ctx.register(s1, w, x, regBytes, regKey);
    assert.ok(replayed.status === 201 && replayed.body === first.body && replayed.headers['idempotent-replayed'] === 'true',
      `the same session: the stored answer (${replyNote(replayed)}, replayed=${replayed.headers['idempotent-replayed'] === 'true'})`);
    const proof = proofOf(await ctx.proof(s1, w, x, registration), registration, x, attempt, 'proof');
    const recKey = randomUUID();
    const recBytes = JSON.stringify(recordBody(w, registration, attempt, proof));
    const recorded = await ctx.record(s1, w, x, recBytes, recKey);
    const payment = recordedOf(recorded, x, attempt, TOTAL, 'record');
    const recReplay = await ctx.record(s1, w, x, recBytes, recKey);
    assert.ok(recReplay.status === 201 && recReplay.body === recorded.body && recReplay.headers['idempotent-replayed'] === 'true',
      `the same session: the original key and bytes replay the stored answer (${replyNote(recReplay)}, replayed=${recReplay.headers['idempotent-replayed'] === 'true'})`);
    // An open registration of the same staff member on the other invoice, from the first session.
    const open = await registeredWithProof(ctx, s1, w, y, 'open on y');

    // A replacement session of the same staff member (a re-authentication).
    const s2 = await signIn(ctx, w.mgr);
    assert.ok(s2.key !== s1.key, 'a new session key (values withheld)');
    const before = await counts([w.T]);
    for (const [label, reply] of [['the register key', await ctx.register(s2, w, x, regBytes, regKey)], ['the record key', await ctx.record(s2, w, x, recBytes, recKey)]]) {
      assertRefusal(reply, 422, 'idempotency_key_reused', `the replacement session replaying ${label}`);
      assert.ok(!reply.body.includes(registration) && !reply.body.includes(payment), `${label}: no cached body`);
    }
    for (const [label, reply] of [
      ['a new key with the recorded registration\'s proof', await ctx.record(s2, w, x, recBytes)],
      ['a new key with the open registration\'s proof', await ctx.record(s2, w, y, recordBody(w, open.registration, open.attempt, open.proof))],
      ['the proof GET of the open registration', await ctx.proof(s2, w, y, open.registration)],
    ]) {
      assertRefusal(reply, 404, 'not_found', `the replacement session: ${label}`);
    }
    const after = await counts([w.T]);
    assert.deepEqual(delta(after, before), { ...NOTHING, LE: 2 }, 'nothing written but the two new keys\' leases (a 422 reserves none)');
    // The list shows both states; settlement reconciles them from the replacement session.
    const listed = await attemptsOf(ctx, s2, w, 'the list');
    const byInvoice = Object.fromEntries(listed.map((a) => [a.invoiceId, a]));
    assert.deepEqual([byInvoice[x].state, byInvoice[x].version, byInvoice[x].payment.id], ['recorded', 2, payment]);
    assert.deepEqual([byInvoice[y].state, byInvoice[y].version, byInvoice[y].payment], ['open', 1, null]);
    sealedOf(await ctx.register(s2, w, y, { expectedTenant: w.T, attemptId: randomUUID() }), 'write_conflict', 'a new attempt while the slot is held');
    settledOf(await ctx.settle(s2, w, x, { expectedTenant: w.T, attemptId: attempt, expectedVersion: 2 }), x, attempt, 'confirmed', 'confirm x');
    settledOf(await ctx.settle(s2, w, y, { expectedTenant: w.T, attemptId: open.attempt, expectedVersion: 1 }), y, open.attempt, 'withdrawn', 'withdraw y');
    assert.equal((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where tenant_id = ${w.T}`)[0].n, 1, 'one payment in all');
  });
});

// ===========================================================================
// IRH-03: a mismatched attempt
// ===========================================================================

test('IRH-03: a record naming another attempt id is the uniform 404 — no payment, no audit record, the registration unchanged; a flipped proof and another invoice the same body and log reason; the matching record then applies', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh03');
    const s = await signIn(ctx, w.mgr);
    const [x, y] = [await issueOne(ctx, s, w, 'irh03 x'), await issueOne(ctx, s, w, 'irh03 y')];
    const r = await registeredWithProof(ctx, s, w, x, 'irh03');
    const row = await registrationOf(r.registration);
    const flipped = `${r.proof[0] === 'a' ? 'b' : 'a'}${r.proof.slice(1)}`;
    const reasons = new Set();
    for (const [label, invoice, body] of [
      ['another attempt id', x, recordBody(w, r.registration, randomUUID(), r.proof)],
      ['a flipped proof', x, recordBody(w, r.registration, r.attempt, flipped)],
      ['another invoice', y, recordBody(w, r.registration, r.attempt, r.proof)],
      ['another registration id', x, recordBody(w, randomUUID(), r.attempt, r.proof)],
    ]) {
      const key = randomUUID();
      const before = await counts([w.T], [{ key, principal: s.principal }]);
      const reply = await ctx.record(s, w, invoice, body, key);
      assertRefusal(reply, 404, 'not_found', label);
      reasons.add(ctx.reason(reply));
      assert.deepEqual(delta(await counts([w.T], [{ key, principal: s.principal }]), before), LEASE_ONLY, `${label}: no payment, no audit record, no completion`);
      assert.deepEqual(await registrationOf(r.registration), row, `${label}: the registration unchanged`);
    }
    assert.equal(reasons.size, 1, `one log reason for every mismatch: ${[...reasons]}`);
    recordedOf(await ctx.record(s, w, x, recordBody(w, r.registration, r.attempt, r.proof)), x, r.attempt, TOTAL, 'the matching record');
    settledOf(await ctx.settle(s, w, x, { expectedTenant: w.T, attemptId: r.attempt, expectedVersion: 2 }), x, r.attempt, 'confirmed', 'settle');
  });
});

// ===========================================================================
// IRH-04: pre-flush
// ===========================================================================

test('IRH-04: PRE-FLUSH — a registration committed with synchronous_commit=off on a runtime-login connection, the WAL writer slowed and unflushed WAL ahead of the flush: the proof GET is the bounded retryable 503 (no proof, nothing written, no routine text); once a durable commit flushes past it the retried GET serves the proof', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh04');
    const s = await signIn(ctx, w.mgr);
    const invoice = await issueOne(ctx, s, w, 'irh04');
    assert.equal((await registrar`select pg_catalog.current_setting('synchronous_commit') as v`)[0].v, 'off');
    assert.equal((await lagger`select pg_catalog.current_setting('synchronous_commit') as v`)[0].v, 'off');
    await setWalWriterDelay('10s');
    let lagging = false;
    let lag = Promise.resolve();
    let caught = null;
    try {
      for (let i = 0; i < 20 && caught === null; i += 1) {
        const registration = randomUUID();
        const attempt = randomUUID();
        const [reg] = await registrar`select o_outcome from tmpos_invoice_payment.m7b_invoice_payment_register(${s.key}::text, ${w.S}::uuid, ${invoice}::uuid,
          ${w.T}::uuid, ${registration}::uuid, ${attempt}::uuid, ${randomUUID()}::uuid)`.catch((e) => { throw sealDbError('IRH-04 the direct register', e); });
        assert.equal(reg.o_outcome, 'applied', 'registered directly, committed asynchronously');
        const row = await registrationOf(registration);
        // Unflushed WAL keeps arriving ahead of the flush position while the GET runs (the GET's own rate-limit commit is
        // synchronous, so the registration itself is flushed before the routine reads it; the routine's bar is the insert
        // position it samples AFTER that read).
        lagging = true;
        lag = (async () => {
          while (lagging) {
            await lagger`select pg_catalog.pg_logical_emit_message(false, 'irh-lag', ${'x'.repeat(256)})`;
            await delay(2);
          }
        })();
        const before = await counts([w.T]);
        const t0 = Date.now();
        const reply = await ctx.proof(s, w, invoice, registration);
        const waited = Date.now() - t0;
        lagging = false;
        await lag;
        if (reply.status === 503) {
          assertRefusal(reply, 503, 'service_unavailable', 'not yet durable');
          assert.equal(ctx.reason(reply), 'invoice_payment_registration_proof_unavailable', 'the port\'s bounded outage reason, never the routine text');
          assert.ok(waited >= 1000 && waited < 5000, `bounded: ${waited} ms`);
          assert.deepEqual(delta(await counts([w.T]), before), READ_ONLY, 'nothing written');
          assert.deepEqual(await registrationOf(registration), row, 'the registration unchanged');
          caught = { registration, attempt };
        } else {
          // The flush caught up (the WAL writer or another commit ran): withdraw it and try again.
          proofOf(reply, registration, invoice, attempt, `try ${i}: issued once durable`);
          settledOf(await ctx.settle(s, w, invoice, { expectedTenant: w.T, attemptId: attempt, expectedVersion: 1 }), invoice, attempt, 'withdrawn', `try ${i}: withdrawn`);
        }
      }
      assert.ok(caught !== null, 'a proof GET was refused while the flush lagged the sampled position');
      // A durable commit (its commit record is flushed synchronously) flushes past everything before it.
      await owner`select pg_catalog.pg_logical_emit_message(true, 'irh-flush', 'x')`;
      const proof = proofOf(await ctx.proof(s, w, invoice, caught.registration), caught.registration, invoice, caught.attempt, 'the retried GET');
      recordedOf(await ctx.record(s, w, invoice, recordBody(w, caught.registration, caught.attempt, proof)), invoice, caught.attempt, TOTAL, 'recorded with it');
      settledOf(await ctx.settle(s, w, invoice, { expectedTenant: w.T, attemptId: caught.attempt, expectedVersion: 2 }), invoice, caught.attempt, 'confirmed', 'confirmed');
    } finally {
      lagging = false;
      await lag.catch(() => {});
      await setWalWriterDelay(null);
    }
  });
});

// ===========================================================================
// IRH-05: the key removed after startup
// ===========================================================================

/** The owner removes the installed proof key (out of band, as the owner would). */
const removeProofKey = () => owner`delete from tmpos_invoice_payment.payment_proof_key where singleton`;

test('IRH-05: the proof key removed after startup — register, proof and record are the bounded 503 with no write; the list and the settlement keep answering 200; a newly installed key serves fresh registrations', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh05');
    const s = await signIn(ctx, w.mgr);
    const [x, y] = [await issueOne(ctx, s, w, 'irh05 x'), await issueOne(ctx, s, w, 'irh05 y')];
    const r = await registeredWithProof(ctx, s, w, x, 'before the removal');
    await removeProofKey();
    try {
      for (const [label, call, expected] of [
        ['register', (key) => ctx.register(s, w, y, { expectedTenant: w.T, attemptId: randomUUID() }, key), LEASE_ONLY],
        ['proof', () => ctx.proof(s, w, x, r.registration), READ_ONLY],
        ['record', (key) => ctx.record(s, w, x, recordBody(w, r.registration, r.attempt, r.proof), key), LEASE_ONLY],
      ]) {
        const key = randomUUID();
        const before = await counts([w.T], [{ key, principal: s.principal }]);
        const reply = await call(key);
        assertRefusal(reply, 503, 'service_unavailable', `${label} without a key`);
        assert.deepEqual(delta(await counts([w.T], [{ key, principal: s.principal }]), before), expected, `${label}: nothing written`);
      }
      const [listed] = (await attemptsOf(ctx, s, w, 'the list without a key')).filter((a) => a.attemptId === r.attempt);
      assert.deepEqual([listed.state, listed.version], ['open', 1], 'the list still answers');
      settledOf(await ctx.settle(s, w, x, { expectedTenant: w.T, attemptId: r.attempt, expectedVersion: 1 }), x, r.attempt, 'withdrawn', 'the settlement still answers');
    } finally {
      await installProofKey();
    }
    const fresh = await registeredWithProof(ctx, s, w, y, 'after a new key');
    recordedOf(await ctx.record(s, w, y, recordBody(w, fresh.registration, fresh.attempt, fresh.proof)), y, fresh.attempt, TOTAL, 'recorded under the new key');
    settledOf(await ctx.settle(s, w, y, { expectedTenant: w.T, attemptId: fresh.attempt, expectedVersion: 2 }), y, fresh.attempt, 'confirmed', 'confirmed');
  });
});

// ===========================================================================
// IRH-06: a key generation change
// ===========================================================================

test('IRH-06: a key generation change — the old registration is unsendable over HTTP (proof 404, record 404, nothing written), a new attempt the sealed write_conflict while it holds the slot; the list and settle 1 reconcile it; a fresh registration then records; reinstalling the retired bytes is refused by the database', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh06');
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'irh06');
    const old = await registeredWithProof(ctx, s, w, x, 'under the old generation');
    const retired = PROOF_KEYS[PROOF_KEYS.length - 1];
    const rotated = await installProofKey();
    assert.notEqual((await registrationOf(old.registration)).key_generation, rotated.generation, 'the registration names the retired generation');
    const before = await counts([w.T]);
    assertRefusal(await ctx.proof(s, w, x, old.registration), 404, 'not_found', 'the old registration\'s proof GET');
    assertRefusal(await ctx.record(s, w, x, recordBody(w, old.registration, old.attempt, old.proof)), 404, 'not_found', 'the old proof');
    sealedOf(await ctx.register(s, w, x, { expectedTenant: w.T, attemptId: randomUUID() }), 'write_conflict', 'a new attempt while the old one holds the slot');
    // The record's 404 rolled back (its lease waits); the register's sealed conflict committed only its completion.
    const after = await counts([w.T]);
    assert.deepEqual([after.P - before.P, after.G - before.G, after.PA - before.PA, after.GA - before.GA, after.SA - before.SA, after.AA - before.AA],
      [0, 0, 0, 0, 0, 0], 'no payment, no registration, no audit record');
    const [listed] = (await attemptsOf(ctx, s, w, 'the list')).filter((a) => a.attemptId === old.attempt);
    assert.deepEqual([listed.state, listed.version], ['open', 1], 'the lookup shows it open');
    settledOf(await ctx.settle(s, w, x, { expectedTenant: w.T, attemptId: old.attempt, expectedVersion: 1 }), x, old.attempt, 'withdrawn', 'deliberately withdrawn');
    const fresh = await registeredWithProof(ctx, s, w, x, 'under the new generation');
    assert.equal((await registrationOf(fresh.registration)).key_generation, rotated.generation);
    recordedOf(await ctx.record(s, w, x, recordBody(w, fresh.registration, fresh.attempt, fresh.proof)), x, fresh.attempt, TOTAL, 'recorded');
    settledOf(await ctx.settle(s, w, x, { expectedTenant: w.T, attemptId: fresh.attempt, expectedVersion: 2 }), x, fresh.attempt, 'confirmed', 'confirmed');
    assert.equal((await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where invoice_id = ${x}`)[0].n, 1, 'exactly one payment');
    const reinstall = await owner`update tmpos_invoice_payment.payment_proof_key set key = ${retired}, generation = generation + 7 where singleton`
      .then(() => ({ rejected: false }), (err) => ({ rejected: true, coded: typeof err?.code === 'string', code: safeCode(err) }));
    assert.ok(reinstall.rejected && reinstall.coded,
      `the retired bytes are never accepted again: ${reinstall.rejected ? `refused with SQLSTATE ${reinstall.code}` : 'accepted'} (error text withheld)`);
    assertRefusal(await ctx.proof(s, w, x, old.registration), 404, 'not_found', 'and the old registration stays unsendable');
  });
});

// ===========================================================================
// IRH-07: a concurrent record and settlement
// ===========================================================================

test('IRH-07: a record and a settle 1 of the same registration, released together from a lock barrier on the issued header — exactly one of: (201, sealed write_conflict, one payment) or (sealed invalid_state, 200 withdrawn, no payment); then reconciled', async () => {
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh07');
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'irh07');
    const r = await registeredWithProof(ctx, s, w, x, 'irh07');
    let record;
    let settle;
    await owner.begin(async (tx) => {
      await tx`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${x} for update`;
      record = ctx.record(s, w, x, recordBody(w, r.registration, r.attempt, r.proof));
      settle = ctx.settle(s, w, x, { expectedTenant: w.T, attemptId: r.attempt, expectedVersion: 1 });
      let waiting = 0;
      for (const until = Date.now() + 10_000; waiting < 2 && Date.now() < until;) {
        await delay(20);
        waiting = (await owner`select count(*)::int as n from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`)[0].n;
      }
      assert.equal(waiting, 2, 'both commands are seen waiting on the issued header');
    });
    const [rec, set] = [await record, await settle];
    const payments = (await owner`select count(*)::int as n from tmpos_invoice_payment.invoice_payment where invoice_id = ${x}`)[0].n;
    if (rec.status === 201) {
      recordedOf(rec, x, r.attempt, TOTAL, 'the record won');
      sealedOf(set, 'write_conflict', 'the settlement saw it recorded');
      assert.equal(payments, 1);
      settledOf(await ctx.settle(s, w, x, { expectedTenant: w.T, attemptId: r.attempt, expectedVersion: 2 }), x, r.attempt, 'confirmed', 'reconciled: confirmed');
    } else {
      sealedOf(rec, 'invalid_state', 'the record saw it withdrawn');
      settledOf(set, x, r.attempt, 'withdrawn', 'the settlement won');
      assert.equal(payments, 0, 'never a payment beside a withdrawal');
    }
    const [listed] = (await attemptsOf(ctx, s, w, 'the list')).filter((a) => a.attemptId === r.attempt);
    assert.deepEqual([listed.state, listed.payment === null], payments === 1 ? ['confirmed', false] : ['withdrawn', true]);
  });
});

// ===========================================================================
// IRH-08: startup without a key
// ===========================================================================

test('IRH-08: startup is refused while no payment proof key is installed (tenant_payment_proof_key_absent) — nothing bound, exit 1', async () => {
  await removeProofKey();
  try {
    const lines = [];
    const codes = [];
    let binds = 0;
    const result = await startTenantEntry({
      env: ENV, construction: { databaseClient, tokenVerifier: VERIFIER, listen: () => { binds += 1; return { port: 0, host: '127.0.0.1' }; } },
      proc: new EventEmitter(), exit: (code) => { codes.push(code); }, log: { log: (l) => { lines.push(l); LINES.push(l); } },
    });
    assert.deepEqual([result.outcome, result.failure, result.address], ['refused', 'tenant_payment_proof_key_absent', null], JSON.stringify(result));
    assert.deepEqual([codes, binds], [[1], 0]);
    assert.ok(lines.some((l) => l.includes('"startup_refused"') && l.includes('tenant_payment_proof_key_absent')), 'the refusal is logged by category');
  } finally {
    await installProofKey();
  }
});

// ===========================================================================
// IRH-10, IRH-11: the proof transaction's own HOT prune of the session page
// ===========================================================================
// Every 2xx request's after-response refresh HOT-updates the session row; once its heap page is short of free space, the next READ of
// that page prunes it (heap_page_prune_opt) and writes an xid-less Heap2 PRUNE record. When that read is the proof
// transaction's own (034's store reader), the record sits below the insert position the routine samples, and PostgreSQL
// requests its flush only when that transaction COMMITS (an xid-less commit sets the async flush position; a rollback does
// not). So the first attempt answers not_durable (and commits), and one fresh attempt within the 3 s deadline issues.

const PROBE = 'irh_probe';
let probesInstalled = false;
/** pageinspect, pg_walinspect and a scratch table in their own schema (outside public and tmpos_*), installed once and dropped by
 * the teardown; then one VACUUM, so that no catalog page a fresh backend reads during a case is still prunable. */
async function installProbes() {
  if (probesInstalled) return;
  probesInstalled = true;
  await owner.unsafe(`create schema ${PROBE}`);
  await owner.unsafe(`create extension pageinspect with schema ${PROBE}`);
  await owner.unsafe(`create extension pg_walinspect with schema ${PROBE}`);
  await owner.unsafe(`create table ${PROBE}.scratch (v integer)`);
  await owner.unsafe('vacuum');
}
async function dropProbes() {
  if (!probesInstalled) return;
  await owner.unsafe(`drop extension if exists pg_walinspect`);
  await owner.unsafe(`drop extension if exists pageinspect`);
  await owner.unsafe(`drop schema if exists ${PROBE} cascade`);
  probesInstalled = false;
}
const lsnOf = (text) => { const [hi, lo] = String(text).split('/'); return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`); };
const lsnText = (n) => `${(n >> 32n).toString(16).toUpperCase()}/${(n & 0xffffffffn).toString(16).toUpperCase()}`;

/** The session row's heap page: block, PageGetHeapFreeSpace, the prune threshold heap_page_prune_opt applies (the larger of the
 * fillfactor target and BLCKSZ/10), and what one more version of the row consumes (MAXALIGN(len), plus a line pointer unless an
 * unused one is reused). */
async function sessionPageOf(key) {
  const [r] = await owner.unsafe(`select (s.ctid::text::point)[0]::int as blk, (s.ctid::text::point)[1]::int as lp,
      pg_catalog.current_setting('block_size')::int as bs,
      coalesce((select pg_catalog.split_part(o, '=', 2)::int from pg_catalog.unnest(c.reloptions) o where o like 'fillfactor=%'), 100) as ff
    from tmpos_session.session s cross join pg_catalog.pg_class c
   where s.session_key = $1 and c.oid = 'tmpos_session.session'::regclass`, [key]).catch((e) => { throw sealDbError('IRH the session page', e); });
  const [h] = await owner.unsafe(`select h.lower, h.upper from ${PROBE}.page_header(${PROBE}.get_raw_page('tmpos_session.session', $1::bigint)) h`, [r.blk]);
  const [i] = await owner.unsafe(`select (select i.lp_len from ${PROBE}.heap_page_items(${PROBE}.get_raw_page('tmpos_session.session', $1::bigint)) i where i.lp = $2) as len,
      (select pg_catalog.count(*)::int from ${PROBE}.heap_page_items(${PROBE}.get_raw_page('tmpos_session.session', $1::bigint)) i where i.lp_flags = 0) as unused`, [r.blk, r.lp]);
  const free = Math.max(0, h.upper - h.lower - 4);
  const minfree = Math.max(Math.floor((r.bs * (100 - r.ff)) / 100), Math.floor(r.bs / 10));
  const next = ((i.len + 7) & ~7) + (i.unused > 0 ? 0 : 4);
  return { blk: r.blk, free, minfree, next };
}

/** Pads the session page with HOT versions of `key`'s row (its touch, writing back the stamp as stored) until ONE more version —
 * the GET's own touch — takes the page below the prune threshold, while it stays at or above it (so no read prunes it before). */
async function padSessionPage(key) {
  let page = await sessionPageOf(key);
  for (let i = 0; i < 400 && page.free - page.next >= page.minfree; i += 1) {
    const [{ v }] = await owner`select tmpos_session.m5_session_touch(${key}::text, 'validatedAt', s.validated_at) as v from tmpos_session.session s where s.session_key = ${key}`
      .catch((e) => { throw sealDbError('IRH a padding touch', e); });
    assert.equal(v, 'updated', 'a padding version');
    page = await sessionPageOf(key);
  }
  assert.ok(page.free >= page.minfree && page.free - page.next < page.minfree, `padded: ${JSON.stringify(page)}`);
  return page;
}

/** Autovacuum held off the session table for `fn` (and the table vacuumed first), its reloptions restored exactly after. */
async function withSessionTableQuiet(fn) {
  const [{ opts }] = await owner`select c.reloptions::text as opts from pg_catalog.pg_class c where c.oid = 'tmpos_session.session'::regclass`;
  await owner.unsafe('alter table tmpos_session.session set (autovacuum_enabled = false)');
  try {
    await owner.unsafe('vacuum tmpos_session.session');
    return await fn();
  } finally {
    await owner.unsafe('alter table tmpos_session.session reset (autovacuum_enabled)');
    if (opts !== null) await owner.unsafe(`alter table tmpos_session.session set (${opts.slice(1, -1)})`);
    const [{ after }] = await owner`select c.reloptions::text as after from pg_catalog.pg_class c where c.oid = 'tmpos_session.session'::regclass`;
    assert.equal(after, opts, 'the session table\'s reloptions restored');
  }
}

/** The bgwriter logs a standby snapshot (and requests its flush) at most every 15 s; seeing one opens a window in which no
 * background flush request moves the flush position, so only the cases' own commits do. A case reuses a window seen less than
 * 9 s ago (its GET then ends well inside it); otherwise it waits for the next snapshot, waking a hibernating bgwriter by
 * allocating a fresh buffer (a page more of the scratch table) every half second. */
let lastSnapshotAt = null;
async function awaitStandbySnapshot() {
  const [{ level }] = await owner`select pg_catalog.current_setting('wal_level') as level`;
  if (level === 'minimal') return 'none';
  if (lastSnapshotAt !== null && Date.now() - lastSnapshotAt < 9_000) return 'window';
  const [{ from }] = await owner`select pg_catalog.pg_current_wal_insert_lsn()::text as from`;
  await owner`select pg_catalog.pg_logical_emit_message(true, 'irh-tick', 'x')`;
  let nudged = 0;
  for (const until = Date.now() + 35_000; Date.now() < until; await delay(25)) {
    const [{ n }] = await owner.unsafe(`select pg_catalog.count(*)::int as n from ${PROBE}.pg_get_wal_records_info($1::pg_lsn, pg_catalog.pg_current_wal_flush_lsn()) r
       where r.resource_manager = 'Standby' and r.record_type = 'RUNNING_XACTS'`, [from]);
    if (n > 0) { lastSnapshotAt = Date.now(); return 'seen'; }
    if (Date.now() - nudged >= 500) {
      nudged = Date.now();
      await owner.unsafe(`insert into ${PROBE}.scratch (v) select pg_catalog.generate_series(1, 300)`);
    }
  }
  throw new Error('no standby snapshot within 35 s');
}

/** A side connection sampling back to back every runtime-login transaction (pid, start, xid, state, whether it runs the proof
 * routine) with the WAL insert and flush positions. `onSample` sees each sample. */
async function startPoller(onSample = () => {}) {
  const side = testClient(TARGET, { max: 1, onnotice: () => {} });
  const sample = async () => {
    const [row] = await side`select (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::float8 as t,
        pg_catalog.pg_current_wal_insert_lsn()::text as ins, pg_catalog.pg_current_wal_flush_lsn()::text as fl,
        coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object('pid', a.pid, 'xs', (extract(epoch from a.xact_start) * 1000)::float8,
            'xid', a.backend_xid::text, 'proof', a.query like '%m7b_invoice_payment_registration_proof%', 'lock', a.wait_event_type = 'Lock'))
          from pg_catalog.pg_stat_activity a where a.usename = ${RUNTIME_LOGIN} and a.xact_start is not null), '[]'::json) as tx`;
    return { t: row.t, ins: lsnOf(row.ins), fl: lsnOf(row.fl), tx: row.tx };
  };
  for (let i = 0; i < 3; i += 1) await sample(); // the side backend's own first catalog reads, before any window
  const samples = [];
  let running = true;
  const loop = (async () => { while (running) { const s = await sample(); samples.push(s); onSample(s); } })();
  return {
    stop: async () => { running = false; await loop; await side.end({ timeout: 5 }); return samples; },
  };
}

/** The proof transactions the samples saw (each runtime-login transaction that ran the routine), in start order. */
function proofTransactionsOf(samples, t0) {
  const byId = new Map();
  samples.forEach((s, i) => {
    for (const x of s.tx) {
      const id = `${x.pid}@${x.xs}`;
      const tx = byId.get(id) ?? { pid: x.pid, xs: x.xs, first: i, last: i, xids: new Set(), proof: false };
      tx.last = i;
      if (x.xid !== null) tx.xids.add(x.xid);
      if (x.proof) tx.proof = true;
      byId.set(id, tx);
    }
  });
  return [...byId.values()].filter((tx) => tx.proof).sort((a, b) => a.xs - b.xs).map((tx) => ({
    ...tx, start: Math.round(tx.xs - t0), lastSeen: Math.round(samples[tx.last].t - t0),
    endedBy: tx.last + 1 < samples.length ? Math.round(samples[tx.last + 1].t - t0) : null,
    flushAtLast: samples[tx.last].fl, flushAfter: tx.last + 1 < samples.length ? samples[tx.last + 1].fl : null,
  }));
}

/** The WAL records the request window [from, to) holds on the session page and on the scratch table (flushed first). */
async function windowRecordsOf(from, to, blk) {
  const rows = await owner.unsafe(`select b.start_lsn::text as s, b.end_lsn::text as e, b.xid::text as xid, b.resource_manager as rm,
        b.record_type as type, b.relblocknumber::int as blk,
        case when b.relfilenode = pg_catalog.pg_relation_filenode('tmpos_session.session') then 'session' else 'scratch' end as rel
      from ${PROBE}.pg_get_wal_block_info($1::pg_lsn, $2::pg_lsn, false) b
     where b.reldatabase = (select d.oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database())
       and b.relfilenode in (pg_catalog.pg_relation_filenode('tmpos_session.session'), pg_catalog.pg_relation_filenode('${PROBE}.scratch'))
     order by b.start_lsn`, [lsnText(from), lsnText(to)]);
  const all = rows.map((r) => ({ ...r, s: lsnOf(r.s), e: lsnOf(r.e) }));
  return {
    prunes: all.filter((r) => r.rel === 'session' && r.blk === blk && r.rm === 'Heap2' && r.type.startsWith('PRUNE')),
    touches: all.filter((r) => r.rel === 'session' && r.blk === blk && r.rm === 'Heap' && r.type.startsWith('HOT_UPDATE')),
    scratch: all.filter((r) => r.rel === 'scratch'),
  };
}

/** Moves the WAL insert position into the first KB of a fresh WAL page (one synchronous logical message sized to fill the
 * current page), so that the request window's few hundred bytes — the stall touch, the prune, an unrelated insert — share one
 * page with room to spare: no page completes inside the window, so no background write of a completed page can carry the flush
 * across it. Answers the aligned position and the WAL block size. */
async function alignInsertPosition() {
  const [{ bs }] = await owner`select pg_catalog.current_setting('wal_block_size')::int as bs`;
  const block = BigInt(bs);
  for (let i = 0; i < 4; i += 1) {
    const [{ ins }] = await owner`select pg_catalog.pg_current_wal_insert_lsn()::text as ins`;
    const offset = lsnOf(ins) % block;
    if (offset <= 1024n) return { lsn: lsnOf(ins), block };
    await owner`select pg_catalog.pg_logical_emit_message(true, 'irh-align', ${'x'.repeat(Number(block - offset))})`;
  }
  throw new Error('the WAL insert position could not be aligned');
}

/** Every WAL record in [from, to): its transaction id, kind, and whether it touches a block of tmpos_session.session. */
async function gapRecordsOf(from, to) {
  if (to <= from) return [];
  const rows = await owner.unsafe(`select r.start_lsn::text as s, r.xid::text as xid, r.resource_manager as rm, r.record_type as type,
        coalesce(pg_catalog.bool_or(b.relfilenode = pg_catalog.pg_relation_filenode('tmpos_session.session')
          and b.reldatabase = (select d.oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database())), false) as session
      from ${PROBE}.pg_get_wal_records_info($1::pg_lsn, $2::pg_lsn) r
      left join ${PROBE}.pg_get_wal_block_info($1::pg_lsn, $2::pg_lsn, false) b on b.start_lsn = r.start_lsn
     group by r.start_lsn, r.xid, r.resource_manager, r.record_type
     order by r.start_lsn`, [lsnText(from), lsnText(to)]);
  return rows.map((r) => ({ ...r, s: lsnText(lsnOf(r.s)) }));
}

/**
 * The proof GET under observation. In service the session touch that leaves the page prunable is a 2xx request's refresh,
 * written AFTER its response (app.ts: res 'finish' → boundary.refresh → m5_session_touch), so it can land between the next GET's
 * session read (authentication) and that GET's proof transaction. That order is made deterministic here: the page is padded to
 * one version above the prune threshold; the GET is held in its tenant admission (which reads public.tenant, after the session
 * read) by a side transaction's ACCESS EXCLUSIVE lock; while it waits ONE touch (the refresh's routine, writing the stamp back as
 * stored) takes the page below the threshold; then the lock is released, and the proof transaction's read is the first reader of
 * the prunable page. A quiet WAL window, the poller running; `during(sample, t0)` may act on each sample; `beforeLock()` runs
 * once the page is padded, before the WAL insert position is aligned to a fresh page and the lock is taken. Answers the reply, its
 * elapsed ms, the proof transactions, the stall touch and the flush position when the GET returned (before anything else commits).
 */
async function observedProof(ctx, s, w, invoice, registration, during = () => {}, beforeLock = async () => {}) {
  return withSessionTableQuiet(async () => {
    await awaitStandbySnapshot();
    const page = await padSessionPage(s.key);
    const [{ validated }] = await owner`select x.validated_at::text as validated from tmpos_session.session x where x.session_key = ${s.key}`
      .catch((e) => { throw sealDbError('IRH the session stamp', e); });
    await beforeLock();
    const aligned = await alignInsertPosition();
    let locked;
    const isLocked = new Promise((resolve) => { locked = resolve; });
    let unlock;
    const unlocked = new Promise((resolve) => { unlock = resolve; });
    const holding = owner.begin(async (tx) => {
      await tx`lock table public.tenant in access exclusive mode`;
      locked();
      await unlocked;
    });
    await isLocked;
    const fallback = setTimeout(() => unlock(), 5_000); // never hang the suite: a GET that never waits fails the stall assertion
    let t0 = null;
    let stall = null;
    const poller = await startPoller((sample) => {
      if (t0 === null) return;
      if (stall === null && sample.tx.some((x) => x.lock)) {
        stall = (async () => {
          try {
            // No other read of the row: the next reader of the page must be the GET itself.
            const [{ v, xid }] = await owner`select tmpos_session.m5_session_touch(${s.key}::text, 'validatedAt', ${validated}::bigint) as v,
                pg_catalog.pg_current_xact_id()::text as xid`.catch((e) => { throw sealDbError('IRH the stall touch', e); });
            const [h] = await owner.unsafe(`select h.lower, h.upper from ${PROBE}.page_header(${PROBE}.get_raw_page('tmpos_session.session', $1::bigint)) h`, [page.blk]);
            return { v, xid, atMs: Math.round(sample.t - t0), after: { free: Math.max(0, h.upper - h.lower - 4), minfree: page.minfree } };
          } finally {
            unlock();
          }
        })();
      }
      during(sample, t0);
    });
    const [{ from, at }] = await owner`select pg_catalog.pg_current_wal_insert_lsn()::text as from, (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::float8 as at`;
    t0 = at;
    const started = Date.now();
    let reply;
    try {
      reply = await ctx.proof(s, w, invoice, registration);
    } finally {
      clearTimeout(fallback);
      unlock();
    }
    const elapsed = Date.now() - started;
    const samples = await poller.stop();
    const [{ ins, fl }] = await owner`select pg_catalog.pg_current_wal_insert_lsn()::text as ins, pg_catalog.pg_current_wal_flush_lsn()::text as fl`;
    await holding;
    const touched = stall === null ? null : await stall;
    assert.ok(touched !== null && touched.v === 'updated', 'the GET waited in its admission and the stall touch was written');
    assert.ok(touched.after.free < touched.after.minfree, `the stall touch took the page below the prune threshold: ${JSON.stringify(touched.after)}`);
    return {
      reply, elapsed, page, samples, t0, touched, aligned, from: lsnOf(from), insertAfter: lsnOf(ins), flushAfter: lsnOf(fl), txs: proofTransactionsOf(samples, t0),
    };
  });
}

/** One evidence line: transaction boundaries, the WAL, status and elapsed ms. */
function evidenceLine(label, o, records, extra = {}) {
  const prune = records.prunes[0];
  const line = {
    status: o.status ?? o.reply.status, elapsedMs: o.elapsed, reason: o.reason,
    page: o.page, samples: o.samples.length,
    proofTransactions: o.txs.map((tx) => ({ pid: tx.pid, startMs: tx.start, lastSeenMs: tx.lastSeen, goneByMs: tx.endedBy, xid: tx.xids.size === 0 ? null : [...tx.xids],
      flushAtLastSample: lsnText(tx.flushAtLast), flushAfterEnd: tx.flushAfter === null ? null : lsnText(tx.flushAfter) })),
    window: [lsnText(o.from), lsnText(o.insertAfter)], alignedAt: o.aligned === undefined ? null : lsnText(o.aligned.lsn),
    touches: records.touches.map((r) => `${r.type}@${lsnText(r.s)}..${lsnText(r.e)} xid ${r.xid}`),
    prunes: records.prunes.map((r) => `${r.rm}/${r.type} blk ${r.blk} xid ${r.xid} ${lsnText(r.s)}..${lsnText(r.e)}`),
    scratch: records.scratch.map((r) => `${r.type}@${lsnText(r.s)}..${lsnText(r.e)} xid ${r.xid}`),
    stallTouch: o.touched === null ? null : { xid: o.touched.xid, atMs: o.touched.atMs, pageAfter: o.touched.after },
    insertBeforeFirstProofSample: o.txs[0] === undefined || o.txs[0].first === 0 ? null : lsnText(o.samples[o.txs[0].first - 1].ins),
    flushWhenGetReturned: lsnText(o.flushAfter),
    pruneFlushedWhenGetReturned: prune === undefined ? null : o.flushAfter >= prune.e,
    firstSampleFlushedPastPruneMs: prune === undefined ? null : (() => { const at = o.samples.find((x) => x.fl >= prune.e); return at === undefined ? null : Math.round(at.t - o.t0); })(),
    ...extra,
  };
  console.log(`${label} EVIDENCE ${JSON.stringify(line)}`);
  return line;
}

/** Common checks of the window: the GET's own touch, then exactly one xid-less PRUNE of that page, by the first proof transaction. */
/** Common checks of the window: the stall touch, then exactly one xid-less PRUNE of that page, written once the first proof
 * transaction had begun (after the last sample before it), while the flush stayed below its end for as long as it was open. */
function assertSelfPrune(o, records, label) {
  const before = (r) => r.e <= records.prunes[0]?.s;
  assert.equal(records.prunes.length, 1, `${label}: exactly one PRUNE of the session page in the window`);
  const [prune] = records.prunes;
  assert.equal(prune.xid, '0', `${label}: the prune has no transaction id`);
  assert.deepEqual(records.touches.filter(before).map((r) => r.xid), [o.touched.xid], `${label}: the one HOT version before the prune is the stall touch`);
  assert.ok(o.txs.length >= 1, `${label}: a proof transaction was observed`);
  for (const tx of o.txs) assert.equal(tx.xids.size, 0, `${label}: a proof transaction never holds a transaction id`);
  const first = o.txs[0];
  assert.ok(first.first > 0 && prune.s >= o.samples[first.first - 1].ins, `${label}: the prune was written after the last sample before the first proof transaction`);
  assert.ok(prune.e <= o.samples[first.last].ins, `${label}: ... and before that transaction was last seen`);
  for (let i = first.first; i <= first.last; i += 1) {
    assert.ok(o.samples[i].fl < prune.e, `${label}: the flush stays below the prune's end while the first proof transaction is open`);
  }
  return prune;
}

test('IRH-10: SELF-PRUNE — a session touch landing between the GET\'s session read and its proof transaction (in service: the previous 2xx request\'s after-response refresh) leaves the session page prunable and the proof transaction\'s own read prunes it (Heap2 PRUNE, no xid): the first attempt answers not_durable and COMMITS, the flush passes the prune only after that COMMIT, one fresh attempt issues — 200 within the 3 s deadline, exactly two proof transactions, neither holding an xid, the first ended before the second began', async () => {
  await installProbes();
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh10');
    const s = await signIn(ctx, w.mgr);
    const invoice = await issueOne(ctx, s, w, 'irh10');
    const attempt = randomUUID();
    const registration = registeredOf(await ctx.register(s, w, invoice, { expectedTenant: w.T, attemptId: attempt }), invoice, attempt, 'irh10: register');
    const row = await registrationOf(registration);
    const o = await observedProof(ctx, s, w, invoice, registration);
    await owner`select pg_catalog.pg_logical_emit_message(true, 'irh-evidence', 'x')`; // flush the window so pg_walinspect can read it
    const records = await windowRecordsOf(o.from, o.insertAfter, o.page.blk);
    const line = evidenceLine('IRH-10', { ...o, reason: o.reply.status === 200 ? '-' : ctx.reason(o.reply) }, records);
    const prune = assertSelfPrune(o, records, 'IRH-10');
    const proof = proofOf(o.reply, registration, invoice, attempt, 'IRH-10: issued by the fresh attempt');
    assert.ok(o.elapsed < 3000, `IRH-10: within the request deadline: ${o.elapsed} ms`);
    assert.equal(o.txs.length, 2, `IRH-10: exactly two proof transactions: ${JSON.stringify(line.proofTransactions)}`);
    const [t1, t2] = o.txs;
    assert.ok(t1.last < t2.first && t1.xs < t2.xs, 'IRH-10: the first proof transaction ended before the second began (never seen together)');
    assert.ok(t2.xs > o.samples[t1.last].t, 'IRH-10: the second began after the first was last seen');
    const passed = o.samples.findIndex((x) => x.fl >= prune.e);
    assert.ok(passed > t1.last && passed <= t2.last + 1, `IRH-10: the flush passed the prune only after the first COMMIT, before the second attempt ended (sample ${passed})`);
    // Between the first attempt's end and the second's start (the last sample seeing the first, the first sample seeing the
    // second): no write to the session table and no other request-level write — no WAL record holding a transaction id. The
    // second attempt revalidates by reading only.
    const gap = await gapRecordsOf(o.samples[t1.last].ins, o.samples[t2.first].ins);
    console.log(`IRH-10 GAP ${JSON.stringify(gap)}`);
    assert.deepEqual(gap.filter((r) => r.xid !== '0' || (r.session && !(r.rm === 'Heap2' && r.type.startsWith('PRUNE')))), [],
      'IRH-10: no session write and no request-level write between the two attempts');
    assert.deepEqual(await registrationOf(registration), row, 'IRH-10: the registration unchanged by the proof');
    recordedOf(await ctx.record(s, w, invoice, recordBody(w, registration, attempt, proof)), invoice, attempt, TOTAL, 'IRH-10: recorded with it');
  });
});

test('IRH-11: SELF-PRUNE, TARGET UNFLUSHED — the same prune, then an unrelated in-progress transaction (an xid, one small insert) writes WAL after it while the first attempt waits: the first attempt\'s COMMIT flushes only to its own end, the fresh attempt\'s position stays unflushed — the existing bounded retryable 503 within the deadline, at most two proof transactions, nothing written; once that transaction commits, an explicit same-session proof GET serves the proof', async () => {
  await installProbes();
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh11');
    const s = await signIn(ctx, w.mgr);
    const invoice = await issueOne(ctx, s, w, 'irh11');
    const attempt = randomUUID();
    const registration = registeredOf(await ctx.register(s, w, invoice, { expectedTenant: w.T, attemptId: attempt }), invoice, attempt, 'irh11: register');
    const row = await registrationOf(registration);
    const before = await counts([w.T]);
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let unrelated = null;
    let wrote = null;
    const o = await (async () => {
      try {
        return await observedProof(ctx, s, w, invoice, registration, (sample, t0) => {
          if (unrelated !== null) return;
          const first = sample.tx.find((x) => x.proof);
          if (first === undefined || sample.t - first.xs < 100) return;
          unrelated = owner.begin(async (tx) => {
            const [{ xid }] = await tx`insert into irh_probe.scratch (v) values (1) returning pg_catalog.pg_current_xact_id()::text as xid`;
            const [{ at }] = await tx`select (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::float8 as at`;
            wrote = { xid, atMs: Math.round(at - t0), proofTransactionStartMs: Math.round(first.xs - t0) };
            await released;
          });
        });
      } finally {
        release();
      }
    })();
    assert.ok(unrelated !== null, 'IRH-11: the unrelated transaction started while the first attempt waited');
    await unrelated; // its COMMIT (synchronous) flushes everything before it
    const records = await windowRecordsOf(o.from, o.insertAfter, o.page.blk);
    const reason = o.reply.status === 200 ? '-' : ctx.reason(o.reply);
    const line = evidenceLine('IRH-11', { ...o, reason }, records, { unrelated: wrote });
    const prune = assertSelfPrune(o, records, 'IRH-11');
    assertRefusal(o.reply, 503, 'service_unavailable', 'IRH-11: the existing bounded retryable 503');
    assert.equal(reason, 'invoice_payment_registration_proof_unavailable', 'IRH-11: the port\'s bounded outage reason');
    assert.ok(o.elapsed < 3000, `IRH-11: within the request deadline: ${o.elapsed} ms`);
    assert.equal(o.txs.length, 2, `IRH-11: exactly two proof transactions: ${JSON.stringify(line.proofTransactions)}`);
    assert.ok(o.txs[0].last < o.txs[1].first, 'IRH-11: the first proof transaction ended before the second began');
    assert.equal(records.scratch.length, 1, 'IRH-11: one unrelated record in the window');
    assert.match(String(wrote?.xid), /^[1-9][0-9]*$/, 'IRH-11: the unrelated transaction holds an xid');
    assert.ok(records.scratch[0].s >= prune.e && records.scratch[0].e - records.scratch[0].s < 8192n, 'IRH-11: written after the prune, well under one WAL page');
    assert.ok(o.flushAfter < records.scratch[0].e, 'IRH-11: the unrelated WAL was still unflushed when the GET returned');
    // The pre-alignment held: the window from before the prune to the end of the unrelated insert lies in one WAL page with at
    // least 1 KB of room after it, so no completed page could have been flushed past the prune by the WAL writer.
    const { block } = o.aligned;
    assert.ok(o.from / block === records.scratch[0].e / block && block - (records.scratch[0].e % block) >= 1024n,
      `IRH-11: the prune and the unrelated insert share one WAL page with room after them (aligned ${lsnText(o.aligned.lsn)}, window ${lsnText(o.from)}..${lsnText(records.scratch[0].e)})`);
    assert.deepEqual(delta(await counts([w.T]), before), READ_ONLY, 'IRH-11: no payment, no audit record, nothing written');
    assert.deepEqual(await registrationOf(registration), row, 'IRH-11: the registration unchanged');
    const proof = proofOf(await ctx.proof(s, w, invoice, registration), registration, invoice, attempt, 'IRH-11: the explicit same-session retry');
    recordedOf(await ctx.record(s, w, invoice, recordBody(w, registration, attempt, proof)), invoice, attempt, TOTAL, 'IRH-11: recorded with it');
  });
});

/** With the WAL writer slowed, makes it flush once now (an asynchronous commit only it may flush; nothing else commits while
 * this waits), so that for its delay it flushes no later asynchronous commit — a proof transaction's or a revocation's. */
async function primeWalWriter() {
  assert.equal((await lagger`select pg_catalog.current_setting('synchronous_commit') as v`)[0].v, 'off');
  await lagger`select pg_catalog.pg_logical_emit_message(true, 'irh-prime', 'x')`;
  const [{ ins }] = await owner`select pg_catalog.pg_current_wal_insert_lsn()::text as ins`;
  for (const until = Date.now() + 15_000; Date.now() < until; await delay(10)) {
    const [{ fl }] = await owner`select pg_catalog.pg_current_wal_flush_lsn()::text as fl`;
    if (lsnOf(fl) >= lsnOf(ins)) return;
  }
  throw new Error('the WAL writer did not flush the priming commit within 15 s');
}

test('IRH-12: REVALIDATION — the session is revoked (committed asynchronously, the WAL writer slowed so nothing flushes it) while the first attempt waits on the self-prune: the first answers not_durable and commits, the fresh attempt re-reads the session and answers denied — the 403, no proof, nothing written', async () => {
  await installProbes();
  await withEntry(async (ctx) => {
    const w = await world(ctx, 'irh12');
    const s = await signIn(ctx, w.mgr);
    const invoice = await issueOne(ctx, s, w, 'irh12');
    const attempt = randomUUID();
    const registration = registeredOf(await ctx.register(s, w, invoice, { expectedTenant: w.T, attemptId: attempt }), invoice, attempt, 'irh12: register');
    const row = await registrationOf(registration);
    const before = await counts([w.T]);
    let revoking = null;
    let revoked = null;
    await setWalWriterDelay('10s');
    let o;
    try {
      o = await observedProof(ctx, s, w, invoice, registration, (sample, t0) => {
        if (revoking !== null) return;
        const first = sample.tx.find((x) => x.proof);
        if (first === undefined || sample.t - first.xs < 100) return;
        revoking = lagger.begin(async (tx) => {
          const [{ v }] = await tx`select tmpos_session.m5_session_revoke(${s.key}::text) as v`.catch((e) => { throw sealDbError('IRH-12 the revocation', e); });
          const [{ lsn, at }] = await tx`select pg_catalog.pg_current_wal_insert_lsn()::text as lsn, (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::float8 as at`;
          revoked = { v, lsn: lsnOf(lsn), atMs: Math.round(at - t0), proofTransactionStartMs: Math.round(first.xs - t0) };
        }).then(() => { revoked.committedByMs = Math.round(Date.now() - t0); });
      }, primeWalWriter);
    } finally {
      await setWalWriterDelay(null);
    }
    assert.ok(revoking !== null, 'IRH-12: the revocation started while the first attempt waited');
    await revoking;
    await owner`select pg_catalog.pg_logical_emit_message(true, 'irh-evidence', 'x')`; // flush the window so pg_walinspect can read it
    const records = await windowRecordsOf(o.from, o.insertAfter, o.page.blk);
    const reason = o.reply.status === 200 ? '-' : ctx.reason(o.reply);
    const line = evidenceLine('IRH-12', { ...o, reason }, records, { revoked: { ...revoked, lsn: lsnText(revoked.lsn) } });
    const prune = assertSelfPrune(o, records, 'IRH-12');
    assert.equal(revoked.v, 'revoked', 'IRH-12: the session revoked');
    assertRefusal(o.reply, 403, 'forbidden', 'IRH-12: the fresh attempt revalidated the session');
    assert.equal(reason, 'invoice_payment_registration_proof_denied', 'IRH-12: the proof route\'s denial');
    assert.ok(o.elapsed < 3000, `IRH-12: within the request deadline: ${o.elapsed} ms`);
    assert.equal(o.txs.length, 2, `IRH-12: exactly two proof transactions: ${JSON.stringify(line.proofTransactions)}`);
    const [t1, t2] = o.txs;
    assert.ok(t1.last < t2.first && t1.xs < t2.xs, 'IRH-12: the first proof transaction ended before the second began');
    assert.ok(revoked.lsn > prune.e, 'IRH-12: the revocation was written after the first attempt\'s read (its prune)');
    assert.ok(revoked.committedByMs < t1.lastSeen, `IRH-12: the revocation committed while the first attempt still waited: ${JSON.stringify({ ...revoked, lsn: lsnText(revoked.lsn) })}`);
    assert.ok(o.flushAfter < prune.e, 'IRH-12: the first attempt\'s target stayed unflushed through both attempts (no flush let either issue)');
    assert.deepEqual(delta(await counts([w.T]), before), READ_ONLY, 'IRH-12: no payment, no audit record, nothing written');
    assert.deepEqual(await registrationOf(registration), row, 'IRH-12: the registration unchanged');
  });
});

// ===========================================================================
// IRH-09: secrets
// ===========================================================================

test('IRH-09: no proof, proof key or session key in any captured log line, this suite\'s idempotency rows and audit rows, or any error body', async () => {
  assert.ok(PROOFS.size >= 8 && PROOF_KEYS.length >= 4 && KEYS.size >= 8, 'the earlier cases ran');
  const needles = [
    ...[...PROOFS].map((p) => ['a proof', p]),
    ...PROOF_KEYS.flatMap((k) => [['a proof key (hex)', k.toString('hex')], ['a proof key (base64)', k.toString('base64')], ['a proof key (base64url)', k.toString('base64url')]]),
    ...[...KEYS].map((k) => ['a session key', k]),
    ...[...COOKIES].map((c) => ['a session cookie', c]),
  ];
  const scopes = [...new Set(USED_KEYS.map(({ key, principal }) => scopeOf(key, principal)))];
  const idempotency = (await owner`select pg_catalog.to_jsonb(r)::text as j from tmpos_internal.idempotency_record r where r.scope = any(${scopes}::text[])`).map((r) => r.j);
  const audits = (await owner`select pg_catalog.to_jsonb(a)::text as j from public.audit_event a where a.tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.j);
  assert.ok(idempotency.length > 0 && audits.length > 0 && LINES.length > 0 && ERROR_BODIES.length > 0, 'something to scan');
  for (const [where, haystack] of [['a log line', LINES], ['an idempotency row', idempotency], ['an audit row', audits], ['an error body', ERROR_BODIES]]) {
    for (const [what, needle] of needles) {
      assert.ok(!haystack.some((h) => h.includes(needle)), `${what} appears in ${where}`);
    }
  }
});
