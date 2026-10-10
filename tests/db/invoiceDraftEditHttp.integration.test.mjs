// Phase 4.0 M7B-INVOICES-P2 and P2-R1 — editing a saved store invoice draft END TO END: the tenant entry (server/entry/tenantEntry.ts,
// startTenantEntry) serving PATCH /api/v1/stores/{storeId}/invoice-drafts/{id} and GET …/{id}/edit-eligibility over REAL
// loopback HTTP and a disposable PostgreSQL holding every migration in the directory (001-032), composed exactly as
// server/entry/tenantMain.ts composes it but for its construction. The route module (server/runtime/invoiceDrafts.ts), the
// store-scope authorizer and revalidator, the tenant command transaction, the edit's mutator
// (server/persistence/postgresInvoiceDrafts.ts), migration 030's edit routine (the guarded v2: the Invoices level held through
// the sealed outcome and the completion, by an advisory key every writer of a level takes through migration 030's trigger), the
// audit writer (subject_invoice_draft_id) and the outbox enqueue are production's own code. Every draft is saved first through
// the production POST (since migration 031, M7B-INVOICES-P1-R3, through 031's guarded save, and since migration 032,
// M7B-INVOICES-P1-R4, through 032's version-3 save, which locks and makes no role row of either domain).
//
// Case labels: R = red on the entry source (029's routine, no guard) for the defect DA-204, N = the new contract of 030, G = a
// guard that holds before and after.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — tests/db/invoiceDraftsHttp.integration.test.mjs's three, none on the path under test:
// the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime LOGIN, tmpos_ieh_probe,
// holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can drop a COMMIT's answer or the
// COMMIT itself), the identity verifier (a synthetic bearer-token map) and the listener (127.0.0.1:0). Lease expiry is moved
// by the OWNER on the idempotency row, and faults and parking points are OWNER triggers (test-only levers).
//
// WHAT IS PROVEN (each title carries the acceptance criteria it evidences; D/L/A/O/K are the drafts, lines, EDIT audit
// records, invoice_draft.updated events and sealed completions a case's own tenants and keys hold, read by the OWNER as deltas;
// a draft's state is its header and ordered lines as the OWNER reads them, row versions (xmin) included).
//   IEH-01 (AC-03 AC-05) a real edit: the 200, one audit record naming the draft, one event at the new version, the new
//          representation read back through a second entry; draft id, tenant, store, status, currency, creation time and
//          creator unchanged.
//   IEH-02 (AC-03 AC-04) authority: built-in roles, owner-edited Invoices levels (None..Full; Customers None never matters),
//          a tenant-only grant, a read_only store; the edit eligibility answers 200 iff the PATCH is authorized and is the
//          creation eligibility's exact bytes; a Create-only role is allowed the creation eligibility and refused both.
//   IEH-03 (AC-06 AC-05, G/N) a current-version no-op: the sealed 200 changed:false, nothing written (rows and their xmin), no role
//          row, replayed; sealed while it holds the header (a rival edit waits for it) and, parked at its completion, the role's
//          advisory key (an edit makes no role row at all, 030); equal totals and a reorder are changes.
//   IEH-04 (AC-07 AC-12) a stale edit and a stale no-op: the sealed 409 write_conflict, replayed, nothing else written; a
//          completed edit's retry replays its 200 after later edits moved the version.
//   IEH-05 (AC-08) two entries, two Edit actors, one version: one 200 and one sealed 409, ordered by an owner's hold of the
//          draft header, both directions.
//   IEH-06 (AC-09, the HTTP part) a GET during an edit held uncommitted reads the complete earlier draft; after its COMMIT the
//          complete later one.
//   IEH-07 (AC-10, D3) a missing draft, another store's, another tenant's, a missing customer and another tenant's are one 404
//          writing nothing (the lease open); an expectedTenant that is not the store's is the unsealed 409.
//   IEH-08 (AC-11, G; AC-08, N) a fault at the line DELETE, the line INSERT, the header UPDATE, the audit INSERT, the outbox INSERT
//          or the completion — and at a no-op's completion — is the 503 with the earlier draft intact and the lease open; and a
//          no-op's and a sealed conflict's completion parked and then raising (N): while parked the edit's backend holds the
//          role's advisory key SHARED and a non-NULL level write is blocked by it; the raise is the 503 LEASE_ONLY with no
//          role row, and the writer then commits.
//   IEH-09 (AC-12) one key: other bytes, another draft, another store are each the 422 before any write.
//   IEH-10 (AC-13) a lost COMMIT answer with the COMMIT landed (an edit, a no-op, a sealed 409) and with it never landed;
//          same-key, same-bytes recovery; the version stepped exactly once.
//   IEH-11 (AC-14, G; barriers N) a downgrade to Invoices Create, a grant suspension, a store made read_only and a session
//          revocation committed while the edit waits on 016's hold; a downgrade held uncommitted and committed while the edit
//          waits for the role's advisory KEY (not the role row); the reverse — the edit parked at its completion holding the
//          key, the downgrade's UPDATE waiting for it and for its COMMIT.
//   IEH-12 (AC-15) the closed body, the version bounds, the line contract and the 64 KiB bound (65,536 bytes accepted, one more
//          the 413), each refusal writing nothing; a malformed and an unversioned draft id.
//   IEH-13 the chain around the edit and its eligibility: 401, the session CSRF witness, Origin and X-TMPOS-CSRF, no key, a
//          query, another host, no-store; the eligibility the same bytes for any well-formed draft id.
//   IEH-15 (AC-01 AC-02 AC-03 DA-204, R) two tenant entries: the owner's PUT downgrading the manager's Invoices level (an existing
//          override, then an absent one) commits on entry B while a current no-op or a stale edit waits on the draft header on
//          entry A; released, the edit is the 503 transaction_unavailable — nothing changed since the downgrade, the lease open.
//   IEH-16 (AC-04, N) the edit parked at its completion holds the key; the owner's PUT on entry B waits for that key behind the
//          edit's backend; released, the edit is the sealed 200 and then the PUT is the 200; a later PATCH is the authorizer's 403.
//   IEH-17 (AC-09, G) a sealed no-op and a sealed conflict replay exactly; after the owner's PUT downgrade the replay is the 403;
//          after the PUT restores the level the replay answers the retained bytes (idempotent-replayed) and that draft's version,
//          audit records and outbox events are unchanged.
//   IEH-14 no log line carries a description, a customer, a draft, a session key or an Idempotency-Key (run last).
//
// DETERMINISTIC WAITS ONLY: a request is known to wait by pg_stat_activity (a Lock wait, its blocker named) or an owner lock
// that can only be granted once the edit's transaction ended; nothing sleeps for an outcome.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Synthetic data only, every id
// and key made at run time. Its edits leave drafts above version 1 and audit records naming drafts, which block 029's and
// 028's rollback: on a shared service it runs after every step that rolls 028, 029, 030, 031 or 032 back, and before it finishes it removes
// every draft, line and Invoices lock anchor of its tenants, clears every audit subject naming one of its drafts and deletes
// its tenants' draft events, with its sessions, mint-ledger rows, idempotency records, proof schema and login, and restores
// the limiter fingerprint and issuer key row it found.
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
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { createIdempotencyKeyring, IDEMPOTENCY_POLICY } from '../../server/runtime/idempotency.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';
import { PORT_DEADLINE_MS } from '../../server/runtime/deadline.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'ieh-migrator', runtimeRef: 'ieh-runtime' };
const LOCK_KEY = 529_530;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ieh_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** The audit action of an edit (the update contract's kind), pinned here as a literal. */
const ACTION = 'store.invoice_draft.update';
const EVENT = 'invoice_draft.updated';
const MAX = 9007199254740991;
const BODY_BOUND = 65_536;
const WAIT_MS = 10_000;
const SEND_TIMEOUT_MS = 20_000;
/** The revalidator's first lock: 016's hold of the actor's standing. */
const AT_HOLD = /m5_hold_tenant_standing/;
/**
 * The edit routine's statement: where an edit waits for the draft header or its role row (after every authority lock). It
 * names either routine — 029's and the one migration 030 introduced — so one pattern serves the entry source and the correction.
 */
const AT_UPDATE = /(?:tmpos_invoice_draft\.m7b_invoice_draft_update|tmpos_invoice_edit\.m7b_invoice_draft_update_v2)\(/;
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });
/** The completion: the one UPDATE of an idempotency record that seals its response. */
const COMPLETION = 'old.response is null and new.response is not null';
/** The advisory key the parking trigger waits on (the two-int space: never the migration lock's bigint one). */
const PARK = [529_530, 1];
assert.equal(IDEMPOTENCY_POLICY.leaseMs, 60_000, 'the idempotency lease the in-progress cases rely on');
assert.ok(COMMAND_TRANSACTION_DEADLINE_MS <= PORT_DEADLINE_MS);
assert.ok(PORT_DEADLINE_MS * 4 <= SEND_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('IEH');
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
    await step(() => owner.unsafe('drop schema if exists ieh_proof cascade'));
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
    // The events this suite's saves and edits enqueued: no worker exists, so they would otherwise sit pending forever.
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
      assert.deepEqual({ ...state }, { drafts: 0, lines: 0, subjects: 0, anchors: 0 }, 'nothing of this suite blocks 029\'s or 028\'s rollback');
    });
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IEH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'IEH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster; a trap may drop a COMMIT's answer, or the COMMIT itself
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket' ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) } : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-ieh-relay-'));
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
/** A real edit's anchor: its audit INSERT (only an applied edit writes one). */
const AUDIT_ANCHOR = Buffer.from('insert into public.audit_event');
/** A no-op's or a sealed 409's anchor (neither writes an audit record): the command's completion call. */
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
  const [{ applied }] = await owner`select count(*)::int as applied from public.schema_migrations where version in ('029', '030', '031', '032')`;
  assert.equal(applied, 4, 'migrations 029, 030, 031 and 032 are applied: the guarded edit routine and the guarded save exist');
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
  await owner.unsafe('drop schema if exists ieh_proof cascade');
  await owner.unsafe('create schema ieh_proof');
  await owner.unsafe('revoke all on schema ieh_proof from public');
  await owner.unsafe('create sequence ieh_proof.fired');
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
    type: 'service_account', project_id: 'ieh-test-project', client_email: 'ieh-test@ieh-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
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
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ieh-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
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
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IEH ${label} ${SUFFIX}`})`;
  SECRETS.add(id);
  return id;
}
async function actor(label, memberships, status = 'active') {
  const uid = `ieh-${label}-${SUFFIX}`;
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
  const text = `IEH ${label} ${SUFFIX}`;
  SECRETS.add(text);
  return text;
}
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const saveBody = (tenant, customer, lines) => ({ expectedTenant: tenant, customerId: customer, currency: 'USD', lines });
const editBody = (tenant, version, customer, lines, over = {}) => ({ expectedTenant: tenant, expectedVersion: version, customerId: customer, lines, ...over });

/**
 * What a case's tenants hold now — drafts, lines, EDIT audit records, edit events — the sealed completions of its keys, and,
 * across the whole database (the suite's cases run one at a time), EVERY audit record (AA), every outbox row (OO), every
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
/** A rolled-back answer: nothing but the lease its key acquired in its own transaction, left open. */
const LEASE_ONLY = Object.freeze({ ...NOTHING, LE: 1 });
/** A sealed answer: its completion only. */
const COMPLETION_ONLY = Object.freeze({ ...NOTHING, K: 1, C: 1 });
/** One applied edit under a key: its line delta, one edit audit record, one event, one completion. */
const ONE_EDIT = (lines) => Object.freeze({ D: 0, L: lines, A: 1, O: 1, K: 1, AA: 1, OO: 1, C: 1, LE: 0 });
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
const anchorsOf = async (tenant, role) => (await owner`select domain from tmpos_role.tenant_role_level where tenant_id = ${tenant} and role_id = ${role} order by domain`)
  .map((r) => r.domain);
