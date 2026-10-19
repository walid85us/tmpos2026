// Phase 4.0 M7B-INVOICES-DISCARD-P1 — discarding a saved store invoice draft END TO END: the tenant entry
// (server/entry/tenantEntry.ts, startTenantEntry) serving POST /api/v1/stores/{storeId}/invoice-drafts/{id}/discard and GET
// …/{id}/discard-eligibility over REAL loopback HTTP and a disposable PostgreSQL holding every migration in the directory
// (001-035), composed exactly as server/entry/tenantMain.ts composes it but for its construction. The route module
// (server/runtime/invoiceDrafts.ts), the chain's suffix-aware command target (app.ts), the store-scope authorizer and
// revalidator, the tenant command transaction, the discard's mutator (server/persistence/postgresInvoiceDrafts.ts), migration
// 033's discard routine (tmpos_invoice_discard.m7b_invoice_draft_discard: the Invoices level decided at Manage, again under
// migration 030's advisory key, the state before the version) and its open-only reads (page_v2, get_v2), the audit writer
// (subject_invoice_draft_id) and the idempotency kernel are production's own code. Every draft is saved first through the
// production POST (migration 032's create_v3); the owner's level changes go through the production PUT /api/v1/roles/levels
// where a case says so, otherwise through the owner's own row write (a test-only lever).
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — tests/db/invoiceDraftEditHttp.integration.test.mjs's three, none on the path under
// test: the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime LOGIN,
// tmpos_iddh_probe, holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can drop a COMMIT's
// answer or the COMMIT itself), the identity verifier (a synthetic bearer-token map, whose authentication time a case may
// age) and the listener (127.0.0.1:0). Lease expiry is moved by the OWNER on the idempotency row, and faults and parking
// points are OWNER triggers (test-only levers).
//
// WHAT IS PROVEN (each title carries the DSC ids of docs/phase-4/11 §7 and the stage's AC ids it evidences; D/X/L/A/O/K are
// the drafts, DISCARDED drafts, lines, DISCARD audit records, draft outbox rows and sealed completions a case's own tenants
// and keys hold, AA/OO/C/LE every audit record, outbox row, completed idempotency record and open lease in the database — the
// cases run one at a time — all read by the OWNER as deltas; a draft's state is its header and ordered lines, xmin included).
//   IDDH-01 (DSC-01 AC-05 AC-07) a real discard at version 2: the 200 { draftId, version 3, status discarded }; ONE header
//           change (status and version, every other column and every line row as it was), ONE audit record, one completion,
//           NO outbox row; the bystanders untouched; a second entry's reopen is the 404 and its list omits it; the replay is
//           byte-identical and writes nothing.
//   IDDH-02 (DSC-02 AC-02 DSC-19) the Manage boundary on stored levels: the discard eligibility answers 200 exactly when the
//           POST is authorized — defaults (store_owner, manager allowed; technician, sales_staff refused), every stored
//           Invoices level of the manager (none..edit refused, manage..full allowed), a technician and a sales_staff raised to
//           Manage allowed and held at Edit refused; the owner's PUT setting the manager to Edit refuses it and to Manage
//           allows it again; a tenant-only grant reaches no store. Every refusal is the authorizer's 403 before any key.
//   IDDH-03 (AC-03) no Customers and no recent-sign-in prerequisite: a technician at Invoices Manage with Customers None, on a
//           session whose provider authentication is two hours old, discards.
//   IDDH-04 (DSC-03 AC-09) two entries: the owner's PUT on entry B lowers or raises the manager's Invoices level while the
//           discard on entry A waits — (a)-(d) on the draft header an owner holds (lowered from a stored Full and from the
//           default: the 503, nothing written, the lease open; raised Manage -> Full, and lowered to Edit then raised to Full
//           by two committed PUTs: the 200) and (e) for the role's KEY, which the PUT, parked at its completion, holds
//           EXCLUSIVE while the discard holds the header (lowered: the 503; raised: the 200).
//   IDDH-05 (DSC-04 AC-09) a read-only account, a read-only tenant and a read-only store are the chain's 403 before any key;
//           a grant suspension, a session revocation, a store made read_only and an Invoices narrowing to Edit committed while
//           the discard waits on 016's hold are the 503 transaction_unavailable, nothing written, the lease open.
//   IDDH-06 (DSC-05 AC-04) a missing draft, another store's and another tenant's: one status, one body shape, one logged
//           reason, only the requestId differs, nothing but the open lease; an expectedTenant that is not the store's is the
//           unsealed 409; a store the actor holds no grant at, another tenant's, a missing one and a non-canonical one are the
//           403 before any key; a malformed draft id is the 400 before any key; an unversioned one the planner's 400; another
//           suffix, an extra segment and another method are the terminal 404; one key at another draft is the 422; the
//           chain's own refusals write nothing.
//   IDDH-07 (DSC-06 AC-06) a stale and a future version: the sealed 409 write_conflict, its completion only, replayed byte for
//           byte; the current version then discards.
//   IDDH-08 (DSC-08 AC-08) two entries, two actors, ordered by an owner's hold of the header: two discards under different
//           keys are one 200 and one sealed 409 invalid_state with ONE audit record, both directions; an edit first makes the
//           discard the sealed 409 write_conflict, a discard first makes the edit the sealed 409 invalid_state.
//   IDDH-09 (DSC-09) one key: the same bytes replay (Idempotent-Replayed: true, byte-identical); another version, the same
//           value re-spaced, an edit's key, a save's key on the discard and the discard's key on an edit are each the 422,
//           writing nothing.
//   IDDH-10 (DSC-10 AC-06) a fresh key at a discarded draft is the sealed 409 invalid_state whatever version it names and
//           whoever asks — no second audit record, the header as it was — and replays; a stale editor's PATCH of it is the
//           sealed 409 invalid_state too.
//   IDDH-11 (DSC-11 AC-10) a fault at the audit INSERT, at the completion, at the header UPDATE and at a sealed conflict's
//           completion: the 503, the header and lines as they were, nothing recorded but the open lease.
//   IDDH-12 (DSC-12) a 503 leaves its lease: the same key is the 409 request_in_progress until the lease is expired, then
//           it plans again under the CURRENT authority (narrowed: the 403; restored: the 200, replayed) and the current
//           version (moved: the sealed 409 write_conflict).
//   IDDH-13 (DSC-13 AC-10) a lost COMMIT answer with the COMMIT landed (a discard, a sealed conflict, a sealed invalid_state):
//           the 503, then the same key replays what landed, the version stepped once; the COMMIT cut: the 503, nothing, the
//           409 until the lease ends, then one step.
//   IDDH-14 (DSC-15 AC-11) a discarded draft is absent from every list page and its reopen is the missing draft's 404 (shape
//           and logged reason); a cursor naming it still pages; every list answer is the 200, on a second entry too.
//   IDDH-15 (DSC-19) the discard eligibility is target-blind: the same bytes for an open, a missing, another store's,
//           another tenant's, a discarded and an unversioned id — answered while the OWNER holds the draft table ACCESS
//           EXCLUSIVE, which a reopen waits for; an Edit-level role and a read-only account are refused; a query, a malformed
//           id, no session, no session CSRF, another host and another method are refused; no-store throughout; nothing written.
//   IDDH-16 (DSC-24) the exact audit record: actor, tenant, store, the draft as subject, store.invoice_draft.discard,
//           discard_invoice_drafts, scope store, metadata {}, the command kernel's fixed fields, a database-stamped time
//           inside the request, and a server-generated correlation id that is neither the client's nor the response's.
//   IDDH-17 (DSC-25 AC-07) a sealed 200, a sealed conflict and a sealed invalid_state under three keys: after the owner's
//           PUT lowers the manager to Edit each same-key retry is the 403, a revoked session's the 401; after the PUT restores
//           Full each replays its retained bytes; that draft's rows, audit records and completions never move.
//   IDDH-19 (DSC-09; M7B-INVOICES-DISCARD-P1-R1) the 1 KiB body bound and the media type over real sockets, six subtests:
//           (A) a valid discard commits through Node's client and through the hand framing; (B) a declared length over the
//           bound is the 413 body_declared_too_large from the headers alone — with no body byte sent, with no session, with a
//           cross-site Origin, with neither CSRF header, with text/plain, from an actor below Invoices Manage; (C) a chunked
//           body with no Content-Length is read under the cap and past it is the 413 body_streamed_too_large — at the
//           crossing, on a stream never finished, counted in bytes (a multibyte body under 1,024 characters but over 1,024
//           bytes, never finished); after the session (none: the 401) and the authorizer (an actor below Invoices Manage: its
//           403), before the key (none or malformed: still the 413), a coding beside chunked the 400, Content-Length beside it
//           the parser's 400; (D) any type but application/json(;charset=utf-8) (with a cross-site Origin, with neither CSRF
//           header, from an actor below Invoices Manage too), two Content-Type lines, none with a body (no session either)
//           and any Content-Encoding are the 415; none and no body the 400 body_required; ;charset=UTF-8 and
//           "; charset=utf-8" commit; (E) exactly 1,024 bytes commits declared and chunked, 1,025 is the 413 both ways; (F) a
//           key refused at the bound stays fresh and then discards. Each app-layer refusal is { error, requestId } echoing
//           nothing (C6's 400 is Node's own parser's, with no app body), the target draft as it was, NOTHING written and no
//           idempotency record for its key; the request limiter's unit is spent and only recorded.
//   IDDH-18 (DSC-22) no log line carries a description, a customer, a draft, a tenant or store id, a session key, a CSRF
//           token or an Idempotency-Key — nor does the server log of a cluster this file started (run last).
//
// DETERMINISTIC WAITS ONLY: a request is known to wait by pg_stat_activity (a Lock wait, its blocker named) and pg_locks, or
// by an owner lock that can only be granted once its transaction ended; nothing sleeps for an outcome.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Synthetic data only, every id
// and key made at run time. Its discards leave DISCARDED drafts, which migration 033's down refuses (and drafts above version
// 1 and audit subjects, which 029's and 028's refuse): on a shared service it runs after every step that rolls 034, 033 or an
// older migration back, and before it finishes it removes every draft and line of its tenants — the two terminal triggers
// lifted inside ONE owner transaction and put back in the mode they were found in — with every Invoices role and version row
// of its tenants, clears every audit subject naming one of its drafts and deletes its tenants' draft events, its sessions,
// mint-ledger rows, idempotency records, proof schema and login, and restores the limiter fingerprint and issuer key row it
// found; then it checks that none is left and that the triggers are ALWAYS again.
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

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'iddh-migrator', runtimeRef: 'iddh-runtime' };
const LOCK_KEY = 529_534;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_iddh_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** The audit action and permission of a discard (the discard contract's kind and requirement), pinned here as literals. */
const ACTION = 'store.invoice_draft.discard';
const PERMISSION = 'discard_invoice_drafts';
const WAIT_MS = 10_000;
const SEND_TIMEOUT_MS = 20_000;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The revalidator's first lock: 016's hold of the actor's standing. */
const AT_HOLD = /m5_hold_tenant_standing/;
/** The discard routine's statement: where a discard waits for the draft header or for the role's key (migration 033). */
const AT_DISCARD = /tmpos_invoice_discard\.m7b_invoice_draft_discard\(/;
/** The edit routine's statement (migration 030's guarded v2). */
const AT_UPDATE = /tmpos_invoice_edit\.m7b_invoice_draft_update_v2\(/;
/** The reopen's statement (migration 033's open-only get). */
const AT_GET = /tmpos_invoice_discard\.m7b_invoice_draft_get_v2\(/;
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });
/** The completion: the one UPDATE of an idempotency record that seals its response. */
const COMPLETION = 'old.response is null and new.response is not null';
/** The advisory key the parking trigger waits on (the two-int space: never the migration lock's bigint one). */
const PARK = [529_534, 1];
/**
 * A command's lock waits are bounded (lock_timeout 70% of its 2 s transaction: 1400 ms): a request in flight longer than this
 * when its barrier was released may have been refused by a TIMEOUT, which would look like the refusal under test. Such a
 * case is INCONCLUSIVE — a failure, never a pass.
 */
const CONCLUSIVE_WINDOW_MS = 1_100;
assert.equal(IDEMPOTENCY_POLICY.leaseMs, 60_000, 'the idempotency lease the in-progress cases rely on');
assert.ok(COMMAND_TRANSACTION_DEADLINE_MS <= PORT_DEADLINE_MS);
assert.ok(PORT_DEADLINE_MS * 4 <= SEND_TIMEOUT_MS);
assert.ok(CONCLUSIVE_WINDOW_MS < Math.floor(COMMAND_TRANSACTION_DEADLINE_MS * 0.7), 'the window is inside a command\'s lock timeout');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('IDDH');
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
/** Migration 033's terminal guards: a discarded draft admits no delete, nor do its lines, while they are enabled. */
const TERMINAL_TRIGGERS = [['tmpos_invoice_draft.invoice_draft', 'trg_invoice_draft_terminal'], ['tmpos_invoice_draft.invoice_draft_line', 'trg_invoice_draft_line_terminal']];

/**
 * Every draft (open and discarded), line, Invoices role and version row of this suite's tenants, and every audit subject naming
 * one of its drafts — in ONE owner transaction, the append-only and the two terminal triggers lifted only inside it.
 */
async function cleanDrafts() {
  if (TENANTS.length === 0) return;
  await owner.begin('isolation level read committed', async (sql) => {
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    if (drafts.length > 0) {
      await withTriggersLifted(sql, AUDIT_TRIGGER, () => sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`);
      await withTriggersLifted(sql, TERMINAL_TRIGGERS, async () => {
        await sql`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = any(${drafts}::uuid[])`;
        await sql`delete from tmpos_invoice_draft.invoice_draft where draft_id = any(${drafts}::uuid[])`;
      });
    }
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const open of [...OPEN]) await step(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
    await step(() => owner.unsafe('drop schema if exists iddh_proof cascade'));
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
    // The events this suite's saves and edits enqueued (a discard enqueues none): no worker exists, so they would otherwise
    // sit pending forever.
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
        (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]) and status <> 'draft')::int as discarded,
        (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[]))::int as lines,
        (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
        (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors,
        (select count(*) from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[]))::int as versions,
        (select pg_catalog.string_agg(g.tgname::text || ':' || g.tgenabled::text, ',' order by g.tgname) from pg_catalog.pg_trigger g
          where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and not g.tgisinternal) as triggers`;
      assert.deepEqual({ ...state }, {
        drafts: 0, discarded: 0, lines: 0, subjects: 0, anchors: 0, versions: 0,
        triggers: 'trg_invoice_draft_immutable:A,trg_invoice_draft_line_terminal:A,trg_invoice_draft_terminal:A',
      }, 'nothing of this suite blocks 033\'s, 029\'s or 028\'s rollback, and the terminal triggers are ALWAYS again');
    });
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IDDH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'IDDH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster; a trap may drop a COMMIT's answer, or the COMMIT itself
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket' ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) } : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-iddh-relay-'));
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
/** An applied discard's anchor: its audit INSERT (only an applied discard writes one). */
const AUDIT_ANCHOR = Buffer.from('insert into public.audit_event');
/** A sealed 409's anchor (it writes no audit record): the command's completion call. */
const COMPLETION_ANCHOR = Buffer.from('tmpos_internal.m6_idempotency_complete');
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
  const [{ applied }] = await owner`select count(*)::int as applied from public.schema_migrations where version in ('029', '030', '031', '032', '033', '034')`;
  assert.equal(applied, 6, 'migrations 029-034 are applied: the guarded edit and save, the discard with its open-only reads, and issuing (034, whose terminal-trigger function this suite\'s discards run through)');
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
  await owner.unsafe('drop schema if exists iddh_proof cascade');
  await owner.unsafe('create schema iddh_proof');
  await owner.unsafe('revoke all on schema iddh_proof from public');
  await owner.unsafe('create sequence iddh_proof.fired');
});

// ---------------------------------------------------------------------------
// identity, configuration, requests
// ---------------------------------------------------------------------------

/** token -> { uid, authTimeSec? }: the provider's authentication time is now unless a case dates it (IDDH-03). */
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
    type: 'service_account', project_id: 'iddh-test-project', client_email: 'iddh-test@iddh-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
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
// fixtures — all written through the owner, every draft saved through the production POST
// ---------------------------------------------------------------------------

async function newTenant(label, status = 'active') {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`iddh-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
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
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IDDH ${label} ${SUFFIX}`})`;
  SECRETS.add(id);
  return id;
}
async function actor(label, memberships, status = 'active') {
  const uid = `iddh-${label}-${SUFFIX}`;
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
const setLevel = (tenant, role, domain, level, sql = owner) => sql`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;
/** A description no other run shares, registered as a log canary. */
function described(label) {
  const text = `IDDH ${label} ${SUFFIX}`;
  SECRETS.add(text);
  return text;
}
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const saveBody = (tenant, customer, lines) => ({ expectedTenant: tenant, customerId: customer, currency: 'USD', lines });
const editBody = (tenant, version, customer, lines) => ({ expectedTenant: tenant, expectedVersion: version, customerId: customer, lines });
const discardBody = (tenant, version) => ({ expectedTenant: tenant, expectedVersion: version });

