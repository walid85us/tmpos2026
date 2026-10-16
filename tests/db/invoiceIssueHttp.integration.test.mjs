// Phase 4.0 M7B-INVOICES-ISSUE-P1 — issuing a saved store invoice draft END TO END: the tenant entry
// (server/entry/tenantEntry.ts, startTenantEntry) serving POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue, GET
// …/{id}/issue-eligibility, GET …/{id}/issue-preview, GET /api/v1/stores/{storeId}/invoices and GET …/invoices/{id} over REAL
// loopback HTTP and a disposable PostgreSQL holding every migration in the directory (001-034), composed exactly as
// server/entry/tenantMain.ts composes it but for its construction. The route modules (server/runtime/invoiceIssuing.ts,
// server/runtime/issuingSettings.ts), the chain, the store-scope authorizer and revalidator, the tenant command transaction,
// the issue's mutator and the four reads' adapters (server/persistence/postgresInvoiceIssuing.ts), migration 034's routines
// (tmpos_invoice_issue.m7b_invoice_issue, …_preview, m7b_issued_invoice_page / _get, m7b_issuing_settings_get / _set), the
// audit writer's issue triple (subject_invoice_draft_id, subject_issued_invoice_id, subject_customer_id) and the idempotency
// kernel are production's own code. Every draft is saved through the production POST; every store's issuing settings are
// written by the tenant owner (recent sign-in) through the production PUT /api/v1/issuing-settings/{id}; every level change
// goes through the production PUT /api/v1/roles/levels; the customer rename goes through the production PATCH.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — tests/db/invoiceDraftDiscardHttp.integration.test.mjs's three, none on the path under
// test: the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime LOGIN,
// tmpos_iih_probe, holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can drop a COMMIT's
// answer or the COMMIT itself), the identity verifier (a synthetic bearer-token map) and the listener (127.0.0.1:0). Lease
// expiry and retention are moved by the OWNER on the idempotency row; faults are OWNER triggers; the header hold is an OWNER
// row lock (test-only levers). Account, tenant and store statuses are owner fixture writes.
//
// WHAT IS PROVEN (each title carries docs/phase-4/12's ISS ids and the stage's AC ids; D/I/X/N/L/Q/A/O/K are a case's
// drafts, ISSUED drafts, DISCARDED drafts, issued invoices, issued lines, the sum of its stores' counters, ISSUE audit
// records, its stores' outbox rows and its keys' sealed completions; AA/OO/C/LE every audit record, outbox row, completed
// idempotency record and open lease in the database — the cases run one at a time — all read by the OWNER as deltas).
//   IIH-01 authority over stored levels: issue 201 exactly at Invoices Approve+ with Customers View+, else the chain's 403
//          before any key; eligibility and preview agree with the POST in every row.
//   IIH-02 cross-store and cross-tenant isolation: one 404 for a missing, another store's and another tenant's draft or
//          invoice; the same empty page for every foreign source-draft filter; a foreign cursor the 400; ungranted stores the
//          403; two stores' numbers independent.
//   IIH-03 preview -> issue -> reads, exact bodies; one audit record with three subjects, no outbox row.
//   IIH-04 refusals and their effects (sealed / unsealed / 400 + lease), precedence.
//   IIH-05 both tax modes and an explicit zero rate through the whole path; 1999 x 8875 -> 177 / 2176; 10 + 10 at 5000 -> 1.
//   IIH-06 replay and recovery: replay, 422, invalid_state, retention, current authority, Customers View on the filter.
//   IIH-07 a lost COMMIT answer (landed: the replay) and a cut COMMIT (nothing; the next issue takes the same number).
//   IIH-08 a fault at the issued-invoice INSERT, the issued-line INSERT, the draft's transition, the counter UPDATE, the audit
//          INSERT and the completion: the 503, nothing but the lease; without a fault the same issue commits.
//   IIH-09 races over two entries ordered by an owner's hold of the header.
//   IIH-10 snapshot independence from a later customer rename and settings write.
//   IIH-11 the 1 KiB body bound and the media type over real sockets.
//   IIH-12 no log leaks (run last); the shipping inventory is exactly the 29 routes.
//   IIH-13 a change committed on another entry while the issue waits: a rename and a settings write the sealed write_conflict;
//          a level narrowing and a session revocation the 503, rolled back — each 503 answered before the issue's lock bound
//          (wall clock from the send, and the release before waitstart + the bound on the database clock), so never a timeout.
//
// DETERMINISTIC WAITS ONLY: pg_stat_activity / pg_locks, an owner lock granted only once its transaction ended, or a relay
// trap; nothing sleeps for an outcome. DISPOSABLE ONLY: the harness's resolved target, refused by assertDisposableTestDsn
// unless disposable. Synthetic data only. Before it finishes it removes every issued line, issued invoice, counter, settings
// row, draft, line, customer, role-level row, issue and settings audit record (and nulls every other audit subject naming
// them) of its tenants — the guard, terminal and append-only triggers lifted inside ONE owner transaction and put back in the
// mode they were found in — with its draft events, sessions, mint-ledger rows, idempotency records, proof schema and login,
// restores the limiter fingerprint and issuer key row, and checks that the database holds no settings, counter, issued row,
// issued draft or issue/settings audit record and that every trigger is ALWAYS again.
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
import { startTenantEntry, TENANT_SHIPPING_ROUTES } from '../../server/entry/tenantEntry.ts';
import { SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring, IDEMPOTENCY_POLICY } from '../../server/runtime/idempotency.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';
import { PORT_DEADLINE_MS } from '../../server/runtime/deadline.ts';
import { encodeIssuedInvoiceCursor } from '../../server/runtime/invoiceIssuing.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'iih-migrator', runtimeRef: 'iih-runtime' };
const LOCK_KEY = 529_537;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_iih_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** The issue's audit action and permission, and the settings write's action, pinned here as literals. */
const ACTION = 'store.invoice.issue';
const PERMISSION = 'issue_invoices';
const SETTINGS_ACTION = 'tenant.issuing_settings.update';
const MAX = Number.MAX_SAFE_INTEGER;
const WAIT_MS = 10_000;
const SEND_TIMEOUT_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISSUED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** The issue routine's statement (034): where an issue waits for the draft header. Never the preview's. */
const AT_ISSUE = /tmpos_invoice_issue\.m7b_invoice_issue\(/;
const AT_UPDATE = /tmpos_invoice_edit\.m7b_invoice_draft_update_v2\(/;
const AT_DISCARD = /tmpos_invoice_discard\.m7b_invoice_draft_discard\(/;
const AT_HOLD = /m5_hold_tenant_standing/;
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });
/** A command's lock_timeout (supervisedPgClient's transaction bounds): an answer sooner than this after its send is no timeout. */
const COMMAND_LOCK_BOUND_MS = 1_400;
/** How long before the waiter's lock bound (waitstart + COMMAND_LOCK_BOUND_MS, database clock) a lever must release. */
const RELEASE_MARGIN_MS = 300;
/** The completion: the one UPDATE of an idempotency record that seals its response. */
const COMPLETION = 'old.response is null and new.response is not null';
assert.equal(IDEMPOTENCY_POLICY.leaseMs, 60_000, 'the idempotency lease the in-progress cases rely on');
assert.ok(COMMAND_TRANSACTION_DEADLINE_MS <= PORT_DEADLINE_MS);
assert.ok(PORT_DEADLINE_MS * 4 <= SEND_TIMEOUT_MS);
assert.ok(COMMAND_LOCK_BOUND_MS < COMMAND_TRANSACTION_DEADLINE_MS);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('IIH');
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
const TERMINAL_TRIGGERS = [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']];
/** Migration 034's row guards: issued rows, counters and settings admit no delete while they are enabled. */
const ISSUE_TRIGGERS = [
  ['tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_guard'],
  ['tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_guard'],
  ['tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_guard'],
  ['tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_guard'],
];

/**
 * Every issued line and invoice, counter, settings row, draft, line, customer, Invoices/Customers role and version row of
 * this suite's tenants, its issue and settings audit records, and every other audit subject naming one of its drafts,
 * invoices, stores or customers — in ONE owner transaction, the guards lifted only inside it.
 */
async function cleanIssuing() {
  if (TENANTS.length === 0) return;
  await owner.begin('isolation level read committed', async (sql) => {
    await withTriggersLifted(sql, AUDIT_TRIGGER, async () => {
      await sql`delete from public.audit_event where action_id in (${ACTION}, ${SETTINGS_ACTION}) and tenant_id = any(${TENANTS}::uuid[])`;
      await sql`update public.audit_event set subject_invoice_draft_id = null
        where subject_invoice_draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_issued_invoice_id = null
        where subject_issued_invoice_id in (select invoice_id from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_store_id = null
        where subject_store_id in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_customer_id = null
        where subject_customer_id in (select customer_id from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]))`;
    });
    await withTriggersLifted(sql, ISSUE_TRIGGERS, async () => {
      await sql`delete from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_issue.store_issuing_settings where tenant_id = any(${TENANTS}::uuid[])`;
    });
    await withTriggersLifted(sql, TERMINAL_TRIGGERS, async () => {
      await sql`delete from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`;
    });
    // Every customer this file made, so no row_version above 1 survives it (024's down refuses while one does).
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
    await step(() => owner.unsafe('drop schema if exists iih_proof cascade'));
    // The events this suite's saves and edits enqueued (an issue, a settings write and a customer edit enqueue none).
    if (TENANTS.length > 0) {
      await step(() => owner`delete from tmpos_internal.outbox_event where event_type in ('invoice_draft.created', 'invoice_draft.updated')
        and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`);
    }
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
        (select count(*) from tmpos_invoice_issue.store_issuing_settings)::int as settings,
        (select count(*) from tmpos_invoice_issue.store_invoice_counter)::int as counters,
        (select count(*) from tmpos_invoice_issue.issued_invoice)::int as invoices,
        (select count(*) from tmpos_invoice_issue.issued_invoice_line)::int as issued_lines,
        (select count(*) from tmpos_invoice_draft.invoice_draft where status = 'issued')::int as issued_drafts,
        (select count(*) from public.audit_event where action_id in (${ACTION}, ${SETTINGS_ACTION}))::int as issue_audits,
        (select count(*) from public.audit_event where subject_issued_invoice_id is not null or subject_store_id is not null)::int as subjects,
        (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
        (select count(*) from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]))::int as customers,
        (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors,
        (select max(version) from public.schema_migrations) as latest,
        (select pg_catalog.string_agg(g.tgname::text || ':' || g.tgenabled::text, ',' order by g.tgname) from pg_catalog.pg_trigger g
          where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass,
            'tmpos_invoice_issue.issued_invoice'::regclass, 'tmpos_invoice_issue.issued_invoice_line'::regclass,
            'tmpos_invoice_issue.store_invoice_counter'::regclass, 'tmpos_invoice_issue.store_issuing_settings'::regclass) and not g.tgisinternal) as triggers`;
      assert.deepEqual({ ...state }, {
        settings: 0, counters: 0, invoices: 0, issued_lines: 0, issued_drafts: 0, issue_audits: 0, subjects: 0, drafts: 0, customers: 0, anchors: 0, latest: '034',
        triggers: ['trg_invoice_draft_immutable:A', 'trg_invoice_draft_line_terminal:A', 'trg_invoice_draft_terminal:A', 'trg_issued_invoice_commit_check:A',
          'trg_issued_invoice_guard:A', 'trg_issued_invoice_line_guard:A', 'trg_issued_invoice_line_truncate:A', 'trg_issued_invoice_truncate:A',
          'trg_store_invoice_counter_guard:A', 'trg_store_invoice_counter_truncate:A', 'trg_store_issuing_settings_guard:A', 'trg_store_issuing_settings_truncate:A'].join(','),
      }, 'nothing of this suite blocks 034\'s rollback, and every guard is ALWAYS again');
    });
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IIH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'IIH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay (the discard suite's): a trap may drop a COMMIT's answer, or the COMMIT itself
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket' ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) } : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-iih-relay-'));
  const pairs = new Set();
  const state = { pairs, trap: null };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); }, anchored: false, silenced: false };
    pairs.add(pair);
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
/** An applied issue's anchor: its audit INSERT (only an applied issue writes one). */
const AUDIT_ANCHOR = Buffer.from('insert into public.audit_event');
const COMMIT_PARSE = Buffer.from('\0commit\0');
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
  const [{ applied }] = await owner`select count(*)::int as applied from public.schema_migrations where version in ('028', '029', '030', '031', '032', '033', '034')`;
  assert.equal(applied, 7, 'migrations 028-034 are applied: the drafts, their edit, save, discard and the issuing of migration 034');
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
  await owner.unsafe('drop schema if exists iih_proof cascade');
  await owner.unsafe('create schema iih_proof');
  await owner.unsafe('revoke all on schema iih_proof from public');
  await owner.unsafe('create sequence iih_proof.fired');
  // IIH-13's gate: one row the OWNER holds FOR UPDATE, which the 'park' trigger action waits on.
  await owner.unsafe('create table iih_proof.gate (id integer primary key)');
  await owner.unsafe('insert into iih_proof.gate (id) values (1)');
});

// ---------------------------------------------------------------------------
// identity, configuration, requests
// ---------------------------------------------------------------------------

const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) { const err = new Error('unknown_token'); err.code = 'auth/invalid-id-token'; throw err; }
    return { uid: rec.uid, authTime: rec.authTimeSec ?? Math.floor(Date.now() / 1000), secondFactor: 'totp' };
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
    type: 'service_account', project_id: 'iih-test-project', client_email: 'iih-test@iih-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
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
// fixtures
// ---------------------------------------------------------------------------

async function newTenant(label, status = 'active') {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`iih-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  SECRETS.add(id);
  return id;
}
async function newStore(tenant, name, status = 'active') {
  const id = (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`${name} ${SUFFIX}`}, ${status}) returning store_id`)[0].store_id;
  SECRETS.add(id);
  return id;
}
const NAMES = new Map();
/** A customer (owner fixture), with a phone and an email no issued read may return. */
async function newCustomer(tenant, label) {
  const id = randomUUID();
  const name = `IIH ${label} ${SUFFIX}`;
  const phone = '+1 555 0142';
  const email = `iih-${label.replace(/\W+/g, '-')}-${SUFFIX}@example.test`;
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, phone, email) values (${id}, ${tenant}, ${name}, ${phone}, ${email})`;
  NAMES.set(id, name);
  SECRETS.add(id).add(name).add(email);
  return id;
}
async function actor(label, memberships, status = 'active') {
  const uid = `iih-${label}-${SUFFIX}`;
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
function described(label) {
  const text = `IIH ${label} ${SUFFIX}`;
  SECRETS.add(text);
  return text;
}
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const saveBody = (tenant, customer, lines) => ({ expectedTenant: tenant, customerId: customer, currency: 'USD', lines });
const editBody = (tenant, version, customer, lines) => ({ expectedTenant: tenant, expectedVersion: version, customerId: customer, lines });
const discardBody = (tenant, version) => ({ expectedTenant: tenant, expectedVersion: version });
const issueBody = (tenant, version, settingsVersion, customerVersion) => ({
  expectedTenant: tenant, expectedVersion: version, expectedSettingsVersion: settingsVersion, expectedCustomerVersion: customerVersion,
});
const RATE_8875 = Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: 8875 });
const NO_TAX = Object.freeze({ mode: 'none' });
/** Seller values no other run shares, each registered as a log canary. */
function sellerOf(label, tax = RATE_8875, { taxId = true } = {}) {
  return {
    legalName: described(`${label} legal`), storeName: described(`${label} shop`),
    postalAddress: `${described(`${label} street`)}\n${described(`${label} city`)}`,
    taxRegistrationId: taxId ? described(`${label} reg`) : null, tax,
  };
}
/** The amounts a subtotal derives under a tax setting (doc 12 §10.8, BigInt), as the wire shows them. */
function amountsFor(subtotal, tax) {
  if (tax.mode === 'none') return { currency: 'USD', subtotalCents: subtotal, tax: { mode: 'none', description: 'No tax calculated' }, totalCents: subtotal };
  const amount = Number((BigInt(subtotal) * BigInt(tax.rateMilliPercent) + 50_000n) / 100_000n);
  return { currency: 'USD', subtotalCents: subtotal, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: tax.rateMilliPercent, amountCents: amount }, totalCents: subtotal + amount };
}
const linesFor = (lines) => lines.map((l, i) => ({ position: i + 1, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.quantity * l.unitPriceCents }));
const subtotalOf = (lines) => lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
const taxWire = (tax) => (tax.mode === 'none' ? { mode: 'none' } : { mode: 'exclusive_rate', rateMilliPercent: tax.rateMilliPercent });

