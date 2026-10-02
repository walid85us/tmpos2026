// M7A-CUSTOMERS-P7 — PATCH /api/v1/customers/{id} END TO END: the tenant entry (server/entry/tenantEntry.ts, startTenantEntry)
// editing customers over REAL loopback HTTP and a disposable PostgreSQL holding every migration in the directory (001-025),
// composed exactly as server/entry/tenantMain.ts composes it but for its construction. The planner
// (server/runtime/customerUpdate.ts), the tenant command transaction and its revalidator, the mutator
// (server/persistence/postgresCustomerUpdate.ts), migration 024's tmpos_customer_edit.m7a_customer_update, the audit writer
// (subject_customer_id) and the completion are production's own code; the profile read is 024's versioned one.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — the three things tests/db/customerCreate.integration.test.mjs substitutes, none of them
// on the path under test: the database client (a supervised kernel over the cluster as a non-owner least-privilege runtime
// LOGIN, tmpos_m7ch_probe, holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can also
// drop a COMMIT's answer), the identity verifier (a synthetic bearer-token map) and the listener (127.0.0.1:0).
//
// WHAT IS PROVEN. C/U/K/O are the customer rows, the audit rows of action tenant.customer.update, the sealed idempotency
// completions and the outbox rows (L: every idempotency row, leases included), each a delta the OWNER reads around a case;
// V is the edited row's row_version.
//   M7CH-01 (AC-1) an Edit role's change of name, phone and email is the exact 200 {customer:{id,name},version:2,changed:true};
//           a SECOND tenant entry over the same database reads the new values with the same id and creation time (a legacy
//           NULL stays NULL) and ETag "2"; the detail and the list still answer {id,name} only;
//   M7CH-02 (AC-2) omitted contacts are kept, null and "" clear, names are trimmed; a missing name or expectedVersion, an
//           unknown or immutable key (id, createdAt, tenantId, version), a wrong type and a version out of range are 400s
//           that change nothing (row, version, audit, completion); a non-canonical id is a 400 after authentication only;
//   M7CH-03 (AC-3) View and Create roles are 403 and Edit and Full are 200; an owner's level edit after sign-in is honoured
//           both ways; read_only tenants and accounts are 403; another tenant's customer is the missing id's 404; an
//           administrative session or host and another session's CSRF witness are refused by the chain — nothing changes;
//   M7CH-04 (AC-4) one change is one version, one audit record (the session's actor and tenant, the customer as its subject,
//           metadata {}, no name, phone or email anywhere in it) and one sealed completion; the exact retry replays byte
//           for byte; a changed body or the same body at another customer under the key is the 422; a replay needs the session;
//   M7CH-05 (AC-4) an audit INSERT fault and a completion fault are 503s that leave the customer, its version and the audit
//           untouched; a lost COMMIT answer is a 503 whose retry replays what committed — never a second change;
//   M7CH-06 (AC-6) a current no-op is 200 changed:false at the same version, no audit, the row not written, its completion
//           sealed while it still holds the row (a rival edit waits for it), and its retry replays; a stale no-op is the 409;
//           a completed edit's retry replays its 200 after later edits moved the version (replay before evaluation);
//   M7CH-07 (AC-5) two tenant entries, one database, two Edit actors, one expected version: one 200 and one sealed 409
//           write_conflict that replays under its key, ordered by an owner's hold of the customer row;
//   M7CH-08 (AC-5) revocations ordered by lock waits: a grant suspension, a session revocation or a level narrowing that
//           commits while the edit waits on 016's hold leaves nothing; one attempted while the edit holds its locks waits
//           for the edit's commit;
//   M7CH-09 no captured log line carries a customer name, phone, email or id, a session identifier, key, CSRF token or an
//           Idempotency-Key — nor, on a cluster this file started, the server's own log.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster
// this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every edit it
// commits writes an audit record naming a customer, and audit records are append-only, so on a shared service 024 cannot be
// rolled back after it: its CI step runs after every suite that rolls 024 back. It deletes every customer it made (no
// row_version above 1 survives it), its role-level rows, its sessions, mint-ledger rows and idempotency records, its proof
// schema and its login, and restores the limiter's fingerprint and the issuer key row it found. What it leaves is what every
// suite leaves: its synthetically named identities and tenants, and their audit records.
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
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { tenantMintProof } from '../../server/persistence/postgresSessionStore.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { principalKeyOf, SESSION_COOKIES, SESSION_CSRF_HEADER, SESSION_TTL } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { CUSTOMER_DIRECTORY_PATH } from '../../server/runtime/customerDirectory.ts';
import { createIdempotencyKeyring, IDEMPOTENCY_POLICY } from '../../server/runtime/idempotency.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';
import { PORT_DEADLINE_MS } from '../../server/runtime/deadline.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7ch-migrator', runtimeRef: 'm7ch-runtime' };
const LOCK_KEY = 528_532;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7ch_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** The audit action of an edit (the command contract's kind), pinned here as a literal. */
const ACTION = 'tenant.customer.update';
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The bound on every lever and every awaited outcome. */
const WAIT_MS = 10_000;
/** The revalidator's first lock: 016's hold of the actor's standing (postgresTenantAdmission.ts). */
const AT_HOLD = /m5_hold_tenant_standing/;
/** The edit routine's statement: where a request waits for the customer row (after every authority lock). */
const AT_EDIT = /tmpos_customer_edit\.m7a_customer_update/;
/** The advisory key the parking trigger waits on (the two-int space: never the migration lock's bigint one). */
const PARK = [528_532, 23];
/** Four one-connection pools per instance: two instances, the owner and the observer stay inside a 20-connection cluster. */
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });
const PHONE = '+1 555 0100';
/** The client socket's bound on one reply (send below). */
const SEND_TIMEOUT_MS = 20_000;
/** The edit route's declared body cap (server/runtime/customerUpdate.ts MAX_BODY_BYTES). */
const EDIT_BODY_MAX_BYTES = 8_192;
// The timing every lease and deadline case below relies on, pinned: the entry composes the runtime with these defaults
// (createApp's portDeadlineMs is never overridden in production composition), so a change to them fails here first.
// A retry 'within the lease' must land long before it lapses, and an unknown COMMIT must answer before the socket bound.
assert.equal(IDEMPOTENCY_POLICY.leaseMs, 60_000, 'the idempotency lease the in-progress cases rely on');
assert.ok(COMMAND_TRANSACTION_DEADLINE_MS <= PORT_DEADLINE_MS, 'the commit runs under min(port deadline, transaction deadline)');
assert.ok(PORT_DEADLINE_MS * 4 <= SEND_TIMEOUT_MS, 'a deadline-bound 503 answers well inside the client socket bound');

// ---------------------------------------------------------------------------
// cluster lifecycle (mirrors tests/db/customerCreate.integration.test.mjs)
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M7CH');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** `host`/`user` travel in client options, never the URL; a named role REPLACES the userinfo. */
function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}

/** The owner: applies the migrations, writes fixtures, holds the levers and counts rows. RLS does not restrict it. */
const owner = testClient(TARGET, { max: 4, onnotice: () => {} });
/** The observer: reads pg_stat_activity while the owner's connections hold levers. */
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
/** Every Idempotency-Key this file sent with the principal that sent it: teardown removes their records. */
const USED_KEYS = [];
/** The case running now (the cases run one at a time) and the tenants each case made: counts() is scoped to them. */
let CURRENT = null;
const CASE_TENANTS = new Map();
/** A case: its tenants and keys are its own, so a stray late write of an earlier failed case cannot move its deltas. */
const caseTest = (name, fn) => test(name, async () => {
  CURRENT = name.slice(0, 'M7CH-00'.length);
  CASE_TENANTS.set(CURRENT, []);
  try { await fn(); } finally { CURRENT = null; }
});
let rateLimitFingerprintBefore;
async function fingerprintRow() {
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  return rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
}
let issuerKeyBefore;
async function issuerKeyRow() {
  const rows = await owner`select key from tmpos_mint.issuer_key where singleton`;
  return rows.length === 0 ? null : Buffer.from(rows[0].key);
}

// Race helpers a teardown may have to settle.
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => delay(5);
/** A request a failing test may abandon: its rejection is observed here, and still reaches whoever awaits it. */
const quietly = (p) => { p.catch(() => {}); return p; };
async function within(promise, label) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: label }), WAIT_MS); });
  try { return await Promise.race([promise, bound]); } finally { clearTimeout(timer); }
}
const ROLLBACK = Symbol('rollback');
/** Holds and owner writes a failing test may leave open; teardown settles every one before it cleans up. */
const OPEN = new Set();

