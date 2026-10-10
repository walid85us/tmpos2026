// Phase 4.0 M7B-INVOICES-P1-R3 — the Invoices authority of an invoice-draft CREATE (POST /api/v1/stores/{storeId}/invoice-drafts)
// held through its newly sealed outcome, END TO END: two tenant entries (server/entry/tenantEntry.ts, startTenantEntry) over
// REAL loopback HTTP and ONE disposable PostgreSQL holding every migration in the directory, composed exactly as
// server/entry/tenantMain.ts composes them but for their construction. The route module (server/runtime/invoiceDrafts.ts), the
// store-scope authorizer and revalidator, the tenant command transaction, the create's mutator
// (server/persistence/postgresInvoiceDrafts.ts) and the create routine it calls (migration 028's, or the guarded replacement a
// later migration binds), the owner's PUT /api/v1/roles/levels with migration 026's setter and 030's writer trigger, the audit
// writer and the outbox enqueue are production's own code. The narrowing is always the tenant OWNER's own PUT on the OTHER
// entry, by a DIFFERENT operator from the one whose create is under test (no shared account lock can serialize the race).
//
// Case labels: R = red on the entry source c4ba482 (migrations 001-030, the create runs 028's routine) for the defect DA-210,
// N = the new contract of the correction, G = a guard that holds before and after.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — tests/db/invoiceDraftEditHttp.integration.test.mjs's three, none on the path under test:
// the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime LOGIN, tmpos_ica_probe,
// holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay), the identity verifier (a synthetic
// bearer-token map) and the listener (127.0.0.1:0). The barrier below is an OWNER lock (a test-only lever).
//
// THE BARRIER (DA-210's window). The create's first touch of tmpos_customer.customer in its command transaction is its
// customer-existence read (028 step 10; the same step in the guarded replacement): the revalidator reads the session, 016's
// hold rows, the admission and the role levels, never a customer. That read comes AFTER the routine's unlocked Invoices
// decision (028 step 8) and BEFORE any answer. An OWNER transaction holds tmpos_customer.customer in ACCESS EXCLUSIVE mode; the
// create is known to be parked there only when pg_locks shows its backend — the one backend blocked by that holder — waiting on
// an ungranted AccessShareLock on exactly that relation, inside the create routine's statement (pg_stat_activity). The owner's
// PUT then commits on entry B (its 200 and its committed row read back) while the create still waits, and only then is the
// table released. No sleep decides an outcome. The create's lock waits are bounded (lock_timeout 70% of its 2 s command
// transaction), so a case whose create was in flight longer than CONCLUSIVE_WINDOW_MS when the table was released is
// INCONCLUSIVE — a failure, never a pass; every case records its send-to-release time and the PUT's duration.
//
// WHAT IS PROVEN (D/L/A/O/K are the drafts, lines, CREATE audit records, invoice_draft.created events and sealed completions a
// case's own tenant and keys hold; AA/OO/C/LE every audit record, outbox row, completed idempotency record and open lease in
// the database — the cases run one at a time — all read by the OWNER as deltas).
//   ICA-01 (AC-02 DA-210) an existing stored Invoices override: a manager (store grant, Invoices stored at Create, Customers at
//          its default) creates on entry A while the barrier holds it; the owner's PUT narrows the manager's Invoices level to
//          View and commits on entry B; released, the create must not be the sealed 422: it is the 503
//          transaction_unavailable, its idempotency record unsealed and its lease held (the same-key retry the authorizer's
//          403 or 409, never a replay), no draft, line, audit record or event, the role and version rows exactly the PUT's.
//          (a) [R] a customer id that does not exist in the tenant; (b) [G] an existing customer (028's locked re-decision).
//   ICA-02 (AC-03 DA-210) an absent override: a sales_staff (default Invoices Create, NO stored row for that role and domain);
//          the PUT is the role's FIRST Invoices insertion, to View; the same barrier and assertions, and no role or version
//          row other than the PUT's own. (a) [R] a missing customer; (b) [G] an existing customer.
//   ICA-03 (AC-04, N) an authorized customer_not_found holds the role's key through its completion: the create (a missing
//          customer) parked at its completion by an owner trigger holds the role's key SHARED (pg_locks: class 530030,
//          objsubid 2, ShareLock, granted, on its backend); the owner's PUT narrowing that role to View on entry B waits for
//          that key (ExclusiveLock, ungranted, pg_blocking_pids = exactly the create's backend, no other lock) and has not
//          answered; released, the create is the sealed 422 (its completion only, no role row), THEN the PUT is the 200, and
//          a later create under a new key is the authorizer's 403, writing nothing. (a) an existing override (manager);
//          (b) an absent override (sales_staff, the PUT's first insertion).
//   ICA-04 (AC-05, N) the same for a successful create (an existing customer): the 201 with exactly one draft, its line, one
//          audit record, one event and the completion — committed while the PUT waited for the key — the Customers NULL
//          anchor its only role row, then the PUT's 200, then the 403. (a) and (b) as ICA-03.
//   ICA-08 (AC-09, N) the completion fails: parked holding the key with the PUT waiting, the completion then raises: the 503,
//          rolled back (no draft, line, audit record, event, completion or role row of the create), the lease held, the key
//          gone with that transaction — the waiting PUT (here a widening to Edit, so the create stays authorized) commits
//          its 200 — and the same-key retry is the 409 request_in_progress. (a) an applied create; (b) a customer_not_found.
//   ICA-09 (AC-10, G) replay and current authority: a sealed 422 and a sealed 201 replay byte for byte (Idempotent-Replayed:
//          true); after the PUT narrows, the same-key replay is the authorizer's 403; restored by a second PUT, the replay
//          returns the stored bytes again; another body under either key is the 422 idempotency_key_reused; nothing new
//          written (the drafts, lines, audit records, events and both records, row versions included, as they were).
//   ICA-12 (AC-11, G/N) a lost COMMIT acknowledgement (the relay forwards the COMMIT and drops its answer): [N] the create,
//          parked at its completion by the owner trigger BEFORE its COMMIT is sent, holds exactly the role's key SHARED (class
//          530030, objsubid 2, ShareLock, granted, on its backend); released, [G] the 503 transaction_timeout at the commit
//          deadline, the outcome unknown; what landed is whole (one draft, its line, one audit record, one event, the
//          completion); the same-key retry replays it; no guard key stands afterwards and the owner's PUT then commits.
// ICA-05..07, ICA-10 and ICA-11 are the routine-level cases (tests/db/invoiceDraftCreateAuthority.integration.test.mjs). The
// parking trigger (ICA-03, -04, -08, -12) is an OWNER trigger on tmpos_internal.idempotency_record that fires only for the
// create's own completion (its record's scope) and waits on a test advisory key the OWNER holds: a test-only lever, like the
// barrier.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Synthetic data only, every id
// and key made at run time. Before it finishes it drops its proof schema (ica_proof: the parking trigger's function and
// counter), removes every draft, line and Invoices lock anchor of its tenants, clears every
// audit subject naming one of its drafts and deletes its tenants' draft events, with its sessions, mint-ledger rows, idempotency
// records and login, and restores the limiter fingerprint and issuer key row it found.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriverVia } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring, IDEMPOTENCY_POLICY } from '../../server/runtime/idempotency.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';
import { PORT_DEADLINE_MS } from '../../server/runtime/deadline.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
/** Every forward migration in the directory (whatever its newest number): the suite applies and requires them all. */
const DIRECTORY_VERSIONS = readdirSync(MIG_DIR).map((f) => /^(\d{3})_[a-z0-9_]+\.up\.sql$/.exec(f)?.[1]).filter(Boolean).sort();
const MIGRATOR = { purpose: 'migration', migratorRef: 'ica-migrator', runtimeRef: 'ica-runtime' };
const LOCK_KEY = 531_031;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ica_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';
/** The audit action of a save (the create contract's kind) and its event, pinned here as literals. */
const ACTION = 'store.invoice_draft.create';
const EVENT = 'invoice_draft.created';
const WAIT_MS = 10_000;
const SEND_TIMEOUT_MS = 20_000;
/**
 * The create routine's statement, where the create waits at the barrier. It names either routine — 028's and the guarded
 * replacement (tmpos_invoice_edit.m7b_invoice_draft_create_v2) — so one pattern serves the entry source and the correction.
 */