/** A tenant's role rows and role-level edit counters exactly as stored, row versions (xmin) included: a write by anyone moves them. */
async function invoicesRowsOf(tenant) {
  return {
    roles: (await owner`select role_id, domain, level, xmin::text as xmin from tmpos_role.tenant_role_level where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
    versions: (await owner`select role_id, domain, version::text as version, xmin::text as xmin from tmpos_role_edit.role_level_version where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
  };
}
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
    relay, port, lines, stop,
    read: (s, path, headers = {}) => send(port, 'GET', path,
      { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers }, undefined, { localAddress: from }),
    get: (s, store, id) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/${id}`),
    list: (s, store) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts`),
    eligibility: (s, store, headers = {}) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/eligibility`, headers),
    editEligibility: (s, store, id, { query = '', headers = {} } = {}) => ctx.read(s, `/api/v1/stores/${store}/invoice-drafts/${id}/edit-eligibility${query}`, headers),
    save: (s, store, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'POST', `/api/v1/stores/${store}/invoice-drafts`, body, key, headers),
    patch: (s, store, id, body, { key = randomUUID(), headers = {} } = {}) => unsafe(s, 'PATCH', `/api/v1/stores/${store}/invoice-drafts/${id}`, body, key, headers),
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
  SECRETS.add(csrf).add(cookie.slice(cookie.indexOf('=') + 1)).add(key);
  return { cookie, csrf, key, principal: who.principal };
}
/** Save a draft through the production POST; its id. */
async function seed(ctx, s, store, tenant, customer, lines) {
  const reply = await ctx.save(s, store, saveBody(tenant, customer, lines));
  assert.equal(reply.status, 201, `the seed save: ${reply.body}`);
  const id = JSON.parse(reply.body).draft.id;
  SECRETS.add(id);
  return id;
}
/** An edit's 200: exactly { draftId, version, changed }. */
function editedOf(reply, { draftId, version, changed }, label, { replayed = false } = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify({ draftId, version, changed }), `${label}: the exact sealed body`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assert.equal(reply.headers.location, undefined, `${label}: no Location`);
  assertBaseline(reply, label);
}
/** A sealed 409: exactly { "error": word }, no correlator. */
function sealedOf(reply, word, label, { replayed = false } = {}) {
  assert.equal(reply.status, 409, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify({ error: word }), `${label}: the exact sealed body`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}
/** A reopened draft: exactly the get's shape. */
function draftOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assertBaseline(reply, label);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['draft'], label);
  assert.deepEqual(Object.keys(body.draft), ['id', 'storeId', 'customerId', 'status', 'currency', 'version', 'createdAt', 'subtotalCents', 'lines'], label);
  return body.draft;
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
const linesOf = (draft) => draft.lines.map((l) => [l.position, l.description, l.quantity, l.unitPriceCents, l.lineTotalCents]);

// ---------------------------------------------------------------------------
// levers (customerEditHttp's and invoiceDraftsHttp's)
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
 * edit's transaction has ended (rolled back) when this returns. Bounded by the lock timeout, never a sleep.
 */
async function headerFree(draft) {
  await owner.begin(async (sql) => {
    await sql`select pg_catalog.set_config('lock_timeout', ${`${WAIT_MS}ms`}, true)`;
    await sql`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${draft} for update`;
  });
}
const TRIGGER_ACTIONS = Object.freeze({
  raise: `raise exception 'IEH injected fault' using errcode = 'P0001';`,
  park: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); return coalesce(new, old);`,
  /** Parks on PARK, and raises once the park is released: the command fails AFTER it has done everything but complete. */
  parkRaise: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); raise exception 'IEH injected fault' using errcode = 'P0001';`,
});
/**
 * `work` runs with ONE owner trigger BEFORE `event` (insert | update | delete) on `table` for each row matching `when`: it
 * counts itself on ieh_proof.fired (a sequence, so the count survives the rollback it causes), then raises or parks on PARK.
 * Dropped, with its function, whatever `work` did.
 */
async function withTrigger(table, event, when, action, work) {
  await owner.unsafe(`create function ieh_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('ieh_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function ieh_proof.fire() from public');
  await owner.unsafe(`create trigger ieh_fire before ${event} on ${table} for each row when (${when}) execute function ieh_proof.fire()`);
  try { return await work(); } finally {
    await owner.unsafe(`drop trigger if exists ieh_fire on ${table}`);
    await owner.unsafe('drop function if exists ieh_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('ieh_proof.fired'::regclass), 0)::int as n`)[0].n;
const DRAFT_TABLE = 'tmpos_invoice_draft.invoice_draft';
const LINE_TABLE = 'tmpos_invoice_draft.invoice_draft_line';
/** The locks `pid` waits for (pg_locks, ungranted): locktype, mode, the transaction id or the relation. */
const waitsOf = async (pid) => (await probe`select l.locktype, l.mode, l.transactionid::text as xid, l.relation::regclass::text as relation
  from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted`).map((r) => ({ ...r }));
/** The guard key of (tenant, role) as the database computes it (migration 030): hashtext of 'tenant/role', an int4. */
const guardKey = async (tenant, role) => (await probe`select pg_catalog.hashtext(${tenant}::text || '/' || ${role}::text) as k`)[0].k;
/** The advisory locks of the guard's class (530030, objsubid 2) `pid` holds or waits for: key (int4), mode, granted. */
const guardLocksOf = async (pid) => (await probe`select l.objid::int as key, l.objsubid::int as sub, l.mode::text as mode, l.granted
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' and l.classid::int = 530030 order by 1, 3, 4`).map((r) => ({ ...r }));
/** The guard lock an edit holds (ShareLock) or a level writer holds or waits for (ExclusiveLock) on (tenant, role). */
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

// ===========================================================================
// IEH-01: a real edit, end to end
// ===========================================================================

test('IEH-01 (AC-03 AC-05): a manager replaces a draft\'s customer and ordered lines — the 200 at version 2, one audit record naming the draft, one invoice_draft.updated event at version 2, the new representation through a second entry; the immutable fields unchanged', async () => {
  const T = await newTenant('ieh01');
  const S = await newStore(T, 'IEH01 store');
  const C = await newCustomer(T, 'ieh01-a');
  const C2 = await newCustomer(T, 'ieh01-b');
  const S2 = await newStore(T, 'IEH01 other store');
  const who = await actor('ieh01', [storeGrant(T, S, 'manager'), storeGrant(T, S2, 'manager')]);
  await withEntry((a) => withEntry(async (b) => {
    const s = await signIn(a, who);
    const sb = await signIn(b, who);
    const id = await seed(a, s, S, T, C, [line(described('one'), 2, 50), line(described('two'), 1, 7)]);
    // Bystanders: another draft of the same store and one of the actor's other store — an edit touches exactly its own rows.
    const sibling = await seed(a, s, S, T, C, [line(described('sibling'), 1, 1)]);
    const elsewhere = await seed(a, s, S2, T, C, [line(described('elsewhere'), 2, 2), line(described('elsewhere two'), 3, 3)]);
    const bystanders = await Promise.all([sibling, elsewhere].map(stateOf));
    const original = await stateOf(id);
    assert.equal(original.header.version, '1');
    assert.equal(draftOf(await a.get(s, S, id), 'the saved draft').version, 1);
    assert.equal(verdictOf(await a.editEligibility(s, S, id), 'the edit eligibility'), 'allowed');
    const key = randomUUID();
    const keys = [{ key, principal: who.principal }];
    const lines = [line(described('three'), 3, 1_000), line(described('one'), 2, 50), line(described('four'), 1, 0)];
    const before = await counts([T], keys);
    const reply = await a.patch(s, S, id, editBody(T, 1, C2, lines), { key });
    editedOf(reply, { draftId: id, version: 2, changed: true }, 'the edit');
    assert.deepEqual(delta(await counts([T], keys), before), ONE_EDIT(1), 'three lines for two, one audit record, one event, one completion');
    assert.deepEqual(await Promise.all([sibling, elsewhere].map(stateOf)), bystanders,
      'the same store\'s other draft and the other store\'s draft untouched: header, lines and their xmin');
    // Read back through the SECOND entry, its own session: the database's representation alone.
    const got = draftOf(await b.get(sb, S, id), 'the edited draft, read on the second entry');
    assert.deepEqual([got.id, got.storeId, got.customerId, got.status, got.currency, got.version, got.subtotalCents],
      [id, S, C2, 'draft', 'USD', 2, 3_100], 'customer, subtotal and version moved together');
    assert.deepEqual(linesOf(got), [[1, lines[0].description, 3, 1_000, 3_000], [2, lines[1].description, 2, 50, 100], [3, lines[2].description, 1, 0, 0]],
      'the complete ordered collection, positions 1..n');
    const after = await stateOf(id);
    for (const column of ['draft_id', 'tenant_id', 'store_id', 'status', 'currency', 'created_at', 'created_by']) {
      assert.equal(after.header[column], original.header[column], `${column} unchanged`);
    }
    assert.equal(got.createdAt.slice(0, 19), draftOf(await a.get(s, S, id), 'again').createdAt.slice(0, 19));
    // The audit record: the edit's own action, permission, scope, actor and subject — and nothing of its content.
    const audit = await owner`select action_id, required_permission, scope_type, tenant_id, store_id, actor_internal_user_id, subject_invoice_draft_id,
      subject_customer_id, subject_tenant_id, decision, result_status, metadata from public.audit_event where action_id = ${ACTION} and subject_invoice_draft_id = ${id}`;
    assert.equal(audit.length, 1);
    assert.deepEqual({ ...audit[0] }, {
      action_id: ACTION, required_permission: 'edit_invoice_drafts', scope_type: 'store', tenant_id: T, store_id: S, actor_internal_user_id: who.id,
      subject_invoice_draft_id: id, subject_customer_id: null, subject_tenant_id: null, decision: 'allow', result_status: 'succeeded', metadata: {},
    });
    const events = await owner`select event_type, event_version, aggregate_type, aggregate_id, aggregate_version::text as aggregate_version, payload
      from tmpos_internal.outbox_event where event_type = ${EVENT} and aggregate_id = ${id}`;
    assert.equal(events.length, 1);
    assert.deepEqual({ ...events[0] }, {
      event_type: EVENT, event_version: 1, aggregate_type: 'invoice_draft', aggregate_id: id, aggregate_version: '2',
      payload: { storeId: S, customerId: C2, lineCount: 3 },
    }, 'identifiers and a count, at the new version');
    // The same key and bytes replay the sealed 200.
    editedOf(await a.patch(s, S, id, editBody(T, 1, C2, lines), { key }), { draftId: id, version: 2, changed: true }, 'the retry', { replayed: true });
    assert.deepEqual(delta(await counts([T], keys), before), ONE_EDIT(1), 'the retry wrote nothing');
  }));
});

// ===========================================================================
// IEH-02: authority
// ===========================================================================

test('IEH-02 (AC-03 AC-04): the edit eligibility answers 200 exactly when the PATCH is authorized — built-in defaults, owner-edited Invoices levels (Customers None never matters), a tenant-only grant, a read_only store — and its 200 is the creation eligibility\'s exact bytes; a Create-only role gets the creation eligibility and is refused both', async () => {
  const T = await newTenant('ieh02');
  const S = await newStore(T, 'IEH02 store');
  const C = await newCustomer(T, 'ieh02');
  const ownerActor = await actor('ieh02-owner', [storeGrant(T, S, 'store_owner')]);
  const roles = {};
  for (const role of ['manager', 'technician', 'sales_staff']) roles[role] = await actor(`ieh02-${role}`, [storeGrant(T, S, role)]);
  const tenantOnly = await actor('ieh02-tenant-only', [tenantGrant(T, 'store_owner')]);
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, ownerActor);
    const id = await seed(ctx, so, S, T, C, [line(described('authority'), 1, 1)]);
    let version = 1;
    const sessions = { store_owner: so };
    for (const [role, who] of Object.entries(roles)) sessions[role] = await signIn(ctx, who);
    const principals = { store_owner: ownerActor.principal, ...Object.fromEntries(Object.entries(roles).map(([r, w]) => [r, w.principal])) };
    /** Eligibility, then the PATCH it predicts: allowed ⇒ the 200 at the next version; forbidden ⇒ the authorizer's 403, nothing written. */
    const decide = async (role, label) => {
      const s = sessions[role];
      const verdict = verdictOf(await ctx.editEligibility(s, S, id), `${label}: the edit eligibility`);
      const key = randomUUID();
      const keys = [{ key, principal: principals[role] }];
      const before = await counts([T], keys);
      const reply = await ctx.patch(s, S, id, editBody(T, version, C, [line(described(`authority ${label}`), 1, version)]), { key });
      if (verdict === 'allowed') {
        editedOf(reply, { draftId: id, version: version + 1, changed: true }, `${label}: the PATCH`);
        version += 1;
        assert.deepEqual(delta(await counts([T], keys), before), ONE_EDIT(0), label);
      } else {
        assertRefusal(reply, 403, 'forbidden', `${label}: the PATCH`);
        assert.equal(ctx.reason(reply), 'authz_denied', `${label}: the authorizer's own refusal`);
        assert.deepEqual(delta(await counts([T], keys), before), NOTHING, `${label}: nothing written`);
        assert.equal((await owner`select count(*)::int as n from tmpos_internal.idempotency_record where scope = ${scopeOf(key, principals[role])}`)[0].n, 0,
          `${label}: refused before any key was acquired`);
      }
      return verdict;
    };
    // Built-in defaults: owner and manager Edit; technician (View) and sales staff (Create) refused.
    assert.deepEqual({
      store_owner: await decide('store_owner', 'store_owner at its default'), manager: await decide('manager', 'manager at its default'),
      technician: await decide('technician', 'technician at its default'), sales_staff: await decide('sales_staff', 'sales_staff at its default'),
    }, { store_owner: 'allowed', manager: 'allowed', technician: 'forbidden', sales_staff: 'forbidden' });
    // The Create-only role: the creation eligibility allows it, the edit refuses it — Create never stands in for Edit.
    const create = await ctx.eligibility(sessions.sales_staff, S);
    const edit = await ctx.editEligibility(sessions.manager, S, id);
    assert.deepEqual([create.status, create.body], [200, '{"eligibility":"allowed"}'], 'sales staff: the creation eligibility');
    assert.equal(edit.body, create.body, 'the edit eligibility\'s 200 is the creation eligibility\'s exact bytes');
    // The owner's edits of the Invoices level decide, both directions; Customers None never matters.
    for (const [level, customers, expected] of [
      ['none', undefined, 'forbidden'], ['view', undefined, 'forbidden'], ['create', undefined, 'forbidden'], ['edit', undefined, 'allowed'],
      ['manage', undefined, 'allowed'], ['approve', undefined, 'allowed'], ['full', undefined, 'allowed'], ['edit', 'none', 'allowed'], ['create', 'full', 'forbidden'],
    ]) {
      for (const role of ['sales_staff', 'technician', 'manager']) {
        await setLevel(T, role, 'invoices', level);
        await setLevel(T, role, 'customers', customers ?? null);
        assert.equal(await decide(role, `${role} at Invoices ${level}, Customers ${customers ?? 'default'}`), expected, `${role} ${level} ${customers}`);
      }
    }
    // The owner has no editable level (020's CHECK admits no store_owner row): with every other role narrowed, it still edits.
    assert.equal(await decide('store_owner', 'store_owner beside narrowed roles'), 'allowed');
    // A tenant-only owner grant reaches no store (no inheritance): both 403.
    const st = await signIn(ctx, tenantOnly);
    assertRefusal(await ctx.editEligibility(st, S, id), 403, 'forbidden', 'a tenant-only grant: the edit eligibility');
    const tenantKey = randomUUID();
    assertRefusal(await ctx.patch(st, S, id, editBody(T, version, C, [line('x', 1, 1)]), { key: tenantKey }), 403, 'forbidden', 'a tenant-only grant: the PATCH');
    // A read_only store, on a session established after the change: the edit eligibility (a classified read) and the PATCH are
    // both the 403 writing nothing; the reopen still answers.
    await owner`update store set status = 'read_only' where store_id = ${S}`;
    try {
      const sr = await signIn(ctx, roles.manager);
      sessions.manager = sr;
      assert.equal(draftOf(await ctx.get(sr, S, id), 'a read_only store still reopens').version, version);
      assert.equal(await decide('manager', 'a manager at a read_only store'), 'forbidden');
    } finally {
      await owner`update store set status = 'active' where store_id = ${S}`;
    }
    const final = await stateOf(id);
    assert.equal(final.header.version, String(version), 'every allowed PATCH stepped the version exactly once');
  });
});