/** Made in this process, never written anywhere: the limiter's key, the tenant issuer key and the tenant command key. */
const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);
const KEYRING = createIdempotencyKeyring(IDEMPOTENCY_KEY);
/** The record scope a key and principal own (it binds nothing else): how teardown and M7CH-04 find a key's record. */
const scopeOf = (key, principal) => KEYRING.operationOf(key, principal, {
  method: 'PATCH', path: '/', audience: 'tenant', tenant: null, store: null, actor: null, body: new Uint8Array(0),
}).scope;

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const open of [...OPEN]) await step(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
    // The proof schema's function carries every trigger this file installed: CASCADE drops them with it.
    await step(() => owner.unsafe('drop schema if exists m7ch_proof cascade'));
    // Every customer this file made, so no row_version above 1 survives it (024's down refuses while one does).
    if (TENANTS.length > 0) await step(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
    if (TENANTS.length > 0) await step(() => owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`);
    if (TENANTS.length > 0) await step(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
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
      await step(async () => {
        await owner.begin(async (sql) => {
          await sql`delete from tmpos_mint.issuer_key where singleton`;
          if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
        });
        const after = await issuerKeyRow();
        assert.ok(after === null ? issuerKeyBefore === null : issuerKeyBefore !== null && after.equals(issuerKeyBefore),
          'the issuer key row this suite found is restored exactly');
      });
    }
    await step(async () => {
      const [{ n }] = await owner`select count(*)::int as n from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`;
      assert.equal(n, 0, 'no customer of this suite survives it');
    });
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M7CH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'M7CH setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster; a trap can drop a COMMIT's answer (productionEntry's)
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket'
    ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) }
    : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m7ch-relay-'));
  const pairs = new Set();
  const state = { closes: 0, pairs, trap: null };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); }, audited: false, silenced: false };
    pairs.add(pair);
    client.on('data', (chunk) => { if (state.trap !== null) state.trap(pair, chunk); db.write(chunk); });
    db.on('data', (chunk) => { if (!pair.silenced) client.write(chunk); });
    for (const socket of [client, db]) {
      socket.on('error', pair.cut);
      socket.on('close', pair.cut);
    }
  });
  const path = join(dir, '.s.PGSQL.5432');
  const listen = () => new Promise((done) => server.listen(path, done));
  const refuse = () => (server.listening ? new Promise((done) => server.close(done)) : Promise.resolve());
  return {
    dir,
    listening: listen(),
    state,
    async close() {
      const drained = refuse();
      for (const pair of [...pairs]) pair.cut();
      await drained;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const AUDIT_INSERT_TEXT = Buffer.from('insert into public.audit_event');
const COMMIT_PARSE = Buffer.from('\0commit\0'); // the kernel's own `commit`, as an unnamed Parse message carries it

/**
 * Arm `relay`: on the first connection that sends the audit INSERT, the next COMMIT is forwarded — so the server commits —
 * and every byte of the server's answer after it is dropped. release() disarms the trap and cuts the silenced connection.
 */
function loseCommitAnswer(relay) {
  const silenced = [];
  // A marker may straddle two TCP chunks: each connection's previous tail (the longest marker less one byte) is carried
  // into the next window, so a split marker is still seen exactly once.
  const carry = Math.max(AUDIT_INSERT_TEXT.length, COMMIT_PARSE.length) - 1;
  relay.state.trap = (pair, chunk) => {
    const window = pair.tail === undefined ? chunk : Buffer.concat([pair.tail, chunk]);
    pair.tail = window.subarray(Math.max(0, window.length - carry));
    // Only a COMMIT after the audit INSERT counts — in the same window too (both may arrive in one chunk); the carried tail
    // never reaches back before the audit match.
    let from = 0;
    const audit = pair.audited ? -1 : window.indexOf(AUDIT_INSERT_TEXT);
    if (audit !== -1) {
      pair.audited = true;
      from = audit + AUDIT_INSERT_TEXT.length;
      pair.tail = window.subarray(Math.max(from, window.length - carry));
    }
    if (pair.audited && window.indexOf(COMMIT_PARSE, from) !== -1) {
      pair.silenced = true;
      silenced.push(pair);
      relay.state.trap = null;
    }
  };
  return { silenced, release: () => { relay.state.trap = null; for (const pair of silenced) pair.cut(); } };
}

function databaseClientOver(relay, kernelModule = { createSupervisedPgClient, MAX_POOLS, runtimeClientOptions }) {
  return (_endpoint) => kernelModule.createSupervisedPgClient(testDriverVia(TARGET, relay.dir), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...kernelModule.runtimeClientOptions(TARGET_DSN), ssl: false, max: kernelModule.MAX_POOLS, idle_timeout: 0,
    onclose: () => { relay.state.closes += 1; },
    user: RUNTIME_LOGIN,
  });
}

// ---------------------------------------------------------------------------
// setup: every migration, the runtime login, the three keys, and the owner's proof schema
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
  const [{ present }] = await owner`select pg_catalog.to_regprocedure('tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)') is not null as present`;
  assert.ok(present, 'migration 024\'s edit routine is applied');
});

await setupStep(async () => {
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  // G-DBROLE provisioning (not a migration): the ledger read the startup preflight requires of the runtime login.
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
});

await setupStep(async () => {
  rateLimitFingerprintBefore = await fingerprintRow();
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(RATE_KEY)})`;
  });
  issuerKeyBefore = await issuerKeyRow();
  await installTestIssuerKey(owner, ISSUER_KEY);
  // The owner's levers: a schema outside ^(public|tmpos_) (the preflight's application set) holding one witness sequence;
  // withTrigger installs one trigger function in it at a time. Nothing in it is granted to anyone.
  await owner.unsafe('drop schema if exists m7ch_proof cascade');
  await owner.unsafe('create schema m7ch_proof');
  await owner.unsafe('revoke all on schema m7ch_proof from public');
  await owner.unsafe('create sequence m7ch_proof.fired');
});

// ---------------------------------------------------------------------------
// the synthetic identity provider and the configuration every entry starts from
// ---------------------------------------------------------------------------

const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) {
      const err = new Error('unknown_token');
      err.code = 'auth/invalid-id-token';
      throw err;
    }
    return { uid: rec.uid, authTime: Math.floor(Date.now() / 1000), secondFactor: 'totp' };
  },
});

const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const FIREBASE_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'm7ch-test-project',
  client_email: 'm7ch-test@m7ch-test-project.iam.gserviceaccount.com',
  private_key: FIREBASE_PRIVATE_KEY,
});

/** Every instance gets the SAME IDEMPOTENCY_KEY: the process cannot check that its peers hold it (DA-101), so the suite does. */
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
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: FIREBASE_JSON,
});

// ---------------------------------------------------------------------------
// requests, replies and logs
// ---------------------------------------------------------------------------

/** A random 127.x.y.z loopback source, never the trusted proxy: each is its own limiter subject. */
function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}

/** Every captured log line across the suite, and every secret-shaped value it handled: M7CH-09 joins the two. */
const ALL_LOG_LINES = [];
const SECRETS = new Set();

/** A customer name no other run shares, registered as a log canary. */
function canary(label) {
  const name = `M7CH ${label} ${SUFFIX}`;
  SECRETS.add(name);
  return name;
}
/**
 * Every name, phone and email a PATCH body carried, as sent and trimmed, joins the log canaries (M7CH-09): collected from
 * the bodies actually submitted, never a hand list. Values too short to be distinctive (under 6 characters) are skipped.
 */