const AT_CREATE = /(?:tmpos_invoice_draft\.m7b_invoice_draft_create|tmpos_invoice_edit\.m7b_invoice_draft_create_v2)\(/;
/** The barrier's relation: the create's first touch of it is its customer-existence read. */
const CUSTOMER_TABLE = 'tmpos_customer.customer';
/**
 * The create's lock waits are bounded (lock_timeout 70% of the 2 s command transaction: 1400 ms): a create in flight longer
 * than this when the table was released may have been refused by a TIMEOUT. Such a case is INCONCLUSIVE.
 */
const CONCLUSIVE_WINDOW_MS = 1_100;
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });
assert.equal(IDEMPOTENCY_POLICY.leaseMs, 60_000, 'the idempotency lease the in-progress cases rely on');
assert.ok(COMMAND_TRANSACTION_DEADLINE_MS <= PORT_DEADLINE_MS);
assert.ok(PORT_DEADLINE_MS * 4 <= SEND_TIMEOUT_MS);
assert.ok(CONCLUSIVE_WINDOW_MS < Math.floor(COMMAND_TRANSACTION_DEADLINE_MS * 0.7), 'the window is inside the create\'s lock timeout');
assert.ok(DIRECTORY_VERSIONS.includes('028') && DIRECTORY_VERSIONS.includes('030'), 'the directory holds the create routine and the guard key');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('ICA');
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
const probe = testClient(TARGET, { max: 1, onnotice: () => {} });
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
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => delay(5);
const quietly = (p) => { p.catch(() => {}); return p; };
async function within(promise, label) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: label }), WAIT_MS); });
  try { return await Promise.race([promise, bound]); } finally { clearTimeout(timer); }
}
const ROLLBACK = Symbol('rollback');
const OPEN = new Set();
const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);
const KEYRING = createIdempotencyKeyring(IDEMPOTENCY_KEY);
/** The record scope a key and principal own (it binds nothing else). */
const scopeOf = (key, principal) => KEYRING.operationOf(key, principal, {
  method: 'POST', path: '/', audience: 'tenant', tenant: null, store: null, actor: null, body: new Uint8Array(0),
}).scope;

