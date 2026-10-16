// Phase 4.0 M7B-INVOICES-P1 — store-owned invoice drafts END TO END: the tenant entry (server/entry/tenantEntry.ts,
// startTenantEntry) saving, listing and reopening drafts over REAL loopback HTTP and a disposable PostgreSQL holding every
// migration in the directory (001-034), composed exactly as server/entry/tenantMain.ts composes it but for its construction.
// The route module (server/runtime/invoiceDrafts.ts), the store-scope authorizer and revalidator, the tenant command
// transaction, the mutator and reads (server/persistence/postgresInvoiceDrafts.ts), migration 028's routines, the audit
// writer (subject_invoice_draft_id) and the outbox enqueue are production's own code.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — tests/db/customerEditHttp.integration.test.mjs's three, none on the path under test:
// the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime LOGIN, tmpos_idh_probe,
// holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can drop a COMMIT's answer or the
// COMMIT itself), the identity verifier (a synthetic bearer-token map) and the listener (127.0.0.1:0). Lease expiry is moved
// by the OWNER on the idempotency row (a test-only lever; the runtime has no such control).
//
// WHAT IS PROVEN (each test's title carries the acceptance criteria it evidences; D/L/A/O/K are the drafts, lines, draft
// audit records, outbox events and sealed completions a case's own tenants and keys hold, read by the OWNER as deltas).
//   IDH-01 (AC-01 AC-07) save, list and reopen across two tenant entries over one database, and after one is restarted.
//   IDH-02 (AC-02) another store of the tenant, another tenant's store, a missing store and a non-canonical segment are one
//          403 for list, get and save, writing nothing; a foreign draft through the actor's own store is the missing id's 404.
//   IDH-03 (AC-03) the owner's own PUT /api/v1/roles/levels edits the Invoices (and Customers) levels and the draft routes
//          follow them, both directions (DA-184's HTTP witness): the save, the list, and the reopen (a technician at its
//          default View reopens a draft; at None the reopen is the list's 403; back at View it reopens the same draft).
//   IDH-04 (AC-04) a store owner's Full stops at the store it holds a grant at; a tenant-only owner reaches no store route.
//   IDH-05 (AC-05) a missing and another tenant's customer: byte-identical sealed 422s, each writing only its completion, each
//          replayed under its key.
//   IDH-06 (AC-06) ordered lines, USD cents and the subtotal (to 2^53 - 1) survive; every invalid body is the 400 writing
//          nothing; a body over 64 KiB is the 413.
//   IDH-07 (AC-08) an injected fault at the line insert, the audit insert, the outbox enqueue or the completion leaves no
//          draft, line, audit record or event; the lease stays (409 within it).
//   IDH-08 (AC-09) concurrent identical saves across two instances: one draft and exactly one fresh 201, every other answer
//          that 201 replayed, in progress (409) or unavailable while it commits (503, design R9; customerCreate's M7CC-06
//          set); a changed body under the key is the 422 before any write.
//   IDH-09 (AC-10) a level narrowing, a grant suspension, a store grant DELETED, a session revocation, an account
//          suspension, a tenant suspended or made read-only and a store suspension committed while the save waits on 016's
//          hold leave nothing (no draft, line, audit record, event or completion; the lease left open); each attempted while
//          the save holds its locks is seen waiting on a lock the save holds (pg_stat_activity: a Lock wait, the save's
//          backend among its blockers — never a sleep), and applies only after the save commits.
//   IDH-10 (AC-11) the COMMIT lands and its answer is lost: 503, the draft whole, the same-key retry replays — and only under
//          current authority; the COMMIT never lands: 503, nothing, 409 until the lease expires, then one new draft.
//   IDH-11 (AC-12) pages of 20 by default and at most 50, equal creation times walked without loss or repeat, the cursor
//          only behind a full page, and an unknown, foreign or malformed cursor the same 400 body length.
//   IDH-13 (AC-02 AC-05) a save whose expectedTenant is not the store's tenant is the pinned UNSEALED 409 write_conflict:
//          nothing written — no draft, line, audit, event or role row — and no completion, the lease left open (a same-key
//          retry is 409 request_in_progress, never a replayed 409).
//   IDH-14 (AC-01 AC-10) a read_only and an overdue account, tenant and store, on a session established after the change:
//          discovery marks the store read-only, the list and the reopen answer the existing draft (200), the save is the
//          authorizer's 403 before any key is acquired, writing nothing.
//   IDH-15 (M7B-INVOICES-P1-R2: DA-201 AC-10 AC-11) GET .../invoice-drafts/eligibility over real 028 equals the save's own
//          authorization, case by case: store_owner, manager and sales_staff at their defaults, technician at its default
//          View, and owner-edited levels (Invoices lowered below Create, Customers lowered below View, technician raised to
//          Create; the owner has no editable level): eligibility is the exact 200 { "eligibility": "allowed" } iff a real POST is
//          201, and the 403 iff that POST is the authorizer's 403 writing no business row (no draft, line, audit, outbox,
//          completion, lease or role-level row); an edit committed while the session lives moves both, both directions.
//   IDH-16 (DA-201 AC-09 AC-10 AC-11) a technician grant at the store, standing in for an account whose browser-only
//          custom role claims Invoices Full (the browser side is slice B2's, SDB-07): eligibility and the direct POST are
//          both 403 writing no business row; another store of the tenant, another tenant's store, a missing store and
//          non-canonical or braced segments are one 403 whose body differs only in requestId — the same as the
//          technician's.
//   IDH-17 (DA-201 AC-11) a read_only and an overdue account, tenant and store, on a session established after the change:
//          the list still answers (200), eligibility is the 403 and so is the save; and a session established BEFORE a
//          tenant is made read_only is ended on its next request (eligibility, list and save each the 401, no business row),
//          while a session established afterwards lists (200) and is refused eligibility (403).
//   IDH-18 (DA-201 AC-12) the chain around eligibility: 401 without a session, the session CSRF witness (missing or
//          another session's token) the same 403, any query the 400, the administrative host and a POST the 404, no-store on
//          every answer; the request limit's 300 eligibility answers from one client write no business row (drafts, lines,
//          audit records, outbox events, completions, leases and role-level rows unchanged) and the 301st is its 429 with
//          Retry-After. The limiter's window opens at the client's first request, so the 300 must land within 60 s: measured
//          about 3.8 s locally (a margin of roughly 56 s; the assertion reports the elapsed time if a slow runner ever eats it).
//   IDH-12 the chain's order and headers: 401, the CSRF witnesses, no-store; no log line carries a description, a customer,
//          a draft, a session key or an Idempotency-Key (run last, over every case's log lines).
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Synthetic data only, every id
// and key made at run time. Its committed saves write draft audit records, which block 028's rollback: on a shared service it
// runs after every step that rolls 028 back, and before it finishes it removes every draft, line and Invoices lock anchor of
// its tenants and clears every audit subject naming one of its drafts (an owner transaction lifting 002's append-only
// trigger, then restoring it — customerEdit's technique), with its sessions, mint-ledger rows, idempotency records, proof
// schema and login, and restores the limiter fingerprint and issuer key row it found.
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
import { SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { RATE_LIMITS } from '../../server/runtime/rateLimit.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring, IDEMPOTENCY_POLICY } from '../../server/runtime/idempotency.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';
import { PORT_DEADLINE_MS } from '../../server/runtime/deadline.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'idh-migrator', runtimeRef: 'idh-runtime' };
const LOCK_KEY = 528_529;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_idh_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** The audit action of a save (the command contract's kind), pinned here as a literal. */
const ACTION = 'store.invoice_draft.create';
const MAX = 9007199254740991;
const WAIT_MS = 10_000;
const SEND_TIMEOUT_MS = 20_000;
/** The revalidator's first lock: 016's hold of the actor's standing. */
const AT_HOLD = /m5_hold_tenant_standing/;
/**
 * The create routine's statement: where a save waits for the customer row (after every authority lock). Since migration 031
 * (M7B-INVOICES-P1-R3) the adapter calls the guarded save in 030's schema; since migration 032 (M7B-INVOICES-P1-R4) that is
 * its version-3 routine, so that is the statement the barrier names.
 */
const AT_CREATE = /tmpos_invoice_edit\.m7b_invoice_draft_create_v3\(/;
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });
const MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
assert.equal(IDEMPOTENCY_POLICY.leaseMs, 60_000, 'the idempotency lease the in-progress cases rely on');
assert.ok(COMMAND_TRANSACTION_DEADLINE_MS <= PORT_DEADLINE_MS);
assert.ok(PORT_DEADLINE_MS * 4 <= SEND_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('IDH');
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

/** R8: every draft, line and Invoices lock anchor of this suite's tenants, and every audit subject naming one of its drafts. */
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
    await step(() => owner.unsafe('drop schema if exists idh_proof cascade'));
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
      await step(() => owner`delete from tmpos_internal.outbox_event where event_type = 'invoice_draft.created'
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
      assert.deepEqual({ ...state }, { drafts: 0, lines: 0, subjects: 0, anchors: 0 }, 'R8: nothing of this suite blocks 028\'s rollback');
    });
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IDH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'IDH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster; a trap may drop a COMMIT's answer, or the COMMIT itself
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket' ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) } : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-idh-relay-'));
  const pairs = new Set();
  const state = { pairs, trap: null };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); }, audited: false, silenced: false };
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
const AUDIT_INSERT_TEXT = Buffer.from('insert into public.audit_event');
const COMMIT_PARSE = Buffer.from('\0commit\0');
/**
 * Arm `relay` for the first connection that sends the audit INSERT: at its next COMMIT, `mode` 'lose' forwards the COMMIT
 * (the server commits) and drops every byte of the answer; 'cut' keeps the COMMIT from the server and severs the connection
 * (the server rolls back). release() disarms the trap and cuts a silenced connection.
 */
function trapCommit(relay, mode) {
  const hit = [];
  const carry = Math.max(AUDIT_INSERT_TEXT.length, COMMIT_PARSE.length) - 1;
  relay.state.trap = (pair, chunk) => {
    const window = pair.tail === undefined ? chunk : Buffer.concat([pair.tail, chunk]);
    pair.tail = window.subarray(Math.max(0, window.length - carry));
    let from = 0;
    const audit = pair.audited ? -1 : window.indexOf(AUDIT_INSERT_TEXT);
    if (audit !== -1) {
      pair.audited = true;
      from = audit + AUDIT_INSERT_TEXT.length;
      pair.tail = window.subarray(Math.max(from, window.length - carry));
    }
    if (pair.audited && window.indexOf(COMMIT_PARSE, from) !== -1) {
      hit.push(pair);
      relay.state.trap = null;
      if (mode === 'cut') return 'cut';
      pair.silenced = true;
    }
    return 'pass';
  };
  return { hit, release: () => { relay.state.trap = null; for (const pair of hit) pair.cut(); } };
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
  await owner.unsafe('drop schema if exists idh_proof cascade');
  await owner.unsafe('create schema idh_proof');
  await owner.unsafe('revoke all on schema idh_proof from public');
  await owner.unsafe('create sequence idh_proof.fired');
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
    type: 'service_account', project_id: 'idh-test-project', client_email: 'idh-test@idh-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`idh-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  SECRETS.add(id);
  return id;
}
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${`${name} ${SUFFIX}`}, ${status}) returning store_id`)[0].store_id;
async function newCustomer(tenant, label) {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IDH ${label} ${SUFFIX}`})`;
  SECRETS.add(id);
  return id;
}
async function actor(label, memberships, status = 'active') {
  const uid = `idh-${label}-${SUFFIX}`;
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
  const text = `IDH ${label} ${SUFFIX}`;
  SECRETS.add(text);
  return text;
}
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const bodyOf = (tenant, customer, lines, over = {}) => ({ expectedTenant: tenant, customerId: customer, currency: 'USD', lines, ...over });

/** What a case's tenants hold now: drafts, lines, draft audit records, draft events; and the sealed completions of its keys. */
async function counts(tenants, keys = []) {
  const scopes = keys.map(({ key, principal }) => scopeOf(key, principal));
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as d,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as l,
    (select count(*) from public.audit_event where action_id = ${ACTION} and tenant_id = any(${tenants}::uuid[]))::int as a,
    (select count(*) from tmpos_internal.outbox_event where event_type = 'invoice_draft.created'
      and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = any(${tenants}::uuid[])))::int as o,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k`;
  return { D: r.d, L: r.l, A: r.a, O: r.o, K: r.k };
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const NOTHING = Object.freeze({ D: 0, L: 0, A: 0, O: 0, K: 0 });
/**
 * Everything a draft save, a refused one or an eligibility answer could write (M7B-INVOICES-P1-R2), read by the OWNER: the
 * tenants' drafts and lines, EVERY audit record and outbox event, every sealed completion and every open lease, and the
 * tenants' role-level rows (028's lock anchors included) as one text — the suite's cases run one at a time.
 */