/**
 * What a case's tenants hold now — drafts, DISCARDED drafts, lines, DISCARD audit records, draft outbox rows (any type) — the
 * sealed completions of its keys, and, across the whole database (the suite's cases run one at a time), EVERY audit record
 * (AA), every outbox row (OO), every completed idempotency record (C) and every open lease (LE): a refusal that "writes
 * nothing" may not write those either, and a discard may write no outbox row anywhere.
 */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as d,
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]) and status = 'discarded')::int as x,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as l,
    (select count(*) from public.audit_event where action_id = ${ACTION} and tenant_id = any(${tenants}::uuid[]))::int as a,
    (select count(*) from tmpos_internal.outbox_event where payload ->> 'storeId' in (select store_id::text from public.store where tenant_id = any(${tenants}::uuid[])))::int as o,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from public.audit_event)::int as aa,
    (select count(*) from tmpos_internal.outbox_event)::int as oo,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as c,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as le`;
  return { D: r.d, X: r.x, L: r.l, A: r.a, O: r.o, K: r.k, AA: r.aa, OO: r.oo, C: r.c, LE: r.le };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const NOTHING = Object.freeze({ D: 0, X: 0, L: 0, A: 0, O: 0, K: 0, AA: 0, OO: 0, C: 0, LE: 0 });
/** A rolled-back answer: nothing but the lease its key acquired in its own transaction, left open. */
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
/** A sealed answer: its completion only. */
const COMPLETION_ONLY = Object.freeze({ ...NOTHING, K: 1, C: 1 });
/** One applied discard under a key: one header discarded, one discard audit record, one completion — and NO outbox row. */
const ONE_DISCARD = Object.freeze({ ...NOTHING, X: 1, A: 1, K: 1, AA: 1, C: 1 });
/** A draft's header and ordered lines as the OWNER reads them — every column, and each row version (xmin). */
async function stateOf(draft) {
  const [header] = await owner`select draft_id, tenant_id, store_id, customer_id, status, currency, version::text as version, line_count,
    subtotal_cents::text as subtotal_cents, created_at::text as created_at, created_by, xmin::text as xmin
    from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`;
  const lines = await owner`select position, description, quantity::text as quantity, unit_price_cents::text as unit_price_cents,
    line_total_cents::text as line_total_cents, xmin::text as xmin from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft} order by position`;
  return { header: header === undefined ? null : { ...header }, lines: lines.map((l) => ({ ...l })) };
}
/** The idempotency record of `key` is still an open lease (nothing completed it). */
async function leaseOpen(key, principal) {
  const [row] = await owner`select response is null as open from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`;
  return row?.open === true;
}
/** How many idempotency records `key` owns (0: refused before any key was acquired). */
const recordsOf = async (key, principal) => (await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principal)}`)[0].n;
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
    // `from`: the entry's loopback source address (the limiter's subject), for IDDH-19's hand-framed requests.
    relay, port, from, lines, stop,
    read: (s, path, headers = {}) => send(port, 'GET', path,
      { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers }, undefined, { localAddress: from }),
    get: (s, store, id) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/${id}`),
    list: (s, store, query = '') => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts${query}`),
    discardEligibility: (s, store, id, { query = '', headers = {} } = {}) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/${id}/discard-eligibility${query}`, headers),
    save: (s, store, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', `/api/v1/stores/${store}/invoice-drafts`, body, key, headers),
    patch: (s, store, id, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'PATCH', `/api/v1/stores/${store}/invoice-drafts/${id}`, body, key, headers),
    discard: (s, store, id, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', `/api/v1/stores/${store}/invoice-drafts/${id}/discard`, body, key, headers),
    /** An unsafe request at any path (the trailing-path cases). */
    unsafe: (s, method, path, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, method, path, body, key, headers),
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
/** Save a draft through the production POST; its id. */
async function seed(ctx, s, store, tenant, customer, lines, { key } = {}) {
  const reply = await ctx.save(s, store, saveBody(tenant, customer, lines), key === undefined ? {} : { key });
  assert.equal(reply.status, 201, `the seed save: ${reply.body}`);
  const id = JSON.parse(reply.body).draft.id;
  SECRETS.add(id);
  return id;
}
/** A discard's 200: exactly { draftId, version, status: 'discarded' }. */
function discardedOf(reply, { draftId, version }, label, { replayed = false } = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify({ draftId, version, status: 'discarded' }), `${label}: the exact sealed body`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assert.equal(reply.headers.location, undefined, `${label}: no Location`);
  assertBaseline(reply, label);
}
/** An edit's 200: exactly { draftId, version, changed }. */
function editedOf(reply, { draftId, version, changed }, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify({ draftId, version, changed }), `${label}: the exact sealed body`);
}
/** A sealed 409: exactly { "error": word }, no correlator. */
function sealedOf(reply, word, label, { replayed = false } = {}) {
  assert.equal(reply.status, 409, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify({ error: word }), `${label}: the exact sealed body`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
/** A list page: exactly { drafts, nextCursor }, the drafts' ids in order. */
function pageOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assertBaseline(reply, label);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['drafts', 'nextCursor'], label);
  return { ids: body.drafts.map((d) => d.id), statuses: [...new Set(body.drafts.map((d) => d.status))], nextCursor: body.nextCursor };
}
/** An eligibility answer as its verdict: the exact closed 200 is 'allowed', the chain's 403 'forbidden'; anything else fails. */
function verdictOf(reply, label) {
  assertBaseline(reply, label);
  if (reply.status === 200) {
    assert.equal(reply.body, '{"eligibility":"allowed"}', `${label}: exactly the closed positive body`);
    return 'allowed';
  }
  assertRefusal(reply, 403, 'forbidden', label);
  return 'forbidden';
}
/** The version the owner reviews for `role`'s Invoices level (GET /api/v1/roles/levels/invoices). */
async function reviewedOf(ctx, s, role) {
  const read = await ctx.read(s, '/api/v1/roles/levels/invoices');
  assert.equal(read.status, 200, `the owner reads the Invoices levels: ${read.body}`);
  return Number(JSON.parse(read.body).roles.find((r) => r.roleId === role).version);
}
/** The owner's PUT of `role`'s Invoices level, asserted as its own 200 at version + 1; that next version. */
async function putLevel(ctx, s, tenant, role, level, version, label, { key = randomUUID() } = {}) {
  const reply = await replyTo(ctx.levels(s, { roleId: role, domain: 'invoices', level, reason: described(`${label} to ${level}`), expectedTenant: tenant, expectedVersion: version }, { key }),
    `${label}: the owner's PUT to ${level}`);
  assert.equal(reply.status, 200, `${label}: the owner's PUT to ${level}: ${reply.body}`);
  assert.deepEqual(JSON.parse(reply.body), { roleLevel: { roleId: role, domain: 'invoices', level, version: version + 1 } }, `${label}: the PUT's own answer`);
  return version + 1;
}

// ---------------------------------------------------------------------------
// levers (the edit suite's)
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
const holdAccount = (who) => hold('app_user for update', (sql) => sql`select 1 from public.app_user where internal_user_id = ${who.id} for update`);
const holdHeader = (draft) => hold('draft header for update', (sql) => sql`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${draft} for update`);
const holdPark = () => hold('the parking key', (sql) => sql`select pg_catalog.pg_advisory_xact_lock(${PARK[0]}::int, ${PARK[1]}::int)`);
function ownerWrite(label, fn) {
  const started = deferred();
  const done = owner.begin(async (sql) => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    started.resolve({ pid });
    await fn(sql);
  }).then(() => 'committed', (e) => `failed:${e?.message ?? e}`);
  const write = { label, done, started: Promise.race([started.promise, done.then((v) => ({ early: v }))]) };
  OPEN.add(write);
  done.then(() => OPEN.delete(write));
  return write;
}
/** Wait until an owner write settles or waits on a Lock: { settled } | { blocked, blockers } | null (bound). */
async function ownerOutcome(write) {
  const s = await write.started;
  if ('early' in s) return { settled: s.early };
  let settled = null;
  write.done.then((v) => { settled = v; });
  for (const until = Date.now() + WAIT_MS; Date.now() < until; await tick()) {
    if (settled !== null) return { settled };
    const [row] = await probe`select wait_event_type, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = ${s.pid}`;
    if (settled !== null) return { settled };
    if (row?.wait_event_type === 'Lock') return { blocked: true, blockers: row.blockers };
  }
  return null;
}
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
/**
 * The OWNER takes `draft`'s header FOR UPDATE: granted only once no transaction holds or waits ahead on it — so a cut
 * discard's transaction has ended (rolled back) when this returns. Bounded by the lock timeout, never a sleep.
 */
