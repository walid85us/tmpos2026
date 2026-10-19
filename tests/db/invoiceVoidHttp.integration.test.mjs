// Phase 4.0 M7B-INVOICES-VOID-P1 — voiding an issued store invoice END TO END: the tenant entry (server/entry/tenantEntry.ts,
// startTenantEntry) serving POST /api/v1/stores/{storeId}/invoices/{id}/void, GET …/invoices/{id}/void-eligibility and the
// lifecycle-aware GET /api/v1/stores/{storeId}/invoices and GET …/invoices/{id} over REAL loopback HTTP and a disposable
// PostgreSQL holding every migration in the directory (001-035), composed exactly as server/entry/tenantMain.ts composes it
// but for its construction. The route module (server/runtime/invoiceVoid.ts), the chain (its recent sign-in, the store-scope
// authorizer and revalidator), the tenant command transaction, the void's mutator (server/persistence/postgresInvoiceVoid.ts:
// ONE call into migration 035's tmpos_invoice_void.m7b_invoice_void, then the recent sign-in judged again on the database
// clock), the issued reads' adapters over 035's v2 reads, the audit writer's issued-invoice-alone statement and the
// idempotency kernel are production's own code. Every invoice is issued through the production POST …/issue on a draft saved
// through the production POST; every store's issuing settings are written by the tenant owner through the production PUT;
// every level change goes through the production PUT /api/v1/roles/levels; every void goes through the production POST —
// never an owner INSERT of a void record.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — tests/db/invoiceIssueHttp.integration.test.mjs's three, none on the path under test:
// the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime LOGIN, tmpos_ivh_probe,
// holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can drop a COMMIT's answer, cut the
// COMMIT, or cut the connection as the void's call is sent), the identity verifier (a synthetic bearer-token map whose
// authentication time a case may age or pin) and the listener (127.0.0.1:0). Lease expiry and retention are moved by the
// OWNER on the idempotency row; faults and parks are OWNER triggers; the header, account and gate holds are OWNER row locks
// (test-only levers). Account, tenant and store statuses are owner fixture writes.
//
// WHAT IS PROVEN (each title carries docs/phase-4/13's VOID ids and the P1 contract's R-* tags; D/I/N/L/Q/A/V/VA/O/K are a
// case's drafts, ISSUED drafts, issued invoices, issued lines, the sum of its stores' counters, ISSUE audit records, VOID
// records, VOID audit records, its stores' outbox rows and its keys' sealed completions; AA/OO/C/LE every audit record,
// outbox row, completed idempotency record and open lease in the database — the cases run one at a time — all read by the
// OWNER as deltas).
//   IVH-01 authority over STORED levels: the void 200 exactly at Invoices Approve+ with Customers View+ (store_owner Full),
//          else the chain's 403 before any key; the eligibility equals the POST's authorization in every row.
//   IVH-02 the recent sign-in: a sign-in older than 10 minutes is the 403 step_up_required before any key (the eligibility,
//          action-only, still answers); a reauthentication makes it fresh and the same key voids; a replay is stopped by
//          the same step-up before idempotency.
//   IVH-03 isolation: one 404 for a missing, another store's and another tenant's invoice (rolled back, the lease kept); the
//          403 before any key at a store that is not the trusted one; a malformed target the 400 before, a non-RFC one the
//          400 after the key; the eligibility is target-blind; a voided invoice is disclosed to nobody outside its store.
//   IVH-04 the transaction and the reads: one void per reason code — the exact 200, one void record, one audit record
//          (store scope, the invoice alone, invoice_void_<code>, the fixed sentence, metadata {}, occurred_at <= voided_at),
//          no outbox row, the completion; the invoice, lines, counter and source draft untouched; never-voided answers byte
//          for byte the 034 answers; the voided detail's exact bytes with "void" LAST; the list's status; ?sourceDraft=;
//          ordering and cursors unchanged; read on a second entry.
//   IVH-05 repeats: the sealed 200 replay; 422 for other bytes, another invoice and an issue key; a new key the sealed 409
//          invalid_state and its replay; a same-key repeat while the attempt is in flight waits on its fence and replays
//          its 200; past retention a new operation; a replay under the current authority.
//   IVH-06 a stale expectedTenant the unsealed 409 (the lease kept, no completion); every body the planner refuses —
//          forged auth-time, actor and store fields included — the 400 after the key; the 1 KiB bound and the media type.
//   IVH-07 two entries race one invoice under two keys, ordered by an owner's hold of the issued header: one 200, one sealed
//          invalid_state, one void record, one audit record.
//   IVH-08 a fault at the void INSERT, the void's audit INSERT and its completion: the 503, nothing but the lease.
//   IVH-09 a lost COMMIT answer (landed: the replay) and a cut COMMIT (nothing; the retry after the lease voids once).
//   IVH-10 a change committed while the void waits — an Invoices and a Customers narrowing holding key 530030, a session
//          revocation at 016's hold — and a sign-in that goes stale while the void waits on the header (the routine's own
//          check, before its INSERT) and while it is parked at its void INSERT after the routine's check (the adapter's re-check): each the
//          503, rolled back.
//   IVH-11 a void past its lock bound, a cut connection and an unanswered call past the commit deadline (the kernel's
//          abort): the 503 with nothing but the lease.
//   IVH-12 the issue's 201 and its replay unchanged after a void; no re-issue; the correction takes the next number.
//   IVH-13 no log line carries a reason code, label or sentence, a key, a body or an id (run last); the shipping inventory.
//   Added by the F1 fix pass (cases placed beside their kin; IVH-13 stays last): IVH-01b (T2) the actor who ISSUED an invoice, lowered
//   through the real PUT below Invoices Approve and separately below Customers View, voids their own invoice: the chain's 403, a 403
//   leaving no idempotency record, void record, audit record or outbox row; restored, the same actor voids it. IVH-11b (T6, R-M4) a
//   future-dated issued fixture (the owner, 034's row guard lifted and put back): the 503 { error, requestId } with only the lease.
//   IVH-13 also scans for keyed `reason`/`reasonCode` + code patterns and the six audit sentences (T7), with the matcher's own proof.
//
// DETERMINISTIC WAITS ONLY: pg_stat_activity / pg_locks, an owner lock granted only once its transaction ended, or a relay
// trap; nothing sleeps for an outcome (the two sign-in-ageing rounds sleep to a deadline, then assert where the void waited
// on the database clock). DISPOSABLE ONLY: the harness's resolved target, refused by assertDisposableTestDsn unless
// disposable. Synthetic data only. Before it finishes it removes every void record, issued line, issued invoice, counter,
// settings row, draft, line, customer, role-level row, void, issue and settings audit record (and nulls every other audit
// subject naming them) of its tenants — the guard, terminal and append-only triggers lifted inside ONE owner transaction and
// put back in the mode they were found in — with its draft events, sessions, mint-ledger rows, idempotency records, proof
// schema and login, restores the limiter fingerprint and issuer key row, and checks that the database holds no void record,
// void audit record, settings, counter, issued row or issue/settings audit record and that every guard is ALWAYS again
// (035's down refuses while a void record or a void audit record exists, and CI runs every database suite on one database).
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
import { RECENT_AUTH_MAX_AGE_MS, REAUTHENTICATE_HEADER, REAUTHENTICATE_VALUE, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring, IDEMPOTENCY_POLICY } from '../../server/runtime/idempotency.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';
import { PORT_DEADLINE_MS } from '../../server/runtime/deadline.ts';
import { INVOICE_VOID_REASON_CODES, INVOICE_VOID_REASON_LABELS } from '../../server/runtime/invoiceVoid.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'ivh-migrator', runtimeRef: 'ivh-runtime' };
const LOCK_KEY = 529_537;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ivh_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** The void's audit action and permission, the issue's and the settings write's actions, pinned here as literals. */
const VOID_ACTION = 'store.invoice.void';
const VOID_PERMISSION = 'void_issued_invoices';
const ACTION = 'store.invoice.issue';
const SETTINGS_ACTION = 'tenant.issuing_settings.update';
/** The closed reason codes and their labels (contract §2), pinned here as literals in their one order. */
const REASONS = Object.freeze([
  ['issued_in_error', 'Issued by mistake'], ['wrong_customer', 'Wrong customer'], ['wrong_lines_or_amounts', 'Wrong lines or amounts'],
  ['wrong_seller_details', 'Wrong seller details'], ['duplicate', 'Duplicate of another invoice'], ['other', 'Other reason'],
]);
assert.deepEqual(REASONS.map(([code]) => code), [...INVOICE_VOID_REASON_CODES], 'the pinned codes are the server\'s, in its order');
assert.deepEqual(Object.fromEntries(REASONS), { ...INVOICE_VOID_REASON_LABELS }, 'the pinned labels are the server\'s');
const WAIT_MS = 10_000;
const SEND_TIMEOUT_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WIRE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** 034's o_issued_at encoding (035's voided_at on the wire), bound as a parameter of to_char. */
const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
/** The void routine's statement (035): where a void waits for the issued header, the role's key or its INSERT's park. */
const AT_VOID = /tmpos_invoice_void\.m7b_invoice_void\(/;
const AT_HOLD = /m5_hold_tenant_standing/;
/** The idempotency kernel's acquisition (006): where a same-key request waits on an in-flight attempt's fence. */
const AT_ACQUIRE = /m6_idempotency_acquire/;
const ISSUED_TABLE = 'tmpos_invoice_issue.issued_invoice';
const VOID_TABLE = 'tmpos_invoice_void.issued_invoice_void';
/** A canonical lowercase uuid the outbox's aggregate-id shape refuses (version 0): the planner's 400 after the key (R-K3). */
const NIL = '00000000-0000-0000-0000-000000000000';
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });
/** A command's lock_timeout (supervisedPgClient's transaction bounds): an answer sooner than this after its send is no timeout. */
const COMMAND_LOCK_BOUND_MS = 1_400;
/** How long before the waiter's lock bound (waitstart + COMMAND_LOCK_BOUND_MS, database clock) a lever must release. */
const RELEASE_MARGIN_MS = 300;
/** The sign-in-ageing schedule relative to the deadline (ISH-06's): send 600 ms before it, release 150 ms after it. */
const LAPSE = Object.freeze({ send: 600, release: 150 });
/** The completion: the one UPDATE of an idempotency record that seals its response. */
const COMPLETION = 'old.response is null and new.response is not null';
assert.equal(IDEMPOTENCY_POLICY.leaseMs, 60_000, 'the idempotency lease the in-progress cases rely on');
assert.equal(RECENT_AUTH_MAX_AGE_MS, 600_000, 'the recent sign-in is 10 minutes');
assert.ok(COMMAND_TRANSACTION_DEADLINE_MS <= PORT_DEADLINE_MS);
assert.ok(PORT_DEADLINE_MS * 4 <= SEND_TIMEOUT_MS);
assert.ok(COMMAND_LOCK_BOUND_MS < COMMAND_TRANSACTION_DEADLINE_MS);
assert.ok(LAPSE.send + LAPSE.release < COMMAND_LOCK_BOUND_MS, 'an ageing round\'s wait ends inside the void\'s lock bound');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('IVH');
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
/** Migration 035's row guard: a void record admits no delete while it is enabled. */
const VOID_TRIGGERS = [[VOID_TABLE, 'trg_issued_invoice_void_guard']];

/**
 * Every void record, issued line and invoice, counter, settings row, draft, line, customer, Invoices/Customers role and
 * version row of this suite's tenants, its void, issue and settings audit records, and every other audit subject naming one
 * of its drafts, invoices, stores or customers — in ONE owner transaction, the guards lifted only inside it. The void
 * records go before the issued invoices (their foreign key restricts).
 */