// ===========================================================================
// IEH-03: the current-version no-op
// ===========================================================================

test('IEH-03 (AC-06 AC-05, G/N): a current-version no-op is the sealed 200 changed:false — no row written (xmin unchanged), no audit record, event or role row — replayed under its key and sealed while it holds the header and the role\'s key (a rival edit waits for the header); equal totals and a reorder are changes; an edit makes no role row at all', async () => {
  const T = await newTenant('ieh03');
  const S = await newStore(T, 'IEH03 store');
  const C = await newCustomer(T, 'ieh03');
  const ownerActor = await actor('ieh03-owner', [storeGrant(T, S, 'store_owner')]);
  const who = await actor('ieh03-manager', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, ownerActor);
    const s = await signIn(ctx, who);
    const lines = [line(described('noop one'), 2, 100), line(described('noop two'), 1, 0)];
    const id = await seed(ctx, so, S, T, C, lines);
    assert.deepEqual(await anchorsOf(T, 'manager'), [], 'the store owner\'s save took no manager role row');
    const state = await stateOf(id);
    const key = randomUUID();
    const keys = [{ key, principal: who.principal }];
    const before = await counts([T], keys);
    const noop = await ctx.patch(s, S, id, editBody(T, 1, C, lines), { key });
    editedOf(noop, { draftId: id, version: 1, changed: false }, 'the no-op');
    assert.deepEqual(delta(await counts([T], keys), before), COMPLETION_ONLY, 'its completion only');
    assert.deepEqual(await stateOf(id), state, 'header and lines not written: every value, version 1, created_at and xmin unchanged');
    assert.deepEqual(await anchorsOf(T, 'manager'), [], 'no role anchor: a sealed answer carries no write (DA-36)');
    editedOf(await ctx.patch(s, S, id, editBody(T, 1, C, lines), { key }), { draftId: id, version: 1, changed: false }, 'the no-op replayed', { replayed: true });
    // Sealed while it holds the header: parked at its completion, a rival edit (another actor) waits on the no-op's lock.
    const rivalLines = [line(described('noop rival'), 1, 1)];
    const before2 = await counts([T]);
    await withTrigger('tmpos_internal.idempotency_record', 'update', COMPLETION, 'park', async () => {
      const lever = await holdPark();
      let parked;
      let pending;
      try {
        parked = quietly(ctx.patch(s, S, id, editBody(T, 1, C, lines)));
        const noopPid = waitingPid(await blockedOrSettled(parked, { by: lever.pid }), 'the no-op parked at its completion');
        // N (030): the parked no-op holds the manager's guard key SHARED — the sealed answer is committed under it, never without.
        assert.deepEqual(await guardLocksOf(noopPid), [await guardLock(T, 'manager', 'ShareLock')], 'the parked no-op holds the manager\'s key SHARED');
        pending = quietly(ctx.patch(so, S, id, editBody(T, 1, C, rivalLines)));
        const rivalPid = waitingPid(await blockedOrSettled(pending, { by: noopPid, query: AT_UPDATE }), 'the rival edit waiting on the no-op\'s header lock');
        await assertWaitsOnHeaderBehind(rivalPid, noopPid, 'the rival edit');
      } finally {
        await lever.commit();
      }
      editedOf(await replyTo(parked, 'the parked no-op'), { draftId: id, version: 1, changed: false }, 'the parked no-op commits first');
      editedOf(await replyTo(pending, 'the rival'), { draftId: id, version: 2, changed: true }, 'the rival lands after, at version 1');
    });
    assert.deepEqual(delta(await counts([T]), before2), { D: 0, L: -1, A: 1, O: 1, K: 0, AA: 1, OO: 1, C: 2, LE: 0 }, 'one change: the rival\'s; two completions');
    // Equal totals are not equal lines, and a reorder is a change.
    const v2 = [line(described('totals a'), 2, 50), line(described('totals b'), 1, 25)];
    editedOf(await ctx.patch(s, S, id, editBody(T, 2, C, v2)), { draftId: id, version: 3, changed: true }, 'to version 3');
    const sameTotal = [line(v2[0].description, 1, 100), line(v2[1].description, 1, 25)];
    editedOf(await ctx.patch(s, S, id, editBody(T, 3, C, sameTotal)), { draftId: id, version: 4, changed: true }, 'the same subtotal and count, other quantities: a change');
    editedOf(await ctx.patch(s, S, id, editBody(T, 4, C, [sameTotal[1], sameTotal[0]])), { draftId: id, version: 5, changed: true }, 'the same lines reordered: a change');
    editedOf(await ctx.patch(s, S, id, editBody(T, 5, C, [sameTotal[1], sameTotal[0]])), { draftId: id, version: 5, changed: false }, 'and then the same again: the no-op');
    // A description normalized to the stored one (trimmed) is the same line.
    const padded = [{ ...sameTotal[1], description: `  ${sameTotal[1].description}  ` }, sameTotal[0]];
    editedOf(await ctx.patch(s, S, id, editBody(T, 5, C, padded)), { draftId: id, version: 5, changed: false }, 'a description that normalizes to the stored one');
    assert.deepEqual(await anchorsOf(T, 'manager'), [], 'an edit makes no role row at all (030): the change path made none, and took no Customers row either');
    assert.deepEqual(await invoicesRowsOf(T), { roles: [], versions: [] }, 'and no role_level_version row');
  });
});

// ===========================================================================
// IEH-04: stale versions
// ===========================================================================

test('IEH-04 (AC-07 AC-12): a stale edit and a stale no-op are the sealed 409 write_conflict, replayed under their keys, writing only their completions; a completed edit\'s retry replays its first 200 after later edits moved the version', async () => {
  const T = await newTenant('ieh04');
  const S = await newStore(T, 'IEH04 store');
  const C = await newCustomer(T, 'ieh04');
  const who = await actor('ieh04', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const lines1 = [line(described('stale one'), 1, 1)];
    const id = await seed(ctx, s, S, T, C, lines1);
    const firstKey = randomUUID();
    const lines2 = [line(described('stale two'), 2, 2)];
    const first = await ctx.patch(s, S, id, editBody(T, 1, C, lines2), { key: firstKey });
    editedOf(first, { draftId: id, version: 2, changed: true }, 'to version 2');
    const state = await stateOf(id);
    for (const [label, body] of [
      ['a stale edit', editBody(T, 1, C, [line(described('stale three'), 3, 3)])],
      ['a stale no-op (the contents equal the stored ones)', editBody(T, 1, C, lines2)],
      ['a version from the future', editBody(T, 3, C, [line(described('stale four'), 4, 4)])],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      sealedOf(await ctx.patch(s, S, id, body, { key }), 'write_conflict', label);
      sealedOf(await ctx.patch(s, S, id, body, { key }), 'write_conflict', `${label}: replayed`, { replayed: true });
      assert.deepEqual(delta(await counts([T], keys), before), COMPLETION_ONLY, `${label}: its sealed 409 only`);
      assert.deepEqual(await stateOf(id), state, `${label}: the draft untouched`);
    }
    // Replay before evaluation: the first edit's retry is its first 200, after a later edit moved the version past it.
    editedOf(await ctx.patch(s, S, id, editBody(T, 2, C, [line(described('stale five'), 5, 5)])), { draftId: id, version: 3, changed: true }, 'a later edit to 3');
    const late = await ctx.patch(s, S, id, editBody(T, 1, C, lines2), { key: firstKey });
    editedOf(late, { draftId: id, version: 2, changed: true }, 'the first edit\'s retry at version 3', { replayed: true });
    assert.equal(late.body, first.body, 'the first 200, byte for byte');
    assert.equal((await stateOf(id)).header.version, '3', 'no replay moved the version');
    assert.equal(draftOf(await ctx.get(s, S, id), 'the current draft').version, 3, 'a detail read shows the later version honestly');
  });
});

// ===========================================================================
// IEH-05: two instances, two actors, one version
// ===========================================================================

test('IEH-05 (AC-08): two tenant entries over one database, two Edit actors, one expected version — one 200 and one sealed 409 that replays, ordered by an owner\'s hold of the draft header, both directions', async () => {
  const T = await newTenant('ieh05');
  const S = await newStore(T, 'IEH05 store');
  const C = await newCustomer(T, 'ieh05');
  const first = await actor('ieh05-owner', [storeGrant(T, S, 'store_owner')]);
  const second = await actor('ieh05-manager', [storeGrant(T, S, 'manager')]);
  await withEntry((a) => withEntry(async (b) => {
    const sa = await signIn(a, first);
    const sb = await signIn(b, second);
    const id = await seed(a, sa, S, T, C, [line(described('raced seed'), 1, 1)]);
    for (const [round, version, [x, sx, labelX], [y, sy, labelY]] of [
      [1, 1, [a, sa, 'A'], [b, sb, 'B']],
      [2, 2, [b, sb, 'B'], [a, sa, 'A']],
    ]) {
      const winner = [line(described(`raced ${round} ${labelX}`), 2, round)];
      const loser = [line(described(`raced ${round} ${labelY}`), 3, round)];
      const loserKey = randomUUID();
      const before = await counts([T]);
      const h = await holdHeader(id);
      let px;
      let py;
      try {
        px = quietly(x.patch(sx, S, id, editBody(T, version, C, winner)));
        const xPid = waitingPid(await blockedOrSettled(px, { by: h.pid, query: AT_UPDATE }), `round ${round}: ${labelX} waiting on the header`);
        await assertWaitsOnHeaderBehind(xPid, h.pid, `round ${round}: ${labelX}`);
        py = quietly(y.patch(sy, S, id, editBody(T, version, C, loser), { key: loserKey }));
        const yPid = waitingPid(await blockedOrSettled(py, { by: xPid, query: AT_UPDATE }), `round ${round}: ${labelY} queued behind ${labelX}`);
        await assertQueuedOnHeaderTuple(yPid, `round ${round}: ${labelY}`);
      } finally {
        await h.commit();
      }
      editedOf(await replyTo(px, labelX), { draftId: id, version: version + 1, changed: true }, `round ${round}: ${labelX} commits`);
      sealedOf(await replyTo(py, labelY), 'write_conflict', `round ${round}: ${labelY} conflicts on the version ${labelX} moved`);
      sealedOf(await y.patch(sy, S, id, editBody(T, version, C, loser), { key: loserKey }), 'write_conflict', `round ${round}: ${labelY}'s 409 replays`, { replayed: true });
      assert.deepEqual(delta(await counts([T]), before), { D: 0, L: 0, A: 1, O: 1, K: 0, AA: 1, OO: 1, C: 2, LE: 0 }, `round ${round}: one change, two completions`);
      const got = draftOf(await y.get(sy, S, id), `round ${round}: the winner's draft`);
      assert.deepEqual([got.version, linesOf(got)], [version + 1, [[1, winner[0].description, 2, round, 2 * round]]], `round ${round}: the winner's lines`);
    }
  }));
});