async function headerFree(draft) {
  await owner.begin(async (sql) => {
    await sql`select pg_catalog.set_config('lock_timeout', ${`${WAIT_MS}ms`}, true)`;
    await sql`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${draft} for update`;
  });
}
/** Whether an OWNER's FOR UPDATE NOWAIT on `draft`'s header is refused (55P03): some transaction holds it. */
async function headerLocked(draft) {
  try {
    await owner.begin(async (sql) => { await sql`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${draft} for update nowait`; });
    return false;
  } catch (err) {
    if (err?.code === '55P03') return true;
    throw err;
  }
}
const TRIGGER_ACTIONS = Object.freeze({
  raise: `raise exception 'IDDH injected fault' using errcode = 'P0001';`,
  park: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); return coalesce(new, old);`,
});
/**
 * `work` runs with ONE owner trigger BEFORE `event` (insert | update | delete) on `table` for each row matching `when`: it
 * counts itself on iddh_proof.fired (a sequence, so the count survives the rollback it causes), then raises or parks on PARK.
 * Dropped, with its function, whatever `work` did.
 */
async function withTrigger(table, event, when, action, work) {
  await owner.unsafe(`create function iddh_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('iddh_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function iddh_proof.fire() from public');
  await owner.unsafe(`create trigger iddh_fire before ${event} on ${table} for each row when (${when}) execute function iddh_proof.fire()`);
  try { return await work(); } finally {
    await owner.unsafe(`drop trigger if exists iddh_fire on ${table}`);
    await owner.unsafe('drop function if exists iddh_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('iddh_proof.fired'::regclass), 0)::int as n`)[0].n;
const DRAFT_TABLE = 'tmpos_invoice_draft.invoice_draft';
/** The locks `pid` waits for (pg_locks, ungranted): locktype, mode, the transaction id or the relation. */
const waitsOf = async (pid) => (await probe`select l.locktype, l.mode, l.transactionid::text as xid, l.relation::regclass::text as relation
  from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted`).map((r) => ({ ...r }));
/** The guard key of (tenant, role) as the database computes it (migration 030): hashtext of 'tenant/role', an int4. */
const guardKey = async (tenant, role) => (await probe`select pg_catalog.hashtext(${tenant}::text || '/' || ${role}::text) as k`)[0].k;
/** The advisory locks of the guard's class (530030, objsubid 2) `pid` holds or waits for: key (int4), mode, granted. */
const guardLocksOf = async (pid) => (await probe`select l.objid::int as key, l.objsubid::int as sub, l.mode::text as mode, l.granted
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' and l.classid::int = 530030 order by 1, 3, 4`).map((r) => ({ ...r }));
/** The guard lock a discard holds or waits for (ShareLock) or a level writer holds or waits for (ExclusiveLock) on (tenant, role). */
const guardLock = async (tenant, role, mode, granted = true) => ({ key: await guardKey(tenant, role), sub: 2, mode, granted });
/** The transaction id `pid` holds (it has written or row-locked something). */
const xidOf = async (pid) => (await probe`select backend_xid::text as xid from pg_catalog.pg_stat_activity where pid = ${pid}`)[0]?.xid ?? null;
/** The granted locks `pid` holds on `relation` of `locktype` and `mode`. */
const holds = async (pid, relation, locktype, mode) => (await probe`select count(*)::int as n from pg_catalog.pg_locks l
  where l.pid = ${pid} and l.granted and l.locktype = ${locktype} and l.mode = ${mode} and l.relation = ${relation}::regclass`)[0].n;
/**
 * `waiter` waits for the header row lock `holder` holds: the first waiter holds the header's tuple lock and waits for the
 * holder's transaction (an ungranted ShareLock on its xid) — never a lock elsewhere (016's hold, a role row, an advisory key).
 */
async function assertWaitsOnHeaderBehind(waiter, holder, label) {
  const xid = await xidOf(holder);
  assert.ok(xid !== null, `${label}: the holder has a transaction id`);
  assert.deepEqual(await waitsOf(waiter), [{ locktype: 'transactionid', mode: 'ShareLock', xid, relation: null }], `${label}: waits for exactly the holder's transaction`);
  assert.equal(await holds(waiter, DRAFT_TABLE, 'tuple', 'AccessExclusiveLock'), 1, `${label}: holding the draft header's tuple lock (FOR UPDATE)`);
}
/** `waiter` is queued for the draft header's tuple lock (behind the first waiter, which holds it). */
async function assertQueuedOnHeaderTuple(waiter, label) {
  assert.deepEqual(await waitsOf(waiter), [{ locktype: 'tuple', mode: 'AccessExclusiveLock', xid: null, relation: DRAFT_TABLE }], `${label}: queued for the header's tuple lock`);
}
/** Ends `key`'s lease now (the OWNER's lever on the idempotency row: the runtime has no such control). */
const expireLease = (key, principal) => owner`update tmpos_internal.idempotency_record set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where scope = ${scopeOf(key, principal)} and response is null`;
/** No guard lock of the class stands anywhere (every holder's transaction ended). */
const guardLocksStanding = async () => (await probe`select count(*)::int as n from pg_catalog.pg_locks where locktype = 'advisory' and classid::int = 530030`)[0].n;

// ===========================================================================
// IDDH-01: a real discard, end to end
// ===========================================================================

test('IDDH-01 (DSC-01 AC-05 AC-07): a manager discards a draft at version 2 — the 200 { draftId, version 3, status discarded }; one header change (status and version only, every line row as it was), ONE audit record, one completion, NO outbox row; the bystanders untouched; a second entry\'s reopen is the 404 and its list omits it; the replay is byte-identical and writes nothing', async () => {
  const T = await newTenant('iddh01');
  const S = await newStore(T, 'IDDH01 store');
  const S2 = await newStore(T, 'IDDH01 other store');
  const C = await newCustomer(T, 'iddh01');
  const who = await actor('iddh01', [storeGrant(T, S, 'manager'), storeGrant(T, S2, 'manager')]);
  await withEntry((a) => withEntry(async (b) => {
    const s = await signIn(a, who);
    const sb = await signIn(b, who);
    const id = await seed(a, s, S, T, C, [line(described('one'), 2, 50), line(described('two'), 1, 7)]);
    // To version 2 first, so that the step the discard takes is visibly expectedVersion + 1, never "to 2".
    editedOf(await a.patch(s, S, id, editBody(T, 1, C, [line(described('one'), 2, 50), line(described('three'), 3, 3)])), { draftId: id, version: 2, changed: true }, 'the edit to version 2');
    // Bystanders: another draft of the same store and one of the actor's other store — a discard touches exactly its own row.
    const sibling = await seed(a, s, S, T, C, [line(described('sibling'), 1, 1)]);
    const elsewhere = await seed(a, s, S2, T, C, [line(described('elsewhere'), 2, 2)]);
    const bystanders = await Promise.all([sibling, elsewhere].map(stateOf));
    const original = await stateOf(id);
    assert.deepEqual([original.header.status, original.header.version], ['draft', '2']);
    const outboxOfDraft = async () => (await owner`select count(*)::int as n from tmpos_internal.outbox_event where aggregate_id = ${id}`)[0].n;
    const eventsBefore = await outboxOfDraft();
    assert.equal(verdictOf(await a.discardEligibility(s, S, id), 'the discard eligibility'), 'allowed');
    const key = randomUUID();
    const keys = [{ key, principal: who.principal }];
    const before = await counts([T], keys);
    const reply = await a.discard(s, S, id, discardBody(T, 2), { key });
    discardedOf(reply, { draftId: id, version: 3 }, 'the discard');
    assert.deepEqual(delta(await counts([T], keys), before), ONE_DISCARD, 'one header discarded, one audit record, one completion, no outbox row, no lease');
    assert.equal(await outboxOfDraft(), eventsBefore, 'no outbox row of any type for the draft (D-DIS-4)');
    const after = await stateOf(id);
    assert.deepEqual([after.header.status, after.header.version], ['discarded', '3'], 'the terminal state at expectedVersion + 1');
    assert.notEqual(after.header.xmin, original.header.xmin, 'the header row was written');
    for (const column of ['draft_id', 'tenant_id', 'store_id', 'customer_id', 'currency', 'line_count', 'subtotal_cents', 'created_at', 'created_by']) {
      assert.equal(after.header[column], original.header[column], `${column} unchanged`);
    }
    assert.deepEqual(after.lines, original.lines, 'every line row as it was, its xmin included: nothing deleted, nothing rewritten');
    assert.deepEqual(await Promise.all([sibling, elsewhere].map(stateOf)), bystanders, 'the bystanders untouched: header, lines and their xmin');
    // Read on the SECOND entry, its own session: the database's answer alone.
    const gone = await b.get(sb, S, id);
    assertRefusal(gone, 404, 'not_found', 'the discarded draft reopened on the second entry');
    assert.equal(b.reason(gone), 'invoice_draft_not_found', 'the missing draft\'s own reason');
    assert.deepEqual(pageOf(await b.list(sb, S), 'the list on the second entry').ids, [sibling], 'the list omits it, the sibling stays');
    // The same key and bytes replay the sealed 200, byte for byte, writing nothing (AC-07).
    const again = await a.discard(s, S, id, discardBody(T, 2), { key });
    discardedOf(again, { draftId: id, version: 3 }, 'the retry', { replayed: true });
    assert.equal(again.body, reply.body, 'the first 200, byte for byte');
    assert.deepEqual(delta(await counts([T], keys), before), ONE_DISCARD, 'the retry wrote nothing: still one audit record');
    assert.deepEqual(await stateOf(id), after, 'the replay touched no row');
  }));
});

// ===========================================================================
// IDDH-02: the Manage boundary on stored levels
// ===========================================================================

test('IDDH-02 (DSC-02 AC-02 DSC-19): the discard eligibility answers 200 exactly when the POST is authorized — defaults (store_owner, manager allowed; technician, sales_staff refused), every stored Invoices level of the manager (none..edit refused, manage..full allowed), technician and sales_staff at Edit refused and at Manage allowed; the owner\'s PUT setting the manager to Edit refuses it, to Manage allows it; a tenant-only grant reaches no store; every refusal the authorizer\'s 403 before any key', async () => {
  const T = await newTenant('iddh02');
  const S = await newStore(T, 'IDDH02 store');
  const C = await newCustomer(T, 'iddh02');
  const ownerActor = await actor('iddh02-owner', [storeGrant(T, S, 'store_owner')]);
  const roles = {};
  for (const role of ['manager', 'technician', 'sales_staff']) roles[role] = await actor(`iddh02-${role}`, [storeGrant(T, S, role)]);
  const boss = await actor('iddh02-boss', [tenantGrant(T, 'store_owner')]);
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, ownerActor);
    const sessions = { store_owner: so };
    for (const [role, who] of Object.entries(roles)) sessions[role] = await signIn(ctx, who);
    const principals = { store_owner: ownerActor.principal, ...Object.fromEntries(Object.entries(roles).map(([r, w]) => [r, w.principal])) };
    /** A fresh draft (saved by the store owner); the eligibility, then the POST it predicts. */
    const decide = async (role, label) => {
      const id = await seed(ctx, so, S, T, C, [line(described(`authority ${label}`), 1, 1)]);
      const s = sessions[role];
      const verdict = verdictOf(await ctx.discardEligibility(s, S, id), `${label}: the discard eligibility`);
      const key = randomUUID();
      const keys = [{ key, principal: principals[role] }];
      const state = await stateOf(id);
      const before = await counts([T], keys);
      const reply = await ctx.discard(s, S, id, discardBody(T, 1), { key });
      if (verdict === 'allowed') {
        discardedOf(reply, { draftId: id, version: 2 }, `${label}: the POST`);
        assert.deepEqual(delta(await counts([T], keys), before), ONE_DISCARD, label);
      } else {
        assertRefusal(reply, 403, 'forbidden', `${label}: the POST`);
        assert.equal(ctx.reason(reply), 'authz_denied', `${label}: the authorizer's own refusal`);
        assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: nothing written`);
        assert.equal(await recordsOf(key, principals[role]), 0, `${label}: refused before any key was acquired`);
        assert.deepEqual(await stateOf(id), state, `${label}: the draft untouched`);
      }
      return verdict;
    };
    // Built-in defaults: the owner (fixed Full) and the manager (default Full) discard; technician (View), sales staff (Create) not.
    assert.deepEqual({
      store_owner: await decide('store_owner', 'store_owner (fixed Full)'), manager: await decide('manager', 'manager at its default'),
      technician: await decide('technician', 'technician at its default'), sales_staff: await decide('sales_staff', 'sales_staff at its default'),
    }, { store_owner: 'allowed', manager: 'allowed', technician: 'forbidden', sales_staff: 'forbidden' });
    // Every stored Invoices level of the manager: Edit alone does not discard; Manage, Approve and Full do.
    const manager = {};
    for (const level of ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full']) {
      await setLevel(T, 'manager', 'invoices', level);
      manager[level] = await decide('manager', `manager at Invoices ${level}`);
    }
    assert.deepEqual(manager, { none: 'forbidden', view: 'forbidden', create: 'forbidden', edit: 'forbidden', manage: 'allowed', approve: 'allowed', full: 'allowed' });
    // The stored level decides, never the role's name.
    for (const role of ['technician', 'sales_staff']) {
      await setLevel(T, role, 'invoices', 'edit');
      assert.equal(await decide(role, `${role} at Invoices edit`), 'forbidden');
      await setLevel(T, role, 'invoices', 'manage');
      assert.equal(await decide(role, `${role} raised to Invoices manage`), 'allowed');
    }
    // The owner's own PUT through the production chain: the manager at Edit is refused, at Manage allowed again.
    const sb = await signIn(ctx, boss);
    let version = await reviewedOf(ctx, sb, 'manager');
    version = await putLevel(ctx, sb, T, 'manager', 'edit', version, 'IDDH-02');
    assert.equal(await decide('manager', 'manager set to Edit by the owner\'s PUT'), 'forbidden');
    await putLevel(ctx, sb, T, 'manager', 'manage', version, 'IDDH-02');
    assert.equal(await decide('manager', 'manager set to Manage by the owner\'s PUT'), 'allowed');
    // A tenant-only owner grant reaches no store (no inheritance): both refused, no key.
    const id = await seed(ctx, so, S, T, C, [line(described('tenant only'), 1, 1)]);
    const key = randomUUID();
    assertRefusal(await ctx.discardEligibility(sb, S, id), 403, 'forbidden', 'a tenant-only grant: the discard eligibility');
    assertRefusal(await ctx.discard(sb, S, id, discardBody(T, 1), { key }), 403, 'forbidden', 'a tenant-only grant: the POST');
    assert.equal(await recordsOf(key, boss.principal), 0, 'a tenant-only grant: no key acquired');
  });
});

// ===========================================================================
// IDDH-03: no Customers and no recent-sign-in prerequisite
// ===========================================================================

test('IDDH-03 (AC-03): a technician the owner set to Invoices Manage and Customers None discards on an ordinary session whose provider authentication is two hours old — no Customers level and no recent sign-in are asked', async () => {
  const T = await newTenant('iddh03');
  const S = await newStore(T, 'IDDH03 store');
  const C = await newCustomer(T, 'iddh03');
  const ownerActor = await actor('iddh03-owner', [storeGrant(T, S, 'store_owner')]);
  const who = await actor('iddh03-tech', [storeGrant(T, S, 'technician')]);
  await setLevel(T, 'technician', 'invoices', 'manage');
  await setLevel(T, 'technician', 'customers', 'none');
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, ownerActor);
    const id = await seed(ctx, so, S, T, C, [line(described('no prerequisite'), 1, 1)]);
    // The provider authenticated this actor two hours ago: far past the recent-sign-in bound of a step-up route.
    const authTimeSec = Math.floor((Date.now() - 2 * 3_600_000) / 1000);
    const aged = `${who.token}-aged`;
    TOKENS.set(aged, { uid: who.uid, authTimeSec });
    SECRETS.add(aged);
    const s = await signIn(ctx, who, { token: aged });
    const [{ authenticated_at: bound }] = await owner`select authenticated_at from tmpos_session.session where session_key = ${s.key}`;
    assert.equal(Number(bound), authTimeSec * 1000, 'the session binds the provider\'s two-hour-old authentication time');
    assert.ok(Date.now() - Number(bound) > RECENT_AUTH_MAX_AGE_MS, 'older than any recent-sign-in bound');
    assert.deepEqual(withoutXmin((await invoicesRowsOf(T)).roles), [
      { role_id: 'technician', domain: 'customers', level: 'none' }, { role_id: 'technician', domain: 'invoices', level: 'manage' },
    ], 'Customers None and Invoices Manage, as stored');
    assert.equal(verdictOf(await ctx.discardEligibility(s, S, id), 'the eligibility'), 'allowed');
    const key = randomUUID();
    const keys = [{ key, principal: who.principal }];
    const before = await counts([T], keys);
    discardedOf(await ctx.discard(s, S, id, discardBody(T, 1), { key }), { draftId: id, version: 2 }, 'the discard without either prerequisite');
    assert.deepEqual(delta(await counts([T], keys), before), ONE_DISCARD);
  });
});

// ===========================================================================
// IDDH-04: the owner's PUT while a discard waits
// ===========================================================================

/**
 * (a)-(d): the discard on entry A waits on the draft header an owner holds — past every unlocked decision (the authorizer's
 * and the revalidator's reads, the routine's unlocked pre-check) and before the role's key — while the owner's PUT(s) on
 * entry B commit; released, the routine takes the key and decides the level again.
 */
async function levelChangedWhileWaitingOnHeader(st, { a, b, name, stored, levels, expected }) {
  const tag = randomUUID().slice(0, 6);
  const T = await newTenant(`iddh04-${tag}`);
  const S = await newStore(T, `IDDH04 ${tag}`);
  const C = await newCustomer(T, `iddh04-${tag}`);
  const storeOwner = await actor(`iddh04-so-${tag}`, [storeGrant(T, S, 'store_owner')]);
  const manager = await actor(`iddh04-mgr-${tag}`, [storeGrant(T, S, 'manager')]);
  const boss = await actor(`iddh04-boss-${tag}`, [tenantGrant(T, 'store_owner')]);
  if (stored !== null) await setLevel(T, 'manager', 'invoices', stored);
  const so = await signIn(a, storeOwner);
  const sm = await signIn(a, manager);
  const sb = await signIn(b, boss);
  const id = await seed(a, so, S, T, C, [line(described(`iddh04 ${tag}`), 1, 1)]);
  // The owner is signed in on entry B, its pool warmed and the version it reviews read, BEFORE the discard starts to wait.
  let version = await reviewedOf(b, sb, 'manager');
  const state = await stateOf(id);
  const key = randomUUID();
  const keys = [{ key, principal: manager.principal }];
  const before = await counts([T], keys);
  const h = await holdHeader(id);
  let pending;
  let mid;
  let rolesAfterPut;
  const clock = {};
  try {
    clock.sent = Date.now();
    pending = quietly(a.discard(sm, S, id, discardBody(T, 1), { key }));
    const pid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_DISCARD }), `${name}: the discard waiting on the draft header`);
    await assertWaitsOnHeaderBehind(pid, h.pid, name);
    assert.deepEqual(await guardLocksOf(pid), [], `${name}: waiting on the header, it holds no key yet`);
    assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${name}: parked on the header, the discard holds its lease only`);
    for (const level of levels) version = await putLevel(b, sb, T, 'manager', level, version, name);
    rolesAfterPut = await invoicesRowsOf(T);
    assert.deepEqual(withoutXmin(rolesAfterPut.roles), [{ role_id: 'manager', domain: 'invoices', level: levels[levels.length - 1] }], `${name}: the PUTs' role row`);
    mid = await counts([T], keys);
    assert.equal((await blockedNow({ by: h.pid, query: AT_DISCARD })).length, 1, `${name}: the discard still waits after the PUTs committed`);
    clock.released = Date.now();
  } finally {
    await h.commit();
  }
  const reply = await replyTo(pending, name);
  const after = await counts([T], keys);
  const reason = (() => { try { return a.reason(reply); } catch (err) { return `unread: ${err.message}`; } })();
  evidence(st, { case: `IDDH-04 ${name}`, answer: { status: reply.status, body: reply.body, reason }, msSentToRelease: clock.released - clock.sent, deltaSinceMid: delta(after, mid) });
  assert.ok(clock.released - clock.sent < CONCLUSIVE_WINDOW_MS,
    `INCONCLUSIVE: ${name}: the discard was in flight ${clock.released - clock.sent} ms when the header was released (limit ${CONCLUSIVE_WINDOW_MS} ms)`);
  if (expected === 503) {
    assertRefusal(reply, 503, 'service_unavailable', `${name}: refused inside the transaction, not sealed`);
    assert.equal(reason, 'transaction_unavailable', `${name}: the routine's refusal, never a timeout`);
    assert.deepEqual(delta(after, mid), NOTHING, `${name}: nothing written since the PUT committed`);
    assert.equal(await leaseOpen(key, manager.principal), true, `${name}: the lease open`);
    assert.deepEqual(await stateOf(id), state, `${name}: the draft untouched (xmin included)`);
  } else {
    discardedOf(reply, { draftId: id, version: 2 }, `${name}: applied under the level decided after the wait`);
    assert.deepEqual(delta(after, mid), { ...NOTHING, X: 1, A: 1, K: 1, AA: 1, C: 1, LE: -1 }, `${name}: its own discard, audit record and completion`);
  }
  assert.deepEqual(await invoicesRowsOf(T), rolesAfterPut, `${name}: the role and version rows exactly as the PUTs wrote them — the discard made none`);
}

/**
 * (e): the owner's PUT on entry B, parked at its own completion, holds the manager's key EXCLUSIVE (its level write took it
 * through migration 030's trigger); the discard on entry A passes every unlocked decision, takes the header and waits for
 * that key; released, the PUT commits and the discard decides the level under the key.
 */
async function levelChangedWhileWaitingOnKey(st, { a, b, name, level, expected }) {
  const tag = randomUUID().slice(0, 6);
  const T = await newTenant(`iddh04e-${tag}`);
  const S = await newStore(T, `IDDH04e ${tag}`);
  const C = await newCustomer(T, `iddh04e-${tag}`);
  const storeOwner = await actor(`iddh04e-so-${tag}`, [storeGrant(T, S, 'store_owner')]);
  const manager = await actor(`iddh04e-mgr-${tag}`, [storeGrant(T, S, 'manager')]);
  const boss = await actor(`iddh04e-boss-${tag}`, [tenantGrant(T, 'store_owner')]);
  await setLevel(T, 'manager', 'invoices', 'manage');
  const so = await signIn(a, storeOwner);
  const sm = await signIn(a, manager);
  const sb = await signIn(b, boss);
  const id = await seed(a, so, S, T, C, [line(described(`iddh04e ${tag}`), 1, 1)]);
  const reviewed = await reviewedOf(b, sb, 'manager');
  const putKey = randomUUID();
  const putBody = { roleId: 'manager', domain: 'invoices', level, reason: described(`iddh04e ${tag} to ${level}`), expectedTenant: T, expectedVersion: reviewed };
  const state = await stateOf(id);
  const key = randomUUID();
  const keys = [{ key, principal: manager.principal }];
  const before = await counts([T], keys);
  let put;
  let pending;
  let putReply;
  let reply;
  const clock = {};
  await withTrigger('tmpos_internal.idempotency_record', 'update', `${COMPLETION} and new.scope = '${scopeOf(putKey, boss.principal)}'`, 'park', async () => {
    const lever = await holdPark();
    try {
      clock.putSent = Date.now();
      put = quietly(b.levels(sb, putBody, { key: putKey }));
      const putPid = waitingPid(await blockedOrSettled(put, { by: lever.pid }), `${name}: the owner's PUT parked at its completion`);
      assert.deepEqual(await guardLocksOf(putPid), [await guardLock(T, 'manager', 'ExclusiveLock')], `${name}: the parked PUT holds the manager's key EXCLUSIVE`);
      clock.sent = Date.now();
      pending = quietly(a.discard(sm, S, id, discardBody(T, 1), { key }));
      const pid = waitingPid(await blockedOrSettled(pending, { by: putPid, query: AT_DISCARD }), `${name}: the discard waiting for the key behind the PUT`);
      assert.deepEqual((await waitsOf(pid)).map((w) => w.locktype), ['advisory'], `${name}: it waits for an advisory lock — nothing else`);
      assert.deepEqual(await guardLocksOf(pid), [await guardLock(T, 'manager', 'ShareLock', false)], `${name}: the manager's key, SHARED, ungranted`);
      assert.equal(await headerLocked(id), true, `${name}: it took the draft header before the key`);
      assert.deepEqual(delta(await counts([T], keys), before), { ...LEASE_ONLY, LE: 2 }, `${name}: waiting, the discard holds its lease only (beside the parked PUT's own)`);
      clock.released = Date.now();
    } finally {
      await lever.commit();
    }
    // Both answers are awaited INSIDE the trigger's scope: its DROP (ACCESS EXCLUSIVE on the idempotency table) must not queue
    // between a lease check and a completion.
    putReply = await replyTo(put, `${name}: the owner's PUT`);
    reply = await replyTo(pending, `${name}: the discard`);
  });
  const reason = (() => { try { return a.reason(reply); } catch (err) { return `unread: ${err.message}`; } })();
  evidence(st, { case: `IDDH-04 ${name}`, answer: { status: reply.status, body: reply.body, reason }, msPutSentToRelease: clock.released - clock.putSent, msSentToRelease: clock.released - clock.sent });
  assert.ok(clock.released - clock.putSent < CONCLUSIVE_WINDOW_MS,
    `INCONCLUSIVE: ${name}: ${clock.released - clock.putSent} ms from the PUT's send to the release (limit ${CONCLUSIVE_WINDOW_MS} ms): a wait could have timed out`);
  assert.equal(putReply.status, 200, `${name}: the PUT commits first: ${putReply.body}`);
  assert.deepEqual(JSON.parse(putReply.body), { roleLevel: { roleId: 'manager', domain: 'invoices', level, version: reviewed + 1 } }, `${name}: the PUT's own answer`);
  if (expected === 503) {
    assertRefusal(reply, 503, 'service_unavailable', `${name}: refused under the key`);
    assert.equal(reason, 'transaction_unavailable', `${name}: the routine's refusal, never a timeout`);
    assert.equal(await leaseOpen(key, manager.principal), true, `${name}: the lease open`);
    assert.deepEqual(await stateOf(id), state, `${name}: the draft untouched`);
    assert.deepEqual(delta(await counts([T], keys), before), { ...LEASE_ONLY, AA: 1, C: 1 }, `${name}: the discard wrote nothing but its lease (the PUT's own audit record and completion aside)`);
  } else {
    discardedOf(reply, { draftId: id, version: 2 }, `${name}: applied under the raised level`);
    assert.deepEqual(delta(await counts([T], keys), before), { ...ONE_DISCARD, AA: 2, C: 2 }, `${name}: one discard (the PUT's own audit record and completion aside)`);
  }
  assert.equal(await guardLocksStanding(), 0, `${name}: no guard lock stands`);
}

test('IDDH-04 (DSC-03 AC-09): two tenant entries — the owner\'s PUT lowers or raises the manager\'s Invoices level while a discard waits: on the draft header (lowered from a stored Full or from the default to Edit: the 503, nothing written, the lease open; raised Manage -> Full, or lowered to Edit and raised to Full by two committed PUTs: the 200) and for the role\'s key held EXCLUSIVE by the parked PUT (lowered: the 503; raised: the 200)', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    for (const [name, stored, levels, expected] of [
      ['(a) a stored Full lowered to Edit, waiting on the header', 'full', ['edit'], 503],
      ['(b) the default lowered to Edit (the PUT\'s first row), waiting on the header', null, ['edit'], 503],
      ['(c) a stored Manage raised to Full, waiting on the header', 'manage', ['full'], 200],
      ['(d) a stored Manage lowered to Edit and raised to Full by two committed PUTs, waiting on the header', 'manage', ['edit', 'full'], 200],
    ]) {
      await t.test(name, (st) => levelChangedWhileWaitingOnHeader(st, { a, b, name, stored, levels, expected }));
    }
    for (const [name, level, expected] of [
      ['(e1) Manage lowered to Edit by a PUT parked holding the key', 'edit', 503],
      ['(e2) Manage raised to Full by a PUT parked holding the key', 'full', 200],
    ]) {
      await t.test(name, (st) => levelChangedWhileWaitingOnKey(st, { a, b, name, level, expected }));
    }
  }));
});