async function cleanIssuing() {
  if (TENANTS.length === 0) return;
  await owner.begin('isolation level read committed', async (sql) => {
    await withTriggersLifted(sql, AUDIT_TRIGGER, async () => {
      await sql`delete from public.audit_event where action_id in (${VOID_ACTION}, ${ACTION}, ${SETTINGS_ACTION}) and tenant_id = any(${TENANTS}::uuid[])`;
      await sql`update public.audit_event set subject_invoice_draft_id = null
        where subject_invoice_draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_issued_invoice_id = null
        where subject_issued_invoice_id in (select invoice_id from tmpos_invoice_issue.issued_invoice where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_store_id = null
        where subject_store_id in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`;
      await sql`update public.audit_event set subject_customer_id = null
        where subject_customer_id in (select customer_id from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[]))`;
    });
    const [{ present }] = await sql`select pg_catalog.to_regclass(${VOID_TABLE}) is not null as present`;
    if (present) {
      await withTriggersLifted(sql, VOID_TRIGGERS, () => sql`delete from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${TENANTS}::uuid[])`);
    }
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
    await step(() => owner.unsafe('drop schema if exists ivh_proof cascade'));
    // The events this suite's saves enqueued (an issue, a void and a settings write enqueue none).
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
        (select count(*) from tmpos_invoice_void.issued_invoice_void)::int as voids,
        (select count(*) from public.audit_event where action_id = ${VOID_ACTION})::int as void_audits,
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
            'tmpos_invoice_issue.store_invoice_counter'::regclass, 'tmpos_invoice_issue.store_issuing_settings'::regclass,
            'tmpos_invoice_void.issued_invoice_void'::regclass) and not g.tgisinternal) as triggers`;
      assert.deepEqual({ ...state }, {
        voids: 0, void_audits: 0, settings: 0, counters: 0, invoices: 0, issued_lines: 0, issued_drafts: 0, issue_audits: 0, subjects: 0, drafts: 0,
        customers: 0, anchors: 0, latest: '035',
        triggers: ['trg_invoice_draft_immutable:A', 'trg_invoice_draft_line_terminal:A', 'trg_invoice_draft_terminal:A', 'trg_issued_invoice_commit_check:A',
          'trg_issued_invoice_guard:A', 'trg_issued_invoice_line_guard:A', 'trg_issued_invoice_line_truncate:A', 'trg_issued_invoice_truncate:A',
          'trg_issued_invoice_void_guard:A', 'trg_issued_invoice_void_truncate:A',
          'trg_store_invoice_counter_guard:A', 'trg_store_invoice_counter_truncate:A', 'trg_store_issuing_settings_guard:A', 'trg_store_issuing_settings_truncate:A'].sort().join(','),
      }, 'nothing of this suite blocks 035\'s rollback, and every guard is ALWAYS again');
    });
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IVH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'IVH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay (the issue suite's): a trap may drop a COMMIT's answer, cut the COMMIT, or cut the void's call
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket' ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) } : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-ivh-relay-'));
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
/** An applied void's anchor: its audit INSERT (only an applied void writes one). */
const AUDIT_ANCHOR = Buffer.from('insert into public.audit_event');
/** The void's one call into 035 (the outage case cuts the connection as it is sent). */
const VOID_ANCHOR = Buffer.from('tmpos_invoice_void.m7b_invoice_void(');
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
/**
 * At the connection that sends `anchor`: 'cut' closes it before the server sees it (an outage in the middle of the command
 * transaction); 'silence' lets the server run that statement and withholds every answer from its execution on (a statement
 * left unanswered). The driver runs with prepare: false, so `anchor` travels in a Parse/Describe/Flush the server answers
 * first, and the pair's NEXT chunk is that statement's Bind/Execute/Sync: the silence starts there.
 */
function trapCut(relay, anchor, mode = 'cut') {
  const hit = [];
  const carry = anchor.length - 1;
  relay.state.trap = (pair, chunk) => {
    if (hit.includes(pair)) {
      relay.state.trap = null;
      pair.silenced = true;
      return 'pass';
    }
    const window = pair.tail === undefined ? chunk : Buffer.concat([pair.tail, chunk]);
    pair.tail = window.subarray(Math.max(0, window.length - carry));
    if (window.indexOf(anchor) === -1) return 'pass';
    hit.push(pair);
    if (mode === 'silence') return 'pass';
    relay.state.trap = null;
    return 'cut';
  };
  return {
    hit,
    release: () => {
      relay.state.trap = null;
      for (const pair of relay.state.pairs) pair.tail = undefined;
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
  const [{ applied }] = await owner`select count(*)::int as applied from public.schema_migrations where version in ('028', '029', '030', '031', '032', '033', '034', '035')`;
  assert.equal(applied, 8, 'migrations 028-035 are applied: the drafts, their edit, save, discard, the issuing of 034 and the void of 035');
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
  await owner.unsafe('drop schema if exists ivh_proof cascade');
  await owner.unsafe('create schema ivh_proof');
  await owner.unsafe('revoke all on schema ivh_proof from public');
  await owner.unsafe('create sequence ivh_proof.fired');
  // The parks' gate: one row the OWNER holds FOR UPDATE, which the 'park' trigger action waits on.
  await owner.unsafe('create table ivh_proof.gate (id integer primary key)');
  await owner.unsafe('insert into ivh_proof.gate (id) values (1)');
});

// ---------------------------------------------------------------------------
// identity, configuration, requests
// ---------------------------------------------------------------------------

/** token -> { uid, authAgeMs?, authTimeSec? }: the provider's authentication time is now unless a case ages or pins it. */
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
    type: 'service_account', project_id: 'ivh-test-project', client_email: 'ivh-test@ivh-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
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
/** The chain's own unsealed refusal: exactly { error, requestId }, never replayed. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  assert.equal(reply.headers['idempotent-replayed'], undefined, `${label}: never a replay`);
  assertBaseline(reply, label);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newTenant(label, status = 'active') {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ivh-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
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
  const name = `IVH ${label} ${SUFFIX}`;
  const email = `ivh-${label.replace(/\W+/g, '-')}-${SUFFIX}@example.test`;
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, phone, email) values (${id}, ${tenant}, ${name}, ${'+1 555 0142'}, ${email})`;
  NAMES.set(id, name);
  SECRETS.add(id).add(name).add(email);
  return id;
}
async function actor(label, memberships, status = 'active') {
  const uid = `ivh-${label}-${SUFFIX}`;
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
  const text = `IVH ${label} ${SUFFIX}`;
  SECRETS.add(text);
  return text;
}
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const saveBody = (tenant, customer, lines) => ({ expectedTenant: tenant, customerId: customer, currency: 'USD', lines });
const issueBody = (tenant, version, settingsVersion, customerVersion) => ({
  expectedTenant: tenant, expectedVersion: version, expectedSettingsVersion: settingsVersion, expectedCustomerVersion: customerVersion,
});
/** The void's request: exactly { expectedTenant, reasonCode } (contract §4). */
const voidBody = (tenant, reasonCode) => ({ expectedTenant: tenant, reasonCode });
const RATE_8875 = Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: 8875 });
/** Seller values no other run shares, each registered as a log canary. */
function sellerOf(label, tax = RATE_8875) {
  return {
    legalName: described(`${label} legal`), storeName: described(`${label} shop`),
    postalAddress: `${described(`${label} street`)}\n${described(`${label} city`)}`, taxRegistrationId: described(`${label} reg`), tax,
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

/**
 * What a case's tenants hold now — drafts, ISSUED drafts, issued invoices and lines, the sum of their stores' counters, ISSUE
 * audit records, VOID records, VOID audit records, their stores' outbox rows — the sealed completions of its keys, and across
 * the database every audit record, outbox row, completion and open lease.
 */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as d,
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]) and status = 'issued')::int as i,
    (select count(*) from tmpos_invoice_issue.issued_invoice where tenant_id = any(${tenants}::uuid[]))::int as n,
    (select count(*) from tmpos_invoice_issue.issued_invoice_line where tenant_id = any(${tenants}::uuid[]))::int as l,
    (select coalesce(sum(last_number), 0) from tmpos_invoice_issue.store_invoice_counter where tenant_id = any(${tenants}::uuid[]))::int as q,
    (select count(*) from public.audit_event where action_id = ${ACTION} and tenant_id = any(${tenants}::uuid[]))::int as a,
    (select count(*) from tmpos_invoice_void.issued_invoice_void where tenant_id = any(${tenants}::uuid[]))::int as v,
    (select count(*) from public.audit_event where action_id = ${VOID_ACTION} and tenant_id = any(${tenants}::uuid[]))::int as va,
    (select count(*) from tmpos_internal.outbox_event where payload ->> 'storeId' in (select store_id::text from public.store where tenant_id = any(${tenants}::uuid[])))::int as o,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from public.audit_event)::int as aa,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as c,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le`;
  return { D: r.d, I: r.i, N: r.n, L: r.l, Q: r.q, A: r.a, V: r.v, VA: r.va, O: r.o, K: r.k, AA: r.aa, OO: r.oo, C: r.c, LE: r.le };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const NOTHING = Object.freeze({ D: 0, I: 0, N: 0, L: 0, Q: 0, A: 0, V: 0, VA: 0, O: 0, K: 0, AA: 0, OO: 0, C: 0, LE: 0 });
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
const COMPLETION_ONLY = Object.freeze({ ...NOTHING, K: 1, C: 1 });
/** One applied void under a key: one void record, one void audit record, one completion — NO outbox row, nothing else. */
const ONE_VOID = Object.freeze({ ...NOTHING, V: 1, VA: 1, K: 1, AA: 1, C: 1 });
async function stateOf(draft) {
  const [header] = await owner`select draft_id, tenant_id, store_id, customer_id, status, currency, version::text as version, line_count,
    subtotal_cents::text as subtotal_cents, created_at::text as created_at, created_by, xmin::text as xmin
    from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`;
  const lines = await owner`select position, description, quantity::text as quantity, unit_price_cents::text as unit_price_cents,
    line_total_cents::text as line_total_cents, xmin::text as xmin from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft} order by position`;
  return { header: header === undefined ? null : { ...header }, lines: lines.map((l) => ({ ...l })) };
}
/**
 * The issued invoice as stored: its header, its lines, its store's counter (each row's text and xmin) and its source draft —
 * what a void must leave exactly as it was (D-VOID-1: number, snapshot and source draft unchanged).
 */
async function imageOf(invoice) {
  const [h] = await owner`select i::text as row, i.xmin::text as xmin, i.source_draft_id, i.store_id from tmpos_invoice_issue.issued_invoice i where i.invoice_id = ${invoice}`;
  if (h === undefined) return null;
  const lines = await owner`select l::text as row, l.xmin::text as xmin from tmpos_invoice_issue.issued_invoice_line l where l.invoice_id = ${invoice} order by l.position`;
  const counter = await owner`select c::text as row, c.xmin::text as xmin from tmpos_invoice_issue.store_invoice_counter c where c.store_id = ${h.store_id}`;
  return { header: { row: h.row, xmin: h.xmin }, lines: lines.map((l) => ({ ...l })), counter: counter.map((c) => ({ ...c })), draft: await stateOf(h.source_draft_id) };
}
/** The void record of `invoice` as the OWNER reads it (null: none), voided_at in the wire's encoding. */
async function voidRowOf(invoice) {
  const [row] = await owner`select invoice_id, tenant_id, store_id, reason_code, voided_by, pg_catalog.to_char(voided_at at time zone 'UTC', ${UTC_FORMAT}) as voided_at
    from tmpos_invoice_void.issued_invoice_void where invoice_id = ${invoice}`;
  return row === undefined ? null : { ...row };
}
/** The store's counter as stored ('none' while the store has no settings). */
const counterOf = async (store) => (await owner`select last_number::text as n from tmpos_invoice_issue.store_invoice_counter where store_id = ${store}`)[0]?.n ?? 'none';
async function leaseOpen(key, principal) {
  const [row] = await owner`select response is null as open from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`;
  return row?.open === true;
}
const recordsOf = async (key, principal) => (await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`)[0].n;
const evidence = (t, what) => t.diagnostic(`EVIDENCE ${JSON.stringify(what)}`);
/** Whether the database clock has not yet passed `deadline` (epoch ms): authenticationFresh's comparator. */
const dbBefore = async (deadline) => (await probe`select pg_catalog.clock_timestamp() <= pg_catalog.to_timestamp(${String(deadline)}::bigint / 1000.0) as before`)[0].before;

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
  const invoices = (store) => `/api/v1/stores/${store}/invoices`;
  const ctx = {
    relay, port, from, lines, stop,
    read: (s, path, headers = {}) => send(port, 'GET', path,
      { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers }, undefined, { localAddress: from }),
    invoices: (s, store, query = '') => ctx.read(s, `${invoices(store)}${query}`),
    invoice: (s, store, id) => ctx.read(s, `${invoices(store)}/${id}`),
    voidEligibility: (s, store, id) => ctx.read(s, `${invoices(store)}/${id}/void-eligibility`),
    settings: (s, store) => ctx.read(s, `/api/v1/issuing-settings/${store}`),
    save: (s, store, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', drafts(store), body, key, headers),
    issue: (s, store, id, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', `${drafts(store)}/${id}/issue`, body, key, headers),
    voidInvoice: (s, store, id, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', `${invoices(store)}/${id}/void`, body, key, headers),
    putSettings: (s, store, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'PUT', `/api/v1/issuing-settings/${store}`, body, key, headers),
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
/** A login (or, with the reauthentication header and the presented cookie in `headers`, a reauthentication). */
async function signIn(ctx, who, { token = who.token, headers = {} } = {}) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${token}`, ...headers,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const csrf = JSON.parse(reply.body).csrfToken;
  const key = createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
  KEYS.add(key);
  SECRETS.add(csrf).add(cookie.slice(cookie.indexOf('=') + 1)).add(key);
  return { cookie, csrf, key, principal: who.principal };
}
/** A token whose provider authentication time is `ageMs` ago (a stale sign-in past 10 minutes). */
function agedToken(who, ageMs) {
  const token = `${who.token}-aged-${randomUUID().slice(0, 8)}`;
  TOKENS.set(token, { uid: who.uid, authAgeMs: ageMs });
  SECRETS.add(token);
  return token;
}
/** A session whose recent sign-in ends 3-4 s from now (deadline: epoch ms, the database's comparator bound). */
async function timedSignIn(ctx, who) {
  const authTimeSec = Math.ceil((Date.now() + 3_000 - RECENT_AUTH_MAX_AGE_MS) / 1000);
  const deadline = authTimeSec * 1000 + RECENT_AUTH_MAX_AGE_MS;
  const token = `${who.token}-at-${authTimeSec}`;
  TOKENS.set(token, { uid: who.uid, authTimeSec });
  SECRETS.add(token);
  const s = await signIn(ctx, who, { token });
  const [{ authenticated_at: bound }] = await owner`select authenticated_at from tmpos_session.session where session_key = ${s.key}`;
  assert.equal(Number(bound), authTimeSec * 1000, 'the session binds the provider\'s authentication time');
  return { s, deadline };
}
async function seed(ctx, s, store, tenant, customer, lines) {
  const reply = await ctx.save(s, store, saveBody(tenant, customer, lines));
  assert.equal(reply.status, 201, `the seed save: ${reply.body}`);
  const id = JSON.parse(reply.body).draft.id;
  SECRETS.add(id);
  return id;
}
/** The owner's settings write at the version its read reports; the new version. */
async function configure(ctx, sb, tenant, store, seller) {
  const read = await ctx.settings(sb, store);
  assert.equal(read.status, 200, `the owner's settings read: ${read.body}`);
  const version = JSON.parse(read.body).issuingSettings.version;
  const reply = await ctx.putSettings(sb, store, { expectedTenant: tenant, expectedVersion: version, ...seller });
  assert.equal(reply.status, 200, `the owner's settings PUT: ${reply.body}`);
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
/** The void's sealed 200: exactly { "invoice": { "id", "status": "voided" } } — no requestId, no Location (contract §4). */
function voidedOf(reply, invoice, label, { replayed = false } = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assert.equal(reply.body, `{"invoice":{"id":"${invoice}","status":"voided"}}`, `${label}: the exact sealed body`);
  assert.equal(reply.headers.location, undefined, `${label}: no Location`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
/** A sealed 409: exactly { "error": word } — no requestId (idempotency.ts refusalEnvelope). */
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
/** A list page: exactly { invoices, nextCursor }. */
function pageOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assertBaseline(reply, label);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['invoices', 'nextCursor'], label);
  return body;
}
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
/** One store of a fresh tenant with its owner (tenant grant), a store_owner and a manager (store grants) and a customer. */
async function world(label) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label.toUpperCase()} store`);
  const C = await newCustomer(T, label);
  const boss = await actor(`${label}-boss`, [tenantGrant(T, 'store_owner')]);
  const so = await actor(`${label}-so`, [storeGrant(T, S, 'store_owner')]);
  const mgr = await actor(`${label}-mgr`, [storeGrant(T, S, 'manager')]);
  return { label, T, S, C, boss, so, mgr };
}
/** The tenant owner signs in on `ctx` and writes the store's issuing settings once (the 8875 rate). */
async function ready(ctx, w) {
  w.sb = await signIn(ctx, w.boss);
  w.seller = sellerOf(w.label);
  w.tax = w.seller.tax;
  w.settingsVersion = await configure(ctx, w.sb, w.T, w.S, w.seller);
  return w;
}
/** A draft saved and issued by `s` at `w`'s store; { draft, invoice, lines, key, reply }. */
async function issueOne(ctx, s, w, label, { lines = [line(described(label), 1, 100)], key = randomUUID() } = {}) {
  const draft = await seed(ctx, s, w.S, w.T, w.C, lines);
  const reply = await ctx.issue(s, w.S, draft, issueBody(w.T, 1, w.settingsVersion, 1), { key });
  const invoice = issuedOf(reply, { draftId: draft, version: 2, store: w.S }, `${label}: the issue`);
  return { draft, invoice, lines, key, reply };
}
/** The invoice's number and issue time as stored (the time in the wire's encoding). */
async function issuedFactsOf(invoice) {
  const [row] = await owner`select number::int as number, pg_catalog.to_char(issued_at at time zone 'UTC', ${UTC_FORMAT}) as issued_at
    from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice}`;
  return { ...row };
}
/**
 * The detail's exact bytes as migration 034's builder answers them (invoiceIssueHttp IIH-03's form), from the OWNER's rows
 * and the fixture values — plus, for a voided invoice, exactly ONE more member, LAST: "void": { voidedAt, reasonCode }.
 */
async function detailBytes(w, x, lifecycle = null) {
  const { number, issued_at: issuedAt } = await issuedFactsOf(x.invoice);
  const { seller } = w;
  return JSON.stringify({
    invoice: {
      id: x.invoice, number, status: lifecycle === null ? 'issued' : 'voided', snapshotVersion: 1, issuedAt, sourceDraft: { id: x.draft, version: 1 },
      seller: { legalName: seller.legalName, storeName: seller.storeName, postalAddress: seller.postalAddress, taxRegistrationId: seller.taxRegistrationId },
      issuingSettingsVersion: w.settingsVersion, customer: { id: w.C, name: NAMES.get(w.C), version: 1 }, lines: linesFor(x.lines), amounts: amountsFor(subtotalOf(x.lines), w.tax),
      ...(lifecycle === null ? {} : { void: { voidedAt: lifecycle.voidedAt, reasonCode: lifecycle.reasonCode } }),
    },
  });
}
/** A list row exactly as the list answers it: the ten keys, `status` the lifecycle. */
async function listItemOf(w, x, status = 'issued') {
  const { number, issued_at: issuedAt } = await issuedFactsOf(x.invoice);
  return {
    id: x.invoice, number, sourceDraftId: x.draft, customerId: w.C, customerName: NAMES.get(w.C), currency: 'USD',
    totalCents: amountsFor(subtotalOf(x.lines), w.tax).totalCents, issuedAt, status, snapshotVersion: 1,
  };
}

// ---------------------------------------------------------------------------
// levers (the issue suite's)
// ---------------------------------------------------------------------------

async function hold(label, setup) {
  const ready_ = deferred();
  const release = deferred();
  const done = owner.begin(async (sql) => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    await setup(sql);
    ready_.resolve({ pid });
    if ((await release.promise) === 'rollback') throw ROLLBACK;
  }).then(() => 'committed', (e) => (e === ROLLBACK ? 'rolled back' : `failed:${e?.message ?? e}`));
  const first = await Promise.race([ready_.promise, done.then((v) => ({ early: v }))]);
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
const holdIssuedHeader = (invoice) => hold('issued header for update', (sql) => sql`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice} for update`);
const holdGate = () => hold('the gate row', (sql) => sql`select 1 from ivh_proof.gate where id = 1 for update`);
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
/** The OWNER takes `invoice`'s issued header FOR UPDATE: granted only once no transaction holds or waits ahead on it. */
async function headerFree(invoice) {
  await owner.begin(async (sql) => {
    await sql`select pg_catalog.set_config('lock_timeout', ${`${WAIT_MS}ms`}, true)`;
    await sql`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${invoice} for update`;
  });
}
const TRIGGER_ACTIONS = Object.freeze({
  raise: `raise exception 'IVH injected fault' using errcode = 'P0001';`,
  // Waits on the gate row (the OWNER holds it in a lever), then lets the row through.
  park: 'perform 1 from ivh_proof.gate where id = 1 for update; return new;',
  // Only counts that the write was attempted (the sequence is not transactional), then lets the row on to 035's own guard.
  count: 'return new;',
});
/** `work` runs with ONE owner trigger BEFORE `event` on `table` for each row matching `when`: it counts itself, then acts. */
async function withTrigger(table, event, when, action, work) {
  await owner.unsafe(`create function ivh_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('ivh_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function ivh_proof.fire() from public');
  await owner.unsafe(`create trigger ivh_fire before ${event} on ${table} for each row when (${when}) execute function ivh_proof.fire()`);
  try { return await work(); } finally {
    await owner.unsafe(`drop trigger if exists ivh_fire on ${table}`);
    await owner.unsafe('drop function if exists ivh_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('ivh_proof.fired'::regclass), 0)::int as n`)[0].n;
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
  assert.equal(await holds(waiter, ISSUED_TABLE, 'tuple', 'AccessExclusiveLock'), 1, `${label}: holding the issued header's tuple lock (FOR UPDATE)`);
}
async function assertQueuedOnHeaderTuple(waiter, label) {
  assert.deepEqual(await waitsOf(waiter), [{ locktype: 'tuple', mode: 'AccessExclusiveLock', xid: null, relation: ISSUED_TABLE }], `${label}: queued for the issued header's tuple lock`);
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

// ===========================================================================
// IVH-01: authority over stored levels
// ===========================================================================

test('IVH-01 (VOID-01, D-VOID-2, R-SEC-03): authority on the STORED levels, set through the real PUT /api/v1/roles/levels — store_owner (Full) and the manager default void, the technician and sales_staff defaults do not; a manager at Invoices manage is refused, at approve allowed, at approve with Customers none refused and with Customers view allowed (exactly both thresholds), at full allowed; a technician raised to approve (Customers view by default) voids; a read-only account, tenant and store, a tenant grant only and another store\'s grant are refused — the eligibility equals the POST\'s authorization in every row, every refusal the chain\'s 403 before any key, every void naming its actor and leaving the invoice, its lines, the counter and the source draft as they were', async () => {
  const { T, S, C, boss, so } = await world('ivh01');
  const S2 = await newStore(T, 'IVH01 other store');
  const roles = {};
  for (const role of ['manager', 'technician', 'sales_staff']) roles[role] = await actor(`ivh01-${role}`, [storeGrant(T, S, role)]);
  const ro = await actor('ivh01-ro', [storeGrant(T, S, 'store_owner')], 'read_only');
  const elsewhere = await actor('ivh01-elsewhere', [storeGrant(T, S2, 'manager')]);
  await withEntry(async (ctx) => {
    let sso = await signIn(ctx, so);
    const sb = await signIn(ctx, boss);
    const sessions = { store_owner: sso, ro: await signIn(ctx, ro), elsewhere: await signIn(ctx, elsewhere), boss: sb };
    for (const [role, who] of Object.entries(roles)) sessions[role] = await signIn(ctx, who);
    const actors = { store_owner: so, ro, elsewhere, boss, ...roles };
    const w = { T, S, C, settingsVersion: await configure(ctx, sb, T, S, sellerOf('ivh01')) };
    // The refused rows' target, never voided: the eligibility is target-blind, so it is asked of this one in every row.
    const victim = (await issueOne(ctx, sso, w, 'ivh01 victim')).invoice;
    /** The eligibility, then the POST it predicts: an allowed row voids a fresh invoice the store owner issued. */
    const decide = async (who, label, { s = sessions[who] } = {}) => {
      const eligibility = await ctx.voidEligibility(s, S, victim);
      const verdict = verdictOf(eligibility, `${label}: the eligibility`);
      if (verdict === 'forbidden') assert.equal(ctx.reason(eligibility), 'authz_denied', `${label}: the eligibility is the authorizer's refusal`);
      const target = verdict === 'allowed' ? (await issueOne(ctx, sso, w, `ivh01 ${label}`)).invoice : victim;
      const key = randomUUID();
      const keys = [{ key, principal: actors[who].principal }];
      const image = await imageOf(target);
      const before = await counts([T], keys);
      const reply = await ctx.voidInvoice(s, S, target, voidBody(T, 'issued_in_error'), { key });
      if (verdict === 'allowed') {
        voidedOf(reply, target, `${label}: the POST`);
        assert.deepEqual(delta(await counts([T], keys), before), ONE_VOID, `${label}: one void`);
        const row = await voidRowOf(target);
        assert.deepEqual([row.voided_by, row.reason_code, row.tenant_id, row.store_id], [actors[who].id, 'issued_in_error', T, S], `${label}: the void record names its actor`);
      } else {
        assertRefusal(reply, 403, 'forbidden', `${label}: the POST`);
        assert.equal(ctx.reason(reply), 'authz_denied', `${label}: the authorizer's own refusal`);
        assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: nothing written`);
        assert.equal(await recordsOf(key, actors[who].principal), 0, `${label}: refused before any key`);
        assert.equal(await voidRowOf(target), null, `${label}: no void record`);
      }
      assert.deepEqual(await imageOf(target), image, `${label}: the invoice, its lines, the counter and the source draft as they were (xmin included)`);
      return verdict;
    };
    const verdicts = {};
    verdicts['store_owner (fixed Full)'] = await decide('store_owner', 'store_owner');
    for (const role of ['manager', 'technician', 'sales_staff']) verdicts[`${role} default`] = await decide(role, `${role} at its default`);
    for (const [label, domain, level] of [
      ['manager invoices manage', 'invoices', 'manage'], ['manager invoices approve', 'invoices', 'approve'],
      ['manager invoices approve, customers none', 'customers', 'none'], ['manager invoices approve, customers view', 'customers', 'view'],
      ['manager invoices full, customers view', 'invoices', 'full'],
    ]) {
      await putLevel(ctx, sb, T, 'manager', domain, level, 'IVH-01');
      verdicts[label] = await decide('manager', label);
    }
    await putLevel(ctx, sb, T, 'technician', 'invoices', 'approve', 'IVH-01');
    verdicts['technician invoices approve (customers default view)'] = await decide('technician', 'technician raised to Invoices approve');
    verdicts['read-only account'] = await decide('ro', 'a read-only account (store_owner grant)');
    verdicts['tenant grant only'] = await decide('boss', 'a tenant grant only');
    verdicts['another store\'s grant'] = await decide('elsewhere', 'a grant at another store only');
    for (const [label, change, restore] of [
      ['a read-only tenant', () => owner`update tenant set status = 'read_only' where tenant_id = ${T}`, () => owner`update tenant set status = 'active' where tenant_id = ${T}`],
      ['a read-only store', () => owner`update store set status = 'read_only' where store_id = ${S}`, () => owner`update store set status = 'active' where store_id = ${S}`],
    ]) {
      await change();
      try {
        verdicts[label] = await decide('store_owner', label, { s: await signIn(ctx, so) });
      } finally {
        await restore();
      }
      // A status change moves the actor's standing: every earlier session is refused from now on (the login limit is five
      // per account per five minutes, so the store owner signs in again only here).
      if (label === 'a read-only tenant') sso = await signIn(ctx, so);
    }
    assert.deepEqual(verdicts, {
      'store_owner (fixed Full)': 'allowed', 'manager default': 'allowed', 'technician default': 'forbidden', 'sales_staff default': 'forbidden',
      'manager invoices manage': 'forbidden', 'manager invoices approve': 'allowed', 'manager invoices approve, customers none': 'forbidden',
      'manager invoices approve, customers view': 'allowed', 'manager invoices full, customers view': 'allowed',
      'technician invoices approve (customers default view)': 'allowed', 'read-only account': 'forbidden', 'tenant grant only': 'forbidden',
      'another store\'s grant': 'forbidden', 'a read-only tenant': 'forbidden', 'a read-only store': 'forbidden',
    });
    // The levels back at the catalog defaults (manager Invoices full already; Customers full; technician Invoices view), by a
    // new owner session: the tenant's status change above moved every earlier session's standing.
    const sbAfter = await signIn(ctx, boss);
    await putLevel(ctx, sbAfter, T, 'manager', 'customers', 'full', 'IVH-01 restore');
    await putLevel(ctx, sbAfter, T, 'technician', 'invoices', 'view', 'IVH-01 restore');
  });
});

// ===========================================================================
// IVH-01b: no creator shortcut (F1 / T2, HTTP half)
// ===========================================================================

test('IVH-01b (VOID-01, D-VOID-2 "no creator shortcut", R-SEC-03): the actor who ISSUED an invoice — lowered through the real PUT /api/v1/roles/levels below Invoices Approve (to manage), and separately below Customers View (to none) — POSTs a void of their OWN invoice from the very session that issued it and gets the chain\'s 403 forbidden (authz_denied) before any key, the eligibility forbidden too: a 403 leaves NOTHING — no idempotency record (no lease, no completion), no void record, no audit record, no outbox row — and the invoice, its lines, the counter and the source draft as they were; with both levels restored the same actor voids the same invoice (the refusals were the levels, nothing else)', async () => {
  const w = await world('ivh01b');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'ivh01b own invoice');
    const [issuer] = await owner`select issued_by from tmpos_invoice_issue.issued_invoice where invoice_id = ${x.invoice}`;
    assert.equal(issuer.issued_by, w.mgr.id, 'the invoice is the manager\'s own: they issued it');
    assert.equal(verdictOf(await ctx.voidEligibility(s, w.S, x.invoice), 'before lowering: the eligibility'), 'allowed', 'at its default the issuer may void');
    const image = await imageOf(x.invoice);
    for (const [label, domain, lowered, restored] of [
      ['Invoices below Approve (manage)', 'invoices', 'manage', 'full'],
      ['Customers below View (none)', 'customers', 'none', 'full'],
    ]) {
      await putLevel(ctx, w.sb, w.T, 'manager', domain, lowered, `IVH-01b ${label}`);
      const eligibility = await ctx.voidEligibility(s, w.S, x.invoice);
      assert.equal(verdictOf(eligibility, `${label}: the eligibility`), 'forbidden', `${label}: the issuer's eligibility`);
      assert.equal(ctx.reason(eligibility), 'authz_denied', `${label}: the authorizer's own refusal`);
      for (const code of ['issued_in_error', 'other']) {
        const key = randomUUID();
        const keys = [{ key, principal: w.mgr.principal }];
        const before = await counts([w.T], keys);
        const reply = await ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, code), { key });
        assertRefusal(reply, 403, 'forbidden', `${label}: the issuer's void (${code})`);
        assert.equal(ctx.reason(reply), 'authz_denied', `${label}: the authorizer's refusal (${code}), not a routine's`);
        assert.deepEqual(delta(await counts([w.T], keys), before), NOTHING, `${label}: nothing written (${code}) — no void, no audit, no outbox, no completion, no lease`);
        assert.equal(await recordsOf(key, w.mgr.principal), 0, `${label}: refused before any key (${code}): no idempotency record of any kind`);
        assert.equal(await voidRowOf(x.invoice), null, `${label}: no void record (${code})`);
      }
      assert.deepEqual(await imageOf(x.invoice), image, `${label}: the invoice, its lines, the counter and the source draft as they were (xmin included)`);
      await putLevel(ctx, w.sb, w.T, 'manager', domain, restored, `IVH-01b ${label} restore`);
    }
    // The control: the same actor, the same session, the same invoice, the levels back — a 200. The refusals above were the levels.
    const key = randomUUID();
    const keys = [{ key, principal: w.mgr.principal }];
    const before = await counts([w.T], keys);
    voidedOf(await ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, 'issued_in_error'), { key }), x.invoice, 'control: the restored issuer voids their own invoice');
    assert.deepEqual(delta(await counts([w.T], keys), before), ONE_VOID, 'control: one void');
    assert.equal((await voidRowOf(x.invoice)).voided_by, w.mgr.id, 'control: the void names the issuer as its actor');
  });
});