// ===========================================================================
// IEH-06: a read during an uncommitted edit
// ===========================================================================

test('IEH-06 (AC-09, HTTP): while an edit has replaced the lines and stepped the version but not committed, the reopen and the list answer the complete EARLIER draft; once it commits, the complete later one', async () => {
  const T = await newTenant('ieh06');
  const S = await newStore(T, 'IEH06 store');
  const C = await newCustomer(T, 'ieh06');
  const C2 = await newCustomer(T, 'ieh06-b');
  const who = await actor('ieh06', [storeGrant(T, S, 'manager')]);
  // The reader is another actor with its own session: 016's hold locks the EDITOR's account, and the editor's session row is
  // held by its command, so only a reader that shares neither shows what any reader sees.
  const reader = await actor('ieh06-reader', [storeGrant(T, S, 'technician')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const r = await signIn(ctx, reader);
    const earlier = [line(described('read one'), 1, 10), line(described('read two'), 2, 20)];
    const id = await seed(ctx, s, S, T, C, earlier);
    const old = draftOf(await ctx.get(r, S, id), 'the earlier draft');
    const later = [line(described('read three'), 3, 30), line(described('read four'), 4, 40), line(described('read five'), 5, 50)];
    await withTrigger('tmpos_internal.idempotency_record', 'update', COMPLETION, 'park', async () => {
      const lever = await holdPark();
      let parked;
      try {
        parked = quietly(ctx.patch(s, S, id, editBody(T, 1, C2, later)));
        const editPid = waitingPid(await blockedOrSettled(parked, { by: lever.pid }), 'the edit parked at its completion, its business writes done');
        // Its writes are in place, uncommitted: it holds the lines' and the header's RowExclusiveLock (its DELETE, INSERT and
        // UPDATE), and the header row is locked — an owner FOR UPDATE NOWAIT on it is refused (55P03).
        assert.equal(await holds(editPid, LINE_TABLE, 'relation', 'RowExclusiveLock'), 1, 'the parked edit wrote the lines');
        assert.equal(await holds(editPid, DRAFT_TABLE, 'relation', 'RowExclusiveLock'), 1, 'the parked edit wrote the header');
        await assert.rejects(owner.begin(async (sql) => { await sql`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${id} for update nowait`; }),
          (e) => e?.code === '55P03', 'the header is locked by the parked edit');
        // A reader sees the complete earlier draft.
        const during = draftOf(await ctx.get(r, S, id), 'the reopen during the held edit');
        assert.deepEqual(during, old, 'the complete earlier draft — header, version, subtotal and every line');
        const listed = JSON.parse((await ctx.list(r, S)).body).drafts.find((d) => d.id === id);
        assert.deepEqual([listed.customerId, listed.lineCount, listed.subtotalCents], [C, 2, 50], 'the list: the earlier draft too');
      } finally {
        await lever.commit();
      }
      editedOf(await replyTo(parked, 'the held edit'), { draftId: id, version: 2, changed: true }, 'the held edit commits');
    });
    const now = draftOf(await ctx.get(r, S, id), 'after the commit');
    assert.deepEqual([now.version, now.customerId, now.subtotalCents, linesOf(now)], [2, C2, 500, [
      [1, later[0].description, 3, 30, 90], [2, later[1].description, 4, 40, 160], [3, later[2].description, 5, 50, 250],
    ]], 'the complete later draft');
  });
});

// ===========================================================================
// IEH-07: not found, never enumerating; the precondition
// ===========================================================================

test('IEH-07 (AC-10, D3): a missing draft, another store\'s, another tenant\'s, a missing customer and another tenant\'s are one 404 writing nothing (the lease left open); an expectedTenant that is not the store\'s is the unsealed 409, nothing written', async () => {
  const T = await newTenant('ieh07');
  const T2 = await newTenant('ieh07-other');
  const S = await newStore(T, 'IEH07 store');
  const S2 = await newStore(T, 'IEH07 second store');
  const X = await newStore(T2, 'IEH07 foreign store');
  const C = await newCustomer(T, 'ieh07');
  const C2 = await newCustomer(T2, 'ieh07-foreign');
  const who = await actor('ieh07', [storeGrant(T, S, 'manager'), storeGrant(T, S2, 'manager')]);
  const foreign = await actor('ieh07-foreign', [storeGrant(T2, X, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const sf = await signIn(ctx, foreign);
    const id = await seed(ctx, s, S, T, C, [line(described('nf mine'), 1, 1)]);
    const elsewhere = await seed(ctx, s, S2, T, C, [line(described('nf other store'), 1, 1)]);
    const theirs = await seed(ctx, sf, X, T2, C2, [line(described('nf other tenant'), 1, 1)]);
    const states = await Promise.all([id, elsewhere, theirs].map(stateOf));
    const bodies = [];
    for (const [label, draft, customer] of [
      ['a missing draft', randomUUID(), C], ['another store\'s draft (the actor\'s own other store)', elsewhere, C],
      ['another tenant\'s draft', theirs, C], ['a missing customer', id, randomUUID()], ['another tenant\'s customer', id, C2],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T, T2], keys);
      const reply = await ctx.patch(s, S, draft, editBody(T, 1, customer, [line(described(`nf ${label}`), 2, 2)]), { key });
      assertRefusal(reply, 404, 'not_found', label);
      assert.equal(ctx.reason(reply), 'transaction_not_found', label);
      bodies.push(JSON.parse(reply.body).error);
      assert.equal(Buffer.byteLength(reply.body), Buffer.byteLength(JSON.stringify({ error: 'not_found', requestId: JSON.parse(reply.body).requestId })), label);
      assert.deepEqual(delta(await counts([T, T2], keys), before), LEASE_ONLY, `${label}: nothing written but the open lease`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: rolled back, the lease open`);
      assertRefusal(await ctx.patch(s, S, draft, editBody(T, 1, customer, [line(described(`nf ${label}`), 2, 2)]), { key }), 409, 'request_in_progress',
        `${label}: the retry within the lease`);
    }
    assert.deepEqual(new Set(bodies), new Set(['not_found']), 'one body for all five');
    assert.deepEqual(await Promise.all([id, elsewhere, theirs].map(stateOf)), states, 'every draft untouched');
    // The edit eligibility for each of those ids: the same 200, so it enumerates nothing.
    for (const draft of [id, elsewhere, theirs, randomUUID()]) {
      assert.equal(verdictOf(await ctx.editEligibility(s, S, draft), `the edit eligibility for ${draft === id ? 'the draft' : 'another id'}`), 'allowed');
    }
    // The precondition: another tenant, or one that does not exist, is the unsealed 409 in the chain's shape.
    for (const [label, expected] of [['another tenant', T2], ['a tenant that does not exist', randomUUID()]]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const body = editBody(expected, 1, C, [line(described(`mismatch ${label}`), 1, 5)]);
      const before = await counts([T, T2], keys);
      const reply = await ctx.patch(s, S, id, body, { key });
      assertRefusal(reply, 409, 'write_conflict', `${label}: the precondition`);
      assert.equal(ctx.reason(reply), 'transaction_precondition_failed', label);
      assert.equal(reply.headers['idempotent-replayed'], undefined, `${label}: not a replay`);
      assert.deepEqual(delta(await counts([T, T2], keys), before), LEASE_ONLY, `${label}: nothing written, no completion, the lease open`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease open — unsealed`);
      assertRefusal(await ctx.patch(s, S, id, body, { key }), 409, 'request_in_progress', `${label}: the same-key retry within the lease`);
    }
    assert.deepEqual(await stateOf(id), states[0], 'the draft untouched');
  });
});

// ===========================================================================
// IEH-08: faults inside the command
// ===========================================================================