/** Every draft, line and Invoices lock anchor of this suite's tenants, and every audit subject naming one of its drafts. */
async function cleanDrafts() {
  if (TENANTS.length === 0) return;
  await owner.begin('isolation level read committed', async (sql) => {
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    if (drafts.length > 0) {
      // 002's append-only trigger is lifted for this one update and put back in exactly the mode it was found in.
      const [{ mode }] = await sql`select tgenabled as mode from pg_catalog.pg_trigger
        where tgrelid = 'public.audit_event'::regclass and tgname = 'trg_audit_event_reject_mutation'`;
      const restore = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' }[mode];
      assert.ok(restore, `the append-only trigger's mode is known: ${mode}`);
      await sql.unsafe('alter table public.audit_event disable trigger trg_audit_event_reject_mutation');
      await sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`;
      await sql.unsafe(`alter table public.audit_event ${restore} trg_audit_event_reject_mutation`);
    }
    await sql`delete from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const open of [...OPEN]) await step(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
    await step(() => owner.unsafe('drop schema if exists ica_proof cascade'));
    await step(cleanDrafts);
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
    // The events this suite's saves enqueued: no worker exists, so they would otherwise sit pending forever.
    if (TENANTS.length > 0) {
      await step(() => owner`delete from tmpos_internal.outbox_event where event_type in ('invoice_draft.created', 'invoice_draft.updated')
        and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`);
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
        (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
        (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[]))::int as lines,
        (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
        (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors`;
      assert.deepEqual({ ...state }, { drafts: 0, lines: 0, subjects: 0, anchors: 0 }, 'nothing of this suite blocks a later rollback');
    });
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'ICA teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'ICA setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket' ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) } : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-ica-relay-'));
  const pairs = new Set();
  const state = { pairs, trap: null };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); }, anchored: false, silenced: false };
    pairs.add(pair);
    // A trap answering 'cut' keeps the chunk from the server and severs both sides: the server never sees it.
    client.on('data', (chunk) => {
      if (state.trap !== null && state.trap(pair, chunk) === 'cut') { pair.cut(); return; }
      db.write(chunk);
    });
    db.on('data', (chunk) => { if (!pair.silenced) client.write(chunk); });
    for (const socket of [client, db]) { socket.on('error', pair.cut); socket.on('close', pair.cut); }
  });
  const path = join(dir, '.s.PGSQL.5432');
  const listening = new Promise((done) => server.listen(path, done));
  return {
    dir, listening, state,
    async close() {
      const drained = server.listening ? new Promise((done) => server.close(done)) : Promise.resolve();
      for (const pair of [...pairs]) pair.cut();
      await drained;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function databaseClientOver(relay) {
  return () => SMALL_KERNEL.createSupervisedPgClient(testDriverVia(TARGET, relay.dir), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...SMALL_KERNEL.runtimeClientOptions(TARGET_DSN), ssl: false, max: SMALL_KERNEL.MAX_POOLS, idle_timeout: 0, user: RUNTIME_LOGIN,
  });
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
  const ledger = (await owner`select version from public.schema_migrations`).map((r) => r.version);
  assert.deepEqual(DIRECTORY_VERSIONS.filter((v) => !ledger.includes(v)), [], 'every migration in the directory is applied');
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
  await installTestIssuerKey(owner, ISSUER_KEY);
  await owner.unsafe('drop schema if exists ica_proof cascade');
  await owner.unsafe('create schema ica_proof');
  await owner.unsafe('revoke all on schema ica_proof from public');
  await owner.unsafe('create sequence ica_proof.fired');
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
    type: 'service_account', project_id: 'ica-test-project', client_email: 'ica-test@ica-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
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
    request.setTimeout(SEND_TIMEOUT_MS, () => request.destroy(new Error(`no reply within ${SEND_TIMEOUT_MS} ms: ${method} ${path}`)));
    request.end(payload);
  });
}
function assertBaseline(reply, label) {
  assert.equal(reply.headers['strict-transport-security'], HSTS_HEADER.value, `${label}: HSTS`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(reply.headers[name.toLowerCase()], value, `${label}: ${name}`);
  assert.equal(reply.headers['cache-control'], 'no-store', `${label}: no-store`);
}
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  assertBaseline(reply, label);
}

// ---------------------------------------------------------------------------
// fixtures — all written through the owner
// ---------------------------------------------------------------------------

async function newTenant(label, status = 'active') {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ica-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
}
async function newStore(tenant, name, status = 'active') {
  return (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`${name} ${SUFFIX}`}, ${status}) returning store_id`)[0].store_id;
}
async function newCustomer(tenant, label) {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`ICA ${label} ${SUFFIX}`})`;
  return id;
}
async function actor(label, memberships, status = 'active') {
  const uid = `ica-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
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
const setLevel = (tenant, role, domain, level, sql = owner) => sql`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;
const described = (label) => `ICA ${label} ${SUFFIX}`;
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const saveBody = (tenant, customer, lines) => ({ expectedTenant: tenant, customerId: customer, currency: 'USD', lines });

/**
 * What a case's tenants hold now — drafts, lines, CREATE audit records, creation events — the sealed completions of its keys,
 * and, across the whole database (the suite's cases run one at a time), EVERY audit record (AA), every outbox row (OO), every
 * completed idempotency record (C) and every open lease (LE): a refusal that "writes nothing" may not write those either.
 */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as d,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as l,
    (select count(*) from public.audit_event where action_id = ${ACTION} and tenant_id = any(${tenants}::uuid[]))::int as a,
    (select count(*) from tmpos_internal.outbox_event where event_type = ${EVENT}
      and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = any(${tenants}::uuid[])))::int as o,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from public.audit_event)::int as aa,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as c,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le`;
  return { D: r.d, L: r.l, A: r.a, O: r.o, K: r.k, AA: r.aa, OO: r.oo, C: r.c, LE: r.le };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const NOTHING = Object.freeze({ D: 0, L: 0, A: 0, O: 0, K: 0, AA: 0, OO: 0, C: 0, LE: 0 });
/** A request parked in its command transaction: nothing but the lease its key acquired in its own transaction. */
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
/** The idempotency record of `key`: present, sealed (a response stored) or not, and its lease still running. */
async function recordOf(key, principal) {
  const [row] = await owner`select response is not null as sealed, lease_expires_at > pg_catalog.clock_timestamp() as running
    from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`;
  return row === undefined ? { exists: false, sealed: false, leaseHeld: false } : { exists: true, sealed: row.sealed, leaseHeld: !row.sealed && row.running };
}
/** A tenant's role rows and role-level edit counters exactly as stored, row versions (xmin) included: a write by anyone moves them. */
async function invoicesRowsOf(tenant) {
  return {
    roles: (await owner`select role_id, domain, level, xmin::text as xmin from tmpos_role.tenant_role_level where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
    versions: (await owner`select role_id, domain, version::text as version, xmin::text as xmin from tmpos_role_edit.role_level_version where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
  };
}
const withoutXmin = (rows) => rows.map(({ xmin, ...r }) => r);
/** A diagnostic line the evidence is read from (printed by the runner whether the case passes or fails). */
const evidence = (t, what) => t.diagnostic(`EVIDENCE ${JSON.stringify(what)}`);

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

async function withEntry(fn) {
  const relay = startRelay();
  await relay.listening;
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const log = { log: (l) => { lines.push(l); } };
  const result = await startTenantEntry({
    env: ENV, construction: { databaseClient: databaseClientOver(relay), tokenVerifier: VERIFIER, listen: () => ({ port: 0, host: '127.0.0.1' }) },
    proc, exit: (code) => { codes.push(code); }, log,
  });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  const port = result.address.port;
  const from = randomLoopback();
  const stop = async () => {
    if (codes.length === 0) {
      proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; codes.length === 0 && Date.now() < until;) await delay(10);
    }
    await relay.close().catch(() => {});
  };
  const unsafe = (s, method, path, body, key, headers) => {
    if (s?.principal !== undefined) USED_KEYS.push({ key, principal: s.principal });
    return send(port, method, path, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), 'idempotency-key': key, ...headers,
    }, typeof body === 'string' ? body : JSON.stringify(body), { localAddress: from });
  };
  const ctx = {
    relay, port, lines, stop,
    read: (s, path, headers = {}) => send(port, 'GET', path,
      { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers }, undefined, { localAddress: from }),
    eligibility: (s, store, headers = {}) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/eligibility`, headers),
    save: (s, store, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', `/api/v1/stores/${store}/invoice-drafts`, body, key, headers),
    /** The owner's PUT /api/v1/roles/levels (a tenant command under an Idempotency-Key and a recent sign-in). */
    levels: (s, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'PUT', '/api/v1/roles/levels', body, key, headers),
    reason: (reply) => {
      const found = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
        .filter((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id']);
      assert.equal(found.length, 1, 'exactly one log line for the request');
      return found[0].reason ?? '-';
    },
  };
  try {
    return await fn(ctx);
  } finally {
    await stop();
  }
}
async function signIn(ctx, who) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${who.token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const csrf = JSON.parse(reply.body).csrfToken;
  const key = createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
  KEYS.add(key);
  return { cookie, csrf, key, principal: who.principal };
}
const readReason = (ctx, reply) => { try { return ctx.reason(reply); } catch (err) { return `unread: ${err.message}`; } };
/** A reply's error word, or null when its body is not a JSON object carrying one. */
const errorOf = (reply) => { try { return JSON.parse(reply.body).error ?? null; } catch { return null; } };

// ---------------------------------------------------------------------------
// levers and lock-state probes (invoiceDraftEditHttp's)
// ---------------------------------------------------------------------------

async function hold(label, setup) {
  const ready = deferred();
  const release = deferred();
  const done = owner.begin(async (sql) => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    await setup(sql);
    ready.resolve({ pid });
    if ((await release.promise) === 'rollback') throw ROLLBACK;
  }).then(() => 'committed', (e) => (e === ROLLBACK ? 'rolled back' : `failed:${e?.message ?? e}`));
  const first = await Promise.race([ready.promise, done.then((v) => ({ early: v }))]);
  if ('early' in first) throw new Error(`${label}: the hold ended before it was taken (${first.early})`);
  let ending = null;
  const h = {
    ...first, label, done,
    end(how) { if (ending === null) { release.resolve(how); ending = done; OPEN.delete(h); } return ending; },
    commit: () => h.end('commit'),
    settle: () => h.end('rollback'),
  };
  OPEN.add(h);
  return h;
}
/** THE BARRIER: the OWNER holds the customer table ACCESS EXCLUSIVE, so the create's customer-existence read waits for it. */
const holdCustomerTable = () => hold('the customer table, access exclusive', (sql) => sql.unsafe(`lock table ${CUSTOMER_TABLE} in access exclusive mode`));
async function blockedNow({ by = null, query = null } = {}) {
  const rows = await probe`select pid, query, pg_blocking_pids(pid) as blockers from pg_stat_activity where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
  return rows.filter((r) => (query === null || query.test(r.query)) && (by === null || r.blockers.includes(by))).map((r) => ({ pid: r.pid, blockers: r.blockers }));
}
async function blockedOrSettled(request, criteria) {
  let settled = null;
  request.then((value) => { settled = { value }; }, (error) => { settled = { error: String(error) }; });
  for (const until = Date.now() + WAIT_MS; Date.now() < until; await tick()) {
    if (settled !== null) return { settled };
    const hit = await blockedNow(criteria);
    if (hit.length > 0) return { blocked: hit };
  }
  return settled !== null ? { settled } : null;
}
function waitingPid(outcome, what) {
  assert.ok(outcome !== null, `lever did not engage: ${what} not observed within ${WAIT_MS} ms`);
  assert.ok(outcome.blocked, `${what}: the request completed instead of waiting (${JSON.stringify(outcome.settled?.value?.status ?? outcome.settled)})`);
  return outcome.blocked[0].pid;
}
async function replyTo(request, label) {
  const reply = await within(request, label);
  assert.ok(typeof reply?.status === 'number', `no reply to ${label} within ${WAIT_MS} ms: ${JSON.stringify(reply)}`);
  return reply;
}
/** The locks `pid` waits for (pg_locks, ungranted): locktype, mode, the transaction id or the relation. */
const waitsOf = async (pid) => (await probe`select l.locktype, l.mode, l.transactionid::text as xid, l.relation::regclass::text as relation
  from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted`).map((r) => ({ ...r }));
/** Every backend (any user) blocked by `holder`. */
const waitersBehind = async (holder) => (await probe`select pid from pg_catalog.pg_stat_activity
  where ${holder}::int = any(pg_catalog.pg_blocking_pids(pid)) order by pid`).map((r) => r.pid);
/** The advisory locks of the guard's class (530030, objsubid 2) `pid` holds or waits for: key (int4), mode, granted. */
const guardLocksOf = async (pid) => (await probe`select l.objid::int as key, l.objsubid::int as sub, l.mode::text as mode, l.granted
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' and l.classid::int = 530030 order by 1, 3, 4`).map((r) => ({ ...r }));
/** The granted relation locks `pid` holds on tables of the role levels and the customers (what it has read so far). */
const readSoFar = async (pid) => (await probe`select l.relation::regclass::text as relation, l.mode::text as mode
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.granted and l.locktype = 'relation'
   and l.relation in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_role_edit.role_level_version'::regclass, ${CUSTOMER_TABLE}::regclass)
   order by 1, 2`).map((r) => `${r.relation} ${r.mode}`);

// ===========================================================================
// ICA-01, ICA-02: DA-210 — a narrowing committed through the owner's own PUT while the create waits at its customer read
// ===========================================================================

/**
 * One race: `role`'s Invoices level is `stored` (null: no row, the catalog default) and authorizes the create; the create (a
 * missing or an existing customer) is sent on entry `a` and parked at its customer read by the barrier; the tenant owner — a
 * different operator, signed in on entry `b` — narrows `role`'s Invoices level to View through the production PUT, which
 * commits; the table is released. Every safety observation is gathered BEFORE any is asserted, so the evidence line carries
 * all of them whichever assertion fails first.
 */
async function narrowedWhileCreateWaits(st, { a, b, name, role, stored, customerExists }) {
  const tag = randomUUID().slice(0, 6);
  const T = await newTenant(`${role}-${tag}`);
  const S = await newStore(T, `ICA ${tag}`);
  const existing = await newCustomer(T, `${role}-${tag}`);
  const customer = customerExists ? existing : randomUUID();
  // The operator under test holds one store grant; the owner of the narrowing holds exactly one tenant-scope grant (the
  // setter's authority shape): two accounts, two sessions, two entries.
  const operator = await actor(`op-${tag}`, [storeGrant(T, S, role)]);
  const boss = await actor(`boss-${tag}`, [tenantGrant(T, 'store_owner')]);
  if (stored !== null) await setLevel(T, role, 'invoices', stored);
  const so = await signIn(a, operator);
  const sb = await signIn(b, boss);
  // Request authorization passes before the race: the create's own eligibility at the store is the closed 200.
  const eligible = await a.eligibility(so, S);
  assert.deepEqual([eligible.status, eligible.body], [200, '{"eligibility":"allowed"}'], `${name}: the create is authorized before the race`);
  // The owner's pool warmed and the version it reviews read on entry B BEFORE the create starts to wait.
  const read = await b.read(sb, '/api/v1/roles/levels/invoices');
  assert.equal(read.status, 200, `${name}: the owner reads the Invoices levels: ${read.body}`);
  const reviewed = Number(JSON.parse(read.body).roles.find((r) => r.roleId === role).version);
  const putBody = { roleId: role, domain: 'invoices', level: 'view', reason: described(`narrowing ${tag}`), expectedTenant: T, expectedVersion: reviewed };
  const rolesBefore = await invoicesRowsOf(T);
  if (stored === null) assert.deepEqual(rolesBefore, { roles: [], versions: [] }, `${name}: no role row and no version row at all: the catalog default governs`);
  else assert.deepEqual(withoutXmin(rolesBefore.roles), [{ role_id: role, domain: 'invoices', level: stored }], `${name}: the stored override`);
  const body = saveBody(T, customer, [line(described(`create ${tag}`), 1, 5)]);
  const key = randomUUID();
  const keys = [{ key, principal: operator.principal }];
  const putKey = randomUUID();
  const before = await counts([T], keys);
  const h = await holdCustomerTable();
  const clock = { held: Date.now() };
  let pending;
  let pid;
  let put;
  let mid;
  let rolesAfterPut;
  const barrier = {};
  try {
    clock.sent = Date.now();
    pending = quietly(a.save(so, S, body, { key }));
    // THE BARRIER: past its unlocked Invoices decision (028 step 8), the create waits on the customer table the owner holds.
    pid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_CREATE }), `${name}: the create waiting at its customer read`);
    clock.waiting = Date.now();
    barrier.waitsFor = await waitsOf(pid);
    barrier.waitersBehindHolder = await waitersBehind(h.pid);
    barrier.guardKeys = await guardLocksOf(pid);
    barrier.readSoFar = await readSoFar(pid);
    assert.deepEqual(barrier.waitsFor, [{ locktype: 'relation', mode: 'AccessShareLock', xid: null, relation: CUSTOMER_TABLE }],
      `${name}: the create waits for exactly the customer table (its customer read), nothing else`);
    assert.deepEqual(barrier.waitersBehindHolder, [pid], `${name}: the create's backend is the one backend the barrier blocks`);
    assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${name}: parked, the create holds its lease only`);
    // The narrowing: the owner's own PUT on the OTHER entry, through the production chain, commits while the create waits.
    clock.put = Date.now();
    put = await replyTo(b.levels(sb, putBody, { key: putKey }), `${name}: the owner's narrowing`);
    clock.putDone = Date.now();
    assert.equal(put.status, 200, `${name}: the narrowing commits while the create waits: ${put.body}`);
    rolesAfterPut = await invoicesRowsOf(T);
    assert.deepEqual(withoutXmin(rolesAfterPut.roles), [{ role_id: role, domain: 'invoices', level: 'view' }], `${name}: the committed role row reads View`);
    // The baseline for the create's own effects, taken while it still waits: from here on only the create can write.
    mid = await counts([T], keys);
    barrier.stillWaiting = (await blockedNow({ by: h.pid, query: AT_CREATE })).map((r) => r.pid);
    assert.deepEqual(barrier.stillWaiting, [pid], `${name}: the create still waits at its customer read after the narrowing committed`);
    clock.released = Date.now();
  } finally {
    await h.commit();
  }
  const reply = await replyTo(pending, name);
  clock.answered = Date.now();
  const reason = readReason(a, reply);
  const after = await counts([T], keys);
  const record = await recordOf(key, operator.principal);
  const rolesFinal = await invoicesRowsOf(T);
  // The same key, the same bytes, by the same operator: under the narrowed level.
  const retry = await a.save(so, S, body, { key });
  const retryReason = readReason(a, retry);
  const afterRetry = await counts([T], keys);
  const recordAfterRetry = await recordOf(key, operator.principal);
  evidence(st, {
    case: name, role, storedOverride: stored, customer: customerExists ? 'existing' : 'missing',
    barrier, answer: { status: reply.status, body: reply.body, reason, replayed: reply.headers['idempotent-replayed'] ?? null },
    record, deltaSinceNarrowing: delta(after, mid),
    retry: { status: retry.status, error: errorOf(retry), reason: retryReason, replayed: retry.headers['idempotent-replayed'] ?? null },
    deltaFromRetry: delta(afterRetry, after), recordAfterRetry,
    put: { status: put.status, body: put.body },
    rolesBefore: { roles: withoutXmin(rolesBefore.roles), versions: withoutXmin(rolesBefore.versions) },
    rolesAfterPut: { roles: withoutXmin(rolesAfterPut.roles), versions: withoutXmin(rolesAfterPut.versions) },
    rolesUnchangedSincePut: JSON.stringify(rolesFinal) === JSON.stringify(rolesAfterPut),
    ms: { sendToWaitSeen: clock.waiting - clock.sent, sendToRelease: clock.released - clock.sent, put: clock.putDone - clock.put,
      tableHeld: clock.released - clock.held, releaseToAnswer: clock.answered - clock.released },
  });
  // ---- assertions, in order: the conclusive window, then each safety property separately ----
  assert.ok(clock.released - clock.sent < CONCLUSIVE_WINDOW_MS,
    `INCONCLUSIVE: the create was in flight ${clock.released - clock.sent} ms when the table was released (limit ${CONCLUSIVE_WINDOW_MS} ms): a timeout could be the refusal`);
  assert.notEqual(reply.status, 422,
    `SAFETY (DA-210): the create answered the sealed ${reply.status} ${reply.body} AFTER the narrowing to View committed first — its completion committed: ${record.sealed}`);
  assertRefusal(reply, 503, 'service_unavailable', `${name}: refused inside the transaction, not sealed`);
  assert.equal(reason, 'transaction_unavailable', `${name}: refused, never a timeout`);
  assert.equal(record.exists && !record.sealed, true, `SAFETY: nothing sealed — the create's idempotency record has no response (${JSON.stringify(record)})`);
  assert.equal(record.leaseHeld, true, `SAFETY: the separately acquired lease is still held (${JSON.stringify(record)})`);
  assert.equal(retry.headers['idempotent-replayed'], undefined, `SAFETY: the same-key retry is never a replay (${retry.status} ${retry.body})`);
  assert.ok((retry.status === 403 && errorOf(retry) === 'forbidden') || (retry.status === 409 && errorOf(retry) === 'request_in_progress'),
    `SAFETY: the same-key retry is the current authority's 403 or the lease's 409 (${retry.status} ${retry.body})`);
  assert.deepEqual(delta(after, mid), NOTHING, `SAFETY: no draft, line, audit record, event or completion since the narrowing committed`);
  assert.deepEqual(delta(afterRetry, after), NOTHING, 'SAFETY: the retry wrote nothing');
  assert.deepEqual(recordAfterRetry, record, 'SAFETY: the retry left the record as it was');
  assert.deepEqual(JSON.parse(put.body), { roleLevel: { roleId: role, domain: 'invoices', level: 'view', version: reviewed + 1 } }, `${name}: the PUT's own answer`);
  assert.deepEqual(withoutXmin(rolesAfterPut.versions), [{ role_id: role, domain: 'invoices', version: String(reviewed + 1) }],
    `SAFETY: the version rows are exactly the PUT's (${role} invoices ${reviewed + 1}), no other`);
  assert.deepEqual(rolesFinal, rolesAfterPut, 'SAFETY: the role and version rows exactly as the PUT wrote them (xmin included): the create wrote none');
  assert.equal((await owner`select count(*)::int as n from public.audit_event where action_id = 'tenant.role.level.update' and tenant_id = ${T}`)[0].n, 1, `${name}: the PUT's one audit record`);
  assert.equal((await counts([T], [{ key: putKey, principal: boss.principal }])).K, 1, `${name}: the PUT's own sealed completion`);
}