// ===========================================================================
// IVH-02: the recent sign-in
// ===========================================================================

test('IVH-02 (VOID-01 recent sign-in, D-VOID-2, R-SEC-05; BRIEF §8 "Recent sign-in"): a manager whose provider sign-in is 11 minutes old — the action-only eligibility still answers allowed (recentAuth none: it is no proof the sign-in is recent enough), the POST is the chain\'s 403 step_up_required (recent_auth_required) before any key, nothing written; a reauthentication presenting that session makes the sign-in fresh, and the SAME key then voids once; a same-key replay from another stale session of the same principal is stopped by the same step-up before idempotency, a fresh one replays the sealed 200; the reauthenticated session is ended (401); the issue, which declares no recent sign-in, still issues from a stale session', async () => {
  const w = await world('ivh02');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'ivh02');
    const staleToken = agedToken(w.mgr, RECENT_AUTH_MAX_AGE_MS + 60_000);
    const stale = await signIn(ctx, w.mgr, { token: staleToken });
    const stale2 = await signIn(ctx, w.mgr, { token: staleToken });
    const [{ old }] = await owner`select authenticated_at < (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint - ${RECENT_AUTH_MAX_AGE_MS}::int as old
      from tmpos_session.session where session_key = ${stale.key}`;
    assert.equal(old, true, 'the stale session binds a sign-in older than 10 minutes');
    assert.equal(verdictOf(await ctx.voidEligibility(stale, w.S, x.invoice), 'the stale session\'s eligibility'), 'allowed', 'action-only: no recent sign-in judged');
    const key = randomUUID();
    const keys = [{ key, principal: w.mgr.principal }];
    const body = JSON.stringify(voidBody(w.T, 'wrong_seller_details'));
    let before = await counts([w.T], keys);
    const refused = await ctx.voidInvoice(stale, w.S, x.invoice, body, { key });
    assertRefusal(refused, 403, 'step_up_required', 'the void from a stale sign-in');
    assert.equal(ctx.reason(refused), 'recent_auth_required', 'the chain\'s step-up');
    assert.deepEqual(delta(await counts([w.T], keys), before), NOTHING, 'the stale void: nothing written');
    assert.equal(await recordsOf(key, w.mgr.principal), 0, 'refused before any key');
    // A reauthentication of the stale session with a fresh provider sign-in (the session is rotated).
    const fresh = await signIn(ctx, w.mgr, { headers: { cookie: stale.cookie, [REAUTHENTICATE_HEADER]: REAUTHENTICATE_VALUE } });
    before = await counts([w.T], keys);
    const first = await ctx.voidInvoice(fresh, w.S, x.invoice, body, { key });
    voidedOf(first, x.invoice, 'the same key after the reauthentication');
    assert.deepEqual(delta(await counts([w.T], keys), before), ONE_VOID, 'one void');
    // A replay: the step-up stands before idempotency handling (R-SEC-05), the recorded bytes only to a fresh sign-in.
    before = await counts([w.T], keys);
    const again = await ctx.voidInvoice(stale2, w.S, x.invoice, body, { key });
    assertRefusal(again, 403, 'step_up_required', 'the same-key replay from another stale session');
    assert.equal(ctx.reason(again), 'recent_auth_required');
    const replay = await ctx.voidInvoice(fresh, w.S, x.invoice, body, { key });
    voidedOf(replay, x.invoice, 'the same-key replay from the fresh session', { replayed: true });
    assert.equal(replay.body, first.body, 'the recorded bytes');
    assertRefusal(await ctx.voidInvoice(stale, w.S, x.invoice, body, { key }), 401, 'unauthenticated', 'the session the reauthentication ended');
    assert.deepEqual(delta(await counts([w.T], keys), before), NOTHING, 'the replays wrote nothing');
    // The step-up is the void's alone: the issue declares none and still issues from a stale sign-in.
    await issueOne(ctx, stale2, w, 'ivh02 issue from a stale sign-in');
  });
});