async function footprint(tenants) {
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as drafts,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as lines,
    (select count(*) from public.audit_event)::int as audit,
    (select count(*) from tmpos_internal.outbox_event)::int as outbox,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as completions,
    (select count(*) from tmpos_internal.idempotency_record where response is null)::int as leases,
    (select coalesce(string_agg(l.tenant_id::text || ' ' || l.role_id || ' ' || l.domain || ' ' || coalesce(l.level, '-') || ' ' || l.updated_at::text, ','
      order by l.tenant_id, l.role_id, l.domain), '') from tmpos_role.tenant_role_level l where l.tenant_id = any(${tenants}::uuid[])) as roles`;
  return { ...r };
}
/** An eligibility answer as its verdict: the exact closed 200 is 'allowed', the chain's 403 'forbidden'; anything else fails. */
function eligibilityOf(reply, label) {
  assert.equal(reply.headers['cache-control'], 'no-store', `${label}: no-store`);
  assertBaseline(reply, label);
  if (reply.status === 200) {
    assert.equal(reply.body, '{"eligibility":"allowed"}', `${label}: exactly the closed positive body`);
    return 'allowed';
  }
  assertRefusal(reply, 403, 'forbidden', label);
  return 'forbidden';
}

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
  const ctx = {
    relay, port, lines, stop,
    read: (s, path, headers = {}) => send(port, 'GET', path,
      { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers }, undefined, { localAddress: from }),
    list: (s, store, query = '') => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts${query}`),
    get: (s, store, id) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/${id}`),
    /** GET the save's creation eligibility at `store` (M7B-INVOICES-P1-R2), with `query` appended verbatim. */
    eligibility: (s, store, { query = '', headers = {} } = {}) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/eligibility${query}`, headers),
    /** POST a draft at `store` presenting `s`, under a fresh Idempotency-Key unless one is given. */
    save: (s, store, body, { key = randomUUID(), headers = {} } = {}) => {
      SECRETS.add(key);
      if (s?.principal !== undefined) USED_KEYS.push({ key, principal: s.principal });
      return send(port, 'POST', `/api/v1/stores/${store}/invoice-drafts`, {
        host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
        ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), 'idempotency-key': key, ...headers,
      }, typeof body === 'string' ? body : JSON.stringify(body), { localAddress: from });
    },
    put: (s, body, key = randomUUID()) => {
      USED_KEYS.push({ key, principal: s.principal });
      return send(port, 'PUT', '/api/v1/roles/levels', {
        host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
        cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf, 'idempotency-key': key,
      }, JSON.stringify(body), { localAddress: from });
    },
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
  SECRETS.add(csrf).add(cookie.slice(cookie.indexOf('=') + 1)).add(key);
  return { cookie, csrf, key, principal: who.principal };
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
  SECRETS.add(body.draft.id);
  return body.draft.id;
}
/** A reopened draft: exactly the get's shape, every amount exact. */
function draftOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assert.match(reply.headers['cache-control'] ?? '', /no-store/, `${label}: no-store`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['draft'], label);
  assert.deepEqual(Object.keys(body.draft), ['id', 'storeId', 'customerId', 'status', 'currency', 'version', 'createdAt', 'subtotalCents', 'lines'], label);
  assert.match(body.draft.createdAt, MICROS, `${label}: microseconds`);
  return body.draft;
}
function pageOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assert.match(reply.headers['cache-control'] ?? '', /no-store/, `${label}: no-store`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['drafts', 'nextCursor'], label);
  for (const d of body.drafts) assert.deepEqual(Object.keys(d), ['id', 'customerId', 'status', 'currency', 'lineCount', 'subtotalCents', 'createdAt'], label);
  return body;
}