// ===========================================================================
// IDDH-05: read-only standing and revocations
// ===========================================================================

test('IDDH-05 (DSC-04 AC-09): a read-only account, a read-only tenant and a read-only store are the chain\'s 403 before any key; a grant suspension, a session revocation, a store made read_only and an Invoices narrowing to Edit committed while the discard waits on 016\'s hold are the 503 transaction_unavailable, nothing written, the lease open', async () => {
  const one = async (statement, what) => assert.equal((await statement).count, 1, `${what}: exactly one row changed`);
  await withEntry(async (ctx) => {
    // (a) read-only at the chain: the read_only rule caps a read-only actor at View, so the Manage permission is denied.
    {
      const T = await newTenant('iddh05-a');
      const S = await newStore(T, 'IDDH05 a');
      const C = await newCustomer(T, 'iddh05-a');
      const ownerActor = await actor('iddh05-a-owner', [storeGrant(T, S, 'store_owner')]);
      const roAccount = await actor('iddh05-a-ro', [storeGrant(T, S, 'store_owner')], 'read_only');
      const so = await signIn(ctx, ownerActor);
      const id = await seed(ctx, so, S, T, C, [line(described('read only'), 1, 1)]);
      const state = await stateOf(id);
      for (const [label, who, change, restore] of [
        ['a read-only account', roAccount, null, null],
        ['a read-only tenant', ownerActor, () => one(owner`update tenant set status = 'read_only' where tenant_id = ${T}`, 'the tenant'), () => owner`update tenant set status = 'active' where tenant_id = ${T}`],
        ['a read-only store', ownerActor, () => one(owner`update store set status = 'read_only' where store_id = ${S}`, 'the store'), () => owner`update store set status = 'active' where store_id = ${S}`],
      ]) {
        if (change !== null) await change();
        try {
          // A session established after the change.
          const s = await signIn(ctx, who);
          assertRefusal(await ctx.discardEligibility(s, S, id), 403, 'forbidden', `${label}: the eligibility`);
          const key = randomUUID();
          const keys = [{ key, principal: who.principal }];
          const before = await counts([T], keys);
          const reply = await ctx.discard(s, S, id, discardBody(T, 1), { key });
          assertRefusal(reply, 403, 'forbidden', `${label}: the POST`);
          assert.equal(ctx.reason(reply), 'authz_denied', `${label}: the authorizer's refusal`);
          assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: nothing written`);
          assert.equal(await recordsOf(key, who.principal), 0, `${label}: no key acquired`);
        } finally {
          if (restore !== null) await restore();
        }
      }
      assert.deepEqual(await stateOf(id), state, 'the draft untouched');
    }
    // (b) committed while the discard waits on 016's hold: the revalidator re-reads and refuses inside the transaction.
    for (const [label, change, next] of [
      ['the grant suspended first', (f) => (sql) => one(sql`update user_membership set status = 'suspended' where internal_user_id = ${f.who.id}`, 'the grant suspended'), [401, 'unauthenticated']],
      ['the session revoked first', (f) => (sql) => sql`select tmpos_session.m5_session_revoke(${f.s.key}::text)`, [401, 'unauthenticated']],
      ['the store made read_only first', (f) => (sql) => one(sql`update store set status = 'read_only' where store_id = ${f.S}`, 'the store made read_only'), [401, 'unauthenticated']],
      ['Invoices narrowed to Edit first', (f) => (sql) => setLevel(f.T, 'manager', 'invoices', 'edit', sql), [403, 'forbidden']],
    ]) {
      const tag = randomUUID().slice(0, 6);
      const T = await newTenant(`iddh05-b-${tag}`);
      const S = await newStore(T, `IDDH05 b ${tag}`);
      const C = await newCustomer(T, `iddh05-b-${tag}`);
      const who = await actor(`iddh05-b-${tag}`, [storeGrant(T, S, 'manager')]);
      const s = await signIn(ctx, who);
      const id = await seed(ctx, s, S, T, C, [line(described(`hold seed ${label}`), 1, 1)]);
      const state = await stateOf(id);
      const f = { T, S, who, s };
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      const h = await holdAccount(who);
      let pending;
      let mid;
      try {
        pending = quietly(ctx.discard(s, S, id, discardBody(T, 1), { key }));
        waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_HOLD }), `${label}: the discard waiting on 016's hold`);
        assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: parked, the discard holds its lease only`);
        const outcome = await ownerOutcome(ownerWrite(label, change(f)));
        assert.equal(outcome?.settled, 'committed', `${label}: the change commits while the discard waits (${JSON.stringify(outcome)})`);
        mid = await counts([T], keys);
      } finally {
        await h.commit();
      }
      const reply = await replyTo(pending, label);
      assertRefusal(reply, 503, 'service_unavailable', `${label}: refused inside the transaction`);
      assert.equal(ctx.reason(reply), 'transaction_unavailable', `${label}: refused, never a timeout`);
      assert.deepEqual(delta(await counts([T], keys), mid), NOTHING, `${label}: the discard wrote nothing`);
      assert.deepEqual(await stateOf(id), state, `${label}: the draft untouched`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease open`);
      assertRefusal(await ctx.discard(s, S, id, discardBody(T, 1)), next[0], next[1], `${label}: the next request`);
    }
  });
});

// ===========================================================================
// IDDH-06: not found, never enumerating; scope and target binding
// ===========================================================================

test('IDDH-06 (DSC-05 AC-04): a missing draft, another store\'s and another tenant\'s are one 404 — one body shape, one logged reason, only the requestId differs — writing nothing but the open lease; an expectedTenant not the store\'s is the unsealed 409; a store without a grant, another tenant\'s, a missing and a non-canonical one are the 403 before any key; a malformed id the 400 before any key, an unversioned one the planner\'s 400; another suffix, an extra segment and another method the terminal 404; one key at another draft the 422; the chain\'s refusals write nothing', async () => {
  const T = await newTenant('iddh06');
  const T2 = await newTenant('iddh06-other');
  const S = await newStore(T, 'IDDH06 store');
  const S2 = await newStore(T, 'IDDH06 second store');
  const S3 = await newStore(T, 'IDDH06 ungranted store');
  const X = await newStore(T2, 'IDDH06 foreign store');
  const C = await newCustomer(T, 'iddh06');
  const C2 = await newCustomer(T2, 'iddh06-foreign');
  const who = await actor('iddh06', [storeGrant(T, S, 'manager'), storeGrant(T, S2, 'manager')]);
  const foreign = await actor('iddh06-foreign', [storeGrant(T2, X, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const other = await signIn(ctx, who);
    const sf = await signIn(ctx, foreign);
    const id = await seed(ctx, s, S, T, C, [line(described('nf mine'), 1, 1)]);
    const id2 = await seed(ctx, s, S, T, C, [line(described('nf mine two'), 1, 1)]);
    const elsewhere = await seed(ctx, s, S2, T, C, [line(described('nf other store'), 1, 1)]);
    const theirs = await seed(ctx, sf, X, T2, C2, [line(described('nf other tenant'), 1, 1)]);
    const drafts = [id, id2, elsewhere, theirs];
    const states = await Promise.all(drafts.map(stateOf));
    // (1) Not found: one answer for all three.
    const answers = [];
    for (const [label, draft] of [['a missing draft', randomUUID()], ['another store\'s draft (the actor\'s own other store)', elsewhere], ['another tenant\'s draft', theirs]]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T, T2], keys);
      const reply = await ctx.discard(s, S, draft, discardBody(T, 1), { key });
      assertRefusal(reply, 404, 'not_found', label);
      answers.push({ status: reply.status, error: JSON.parse(reply.body).error, bytes: Buffer.byteLength(reply.body), reason: ctx.reason(reply), requestId: JSON.parse(reply.body).requestId });
      assert.deepEqual(delta(await counts([T, T2], keys), before), LEASE_ONLY, `${label}: nothing written but the open lease`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: rolled back, the lease open`);
      assertRefusal(await ctx.discard(s, S, draft, discardBody(T, 1), { key }), 409, 'request_in_progress', `${label}: the retry within the lease`);
    }
    assert.deepEqual(new Set(answers.map(({ requestId, ...rest }) => JSON.stringify(rest))).size, 1, `one status, body shape, length and reason for all three: ${JSON.stringify(answers)}`);
    assert.equal(answers[0].reason, 'transaction_not_found');
    assert.equal(new Set(answers.map((x) => x.requestId)).size, 3, 'only the requestId differs');
    // (2) The precondition: another tenant, or one that does not exist, is the unsealed 409 in the chain's shape.
    for (const [label, expected] of [['another tenant', T2], ['a tenant that does not exist', randomUUID()]]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T, T2], keys);
      const reply = await ctx.discard(s, S, id, discardBody(expected, 1), { key });
      assertRefusal(reply, 409, 'write_conflict', `${label}: the precondition`);
      assert.equal(ctx.reason(reply), 'transaction_precondition_failed', label);
      assert.deepEqual(delta(await counts([T, T2], keys), before), LEASE_ONLY, `${label}: nothing written, no completion, the lease open`);
      assertRefusal(await ctx.discard(s, S, id, discardBody(expected, 1), { key }), 409, 'request_in_progress', `${label}: the same-key retry within the lease`);
    }
    // (3) The store segment must select the actor's own grant: every other store is the authorizer's 403 before any key.
    for (const [label, store] of [['a store of the tenant without a grant', S3], ['another tenant\'s store', X], ['a missing store', randomUUID()], ['a non-canonical store', S.toUpperCase()]]) {
      const key = randomUUID();
      const before = await counts([T, T2]);
      assertRefusal(await ctx.discard(s, store, id, discardBody(T, 1), { key }), 403, 'forbidden', label);
      assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(key, who.principal), 0, `${label}: no key acquired`);
    }
    // (4) The draft segment: malformed is the chain's 400 before any key; well-formed but unversioned the planner's, after it.
    for (const segment of ['x', id.toUpperCase(), `${id}0`]) {
      const key = randomUUID();
      const before = await counts([T, T2]);
      const reply = await ctx.discard(s, S, segment, discardBody(T, 1), { key });
      assertRefusal(reply, 400, 'invalid_request', `the segment ${segment.slice(0, 8)}`);
      assert.equal(ctx.reason(reply), 'command_target_invalid');
      assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, 'before any key: nothing recorded');
      assert.equal(await recordsOf(key, who.principal), 0, 'no key acquired');
    }
    {
      const unversioned = `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`;
      const before = await counts([T, T2]);
      const reply = await ctx.discard(s, S, unversioned, discardBody(T, 1));
      assertRefusal(reply, 400, 'invalid_request', 'an unversioned draft id');
      assert.equal(ctx.reason(reply), 'command_request_invalid');
      assert.deepEqual(delta(await counts([T, T2]), before), LEASE_ONLY, 'the planner refuses after the key: its lease alone');
    }
    // (5) The trailing path: only exactly /{id}/discard is the command; any other suffix, an extra segment or another method
    // matches no route at all — the terminal 404, nothing parsed.
    const base = `/api/v1/stores/${S}/invoice-drafts/${id}`;
    for (const [label, method, path] of [
      ['another suffix', 'POST', `${base}/discards`], ['the suffix in capitals', 'POST', `${base}/DISCARD`], ['an extra segment after it', 'POST', `${base}/discard/x`],
      ['a trailing slash', 'POST', `${base}/discard/`], ['an extra segment before it', 'POST', `${base}/x/discard`], ['the eligibility suffix', 'POST', `${base}/discard-eligibility`],
      ['the edit eligibility suffix', 'POST', `${base}/edit-eligibility`], ['no suffix (POST at the draft)', 'POST', base], ['PATCH at the suffix', 'PATCH', `${base}/discard`],
      ['PUT at the suffix', 'PUT', `${base}/discard`], ['DELETE at the suffix', 'DELETE', `${base}/discard`],
    ]) {
      const key = randomUUID();
      const before = await counts([T, T2]);
      const reply = await ctx.unsafe(s, method, path, discardBody(T, 1), { key });
      assertRefusal(reply, 404, 'not_found', label);
      assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, `${label}: nothing written`);
      assert.equal(await recordsOf(key, who.principal), 0, `${label}: no key acquired`);
    }
    const asGet = await ctx.read(s, `${base}/discard`);
    assertRefusal(asGet, 404, 'not_found', 'a GET of the command');
    // (6) The key binds the draft id: the same key and bytes at another draft of the store, or at another store's draft, are
    // the 422; the original keeps replaying.
    const key = randomUUID();
    const body = JSON.stringify(discardBody(T, 1));
    const first = await ctx.discard(s, S, id, body, { key });
    discardedOf(first, { draftId: id, version: 2 }, 'the discard under the key');
    const before = await counts([T, T2]);
    assertRefusal(await ctx.discard(s, S, id2, body, { key }), 422, 'idempotency_key_reused', 'the same key and bytes at another draft of the store');
    assertRefusal(await ctx.discard(s, S2, elsewhere, body, { key }), 422, 'idempotency_key_reused', 'the same key and bytes at another store\'s draft');
    assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, 'the 422s wrote nothing');
    discardedOf(await ctx.discard(s, S, id, body, { key }), { draftId: id, version: 2 }, 'the original replays', { replayed: true });
    // (7) The chain around the command writes nothing.
    const fresh = discardBody(T, 1);
    const chainBefore = await counts([T, T2]);
    assertRefusal(await ctx.discard(null, S, id2, fresh), 401, 'unauthenticated', 'without a session');
    assertRefusal(await ctx.discard(s, S, id2, fresh, { headers: { [SESSION_CSRF_HEADER]: other.csrf } }), 403, 'forbidden', 'another session\'s CSRF token');
    assertRefusal(await ctx.discard(s, S, id2, fresh, { headers: { origin: 'https://evil.test' } }), 403, 'forbidden', 'a cross-site Origin');
    assertRefusal(await ctx.discard(s, S, id2, fresh, { headers: { [CSRF_HEADER]: '0' } }), 403, 'forbidden', 'no CSRF header value');
    const noKey = await send(ctx.port, 'POST', `/api/v1/stores/${S}/invoice-drafts/${id2}/discard`, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf,
    }, JSON.stringify(fresh));
    assertRefusal(noKey, 400, 'invalid_request', 'no Idempotency-Key');
    assertRefusal(await ctx.discard(s, S, id2, fresh, { headers: { host: ADMIN_HOST } }), 404, 'not_found', 'the administrative host');
    assert.deepEqual(delta(await counts([T, T2]), chainBefore), NOTHING, 'no chain refusal wrote anything');
    const now = await Promise.all(drafts.map(stateOf));
    assert.deepEqual(now.slice(1), states.slice(1), 'every other draft untouched');
  });
});

// ===========================================================================
// IDDH-07: stale versions
// ===========================================================================

test('IDDH-07 (DSC-06 AC-06): a stale and a future version are the sealed 409 write_conflict, writing only their completions, replayed byte for byte under their keys; the current version then discards', async () => {
  const T = await newTenant('iddh07');
  const S = await newStore(T, 'IDDH07 store');
  const C = await newCustomer(T, 'iddh07');
  const who = await actor('iddh07', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const id = await seed(ctx, s, S, T, C, [line(described('stale one'), 1, 1)]);
    editedOf(await ctx.patch(s, S, id, editBody(T, 1, C, [line(described('stale two'), 2, 2)])), { draftId: id, version: 2, changed: true }, 'to version 2');
    const state = await stateOf(id);
    for (const [label, version] of [['a stale version', 1], ['a version from the future', 3]]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      const first = await ctx.discard(s, S, id, discardBody(T, version), { key });
      sealedOf(first, 'write_conflict', label);
      const again = await ctx.discard(s, S, id, discardBody(T, version), { key });
      sealedOf(again, 'write_conflict', `${label}: replayed`, { replayed: true });
      assert.equal(again.body, first.body, `${label}: byte for byte`);
      assert.deepEqual(delta(await counts([T], keys), before), COMPLETION_ONLY, `${label}: its sealed 409 only — no audit record, no state change`);
      assert.deepEqual(await stateOf(id), state, `${label}: the draft untouched (xmin included)`);
    }
    discardedOf(await ctx.discard(s, S, id, discardBody(T, 2)), { draftId: id, version: 3 }, 'the current version discards');
  });
});

// ===========================================================================
// IDDH-08: two instances, ordered by an owner's hold of the header
// ===========================================================================

test('IDDH-08 (DSC-08 AC-08): two tenant entries over one database, two actors, ordered by an owner\'s hold of the draft header — two discards under different keys are one 200 and one sealed 409 invalid_state with ONE audit record, both directions; an edit first makes the discard the sealed 409 write_conflict; a discard first makes the edit the sealed 409 invalid_state', async () => {
  const T = await newTenant('iddh08');
  const S = await newStore(T, 'IDDH08 store');
  const C = await newCustomer(T, 'iddh08');
  const first = await actor('iddh08-owner', [storeGrant(T, S, 'store_owner')]);
  const second = await actor('iddh08-manager', [storeGrant(T, S, 'manager')]);
  await withEntry((a) => withEntry(async (b) => {
    const sa = await signIn(a, first);
    const sb = await signIn(b, second);
    const send2 = { A: (kind, id, body, key) => (kind === 'discard' ? a.discard(sa, S, id, body, { key }) : a.patch(sa, S, id, body, { key })),
      B: (kind, id, body, key) => (kind === 'discard' ? b.discard(sb, S, id, body, { key }) : b.patch(sb, S, id, body, { key })) };
    for (const [round, [x, xKind], [y, yKind]] of [
      ['(a) A discards first, B discards second', ['A', 'discard'], ['B', 'discard']],
      ['(b) B discards first, A discards second', ['B', 'discard'], ['A', 'discard']],
      ['(c) A edits first, B discards second', ['A', 'edit'], ['B', 'discard']],
      ['(d) A discards first, B edits second', ['A', 'discard'], ['B', 'edit']],
    ]) {
      const id = await seed(a, sa, S, T, C, [line(described(`raced seed ${round}`), 1, 1)]);
      const bodyOf = (kind) => (kind === 'discard' ? discardBody(T, 1) : editBody(T, 1, C, [line(described(`raced edit ${round}`), 2, 2)]));
      const queryOf = (kind) => (kind === 'discard' ? AT_DISCARD : AT_UPDATE);
      const yKey = randomUUID();
      const yPrincipal = y === 'A' ? first.principal : second.principal;
      const before = await counts([T]);
      const h = await holdHeader(id);
      let px;
      let py;
      try {
        px = quietly(send2[x](xKind, id, bodyOf(xKind), randomUUID()));
        const xPid = waitingPid(await blockedOrSettled(px, { by: h.pid, query: queryOf(xKind) }), `${round}: ${x} waiting on the header`);
        await assertWaitsOnHeaderBehind(xPid, h.pid, `${round}: ${x}`);
        py = quietly(send2[y](yKind, id, bodyOf(yKind), yKey));
        const yPid = waitingPid(await blockedOrSettled(py, { by: xPid, query: queryOf(yKind) }), `${round}: ${y} queued behind ${x}`);
        await assertQueuedOnHeaderTuple(yPid, `${round}: ${y}`);
      } finally {
        await h.commit();
      }
      const rx = await replyTo(px, `${round}: ${x}`);
      const ry = await replyTo(py, `${round}: ${y}`);
      if (xKind === 'discard') discardedOf(rx, { draftId: id, version: 2 }, `${round}: ${x}'s discard commits`);
      else editedOf(rx, { draftId: id, version: 2, changed: true }, `${round}: ${x}'s edit commits`);
      const word = xKind === 'discard' ? 'invalid_state' : 'write_conflict';
      sealedOf(ry, word, `${round}: ${y} is the sealed ${word}`);
      sealedOf(await send2[y](yKind, id, bodyOf(yKind), yKey), word, `${round}: ${y}'s 409 replays`, { replayed: true });
      assert.equal((await counts([T], [{ key: yKey, principal: yPrincipal }])).K, 1, `${round}: ${y}'s sealed completion`);
      const d = delta(await counts([T]), before);
      if (xKind === 'discard') {
        assert.deepEqual(d, { ...NOTHING, X: 1, A: 1, AA: 1, C: 2 }, `${round}: one discard, ONE audit record, two completions`);
      } else {
        assert.deepEqual(d, { ...NOTHING, O: 1, AA: 1, OO: 1, C: 2 }, `${round}: one edit (its audit record and event, one line for one), no discard, no discard audit record, two completions`);
      }
      const header = (await stateOf(id)).header;
      assert.deepEqual([header.status, header.version], [xKind === 'discard' ? 'discarded' : 'draft', '2'], `${round}: the winner's state, one step`);
    }
  }));
});