// ===========================================================================
// IVH-03: isolation
// ===========================================================================

test('IVH-03 (VOID-02, R-K3, D-VOID-2): isolation — a missing, another store\'s and another tenant\'s invoice are one 404 for the void (rolled back, its lease open), the foreign invoices untouched; a store the actor holds no grant at, another tenant\'s, a missing and a non-canonical one are the 403 before any key for the void and its eligibility; a non-canonical invoice id is the 400 before any key, a canonical id the outbox\'s aggregate shape refuses the planner\'s 400 after it; the eligibility is target-blind (a missing, a foreign and a voided invoice alike); once voided, the invoice is the same 404 at another store and to another tenant, and absent from their lists', async () => {
  const T = await newTenant('ivh03');
  const T2 = await newTenant('ivh03-other');
  const S1 = await newStore(T, 'IVH03 one');
  const S2 = await newStore(T, 'IVH03 two');
  const S3 = await newStore(T, 'IVH03 ungranted');
  const X = await newStore(T2, 'IVH03 foreign');
  const C = await newCustomer(T, 'ivh03');
  const C2 = await newCustomer(T2, 'ivh03-foreign');
  const who = await actor('ivh03', [storeGrant(T, S1, 'manager'), storeGrant(T, S2, 'manager')]);
  const foreign = await actor('ivh03-foreign', [storeGrant(T2, X, 'manager')]);
  const boss = await actor('ivh03-boss', [tenantGrant(T, 'store_owner')]);
  const boss2 = await actor('ivh03-boss2', [tenantGrant(T2, 'store_owner')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const sf = await signIn(ctx, foreign);
    const sb = await signIn(ctx, boss);
    const at = (tenant, store, customer, settingsVersion) => ({ T: tenant, S: store, C: customer, settingsVersion });
    const w1 = at(T, S1, C, await configure(ctx, sb, T, S1, sellerOf('ivh03 one')));
    const w2 = at(T, S2, C, await configure(ctx, sb, T, S2, sellerOf('ivh03 two')));
    const wX = at(T2, X, C2, await configure(ctx, await signIn(ctx, boss2), T2, X, sellerOf('ivh03 foreign')));
    const i1 = await issueOne(ctx, s, w1, 'ivh03 at S1');
    const i2 = await issueOne(ctx, s, w2, 'ivh03 at S2');
    const iX = await issueOne(ctx, sf, wX, 'ivh03 at X');
    const images = { [i2.invoice]: await imageOf(i2.invoice), [iX.invoice]: await imageOf(iX.invoice) };
    const body = voidBody(T, 'duplicate');
    // (1) One 404, rolled back, the lease open.
    const shapes = [];
    for (const [label, invoice] of [['a missing invoice', randomUUID()], ['another store\'s invoice', i2.invoice], ['another tenant\'s invoice', iX.invoice]]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T, T2], keys);
      const r = await ctx.voidInvoice(s, S1, invoice, body, { key });
      assertRefusal(r, 404, 'not_found', label);
      shapes.push({ bytes: Buffer.byteLength(r.body), reason: ctx.reason(r) });
      assert.deepEqual(delta(await counts([T, T2], keys), before), LEASE_ONLY, `${label}: rolled back, nothing but the open lease`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease open`);
      if (images[invoice] !== undefined) assert.deepEqual(await imageOf(invoice), images[invoice], `${label}: untouched`);
      assert.equal(await voidRowOf(invoice), null, `${label}: no void record`);
    }
    assert.equal(new Set(shapes.map((x) => JSON.stringify(x))).size, 1, `one 404: ${JSON.stringify(shapes)}`);
    assert.equal(shapes[0].reason, 'transaction_not_found');
    // (2) A store that is not the trusted one: the 403 before any key, for the void and its eligibility.
    for (const [label, store] of [['an ungranted store', S3], ['another tenant\'s store', X], ['a missing store', randomUUID()], ['a non-canonical store', S1.toUpperCase()]]) {
      const key = randomUUID();
      const before = await counts([T, T2]);
      assertRefusal(await ctx.voidEligibility(s, store, i1.invoice), 403, 'forbidden', `${label}: the eligibility`);
      assertRefusal(await ctx.voidInvoice(s, store, i1.invoice, body, { key }), 403, 'forbidden', `${label}: the void`);
      assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(key, who.principal), 0, `${label}: no key acquired`);
    }
    // (3) The target: a non-canonical id before any key; the nil uuid (canonical, but no RFC version) the planner's 400 after it.
    for (const [label, id, status, reason, effect] of [
      ['an upper-case invoice id', i1.invoice.toUpperCase(), 400, 'command_target_invalid', NOTHING],
      ['a truncated invoice id', i1.invoice.slice(0, 35), 400, 'command_target_invalid', NOTHING],
      ['the nil uuid', NIL, 400, 'command_request_invalid', LEASE_ONLY],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T, T2], keys);
      const r = await ctx.voidInvoice(s, S1, id, body, { key });
      assertRefusal(r, status, 'invalid_request', label);
      assert.equal(ctx.reason(r), reason, `${label}: ${reason}`);
      assert.deepEqual(delta(await counts([T, T2], keys), before), effect, `${label}: ${effect === NOTHING ? 'refused before any key' : 'the lease, nothing else'}`);
    }
    // (4) The eligibility reads no invoice: allowed for a missing and another store's invoice alike.
    for (const [label, id] of [['a missing invoice', randomUUID()], ['another store\'s invoice', i2.invoice], ['another tenant\'s invoice', iX.invoice]]) {
      assert.equal(verdictOf(await ctx.voidEligibility(s, S1, id), `the eligibility of ${label}`), 'allowed', `target-blind: ${label}`);
    }
    // (5) Voided at its own store: no store, tenant or path discloses it elsewhere.
    voidedOf(await ctx.voidInvoice(s, S1, i1.invoice, body), i1.invoice, 'the control: its own store voids it');
    assert.equal(verdictOf(await ctx.voidEligibility(s, S1, i1.invoice), 'the eligibility of the voided invoice'), 'allowed', 'not proof the invoice is still issued');
    const key = randomUUID();
    const before = await counts([T, T2], [{ key, principal: who.principal }]);
    assertRefusal(await ctx.voidInvoice(s, S2, i1.invoice, body, { key }), 404, 'not_found', 'the voided invoice at another store of the tenant: the 404, never "already void"');
    assert.deepEqual(delta(await counts([T, T2], [{ key, principal: who.principal }]), before), LEASE_ONLY);
    for (const [label, sess, store] of [['another store', s, S2], ['another tenant', sf, X]]) {
      const detail = await ctx.invoice(sess, store, i1.invoice);
      assertRefusal(detail, 404, 'not_found', `the voided invoice\'s detail at ${label}`);
      assert.equal(ctx.reason(detail), 'issued_invoice_not_found');
      assert.ok(!pageOf(await ctx.invoices(sess, store), `${label}'s list`).invoices.some((i) => i.id === i1.invoice), `absent from ${label}'s list`);
      assert.deepEqual(pageOf(await ctx.invoices(sess, store, `?sourceDraft=${i1.draft}`), `${label}'s filter`), { invoices: [], nextCursor: null }, `${label}: the empty page`);
    }
  });
});

// ===========================================================================
// IVH-04: the transaction, the audit record and the reads
// ===========================================================================

test('IVH-04 (VOID-04, VOID-10, D-VOID-1, D-VOID-3, D-VOID-4, R-K5, R-K6, R-SEC-04, R-BR-12): one void per reason code — the exact sealed 200 {"invoice":{"id","status":"voided"}}; one void record (the header\'s tenant and store, the code, voided_by = the actor, voided_at inside the request and not before the issue); ONE audit record (store.invoice.void, scope store, the actor, tenant and store, the issued invoice its ONLY subject, permission void_issued_invoices, reasonCode invoice_void_<code>, the fixed sentence "Issued invoice voided. Reason: <label>.", metadata {}, occurred_at <= voided_at); no outbox row; the completion; the invoice, its lines, the counter and the source draft unchanged (xmin included) — and the reads: before any void every detail and the list are the 034 answers byte for byte; after, a never-voided detail is unchanged byte for byte, a voided one is the 034 bytes with "status":"voided" and exactly one more member "void":{"voidedAt","reasonCode"} LAST, never the voiding actor; the list carries each row\'s status in the same ten keys, the same order and cursors; ?sourceDraft= finds each voided invoice; read on a second entry', async () => {
  const w = await world('ivh04');
  await withEntry((a) => withEntry(async (b) => {
    await ready(a, w);
    const s = await signIn(a, w.mgr);
    const sr = await signIn(b, w.so);
    const xs = [];
    for (let n = 0; n < 7; n += 1) xs.push(await issueOne(a, s, w, `ivh04 ${n}`, { lines: [line(described(`ivh04 ${n} a`), n + 1, 1999), line(described(`ivh04 ${n} b`), 3, 7)] }));
    const sibling = xs[3];
    const voiding = xs.filter((x) => x !== sibling);
    assert.equal(voiding.length, REASONS.length);
    // Before any void: the 034 answers, byte for byte.
    const before = {};
    for (const x of xs) {
      const reply = await b.invoice(sr, w.S, x.invoice);
      assert.equal(reply.status, 200, reply.body);
      assertBaseline(reply, 'a detail before any void');
      assert.equal(reply.body, await detailBytes(w, x), `invoice ${xs.indexOf(x) + 1}: the 034 detail, byte for byte`);
      before[x.invoice] = reply.body;
    }
    const newestFirst = [...xs].reverse();
    const listBefore = await b.invoices(sr, w.S);
    assert.equal(listBefore.body, JSON.stringify({ invoices: await Promise.all(newestFirst.map((x) => listItemOf(w, x))), nextCursor: null }), 'the 034 list, byte for byte');
    const pageBefore = pageOf(await b.invoices(sr, w.S, '?limit=3'), 'page one before');
    const page2Before = pageOf(await b.invoices(sr, w.S, `?limit=3&cursor=${pageBefore.nextCursor}`), 'page two before');
    // The voids, one per code.
    const lifecycles = new Map();
    for (const [n, [code, label]] of REASONS.entries()) {
      const x = voiding[n];
      const key = randomUUID();
      const keys = [{ key, principal: w.mgr.principal }];
      const image = await imageOf(x.invoice);
      const c0 = await counts([w.T], keys);
      const [{ t: t0 }] = await owner`select pg_catalog.clock_timestamp()::text as t`;
      const reply = await a.voidInvoice(s, w.S, x.invoice, voidBody(w.T, code), { key });
      const [{ t: t1 }] = await owner`select pg_catalog.clock_timestamp()::text as t`;
      voidedOf(reply, x.invoice, `${code}: the void`);
      assert.deepEqual(delta(await counts([w.T], keys), c0), ONE_VOID, `${code}: one void record, one audit record, one completion — no outbox row, no number, invoice, line or draft change`);
      assert.deepEqual(await imageOf(x.invoice), image, `${code}: the invoice, its lines, the counter and the source draft unchanged (xmin included)`);
      assert.equal(await leaseOpen(key, w.mgr.principal), false, `${code}: the completion recorded`);
      const row = await voidRowOf(x.invoice);
      const { voided_at: voidedAt, ...rest } = row;
      assert.deepEqual(rest, { invoice_id: x.invoice, tenant_id: w.T, store_id: w.S, reason_code: code, voided_by: w.mgr.id }, `${code}: the void record`);
      assert.match(voidedAt, WIRE_TIME_RE, `${code}: voided_at in the wire's encoding`);
      const [{ inside, after_issue: afterIssue }] = await owner`select ${voidedAt}::timestamptz between ${t0}::timestamptz and ${t1}::timestamptz as inside,
        ${voidedAt}::timestamptz >= (select issued_at from tmpos_invoice_issue.issued_invoice where invoice_id = ${x.invoice}) as after_issue`;
      assert.deepEqual([inside, afterIssue], [true, true], `${code}: voided_at is the database's time inside the request, not before the issue`);
      const audits = await owner`select a.scope_type, a.tenant_id, a.store_id, a.actor_internal_user_id, a.action_id, a.required_permission, a.decision, a.result_status,
        a.reason_code, a.human_readable_reason as reason, a.metadata, a.subject_invoice_draft_id, a.subject_issued_invoice_id, a.subject_customer_id,
        a.subject_store_id, a.subject_tenant_id, a.occurred_at <= v.voided_at as before_void
        from public.audit_event a join tmpos_invoice_void.issued_invoice_void v on v.invoice_id = ${x.invoice}
        where a.action_id = ${VOID_ACTION} and a.tenant_id = ${w.T} and a.subject_issued_invoice_id = ${x.invoice}`;
      assert.deepEqual(audits.map((r) => ({ ...r })), [{
        scope_type: 'store', tenant_id: w.T, store_id: w.S, actor_internal_user_id: w.mgr.id, action_id: VOID_ACTION, required_permission: VOID_PERMISSION,
        decision: 'allow', result_status: 'succeeded', reason_code: `invoice_void_${code}`, reason: `Issued invoice voided. Reason: ${label}.`, metadata: {},
        subject_invoice_draft_id: null, subject_issued_invoice_id: x.invoice, subject_customer_id: null, subject_store_id: null, subject_tenant_id: null, before_void: true,
      }], `${code}: exactly one void record, the invoice alone at store scope, the fixed annex, occurred_at <= voided_at (never claimed equal)`);
      lifecycles.set(x.invoice, { voidedAt, reasonCode: code });
    }
    assert.equal((await owner`select count(*)::int as n from tmpos_internal.outbox_event where aggregate_id = any(${xs.map((x) => x.invoice)}::uuid[])`)[0].n, 0, 'no void enqueued an event');
    // After: the reads, on the SECOND entry.
    for (const x of xs) {
      const reply = await b.invoice(sr, w.S, x.invoice);
      assert.equal(reply.status, 200, reply.body);
      assertBaseline(reply, 'a detail after the voids');
      const lifecycle = lifecycles.get(x.invoice) ?? null;
      assert.equal(reply.body, await detailBytes(w, x, lifecycle), `invoice ${xs.indexOf(x) + 1}: the exact detail`);
      if (lifecycle === null) {
        assert.equal(reply.body, before[x.invoice], 'the never-voided sibling: the 034 bytes, unchanged by the voids beside it');
      } else {
        const derived = `${before[x.invoice].replace(`"status":"issued"`, `"status":"voided"`).slice(0, -2)},"void":{"voidedAt":"${lifecycle.voidedAt}","reasonCode":"${lifecycle.reasonCode}"}}}`;
        assert.equal(reply.body, derived, 'the 034 bytes with the status voided and ONE more member, "void", LAST');
        const invoice = JSON.parse(reply.body).invoice;
        assert.deepEqual(Object.keys(invoice).slice(-2), ['amounts', 'void'], 'void after amounts');
        assert.deepEqual(Object.keys(invoice.void), ['voidedAt', 'reasonCode'], 'in that key order');
        assert.ok(invoice.void.voidedAt >= invoice.issuedAt, 'voidedAt not before issuedAt (one fixed-width encoding)');
        for (const v of [w.mgr.id, w.mgr.uid]) assert.ok(!reply.body.includes(v), 'never the voiding actor');
      }
    }
    const listAfter = await b.invoices(sr, w.S);
    assert.equal(listAfter.body, JSON.stringify({
      invoices: await Promise.all(newestFirst.map((x) => listItemOf(w, x, lifecycles.has(x.invoice) ? 'voided' : 'issued'))), nextCursor: null,
    }), 'the list: each row\'s own status, the same ten keys, the same order');
    for (const item of JSON.parse(listAfter.body).invoices) assert.deepEqual(Object.keys(item), Object.keys(JSON.parse(listBefore.body).invoices[0]), 'the ten keys, in order');
    const pageAfter = pageOf(await b.invoices(sr, w.S, '?limit=3'), 'page one after');
    const page2After = pageOf(await b.invoices(sr, w.S, `?limit=3&cursor=${pageAfter.nextCursor}`), 'page two after');
    const shape = (page) => [page.invoices.map((i) => [i.id, i.number]), page.nextCursor];
    assert.deepEqual([shape(pageAfter), shape(page2After)], [shape(pageBefore), shape(page2Before)], 'the same pages and cursors');
    for (const x of voiding) {
      assert.equal((await b.invoices(sr, w.S, `?sourceDraft=${x.draft}`)).body, JSON.stringify({ invoices: [await listItemOf(w, x, 'voided')], nextCursor: null }), 'the recovery filter finds the voided invoice');
    }
    assert.equal((await b.invoices(sr, w.S, `?sourceDraft=${sibling.draft}`)).body, JSON.stringify({ invoices: [await listItemOf(w, sibling)], nextCursor: null }), 'and the issued one');
  }));
});