test('ICA-01 (AC-02 DA-210): an existing stored Invoices override — a manager\'s create waits at its customer read on entry A while the owner\'s PUT narrows the manager\'s Invoices level from Create to View and commits on entry B; released, the create is never the sealed 422: the 503 transaction_unavailable, nothing sealed, the lease held, no draft, line, audit record or event, the role and version rows exactly the PUT\'s', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    for (const [name, customerExists] of [
      ['(a) DA-210 defect reproduction — missing customer', false],
      ['(b) the same ordering, existing customer', true],
    ]) {
      await t.test(name, (st) => narrowedWhileCreateWaits(st, { a, b, name: `ICA-01 ${name}`, role: 'manager', stored: 'create', customerExists }));
    }
  }));
});

test('ICA-02 (AC-03 DA-210): an absent override — a sales_staff\'s create (default Invoices Create, no stored row for that role and domain) waits at its customer read on entry A while the owner\'s PUT makes the role\'s FIRST Invoices row, View, and commits on entry B; released, the create is never the sealed 422: the 503 transaction_unavailable, nothing sealed, the lease held, nothing written, no role or version row but the PUT\'s own', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    for (const [name, customerExists] of [
      ['(a) DA-210 defect reproduction — first narrowing over the default', false],
      ['(b) the same ordering, existing customer', true],
    ]) {
      await t.test(name, (st) => narrowedWhileCreateWaits(st, { a, b, name: `ICA-02 ${name}`, role: 'sales_staff', stored: null, customerExists }));
    }
  }));
});