test('IEH-08 (AC-11, G; AC-08, N): a fault at the line DELETE, the line INSERT, the header UPDATE, the audit INSERT, the outbox INSERT or the completion — or at a no-op\'s completion — is the 503 with the earlier draft intact, nothing recorded and the lease open; a no-op\'s and a sealed conflict\'s completion that parks holding the role\'s key and then raises is the 503 LEASE_ONLY with no role row, the key gone with the transaction, and the blocked level writer then commits', async (t) => {
  const T = await newTenant('ieh08');
  const S = await newStore(T, 'IEH08 store');
  const C = await newCustomer(T, 'ieh08');
  const C2 = await newCustomer(T, 'ieh08-b');
  const who = await actor('ieh08', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const seeded = [line(described('fault one'), 1, 10), line(described('fault two'), 2, 20)];
    const id = await seed(ctx, s, S, T, C, seeded);
    const state = await stateOf(id);
    const change = editBody(T, 1, C2, [line(described('fault new one'), 3, 3), line(described('fault new two'), 4, 4)]);
    for (const [label, table, event, when, body] of [
      ['the line DELETE raises', 'tmpos_invoice_draft.invoice_draft_line', 'delete', `old.draft_id = '${id}'::uuid`, change],
      ['the second line INSERT raises', 'tmpos_invoice_draft.invoice_draft_line', 'insert', `new.draft_id = '${id}'::uuid and new.position = 2`, change],
      ['the header UPDATE raises', 'tmpos_invoice_draft.invoice_draft', 'update', `old.draft_id = '${id}'::uuid`, change],
      ['the audit INSERT raises', 'public.audit_event', 'insert', `new.action_id = '${ACTION}' and new.subject_invoice_draft_id = '${id}'::uuid`, change],
      ['the outbox INSERT raises', 'tmpos_internal.outbox_event', 'insert', `new.event_type = '${EVENT}' and new.aggregate_id = '${id}'::uuid`, change],
      ['the completion raises', 'tmpos_internal.idempotency_record', 'update', COMPLETION, change],
      ['a no-op\'s completion raises', 'tmpos_internal.idempotency_record', 'update', COMPLETION, editBody(T, 1, C, seeded)],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      const firedBefore = await fired();
      const reply = await withTrigger(table, event, when, 'raise', () => ctx.patch(s, S, id, body, { key }));
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: nothing recorded but the open lease`);
      assert.deepEqual(await stateOf(id), state, `${label}: the earlier draft intact — header, version, lines and xmin`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease, taken in its own transaction, is open`);
      assertRefusal(await ctx.patch(s, S, id, body, { key }), 409, 'request_in_progress', `${label}: the retry within the lease`);
    }
    // Since 032 (M7B-INVOICES-P1-R4) the seed's own save (the production POST by this manager) makes no role row at all — 031's
    // save still made the manager's Customers NULL lock anchor, and 028's the Invoices one. The owner makes the Invoices NULL row
    // 028's save used to make, so the writer below is a level UPDATE of an existing row (021's counter advancing to 1), exactly the
    // ordering these rounds prove.
    assert.deepEqual((await invoicesRowsOf(T)).roles.map(({ xmin, ...r }) => r), [],
      'the save made no role row (032): no Customers anchor, no Invoices row');
    await setLevel(T, 'manager', 'invoices', null);
    // N (030): the fault comes AFTER the edit has done everything but complete, with the role's key held. While the completion is
    // parked the edit's backend holds the manager's key SHARED — a no-op's and a sealed conflict's answer alike — and a non-NULL
    // level write by the owner is blocked by exactly that backend; when the park is released the completion raises: the 503, the
    // lease open, no role row made by the edit — and the key goes with the transaction, so the writer commits.
    for (const [label, body] of [
      ['a no-op', editBody(T, 1, C, seeded)],
      ['a sealed conflict', editBody(T, 2, C2, [line(described('fault stale'), 1, 1)])],
    ]) {
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      const firedBefore = await fired();
      // The manager's NULL lock anchor (the Invoices one made above; the seed's save made none): the rows the edit must not add to.
      const rowsBefore = await invoicesRowsOf(T);
      let writer;
      let reply;
      const clock = {};
      await withTrigger('tmpos_internal.idempotency_record', 'update', COMPLETION, 'parkRaise', async () => {
        const lever = await holdPark();
        let pending;
        try {
          clock.sent = Date.now();
          pending = quietly(ctx.patch(s, S, id, body, { key }));
          const editPid = waitingPid(await blockedOrSettled(pending, { by: lever.pid }), `${label}: parked at its completion`);
          assert.deepEqual(await guardLocksOf(editPid), [await guardLock(T, 'manager', 'ShareLock')], `${label}: the parked edit holds the manager's key SHARED`);
          // (The edit's own uncommitted rows would be invisible here — IDE-18 reads them inside the edit's transaction and finds none;
          // what shows it is the writer below: it waits for the key ALONE, never for a role row the edit would have locked or made.)
          assert.deepEqual(await invoicesRowsOf(T), rowsBefore, `${label}: parked, the committed role and version rows are as they were`);
          writer = ownerWrite(`${label}: a non-NULL level write`, (sql) => setLevel(T, 'manager', 'invoices', 'full', sql));
          const outcome = await ownerOutcome(writer);
          assert.ok(outcome?.blocked && outcome.blockers.includes(editPid), `${label}: the level write is blocked by the edit's backend (${JSON.stringify(outcome)})`);
          const writerPid = (await writer.started).pid;
          assert.deepEqual((await guardLocksOf(writerPid)).filter((l) => !l.granted), [await guardLock(T, 'manager', 'ExclusiveLock', false)], `${label}: waiting for the manager's key, EXCLUSIVE`);
          assert.deepEqual((await waitsOf(writerPid)).map((w) => w.locktype), ['advisory'], `${label}: for nothing else`);
          clock.released = Date.now();
        } finally {
          await lever.commit();
        }
        reply = await replyTo(pending, label);
      });
      evidence(t, { case: `IEH-08 ${label}`, msSentToRelease: clock.released - clock.sent, limitMs: CONCLUSIVE_WINDOW_MS });
      assert.ok(clock.released - clock.sent < CONCLUSIVE_WINDOW_MS,
        `INCONCLUSIVE: ${label} was in flight ${clock.released - clock.sent} ms when the park was released (limit ${CONCLUSIVE_WINDOW_MS} ms): a lock timeout could be the failure`);
      assertRefusal(reply, 503, 'service_unavailable', `${label}: the raise after the park`);
      assert.notEqual(ctx.reason(reply), 'transaction_timeout', `${label}: the injected fault, not a lock timeout`);
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: nothing recorded but the open lease`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease open`);
      assert.deepEqual(await stateOf(id), state, `${label}: the earlier draft intact`);
      assert.equal(await within(writer.done, `${label}: the level writer`), 'committed', `${label}: the key went with the transaction: the writer committed`);
      const rowsAfter = await invoicesRowsOf(T);
      assert.deepEqual(rowsAfter.roles.map(({ xmin, ...r }) => r), rowsBefore.roles.map(({ xmin, ...r }) => (r.domain === 'invoices' ? { ...r, level: 'full' } : r)),
        `${label}: the same role rows as before, the Invoices one as the writer wrote it — the edit made none`);
      assert.deepEqual(rowsAfter.versions.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', version: '1' }], `${label}: and the only version row is the writer's own`);
      assert.equal((await probe`select count(*)::int as n from pg_catalog.pg_locks where locktype = 'advisory' and classid::int = 530030`)[0].n, 0, `${label}: no guard lock stands`);
      // The writer's level back to the NULL anchor, its version row removed: the next round starts as this one did.
      await owner`update tmpos_role.tenant_role_level set level = null where tenant_id = ${T} and role_id = 'manager' and domain = 'invoices'`;
      await owner`delete from tmpos_role_edit.role_level_version where tenant_id = ${T}`;
    }
    // Control: without a fault the same change commits.
    editedOf(await ctx.patch(s, S, id, change), { draftId: id, version: 2, changed: true }, 'the change without a fault');
  });
});

// ===========================================================================
// IEH-09: one key, one request
// ===========================================================================

test('IEH-09 (AC-12): under one key, other bytes, another draft and another store are each the 422 before any write; the original keeps replaying', async () => {
  const T = await newTenant('ieh09');
  const S = await newStore(T, 'IEH09 store');
  const S2 = await newStore(T, 'IEH09 second store');
  const C = await newCustomer(T, 'ieh09');
  const who = await actor('ieh09', [storeGrant(T, S, 'manager'), storeGrant(T, S2, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const id = await seed(ctx, s, S, T, C, [line(described('key one'), 1, 1)]);
    const other = await seed(ctx, s, S, T, C, [line(described('key two'), 1, 1)]);
    const there = await seed(ctx, s, S2, T, C, [line(described('key three'), 1, 1)]);
    const key = randomUUID();
    const lines = [line(described('key edit a'), 2, 2), line(described('key edit b'), 3, 3)];
    const body = JSON.stringify(editBody(T, 1, C, lines));
    const first = await ctx.patch(s, S, id, body, { key });
    editedOf(first, { draftId: id, version: 2, changed: true }, 'the edit');
    const states = await Promise.all([id, other, there].map(stateOf));
    const before = await counts([T]);
    for (const [label, store, draft, bytes] of [
      ['another version', S, id, JSON.stringify(editBody(T, 2, C, lines))],
      ['another line order', S, id, JSON.stringify(editBody(T, 1, C, [lines[1], lines[0]]))],
      ['the same JSON value re-spaced', S, id, JSON.stringify(editBody(T, 1, C, lines), null, 1)],
      ['another draft of the store', S, other, body],
      ['another store\'s draft', S2, there, body],
    ]) {
      const reply = await ctx.patch(s, store, draft, bytes, { key });
      assertRefusal(reply, 422, 'idempotency_key_reused', label);
    }
    assert.deepEqual(delta(await counts([T]), before), NOTHING, 'refused before any write');
    assert.deepEqual(await Promise.all([id, other, there].map(stateOf)), states, 'every draft untouched');
    editedOf(await ctx.patch(s, S, id, body, { key }), { draftId: id, version: 2, changed: true }, 'the original replays', { replayed: true });
  });
});

// ===========================================================================
// IEH-10: lost COMMIT answers
// ===========================================================================

test('IEH-10 (AC-13): the COMMIT lands and its answer is lost (an edit, a no-op, a sealed 409) — 503, then the same key and bytes replay the sealed answer, the version stepped once; the COMMIT never lands — 503, nothing, 409 until the lease ends, then one step', async () => {
  const T = await newTenant('ieh10');
  const S = await newStore(T, 'IEH10 store');
  const C = await newCustomer(T, 'ieh10');
  const who = await actor('ieh10', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const seeded = [line(described('lost seed'), 1, 1)];
    const id = await seed(ctx, s, S, T, C, seeded);
    /** Send under a trap; the reply, after asserting the trap engaged exactly once. */
    const trapped = async (mode, anchor, body, key, label) => {
      const trap = trapCommit(ctx.relay, mode, anchor);
      let reply;
      const sentAt = Date.now();
      try { reply = await ctx.patch(s, S, id, body, { key }); } finally { trap.release(); }
      assert.equal(trap.hit.length, 1, `${label}: the trap engaged at exactly one COMMIT`);
      assertRefusal(reply, 503, 'service_unavailable', label);
      return { reply, elapsed: Date.now() - sentAt };
    };
    /** Poll (bounded) until the OWNER sees `predicate` hold — what landed becomes visible; never a sleep for an outcome. */
    const until = async (predicate, label) => {
      for (const end = Date.now() + WAIT_MS; Date.now() < end; await tick()) if (await predicate()) return;
      assert.fail(`${label}: not observed within ${WAIT_MS} ms`);
    };
    // (1) A real edit LANDED, its answer lost (anchor: the audit INSERT).
    const key1 = randomUUID();
    const keys1 = [{ key: key1, principal: who.principal }];
    const edit1 = editBody(T, 1, C, [line(described('lost edit'), 2, 50)]);
    const before1 = await counts([T], keys1);
    const lost = await trapped('lose', AUDIT_ANCHOR, edit1, key1, 'the lost edit answer');
    assert.equal(ctx.reason(lost.reply), 'transaction_timeout', 'unknown at the commit deadline');
    assert.ok(lost.elapsed >= COMMAND_TRANSACTION_DEADLINE_MS - 50, 'answered at the commit\'s own deadline');
    await until(async () => (await counts([T], keys1)).K === before1.K + 1, 'the landed edit');
    assert.deepEqual(delta(await counts([T], keys1), before1), ONE_EDIT(0), 'what committed is visible, whole');
    // A key is no authority: with the manager narrowed to Invoices Create (committed), the retry is the authorizer's 403.
    await setLevel(T, 'manager', 'invoices', 'create');
    assertRefusal(await ctx.patch(s, S, id, edit1, { key: key1 }), 403, 'forbidden', 'the retry without current authority');
    await setLevel(T, 'manager', 'invoices', null);
    editedOf(await ctx.patch(s, S, id, edit1, { key: key1 }), { draftId: id, version: 2, changed: true }, 'the same-key retry replays', { replayed: true });
    assert.equal((await stateOf(id)).header.version, '2', 'stepped exactly once');
    assert.deepEqual(delta(await counts([T], keys1), before1), ONE_EDIT(0), 'never a second step');
    // (2) A no-op LANDED, its answer lost (anchor: the completion — a no-op writes no audit record).
    const key2 = randomUUID();
    const keys2 = [{ key: key2, principal: who.principal }];
    const noop = editBody(T, 2, C, [line(edit1.lines[0].description, 2, 50)]);
    const state2 = await stateOf(id);
    const before2 = await counts([T], keys2);
    await trapped('lose', COMPLETION_ANCHOR, noop, key2, 'the lost no-op answer');
    await until(async () => (await counts([T], keys2)).K === before2.K + 1, 'the landed no-op');
    editedOf(await ctx.patch(s, S, id, noop, { key: key2 }), { draftId: id, version: 2, changed: false }, 'the no-op replays', { replayed: true });
    assert.deepEqual(delta(await counts([T], keys2), before2), COMPLETION_ONLY, 'its completion only');
    assert.deepEqual(await stateOf(id), state2, 'nothing written');
    // (3) A sealed 409 LANDED, its answer lost (anchor: the completion).
    const key3 = randomUUID();
    const keys3 = [{ key: key3, principal: who.principal }];
    const stale = editBody(T, 1, C, [line(described('lost stale'), 9, 9)]);
    const before3 = await counts([T], keys3);
    await trapped('lose', COMPLETION_ANCHOR, stale, key3, 'the lost 409 answer');
    await until(async () => (await counts([T], keys3)).K === before3.K + 1, 'the landed 409');
    sealedOf(await ctx.patch(s, S, id, stale, { key: key3 }), 'write_conflict', 'the 409 replays', { replayed: true });
    assert.deepEqual(await stateOf(id), state2, 'nothing written');
    // (4) NOT LANDED: the COMMIT never reaches the server; the connection is cut and the server rolls the edit back.
    const key4 = randomUUID();
    const keys4 = [{ key: key4, principal: who.principal }];
    const edit4 = editBody(T, 2, C, [line(described('cut edit'), 4, 4), line(described('cut edit two'), 5, 5)]);
    const before4 = await counts([T], keys4);
    await trapped('cut', AUDIT_ANCHOR, edit4, key4, 'the cut COMMIT');
    await headerFree(id); // granted only once the cut transaction has ended
    assert.deepEqual(delta(await counts([T], keys4), before4), LEASE_ONLY, 'nothing landed: the lease alone, open');
    assert.deepEqual(await stateOf(id), state2, 'the draft as it was');
    assertRefusal(await ctx.patch(s, S, id, edit4, { key: key4 }), 409, 'request_in_progress', 'the same-key retry within the lease never re-plans');
    await expireLease(key4, who.principal);
    editedOf(await ctx.patch(s, S, id, edit4, { key: key4 }), { draftId: id, version: 3, changed: true }, 'after the lease: the explicit retry plans again');
    editedOf(await ctx.patch(s, S, id, edit4, { key: key4 }), { draftId: id, version: 3, changed: true }, 'and replays', { replayed: true });
    assert.deepEqual(delta(await counts([T], keys4), before4), ONE_EDIT(1), 'exactly one step (the lease reclaimed and completed)');
    assert.equal((await stateOf(id)).header.version, '3');
  });
});

// ===========================================================================
// IEH-11: authority ordered against the commit
// ===========================================================================

test('IEH-11 (AC-14, G; barriers N): a downgrade to Invoices Create, a grant suspension, a store made read_only and a session revocation committed while the edit waits on 016\'s hold — or a downgrade committed while the edit waits for the role\'s guard key — leave nothing; a downgrade attempted while the edit holds the key waits for the edit\'s COMMIT', async () => {
  const one = async (statement, what) => assert.equal((await statement).count, 1, `${what}: exactly one row changed`);
  await withEntry(async (ctx) => {
    // (a) committed while the edit waits on 016's hold: the revalidator re-reads and refuses inside the transaction.
    for (const [label, change, next] of [
      ['Invoices narrowed to Create first', (f) => (sql) => setLevel(f.T, 'manager', 'invoices', 'create', sql), [403, 'forbidden']],
      ['the grant suspended first', (f) => (sql) => one(sql`update user_membership set status = 'suspended' where internal_user_id = ${f.who.id}`, 'the grant suspended'), [401, 'unauthenticated']],
      ['the store made read_only first', (f) => (sql) => one(sql`update store set status = 'read_only' where store_id = ${f.S}`, 'the store made read_only'), [401, 'unauthenticated']],
      ['the session revoked first', (f) => (sql) => sql`select tmpos_session.m5_session_revoke(${f.s.key}::text)`, [401, 'unauthenticated']],
    ]) {
      const tag = randomUUID().slice(0, 6);
      const T = await newTenant(`ieh11-a-${tag}`);
      const S = await newStore(T, `IEH11 a ${tag}`);
      const C = await newCustomer(T, `ieh11-a-${tag}`);
      const who = await actor(`ieh11-a-${tag}`, [storeGrant(T, S, 'manager')]);
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
        pending = quietly(ctx.patch(s, S, id, editBody(T, 1, C, [line(described(`never ${label}`), 2, 2)]), { key }));
        waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_HOLD }), `${label}: the edit waiting on 016's hold`);
        // Parked on the hold, before the owner's change: the edit has written its lease (its own transaction) and nothing else.
        assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${label}: parked, the edit holds its lease only`);
        const outcome = await ownerOutcome(ownerWrite(label, change(f)));
        assert.equal(outcome?.settled, 'committed', `${label}: the change commits while the edit waits (${JSON.stringify(outcome)})`);
        // The baseline after the owner's change (which may audit itself) and while the edit still waits: from here on only
        // the edit can write.
        mid = await counts([T], keys);
      } finally {
        await h.commit();
      }
      const reply = await replyTo(pending, label);
      assertRefusal(reply, 503, 'service_unavailable', `${label}: refused inside the transaction`);
      assert.equal(ctx.reason(reply), 'transaction_unavailable', `${label}: refused, never a timeout`);
      assert.deepEqual(delta(await counts([T], keys), mid), NOTHING, `${label}: the edit wrote nothing`);
      assert.deepEqual(await stateOf(id), state, `${label}: the draft untouched`);
      assert.equal(await leaseOpen(key, who.principal), true, `${label}: the lease open`);
      const after = await ctx.patch(s, S, id, editBody(T, 1, C, [line(described(`next ${label}`), 3, 3)]));
      assertRefusal(after, next[0], next[1], `${label}: the next request`);
    }
    // (b) committed while the edit waits for the role's KEY: the owner's uncommitted downgrade holds the manager's Invoices row
    // and, through migration 030's trigger, the role's advisory key EXCLUSIVE; the edit passes every unlocked check, locks the
    // header, and waits for the key at step 5b (never for the role row); the downgrade commits, and 5b's fresh re-read after the
    // wait refuses — nothing written.
    {
      const T = await newTenant('ieh11-b');
      const S = await newStore(T, 'IEH11 b');
      const C = await newCustomer(T, 'ieh11-b');
      const who = await actor('ieh11-b', [storeGrant(T, S, 'manager')]);
      const s = await signIn(ctx, who);
      const id = await seed(ctx, s, S, T, C, [line(described('role row seed'), 1, 1)]);
      await setLevel(T, 'manager', 'invoices', 'full');
      const state = await stateOf(id);
      const key = randomUUID();
      const keys = [{ key, principal: who.principal }];
      const before = await counts([T], keys);
      const h = await hold('the Invoices role row narrowed, uncommitted', (sql) => one(sql`update tmpos_role.tenant_role_level set level = 'create'
        where tenant_id = ${T} and role_id = 'manager' and domain = 'invoices'`, 'the downgrade'));
      let pending;
      try {
        pending = quietly(ctx.patch(s, S, id, editBody(T, 1, C, [line(described('role row edit'), 2, 2)]), { key }));
        const pid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_UPDATE }), 'the edit waiting for the role\'s guard key');
        assert.deepEqual((await waitsOf(pid)).map((w) => w.locktype), ['advisory'], 'it waits for an advisory lock — not the role row');
        assert.deepEqual(await guardLocksOf(pid), [await guardLock(T, 'manager', 'ShareLock', false)], 'the manager\'s key, SHARED, ungranted');
        assert.deepEqual(await guardLocksOf(h.pid), [await guardLock(T, 'manager', 'ExclusiveLock')], 'held EXCLUSIVE by the uncommitted downgrade');
      } finally {
        await h.commit();
      }
      const reply = await replyTo(pending, 'the edit after the downgrade');
      assertRefusal(reply, 503, 'service_unavailable', 'the re-decision after the key wait refuses');
      assert.equal(ctx.reason(reply), 'transaction_unavailable');
      assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, 'nothing written but the open lease');
      assert.deepEqual(await stateOf(id), state, 'the draft untouched');
      assertRefusal(await ctx.patch(s, S, id, editBody(T, 1, C, [line(described('role row next'), 3, 3)])), 403, 'forbidden', 'the next request: the authorizer');
    }
    // (c) The reverse: the edit holds the role's key SHARED (parked at its completion, every write done); the downgrade's UPDATE
    // waits for that key, behind the edit, which commits first; then the downgrade applies, and the next edit is refused.
    {
      const T = await newTenant('ieh11-c');
      const S = await newStore(T, 'IEH11 c');
      const C = await newCustomer(T, 'ieh11-c');
      const who = await actor('ieh11-c', [storeGrant(T, S, 'manager')]);
      const s = await signIn(ctx, who);
      const id = await seed(ctx, s, S, T, C, [line(described('reverse seed'), 1, 1)]);
      await setLevel(T, 'manager', 'invoices', 'full');
      const before = await counts([T]);
      let rival;
      await withTrigger('tmpos_internal.idempotency_record', 'update', COMPLETION, 'park', async () => {
        const lever = await holdPark();
        let parked;
        try {
          parked = quietly(ctx.patch(s, S, id, editBody(T, 1, C, [line(described('reverse edit'), 2, 2)])));
          const editPid = waitingPid(await blockedOrSettled(parked, { by: lever.pid }), 'the edit parked at its completion');
          rival = ownerWrite('the downgrade', (sql) => one(sql`update tmpos_role.tenant_role_level set level = 'create'
            where tenant_id = ${T} and role_id = 'manager' and domain = 'invoices'`, 'the downgrade'));
          const outcome = await ownerOutcome(rival);
          assert.ok(outcome?.blocked && outcome.blockers.includes(editPid), `the downgrade waits for the edit (${JSON.stringify(outcome)})`);
          const rivalPid = (await rival.started).pid;
          assert.deepEqual(await guardLocksOf(editPid), [await guardLock(T, 'manager', 'ShareLock')], 'the parked edit holds the manager\'s key SHARED');
          assert.deepEqual((await guardLocksOf(rivalPid)).filter((l) => !l.granted), [await guardLock(T, 'manager', 'ExclusiveLock', false)], 'the downgrade waits for that key, EXCLUSIVE');
          assert.deepEqual((await waitsOf(rivalPid)).map((w) => w.locktype), ['advisory'], 'and for nothing else');
        } finally {
          await lever.commit();
        }
        editedOf(await replyTo(parked, 'the edit'), { draftId: id, version: 2, changed: true }, 'the edit commits first');
      });
      assert.equal(await within(rival.done, 'the downgrade'), 'committed', 'the downgrade commits after');
      assert.deepEqual(delta(await counts([T]), before), { D: 0, L: 0, A: 1, O: 1, K: 0, AA: 1, OO: 1, C: 1, LE: 0 }, 'one change');
      assertRefusal(await ctx.patch(s, S, id, editBody(T, 2, C, [line(described('reverse next'), 3, 3)])), 403, 'forbidden', 'then the downgrade decides');
    }
  });
});

// ===========================================================================
// IEH-15: DA-204 — a downgrade committed through the owner's own PUT while the edit waits on the draft header
// ===========================================================================

/**
 * The edit's lock waits are bounded (lock_timeout 1400 ms, a 2 s transaction): a PATCH that was in flight longer than this when
 * the header was released may have been refused by a TIMEOUT, which would look like the refusal under test. Such a case is
 * INCONCLUSIVE — a failure, never a pass.
 */
const CONCLUSIVE_WINDOW_MS = 1_100;

test('IEH-15 (AC-01 AC-02 AC-03 DA-204): two tenant entries over one database — the owner\'s PUT downgrading the manager\'s Invoices level (an existing override, then an absent one) commits on entry B while a current no-op or a stale edit waits on the draft header on entry A; released, the edit is the 503 transaction_unavailable, nothing changed since the downgrade, the lease open', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    for (const [name, absent, stale] of [
      ['(a) an existing override, a current no-op', false, false],
      ['(b) an existing override, a stale version', false, true],
      ['(c) an absent override, a current no-op', true, false],
      ['(d) an absent override, a stale version', true, true],
    ]) {
      await t.test(`DA-204 defect reproduction: ${name}`, async (st) => {
        const tag = randomUUID().slice(0, 6);
        const T = await newTenant(`ieh15-${tag}`);
        const S = await newStore(T, `IEH15 ${tag}`);
        const C = await newCustomer(T, `ieh15-${tag}`);
        // The store owner (fixed Full: it never makes a role row) saves and prepares the draft; the manager is the editor under
        // test; the owner of the downgrade is a THIRD actor holding exactly one tenant-scope grant (the setter's authority shape).
        const storeOwner = await actor(`ieh15-so-${tag}`, [storeGrant(T, S, 'store_owner')]);
        const manager = await actor(`ieh15-mgr-${tag}`, [storeGrant(T, S, 'manager')]);
        const boss = await actor(`ieh15-boss-${tag}`, [tenantGrant(T, 'store_owner')]);
        if (!absent) await setLevel(T, 'manager', 'invoices', 'edit');
        const so = await signIn(a, storeOwner);
        const sm = await signIn(a, manager);
        const sb = await signIn(b, boss);
        const lines = [line(described(`ieh15 ${tag}`), 2, 100)];
        const id = await seed(a, so, S, T, C, lines);
        if (stale) {
          editedOf(await a.patch(so, S, id, editBody(T, 1, C, [line(described(`ieh15 prepared ${tag}`), 1, 5)])), { draftId: id, version: 2, changed: true }, `${name}: the draft prepared at version 2`);
        }
        // The edit: a current no-op, or a version-1 edit of a version-2 draft (the sealed 409 of the entry source).
        const body = stale ? editBody(T, 1, C, [line(described(`ieh15 stale ${tag}`), 3, 3)]) : editBody(T, 1, C, lines);
        // The owner is signed in on entry B, its pool warmed and the version it reviews read, BEFORE the edit starts to wait.
        const read = await b.read(sb, '/api/v1/roles/levels/invoices');
        assert.equal(read.status, 200, `${name}: the owner reads the Invoices levels: ${read.body}`);
        const reviewed = Number(JSON.parse(read.body).roles.find((r) => r.roleId === 'manager').version);
        const putBody = { roleId: 'manager', domain: 'invoices', level: 'create', reason: described(`ieh15 downgrade ${tag}`), expectedTenant: T, expectedVersion: reviewed };
        const rolesBefore = await invoicesRowsOf(T);
        if (absent) assert.deepEqual(rolesBefore, { roles: [], versions: [] }, `${name}: no Invoices role row and no version row: the catalog default governs`);
        else assert.deepEqual(rolesBefore.roles.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', level: 'edit' }], `${name}: the stored override`);
        const state = await stateOf(id);
        const key = randomUUID();
        const keys = [{ key, principal: manager.principal }];
        const putKey = randomUUID();
        const putKeys = [{ key: putKey, principal: boss.principal }];
        const before = await counts([T], keys);
        const h = await holdHeader(id);
        let pending;
        let mid;
        let rolesAfterPut;
        let stillWaiting;
        let waitedOn;
        const clock = {};
        try {
          clock.sent = Date.now();
          pending = quietly(a.patch(sm, S, id, body, { key }));
          // THE BARRIER: past every unlocked decision (016's hold, the session, the grant, step 3's Invoices level), the edit
          // waits on the draft header an owner session holds — and holds nothing the downgrade needs.
          const pid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_UPDATE }), `${name}: the edit waiting on the draft header`);
          clock.waiting = Date.now();
          await assertWaitsOnHeaderBehind(pid, h.pid, name);
          waitedOn = await waitsOf(pid);
          assert.deepEqual(delta(await counts([T], keys), before), LEASE_ONLY, `${name}: parked on the header, the edit holds its lease only`);
          assert.deepEqual(await invoicesRowsOf(T), rolesBefore, `${name}: the downgrade has not run yet`);
          // The downgrade: the owner's own PUT on the OTHER entry, through the production chain, commits while the edit waits.
          clock.put = Date.now();
          const put = await replyTo(b.levels(sb, putBody, { key: putKey }), `${name}: the owner's downgrade`);
          clock.putDone = Date.now();
          assert.equal(put.status, 200, `${name}: the downgrade commits while the edit waits: ${put.body}`);
          assert.deepEqual(JSON.parse(put.body), { roleLevel: { roleId: 'manager', domain: 'invoices', level: 'create', version: reviewed + 1 } }, `${name}: the PUT's own answer`);
          // The PUT's own footprint, separately: its role row and version row, one tenant-scope audit record, its own completion.
          rolesAfterPut = await invoicesRowsOf(T);
          assert.deepEqual(rolesAfterPut.roles.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', level: 'create' }], `${name}: the PUT's role row`);
          assert.deepEqual(rolesAfterPut.versions.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', version: String(reviewed + 1) }], `${name}: the PUT's version row`);
          assert.equal((await owner`select count(*)::int as n from public.audit_event where action_id = 'tenant.role.level.update' and tenant_id = ${T}`)[0].n, 1, `${name}: the PUT's one audit record`);
          assert.equal((await counts([T], putKeys)).K, 1, `${name}: the PUT's own sealed completion`);
          // The baseline for the edit's own effects, taken while it still waits: from here on only the edit can write.
          mid = await counts([T], keys);
          stillWaiting = (await blockedNow({ by: h.pid, query: AT_UPDATE })).length === 1;
          assert.equal(stillWaiting, true, `${name}: the edit still waits on the header after the downgrade committed`);
          clock.released = Date.now();
        } finally {
          await h.commit();
        }
        const reply = await replyTo(pending, name);
        const after = await counts([T], keys);
        const reason = (() => { try { return a.reason(reply); } catch (err) { return `unread: ${err.message}`; } })();
        evidence(st, { case: `IEH-15 ${name}`, decidingRead: 'step 3 (unlocked Invoices level) before the header wait; the revalidator\'s unlocked read before it', waitedOn,
          downgradeCommittedBeforeRelease: stillWaiting === true, answer: { status: reply.status, body: reply.body, reason },
          msFromSendToRelease: clock.released - clock.sent, msFromWaitSeenToRelease: clock.released - clock.waiting, msPut: clock.putDone - clock.put,
          deltaSinceMid: delta(after, mid), leaseOpen: await leaseOpen(key, manager.principal),
          draftUntouched: JSON.stringify(await stateOf(id)) === JSON.stringify(state),
          rolesUnchangedSincePut: JSON.stringify(await invoicesRowsOf(T)) === JSON.stringify(rolesAfterPut) });
        assert.ok(clock.released - clock.sent < CONCLUSIVE_WINDOW_MS,
          `INCONCLUSIVE: the edit was in flight ${clock.released - clock.sent} ms when the header was released (limit ${CONCLUSIVE_WINDOW_MS} ms): a timeout could be the refusal`);
        assertRefusal(reply, 503, 'service_unavailable', `${name}: refused inside the transaction, not sealed`);
        assert.equal(reason, 'transaction_unavailable', `${name}: refused, never a timeout`);
        assert.deepEqual(delta(after, mid), NOTHING, `${name}: nothing changed since the downgrade committed — no completion, audit, event, draft or line`);
        assert.equal(await leaseOpen(key, manager.principal), true, `${name}: the lease open`);
        assert.deepEqual(await stateOf(id), state, `${name}: that draft's row and lines untouched (xmin included)`);
        assert.deepEqual(await invoicesRowsOf(T), rolesAfterPut, `${name}: the role and version rows exactly as the PUT wrote them`);
      });
    }
  }));
});