// ===========================================================================
// IVH-05: repeats
// ===========================================================================

test('IVH-05 (VOID-05, D-VOID-5, R-K1): the same key and bytes replay the sealed 200 byte for byte with Idempotent-Replayed: true; the same key with another code, at another invoice, or an issue\'s key on the void route is the unsealed 422 idempotency_key_reused, writing nothing; a NEW key on the voided invoice is the sealed 409 invalid_state (its completion alone, whatever code it names) and replays as such; the same key sent while its first attempt is still in flight waits on that attempt\'s fence and replays its sealed 200 once it commits (never a second attempt); past its retention the key is a new operation and answers invalid_state; a replay after the owner narrows the level is the authorizer\'s 403, after the restoration the recorded bytes — one void record and one audit record per invoice throughout', async () => {
  const w = await world('ivh05');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'ivh05 x');
    const y = await issueOne(ctx, s, w, 'ivh05 y');
    const body = JSON.stringify(voidBody(w.T, 'wrong_customer'));
    const key = randomUUID();
    const keys = [{ key, principal: w.mgr.principal }];
    const before = await counts([w.T], keys);
    const first = await ctx.voidInvoice(s, w.S, x.invoice, body, { key });
    voidedOf(first, x.invoice, 'the void');
    const replay = await ctx.voidInvoice(s, w.S, x.invoice, body, { key });
    voidedOf(replay, x.invoice, 'the replay', { replayed: true });
    assert.equal(replay.body, first.body, 'byte for byte');
    for (const [label, invoice, bytes, k] of [
      ['the same key, another code', x.invoice, JSON.stringify(voidBody(w.T, 'duplicate')), key],
      ['the same key and bytes, another invoice', y.invoice, body, key],
      ['the issue\'s key on the void route', y.invoice, body, y.key],
    ]) {
      const r = await ctx.voidInvoice(s, w.S, invoice, bytes, { key: k });
      assertRefusal(r, 422, 'idempotency_key_reused', label);
      assert.equal(ctx.reason(r), 'idempotency_conflict', label);
    }
    assert.deepEqual(delta(await counts([w.T], keys), before), ONE_VOID, 'the replay and the 422s wrote nothing: one void');
    assert.equal(await voidRowOf(y.invoice), null, 'the other invoice untouched');
    // A new key on the voided invoice: the sealed "already void", whatever code it names.
    for (const code of ['wrong_customer', 'other']) {
      const k = randomUUID();
      const c0 = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
      const sealed = await ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, code), { key: k });
      sealedOf(sealed, 'invalid_state', `a new key (${code}) on the voided invoice`);
      const sealedAgain = await ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, code), { key: k });
      sealedOf(sealedAgain, 'invalid_state', `its replay (${code})`, { replayed: true });
      assert.equal(sealedAgain.body, sealed.body);
      assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), c0), COMPLETION_ONLY, `${code}: its completion only`);
    }
    assert.equal((await voidRowOf(x.invoice)).reason_code, 'wrong_customer', 'the first void\'s code stands');
    // The same key sent while its first attempt is still in flight (that void waiting on the OWNER's hold of the header): the
    // acquisition waits on the attempt's fence (006: the record FOR UPDATE until its COMMIT) and, once the attempt commits,
    // replays its sealed 200 — never a second attempt. (An attempt that ENDED unsealed leaves a live lease: the same key is
    // then the 409 request_in_progress — IVH-06, IVH-09, IVH-10, IVH-11.)
    const k2 = randomUUID();
    const c2 = await counts([w.T], [{ key: k2, principal: w.mgr.principal }]);
    const h = await holdIssuedHeader(y.invoice);
    let pending;
    let busy;
    try {
      pending = quietly(ctx.voidInvoice(s, w.S, y.invoice, body, { key: k2 }));
      const firstPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_VOID }), 'the void waiting on the issued header');
      busy = quietly(ctx.voidInvoice(s, w.S, y.invoice, body, { key: k2 }));
      waitingPid(await blockedOrSettled(busy, { by: firstPid, query: AT_ACQUIRE }), 'the same key waiting on the first attempt\'s fence');
    } finally {
      await h.commit();
    }
    const recorded = await replyTo(pending, 'the void that waited');
    voidedOf(recorded, y.invoice, 'the void that waited applies');
    const second = await replyTo(busy, 'the same key sent while the first was in flight');
    voidedOf(second, y.invoice, 'the same key sent while the first was in flight: the sealed 200, replayed', { replayed: true });
    assert.equal(second.body, recorded.body, 'the recorded bytes');
    assert.deepEqual(delta(await counts([w.T], [{ key: k2, principal: w.mgr.principal }]), c2), ONE_VOID, 'one void: the in-flight repeat wrote nothing');
    // Past its retention the key's record is overwritten in place: a new operation, decided on the current state.
    await expireRetention(key, w.mgr.principal);
    const c3 = await counts([w.T], keys);
    sealedOf(await ctx.voidInvoice(s, w.S, x.invoice, body, { key }), 'invalid_state', 'the same key past its retention: a new operation');
    assert.deepEqual(delta(await counts([w.T], keys), c3), NOTHING, 'the record reused in place: no second void record or audit record');
    // Current authority on replay.
    await putLevel(ctx, w.sb, w.T, 'manager', 'invoices', 'manage', 'IVH-05');
    const narrowed = await ctx.voidInvoice(s, w.S, y.invoice, body, { key: k2 });
    assertRefusal(narrowed, 403, 'forbidden', 'the replay after the owner narrowed Invoices to manage');
    assert.equal(ctx.reason(narrowed), 'authz_denied', 'the authorizer, never the stored answer');
    await putLevel(ctx, w.sb, w.T, 'manager', 'invoices', 'full', 'IVH-05');
    const restored = await ctx.voidInvoice(s, w.S, y.invoice, body, { key: k2 });
    voidedOf(restored, y.invoice, 'the replay after the restoration', { replayed: true });
    assert.equal(restored.body, recorded.body, 'the recorded bytes');
    const [{ v, va }] = await owner`select (select count(*) from tmpos_invoice_void.issued_invoice_void where tenant_id = ${w.T})::int as v,
      (select count(*) from public.audit_event where action_id = ${VOID_ACTION} and tenant_id = ${w.T})::int as va`;
    assert.deepEqual([v, va], [2, 2], 'two invoices voided, one void record and one audit record each');
  });
});

// ===========================================================================
// IVH-06: the precondition, the strict body and its bound
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
function rawUnsafe(ctx, s, path, lines, tail, key) {
  SECRETS.add(key);
  USED_KEYS.push({ key, principal: s.principal });
  const head = [`Host: ${TENANT_HOST}`, `Origin: ${TENANT_ORIGIN}`, 'Sec-Fetch-Site: same-origin', `${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`,
    `Cookie: ${s.cookie}`, `${SESSION_CSRF_HEADER}: ${s.csrf}`, `Idempotency-Key: ${key}`];
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

test('IVH-06 (VOID-07 server half, VOID-13 server half, R-BR-08, R-BR-09, R-K3): a stale expectedTenant (another tenant, one that does not exist) is the unsealed 409 write_conflict — rolled back, no completion, the lease kept, the same-key retry 409 request_in_progress; every body the planner refuses — an extra key, a free-text reason, a version field, a forged auth-time, actor or store field, a missing key, an unknown, re-cased, label or audit-coded code, a non-canonical tenant, an array — is the 400 invalid_request after the key, the lease and nothing else; the void body is bounded at exactly 1 KiB on the real entry over real sockets — 1,024 bytes declared and chunked void, 1,025 bytes declared and chunked are the 413, a missing or unsupported Content-Type the 415, none with a key record; the current tenant then voids (control)', async () => {
  const w = await world('ivh06');
  const other = await newTenant('ivh06-other');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const victim = await issueOne(ctx, s, w, 'ivh06 victim');
    const image = await imageOf(victim.invoice);
    // (1) The precondition: unsealed, rolled back, the lease kept.
    for (const [label, tenant] of [['another tenant', other], ['a tenant that does not exist', randomUUID()]]) {
      const key = randomUUID();
      const keys = [{ key, principal: w.mgr.principal }];
      const before = await counts([w.T], keys);
      const reply = await ctx.voidInvoice(s, w.S, victim.invoice, voidBody(tenant, 'other'), { key });
      assertRefusal(reply, 409, 'write_conflict', `${label}: the precondition`);
      assert.equal(ctx.reason(reply), 'transaction_precondition_failed', label);
      assert.deepEqual(delta(await counts([w.T], keys), before), LEASE_ONLY, `${label}: no completion, the lease open`);
      assert.equal(await leaseOpen(key, w.mgr.principal), true, `${label}: the lease kept`);
      assertRefusal(await ctx.voidInvoice(s, w.S, victim.invoice, voidBody(tenant, 'other'), { key }), 409, 'request_in_progress', `${label}: the same-key retry within the lease`);
    }
    // (2) Bodies the planner refuses: the 400 after the key.
    const valid = voidBody(w.T, 'other');
    for (const [label, body] of [
      ['an extra key', { ...valid, note: 'x' }],
      ['a free-text reason beside the code', { ...valid, reason: described('ivh06 free text') }],
      ['a version field', { ...valid, expectedVersion: 1 }],
      ['a forged auth-time field', { ...valid, authenticatedAt: Date.now() }],
      ['a forged sign-in field', { ...valid, authTime: Math.floor(Date.now() / 1000) }],
      ['a forged actor field', { ...valid, actorId: w.boss.id }],
      ['a forged store field', { ...valid, storeId: w.S }],
      ['no reason code', { expectedTenant: w.T }],
      ['no expected tenant', { reasonCode: 'other' }],
      ['an unknown code', voidBody(w.T, 'refunded')],
      ['a re-cased code', voidBody(w.T, 'Other')],
      ['a label for its code', voidBody(w.T, 'Other reason')],
      ['the audit code for its code', voidBody(w.T, 'invoice_void_other')],
      ['an empty code', voidBody(w.T, '')],
      ['a null code', { expectedTenant: w.T, reasonCode: null }],
      ['a code in a list', { expectedTenant: w.T, reasonCode: ['other'] }],
      ['an upper-case tenant', voidBody(w.T.toUpperCase(), 'other')],
      ['a tenant that is no uuid', voidBody('tenant', 'other')],
      ['an empty object', {}],
      ['an array', [valid]],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: w.mgr.principal }];
      const before = await counts([w.T], keys);
      const reply = await ctx.voidInvoice(s, w.S, victim.invoice, JSON.stringify(body), { key });
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'command_request_invalid', `${label}: the planner's refusal`);
      assert.deepEqual(delta(await counts([w.T], keys), before), LEASE_ONLY, `${label}: the lease acquired, nothing else`);
    }
    assert.deepEqual([await imageOf(victim.invoice), await voidRowOf(victim.invoice)], [image, null], 'the victim untouched, no void record');
    // (3) The 1 KiB bound and the media type, over raw sockets.
    const BOUND = 1024; // INVOICE_VOID_MAX_BODY_BYTES, pinned here as a literal
    const declared = await issueOne(ctx, s, w, 'ivh06 declared');
    const streamed = await issueOne(ctx, s, w, 'ivh06 chunked');
    const path = (id) => `/api/v1/stores/${w.S}/invoices/${id}/void`;
    const base = JSON.stringify(valid);
    const pad = (n) => `${base.slice(0, -1)}${' '.repeat(n - Buffer.byteLength(base))}}`;
    const atBound = pad(BOUND);
    const over = pad(BOUND + 1);
    assert.deepEqual([Buffer.byteLength(atBound), Buffer.byteLength(over)], [BOUND, BOUND + 1]);
    assert.deepEqual(JSON.parse(atBound), valid, 'the padded body is the plain void body');
    let key = randomUUID();
    let before = await counts([w.T], [{ key, principal: w.mgr.principal }]);
    voidedOf(await ctx.voidInvoice(s, w.S, declared.invoice, atBound, { key }), declared.invoice, '1,024 bytes declared');
    assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.mgr.principal }]), before), ONE_VOID);
    key = randomUUID();
    before = await counts([w.T], [{ key, principal: w.mgr.principal }]);
    voidedOf(await rawUnsafe(ctx, s, path(streamed.invoice), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(atBound, 256), key), streamed.invoice, '1,024 bytes chunked');
    assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.mgr.principal }]), before), ONE_VOID);
    for (const [label, request, status, error, reason] of [
      ['1,025 bytes declared', (k) => ctx.voidInvoice(s, w.S, victim.invoice, over, { key: k }), 413, 'content_too_large', 'body_declared_too_large'],
      ['1,025 bytes chunked', (k) => rawUnsafe(ctx, s, path(victim.invoice), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(over, 256), k), 413, 'content_too_large', 'body_streamed_too_large'],
      ['text/plain', (k) => ctx.voidInvoice(s, w.S, victim.invoice, base, { key: k, headers: { 'content-type': 'text/plain' } }), 415, 'unsupported_media_type', 'media_type_unsupported'],
      ['no Content-Type with a body', (k) => rawUnsafe(ctx, s, path(victim.invoice), `Content-Length: ${base.length}\r\n`, base, k), 415, 'unsupported_media_type', 'media_type_missing'],
    ]) {
      const k = randomUUID();
      const b0 = await counts([w.T], [{ key: k, principal: w.mgr.principal }]);
      const reply = await request(k);
      assertRefusal(reply, status, error, label);
      assert.equal(ctx.reason(reply), reason, `${label}: the logged reason`);
      assert.deepEqual(delta(await counts([w.T], [{ key: k, principal: w.mgr.principal }]), b0), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(k, w.mgr.principal), 0, `${label}: no idempotency record — no lease, no completion`);
    }
    // Control: the current tenant voids the victim.
    key = randomUUID();
    before = await counts([w.T], [{ key, principal: w.mgr.principal }]);
    voidedOf(await ctx.voidInvoice(s, w.S, victim.invoice, base, { key }), victim.invoice, 'control: the current tenant');
    assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.mgr.principal }]), before), ONE_VOID);
  });
});

