// Phase 4.0 M7B-INVOICES-ISSUE-P1 — a store's issuing settings END TO END: the tenant entry (server/entry/tenantEntry.ts,
// startTenantEntry) serving GET and PUT /api/v1/issuing-settings/{storeId} over REAL loopback HTTP and a disposable
// PostgreSQL holding every migration in the directory (001-034), composed exactly as server/entry/tenantMain.ts composes it
// but for its construction. The route module (server/runtime/issuingSettings.ts), the owner-only tenant authorizer and
// revalidator (edit_issuing_settings, recent sign-in on the write), the tenant command transaction, the write's mutator and the
// read's adapter (server/persistence/postgresInvoiceIssuing.ts), migration 034's routines (m7b_issuing_settings_get/_set), the
// audit writer (subject_store_id) and the idempotency kernel are production's own code. Every setting is written through the
// production PUT; the one issue (ISH-03) goes through the production preview and POST on a draft saved by the production POST.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — tests/db/invoiceDraftDiscardHttp.integration.test.mjs's three, none on the path under
// test: the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime LOGIN,
// tmpos_ish_probe, holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay), the identity verifier (a
// synthetic bearer-token map, whose authentication time a case may age or pin) and the listener (127.0.0.1:0). Lock holds are
// OWNER transactions (test-only levers).
//
// WHAT IS PROVEN (each title carries the pack's ISS ids — docs/phase-4/12 §7, §10 — and the brief's AC ids; ST/SV/CT/CN are a
// case's tenants' settings rows, the sum of their versions, counter rows and the sum of their numbers, I/X issued invoices and
// issued drafts, A/IA settings-write and issue audit records, K the sealed completions of its keys; AA/OO/C/LE every audit
// record, outbox row, completed idempotency record and open lease in the database — the cases run one at a time — all read by
// the OWNER as deltas).
//   ISH-01 the owner's first write and the reads around it.     ISH-02 who may read and write, and which stores.
//   ISH-03 versions, preconditions and a stale issue review.    ISH-04 two concurrent first writes.
//   ISH-05 every body shape §10.4 names.                        ISH-06 the audit record, and the deadline judged after a wait.
//   ISH-07 the 8 KiB bound and the media type on real sockets.  ISH-08 no log line carries a secret (run last).
//   ISH-09 a revocation committed while the write waits at 016's hold: the 503 before the write's lock bound, then the 401.
//
// DETERMINISTIC WAITS ONLY: a request is known to wait by pg_stat_activity (a Lock wait, its blocker named); ISH-06 schedules
// its sends on the wall clock relative to a recent-sign-in deadline 3-4 s away (roleLevels' M7RLH-09 pattern), never sleeping
// for an outcome.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Synthetic data only. Before it
// finishes it removes, in ONE owner transaction with the guards lifted and put back in the mode they were found in, every
// settings row, counter, issued invoice and line, draft and line of its tenants and the settings and issue audit records of its
// tenants (034's down refuses while any exists), with its role rows, sessions, mint-ledger rows, idempotency records, draft
// events and login, and restores the limiter fingerprint and issuer key row it found; then it checks that none is left
// anywhere and that every guard is ALWAYS again.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { RECENT_AUTH_MAX_AGE_MS, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring, IDEMPOTENCY_POLICY } from '../../server/runtime/idempotency.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';
import { PORT_DEADLINE_MS } from '../../server/runtime/deadline.ts';
import { ISSUING_SETTINGS_MAX_BODY_BYTES } from '../../server/runtime/issuingSettings.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'ish-migrator', runtimeRef: 'ish-runtime' };
const LOCK_KEY = 529_536;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ish_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';
/** The settings write's audit action and permission (its contract's kind and requirement), and the issue's action, as literals. */
const ACTION = 'tenant.issuing_settings.update';
const PERMISSION = 'edit_issuing_settings';
const ISSUE_ACTION = 'store.invoice.issue';
const BOUND = 8192; // ISSUING_SETTINGS_MAX_BODY_BYTES, pinned here as a literal
const WAIT_MS = 10_000;
const SEND_TIMEOUT_MS = 20_000;
/** The settings write routine's statement: where a write waits for the per-store key or the settings row. */
const AT_SET = /tmpos_invoice_issue\.m7b_issuing_settings_set\(/;
const AT_HOLD = /m5_hold_tenant_standing/;
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });
/** A command's lock waits are bounded at 70 % of its transaction: an answer sooner than this after it was sent is no timeout. */
const COMMAND_LOCK_BOUND_MS = Math.floor(COMMAND_TRANSACTION_DEADLINE_MS * 0.7);
/** How long before the waiter's lock bound (waitstart + COMMAND_LOCK_BOUND_MS, database clock) a lever must release. */
const RELEASE_MARGIN_MS = 300;
/** ISH-06's schedule relative to the deadline (roleLevels' LAPSE): send 600 ms before it, release 150 ms after it. */
const LAPSE = Object.freeze({ send: 600, release: 150 });
assert.equal(IDEMPOTENCY_POLICY.leaseMs, 60_000, 'the idempotency lease the in-progress cases rely on');
assert.equal(ISSUING_SETTINGS_MAX_BODY_BYTES, BOUND, 'the write\'s body bound is 8 KiB');
assert.ok(COMMAND_TRANSACTION_DEADLINE_MS <= PORT_DEADLINE_MS);
assert.ok(PORT_DEADLINE_MS * 4 <= SEND_TIMEOUT_MS);
assert.ok(LAPSE.send + LAPSE.release < COMMAND_LOCK_BOUND_MS, 'ISH-06\'s wait ends inside a command\'s lock timeout');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('ISH');
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
/** 034's guards (no update, delete or truncate of settings, counters and issued rows) and 033/034's draft terminal guards. */
const GUARDS = [
  ['tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_guard'],
  ['tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_guard'],
  ['tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_commit_check'],
  ['tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_guard'],
  ['tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_guard'],
  ['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'],
  ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal'],
];

/** Everything issuing-related of this suite's tenants, in ONE owner transaction, the guards lifted only inside it. */
async function cleanIssuing() {
  if (TENANTS.length === 0) return;
  await owner.begin('isolation level read committed', async (sql) => {
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    await withTriggersLifted(sql, AUDIT_TRIGGER, async () => {
      await sql`delete from public.audit_event where action_id in (${ACTION}, ${ISSUE_ACTION}) and tenant_id = any(${TENANTS}::uuid[])`;
      if (drafts.length > 0) await sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`;
      await sql`update public.audit_event set subject_customer_id = null
        where subject_customer_id in (select customer_id from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]))`;
    });
    await withTriggersLifted(sql, GUARDS, async () => {
      await sql`delete from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${TENANTS}::uuid[])`;
      if (drafts.length > 0) {
        await sql`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = any(${drafts}::uuid[])`;
        await sql`delete from tmpos_invoice_draft.invoice_draft where draft_id = any(${drafts}::uuid[])`;
      }
    });
    // Every customer this file made (ISH-03's), after its drafts: 017's down refuses while any customer exists.
    await sql`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const open of [...OPEN]) await step(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
    await step(cleanIssuing);
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
    // The events ISH-03's draft save enqueued (a settings write enqueues none): no worker exists to take them.
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
      // Across the whole database: 034's down refuses while any of these exists, and later CI steps roll it back.
      const [state] = await owner`select
        (select count(*) from tmpos_invoice_issue.store_issuing_settings)::int as settings,
        (select count(*) from tmpos_invoice_issue.store_invoice_counter)::int as counters,
        (select count(*) from tmpos_invoice_issue.issued_invoice)::int as issued,
        (select count(*) from tmpos_invoice_issue.issued_invoice_line)::int as issued_lines,
        (select count(*) from tmpos_invoice_draft.invoice_draft where status = 'issued')::int as issued_drafts,
        (select count(*) from public.audit_event where subject_store_id is not null or subject_issued_invoice_id is not null)::int as store_or_invoice_subjects,
        (select count(*) from public.audit_event where action_id in (${ACTION}, ${ISSUE_ACTION}))::int as settings_or_issue_audits,
        (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
        (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors,
        (select count(*) from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]))::int as customers,
        (select pg_catalog.string_agg(g.tgname::text || ':' || g.tgenabled::text, ',' order by g.tgname) from pg_catalog.pg_trigger g
          where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass,
            'tmpos_invoice_issue.store_issuing_settings'::regclass, 'tmpos_invoice_issue.store_invoice_counter'::regclass,
            'tmpos_invoice_issue.issued_invoice'::regclass, 'tmpos_invoice_issue.issued_invoice_line'::regclass)
            and not g.tgisinternal and g.tgenabled <> 'A') as not_always,
        (select count(*) from public.schema_migrations where version = '034')::int as at034`;
      assert.deepEqual({ ...state }, {
        settings: 0, counters: 0, issued: 0, issued_lines: 0, issued_drafts: 0, store_or_invoice_subjects: 0, settings_or_issue_audits: 0,
        drafts: 0, anchors: 0, customers: 0, not_always: null, at034: 1,
      }, 'the database is at 034 with nothing that blocks its rollback, and every guard is ALWAYS again');
    });
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'ISH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'ISH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster (no trap is armed in this suite)
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket' ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) } : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-ish-relay-'));
  const pairs = new Set();
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); } };
    pairs.add(pair);
    client.on('data', (chunk) => db.write(chunk));
    db.on('data', (chunk) => client.write(chunk));
    for (const socket of [client, db]) { socket.on('error', pair.cut); socket.on('close', pair.cut); }
  });
  const path = join(dir, '.s.PGSQL.5432');
  const listening = new Promise((done) => server.listen(path, done));
  return {
    dir, listening,
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
  const [{ applied }] = await owner`select count(*)::int as applied from public.schema_migrations where version = '034'`;
  assert.equal(applied, 1, 'migration 034 (issuing) is applied');
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
});