// ---------------------------------------------------------------------------
// levers (customerEditHttp's)
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
const TRIGGER_ACTIONS = Object.freeze({ raise: `raise exception 'IDH injected fault' using errcode = 'P0001';` });
async function withTrigger(table, event, when, action, work) {
  await owner.unsafe(`create function idh_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('idh_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function idh_proof.fire() from public');
  await owner.unsafe(`create trigger idh_fire before ${event} on ${table} for each row when (${when}) execute function idh_proof.fire()`);
  try { return await work(); } finally {
    await owner.unsafe(`drop trigger if exists idh_fire on ${table}`);
    await owner.unsafe('drop function if exists idh_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('idh_proof.fired'::regclass), 0)::int as n`)[0].n;
/** Ends `key`'s lease now (the OWNER's lever on the idempotency row: the runtime has no such control). */
const expireLease = (key, principal) => owner`update tmpos_internal.idempotency_record set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where scope = ${scopeOf(key, principal)} and response is null`;

// ===========================================================================
// IDH-01: two instances and a restart
// ===========================================================================

test('IDH-01 (AC-01 AC-07): a store manager saves on one tenant entry; a second entry over the same database lists and reopens it; after a restart a fresh entry still does — every read from the database alone', async () => {
  const T = await newTenant('idh01');
  const S = await newStore(T, 'IDH01 store');
  const C = await newCustomer(T, 'idh01');
  const who = await actor('idh01', [storeGrant(T, S, 'manager')]);
  const lines = [line(described('screen'), 1, 12_999), line(described('labour  hour'), 2, 4_500), line(`${described('glass')} ${String.fromCodePoint(0x1f4f1)}`, 3, 0)];
  let id;
  let first;
  await withEntry((a) => withEntry(async (b) => {
    const sa = await signIn(a, who);
    const stores = await a.read(sa, '/api/v1/stores');
    assert.deepEqual(JSON.parse(stores.body), { stores: [{ id: S, tenantId: T, name: `IDH01 store ${SUFFIX}`, readOnly: false }] }, 'discovery names the store and its tenant');
    const before = await counts([T]);
    id = createdOf(await a.save(sa, S, bodyOf(T, C, lines)), S, { lineCount: 3, subtotalCents: 21_999 }, 'the save on entry A');
    assert.deepEqual(delta(await counts([T]), before), { D: 1, L: 3, A: 1, O: 1, K: 0 }, 'one draft, three lines, one audit record, one event');
    first = draftOf(await a.get(sa, S, id), 'reopened on A');
    assert.deepEqual({ ...first, createdAt: undefined }, {
      id, storeId: S, customerId: C, status: 'draft', currency: 'USD', version: 1, createdAt: undefined, subtotalCents: 21_999,
      lines: lines.map((l, i) => ({ position: i + 1, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.quantity * l.unitPriceCents })),
    });
    const sb = await signIn(b, who);
    assert.deepEqual(draftOf(await b.get(sb, S, id), 'reopened on B'), first, 'the second instance reads the same draft');
    assert.deepEqual(pageOf(await b.list(sb, S), 'listed on B'), { drafts: [{ id, customerId: C, status: 'draft', currency: 'USD', lineCount: 3, subtotalCents: 21_999, createdAt: first.createdAt }], nextCursor: null });
    // The audit record: the store scope, its tenant and store, the actor, the draft as subject, metadata {} and no description.
    const [audit] = await owner`select scope_type, tenant_id, store_id, actor_internal_user_id, required_permission, subject_invoice_draft_id, subject_customer_id,
        metadata::text as metadata, request_id from public.audit_event where subject_invoice_draft_id = ${id}`;
    assert.deepEqual({ ...audit, request_id: undefined }, { scope_type: 'store', tenant_id: T, store_id: S, actor_internal_user_id: who.id,
      required_permission: 'create_invoice_drafts', subject_invoice_draft_id: id, subject_customer_id: null, metadata: '{}', request_id: undefined });
    const [event] = await owner`select event_type, event_version, aggregate_type, aggregate_id, aggregate_version::int as v, payload, tenant_digest, store_digest, actor_digest,
        correlation_id::text as correlation from tmpos_internal.outbox_event where aggregate_id = ${id}`;
    assert.deepEqual({ ...event, correlation: undefined }, { event_type: 'invoice_draft.created', event_version: 1, aggregate_type: 'invoice_draft', aggregate_id: id, v: 1,
      payload: { storeId: S, customerId: C, lineCount: 3 }, tenant_digest: null, store_digest: null, actor_digest: null, correlation: undefined },
      'identifiers and a count; the envelope names no tenant, store or actor');
    assert.equal(event.correlation, audit.request_id, 'one correlation for the audit record and the event');
  }));
  // A restart: the first two entries are gone; a fresh process over the same database.
  await withEntry(async (c) => {
    const sc = await signIn(c, who);
    assert.deepEqual(draftOf(await c.get(sc, S, id), 'reopened after the restart'), first);
    assert.equal(pageOf(await c.list(sc, S), 'listed after the restart').drafts.length, 1);
  });
});

// ===========================================================================
// IDH-02..04: authority
// ===========================================================================

test('IDH-02 (AC-02): another store of the tenant, another tenant\'s store, a missing store and a non-canonical segment are one 403 for list, get and save, writing nothing; a foreign draft is the missing id\'s 404', async () => {
  const T = await newTenant('idh02');
  const T2 = await newTenant('idh02-other');
  const S1 = await newStore(T, 'IDH02 one');
  const S2 = await newStore(T, 'IDH02 two');
  const S3 = await newStore(T2, 'IDH02 other');
  const C = await newCustomer(T, 'idh02');
  const C2 = await newCustomer(T2, 'idh02-other');
  const who = await actor('idh02', [storeGrant(T, S1, 'manager')]);
  const other = await actor('idh02-other', [storeGrant(T2, S3, 'manager')]);
  const sibling = await actor('idh02-sibling', [storeGrant(T, S2, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const own = createdOf(await ctx.save(s, S1, bodyOf(T, C, [line(described('own'), 1, 100)])), S1, { lineCount: 1, subtotalCents: 100 }, 'own store');
    const foreign = createdOf(await ctx.save(await signIn(ctx, other), S3, bodyOf(T2, C2, [line(described('foreign'), 1, 1)])), S3, { lineCount: 1, subtotalCents: 1 }, 'another tenant');
    const siblingDraft = createdOf(await ctx.save(await signIn(ctx, sibling), S2, bodyOf(T, C, [line(described('sibling'), 1, 1)])), S2, { lineCount: 1, subtotalCents: 1 }, 'the other store');
    const keys = [];
    const before = await counts([T, T2]);
    for (const [label, store, tenant, customer] of [
      ['the tenant\'s other store', S2, T, C], ['another tenant\'s store', S3, T2, C2], ['a missing store', randomUUID(), T, C],
      ['a non-canonical segment', S1.toUpperCase(), T, C], ['a braced segment', `{${S1}}`, T, C],
    ]) {
      assertRefusal(await ctx.list(s, store), 403, 'forbidden', `${label}: list`);
      assertRefusal(await ctx.get(s, store, own), 403, 'forbidden', `${label}: get`);
      const key = randomUUID();
      keys.push({ key, principal: who.principal });
      assertRefusal(await ctx.save(s, store, bodyOf(tenant, customer, [line(described(`refused ${label}`), 1, 1)]), { key }), 403, 'forbidden', `${label}: save`);
    }
    assert.deepEqual(delta(await counts([T, T2]), before), NOTHING, 'every refusal wrote nothing');
    const [{ n }] = await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = any(${keys.map((k) => scopeOf(k.key, k.principal))}::text[])`;
    assert.equal(n, 0, 'refused by the authorizer before any key was acquired');
    // A foreign draft through the actor's own store, a sibling store's draft and a missing id: one 404, one shape.
    const replies = [await ctx.get(s, S1, foreign), await ctx.get(s, S1, siblingDraft), await ctx.get(s, S1, randomUUID())];
    for (const [i, r] of replies.entries()) assertRefusal(r, 404, 'not_found', `foreign ${i}`);
    assert.equal(new Set(replies.map((r) => r.body.length)).size, 1, 'equal body lengths');
    assert.ok(!pageOf(await ctx.list(s, S1), 'own list').drafts.some((d) => d.id === foreign || d.id === siblingDraft), 'the list holds only its own store\'s drafts');
    assertRefusal(await ctx.get(s, S1, own.toUpperCase()), 400, 'invalid_request', 'a non-canonical draft id (after authorization)');
  });
});

test('IDH-03 (AC-03): the owner\'s own PUT /api/v1/roles/levels edits the Invoices and Customers levels, and the save, the list and the reopen follow, both directions (DA-184 HTTP witness)', async () => {
  const T = await newTenant('idh03');
  const S = await newStore(T, 'IDH03 store');
  const C = await newCustomer(T, 'idh03');
  const boss = await actor('idh03-owner', [tenantGrant(T, 'store_owner')]);
  const tech = await actor('idh03-tech', [storeGrant(T, S, 'technician')]);
  const sales = await actor('idh03-sales', [storeGrant(T, S, 'sales_staff')]);
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, boss);
    const st = await signIn(ctx, tech);
    const ss = await signIn(ctx, sales);
    const level = async (domain, roleId, value) => {
      const states = JSON.parse((await ctx.read(so, `/api/v1/roles/levels${domain === 'invoices' ? '/invoices' : ''}`)).body).roles;
      const version = states.find((r) => r.roleId === roleId).version;
      const reply = await ctx.put(so, { roleId, domain, level: value, reason: `IDH03 sets ${roleId} ${domain} to ${value}`, expectedTenant: T, expectedVersion: version });
      assert.equal(reply.status, 200, `the owner's edit ${roleId} ${domain} ${value}: ${reply.body}`);
    };
    const body = () => bodyOf(T, C, [line(described('idh03'), 1, 10)]);
    // A draft for the technician to reopen, saved by sales_staff at its default Create before any edit.
    const seed = createdOf(await ctx.save(ss, S, body()), S, { lineCount: 1, subtotalCents: 10 }, 'the seed: sales_staff default Create');
    const reopened = draftOf(await ctx.get(st, S, seed), 'technician default: View reopens');
    assert.deepEqual([reopened.id, reopened.storeId, reopened.customerId, reopened.subtotalCents, reopened.lines.length], [seed, S, C, 10, 1]);
    assert.equal((await ctx.list(st, S)).status, 200, 'technician default: View lists');
    assertRefusal(await ctx.save(st, S, body()), 403, 'forbidden', 'technician default: no Create');
    await level('invoices', 'technician', 'create');
    createdOf(await ctx.save(st, S, body()), S, { lineCount: 1, subtotalCents: 10 }, 'the owner raised technician Invoices to Create');
    await level('customers', 'technician', 'none');
    assertRefusal(await ctx.save(st, S, body()), 403, 'forbidden', 'Customers None: the corequisite refuses the save');
    assert.equal((await ctx.list(st, S)).status, 200, 'the read stands');
    createdOf(await ctx.save(ss, S, body()), S, { lineCount: 1, subtotalCents: 10 }, 'sales_staff default: Create');
    await level('invoices', 'sales_staff', 'view');
    assertRefusal(await ctx.save(ss, S, body()), 403, 'forbidden', 'the owner lowered sales_staff Invoices to View');
    assert.equal((await ctx.list(ss, S)).status, 200);
    await level('invoices', 'sales_staff', 'none');
    assertRefusal(await ctx.list(ss, S), 403, 'forbidden', 'and to None: no list');
    await level('invoices', 'sales_staff', 'create');
    createdOf(await ctx.save(ss, S, body()), S, { lineCount: 1, subtotalCents: 10 }, 'and back up: saves again');
    // The reopen, both directions: the owner takes the technician's Invoices level to None — the reopen is the list's own 403 —
    // and back to View, where the same draft reopens exactly as before.
    await level('invoices', 'technician', 'none');
    const closed = [await ctx.get(st, S, seed), await ctx.list(st, S)];
    assertRefusal(closed[0], 403, 'forbidden', 'technician Invoices None: no reopen');
    assertRefusal(closed[1], 403, 'forbidden', 'technician Invoices None: no list');
    const { requestId: _reopenId, ...reopenRefusal } = JSON.parse(closed[0].body);
    const { requestId: _listId, ...listRefusal } = JSON.parse(closed[1].body);
    assert.deepEqual(reopenRefusal, listRefusal, 'the reopen\'s refusal body equals the list\'s in every field but requestId');
    await level('invoices', 'technician', 'view');
    assert.deepEqual(draftOf(await ctx.get(st, S, seed), 'technician back to View: reopens again'), reopened, 'the same draft, exactly');
    assert.equal((await ctx.list(st, S)).status, 200, 'and lists again');
  });
});

test('IDH-04 (AC-04): a store owner\'s Full stops at the store it holds a grant at; a tenant-only owner reaches no store route and discovers no store; a custom role cannot be a membership', async () => {
  const T = await newTenant('idh04');
  const S1 = await newStore(T, 'IDH04 one');
  const S2 = await newStore(T, 'IDH04 two');
  const C = await newCustomer(T, 'idh04');
  const storeOwner = await actor('idh04-owner', [storeGrant(T, S1, 'store_owner')]);
  const tenantOwner = await actor('idh04-tenant-owner', [tenantGrant(T, 'store_owner')]);
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, storeOwner);
    createdOf(await ctx.save(so, S1, bodyOf(T, C, [line(described('owner'), 1, 1)])), S1, { lineCount: 1, subtotalCents: 1 }, 'its own store');
    assertRefusal(await ctx.save(so, S2, bodyOf(T, C, [line(described('owner elsewhere'), 1, 1)])), 403, 'forbidden', 'another store of its tenant');
    assertRefusal(await ctx.list(so, S2), 403, 'forbidden', 'no list there either');
    const st = await signIn(ctx, tenantOwner);
    assert.deepEqual(JSON.parse((await ctx.read(st, '/api/v1/stores')).body), { stores: [] }, 'a tenant-only owner discovers no store');
    for (const store of [S1, S2]) {
      assertRefusal(await ctx.list(st, store), 403, 'forbidden', 'no inheritance: list');
      assertRefusal(await ctx.save(st, store, bodyOf(T, C, [line(described('tenant owner'), 1, 1)])), 403, 'forbidden', 'no inheritance: save');
    }
  });
  // A probe tenant, store and identity of their own (never registered as log canaries: the refused row is echoed into the
  // server log's DETAIL, which IDH-12 reads).
  const [{ tenant_id: probeTenant }] = await owner`insert into tenant (display_name, status) values (${`idh-probe-${SUFFIX}`}, 'active') returning tenant_id`;
  const probeStore = await newStore(probeTenant, 'IDH04 probe');
  const [{ internal_user_id: probeUser }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${`idh-probe-${SUFFIX}`}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${probeUser}, 'active')`;
  const [{ code }] = [await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${probeUser}, ${probeTenant}, ${probeStore}, 'store', 'shift_lead', 'active')`.then(() => ({ code: null }), (err) => ({ code: err.code }))];
  assert.equal(code, '23514', 'a browser-only custom role has no server authority: the membership CHECK refuses it');
});