/**
 * What a case's tenants hold now — drafts, ISSUED and DISCARDED drafts, issued invoices and lines, the sum of their stores'
 * counters, ISSUE audit records, their stores' outbox rows — the sealed completions of its keys, and across the database every
 * audit record, outbox row, completion and open lease.
 */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as d,
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]) and status = 'issued')::int as i,
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]) and status = 'discarded')::int as x,
    (select count(*) from tmpos_invoice_issue.issued_invoice where tenant_id = any(${tenants}::uuid[]))::int as n,
    (select count(*) from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${tenants}::uuid[]))::int as l,
    (select coalesce(sum(last_number), 0) from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${tenants}::uuid[]))::int as q,
    (select count(*) from public.audit_event where action_id = ${ACTION} and tenant_id = any(${tenants}::uuid[]))::int as a,
    (select count(*) from tmpos_internal.outbox_event where payload ->> 'storeId' in (select store_id::text from public.store where tenant_id = any(${tenants}::uuid[])))::int as o,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from public.audit_event)::int as aa,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as c,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le`;
  return { D: r.d, I: r.i, X: r.x, N: r.n, L: r.l, Q: r.q, A: r.a, O: r.o, K: r.k, AA: r.aa, OO: r.oo, C: r.c, LE: r.le };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const NOTHING = Object.freeze({ D: 0, I: 0, X: 0, N: 0, L: 0, Q: 0, A: 0, O: 0, K: 0, AA: 0, OO: 0, C: 0, LE: 0 });
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
const COMPLETION_ONLY = Object.freeze({ ...NOTHING, K: 1, C: 1 });
/** One applied issue of an n-line draft under a key: the draft issued, one invoice, n lines, the counter +1, one audit record, one completion, NO outbox row. */
const ONE_ISSUE = (n) => Object.freeze({ ...NOTHING, I: 1, N: 1, L: n, Q: 1, A: 1, K: 1, AA: 1, C: 1 });
async function stateOf(draft) {
  const [header] = await owner`select draft_id, tenant_id, store_id, customer_id, status, currency, version::text as version, line_count,
    subtotal_cents::text as subtotal_cents, created_at::text as created_at, created_by, xmin::text as xmin
    from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`;
  const lines = await owner`select position, description, quantity::text as quantity, unit_price_cents::text as unit_price_cents,
    line_total_cents::text as line_total_cents, xmin::text as xmin from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft} order by position`;
  return { header: header === undefined ? null : { ...header }, lines: lines.map((l) => ({ ...l })) };
}
/** The store's counter as stored ('none' while the store has no settings). */
const counterOf = async (store) => (await owner`select last_number::text as n from tmpos_invoice_issue.store_invoice_counter where store_id = ${store}`)[0]?.n ?? 'none';
/** The issued invoice of `draft` as the OWNER reads it (null: none). */
const issuedRowOf = async (draft) => {
  const [row] = await owner`select invoice_id, number::text as number, issued_by, settings_version::text as settings_version,
    customer_version::text as customer_version, tax_cents::text as tax_cents, total_cents::text as total_cents
    from tmpos_invoice_issue.issued_invoice where source_draft_id = ${draft}`;
  return row === undefined ? null : { ...row };
};
async function leaseOpen(key, principal) {
  const [row] = await owner`select response is null as open from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`;
  return row?.open === true;
}
const recordsOf = async (key, principal) => (await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`)[0].n;
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
  const drafts = (store) => `/api/v1/stores/${store}/invoice-drafts`;
  const ctx = {
    relay, port, from, lines, stop,
    read: (s, path, headers = {}) => send(port, 'GET', path,
      { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers }, undefined, { localAddress: from }),
    get: (s, store, id) => ctx.read(s, `${drafts(store)}/${id}`),
    list: (s, store, query = '') => ctx.read(s, `${drafts(store)}${query}`),
    eligibility: (s, store, id) => ctx.read(s, `${drafts(store)}/${id}/issue-eligibility`),
    preview: (s, store, id) => ctx.read(s, `${drafts(store)}/${id}/issue-preview`),
    invoices: (s, store, query = '') => ctx.read(s, `/api/v1/stores/${store}/invoices${query}`),
    invoice: (s, store, id) => ctx.read(s, `/api/v1/stores/${store}/invoices/${id}`),
    settings: (s, store) => ctx.read(s, `/api/v1/issuing-settings/${store}`),
    save: (s, store, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', drafts(store), body, key, headers),
    patch: (s, store, id, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'PATCH', `${drafts(store)}/${id}`, body, key, headers),
    discard: (s, store, id, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', `${drafts(store)}/${id}/discard`, body, key, headers),
    issue: (s, store, id, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', `${drafts(store)}/${id}/issue`, body, key, headers),
    putSettings: (s, store, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'PUT', `/api/v1/issuing-settings/${store}`, body, key, headers),
    renameCustomer: (s, id, body, { key = randomUUID() } = {}) => unsafe(s, 'PATCH', `/api/v1/customers/${id}`, body, key, {}),
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
async function seed(ctx, s, store, tenant, customer, lines, { key } = {}) {
  const reply = await ctx.save(s, store, saveBody(tenant, customer, lines), key === undefined ? {} : { key });
  assert.equal(reply.status, 201, `the seed save: ${reply.body}`);
  const id = JSON.parse(reply.body).draft.id;
  SECRETS.add(id);
  return id;
}
/** The owner's settings write at the version its read reports; the new version. */
async function configure(ctx, sb, tenant, store, seller, label = 'configure') {
  const read = await ctx.settings(sb, store);
  assert.equal(read.status, 200, `${label}: the owner's settings read: ${read.body}`);
  const version = JSON.parse(read.body).issuingSettings.version;
  const reply = await ctx.putSettings(sb, store, { expectedTenant: tenant, expectedVersion: version, ...seller });
  assert.equal(reply.status, 200, `${label}: the owner's settings PUT: ${reply.body}`);
  assert.equal(JSON.parse(reply.body).issuingSettings.version, version + 1, `${label}: version + 1`);
  return version + 1;
}
/** An issue's 201: exactly { invoice: { id, sourceDraftId, status }, draft: { id, version, status } } and its Location; the invoice id. */
function issuedOf(reply, { draftId, version, store }, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${reply.body}`);
  const id = JSON.parse(reply.body)?.invoice?.id;
  assert.match(String(id), UUID_RE, `${label}: a server-generated invoice id`);
  assert.equal(reply.body, JSON.stringify({ invoice: { id, sourceDraftId: draftId, status: 'issued' }, draft: { id: draftId, version, status: 'issued' } }), `${label}: the exact sealed body`);
  assert.equal(reply.headers.location, `/api/v1/stores/${store}/invoices/${id}`, `${label}: the Location of the issued invoice`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
  SECRETS.add(id);
  return id;
}
function sealedOf(reply, word, label, { replayed = false } = {}) {
  assert.equal(reply.status, 409, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify({ error: word }), `${label}: the exact sealed body`);
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
/** A preview's 200 as its parsed body (baseline headers asserted). */
function previewOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assertBaseline(reply, label);
  return JSON.parse(reply.body).preview;
}
/** A list page: exactly { invoices, nextCursor }. */
function pageOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assertBaseline(reply, label);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['invoices', 'nextCursor'], label);
  return body;
}
/** Every key of a JSON value, recursively. */
const keysOf = (v) => (Array.isArray(v) ? v.flatMap(keysOf) : v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
/** The version the owner reviews for `role`'s `domain` level (Customers: GET /api/v1/roles/levels; Invoices: …/invoices). */
async function reviewedOf(ctx, s, role, domain) {
  const read = await ctx.read(s, domain === 'invoices' ? '/api/v1/roles/levels/invoices' : '/api/v1/roles/levels');
  assert.equal(read.status, 200, `the owner reads the ${domain} levels: ${read.body}`);
  return Number(JSON.parse(read.body).roles.find((r) => r.roleId === role).version);
}
/** The owner's PUT of `role`'s `domain` level at its reviewed version, asserted as its own 200. */
async function putLevel(ctx, s, tenant, role, domain, level, label) {
  const version = await reviewedOf(ctx, s, role, domain);
  const reply = await ctx.levels(s, { roleId: role, domain, level, reason: described(`${label} ${role} ${domain} ${level}`), expectedTenant: tenant, expectedVersion: version });
  assert.equal(reply.status, 200, `${label}: the owner's PUT of ${role} ${domain} to ${level}: ${reply.body}`);
  assert.deepEqual(JSON.parse(reply.body), { roleLevel: { roleId: role, domain, level, version: version + 1 } }, `${label}: the PUT's own answer`);
}

// ---------------------------------------------------------------------------
// levers (the discard suite's)
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
const holdHeader = (draft) => hold('draft header for update', (sql) => sql`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${draft} for update`);
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
/** The OWNER takes `draft`'s header FOR UPDATE: granted only once no transaction holds or waits ahead on it. */
async function headerFree(draft) {
  await owner.begin(async (sql) => {
    await sql`select pg_catalog.set_config('lock_timeout', ${`${WAIT_MS}ms`}, true)`;
    await sql`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${draft} for update`;
  });
}
const TRIGGER_ACTIONS = Object.freeze({
  raise: `raise exception 'IIH injected fault' using errcode = 'P0001';`,
  // Waits on the gate row (the OWNER holds it in a lever), then lets the row through.
  park: 'perform 1 from iih_proof.gate where id = 1 for update; return new;',
});
/** `work` runs with ONE owner trigger BEFORE `event` on `table` for each row matching `when`: it counts itself, then raises. */
async function withTrigger(table, event, when, action, work) {
  await owner.unsafe(`create function iih_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('iih_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function iih_proof.fire() from public');
  await owner.unsafe(`create trigger iih_fire before ${event} on ${table} for each row when (${when}) execute function iih_proof.fire()`);
  try { return await work(); } finally {
    await owner.unsafe(`drop trigger if exists iih_fire on ${table}`);
    await owner.unsafe('drop function if exists iih_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('iih_proof.fired'::regclass), 0)::int as n`)[0].n;
const DRAFT_TABLE = 'tmpos_invoice_draft.invoice_draft';
const waitsOf = async (pid) => (await probe`select l.locktype, l.mode, l.transactionid::text as xid, l.relation::regclass::text as relation
  from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted`).map((r) => ({ ...r }));
/** Milliseconds left on the database clock before `pid`'s one ungranted lock reaches its bound (waitstart + COMMAND_LOCK_BOUND_MS). */
async function lockBoundLeft(pid, label) {
  const rows = await probe`select (extract(epoch from l.waitstart + ${COMMAND_LOCK_BOUND_MS}::int * interval '1 millisecond'
    - pg_catalog.clock_timestamp()) * 1000)::float8 as left_ms from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted`;
  assert.equal(rows.length, 1, `${label}: exactly one lock awaited`);
  assert.equal(typeof rows[0].left_ms, 'number', `${label}: its waitstart recorded`);
  return rows[0].left_ms;
}
const xidOf = async (pid) => (await probe`select backend_xid::text as xid from pg_catalog.pg_stat_activity where pid = ${pid}`)[0]?.xid ?? null;
const holds = async (pid, relation, locktype, mode) => (await probe`select count(*)::int as n from pg_catalog.pg_locks l
  where l.pid = ${pid} and l.granted and l.locktype = ${locktype} and l.mode = ${mode} and l.relation = ${relation}::regclass`)[0].n;
async function assertWaitsOnHeaderBehind(waiter, holder, label) {
  const xid = await xidOf(holder);
  assert.ok(xid !== null, `${label}: the holder has a transaction id`);
  assert.deepEqual(await waitsOf(waiter), [{ locktype: 'transactionid', mode: 'ShareLock', xid, relation: null }], `${label}: waits for exactly the holder's transaction`);
  assert.equal(await holds(waiter, DRAFT_TABLE, 'tuple', 'AccessExclusiveLock'), 1, `${label}: holding the draft header's tuple lock (FOR UPDATE)`);
}
async function assertQueuedOnHeaderTuple(waiter, label) {
  assert.deepEqual(await waitsOf(waiter), [{ locktype: 'tuple', mode: 'AccessExclusiveLock', xid: null, relation: DRAFT_TABLE }], `${label}: queued for the header's tuple lock`);
}
const expireLease = (key, principal) => owner`update tmpos_internal.idempotency_record set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where scope = ${scopeOf(key, principal)} and response is null`;
/** Moves `key`'s record past its retention (the OWNER's lever): the next acquisition overwrites it in place. */
const expireRetention = (key, principal) => owner`update tmpos_internal.idempotency_record
  set lease_expires_at = pg_catalog.clock_timestamp() - interval '2 seconds', expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where scope = ${scopeOf(key, principal)}`;
async function until(predicate, label) {
  for (const end = Date.now() + WAIT_MS; Date.now() < end; await tick()) if (await predicate()) return;
  assert.fail(`${label}: not observed within ${WAIT_MS} ms`);
}

/** One store of a fresh tenant with its owner (tenant grant), a store_owner and a manager (store grants) and a customer. */
async function world(label) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label.toUpperCase()} store`);
  const C = await newCustomer(T, label);
  const boss = await actor(`${label}-boss`, [tenantGrant(T, 'store_owner')]);
  const so = await actor(`${label}-so`, [storeGrant(T, S, 'store_owner')]);
  const mgr = await actor(`${label}-mgr`, [storeGrant(T, S, 'manager')]);
  return { T, S, C, boss, so, mgr };
}

// ===========================================================================
// IIH-01: authority over stored levels
// ===========================================================================

test('IIH-01 (ISS-01 ISS-02 AC-03): authority on the STORED levels, set through the real PUT /api/v1/roles/levels — store_owner and the manager default issue, the technician and sales_staff defaults do not; a manager at Invoices manage is refused, at approve and full allowed, with Customers none refused and at view allowed again; a technician raised to approve issues; a read-only account, tenant and store, a tenant grant only, another store\'s grant and a browser-only custom role (unrepresentable: a technician stands in) are refused — the eligibility and the preview equal the POST\'s authorization in every row, every refusal the chain\'s 403 before any key', async () => {
  const { T, S, C, boss, so } = await world('iih01');
  const S2 = await newStore(T, 'IIH01 other store');
  const roles = {};
  for (const role of ['manager', 'technician', 'sales_staff']) roles[role] = await actor(`iih01-${role}`, [storeGrant(T, S, role)]);
  const ro = await actor('iih01-ro', [storeGrant(T, S, 'store_owner')], 'read_only');
  const elsewhere = await actor('iih01-elsewhere', [storeGrant(T, S2, 'manager')]);
  // A browser-only custom role has no server authority: the membership CHECK refuses it outright. Probed on rows of their own,
  // never this suite's secrets: the refusal's DETAIL (the failing row) reaches the server log, which IIH-12 reads.
  const [{ tenant_id: probeTenant }] = await owner`insert into tenant (display_name, status) values (${`iih-probe-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(probeTenant);
  const [{ store_id: probeStore }] = await owner`insert into store (tenant_id, store_name, status) values (${probeTenant}, ${`IIH probe ${SUFFIX}`}, 'active') returning store_id`;
  const [{ internal_user_id: probeUser }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${`iih-probe-${SUFFIX}`}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${probeUser}, 'active')`;
  const [{ code }] = [await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${probeUser}, ${probeTenant}, ${probeStore}, 'store', 'shift_lead', 'active')`.then(() => ({ code: null }), (err) => ({ code: err.code }))];
  assert.equal(code, '23514', 'a browser-only custom role cannot be a server grant');
  await withEntry(async (ctx) => {
    let sso = await signIn(ctx, so);
    const sb = await signIn(ctx, boss);
    const sessions = { store_owner: sso, ro: await signIn(ctx, ro), elsewhere: await signIn(ctx, elsewhere), boss: sb };
    for (const [role, who] of Object.entries(roles)) sessions[role] = await signIn(ctx, who);
    const principals = { store_owner: so.principal, ro: ro.principal, elsewhere: elsewhere.principal, boss: boss.principal, ...Object.fromEntries(Object.entries(roles).map(([r, w]) => [r, w.principal])) };
    const settingsVersion = await configure(ctx, sb, T, S, sellerOf('iih01'));
    let issued = 0;
    /** A fresh draft (saved by the store owner, or `id`); eligibility, preview, then the POST they predict. */
    const decide = async (who, label, { id = null, s = sessions[who] } = {}) => {
      const draft = id ?? await seed(ctx, sso, S, T, C, [line(described(`authority ${label}`), 1, 100)]);
      const verdict = verdictOf(await ctx.eligibility(s, S, draft), `${label}: the eligibility`);
      const preview = await ctx.preview(s, S, draft);
      const key = randomUUID();
      const keys = [{ key, principal: principals[who] }];
      const state = await stateOf(draft);
      const before = await counts([T], keys);
      if (verdict === 'allowed') {
        const expected = previewOf(preview, `${label}: the preview`).expected;
        assert.deepEqual(expected, issueBody(T, 1, settingsVersion, 1), `${label}: the preview's expected body`);
        issuedOf(await ctx.issue(s, S, draft, expected, { key }), { draftId: draft, version: 2, store: S }, `${label}: the POST`);
        assert.deepEqual(delta(await counts([T], keys), before), ONE_ISSUE(1), `${label}: one issue`);
        issued += 1;
        assert.equal(await counterOf(S), String(issued), `${label}: the store's counter at the number`);
      } else {
        assertRefusal(preview, 403, 'forbidden', `${label}: the preview`);
        assert.equal(ctx.reason(preview), 'authz_denied', `${label}: the preview is the authorizer's refusal`);
        const reply = await ctx.issue(s, S, draft, issueBody(T, 1, settingsVersion, 1), { key });
        assertRefusal(reply, 403, 'forbidden', `${label}: the POST`);
        assert.equal(ctx.reason(reply), 'authz_denied', `${label}: the authorizer's own refusal`);
        assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: nothing written`);
        assert.equal(await recordsOf(key, principals[who]), 0, `${label}: refused before any key`);
        assert.deepEqual(await stateOf(draft), state, `${label}: the draft untouched`);
      }
      return verdict;
    };
    const verdicts = {};
    verdicts['store_owner (fixed Full)'] = await decide('store_owner', 'store_owner');
    // view_issued_invoices (Invoices >= View and Customers >= View): the store owner's issue above is the invoice they read.
    const [{ invoice_id: invoice }] = await owner`select invoice_id from tmpos_invoice_issue.issued_invoice where store_id = ${S} and number = 1`;
    SECRETS.add(invoice);
    /** The list and the detail together: both the 200 (the detail of that invoice), or both the authorizer's 403. */
    const readsOf = async (who, label) => {
      const list = await ctx.invoices(sessions[who], S);
      const detail = await ctx.invoice(sessions[who], S, invoice);
      if (list.status === 200) {
        assert.ok(pageOf(list, `${label}: the list`).invoices.some((i) => i.id === invoice), `${label}: the list holds the invoice`);
        assert.equal(detail.status, 200, `${label}: the detail allowed with the list: ${detail.body}`);
        assertBaseline(detail, `${label}: the detail`);
        assert.equal(JSON.parse(detail.body).invoice.id, invoice, `${label}: the detail of that invoice`);
        return 'allowed';
      }
      for (const [reply, what] of [[list, 'the list'], [detail, 'the detail']]) {
        assertRefusal(reply, 403, 'forbidden', `${label}: ${what}`);
        assert.equal(ctx.reason(reply), 'authz_denied', `${label}: ${what} is the authorizer's refusal`);
      }
      return 'forbidden';
    };
    const reads = { store_owner: await readsOf('store_owner', 'store_owner reads') };
    for (const role of ['manager', 'technician', 'sales_staff']) verdicts[`${role} default`] = await decide(role, `${role} at its default`);
    reads['technician default (Invoices view)'] = await readsOf('technician', 'the technician default reads');
    await putLevel(ctx, sb, T, 'manager', 'invoices', 'none', 'IIH-01');
    reads['manager invoices none'] = await readsOf('manager', 'a manager at Invoices none reads');
    for (const level of ['manage', 'approve', 'full']) {
      await putLevel(ctx, sb, T, 'manager', 'invoices', level, 'IIH-01');
      verdicts[`manager invoices ${level}`] = await decide('manager', `manager at Invoices ${level}`);
    }
    await putLevel(ctx, sb, T, 'manager', 'customers', 'none', 'IIH-01');
    verdicts['manager invoices full, customers none'] = await decide('manager', 'manager at Invoices full, Customers none');
    reads['manager invoices full, customers none'] = await readsOf('manager', 'a manager at Invoices full, Customers none reads');
    await putLevel(ctx, sb, T, 'manager', 'customers', 'view', 'IIH-01');
    verdicts['manager invoices full, customers view'] = await decide('manager', 'manager at Invoices full, Customers view');
    reads['manager invoices full, customers view'] = await readsOf('manager', 'a manager at Invoices full, Customers view reads');
    await putLevel(ctx, sb, T, 'technician', 'invoices', 'approve', 'IIH-01');
    verdicts['technician invoices approve (customers default view)'] = await decide('technician', 'technician raised to Invoices approve');
    verdicts['read-only account'] = await decide('ro', 'a read-only account (store_owner grant)');
    verdicts['tenant grant only'] = await decide('boss', 'a tenant grant only');
    verdicts['another store\'s grant'] = await decide('elsewhere', 'a grant at another store only');
    for (const [label, change, restore] of [
      ['a read-only tenant', () => owner`update tenant set status = 'read_only' where tenant_id = ${T}`, () => owner`update tenant set status = 'active' where tenant_id = ${T}`],
      ['a read-only store', () => owner`update store set status = 'read_only' where store_id = ${S}`, () => owner`update store set status = 'active' where store_id = ${S}`],
    ]) {
      const id = await seed(ctx, sso, S, T, C, [line(described(`authority ${label}`), 1, 100)]);
      await change();
      try {
        verdicts[label] = await decide('store_owner', label, { id, s: await signIn(ctx, so) });
      } finally {
        await restore();
      }
      // A status change moves the actor's standing: every earlier session is refused from now on, so the next seed signs in
      // again (only before the read-only store: the login limit is five per account per five minutes).
      if (label === 'a read-only tenant') sso = await signIn(ctx, so);
    }
    assert.deepEqual(verdicts, {
      'store_owner (fixed Full)': 'allowed', 'manager default': 'allowed', 'technician default': 'forbidden', 'sales_staff default': 'forbidden',
      'manager invoices manage': 'forbidden', 'manager invoices approve': 'allowed', 'manager invoices full': 'allowed',
      'manager invoices full, customers none': 'forbidden', 'manager invoices full, customers view': 'allowed',
      'technician invoices approve (customers default view)': 'allowed', 'read-only account': 'forbidden', 'tenant grant only': 'forbidden',
      'another store\'s grant': 'forbidden', 'a read-only tenant': 'forbidden', 'a read-only store': 'forbidden',
    });
    assert.deepEqual(reads, {
      store_owner: 'allowed', 'technician default (Invoices view)': 'allowed', 'manager invoices none': 'forbidden',
      'manager invoices full, customers none': 'forbidden', 'manager invoices full, customers view': 'allowed',
    }, 'view_issued_invoices: Invoices >= View and Customers >= View, told apart from issue_invoices by the technician default');
    // The levels back at the catalog defaults (manager Invoices full already; manager Customers full, technician Invoices view),
    // by a new owner session: the tenant's status changes above moved every earlier session's standing.
    const sbAfter = await signIn(ctx, boss);
    await putLevel(ctx, sbAfter, T, 'manager', 'customers', 'full', 'IIH-01 restore');
    await putLevel(ctx, sbAfter, T, 'technician', 'invoices', 'view', 'IIH-01 restore');
  });
});