function noteSubmitted(body) {
  let parsed = body;
  if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch { return; } }
  if (typeof parsed !== 'object' || parsed === null) return;
  for (const field of ['name', 'phone', 'email']) {
    const value = parsed[field];
    if (typeof value !== 'string') continue;
    for (const v of [value, value.trim()]) if (v.length >= 6) SECRETS.add(v);
  }
}
/** An email no other run shares, registered as a log canary. */
function mailOf(label) {
  const email = `m7ch-${label.replace(/\W+/g, '-')}-${SUFFIX}@example.test`;
  SECRETS.add(email);
  return email;
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

/** The baseline headers every reply carries, the HSTS one included (the tenant entry serves with hsts: true). */
function assertBaseline(reply, label) {
  assert.equal(reply.headers['strict-transport-security'], HSTS_HEADER.value, `${label}: HSTS`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(reply.headers[name.toLowerCase()], value, `${label}: ${name}`);
}

/** A refusal is the fixed `{ error, requestId }` and nothing else, never sets a cookie, and carries the baseline headers. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
}

/** An edit's 200: exactly {customer:{id,name},version,changed}, byte for byte, in that key order — never a contact. */
function editedOf(reply, { id, name, version, changed = true }, label, { replayed = false } = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  assert.equal(reply.body, JSON.stringify({ customer: { id, name }, version, changed }), `${label}: the exact body`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
  return reply.body;
}

/** The sealed stale-version answer: 409 {"error":"write_conflict"} and nothing else (a recorded body carries no request id). */
function conflictOf(reply, label, { replayed = false } = {}) {
  assert.equal(reply.status, 409, `${label}: ${reply.body}`);
  assert.equal(reply.body, '{"error":"write_conflict"}', `${label}: the sealed conflict`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assertBaseline(reply, label);
}

/** The header names of a reply, without the per-request ones: a foreign and a missing id must answer identically. */
const headerShape = (reply) => Object.keys(reply.headers).filter((h) => !['date', 'x-request-id'].includes(h)).sort();

// ---------------------------------------------------------------------------
// fixtures — all written through the owner
// ---------------------------------------------------------------------------

async function actor(label, memberships, status = 'active') {
  const uid = `m7ch-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  UIDS.push(uid);
  SECRETS.add(token).add(uid).add(id);
  return { id, uid, token, label, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });

async function newTenant(label, status = 'active') {
  const name = `m7ch-${label}-${SUFFIX}`;
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${name}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  if (CURRENT !== null) CASE_TENANTS.get(CURRENT).push(id);
  SECRETS.add(id).add(name);
  return id;
}

/** The owner's durable Customers level for `role` in `tenant` (020's table, as the role-level suites write it). */
const setLevel = (tenant, role, level, sql = owner) => sql`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, 'customers', ${level}, now())
  on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;

/** A customer row as the owner writes it: created_at the database's clock unless `legacy` (NULL, a pre-023 row). */
async function seedCustomer(tenant, label, { phone = null, email = null, legacy = false } = {}) {
  const id = randomUUID();
  const name = canary(label);
  SECRETS.add(id);
  if (legacy) await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, phone, email, created_at) values (${id}, ${tenant}, ${name}, ${phone}, ${email}, null)`;
  else await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, phone, email) values (${id}, ${tenant}, ${name}, ${phone}, ${email})`;
  return { id, name, phone, email };
}

/** The stored row: values, version (decimal text), creation time (epoch microseconds, or null) and xmin. */
async function rowOf(id) {
  const [row] = await owner`select tenant_id, name, phone, email, row_version::text as version,
      (extract(epoch from created_at) * 1000000)::bigint::text as created_us, xmin::text as xmin
    from tmpos_customer.customer where customer_id = ${id}`;
  return row === undefined ? null : { ...row };
}

/** The store key of the session a cookie presents: the SHA-256 of its identifier, as the chain computes it. */
const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
/** Records a fresh sign-in's identifier, store key and mint proof (read back before any request touches the row) as secrets. */
async function noteSession(cookie) {
  const key = keyOf(cookie);
  KEYS.add(key);
  SECRETS.add(cookie.slice(cookie.indexOf('=') + 1)).add(key);
  const [row] = await owner`select audience, auth_provider, auth_provider_uid, principal_key, security_version, authenticated_at,
      created_at, last_seen_at, validated_at, expires_at from tmpos_session.session where session_key = ${key}`;
  assert.equal(row?.audience, 'tenant', 'the sign-in wrote one tenant session row');
  const proof = tenantMintProof(ISSUER_KEY, key, {
    audience: row.audience, authProvider: row.auth_provider, authProviderUid: row.auth_provider_uid, principalKey: row.principal_key,
    securityVersion: row.security_version, authenticatedAt: row.authenticated_at === null ? null : Number(row.authenticated_at),
    createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at), validatedAt: Number(row.validated_at),
  }, Number(row.expires_at));
  for (const encoding of ['hex', 'base64', 'base64url']) SECRETS.add(proof.toString(encoding));
  return key;
}

/** A live, well-formed ADMINISTRATIVE session row minted as the runtime login through 018's admin branch: its identifier. */
async function adminSessionId(who) {
  const id = randomBytes(32).toString('base64url');
  const key = createHash('sha256').update(id).digest('base64url');
  KEYS.add(key);
  SECRETS.add(id).add(key);
  const runtime = testClient(TARGET, { user: RUNTIME_LOGIN, max: 1, onnotice: () => {} });
  try {
    const at = Date.now();
    const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, 'admin'::text, 'firebase'::text,
      ${who.uid}::text, ${principalKeyOf(who.principal)}::text, 'm7ch-admin'::text, ${at}::bigint, ${at}::bigint, ${at}::bigint,
      ${at}::bigint, ${at + SESSION_TTL.admin.absoluteMs}::bigint, null::bytea) as outcome`;
    assert.equal(outcome, 'created', 'an administrative row exists to be presented');
  } finally {
    await runtime.end({ timeout: 5 });
  }
  return id;
}

// ---------------------------------------------------------------------------
// row counts: C/U/K/O (and L), as deltas around a case
// ---------------------------------------------------------------------------

async function counts() {
  // Scoped to the running case: its tenants' customers and update audit records, and the idempotency records of the keys
  // it sent. LA (every idempotency record) is there for the refusals whose key is never one this file records.
  const tenants = CASE_TENANTS.get(CURRENT) ?? [];
  const scopes = [...new Set(USED_KEYS.filter((u) => u.test === CURRENT).map(({ key, principal }) => scopeOf(key, principal)))];
  const [r] = await owner`select
    (select count(*) from tmpos_customer.customer where tenant_id = any(${tenants}::uuid[]))::int as c,
    (select count(*) from public.audit_event where action_id = ${ACTION} and tenant_id = any(${tenants}::uuid[]))::int as u,
    (select count(*) from tmpos_internal.idempotency_record where response is not null and scope = any(${scopes}::text[]))::int as k,
    (select count(*) from tmpos_internal.outbox_event)::int as o,
    (select count(*) from tmpos_internal.idempotency_record where scope = any(${scopes}::text[]))::int as l,
    (select count(*) from tmpos_internal.idempotency_record)::int as la`;
  return { ...r };
}
/** The delta since `before`: C/U/K/O always, L and LA only when `expected` names them. */
async function assertDelta(before, expected, label) {
  const now = await counts();
  const got = { C: now.c - before.c, U: now.u - before.u, K: now.k - before.k, O: now.o - before.o, L: now.l - before.l, LA: now.la - before.la };
  assert.deepEqual(got, { ...got, ...expected }, `${label}: C/U/K/O/L`);
}
const NOTHING = Object.freeze({ C: 0, U: 0, K: 0, O: 0 });
const ONE = Object.freeze({ C: 0, U: 1, K: 1, O: 0 });

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

function makeCapture() {
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const log = { log: (line) => { lines.push(line); ALL_LOG_LINES.push(line); } };
  const exit = (code) => { codes.push(code); };
  return { lines, codes, proc, log, exit };
}

/** The headers of a well-formed unsafe tenant request presenting `s` (null: no session) and `key` (null: no key). */
function unsafeHeaders(s, key) {
  return {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }),
    'content-type': 'application/json',
    ...(key === null ? {} : { 'idempotency-key': key }),
  };
}

/** Start one tenant entry over its own relay, hand the test a bound request surface, then stop it. */
async function withEntry(overrides, fn) {
  const relay = startRelay();
  await relay.listening;
  const clientAddress = randomLoopback();
  const cap = makeCapture();
  const construction = {
    databaseClient: databaseClientOver(relay, overrides.kernelModule),
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  const result = await startTenantEntry({ env: ENV, construction, proc: cap.proc, exit: cap.exit, log: cap.log });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  const port = result.address.port;
  const read = (s, path, headers = {}) => send(port, 'GET', path,
    { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }), ...headers }, undefined, { localAddress: clientAddress });
  const ctx = {
    cap, relay, port,
    /** PATCH /api/v1/customers/{segment} presenting `s`, under a fresh Idempotency-Key unless one is given. */
    patch: (s, segment, body, { key = randomUUID(), headers = {}, drop = [] } = {}) => {
      if (key !== null && V4.test(key)) {
        SECRETS.add(key);
        if (s?.principal !== undefined) USED_KEYS.push({ key, principal: s.principal, test: CURRENT });
      }
      noteSubmitted(body);
      const all = { ...unsafeHeaders(s, key), ...headers };
      for (const name of drop) delete all[name];
      return send(port, 'PATCH', `${CUSTOMER_DIRECTORY_PATH}/${segment}`, all, typeof body === 'string' ? body : JSON.stringify(body), { localAddress: clientAddress });
    },
    profile: (s, id, headers = {}) => read(s, `${CUSTOMER_DIRECTORY_PATH}/${id}/profile`, headers),
    head: (s, path) => send(port, 'HEAD', path, { host: TENANT_HOST, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }, undefined, { localAddress: clientAddress }),
    detail: (s, id) => read(s, `${CUSTOMER_DIRECTORY_PATH}/${id}`),
    list: (s) => read(s, `${CUSTOMER_DIRECTORY_PATH}?limit=100`),
    logout: (s) => send(port, 'POST', sessionPaths('tenant').logout, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf,
    }, undefined, { localAddress: clientAddress }),
    /** The refusal reason the runtime logged for one reply. */
    reason: (reply) => {
      const lines = cap.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
        .filter((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id']);
      assert.equal(lines.length, 1, 'exactly one log line for the request');
      return lines[0].reason ?? '-';
    },
  };
  try {
    return await fn(ctx);
  } finally {
    if (cap.codes.length === 0) {
      cap.proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; cap.codes.length === 0 && Date.now() < until;) await delay(10);
    }
    await relay.close().catch(() => {});
  }
}

/** A tenant login from a fresh loopback source (the login limit is per source): { cookie, csrf, key, principal }. */
async function signIn(ctx, who) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${who.token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const csrf = JSON.parse(reply.body).csrfToken;
  SECRETS.add(csrf);
  return { cookie, csrf, key: await noteSession(cookie), principal: who.principal };
}

/** The profile 200 at `version`: exactly { customer: { id, name, phone, email, createdAt } } with the strong ETag. */
function profileOf(reply, version, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['customer'], label);
  assert.deepEqual(Object.keys(body.customer), ['id', 'name', 'phone', 'email', 'createdAt'], label);
  assert.equal(reply.headers.etag, `"${version}"`, `${label}: the version as a strong ETag`);
  assert.match(reply.headers['cache-control'] ?? '', /no-store/, `${label}: no-store`);
  return body.customer;
}

// ---------------------------------------------------------------------------
// levers: owner-held locks, owner triggers and competing owner writes, observed through pg_stat_activity
// (tests/db/customerCreate.integration.test.mjs)
// ---------------------------------------------------------------------------

/** Hold locks in an OPEN owner transaction until released. */
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
    end(how) {
      if (ending === null) { release.resolve(how); ending = done; OPEN.delete(h); }
      return ending;
    },
    commit: () => h.end('commit'),
    settle: () => h.end('rollback'),
  };
  OPEN.add(h);
  return h;
}
const holdAccount = (who) => hold('app_user for update', (sql) => sql`select 1 from public.app_user where internal_user_id = ${who.id} for update`);
const holdCustomer = (id) => hold('customer for update', (sql) => sql`select 1 from tmpos_customer.customer where customer_id = ${id} for update`);
/** The advisory key the parking trigger waits on, held until released. */
const holdPark = () => hold('the parking key', (sql) => sql`select pg_catalog.pg_advisory_xact_lock(${PARK[0]}::int, ${PARK[1]}::int)`);

/** An owner write: its backend pid once started, and 'committed' | 'failed:...' once settled. */
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

/** Runtime-login backends waiting on a Lock now, filtered by blocker pid and statement text. */
async function blockedNow({ by = null, query = null } = {}) {
  const rows = await probe`select pid, query, pg_blocking_pids(pid) as blockers from pg_stat_activity
    where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
  return rows.filter((r) => (query === null || query.test(r.query)) && (by === null || r.blockers.includes(by)))
    .map((r) => ({ pid: r.pid, blockers: r.blockers }));
}
/** Wait until `request` settles or a runtime backend matching `criteria` waits on a Lock: { settled } | { blocked } | null. */
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
/** A request that must be waiting at `what`: its backend's pid — or a failure naming what happened instead. */
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
 * `work` runs with ONE owner trigger BEFORE `event` (insert | update) on `table` for each row matching `when`: it counts
 * itself on m7ch_proof.fired (a sequence, so the count survives the rollback it causes), then parks on the advisory key
 * PARK or raises. Dropped, with its function, whatever `work` did.
 */
const TRIGGER_ACTIONS = Object.freeze({
  park: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); return new;`,
  raise: `raise exception 'M7CH injected fault' using errcode = 'P0001';`,
});
async function withTrigger(table, event, when, action, work) {
  await owner.unsafe(`create function m7ch_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('m7ch_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function m7ch_proof.fire() from public');
  await owner.unsafe(`create trigger m7ch_fire before ${event} on ${table} for each row when (${when}) execute function m7ch_proof.fire()`);
  try {
    return await work();
  } finally {
    await owner.unsafe(`drop trigger if exists m7ch_fire on ${table}`);
    await owner.unsafe('drop function if exists m7ch_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('m7ch_proof.fired'::regclass), 0)::int as n`)[0].n;
const EDIT_AUDIT = `new.action_id = '${ACTION}'`;
/** The completion: the one UPDATE of an idempotency record that seals its response (transactionalStore's fault filter). */
const COMPLETION = 'old.response is null and new.response is not null';

// ===========================================================================
// M7CH-01 (AC-1): a persistent edit, read back through a second instance
// ===========================================================================

caseTest('M7CH-01: an Edit role\'s change of name, phone and email is the exact 200 {customer:{id,name},version:2,changed:true}; a second tenant entry over the same database reads the new values, the same id and creation time (a legacy NULL stays NULL) and ETag "2"; detail and list still answer {id,name}', async () => {
  const T = await newTenant('m7ch01');
  await setLevel(T, 'sales_staff', 'edit');
  const editor = await actor('m7ch01-edit', [tenantGrant(T, 'sales_staff')]);
  const modern = await seedCustomer(T, 'modern', { phone: PHONE, email: mailOf('m7ch01-modern') });
  const legacy = await seedCustomer(T, 'legacy', { legacy: true });
  const modernAt = (await rowOf(modern.id)).created_us;
  assert.notEqual(modernAt, null, 'the modern row holds the database\'s creation time');
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const sa = await signIn(a, editor);
    const beforeProfile = profileOf(await a.profile(sa, modern.id), 1, 'the profile before the edit');
    assert.deepEqual({ ...beforeProfile, createdAt: null }, { id: modern.id, name: modern.name, phone: PHONE, email: modern.email, createdAt: null });
    assert.equal(profileOf(await a.profile(sa, legacy.id), 1, 'the legacy profile before').createdAt, null);

    const next = { name: canary('modern edited'), phone: '+1 555 0199', email: mailOf('m7ch01-edited') };
    const before = await counts();
    editedOf(await a.patch(sa, modern.id, { expectedVersion: 1, ...next }), { id: modern.id, name: next.name, version: 2 }, 'the modern edit');
    const legacyNext = { name: canary('legacy edited'), phone: PHONE, email: mailOf('m7ch01-legacy') };
    editedOf(await a.patch(sa, legacy.id, { expectedVersion: 1, ...legacyNext }), { id: legacy.id, name: legacyNext.name, version: 2 }, 'the legacy edit');
    await assertDelta(before, { C: 0, U: 2, K: 2, O: 0, L: 2 }, 'two edits');

    // The second instance, a fresh sign-in there: what was committed, from the database alone.
    const sb = await signIn(b, editor);
    const afterReply = await b.profile(sb, modern.id);
    const after = profileOf(afterReply, 2, 'the profile on the second instance');
    // No validator is processed: If-None-Match naming the current strong ETag is the same full 200, never a bodiless 304.
    for (const [label, inm] of [['If-None-Match: the current ETag', afterReply.headers.etag], ['If-None-Match: *', '*'], ['a weak form of it', `W/${afterReply.headers.etag}`]]) {
      const conditional = await b.profile(sb, modern.id, { 'if-none-match': inm });
      profileOf(conditional, 2, label);
      assert.equal(conditional.body, afterReply.body, `${label}: the exact body bytes`);
      assert.equal(conditional.headers['content-length'], String(Buffer.byteLength(conditional.body)), `${label}: Content-Length is the body's byte length`);
    }
    assert.equal(afterReply.headers['content-length'], String(Buffer.byteLength(afterReply.body)), 'Content-Length is the body\'s byte length');
    // HEAD is not served on the profile route (the route table answers GET only): the bounded 404, no profile headers.
    const head = await b.head(sb, `${CUSTOMER_DIRECTORY_PATH}/${modern.id}/profile`);
    assert.equal(head.status, 404, 'HEAD is no route');
    assert.notEqual(head.headers.etag, afterReply.headers.etag, 'HEAD carries no version (at most the framework\'s weak tag of the 404 body)');
    assert.ok(head.headers.etag === undefined || head.headers.etag.startsWith('W/'), 'never a strong validator on HEAD');
    assert.deepEqual(after, { id: modern.id, ...next, createdAt: beforeProfile.createdAt }, 'new values, the same id and creation time');
    assert.deepEqual(profileOf(await b.profile(sb, legacy.id), 2, 'the legacy profile on the second instance'),
      { id: legacy.id, ...legacyNext, createdAt: null }, 'a legacy row\'s unknown creation time stays unknown');
    const detail = await b.detail(sb, modern.id);
    assert.equal(detail.status, 200, detail.body);
    assert.equal(detail.body, JSON.stringify({ customer: { id: modern.id, name: next.name } }), 'the detail is {id,name}, the new name');
    const listed = await b.list(sb);
    assert.equal(listed.status, 200, listed.body);
    const page = JSON.parse(listed.body).customers;
    assert.ok(page.every((c) => JSON.stringify(Object.keys(c)) === '["id","name"]'), 'the list carries {id,name} only');
    assert.deepEqual(new Map(page.map((c) => [c.id, c.name])), new Map([[modern.id, next.name], [legacy.id, legacyNext.name]]));

    // The rows: the id, tenant and creation time untouched; the version moved once each.
    const m = await rowOf(modern.id);
    assert.deepEqual([m.tenant_id, m.name, m.phone, m.email, m.version, m.created_us], [T, next.name, next.phone, next.email, '2', modernAt]);
    const l = await rowOf(legacy.id);
    assert.deepEqual([l.tenant_id, l.name, l.version, l.created_us], [T, legacyNext.name, '2', null]);
  }));
});

// ===========================================================================
// M7CH-02 (AC-2): patch semantics and the request itself
// ===========================================================================

caseTest('M7CH-02: omitted contacts are kept, null and "" clear, names are trimmed; a missing name or expectedVersion, an unknown or immutable key, a wrong type and an out-of-range version are 400s that change nothing; a non-canonical id is a 400 only after authentication', async () => {
  const T = await newTenant('m7ch02');
  const who = await actor('m7ch02', [tenantGrant(T, 'manager')]);
  const email = mailOf('m7ch02');
  const c = await seedCustomer(T, 'patched', { phone: PHONE, email });
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, who);
    const name = canary('patched renamed');
    const steps = [
      ['phone and email omitted: both kept', { expectedVersion: 1, name }, { name, phone: PHONE, email }],
      ['phone null: cleared, email kept', { expectedVersion: 2, name, phone: null }, { name, phone: null, email }],
      ['email "": cleared', { expectedVersion: 3, name, email: '' }, { name, phone: null, email: null }],
      ['a phone set again, a blank email (already clear) cleared', { expectedVersion: 4, name, phone: ` ${PHONE} `, email: '   ' }, { name, phone: PHONE, email: null }],
      ['a name trimmed at its edges', { expectedVersion: 5, name: ` \t${name}2　` }, { name: `${name}2`, phone: PHONE, email: null }],
    ];
    for (const [label, body, stored] of steps) {
      const before = await counts();
      editedOf(await ctx.patch(s, c.id, body), { id: c.id, name: stored.name, version: body.expectedVersion + 1 }, label);
      await assertDelta(before, { ...ONE, L: 1 }, label);
      const row = await rowOf(c.id);
      assert.deepEqual({ name: row.name, phone: row.phone, email: row.email, version: row.version },
        { ...stored, version: String(body.expectedVersion + 1) }, `${label}: stored`);
    }

    // Refused by the command's contract once the key is acquired: the lease is taken and nothing else moves.
    const current = await rowOf(c.id);
    const v = 6;
    const okName = canary('never stored m7ch02');
    const refused = [
      ['an empty object', {}],
      ['no name', { expectedVersion: v }],
      ['no expectedVersion', { name: okName }],
      ['an unknown key', { expectedVersion: v, name: okName, note: 'x' }],
      ['an id', { expectedVersion: v, name: okName, id: c.id }],
      ['a createdAt', { expectedVersion: v, name: okName, createdAt: '2020-01-01T00:00:00.000Z' }],
      ['a created_at', { expectedVersion: v, name: okName, created_at: null }],
      ['a tenantId', { expectedVersion: v, name: okName, tenantId: T }],
      ['a version', { expectedVersion: v, name: okName, version: v + 1 }],
      ['expectedVersion 0', { expectedVersion: 0, name: okName }],
      ['expectedVersion -1', { expectedVersion: -1, name: okName }],
      ['expectedVersion 1.5', { expectedVersion: 1.5, name: okName }],
      ['expectedVersion a string', { expectedVersion: String(v), name: okName }],
      ['expectedVersion null', { expectedVersion: null, name: okName }],
      ['expectedVersion 2^53-1', { expectedVersion: Number.MAX_SAFE_INTEGER, name: okName }],
      ['a null name', { expectedVersion: v, name: null }],
      ['a number name', { expectedVersion: v, name: 5 }],
      ['an empty name', { expectedVersion: v, name: '' }],
      ['a whitespace name', { expectedVersion: v, name: ' \t ' }],
      ['a name with a control character', { expectedVersion: v, name: 'Acme\u0007Ltd' }],
      ['201 scalars', { expectedVersion: v, name: 'x'.repeat(201) }],
      ['a number phone', { expectedVersion: v, name: okName, phone: 5550100 }],
      ['an object phone', { expectedVersion: v, name: okName, phone: {} }],
      ['a phone without a digit', { expectedVersion: v, name: okName, phone: 'no digit' }],
      ['a boolean email', { expectedVersion: v, name: okName, email: true }],
      ['an email with two @', { expectedVersion: v, name: okName, email: 'a@b@example.test' }],
      ['an array', []],
      ['a JSON string', '"x"'],
      ['JSON null', 'null'],
    ];
    const before = await counts();
    for (const [label, payload] of refused) {
      const reply = await ctx.patch(s, c.id, typeof payload === 'string' ? payload : JSON.stringify(payload));
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'command_request_invalid', label);
      assert.ok(!reply.body.includes(okName) && !reply.body.includes('no digit') && !reply.body.includes('example.test'), `${label}: nothing echoed`);
    }
    await assertDelta(before, { ...NOTHING, L: refused.length }, 'refused by the contract');
    assert.deepEqual(await rowOf(c.id), current, 'the row, its version and its xmin untouched');

    // The path id: judged only after authentication and authorization, before any key is acquired.
    const mid = await counts();
    for (const segment of [c.id.toUpperCase(), 'x', `{${c.id}}`]) {
      assertRefusal(await ctx.patch(null, segment, { expectedVersion: v, name: okName }), 401, 'unauthenticated', `${segment}: no session`);
      const bad = await ctx.patch(s, segment, { expectedVersion: v, name: okName });
      assertRefusal(bad, 400, 'invalid_request', `${segment}: authenticated`);
      assert.equal(ctx.reason(bad), 'command_target_invalid', segment);
    }
    await assertDelta(mid, { ...NOTHING, L: 0, LA: 0 }, 'a malformed id reserves nothing');
    assert.deepEqual(await rowOf(c.id), current);

    // The request's framing, refused before any key is acquired: no key, a malformed or non-v4 key, a wrong Content-Type
    // and a body one byte over the route's cap.
    const valid = { expectedVersion: v, name: okName };
    const over = JSON.stringify({ ...valid, name: '' });
    const oversize = JSON.stringify({ ...valid, name: 'x'.repeat(EDIT_BODY_MAX_BYTES + 1 - over.length) });
    assert.equal(Buffer.byteLength(oversize), EDIT_BODY_MAX_BYTES + 1, 'one byte over the cap');
    const framing = await counts();
    for (const [label, request, status, error, reason] of [
      ['no Idempotency-Key', () => ctx.patch(s, c.id, valid, { key: null }), 400, 'invalid_request', 'idempotency_key_missing'],
      ['a version-1 UUID key', () => ctx.patch(s, c.id, valid, { key: ['6ba7b810', '9dad', '11d1', '80b4', '00c04fd430c8'].join('-') }), 400, 'invalid_request', 'idempotency_key_invalid'],
      ['a short token key', () => ctx.patch(s, c.id, valid, { key: 'abc' }), 400, 'invalid_request', 'idempotency_key_invalid'],
      ['text/plain', () => ctx.patch(s, c.id, valid, { headers: { 'content-type': 'text/plain' } }), 415, 'unsupported_media_type', 'media_type_unsupported'],
      ['no Content-Type', () => ctx.patch(s, c.id, valid, { drop: ['content-type'] }), 415, 'unsupported_media_type', 'media_type_missing'],
      ['a body one byte over the cap', () => ctx.patch(s, c.id, oversize), 413, 'content_too_large', 'body_declared_too_large'],
    ]) {
      const reply = await request();
      assertRefusal(reply, status, error, label);
      assert.equal(ctx.reason(reply), reason, label);
    }
    await assertDelta(framing, { ...NOTHING, L: 0, LA: 0 }, 'refused framing: no idempotency record, no audit, no customer');
    assert.deepEqual(await rowOf(c.id), current, 'the row, its version and its xmin untouched by every framing refusal');
  });
});