// ---------------------------------------------------------------------------
// the completion lever, the COMMIT trap and the replay shapes (invoiceDraftEditHttp's and invoiceDraftsHttp's)
// ---------------------------------------------------------------------------

/** The completion: the one UPDATE of an idempotency record that seals its response. */
const COMPLETION = 'old.response is null and new.response is not null';
/** The advisory key the parking trigger waits on (the two-int space: never the migration lock's bigint one, never 530030). */
const PARK = [531_031, 1];
/** The statement a create parked at its completion is in: the completion call. */
const AT_COMPLETION = /tmpos_internal\.m6_idempotency_complete\(/;
const holdPark = () => hold('the parking key', (sql) => sql`select pg_catalog.pg_advisory_xact_lock(${PARK[0]}::int, ${PARK[1]}::int)`);
const TRIGGER_ACTIONS = Object.freeze({
  park: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); return coalesce(new, old);`,
  /** Parks on PARK, and raises once the park is released: the command fails AFTER it has done everything but complete. */
  parkRaise: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); raise exception 'ICA injected fault' using errcode = 'P0001';`,
});
/**
 * `work` runs with ONE owner trigger BEFORE `event` on `table` for each row matching `when`: it counts itself on
 * ica_proof.fired (a sequence, so the count survives the rollback it causes), then parks on PARK (and raises, for parkRaise).
 * Dropped, with its function, whatever `work` did.
 */
async function withTrigger(table, event, when, action, work) {
  await owner.unsafe(`create function ica_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('ica_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function ica_proof.fire() from public');
  await owner.unsafe(`create trigger ica_fire before ${event} on ${table} for each row when (${when}) execute function ica_proof.fire()`);
  try { return await work(); } finally {
    await owner.unsafe(`drop trigger if exists ica_fire on ${table}`);
    await owner.unsafe('drop function if exists ica_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('ica_proof.fired'::regclass), 0)::int as n`)[0].n;
/** The guard key of (tenant, role) as the database computes it (migration 030): hashtext of 'tenant/role', an int4. */
const guardKey = async (tenant, role) => (await probe`select pg_catalog.hashtext(${tenant}::text || '/' || ${role}::text) as k`)[0].k;
/** The guard lock a create holds (ShareLock) or a level writer holds or waits for (ExclusiveLock) on (tenant, role). */
const guardLock = async (tenant, role, mode, granted = true) => ({ key: await guardKey(tenant, role), sub: 2, mode, granted });
/** Every advisory lock of the guard's class in the database, held or awaited by anyone. */
const guardLocksStanding = async () => (await probe`select count(*)::int as n from pg_catalog.pg_locks
  where locktype = 'advisory' and classid::int = 530030`)[0].n;
/** A case's own columns: its tenant's drafts, lines, create audit records and events, its keys' sealed completions. */
const mine = ({ D, L, A, O, K }) => ({ D, L, A, O, K });
const MINE_NOTHING = Object.freeze({ D: 0, L: 0, A: 0, O: 0, K: 0 });
/** Poll (bounded) until the OWNER sees `predicate` hold — what landed becomes visible; never a sleep for an outcome. */
async function until(predicate, label) {
  for (const end = Date.now() + WAIT_MS; Date.now() < end; await tick()) if (await predicate()) return;
  assert.fail(`${label}: not observed within ${WAIT_MS} ms`);
}
/** A 201: exactly { draft: { id, status, currency, lineCount, subtotalCents } } with its Location; the id. */
function createdOf(reply, store, { lineCount, subtotalCents }, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['draft'], label);
  assert.deepEqual(Object.keys(body.draft), ['id', 'status', 'currency', 'lineCount', 'subtotalCents'], label);
  assert.deepEqual({ ...body.draft, id: undefined }, { id: undefined, status: 'draft', currency: 'USD', lineCount, subtotalCents }, label);
  assert.match(body.draft.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `${label}: the runtime's v4 id`);
  assert.equal(reply.headers.location, `/api/v1/stores/${store}/invoice-drafts/${body.draft.id}`, `${label}: Location`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
  return body.draft.id;
}
const CUSTOMER_NOT_FOUND = '{"error":"customer_not_found"}';
/** The sealed 422, exactly (no correlator in its body). */
function notFoundOf(reply, label, { replayed = false } = {}) {
  assert.deepEqual([reply.status, reply.body, reply.headers.location], [422, CUSTOMER_NOT_FOUND, undefined], `${label}: the sealed 422`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
/** One draft's create effects, target-specifically: its header, lines, audit records and events. */
async function effectsOf(draft) {
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where draft_id = ${draft})::int as drafts,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft})::int as lines,
    (select count(*) from public.audit_event where action_id = ${ACTION} and subject_invoice_draft_id = ${draft})::int as audits,
    (select count(*) from tmpos_internal.outbox_event where event_type = ${EVENT} and aggregate_id = ${draft})::int as events`;
  return { ...r };
}
/** A tenant's drafts, lines, audit records naming them, their events and the records of `keys`, every column, row versions included. */
async function footprintOf(tenant, keys) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal)).sort();
  const [r] = await owner`select
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) || pg_catalog.jsonb_build_object('xmin', d.xmin::text) order by d.draft_id), '[]'::jsonb)
       from tmpos_invoice_draft.invoice_draft d where d.tenant_id = ${tenant}) as drafts,
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) || pg_catalog.jsonb_build_object('xmin', l.xmin::text) order by l.draft_id, l.position), '[]'::jsonb)
       from tmpos_invoice_draft.invoice_draft_line l where l.tenant_id = ${tenant}) as lines,
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) order by pg_catalog.to_jsonb(a)::text), '[]'::jsonb)
       from public.audit_event a where a.subject_invoice_draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = ${tenant})) as audit,
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by pg_catalog.to_jsonb(o)::text), '[]'::jsonb)
       from tmpos_internal.outbox_event o where o.aggregate_id in (select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = ${tenant})) as outbox,
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('response', i.response, 'xmin', i.xmin::text) order by i.scope), '[]'::jsonb)
       from tmpos_internal.idempotency_record i where i.scope = any(${scopes}::text[])) as records`;
  return { ...r };
}
/** The replay's bytes: status, body, Location and the replay marker. */
const bytesOf = (reply) => ({ status: reply.status, body: reply.body, location: reply.headers.location ?? null, contentType: reply.headers['content-type'] ?? null });

/** A real create's anchor: its audit INSERT (only an applied create writes one). */
const AUDIT_ANCHOR = Buffer.from('insert into public.audit_event');
const COMMIT_PARSE = Buffer.from('\0commit\0');
/**
 * Arm `relay` for the first connection that sends `anchor`: at its next COMMIT, `mode` 'lose' forwards the COMMIT (the server
 * commits) and drops every byte of the answer; 'cut' keeps the COMMIT from the server and severs the connection (the server
 * rolls back). release() disarms the trap and cuts a silenced connection.
 */
function trapCommit(relay, mode, anchor) {
  const hit = [];
  const carry = Math.max(anchor.length, COMMIT_PARSE.length) - 1;
  relay.state.trap = (pair, chunk) => {
    const window = pair.tail === undefined ? chunk : Buffer.concat([pair.tail, chunk]);
    pair.tail = window.subarray(Math.max(0, window.length - carry));
    let from = 0;
    const at = pair.anchored ? -1 : window.indexOf(anchor);
    if (at !== -1) {
      pair.anchored = true;
      from = at + anchor.length;
      pair.tail = window.subarray(Math.max(from, window.length - carry));
    }
    if (pair.anchored && window.indexOf(COMMIT_PARSE, from) !== -1) {
      hit.push(pair);
      relay.state.trap = null;
      if (mode === 'cut') return 'cut';
      pair.silenced = true;
    }
    return 'pass';
  };
  return {
    hit,
    release: () => {
      relay.state.trap = null;
      for (const pair of relay.state.pairs) { pair.anchored = false; pair.tail = undefined; }
      for (const pair of hit) pair.cut();
    },
  };
}

/** A tenant, a store, an existing customer, the operator under test (one store grant) and the owner (one tenant-scope grant). */
async function sceneOf(a, b, role, stored) {
  const tag = randomUUID().slice(0, 6);
  const T = await newTenant(`${role}-${tag}`);
  const S = await newStore(T, `ICA ${tag}`);
  const C = await newCustomer(T, `${role}-${tag}`);
  const operator = await actor(`op-${tag}`, [storeGrant(T, S, role)]);
  const boss = await actor(`boss-${tag}`, [tenantGrant(T, 'store_owner')]);
  if (stored !== null) await setLevel(T, role, 'invoices', stored);
  return { tag, T, S, C, operator, boss, so: await signIn(a, operator), sb: await signIn(b, boss) };
}
/** The version the owner reviews for `role`'s Invoices level, read through entry B (its pool warmed). */
async function reviewedOf(b, sb, role, label) {
  const read = await b.read(sb, '/api/v1/roles/levels/invoices');
  assert.equal(read.status, 200, `${label}: the owner reads the Invoices levels: ${read.body}`);
  return Number(JSON.parse(read.body).roles.find((r) => r.roleId === role).version);
}

// ===========================================================================
// ICA-03, ICA-04, ICA-08: the role's key held SHARED from step 10b to the end of the command transaction
// ===========================================================================

/**
 * One race at the create's completion. `role`'s Invoices level is `stored` (null: the catalog default) and authorizes the
 * create; the create (a missing or an existing customer) is sent on entry `a` and parked at its completion by the owner trigger
 * (`action` 'park', or 'parkRaise': the completion then raises); while it is parked the owner — a different operator, signed in
 * on entry `b` — sends the PUT setting `role`'s Invoices level to `putLevel`; the park is released. Every observation is
 * gathered and returned; nothing is asserted here but that the levers engaged (the callers assert, in order).
 */
async function parkedAtCompletion({ a, b, name, role, stored, customerExists, action, putLevel }) {
  const sc = await sceneOf(a, b, role, stored);
  const { tag, T, S, C, operator, boss, so, sb } = sc;
  const eligible = await a.eligibility(so, S);
  assert.deepEqual([eligible.status, eligible.body], [200, '{"eligibility":"allowed"}'], `${name}: the create is authorized before the race`);
  const reviewed = await reviewedOf(b, sb, role, name);
  const putBody = { roleId: role, domain: 'invoices', level: putLevel, reason: described(`${putLevel} ${tag}`), expectedTenant: T, expectedVersion: reviewed };
  const rolesBefore = await invoicesRowsOf(T);
  const body = saveBody(T, customerExists ? C : randomUUID(), [line(described(`create ${tag}`), 2, 5)]);
  const key = randomUUID();
  const keys = [{ key, principal: operator.principal }];
  const putKey = randomUUID();
  const scope = scopeOf(key, operator.principal);
  assert.match(scope, /^[A-Za-z0-9_-]+$/, 'the record scope is a digest, safe inside the trigger\'s predicate');
  const before = await counts([T], keys);
  const firedBefore = await fired();
  const clock = {};
  const o = { case: name, role, storedOverride: stored, customer: customerExists ? 'existing' : 'missing', action, putLevel,
    expectedKey: await guardKey(T, role) };
  let pending;
  let put;
  let putSettled = false;
  // Only THIS create's completion parks: the PUT's own completion (another scope) never fires the trigger.
  await withTrigger('tmpos_internal.idempotency_record', 'update', `${COMPLETION} and old.scope = '${scope}'`, action, async () => {
    const lever = await holdPark();
    try {
      clock.sent = Date.now();
      pending = quietly(a.save(so, S, body, { key }));
      o.createPid = waitingPid(await blockedOrSettled(pending, { by: lever.pid, query: AT_COMPLETION }), `${name}: the create parked at its completion`);
      clock.parked = Date.now();
      o.createGuard = await guardLocksOf(o.createPid);
      o.createWaits = await waitsOf(o.createPid);
      o.rolesParked = await invoicesRowsOf(T);
      o.deltaParked = delta(await counts([T], keys), before);
      // The owner's PUT on the OTHER entry, through the production chain.
      put = quietly(b.levels(sb, putBody, { key: putKey }));
      put.then(() => { putSettled = true; }, () => { putSettled = true; });
      const outcome = await blockedOrSettled(put, { by: o.createPid });
      if (outcome?.blocked) {
        o.putPid = outcome.blocked[0].pid;
        clock.putWaiting = Date.now();
        o.putBlockers = (await probe`select pg_catalog.pg_blocking_pids(${o.putPid}::int) as b`)[0].b;
        o.putWaits = await waitsOf(o.putPid);
        o.putGuard = await guardLocksOf(o.putPid);
      } else {
        o.putDidNotWait = outcome === null ? 'neither blocked nor settled' : (outcome.settled.value?.status ?? outcome.settled.error);
      }
      o.putAnsweredWhileParked = putSettled;
      clock.released = Date.now();
    } finally {
      await lever.commit();
      // Both answers are awaited INSIDE the trigger's scope: its DROP (ACCESS EXCLUSIVE on the idempotency table) must not
      // queue between a request's lease and its completion.
      if (pending !== undefined) { o.reply = await within(pending, `${name}: the create`); clock.answered = Date.now(); }
      if (put !== undefined) { o.putReply = await within(put, `${name}: the owner's PUT`); clock.putAnswered = Date.now(); }
    }
  });
  const after = await counts([T], keys);
  o.firedDelta = (await fired()) - firedBefore;
  o.deltaAll = delta(after, before);
  o.record = await recordOf(key, operator.principal);
  o.rolesAfter = await invoicesRowsOf(T);
  o.guardLocksStandingAfter = await guardLocksStanding();
  o.answer = typeof o.reply?.status === 'number' ? { status: o.reply.status, body: o.reply.body, reason: readReason(a, o.reply), replayed: o.reply.headers['idempotent-replayed'] ?? null } : o.reply;
  o.putAnswer = typeof o.putReply?.status === 'number' ? { status: o.putReply.status, body: o.putReply.body } : o.putReply;
  o.ms = { sendToParked: clock.parked - clock.sent, sendToPutWaiting: clock.putWaiting - clock.sent, sendToRelease: clock.released - clock.sent,
    releaseToAnswer: clock.answered - clock.released, releaseToPutAnswer: clock.putAnswered - clock.released };
  return { ...sc, role, o, clock, reviewed, rolesBefore, body, key, keys, putKey, before, after };
}