// ===========================================================================
// IIH-02: cross-store and cross-tenant isolation
// ===========================================================================

test('IIH-02 (ISS-04 AC-03): isolation — a missing, another store\'s and another tenant\'s draft are one 404 for the preview and the issue (the issue rolled back, its lease open); a missing, another store\'s and another tenant\'s invoice one 404; an unknown, another store\'s, another tenant\'s, an open and a discarded source draft the same empty page; a foreign or unknown cursor the 400; an ungranted, foreign, missing or non-canonical store the 403 before any key; two stores\' numbers independent', async () => {
  const T = await newTenant('iih02');
  const T2 = await newTenant('iih02-other');
  const S1 = await newStore(T, 'IIH02 one');
  const S2 = await newStore(T, 'IIH02 two');
  const S3 = await newStore(T, 'IIH02 ungranted');
  const X = await newStore(T2, 'IIH02 foreign');
  const C = await newCustomer(T, 'iih02');
  const C2 = await newCustomer(T2, 'iih02-foreign');
  const who = await actor('iih02', [storeGrant(T, S1, 'manager'), storeGrant(T, S2, 'manager')]);
  const foreign = await actor('iih02-foreign', [storeGrant(T2, X, 'manager')]);
  const boss = await actor('iih02-boss', [tenantGrant(T, 'store_owner')]);
  const boss2 = await actor('iih02-boss2', [tenantGrant(T2, 'store_owner')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const sf = await signIn(ctx, foreign);
    for (const [owner_, tenant, store] of [[boss, T, S1], [boss, T, S2], [boss2, T2, X]]) await configure(ctx, await signIn(ctx, owner_), tenant, store, sellerOf(`iih02 ${store.slice(0, 4)}`));
    const issueAt = async (sess, store, tenant, customer, label) => {
      const id = await seed(ctx, sess, store, tenant, customer, [line(described(label), 2, 50)]);
      const expected = previewOf(await ctx.preview(sess, store, id), `${label}: preview`).expected;
      return { draft: id, invoice: issuedOf(await ctx.issue(sess, store, id, expected), { draftId: id, version: 2, store }, label) };
    };
    const i1 = await issueAt(s, S1, T, C, 'iih02 first at S1');
    const i2 = await issueAt(s, S2, T, C, 'iih02 first at S2');
    const i3 = await issueAt(s, S1, T, C, 'iih02 second at S1');
    const iX = await issueAt(sf, X, T2, C2, 'iih02 first at X');
    const numberOf = async (sess, store, id) => JSON.parse((await ctx.invoice(sess, store, id)).body).invoice.number;
    assert.deepEqual([await numberOf(s, S1, i1.invoice), await numberOf(s, S1, i3.invoice), await numberOf(s, S2, i2.invoice), await numberOf(sf, X, iX.invoice)],
      [1, 2, 1, 1], 'each store numbers from 1, independently');
    assert.deepEqual([await counterOf(S1), await counterOf(S2), await counterOf(X), await counterOf(S3)], ['2', '1', '1', 'none'], 'the counters as stored');
    const open1 = await seed(ctx, s, S1, T, C, [line(described('iih02 open S1'), 1, 1)]);
    const open2 = await seed(ctx, s, S2, T, C, [line(described('iih02 open S2'), 1, 1)]);
    const disc1 = await seed(ctx, s, S1, T, C, [line(described('iih02 discarded S1'), 1, 1)]);
    assert.equal((await ctx.discard(s, S1, disc1, discardBody(T, 1))).status, 200, 'the discarded source draft');
    const theirsOpen = await seed(ctx, sf, X, T2, C2, [line(described('iih02 open X'), 1, 1)]);
    // (1) Drafts: one 404 for the preview and one for the issue.
    const previews = [];
    const issues = [];
    for (const [label, draft] of [['a missing draft', randomUUID()], ['another store\'s open draft', open2], ['another tenant\'s open draft', theirsOpen], ['another store\'s issued draft', i2.draft]]) {
      const p = await ctx.preview(s, S1, draft);
      assertRefusal(p, 404, 'not_found', `${label}: the preview`);
      previews.push({ bytes: Buffer.byteLength(p.body), reason: ctx.reason(p) });
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T, T2], keys);
      const r = await ctx.issue(s, S1, draft, issueBody(T, 1, 1, 1), { key });
      assertRefusal(r, 404, 'not_found', `${label}: the issue`);
      issues.push({ bytes: Buffer.byteLength(r.body), reason: ctx.reason(r) });
      assert.deepEqual(delta(await counts([T, T2], keys), before), LEASE_ONLY, `${label}: rolled back, nothing but the open lease`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease open`);
    }
    assert.equal(new Set(previews.map((x) => JSON.stringify(x))).size, 1, `one preview 404: ${JSON.stringify(previews)}`);
    assert.equal(previews[0].reason, 'invoice_issue_preview_not_found');
    assert.equal(new Set(issues.map((x) => JSON.stringify(x))).size, 1, `one issue 404: ${JSON.stringify(issues)}`);
    assert.equal(issues[0].reason, 'transaction_not_found');
    // (2) Invoices: one 404.
    const details = [];
    for (const [label, invoice] of [['a missing invoice', randomUUID()], ['another store\'s invoice', i2.invoice], ['another tenant\'s invoice', iX.invoice]]) {
      const r = await ctx.invoice(s, S1, invoice);
      assertRefusal(r, 404, 'not_found', label);
      details.push({ bytes: Buffer.byteLength(r.body), reason: ctx.reason(r) });
    }
    assert.equal(new Set(details.map((x) => JSON.stringify(x))).size, 1, `one detail 404: ${JSON.stringify(details)}`);
    assert.equal(details[0].reason, 'issued_invoice_not_found');
    assert.equal(JSON.parse((await ctx.invoice(s, S2, i2.invoice)).body).invoice.id, i2.invoice, 'control: its own store reads it');
    // (3) The source-draft filter: the same empty page for every foreign or non-issued draft.
    for (const [label, draft] of [['unknown', randomUUID()], ['another store\'s issued draft', i2.draft], ['another tenant\'s issued draft', iX.draft], ['an open draft', open1], ['a discarded draft', disc1]]) {
      assert.deepEqual(pageOf(await ctx.invoices(s, S1, `?sourceDraft=${draft}`), label), { invoices: [], nextCursor: null }, `${label}: the empty page`);
    }
    assert.deepEqual(pageOf(await ctx.invoices(s, S1, `?sourceDraft=${i1.draft}`), 'its own issued draft').invoices.map((i) => i.id), [i1.invoice]);
    // (4) Paging, newest number first; a foreign or unknown anchor is the 400.
    const first = pageOf(await ctx.invoices(s, S1, '?limit=1'), 'page one');
    assert.deepEqual(first.invoices.map((i) => [i.id, i.number]), [[i3.invoice, 2]]);
    const last = pageOf(await ctx.invoices(s, S1, `?limit=1&cursor=${first.nextCursor}`), 'page two');
    assert.deepEqual([last.invoices.map((i) => [i.id, i.number]), last.nextCursor], [[[i1.invoice, 1]], null]);
    for (const [label, anchor] of [['another store\'s invoice', i2.invoice], ['another tenant\'s invoice', iX.invoice], ['an unknown invoice', randomUUID()]]) {
      const r = await ctx.invoices(s, S1, `?cursor=${encodeIssuedInvoiceCursor(anchor)}`);
      assertRefusal(r, 400, 'invalid_request', `a cursor naming ${label}`);
      assert.equal(ctx.reason(r), 'issued_invoice_cursor_unknown');
    }
    assertRefusal(await ctx.invoices(s, S1, `?sourceDraft=${i1.draft}&cursor=${first.nextCursor}`), 400, 'invalid_request', 'a cursor beside the filter');
    assert.deepEqual(pageOf(await ctx.invoices(sf, X, ''), 'the foreign tenant\'s own list').invoices.map((i) => i.id), [iX.invoice]);
    // (5) A store the actor holds no grant at, another tenant's, a missing and a non-canonical one: the 403 before any key.
    for (const [label, store] of [['an ungranted store', S3], ['another tenant\'s store', X], ['a missing store', randomUUID()], ['a non-canonical store', S1.toUpperCase()]]) {
      const key = randomUUID();
      const before = await counts([T, T2]);
      for (const [what, reply] of [
        ['eligibility', await ctx.eligibility(s, store, open1)], ['preview', await ctx.preview(s, store, open1)], ['list', await ctx.invoices(s, store)],
        ['detail', await ctx.invoice(s, store, i1.invoice)], ['issue', await ctx.issue(s, store, open1, issueBody(T, 1, 1, 1), { key })],
      ]) assertRefusal(reply, 403, 'forbidden', `${label}: the ${what}`);
      assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(key, who.principal), 0, `${label}: no key acquired`);
    }
  });
});

// ===========================================================================
// IIH-03: preview -> issue -> reads
// ===========================================================================

test('IIH-03 (ISS-15 ISS-17 AC-04): the preview\'s exact body (lines, customer, settings, amounts labelled Tax, expected); the POST with exactly preview.expected is the 201 with its Location; the Location reads number 1, the snapshot, snapshotVersion 1 — no actor, phone or email, nothing labelled due, paid or balance; the list and ?sourceDraft= serve it; the draft has left the drafts list and its reopen and preview are 404; ONE audit record (store.invoice.issue, scope store, tenant, store, actor, subjects draft + invoice + customer, metadata {}), NO outbox row, the completion recorded', async () => {
  const { T, S, C, boss, mgr } = await world('iih03');
  await withEntry((a) => withEntry(async (b) => {
    const sb = await signIn(a, boss);
    const s = await signIn(a, mgr);
    const sb2 = await signIn(b, mgr);
    const seller = sellerOf('iih03');
    const settingsVersion = await configure(a, sb, T, S, seller);
    const lines = [line(described('iih03 one'), 2, 1999), line(described('iih03 two'), 3, 7)];
    const id = await seed(a, s, S, T, C, lines);
    const subtotal = subtotalOf(lines);
    const amounts = amountsFor(subtotal, RATE_8875);
    const expected = issueBody(T, 1, settingsVersion, 1);
    const previewReply = await a.preview(s, S, id);
    assert.equal(previewReply.status, 200, previewReply.body);
    assert.equal(previewReply.body, JSON.stringify({
      preview: {
        draft: { id, version: 1, lines: linesFor(lines), subtotalCents: subtotal },
        customer: { id: C, name: NAMES.get(C), version: 1 },
        issuingSettings: { version: settingsVersion, legalName: seller.legalName, storeName: seller.storeName, postalAddress: seller.postalAddress, taxRegistrationId: seller.taxRegistrationId, tax: taxWire(RATE_8875) },
        amounts, expected,
      },
    }), 'the preview, byte for byte');
    assertBaseline(previewReply, 'the preview');
    const key = randomUUID();
    const keys = [{ key, principal: mgr.principal }];
    const before = await counts([T], keys);
    const [{ t: t0 }] = await owner`select pg_catalog.clock_timestamp()::text as t`;
    const reply = await a.issue(s, S, id, JSON.parse(previewReply.body).preview.expected, { key });
    const [{ t: t1 }] = await owner`select pg_catalog.clock_timestamp()::text as t`;
    const invoice = issuedOf(reply, { draftId: id, version: 2, store: S }, 'the issue');
    assert.deepEqual(delta(await counts([T], keys), before), ONE_ISSUE(2), 'one issue: the draft issued, one invoice, two lines, the counter +1, one audit record, one completion, NO outbox row');
    assert.equal(await counterOf(S), '1');
    const row = await issuedRowOf(id);
    assert.deepEqual(row, { invoice_id: invoice, number: '1', issued_by: mgr.id, settings_version: '1', customer_version: '1', tax_cents: String(amounts.tax.amountCents), total_cents: String(amounts.totalCents) }, 'the stored header (the actor kept, never served)');
    // The Location, read on the SECOND entry.
    const detailReply = await b.read(sb2, reply.headers.location);
    assert.equal(detailReply.status, 200, detailReply.body);
    assertBaseline(detailReply, 'the detail');
    const issuedAt = JSON.parse(detailReply.body).invoice.issuedAt;
    assert.match(issuedAt, ISSUED_AT_RE, 'issuedAt: UTC with microseconds');
    assert.equal((await owner`select ${issuedAt}::timestamptz between ${t0}::timestamptz and ${t1}::timestamptz as inside`)[0].inside, true, 'issuedAt is the database\'s time inside the request');
    assert.equal(detailReply.body, JSON.stringify({
      invoice: {
        id: invoice, number: 1, status: 'issued', snapshotVersion: 1, issuedAt, sourceDraft: { id, version: 1 },
        seller: { legalName: seller.legalName, storeName: seller.storeName, postalAddress: seller.postalAddress, taxRegistrationId: seller.taxRegistrationId },
        issuingSettingsVersion: settingsVersion, customer: { id: C, name: NAMES.get(C), version: 1 }, lines: linesFor(lines), amounts,
      },
    }), 'the detail, byte for byte');
    const phoneEmail = (await owner`select phone, email from tmpos_customer.customer where customer_id = ${C}`)[0];
    for (const v of [mgr.id, mgr.uid, phoneEmail.phone, phoneEmail.email]) assert.ok(!detailReply.body.includes(v), 'no actor, phone or email in the detail');
    assert.deepEqual(keysOf(JSON.parse(detailReply.body)).filter((k) => /due|paid|balance/i.test(k)), [], 'nothing labelled due, paid, unpaid or balance');
    const listItem = { id: invoice, number: 1, sourceDraftId: id, customerId: C, customerName: NAMES.get(C), currency: 'USD', totalCents: amounts.totalCents, issuedAt, status: 'issued', snapshotVersion: 1 };
    const listReply = await b.invoices(sb2, S);
    assert.equal(listReply.body, JSON.stringify({ invoices: [listItem], nextCursor: null }), 'the list, byte for byte');
    assert.equal((await b.invoices(sb2, S, `?sourceDraft=${id}`)).body, JSON.stringify({ invoices: [listItem], nextCursor: null }), 'the recovery filter finds it');
    for (const v of [mgr.id, phoneEmail.phone, phoneEmail.email]) assert.ok(!listReply.body.includes(v), 'no actor, phone or email in the list');
    // The draft has left the open-draft reads.
    assert.deepEqual(JSON.parse((await b.list(sb2, S)).body).drafts.map((d) => d.id), [], 'the drafts list omits it');
    const reopen = await b.get(sb2, S, id);
    assertRefusal(reopen, 404, 'not_found', 'the issued draft\'s reopen');
    assert.equal(b.reason(reopen), 'invoice_draft_not_found');
    assertRefusal(await b.preview(sb2, S, id), 404, 'not_found', 'the issued draft\'s preview');
    // The one audit record.
    const audits = await owner`select scope_type, tenant_id, store_id, actor_internal_user_id, action_id, required_permission, decision, result_status, metadata,
      subject_invoice_draft_id, subject_issued_invoice_id, subject_customer_id, subject_store_id, subject_tenant_id
      from public.audit_event where action_id = ${ACTION} and tenant_id = ${T}`;
    assert.deepEqual(audits.map((r) => ({ ...r })), [{
      scope_type: 'store', tenant_id: T, store_id: S, actor_internal_user_id: mgr.id, action_id: ACTION, required_permission: PERMISSION, decision: 'allow',
      result_status: 'succeeded', metadata: {}, subject_invoice_draft_id: id, subject_issued_invoice_id: invoice, subject_customer_id: C, subject_store_id: null, subject_tenant_id: null,
    }], 'exactly one issue record: three subjects at store scope, metadata {}');
    assert.equal((await owner`select count(*)::int as n from tmpos_internal.outbox_event where aggregate_id in (${id}, ${invoice})`)[0].n, 1, 'only the save\'s own event: the issue enqueued none');
    assert.equal(await leaseOpen(key, mgr.principal), false, 'the completion recorded');
  }));
});

// ===========================================================================
// IIH-04: refusals and their effects
// ===========================================================================

test('IIH-04 (ISS-07 ISS-12 ISS-12b AC-02 AC-05): a stale or future draft, settings and customer version are the sealed 409 write_conflict (replayed under the key; the counter unchanged, no audit); a discarded and an already-issued draft the sealed invalid_state; no settings the sealed issuing_not_configured (decided after the state, before the version); a total above 2^53 - 1 the sealed amount_out_of_range with nothing allocated; an expectedTenant mismatch the unsealed 409 (the lease kept, no completion); malformed bodies the 400 with the lease and nothing else', async () => {
  const { T, S, C, boss, mgr } = await world('iih04');
  const S0 = await newStore(T, 'IIH04 unconfigured');
  const SB = await newStore(T, 'IIH04 big');
  const mgr0 = await actor('iih04-mgr0', [storeGrant(T, S0, 'manager'), storeGrant(T, SB, 'manager')]);
  await withEntry(async (ctx) => {
    const sb = await signIn(ctx, boss);
    const s = await signIn(ctx, mgr);
    const s0 = await signIn(ctx, mgr0);
    let settingsVersion = await configure(ctx, sb, T, S, sellerOf('iih04'));
    const sealedCase = async (sess, principal, store, id, body, word, label) => {
      const key = randomUUID();
      const keys = [{ key, principal }];
      const state = await stateOf(id);
      const counter = await counterOf(store);
      const before = await counts([T], keys);
      const first = await ctx.issue(sess, store, id, body, { key });
      sealedOf(first, word, label);
      const again = await ctx.issue(sess, store, id, body, { key });
      sealedOf(again, word, `${label}: replayed`, { replayed: true });
      assert.equal(again.body, first.body, `${label}: byte for byte`);
      assert.deepEqual(delta(await counts([T], keys), before), COMPLETION_ONLY, `${label}: its completion only — no number, invoice, draft change or audit record`);
      assert.deepEqual(await stateOf(id), state, `${label}: the draft untouched`);
      assert.equal(await counterOf(store), counter, `${label}: the counter unchanged`);
    };
    // (1) Versions: the draft (moved by an edit), the settings (moved by the owner's PUT), the customer (moved by a rename).
    const lines = [line(described('iih04 one'), 1, 500)];
    const id = await seed(ctx, s, S, T, C, lines);
    assert.equal((await ctx.patch(s, S, id, editBody(T, 1, C, [line(described('iih04 two'), 2, 250)]))).status, 200, 'the draft to version 2');
    settingsVersion = await configure(ctx, sb, T, S, sellerOf('iih04 v2'));
    const renamed = described('iih04 renamed');
    const rename = await ctx.renameCustomer(sb, C, { expectedVersion: 1, name: renamed });
    assert.equal(rename.status, 200, `the customer to version 2: ${rename.body}`);
    NAMES.set(C, renamed);
    for (const [label, body] of [
      ['a stale draft version', issueBody(T, 1, settingsVersion, 2)], ['a future draft version', issueBody(T, 3, settingsVersion, 2)],
      ['a stale settings version', issueBody(T, 2, settingsVersion - 1, 2)], ['a future settings version', issueBody(T, 2, settingsVersion + 5, 2)],
      ['a stale customer version', issueBody(T, 2, settingsVersion, 1)], ['a future customer version', issueBody(T, 2, settingsVersion, 99)],
    ]) await sealedCase(s, mgr.principal, S, id, body, 'write_conflict', label);
    // (2) The expectedTenant precondition: unsealed, rolled back, the lease kept.
    for (const [label, tenant] of [['another tenant', await newTenant('iih04-other')], ['a tenant that does not exist', randomUUID()]]) {
      const key = randomUUID();
      const keys = [{ key, principal: mgr.principal }];
      const before = await counts([T], keys);
      const reply = await ctx.issue(s, S, id, issueBody(tenant, 2, settingsVersion, 2), { key });
      assertRefusal(reply, 409, 'write_conflict', `${label}: the precondition`);
      assert.equal(ctx.reason(reply), 'transaction_precondition_failed', label);
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: no completion, the lease open`);
      assertRefusal(await ctx.issue(s, S, id, issueBody(tenant, 2, settingsVersion, 2), { key }), 409, 'request_in_progress', `${label}: the same-key retry within the lease`);
    }
    // (3) Malformed bodies: the planner's 400 after the key — the lease and nothing else.
    const valid = JSON.stringify(issueBody(T, 2, settingsVersion, 2));
    for (const [label, body] of [
      ['an extra key', JSON.stringify({ ...issueBody(T, 2, settingsVersion, 2), total: 1 })],
      ['a missing key', JSON.stringify({ expectedTenant: T, expectedVersion: 2, expectedSettingsVersion: settingsVersion })],
      ['-0', valid.replace('"expectedVersion":2', '"expectedVersion":-0')],
      ['a fraction', valid.replace('"expectedVersion":2', '"expectedVersion":1.5')],
      ['a string number', valid.replace('"expectedVersion":2', '"expectedVersion":"2"')],
      ['a version past 2^53 - 2', valid.replace('"expectedVersion":2', `"expectedVersion":${MAX}`)],
      ['a settings version 0', valid.replace(`"expectedSettingsVersion":${settingsVersion}`, '"expectedSettingsVersion":0')],
      ['a customer version past 2^53 - 1', valid.replace('"expectedCustomerVersion":2', '"expectedCustomerVersion":9007199254740992')],
      ['an upper-case tenant', valid.replace(T, T.toUpperCase())],
    ]) {
      assert.notEqual(body, valid, `${label}: the body differs`);
      const key = randomUUID();
      const keys = [{ key, principal: mgr.principal }];
      const before = await counts([T], keys);
      const reply = await ctx.issue(s, S, id, body, { key });
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'command_request_invalid', `${label}: the planner's refusal`);
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: the lease acquired, nothing else`);
    }
    // Control: the current versions issue.
    const key = randomUUID();
    const before = await counts([T], [{ key, principal: mgr.principal }]);
    issuedOf(await ctx.issue(s, S, id, issueBody(T, 2, settingsVersion, 2), { key }), { draftId: id, version: 3, store: S }, 'the current versions');
    assert.deepEqual(delta(await counts([T], [{ key, principal: mgr.principal }]), before), ONE_ISSUE(1), 'one issue');
    // (4) Terminal drafts: an already-issued draft (whatever version it names) and a discarded one.
    await sealedCase(s, mgr.principal, S, id, issueBody(T, 3, settingsVersion, 2), 'invalid_state', 'the already-issued draft at its current version');
    await sealedCase(s, mgr.principal, S, id, issueBody(T, 2, settingsVersion, 2), 'invalid_state', 'the already-issued draft at the version it was issued from');
    const discarded = await seed(ctx, s, S, T, C, [line(described('iih04 discarded'), 1, 1)]);
    assert.equal((await ctx.discard(s, S, discarded, discardBody(T, 1))).status, 200, 'discarded');
    await sealedCase(s, mgr.principal, S, discarded, issueBody(T, 2, settingsVersion, 2), 'invalid_state', 'a discarded draft');
    // (5) A store without settings: the preview's unsealed 409 and the issue's sealed one; the state first, then the settings.
    const unconfigured = await seed(ctx, s0, S0, T, C, [line(described('iih04 unconfigured'), 1, 1)]);
    const p = await ctx.preview(s0, S0, unconfigured);
    assertRefusal(p, 409, 'issuing_not_configured', 'the preview at a store without settings');
    assert.equal(ctx.reason(p), 'invoice_issue_preview_not_configured');
    await sealedCase(s0, mgr0.principal, S0, unconfigured, issueBody(T, 1, 1, 2), 'issuing_not_configured', 'a store without settings');
    await sealedCase(s0, mgr0.principal, S0, unconfigured, issueBody(T, 7, 1, 2), 'issuing_not_configured', 'a store without settings and a stale version: the settings before the version');
    const gone = await seed(ctx, s0, S0, T, C, [line(described('iih04 unconfigured discarded'), 1, 1)]);
    assert.equal((await ctx.discard(s0, S0, gone, discardBody(T, 1))).status, 200, 'discarded at the unconfigured store');
    await sealedCase(s0, mgr0.principal, S0, gone, issueBody(T, 2, 1, 2), 'invalid_state', 'a discarded draft at a store without settings: the state before the settings');
    assert.equal(await counterOf(S0), 'none', 'still no counter at the unconfigured store');
    // (6) A total above 2^53 - 1 at a 100 % rate: the preview's unsealed 409 and the issue's sealed one; nothing allocated.
    const bigVersion = await configure(ctx, sb, T, SB, sellerOf('iih04 big', { mode: 'exclusive_rate', rateMilliPercent: 100_000 }));
    const big = await seed(ctx, s0, SB, T, C, [line(described('iih04 big'), 1, MAX)]);
    const bp = await ctx.preview(s0, SB, big);
    assertRefusal(bp, 409, 'amount_out_of_range', 'the preview of a total above 2^53 - 1');
    assert.equal(ctx.reason(bp), 'invoice_issue_preview_amount_out_of_range');
    await sealedCase(s0, mgr0.principal, SB, big, issueBody(T, 1, bigVersion, 2), 'amount_out_of_range', 'a total above 2^53 - 1');
    assert.equal(await counterOf(SB), '0', 'the counter still at 0: no number allocated');
  });
});

// ===========================================================================
// IIH-05: the tax modes through the whole path
// ===========================================================================

test('IIH-05 (ISS-11 ISS-12 ISS-12b AC-05): both tax modes and an explicit zero rate through the preview, the issue, the detail, the list and the stored header — 1 x 1999 at 8875 is tax 177, total 2176; 10 + 10 at 5000 is tax 1; rate 0 is tax 0 labelled Tax; none is "No tax calculated", total = subtotal; each snapshot keeps the settings it was issued under', async () => {
  const { T, S, C, boss, so } = await world('iih05');
  await withEntry(async (ctx) => {
    const sb = await signIn(ctx, boss);
    const s = await signIn(ctx, so);
    const cases = [
      { label: '1 x 1999 at 8875', tax: RATE_8875, lines: [line(described('iih05 a'), 1, 1999)], taxCents: 177, total: 2176 },
      { label: '10 + 10 at 5000', tax: { mode: 'exclusive_rate', rateMilliPercent: 5000 }, lines: [line(described('iih05 b1'), 1, 10), line(described('iih05 b2'), 1, 10)], taxCents: 1, total: 21 },
      { label: 'an explicit zero rate', tax: { mode: 'exclusive_rate', rateMilliPercent: 0 }, lines: [line(described('iih05 c'), 3, 333)], taxCents: 0, total: 999 },
      { label: 'none', tax: NO_TAX, lines: [line(described('iih05 d'), 4, 250)], taxCents: null, total: 1000 },
    ];
    const issued = [];
    for (const [n, c] of cases.entries()) {
      const version = await configure(ctx, sb, T, S, sellerOf(`iih05 ${n}`, c.tax, { taxId: n % 2 === 0 }), c.label);
      const amounts = amountsFor(subtotalOf(c.lines), c.tax);
      assert.equal(amounts.totalCents, c.total, `${c.label}: the worked example's total`);
      if (c.taxCents !== null) assert.equal(amounts.tax.amountCents, c.taxCents, `${c.label}: the worked example's tax`);
      else assert.deepEqual(amounts.tax, { mode: 'none', description: 'No tax calculated' });
      const id = await seed(ctx, s, S, T, C, c.lines);
      const preview = previewOf(await ctx.preview(s, S, id), `${c.label}: preview`);
      assert.deepEqual([preview.amounts, preview.issuingSettings.tax, preview.issuingSettings.version], [amounts, taxWire(c.tax), version], `${c.label}: the preview's amounts and tax setting`);
      const invoice = issuedOf(await ctx.issue(s, S, id, preview.expected), { draftId: id, version: 2, store: S }, `${c.label}: the issue`);
      issued.push({ invoice, amounts, version, number: n + 1, tax: c.tax });
      const row = await issuedRowOf(id);
      assert.deepEqual([row.number, row.tax_cents, row.total_cents, row.settings_version], [String(n + 1), c.taxCents === null ? null : String(c.taxCents), String(c.total), String(version)], `${c.label}: the stored header`);
    }
    for (const x of issued) {
      const detail = JSON.parse((await ctx.invoice(s, S, x.invoice)).body).invoice;
      assert.deepEqual([detail.number, detail.amounts, detail.issuingSettingsVersion], [x.number, x.amounts, x.version], `invoice ${x.number}: its own amounts and settings version, after later settings writes`);
    }
    const page = pageOf(await ctx.invoices(s, S), 'the list');
    assert.deepEqual(page.invoices.map((i) => [i.number, i.totalCents]), [[4, 1000], [3, 999], [2, 21], [1, 2176]], 'newest number first, each its own total');
  });
});