// ===========================================================================
// IDH-05..06: customers and inputs
// ===========================================================================

test('IDH-05 (AC-05): a missing and another tenant\'s customer are byte-identical sealed 422s, each writing only its completion and replayed under its key', async () => {
  const T = await newTenant('idh05');
  const T2 = await newTenant('idh05-other');
  const S = await newStore(T, 'IDH05 store');
  const foreignCustomer = await newCustomer(T2, 'idh05-other');
  const who = await actor('idh05', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const replies = [];
    for (const [label, customer] of [['missing', randomUUID()], ['another tenant\'s', foreignCustomer]]) {
      const key = randomUUID();
      const body = bodyOf(T, customer, [line(described(`cnf ${label}`), 1, 5)]);
      const before = await counts([T, T2], [{ key, principal: who.principal }]);
      const reply = await ctx.save(s, S, body, { key });
      assert.equal(reply.status, 422, `${label}: ${reply.body}`);
      assert.equal(reply.body, '{"error":"customer_not_found"}', `${label}: the sealed refusal, no correlator in the body`);
      assert.equal(reply.headers.location, undefined);
      assertBaseline(reply, label);
      assert.deepEqual(delta(await counts([T, T2], [{ key, principal: who.principal }]), before), { ...NOTHING, K: 1 }, `${label}: only the completion`);
      const replay = await ctx.save(s, S, body, { key });
      assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed']], [422, reply.body, 'true'], `${label}: replayed under its key`);
      assertRefusal(await ctx.save(s, S, { ...body, lines: [line(described('changed'), 1, 5)] }, { key }), 422, 'idempotency_key_reused', `${label}: a changed body under the key`);
      replies.push(reply);
    }
    assert.equal(replies[0].body, replies[1].body, 'byte-identical answers');
    assert.deepEqual(Object.keys(replies[0].headers).filter((h) => !['date', 'x-request-id'].includes(h)).sort(),
      Object.keys(replies[1].headers).filter((h) => !['date', 'x-request-id'].includes(h)).sort(), 'and identical header names');
    const [{ n }] = await owner`select count(*)::int as n from tmpos_role.tenant_role_level where tenant_id = ${T}`;
    assert.equal(n, 0, 'decided before any write: not even a role lock row');
  });
});

test('IDH-06 (AC-06): ordered lines, USD cents and the subtotal to 2^53 - 1 survive; every invalid body is the 400 writing nothing; a body over 64 KiB is the 413', async () => {
  const T = await newTenant('idh06');
  const S = await newStore(T, 'IDH06 store');
  const C = await newCustomer(T, 'idh06');
  const who = await actor('idh06', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const big = createdOf(await ctx.save(s, S, bodyOf(T, C, [line(described('max'), MAX, 1)])), S, { lineCount: 1, subtotalCents: MAX }, '2^53 - 1');
    assert.equal(draftOf(await ctx.get(s, S, big), 'reopened').lines[0].lineTotalCents, MAX, 'exact');
    const fifty = Array.from({ length: 50 }, (_, i) => line(`${described('L')} ${i + 1}`, 1, i === 0 ? MAX - 49 : 1));
    const many = createdOf(await ctx.save(s, S, bodyOf(T, C, fifty)), S, { lineCount: 50, subtotalCents: MAX }, 'fifty lines summing to 2^53 - 1');
    assert.deepEqual(draftOf(await ctx.get(s, S, many), 'fifty reopened').lines.map((l) => l.position), Array.from({ length: 50 }, (_, i) => i + 1));
    const trimmed = createdOf(await ctx.save(s, S, bodyOf(T, C, [line(`  ${described('trimmed')}  `, 2, 3)])), S, { lineCount: 1, subtotalCents: 6 }, 'trimmed');
    assert.equal(draftOf(await ctx.get(s, S, trimmed), 'trimmed reopened').lines[0].description, described('trimmed'), 'edges trimmed, the inside exact');
    const before = await counts([T]);
    for (const [label, body] of [
      ['no lines', bodyOf(T, C, [])], ['51 lines', bodyOf(T, C, Array.from({ length: 51 }, () => line('x', 1, 1)))],
      ['an unknown key', { ...bodyOf(T, C, [line('x', 1, 1)]), subtotalCents: 1 }], ['a line key', bodyOf(T, C, [{ ...line('x', 1, 1), lineTotalCents: 1 }])],
      ['EUR', bodyOf(T, C, [line('x', 1, 1)], { currency: 'EUR' })], ['a non-canonical customer', bodyOf(T, C.toUpperCase(), [line('x', 1, 1)])],
      ['an empty description', bodyOf(T, C, [line('  ', 1, 1)])], ['257 characters', bodyOf(T, C, [line('x'.repeat(257), 1, 1)])],
      ['a control', bodyOf(T, C, [line('a\u0007b', 1, 1)])], ['a Bidi control', bodyOf(T, C, [line('a‮b', 1, 1)])],
      ['quantity 0', bodyOf(T, C, [line('x', 0, 1)])], ['a fraction', bodyOf(T, C, [line('x', 1.5, 1)])], ['a negative price', bodyOf(T, C, [line('x', 1, -1)])],
      ['a dollar string', bodyOf(T, C, [line('x', 1, '1.00')])], ['a product overflow', bodyOf(T, C, [line('x', 2, Math.ceil(MAX / 2))])],
      ['a sum overflow', bodyOf(T, C, [line('x', 1, MAX), line('y', 1, 1)])],
    ]) {
      assertRefusal(await ctx.save(s, S, body), 400, 'invalid_request', label);
    }
    assertRefusal(await ctx.save(s, S, `{"expectedTenant":"${T}","customerId":"${C}","currency":"USD","lines":[{"description":"x","quantity":1,"unitPriceCents":-0}]}`),
      400, 'invalid_request', '-0');
    const huge = JSON.stringify(bodyOf(T, C, Array.from({ length: 50 }, () => line('\\u00e9'.repeat(256), 1, 1)))).replace(/\\\\u00e9/g, '\\u00e9');
    assert.ok(Buffer.byteLength(huge) > 64 * 1024, 'an escaped body over the bound');
    assertRefusal(await ctx.save(s, S, huge), 413, 'content_too_large', 'over 64 KiB');
    assert.deepEqual(delta(await counts([T]), before), NOTHING, 'no invalid body wrote anything');
  });
});

// ===========================================================================
// IDH-07..08: atomicity and idempotency
// ===========================================================================

test('IDH-07 (AC-08): a fault at the line insert, the audit insert, the outbox enqueue or the completion leaves no draft, line, audit record or event, and the lease stays', async () => {
  const T = await newTenant('idh07');
  const S = await newStore(T, 'IDH07 store');
  const C = await newCustomer(T, 'idh07');
  const who = await actor('idh07', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    for (const [label, table, event, when] of [
      ['the second line insert raises', 'tmpos_invoice_draft.invoice_draft_line', 'insert', 'new.position = 2'],
      ['the audit INSERT raises', 'public.audit_event', 'insert', `new.action_id = '${ACTION}'`],
      ['the outbox enqueue raises', 'tmpos_internal.outbox_event', 'insert', `new.event_type = 'invoice_draft.created'`],
      ['the completion raises', 'tmpos_internal.idempotency_record', 'update', 'old.response is null and new.response is not null'],
    ]) {
      const key = randomUUID();
      const body = bodyOf(T, C, [line(described(`fault ${label}`), 1, 1), line(described(`fault two ${label}`), 2, 2)]);
      const before = await counts([T], [{ key, principal: who.principal }]);
      const firedBefore = await fired();
      const reply = await withTrigger(table, event, when, 'raise', () => ctx.save(s, S, body, { key }));
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), NOTHING, `${label}: nothing partial`);
      const [lease] = await owner`select response is null as open from tmpos_internal.idempotency_record where scope = ${scopeOf(key, who.principal)}`;
      assert.equal(lease?.open, true, `${label}: the lease, taken in its own transaction, is open`);
      assertRefusal(await ctx.save(s, S, body, { key }), 409, 'request_in_progress', `${label}: the retry within the lease`);
    }
  });
});