/** The key-hold contract, asserted in order: the window, the create's SHARED key, the PUT waiting for exactly that key. */
async function assertHeldThroughCompletion(r, name) {
  const { o, clock, T, role, rolesBefore } = r;
  assert.ok(clock.released - clock.sent < CONCLUSIVE_WINDOW_MS,
    `INCONCLUSIVE: ${name}: the create was in flight ${clock.released - clock.sent} ms when the park was released (limit ${CONCLUSIVE_WINDOW_MS} ms): a lock timeout could decide it`);
  assert.deepEqual(o.createGuard, [await guardLock(T, role, 'ShareLock')],
    `KEY: ${name}: parked at its completion, the create's backend holds the role's key SHARED (class 530030, objsubid 2, granted) — and nothing else of that class`);
  assert.ok(o.putPid !== undefined, `KEY: ${name}: the owner's PUT waits behind the create (it did not wait: ${o.putDidNotWait})`);
  assert.deepEqual(o.putBlockers, [o.createPid], `KEY: ${name}: pg_blocking_pids of the PUT's backend is exactly the create's backend`);
  assert.deepEqual(o.putWaits.map((w) => [w.locktype, w.mode]), [['advisory', 'ExclusiveLock']], `KEY: ${name}: the PUT waits for one advisory lock, EXCLUSIVE — nothing else`);
  assert.deepEqual(o.putGuard.filter((l) => !l.granted), [await guardLock(T, role, 'ExclusiveLock', false)], `KEY: ${name}: that lock is the role's key, ungranted`);
  assert.equal(o.putAnsweredWhileParked, false, `KEY: ${name}: the PUT has not answered while the create holds the key`);
  assert.deepEqual(o.rolesParked, rolesBefore, `${name}: parked, the committed role and version rows are as they were`);
  assert.equal(o.firedDelta, 1, `${name}: the parking trigger fired once — the create's own completion only`);
}
/** The PUT's own footprint: its answer, its one tenant-scope audit record, its own completion. */
async function assertPut(r, level, name) {
  const { o, T, role, reviewed, boss, putKey } = r;
  assert.ok(typeof o.putReply?.status === 'number', `${name}: the PUT answered: ${JSON.stringify(o.putReply)}`);
  assert.equal(o.putReply.status, 200, `${name}: the PUT commits after the create's transaction ended: ${o.putReply.body}`);
  assert.deepEqual(JSON.parse(o.putReply.body), { roleLevel: { roleId: role, domain: 'invoices', level, version: reviewed + 1 } }, `${name}: the PUT's own answer`);
  assert.deepEqual(withoutXmin(o.rolesAfter.versions), [{ role_id: role, domain: 'invoices', version: String(reviewed + 1) }], `${name}: the only version row is the PUT's`);
  assert.equal((await owner`select count(*)::int as n from public.audit_event where action_id = 'tenant.role.level.update' and tenant_id = ${T}`)[0].n, 1, `${name}: the PUT's one audit record`);
  assert.equal((await counts([T], [{ key: putKey, principal: boss.principal }])).K, 1, `${name}: the PUT's own sealed completion`);
}
/** After a narrowing PUT: a later create under a NEW key is the authorizer's 403 and writes nothing. */
async function assertLaterCreateRefused(r, a, name) {
  const { T, S, C, so } = r;
  const before = await counts([T]);
  assertRefusal(await a.save(so, S, saveBody(T, C, [line(described(`later ${r.tag}`), 1, 1)])), 403, 'forbidden', `${name}: a later create meets the narrowing`);
  assert.deepEqual(mine(delta(await counts([T]), before)), MINE_NOTHING, `${name}: and wrote nothing`);
}