// ===========================================================================
// IIH-06: replay and recovery
// ===========================================================================

test('IIH-06 (ISS-08 ISS-18 AC-08): the same key and body replay the recorded 201 (same invoice, no second number); the same key with another body is the 422; a new key the sealed invalid_state; past its retention the same key is a new operation answering invalid_state, still one invoice; a replay after the owner narrows the level is the 403, after a revocation the 401, after the restoration the recorded bytes; ?sourceDraft= requires the current Customers View (lost: the 403)', async () => {
  const { T, S, C, boss, mgr } = await world('iih06');
  await withEntry(async (ctx) => {
    const sb = await signIn(ctx, boss);
    const s = await signIn(ctx, mgr);
    const settingsVersion = await configure(ctx, sb, T, S, sellerOf('iih06'));
    const id = await seed(ctx, s, S, T, C, [line(described('iih06 one'), 1, 42)]);
    const body = JSON.stringify(issueBody(T, 1, settingsVersion, 1));
    const key = randomUUID();
    const keys = [{ key, principal: mgr.principal }];
    const before = await counts([T], keys);
    const first = await ctx.issue(s, S, id, body, { key });
    const invoice = issuedOf(first, { draftId: id, version: 2, store: S }, 'the issue');
    const replay = await ctx.issue(s, S, id, body, { key });
    issuedOf(replay, { draftId: id, version: 2, store: S }, 'the replay', { replayed: true });
    assert.equal(replay.body, first.body, 'the recorded 201, byte for byte: the same invoice id');
    assert.equal(replay.headers.location, first.headers.location);
    assertRefusal(await ctx.issue(s, S, id, JSON.stringify(issueBody(T, 1, settingsVersion + 1, 1)), { key }), 422, 'idempotency_key_reused', 'the same key, another body');
    assert.deepEqual(delta(await counts([T], keys), before), ONE_ISSUE(1), 'the replay and the 422 wrote nothing: one invoice, one number');
    sealedOf(await ctx.issue(s, S, id, body), 'invalid_state', 'a new key at the issued draft');
    // Past its retention the key's record is overwritten in place: a new operation, decided on the current state.
    await expireRetention(key, mgr.principal);
    const afterRetention = await counts([T], keys);
    sealedOf(await ctx.issue(s, S, id, body, { key }), 'invalid_state', 'the same key past its retention: a new operation');
    assert.deepEqual(delta(await counts([T], keys), afterRetention), { ...NOTHING, C: 0 }, 'the record reused in place: no new invoice, number or audit record');
    assert.equal((await counts([T])).N, 1, 'still exactly one invoice');
    // Current authority on replay: a second issue under its own key.
    const id2 = await seed(ctx, s, S, T, C, [line(described('iih06 two'), 1, 43)]);
    const body2 = JSON.stringify(issueBody(T, 1, settingsVersion, 1));
    const key2 = randomUUID();
    const recorded = await ctx.issue(s, S, id2, body2, { key: key2 });
    const invoice2 = issuedOf(recorded, { draftId: id2, version: 2, store: S }, 'the second issue');
    await putLevel(ctx, sb, T, 'manager', 'invoices', 'manage', 'IIH-06');
    const narrowed = await ctx.issue(s, S, id2, body2, { key: key2 });
    assertRefusal(narrowed, 403, 'forbidden', 'the replay after the owner narrowed Invoices to manage');
    assert.equal(ctx.reason(narrowed), 'authz_denied', 'the authorizer, never the stored answer');
    await putLevel(ctx, sb, T, 'manager', 'invoices', 'full', 'IIH-06');
    const revoked = await signIn(ctx, mgr);
    await owner`select tmpos_session.m5_session_revoke(${revoked.key}::text)`;
    assertRefusal(await ctx.issue(revoked, S, id2, body2, { key: key2 }), 401, 'unauthenticated', 'the replay on a revoked session');
    const restored = await ctx.issue(s, S, id2, body2, { key: key2 });
    issuedOf(restored, { draftId: id2, version: 2, store: S }, 'the replay after the restoration', { replayed: true });
    assert.equal(restored.body, recorded.body, 'the recorded bytes');
    // The recovery filter under the current Customers level.
    assert.deepEqual(pageOf(await ctx.invoices(s, S, `?sourceDraft=${id2}`), 'the filter').invoices.map((i) => i.id), [invoice2]);
    await putLevel(ctx, sb, T, 'manager', 'customers', 'none', 'IIH-06');
    for (const [label, reply] of [['the filter', await ctx.invoices(s, S, `?sourceDraft=${id2}`)], ['the detail', await ctx.invoice(s, S, invoice2)], ['the list', await ctx.invoices(s, S)]]) {
      assertRefusal(reply, 403, 'forbidden', `${label} without Customers View`);
      assert.equal(ctx.reason(reply), 'authz_denied');
    }
    await putLevel(ctx, sb, T, 'manager', 'customers', 'view', 'IIH-06');
    assert.deepEqual(pageOf(await ctx.invoices(s, S, `?sourceDraft=${id}`), 'the filter at Customers View').invoices.map((i) => i.id), [invoice]);
    assert.deepEqual([await counterOf(S), (await counts([T])).N], ['2', 2], 'two numbers, two invoices, in all');
  });
});