// ===========================================================================
// M7CH-03 (AC-3): authority, the tenant boundary, the audience and the session witness
// ===========================================================================

caseTest('M7CH-03: View and Create roles are 403, Edit and Full are 200; an owner\'s level edit after sign-in is honoured both ways; read_only tenants and accounts are 403; another tenant\'s customer is the missing id\'s 404; an administrative session or host and another session\'s CSRF witness are refused by the chain — nothing changes', async () => {
  /** A fresh tenant of `status` with one customer and one actor of `role` (account `account`), the level stored if given. */
  const fresh = async (label, role, { status = 'active', account = 'active', level } = {}) => {
    const tenant = await newTenant(`m7ch03-${label}`, status);
    if (level !== undefined) await setLevel(tenant, role, level);
    const customer = await seedCustomer(tenant, `m7ch03 ${label}`, { phone: PHONE });
    const who = await actor(`m7ch03-${label}`, [tenantGrant(tenant, role)], account);
    return { label, tenant, customer, who };
  };
  const attempt = (ctx, s, f, id = f.customer.id) => ctx.patch(s, id, { expectedVersion: 1, name: canary(`${f.label} edited`) });
  await withEntry({}, async (ctx) => {
    // Edit and Full: 200.
    for (const [label, role, opts] of [['store-owner', 'store_owner'], ['manager-full', 'manager'], ['sales-raised-edit', 'sales_staff', { level: 'edit' }]]) {
      const f = await fresh(label, role, opts);
      const s = await signIn(ctx, f.who);
      const name = canary(`${f.label} edited`);
      const before = await counts();
      editedOf(await ctx.patch(s, f.customer.id, { expectedVersion: 1, name }), { id: f.customer.id, name, version: 2 }, label);
      await assertDelta(before, { ...ONE, L: 1 }, `${label}: one version, one audit record, one completion`);
      assert.equal((await rowOf(f.customer.id)).version, '2', `${label}: applied`);
    }
    // View, Create, a read_only tenant or account: 403 before any key.
    const refused = [
      await fresh('technician-view', 'technician'), await fresh('sales-create', 'sales_staff'),
      await fresh('manager-narrowed-create', 'manager', { level: 'create' }),
      await fresh('read-only-tenant', 'store_owner', { status: 'read_only' }),
      await fresh('read-only-account', 'store_owner', { account: 'read_only' }),
    ];
    const before = await counts();
    for (const f of refused) {
      const reply = await attempt(ctx, await signIn(ctx, f.who), f);
      assertRefusal(reply, 403, 'forbidden', f.label);
      assert.equal(ctx.reason(reply), 'authz_denied', `${f.label}: refused by the authorizer`);
      assert.equal((await rowOf(f.customer.id)).version, '1', `${f.label}: nothing written`);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused before the key');

    // An owner's edit of the role's level after sign-in, on the very next request: raised to Edit admits, lowered refuses.
    const raised = await fresh('sales-raised-later', 'sales_staff');
    const rs = await signIn(ctx, raised.who);
    assertRefusal(await attempt(ctx, rs, raised), 403, 'forbidden', 'Create, before the raise');
    await setLevel(raised.tenant, 'sales_staff', 'edit');
    assert.equal((await attempt(ctx, rs, raised)).status, 200, 'raised to Edit, the same session');
    const lowered = await fresh('manager-lowered-later', 'manager');
    const ls = await signIn(ctx, lowered.who);
    await setLevel(lowered.tenant, 'manager', 'view');
    assertRefusal(await attempt(ctx, ls, lowered), 403, 'forbidden', 'lowered to View, the same session');
    assert.equal((await rowOf(lowered.customer.id)).version, '1', 'the lowered role wrote nothing');

    // The tenant boundary: B's customer and a missing id are one 404 — same body shape, headers and log reason.
    const fa = await fresh('boundary-a', 'manager');
    const fb = await fresh('boundary-b', 'manager');
    const sa = await signIn(ctx, fa.who);
    const missing = randomUUID();
    SECRETS.add(missing);
    const mid = await counts();
    const foreign = await attempt(ctx, sa, fa, fb.customer.id);
    const absent = await attempt(ctx, sa, fa, missing);
    for (const [label, reply] of [['foreign', foreign], ['missing', absent]]) {
      assertRefusal(reply, 404, 'not_found', label);
      assert.equal(ctx.reason(reply), 'transaction_not_found', label);
      assert.ok(!reply.body.includes(fb.customer.id) && !reply.body.includes(fb.customer.name), `${label}: nothing of B`);
    }
    assert.deepEqual(headerShape(foreign), headerShape(absent), 'foreign and missing: identical header names');
    await assertDelta(mid, { ...NOTHING, L: 2 }, 'the 404s committed nothing (their leases wait out their time)');
    assert.deepEqual([(await rowOf(fb.customer.id)).version, (await rowOf(fb.customer.id)).name], ['1', fb.customer.name], 'B\'s row untouched');

    // The audience and the session witness: refused by the chain, before any key.
    const platform = await actor('m7ch03-admin', [{ scope: 'platform', role: 'system_owner' }]);
    const adminId = await adminSessionId(platform);
    const other = await signIn(ctx, (await fresh('witness-other', 'manager')).who);
    const body = { expectedVersion: 1, name: canary('never stored m7ch03') };
    const chain = await counts();
    for (const [label, request, status, error] of [
      ['an administrative session under its own cookie', () => ctx.patch({ cookie: `${SESSION_COOKIES.admin}=${adminId}`, csrf: sa.csrf }, fa.customer.id, body), 401, 'unauthenticated'],
      ['an administrative session under the tenant cookie', () => ctx.patch({ cookie: `${SESSION_COOKIES.tenant}=${adminId}`, csrf: sa.csrf }, fa.customer.id, body), 401, 'unauthenticated'],
      ['the administrative host', () => ctx.patch(sa, fa.customer.id, body, { headers: { host: ADMIN_HOST } }), 404, 'not_found'],
      ['the administrative Origin', () => ctx.patch(sa, fa.customer.id, body, { headers: { origin: ADMIN_ORIGIN } }), 403, 'forbidden'],
      ['another session\'s CSRF witness', () => ctx.patch(sa, fa.customer.id, body, { headers: { [SESSION_CSRF_HEADER]: other.csrf } }), 403, 'forbidden'],
      ['no session CSRF witness', () => ctx.patch(sa, fa.customer.id, body, { drop: [SESSION_CSRF_HEADER] }), 403, 'forbidden'],
    ]) {
      assertRefusal(await request(), status, error, label);
    }
    await assertDelta(chain, { ...NOTHING, L: 0 }, 'refused by the chain');
    assert.equal((await rowOf(fa.customer.id)).version, '1', 'A\'s row untouched');
  });
});

// ===========================================================================
// M7CH-04 (AC-4): one change, one version, one audit record, one completion; the key
// ===========================================================================

caseTest('M7CH-04: one change is one version, one audit record (the session\'s actor and tenant, the customer as its subject, metadata {}, no name, phone or email) and one sealed completion; the exact retry replays byte for byte; a changed body or the same body at another customer under the key is the 422; a replay after logout is 401', async () => {
  const T = await newTenant('m7ch04');
  const who = await actor('m7ch04', [tenantGrant(T, 'manager')]);
  const oldEmail = mailOf('m7ch04-old');
  const c = await seedCustomer(T, 'audited', { phone: PHONE, email: oldEmail });
  const sibling = await seedCustomer(T, 'sibling');
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, who);
    const key = randomUUID();
    const next = { name: canary('audited renamed'), phone: '+1 555 0142', email: mailOf('m7ch04-new') };
    const body = JSON.stringify({ expectedVersion: 1, ...next });
    let before = await counts();
    const first = await ctx.patch(s, c.id, body, { key });
    editedOf(first, { id: c.id, name: next.name, version: 2 }, 'the edit');
    await assertDelta(before, { ...ONE, L: 1 }, 'one change');
    assert.equal((await rowOf(c.id)).version, '2', 'one increment');

    const audits = await owner`select scope_type, tenant_id, store_id, required_permission, actor_internal_user_id, subject_customer_id,
        subject_tenant_id, metadata::text as metadata, pg_catalog.row_to_json(a)::text as row
      from public.audit_event a where action_id = ${ACTION} and subject_customer_id = ${c.id}`;
    assert.equal(audits.length, 1, 'one audit record names the customer');
    const { row, ...audit } = audits[0];
    assert.deepEqual({ ...audit }, {
      scope_type: 'tenant', tenant_id: T, store_id: null, required_permission: 'edit_customers', actor_internal_user_id: who.id,
      subject_customer_id: c.id, subject_tenant_id: null, metadata: '{}',
    }, 'the session\'s actor and tenant, the customer as its subject, metadata {}');
    for (const value of [c.name, next.name, PHONE, next.phone, oldEmail, next.email]) {
      assert.ok(!row.includes(value), 'no old or new name, phone or email anywhere in the audit record');
    }
    const [record] = await owner`select response is not null as sealed from tmpos_internal.idempotency_record where scope = ${scopeOf(key, who.principal)}`;
    assert.equal(record?.sealed, true, 'the key\'s completion is sealed');

    // The exact retry: the recorded 200, byte for byte, marked a replay; nothing new.
    before = await counts();
    const again = await ctx.patch(s, c.id, body, { key });
    editedOf(again, { id: c.id, name: next.name, version: 2 }, 'the replay', { replayed: true });
    assert.equal(again.body, first.body, 'the recorded body, byte for byte');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'the replay');

    // The same key with another body, or the same body at another customer (the target is bound): 422, never a replay.
    for (const [label, id, payload] of [
      ['a changed name', c.id, { expectedVersion: 1, ...next, name: canary('changed under the key') }],
      ['a changed expectedVersion', c.id, { expectedVersion: 2, ...next }],
      ['a dropped contact', c.id, { expectedVersion: 1, name: next.name, phone: next.phone }],
      ['the same bytes at another customer', sibling.id, body],
    ]) {
      const reply = await ctx.patch(s, id, typeof payload === 'string' ? payload : JSON.stringify(payload), { key });
      assertRefusal(reply, 422, 'idempotency_key_reused', label);
      assert.ok(!reply.body.includes(c.id), `${label}: never the first customer's answer`);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused under the key');
    assert.deepEqual([(await rowOf(sibling.id)).version, (await rowOf(sibling.id)).name], ['1', sibling.name], 'the other customer untouched');
    assert.equal((await rowOf(c.id)).version, '2', 'still one increment');

    // A replay never bypasses the session.
    assert.equal((await ctx.logout(s)).status, 204);
    assertRefusal(await ctx.patch(s, c.id, body, { key }), 401, 'unauthenticated', 'a replay after logout');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'after logout');
  });
});