// ---------------------------------------------------------------------------
// identity, configuration, requests
// ---------------------------------------------------------------------------

/** token -> { uid, authAgeMs? , authTimeSec? }: the provider's authentication time is now unless a case ages or pins it. */
const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) { const err = new Error('unknown_token'); err.code = 'auth/invalid-id-token'; throw err; }
    return { uid: rec.uid, authTime: rec.authTimeSec ?? Math.floor((Date.now() - (rec.authAgeMs ?? 0)) / 1000), secondFactor: 'totp' };
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
    type: 'service_account', project_id: 'ish-test-project', client_email: 'ish-test@ish-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
  }),
});

function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}
const ALL_LOG_LINES = [];
const SECRETS = new Set();

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
// fixtures — tenants, stores, customers and actors through the owner; every setting through the production PUT
// ---------------------------------------------------------------------------

async function newTenant(label, status = 'active') {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ish-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  SECRETS.add(id);
  return id;
}
async function newStore(tenant, name, status = 'active') {
  const id = (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`${name} ${SUFFIX}`}, ${status}) returning store_id`)[0].store_id;
  SECRETS.add(id);
  return id;
}
async function newCustomer(tenant, label) {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`ISH ${label} ${SUFFIX}`})`;
  SECRETS.add(id);
  return id;
}
async function actor(label, memberships, status = 'active') {
  const uid = `ish-${label}-${SUFFIX}`;
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
  SECRETS.add(token).add(uid).add(id);
  return { id, uid, token, label, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
/** A tenant, one active store and its owner (store_owner on one tenant grant: the owner rule). */
async function shop(label) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label} store`);
  const boss = await actor(`${label}-owner`, [tenantGrant(T, 'store_owner')]);
  return { T, S, boss };
}
/** Seller values no other run shares (each text registered as a log canary), every one already in its stored form. */
function sellerValues(label, over = {}) {
  const v = {
    legalName: `ISH ${label} Legal Seller ${SUFFIX}`, storeName: `ISH ${label} Shop ${SUFFIX}`,
    postalAddress: `1 ${label} Street ${SUFFIX}\nTown ${label} ${SUFFIX}`, taxRegistrationId: `TAX-${label}-${SUFFIX}`,
    tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 }, ...over,
  };
  for (const text of [v.legalName, v.storeName, v.taxRegistrationId, ...(typeof v.postalAddress === 'string' ? v.postalAddress.split('\n') : [])]) {
    if (typeof text === 'string' && text.includes(SUFFIX)) SECRETS.add(text.trim());
  }
  return v;
}
const putBody = (tenant, version, values) => ({ expectedTenant: tenant, expectedVersion: version, ...values });
const taxBody = (tax) => (tax.mode === 'none' ? { mode: 'none' } : { mode: 'exclusive_rate', rateMilliPercent: tax.rateMilliPercent });
/** The settings-read body (and the write's 200) of `values` at `version`, in viewBody's key order. */
const viewOf = (store, version, v) => ({ issuingSettings: {
  storeId: store, version, configured: true, legalName: v.legalName, storeName: v.storeName, postalAddress: v.postalAddress,
  taxRegistrationId: v.taxRegistrationId, tax: taxBody(v.tax),
} });
const noneView = (store) => ({ issuingSettings: { storeId: store, version: 0, configured: false } });

/**
 * What a case's tenants hold now — settings rows (ST), the sum of their versions (SV), counter rows (CT) and the sum of their
 * numbers (CN), issued invoices (I) and issued drafts (X), settings-write (A) and issue (IA) audit records — the sealed
 * completions of its keys (K), and, across the whole database, EVERY audit record (AA), outbox row (OO), completed idempotency
 * record (C) and open lease (LE).
 */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${tenants}::uuid[]))::int as st,
    (select coalesce(sum(version), 0) from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${tenants}::uuid[]))::int as sv,
    (select count(*) from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${tenants}::uuid[]))::int as ct,
    (select coalesce(sum(last_number), 0) from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${tenants}::uuid[]))::int as cn,
    (select count(*) from tmpos_invoice_issue.issued_invoice where tenant_id = any(${tenants}::uuid[]))::int as i,
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]) and status = 'issued')::int as x,
    (select count(*) from public.audit_event where action_id = ${ACTION} and tenant_id = any(${tenants}::uuid[]))::int as a,
    (select count(*) from public.audit_event where action_id = ${ISSUE_ACTION} and tenant_id = any(${tenants}::uuid[]))::int as ia,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from public.audit_event)::int as aa,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as c,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le`;
  return { ST: r.st, SV: r.sv, CT: r.ct, CN: r.cn, I: r.i, X: r.x, A: r.a, IA: r.ia, K: r.k, AA: r.aa, OO: r.oo, C: r.c, LE: r.le };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const NOTHING = Object.freeze({ ST: 0, SV: 0, CT: 0, CN: 0, I: 0, X: 0, A: 0, IA: 0, K: 0, AA: 0, OO: 0, C: 0, LE: 0 });
/** A rolled-back answer (or the planner's 400): nothing but the lease its key acquired, left open. */
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
/** A sealed refusal: its completion only. */
const COMPLETION_ONLY = Object.freeze({ ...NOTHING, K: 1, C: 1 });
/** A first write: one settings row at version 1, one counter at 0, one audit record, one completion — NO outbox row. */
const FIRST_WRITE = Object.freeze({ ...NOTHING, ST: 1, SV: 1, CT: 1, A: 1, K: 1, AA: 1, C: 1 });
/** A later write: the version up by one, one audit record, one completion — no row added, NO outbox row. */
const NEXT_WRITE = Object.freeze({ ...NOTHING, SV: 1, A: 1, K: 1, AA: 1, C: 1 });
/** The store's settings and counter rows as the OWNER reads them (row versions included). */
async function storedOf(store) {
  const [s] = await owner`select tenant_id, version::text as version, legal_name, store_name, postal_address, tax_registration_id, tax_mode, tax_rate,
    xmin::text as xmin from tmpos_invoice_issue.store_issuing_settings where store_id = ${store}`;
  const [k] = await owner`select last_number::text as last_number, xmin::text as xmin from tmpos_invoice_issue.store_invoice_counter where store_id = ${store}`;
  return { settings: s === undefined ? null : { ...s }, counter: k === undefined ? null : { ...k } };
}
const recordsOf = async (key, principal) => (await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`)[0].n;
async function leaseOpen(key, principal) {
  const [row] = await owner`select response is null as open from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`;
  return row?.open === true;
}
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
  const log = { log: (l) => { lines.push(l); ALL_LOG_LINES.push(l); } };
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
    SECRETS.add(key);
    if (s?.principal !== undefined) USED_KEYS.push({ key, principal: s.principal });
    return send(port, method, path, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), 'idempotency-key': key, ...headers,
    }, typeof body === 'string' ? body : JSON.stringify(body), { localAddress: from });
  };
  const ctx = {
    port, from, lines, stop,
    read: (s, path, headers = {}) => send(port, 'GET', path,
      { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers }, undefined, { localAddress: from }),
    settings: (s, store, query = '') => ctx.read(s, `/api/v1/issuing-settings/${store}${query}`),
    put: (s, store, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'PUT', `/api/v1/issuing-settings/${store}`, body, key, headers),
    save: (s, store, body, { key = randomUUID() } = {}) => unsafe(s, 'POST', `/api/v1/stores/${store}/invoice-drafts`, body, key, {}),
    preview: (s, store, draft) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/${draft}/issue-preview`),
    issue: (s, store, draft, body, { key = randomUUID() } = {}) => unsafe(s, 'POST', `/api/v1/stores/${store}/invoice-drafts/${draft}/issue`, body, key, {}),
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
async function signIn(ctx, who, { token = who.token } = {}) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const csrf = JSON.parse(reply.body).csrfToken;
  const key = createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
  KEYS.add(key);
  SECRETS.add(csrf).add(cookie.slice(cookie.indexOf('=') + 1)).add(key);
  return { cookie, csrf, key, principal: who.principal };
}
/** A 200 whose body is exactly `expected`'s JSON (viewBody's key order), replayed or not. */
function settledOf(reply, expected, label, { replayed = false } = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify(expected), `${label}: the exact body`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
/** A sealed 409: exactly { "error": word }, no correlator. */
function sealedOf(reply, word, label, { replayed = false } = {}) {
  assert.equal(reply.status, 409, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify({ error: word }), `${label}: the exact sealed body`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}

// ---------------------------------------------------------------------------
// levers
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
/** The settings write's per-store advisory key (class 530034), held EXCLUSIVE by the owner. */
const holdStoreKey = (store) => hold('the store key', (sql) => sql`select pg_catalog.pg_advisory_xact_lock(530034, pg_catalog.hashtext(${store}::text))`);
/** The store's settings row, held FOR SHARE by the owner (as an issue holds it). */
const holdSettings = (store) => hold('the settings row for share', (sql) => sql`select 1 from tmpos_invoice_issue.store_issuing_settings where store_id = ${store} for share`);
async function blockedNow({ by = null, query = null } = {}) {
  const rows = await probe`select pid, query, pg_blocking_pids(pid) as blockers from pg_stat_activity where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
  return rows.filter((r) => (query === null || query.test(r.query)) && (by === null || r.blockers.includes(by))).map((r) => ({ pid: r.pid, blockers: r.blockers }));
}
/** Until `n` runtime statements wait as `criteria` says, or `requests` all settled, or the bound: the waiters seen. */
async function waiters(n, criteria, requests) {
  let settled = 0;
  for (const r of requests) r.then(() => { settled += 1; }, () => { settled += 1; });
  for (const until = Date.now() + WAIT_MS; Date.now() < until; await tick()) {
    const hit = await blockedNow(criteria);
    if (hit.length >= n || settled === requests.length) return hit;
  }
  return blockedNow(criteria);
}
/** Milliseconds left on the database clock before `pid`'s one ungranted lock reaches its bound (waitstart + COMMAND_LOCK_BOUND_MS). */
async function lockBoundLeft(pid, label) {
  const rows = await probe`select (extract(epoch from l.waitstart + ${COMMAND_LOCK_BOUND_MS}::int * interval '1 millisecond'
    - pg_catalog.clock_timestamp()) * 1000)::float8 as left_ms from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted`;
  assert.equal(rows.length, 1, `${label}: exactly one lock awaited`);
  assert.equal(typeof rows[0].left_ms, 'number', `${label}: its waitstart recorded`);
  return rows[0].left_ms;
}
async function replyTo(request, label) {
  const reply = await within(request, label);
  assert.ok(typeof reply?.status === 'number', `no reply to ${label} within ${WAIT_MS} ms: ${JSON.stringify(reply)}`);
  return reply;
}

// ===========================================================================
// ISH-01: the owner's first write and the reads around it
// ===========================================================================

test('ISH-01 (ISS-25, AC-02): the owner on a tenant grant with a recent sign-in — the read before any write is version 0, configured false; the first PUT at expectedVersion 0 is the 200 at version 1 with the normalized values (edge spaces trimmed, each address line trimmed), creating one settings row and the store\'s counter at 0 with one audit record, one completion and no outbox row; the read returns exactly that; the same key and bytes replay byte for byte writing nothing; the same key with other bytes is the 422', async () => {
  const { T, S, boss } = await shop('ish01');
  await withEntry(async (ctx) => {
    const o = await signIn(ctx, boss);
    let before = await counts([T]);
    settledOf(await ctx.settings(o, S), noneView(S), 'the read before any write');
    assert.deepEqual(delta(await counts([T]), before), NOTHING, 'a read writes nothing');
    assert.deepEqual(await storedOf(S), { settings: null, counter: null }, 'no settings and no counter yet');

    const stored = sellerValues('ish01');
    const [line1, line2] = stored.postalAddress.split('\n');
    const sent = { ...stored, legalName: `  ${stored.legalName}  `, storeName: ` ${stored.storeName} `, postalAddress: `  ${line1}   \n   ${line2}  `, taxRegistrationId: `   ${stored.taxRegistrationId} ` };
    const key = randomUUID();
    const keys = [{ key, principal: boss.principal }];
    before = await counts([T], keys);
    const first = await ctx.put(o, S, putBody(T, 0, sent), { key });
    settledOf(first, viewOf(S, 1, stored), 'the first write');
    assert.deepEqual(delta(await counts([T], keys), before), FIRST_WRITE, 'one settings row at v1, one counter, one audit record, one completion, no outbox row');
    const row = await storedOf(S);
    const { xmin: _xmin, ...settingsRow } = row.settings;
    assert.deepEqual(settingsRow, {
      tenant_id: T, version: '1', legal_name: stored.legalName, store_name: stored.storeName, postal_address: stored.postalAddress,
      tax_registration_id: stored.taxRegistrationId, tax_mode: 'exclusive_rate', tax_rate: 8875,
    }, 'the stored row holds the normalized values');
    assert.equal(row.counter?.last_number, '0', 'the store\'s counter is created at 0');

    before = await counts([T], keys);
    settledOf(await ctx.settings(o, S), viewOf(S, 1, stored), 'the read after the write');
    const again = await ctx.put(o, S, putBody(T, 0, sent), { key });
    settledOf(again, viewOf(S, 1, stored), 'the same key and bytes', { replayed: true });
    assert.equal(again.body, first.body, 'byte-identical');
    assertRefusal(await ctx.put(o, S, putBody(T, 0, { ...sent, legalName: `${stored.legalName} other` }), { key }), 422, 'idempotency_key_reused', 'the same key, another body');
    assert.deepEqual(delta(await counts([T], keys), before), NOTHING, 'the read, the replay and the 422 write nothing');
    assert.deepEqual(await storedOf(S), row, 'the rows as they were, xmin included');
  });
});

// ===========================================================================
// ISH-02: who may read and write, and which stores
// ===========================================================================

test('ISH-02 (ISS-25, AC-02, AC-03): a manager on a tenant grant, a store_owner on only a store grant and a read-only tenant\'s owner are refused 403 on the read and the write (the write before any key); a stale sign-in is the 403 step_up_required on the PUT while its GET still answers; another tenant\'s store, a missing store and a suspended store are the 404 on the read and the rolled-back 404 on the write (its lease only); a read_only store reads (version 0) but is the write\'s 404; nothing else is written in any case, and the owner then writes', async (t) => {
  const { T, S, boss } = await shop('ish02');
  const mgr = await actor('ish02-mgr', [tenantGrant(T, 'manager')]);
  const storeOwner = await actor('ish02-so', [storeGrant(T, S, 'store_owner')]);
  const TR = await newTenant('ish02ro', 'read_only');
  const SR = await newStore(TR, 'ish02 ro tenant store');
  const roOwner = await actor('ish02-roowner', [tenantGrant(TR, 'store_owner')]);
  const { S: S2 } = await shop('ish02other');
  const suspended = await newStore(T, 'ish02 suspended', 'suspended');
  const readOnlyStore = await newStore(T, 'ish02 read only', 'read_only');
  const stale = `${boss.token}-stale`;
  TOKENS.set(stale, { uid: boss.uid, authAgeMs: RECENT_AUTH_MAX_AGE_MS + 60_000 });
  const values = sellerValues('ish02');
  await withEntry(async (ctx) => {
    const sessions = { mgr: await signIn(ctx, mgr), storeOwner: await signIn(ctx, storeOwner), roOwner: await signIn(ctx, roOwner) };
    const o = await signIn(ctx, boss);
    const oStale = await signIn(ctx, boss, { token: stale });
    const tenants = [T, TR];
    // (1) Not the owner rule: the 403 on both; the write refused before any key.
    for (const [label, s, tenant, store] of [['a manager on a tenant grant', sessions.mgr, T, S], ['a store_owner on only a store grant', sessions.storeOwner, T, S],
      ['a read-only tenant\'s owner', sessions.roOwner, TR, SR]]) {
      const key = randomUUID();
      const before = await counts(tenants, [{ key, principal: s.principal }]);
      const read = await ctx.settings(s, store);
      assertRefusal(read, 403, 'forbidden', `${label}: the read`);
      const write = await ctx.put(s, store, putBody(tenant, 0, values), { key });
      assertRefusal(write, 403, 'forbidden', `${label}: the write`);
      assert.deepEqual(delta(await counts(tenants, [{ key, principal: s.principal }]), before), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(key, s.principal), 0, `${label}: refused before any key`);
      evidence(t, { case: label, read: ctx.reason(read), write: ctx.reason(write) });
    }
    // (2) A stale sign-in: the read answers; the write is the step-up refusal before any key.
    let key = randomUUID();
    let before = await counts([T], [{ key, principal: boss.principal }]);
    settledOf(await ctx.settings(oStale, S), noneView(S), 'a stale sign-in still reads');
    assertRefusal(await ctx.put(oStale, S, putBody(T, 0, values), { key }), 403, 'step_up_required', 'a stale sign-in writes');
    assert.deepEqual(delta(await counts([T], [{ key, principal: boss.principal }]), before), NOTHING, 'the stale write: nothing written');
    assert.equal(await recordsOf(key, boss.principal), 0, 'the stale write: refused before any key');
    // (3) Stores that are not a readable (read) or writable (write) store of the owner's tenant: one 404 each way.
    const reasons = { read: new Set(), write: new Set() };
    for (const [label, store, readable] of [['another tenant\'s store', S2, false], ['a missing store', randomUUID(), false], ['a suspended store', suspended, false],
      ['a read_only store', readOnlyStore, true]]) {
      key = randomUUID();
      const keys = [{ key, principal: boss.principal }];
      before = await counts([T], keys);
      const read = await ctx.settings(o, store);
      if (readable) settledOf(read, noneView(store), `${label}: the read`);
      else { assertRefusal(read, 404, 'not_found', `${label}: the read`); reasons.read.add(ctx.reason(read)); }
      const write = await ctx.put(o, store, putBody(T, 0, values), { key });
      assertRefusal(write, 404, 'not_found', `${label}: the write`);
      reasons.write.add(ctx.reason(write));
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: rolled back — nothing but the open lease`);
      assert.equal(await leaseOpen(key, boss.principal), true, `${label}: the lease open`);
      assertRefusal(await ctx.put(o, store, putBody(T, 0, values), { key }), 409, 'request_in_progress', `${label}: the same key within the lease`);
      assert.deepEqual(await storedOf(store), { settings: null, counter: null }, `${label}: no settings or counter`);
    }
    assert.deepEqual([...reasons.read], ['issuing_settings_store_not_found'], 'one logged reason for every read 404');
    assert.equal(reasons.write.size, 1, `one logged reason for every write 404: ${[...reasons.write]}`);
    evidence(t, { writeNotFoundReason: [...reasons.write][0] });
    // (4) The control: the owner, recent, at the active store.
    key = randomUUID();
    before = await counts([T], [{ key, principal: boss.principal }]);
    settledOf(await ctx.put(o, S, putBody(T, 0, values), { key }), viewOf(S, 1, values), 'the owner writes');
    assert.deepEqual(delta(await counts([T], [{ key, principal: boss.principal }]), before), FIRST_WRITE, 'the owner\'s first write');
  });
});