// ===========================================================================
// IIH-07: lost COMMIT
// ===========================================================================

test('IIH-07 (ISS-10 AC-09): the COMMIT lands and its answer is lost — the 503, the invoice exists once with its number, the same key replays the 201; the COMMIT is cut — the 503, no invoice, the counter unchanged, the 409 until the lease ends, then the retry takes the very number the cut issue would have taken', async () => {
  const { T, S, C, boss, mgr } = await world('iih07');
  await withEntry(async (ctx) => {
    const sb = await signIn(ctx, boss);
    const s = await signIn(ctx, mgr);
    const settingsVersion = await configure(ctx, sb, T, S, sellerOf('iih07'));
    const lost = await seed(ctx, s, S, T, C, [line(described('iih07 lost'), 1, 5)]);
    const cut = await seed(ctx, s, S, T, C, [line(described('iih07 cut'), 1, 6)]);
    const trapped = async (mode, draft, key, label) => {
      const trap = trapCommit(ctx.relay, mode, AUDIT_ANCHOR);
      let reply;
      const sentAt = Date.now();
      try { reply = await ctx.issue(s, S, draft, issueBody(T, 1, settingsVersion, 1), { key }); } finally { trap.release(); }
      assert.equal(trap.hit.length, 1, `${label}: the trap engaged at exactly one COMMIT`);
      assertRefusal(reply, 503, 'service_unavailable', label);
      return { reply, elapsed: Date.now() - sentAt };
    };
    // (1) Landed, its answer lost.
    const key1 = randomUUID();
    const keys1 = [{ key: key1, principal: mgr.principal }];
    const before1 = await counts([T], keys1);
    const l = await trapped('lose', lost, key1, 'the lost answer');
    assert.equal(ctx.reason(l.reply), 'transaction_timeout', 'unknown at the commit deadline');
    await until(async () => (await counts([T], keys1)).K === before1.K + 1, 'the landed issue');
    assert.deepEqual(delta(await counts([T], keys1), before1), ONE_ISSUE(1), 'what committed is visible, whole');
    const landed = await issuedRowOf(lost);
    assert.equal(landed.number, '1', 'the invoice exists with number 1');
    const replay = await ctx.issue(s, S, lost, issueBody(T, 1, settingsVersion, 1), { key: key1 });
    assert.equal(issuedOf(replay, { draftId: lost, version: 2, store: S }, 'the same-key retry', { replayed: true }), landed.invoice_id, 'the replay names the invoice that landed');
    assert.deepEqual(delta(await counts([T], keys1), before1), ONE_ISSUE(1), 'never a second invoice or number');
    // (2) Cut: the server rolls the issue back.
    const key2 = randomUUID();
    const keys2 = [{ key: key2, principal: mgr.principal }];
    const state = await stateOf(cut);
    const before2 = await counts([T], keys2);
    await trapped('cut', cut, key2, 'the cut COMMIT');
    await headerFree(cut); // granted only once the cut transaction has ended
    assert.deepEqual(delta(await counts([T], keys2), before2), LEASE_ONLY, 'nothing landed: the lease alone');
    assert.deepEqual([await stateOf(cut), await issuedRowOf(cut), await counterOf(S)], [state, null, '1'], 'the draft as it was, no invoice, the counter unchanged');
    assertRefusal(await ctx.issue(s, S, cut, issueBody(T, 1, settingsVersion, 1), { key: key2 }), 409, 'request_in_progress', 'the same key within the lease');
    await expireLease(key2, mgr.principal);
    issuedOf(await ctx.issue(s, S, cut, issueBody(T, 1, settingsVersion, 1), { key: key2 }), { draftId: cut, version: 2, store: S }, 'after the lease: the explicit retry');
    assert.equal((await issuedRowOf(cut)).number, '2', 'the number the cut issue would have taken');
    assert.deepEqual(delta(await counts([T], keys2), before2), ONE_ISSUE(1), 'exactly one issue');
  });
});