// ===========================================================================
// IDDH-09: one key, one request
// ===========================================================================

test('IDDH-09 (DSC-09): one key — the same bytes replay (Idempotent-Replayed: true, byte-identical); another version, the same value re-spaced, an edit\'s key and a save\'s key on the discard, and the discard\'s key on an edit are each the 422, writing nothing; the original keeps replaying', async () => {
  const T = await newTenant('iddh09');
  const S = await newStore(T, 'IDDH09 store');
  const C = await newCustomer(T, 'iddh09');
  const who = await actor('iddh09', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const saveKey = randomUUID();
    const id = await seed(ctx, s, S, T, C, [line(described('key one'), 1, 1)]);
    const saved = await seed(ctx, s, S, T, C, [line(described('key saved'), 1, 1)], { key: saveKey });
    const edited = await seed(ctx, s, S, T, C, [line(described('key edited'), 1, 1)]);
    const open = await seed(ctx, s, S, T, C, [line(described('key open'), 1, 1)]);
    const editKey = randomUUID();
    editedOf(await ctx.patch(s, S, edited, editBody(T, 1, C, [line(described('key edit'), 2, 2)]), { key: editKey }), { draftId: edited, version: 2, changed: true }, 'the edit under its key');
    const key = randomUUID();
    const body = JSON.stringify(discardBody(T, 1));
    const first = await ctx.discard(s, S, id, body, { key });
    discardedOf(first, { draftId: id, version: 2 }, 'the discard');
    const replay = await ctx.discard(s, S, id, body, { key });
    discardedOf(replay, { draftId: id, version: 2 }, 'the same key and bytes', { replayed: true });
    assert.equal(replay.body, first.body, 'byte-identical');
    const states = await Promise.all([id, saved, edited, open].map(stateOf));
    const before = await counts([T]);
    for (const [label, reply] of [
      ['another version under the key', await ctx.discard(s, S, id, JSON.stringify(discardBody(T, 2)), { key })],
      ['the same value re-spaced', await ctx.discard(s, S, id, JSON.stringify(discardBody(T, 1), null, 1), { key })],
      ['the keys in another order', await ctx.discard(s, S, id, JSON.stringify({ expectedVersion: 1, expectedTenant: T }), { key })],
      ['an edit\'s key on the discard of its draft', await ctx.discard(s, S, edited, discardBody(T, 2), { key: editKey })],
      ['a save\'s key on the discard of its draft', await ctx.discard(s, S, saved, discardBody(T, 1), { key: saveKey })],
      ['the discard\'s key on an edit', await ctx.patch(s, S, open, editBody(T, 1, C, [line(described('key reuse'), 1, 1)]), { key })],
    ]) assertRefusal(reply, 422, 'idempotency_key_reused', label);
    assert.deepEqual(delta(await counts([T]), before), NOTHING, 'refused before any write');
    assert.deepEqual(await Promise.all([id, saved, edited, open].map(stateOf)), states, 'every draft untouched');
    discardedOf(await ctx.discard(s, S, id, body, { key }), { draftId: id, version: 2 }, 'the original replays', { replayed: true });
  });
});

// ===========================================================================
// IDDH-10: a fresh key at a discarded draft; the stale editor
// ===========================================================================

test('IDDH-10 (DSC-10 AC-06): a fresh key at a discarded draft is the sealed 409 invalid_state whatever version it names (current, stale, ahead) and whoever asks — no second audit record, the header as it was — and replays; a stale editor\'s PATCH of it is the sealed 409 invalid_state too', async () => {
  const T = await newTenant('iddh10');
  const S = await newStore(T, 'IDDH10 store');
  const C = await newCustomer(T, 'iddh10');
  const ownerActor = await actor('iddh10-owner', [storeGrant(T, S, 'store_owner')]);
  const who = await actor('iddh10', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, ownerActor);
    const s = await signIn(ctx, who);
    const lines = [line(described('discarded one'), 1, 1)];
    const id = await seed(ctx, s, S, T, C, lines);
    discardedOf(await ctx.discard(s, S, id, discardBody(T, 1)), { draftId: id, version: 2 }, 'the discard');
    const state = await stateOf(id);
    const audits = (await counts([T])).A;
    for (const [label, principal, send] of [
      ['the manager naming the current version', who.principal, (k) => ctx.discard(s, S, id, discardBody(T, 2), { key: k })],
      ['the manager naming the stale version (precedence: the state before the version)', who.principal, (k) => ctx.discard(s, S, id, discardBody(T, 1), { key: k })],
      ['the manager naming a version ahead', who.principal, (k) => ctx.discard(s, S, id, discardBody(T, 99), { key: k })],
      ['the store owner naming the current version', ownerActor.principal, (k) => ctx.discard(so, S, id, discardBody(T, 2), { key: k })],
      ['a stale editor\'s PATCH at the version it reopened', who.principal, (k) => ctx.patch(s, S, id, editBody(T, 1, C, [line(described('stale editor'), 2, 2)]), { key: k })],
      ['an editor\'s PATCH at the current version', ownerActor.principal, (k) => ctx.patch(so, S, id, editBody(T, 2, C, lines), { key: k })],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal }];
      const before = await counts([T], keys);
      const reply = await send(key);
      sealedOf(reply, 'invalid_state', label);
      assert.deepEqual(delta(await counts([T], keys), before), COMPLETION_ONLY, `${label}: its completion only — no second audit record, no state change`);
      assert.deepEqual(await stateOf(id), state, `${label}: the header and lines as they were (xmin included), version 2`);
      const again = await send(key);
      sealedOf(again, 'invalid_state', `${label}: replayed`, { replayed: true });
      assert.equal(again.body, reply.body, `${label}: byte for byte`);
    }
    assert.equal((await counts([T])).A, audits, 'still exactly one discard audit record');
  });
});

// ===========================================================================
// IDDH-11: faults inside the command
// ===========================================================================

test('IDDH-11 (DSC-11 AC-10): a fault at the audit INSERT, at the completion, at the header UPDATE and at a sealed conflict\'s completion is the 503 — the header and lines as they were, nothing recorded but the open lease; without a fault the same discard commits', async () => {
  const T = await newTenant('iddh11');
  const S = await newStore(T, 'IDDH11 store');
  const C = await newCustomer(T, 'iddh11');
  const who = await actor('iddh11', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const id = await seed(ctx, s, S, T, C, [line(described('fault one'), 1, 10), line(described('fault two'), 2, 20)]);
    const state = await stateOf(id);
    for (const [label, table, event, when, version] of [
      ['the audit INSERT raises', 'public.audit_event', 'insert', `new.action_id = '${ACTION}' and new.subject_invoice_draft_id = '${id}'::uuid`, 1],
      ['the completion raises', 'tmpos_internal.idempotency_record', 'update', COMPLETION, 1],
      ['the header UPDATE raises', DRAFT_TABLE, 'update', `old.draft_id = '${id}'::uuid`, 1],
      ['a sealed conflict\'s completion raises', 'tmpos_internal.idempotency_record', 'update', COMPLETION, 7],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      const firedBefore = await fired();
      const reply = await withTrigger(table, event, when, 'raise', () => ctx.discard(s, S, id, discardBody(T, version), { key }));
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: nothing recorded but the open lease — no audit record, no completion, no state change`);
      assert.deepEqual(await stateOf(id), state, `${label}: the header and lines as they were (xmin included)`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease open`);
      assertRefusal(await ctx.discard(s, S, id, discardBody(T, version), { key }), 409, 'request_in_progress', `${label}: the retry within the lease`);
    }
    discardedOf(await ctx.discard(s, S, id, discardBody(T, 1)), { draftId: id, version: 2 }, 'control: without a fault the discard commits');
  });
});

// ===========================================================================
// IDDH-12: a refusal leaves its lease; the retry plans again
// ===========================================================================