// ===========================================================================
// M7CH-05 (AC-4): faults and the lost COMMIT answer
// ===========================================================================

caseTest('M7CH-05: an audit INSERT fault and a completion fault are 503s that leave the customer, its version and the audit untouched (the lease kept); a lost COMMIT answer is a 503 whose retry replays the committed 200 — never a second change', async () => {
  const T = await newTenant('m7ch05');
  const who = await actor('m7ch05', [tenantGrant(T, 'manager')]);
  const c = await seedCustomer(T, 'faulted', { phone: PHONE });
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, who);
    for (const [label, table, event, when] of [
      ['the audit INSERT raises', 'public.audit_event', 'insert', EDIT_AUDIT],
      ['the completion raises', 'tmpos_internal.idempotency_record', 'update', COMPLETION],
    ]) {
      const key = randomUUID();
      const body = { expectedVersion: 1, name: canary(`fault ${label}`), phone: null };
      const row = await rowOf(c.id);
      const before = await counts();
      const firedBefore = await fired();
      const reply = await withTrigger(table, event, when, 'raise', () => ctx.patch(s, c.id, body, { key }));
      assertRefusal(reply, 503, 'service_unavailable', label);
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      await assertDelta(before, { ...NOTHING, L: 1 }, label);
      assert.deepEqual(await rowOf(c.id), row, `${label}: the customer, its version and its xmin untouched`);
      // The lease was taken in its own transaction and is not reported rolled back: a retry within it is in progress. The
      // record's remaining lease is read first, so the retry provably lands inside it with a wide margin.
      const [lease] = await owner`select response is null as open, (extract(epoch from (lease_expires_at - clock_timestamp())) * 1000)::int as remaining_ms
        from tmpos_internal.idempotency_record where scope = ${scopeOf(key, who.principal)}`;
      assert.equal(lease?.open, true, `${label}: the lease is open, nothing sealed`);
      assert.ok(lease.remaining_ms > IDEMPOTENCY_POLICY.leaseMs / 2 && lease.remaining_ms <= IDEMPOTENCY_POLICY.leaseMs,
        `${label}: the retry lands well inside the lease (${lease.remaining_ms} ms left)`);
      assertRefusal(await ctx.patch(s, c.id, body, { key }), 409, 'request_in_progress', `${label}: the retry within the lease`);
      assert.equal((await rowOf(c.id)).version, '1');
    }

    // The COMMIT reaches the server and its answer is dropped: unknown, so a 503 — never a 200 before the commit is known.
    const key = randomUUID();
    const next = { expectedVersion: 1, name: canary('lost commit answer'), phone: null };
    const before = await counts();
    const trap = loseCommitAnswer(ctx.relay);
    let reply;
    const sentAt = Date.now();
    try {
      reply = await ctx.patch(s, c.id, next, { key });
    } finally {
      trap.release();
    }
    const waited = Date.now() - sentAt;
    // The 503 is the commit's own deadline running out (min(port, transaction) deadline), never the client socket's bound.
    assert.ok(waited >= COMMAND_TRANSACTION_DEADLINE_MS - 50 && waited < SEND_TIMEOUT_MS / 2,
      `the unknown COMMIT answered at its deadline (${waited} ms; deadline ${COMMAND_TRANSACTION_DEADLINE_MS} ms, socket bound ${SEND_TIMEOUT_MS} ms)`);
    assert.equal(trap.silenced.length, 1, 'one COMMIT reached the server, and its answer was dropped');
    assertRefusal(reply, 503, 'service_unavailable', 'the lost answer');
    assert.equal(ctx.reason(reply), 'transaction_timeout', 'the outcome was unknown at the port deadline');
    let row = null;
    for (const until = Date.now() + 5_000; row?.version !== '2' && Date.now() < until; await delay(50)) row = await rowOf(c.id);
    assert.deepEqual([row.version, row.name, row.phone], ['2', next.name, null], 'what committed becomes visible, whole');
    await assertDelta(before, { ...ONE, L: 1 }, 'the commit landed whole');
    // The retry resolves through the retained completion: the committed answer, replayed — never a second increment.
    editedOf(await ctx.patch(s, c.id, next, { key }), { id: c.id, name: next.name, version: 2 }, 'the retry', { replayed: true });
    assertRefusal(await ctx.patch(s, c.id, { ...next, name: canary('changed after the lost answer') }, { key }), 422, 'idempotency_key_reused', 'a changed retry');
    await assertDelta(before, { ...ONE, L: 1 }, 'never a second change');
    assert.equal((await rowOf(c.id)).version, '2');
  });
});