test('IDH-08 (AC-09): concurrent identical saves across two instances make ONE draft and exactly one fresh 201 — every other answer its replay, in progress, or unavailable while it commits; a changed body under the key is the 422 before any write', async () => {
  const T = await newTenant('idh08');
  const S = await newStore(T, 'IDH08 store');
  const C = await newCustomer(T, 'idh08');
  const who = await actor('idh08', [storeGrant(T, S, 'manager')]);
  await withEntry((a) => withEntry(async (b) => {
    const sa = await signIn(a, who);
    const sb = await signIn(b, who);
    const key = randomUUID();
    const body = bodyOf(T, C, [line(described('race'), 3, 7)]);
    const before = await counts([T], [{ key, principal: who.principal }]);
    const instance = (i) => (i % 2 === 0 ? a : b);
    const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => instance(i).save(i % 2 === 0 ? sa : sb, S, body, { key })));
    // customerCreate's M7CC-06 burst set, exactly: ONE fresh 201 (the one plan and commit); every other answer that 201
    // replayed, 409 request_in_progress (a live lease no transaction holds), or 503 service_unavailable (its acquire ran out
    // its lock bound while the winner's transaction held the record row — design R9). A second fresh 201 fails.
    const fresh = replies.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] === undefined);
    assert.equal(fresh.length, 1, `exactly one fresh 201: ${replies.map((r) => r.status).join(',')}`);
    createdOf(fresh[0], S, { lineCount: 1, subtotalCents: 21 }, 'the one commit');
    for (const [i, r] of replies.entries()) {
      if (r === fresh[0]) continue;
      if (r.status === 201) {
        createdOf(r, S, { lineCount: 1, subtotalCents: 21 }, 'a replay', { replayed: true });
        assert.equal(r.body, fresh[0].body, 'a replay is the one sealed answer');
      } else if (r.status === 409) {
        assertRefusal(r, 409, 'request_in_progress', 'in progress');
      } else {
        assertRefusal(r, 503, 'service_unavailable', 'unavailable while the winner commits');
        assert.equal(instance(i).reason(r), 'idempotency_unavailable', 'its acquire ran out its lock bound');
      }
    }
    const final = await a.save(sa, S, body, { key });
    const id = createdOf(final, S, { lineCount: 1, subtotalCents: 21 }, 'the explicit retry', { replayed: true });
    assert.equal(final.body, fresh[0].body);
    assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), { D: 1, L: 1, A: 1, O: 1, K: 1 }, 'one draft, one record of everything');
    assert.equal(draftOf(await b.get(sb, S, id), 'the one draft').id, id);
    const mid = await counts([T]);
    assertRefusal(await b.save(sb, S, bodyOf(T, C, [line(described('race changed'), 3, 7)]), { key }), 422, 'idempotency_key_reused', 'a changed body under the key');
    assert.deepEqual(delta(await counts([T]), mid), NOTHING, 'refused before any write');
  }));
});

// ===========================================================================
// IDH-09: ordering against the commit, both ways
// ===========================================================================

test('IDH-09 (AC-10): a level narrowing, a grant suspension or deletion, a session revocation, an account suspension, a tenant suspended or made read-only and a store suspension committed while the save waits on 016\'s hold leave nothing; each attempted while the save holds its locks waits for its COMMIT, then applies', async () => {
  /** The owner's change touches exactly one row (an UPDATE or DELETE that matched nothing would also commit). */
  const one = async (statement, what) => assert.equal((await statement).count, 1, `${what}: exactly one row changed`);
  await withEntry(async (ctx) => {
    // (a) The change commits first: the save waits on 016's hold (the owner holds the account), the change commits meanwhile,
    // then the save proceeds, re-reads and refuses inside its transaction. An ACCOUNT write cannot commit beside that hold (it
    // waits for the owner's own row lock), so it is made INSIDE the hold (`inHold`): the owner holds the account and suspends
    // it before the save is sent, and that transaction commits while the save waits on it — the same barrier, and the change
    // still committed while the save waits on 016's hold, as every other case's is.
    for (const [label, change, next, { inHold = false } = {}] of [
      ['the Invoices level narrowed to View first', (f) => (sql) => setLevel(f.T, 'sales_staff', 'invoices', 'view', sql), [403, 'forbidden']],
      ['the Customers level narrowed to None first', (f) => (sql) => setLevel(f.T, 'sales_staff', 'customers', 'none', sql), [403, 'forbidden']],
      ['the grant suspended first', (f) => (sql) => sql`update user_membership set status = 'suspended' where internal_user_id = ${f.who.id}`, [401, 'unauthenticated']],
      ['the store grant deleted first', (f) => (sql) => one(sql`delete from user_membership where internal_user_id = ${f.who.id} and store_id = ${f.S}`, 'the grant deleted'), [401, 'unauthenticated']],
      ['the session revoked first', (f) => (sql) => sql`select tmpos_session.m5_session_revoke(${f.s.key}::text)`, [401, 'unauthenticated']],
      ['the account suspended first', (f) => (sql) => one(sql`update app_user set status = 'suspended' where internal_user_id = ${f.who.id}`, 'the account suspended'), [401, 'unauthenticated'], { inHold: true }],
      ['the tenant suspended first', (f) => (sql) => one(sql`update tenant set status = 'suspended' where tenant_id = ${f.T}`, 'the tenant suspended'), [401, 'unauthenticated']],
      ['the tenant made read-only first', (f) => (sql) => one(sql`update tenant set status = 'read_only' where tenant_id = ${f.T}`, 'the tenant made read-only'), [401, 'unauthenticated']],
      ['the store suspended first', (f) => (sql) => sql`update store set status = 'suspended' where store_id = ${f.S}`, [401, 'unauthenticated']],
    ]) {
      const tag = randomUUID().slice(0, 6);
      const T = await newTenant(`idh09-a-${tag}`);
      const S = await newStore(T, `IDH09 a ${tag}`);
      const C = await newCustomer(T, `idh09-a-${tag}`);
      const who = await actor(`idh09-a-${tag}`, [storeGrant(T, S, 'sales_staff')]);
      const f = { T, S, who, s: await signIn(ctx, who) };
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      const h = await hold(inHold ? 'app_user for update, then suspended' : 'app_user for update', async (sql) => {
        await sql`select 1 from public.app_user where internal_user_id = ${who.id} for update`;
        if (inHold) await change(f)(sql);
      });
      let pending;
      try {
        pending = quietly(ctx.save(f.s, S, bodyOf(T, C, [line(described(`never ${label}`), 1, 1)]), { key }));
        waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_HOLD }), `${label}: the save waiting on 016's hold`);
        if (inHold) {
          assert.equal(await h.commit(), 'committed', `${label}: the hold's own change commits while the save waits`);
        } else {
          const outcome = await ownerOutcome(ownerWrite(label, change(f)));
          assert.equal(outcome?.settled, 'committed', `${label}: the change commits while the save waits (${JSON.stringify(outcome)})`);
        }
      } finally {
        await h.commit();
      }
      const reply = await replyTo(pending, label);
      assertRefusal(reply, 503, 'service_unavailable', `${label}: refused inside the transaction`);
      assert.equal(ctx.reason(reply), 'transaction_unavailable', `${label}: the revalidation refused, never a timeout`);
      assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: nothing written, no completion`);
      const [lease] = await owner`select response is null as open from tmpos_internal.idempotency_record where scope = ${scopeOf(key, who.principal)}`;
      assert.equal(lease?.open, true, `${label}: the lease, taken in its own transaction, stays open (IDH-07's rule: a rollback never releases it)`);
      assertRefusal(await ctx.save(f.s, S, bodyOf(T, C, [line(described(`next ${label}`), 1, 1)])), next[0], next[1], `${label}: the next request`);
    }
    // (b) The save holds its locks first: it waits for the customer row (held by the owner) only after every authority lock;
    // each change waits for it (its backend seen waiting on a lock the save holds), it commits first, then the change applies.
    for (const [label, change] of [
      ['an Invoices level narrowing', (f) => (sql) => setLevel(f.T, 'sales_staff', 'invoices', 'none', sql)],
      ['a Customers level narrowing', (f) => (sql) => setLevel(f.T, 'sales_staff', 'customers', 'none', sql)],
      ['a grant suspension', (f) => (sql) => sql`update user_membership set status = 'suspended' where internal_user_id = ${f.who.id}`],
      ['a store grant deletion', (f) => (sql) => one(sql`delete from user_membership where internal_user_id = ${f.who.id} and store_id = ${f.S}`, 'the grant deleted')],
      ['an account suspension', (f) => (sql) => one(sql`update app_user set status = 'suspended' where internal_user_id = ${f.who.id}`, 'the account suspended')],
      ['a tenant suspension', (f) => (sql) => one(sql`update tenant set status = 'suspended' where tenant_id = ${f.T}`, 'the tenant suspended')],
      ['a tenant made read-only', (f) => (sql) => one(sql`update tenant set status = 'read_only' where tenant_id = ${f.T}`, 'the tenant made read-only')],
      ['a store suspension', (f) => (sql) => sql`update store set status = 'suspended' where store_id = ${f.S}`],
      ['a revocation of the presenting session', (f) => (sql) => sql`select tmpos_session.m5_session_revoke(${f.s.key}::text)`],
    ]) {
      const tag = randomUUID().slice(0, 6);
      const T = await newTenant(`idh09-b-${tag}`);
      const S = await newStore(T, `IDH09 b ${tag}`);
      const C = await newCustomer(T, `idh09-b-${tag}`);
      const who = await actor(`idh09-b-${tag}`, [storeGrant(T, S, 'sales_staff')]);
      const f = { T, S, who, s: await signIn(ctx, who) };
      // The role lock rows exist already (the customers row an earlier read made, here the owner's explicit defaults), so the
      // narrowing is an UPDATE that must wait for the save: since 031 (M7B-INVOICES-P1-R3) an Invoices one, and since 032
      // (M7B-INVOICES-P1-R4) a Customers one as well, wait for 030's key, which the save holds SHARED (the save locks no role row
      // any more) and each level write's trigger asks EXCLUSIVE.
      await setLevel(T, 'sales_staff', 'invoices', 'create');
      await setLevel(T, 'sales_staff', 'customers', 'create');
      const before = await counts([T]);
      const h = await hold('customer for update', (sql) => sql`select 1 from tmpos_customer.customer where customer_id = ${C} for update`);
      let pending;
      let rival;
      try {
        pending = quietly(ctx.save(f.s, S, bodyOf(T, C, [line(described(`before ${label}`), 1, 1)])));
        const commandPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_CREATE }), `${label}: the save waiting on the customer row`);
        rival = ownerWrite(label, change(f));
        const outcome = await ownerOutcome(rival);
        assert.ok(outcome?.blocked && outcome.blockers.includes(commandPid), `${label} waits for the save (${JSON.stringify(outcome)})`);
      } finally {
        await h.commit();
      }
      const reply = await replyTo(pending, label);
      createdOf(reply, S, { lineCount: 1, subtotalCents: 1 }, `${label}: the save commits first`);
      assert.equal(await within(rival.done, label), 'committed', `${label} commits after`);
      assert.deepEqual(delta(await counts([T]), before), { D: 1, L: 1, A: 1, O: 1, K: 0 }, label);
    }
  });
});