test('IDDH-12 (DSC-12): a 503 leaves its lease — the same key is the 409 request_in_progress until the lease is expired; then it plans again under the CURRENT authority (narrowed to Edit: the 403; restored: the 200, then replayed) and the current version (moved by an edit: the sealed 409 write_conflict)', async () => {
  const T = await newTenant('iddh12');
  const S = await newStore(T, 'IDDH12 store');
  const C = await newCustomer(T, 'iddh12');
  const ownerActor = await actor('iddh12-owner', [storeGrant(T, S, 'store_owner')]);
  const who = await actor('iddh12', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, ownerActor);
    const s = await signIn(ctx, who);
    const refusedOnce = async (id, key) => {
      const reply = await withTrigger('public.audit_event', 'insert', `new.action_id = '${ACTION}' and new.subject_invoice_draft_id = '${id}'::uuid`, 'raise',
        () => ctx.discard(s, S, id, discardBody(T, 1), { key }));
      assertRefusal(reply, 503, 'service_unavailable', 'the refused discard');
      assert.equal(await leaseOpen(key, who.principal), true, 'the refusal left its lease');
      for (const n of [1, 2]) assertRefusal(await ctx.discard(s, S, id, discardBody(T, 1), { key }), 409, 'request_in_progress', `the same key within the lease (${n})`);
    };
    // (a) Authority: narrowed after the refusal, the expired lease's retry meets the authorizer; restored, it plans and applies.
    {
      const id = await seed(ctx, so, S, T, C, [line(described('lease authority'), 1, 1)]);
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      await refusedOnce(id, key);
      await setLevel(T, 'manager', 'invoices', 'edit');
      // The chain authorizes before it reads the key: narrowed, even within the lease, the answer is the authorizer's.
      assertRefusal(await ctx.discard(s, S, id, discardBody(T, 1), { key }), 403, 'forbidden', 'narrowed, still within the lease: the authorizer answers first');
      assert.equal(await leaseOpen(key, who.principal), true, 'and the lease is still open, untouched by that refusal');
      await expireLease(key, who.principal);
      const narrowed = await ctx.discard(s, S, id, discardBody(T, 1), { key });
      assertRefusal(narrowed, 403, 'forbidden', 'the expired lease\'s retry under the narrowed level');
      assert.equal(ctx.reason(narrowed), 'authz_denied', 'the authorizer decides on the current level');
      await setLevel(T, 'manager', 'invoices', null);
      discardedOf(await ctx.discard(s, S, id, discardBody(T, 1), { key }), { draftId: id, version: 2 }, 'restored: the retry plans again and applies');
      discardedOf(await ctx.discard(s, S, id, discardBody(T, 1), { key }), { draftId: id, version: 2 }, 'and then replays', { replayed: true });
      assert.deepEqual(delta(await counts([T], keys), before), ONE_DISCARD, 'exactly one discard: the lease reclaimed and completed');
    }
    // (b) State: an edit moves the version after the refusal; the expired lease's retry plans on the current version.
    {
      const id = await seed(ctx, so, S, T, C, [line(described('lease version'), 1, 1)]);
      const key = randomUUID();
      await refusedOnce(id, key);
      editedOf(await ctx.patch(so, S, id, editBody(T, 1, C, [line(described('lease moved'), 2, 2)])), { draftId: id, version: 2, changed: true }, 'the store owner edits it to version 2');
      await expireLease(key, who.principal);
      const state = await stateOf(id);
      sealedOf(await ctx.discard(s, S, id, discardBody(T, 1), { key }), 'write_conflict', 'the expired lease\'s retry plans on version 2');
      sealedOf(await ctx.discard(s, S, id, discardBody(T, 1), { key }), 'write_conflict', 'and replays', { replayed: true });
      assert.deepEqual(await stateOf(id), state, 'still open at version 2');
    }
  });
});

// ===========================================================================
// IDDH-13: lost COMMIT answers
// ===========================================================================

test('IDDH-13 (DSC-13 AC-10): the COMMIT lands and its answer is lost (a discard, a sealed conflict, a sealed invalid_state) — the 503, then the same key and bytes replay what landed, the version stepped once; the COMMIT never lands — the 503, nothing, the 409 until the lease ends, then one step', async () => {
  const T = await newTenant('iddh13');
  const S = await newStore(T, 'IDDH13 store');
  const C = await newCustomer(T, 'iddh13');
  const who = await actor('iddh13', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const id = await seed(ctx, s, S, T, C, [line(described('lost seed'), 1, 1)]);
    const stale = await seed(ctx, s, S, T, C, [line(described('lost stale'), 1, 1)]);
    const cut = await seed(ctx, s, S, T, C, [line(described('cut seed'), 1, 1)]);
    /** Send under a trap; the reply, after asserting the trap engaged exactly once. */
    const trapped = async (mode, anchor, draft, body, key, label) => {
      const trap = trapCommit(ctx.relay, mode, anchor);
      let reply;
      const sentAt = Date.now();
      try { reply = await ctx.discard(s, S, draft, body, { key }); } finally { trap.release(); }
      assert.equal(trap.hit.length, 1, `${label}: the trap engaged at exactly one COMMIT`);
      assertRefusal(reply, 503, 'service_unavailable', label);
      return { reply, elapsed: Date.now() - sentAt };
    };
    /** Poll (bounded) until the OWNER sees `predicate` hold — what landed becomes visible; never a sleep for an outcome. */
    const until = async (predicate, label) => {
      for (const end = Date.now() + WAIT_MS; Date.now() < end; await tick()) if (await predicate()) return;
      assert.fail(`${label}: not observed within ${WAIT_MS} ms`);
    };
    // (1) A real discard LANDED, its answer lost (anchor: the audit INSERT).
    const key1 = randomUUID();
    const keys1 = [{ key: key1, principal: who.principal }];
    const before1 = await counts([T], keys1);
    const lost = await trapped('lose', AUDIT_ANCHOR, id, discardBody(T, 1), key1, 'the lost discard answer');
    assert.equal(ctx.reason(lost.reply), 'transaction_timeout', 'unknown at the commit deadline');
    assert.ok(lost.elapsed >= COMMAND_TRANSACTION_DEADLINE_MS - 50, 'answered at the commit\'s own deadline');
    await until(async () => (await counts([T], keys1)).K === before1.K + 1, 'the landed discard');
    assert.deepEqual(delta(await counts([T], keys1), before1), ONE_DISCARD, 'what committed is visible, whole');
    discardedOf(await ctx.discard(s, S, id, discardBody(T, 1), { key: key1 }), { draftId: id, version: 2 }, 'the same-key retry replays', { replayed: true });
    assert.deepEqual([(await stateOf(id)).header.status, (await stateOf(id)).header.version], ['discarded', '2'], 'stepped exactly once');
    assert.deepEqual(delta(await counts([T], keys1), before1), ONE_DISCARD, 'never a second step or audit record');
    // (2) A sealed conflict LANDED, its answer lost (anchor: the completion — a conflict writes no audit record).
    editedOf(await ctx.patch(s, S, stale, editBody(T, 1, C, [line(described('lost stale moved'), 2, 2)])), { draftId: stale, version: 2, changed: true }, 'the stale draft to version 2');
    const key2 = randomUUID();
    const keys2 = [{ key: key2, principal: who.principal }];
    const state2 = await stateOf(stale);
    const before2 = await counts([T], keys2);
    await trapped('lose', COMPLETION_ANCHOR, stale, discardBody(T, 1), key2, 'the lost conflict answer');
    await until(async () => (await counts([T], keys2)).K === before2.K + 1, 'the landed conflict');
    sealedOf(await ctx.discard(s, S, stale, discardBody(T, 1), { key: key2 }), 'write_conflict', 'the conflict replays', { replayed: true });
    assert.deepEqual(delta(await counts([T], keys2), before2), COMPLETION_ONLY, 'its completion only');
    assert.deepEqual(await stateOf(stale), state2, 'nothing written');
    // (3) A sealed invalid_state LANDED (a fresh key at the discarded draft), its answer lost.
    const key3 = randomUUID();
    const keys3 = [{ key: key3, principal: who.principal }];
    const state3 = await stateOf(id);
    const before3 = await counts([T], keys3);
    await trapped('lose', COMPLETION_ANCHOR, id, discardBody(T, 2), key3, 'the lost invalid_state answer');
    await until(async () => (await counts([T], keys3)).K === before3.K + 1, 'the landed invalid_state');
    sealedOf(await ctx.discard(s, S, id, discardBody(T, 2), { key: key3 }), 'invalid_state', 'the invalid_state replays', { replayed: true });
    assert.deepEqual(delta(await counts([T], keys3), before3), COMPLETION_ONLY, 'its completion only');
    assert.deepEqual(await stateOf(id), state3, 'nothing written');
    // (4) NOT LANDED: the COMMIT never reaches the server; the connection is cut and the server rolls the discard back.
    const key4 = randomUUID();
    const keys4 = [{ key: key4, principal: who.principal }];
    const state4 = await stateOf(cut);
    const before4 = await counts([T], keys4);
    await trapped('cut', AUDIT_ANCHOR, cut, discardBody(T, 1), key4, 'the cut COMMIT');
    await headerFree(cut); // granted only once the cut transaction has ended
    assert.deepEqual(delta(await counts([T], keys4), before4), LEASE_ONLY, 'nothing landed: the lease alone, open');
    assert.deepEqual(await stateOf(cut), state4, 'the draft as it was');
    assertRefusal(await ctx.discard(s, S, cut, discardBody(T, 1), { key: key4 }), 409, 'request_in_progress', 'the same-key retry within the lease never re-plans');
    await expireLease(key4, who.principal);
    discardedOf(await ctx.discard(s, S, cut, discardBody(T, 1), { key: key4 }), { draftId: cut, version: 2 }, 'after the lease: the explicit retry plans again');
    discardedOf(await ctx.discard(s, S, cut, discardBody(T, 1), { key: key4 }), { draftId: cut, version: 2 }, 'and replays', { replayed: true });
    assert.deepEqual(delta(await counts([T], keys4), before4), ONE_DISCARD, 'exactly one step (the lease reclaimed and completed)');
  });
});

// ===========================================================================
// IDDH-14: the open-only reads
// ===========================================================================

test('IDDH-14 (DSC-15 AC-11): a discarded draft is absent from every list page and its reopen is the missing draft\'s 404 (one shape, one logged reason); a cursor naming it still pages; every list answer is the 200 — on a second entry and for a View-level reader too', async () => {
  const T = await newTenant('iddh14');
  const S = await newStore(T, 'IDDH14 store');
  const C = await newCustomer(T, 'iddh14');
  const who = await actor('iddh14', [storeGrant(T, S, 'manager')]);
  const reader = await actor('iddh14-reader', [storeGrant(T, S, 'technician')]);
  await withEntry((a) => withEntry(async (b) => {
    const s = await signIn(a, who);
    const r = await signIn(b, reader);
    const d1 = await seed(a, s, S, T, C, [line(described('page one'), 1, 1)]);
    const d2 = await seed(a, s, S, T, C, [line(described('page two'), 1, 1)]);
    const d3 = await seed(a, s, S, T, C, [line(described('page three'), 1, 1)]);
    const firstPage = pageOf(await a.list(s, S, '?limit=1'), 'page one of one');
    assert.deepEqual(firstPage.ids, [d3], 'newest first');
    const cursor = firstPage.nextCursor;
    assert.equal(typeof cursor, 'string', 'a full page carries a cursor naming its last draft');
    SECRETS.add(cursor);
    assert.deepEqual(pageOf(await a.list(s, S), 'before the discard').ids, [d3, d2, d1]);
    discardedOf(await a.discard(s, S, d3, discardBody(T, 1)), { draftId: d3, version: 2 }, 'the newest draft discarded');
    for (const [label, ctx, sess] of [['the discarder on entry A', a, s], ['a View-level reader on entry B', b, r]]) {
      const all = pageOf(await ctx.list(sess, S), `${label}: the list`);
      assert.deepEqual([all.ids, all.statuses, all.nextCursor], [[d2, d1], ['draft'], null], `${label}: the discarded draft is absent, only open drafts`);
      const paged = pageOf(await ctx.list(sess, S, `?limit=1&cursor=${cursor}`), `${label}: the cursor naming the discarded draft`);
      assert.deepEqual(paged.ids, [d2], `${label}: the cursor still pages, after its anchor`);
      assert.equal(typeof paged.nextCursor, 'string', `${label}: and behind a full page the next cursor`);
      assert.deepEqual(pageOf(await ctx.list(sess, S, `?cursor=${cursor}`), `${label}: the rest after the anchor`).ids, [d2, d1]);
      assert.deepEqual(pageOf(await ctx.list(sess, S, `?limit=1&cursor=${paged.nextCursor}`), `${label}: the last page`).ids, [d1]);
      const gone = await ctx.get(sess, S, d3);
      const missing = await ctx.get(sess, S, randomUUID());
      assertRefusal(gone, 404, 'not_found', `${label}: the discarded draft's reopen`);
      assertRefusal(missing, 404, 'not_found', `${label}: a missing draft's reopen`);
      assert.deepEqual([ctx.reason(gone), Buffer.byteLength(gone.body)], [ctx.reason(missing), Buffer.byteLength(missing.body)], `${label}: one reason and one body length`);
      assert.equal(ctx.reason(gone), 'invoice_draft_not_found');
      assert.equal(JSON.parse((await ctx.get(sess, S, d2)).body).draft.status, 'draft', `${label}: an open draft still reopens`);
    }
  }));
});

// ===========================================================================
// IDDH-15: the target-blind eligibility
// ===========================================================================

test('IDDH-15 (DSC-19): the discard eligibility is the same 200 for an open, a missing, another store\'s, another tenant\'s, a discarded and an unversioned id — answered while the OWNER holds the draft table ACCESS EXCLUSIVE, which a reopen waits for; an Edit-level role and a read-only account are refused; a query, a malformed id, no session, no session CSRF, another host and another method are refused; no-store throughout; nothing written', async () => {
  const T = await newTenant('iddh15');
  const T2 = await newTenant('iddh15-other');
  const S = await newStore(T, 'IDDH15 store');
  const S2 = await newStore(T, 'IDDH15 second store');
  const X = await newStore(T2, 'IDDH15 foreign store');
  const C = await newCustomer(T, 'iddh15');
  const C2 = await newCustomer(T2, 'iddh15-foreign');
  const who = await actor('iddh15', [storeGrant(T, S, 'manager'), storeGrant(T, S2, 'manager')]);
  const editor = await actor('iddh15-editor', [storeGrant(T, S, 'technician')]);
  const readOnly = await actor('iddh15-ro', [storeGrant(T, S, 'store_owner')], 'read_only');
  const foreign = await actor('iddh15-foreign', [storeGrant(T2, X, 'manager')]);
  await setLevel(T, 'technician', 'invoices', 'edit');
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const other = await signIn(ctx, who);
    const sf = await signIn(ctx, foreign);
    const open = await seed(ctx, s, S, T, C, [line(described('elig open'), 1, 1)]);
    const discarded = await seed(ctx, s, S, T, C, [line(described('elig discarded'), 1, 1)]);
    const elsewhere = await seed(ctx, s, S2, T, C, [line(described('elig other store'), 1, 1)]);
    const theirs = await seed(ctx, sf, X, T2, C2, [line(described('elig other tenant'), 1, 1)]);
    discardedOf(await ctx.discard(s, S, discarded, discardBody(T, 1)), { draftId: discarded, version: 2 }, 'the discarded one');
    const unversioned = `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`;
    const ids = [open, randomUUID(), elsewhere, theirs, discarded, unversioned];
    // Signed in before the baseline: a login writes its own audit record.
    const se = await signIn(ctx, editor);
    const sro = await signIn(ctx, readOnly);
    const before = await counts([T, T2]);
    // Answered while the OWNER holds the draft table ACCESS EXCLUSIVE: the eligibility reads no draft at all.
    const table = await hold('the draft table, access exclusive', (sql) => sql.unsafe(`lock table ${DRAFT_TABLE} in access exclusive mode`));
    let answers;
    let reopen;
    try {
      answers = [];
      for (const id of ids) answers.push(await replyTo(ctx.discardEligibility(s, S, id), 'the eligibility while the table is held'));
      // Control: the lever engages — a reopen of the open draft waits for the held table.
      reopen = quietly(ctx.get(s, S, open));
      waitingPid(await blockedOrSettled(reopen, { by: table.pid, query: AT_GET }), 'a reopen waiting on the held draft table');
    } finally {
      await table.commit();
    }
    for (const reply of answers) assert.equal(verdictOf(reply, 'a well-formed id'), 'allowed');
    assert.equal(new Set(answers.map((x) => x.body)).size, 1, 'one body for every well-formed id: open, missing, another store\'s, another tenant\'s, discarded, unversioned');
    assert.equal((await replyTo(reopen, 'the reopen')).status, 200, 'the reopen answers once the table is released');
    // Refusals: the role, the account, the request.
    assertRefusal(await ctx.discardEligibility(se, S, open), 403, 'forbidden', 'a technician at Invoices Edit');
    assertRefusal(await ctx.discardEligibility(sro, S, open), 403, 'forbidden', 'a read-only account (store_owner grant)');
    const query = await ctx.discardEligibility(s, S, open, { query: '?x=1' });
    assertRefusal(query, 400, 'invalid_request', 'a query');
    assert.equal(ctx.reason(query), 'invoice_draft_discard_eligibility_query_invalid');
    const malformed = await ctx.discardEligibility(s, S, 'x');
    assertRefusal(malformed, 400, 'invalid_request', 'a malformed id');
    assert.equal(ctx.reason(malformed), 'invoice_draft_id_invalid');
    assertRefusal(await ctx.discardEligibility(s, S.toUpperCase(), open), 403, 'forbidden', 'a non-canonical store');
    assertRefusal(await ctx.discardEligibility(s, X, open), 403, 'forbidden', 'another tenant\'s store');
    assertRefusal(await ctx.discardEligibility(null, S, open), 401, 'unauthenticated', 'no session');
    assertRefusal(await ctx.discardEligibility(null, S, open, { headers: { cookie: s.cookie } }), 403, 'forbidden', 'no session CSRF token');
    assertRefusal(await ctx.discardEligibility(null, S, open, { headers: { cookie: s.cookie, [SESSION_CSRF_HEADER]: other.csrf } }), 403, 'forbidden', 'another session\'s token');
    assertRefusal(await ctx.discardEligibility(s, S, open, { headers: { host: ADMIN_HOST } }), 404, 'not_found', 'the administrative host');
    assertRefusal(await ctx.unsafe(s, 'POST', `/api/v1/stores/${S}/invoice-drafts/${open}/discard-eligibility`, ''), 404, 'not_found', 'a POST to the eligibility');
    assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, 'no eligibility answer wrote anything');
    assert.deepEqual([(await stateOf(open)).header.status, (await stateOf(open)).header.version], ['draft', '1'], 'the open draft still open at version 1');
  });
});