test('ICA-03 (AC-04, N): an authorized customer_not_found holds the role\'s key through its completion — parked there, the create\'s backend holds the key SHARED and the owner\'s PUT narrowing the role to View waits for exactly that key; released, the sealed 422 commits (its completion only, no role row), then the PUT is the 200, and a later create is the authorizer\'s 403', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    for (const [name, role, stored] of [['(a) an existing override (manager, stored Create)', 'manager', 'create'], ['(b) an absent override (sales_staff, the default Create)', 'sales_staff', null]]) {
      await t.test(name, async (st) => {
        const label = `ICA-03 ${name}`;
        const r = await parkedAtCompletion({ a, b, name: label, role, stored, customerExists: false, action: 'park', putLevel: 'view' });
        evidence(st, { ...r.o, reply: undefined, putReply: undefined });
        await assertHeldThroughCompletion(r, label);
        assert.ok(typeof r.o.reply?.status === 'number', `${label}: the create answered: ${JSON.stringify(r.o.reply)}`);
        notFoundOf(r.o.reply, label);
        assert.equal(r.o.record.sealed, true, `${label}: its completion committed (the record sealed)`);
        assert.deepEqual(mine(r.o.deltaAll), { ...MINE_NOTHING, K: 1 }, `${label}: the completion only — no draft, line, audit record or event`);
        await assertPut(r, 'view', label);
        assert.deepEqual(withoutXmin(r.o.rolesAfter.roles), [{ role_id: role, domain: 'invoices', level: 'view' }], `${label}: the only role row is the PUT's: the create made none`);
        assert.equal(r.o.guardLocksStandingAfter, 0, `${label}: no guard lock stands`);
        await assertLaterCreateRefused(r, a, label);
      });
    }
  }));
});

test('ICA-04 (AC-05, N): a successful create holds the role\'s key through its completion — parked there with the key SHARED while the owner\'s PUT waits for exactly that key; released, the 201 commits exactly one draft, its line, one audit record, one event and the completion (its only role row the Customers NULL anchor), then the PUT is the 200, and a later create is the authorizer\'s 403', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    for (const [name, role, stored] of [['(a) an existing override (manager, stored Create)', 'manager', 'create'], ['(b) an absent override (sales_staff, the default Create)', 'sales_staff', null]]) {
      await t.test(name, async (st) => {
        const label = `ICA-04 ${name}`;
        const r = await parkedAtCompletion({ a, b, name: label, role, stored, customerExists: true, action: 'park', putLevel: 'view' });
        r.o.draft = r.o.reply?.status === 201 ? JSON.parse(r.o.reply.body).draft.id : null;
        r.o.effects = r.o.draft === null ? null : await effectsOf(r.o.draft);
        evidence(st, { ...r.o, reply: undefined, putReply: undefined });
        await assertHeldThroughCompletion(r, label);
        assert.ok(typeof r.o.reply?.status === 'number', `${label}: the create answered: ${JSON.stringify(r.o.reply)}`);
        const id = createdOf(r.o.reply, r.S, { lineCount: 1, subtotalCents: 10 }, `${label}: the 201 under the authority it held`);
        assert.equal(r.o.record.sealed, true, `${label}: its completion committed (the record sealed)`);
        assert.deepEqual(r.o.effects, { drafts: 1, lines: 1, audits: 1, events: 1 }, `${label}: exactly that draft, its line, one audit record and one event`);
        assert.deepEqual(mine(r.o.deltaAll), { D: 1, L: 1, A: 1, O: 1, K: 1 }, `${label}: and nothing else of the tenant's`);
        assert.equal((await owner`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = ${r.T}`)[0].draft_id, id, `${label}: the tenant's one draft is the answered one`);
        await assertPut(r, 'view', label);
        assert.deepEqual(withoutXmin(r.o.rolesAfter.roles), [{ role_id: role, domain: 'customers', level: null }, { role_id: role, domain: 'invoices', level: 'view' }],
          `${label}: the create's only role row is the Customers NULL anchor (no Invoices anchor); the Invoices row is the PUT's`);
        assert.equal(r.o.guardLocksStandingAfter, 0, `${label}: no guard lock stands`);
        await assertLaterCreateRefused(r, a, label);
      });
    }
  }));
});

test('ICA-08 (AC-09, N): the completion fails while the create holds the role\'s key and the owner\'s PUT waits for it — the 503, rolled back: no draft, line, audit record, event, completion or role row of the create; the lease held (the same-key retry the 409 request_in_progress); the key gone with that transaction, so the waiting PUT commits its 200', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    for (const [name, customerExists] of [['(a) an applied create', true], ['(b) a customer_not_found', false]]) {
      await t.test(name, async (st) => {
        const label = `ICA-08 ${name}`;
        // The PUT WIDENS the manager's Invoices level (Create -> Edit): the create stays authorized afterwards, so the same-key
        // retry meets the lease (the 409), not the authorizer.
        const r = await parkedAtCompletion({ a, b, name: label, role: 'manager', stored: 'create', customerExists, action: 'parkRaise', putLevel: 'edit' });
        evidence(st, { ...r.o, reply: undefined, putReply: undefined });
        await assertHeldThroughCompletion(r, label);
        assert.ok(typeof r.o.reply?.status === 'number', `${label}: the create answered: ${JSON.stringify(r.o.reply)}`);
        assertRefusal(r.o.reply, 503, 'service_unavailable', `${label}: the completion raised`);
        assert.notEqual(r.o.answer.reason, 'transaction_timeout', `${label}: the injected fault, not a lock timeout`);
        assert.deepEqual(mine(r.o.deltaAll), MINE_NOTHING, `${label}: rolled back — no draft, line, audit record, event or completion`);
        assert.deepEqual(r.o.record, { exists: true, sealed: false, leaseHeld: true }, `${label}: the separately acquired lease is held, nothing sealed`);
        await assertPut(r, 'edit', label);
        assert.deepEqual(withoutXmin(r.o.rolesAfter.roles), [{ role_id: 'manager', domain: 'invoices', level: 'edit' }], `${label}: the only role row is the PUT's (the create's anchor went with its rollback)`);
        assert.equal(r.o.guardLocksStandingAfter, 0, `${label}: no guard lock stands`);
        const before = await counts([r.T], r.keys);
        assertRefusal(await a.save(r.so, r.S, r.body, { key: r.key }), 409, 'request_in_progress', `${label}: the same-key retry within the lease`);
        assert.deepEqual(delta(await counts([r.T], r.keys), before), NOTHING, `${label}: the retry wrote nothing`);
      });
    }
  }));
});

// ===========================================================================
// ICA-09: replay and current authority
// ===========================================================================