// ===========================================================================
// IVH-07: two entries race one invoice
// ===========================================================================

test('IVH-07 (VOID-06 HTTP half, D-VOID-5; BRIEF §8 "Concurrency"): two tenant entries — two runtime pools on one database — void ONE invoice under two keys, ordered by an owner\'s hold of the issued header: the first waiter (holding the header\'s tuple lock, waiting on the holder) applies, the one queued behind it is the sealed 409 invalid_state, replayed under its key; exactly one void record (the first\'s actor), one void audit record, two completions; the invoice unchanged — in both orders', async () => {
  const w = await world('ivh07');
  await withEntry((a) => withEntry(async (b) => {
    await ready(a, w);
    const sa = await signIn(a, w.so);
    const sm = await signIn(b, w.mgr);
    const sends = {
      A: (id, key) => a.voidInvoice(sa, w.S, id, voidBody(w.T, 'duplicate'), { key }),
      B: (id, key) => b.voidInvoice(sm, w.S, id, voidBody(w.T, 'duplicate'), { key }),
    };
    const actors = { A: w.so, B: w.mgr };
    for (const [round, x, y] of [['(a) A first, B second', 'A', 'B'], ['(b) B first, A second', 'B', 'A']]) {
      const inv = await issueOne(a, sa, w, `ivh07 ${round}`);
      const yKey = randomUUID();
      const image = await imageOf(inv.invoice);
      const before = await counts([w.T]);
      const h = await holdIssuedHeader(inv.invoice);
      let px;
      let py;
      try {
        px = quietly(sends[x](inv.invoice, randomUUID()));
        const xPid = waitingPid(await blockedOrSettled(px, { by: h.pid, query: AT_VOID }), `${round}: ${x} waiting on the issued header`);
        await assertWaitsOnHeaderBehind(xPid, h.pid, `${round}: ${x}`);
        py = quietly(sends[y](inv.invoice, yKey));
        const yPid = waitingPid(await blockedOrSettled(py, { by: xPid, query: AT_VOID }), `${round}: ${y} queued behind ${x}`);
        await assertQueuedOnHeaderTuple(yPid, `${round}: ${y}`);
      } finally {
        await h.commit();
      }
      voidedOf(await replyTo(px, `${round}: ${x}`), inv.invoice, `${round}: ${x} applies`);
      sealedOf(await replyTo(py, `${round}: ${y}`), 'invalid_state', `${round}: ${y} is the sealed invalid_state`);
      sealedOf(await sends[y](inv.invoice, yKey), 'invalid_state', `${round}: ${y}'s 409 replays`, { replayed: true });
      assert.equal((await counts([w.T], [{ key: yKey, principal: actors[y].principal }])).K, 1, `${round}: ${y}'s sealed completion`);
      assert.deepEqual(delta(await counts([w.T]), before), { ...NOTHING, V: 1, VA: 1, AA: 1, C: 2 }, `${round}: one void record, ONE audit record, two completions`);
      assert.equal((await voidRowOf(inv.invoice)).voided_by, actors[x].id, `${round}: the void record names ${x}'s actor`);
      assert.deepEqual(await imageOf(inv.invoice), image, `${round}: the invoice unchanged`);
    }
  }));
});

// ===========================================================================
// IVH-08: atomicity
// ===========================================================================

test('IVH-08 (VOID-08 server half; BRIEF §8 "Failure"): a fault at the void record\'s INSERT, at the void\'s audit INSERT and at its completion is the 503 — no void record, no audit record, no completion, the invoice unchanged: nothing but the open lease; without a fault the same void commits', async (t) => {
  const w = await world('ivh08');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'ivh08');
    const image = await imageOf(x.invoice);
    for (const [label, table, event, when] of [
      ['the void record\'s INSERT raises', VOID_TABLE, 'insert', `new.invoice_id = '${x.invoice}'::uuid`],
      ['the void\'s audit INSERT raises', 'public.audit_event', 'insert', `new.action_id = '${VOID_ACTION}' and new.subject_issued_invoice_id = '${x.invoice}'::uuid`],
      ['the completion raises', 'tmpos_internal.idempotency_record', 'update', COMPLETION],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: w.mgr.principal }];
      const before = await counts([w.T], keys);
      const firedBefore = await fired();
      const reply = await withTrigger(table, event, when, 'raise', () => ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, 'other'), { key }));
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(ctx.reason(reply), 'transaction_unavailable', `${label}: the injected fault, rolled back — not a timeout`);
      evidence(t, { case: label, reason: ctx.reason(reply) });
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      assert.deepEqual(delta(await counts([w.T], keys), before), LEASE_ONLY, `${label}: nothing but the open lease`);
      assert.deepEqual([await imageOf(x.invoice), await voidRowOf(x.invoice)], [image, null], `${label}: the invoice as it was, no void record`);
      assert.equal(await leaseOpen(key, w.mgr.principal), true, `${label}: no completion`);
    }
    const key = randomUUID();
    const before = await counts([w.T], [{ key, principal: w.mgr.principal }]);
    voidedOf(await ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, 'other'), { key }), x.invoice, 'control: without a fault');
    assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.mgr.principal }]), before), ONE_VOID);
  });
});

// ===========================================================================
// IVH-09: the COMMIT acknowledgement
// ===========================================================================

test('IVH-09 (VOID-09 database part, D-VOID-5; BRIEF §8 "Unknown commit"): the COMMIT lands and its answer is lost — the 503 at the commit deadline (outcome unknown, never a claimed rollback), the void is there once, whole, and the same key replays the sealed 200; the COMMIT is cut — the 503, no void record or audit record, the 409 request_in_progress until the lease ends, then the explicit same-key retry voids once — each time the truth read back through the detail', async () => {
  const w = await world('ivh09');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const lost = await issueOne(ctx, s, w, 'ivh09 lost');
    const cut = await issueOne(ctx, s, w, 'ivh09 cut');
    const body = voidBody(w.T, 'issued_in_error');
    const trapped = async (mode, invoice, key, label) => {
      const trap = trapCommit(ctx.relay, mode, AUDIT_ANCHOR);
      let reply;
      const sentAt = Date.now();
      try { reply = await ctx.voidInvoice(s, w.S, invoice, body, { key }); } finally { trap.release(); }
      assert.equal(trap.hit.length, 1, `${label}: the trap engaged at exactly one COMMIT`);
      assertRefusal(reply, 503, 'service_unavailable', label);
      return { reply, elapsed: Date.now() - sentAt };
    };
    const statusOf = async (invoice) => JSON.parse((await ctx.invoice(s, w.S, invoice)).body).invoice.status;
    // (1) Landed, its answer lost.
    const key1 = randomUUID();
    const keys1 = [{ key: key1, principal: w.mgr.principal }];
    const before1 = await counts([w.T], keys1);
    const l = await trapped('lose', lost.invoice, key1, 'the lost answer');
    assert.equal(ctx.reason(l.reply), 'transaction_timeout', 'unknown at the commit deadline');
    assert.ok(l.elapsed >= COMMAND_TRANSACTION_DEADLINE_MS - 50, `answered at the commit's own deadline (${l.elapsed} ms)`);
    await until(async () => (await counts([w.T], keys1)).K === before1.K + 1, 'the landed void');
    assert.deepEqual(delta(await counts([w.T], keys1), before1), ONE_VOID, 'what committed is visible, whole');
    assert.equal(await statusOf(lost.invoice), 'voided', 'the detail reads it voided');
    voidedOf(await ctx.voidInvoice(s, w.S, lost.invoice, body, { key: key1 }), lost.invoice, 'the same-key retry', { replayed: true });
    assert.deepEqual(delta(await counts([w.T], keys1), before1), ONE_VOID, 'never a second void or audit record');
    // (2) Cut: the server rolls the void back.
    const key2 = randomUUID();
    const keys2 = [{ key: key2, principal: w.mgr.principal }];
    const image = await imageOf(cut.invoice);
    const before2 = await counts([w.T], keys2);
    await trapped('cut', cut.invoice, key2, 'the cut COMMIT');
    await headerFree(cut.invoice); // granted only once the cut transaction has ended
    assert.deepEqual(delta(await counts([w.T], keys2), before2), LEASE_ONLY, 'nothing landed: the lease alone');
    assert.deepEqual([await imageOf(cut.invoice), await voidRowOf(cut.invoice), await statusOf(cut.invoice)], [image, null, 'issued'], 'the invoice as it was, no void record, read back issued');
    assertRefusal(await ctx.voidInvoice(s, w.S, cut.invoice, body, { key: key2 }), 409, 'request_in_progress', 'the same key within the lease');
    await expireLease(key2, w.mgr.principal);
    voidedOf(await ctx.voidInvoice(s, w.S, cut.invoice, body, { key: key2 }), cut.invoice, 'after the lease: the explicit retry');
    assert.deepEqual(delta(await counts([w.T], keys2), before2), ONE_VOID, 'exactly one void');
    assert.equal(await statusOf(cut.invoice), 'voided');
  });
});

// ===========================================================================
// IVH-10: a change committed, or a sign-in gone stale, while the void waits
// ===========================================================================