// ===========================================================================
// IDDH-16: the exact audit record
// ===========================================================================

test('IDDH-16 (DSC-24): the discard\'s one audit record, read by the owner — actor, tenant, store, the draft as subject, action store.invoice_draft.discard, permission discard_invoice_drafts, scope store, metadata {}, the command kernel\'s fixed fields, a database-stamped time inside the request, and a server-generated correlation id that is neither the client\'s nor the response\'s', async () => {
  const T = await newTenant('iddh16');
  const S = await newStore(T, 'IDDH16 store');
  const C = await newCustomer(T, 'iddh16');
  const who = await actor('iddh16', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const id = await seed(ctx, s, S, T, C, [line(described('audited'), 3, 4)]);
    const clientCorrelator = randomUUID();
    const [{ t: before }] = await owner`select pg_catalog.clock_timestamp()::text as t`;
    const reply = await ctx.discard(s, S, id, discardBody(T, 1), { headers: { 'x-request-id': clientCorrelator } });
    const [{ t: after }] = await owner`select pg_catalog.clock_timestamp()::text as t`;
    discardedOf(reply, { draftId: id, version: 2 }, 'the discard');
    const rows = await owner`select audit_version, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type,
      tenant_id, store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
      evaluated_by, evidence_level, metadata, subject_tenant_id, subject_customer_id, subject_invoice_draft_id, request_id,
      occurred_at between ${before}::timestamptz and ${after}::timestamptz as inside
      from public.audit_event where subject_invoice_draft_id = ${id} and action_id = ${ACTION}`;
    assert.equal(rows.length, 1, 'exactly one discard record names the draft (its save wrote one too, under its own action)');
    const audits = await owner`select action_id from public.audit_event where tenant_id = ${T} and action_id = ${ACTION}`;
    assert.equal(audits.length, 1, 'and exactly one discard record in the tenant');
    const { request_id: requestId, inside, ...row } = rows[0];
    assert.deepEqual({ ...row }, {
      audit_version: 'audit.v1', trace_id: null, actor_internal_user_id: who.id, actor_auth_provider: null, on_behalf_of_internal_user_id: null,
      scope_type: 'store', tenant_id: T, store_id: S, action_id: ACTION, required_permission: PERMISSION, decision: 'allow',
      reason_code: 'command_committed', human_readable_reason: 'An authorized command committed atomically with its idempotency completion and outbox events.',
      result_status: 'succeeded', source_of_truth: 'command_transaction', evaluated_by: 'm6_postgres_command_transaction@v1', evidence_level: 'durable_compliance_event',
      metadata: {}, subject_tenant_id: null, subject_customer_id: null, subject_invoice_draft_id: id,
    }, 'the draft identified by its subject; no line, customer or description copied');
    assert.equal(inside, true, 'occurred_at is the database\'s own time, inside the request');
    assert.match(requestId, UUID_V4_RE, 'a server-generated correlation id');
    assert.notEqual(requestId, clientCorrelator, 'never the client\'s correlator');
    assert.notEqual(requestId, reply.headers['x-request-id'], 'nor the response\'s request id');
    assert.equal((await owner`select count(*)::int as n from public.audit_event where request_id = ${requestId}`)[0].n, 1, 'and no other record shares it (no event: D-DIS-4)');
  });
});

// ===========================================================================
// IDDH-17: replay respects current authority
// ===========================================================================

/** What a draft holds that a replay must not move: its header and lines, its audit records (every column), and the sealed completions of `keys`. */
async function replayFootprint(draft, keys) {
  const [audit] = await owner`select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) order by pg_catalog.to_jsonb(a)::text), '[]'::jsonb) as rows
    from public.audit_event a where a.subject_invoice_draft_id = ${draft}`;
  const completions = (await owner`select response, xmin::text as xmin from tmpos_internal.idempotency_record
    where scope = any(${keys.map(({ key, principal }) => scopeOf(key, principal)).sort()}::text[]) order by scope`).map((r) => ({ ...r }));
  return { state: await stateOf(draft), audit: audit.rows, completions };
}

test('IDDH-17 (DSC-25 AC-07): a sealed 200, a sealed conflict and a sealed invalid_state under three keys — after the owner\'s PUT lowers the manager to Edit each same-key retry is the 403 and a revoked session\'s the 401, never the stored answer; after the PUT restores Full each replays its retained bytes; those drafts\' rows, audit records and completions never move', async () => {
  const T = await newTenant('iddh17');
  const S = await newStore(T, 'IDDH17 store');
  const C = await newCustomer(T, 'iddh17');
  const manager = await actor('iddh17-mgr', [storeGrant(T, S, 'manager')]);
  const boss = await actor('iddh17-boss', [tenantGrant(T, 'store_owner')]);
  await withEntry(async (ctx) => {
    const sm = await signIn(ctx, manager);
    const sb = await signIn(ctx, boss);
    const id = await seed(ctx, sm, S, T, C, [line(described('replay discarded'), 1, 1)]);
    const stale = await seed(ctx, sm, S, T, C, [line(described('replay stale'), 1, 1)]);
    editedOf(await ctx.patch(sm, S, stale, editBody(T, 1, C, [line(described('replay moved'), 2, 2)])), { draftId: stale, version: 2, changed: true }, 'the stale draft to version 2');
    const calls = [
      { label: 'the sealed 200', key: randomUUID(), draft: id, body: discardBody(T, 1) },
      { label: 'the sealed conflict', key: randomUUID(), draft: stale, body: discardBody(T, 1) },
      { label: 'the sealed invalid_state', key: randomUUID(), draft: id, body: discardBody(T, 2) },
    ];
    for (const c of calls) c.first = await ctx.discard(sm, S, c.draft, c.body, { key: c.key });
    discardedOf(calls[0].first, { draftId: id, version: 2 }, calls[0].label);
    sealedOf(calls[1].first, 'write_conflict', calls[1].label);
    sealedOf(calls[2].first, 'invalid_state', calls[2].label);
    const keys = calls.map((c) => ({ key: c.key, principal: manager.principal }));
    const replays = async (when) => {
      for (const c of calls) {
        const again = await ctx.discard(sm, S, c.draft, c.body, { key: c.key });
        assert.equal(again.status, c.first.status, `${when}: ${c.label}: ${again.body}`);
        assert.equal(again.body, c.first.body, `${when}: ${c.label}: the retained bytes`);
        assert.equal(again.headers['idempotent-replayed'], 'true', `${when}: ${c.label}: replayed`);
      }
    };
    await replays('before any change');
    const settled = { id: await replayFootprint(id, keys), stale: await replayFootprint(stale, keys) };
    assert.equal(settled.id.completions.length, 3, 'all three sealed completions are stored');
    // The owner lowers the manager below Manage through the production PUT: each replay meets the authorizer.
    let version = await reviewedOf(ctx, sb, 'manager');
    version = await putLevel(ctx, sb, T, 'manager', 'edit', version, 'IDDH-17');
    for (const c of calls) {
      const refused = await ctx.discard(sm, S, c.draft, c.body, { key: c.key });
      assertRefusal(refused, 403, 'forbidden', `lowered: ${c.label}'s retry`);
      assert.equal(ctx.reason(refused), 'authz_denied', `lowered: ${c.label}: the authorizer, not the stored answer`);
    }
    // A revoked session: the 401, whatever the key holds.
    const revoked = await signIn(ctx, manager);
    await owner`select tmpos_session.m5_session_revoke(${revoked.key}::text)`;
    assertRefusal(await ctx.discard(revoked, S, calls[0].draft, calls[0].body, { key: calls[0].key }), 401, 'unauthenticated', 'a revoked session\'s retry');
    assert.deepEqual({ id: await replayFootprint(id, keys), stale: await replayFootprint(stale, keys) }, settled, 'lowered: the drafts, their audit records and the completions did not move');
    // The owner restores Full (the manager's default word): the same keys and bytes replay the retained answers.
    await putLevel(ctx, sb, T, 'manager', 'full', version, 'IDDH-17');
    await replays('after the restore');
    assert.deepEqual({ id: await replayFootprint(id, keys), stale: await replayFootprint(stale, keys) }, settled, 'restored: still nothing moved');
    assert.equal((await counts([T])).A, 1, 'one discard audit record in all');
  });
});

// ===========================================================================
// IDDH-19: the body bound and the media type at the request boundary (raw sockets)
// ===========================================================================

/** A raw HTTP/1.1 answer's head and its Content-Length body, or null until both arrived (customerCreate's M7CC-07 parser). */
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
/**
 * One hand-framed request written in ONE piece over a fresh socket (M7CC-07's pattern): Node's client always frames a body it
 * is handed whole with a Content-Length, and a client racing a close mid-upload can surface a reset instead of the answer.
 * Settles once the head and its Content-Length body arrived, or { status: 0 } on an error, a close or the deadline.
 */
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
/**
 * A hand-framed POST at `path` from the entry's own source address: the tenant Host, Origin and pre-session CSRF, the session's
 * cookie and CSRF token (none for s === null), the Idempotency-Key when one is given (registered as a log canary and for the
 * teardown), then `lines` (each ending CRLF) and `tail` as the body bytes. No Connection header is sent, so a Connection: close
 * in the answer is the server's own. `csrf: false` leaves out both CSRF headers (the pre-session one and the session's).
 */
function rawUnsafe(ctx, s, path, lines, tail = '', key = null, { csrf = true } = {}) {
  if (key !== null) {
    SECRETS.add(key);
    if (s !== null) USED_KEYS.push({ key, principal: s.principal });
  }
  const head = [`Host: ${TENANT_HOST}`, `Origin: ${TENANT_ORIGIN}`, 'Sec-Fetch-Site: same-origin', ...(csrf ? [`${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`] : []),
    ...(s === null ? [] : [`Cookie: ${s.cookie}`, ...(csrf ? [`${SESSION_CSRF_HEADER}: ${s.csrf}`] : [])]), ...(key === null ? [] : [`Idempotency-Key: ${key}`])];
  return rawRequest(ctx.port, `POST ${path} HTTP/1.1\r\n${head.map((l) => `${l}\r\n`).join('')}${lines}\r\n${tail}`, { localAddress: ctx.from });
}
/**
 * `text` hand-framed as chunks of `size` characters and the last chunk; no trailer. Each chunk-size field is that piece's
 * UTF-8 byte length (rawRequest writes UTF-8), so a multibyte piece is framed by its bytes; for ASCII a character is a byte.
 * With `finished` false the last chunk is left off: the body never ends (rawRequest never half-closes its socket).
 */
const chunked = (text, size, finished = true) => {
  let out = '';
  for (let i = 0; i < text.length; i += size) {
    const piece = text.slice(i, i + size);
    out += `${Buffer.byteLength(piece).toString(16)}\r\n${piece}\r\n`;
  }
  return finished ? `${out}0\r\n\r\n` : out;
};
/**
 * The request limiter's buckets (every namespace): read as evidence only — every request here spends one unit of it. The
 * figure is approximate (a window that rolls between two reads resets its consumed count), so it is recorded, never asserted.
 */
const limiterSpent = async () => (await owner`select coalesce(sum(consumed), 0)::int as n from tmpos_rate_limit.bucket`)[0].n;