// ===========================================================================
// IDH-10: the lost COMMIT answer, both branches
// ===========================================================================

test('IDH-10 (AC-11): the COMMIT lands and its answer is lost — 503, the draft whole, the same-key retry replays only under current authority; the COMMIT never lands — 503, nothing, 409 until the lease ends, then one new draft', async () => {
  const T = await newTenant('idh10');
  const S = await newStore(T, 'IDH10 store');
  const C = await newCustomer(T, 'idh10');
  const who = await actor('idh10', [storeGrant(T, S, 'sales_staff')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    // LANDED: the COMMIT reaches the server and its answer is dropped.
    const key = randomUUID();
    const body = bodyOf(T, C, [line(described('lost answer'), 2, 50)]);
    const before = await counts([T], [{ key, principal: who.principal }]);
    const trap = trapCommit(ctx.relay, 'lose');
    let reply;
    const sentAt = Date.now();
    try { reply = await ctx.save(s, S, body, { key }); } finally { trap.release(); }
    assert.equal(trap.hit.length, 1, 'one COMMIT reached the server, and its answer was dropped');
    assertRefusal(reply, 503, 'service_unavailable', 'the lost answer');
    assert.equal(ctx.reason(reply), 'transaction_timeout', 'unknown at the port deadline');
    assert.ok(Date.now() - sentAt >= COMMAND_TRANSACTION_DEADLINE_MS - 50, 'answered at the commit\'s own deadline');
    let landed = null;
    for (const until = Date.now() + 5_000; landed === null && Date.now() < until; await delay(50)) {
      const d = delta(await counts([T], [{ key, principal: who.principal }]), before);
      if (d.D === 1) landed = d;
    }
    assert.deepEqual(landed, { D: 1, L: 1, A: 1, O: 1, K: 1 }, 'what committed is visible, whole');
    // A key is no authority: with the actor's Invoices level narrowed to None (committed), the retry is the authorizer's 403.
    await setLevel(T, 'sales_staff', 'invoices', 'none');
    assertRefusal(await ctx.save(s, S, body, { key }), 403, 'forbidden', 'the retry without current authority');
    await setLevel(T, 'sales_staff', 'invoices', 'create');
    const replayed = await ctx.save(s, S, body, { key });
    const id = createdOf(replayed, S, { lineCount: 1, subtotalCents: 100 }, 'the explicit same-key retry', { replayed: true });
    assert.deepEqual(delta(await counts([T], [{ key, principal: who.principal }]), before), { D: 1, L: 1, A: 1, O: 1, K: 1 }, 'never a second draft');
    assert.equal(draftOf(await ctx.get(s, S, id), 'the landed draft').subtotalCents, 100);
    // NOT LANDED: the COMMIT never reaches the server and the connection is cut — the server rolls back.
    const key2 = randomUUID();
    const body2 = bodyOf(T, C, [line(described('lost commit'), 1, 9)]);
    const before2 = await counts([T], [{ key: key2, principal: who.principal }]);
    const cut = trapCommit(ctx.relay, 'cut');
    let reply2;
    try { reply2 = await ctx.save(s, S, body2, { key: key2 }); } finally { cut.release(); }
    assert.equal(cut.hit.length, 1, 'the COMMIT was kept from the server');
    assertRefusal(reply2, 503, 'service_unavailable', 'no reliable answer');
    await delay(200);
    assert.deepEqual(delta(await counts([T], [{ key: key2, principal: who.principal }]), before2), NOTHING, 'nothing landed');
    assertRefusal(await ctx.save(s, S, body2, { key: key2 }), 409, 'request_in_progress', 'the same-key retry within the lease never re-plans');
    await expireLease(key2, who.principal);
    const again = await ctx.save(s, S, body2, { key: key2 });
    const id2 = createdOf(again, S, { lineCount: 1, subtotalCents: 9 }, 'after the lease: the explicit retry plans again');
    assert.deepEqual(delta(await counts([T], [{ key: key2, principal: who.principal }]), before2), { D: 1, L: 1, A: 1, O: 1, K: 1 }, 'exactly one draft');
    const replay2 = await ctx.save(s, S, body2, { key: key2 });
    assert.equal(createdOf(replay2, S, { lineCount: 1, subtotalCents: 9 }, 'and replays', { replayed: true }), id2);
  });
});

// ===========================================================================
// IDH-11..12: pagination; the chain and the logs
// ===========================================================================

test('IDH-11 (AC-12): 20 by default, at most 50; equal creation times walked without loss or repeat; the cursor only behind a full page; unknown, foreign and malformed cursors the same 400 body length', async () => {
  const T = await newTenant('idh11');
  const S = await newStore(T, 'IDH11 store');
  const S2 = await newStore(T, 'IDH11 two');
  const C = await newCustomer(T, 'idh11');
  const who = await actor('idh11', [storeGrant(T, S, 'manager')]);
  // Twenty-three drafts with ONE creation time, written by the owner in one transaction, and one at another store.
  const ids = [];
  await owner.begin(async (sql) => {
    for (let i = 0; i < 23; i++) {
      const id = randomUUID();
      ids.push(id);
      await sql`insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
        values (${id}, ${T}, ${S}, ${C}, 'draft', 'USD', 1, 1, ${i}, ${who.id})`;
      await sql`insert into tmpos_invoice_draft.invoice_draft_line values (${id}, ${T}, ${S}, 1, ${`Line ${i}`}, 1, ${i}, ${i})`;
    }
  });
  const otherStore = randomUUID();
  await owner.begin(async (sql) => {
    await sql`insert into tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
      values (${otherStore}, ${T}, ${S2}, ${C}, 'draft', 'USD', 1, 1, 0, ${who.id})`;
    await sql`insert into tmpos_invoice_draft.invoice_draft_line values (${otherStore}, ${T}, ${S2}, 1, 'x', 1, 0, 0)`;
  });
  const expected = [...ids].sort().reverse();
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const first = pageOf(await ctx.list(s, S), 'default page');
    assert.equal(first.drafts.length, 20, 'twenty by default');
    assert.equal(new Set(first.drafts.map((d) => d.createdAt)).size, 1, 'one creation time');
    assert.match(first.nextCursor, /^[A-Za-z0-9_-]{23}$/);
    const second = pageOf(await ctx.list(s, S, `?cursor=${first.nextCursor}`), 'second page');
    assert.equal(second.nextCursor, null, 'no cursor behind a short page');
    assert.deepEqual([...first.drafts, ...second.drafts].map((d) => d.id), expected, 'every draft once, id descending');
    for (const size of [1, 7, 23]) {
      const seen = [];
      let cursor = null;
      for (let guard = 0; guard < 30; guard++) {
        const p = pageOf(await ctx.list(s, S, `?limit=${size}${cursor === null ? '' : `&cursor=${cursor}`}`), `size ${size}`);
        seen.push(...p.drafts.map((d) => d.id));
        if (p.nextCursor === null) break;
        assert.equal(p.drafts.length, size, 'a cursor only behind a full page');
        cursor = p.nextCursor;
      }
      assert.deepEqual(seen, expected, `page size ${size}: no loss, no repeat`);
    }
    assert.equal(pageOf(await ctx.list(s, S, '?limit=50'), 'fifty').drafts.length, 23);
    assertRefusal(await ctx.list(s, S, '?limit=51'), 400, 'invalid_request', 'above fifty');
    const encode = (id) => Buffer.concat([Buffer.from([0x01]), Buffer.from(id.replace(/-/g, ''), 'hex')]).toString('base64url');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const valid = encode(ids[0]);
    const alias = valid.slice(0, -1) + alphabet[alphabet.indexOf(valid.at(-1)) ^ 1];
    const refusals = [];
    for (const [label, cursor] of [['an unknown anchor', encode(randomUUID())], ['another store\'s anchor', encode(otherStore)], ['a malformed cursor', 'x'.repeat(23)],
      ['a second spelling', alias], ['another tag', Buffer.concat([Buffer.from([0x02]), Buffer.from(ids[0].replace(/-/g, ''), 'hex')]).toString('base64url')]]) {
      const r = await ctx.list(s, S, `?cursor=${cursor}`);
      assertRefusal(r, 400, 'invalid_request', label);
      refusals.push(r.body.length);
    }
    assert.equal(new Set(refusals).size, 1, 'equal body lengths: nothing tells them apart');
  });
});

// ===========================================================================
// IDH-13..14: the expectedTenant precondition and the read-only statuses, end to end
// ===========================================================================

test('IDH-13 (AC-02 AC-05): a save whose expectedTenant is not the store\'s tenant is the unsealed 409 write_conflict — nothing written, no completion, the lease left open', async () => {
  const T = await newTenant('idh13');
  const T2 = await newTenant('idh13-other');
  const S = await newStore(T, 'IDH13 store');
  const C = await newCustomer(T, 'idh13');
  const who = await actor('idh13', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    for (const [label, expected] of [['another tenant', T2], ['a tenant that does not exist', randomUUID()]]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const body = bodyOf(expected, C, [line(described(`mismatch ${label}`), 1, 5)]);
      const before = await counts([T, T2], keys);
      const reply = await ctx.save(s, S, body, { key });
      assertRefusal(reply, 409, 'write_conflict', `${label}: the precondition`);
      assert.equal(reply.headers['idempotent-replayed'], undefined, `${label}: not a replay`);
      assert.equal(reply.headers.location, undefined, `${label}: no Location`);
      assert.deepEqual(delta(await counts([T, T2], keys), before), NOTHING, `${label}: no draft, line, audit, event or completion`);
      const [lease] = await owner`select response is null as open from tmpos_internal.idempotency_record where scope = ${scopeOf(key, who.principal)}`;
      assert.equal(lease?.open, true, `${label}: the lease, taken in its own transaction, is open — unsealed, nothing completed`);
      assertRefusal(await ctx.save(s, S, body, { key }), 409, 'request_in_progress', `${label}: the same-key retry within the lease`);
    }
    const [{ n }] = await owner`select count(*)::int as n from tmpos_role.tenant_role_level where tenant_id = any(${[T, T2]}::uuid[])`;
    assert.equal(n, 0, 'decided before any write: not even a role lock row');
    // Control: the store's own tenant saves.
    createdOf(await ctx.save(s, S, bodyOf(T, C, [line(described('mismatch control'), 1, 5)])), S, { lineCount: 1, subtotalCents: 5 }, 'the store\'s tenant');
  });
});