// ===========================================================================
// ISH-03: versions, preconditions and a stale issue review
// ===========================================================================

test('ISH-03 (ISS-25, AC-02): a first write when settings exist and a stale or future version are the sealed 409 write_conflict (its completion only), replayed byte for byte under their keys; an expectedTenant not the owner\'s is the unsealed 409 (lease kept, no completion); every accepted write moves the version by one even with identical values; a change away and back gives v3, and an issue whose preview was reviewed at v1 is then the sealed 409 write_conflict — no invoice, no number, the draft still open', async () => {
  const { T, S, boss } = await shop('ish03');
  const { T: T2 } = await shop('ish03other');
  const issuer = await actor('ish03-issuer', [storeGrant(T, S, 'store_owner')]);
  const C = await newCustomer(T, 'ish03');
  const A = sellerValues('ish03a');
  const B = sellerValues('ish03b', { tax: { mode: 'none' } });
  await withEntry(async (ctx) => {
    const o = await signIn(ctx, boss);
    const si = await signIn(ctx, issuer);
    const write = async (label, version, values, expectedDelta) => {
      const key = randomUUID();
      const keys = [{ key, principal: boss.principal }];
      const before = await counts([T], keys);
      const reply = await ctx.put(o, S, putBody(T, version, values), { key });
      settledOf(reply, viewOf(S, version + 1, values), label);
      assert.deepEqual(delta(await counts([T], keys), before), expectedDelta, `${label}: one new version`);
      return reply;
    };
    const sealedConflict = async (label, version) => {
      const key = randomUUID();
      const keys = [{ key, principal: boss.principal }];
      const row = await storedOf(S);
      let before = await counts([T], keys);
      const reply = await ctx.put(o, S, putBody(T, version, A), { key });
      sealedOf(reply, 'write_conflict', label);
      assert.deepEqual(delta(await counts([T], keys), before), COMPLETION_ONLY, `${label}: its completion only`);
      before = await counts([T], keys);
      const again = await ctx.put(o, S, putBody(T, version, A), { key });
      sealedOf(again, 'write_conflict', `${label}: replayed`, { replayed: true });
      assert.equal(again.body, reply.body, `${label}: byte-identical`);
      assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: the replay writes nothing`);
      assert.deepEqual(await storedOf(S), row, `${label}: the settings and counter as they were`);
    };
    await write('v1 = A', 0, A, FIRST_WRITE);
    await sealedConflict('a first write when settings exist', 0);
    // The issuer saves a draft and reviews its preview at settings v1.
    const saved = await ctx.save(si, S, { expectedTenant: T, customerId: C, currency: 'USD', lines: [{ description: `ISH ish03 line ${SUFFIX}`, quantity: 1, unitPriceCents: 1999 }] });
    assert.equal(saved.status, 201, `the draft save: ${saved.body}`);
    const draft = JSON.parse(saved.body).draft.id;
    SECRETS.add(draft);
    const preview = await ctx.preview(si, S, draft);
    assert.equal(preview.status, 200, `the preview at v1: ${preview.body}`);
    const reviewed = JSON.parse(preview.body).preview.expected;
    assert.deepEqual({ tenant: reviewed.expectedTenant, version: reviewed.expectedVersion, settings: reviewed.expectedSettingsVersion }, { tenant: T, version: 1, settings: 1 }, 'the review names settings v1');
    // Away and back: v2 = B, v3 = A (the values v1 held), v4 = A again (identical): each a new version.
    await write('v2 = B (change away)', 1, B, NEXT_WRITE);
    await write('v3 = A (change back)', 2, A, NEXT_WRITE);
    const key = randomUUID();
    const keys = [{ key, principal: issuer.principal }];
    const draftBefore = (await owner`select status, version::text as version, xmin::text as xmin from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`)[0];
    let before = await counts([T], keys);
    sealedOf(await ctx.issue(si, S, draft, reviewed, { key }), 'write_conflict', 'the issue reviewed at v1, now at v3');
    assert.deepEqual(delta(await counts([T], keys), before), COMPLETION_ONLY, 'the stale issue: its completion only — no invoice, number, issued draft or audit record');
    assert.deepEqual((await owner`select status, version::text as version, xmin::text as xmin from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`)[0], draftBefore, 'the draft still open, untouched');
    assert.equal((await storedOf(S)).counter.last_number, '0', 'no number was consumed');
    await write('v4 = A again (identical values)', 3, A, NEXT_WRITE);
    await sealedConflict('a stale version (2 at v4)', 2);
    await sealedConflict('a future version (9 at v4)', 9);
    // The precondition: another tenant (a real one, and one that does not exist) is the unsealed 409, rolled back.
    for (const [label, expected] of [['another tenant', T2], ['a tenant that does not exist', randomUUID()]]) {
      const k = randomUUID();
      const ks = [{ key: k, principal: boss.principal }];
      before = await counts([T, T2], ks);
      const reply = await ctx.put(o, S, putBody(expected, 4, A), { key: k });
      assertRefusal(reply, 409, 'write_conflict', `${label}: the precondition`);
      assert.equal(ctx.reason(reply), 'transaction_precondition_failed', label);
      assert.deepEqual(delta(await counts([T, T2], ks), before), LEASE_ONLY, `${label}: no completion, the lease open`);
      assertRefusal(await ctx.put(o, S, putBody(expected, 4, A), { key: k }), 409, 'request_in_progress', `${label}: the same key within the lease`);
    }
    assert.equal((await storedOf(S)).settings.version, '4', 'four accepted writes, four versions');
    settledOf(await ctx.settings(o, S), viewOf(S, 4, A), 'the read at v4');
  });
});

// ===========================================================================
// ISH-04: two concurrent first writes
// ===========================================================================

test('ISH-04 (ISS-25, AC-07): two tenant entries, a different owner of the tenant signed in on each, send first writes (expectedVersion 0) of different values while the OWNER holds the store\'s settings key — both are seen waiting inside the set routine; released, one is the 200 at v1 and the other the sealed 409 write_conflict (never a uniqueness error): exactly one settings row, its winner\'s values, one counter at 0, one audit record, two completions', async (t) => {
  const { T, S, boss } = await shop('ish04');
  // A second owner of the tenant (two people, each store_owner on one tenant grant): each request is its own actor's, so
  // nothing earlier in the chain orders them and both reach the store key (seen below).
  const boss2 = await actor('ish04-owner2', [tenantGrant(T, 'store_owner')]);
  const A = sellerValues('ish04a');
  const B = sellerValues('ish04b', { tax: { mode: 'none' } });
  await withEntry((a) => withEntry(async (b) => {
    const sa = await signIn(a, boss);
    const sb = await signIn(b, boss2);
    const ka = randomUUID();
    const kb = randomUUID();
    const keys = [{ key: ka, principal: boss.principal }, { key: kb, principal: boss2.principal }];
    const before = await counts([T], keys);
    const lever = await holdStoreKey(S);
    let ra;
    let rb;
    let seen;
    try {
      ra = quietly(a.put(sa, S, putBody(T, 0, A), { key: ka }));
      rb = quietly(b.put(sb, S, putBody(T, 0, B), { key: kb }));
      seen = await waiters(2, { by: lever.pid, query: AT_SET }, [ra, rb]);
    } finally {
      await lever.commit();
    }
    const [x, y] = [await replyTo(ra, 'entry A\'s write'), await replyTo(rb, 'entry B\'s write')];
    assert.equal(seen.length, 2, `both writes waited on the store key inside the set routine: ${JSON.stringify(seen)}; answered ${x.status} ${x.body} / ${y.status} ${y.body} (${a.reason(x)} / ${b.reason(y)})`);
    const winnerIsA = x.status === 200;
    const [won, lost, values] = winnerIsA ? [x, y, A] : [y, x, B];
    settledOf(won, viewOf(S, 1, values), 'the winner');
    sealedOf(lost, 'write_conflict', 'the loser');
    assert.deepEqual(delta(await counts([T], keys), before), { ...NOTHING, ST: 1, SV: 1, CT: 1, A: 1, K: 2, AA: 1, C: 2 },
      'one settings row at v1, one counter at 0, one audit record, two completions');
    const row = await storedOf(S);
    assert.deepEqual([row.settings.version, row.settings.legal_name, row.settings.tax_mode, row.counter.last_number], ['1', values.legalName, values.tax.mode, '0'], 'the winner\'s values');
    evidence(t, { winner: winnerIsA ? 'A' : 'B', statuses: [x.status, y.status] });
  }));
});

// ===========================================================================
// ISH-05: every body shape §10.4 names
// ===========================================================================

test('ISH-05 (AC-02): the bodies — the tax shapes (exclusive_rate at 0 and at 100000 and none admitted; 100001, -1, a fraction, -0, a string, a missing rate, a rate with none, an unknown mode, an extra key and no tax refused) and the text rules (C0, NUL, DEL, U+2028, three Bidi_Control characters and a lone surrogate refused; edge spaces trimmed; bounds counted in scalars; the address\'s 1-8 trimmed lines joined by one LF, an empty line, a CR, a ninth line and a 121-scalar line refused; taxRegistrationId null admitted, empty, over-long or a number refused) — each 200 a new version with exactly the normalized values, each 400 the planner\'s invalid_request holding its lease and writing nothing else', async (t) => {
  const { T, S, boss } = await shop('ish05');
  const base = sellerValues('ish05');
  const pad = (prefix, n) => `${prefix}${'x'.repeat(n - [...prefix].length)}`;
  await withEntry(async (ctx) => {
    const o = await signIn(ctx, boss);
    let version = 0;
    const reasons = new Set();
    const accepted = async (label, sent, stored = sent) => {
      const key = randomUUID();
      const keys = [{ key, principal: boss.principal }];
      const before = await counts([T], keys);
      settledOf(await ctx.put(o, S, putBody(T, version, sent), { key }), viewOf(S, version + 1, stored), label);
      assert.deepEqual(delta(await counts([T], keys), before), version === 0 ? FIRST_WRITE : NEXT_WRITE, `${label}: one new version`);
      version += 1;
    };
    /** `body`: an object (the base values overridden) or raw text naming the current version. */
    const refused = async (label, body) => {
      const key = randomUUID();
      const keys = [{ key, principal: boss.principal }];
      const row = await storedOf(S);
      const before = await counts([T], keys);
      const reply = await ctx.put(o, S, typeof body === 'string' ? body : { ...putBody(T, version, base), ...body }, { key });
      assertRefusal(reply, 400, 'invalid_request', label);
      reasons.add(ctx.reason(reply));
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: its lease and nothing else`);
      assert.equal(await leaseOpen(key, boss.principal), true, `${label}: the lease open`);
      assert.deepEqual(await storedOf(S), row, `${label}: the settings as they were`);
    };
    /** The body as text with `marker` (a JSON number in it) replaced by `literal`: -0 and 1.5 survive only as text. */
    const rawWith = (values, marker, literal) => {
      const text = JSON.stringify(putBody(T, version, values));
      assert.ok(text.includes(String(marker)));
      return text.replace(String(marker), literal);
    };
    await accepted('the base values', base);
    // The tax setting.
    await accepted('exclusive_rate at 0 (an explicit zero, not none)', { ...base, tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } });
    await accepted('exclusive_rate at 100000', { ...base, tax: { mode: 'exclusive_rate', rateMilliPercent: 100_000 } });
    await accepted('none', { ...base, tax: { mode: 'none' } });
    for (const [label, tax] of [['a rate of 100001', { mode: 'exclusive_rate', rateMilliPercent: 100_001 }], ['a rate of -1', { mode: 'exclusive_rate', rateMilliPercent: -1 }],
      ['a rate as a string', { mode: 'exclusive_rate', rateMilliPercent: '5000' }], ['exclusive_rate with no rate', { mode: 'exclusive_rate' }],
      ['none with a rate', { mode: 'none', rateMilliPercent: 0 }], ['an unknown mode', { mode: 'flat', rateMilliPercent: 5000 }],
      ['an extra key in the tax setting', { mode: 'none', note: 'x' }], ['a null tax setting', null], ['a rate as null', { mode: 'exclusive_rate', rateMilliPercent: null }]]) {
      await refused(`tax: ${label}`, { tax });
    }
    await refused('tax: a fractional rate (1.5)', rawWith({ ...base, tax: { mode: 'exclusive_rate', rateMilliPercent: 424_242 } }, 424_242, '1.5'));
    await refused('tax: a rate of -0', rawWith({ ...base, tax: { mode: 'exclusive_rate', rateMilliPercent: 424_242 } }, 424_242, '-0'));
    await refused('tax: a whole-valued fraction (5000.5)', rawWith({ ...base, tax: { mode: 'exclusive_rate', rateMilliPercent: 424_242 } }, 424_242, '5000.5'));
    // The body's own keys.
    const { tax: _tax, ...noTax } = putBody(T, version, base);
    await refused('the body without tax', JSON.stringify(noTax));
    const { taxRegistrationId: _id, ...noTaxId } = putBody(T, version, base);
    await refused('the body without taxRegistrationId', JSON.stringify(noTaxId));
    await refused('an extra key in the body', { note: 'x' });
    await refused('expectedVersion as a string', { expectedVersion: String(version) });
    await refused('expectedTenant not a uuid', { expectedTenant: 'tenant' });
    // Text: controls, separators, Bidi_Control, lone surrogates and invisible values.
    for (const [label, legalName] of [['a C0 control (U+0001)', 'ISH Legal\u0001 Name'], ['NUL', 'ISH Legal\u0000 Name'], ['DEL', 'ISH Legal\u007f Name'],
      ['U+0085 (C1)', 'ISH Legal\u0085 Name'], ['U+2028', 'ISH Legal  Name'], ['U+202E (Bidi_Control)', 'ISH Legal‮ Name'],
      ['U+200E (Bidi_Control)', 'ISH Legal‎ Name'], ['U+2066 (Bidi_Control)', 'ISH Legal⁦ Name'], ['a lone surrogate', 'ISH Legal\ud800 Name'],
      ['only spaces', '    '], ['empty', ''], ['a number', 42], ['null', null], ['an LF inside', 'ISH Legal\nName']]) {
      await refused(`legalName: ${label}`, { legalName });
    }
    await refused('storeName: a Bidi_Control character (U+061C)', { storeName: 'ISH Shop؜ Name' });
    await refused('storeName: 121 scalars', { storeName: pad('S', 121) });
    await refused('legalName: 201 scalars', { legalName: pad('L', 201) });
    await refused('legalName: 201 astral scalars (402 UTF-16 units)', { legalName: '\u{1D49C}'.repeat(201) });
    await refused('taxRegistrationId: empty', { taxRegistrationId: '' });
    await refused('taxRegistrationId: only spaces', { taxRegistrationId: '   ' });
    await refused('taxRegistrationId: 65 scalars', { taxRegistrationId: pad('T', 65) });
    await refused('taxRegistrationId: a number', { taxRegistrationId: 12345 });
    // The postal address.
    const lineOf = (n, i) => pad(`L${i} ${SUFFIX} `, n);
    for (const [label, postalAddress] of [['an empty line between two', 'Line one\n\nLine three'], ['a CR LF', 'Line one\r\nLine two'], ['a lone CR', 'Line one\rLine two'],
      ['nine lines', Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`).join('\n')], ['a 121-scalar line', `Line one\n${pad('Z', 121)}`],
      ['empty', ''], ['only an LF', '\n'], ['a whitespace-only line', 'Line one\n   \nLine three'], ['a control in a line', 'Line one\nLine\u0007 two'],
      ['a Bidi_Control character in a line', 'Line one\nLine‭ two'], ['an array', ['Line one']]]) {
      await refused(`postalAddress: ${label}`, { postalAddress });
    }
    // Admitted text: the bounds exactly, counted in scalars, and the normalization.
    const astral = '\u{1D49C}'.repeat(200);
    const exact = { ...base, legalName: pad('L', 200), storeName: pad('S', 120), taxRegistrationId: pad('T', 64) };
    await accepted('legalName 200, storeName 120, taxRegistrationId 64 scalars', exact);
    await accepted('legalName of 200 astral scalars (400 UTF-16 units)', { ...base, legalName: astral });
    await accepted('taxRegistrationId null', { ...base, taxRegistrationId: null });
    await accepted('one address line', { ...base, postalAddress: `One line ${SUFFIX}` });
    const eight = Array.from({ length: 8 }, (_, i) => lineOf(120, i + 1));
    assert.equal(eight.join('\n').length, 967, 'the largest address: 8 lines of 120 scalars and 7 LFs');
    await accepted('eight lines of 120 scalars (967 in all)', { ...base, postalAddress: eight.join('\n') });
    await accepted('edge spaces and edge LFs trimmed, each line trimmed',
      { ...base, legalName: `   ${base.legalName}  `, postalAddress: `\n  ${eight[0]}  \n\t${eight[1]}　\n` },
      { ...base, postalAddress: `${eight[0]}\n${eight[1]}` });
    assert.equal(reasons.size, 1, `every 400 is the one planner refusal: ${[...reasons]}`);
    const row = await storedOf(S);
    assert.deepEqual([row.settings.version, row.settings.postal_address, row.counter.last_number], [String(version), `${eight[0]}\n${eight[1]}`, '0'], 'the last accepted version stands; the counter never moved');
    evidence(t, { accepted: version, refusalReason: [...reasons][0] });
  });
});

// ===========================================================================
// ISH-06: the audit record, and the recent-sign-in deadline judged again after a lock wait
// ===========================================================================

test('ISH-06 (ISS-25, ISS-17, AC-02): one audit record per accepted write — the owner, scope tenant, the tenant, the store as subject_store_id and no other subject, action tenant.issuing_settings.update, permission edit_issuing_settings, metadata {}, the reason code by tax mode and a fixed reason naming the version (and the rate) holding no seller text — none for a sealed refusal, a replay, a rolled-back refusal or a 400, and no outbox row; then the owner\'s recent sign-in goes stale WHILE its write waits on the settings row the OWNER holds FOR SHARE: released, the 503 with nothing written but the lease, the version as it was; the same key from the stale session is the 403 step_up_required and from a fresh one the 409 request_in_progress; the control with a fresh sign-in is the 200', async (t) => {
  const { T, S, boss } = await shop('ish06');
  const { T: T2 } = await shop('ish06other');
  const values = [sellerValues('ish06a'), sellerValues('ish06b', { tax: { mode: 'none' }, taxRegistrationId: null }), sellerValues('ish06c', { tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } })];
  await withEntry(async (ctx) => {
    const o = await signIn(ctx, boss);
    const before = await counts([T]);
    const started = (await owner`select pg_catalog.clock_timestamp() as at`)[0].at;
    for (const [i, v] of values.entries()) settledOf(await ctx.put(o, S, putBody(T, i, v)), viewOf(S, i + 1, v), `write v${i + 1}`);
    // Refusals and a replay: none writes an audit record.
    const key = randomUUID();
    const sealed = await ctx.put(o, S, putBody(T, 1, values[0]), { key });
    sealedOf(sealed, 'write_conflict', 'a stale version');
    sealedOf(await ctx.put(o, S, putBody(T, 1, values[0]), { key }), 'write_conflict', 'its replay', { replayed: true });
    assertRefusal(await ctx.put(o, S, putBody(T2, 3, values[0])), 409, 'write_conflict', 'another tenant');
    assertRefusal(await ctx.put(o, S, { ...putBody(T, 3, values[0]), tax: { mode: 'none', rate: 1 } }), 400, 'invalid_request', 'a malformed tax setting');
    assert.deepEqual(delta(await counts([T]), before), { ...NOTHING, ST: 1, SV: 3, CT: 1, A: 3, AA: 3, C: 4, LE: 2 }, 'three audit records for three writes, none for the refusals, no outbox row');
    const audits = await owner`select actor_internal_user_id as actor, scope_type, tenant_id, store_id, action_id, required_permission, reason_code,
      human_readable_reason as reason, metadata, subject_store_id, subject_tenant_id, subject_customer_id, subject_invoice_draft_id, subject_issued_invoice_id,
      occurred_at >= ${started} and occurred_at <= pg_catalog.clock_timestamp() as stamped_inside
      from public.audit_event where action_id = ${ACTION} and tenant_id = ${T} order by occurred_at`;
    const expected = [
      ['issuing_settings_tax_exclusive_rate', 'Issuing settings version 1: exclusive tax at 8875 thousandths of a percent.'],
      ['issuing_settings_tax_none', 'Issuing settings version 2: no tax calculated.'],
      ['issuing_settings_tax_exclusive_rate', 'Issuing settings version 3: exclusive tax at 0 thousandths of a percent.'],
    ];
    assert.deepEqual(audits.map((r) => ({ ...r })), expected.map(([code, reason]) => ({
      actor: boss.id, scope_type: 'tenant', tenant_id: T, store_id: null, action_id: ACTION, required_permission: PERMISSION, reason_code: code, reason, metadata: {},
      subject_store_id: S, subject_tenant_id: null, subject_customer_id: null, subject_invoice_draft_id: null, subject_issued_invoice_id: null, stamped_inside: true,
    })), 'the three audit records exactly');
    for (const a of audits) {
      for (const v of values) for (const text of [v.legalName, v.storeName, v.taxRegistrationId, ...v.postalAddress.split('\n')]) {
        if (text !== null) assert.ok(!a.reason.includes(text), 'no seller text in the reason');
      }
    }
  });

  // The deadline, judged again after the routine's lock wait (roleLevels' M7RLH-09 schedule).
  await withEntry(async (ctx) => {
    const authTimeSec = Math.ceil((Date.now() + 3_000 - RECENT_AUTH_MAX_AGE_MS) / 1000);
    const deadline = authTimeSec * 1000 + RECENT_AUTH_MAX_AGE_MS;
    const timed = `${boss.token}-at-${authTimeSec}`;
    TOKENS.set(timed, { uid: boss.uid, authTimeSec });
    const o = await signIn(ctx, boss, { token: timed });
    const [{ authenticated_at: bound }] = await owner`select authenticated_at from tmpos_session.session where session_key = ${o.key}`;
    assert.equal(Number(bound), authTimeSec * 1000, 'the session binds the provider\'s authentication time');
    const key = randomUUID();
    const keys = [{ key, principal: boss.principal }];
    const row = await storedOf(S);
    const before = await counts([T], keys);
    const r = {};
    const lever = await holdSettings(S);
    let request;
    try {
      await delay(Math.max(0, deadline - LAPSE.send - Date.now()));
      r.sentAt = Date.now();
      request = quietly(ctx.put(o, S, putBody(T, 3, values[0]), { key }));
      request.then(() => { r.repliedAt = Date.now(); }, () => {});
      r.seen = await waiters(1, { by: lever.pid, query: AT_SET }, [request]);
      await delay(Math.max(0, deadline + LAPSE.release - Date.now()));
      [{ past: r.dbPastAt }] = await probe`select pg_catalog.clock_timestamp() > pg_catalog.to_timestamp(${String(deadline)}::bigint / 1000.0) as past`;
    } finally {
      await lever.commit();
    }
    const reply = await replyTo(request, 'the write that waited');
    const timeline = `relative to the deadline: sent ${r.sentAt - deadline} ms, answered ${r.repliedAt - deadline} ms`;
    assert.ok(r.sentAt < deadline, `sent while the sign-in was recent — ${timeline}`);
    assert.equal(r.seen.length, 1, `the write waited on the settings row inside the set routine — ${timeline}: ${reply.status} ${reply.body}`);
    assert.equal(r.dbPastAt, true, `the deadline had passed on the database clock before the release — ${timeline}`);
    assertRefusal(reply, 503, 'service_unavailable', `the write, refused after the routine answered — ${timeline}`);
    assert.ok(r.repliedAt - r.sentAt < COMMAND_LOCK_BOUND_MS, `answered before any lock bound could expire — ${timeline}`);
    assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, 'nothing written but the open lease');
    assert.deepEqual(await storedOf(S), row, 'the settings as they were');
    evidence(t, { case: 'deadline after the wait', reason: ctx.reason(reply), sentMs: r.sentAt - deadline, answeredMs: r.repliedAt - deadline });
    const fresh = await signIn(ctx, boss); // a sign-in writes its own session audit record: taken before the counts
    let after = await counts([T], keys);
    assertRefusal(await ctx.put(o, S, putBody(T, 3, values[0]), { key }), 403, 'step_up_required', 'the same key from the stale session');
    assertRefusal(await ctx.put(fresh, S, putBody(T, 3, values[0]), { key }), 409, 'request_in_progress', 'the same key from a fresh sign-in, within the lease');
    assert.deepEqual(delta(await counts([T], keys), after), NOTHING, 'neither retry writes anything');
    // The control: the same wait on a fresh sign-in commits.
    const k2 = randomUUID();
    after = await counts([T], [{ key: k2, principal: boss.principal }]);
    const lever2 = await holdSettings(S);
    let control;
    try {
      control = quietly(ctx.put(fresh, S, putBody(T, 3, values[0]), { key: k2 }));
      assert.equal((await waiters(1, { by: lever2.pid, query: AT_SET }, [control])).length, 1, 'the control waited on the settings row too');
    } finally {
      await lever2.commit();
    }
    settledOf(await replyTo(control, 'the control'), viewOf(S, 4, values[0]), 'the control commits');
    assert.deepEqual(delta(await counts([T], [{ key: k2, principal: boss.principal }]), after), NEXT_WRITE, 'the control: one new version');
  });
});

// ===========================================================================
// ISH-09: a revocation committed while the write waits at 016's hold
// ===========================================================================

test('ISH-09 (ISS-25, AC-07): the owner\'s settings PUT is seen waiting at 016\'s hold (the owner of the database holds the account row); the writer\'s session is revoked by owner SQL and commits; released, the PUT is the 503, rolled back — no settings row or version change, no audit record, no completion, nothing but its open lease; the revoked session is then the 401', async (t) => {
  const { T, S, boss } = await shop('ish09');
  await withEntry(async (ctx) => {
    const o = await signIn(ctx, boss);
    const values = sellerValues('ish09');
    settledOf(await ctx.put(o, S, putBody(T, 0, values)), viewOf(S, 1, values), 'the first write');
    const row = await storedOf(S);
    const key = randomUUID();
    const keys = [{ key, principal: boss.principal }];
    const before = await counts([T], keys);
    const h = await hold('app_user for update', (sql) => sql`select 1 from public.app_user where internal_user_id = ${boss.id} for update`);
    const at = {};
    let pending;
    try {
      at.sent = Date.now();
      pending = quietly(ctx.put(o, S, putBody(T, 1, sellerValues('ish09 v2')), { key }));
      pending.then(() => { at.replied = Date.now(); }, () => {});
      const seen = await waiters(1, { by: h.pid, query: AT_HOLD }, [pending]);
      assert.equal(seen.length, 1, 'the PUT seen waiting at 016\'s hold, behind the holder');
      assert.deepEqual((await owner`select tmpos_session.m5_session_revoke(${o.key}::text) as r`).map((x) => x.r), ['revoked'], 'the revocation commits while the PUT waits');
      // 011's revoke deletes the row: gone before the release.
      assert.equal((await owner`select count(*)::int as n from tmpos_session.session where session_key = ${o.key}`)[0].n, 0, 'the revoked session\'s row is gone');
      at.boundLeft = await lockBoundLeft(seen[0].pid, 'the PUT');
    } finally {
      await h.settle();
    }
    const reply = await replyTo(pending, 'the PUT');
    assertRefusal(reply, 503, 'service_unavailable', 'the PUT refused inside its transaction');
    assert.equal(ctx.reason(reply), 'transaction_unavailable', 'the revalidation refused, never a timeout');
    evidence(t, { case: 'ISH-09', elapsedMs: at.replied - at.sent, boundLeftMs: at.boundLeft });
    assert.ok(at.boundLeft > RELEASE_MARGIN_MS, `released ${at.boundLeft} ms before the PUT's lock bound on the database clock`);
    assert.ok(at.replied - at.sent < COMMAND_LOCK_BOUND_MS, `answered ${at.replied - at.sent} ms after the send: before any lock, statement or deadline timeout`);
    assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, 'nothing but the PUT\'s open lease');
    assert.equal(await leaseOpen(key, boss.principal), true, 'its lease open, no completion');
    assert.deepEqual(await storedOf(S), row, 'the settings and counter rows as they were, xmin included');
    assertRefusal(await ctx.settings(o, S), 401, 'unauthenticated', 'the revoked session is refused from now on');
  });
});