test('IDDH-19 (DSC-09, doc 11 §5 B; M7B-INVOICES-DISCARD-P1-R1): the discard body is bounded at exactly 1 KiB on the real entry over real sockets — a valid discard at exactly 1,024 bytes commits declared and chunked; one byte over and far over is the 413, judged from the declared length before Origin, both CSRF headers, the session and the authorizer, and on the bytes streamed — at the crossing, before the stream ends, in bytes not characters — after the session and the authorizer and before the key; an unsupported Content-Type (before Origin, both CSRF headers and the authorizer), a duplicated one, a missing one with a body (before the session) and any Content-Encoding are the 415; each app-layer refusal (not the HTTP parser 400 for Content-Length beside chunked) answers only { error, requestId }, moves no draft, writes no audit record, outbox row, idempotency record, lease or completion (the request limiter spends its unit), and leaves its key fresh', async (t) => {
  const T = await newTenant('iddh19');
  const S = await newStore(T, 'IDDH19 store');
  const C = await newCustomer(T, 'iddh19');
  const who = await actor('iddh19', [storeGrant(T, S, 'manager')]);
  // The default technician holds Invoices below Manage: the authorizer's 403 (IDDH-02).
  const tech = await actor('iddh19-tech', [storeGrant(T, S, 'technician')]);
  const BOUND = 1024; // INVOICE_DRAFT_DISCARD_MAX_BODY_BYTES, pinned here as a literal
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const sTech = await signIn(ctx, tech);
    const draft = async (label) => seed(ctx, s, S, T, C, [line(described(`bound ${label}`), 1, 1)]);
    const drafts = [];
    for (const label of ['positive', 'positive raw', 'at the bound', 'at the bound chunked', 'charset variant', 'charset spaced', 'key reused', 'victim']) drafts.push(await draft(label));
    const [pos, posRaw, bound, boundChunked, variant, spaced, reuse, victim] = drafts;
    const victimState = await stateOf(victim);
    const path = (id) => `/api/v1/stores/${S}/invoice-drafts/${id}/discard`;
    // Every draft is at version 1, so one body serves each: whitespace is JSON (and adds no key), so padding it before its
    // closing brace reaches any size exactly — the edit suite's padding-at-the-bound pattern.
    const base = JSON.stringify(discardBody(T, 1));
    const pad = (n) => `${base.slice(0, -1)}${' '.repeat(n - Buffer.byteLength(base))}}`;
    const atBound = pad(BOUND);
    const over = pad(BOUND + 1);
    assert.equal(Buffer.byteLength(atBound), BOUND, 'the body at the bound');
    assert.equal(Buffer.byteLength(over), BOUND + 1, 'one byte over');
    assert.deepEqual(JSON.parse(atBound), discardBody(T, 1), 'the padded body is the plain discard body');
    const LAYER = {
      metadata: 'metadata (admitBody: headers only; driven here ahead of Origin, both CSRF headers, the session and the authorizer — its place after the limiter and before the key is app.ts\'s order, not driven here)',
      read: 'bounded read (readBoundedBody: driven here after the session and the authorizer and before the key — its place after the session CSRF, the trusted context and the target is app.ts\'s order, not driven here)',
      session: 'session (before the body is read)',
      authorizer: 'the authorizer (after the session, before the body is read)',
      parser: 'the HTTP parser (before the app: no app header, no log line)',
    };

    /**
     * One refusal, judged whole: its status and exact public body { error, requestId } (a fresh correlator — no X-Request-Id
     * is sent) echoing none of the body, the key, the session's cookie or CSRF token, or any id; the security headers; the one
     * logged reason; the server's own Connection: close when a body was declared (raw requests only — Node's client sends
     * its own); then nothing written for the case's tenant or anywhere (counts: drafts, discarded drafts, lines, discard audit
     * records, draft outbox rows, this key's completions, and every audit record, outbox row, completion and open lease), no
     * idempotency record at all for the key (no lease, no completion), and the target draft exactly as it was, xmin included.
     * `target`/`targetState`: the draft the request names and its snapshot (the victim by default); `session`: whose key.
     */
    const refused = async (st, label, request, { status, error, reason, layer, key = null, close = false, target = victim, targetState = victimState, session = s }) => {
      const keys = key === null ? [] : [{ key, principal: session.principal }];
      const before = await counts([T], keys);
      const spentBefore = await limiterSpent();
      const started = Date.now();
      const reply = await request();
      const elapsedMs = Date.now() - started;
      assertRefusal(reply, status, error, label);
      const body = JSON.parse(reply.body);
      assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `${label}: a fresh correlator`);
      assert.equal(reply.headers['x-request-id'], body.requestId, `${label}: the same correlator in the header`);
      for (const value of [key, session.csrf, session.cookie.slice(session.cookie.indexOf('=') + 1), session.key, T, S, C, target, 'expectedTenant', 'expectedVersion'].filter((v) => v !== null)) {
        assert.ok(!reply.body.includes(value), `${label}: the answer echoes nothing it was sent`);
      }
      assert.equal(ctx.reason(reply), reason, `${label}: the logged reason`);
      if (close) assert.equal(reply.headers.connection, 'close', `${label}: the server closes over the unread body`);
      assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: nothing written`);
      if (key !== null) assert.equal(await recordsOf(key, session.principal), 0, `${label}: no idempotency record — no lease, no completion`);
      assert.deepEqual(await stateOf(target), targetState, `${label}: the draft as it was (status, version, customer, every column and line, xmin)`);
      evidence(st, { case: label, status: reply.status, error: body.error, reason, layer, elapsedMs, limiterUnitsSpent: (await limiterSpent()) - spentBefore });
      return reply;
    };

    await t.test('A: positive controls — a valid discard reaches the route and commits, through Node\'s client and through the raw framing the refusals use', async (st) => {
      let key = randomUUID();
      let before = await counts([T], [{ key, principal: who.principal }]);
      discardedOf(await ctx.discard(s, S, pos, discardBody(T, 1), { key }), { draftId: pos, version: 2 }, 'A1 the plain discard');
      assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), ONE_DISCARD, 'A1: one discard');
      // The raw framing itself admits a valid request (a refusal below cannot pass because the framing is wrong).
      key = randomUUID();
      before = await counts([T], [{ key, principal: who.principal }]);
      const body = JSON.stringify(discardBody(T, 1));
      const reply = await rawUnsafe(ctx, s, path(posRaw), `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`, body, key);
      discardedOf(reply, { draftId: posRaw, version: 2 }, 'A2 the same discard hand-framed');
      assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), ONE_DISCARD, 'A2: one discard');
      evidence(st, { case: 'A', statuses: [200, reply.status] });
    });

    await t.test('B: a declared length over the bound is the 413 from the headers alone — before Origin, both CSRF headers, the session and the authorizer', async (st) => {
      const far = pad(2 * BOUND);
      let key = randomUUID();
      await refused(st, 'B1 a 2,048-byte valid body, honestly declared', () => ctx.discard(s, S, victim, far, { key }),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key });
      key = randomUUID();
      await refused(st, 'B2 Content-Length 1025 and no body byte sent: answered without waiting for the body',
        () => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nContent-Length: 1025\r\n', '', key),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key, close: true });
      key = randomUUID();
      await refused(st, 'B3 no session at all: still the 413, not the 401',
        () => rawUnsafe(ctx, null, path(victim), `Content-Type: application/json\r\nContent-Length: ${far.length}\r\n`, far, key),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key, close: true });
      key = randomUUID();
      await refused(st, 'B4 a cross-site Origin: still the 413, not the 403', () => ctx.discard(s, S, victim, far, { key, headers: { origin: 'https://evil.test' } }),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key });
      key = randomUUID();
      await refused(st, 'B6 neither CSRF header (the pre-session one nor the session\'s): still the 413, not the 403',
        () => rawUnsafe(ctx, s, path(victim), `Content-Type: application/json\r\nContent-Length: ${far.length}\r\n`, far, key, { csrf: false }),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key, close: true });
      key = randomUUID();
      await refused(st, 'B5 the length is judged before the media type: text/plain and 2,048 bytes is the 413',
        () => ctx.discard(s, S, victim, far, { key, headers: { 'content-type': 'text/plain' } }),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key });
      key = randomUUID();
      await refused(st, 'B7 the length is judged before the authorizer: an actor below Invoices Manage declaring 2,048 bytes is the 413, not the 403',
        () => ctx.discard(sTech, S, victim, far, { key }),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key, session: sTech });
    });

    await t.test('C: a chunked body with no Content-Length is admitted and read under the cap — past 1,024 decoded bytes (bytes, not characters) it is the 413 the bounded read settles at the crossing, after the session and the authorizer and before the key, answered within a deadline', async (st) => {
      const stream = pad(4 * BOUND);
      let key = randomUUID();
      await refused(st, 'C1 4,096 bytes in 512-byte chunks (the cap crossed mid-stream)',
        () => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(stream, 512), key),
        { status: 413, error: 'content_too_large', reason: 'body_streamed_too_large', layer: LAYER.read, key, close: true });
      // The refusal comes at the crossing, not after the whole body: three 512-byte chunks (1,536 bytes, the cap crossed in the
      // third) and no last chunk, the socket left open — only a read that refuses mid-stream answers before the deadline.
      key = randomUUID();
      await refused(st, 'C7 1,536 bytes in 512-byte chunks and no last chunk (the stream never ends): the 413 arrives within the deadline',
        () => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(pad(1536), 512, false), key),
        { status: 413, error: 'content_too_large', reason: 'body_streamed_too_large', layer: LAYER.read, key, close: true });
      key = randomUUID();
      await refused(st, 'C8 the authorizer precedes the read: the same stream from an actor below Invoices Manage is the 403, not the 413',
        () => rawUnsafe(ctx, sTech, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(stream, 512), key),
        { status: 403, error: 'forbidden', reason: 'authz_denied', layer: LAYER.authorizer, key, close: true, session: sTech });
      // The cap counts bytes, not characters: 600 two-byte characters in a JSON string put the body under 1,024 characters
      // but over 1,024 bytes; left unfinished, only a read that counts bytes answers (a character count never reaches the cap).
      const multibyte = `${base.slice(0, -1)},"note":"${'\u00e9'.repeat(600)}"}`;
      assert.ok(multibyte.length < BOUND && Buffer.byteLength(multibyte) > BOUND, 'C9: under the bound in characters, over it in bytes');
      key = randomUUID();
      await refused(st, `C9 ${multibyte.length} characters and ${Buffer.byteLength(multibyte)} UTF-8 bytes in 256-character chunks framed by their bytes, no last chunk: the 413 within the deadline`,
        () => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(multibyte, 256, false), key),
        { status: 413, error: 'content_too_large', reason: 'body_streamed_too_large', layer: LAYER.read, key, close: true });
      await refused(st, 'C2 the body is read before the key is judged: no Idempotency-Key at all is still the 413',
        () => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(stream, 512)),
        { status: 413, error: 'content_too_large', reason: 'body_streamed_too_large', layer: LAYER.read, close: true });
      await refused(st, 'C3 a malformed Idempotency-Key is still the 413',
        () => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nIdempotency-Key: abc\r\n', chunked(stream, 512)),
        { status: 413, error: 'content_too_large', reason: 'body_streamed_too_large', layer: LAYER.read, close: true });
      key = randomUUID();
      await refused(st, 'C4 the session precedes the read: the same stream with no session is the 401',
        () => rawUnsafe(ctx, null, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(stream, 512), key),
        { status: 401, error: 'unauthenticated', reason: 'session_missing', layer: LAYER.session, key, close: true });
      key = randomUUID();
      await refused(st, 'C5 a coding beside chunked is refused before any read (the framing is not loosened)',
        () => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: gzip, chunked\r\n', chunked(stream, 512), key),
        { status: 400, error: 'invalid_request', reason: 'transfer_encoding_unsupported', layer: LAYER.metadata, key, close: true });
      // Content-Length beside Transfer-Encoding never reaches the app: Node's strict parser answers its own bounded 400 (no
      // app header, no log line), so only the status and the nothing-written evidence are asserted.
      key = randomUUID();
      const before = await counts([T], [{ key, principal: who.principal }]);
      const parser = await rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n', chunked(stream, 512), key);
      assert.equal(parser.status, 400, `C6 Content-Length and Transfer-Encoding together: ${parser.body}`);
      assert.equal(parser.headers['x-request-id'], undefined, 'C6: answered before the app');
      assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), NOTHING, 'C6: nothing written');
      assert.equal(await recordsOf(key, who.principal), 0, 'C6: no idempotency record');
      assert.deepEqual(await stateOf(victim), victimState, 'C6: the draft as it was');
      evidence(st, { case: 'C6 Content-Length and Transfer-Encoding together', status: parser.status, layer: LAYER.parser });
    });

    await t.test('D: the media type — anything but application/json (optionally ;charset=utf-8, case-insensitive, a space allowed before it) is the 415 from the headers alone, before Origin, both CSRF headers, the session and the authorizer; an absent type with no body is the 400 body_required', async (st) => {
      const valid = JSON.stringify(discardBody(T, 1));
      const unsupported = { status: 415, error: 'unsupported_media_type', layer: LAYER.metadata };
      for (const [label, type] of [
        ['D1 text/plain', 'text/plain'],
        ['D2 another charset', 'application/json; charset=latin1'],
        ['D3 a quoted charset', 'application/json; charset="utf-8"'],
        ['D4 an extra parameter', 'application/json; charset=utf-8; x=y'],
        ['D5 a longer subtype', 'application/jsonx'],
      ]) {
        const key = randomUUID();
        await refused(st, label, () => ctx.discard(s, S, victim, valid, { key, headers: { 'content-type': type } }), { ...unsupported, reason: 'media_type_unsupported', key });
      }
      let key = randomUUID();
      await refused(st, 'D12 text/plain with a cross-site Origin: still the 415, not the 403',
        () => ctx.discard(s, S, victim, valid, { key, headers: { 'content-type': 'text/plain', origin: 'https://evil.test' } }), { ...unsupported, reason: 'media_type_unsupported', key });
      key = randomUUID();
      await refused(st, 'D13 text/plain with a valid session and neither CSRF header: still the 415, not the 403',
        () => rawUnsafe(ctx, s, path(victim), `Content-Type: text/plain\r\nContent-Length: ${valid.length}\r\n`, valid, key, { csrf: false }),
        { ...unsupported, reason: 'media_type_unsupported', key, close: true });
      key = randomUUID();
      await refused(st, 'D14 text/plain from an actor below Invoices Manage: still the 415, not the 403',
        () => ctx.discard(sTech, S, victim, valid, { key, headers: { 'content-type': 'text/plain' } }), { ...unsupported, reason: 'media_type_unsupported', key, session: sTech });
      key = randomUUID();
      await refused(st, 'D6 two Content-Type lines, both application/json',
        () => rawUnsafe(ctx, s, path(victim), `Content-Type: application/json\r\nContent-Type: application/json\r\nContent-Length: ${valid.length}\r\n`, valid, key),
        { ...unsupported, reason: 'media_type_unsupported', key, close: true });
      key = randomUUID();
      await refused(st, 'D7 no Content-Type line with a body',
        () => rawUnsafe(ctx, s, path(victim), `Content-Length: ${valid.length}\r\n`, valid, key),
        { ...unsupported, reason: 'media_type_missing', key, close: true });
      key = randomUUID();
      await refused(st, 'D8 no Content-Type and no session: still the 415, not the 401',
        () => rawUnsafe(ctx, null, path(victim), `Content-Length: ${valid.length}\r\n`, valid, key),
        { ...unsupported, reason: 'media_type_missing', key, close: true });
      key = randomUUID();
      await refused(st, 'D9 a Content-Encoding (gzip) over a plain JSON body', () => ctx.discard(s, S, victim, valid, { key, headers: { 'content-encoding': 'gzip' } }),
        { ...unsupported, reason: 'content_encoding_unsupported', key });
      key = randomUUID();
      await refused(st, 'D10 no Content-Type and Content-Length 0: no body, so the 400 body_required (not a 415)',
        () => rawUnsafe(ctx, s, path(victim), 'Content-Length: 0\r\n', '', key),
        { status: 400, error: 'invalid_request', reason: 'body_required', layer: LAYER.metadata, key });
      // The supported type's own variants — no space and an upper-case charset (D11), a space before the charset (D15) — are
      // admitted, and each discard commits on its own draft.
      key = randomUUID();
      const before = await counts([T], [{ key, principal: who.principal }]);
      discardedOf(await ctx.discard(s, S, variant, valid, { key, headers: { 'content-type': 'application/json;charset=UTF-8' } }), { draftId: variant, version: 2 }, 'D11 application/json;charset=UTF-8');
      assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), ONE_DISCARD, 'D11: one discard');
      key = randomUUID();
      const beforeSpaced = await counts([T], [{ key, principal: who.principal }]);
      discardedOf(await ctx.discard(s, S, spaced, valid, { key, headers: { 'content-type': 'application/json; charset=utf-8' } }), { draftId: spaced, version: 2 }, 'D15 application/json; charset=utf-8');
      assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), beforeSpaced), ONE_DISCARD, 'D15: one discard');
    });

    await t.test('E: the exact boundary — a valid discard of exactly 1,024 bytes commits, declared and chunked; 1,025 bytes is the 413, declared and chunked, on its own key, nothing changed', async (st) => {
      let key = randomUUID();
      let before = await counts([T], [{ key, principal: who.principal }]);
      discardedOf(await ctx.discard(s, S, bound, atBound, { key }), { draftId: bound, version: 2 }, 'E1 1,024 bytes declared');
      assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), ONE_DISCARD, 'E1: one discard');
      key = randomUUID();
      before = await counts([T], [{ key, principal: who.principal }]);
      const reply = await rawUnsafe(ctx, s, path(boundChunked), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(atBound, 256), key);
      discardedOf(reply, { draftId: boundChunked, version: 2 }, 'E2 1,024 bytes chunked');
      assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), ONE_DISCARD, 'E2: one discard');
      key = randomUUID();
      await refused(st, 'E3 1,025 bytes declared', () => ctx.discard(s, S, victim, over, { key }),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key });
      key = randomUUID();
      await refused(st, 'E4 1,025 bytes chunked (256-byte chunks)',
        () => rawUnsafe(ctx, s, path(victim), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(over, 256), key),
        { status: 413, error: 'content_too_large', reason: 'body_streamed_too_large', layer: LAYER.read, key, close: true });
    });

    await t.test('F: a key refused at the boundary stays fresh — after a declared and a streamed 413 under it, the same key with a valid body discards (not a replay, not the 409 request_in_progress, not the 422)', async (st) => {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const reuseState = await stateOf(reuse);
      await refused(st, 'F1 declared 1,025 bytes under the key', () => ctx.discard(s, S, reuse, over, { key }),
        { status: 413, error: 'content_too_large', reason: 'body_declared_too_large', layer: LAYER.metadata, key, target: reuse, targetState: reuseState });
      await refused(st, 'F2 the same key, 1,025 bytes chunked',
        () => rawUnsafe(ctx, s, path(reuse), 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n', chunked(over, 256), key),
        { status: 413, error: 'content_too_large', reason: 'body_streamed_too_large', layer: LAYER.read, key, close: true, target: reuse, targetState: reuseState });
      const before = await counts([T], keys);
      discardedOf(await ctx.discard(s, S, reuse, discardBody(T, 1), { key }), { draftId: reuse, version: 2 }, 'F3 the same key, a valid body');
      assert.deepEqual(delta(await counts([T], keys), before), ONE_DISCARD, 'F3: one discard, its completion under the key');
      assert.equal(await recordsOf(key, who.principal), 1, 'F3: the key now holds exactly its completion');
      assert.equal(await leaseOpen(key, who.principal), false, 'F3: and no open lease');
    });

    assert.deepEqual(await stateOf(victim), victimState, 'every refusal left the target draft as it was');
  });
});

// ===========================================================================
// IDDH-18: the logs (last)
// ===========================================================================

test('IDDH-18 (DSC-22; it passes on the entry sources too): no log line carries a description, a customer, a draft, a tenant or store id, a session key, a CSRF token or an Idempotency-Key — nor does the server log of a cluster this file started', () => {
  const forbidden = [...SECRETS, ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)])];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const l of ALL_LOG_LINES) for (const secret of forbidden) assert.ok(!l.includes(secret), `a log line carries a secret: ${secret.slice(0, 6)}...`);
  if (cluster !== null) {
    const leaked = forbidden.filter((v) => readFileSync(`${cluster.root}/postgres.log`, 'utf8').includes(v));
    assert.deepEqual(leaked.map((v) => v.slice(0, 6)), [], 'the cluster\'s server log carries no secret');
  }
});