// ===========================================================================
// IEH-16, IEH-17: the guard key through the HTTP chain — an owner's PUT behind a parked edit; sealed answers replayed against the level
// ===========================================================================

/** A case's own edit columns: this draft's rows, its edit audit records, its events, its sealed completions (no whole-table column). */
const mine = ({ D, L, A, O, K }) => ({ D, L, A, O, K });

test('IEH-16 (AC-04, N): an edit parked at its completion holds the role\'s key — the owner\'s PUT on the other entry waits for that key behind the edit\'s backend; released, the edit is the sealed 200 and then the PUT is the 200; a later PATCH is the authorizer\'s 403', async (t) => {
  await withEntry((a) => withEntry(async (b) => {
    for (const [name, absent] of [['(a) an existing override, a real change', false], ['(b) an absent override, a current no-op', true]]) {
      const tag = randomUUID().slice(0, 6);
      const T = await newTenant(`ieh16-${tag}`);
      const S = await newStore(T, `IEH16 ${tag}`);
      const C = await newCustomer(T, `ieh16-${tag}`);
      const storeOwner = await actor(`ieh16-so-${tag}`, [storeGrant(T, S, 'store_owner')]);
      const manager = await actor(`ieh16-mgr-${tag}`, [storeGrant(T, S, 'manager')]);
      const boss = await actor(`ieh16-boss-${tag}`, [tenantGrant(T, 'store_owner')]);
      if (!absent) await setLevel(T, 'manager', 'invoices', 'edit');
      const so = await signIn(a, storeOwner);
      const sm = await signIn(a, manager);
      const sb = await signIn(b, boss);
      const lines = [line(described(`ieh16 ${tag}`), 2, 100)];
      const id = await seed(a, so, S, T, C, lines);
      // The owner is signed in on entry B, its pool warmed and the version it reviews read, BEFORE the edit parks (the park and the
      // PUT's wait both live inside the edit's lock timeout).
      const read = await b.read(sb, '/api/v1/roles/levels/invoices');
      assert.equal(read.status, 200, `${name}: the owner reads the Invoices levels: ${read.body}`);
      const reviewed = Number(JSON.parse(read.body).roles.find((r) => r.roleId === 'manager').version);
      const putBody = { roleId: 'manager', domain: 'invoices', level: 'create', reason: described(`ieh16 downgrade ${tag}`), expectedTenant: T, expectedVersion: reviewed };
      const body = absent ? editBody(T, 1, C, lines) : editBody(T, 1, C, [line(described(`ieh16 change ${tag}`), 3, 3)]);
      const key = randomUUID();
      const keys = [{ key, principal: manager.principal }];
      const putKey = randomUUID();
      const putKeys = [{ key: putKey, principal: boss.principal }];
      const before = await counts([T], keys);
      const rolesBefore = await invoicesRowsOf(T);
      const state = await stateOf(id);
      let parked;
      let put;
      let edited;
      let putReply;
      let putSettled = false;
      const clock = {};
      await withTrigger('tmpos_internal.idempotency_record', 'update', COMPLETION, 'park', async () => {
        const lever = await holdPark();
        try {
          parked = quietly(a.patch(sm, S, id, body, { key }));
          const editPid = waitingPid(await blockedOrSettled(parked, { by: lever.pid }), `${name}: the edit parked at its completion`);
          clock.parked = Date.now();
          assert.deepEqual(await guardLocksOf(editPid), [await guardLock(T, 'manager', 'ShareLock')], `${name}: the parked edit holds the manager's key SHARED`);
          // The edit's own uncommitted rows would be invisible to the owner here (IDE-18 reads them inside the edit's transaction and
          // finds none); what is shown is the committed state and, below, that the PUT waits for the key ALONE — never for a role row.
          assert.deepEqual(await invoicesRowsOf(T), rolesBefore, `${name}: parked, the committed role and version rows are as they were`);
          // The owner's PUT on the OTHER entry, through the production chain: it reaches the level UPDATE and waits for the key.
          put = quietly(b.levels(sb, putBody, { key: putKey }));
          put.then(() => { putSettled = true; });
          const putPid = waitingPid(await blockedOrSettled(put, { by: editPid }), `${name}: the owner's PUT waiting for the key behind the edit`);
          clock.putWaiting = Date.now();
          assert.deepEqual((await waitsOf(putPid)).map((w) => w.locktype), ['advisory'], `${name}: the PUT waits for an advisory lock — nothing else`);
          assert.deepEqual((await guardLocksOf(putPid)).filter((l) => !l.granted), [await guardLock(T, 'manager', 'ExclusiveLock', false)], `${name}: the manager's key, EXCLUSIVE`);
          assert.equal(putSettled, false, `${name}: the PUT has not answered while the edit holds the key`);
          clock.released = Date.now();
        } finally {
          await lever.commit();
        }
        // Both answers are awaited INSIDE the trigger's scope: its DROP (ACCESS EXCLUSIVE on the idempotency table) must not queue
        // between the PUT's lease check and its completion.
        edited = await replyTo(parked, `${name}: the parked edit`);
        putReply = await replyTo(put, `${name}: the owner's PUT`);
      });
      evidence(t, { case: `IEH-16 ${name}`, msParkedToPutWaiting: clock.putWaiting - clock.parked, msParkedToRelease: clock.released - clock.parked, limitMs: CONCLUSIVE_WINDOW_MS });
      assert.ok(clock.released - clock.parked < CONCLUSIVE_WINDOW_MS,
        `INCONCLUSIVE: ${name}: ${clock.released - clock.parked} ms from the edit's park to its release (limit ${CONCLUSIVE_WINDOW_MS} ms): its park wait could have timed out`);
      editedOf(edited, { draftId: id, version: absent ? 1 : 2, changed: !absent }, `${name}: the edit is the sealed 200 under its authority`);
      assert.equal(putReply.status, 200, `${name}: then the PUT commits: ${putReply.body}`);
      assert.deepEqual(JSON.parse(putReply.body), { roleLevel: { roleId: 'manager', domain: 'invoices', level: 'create', version: reviewed + 1 } }, `${name}: the PUT's own answer`);
      // The edit's own effects, target-specifically: that draft, its lines, its audit record and event, its completion.
      assert.deepEqual(mine(delta(await counts([T], keys), before)), absent ? { D: 0, L: 0, A: 0, O: 0, K: 1 } : { D: 0, L: 0, A: 1, O: 1, K: 1 }, `${name}: the edit's own effects`);
      if (absent) assert.deepEqual(await stateOf(id), state, `${name}: the no-op wrote nothing`);
      // The PUT's own footprint, separately: its role row, its version row, one tenant-scope audit record, its own completion.
      const after = await invoicesRowsOf(T);
      assert.deepEqual(after.roles.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', level: 'create' }], `${name}: the PUT's role row`);
      assert.deepEqual(after.versions.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', version: String(reviewed + 1) }], `${name}: the PUT's version row`);
      assert.equal((await owner`select count(*)::int as n from public.audit_event where action_id = 'tenant.role.level.update' and tenant_id = ${T}`)[0].n, 1, `${name}: the PUT's one audit record`);
      assert.equal((await counts([T], putKeys)).K, 1, `${name}: the PUT's own sealed completion`);
      assert.equal((await probe`select count(*)::int as n from pg_catalog.pg_locks where locktype = 'advisory' and classid::int = 530030`)[0].n, 0, `${name}: no guard lock stands`);
      // The downgrade now governs: the next edit is the authorizer's 403, nothing written.
      const beforeLater = await counts([T]);
      assertRefusal(await a.patch(sm, S, id, editBody(T, absent ? 1 : 2, C, [line(described(`ieh16 later ${tag}`), 4, 4)])), 403, 'forbidden', `${name}: a later edit meets the downgrade`);
      assert.deepEqual(mine(delta(await counts([T]), beforeLater)), { D: 0, L: 0, A: 0, O: 0, K: 0 }, `${name}: and wrote nothing`);
    }
  }));
});

/** What a draft holds that a replay must not move: its header and lines, its audit records and events (every column), and its two sealed completions. */
async function replayFootprint(draft, keys) {
  const [audit] = await owner`select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) order by pg_catalog.to_jsonb(a)::text), '[]'::jsonb) as rows
    from public.audit_event a where a.subject_invoice_draft_id = ${draft}`;
  const [outbox] = await owner`select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by pg_catalog.to_jsonb(o)::text), '[]'::jsonb) as rows
    from tmpos_internal.outbox_event o where o.aggregate_id = ${draft}`;
  const completions = (await owner`select response, xmin::text as xmin from tmpos_internal.idempotency_record
    where scope = any(${keys.map(({ key, principal }) => scopeOf(key, principal)).sort()}::text[]) order by scope`).map((r) => ({ ...r }));
  return { state: await stateOf(draft), audit: audit.rows, outbox: outbox.rows, completions };
}

test('IEH-17 (AC-09, G): a sealed no-op and a sealed conflict replay exactly; after the owner\'s PUT downgrade the replay is the authorizer\'s 403, after the PUT restores the level it answers the retained bytes (idempotent-replayed) — and that draft\'s version, audit records, events and sealed completions never moved', async () => {
  const tag = randomUUID().slice(0, 6);
  const T = await newTenant(`ieh17-${tag}`);
  const S = await newStore(T, `IEH17 ${tag}`);
  const C = await newCustomer(T, `ieh17-${tag}`);
  const storeOwner = await actor(`ieh17-so-${tag}`, [storeGrant(T, S, 'store_owner')]);
  const manager = await actor(`ieh17-mgr-${tag}`, [storeGrant(T, S, 'manager')]);
  const boss = await actor(`ieh17-boss-${tag}`, [tenantGrant(T, 'store_owner')]);
  await withEntry(async (ctx) => {
    const so = await signIn(ctx, storeOwner);
    const sm = await signIn(ctx, manager);
    const sb = await signIn(ctx, boss);
    const lines = [line(described(`ieh17 ${tag}`), 2, 100)];
    const id = await seed(ctx, so, S, T, C, lines);
    // To version 2, so that a version-1 edit is a sealed 409 and a version-2 edit of the stored contents a sealed no-op.
    const lines2 = [line(described(`ieh17 edited ${tag}`), 3, 30)];
    editedOf(await ctx.patch(sm, S, id, editBody(T, 1, C, lines2)), { draftId: id, version: 2, changed: true }, 'the real edit to version 2');
    const noopKey = randomUUID();
    const conflictKey = randomUUID();
    const keys = [{ key: noopKey, principal: manager.principal }, { key: conflictKey, principal: manager.principal }];
    const noopBody = editBody(T, 2, C, lines2);
    const conflictBody = editBody(T, 1, C, [line(described(`ieh17 stale ${tag}`), 5, 5)]);
    const noop = await ctx.patch(sm, S, id, noopBody, { key: noopKey });
    editedOf(noop, { draftId: id, version: 2, changed: false }, 'the sealed no-op');
    const conflict = await ctx.patch(sm, S, id, conflictBody, { key: conflictKey });
    sealedOf(conflict, 'write_conflict', 'the sealed conflict');
    const replays = async (when) => {
      const n = await ctx.patch(sm, S, id, noopBody, { key: noopKey });
      editedOf(n, { draftId: id, version: 2, changed: false }, `${when}: the no-op replayed`, { replayed: true });
      assert.equal(n.body, noop.body, `${when}: the no-op's retained bytes`);
      const c = await ctx.patch(sm, S, id, conflictBody, { key: conflictKey });
      sealedOf(c, 'write_conflict', `${when}: the conflict replayed`, { replayed: true });
      assert.equal(c.body, conflict.body, `${when}: the conflict's retained bytes`);
    };
    await replays('before any downgrade');
    const settled = await replayFootprint(id, keys);
    assert.equal(settled.completions.length, 2, 'both sealed completions are stored');
    // The owner downgrades the manager's Invoices level through the production PUT: the replays meet the authorizer.
    const read = await ctx.read(sb, '/api/v1/roles/levels/invoices');
    assert.equal(read.status, 200, `the owner reads the Invoices levels: ${read.body}`);
    const reviewed = Number(JSON.parse(read.body).roles.find((r) => r.roleId === 'manager').version);
    const down = await ctx.levels(sb, { roleId: 'manager', domain: 'invoices', level: 'create', reason: described(`ieh17 downgrade ${tag}`), expectedTenant: T, expectedVersion: reviewed });
    assert.equal(down.status, 200, `the downgrade: ${down.body}`);
    assert.deepEqual(JSON.parse(down.body), { roleLevel: { roleId: 'manager', domain: 'invoices', level: 'create', version: reviewed + 1 } }, 'the downgrade\'s own answer');
    assertRefusal(await ctx.patch(sm, S, id, noopBody, { key: noopKey }), 403, 'forbidden', 'the no-op\'s replay after the downgrade');
    assertRefusal(await ctx.patch(sm, S, id, conflictBody, { key: conflictKey }), 403, 'forbidden', 'the conflict\'s replay after the downgrade');
    assert.deepEqual(await replayFootprint(id, keys), settled, 'downgraded: that draft, its audit records, events and sealed completions did not move');
    // The owner restores it (Full, the manager's default word): the same keys and bytes replay the retained answers.
    const up = await ctx.levels(sb, { roleId: 'manager', domain: 'invoices', level: 'full', reason: described(`ieh17 restore ${tag}`), expectedTenant: T, expectedVersion: reviewed + 1 });
    assert.equal(up.status, 200, `the restore: ${up.body}`);
    assert.deepEqual(JSON.parse(up.body), { roleLevel: { roleId: 'manager', domain: 'invoices', level: 'full', version: reviewed + 2 } }, 'the restore\'s own answer');
    await replays('after the restore');
    assert.deepEqual(await replayFootprint(id, keys), settled, 'restored: that draft, its audit records, events and sealed completions still did not move');
    // The downgrade's and the restore's own writes, separately: the role row as restored, the version row twice stepped, two tenant audit records.
    const after = await invoicesRowsOf(T);
    assert.deepEqual(after.roles.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', level: 'full' }], 'the role row as the restore left it');
    assert.deepEqual(after.versions.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', version: String(reviewed + 2) }], 'the version row stepped by each PUT');
    assert.equal((await owner`select count(*)::int as n from public.audit_event where action_id = 'tenant.role.level.update' and tenant_id = ${T}`)[0].n, 2, 'one tenant audit record per PUT');
  });
});

// ===========================================================================
// IEH-12: bounds
// ===========================================================================

test('IEH-12 (AC-15): the closed body, the version bounds and the line contract are each the 400 writing nothing; 65,536 bytes are accepted and one more is the 413; 50 lines to 2^53 - 1 survive exactly; a malformed or unversioned draft id is the 400', async () => {
  const T = await newTenant('ieh12');
  const S = await newStore(T, 'IEH12 store');
  const C = await newCustomer(T, 'ieh12');
  const who = await actor('ieh12', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const id = await seed(ctx, s, S, T, C, [line(described('bounds seed'), 1, 1)]);
    const ok = (over = {}) => editBody(T, 1, C, [line(described('bounds'), 1, 1)], over);
    const without = (key) => Object.fromEntries(Object.entries(ok()).filter(([k]) => k !== key));
    const state = await stateOf(id);
    for (const [label, body] of [
      ['a currency', ok({ currency: 'USD' })], ['a subtotal', ok({ subtotalCents: 1 })], ['a total', ok({ totalCents: 1 })], ['an id', ok({ id })],
      ['a status', ok({ status: 'draft' })], ['a creation time', ok({ createdAt: '2026-10-07T00:00:00.000000Z' })], ['a store', ok({ storeId: S })],
      ['no expectedVersion', without('expectedVersion')], ['no lines', without('lines')], ['no customer', without('customerId')], ['no expectedTenant', without('expectedTenant')],
      ['version 0', ok({ expectedVersion: 0 })], ['version 2^53 - 1', ok({ expectedVersion: MAX })], ['version 1.5', ok({ expectedVersion: 1.5 })],
      ['version as text', ok({ expectedVersion: '1' })], ['version -1', ok({ expectedVersion: -1 })],
      ['no line', ok({ lines: [] })], ['51 lines', ok({ lines: Array.from({ length: 51 }, () => line('x', 1, 1)) })],
      ['a 257-scalar description', ok({ lines: [line('x'.repeat(257), 1, 1)] })], ['a control in a description', ok({ lines: [line('a\u0007b', 1, 1)] })],
      ['quantity 0', ok({ lines: [line('x', 0, 1)] })], ['a negative price', ok({ lines: [line('x', 1, -1)] })], ['a fractional price', ok({ lines: [line('x', 1, 0.5)] })],
      ['a product above 2^53 - 1', ok({ lines: [line('x', 2, Math.ceil(MAX / 2))] })], ['a sum above 2^53 - 1', ok({ lines: [line('x', 1, MAX), line('y', 1, 1)] })],
      ['a line total', ok({ lines: [{ ...line('x', 1, 1), lineTotalCents: 1 }] })], ['a position', ok({ lines: [{ ...line('x', 1, 1), position: 1 }] })],
      ['not JSON', '{'], ['an array', '[]'],
    ]) {
      const before = await counts([T]);
      const reply = await ctx.patch(s, S, id, body);
      assertRefusal(reply, 400, 'invalid_request', label);
      // Malformed JSON is refused before any key; every other body reaches the planner once its key is acquired, so its
      // lease is all that exists (it waits out its time).
      assert.deepEqual(delta(await counts([T]), before), label === 'not JSON' ? NOTHING : LEASE_ONLY, `${label}: nothing written`);
    }
    assert.deepEqual(await stateOf(id), state, 'the draft untouched');
    // The body bound: whitespace is JSON, so a valid edit padded to exactly 65,536 bytes is accepted; one byte more is the 413.
    const base = JSON.stringify(ok());
    const atBound = `${base.slice(0, -1)}${' '.repeat(BODY_BOUND - Buffer.byteLength(base))}}`;
    assert.equal(Buffer.byteLength(atBound), BODY_BOUND);
    const records = (await owner`select count(*)::int as n from tmpos_internal.idempotency_record`)[0].n;
    const overKey = randomUUID();
    assertRefusal(await ctx.patch(s, S, id, `${atBound} `, { key: overKey }), 413, 'content_too_large', '65,537 bytes');
    assert.equal((await owner`select count(*)::int as n from tmpos_internal.idempotency_record`)[0].n, records, 'the 413 reserves no key');
    editedOf(await ctx.patch(s, S, id, atBound), { draftId: id, version: 2, changed: true }, '65,536 bytes');
    // Fifty lines summing to exactly 2^53 - 1, read back exactly.
    const fifty = Array.from({ length: 50 }, (_, i) => line(described(`fifty ${i}`), 1, i === 0 ? MAX - 49 : 1));
    editedOf(await ctx.patch(s, S, id, editBody(T, 2, C, fifty)), { draftId: id, version: 3, changed: true }, 'fifty lines');
    const got = draftOf(await ctx.get(s, S, id), 'fifty lines read back');
    assert.deepEqual([got.subtotalCents, got.lines.length, got.lines[0].lineTotalCents, got.lines[49].position], [MAX, 50, MAX - 49, 50]);
    // The path's draft id: a malformed segment is the target's 400 before any key; an unversioned one the planner's 400.
    for (const segment of [id.toUpperCase(), 'x', `${id}0`]) {
      const reply = await ctx.patch(s, S, segment, ok());
      assertRefusal(reply, 400, 'invalid_request', `the segment ${segment.slice(0, 8)}`);
      assert.equal(ctx.reason(reply), 'command_target_invalid');
    }
    const unversioned = `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`;
    const reply = await ctx.patch(s, S, unversioned, ok());
    assertRefusal(reply, 400, 'invalid_request', 'an unversioned draft id');
    assert.equal(ctx.reason(reply), 'command_request_invalid');
  });
});

// ===========================================================================
// IEH-13: the chain
// ===========================================================================

test('IEH-13: around the edit and its eligibility — 401 without a session, the session CSRF witness, Origin and X-TMPOS-CSRF, no key, a query, another host, no-store everywhere; the eligibility the same bytes for any well-formed id', async () => {
  const T = await newTenant('ieh13');
  const S = await newStore(T, 'IEH13 store');
  const C = await newCustomer(T, 'ieh13');
  const who = await actor('ieh13', [storeGrant(T, S, 'manager')]);
  await withEntry(async (ctx) => {
    const s = await signIn(ctx, who);
    const other = await signIn(ctx, who);
    const id = await seed(ctx, s, S, T, C, [line(described('chain seed'), 1, 1)]);
    const body = editBody(T, 1, C, [line(described('chain edit'), 2, 2)]);
    const before = await counts([T]);
    assertRefusal(await ctx.patch(null, S, id, body), 401, 'unauthenticated', 'the PATCH without a session');
    assertRefusal(await ctx.patch(s, S, id, body, { headers: { [SESSION_CSRF_HEADER]: other.csrf } }), 403, 'forbidden', 'another session\'s CSRF token');
    assertRefusal(await ctx.patch(s, S, id, body, { headers: { origin: 'https://evil.test' } }), 403, 'forbidden', 'a cross-site Origin');
    assertRefusal(await ctx.patch(s, S, id, body, { headers: { [CSRF_HEADER]: '0' } }), 403, 'forbidden', 'no CSRF header value');
    const noKey = await send(ctx.port, 'PATCH', `/api/v1/stores/${S}/invoice-drafts/${id}`, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf,
    }, JSON.stringify(body));
    assertRefusal(noKey, 400, 'invalid_request', 'no Idempotency-Key');
    assertRefusal(await ctx.patch(s, S, id, body, { headers: { host: ADMIN_HOST } }), 404, 'not_found', 'the administrative host');
    assert.deepEqual(delta(await counts([T]), before), NOTHING, 'no chain refusal wrote anything');
    // The edit eligibility: the creation eligibility's conventions.
    assertRefusal(await ctx.editEligibility(null, S, id), 401, 'unauthenticated', 'no session');
    assertRefusal(await ctx.editEligibility(null, S, id, { headers: { cookie: s.cookie } }), 403, 'forbidden', 'no session CSRF token');
    assertRefusal(await ctx.editEligibility(null, S, id, { headers: { cookie: s.cookie, [SESSION_CSRF_HEADER]: other.csrf } }), 403, 'forbidden', 'another session\'s token');
    assertRefusal(await ctx.editEligibility(s, S, id, { query: '?x=1' }), 400, 'invalid_request', 'a query');
    assertRefusal(await ctx.editEligibility(s, S, id, { headers: { host: ADMIN_HOST } }), 404, 'not_found', 'the administrative host');
    assertRefusal(await ctx.editEligibility(s, S, 'x'), 400, 'invalid_request', 'a malformed id');
    assertRefusal(await ctx.editEligibility(s, S.toUpperCase(), id), 403, 'forbidden', 'a non-canonical store');
    const answers = await Promise.all([id, randomUUID(), `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`].map((d) => ctx.editEligibility(s, S, d)));
    for (const a of answers) assert.equal(verdictOf(a, 'a well-formed id'), 'allowed');
    assert.equal(new Set(answers.map((a) => a.body)).size, 1, 'one body for every well-formed id');
    const post = await send(ctx.port, 'POST', `/api/v1/stores/${S}/invoice-drafts/${id}/edit-eligibility`, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf,
    }, '');
    assertRefusal(post, 404, 'not_found', 'a POST to the edit eligibility');
    assert.deepEqual(delta(await counts([T]), before), NOTHING, 'no eligibility answer wrote anything');
    editedOf(await ctx.patch(s, S, id, body), { draftId: id, version: 2, changed: true }, 'control: the edit');
  });
});

// ===========================================================================
// IEH-14: the logs (last)
// ===========================================================================

test('IEH-14 (regression guard: it passes on the entry sources too): no log line carries a description, a customer, a draft, a tenant or store id, a session key, a CSRF token or an Idempotency-Key — nor does the server log of a cluster this file started', () => {
  const forbidden = [...SECRETS, ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)])];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const l of ALL_LOG_LINES) for (const secret of forbidden) assert.ok(!l.includes(secret), `a log line carries a secret: ${secret.slice(0, 6)}...`);
  if (cluster !== null) {
    const leaked = forbidden.filter((v) => readFileSync(`${cluster.root}/postgres.log`, 'utf8').includes(v));
    assert.deepEqual(leaked.map((v) => v.slice(0, 6)), [], 'the cluster\'s server log carries no secret');
  }
});