test('IVH-10 (VOID-03 HTTP half, D-VOID-2, R-SEC-02, R-BR-11): two tenant entries; a manager voids on A while — (a) the real PUT /api/v1/roles/levels narrowing the manager to Invoices manage, and (b) narrowing Customers to none, holds key 530030 EXCLUSIVE (parked at its audit INSERT on a gate row the owner holds) and the void waits on that key SHARED: each the 503, rolled back, answered before the void\'s lock bound; (d) the sign-in passes its 10 minutes while the void waits on the owner\'s hold of the issued header — the routine\'s own check after its last wait, before its write (an owner fault armed at the void-record INSERT never fires): the 503; (e) the sign-in passes its 10 minutes while the void is parked at its void-record INSERT, AFTER the routine\'s check passed — the mutator\'s re-check on the database clock: the 503, rolled back; after each the same key from the stale session is the 403 step_up_required and from a fresh one the 409 request_in_progress; (c) a session revocation committed while the void waits at 016\'s hold: the 503 and then the 401; nothing but each void\'s open lease; then a new session voids (control)', async (t) => {
  const w = await world('ivh10');
  const mgr2 = await actor('ivh10-mgr2', [storeGrant(w.T, w.S, 'manager')]);
  await withEntry((a) => withEntry(async (b) => {
    await ready(b, w);
    const sm = await signIn(a, w.mgr);
    const x = await issueOne(a, sm, w, 'ivh10');
    const image = await imageOf(x.invoice);
    const body = voidBody(w.T, 'wrong_customer');
    /** One refused round under its own key: the reply, the invoice as it was, no void record, and the effects after. */
    const round = async (label, who, race) => {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([w.T], keys);
      const reply = await race(key);
      assert.deepEqual([await imageOf(x.invoice), await voidRowOf(x.invoice)], [image, null], `${label}: the invoice as it was (xmin included), no void record`);
      return { reply, key, delta: async () => delta(await counts([w.T], keys), before) };
    };
    /** After a refused round of `who`: the same key from the stale session, then from a fresh one; neither writes. */
    const retries = async (label, who, stale, key) => {
      const fresh = await signIn(a, who); // a sign-in writes its own session audit record: taken before the counts
      const after = await counts([w.T], [{ key, principal: who.principal }]);
      const r1 = await a.voidInvoice(stale, w.S, x.invoice, body, { key });
      assertRefusal(r1, 403, 'step_up_required', `${label}: the same key from the stale session`);
      assertRefusal(await a.voidInvoice(fresh, w.S, x.invoice, body, { key }), 409, 'request_in_progress', `${label}: the same key from a fresh sign-in, within the lease`);
      assert.deepEqual(delta(await counts([w.T], [{ key, principal: who.principal }]), after), NOTHING, `${label}: neither retry writes anything`);
    };

    // (a), (b): the narrowing holds key 530030 EXCLUSIVE, parked at its audit INSERT; the void then waits on the key.
    for (const [label, domain, level] of [['(a) an Invoices narrowing', 'invoices', 'manage'], ['(b) a Customers narrowing', 'customers', 'none']]) {
      const reviewed = await reviewedOf(b, w.sb, 'manager', domain);
      const narrow = { roleId: 'manager', domain, level, reason: described(`ivh10 ${label}`), expectedTenant: w.T, expectedVersion: reviewed };
      let put;
      const at = {};
      verdictOf(await a.voidEligibility(sm, w.S, x.invoice), `${label}: entry A warm before the gate`);
      const r = await round(label, w.mgr, (key) => withTrigger('public.audit_event', 'insert',
        `new.action_id = 'tenant.role.level.update' and new.tenant_id = '${w.T}'::uuid`, 'park', async () => {
          const gate = await holdGate();
          let pending;
          let narrowing;
          try {
            narrowing = quietly(b.levels(w.sb, narrow));
            const putPid = waitingPid(await blockedOrSettled(narrowing, { by: gate.pid }), `${label}: the narrowing parked at its audit INSERT`);
            const [{ n }] = await probe`select count(*)::int as n from pg_catalog.pg_locks l where l.pid = ${putPid} and l.granted
              and l.locktype = 'advisory' and l.classid = 530030 and l.objsubid = 2 and l.mode = 'ExclusiveLock'`;
            assert.equal(n, 1, `${label}: the narrowing holds key 530030 EXCLUSIVE`);
            at.sent = Date.now();
            pending = quietly(a.voidInvoice(sm, w.S, x.invoice, body, { key }));
            pending.then(() => { at.replied = Date.now(); }, () => {});
            const pid = waitingPid(await blockedOrSettled(pending, { by: putPid, query: AT_VOID }), `${label}: the void waiting on the key`);
            assert.deepEqual(await waitsOf(pid), [{ locktype: 'advisory', mode: 'ShareLock', xid: null, relation: null }], `${label}: the void waits on the advisory key, SHARED`);
            at.boundLeft = await lockBoundLeft(pid, label);
          } finally {
            await gate.commit();
          }
          put = await replyTo(narrowing, `${label}: the narrowing`);
          return replyTo(pending, `${label}: the void`);
        }));
      assert.equal(put.status, 200, `${label}: the narrowing commits: ${put.body}`);
      assert.deepEqual(JSON.parse(put.body), { roleLevel: { roleId: 'manager', domain, level, version: reviewed + 1 } }, `${label}: the PUT's own answer`);
      assertRefusal(r.reply, 503, 'service_unavailable', `${label}: the void refused by the re-read under the key`);
      assert.equal(a.reason(r.reply), 'transaction_unavailable', `${label}: rolled back, never a timeout`);
      evidence(t, { case: label, elapsedMs: at.replied - at.sent, boundLeftMs: at.boundLeft });
      assert.ok(at.boundLeft > RELEASE_MARGIN_MS, `${label}: released ${at.boundLeft} ms before the void's lock bound on the database clock`);
      assert.ok(at.replied - at.sent < COMMAND_LOCK_BOUND_MS, `${label}: answered ${at.replied - at.sent} ms after the send: before any lock, statement or deadline timeout`);
      assert.deepEqual(await r.delta(), { ...NOTHING, LE: 1, AA: 1, C: 1 }, `${label}: the void's open lease, and the narrowing's audit record and completion`);
      assert.equal(await leaseOpen(r.key, w.mgr.principal), true, `${label}: the void's lease open`);
      await putLevel(b, w.sb, w.T, 'manager', domain, 'full', `IVH-10 ${label} undone`);
    }

    // (d): the sign-in ages past its bound while the void waits on the OWNER's hold of the issued header.
    {
      const label = '(d) the sign-in goes stale while the void waits on the issued header';
      const timed = await timedSignIn(a, mgr2);
      const at = {};
      const firedBefore = await fired();
      // An owner fault armed at the void-record INSERT: it never fires, so the refusal came inside the routine before its
      // write (step 6) — never an 'applied' that the mutator's re-check then refused, which (e) proves.
      const r = await round(label, mgr2, (key) => withTrigger(VOID_TABLE, 'insert', `new.invoice_id = '${x.invoice}'::uuid`, 'raise', async () => {
        const h = await holdIssuedHeader(x.invoice);
        let pending;
        try {
          await delay(Math.max(0, timed.deadline - LAPSE.send - Date.now()));
          at.sent = Date.now();
          pending = quietly(a.voidInvoice(timed.s, w.S, x.invoice, body, { key }));
          pending.then(() => { at.replied = Date.now(); }, () => {});
          const pid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_VOID }), `${label}: the void waiting on the header`);
          at.waitingWhileFresh = await dbBefore(timed.deadline);
          await assertWaitsOnHeaderBehind(pid, h.pid, label);
          await delay(Math.max(0, timed.deadline + LAPSE.release - Date.now()));
          at.staleAtRelease = !(await dbBefore(timed.deadline));
        } finally {
          await h.commit();
        }
        return replyTo(pending, label);
      }));
      const timeline = `relative to the deadline: sent ${at.sent - timed.deadline} ms, answered ${at.replied - timed.deadline} ms`;
      assert.equal(await fired(), firedBefore, `${label}: the void-record INSERT never ran: the routine's step 6 refused before its write`);
      assert.ok(at.sent < timed.deadline, `${label}: sent while the sign-in was recent — ${timeline}`);
      assert.equal(at.waitingWhileFresh, true, `${label}: seen waiting before the deadline on the database clock — ${timeline}`);
      assert.equal(at.staleAtRelease, true, `${label}: the deadline had passed on the database clock before the release — ${timeline}`);
      assertRefusal(r.reply, 503, 'service_unavailable', `${label}: refused after the wait — ${timeline}`);
      assert.equal(a.reason(r.reply), 'transaction_unavailable', `${label}: rolled back, never a timeout`);
      assert.ok(at.replied - at.sent < COMMAND_LOCK_BOUND_MS, `${label}: answered before any lock bound could expire — ${timeline}`);
      assert.deepEqual(await r.delta(), LEASE_ONLY, `${label}: nothing but the open lease`);
      evidence(t, { case: label, sentMs: at.sent - timed.deadline, answeredMs: at.replied - timed.deadline });
      await retries(label, mgr2, timed.s, r.key);
    }

    // (e): the sign-in ages past its bound while the void is parked at its void-record INSERT — after the routine's own check.
    {
      const label = '(e) the sign-in goes stale while the void is parked at its void-record INSERT';
      const timed = await timedSignIn(a, mgr2);
      const at = {};
      const firedBefore = await fired();
      const r = await round(label, mgr2, (key) => withTrigger(VOID_TABLE, 'insert', `new.invoice_id = '${x.invoice}'::uuid`, 'park', async () => {
        const gate = await holdGate();
        let pending;
        try {
          await delay(Math.max(0, timed.deadline - LAPSE.send - Date.now()));
          at.sent = Date.now();
          pending = quietly(a.voidInvoice(timed.s, w.S, x.invoice, body, { key }));
          pending.then(() => { at.replied = Date.now(); }, () => {});
          waitingPid(await blockedOrSettled(pending, { by: gate.pid, query: AT_VOID }), `${label}: the void parked at its INSERT`);
          // Parked at the INSERT, so the routine's step-6 check already ran — and it ran before this instant.
          at.parkedWhileFresh = await dbBefore(timed.deadline);
          await delay(Math.max(0, timed.deadline + LAPSE.release - Date.now()));
          at.staleAtRelease = !(await dbBefore(timed.deadline));
        } finally {
          await gate.commit();
        }
        return replyTo(pending, label);
      }));
      const timeline = `relative to the deadline: sent ${at.sent - timed.deadline} ms, answered ${at.replied - timed.deadline} ms`;
      assert.equal(await fired(), firedBefore + 1, `${label}: the park ran: the routine reached its INSERT`);
      assert.ok(at.sent < timed.deadline, `${label}: sent while the sign-in was recent — ${timeline}`);
      assert.equal(at.parkedWhileFresh, true, `${label}: parked (the routine's own check passed) before the deadline on the database clock — ${timeline}`);
      assert.equal(at.staleAtRelease, true, `${label}: the deadline had passed on the database clock before the release — ${timeline}`);
      assertRefusal(r.reply, 503, 'service_unavailable', `${label}: refused by the mutator's re-check after the routine answered — ${timeline}`);
      assert.equal(a.reason(r.reply), 'transaction_unavailable', `${label}: rolled back, never a timeout`);
      assert.ok(at.replied - at.sent < COMMAND_LOCK_BOUND_MS, `${label}: answered before any lock bound could expire — ${timeline}`);
      assert.deepEqual(await r.delta(), LEASE_ONLY, `${label}: nothing but the open lease — no void record, no audit record, no completion`);
      evidence(t, { case: label, sentMs: at.sent - timed.deadline, answeredMs: at.replied - timed.deadline });
      await retries(label, mgr2, timed.s, r.key);
    }

    // (c): the OWNER holds the manager's account row (016's hold); the void waits there; the revocation commits meanwhile.
    {
      const label = '(c) a session revocation while the void waits at 016\'s hold';
      const at = {};
      const r = await round(label, w.mgr, async (key) => {
        const h = await hold('app_user for update', (sql) => sql`select 1 from public.app_user where internal_user_id = ${w.mgr.id} for update`);
        let pending;
        try {
          at.sent = Date.now();
          pending = quietly(a.voidInvoice(sm, w.S, x.invoice, body, { key }));
          pending.then(() => { at.replied = Date.now(); }, () => {});
          const pid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_HOLD }), `${label}: the void waiting at 016's hold`);
          assert.deepEqual((await waitsOf(pid)).map((l) => [l.locktype, l.mode]), [['transactionid', 'ShareLock']], `${label}: on the holder's transaction`);
          assert.deepEqual((await owner`select tmpos_session.m5_session_revoke(${sm.key}::text) as r`).map((row) => row.r), ['revoked'], `${label}: the revocation commits while the void waits`);
          at.boundLeft = await lockBoundLeft(pid, label);
        } finally {
          await h.settle();
        }
        return replyTo(pending, label);
      });
      assertRefusal(r.reply, 503, 'service_unavailable', `${label}: refused inside its transaction`);
      assert.equal(a.reason(r.reply), 'transaction_unavailable', `${label}: the revalidation refused: rolled back, never a timeout`);
      evidence(t, { case: label, elapsedMs: at.replied - at.sent, boundLeftMs: at.boundLeft });
      assert.ok(at.boundLeft > RELEASE_MARGIN_MS, `${label}: released ${at.boundLeft} ms before the void's lock bound`);
      assert.ok(at.replied - at.sent < COMMAND_LOCK_BOUND_MS, `${label}: answered ${at.replied - at.sent} ms after the send`);
      assert.deepEqual(await r.delta(), LEASE_ONLY, `${label}: nothing but the open lease`);
      assertRefusal(await a.voidEligibility(sm, w.S, x.invoice), 401, 'unauthenticated', `${label}: the revoked session is refused from now on`);
    }

    // Control: a new session voids, at the restored levels.
    const again = await signIn(a, w.mgr);
    const key = randomUUID();
    const before = await counts([w.T], [{ key, principal: w.mgr.principal }]);
    voidedOf(await a.voidInvoice(again, w.S, x.invoice, body, { key }), x.invoice, 'control: a new session voids');
    assert.deepEqual(delta(await counts([w.T], [{ key, principal: w.mgr.principal }]), before), ONE_VOID, 'control: one void');
  }));
});

// ===========================================================================
// IVH-11: a deadline and an outage
// ===========================================================================

test('IVH-11 (R-BR-07, VOID-08 server half; BRIEF §8 "Failure"): a void that cannot finish is the 503 with nothing but its lease — (a) the OWNER holds the issued header past the void\'s lock bound: answered at the bound, rolled back; (b) the runtime\'s database connection is cut as the void\'s call is sent (an outage mid-transaction): rolled back; (c) the server runs the void\'s call but its answer never arrives: the kernel\'s own commit deadline aborts with that statement in flight — the outcome-unknown 503 at the deadline, the kernel itself ending the transaction (before the server\'s idle bound could), rolled back — each time the invoice unchanged, the same key the 409 request_in_progress until its lease ends, then the retry voids once', async (t) => {
  const w = await world('ivh11');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const body = voidBody(w.T, 'other');
    for (const [label, reason] of [['(a) past the lock bound', 'transaction_unavailable'], ['(b) a cut connection', 'transaction_unavailable'],
      ['(c) the void\'s call unanswered past the commit deadline', 'transaction_timeout']]) {
      const x = await issueOne(ctx, s, w, `ivh11 ${label}`);
      const image = await imageOf(x.invoice);
      const key = randomUUID();
      const keys = [{ key, principal: w.mgr.principal }];
      const before = await counts([w.T], keys);
      let reply;
      const sentAt = Date.now();
      if (label.startsWith('(a)')) {
        const h = await holdIssuedHeader(x.invoice);
        try {
          const pending = quietly(ctx.voidInvoice(s, w.S, x.invoice, body, { key }));
          waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_VOID }), `${label}: the void waiting on the header`);
          reply = await replyTo(pending, label); // the hold stands until the void has answered
        } finally {
          await h.commit();
        }
        assert.ok(Date.now() - sentAt >= COMMAND_LOCK_BOUND_MS - 50, `${label}: answered at the bound (${Date.now() - sentAt} ms)`);
      } else if (label.startsWith('(b)')) {
        const trap = trapCut(ctx.relay, VOID_ANCHOR);
        try { reply = await ctx.voidInvoice(s, w.S, x.invoice, body, { key }); } finally { trap.release(); }
        assert.equal(trap.hit.length, 1, `${label}: the void's call was cut once`);
        await until(async () => (await probe`select count(*)::int as n from pg_catalog.pg_stat_activity
          where usename = ${RUNTIME_LOGIN} and state like 'idle in transaction%'`)[0].n === 0, `${label}: the cut transaction ended`);
      } else {
        // The server runs the call (the routine locks the header and writes its record, uncommitted) and goes idle in the
        // transaction; its answer never arrives, so the kernel's own deadline aborts with that statement still in flight.
        const trap = trapCut(ctx.relay, VOID_ANCHOR, 'silence');
        let elapsed;
        try {
          const pending = quietly(ctx.voidInvoice(s, w.S, x.invoice, body, { key }));
          let open;
          await until(async () => {
            [open] = await probe`select pid, (extract(epoch from state_change) * 1000)::float8 as since from pg_catalog.pg_stat_activity
              where usename = ${RUNTIME_LOGIN} and state = 'idle in transaction' and position(${VOID_ANCHOR.toString()} in query) > 0`;
            return open !== undefined;
          }, `${label}: the void's call answered by the server, its transaction open`);
          await assert.rejects(owner.begin((sql) => sql`select 1 from tmpos_invoice_issue.issued_invoice where invoice_id = ${x.invoice} for update nowait`),
            { code: '55P03' }, `${label}: the routine ran: the void's open transaction holds the issued header`);
          reply = await replyTo(pending, label);
          elapsed = Date.now() - sentAt;
          // Before the trap's release cuts anything: the kernel itself ended that session, and before the server's own
          // idle-in-transaction bound (twice the deadline) could have.
          await until(async () => (await probe`select count(*)::int as n from pg_catalog.pg_stat_activity where pid = ${open.pid}`)[0].n === 0,
            `${label}: the abandoned transaction's session ended by the kernel`);
          const [{ now }] = await probe`select (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::float8 as now`;
          assert.ok(now - open.since < 2 * COMMAND_TRANSACTION_DEADLINE_MS - RELEASE_MARGIN_MS,
            `${label}: ended ${Math.round(now - open.since)} ms after it went idle — the kernel's cancellation, not the server's idle bound`);
        } finally { trap.release(); }
        assert.deepEqual([trap.hit.length, trap.hit[0].silenced], [1, true], `${label}: the void's call silenced once, at its execution`);
        assert.ok(elapsed >= COMMAND_TRANSACTION_DEADLINE_MS - 50, `${label}: answered at the commit deadline (${elapsed} ms)`);
      }
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(ctx.reason(reply), reason, reason === 'transaction_timeout'
        ? `${label}: the deadline's outcome-unknown 503, never a claimed rollback`
        : `${label}: rolled back (known), never the unknown-outcome timeout`);
      evidence(t, { case: label, reason: ctx.reason(reply), elapsedMs: Date.now() - sentAt });
      assert.deepEqual(delta(await counts([w.T], keys), before), LEASE_ONLY, `${label}: nothing but the open lease`);
      assert.deepEqual([await imageOf(x.invoice), await voidRowOf(x.invoice)], [image, null], `${label}: the invoice as it was, no void record`);
      assertRefusal(await ctx.voidInvoice(s, w.S, x.invoice, body, { key }), 409, 'request_in_progress', `${label}: the same key within the lease`);
      await expireLease(key, w.mgr.principal);
      voidedOf(await ctx.voidInvoice(s, w.S, x.invoice, body, { key }), x.invoice, `${label}: after the lease, the retry`);
      assert.deepEqual(delta(await counts([w.T], keys), before), ONE_VOID, `${label}: exactly one void`);
    }
  });
});