test('IDH-14 (AC-01 AC-10): a read_only and an overdue account, tenant and store, on a session established after the change, list and reopen the existing draft and cannot save — the authorizer\'s 403 before any key, nothing written', async () => {
  for (const axis of ['account', 'tenant', 'store']) {
    for (const status of ['read_only', 'overdue']) {
      const label = `${axis} ${status}`;
      const T = await newTenant(`idh14-${axis}-${status}`);
      const S = await newStore(T, `IDH14 ${axis} ${status}`);
      const C = await newCustomer(T, `idh14-${axis}-${status}`);
      const who = await actor(`idh14-${axis}-${status}`, [storeGrant(T, S, 'manager')]);
      await withEntry(async (ctx) => {
        const id = createdOf(await ctx.save(await signIn(ctx, who), S, bodyOf(T, C, [line(described(`ro ${label}`), 2, 3)])), S, { lineCount: 1, subtotalCents: 6 }, `${label}: saved while active`);
        if (axis === 'account') await owner`update app_user set status = ${status} where internal_user_id = ${who.id}`;
        else if (axis === 'tenant') await owner`update tenant set status = ${status} where tenant_id = ${T}`;
        else await owner`update store set status = ${status} where store_id = ${S}`;
        const s = await signIn(ctx, who);
        const stores = JSON.parse((await ctx.read(s, '/api/v1/stores')).body).stores;
        assert.deepEqual(stores.filter((e) => e.id === S).map((e) => e.readOnly), [true], `${label}: discovery marks the store read-only`);
        assert.deepEqual(pageOf(await ctx.list(s, S), `${label}: the list`).drafts.map((d) => d.id), [id], `${label}: the list answers the draft`);
        const draft = draftOf(await ctx.get(s, S, id), `${label}: the reopen`);
        assert.deepEqual([draft.id, draft.storeId, draft.customerId, draft.subtotalCents, draft.lines.length], [id, S, C, 6, 1], `${label}: the reopen answers it`);
        const key = randomUUID();
        const keys = [{ key, principal: who.principal }];
        const before = await counts([T], keys);
        assertRefusal(await ctx.save(s, S, bodyOf(T, C, [line(described(`ro refused ${label}`), 1, 1)]), { key }), 403, 'forbidden', `${label}: no save`);
        assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: nothing written`);
        const [{ n }] = await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, who.principal)}`;
        assert.equal(n, 0, `${label}: refused by the authorizer before any key was acquired`);
      });
    }
  }
});

test('IDH-15 (M7B-INVOICES-P1-R2: DA-201 AC-10 AC-11): eligibility over real 028 is allowed exactly when a real POST passes authorization — every built-in role at its default and under owner-edited levels; a denied POST is the 403 writing no business row', async () => {
  const CASES = [
    ['store_owner default', 'store_owner', [], true],
    ['manager default', 'manager', [], true],
    ['sales_staff default', 'sales_staff', [], true],
    ['technician default (View)', 'technician', [], false],
    ['technician raised to Invoices Create', 'technician', [['invoices', 'create']], true],
    ['technician raised to Invoices Full, Customers lowered to None', 'technician', [['invoices', 'full'], ['customers', 'none']], false],
    ['sales_staff lowered to Invoices View', 'sales_staff', [['invoices', 'view']], false],
    ['manager lowered to Invoices View', 'manager', [['invoices', 'view']], false],
    ['sales_staff with Customers lowered to None', 'sales_staff', [['customers', 'none']], false],
    ['manager with Customers lowered to None', 'manager', [['customers', 'none']], false],
    // (No store_owner edit: 020's tenant_role_level_role_chk admits no level row for the owner, whose authority is fixed.)
  ];
  const cases = [];
  for (const [i, [label, role, edits, expected]] of CASES.entries()) {
    const T = await newTenant(`idh15-${i}`);
    const S = await newStore(T, `IDH15 ${i}`);
    const C = await newCustomer(T, `idh15-${i}`);
    const who = await actor(`idh15-${i}`, [storeGrant(T, S, role)]);
    for (const [domain, level] of edits) await setLevel(T, role, domain, level);
    cases.push({ label, T, S, C, who, expected });
  }
  await withEntry(async (ctx) => {
    const table = [];
    const sessions = [];
    for (const { label, T, S, C, who, expected } of cases) {
      const s = await signIn(ctx, who);
      sessions.push(s);
      const before = await footprint([T]);
      const verdict = eligibilityOf(await ctx.eligibility(s, S), `${label}: eligibility`);
      assert.deepEqual(await footprint([T]), before, `${label}: the eligibility answer wrote nothing`);
      const key = randomUUID();
      const saved = await ctx.save(s, S, bodyOf(T, C, [line(described(`idh15 ${label}`), 1, 7)]), { key });
      if (saved.status === 201) {
        createdOf(saved, S, { lineCount: 1, subtotalCents: 7 }, `${label}: the POST`);
      } else {
        assertRefusal(saved, 403, 'forbidden', `${label}: the POST`);
        assert.deepEqual(await footprint([T]), before, `${label}: the refused POST wrote nothing — no draft, line, audit, outbox, completion, lease or role row`);
        const [{ n }] = await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, who.principal)}`;
        assert.equal(n, 0, `${label}: refused before any key was acquired`);
      }
      assert.equal(verdict === 'allowed', saved.status === 201, `${label}: eligibility ${verdict} but the POST ${saved.status}`);
      table.push([label, verdict, saved.status]);
      assert.equal(verdict === 'allowed', expected, `${label}: expected ${expected ? 'allowed' : 'forbidden'}`);
    }
    assert.equal(table.length, CASES.length);
    // The CURRENT server-saved level, read per request: an edit committed while the session lives moves eligibility and the
    // POST together, both directions, on that same session (sales_staff at its default, case 2).
    const { T, S, C } = cases[2];
    const s = sessions[2];
    await setLevel(T, 'sales_staff', 'invoices', 'view');
    const before = await footprint([T]);
    assert.equal(eligibilityOf(await ctx.eligibility(s, S), 'lowered mid-session'), 'forbidden');
    assertRefusal(await ctx.save(s, S, bodyOf(T, C, [line(described('idh15 lowered'), 1, 1)])), 403, 'forbidden', 'lowered mid-session: the POST');
    assert.deepEqual(await footprint([T]), before, 'lowered mid-session: nothing written');
    await setLevel(T, 'sales_staff', 'invoices', 'create');
    assert.equal(eligibilityOf(await ctx.eligibility(s, S), 'raised back mid-session'), 'allowed');
    createdOf(await ctx.save(s, S, bodyOf(T, C, [line(described('idh15 raised'), 1, 1)])), S, { lineCount: 1, subtotalCents: 1 }, 'raised back mid-session: the POST');
  });
});

test('IDH-16 (DA-201 AC-09 AC-10 AC-11): a technician grant at the store — standing in for an account whose browser-only role claims Invoices Full (browser side: slice B2) — is refused eligibility and the direct POST alike (403, no business row); a foreign, missing or non-canonical store is one 403 body, the technician\'s', async () => {
  const T = await newTenant('idh16');
  const T2 = await newTenant('idh16-other');
  const S = await newStore(T, 'IDH16 one');
  const S2 = await newStore(T, 'IDH16 two');
  const S3 = await newStore(T2, 'IDH16 other');
  const C = await newCustomer(T, 'idh16');
  // Stands in for SDB-07's account, whose shop profile (Firestore users/{uid}.role) names a custom role with Invoices Full that
  // exists only in the browser: the server holds only a technician grant (a custom role id cannot be a membership — IDH-04's
  // CHECK). Nothing browser-side is set up here; that the hint never reaches a request is slice B2's to prove.
  const tech = await actor('idh16-custom', [storeGrant(T, S, 'technician')]);
  const who = await actor('idh16-manager', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const st = await signIn(ctx, tech);
    const sm = await signIn(ctx, who);
    const before = await footprint([T, T2]);
    const denied = await ctx.eligibility(st, S);
    assert.equal(eligibilityOf(denied, 'the custom-role account: eligibility'), 'forbidden');
    assert.equal((await ctx.list(st, S)).status, 200, 'it still lists (Invoices View)');
    const key = randomUUID();
    assertRefusal(await ctx.save(st, S, bodyOf(T, C, [line(described('idh16 custom'), 1, 1)]), { key }), 403, 'forbidden', 'the custom-role account: the direct POST');
    assert.deepEqual(await footprint([T, T2]), before, 'nothing written by either');
    const [{ n }] = await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, tech.principal)}`;
    assert.equal(n, 0, 'refused before any key');
    assert.equal(eligibilityOf(await ctx.eligibility(sm, S), 'the manager at its own store'), 'allowed', 'control');
    const replies = [['a denied role', denied]];
    for (const [label, store] of [['the tenant\'s other store', S2], ['another tenant\'s store', S3], ['a missing store', randomUUID()],
      ['an upper-case segment', S.toUpperCase()], ['a braced segment', `{${S}}`], ['a word', 'mine']]) {
      const r = await ctx.eligibility(sm, store);
      assert.equal(eligibilityOf(r, label), 'forbidden', label);
      replies.push([label, r]);
    }
    const shapes = new Set(replies.map(([, r]) => { const { requestId: _id, ...rest } = JSON.parse(r.body); return `${r.status} ${r.body.length} ${JSON.stringify(rest)}`; }));
    assert.equal(shapes.size, 1, `one status, one body length, one body but requestId: ${[...shapes].join(' | ')}`);
    assert.deepEqual(await footprint([T, T2]), before, 'still nothing written');
  });
});