// ===========================================================================
// ISH-07: the 8 KiB bound and the media type on real sockets
// ===========================================================================

function parseHttpHead(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const lines = raw.slice(0, idx).split('\r\n');
  const m = /^HTTP\/\d\.\d (\d{3})/.exec(lines[0] ?? '');
  if (m === null) return null;
  const headers = {};
  for (const l of lines.slice(1)) {
    const at = l.indexOf(':');
    if (at < 0) continue;
    headers[l.slice(0, at).trim().toLowerCase()] = l.slice(at + 1).trim();
  }
  const bodyStart = idx + 4;
  const len = Number(headers['content-length'] ?? '0');
  if (raw.length - bodyStart < len) return null;
  return { status: Number(m[1]), headers, body: raw.slice(bodyStart, bodyStart + len) };
}
/** One hand-framed request written in ONE piece over a fresh socket; settles on the answer, or { status: 0 }. */
function rawRequest(port, text, { localAddress, timeoutMs = WAIT_MS } = {}) {
  return new Promise((resolve) => {
    const options = { port, host: '127.0.0.1' };
    if (localAddress) options.localAddress = localAddress;
    const socket = net.connect(options);
    let raw = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(parseHttpHead(raw) ?? { status: 0, headers: {}, body: raw }), timeoutMs);
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      const parsed = parseHttpHead(raw);
      if (parsed !== null) finish(parsed);
    });
    socket.on('error', () => finish({ status: 0, headers: {}, body: '' }));
    socket.on('close', () => finish(parseHttpHead(raw) ?? { status: 0, headers: {}, body: raw }));
  });
}
/** A hand-framed PUT at `path`: the tenant Host, Origin, both CSRF headers, the session cookie and the key, then `lines` and `tail`. */
function rawPut(ctx, s, path, lines, tail, key) {
  SECRETS.add(key);
  USED_KEYS.push({ key, principal: s.principal });
  const head = [`Host: ${TENANT_HOST}`, `Origin: ${TENANT_ORIGIN}`, 'Sec-Fetch-Site: same-origin', `${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`,
    `Cookie: ${s.cookie}`, `${SESSION_CSRF_HEADER}: ${s.csrf}`, `Idempotency-Key: ${key}`];
  return rawRequest(ctx.port, `PUT ${path} HTTP/1.1\r\n${head.map((l) => `${l}\r\n`).join('')}${lines}\r\n${tail}`, { localAddress: ctx.from });
}
/** `text` framed as chunks of `size` bytes (ASCII) and the last chunk. */
const chunked = (text, size) => {
  let out = '';
  for (let i = 0; i < text.length; i += size) {
    const piece = text.slice(i, i + size);
    out += `${Buffer.byteLength(piece).toString(16)}\r\n${piece}\r\n`;
  }
  return `${out}0\r\n\r\n`;
};