// ===========================================================================
// M7CH-06 (AC-6): no-ops, a stale no-op, and replay before evaluation
// ===========================================================================

caseTest('M7CH-06: a current no-op is 200 changed:false at the same version with no audit and the row not written, sealed while it holds the row (a rival edit waits for it), and its retry replays; a stale no-op is the sealed 409; a completed edit\'s retry replays its 200 after later edits moved the version', async () => {
  const T = await newTenant('m7ch06');
  const who = await actor('m7ch06', [tenantGrant(T, 'manager')]);
  const rival = await actor('m7ch06-rival', [tenantGrant(T, 'store_owner')]);
  const c = await seedCustomer(T, 'noop', { phone: PHONE });
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, who);
    const r = await signIn(ctx, rival);

    // The current no-op: every supplied value already stored (a null email clearing nothing).
    const noKey = randomUUID();
    const same = JSON.stringify({ expectedVersion: 1, name: c.name, phone: PHONE, email: null });
    const row = await rowOf(c.id);
    let before = await counts();
    const noop = await ctx.patch(s, c.id, same, { key: noKey });
    editedOf(noop, { id: c.id, name: c.name, version: 1, changed: false }, 'the no-op');
    await assertDelta(before, { C: 0, U: 0, K: 1, O: 0, L: 1 }, 'a no-op: its completion only');
    assert.deepEqual(await rowOf(c.id), row, 'the row not written: values, version 1 and xmin unchanged');
    const replay = await ctx.patch(s, c.id, same, { key: noKey });
    editedOf(replay, { id: c.id, name: c.name, version: 1, changed: false }, 'the no-op replayed', { replayed: true });
    assert.equal(replay.body, noop.body);

    // The no-op seals while it holds the row: parked at its completion, a rival edit of the same version waits on it.
    const renamed = canary('noop rival');
    before = await counts();
    await withTrigger('tmpos_internal.idempotency_record', 'update', COMPLETION, 'park', async () => {
      const lever = await holdPark();
      let parked;
      let pending;
      try {
        parked = quietly(ctx.patch(s, c.id, same));
        const noopPid = waitingPid(await blockedOrSettled(parked, { by: lever.pid }), 'the no-op parked at its completion');
        pending = quietly(ctx.patch(r, c.id, { expectedVersion: 1, name: renamed }));
        waitingPid(await blockedOrSettled(pending, { by: noopPid, query: AT_EDIT }), 'the rival edit waiting on the no-op\'s row lock');
      } finally {
        await lever.commit();
      }
      editedOf(await replyTo(parked, 'the parked no-op'), { id: c.id, name: c.name, version: 1, changed: false }, 'the parked no-op commits first');
      editedOf(await replyTo(pending, 'the rival'), { id: c.id, name: renamed, version: 2 }, 'the rival lands after, at version 1');
    });
    await assertDelta(before, { C: 0, U: 1, K: 2, O: 0, L: 2 }, 'one audit record: the rival\'s');

    // A stale no-op: the values equal what is stored, the version is not — the sealed 409, replayed under its key.
    const staleKey = randomUUID();
    const stale = { expectedVersion: 1, name: renamed };
    before = await counts();
    conflictOf(await ctx.patch(s, c.id, stale, { key: staleKey }), 'a stale no-op');
    conflictOf(await ctx.patch(s, c.id, stale, { key: staleKey }), 'the stale no-op replayed', { replayed: true });
    await assertDelta(before, { C: 0, U: 0, K: 1, O: 0, L: 1 }, 'a stale no-op: its sealed 409 only');
    assert.equal((await rowOf(c.id)).version, '2');

    // Replay before evaluation: a completed edit's retry is its 200, even after later edits moved the version past it.
    const editKey = randomUUID();
    const third = { expectedVersion: 2, name: canary('noop third') };
    const done = await ctx.patch(s, c.id, third, { key: editKey });
    editedOf(done, { id: c.id, name: third.name, version: 3 }, 'the edit to 3');
    editedOf(await ctx.patch(r, c.id, { expectedVersion: 3, name: canary('noop fourth') }), { id: c.id, name: canary('noop fourth'), version: 4 }, 'a later edit to 4');
    const late = await ctx.patch(s, c.id, third, { key: editKey });
    editedOf(late, { id: c.id, name: third.name, version: 3 }, 'the retry at version 4', { replayed: true });
    assert.equal(late.body, done.body, 'the first 200, byte for byte');
    editedOf(await ctx.patch(s, c.id, same, { key: noKey }), { id: c.id, name: c.name, version: 1, changed: false }, 'the first no-op, still', { replayed: true });
    assert.equal((await rowOf(c.id)).version, '4', 'no replay moved the version');
  });
});