test('ICA-09 (AC-10, G): a sealed 422 and a sealed 201 replay byte for byte; after the owner\'s PUT narrows the role, the same-key replay is the authorizer\'s 403; restored, the replay returns the stored bytes; another body under either key is the 422 idempotency_key_reused; nothing new written', async () => {
  await withEntry((a) => withEntry(async (b) => {
    const { tag, T, S, C, operator, so, sb } = await sceneOf(a, b, 'manager', 'create');
    const missing = saveBody(T, randomUUID(), [line(described(`replay missing ${tag}`), 1, 5)]);
    const real = saveBody(T, C, [line(described(`replay real ${tag}`), 3, 7)]);
    const k422 = randomUUID();
    const k201 = randomUUID();
    const keys = [{ key: k422, principal: operator.principal }, { key: k201, principal: operator.principal }];
    const before = await counts([T], keys);
    const sealed422 = await a.save(so, S, missing, { key: k422 });
    notFoundOf(sealed422, 'the sealed 422');
    const sealed201 = await a.save(so, S, real, { key: k201 });
    createdOf(sealed201, S, { lineCount: 1, subtotalCents: 21 }, 'the sealed 201');
    assert.deepEqual(mine(delta(await counts([T], keys), before)), { D: 1, L: 1, A: 1, O: 1, K: 2 }, 'one draft and two completions');
    const footprint = await footprintOf(T, keys);
    const replays = async (label) => {
      for (const [body, key, original] of [[missing, k422, sealed422], [real, k201, sealed201]]) {
        const replay = await a.save(so, S, body, { key });
        assert.deepEqual(bytesOf(replay), bytesOf(original), `${label}: key ${key === k422 ? '422' : '201'} replays the stored bytes`);
        assert.equal(replay.headers['idempotent-replayed'], 'true', `${label}: marked replayed`);
        assertBaseline(replay, label);
      }
    };
    await replays('under the authority they were sealed under');
    // The owner narrows the manager's Invoices level to View: a key is no authority.
    const reviewed = await reviewedOf(b, sb, 'manager', 'ICA-09');
    const narrowed = await b.levels(sb, { roleId: 'manager', domain: 'invoices', level: 'view', reason: described(`narrow ${tag}`), expectedTenant: T, expectedVersion: reviewed });
    assert.equal(narrowed.status, 200, `the narrowing: ${narrowed.body}`);
    for (const [body, key] of [[missing, k422], [real, k201]]) {
      const refused = await a.save(so, S, body, { key });
      assertRefusal(refused, 403, 'forbidden', 'the same-key replay without current authority');
      assert.equal(refused.headers['idempotent-replayed'], undefined, 'never a replay');
    }
    // Restored (the owner's second PUT), the stored bytes come back.
    const restored = await b.levels(sb, { roleId: 'manager', domain: 'invoices', level: 'create', reason: described(`restore ${tag}`), expectedTenant: T, expectedVersion: reviewed + 1 });
    assert.equal(restored.status, 200, `the restoration: ${restored.body}`);
    await replays('restored');
    assertRefusal(await a.save(so, S, { ...missing, lines: [line(described(`changed ${tag}`), 1, 5)] }, { key: k422 }), 422, 'idempotency_key_reused', 'another body under the 422\'s key');
    assertRefusal(await a.save(so, S, { ...real, lines: [line(described(`changed ${tag}`), 3, 7)] }, { key: k201 }), 422, 'idempotency_key_reused', 'another body under the 201\'s key');
    assert.deepEqual(await footprintOf(T, keys), footprint, 'nothing new written: drafts, lines, audit records, events and both records exactly as sealed (row versions included)');
    assert.deepEqual(mine(delta(await counts([T], keys), before)), { D: 1, L: 1, A: 1, O: 1, K: 2 }, 'still one draft and two completions');
  }));
});

// ===========================================================================
// ICA-12: the lost COMMIT acknowledgement under the guarded routine
// ===========================================================================

test('ICA-12 (AC-11, G/N): [N] parked at its completion BEFORE its COMMIT is sent, the create\'s backend holds exactly the role\'s key SHARED (class 530030, objsubid 2, granted); released, [G] its COMMIT lands and the answer is lost — the 503 transaction_timeout at the commit deadline, the outcome unknown; what landed is whole (one draft, its line, one audit record, one event, the completion); the same-key retry replays it; no guard key stands afterwards and the owner\'s PUT then commits', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    const { tag, T, S, C, operator, so, sb } = await sceneOf(a, b, 'sales_staff', null);
    const reviewed = await reviewedOf(b, sb, 'sales_staff', 'ICA-12');
    const key = randomUUID();
    const keys = [{ key, principal: operator.principal }];
    const scope = scopeOf(key, operator.principal);
    assert.match(scope, /^[A-Za-z0-9_-]+$/, 'the record scope is a digest, safe inside the trigger\'s predicate');
    const body = saveBody(T, C, [line(described(`lost answer ${tag}`), 2, 50)]);
    const before = await counts([T], keys);
    const firedBefore = await fired();
    const o = { expectedKey: await guardKey(T, 'sales_staff') };
    const clock = {};
    const trap = trapCommit(a.relay, 'lose', AUDIT_ANCHOR);
    let reply;
    try {
      // The create parks at its own completion (the trigger's scope), observed there BEFORE its COMMIT is sent; released, it
      // completes and sends the COMMIT, which the trap forwards and whose answer it drops.
      await withTrigger('tmpos_internal.idempotency_record', 'update', `${COMPLETION} and old.scope = '${scope}'`, 'park', async () => {
        const lever = await holdPark();
        let pending;
        try {
          clock.sent = Date.now();
          pending = quietly(a.save(so, S, body, { key }));
          o.createPid = waitingPid(await blockedOrSettled(pending, { by: lever.pid, query: AT_COMPLETION }), 'ICA-12: the create parked at its completion');
          o.createGuard = await guardLocksOf(o.createPid);
          o.commitsSentWhileParked = trap.hit.length;
          clock.released = Date.now();
        } finally {
          await lever.commit();
          // Awaited INSIDE the trigger's scope: its DROP must not queue between the create's lease and its completion.
          if (pending !== undefined) { reply = await within(pending, 'ICA-12: the create'); clock.answered = Date.now(); }
        }
      });
    } finally { trap.release(); }
    o.firedDelta = (await fired()) - firedBefore;
    o.ms = { sendToRelease: clock.released - clock.sent, sendToAnswer: clock.answered - clock.sent };
    evidence(t, o);
    assert.ok(clock.released - clock.sent < CONCLUSIVE_WINDOW_MS,
      `INCONCLUSIVE: ICA-12: the create was in flight ${clock.released - clock.sent} ms when the park was released (limit ${CONCLUSIVE_WINDOW_MS} ms): a lock timeout could decide it`);
    assert.equal(o.commitsSentWhileParked, 0, 'ICA-12: observed before the create\'s COMMIT was sent');
    assert.deepEqual(o.createGuard, [await guardLock(T, 'sales_staff', 'ShareLock')],
      'KEY: ICA-12: parked at its completion, before its COMMIT, the create\'s backend holds the role\'s key SHARED (class 530030, objsubid 2, granted) — and nothing else of that class');
    assert.equal(o.firedDelta, 1, 'ICA-12: the parking trigger fired once — the create\'s own completion only');
    assert.ok(typeof reply?.status === 'number', `ICA-12: the create answered: ${JSON.stringify(reply)}`);
    const elapsed = clock.answered - clock.sent;
    assert.equal(trap.hit.length, 1, 'one COMMIT reached the server, and its answer was dropped');
    assertRefusal(reply, 503, 'service_unavailable', 'the lost answer');
    assert.equal(a.reason(reply), 'transaction_timeout', 'unknown at the commit deadline');
    assert.ok(elapsed >= COMMAND_TRANSACTION_DEADLINE_MS - 50, `answered at the commit's own deadline (${elapsed} ms)`);
    await until(async () => (await counts([T], keys)).K === before.K + 1, 'the landed create');
    const landed = delta(await counts([T], keys), before);
    assert.deepEqual(landed, { D: 1, L: 1, A: 1, O: 1, K: 1, AA: 1, OO: 1, C: 1, LE: 0 }, 'what committed is visible, whole: one draft, its line, one audit record, one event, the completion');
    const [{ draft_id: landedId }] = await owner`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = ${T}`;
    assert.deepEqual(await effectsOf(landedId), { drafts: 1, lines: 1, audits: 1, events: 1 }, 'all of it the landed draft\'s');
    const replay = await a.save(so, S, body, { key });
    assert.equal(createdOf(replay, S, { lineCount: 1, subtotalCents: 100 }, 'the same-key retry replays what landed', { replayed: true }), landedId);
    assert.deepEqual(delta(await counts([T], keys), before), landed, 'never a second draft, audit record or event');
    assert.equal(await guardLocksStanding(), 0, 'no guard key stands after the landed COMMIT');
    const put = await replyTo(b.levels(sb, { roleId: 'sales_staff', domain: 'invoices', level: 'view', reason: described(`after ${tag}`), expectedTenant: T, expectedVersion: reviewed }), 'the owner\'s PUT');
    assert.equal(put.status, 200, `the owner's PUT commits: nothing holds the role's key: ${put.body}`);
  }));
});