test('ISH-07 (ISS-22): the settings write\'s body is bounded at exactly 8 KiB on the real entry over real sockets — exactly 8,192 bytes commits declared and chunked; 8,193 is the 413 declared (from the headers) and chunked (on the bytes streamed); text/plain, two Content-Type lines and none with a body are the 415; each refusal answers only { error, requestId }, writes nothing — no idempotency record for its key — and leaves its key fresh: the key refused at the bound then commits', async (t) => {
  const { T, S, boss } = await shop('ish07');
  const values = sellerValues('ish07');
  await withEntry(async (ctx) => {
    const o = await signIn(ctx, boss);
    const path = `/api/v1/issuing-settings/${S}`;
    const padded = (version, n) => {
      const text = JSON.stringify(putBody(T, version, values));
      return `${text.slice(0, -1)}${' '.repeat(n - Buffer.byteLength(text))}}`;
    };
    assert.equal(Buffer.byteLength(padded(0, BOUND)), BOUND);
    assert.deepEqual(JSON.parse(padded(0, BOUND)), putBody(T, 0, values), 'the padded body is the plain write');
    const refused = async (label, request, { status, error, reason, key, close = false }) => {
      const row = await storedOf(S);
      const before = await counts([T], [{ key, principal: boss.principal }]);
      const reply = await request();
      assertRefusal(reply, status, error, label);
      const body = JSON.parse(reply.body);
      assert.equal(reply.headers['x-request-id'], body.requestId, `${label}: the correlator in the header`);
      for (const v of [key, o.csrf, o.key, T, S, values.legalName]) assert.ok(!reply.body.includes(v), `${label}: the answer echoes nothing it was sent`);
      assert.equal(ctx.reason(reply), reason, `${label}: the logged reason`);
      if (close) assert.equal(reply.headers.connection, 'close', `${label}: the server closes over the unread body`);
      assert.deepEqual(delta(await counts([T], [{ key, principal: boss.principal }]), before), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(key, boss.principal), 0, `${label}: no idempotency record`);
      assert.deepEqual(await storedOf(S), row, `${label}: the settings as they were`);
      evidence(t, { case: label, status: reply.status, reason });
    };
    // v1 at exactly the bound, declared through Node's client; v2 at exactly the bound, chunked by hand.
    let key = randomUUID();
    let before = await counts([T], [{ key, principal: boss.principal }]);
    settledOf(await ctx.put(o, S, padded(0, BOUND), { key }), viewOf(S, 1, values), '8,192 bytes declared');
    assert.deepEqual(delta(await counts([T], [{ key, principal: boss.principal }]), before), FIRST_WRITE, '8,192 declared: the first write');
    key = randomUUID();
    before = await counts([T], [{ key, principal: boss.principal }]);
    const reply = await rawPut(ctx, o, path, 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(padded(1, BOUND), 1000), key);
    settledOf(reply, viewOf(S, 2, values), '8,192 bytes chunked');
    assert.deepEqual(delta(await counts([T], [{ key, principal: boss.principal }]), before), NEXT_WRITE, '8,192 chunked: the next write');
    // One byte over, declared and streamed, then the media type.
    const boundKey = randomUUID();
    await refused('8,193 bytes declared', () => ctx.put(o, S, padded(2, BOUND + 1), { key: boundKey }),
      { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', key: boundKey });
    await refused('8,193 bytes chunked (1,000-byte chunks), the same key', () => rawPut(ctx, o, path, 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(padded(2, BOUND + 1), 1000), boundKey),
      { status: 413, error: 'content_too_large', reason: 'body_streamed_too_large', key: boundKey, close: true });
    key = randomUUID();
    await refused('text/plain', () => ctx.put(o, S, putBody(T, 2, values), { key, headers: { 'content-type': 'text/plain' } }),
      { status: 415, error: 'unsupported_media_type', reason: 'media_type_unsupported', key });
    key = randomUUID();
    const valid = JSON.stringify(putBody(T, 2, values));
    await refused('two Content-Type lines', () => rawPut(ctx, o, path, `Content-Type: application/json\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(valid)}\r\n`, valid, key),
      { status: 415, error: 'unsupported_media_type', reason: 'media_type_unsupported', key, close: true });
    key = randomUUID();
    await refused('no Content-Type with a body', () => rawPut(ctx, o, path, `Content-Length: ${Buffer.byteLength(valid)}\r\n`, valid, key),
      { status: 415, error: 'unsupported_media_type', reason: 'media_type_missing', key, close: true });
    // The key refused at the bound is still fresh: a valid body under it commits (not a replay, not 409, not 422).
    before = await counts([T], [{ key: boundKey, principal: boss.principal }]);
    settledOf(await ctx.put(o, S, putBody(T, 2, values), { key: boundKey }), viewOf(S, 3, values), 'the key refused at the bound, with a valid body');
    assert.deepEqual(delta(await counts([T], [{ key: boundKey, principal: boss.principal }]), before), NEXT_WRITE, 'its one write');
  });
});

// ===========================================================================
// ISH-08: the logs (last)
// ===========================================================================

test('ISH-08 (ISS-24): no log line carries seller text, a tenant or store id, a session key, a CSRF token or an Idempotency-Key — nor does the server log of a cluster this file started', () => {
  const forbidden = [...SECRETS, ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)])];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const l of ALL_LOG_LINES) for (const secret of forbidden) assert.ok(!l.includes(secret), `a log line carries a secret: ${secret.slice(0, 6)}...`);
  if (cluster !== null) {
    const leaked = forbidden.filter((v) => readFileSync(`${cluster.root}/postgres.log`, 'utf8').includes(v));
    assert.deepEqual(leaked.map((v) => v.slice(0, 6)), [], 'the cluster\'s server log carries no secret');
  }
});