// ===========================================================================
// M7CH-07 (AC-5): two instances, two actors, one version
// ===========================================================================

caseTest('M7CH-07: two tenant entries over one database, two Edit actors, one expected version — one 200 and one sealed 409 write_conflict that replays under its key, ordered by an owner\'s hold of the customer row', async () => {
  const T = await newTenant('m7ch07');
  const first = await actor('m7ch07-owner', [tenantGrant(T, 'store_owner')]);
  const second = await actor('m7ch07-manager', [tenantGrant(T, 'manager')]);
  const c = await seedCustomer(T, 'raced', { phone: PHONE });
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const sa = await signIn(a, first);
    const sb = await signIn(b, second);
    for (const [round, version, [x, sx, labelX], [y, sy, labelY]] of [
      [1, 1, [a, sa, 'A'], [b, sb, 'B']],
      [2, 2, [b, sb, 'B'], [a, sa, 'A']],
    ]) {
      const winner = canary(`raced ${round} ${labelX}`);
      const loser = canary(`raced ${round} ${labelY}`);
      const loserKey = randomUUID();
      const before = await counts();
      const h = await holdCustomer(c.id);
      let px;
      let py;
      try {
        px = quietly(x.patch(sx, c.id, { expectedVersion: version, name: winner }));
        const xPid = waitingPid(await blockedOrSettled(px, { by: h.pid, query: AT_EDIT }), `round ${round}: ${labelX} waiting on the row`);
        py = quietly(y.patch(sy, c.id, { expectedVersion: version, name: loser }, { key: loserKey }));
        waitingPid(await blockedOrSettled(py, { by: xPid, query: AT_EDIT }), `round ${round}: ${labelY} queued behind ${labelX}`);
      } finally {
        await h.commit();
      }
      editedOf(await replyTo(px, labelX), { id: c.id, name: winner, version: version + 1 }, `round ${round}: ${labelX} commits`);
      conflictOf(await replyTo(py, labelY), `round ${round}: ${labelY} conflicts on the version ${labelX} moved`);
      conflictOf(await y.patch(sy, c.id, { expectedVersion: version, name: loser }, { key: loserKey }), `round ${round}: ${labelY}'s 409 replays`, { replayed: true });
      await assertDelta(before, { C: 0, U: 1, K: 2, O: 0, L: 2 }, `round ${round}: one change, two completions`);
      const row = await rowOf(c.id);
      assert.deepEqual([row.version, row.name, row.phone], [String(version + 1), winner, PHONE], `round ${round}: the winner's values`);
    }
  }));
});