// ===========================================================================
// IIH-08: atomicity
// ===========================================================================

test('IIH-08 (ISS-16 AC-06): a fault at the issued-invoice INSERT, the issued-line INSERT, the draft\'s transition UPDATE, the counter UPDATE, the issue\'s audit INSERT and its completion is the 503 — no invoice, no line, the draft still open at its version (xmin included), the counter unchanged, no audit record, no completion: nothing but the open lease; without a fault the same issue commits', async () => {
  const { T, S, C, boss, mgr } = await world('iih08');
  await withEntry(async (ctx) => {
    const sb = await signIn(ctx, boss);
    const s = await signIn(ctx, mgr);
    const settingsVersion = await configure(ctx, sb, T, S, sellerOf('iih08'));
    const id = await seed(ctx, s, S, T, C, [line(described('iih08 one'), 1, 10), line(described('iih08 two'), 2, 20)]);
    const state = await stateOf(id);
    for (const [label, table, event, when] of [
      ['the issued-invoice INSERT raises', 'tmpos_invoice_issue.issued_invoice', 'insert', `new.source_draft_id = '${id}'::uuid`],
      ['the issued-line INSERT raises', 'tmpos_invoice_issue.issued_invoice_line', 'insert', `new.tenant_id = '${T}'::uuid`],
      ['the draft\'s transition UPDATE raises', DRAFT_TABLE, 'update', `new.draft_id = '${id}'::uuid and new.status = 'issued'`],
      ['the counter UPDATE raises', 'tmpos_invoice_issue.store_invoice_counter', 'update', `new.store_id = '${S}'::uuid`],
      ['the audit INSERT raises', 'public.audit_event', 'insert', `new.action_id = '${ACTION}' and new.subject_invoice_draft_id = '${id}'::uuid`],
      ['the completion raises', 'tmpos_internal.idempotency_record', 'update', COMPLETION],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: mgr.principal }];
      const before = await counts([T], keys);
      const firedBefore = await fired();
      const reply = await withTrigger(table, event, when, 'raise', () => ctx.issue(s, S, id, issueBody(T, 1, settingsVersion, 1), { key }));
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: nothing but the open lease`);
      assert.deepEqual([await stateOf(id), await issuedRowOf(id), await counterOf(S)], [state, null, '0'], `${label}: the draft as it was, no invoice, the counter at 0`);
      assert.equal(await leaseOpen(key, mgr.principal), true, `${label}: no completion`);
    }
    const key = randomUUID();
    const before = await counts([T], [{ key, principal: mgr.principal }]);
    issuedOf(await ctx.issue(s, S, id, issueBody(T, 1, settingsVersion, 1), { key }), { draftId: id, version: 2, store: S }, 'control: without a fault');
    assert.deepEqual(delta(await counts([T], [{ key, principal: mgr.principal }]), before), ONE_ISSUE(2));
    assert.equal((await issuedRowOf(id)).number, '1', 'the faults consumed no number');
  });
});

// ===========================================================================
// IIH-09: races over two entries
// ===========================================================================

test('IIH-09 (ISS-05 ISS-06 AC-07): two tenant entries ordered by an owner\'s hold of the draft header — two issues under different keys are one 201 and one sealed invalid_state (one invoice, one audit record, one number); an issue first makes an edit and a discard the sealed invalid_state; an edit first makes the issue the sealed write_conflict; a discard first makes the issue the sealed invalid_state', async () => {
  const { T, S, C, boss, so, mgr } = await world('iih09');
  await withEntry((a) => withEntry(async (b) => {
    const sa = await signIn(a, so);
    const sm = await signIn(b, mgr);
    const settingsVersion = await configure(a, await signIn(a, boss), T, S, sellerOf('iih09'));
    const sends = {
      A: (kind, id, body, key) => (kind === 'issue' ? a.issue(sa, S, id, body, { key }) : kind === 'discard' ? a.discard(sa, S, id, body, { key }) : a.patch(sa, S, id, body, { key })),
      B: (kind, id, body, key) => (kind === 'issue' ? b.issue(sm, S, id, body, { key }) : kind === 'discard' ? b.discard(sm, S, id, body, { key }) : b.patch(sm, S, id, body, { key })),
    };
    const queryOf = { issue: AT_ISSUE, edit: AT_UPDATE, discard: AT_DISCARD };
    let numbers = 0;
    for (const [round, [x, xKind], [y, yKind]] of [
      ['(a) A issues first, B issues second', ['A', 'issue'], ['B', 'issue']],
      ['(b) B issues first, A issues second', ['B', 'issue'], ['A', 'issue']],
      ['(c) A issues first, B edits second', ['A', 'issue'], ['B', 'edit']],
      ['(d) A issues first, B discards second', ['A', 'issue'], ['B', 'discard']],
      ['(e) A edits first, B issues second', ['A', 'edit'], ['B', 'issue']],
      ['(f) A discards first, B issues second', ['A', 'discard'], ['B', 'issue']],
    ]) {
      const id = await seed(a, sa, S, T, C, [line(described(`raced ${round}`), 1, 1)]);
      const bodyOf = (kind) => (kind === 'issue' ? issueBody(T, 1, settingsVersion, 1) : kind === 'discard' ? discardBody(T, 1) : editBody(T, 1, C, [line(described(`raced edit ${round}`), 2, 2)]));
      const yKey = randomUUID();
      const yPrincipal = y === 'A' ? so.principal : mgr.principal;
      const before = await counts([T]);
      const h = await holdHeader(id);
      let px;
      let py;
      try {
        px = quietly(sends[x](xKind, id, bodyOf(xKind), randomUUID()));
        const xPid = waitingPid(await blockedOrSettled(px, { by: h.pid, query: queryOf[xKind] }), `${round}: ${x} waiting on the header`);
        await assertWaitsOnHeaderBehind(xPid, h.pid, `${round}: ${x}`);
        py = quietly(sends[y](yKind, id, bodyOf(yKind), yKey));
        const yPid = waitingPid(await blockedOrSettled(py, { by: xPid, query: queryOf[yKind] }), `${round}: ${y} queued behind ${x}`);
        await assertQueuedOnHeaderTuple(yPid, `${round}: ${y}`);
      } finally {
        await h.commit();
      }
      const rx = await replyTo(px, `${round}: ${x}`);
      const ry = await replyTo(py, `${round}: ${y}`);
      if (xKind === 'issue') { issuedOf(rx, { draftId: id, version: 2, store: S }, `${round}: ${x}'s issue commits`); numbers += 1; }
      else assert.equal(rx.status, 200, `${round}: ${x}'s ${xKind} commits: ${rx.body}`);
      const word = xKind === 'edit' ? 'write_conflict' : 'invalid_state';
      sealedOf(ry, word, `${round}: ${y} is the sealed ${word}`);
      sealedOf(await sends[y](yKind, id, bodyOf(yKind), yKey), word, `${round}: ${y}'s 409 replays`, { replayed: true });
      assert.equal((await counts([T], [{ key: yKey, principal: yPrincipal }])).K, 1, `${round}: ${y}'s sealed completion`);
      const d = delta(await counts([T]), before);
      if (xKind === 'issue') assert.deepEqual(d, { ...NOTHING, I: 1, N: 1, L: 1, Q: 1, A: 1, AA: 1, C: 2 }, `${round}: one invoice, ONE audit record, one number, two completions`);
      else if (xKind === 'edit') assert.deepEqual(d, { ...NOTHING, O: 1, AA: 1, OO: 1, C: 2 }, `${round}: the edit alone (its audit record and event), no invoice`);
      else assert.deepEqual(d, { ...NOTHING, X: 1, AA: 1, C: 2 }, `${round}: the discard alone, no invoice`);
      assert.equal(await counterOf(S), String(numbers), `${round}: one number per applied issue`);
    }
  }));
});