// ===========================================================================
// IVH-11b: a database clock behind the invoice (F1 / T6, HTTP half)
// ===========================================================================

test('IVH-11b (VOID-14, R-M4, R-DB-6): an invoice whose issued_at is LATER than the database clock (a future-dated issued fixture: the OWNER sets it on a production-issued invoice with 034\'s row guard lifted inside one transaction and put back as found) cannot be voided — a fresh-sign-in manager passes every chain check and the routine\'s authority, the routine reaches its void INSERT (a counting owner trigger fires once) and 035\'s guard (voided_at not before issued_at) refuses it: the 503 service_unavailable with exactly { error, requestId } (transaction_unavailable: rolled back, never the unknown-outcome timeout) and nothing but the open lease — no completion, no void record, no audit record, no outbox row, the invoice as it was; with the fixture put back, the same key after its lease voids once', async () => {
  const w = await world('ivh11b');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'ivh11b');
    const [{ original }] = await owner`select issued_at::text as original from tmpos_invoice_issue.issued_invoice where invoice_id = ${x.invoice}`;
    /** The OWNER's write of the issued time, 034's row guard lifted for this one statement and put back in the mode it was found in. */
    const setIssuedAt = (set) => owner.begin('isolation level read committed', (sql) => withTriggersLifted(sql, [[ISSUED_TABLE, 'trg_issued_invoice_guard']], () => set(sql)));
    // An hour AFTER the database's own clock (read inside the owner transaction, never the test host's).
    await setIssuedAt((sql) => sql`update tmpos_invoice_issue.issued_invoice set issued_at = pg_catalog.clock_timestamp() + interval '1 hour' where invoice_id = ${x.invoice}`);
    const [{ ahead }] = await owner`select issued_at > pg_catalog.clock_timestamp() + interval '50 minutes' as ahead
      from tmpos_invoice_issue.issued_invoice where invoice_id = ${x.invoice}`;
    assert.equal(ahead, true, 'the fixture: issued about an hour AFTER the database clock');
    const [{ mode }] = await owner`select tgenabled as mode from pg_catalog.pg_trigger where tgrelid = ${ISSUED_TABLE}::regclass and tgname = 'trg_issued_invoice_guard'`;
    assert.equal(mode, 'A', '034\'s row guard is ALWAYS again');
    const image = await imageOf(x.invoice);
    const key = randomUUID();
    const keys = [{ key, principal: w.mgr.principal }];
    const before = await counts([w.T], keys);
    const firedBefore = await fired();
    const reply = await withTrigger(VOID_TABLE, 'insert', `new.invoice_id = '${x.invoice}'::uuid`, 'count', () => ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, 'other'), { key }));
    assert.equal(await fired(), firedBefore + 1, 'the routine got past every refusal and attempted its void INSERT exactly once: 035\'s guard is what refused');
    assertRefusal(reply, 503, 'service_unavailable', 'the void of a future-dated invoice');
    assert.equal(reply.body, JSON.stringify({ error: 'service_unavailable', requestId: reply.headers['x-request-id'] }), 'exactly { error, requestId }, in that order');
    assert.equal(ctx.reason(reply), 'transaction_unavailable', 'rolled back (known), never the unknown-outcome timeout');
    assert.deepEqual(delta(await counts([w.T], keys), before), LEASE_ONLY, 'nothing but the open lease: no completion, no void record, no audit record, no outbox row');
    assert.equal(await leaseOpen(key, w.mgr.principal), true, 'the lease is open: no completion');
    assert.deepEqual([await imageOf(x.invoice), await voidRowOf(x.invoice)], [image, null], 'the invoice as it was, no void record');
    // The fixture removed: the invoice carries its own issue time again, and the same key — once its lease ends — voids once.
    await setIssuedAt((sql) => sql`update tmpos_invoice_issue.issued_invoice set issued_at = ${original}::text::timestamptz where invoice_id = ${x.invoice}`);
    assert.deepEqual((await owner`select issued_at::text as at from tmpos_invoice_issue.issued_invoice where invoice_id = ${x.invoice}`)[0].at, original, 'the fixture is gone: the original issue time');
    assertRefusal(await ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, 'other'), { key }), 409, 'request_in_progress', 'the same key within the lease');
    await expireLease(key, w.mgr.principal);
    voidedOf(await ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, 'other'), { key }), x.invoice, 'control: with the fixture removed, the retry');
    assert.deepEqual(delta(await counts([w.T], keys), before), ONE_VOID, 'control: exactly one void — the refusal was the clock, nothing else');
  });
});

// ===========================================================================
// IVH-12: the issue after a void
// ===========================================================================

test('IVH-12 (VOID-15, D-VOID-1, D-VOID-6): after a void the issue is unchanged — its same-key replay is the recorded 201 byte for byte ("status":"issued", the same Location) with Idempotent-Replayed: true, writing nothing; a new key on its draft is the sealed invalid_state (no re-issue); the voided invoice keeps its number, snapshot and source draft; the correction is a fresh draft issued under the NEXT number, itself issued — the void reached no other invoice', async () => {
  const w = await world('ivh12');
  await withEntry(async (ctx) => {
    await ready(ctx, w);
    const s = await signIn(ctx, w.mgr);
    const x = await issueOne(ctx, s, w, 'ivh12');
    const detailBefore = (await ctx.invoice(s, w.S, x.invoice)).body;
    voidedOf(await ctx.voidInvoice(s, w.S, x.invoice, voidBody(w.T, 'wrong_lines_or_amounts')), x.invoice, 'the void');
    const issued = issueBody(w.T, 1, w.settingsVersion, 1);
    let before = await counts([w.T], [{ key: x.key, principal: w.mgr.principal }]);
    const replay = await ctx.issue(s, w.S, x.draft, issued, { key: x.key });
    issuedOf(replay, { draftId: x.draft, version: 2, store: w.S }, 'the issue\'s replay after the void', { replayed: true });
    assert.equal(replay.body, x.reply.body, 'the recorded 201, byte for byte ("status":"issued" is true of the issue)');
    assert.equal(replay.headers.location, x.reply.headers.location, 'the same Location');
    assert.deepEqual(delta(await counts([w.T], [{ key: x.key, principal: w.mgr.principal }]), before), NOTHING, 'the replay wrote nothing');
    before = await counts([w.T]);
    sealedOf(await ctx.issue(s, w.S, x.draft, issued), 'invalid_state', 'a new key on the voided invoice\'s draft: no re-issue');
    assert.deepEqual(delta(await counts([w.T]), before), { ...NOTHING, C: 1 }, 'its completion only: no invoice, number or audit record');
    const detail = JSON.parse((await ctx.invoice(s, w.S, x.invoice)).body).invoice;
    const { void: lifecycle, status, ...kept } = detail;
    const { status: statusBefore, ...keptBefore } = JSON.parse(detailBefore).invoice;
    assert.deepEqual([status, statusBefore, lifecycle.reasonCode], ['voided', 'issued', 'wrong_lines_or_amounts']);
    assert.deepEqual(kept, keptBefore, 'its number, snapshot and source draft as issued');
    const correction = await issueOne(ctx, s, w, 'ivh12 correction');
    const fresh = JSON.parse((await ctx.invoice(s, w.S, correction.invoice)).body).invoice;
    assert.deepEqual([detail.number, fresh.number, fresh.status, 'void' in fresh, await counterOf(w.S)], [1, 2, 'issued', false, '2'], 'the correction: the next number, issued');
  });
});

// ===========================================================================
// IVH-13: logs and containment (last)
// ===========================================================================

test('IVH-13 (VOID-13 server half, R-SEC-04): no log line of any entry carries a reason code (as a value), a reason label, the audit sentence or code, a session key, an Idempotency-Key, a body, seller, customer or line text or an id — nor does the server log of a cluster this file started; the shipping inventory is exactly the 31 routes, the void\'s eligibility then its command right after the issued detail', () => {
  const forbidden = [...SECRETS, ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)])];
  // The distinctive codes as substrings too; 'duplicate' and 'other' are common words, checked as whole values below.
  const reasonTexts = ['invoice_void_', 'Issued invoice voided', ...REASONS.map(([, label]) => label),
    ...REASONS.map(([code]) => code).filter((code) => code.includes('_'))];
  const codes = new Set(REASONS.map(([code]) => code));
  // F1 / T7 (R-SEC-04), ADDED beside the exact checks: the audit sentence in full for each of the six labels, and a KEYED pattern —
  // `reason`, `reasonCode` or `reason_code` (JSON key or bare, quoted or not, a quote JSON-escaped inside a string too) followed by `:` or `=` and any of the six codes,
  // bare or as the audit's invoice_void_<code> — which also catches 'duplicate' and 'other' in key=value text, where the exact
  // checks (a substring list that leaves those two common words out, and whole values of a JSON line) do not.
  const reasonSentences = REASONS.map(([, label]) => `Issued invoice voided. Reason: ${label}.`);
  const KEYED_REASON = new RegExp('(?<![A-Za-z0-9_])(?:reasonCode|reason_code|reason)(?![A-Za-z0-9_])(?:\\\\?["\'])?\\s*[:=]\\s*(?:\\\\?["\'])?'
    + `(?:invoice_void_)?(?:${[...codes].join('|')})(?![A-Za-z0-9_])`, 'i');
  assert.equal(new Set(reasonSentences).size, 6, 'six distinct audit sentences');
  // The matcher's own proof, on synthetic lines (never a product log): what the exact checks miss and the keyed one catches ...
  for (const line of ['reasonCode=duplicate', 'reason=other', 'retry reason: "duplicate" next', "reasonCode: 'other'", 'GET /x?reason=duplicate&y=1', 'REASONCODE=Duplicate']) {
    assert.throws(() => JSON.parse(line), `${line}: not a JSON line, so the whole-value check never sees it`);
    assert.deepEqual(reasonTexts.filter((text) => line.includes(text)), [], `${line}: the exact substring checks miss it`);
    assert.equal(KEYED_REASON.test(line), true, `${line}: the keyed pattern catches it`);
  }
  // ... in JSON and underscored forms the keyed pattern also catches, and benign lines it must let through.
  for (const line of ['{"reasonCode":"duplicate"}', '{"event":"x","reason": "other"}', '{\\"reasonCode\\":\\"duplicate\\"}', 'reasonCode=issued_in_error', 'reason_code=wrong_customer', 'reasonCode=invoice_void_other']) {
    assert.equal(KEYED_REASON.test(line), true, `${line}: the keyed pattern catches it`);
  }
  for (const line of ['{"event":"request","reason":"authz_denied","route":"other","status":403}', 'reason=transaction_not_found', 'reasonCode=otherwise', 'reason=duplicated',
    'unreason=other', 'reasonable=duplicate', 'route=other', 'duplicate=other', 'reason=other_thing',
    '{\\"event\\":\\"request\\",\\"reason\\":\\"authz_denied\\",\\"route\\":\\"other\\"}']) {
    assert.equal(KEYED_REASON.test(line), false, `${line}: a benign line passes`);
  }
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  const values = (v) => (Array.isArray(v) ? v.flatMap(values) : v !== null && typeof v === 'object' ? Object.values(v).flatMap(values) : [v]);
  for (const l of ALL_LOG_LINES) {
    for (const secret of forbidden) assert.ok(!l.includes(secret), `a log line carries a secret: ${secret.slice(0, 6)}...`);
    for (const text of reasonTexts) assert.ok(!l.includes(text), `a log line carries a void reason: ${text}`);
    for (const text of reasonSentences) assert.ok(!l.includes(text), `a log line carries a void audit sentence: ${text}`);
    assert.ok(!KEYED_REASON.test(l), 'a log line carries a keyed void reason (reason or reasonCode followed by a code)');
    let parsed = null;
    try { parsed = JSON.parse(l); } catch { /* a non-JSON line is checked as text above */ }
    if (parsed === null || typeof parsed !== 'object') continue;
    // `route` is the classifier's own word (app.ts classifyRoute): a literal known path, or 'other' for every templated one.
    const { route, ...rest } = parsed;
    assert.ok(route === undefined || route === 'other' || (typeof route === 'string' && route.startsWith('/') && !UUID_RE.test(route.slice(-36))), `a route class, never a path with an id: ${route}`);
    assert.deepEqual(values(rest).filter((v) => codes.has(v)), [], 'no log value is a reason code');
  }
  if (cluster !== null) {
    const text = readFileSync(`${cluster.root}/postgres.log`, 'utf8');
    assert.deepEqual(forbidden.filter((v) => text.includes(v)).map((v) => v.slice(0, 6)), [], 'the cluster\'s server log carries no secret');
    assert.deepEqual(reasonTexts.filter((v) => text.includes(v)), [], 'nor a void reason');
    assert.deepEqual(reasonSentences.filter((v) => text.includes(v)), [], 'nor a void audit sentence');
    assert.equal(KEYED_REASON.test(text), false, 'nor a keyed void reason');
  }
  assert.equal(TENANT_SHIPPING_ROUTES.length, 31, 'exactly the 31 shipping routes');
  const served = TENANT_SHIPPING_ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(served).size, 31, 'no route twice');
  const detail = served.indexOf('GET /api/v1/stores/{storeId}/invoices/{id}');
  assert.ok(detail >= 0, 'the issued detail is served');
  assert.deepEqual(served.slice(detail + 1, detail + 3), ['GET /api/v1/stores/{storeId}/invoices/{id}/void-eligibility', 'POST /api/v1/stores/{storeId}/invoices/{id}/void'],
    'the void\'s eligibility, then its command, right after the issued detail');
});