// ===========================================================================
// M7CH-08 (AC-5): revocations ordered by lock waits
// ===========================================================================

caseTest('M7CH-08: a grant suspension, a session revocation or a level narrowing committed while the edit waits on 016\'s hold leaves nothing written; one attempted while the edit holds its locks waits for the edit, which commits first', async () => {
  await withEntry({}, async (ctx) => {
    // (a) The revocation commits first: the edit waits on 016's hold (the owner holds the account), the revocation commits
    // meanwhile, then the edit proceeds, re-reads, and refuses inside its transaction.
    for (const [label, revoke, next] of [
      ['the grant suspended first', (f) => (sql) => sql`update user_membership set status = 'suspended' where internal_user_id = ${f.who.id}`, [401, 'unauthenticated']],
      ['the session revoked first', (f) => (sql) => sql`select tmpos_session.m5_session_revoke(${f.s.key}::text)`, [401, 'unauthenticated']],
      ['the role narrowed to Create first', (f) => (sql) => setLevel(f.tenant, 'manager', 'create', sql), [403, 'forbidden']],
    ]) {
      const tag = label.split(' ')[1];
      const tenant = await newTenant(`m7ch08-first-${tag}`);
      const who = await actor(`m7ch08-first-${tag}`, [tenantGrant(tenant, 'manager')]);
      const c = await seedCustomer(tenant, `revoked first ${tag}`);
      const f = { tenant, who, c, s: await signIn(ctx, who) };
      const body = { expectedVersion: 1, name: canary(`never stored ${label}`) };
      const row = await rowOf(c.id);
      const before = await counts();
      const h = await holdAccount(who);
      let pending;
      try {
        pending = quietly(ctx.patch(f.s, c.id, body));
        waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_HOLD }), `${label}: the edit waiting on 016's hold`);
        const outcome = await ownerOutcome(ownerWrite(label, revoke(f)));
        assert.equal(outcome?.settled, 'committed', `${label}: the revocation commits while the edit waits (${JSON.stringify(outcome)})`);
      } finally {
        await h.commit();
      }
      const refusedReply = await replyTo(pending, label);
      assertRefusal(refusedReply, 503, 'service_unavailable', `${label}: the edit refuses inside its transaction`);
      assert.equal(ctx.reason(refusedReply), 'transaction_unavailable', `${label}: the revalidation refused, never a timeout`);
      await assertDelta(before, { ...NOTHING, L: 1 }, `${label}: nothing written; the lease, taken before, stays`);
      assert.deepEqual(await rowOf(c.id), row, `${label}: the customer untouched`);
      assertRefusal(await ctx.patch(f.s, c.id, body), next[0], next[1], `${label}: the next request`);
    }

    // (b) The edit holds its locks first: it waits for the customer row (held by the owner) only after every authority
    // lock; a grant suspension, a level narrowing and a logout of the presenting session each wait for it; it commits,
    // then they do.
    for (const [label, competitor, next] of [
      ['a grant suspension', (f) => ({ write: (sql) => sql`update user_membership set status = 'suspended' where internal_user_id = ${f.who.id}` }), [401, 'unauthenticated']],
      ['a level narrowing', (f) => ({ write: (sql) => setLevel(f.tenant, 'manager', 'view', sql) }), [403, 'forbidden']],
      ['a logout of the presenting session', (f) => ({ request: quietly(ctx.logout(f.s)) }), [401, 'unauthenticated']],
      ['a revocation of the presenting session', (f) => ({ write: (sql) => sql`select tmpos_session.m5_session_revoke(${f.s.key}::text)` }), [401, 'unauthenticated']],
    ]) {
      const tag = label.split(' ').slice(1, 3).join('-');
      const tenant = await newTenant(`m7ch08-after-${tag}`);
      const who = await actor(`m7ch08-after-${tag}`, [tenantGrant(tenant, 'manager')]);
      const c = await seedCustomer(tenant, `revoked after ${tag}`);
      const f = { tenant, who, c, s: await signIn(ctx, who) };
      const name = canary(`edited before ${label}`);
      const before = await counts();
      const h = await holdCustomer(c.id);
      let pending;
      let rival;
      try {
        pending = quietly(ctx.patch(f.s, c.id, { expectedVersion: 1, name }));
        const commandPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_EDIT }), `${label}: the edit waiting on the customer row`);
        rival = competitor(f);
        if (rival.write !== undefined) {
          rival.done = ownerWrite(label, rival.write);
          const outcome = await ownerOutcome(rival.done);
          assert.ok(outcome?.blocked && outcome.blockers.includes(commandPid), `${label} waits for the edit (${JSON.stringify(outcome)})`);
        } else {
          waitingPid(await blockedOrSettled(rival.request, { by: commandPid }), `${label} waits for the edit`);
        }
      } finally {
        await h.commit();
      }
      editedOf(await replyTo(pending, label), { id: c.id, name, version: 2 }, `${label}: the edit commits first`);
      if (rival.write !== undefined) assert.equal(await within(rival.done.done, label), 'committed', `${label} commits after`);
      else assert.equal((await replyTo(rival.request, label)).status, 204, `${label} ends the session after`);
      await assertDelta(before, { ...ONE, L: 1 }, label);
      assertRefusal(await ctx.patch(f.s, c.id, { expectedVersion: 2, name: canary(`never stored after ${label}`) }), next[0], next[1], `${label}: the next request`);
      assert.equal((await rowOf(c.id)).version, '2', `${label}: one change`);
    }
  });
});

// ===========================================================================
// M7CH-09: logs (declared last)
// ===========================================================================

test('M7CH-09: no captured log line carries a customer name, phone, email or id, a session identifier, key or CSRF token, an Idempotency-Key, a token or a key — nor does the server log of a cluster this file started', () => {
  const forbidden = [
    'synthetic-pw', PHONE,
    ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)]),
    ...SECRETS,
  ];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const sent of ['+1 555 0199', '+1 555 0142']) assert.ok(SECRETS.has(sent), `the submitted phone ${sent} was collected from the bodies sent`);
  for (const line of ALL_LOG_LINES) {
    for (const needle of forbidden) assert.ok(!line.includes(needle), `a log line leaked a value: ${String(needle).slice(0, 6)}...`);
  }
  if (cluster !== null) {
    const log = readFileSync(`${cluster.root}/postgres.log`, 'utf8');
    const leaked = forbidden.filter((v) => log.includes(v));
    assert.deepEqual(leaked.map((v) => String(v).slice(0, 6)), [], 'nothing of these in the server log');
  }
});