// ===========================================================================
// IIH-10: snapshot independence
// ===========================================================================

test('IIH-10 (ISS-14 AC-04): after the issue, a customer rename through the real PATCH and a settings write through the real PUT leave the issued detail and list byte for byte as they were; a new preview shows the new values (control)', async () => {
  const { T, S, C, boss, mgr } = await world('iih10');
  await withEntry(async (ctx) => {
    const sb = await signIn(ctx, boss);
    const s = await signIn(ctx, mgr);
    const settingsVersion = await configure(ctx, sb, T, S, sellerOf('iih10'));
    const id = await seed(ctx, s, S, T, C, [line(described('iih10 one'), 3, 300)]);
    const invoice = issuedOf(await ctx.issue(s, S, id, issueBody(T, 1, settingsVersion, 1)), { draftId: id, version: 2, store: S }, 'the issue');
    const detail = await ctx.invoice(s, S, invoice);
    const list = await ctx.invoices(s, S);
    assert.equal(detail.status, 200);
    const renamed = described('iih10 renamed');
    assert.equal((await ctx.renameCustomer(sb, C, { expectedVersion: 1, name: renamed })).status, 200, 'the rename');
    NAMES.set(C, renamed);
    const seller = sellerOf('iih10 v2', NO_TAX, { taxId: false });
    const v2 = await configure(ctx, sb, T, S, seller);
    assert.equal((await ctx.invoice(s, S, invoice)).body, detail.body, 'the detail unchanged, byte for byte');
    assert.equal((await ctx.invoices(s, S)).body, list.body, 'the list unchanged, byte for byte');
    const id2 = await seed(ctx, s, S, T, C, [line(described('iih10 two'), 1, 1)]);
    const preview = previewOf(await ctx.preview(s, S, id2), 'a new preview');
    assert.deepEqual([preview.customer, preview.issuingSettings.version, preview.issuingSettings.legalName, preview.issuingSettings.tax],
      [{ id: C, name: renamed, version: 2 }, v2, seller.legalName, { mode: 'none' }], 'control: the new values are live');
  });
});

// ===========================================================================
// IIH-13: a concurrent change committed while the issue waits, over two entries
// ===========================================================================