test('IDH-17 (DA-201 AC-11): a read_only and an overdue account, tenant and store — on a session established after the change — still list (200) but are refused eligibility (403) and the save (403); a session established before a tenant turns read_only is ended (401)', async () => {
  const cases = [];
  for (const axis of ['account', 'tenant', 'store']) {
    for (const status of ['read_only', 'overdue']) {
      const T = await newTenant(`idh17-${axis}-${status}`);
      const S = await newStore(T, `IDH17 ${axis} ${status}`);
      const C = await newCustomer(T, `idh17-${axis}-${status}`);
      const who = await actor(`idh17-${axis}-${status}`, [storeGrant(T, S, 'manager')]);
      cases.push({ label: `${axis} ${status}`, axis, status, T, S, C, who });
    }
  }
  const earlyT = await newTenant('idh17-early');
  const earlyS = await newStore(earlyT, 'IDH17 early');
  const early = { T: earlyT, S: earlyS, C: await newCustomer(earlyT, 'idh17-early'), who: await actor('idh17-early', [storeGrant(earlyT, earlyS, 'manager')]) };
  await withEntry(async (ctx) => {
    for (const { label, axis, status, T, S, C, who } of cases) {
      assert.equal(eligibilityOf(await ctx.eligibility(await signIn(ctx, who), S), `${label}: while active`), 'allowed', `${label}: control`);
      if (axis === 'account') await owner`update app_user set status = ${status} where internal_user_id = ${who.id}`;
      else if (axis === 'tenant') await owner`update tenant set status = ${status} where tenant_id = ${T}`;
      else await owner`update store set status = ${status} where store_id = ${S}`;
      const s = await signIn(ctx, who);
      pageOf(await ctx.list(s, S), `${label}: the list`);
      const before = await footprint([T]);
      assert.equal(eligibilityOf(await ctx.eligibility(s, S), `${label}: eligibility`), 'forbidden', label);
      assertRefusal(await ctx.save(s, S, bodyOf(T, C, [line(described(`idh17 ${label}`), 1, 1)])), 403, 'forbidden', `${label}: the save`);
      assert.deepEqual(await footprint([T]), before, `${label}: nothing written`);
    }
    // The session established FIRST, then the tenant made read_only: the boundary ends that session on its next request
    // (the existing session-boundary rule, not this route's) — the list, eligibility and the save are each the 401, and no
    // eligibility answer outlives the change; a session established afterwards lists (200) and is refused eligibility (403).
    const { T, S, C, who } = early;
    const s = await signIn(ctx, who);
    assert.equal(eligibilityOf(await ctx.eligibility(s, S), 'established first: while active'), 'allowed');
    await owner`update tenant set status = 'read_only' where tenant_id = ${T}`;
    const before = await footprint([T]);
    assertRefusal(await ctx.eligibility(s, S), 401, 'unauthenticated', 'established first: eligibility after read_only');
    assertRefusal(await ctx.list(s, S), 401, 'unauthenticated', 'established first: the list after read_only');
    assertRefusal(await ctx.save(s, S, bodyOf(T, C, [line(described('idh17 established first'), 1, 1)])), 401, 'unauthenticated', 'established first: the save');
    assert.deepEqual(await footprint([T]), before, 'established first: no business row');
    const fresh = await signIn(ctx, who); // a sign-in is audited: the snapshot is taken after it
    const afterSignIn = await footprint([T]);
    pageOf(await ctx.list(fresh, S), 'established after: the list');
    assert.equal(eligibilityOf(await ctx.eligibility(fresh, S), 'established after: eligibility'), 'forbidden');
    assert.deepEqual(await footprint([T]), afterSignIn, 'established after: no business row');
  });
});

test('IDH-18 (DA-201 AC-12): around eligibility — 401, the session CSRF witness, a query, another host, a POST, no-store everywhere; 300 answers from one client write no business row and the 301st is the 429 with Retry-After', async () => {
  const T = await newTenant('idh18');
  const S = await newStore(T, 'IDH18 store');
  const who = await actor('idh18', [storeGrant(T, S, 'sales_staff')]);
  // The chain's refusals, from one entry (and its one client address).
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const other = await signIn(ctx, who);
    for (const [label, reply, status, error] of [
      ['no session', await ctx.eligibility(null, S), 401, 'unauthenticated'],
      ['no session CSRF token', await ctx.read(null, `/api/v1/stores/${S}/invoice-drafts/eligibility`, { cookie: s.cookie }), 403, 'forbidden'],
      ['another session\'s token', await ctx.read(null, `/api/v1/stores/${S}/invoice-drafts/eligibility`, { cookie: s.cookie, [SESSION_CSRF_HEADER]: other.csrf }), 403, 'forbidden'],
      ['a query', await ctx.eligibility(s, S, { query: '?x=1' }), 400, 'invalid_request'],
      ['an empty query', await ctx.eligibility(s, S, { query: '?' }), 400, 'invalid_request'],
      ['the administrative host', await ctx.eligibility(s, S, { headers: { host: ADMIN_HOST } }), 404, 'not_found'],
      ['a trailing segment', await ctx.read(s, `/api/v1/stores/${S}/invoice-drafts/eligibility/x`), 404, 'not_found'],
    ]) {
      assertRefusal(reply, status, error, label);
      assert.equal(reply.headers['cache-control'], 'no-store', `${label}: no-store`);
    }
    const post = await send(ctx.port, 'POST', `/api/v1/stores/${S}/invoice-drafts/eligibility`, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf,
    }, '');
    assertRefusal(post, 404, 'not_found', 'a POST names no eligibility');
    assert.equal(eligibilityOf(await ctx.eligibility(s, S), 'the session\'s own token'), 'allowed');
    assert.equal(eligibilityOf(await ctx.eligibility(other, S), 'the second session, its own token'), 'allowed');
  });
  // A fresh entry, so its one client address has spent nothing: only eligibility reads go out from it.
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const before = await footprint([T]);
    const statuses = [];
    let limited = null;
    const started = Date.now();
    const { limit, windowMs } = RATE_LIMITS.request;
    for (let i = 0; i < limit + 10 && limited === null; i++) {
      const r = await ctx.eligibility(s, S);
      if (r.status === 200) statuses.push(eligibilityOf(r, `answer ${i + 1}`));
      else limited = { at: i + 1, reply: r };
    }
    const elapsed = Date.now() - started;
    // Timing-dependent by nature: the bucket opens at the first answer and must not close before the last (DA-60 class).
    assert.ok(elapsed < windowMs, `the run fit one ${windowMs} ms window (${elapsed} ms)`);
    assert.deepEqual([statuses.length, new Set(statuses).size], [limit, 1], `exactly the request limit's ${limit} answers, every one allowed`);
    assert.ok(limited !== null, 'the limit was reached');
    assert.equal(limited.at, limit + 1);
    assertRefusal(limited.reply, 429, 'rate_limited', 'the 301st');
    assert.match(limited.reply.headers['retry-after'] ?? '', /^[1-9][0-9]*$/, 'Retry-After in whole seconds');
    assert.ok(Number(limited.reply.headers['retry-after']) <= windowMs / 1000, 'within the window');
    assert.equal(limited.reply.headers['cache-control'], 'no-store');
    assert.deepEqual(await footprint([T]), before, '300 eligibility answers and a 429: no draft, line, audit record, outbox event, completion, lease or role-level row');
  });
});

test('IDH-12: the chain — 401 without a session, the session CSRF witness on GET, Origin and X-TMPOS-CSRF on POST, the tenant host only, no-store — and no log line carries a description, a customer, a draft, a session key or an Idempotency-Key', async () => {
  const T = await newTenant('idh12');
  const S = await newStore(T, 'IDH12 store');
  const C = await newCustomer(T, 'idh12');
  const who = await actor('idh12', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    assertRefusal(await ctx.list(null, S), 401, 'unauthenticated', 'no session');
    const s = await signIn(ctx, who);
    const other = await signIn(ctx, who);
    assertRefusal(await ctx.read(null, `/api/v1/stores/${S}/invoice-drafts`, { cookie: s.cookie }), 403, 'forbidden', 'no session CSRF token');
    assertRefusal(await ctx.read(null, `/api/v1/stores/${S}/invoice-drafts`, { cookie: s.cookie, [SESSION_CSRF_HEADER]: other.csrf }), 403, 'forbidden', 'another session\'s token');
    assertRefusal(await ctx.save(s, S, bodyOf(T, C, [line('x', 1, 1)]), { headers: { origin: 'https://evil.test' } }), 403, 'forbidden', 'a cross-site Origin');
    assertRefusal(await ctx.save(s, S, bodyOf(T, C, [line('x', 1, 1)]), { headers: { [CSRF_HEADER]: '0' } }), 403, 'forbidden', 'no CSRF header value');
    const noKey = await send(ctx.port, 'POST', `/api/v1/stores/${S}/invoice-drafts`, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf,
    }, JSON.stringify(bodyOf(T, C, [line('x', 1, 1)])));
    assertRefusal(noKey, 400, 'invalid_request', 'no Idempotency-Key');
    assertRefusal(await ctx.read(s, `/api/v1/stores/${S}/invoice-drafts`, { host: ADMIN_HOST }), 404, 'not_found', 'the administrative host');
    const id = createdOf(await ctx.save(s, S, bodyOf(T, C, [line(described('logged'), 1, 1)])), S, { lineCount: 1, subtotalCents: 1 }, 'a save');
    const got = await ctx.get(s, S, id);
    assert.equal(got.headers['cache-control'], 'no-store');
    assertBaseline(got, 'the get');
    assertRefusal(await ctx.read(s, `/api/v1/stores/${S}/invoice-drafts/${id}?x=1`), 400, 'invalid_request', 'a query on the get');
  });
  // No log line of any entry this suite started — nor the server log of a cluster it started — carries a secret it handled.
  const forbidden = [...SECRETS, ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)])];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const l of ALL_LOG_LINES) for (const secret of forbidden) assert.ok(!l.includes(secret), `a log line carries a secret: ${secret.slice(0, 6)}...`);
  if (cluster !== null) {
    const leaked = forbidden.filter((v) => readFileSync(`${cluster.root}/postgres.log`, 'utf8').includes(v));
    assert.deepEqual(leaked.map((v) => v.slice(0, 6)), [], 'the cluster\'s server log carries no secret');
  }
});