test('IIH-13 (ISS-03 HTTP half, ISS-07, AC-07): two tenant entries; a manager at Invoices approve issues on A while a change commits on B — (a) a customer rename through the real PATCH while the issue waits on the owner\'s hold of the draft header: the sealed 409 write_conflict, replayed byte for byte; (b) a settings write through the real PUT, the same way: the sealed write_conflict; (c) the real PUT /api/v1/roles/levels narrowing the manager to Invoices manage holds key 530030 EXCLUSIVE (parked at its audit INSERT on a gate row the owner holds) while the issue waits on that key SHARED: the 503, rolled back; (d) a session revocation committed while the issue waits at 016\'s hold: the 503, rolled back — every effect exact, no number used; then every level restored and a new session issues (control)', async (t) => {
  const { T, S, C, boss, mgr } = await world('iih13');
  await withEntry((a) => withEntry(async (b) => {
    const sb = await signIn(b, boss);
    const sm = await signIn(a, mgr);
    const seller = sellerOf('iih13');
    let sv = await configure(b, sb, T, S, seller);
    let cv = 1;
    await putLevel(b, sb, T, 'manager', 'invoices', 'approve', 'IIH-13');
    const drafts = {};
    for (const round of ['a', 'b', 'c', 'd']) drafts[round] = await seed(a, sm, S, T, C, [line(described(`iih13 ${round}`), 1, 100)]);
    /** One round: the issue's own key; the state and counts before; the issue's reply and the effects after. */
    const round = async (label, race) => {
      const id = drafts[label[1]];
      const key = randomUUID();
      const keys = [{ key, principal: mgr.principal }];
      const body = issueBody(T, 1, sv, cv);
      const state = await stateOf(id);
      const counter = await counterOf(S);
      const before = await counts([T], keys);
      const reply = await race(() => quietly(a.issue(sm, S, id, body, { key })));
      assert.deepEqual([await stateOf(id), await issuedRowOf(id), await counterOf(S)], [state, null, counter], `${label}: the draft as it was (xmin included), no invoice, the counter unchanged`);
      return { reply, key, keys, body, id, before, delta: async () => delta(await counts([T], keys), before) };
    };

    // (a), (b): the issue waits on the owner's hold of the draft header (a row the rival does not need); the rival commits on B.
    for (const [label, rival] of [
      ['(a) a customer rename', async () => {
        const renamed = described('iih13 renamed');
        const reply = await replyTo(b.renameCustomer(sb, C, { expectedVersion: cv, name: renamed }), '(a) the rename');
        assert.equal(reply.status, 200, `(a) the rename commits while the issue waits: ${reply.body}`);
        NAMES.set(C, renamed);
        cv += 1;
      }],
      ['(b) a settings write', async () => {
        const reply = await replyTo(b.putSettings(sb, S, { expectedTenant: T, expectedVersion: sv, ...seller }), '(b) the settings write');
        assert.equal(reply.status, 200, `(b) the settings write commits while the issue waits: ${reply.body}`);
        assert.equal(JSON.parse(reply.body).issuingSettings.version, sv + 1, '(b) the settings at version + 1');
        sv += 1;
      }],
    ]) {
      const r = await round(label, async (send) => {
        const h = await holdHeader(drafts[label[1]]);
        let pending;
        try {
          pending = send();
          const pid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_ISSUE }), `${label}: the issue waiting on the header`);
          // Only the rival inside the issue's 1,400 ms lock wait; the exact wait is asserted after it, the issue still waiting.
          await rival();
          await assertWaitsOnHeaderBehind(pid, h.pid, `${label}: the issue, still waiting after the rival committed`);
        } finally {
          await h.commit();
        }
        return replyTo(pending, `${label}: the issue`);
      });
      sealedOf(r.reply, 'write_conflict', `${label}: the sealed write_conflict`);
      const again = await a.issue(sm, S, r.id, r.body, { key: r.key });
      sealedOf(again, 'write_conflict', `${label}: replayed under its key`, { replayed: true });
      assert.equal(again.body, r.reply.body, `${label}: the same bytes`);
      // The issue: its completion only. The rival: its own audit record and completion (a rename and a settings write enqueue no event).
      assert.deepEqual(await r.delta(), { ...COMPLETION_ONLY, AA: 1, C: 2 }, `${label}: the issue's completion, and the rival's audit record and completion`);
    }

    // (c): the narrowing holds key 530030 EXCLUSIVE, parked at its audit INSERT on the owner's gate row; the issue then waits on the key.
    {
      const reviewed = await reviewedOf(b, sb, 'manager', 'invoices');
      const narrow = { roleId: 'manager', domain: 'invoices', level: 'manage', reason: described('iih13 narrowing'), expectedTenant: T, expectedVersion: reviewed };
      let put;
      const at = {};
      previewOf(await a.preview(sm, S, drafts.c), '(c) entry A warm before the gate');
      const r = await round('(c) a level narrowing', (send) => withTrigger('public.audit_event', 'insert',
        `new.action_id = 'tenant.role.level.update' and new.tenant_id = '${T}'::uuid`, 'park', async () => {
          const gate = await hold('the gate row', (sql) => sql`select 1 from iih_proof.gate where id = 1 for update`);
          let pending;
          let narrowing;
          try {
            narrowing = quietly(b.levels(sb, narrow));
            const putPid = waitingPid(await blockedOrSettled(narrowing, { by: gate.pid }), '(c) the narrowing parked at its audit INSERT');
            const [{ n }] = await probe`select count(*)::int as n from pg_catalog.pg_locks l where l.pid = ${putPid} and l.granted
              and l.locktype = 'advisory' and l.classid = 530030 and l.objsubid = 2 and l.mode = 'ExclusiveLock'`;
            assert.equal(n, 1, '(c) the narrowing holds key 530030 EXCLUSIVE');
            at.sent = Date.now();
            pending = send();
            pending.then(() => { at.replied = Date.now(); }, () => {});
            const pid = waitingPid(await blockedOrSettled(pending, { by: putPid, query: AT_ISSUE }), '(c) the issue waiting on the key');
            assert.deepEqual(await waitsOf(pid), [{ locktype: 'advisory', mode: 'ShareLock', xid: null, relation: null }], '(c) the issue waits on the advisory key, SHARED');
            at.boundLeft = await lockBoundLeft(pid, '(c) the issue');
          } finally {
            await gate.commit();
          }
          put = await replyTo(narrowing, '(c) the narrowing');
          return replyTo(pending, '(c) the issue');
        }));
      assert.equal(put.status, 200, `(c) the narrowing commits: ${put.body}`);
      assert.deepEqual(JSON.parse(put.body), { roleLevel: { roleId: 'manager', domain: 'invoices', level: 'manage', version: reviewed + 1 } }, '(c) the PUT\'s own answer');
      assertRefusal(r.reply, 503, 'service_unavailable', '(c) the issue refused by the re-read under the key');
      assert.equal(a.reason(r.reply), 'transaction_unavailable', '(c) the re-read under the key refused: rolled back, never a timeout');
      evidence(t, { case: '(c)', elapsedMs: at.replied - at.sent, boundLeftMs: at.boundLeft });
      assert.ok(at.boundLeft > RELEASE_MARGIN_MS, `(c) released ${at.boundLeft} ms before the issue's lock bound on the database clock`);
      assert.ok(at.replied - at.sent < COMMAND_LOCK_BOUND_MS, `(c) answered ${at.replied - at.sent} ms after the send: before any lock, statement or deadline timeout`);
      // The issue: rolled back, its lease left open (no completion). The narrowing: its audit record and completion.
      assert.deepEqual(await r.delta(), { ...NOTHING, LE: 1, AA: 1, C: 1 }, '(c) the issue\'s open lease, and the narrowing\'s audit record and completion');
      assert.equal(await leaseOpen(r.key, mgr.principal), true, '(c) the issue\'s lease open');
      await putLevel(b, sb, T, 'manager', 'invoices', 'approve', 'IIH-13 (c) undone');
    }

    // (d): the owner holds the manager's account row (016's hold); the issue waits there; the revocation commits meanwhile.
    {
      const at = {};
      const r = await round('(d) a session revocation', async (send) => {
        const h = await hold('app_user for update', (sql) => sql`select 1 from public.app_user where internal_user_id = ${mgr.id} for update`);
        let pending;
        try {
          at.sent = Date.now();
          pending = send();
          pending.then(() => { at.replied = Date.now(); }, () => {});
          const pid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_HOLD }), '(d) the issue waiting at 016\'s hold');
          assert.deepEqual((await waitsOf(pid)).map((w) => [w.locktype, w.mode]), [['transactionid', 'ShareLock']], '(d) on the holder\'s transaction');
          assert.deepEqual((await owner`select tmpos_session.m5_session_revoke(${sm.key}::text) as r`).map((x) => x.r), ['revoked'], '(d) the revocation commits while the issue waits');
          // 011's revoke deletes the row: gone before the release.
          assert.equal((await owner`select count(*)::int as n from tmpos_session.session where session_key = ${sm.key}`)[0].n, 0, '(d) the revoked session\'s row is gone');
          at.boundLeft = await lockBoundLeft(pid, '(d) the issue');
        } finally {
          await h.settle();
        }
        return replyTo(pending, '(d) the issue');
      });
      assertRefusal(r.reply, 503, 'service_unavailable', '(d) the issue refused inside its transaction');
      assert.equal(a.reason(r.reply), 'transaction_unavailable', '(d) the revalidation refused: rolled back, never a timeout');
      evidence(t, { case: '(d)', elapsedMs: at.replied - at.sent, boundLeftMs: at.boundLeft });
      assert.ok(at.boundLeft > RELEASE_MARGIN_MS, `(d) released ${at.boundLeft} ms before the issue's lock bound on the database clock`);
      assert.ok(at.replied - at.sent < COMMAND_LOCK_BOUND_MS, `(d) answered ${at.replied - at.sent} ms after the send: before any lock, statement or deadline timeout`);
      assert.deepEqual(await r.delta(), LEASE_ONLY, '(d) nothing but the issue\'s open lease');
      assert.equal(await leaseOpen(r.key, mgr.principal), true, '(d) the issue\'s lease open');
      assertRefusal(await a.preview(sm, S, drafts.d), 401, 'unauthenticated', '(d) the revoked session is refused from now on');
    }

    // Restored: the manager's Invoices level at its catalog default (full), a new session; the round (d) draft then issues.
    await putLevel(b, sb, T, 'manager', 'invoices', 'full', 'IIH-13 restore');
    const again = await signIn(a, mgr);
    const key = randomUUID();
    const before = await counts([T], [{ key, principal: mgr.principal }]);
    issuedOf(await a.issue(again, S, drafts.d, issueBody(T, 1, sv, cv), { key }), { draftId: drafts.d, version: 2, store: S }, 'control: a new session issues');
    assert.deepEqual(delta(await counts([T], [{ key, principal: mgr.principal }]), before), ONE_ISSUE(1), 'control: one issue');
    assert.equal(await counterOf(S), '1', 'control: the first number — no refused round used one');
  }));
});

// ===========================================================================
// IIH-11: the body bound and the media type (raw sockets)
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
function rawUnsafe(ctx, s, path, lines, tail = '', key = null) {
  if (key !== null) {
    SECRETS.add(key);
    if (s !== null) USED_KEYS.push({ key, principal: s.principal });
  }
  const head = [`Host: ${TENANT_HOST}`, `Origin: ${TENANT_ORIGIN}`, 'Sec-Fetch-Site: same-origin', `${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`,
    ...(s === null ? [] : [`Cookie: ${s.cookie}`, `${SESSION_CSRF_HEADER}: ${s.csrf}`]), ...(key === null ? [] : [`Idempotency-Key: ${key}`])];
  return rawRequest(ctx.port, `POST ${path} HTTP/1.1\r\n${head.map((l) => `${l}\r\n`).join('')}${lines}\r\n${tail}`, { localAddress: ctx.from });
}
const chunked = (text, size) => {
  let out = '';
  for (let i = 0; i < text.length; i += size) {
    const piece = text.slice(i, i + size);
    out += `${Buffer.byteLength(piece).toString(16)}\r\n${piece}\r\n`;
  }
  return `${out}0\r\n\r\n`;
};

test('IIH-11 (ISS-22): the issue body is bounded at exactly 1 KiB on the real entry over real sockets — a valid issue of exactly 1,024 bytes reaches the plan and commits, declared and chunked; 1,025 bytes is the 413, declared and chunked; an unsupported, a duplicated and a missing Content-Type are the 415 — each refusal with no idempotency record for its key and nothing written', async () => {
  const { T, S, C, boss, mgr } = await world('iih11');
  const BOUND = 1024; // INVOICE_ISSUE_MAX_BODY_BYTES, pinned here as a literal
  await withEntry(async (ctx) => {
    const sb = await signIn(ctx, boss);
    const s = await signIn(ctx, mgr);
    const settingsVersion = await configure(ctx, sb, T, S, sellerOf('iih11'));
    const [declared, streamed, victim] = [await seed(ctx, s, S, T, C, [line(described('iih11 declared'), 1, 1)]),
      await seed(ctx, s, S, T, C, [line(described('iih11 chunked'), 1, 1)]), await seed(ctx, s, S, T, C, [line(described('iih11 victim'), 1, 1)])];
    const victimState = await stateOf(victim);
    const path = (id) => `/api/v1/stores/${S}/invoice-drafts/${id}/issue`;
    const base = JSON.stringify(issueBody(T, 1, settingsVersion, 1));
    const pad = (n) => `${base.slice(0, -1)}${' '.repeat(n - Buffer.byteLength(base))}}`;
    const atBound = pad(BOUND);
    const over = pad(BOUND + 1);
    assert.deepEqual([Buffer.byteLength(atBound), Buffer.byteLength(over)], [BOUND, BOUND + 1]);
    assert.deepEqual(JSON.parse(atBound), issueBody(T, 1, settingsVersion, 1), 'the padded body is the plain issue body');
    // At the bound: commits, declared and chunked.
    let key = randomUUID();
    let before = await counts([T], [{ key, principal: mgr.principal }]);
    issuedOf(await ctx.issue(s, S, declared, atBound, { key }), { draftId: declared, version: 2, store: S }, '1,024 bytes declared');
    assert.deepEqual(delta(await counts([T], [{ key, principal: mgr.principal }]), before), ONE_ISSUE(1));
    key = randomUUID();
    before = await counts([T], [{ key, principal: mgr.principal }]);
    const chunkedReply = await rawUnsafe(ctx, s, path(streamed), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(atBound, 256), key);
    issuedOf(chunkedReply, { draftId: streamed, version: 2, store: S }, '1,024 bytes chunked');
    assert.deepEqual(delta(await counts([T], [{ key, principal: mgr.principal }]), before), ONE_ISSUE(1));
    // The refusals.
    const valid = base;
    for (const [label, request, status, error, reason] of [
      ['1,025 bytes declared', (k) => ctx.issue(s, S, victim, over, { key: k }), 413, 'content_too_large', 'body_declared_too_large'],
      ['1,025 bytes chunked', (k) => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(over, 256), k), 413, 'content_too_large', 'body_streamed_too_large'],
      ['text/plain', (k) => ctx.issue(s, S, victim, valid, { key: k, headers: { 'content-type': 'text/plain' } }), 415, 'unsupported_media_type', 'media_type_unsupported'],
      ['two Content-Type lines', (k) => rawUnsafe(ctx, s, path(victim), `Content-Type: application/json\r\nContent-Type: application/json\r\nContent-Length: ${valid.length}\r\n`, valid, k), 415, 'unsupported_media_type', 'media_type_unsupported'],
      ['no Content-Type with a body', (k) => rawUnsafe(ctx, s, path(victim), `Content-Length: ${valid.length}\r\n`, valid, k), 415, 'unsupported_media_type', 'media_type_missing'],
    ]) {
      const k = randomUUID();
      const b0 = await counts([T], [{ key: k, principal: mgr.principal }]);
      const reply = await request(k);
      assertRefusal(reply, status, error, label);
      assert.equal(ctx.reason(reply), reason, `${label}: the logged reason`);
      assert.deepEqual(delta(await counts([T], [{ key: k, principal: mgr.principal }]), b0), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(k, mgr.principal), 0, `${label}: no idempotency record — no lease, no completion`);
      assert.deepEqual(await stateOf(victim), victimState, `${label}: the draft as it was`);
    }
    assert.equal(await counterOf(S), '2', 'two issues in all');
  });
});

// ===========================================================================
// IIH-12: logs and containment (last)
// ===========================================================================

test('IIH-12 (ISS-24 server half, AC-12): no log line of any entry carries a session key, an Idempotency-Key, a body, seller, customer or line text or an id — nor does the server log of a cluster this file started; the shipping inventory is exactly the 29 routes, the seven issuing routes among them', () => {
  const forbidden = [...SECRETS, ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)])];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const l of ALL_LOG_LINES) for (const secret of forbidden) assert.ok(!l.includes(secret), `a log line carries a secret: ${secret.slice(0, 6)}...`);
  if (cluster !== null) {
    const leaked = forbidden.filter((v) => readFileSync(`${cluster.root}/postgres.log`, 'utf8').includes(v));
    assert.deepEqual(leaked.map((v) => v.slice(0, 6)), [], 'the cluster\'s server log carries no secret');
  }
  assert.equal(TENANT_SHIPPING_ROUTES.length, 29, 'exactly the 29 shipping routes');
  const served = new Set(TENANT_SHIPPING_ROUTES.map((r) => `${r.method} ${r.path}`));
  for (const route of ['GET /api/v1/issuing-settings/{id}', 'PUT /api/v1/issuing-settings/{id}', 'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility',
    'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview', 'POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue',
    'GET /api/v1/stores/{storeId}/invoices', 'GET /api/v1/stores/{storeId}/invoices/{id}']) assert.ok(served.has(route), `served: ${route}`);
  assert.equal(served.size, 29, 'no route twice');
});
