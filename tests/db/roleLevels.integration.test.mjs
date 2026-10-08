// M7A-CUSTOMERS-P3-R1 — AN OWNER'S ROLE EDIT REACHES EVERY CUSTOMER DECISION, END TO END: the tenant entry
// (server/entry/tenantEntry.ts, startTenantEntry) over REAL loopback HTTP and a disposable PostgreSQL holding migrations
// 001-029, composed exactly as server/entry/tenantMain.ts composes it but for its construction.
//
// M7A-CUSTOMERS-P4 UPDATE (DA-125; migration 021). The edit is conditional: its body is six fields, the four of the edit and
// the tenant and version the owner reviewed (expectedTenant, expectedVersion), and it writes only while both still hold.
// Every edit here is built the way the shop builds it — edit() reads GET /api/v1/roles/levels first and asserts that read's
// tenant and version — or, where a case needs a precondition without an owner read (a refused editor, a malformed body, a
// race lever), from the version 021 stores (preOf, an owner read). An applied edit answers the version it committed at, one
// past the asserted one, and the read-back carries each editable role's version. M7RLH-08 records the residual on 021's set
// (020's is no longer the runtime role's to call), and M7RLH-10 the precondition through the route: a stale version and a
// foreign tenant are an UNSEALED 409 write_conflict with nothing written, the key's lease kept; a restored default moves
// the version, so the draft from before it stays refused; a replay still answers its own committed 200.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY — the three things tests/db/customerCreate.integration.test.mjs substitutes, none of
// them on the path under test: the database client (a supervised kernel over the cluster as a non-owner least-privilege
// runtime LOGIN, tmpos_m7rlh_probe, holding tmpos_app and tmpos_audit_writer and nothing else, through a byte relay that can
// also drop a COMMIT's answer), the identity verifier (a synthetic bearer-token map whose authentication time a test may
// age) and the listener (127.0.0.1:0). The host lock, the limiter, the Origin/CSRF checks, the tenant session boundary, the
// tenant authorizer and its role-level read, the step-up check, the idempotency store, the tenant command transaction and
// its revalidator, migration 020's routines, the audit writer and the completion are production's own code, unmodified.
//
// WHAT IS PROVEN. C/A/E/K/O are the customer rows, the audit rows of tenant.customer.create, the audit rows of
// tenant.role.level.update, the sealed idempotency completions and the outbox rows (L: every idempotency row, leases
// included), each a delta the OWNER reads around a case. Every case runs in a tenant of its own, so no level leaks between
// cases:
//   M7RLH-01 THE REGRESSION: a store owner's PUT /api/v1/roles/levels narrowing sales_staff to View answers 200, and the
//            sales_staff session's next POST /api/v1/customers is 403 with 0/0/0 (at 8c0a4a8: 404, then 201 with 1/1/1);
//   M7RLH-02 a default sales_staff creates (1/1/1/0) and another tenant cannot read it; narrowed to View and to None it is
//            refused before any key; restored to Create a new key creates; the key refused at the authorizer, resent after
//            the restore, is a NEW command; a technician widened to Create creates;
//   M7RLH-03 a session issued before the edit is refused on its next POST without re-login; None also refuses the read
//            (GET 403, and 020's page_v3 answers 'denied' for the same key); View still reads;
//   M7RLH-04 two entries on one database: the owner's edit, parked holding the role row, makes the other instance's create
//            wait INSIDE 020's routine; the edit commits and the create is refused (503, nothing written); its key then answers
//            403 while narrowed, 409 within its lease once restored, and — the lease expired — is decided afresh (201);
//   M7RLH-05 two entries on one database: a create parked holding the role row FOR SHARE makes the other instance's edit wait;
//            the create commits first, then the edit, whose level stands and refuses the next create;
//   M7RLH-06 the edit route itself: non-owner editors and store/other-tenant owners are 403 with nothing written; every
//            malformed body is 400; a stale sign-in is 403 step_up_required; the admitted edit writes one tenant-scope audit
//            record naming the edit and its reason, one completion, no outbox event; replay, conflict, admin audience,
//            Host, Idempotency-Key, Origin, CSRF and size refusals;
//   M7RLH-07 an audit INSERT that raises rolls a create and an edit back whole (503, the lease kept, 409 within it); a COMMIT
//            whose answer is lost is a 503 and the retry replays what committed — a create and an edit alike;
//   M7RLH-08 the runtime login directly (the residuals, witnessed with their counts): a live sales_staff key creates on 020's
//            routine with NO audit, completion or outbox row, and is refused once the owner narrows; a live owner key changes
//            a level on 021's set routine (given the tenant and version) with NO audit or completion; 020's set, 019's create
//            and 018's page_v2 are 42501, and neither the customer table nor the role table takes a direct write;
//   M7RLH-09 two entries on one database: the owner's recent sign-in goes stale WHILE its edit waits inside 021's set routine
//            for a create holding the role row FOR SHARE; the create commits (201), the edit is refused on the database clock
//            after the routine answered (503, level unchanged, no edit audit record, no completion, its lease kept: 409 for
//            the same key within it); M7RLH-09b the same shape with the deadline far off commits both (201, 200);
//   M7RLH-C1 the compiled tenant artifact serves exactly its twenty routes (the customer detail read since P4, the profile read
//            since P6, the customer edit since P7, the Invoices read-back since M5-INVOICES-AUTH-P1, the store directory and the three invoice-draft routes since
//            M7B-INVOICES-P1, the drafts' creation eligibility since M7B-INVOICES-P1-R2, the draft edit and its edit eligibility
//            since M7B-INVOICES-P2), the owner's PUT, its
//            read-back, the Invoices read-back (the catalog defaults of a fresh tenant) and the narrowed POST refusal.
//   M7RL-G01..G03 (M7A-CUSTOMERS-P3-R2) the owner's read-back, GET /api/v1/roles/levels: a fresh tenant reads every catalog
//            default, 020's NULL lock row reads as the default, an edit reads as stored — in a second session and under a
//            stale sign-in too — with no-store and no session material, and the read writes nothing; only the tenant's store
//            owner reads it (manager, technician, sales_staff and a store-scope owner 403; no session and an administrative
//            session 401; the admin or an unknown Host 404; any query 400); each owner reads its own tenant alone.
//   M7RL-G04 (M7A-CUSTOMERS-P3-R2 review, AM8) a live owner session whose grant is then demoted to manager, or suspended, is
//            refused on its next read (the changed standing ends the session: 401 — never the old answer) and its re-login
//            as a manager reads 403; every 401/403 answer is no-store; a stored `manage` (a level the shop's grid never
//            offers) round-trips through the edit and the read-back as stored.
//   M7RLH-10 (M7A-CUSTOMERS-P4) the precondition: a stale version and another tenant's id are 409 write_conflict in the
//            chain's { error, requestId } shape — no level, version, audit record or completion, the lease kept (409
//            request_in_progress for the same key, and once it lapses the same key is decided afresh: 409 again); a key
//            whose edit committed replays that 200 after a later edit superseded it; default -> None -> the default Create
//            moves the version twice, so the draft of the first read is refused and Create stands.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster
// this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. On a shared service
// it removes its own customer, role-level (021's versions first), session and mint-ledger rows and its proof schema, restores the limiter's
// fingerprint and the issuer key row it found (or its absence), drops every trigger it installed and its login. What it
// leaves is what every suite leaves: its synthetically named identities, tenants and stores, their audit records and
// idempotency records.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnv, installTestIssuerKey, resolveDisposableTarget, testClient, testDriverVia } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry, TENANT_SHIPPING_ROUTES } from '../../server/entry/tenantEntry.ts';
import { SHIPPING_ROUTES } from '../../server/entry/productionEntry.ts';
import { principalKeyOf, RECENT_AUTH_MAX_AGE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER, SESSION_TTL } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { COMMAND_TRANSACTION_DEADLINE_MS } from '../../server/runtime/commandTransaction.ts';
import { CUSTOMER_DIRECTORY_PATH } from '../../server/runtime/customerDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7rlh-migrator', runtimeRef: 'm7rlh-runtime' };
const LOCK_KEY = 528_526;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7rlh_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/**
 * The edit route, pinned as a LITERAL (not imported from server/runtime/roleLevelUpdate.ts): this file must load on the
 * entry commit 8c0a4a8, where that module does not exist, so M7RLH-01 can be run there and seen to fail.
 */
const ROLE_LEVELS_PATH = '/api/v1/roles/levels';
/** The two audit actions (the command contracts' kinds), pinned as literals. */
const CREATE_ACTION = 'tenant.customer.create';
const EDIT_ACTION = 'tenant.role.level.update';
/** A reason the edit route admits: trimmed, 10-500 scalars. */
const REASON = 'Owner review of customer access';
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The bound on every lever and every awaited outcome. */
const WAIT_MS = 10_000;
/** The command transaction's lock bound (postgresTransactionalStore.ts boundsUnder): no lock wait shorter than it times out. */
const COMMAND_LOCK_BOUND_MS = Math.floor(COMMAND_TRANSACTION_DEADLINE_MS * 0.7);
/** The advisory key the parking trigger waits on (the two-int space: never the migration lock's bigint one). */
const PARK = [528_526, 20];
/** Four one-connection pools per instance: two instances, the owner and the observer stay inside a 20-connection cluster. */
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });

// ---------------------------------------------------------------------------
// cluster lifecycle (mirrors tests/db/customerCreate.integration.test.mjs)
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M7RLH');
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
/** The observer: reads pg_stat_activity and pg_locks while the owner's connections hold levers. */
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
/** Holds a failing test may leave open; teardown settles every one before it cleans up. */
const OPEN = new Set();

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const open of [...OPEN]) await step(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
    // The proof schema's function carries every trigger this file installed: CASCADE drops them with it.
    await step(() => owner.unsafe('drop schema if exists m7rlh_proof cascade'));
    if (TENANTS.length > 0) {
      // 021's rollback refuses while any version row exists, and 020's while a stored level differs from its default: this
      // suite's versions, then its edits, are removed. Either table is absent on a database before its migration (the entry
      // commit's red run), and then there is nothing to remove.
      await step(async () => {
        const [{ versions }] = await owner`select pg_catalog.to_regclass('tmpos_role_edit.role_level_version') is not null as versions`;
        if (versions) await owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
      });
      await step(async () => {
        const [{ present }] = await owner`select pg_catalog.to_regclass('tmpos_role.tenant_role_level') is not null as present`;
        if (present) await owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
      });
      // 016's up/down refuse while a tenant session exists, 017's down while a customer row does, 018's while a ledger row does.
      await step(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
    }
    if (UIDS.length > 0) {
      await step(async () => {
        for (const row of await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`) KEYS.add(row.session_key);
      });
    }
    if (KEYS.size > 0) await step(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
    if (UIDS.length > 0) await step(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
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
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M7RLH teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'M7RLH setup failed, and so did its teardown'); });
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
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m7rlh-relay-'));
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
 * Arm `relay` (productionEntry.integration's M6AA-10 technique): on the first connection that sends the audit INSERT, the
 * next COMMIT is forwarded — so the server commits — and every byte of the server's answer after it is dropped.
 * release() disarms the trap and cuts the silenced connection.
 */
function loseCommitAnswer(relay) {
  const silenced = [];
  relay.state.trap = (pair, chunk) => {
    if (chunk.includes(AUDIT_INSERT_TEXT)) {
      pair.audited = true;
    } else if (pair.audited && chunk.includes(COMMIT_PARSE)) {
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
// setup: every migration in the directory (001-029 here; 001-019 on the entry commit), the runtime login, the three keys,
// and the owner's proof schema
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
});

await setupStep(async () => {
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  // G-DBROLE provisioning (not a migration): the ledger read the startup preflight requires of the runtime login.
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
});

/** Made in this process, never written anywhere: the limiter's key, the tenant issuer key and the tenant command key. */
const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);

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
  await owner.unsafe('drop schema if exists m7rlh_proof cascade');
  await owner.unsafe('create schema m7rlh_proof');
  await owner.unsafe('revoke all on schema m7rlh_proof from public');
  await owner.unsafe('create sequence m7rlh_proof.fired');
});

// ---------------------------------------------------------------------------
// the synthetic identity provider and the configuration every entry starts from
// ---------------------------------------------------------------------------

/**
 * token -> { uid, authAgeMs } | { uid, authTimeSec }: the verifier answers the provider's authentication time (whole seconds,
 * as the provider states it) as now minus authAgeMs, or exactly authTimeSec — whose session's recent-sign-in deadline is then
 * exactly authTimeSec * 1000 + RECENT_AUTH_MAX_AGE_MS (the adapter's seconds-to-ms, app.ts's bound).
 */
const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) {
      const err = new Error('unknown_token');
      err.code = 'auth/invalid-id-token';
      throw err;
    }
    return { uid: rec.uid, authTime: rec.authTimeSec ?? Math.floor((Date.now() - rec.authAgeMs) / 1000), secondFactor: 'totp' };
  },
});

const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const FIREBASE_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'm7rlh-test-project',
  client_email: 'm7rlh-test@m7rlh-test-project.iam.gserviceaccount.com',
  private_key: FIREBASE_PRIVATE_KEY,
});

/** Every instance gets the SAME IDEMPOTENCY_KEY: the process cannot check that its peers hold it (DA-112), so the suite does. */
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
// requests and replies
// ---------------------------------------------------------------------------

/** A random 127.x.y.z loopback source, never the trusted proxy: each is its own limiter subject. */
function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}

/** A customer name no other run shares: `M7RLH <label> <suffix>` (the parking and fault triggers filter on the prefix). */
const nameOf = (label) => `M7RLH ${label} ${SUFFIX}`;

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
    request.setTimeout(20_000, () => request.destroy(new Error(`no reply within 20 s: ${method} ${path}`)));
    request.end(payload);
  });
}

function parseHttpHead(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const lines = raw.slice(0, idx).split('\r\n');
  const m = /^HTTP\/\d\.\d (\d{3})/.exec(lines[0] ?? '');
  if (m === null) return null;
  const headers = {};
  const setCookies = [];
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (name === 'set-cookie') setCookies.push(value); else headers[name] = value;
  }
  const bodyStart = idx + 4;
  const len = Number(headers['content-length'] ?? '0');
  if (raw.length - bodyStart < len) return null;
  return { status: Number(m[1]), headers, setCookies, body: raw.slice(bodyStart, bodyStart + len) };
}

/** A raw request over a fresh socket: a declared length with no body. */
function rawRequest(port, text, { localAddress, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const options = { port, host: '127.0.0.1' };
    if (localAddress) options.localAddress = localAddress;
    const socket = net.connect(options);
    let raw = '';
    let settled = false;
    const timer = setTimeout(() => finish(parseHttpHead(raw) ?? { status: 0, headers: {}, setCookies: [], body: raw }), timeoutMs);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      const parsed = parseHttpHead(raw);
      if (parsed !== null) finish(parsed);
    });
    socket.on('error', () => finish({ status: 0, headers: {}, setCookies: [], body: '' }));
    socket.on('close', () => finish(parseHttpHead(raw) ?? { status: 0, headers: {}, setCookies: [], body: raw }));
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
  const cookies = reply.setCookies ?? reply.headers['set-cookie'];
  assert.ok(cookies === undefined || cookies.length === 0, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
}

/** A created customer: 201, exactly { customer: { id, name } }, a version-4 id, Location its detail path. Answers { id, name }. */
function createdOf(reply, name, label, { replayed = false } = {}) {
  assert.equal(reply.status, 201, `${label}: ${reply.status} ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['customer'], label);
  assert.deepEqual(Object.keys(body.customer), ['id', 'name'], label);
  assert.match(body.customer.id, V4, `${label}: a server-generated version-4 id`);
  assert.equal(body.customer.name, name, label);
  assert.equal(reply.headers.location, `/api/v1/customers/${body.customer.id}`, `${label}: Location names the detail route (M7A-CUSTOMERS-P4)`);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
  return body.customer;
}

/**
 * An applied edit: 200, exactly { roleLevel: { roleId, domain, level, version } } — the version it committed at, one past the
 * asserted one (M7A-CUSTOMERS-P4) — no Set-Cookie.
 */
function editedOf(reply, roleId, level, label, { replayed = false, version } = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.status} ${reply.body}`);
  assert.ok(Number.isSafeInteger(version) && version > 0, `${label}: the case names the committed version`);
  assert.deepEqual(JSON.parse(reply.body), { roleLevel: { roleId, domain: 'customers', level, version } }, label);
  assert.equal(reply.headers['idempotent-replayed'], replayed ? 'true' : undefined, `${label}: replayed=${replayed}`);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
}

/** The catalog's Customers defaults, pinned here as the read-back must report them (permissionCatalog.ts). */
const CUSTOMERS_DEFAULTS = Object.freeze({ manager: 'full', technician: 'view', sales_staff: 'create' });

/**
 * A read-back: 200, exactly { tenant, domain, roles } — the owner first, fixed and unversioned, then each editable role at
 * its stored level (`stored`, by role) or its default, and at its version (`versions`, by role; 0 when never edited:
 * M7A-CUSTOMERS-P4) — no-store, no Set-Cookie, the baseline headers.
 */
function readBackOf(reply, tenant, stored, label, versions = {}) {
  assert.equal(reply.status, 200, `${label}: ${reply.status} ${reply.body}`);
  const roles = [{ roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null },
    ...Object.entries(CUSTOMERS_DEFAULTS).map(([roleId, defaultLevel]) => {
      const level = stored[roleId] ?? null;
      return {
        roleId, level: level ?? defaultLevel, defaultLevel, source: level === null ? 'default' : 'stored', editable: true, version: versions[roleId] ?? 0,
      };
    })];
  assert.deepEqual(JSON.parse(reply.body), { tenant, domain: 'customers', roles }, label);
  assert.equal(reply.headers['cache-control'], 'no-store', `${label}: never cached`);
  assert.equal(reply.headers['set-cookie'], undefined, `${label}: no Set-Cookie`);
  assertBaseline(reply, label);
}

/**
 * The edit route's body: exactly its six fields (M7A-CUSTOMERS-P4) — the edit, then the precondition `pre` = { tenant,
 * version } it asserts.
 */
const levelBody = (roleId, level, pre, reason = REASON) => ({
  roleId, domain: 'customers', level, reason, expectedTenant: pre.tenant, expectedVersion: pre.version,
});

// ---------------------------------------------------------------------------
// fixtures — all written through the owner
// ---------------------------------------------------------------------------

async function actor(label, memberships) {
  const uid = `m7rlh-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid, authAgeMs: 0 });
  // The same principal, signed in long ago by the provider's own clock: a session from it fails the step-up bound.
  TOKENS.set(`${token}-stale`, { uid, authAgeMs: RECENT_AUTH_MAX_AGE_MS + 60_000 });
  UIDS.push(uid);
  return { id, uid, token, staleToken: `${token}-stale`, label, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });

async function newTenant(label) {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`m7rlh-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(id);
  return id;
}

/** A tenant of its own for one case, with its store owner (the one editor the server admits). */
async function shop(label) {
  const tenant = await newTenant(label);
  const boss = await actor(`${label}-owner`, [tenantGrant(tenant, 'store_owner')]);
  return { tenant, boss };
}

/** The store key of the session a cookie presents: the SHA-256 of its identifier, as the chain computes it. */
const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');

/** A live, well-formed ADMINISTRATIVE session row minted as the runtime login through 018's admin branch: its identifier. */
async function adminSessionId(who) {
  const id = randomBytes(32).toString('base64url');
  const key = createHash('sha256').update(id).digest('base64url');
  KEYS.add(key);
  const runtime = runtimeClient();
  try {
    const at = Date.now();
    const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, 'admin'::text, 'firebase'::text,
      ${who.uid}::text, ${principalKeyOf(who.principal)}::text, 'm7rlh-admin'::text, ${at}::bigint, ${at}::bigint, ${at}::bigint,
      ${at}::bigint, ${at + SESSION_TTL.admin.absoluteMs}::bigint, null::bytea) as outcome`;
    assert.equal(outcome, 'created', 'an administrative row exists to be presented');
  } finally {
    await runtime.end({ timeout: 5 });
  }
  return id;
}

/** The runtime login's own connection, for the direct database attempts. */
const runtimeClient = () => testClient(TARGET, { user: RUNTIME_LOGIN, max: 1, onnotice: () => {} });
async function codeOf(query) {
  try { await query; return 'ok'; } catch (err) { return err?.code ?? String(err); }
}

/** The stored Customers level of a role in a tenant: a level, null (the lock row: the catalog default) or undefined (no row). */
async function levelOf(tenant, roleId) {
  const rows = await owner`select level from tmpos_role.tenant_role_level
    where tenant_id = ${tenant} and role_id = ${roleId} and domain = 'customers'`;
  return rows.length === 0 ? undefined : rows[0].level;
}

/** A role's version as 021 stores it: 0 until the first edit since 021 (no row). */
async function versionOf(tenant, roleId) {
  const rows = await owner`select version from tmpos_role_edit.role_level_version
    where tenant_id = ${tenant} and role_id = ${roleId} and domain = 'customers'`;
  return rows.length === 0 ? 0 : Number(rows[0].version);
}
/** The precondition a draft of `roleId` made now asserts: the tenant and the role's current version (an owner read). */
const preOf = async (tenant, roleId) => ({ tenant, version: await versionOf(tenant, roleId) });

/** The scopes of every idempotency record still in progress (a lease, no completion). */
const openLeases = async () => new Set((await owner`select scope from tmpos_internal.idempotency_record where response is null`).map((r) => r.scope));

// ---------------------------------------------------------------------------
// row counts: C/A/E/K/O (and L), as deltas around a case
// ---------------------------------------------------------------------------

async function counts() {
  const [r] = await owner`select
    (select count(*) from tmpos_customer.customer)::int as c,
    (select count(*) from public.audit_event where action_id = ${CREATE_ACTION})::int as a,
    (select count(*) from public.audit_event where action_id = ${EDIT_ACTION})::int as e,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as k,
    (select count(*) from tmpos_internal.outbox_event)::int as o,
    (select count(*) from tmpos_internal.idempotency_record)::int as l`;
  return { ...r };
}
async function deltaSince(before) {
  const now = await counts();
  return { C: now.c - before.c, A: now.a - before.a, E: now.e - before.e, K: now.k - before.k, O: now.o - before.o, L: now.l - before.l };
}
/** The delta since `before` equals `expected` in every field `expected` names; the message prints the whole delta. */
async function assertDelta(before, expected, label) {
  const got = await deltaSince(before);
  assert.deepEqual(got, { ...got, ...expected }, `${label}: C/A/E/K/O/L ${JSON.stringify(got)}`);
}
const NOTHING = Object.freeze({ C: 0, A: 0, E: 0, K: 0, O: 0 });
/** One customer create: the row, its audit record, its completion, no outbox event. */
const ONE = Object.freeze({ C: 1, A: 1, E: 0, K: 1, O: 0 });
/** One role edit: its audit record, its completion, no customer, no outbox event. */
const EDIT = Object.freeze({ C: 0, A: 0, E: 1, K: 1, O: 0 });

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

function makeCapture() {
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const log = { log: (line) => { lines.push(line); } };
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

/**
 * Start one tenant entry over its own relay — the source entry, or `start` (M7RLH-C1's compiled one) — hand the test a
 * bound request surface, then stop it.
 */
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
  const result = await (overrides.start ?? startTenantEntry)({ env: ENV, construction, proc: cap.proc, exit: cap.exit, log: cap.log });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  const port = result.address.port;
  const unsafe = (method, path) => (s, body, { key = randomUUID(), headers = {}, drop = [], localAddress = clientAddress } = {}) => {
    const all = { ...unsafeHeaders(s, key), ...headers };
    for (const name of drop) delete all[name];
    return send(port, method, path, all, typeof body === 'string' ? body : JSON.stringify(body), { localAddress });
  };
  const ctx = {
    cap, relay, port, clientAddress, result,
    post: unsafe('POST', CUSTOMER_DIRECTORY_PATH),
    put: unsafe('PUT', ROLE_LEVELS_PATH),
    /** The owner's read-back (M7A-CUSTOMERS-P3-R2): a safe GET presenting `s` (null: no session). */
    levels: (s, { query = '', headers = {} } = {}) => send(port, 'GET', `${ROLE_LEVELS_PATH}${query}`,
      { host: TENANT_HOST, ...(s === null ? {} : { cookie: s.cookie }), ...headers }, undefined, { localAddress: clientAddress }),
    /** A hand-framed request: the unsafe headers of `s`, then `lines` (each ending CRLF), then `tail` as the body bytes. */
    raw: (method, path, s, lines, tail = '') => {
      const head = Object.entries(unsafeHeaders(s, null)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      return rawRequest(port, `${method} ${path} HTTP/1.1\r\n${head}${lines}Connection: close\r\n\r\n${tail}`, { localAddress: clientAddress });
    },
    list: (s, query = '?limit=100') => send(port, 'GET', `${CUSTOMER_DIRECTORY_PATH}${query}`, { host: TENANT_HOST, cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf }, undefined, { localAddress: clientAddress }),
    current: (s) => send(port, 'GET', sessionPaths('tenant').current, { host: TENANT_HOST, cookie: s.cookie }, undefined, { localAddress: clientAddress }),
    /** The log records the runtime wrote for one reply, by its request id. */
    records: (reply) => cap.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
      .filter((r) => r.requestId === reply.headers['x-request-id']),
    /** The refusal reason the runtime logged for one reply. */
    reason: (reply) => {
      const lines = ctx.records(reply).filter((r) => r.event === 'request');
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

/** A tenant login from a fresh loopback source (the login limit is per source): { cookie, csrf, key }. */
async function signIn(ctx, who, { token = who.token } = {}) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  const key = keyOf(cookie);
  KEYS.add(key);
  return { cookie, csrf: JSON.parse(reply.body).csrfToken, key };
}

/**
 * The owner's edit through the route, which must apply — built as the shop builds it (M7A-CUSTOMERS-P4): the read-back first,
 * then the edit asserting that read's tenant and the role's version, answered at the next version.
 */
async function edit(ctx, s, roleId, level, label = `the owner sets ${roleId} to ${level}`) {
  const read = await ctx.levels(s);
  assert.equal(read.status, 200, `${label}: the read the draft is made from: ${read.body}`);
  const { tenant, roles } = JSON.parse(read.body);
  const { version } = roles.find((r) => r.roleId === roleId);
  const reply = await ctx.put(s, levelBody(roleId, level, { tenant, version }));
  editedOf(reply, roleId, level, label, { version: version + 1 });
  return reply;
}

/** Every customer the session's tenant read answers, following nextCursor: id -> name. */
async function customersOf(ctx, s) {
  const seen = new Map();
  let query = '?limit=100';
  for (let guard = 0; guard < 50; guard++) {
    const reply = await ctx.list(s, query);
    assert.equal(reply.status, 200, reply.body);
    const body = JSON.parse(reply.body);
    for (const c of body.customers) seen.set(c.id, c.name);
    if (body.nextCursor === null) return seen;
    query = `?limit=100&cursor=${body.nextCursor}`;
  }
  throw new Error('the walk did not end');
}

// ---------------------------------------------------------------------------
// levers: owner-held locks and owner triggers, observed through pg_stat_activity and pg_locks
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
/** The advisory key the parking trigger waits on, held until released. */
const holdPark = () => hold('the parking key', (sql) => sql`select pg_catalog.pg_advisory_xact_lock(${PARK[0]}::int, ${PARK[1]}::int)`);

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
  assert.ok(outcome.blocked, `${what}: the request completed instead of waiting (${JSON.stringify(outcome.settled?.value?.status ?? outcome.settled)} ${outcome.settled?.value?.body ?? ''})`);
  return outcome.blocked[0].pid;
}
async function replyTo(request, label) {
  const reply = await within(request, label);
  assert.ok(typeof reply?.status === 'number', `no reply to ${label} within ${WAIT_MS} ms: ${JSON.stringify(reply)}`);
  return reply;
}
/** The locks a backend is waiting for, and the relation-level locks it holds on the role table. */
const waitingLocks = (pid) => probe`select locktype, mode from pg_catalog.pg_locks where pid = ${pid} and not granted`;
const roleTableLocks = async (pid) => (await probe`select mode from pg_catalog.pg_locks
  where pid = ${pid} and granted and relation = 'tmpos_role.tenant_role_level'::regclass`).map((r) => r.mode).sort();

/**
 * `work` runs with ONE owner trigger BEFORE INSERT on `table` for each row matching `when`: it counts itself on
 * m7rlh_proof.fired (a sequence, so the count survives the rollback it causes), then parks on the advisory key PARK, or
 * raises. Dropped, with its function, whatever `work` did.
 */
const TRIGGER_ACTIONS = Object.freeze({
  park: `perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); return new;`,
  raise: `raise exception 'M7RLH injected fault' using errcode = 'P0001';`,
});
async function withTrigger(table, when, action, work) {
  await owner.unsafe(`create function m7rlh_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.nextval('m7rlh_proof.fired'); ${TRIGGER_ACTIONS[action]} end $$`);
  await owner.unsafe('revoke all on function m7rlh_proof.fire() from public');
  await owner.unsafe(`create trigger m7rlh_fire before insert on ${table} for each row when (${when}) execute function m7rlh_proof.fire()`);
  try {
    return await work();
  } finally {
    await owner.unsafe(`drop trigger if exists m7rlh_fire on ${table}`);
    await owner.unsafe('drop function if exists m7rlh_proof.fire()');
  }
}
const fired = async () => (await owner`select coalesce(pg_catalog.pg_sequence_last_value('m7rlh_proof.fired'::regclass), 0)::int as n`)[0].n;
/** A customer INSERT whose name starts `M7RLH <prefix>`: the parking and fault triggers' filter. */
const namedLike = (prefix) => `pg_catalog.starts_with(new.name, 'M7RLH ${prefix}')`;
const CREATE_AUDIT = `new.action_id = '${CREATE_ACTION}'`;
const EDIT_AUDIT = `new.action_id = '${EDIT_ACTION}'`;

/** A route inventory as comparable lines. */
const canonical = (routes) => [...routes].map((r) => `${r.method} ${r.path} ${r.access} ${r.body} ${r.idempotency}`).sort();
/**
 * The tenant artifact's twenty intended routes, stated here once (M7A-CUSTOMERS-P3-R2: the owner's read-back; P4: the detail
 * read; P6: the profile read; P7: the customer edit; M5-INVOICES-AUTH-P1: the Invoices read-back; M7B-INVOICES-P1: the store
 * directory and the invoice drafts' list, read and save; M7B-INVOICES-P1-R2: the drafts' creation eligibility;
 * M7B-INVOICES-P2: the draft edit and its edit eligibility).
 */
const TENANT_TWENTY = Object.freeze([
  'GET /api/v1/customers session none none',
  'GET /api/v1/customers/{id} session none none',
  'GET /api/v1/customers/{id}/profile session none none',
  'GET /api/v1/roles/levels session none none',
  'GET /api/v1/roles/levels/invoices session none none',
  'GET /api/v1/session session none none',
  'GET /api/v1/stores session none none',
  'GET /api/v1/stores/{storeId}/invoice-drafts session none none',
  'GET /api/v1/stores/{storeId}/invoice-drafts/eligibility session none none',
  'GET /api/v1/stores/{storeId}/invoice-drafts/{id} session none none',
  'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility session none none',
  'GET /health public none none',
  'GET /readiness public none none',
  'PATCH /api/v1/customers/{id} session json required',
  'PATCH /api/v1/stores/{storeId}/invoice-drafts/{id} session json required',
  'POST /api/v1/customers session json required',
  'POST /api/v1/session/login login none none',
  'POST /api/v1/session/logout session none none',
  'POST /api/v1/stores/{storeId}/invoice-drafts session json required',
  'PUT /api/v1/roles/levels session json required',
]);

// ===========================================================================
// M7RLH-01: THE REGRESSION
// ===========================================================================

test('M7RLH-01: THE REGRESSION — a store owner narrows sales_staff to View over PUT /api/v1/roles/levels (200 {roleLevel}), and the sales_staff session\'s next POST /api/v1/customers is 403 with no customer, no audit record and no completion', async () => {
  // P3's defect: an owner's edit lived only in the editing browser tab, so the server decided sales_staff from the catalog
  // default (Create) and from 019's name list, whatever the owner had set. On the entry commit this case answers the PUT
  // 404 (no such route) and the POST 201 with 1/1/1. The sales_staff session is issued BEFORE the edit: the edit must
  // reach the next decision without a re-login.
  const { tenant, boss } = await shop('m7rlh01');
  const sales = await actor('m7rlh01-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({}, async (ctx) => {
    const salesSession = await signIn(ctx, sales);
    const bossSession = await signIn(ctx, boss); // a recent sign-in: the edit is a step-up action
    const put = await ctx.put(bossSession, levelBody('sales_staff', 'view', await preOf(tenant, 'sales_staff')));
    const name = nameOf('m7rlh01 after the narrowing');
    const before = await counts();
    const post = await ctx.post(salesSession, { name });
    const d = await deltaSince(before);
    // One assertion over everything observed, so a failure prints both statuses and every delta at once.
    const observed = { put: put.status, post: post.status, customers: d.C, audits: d.A, completions: d.K };
    assert.deepEqual(observed, { put: 200, post: 403, customers: 0, audits: 0, completions: 0 },
      `the owner's narrowing must reach the committing decision — observed ${JSON.stringify(observed)}; PUT ${put.body}; POST ${post.body}`);

    editedOf(put, 'sales_staff', 'view', 'the owner\'s edit', { version: 1 });
    assertRefusal(post, 403, 'forbidden', 'the narrowed role\'s create');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused at the authorizer, before any key is acquired');
    assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'the edit is durable: migration 020\'s row holds it');
  });
});

// ===========================================================================
// M7RLH-02: defaults, narrowing, restoring, widening
// ===========================================================================

test('M7RLH-02: a default sales_staff creates (201, 1/1/1/0) and another tenant cannot read it; narrowed to View and to None it is refused before any key with nothing written; restored to Create a new key creates; the key refused at the authorizer, resent after the restore, is a NEW command; a technician widened to Create creates', async () => {
  const { tenant, boss } = await shop('m7rlh02');
  const sales = await actor('m7rlh02-sales', [tenantGrant(tenant, 'sales_staff')]);
  const tech = await actor('m7rlh02-tech', [tenantGrant(tenant, 'technician')]);
  const other = await newTenant('m7rlh02-b');
  const reader = await actor('m7rlh02-b', [tenantGrant(other, 'manager')]);
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, sales);
    const o = await signIn(ctx, boss);
    const b = await signIn(ctx, reader);
    const bBefore = await customersOf(ctx, b);

    // Untouched, sales_staff holds its catalog default (Create): one row, one tenant-scoped audit record, one completion.
    const name = nameOf('m7rlh02 default');
    let before = await counts();
    const created = createdOf(await ctx.post(s, { name }), name, 'the default role');
    await assertDelta(before, { ...ONE, L: 1 }, 'the default role');
    const [row] = await owner`select tenant_id, name from tmpos_customer.customer where customer_id = ${created.id}`;
    assert.deepEqual({ ...row }, { tenant_id: tenant, name }, 'the row, in the session\'s tenant');
    const audits = await owner`select scope_type, tenant_id, required_permission from public.audit_event
      where action_id = ${CREATE_ACTION} and actor_internal_user_id = ${sales.id}`;
    assert.deepEqual(audits.map((r) => ({ ...r })), [{ scope_type: 'tenant', tenant_id: tenant, required_permission: 'create_customers' }]);
    assert.equal((await customersOf(ctx, s)).get(created.id), name, 'its own tenant reads it');
    assert.deepEqual(await customersOf(ctx, b), bBefore, 'the other tenant reads exactly what it read before');

    // Narrowed to View, then to None: refused at the authorizer on the stored level — before any key, so nothing at all.
    let refusedKey;
    const refusedName = nameOf('m7rlh02 refused then resent');
    for (const level of ['view', 'none']) {
      await edit(ctx, o, 'sales_staff', level);
      refusedKey = randomUUID();
      before = await counts();
      assertRefusal(await ctx.post(s, { name: refusedName }, { key: refusedKey }), 403, 'forbidden', `narrowed to ${level}`);
      await assertDelta(before, { ...NOTHING, L: 0 }, `narrowed to ${level}: nothing, not even a lease`);
    }

    // Restored to Create: a new key creates.
    await edit(ctx, o, 'sales_staff', 'create');
    const again = nameOf('m7rlh02 restored');
    before = await counts();
    createdOf(await ctx.post(s, { name: again }), again, 'restored, a new key');
    await assertDelta(before, { ...ONE, L: 1 }, 'restored, a new key');

    // The key refused while narrowed, resent unchanged after the restore: a NEW command. The authorizer refused it before
    // the idempotency store was asked, so no record — and no lease — ever existed for it: nothing to replay or to wait
    // out. It is decided afresh on the level as it stands now, and it is a first answer, never marked a replay.
    before = await counts();
    createdOf(await ctx.post(s, { name: refusedName }, { key: refusedKey }), refusedName, 'the refused key after the restore');
    await assertDelta(before, { ...ONE, L: 1 }, 'the refused key after the restore: its first record');

    // Widening applies too: a technician (default View) is refused, then creates once the owner sets Create.
    const t = await signIn(ctx, tech);
    const techName = nameOf('m7rlh02 technician');
    assertRefusal(await ctx.post(t, { name: techName }), 403, 'forbidden', 'a technician at its default');
    await edit(ctx, o, 'technician', 'create');
    before = await counts();
    createdOf(await ctx.post(t, { name: techName }), techName, 'a technician widened to Create');
    await assertDelta(before, { ...ONE, L: 1 }, 'a technician widened to Create');
    assert.deepEqual([await levelOf(tenant, 'sales_staff'), await levelOf(tenant, 'technician'), await levelOf(tenant, 'manager')],
      ['create', 'create', undefined], 'the stored levels: only what the owner set');
  });
});

// ===========================================================================
// M7RLH-03: an existing session, and the read
// ===========================================================================

test('M7RLH-03: a session issued before the edit is refused on its next POST without re-login; None also refuses the read (GET 403, and 020\'s page_v3 answers \'denied\' for the same key); View still reads', async () => {
  const { tenant, boss } = await shop('m7rlh03');
  const sales = await actor('m7rlh03-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, sales);
    const o = await signIn(ctx, boss);
    const name = nameOf('m7rlh03 before the edit');
    const created = createdOf(await ctx.post(s, { name }), name, 'the session creates before the edit');
    const runtime = runtimeClient();
    try {
      // The same session, no new login: the edit touches no session, grant or standing, and still decides the next request.
      await edit(ctx, o, 'sales_staff', 'view');
      let before = await counts();
      assertRefusal(await ctx.post(s, { name: nameOf('m7rlh03 after the edit') }), 403, 'forbidden', 'the existing session, narrowed to View');
      await assertDelta(before, { ...NOTHING, L: 0 }, 'the existing session, narrowed to View');
      assert.equal((await ctx.current(s)).status, 200, 'the session itself is still live: the refusal is the permission');

      // View still reads, over HTTP and on 020's read directly.
      assert.equal((await customersOf(ctx, s)).get(created.id), name, 'View reads');
      const page = await runtime`select * from tmpos_role.m7a_customer_page_v3(${s.key}::text, null::uuid, 100)`;
      assert.ok(page.length > 0 && page.every((r) => r.o_outcome !== 'denied') && page.some((r) => r.o_customer_id === created.id),
        `page_v3 answers the page at View: ${JSON.stringify(page.map((r) => r.o_outcome))}`);

      // None refuses the read as well: the authorizer (403), and the database's own read for the very same key.
      await edit(ctx, o, 'sales_staff', 'none');
      before = await counts();
      assertRefusal(await ctx.list(s), 403, 'forbidden', 'GET narrowed to None');
      const denied = await runtime`select * from tmpos_role.m7a_customer_page_v3(${s.key}::text, null::uuid, 100)`;
      assert.deepEqual(denied.map((r) => ({ ...r })), [{ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null }],
        'page_v3 refuses the same key at None');
      assert.equal((await ctx.current(s)).status, 200, 'still the same live session');

      // Back to View: the read returns, still without a new login.
      await edit(ctx, o, 'sales_staff', 'view');
      assert.equal((await customersOf(ctx, s)).get(created.id), name, 'View reads again');
      await assertDelta(before, { ...EDIT, L: 1 }, 'the refused read wrote nothing; the edit back to View is one edit');
    } finally {
      await runtime.end({ timeout: 5 });
    }
  });
});

// ===========================================================================
// M7RLH-04: the edit commits first, while the create waits on the role row — two instances
// ===========================================================================

test('M7RLH-04: two entries on one database — the owner\'s edit, parked holding the role row, makes the other instance\'s create wait INSIDE 020\'s routine; the edit commits and the create is refused (503, nothing written); its key then answers 403 while narrowed, 409 within its lease once restored, and is decided afresh once the lease expires (201)', async () => {
  const { tenant, boss } = await shop('m7rlh04');
  const sales = await actor('m7rlh04-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const o = await signIn(a, boss);
    const s = await signIn(b, sales);
    // A first create commits the role's lock row (NULL: the default), so the edit below UPDATES an existing row.
    const first = nameOf('m7rlh04 first');
    createdOf(await b.post(s, { name: first }), first, 'the default role creates');
    assert.equal(await levelOf(tenant, 'sales_staff'), null, 'the lock row exists, at the default');

    // The edit (instance A) takes the role row FOR UPDATE in 021's set routine and parks at its audit INSERT, uncommitted.
    // The create (instance B) passes the authorizer and the in-transaction revalidator — both read the COMMITTED level,
    // still the default — and reaches 020's create routine, which waits on the edit's row. The edit commits; the routine
    // re-reads the row under READ COMMITTED, finds View, and answers no row: the transaction rolls back whole.
    const key = randomUUID();
    const name = nameOf('m7rlh04 raced');
    const pre = await preOf(tenant, 'sales_staff');
    const leasesBefore = await openLeases();
    const before = await counts();
    let editReq;
    let createReq;
    let sentAt;
    let repliedAt;
    let locks;
    await withTrigger('public.audit_event', EDIT_AUDIT, 'park', async () => {
      const lever = await holdPark();
      try {
        editReq = quietly(a.put(o, levelBody('sales_staff', 'view', pre)));
        const editPid = waitingPid(await blockedOrSettled(editReq, { by: lever.pid }), 'the edit parked at its audit INSERT, its role row locked');
        sentAt = Date.now();
        createReq = quietly(b.post(s, { name }, { key }));
        createReq.then(() => { repliedAt = Date.now(); }, () => {});
        // M7A-CUSTOMERS-P6: the runtime's create statement is 023's routine; the wait is 020's, inside it.
        const createPid = waitingPid(await blockedOrSettled(createReq, { by: editPid, query: /tmpos_customer_contact\.m7a_contact_create/ }),
          'the create waiting on the edit inside 020\'s create routine (called by 023\'s)');
        locks = await waitingLocks(createPid);
      } finally {
        await lever.commit();
      }
      editedOf(await replyTo(editReq, 'the edit'), 'sales_staff', 'view', 'the edit commits first', { version: 1 });
    });
    const refused = await replyTo(createReq, 'the create');
    const elapsed = repliedAt - sentAt;
    assert.ok(locks.length > 0 && locks.every((l) => l.locktype === 'transactionid' || l.locktype === 'tuple'),
      `the create waited on the edit's row version: ${JSON.stringify(locks)}`);
    assertRefusal(refused, 503, 'service_unavailable', 'the create, refused inside its transaction');
    // Every lock wait of the command transaction is bounded at COMMAND_LOCK_BOUND_MS: a reply sooner than that after the
    // request was SENT cannot be a lock timeout, so the 503 is the routine's refusal on the level it re-read.
    assert.ok(elapsed < COMMAND_LOCK_BOUND_MS, `the refusal came before any lock bound could expire (${elapsed} ms)`);
    await assertDelta(before, { ...EDIT, L: 2 }, 'the edit\'s record and completion, and the create\'s lease only');
    assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'the edit stands');
    const lease = [...(await openLeases())].filter((scope) => !leasesBefore.has(scope));
    assert.equal(lease.length, 1, 'the refused create left exactly its lease');

    // Same key while still narrowed: the authorizer refuses before the key is touched (design R8).
    let after = await counts();
    assertRefusal(await a.post(s, { name }, { key }), 403, 'forbidden', 'the same key while narrowed');
    await assertDelta(after, { ...NOTHING, L: 0 }, 'the same key while narrowed');

    // Restored, the same key within its lease: in progress, never planned twice.
    await edit(a, o, 'sales_staff', 'create');
    after = await counts();
    assertRefusal(await b.post(s, { name }, { key }), 409, 'request_in_progress', 'the same key within its lease');
    await assertDelta(after, { ...NOTHING, L: 0 }, 'the same key within its lease');

    // The lease run out (the owner moves its expiry into the past, as time would): the key is reclaimed and decided afresh
    // on the level as it stands now — a first answer, not a replay of anything.
    await owner`update tmpos_internal.idempotency_record set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
      where scope = ${lease[0]}`;
    after = await counts();
    const reclaimed = await b.post(s, { name }, { key });
    createdOf(reclaimed, name, 'the key after its lease expired');
    assert.equal(b.records(reclaimed).filter((r) => r.event === 'idempotency_reclaimed').length, 1, 'the runtime reclaimed the lapsed lease');
    await assertDelta(after, { ...ONE, L: 0 }, 'the reclaimed key: one customer, on its existing record');
  }));
});

// ===========================================================================
// M7RLH-05: the create holds the role row first — two instances
// ===========================================================================

test('M7RLH-05: two entries on one database — a create parked holding the role row FOR SHARE makes the other instance\'s edit wait; the create commits first, then the edit, whose level stands and refuses the next create', async () => {
  const { tenant, boss } = await shop('m7rlh05');
  const sales = await actor('m7rlh05-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const s = await signIn(a, sales);
    const o = await signIn(b, boss);
    // A first create commits the lock row, so the parked create below takes an EXISTING row FOR SHARE.
    const first = nameOf('m7rlh05 first');
    createdOf(await a.post(s, { name: first }), first, 'the default role creates');

    const name = nameOf('park m7rlh05');
    const pre = await preOf(tenant, 'sales_staff');
    const before = await counts();
    let createReq;
    let editReq;
    let held;
    let editLocks;
    await withTrigger('tmpos_customer.customer', namedLike('park m7rlh05'), 'park', async () => {
      const lever = await holdPark();
      try {
        // The create (instance A) decides Create, takes the role row FOR SHARE, and parks at its customer INSERT.
        createReq = quietly(a.post(s, { name }));
        const createPid = waitingPid(await blockedOrSettled(createReq, { by: lever.pid }), 'the create parked at its INSERT');
        held = await roleTableLocks(createPid);
        // The edit (instance B) reaches 021's set routine and waits for the create's lock.
        editReq = quietly(b.put(o, levelBody('sales_staff', 'view', pre)));
        const editPid = waitingPid(await blockedOrSettled(editReq, { by: createPid, query: /tmpos_role_edit\.m7a_role_level_set_v2/ }),
          'the edit waiting on the create inside 021\'s set routine');
        editLocks = await waitingLocks(editPid);
      } finally {
        await lever.commit();
      }
      createdOf(await replyTo(createReq, 'the create'), name, 'the create commits first');
      editedOf(await replyTo(editReq, 'the edit'), 'sales_staff', 'view', 'the edit commits after it', { version: 1 });
    });
    assert.ok(held.includes('RowShareLock'), `the create held the role row FOR SHARE: ${JSON.stringify(held)}`);
    assert.ok(editLocks.length > 0 && editLocks.every((l) => l.locktype === 'transactionid' || l.locktype === 'tuple'),
      `the edit waited on the create's row lock: ${JSON.stringify(editLocks)}`);
    await assertDelta(before, { C: 1, A: 1, E: 1, K: 2, O: 0, L: 2 }, 'one create and one edit, both whole');
    assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'the final level is the edit\'s');

    const next = await counts();
    assertRefusal(await a.post(s, { name: nameOf('m7rlh05 after') }), 403, 'forbidden', 'the next create, on either instance');
    assertRefusal(await b.post(s, { name: nameOf('m7rlh05 after b') }), 403, 'forbidden', 'the next create, on the other instance');
    await assertDelta(next, { ...NOTHING, L: 0 }, 'refused after the edit');
  }));
});

// ===========================================================================
// M7RLH-06: the edit route itself
// ===========================================================================

test('M7RLH-06: non-owner editors, a store-scope owner and another tenant\'s owner cannot change the level; every malformed body is 400; a stale sign-in is 403 step_up_required; the admitted edit writes one tenant-scope audit record naming it and its reason, one completion and no outbox event; replay, conflict, admin audience, Host, Idempotency-Key, Origin, CSRF and size refusals', async () => {
  const { tenant, boss } = await shop('m7rlh06');
  const [{ store_id: store }] = await owner`insert into store (tenant_id, store_name, status)
    values (${tenant}, ${`m7rlh06-store-${SUFFIX}`}, 'active') returning store_id`;
  const refusedEditors = [
    ['a manager', await actor('m7rlh06-manager', [tenantGrant(tenant, 'manager')])],
    ['a sales_staff', await actor('m7rlh06-sales', [tenantGrant(tenant, 'sales_staff')])],
    ['a technician', await actor('m7rlh06-tech', [tenantGrant(tenant, 'technician')])],
    ['a store-scope store_owner', await actor('m7rlh06-store-owner', [{ scope: 'store', tenant, store, role: 'store_owner' }])],
  ];
  const elsewhere = await shop('m7rlh06-elsewhere');
  const admin = await actor('m7rlh06-admin', [{ scope: 'platform', role: 'system_owner' }]);
  const adminId = await adminSessionId(admin);
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);

    // Only the tenant's store owner edits: every other role in the tenant, and a store-scope owner, is the generic 403 at
    // the authorizer — before any key, so no record, no audit, no completion and no level.
    let before = await counts();
    const pre = await preOf(tenant, 'sales_staff');
    for (const [label, who] of refusedEditors) {
      assertRefusal(await ctx.put(await signIn(ctx, who), levelBody('sales_staff', 'view', pre)), 403, 'forbidden', label);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'non-owner editors');
    assert.equal(await levelOf(tenant, 'sales_staff'), undefined, 'no level was written for this tenant');
    // Another tenant's owner edits ITS tenant only: the tenant is the session's, never a parameter.
    await edit(ctx, await signIn(ctx, elsewhere.boss), 'sales_staff', 'none', 'another tenant\'s owner');
    assert.deepEqual([await levelOf(elsewhere.tenant, 'sales_staff'), await levelOf(tenant, 'sales_staff')], ['none', undefined],
      'the other tenant\'s edit stays in the other tenant');

    // Bodies the command's contract refuses, once the key is acquired: 400, the lease taken, nothing else written.
    const { expectedTenant: _t, expectedVersion: _v, ...fourFields } = levelBody('sales_staff', 'view', pre);
    const bodies = [
      ['the owner role itself', levelBody('store_owner', 'view', pre)],
      ['an unknown role', levelBody('cashier', 'view', pre)],
      ['a role in another letter case', levelBody('Sales_Staff', 'view', pre)],
      ['another domain', { ...levelBody('sales_staff', 'view', pre), domain: 'employees' }],
      ['an invalid level', levelBody('sales_staff', 'owner', pre)],
      ['a level in another letter case', levelBody('sales_staff', 'View', pre)],
      ['no reason', { roleId: 'sales_staff', domain: 'customers', level: 'view', expectedTenant: tenant, expectedVersion: 0 }],
      ['a nine-scalar reason', levelBody('sales_staff', 'view', pre, 'too short')],
      ['a reason short once trimmed', levelBody('sales_staff', 'view', pre, '   too short     ')],
      ['a non-string reason', levelBody('sales_staff', 'view', pre, 1234567890)],
      ['an extra tenantId', { ...levelBody('sales_staff', 'view', pre), tenantId: elsewhere.tenant }],
      ['an extra key', { ...levelBody('sales_staff', 'view', pre), note: 'x' }],
      ['an array', [levelBody('sales_staff', 'view', pre)]],
      ['JSON null', 'null'],
      // M7A-CUSTOMERS-P4: the precondition is required and well formed — the pre-P4 four-field body is refused.
      ['the four-field body (no precondition)', fourFields],
      ['no expected version', { ...fourFields, expectedTenant: tenant }],
      ['no expected tenant', { ...fourFields, expectedVersion: 0 }],
      ['an expected tenant in upper case', levelBody('sales_staff', 'view', { tenant: tenant.toUpperCase(), version: 0 })],
      ['an expected tenant that is not a UUID', levelBody('sales_staff', 'view', { tenant: 'this store', version: 0 })],
      ['a negative expected version', levelBody('sales_staff', 'view', { tenant, version: -1 })],
      ['a fractional expected version', levelBody('sales_staff', 'view', { tenant, version: 0.5 })],
      ['an expected version as text', levelBody('sales_staff', 'view', { tenant, version: '0' })],
    ];
    before = await counts();
    for (const [label, body] of bodies) {
      const reply = await ctx.put(o, body);
      assertRefusal(reply, 400, 'invalid_request', label);
      assert.equal(ctx.reason(reply), 'command_request_invalid', label);
    }
    await assertDelta(before, { ...NOTHING, L: bodies.length }, 'refused by the contract');
    assert.equal(await levelOf(tenant, 'sales_staff'), undefined, 'no level written by a refused body');

    // Step-up: the same owner, signed in long ago by the provider's clock, is refused before the body is read.
    const stale = await signIn(ctx, boss, { token: boss.staleToken });
    before = await counts();
    const stepUp = await ctx.put(stale, levelBody('sales_staff', 'view', pre));
    assertRefusal(stepUp, 403, 'step_up_required', 'a stale sign-in');
    assert.equal(ctx.reason(stepUp), 'recent_auth_required', 'a stale sign-in');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'a stale sign-in');

    // A recent sign-in edits: one record, one completion, one tenant-scope audit record naming the edit and the owner's
    // own words (trimmed), no subject tenant, no metadata, no outbox event.
    const key = randomUUID();
    const body = levelBody('sales_staff', 'view', pre, `  ${REASON} before the audit  `);
    before = await counts();
    const first = await ctx.put(o, body, { key });
    editedOf(first, 'sales_staff', 'view', 'the admitted edit', { version: 1 });
    await assertDelta(before, { ...EDIT, L: 1 }, 'the admitted edit');
    const audits = await owner`select scope_type, tenant_id, store_id, required_permission, decision, reason_code, human_readable_reason,
        subject_tenant_id, metadata from public.audit_event where action_id = ${EDIT_ACTION} and actor_internal_user_id = ${boss.id}`;
    assert.deepEqual(audits.map((r) => ({ ...r })), [{
      scope_type: 'tenant', tenant_id: tenant, store_id: null, required_permission: 'edit_role_levels', decision: 'allow',
      reason_code: 'role_sales_staff_customers_to_view', human_readable_reason: `${REASON} before the audit`,
      subject_tenant_id: null, metadata: {},
    }], 'one audit record of the trusted actor, at the session\'s tenant');
    assert.equal(await levelOf(tenant, 'sales_staff'), 'view');

    // The same key and body: the recorded 200, byte for byte, marked a replay; no second audit record.
    before = await counts();
    const again = await ctx.put(o, body, { key });
    editedOf(again, 'sales_staff', 'view', 'the replay', { replayed: true, version: 1 });
    assert.equal(again.body, first.body, 'the recorded body, byte for byte');
    // The same key, another body: the conflict policy, nothing written, the level as it was.
    assertRefusal(await ctx.put(o, levelBody('sales_staff', 'none', pre), { key }), 422, 'idempotency_key_reused', 'the same key, another body');
    // The same key asserting the version its own edit moved to: another request, so another key (422), never a second edit.
    assertRefusal(await ctx.put(o, levelBody('sales_staff', 'view', { tenant, version: 1 }, `  ${REASON} before the audit  `), { key }), 422,
      'idempotency_key_reused', 'the same key, a newer version asserted');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'replay and conflict');
    assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'the conflict changed nothing');

    // Refused before any key: the audience, the Host, the key itself, Origin, CSRF and the size cap.
    const edited = JSON.stringify(levelBody('sales_staff', 'none', await preOf(tenant, 'sales_staff')));
    const csrf = randomBytes(32).toString('base64url');
    before = await counts();
    for (const [label, request, status, error, reason] of [
      ['an administrative session under its own cookie', () => ctx.put({ cookie: `${SESSION_COOKIES.admin}=${adminId}`, csrf }, edited), 401, 'unauthenticated', 'session_missing'],
      ['an administrative session under the tenant cookie', () => ctx.put({ cookie: `${SESSION_COOKIES.tenant}=${adminId}`, csrf }, edited), 401, 'unauthenticated', 'session_wrong_audience'],
      ['no session', () => ctx.put(null, edited), 401, 'unauthenticated', null],
      ['the admin host', () => ctx.put(o, edited, { headers: { host: ADMIN_HOST } }), 404, 'not_found', null],
      ['an unknown host', () => ctx.put(o, edited, { headers: { host: 'unknown.tmpos.test' } }), 404, 'not_found', null],
      ['no key', () => ctx.put(o, edited, { key: null }), 400, 'invalid_request', 'idempotency_key_missing'],
      ['a malformed key', () => ctx.put(o, edited, { key: 'abc' }), 400, 'invalid_request', 'idempotency_key_invalid'],
      ['a foreign Origin', () => ctx.put(o, edited, { headers: { origin: 'https://evil.test' } }), 403, 'forbidden', 'csrf_origin_mismatch'],
      ['the admin Origin', () => ctx.put(o, edited, { headers: { origin: ADMIN_ORIGIN } }), 403, 'forbidden', 'csrf_origin_mismatch'],
      ['no Origin', () => ctx.put(o, edited, { drop: ['origin'] }), 403, 'forbidden', 'csrf_origin_missing'],
      ['no pre-session CSRF header', () => ctx.put(o, edited, { drop: [CSRF_HEADER] }), 403, 'forbidden', 'csrf_token_missing'],
      ['no session CSRF', () => ctx.put(o, edited, { drop: [SESSION_CSRF_HEADER] }), 403, 'forbidden', null],
      ['a wrong session CSRF', () => ctx.put(o, edited, { headers: { [SESSION_CSRF_HEADER]: csrf } }), 403, 'forbidden', null],
      ['a declared length over the cap', () => ctx.raw('PUT', ROLE_LEVELS_PATH, o, `Idempotency-Key: ${randomUUID()}\r\nContent-Length: 8193\r\n`), 413, 'content_too_large', 'body_declared_too_large'],
    ]) {
      const reply = await request();
      assertRefusal(reply, status, error, label);
      if (reason !== null) assert.equal(ctx.reason(reply), reason, label);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused before the key');
    assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'nothing refused changed the level');
  });
});

// ===========================================================================
// M7RLH-07: failure atomicity and the lost COMMIT answer, for a create and an edit
// ===========================================================================

test('M7RLH-07: an audit INSERT that raises rolls a create and an edit back whole (503, the lease kept, 409 within it); a COMMIT whose answer is lost is a 503, and the retry replays what committed — a create and an edit alike', async () => {
  const { tenant, boss } = await shop('m7rlh07');
  const sales = await actor('m7rlh07-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, sales);
    const o = await signIn(ctx, boss);

    // Each command's audit INSERT raises inside its transaction: nothing of it survives, and its lease is kept.
    for (const [label, when, request, retry] of [
      ['a create', CREATE_AUDIT, (key) => ctx.post(s, { name: nameOf('m7rlh07 fault create') }, { key }),
        (key) => ctx.post(s, { name: nameOf('m7rlh07 fault create') }, { key })],
      // The same body both times: nothing committed, so the version the draft asserts is still the one it read.
      ['an edit', EDIT_AUDIT, async (key) => ctx.put(o, levelBody('sales_staff', 'none', await preOf(tenant, 'sales_staff')), { key }),
        async (key) => ctx.put(o, levelBody('sales_staff', 'none', await preOf(tenant, 'sales_staff')), { key })],
    ]) {
      const key = randomUUID();
      const levelBefore = await levelOf(tenant, 'sales_staff');
      const before = await counts();
      const firedBefore = await fired();
      const reply = await withTrigger('public.audit_event', when, 'raise', () => request(key));
      assertRefusal(reply, 503, 'service_unavailable', `${label}: the audit INSERT raises`);
      assert.equal(await fired(), firedBefore + 1, `${label}: the fault ran, inside the command`);
      await assertDelta(before, { ...NOTHING, L: 1 }, `${label}: rolled back whole`);
      assert.equal(await levelOf(tenant, 'sales_staff'), levelBefore, `${label}: the level as it was`);
      assertRefusal(await retry(key), 409, 'request_in_progress', `${label}: the retry within the lease`);
    }

    // A create's COMMIT reaches the server and its answer is dropped: unknown, so a 503 — never a 201 before the commit is
    // known; the retry resolves through the retained completion.
    const createKey = randomUUID();
    const name = nameOf('m7rlh07 lost create');
    let before = await counts();
    let trap = loseCommitAnswer(ctx.relay);
    let reply;
    try {
      reply = await ctx.post(s, { name }, { key: createKey });
    } finally {
      trap.release();
    }
    assert.equal(trap.silenced.length, 1, 'the create: one COMMIT reached the server, and its answer was dropped');
    assertRefusal(reply, 503, 'service_unavailable', 'the create\'s lost answer');
    assert.equal(ctx.reason(reply), 'transaction_timeout', 'the create: unknown at the port deadline');
    let row;
    for (const until = Date.now() + 5_000; row === undefined && Date.now() < until; await delay(50)) {
      [row] = await owner`select customer_id from tmpos_customer.customer where name = ${name}`;
    }
    assert.ok(row !== undefined, 'what committed becomes visible');
    assert.equal(createdOf(await ctx.post(s, { name }, { key: createKey }), name, 'the create\'s retry', { replayed: true }).id, row.customer_id);
    await assertDelta(before, { ...ONE, L: 1 }, 'the create landed whole, once');

    // The same for an edit: the level lands with its audit record and completion, and the retry replays the 200.
    const editKey = randomUUID();
    const editBody = levelBody('sales_staff', 'view', await preOf(tenant, 'sales_staff'));
    before = await counts();
    trap = loseCommitAnswer(ctx.relay);
    try {
      reply = await ctx.put(o, editBody, { key: editKey });
    } finally {
      trap.release();
    }
    assert.equal(trap.silenced.length, 1, 'the edit: one COMMIT reached the server, and its answer was dropped');
    assertRefusal(reply, 503, 'service_unavailable', 'the edit\'s lost answer');
    assert.equal(ctx.reason(reply), 'transaction_timeout', 'the edit: unknown at the port deadline');
    let level;
    for (const until = Date.now() + 5_000; level !== 'view' && Date.now() < until; await delay(50)) level = await levelOf(tenant, 'sales_staff');
    assert.equal(level, 'view', 'what committed becomes visible');
    editedOf(await ctx.put(o, editBody, { key: editKey }), 'sales_staff', 'view', 'the edit\'s retry', { replayed: true, version: 1 });
    assert.equal(await versionOf(tenant, 'sales_staff'), 1, 'the version moved once');
    await assertDelta(before, { ...EDIT, L: 1 }, 'the edit landed whole, once');
  });
});

// ===========================================================================
// M7RLH-08: the runtime login directly — the residuals, witnessed
// ===========================================================================

test('M7RLH-08: the runtime login plus a live key, directly — a sales_staff key creates on 020\'s routine with NO audit, completion or outbox row and is refused once the owner narrows; an owner key changes a level on 021\'s set routine, given the tenant and version, with NO audit or completion; 020\'s set, 019\'s create and 018\'s page_v2 are 42501; neither the customer table nor the role table takes a direct write', async () => {
  // The residuals (design R10), recorded with their counts, not closed: the session key is the ONLY authority either
  // definer routine takes, and the runtime role (tmpos_app) can call both. The HTTP route adds the audit record, the
  // idempotency record and its completion, the step-up and the reason; a direct call bypasses every one of them. Since
  // M7A-CUSTOMERS-P4 the edit routine the runtime role reaches is 021's, conditional on the tenant and version (DA-119,
  // now preconditioned); 020's unconditional set is revoked from it.
  const { tenant, boss } = await shop('m7rlh08');
  const sales = await actor('m7rlh08-sales', [tenantGrant(tenant, 'sales_staff')]);
  const [{ membership_id: salesGrant }] = await owner`select membership_id from user_membership where internal_user_id = ${sales.id}`;
  const [{ membership_id: bossGrant }] = await owner`select membership_id from user_membership where internal_user_id = ${boss.id}`;
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, sales);
    const o = await signIn(ctx, boss);
    const runtime = runtimeClient();
    try {
      // (1) A live sales_staff key on the create the runtime role holds — 023's since M7A-CUSTOMERS-P6, deciding through
      //     020's: one customer in the key's tenant, and nothing else.
      const id = randomUUID();
      const name = nameOf('m7rlh08 direct');
      let before = await counts();
      const made = await runtime`select * from tmpos_customer_contact.m7a_contact_create(${s.key}::text, ${id}::uuid, ${name}::text, null::text, null::text)`;
      assert.deepEqual(made.map((r) => ({ ...r })), [{ o_tenant_id: tenant, o_actor_id: sales.id, o_membership_id: salesGrant }],
        'the key\'s own tenant, actor and grant');
      await assertDelta(before, { C: 1, A: 0, E: 0, K: 0, O: 0, L: 0 }, 'RESIDUAL: a direct create writes no audit, completion or outbox row');

      // (2) Once the owner narrows (through the audited route), the same direct call is refused: no row, nothing written.
      await edit(ctx, o, 'sales_staff', 'view');
      before = await counts();
      const none = await runtime`select * from tmpos_customer_contact.m7a_contact_create(${s.key}::text, ${randomUUID()}::uuid, ${name}::text, null::text, null::text)`;
      assert.equal(none.length, 0, 'the narrowed key: no row');
      await assertDelta(before, { ...NOTHING, L: 0 }, 'the narrowed key');

      // (3) A live OWNER key on 021's set routine, given the tenant and the current version, changes the level with no audit
      //     record, reason, step-up or completion; the version moves as for any edit.
      before = await counts();
      const version = await versionOf(tenant, 'sales_staff');
      const set = await runtime`select * from tmpos_role_edit.m7a_role_level_set_v2(${o.key}::text, 'sales_staff'::text, 'customers'::text,
        'create'::text, ${tenant}::uuid, ${String(version)}::bigint)`;
      assert.deepEqual(set.map((r) => ({ ...r })), [{
        o_outcome: 'applied', o_tenant_id: tenant, o_actor_id: boss.id, o_membership_id: bossGrant, o_level: 'create', o_version: String(version + 1),
      }], 'the owner key\'s own tenant, actor and grant, at the next version');
      assert.deepEqual([await levelOf(tenant, 'sales_staff'), await versionOf(tenant, 'sales_staff')], ['create', version + 1], 'the level changed');
      await assertDelta(before, { ...NOTHING, L: 0 }, 'RESIDUAL: a direct edit writes no audit record and no completion');
      // The same key asserting a stale version, or another tenant: a precondition row, nothing written.
      for (const [label, assertedTenant, assertedVersion, outcome] of [
        ['a stale version', tenant, version, 'version_conflict'], ['another tenant', randomUUID(), version + 1, 'tenant_mismatch'],
      ]) {
        const refused = await runtime`select * from tmpos_role_edit.m7a_role_level_set_v2(${o.key}::text, 'sales_staff'::text, 'customers'::text,
          'full'::text, ${assertedTenant}::uuid, ${String(assertedVersion)}::bigint)`;
        assert.deepEqual(refused.map((r) => r.o_outcome), [outcome], label);
        assert.deepEqual([await levelOf(tenant, 'sales_staff'), await versionOf(tenant, 'sales_staff')], ['create', version + 1], `${label}: unchanged`);
      }
      // A non-owner key on the same routine: no row, the level unchanged.
      const notOwner = await runtime`select * from tmpos_role_edit.m7a_role_level_set_v2(${s.key}::text, 'sales_staff'::text, 'customers'::text,
        'full'::text, ${tenant}::uuid, ${String(version + 1)}::bigint)`;
      assert.equal(notOwner.length, 0, 'a sales_staff key edits nothing');
      assert.equal(await levelOf(tenant, 'sales_staff'), 'create', 'the level unchanged');

      // (4) The routines that decided from the role NAME are out of the runtime role's reach, and so is every table.
      before = await counts();
      for (const [label, query] of [
        // M7A-CUSTOMERS-P4: 020's unconditional set is revoked from the runtime role by 021.
        ['020\'s set', runtime`select * from tmpos_role.m7a_role_level_set(${o.key}::text, 'sales_staff'::text, 'customers'::text, 'full'::text)`],
        ['019\'s create', runtime`select * from tmpos_customer_write.m7a_customer_create(${s.key}::text, ${randomUUID()}::uuid, ${name}::text)`],
        // M7A-CUSTOMERS-P6: 020's create is revoked from the runtime role by 023, whose create calls it.
        ['020\'s create', runtime`select * from tmpos_role.m7a_customer_create(${s.key}::text, ${randomUUID()}::uuid, ${name}::text)`],
        ['018\'s page_v2', runtime`select * from tmpos_mint.m7a_customer_page_v2(${s.key}::text, null::uuid, 10)`],
        ['INSERT on the customer table', runtime`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${randomUUID()}, ${tenant}, ${name})`],
        ['SELECT on the role table', runtime`select * from tmpos_role.tenant_role_level`],
        ['UPDATE on the role table', runtime`update tmpos_role.tenant_role_level set level = 'full' where tenant_id = ${tenant}`],
        ['INSERT on the role table', runtime`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
          values (${tenant}, 'technician', 'customers', 'full', pg_catalog.now())`],
        ['SELECT on the version table', runtime`select * from tmpos_role_edit.role_level_version`],
        ['UPDATE on the version table', runtime`update tmpos_role_edit.role_level_version set version = 1 where tenant_id = ${tenant}`],
      ]) assert.equal(await codeOf(query), '42501', label);
      assert.equal(await levelOf(tenant, 'sales_staff'), 'create', 'the level unchanged by 020\'s refused set');
      await assertDelta(before, { ...NOTHING, L: 0 }, 'nothing written by a refused call');
      assert.equal(await levelOf(tenant, 'technician'), undefined, 'no role row written directly');
    } finally {
      await runtime.end({ timeout: 5 });
    }
  });
});

// ===========================================================================
// M7RLH-09: the owner's recent sign-in goes stale while the edit waits for the role row — two instances
// ===========================================================================

/**
 * The schedule around a moment `at` (epoch ms): the create parks from at - park, the edit is sent at at - send, the lever is
 * released at at + release. Both lock waits (the create on the parking key, the edit on the create's row) then last about a
 * second at most — inside COMMAND_LOCK_BOUND_MS, so neither can end in a lock timeout.
 */
const LAPSE = Object.freeze({ park: 900, send: 600, release: 150 });

/**
 * M7RLH-05's shape on LAPSE's schedule: a sales_staff create (instance A, session `s`) parks at its customer INSERT holding
 * the role row FOR SHARE; the owner's edit to View (instance B, session `o`, Idempotency-Key `key`, asserting `pre`) is
 * observed waiting on the create INSIDE 021's set routine; at at + release the database clock is read and the lever released. Answers both replies,
 * the create's name, the locks observed and the moments (epoch ms) each step happened.
 */
async function editWaitsOnParkedCreate(a, b, s, o, label, at, key, pre) {
  const name = nameOf(`park ${label}`);
  const out = { name };
  await withTrigger('tmpos_customer.customer', namedLike(`park ${label}`), 'park', async () => {
    await delay(Math.max(0, at - LAPSE.park - Date.now()));
    const lever = await holdPark();
    let createReq;
    let editReq;
    try {
      createReq = quietly(a.post(s, { name }));
      const createPid = waitingPid(await blockedOrSettled(createReq, { by: lever.pid }), `${label}: the create parked at its INSERT`);
      out.held = await roleTableLocks(createPid);
      await delay(Math.max(0, at - LAPSE.send - Date.now()));
      out.sentAt = Date.now();
      editReq = quietly(b.put(o, levelBody('sales_staff', 'view', pre), { key }));
      editReq.then(() => { out.repliedAt = Date.now(); }, () => {});
      const editPid = waitingPid(await blockedOrSettled(editReq, { by: createPid, query: /tmpos_role_edit\.m7a_role_level_set_v2/ }),
        `${label}: the edit waiting on the create inside 021's set routine`);
      out.observedAt = Date.now();
      out.editLocks = await waitingLocks(editPid);
      await delay(Math.max(0, at + LAPSE.release - Date.now()));
      [{ past: out.dbPastAt }] = await probe`select pg_catalog.clock_timestamp() > pg_catalog.to_timestamp(${String(at)}::bigint / 1000.0) as past`;
      out.releasedAt = Date.now();
    } finally {
      await lever.commit();
    }
    out.created = await replyTo(createReq, `${label}: the create`);
    out.edited = await replyTo(editReq, `${label}: the edit`);
  });
  return out;
}

/** The moments of one race relative to `at`, for assertion messages. */
const timelineOf = (r, at) => `relative to ${at}: edit sent ${r.sentAt - at} ms, seen waiting in 020 ${r.observedAt - at} ms, `
  + `released ${r.releasedAt - at} ms, edit answered ${r.repliedAt - at} ms`;
/** The stored level for display: the catalog default when the lock row holds NULL, 'no row' when there is none. */
const shownLevel = (level) => (level === null ? 'default' : level === undefined ? 'no row' : level);

test('M7RLH-09: two entries on one database — the owner\'s recent sign-in goes stale WHILE its edit waits inside 021\'s set routine for a create holding the role row; the create commits (201) and the edit is refused after the routine answered (503): level still the default, no edit audit record, no completion, its lease kept (409 for the same key within it)', async () => {
  const { tenant, boss } = await shop('m7rlh09');
  const sales = await actor('m7rlh09-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const s = await signIn(a, sales);
    // A first create commits the lock row (NULL: the default), so the parked create takes an EXISTING row FOR SHARE.
    const first = nameOf('m7rlh09 first');
    createdOf(await a.post(s, { name: first }), first, 'the default role creates');
    assert.equal(await levelOf(tenant, 'sales_staff'), null, 'the lock row exists, at the default');

    // The owner signs in with a provider authentication time (whole seconds) whose recent-sign-in deadline — that time plus
    // RECENT_AUTH_MAX_AGE_MS — falls 3-4 s from now: recent at sign-in, at the authorizer and at the revalidator, stale by
    // the time the create below lets the edit's lock wait end.
    const authTimeSec = Math.ceil((Date.now() + 3_000 - RECENT_AUTH_MAX_AGE_MS) / 1000);
    const deadline = authTimeSec * 1000 + RECENT_AUTH_MAX_AGE_MS;
    const timed = `${boss.token}-at-${authTimeSec}`;
    TOKENS.set(timed, { uid: boss.uid, authTimeSec });
    const o = await signIn(b, boss, { token: timed });
    const [{ authenticated_at: bound }] = await owner`select authenticated_at from tmpos_session.session where session_key = ${o.key}`;
    assert.equal(Number(bound), authTimeSec * 1000, 'the session binds the provider\'s authentication time');

    const key = randomUUID();
    const pre = await preOf(tenant, 'sales_staff');
    const leasesBefore = await openLeases();
    const before = await counts();
    const r = await editWaitsOnParkedCreate(a, b, s, o, 'm7rlh09', deadline, key, pre);
    const timeline = timelineOf(r, deadline);
    // The schedule held: the edit was sent before the deadline and reached 020's routine (so the authorizer and the
    // revalidator both judged the sign-in recent); the deadline had passed on the DATABASE clock before the wait ended.
    assert.ok(r.sentAt < deadline, `the edit was sent while the sign-in was recent — ${timeline}`);
    assert.equal(r.dbPastAt, true, `the deadline had passed on the database clock before the lever was released — ${timeline}`);
    assert.ok(r.held.includes('RowShareLock'), `the create held the role row FOR SHARE: ${JSON.stringify(r.held)}`);
    assert.ok(r.editLocks.length > 0 && r.editLocks.every((l) => l.locktype === 'transactionid' || l.locktype === 'tuple'),
      `the edit waited on the create's row lock: ${JSON.stringify(r.editLocks)}`);

    const level = await levelOf(tenant, 'sales_staff');
    const [{ n: editAudits }] = await owner`select count(*)::int as n from public.audit_event
      where action_id = ${EDIT_ACTION} and actor_internal_user_id = ${boss.id}`;
    const delta = await deltaSince(before);
    const observed = { create: r.created.status, edit: r.edited.status, level: shownLevel(level), editAudits, delta };
    assert.deepEqual(observed,
      { create: 201, edit: 503, level: 'default', editAudits: 0, delta: { C: 1, A: 1, E: 0, K: 1, O: 0, L: 2 } },
      `observed ${JSON.stringify(observed)}; edit answered ${r.edited.body} (logged ${JSON.stringify(b.records(r.edited).map((x) => x.reason ?? x.event))}) — ${timeline}`);
    createdOf(r.created, r.name, 'the create commits');
    assertRefusal(r.edited, 503, 'service_unavailable', 'the edit, refused after 020 answered');
    // Every lock wait of the command transaction is bounded at COMMAND_LOCK_BOUND_MS: an answer sooner than that after the
    // edit was SENT cannot be a lock timeout, so the 503 is the refusal on the database clock after the routine answered.
    assert.ok(r.repliedAt - r.sentAt < COMMAND_LOCK_BOUND_MS, `the edit was answered before any lock bound could expire — ${timeline}`);
    const lease = [...(await openLeases())].filter((scope) => !leasesBefore.has(scope));
    assert.equal(lease.length, 1, `the refused edit left exactly its lease: ${JSON.stringify(lease)}`);

    // The same key from the stale session: the step-up check refuses before the key is touched.
    let after = await counts();
    const stale = await b.put(o, levelBody('sales_staff', 'view', pre), { key });
    assertRefusal(stale, 403, 'step_up_required', `the same key from the stale session (${stale.status})`);
    await assertDelta(after, { ...NOTHING, L: 0 }, 'the same key from the stale session');
    // The same key and body from a recent sign-in of the same owner, within the lease: in progress, never planned twice.
    const fresh = await signIn(b, boss);
    after = await counts();
    const retry = await b.put(fresh, levelBody('sales_staff', 'view', pre), { key });
    assertRefusal(retry, 409, 'request_in_progress', `the same key within its lease (${retry.status})`);
    await assertDelta(after, { ...NOTHING, L: 0 }, 'the same key within its lease');
    assert.equal(shownLevel(await levelOf(tenant, 'sales_staff')), 'default', 'the level is still the default');
    assert.equal(await versionOf(tenant, 'sales_staff'), 0, 'and its version never moved');
  }));
});

test('M7RLH-09b: the control — the same race with the owner\'s recent sign-in far from its deadline: the create commits (201), then the edit (200), whose level stands', async () => {
  const { tenant, boss } = await shop('m7rlh09b');
  const sales = await actor('m7rlh09b-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({ kernelModule: SMALL_KERNEL }, (a) => withEntry({ kernelModule: SMALL_KERNEL }, async (b) => {
    const s = await signIn(a, sales);
    const first = nameOf('m7rlh09b first');
    createdOf(await a.post(s, { name: first }), first, 'the default role creates');
    const o = await signIn(b, boss); // authenticated now: the deadline is RECENT_AUTH_MAX_AGE_MS away
    const at = Date.now() + 1_500;
    const before = await counts();
    const r = await editWaitsOnParkedCreate(a, b, s, o, 'm7rlh09b', at, randomUUID(), await preOf(tenant, 'sales_staff'));
    const delta = await deltaSince(before);
    const observed = { create: r.created.status, edit: r.edited.status, level: shownLevel(await levelOf(tenant, 'sales_staff')), delta };
    assert.deepEqual(observed, { create: 201, edit: 200, level: 'view', delta: { C: 1, A: 1, E: 1, K: 2, O: 0, L: 2 } },
      `observed ${JSON.stringify(observed)}; edit answered ${r.edited.body} — ${timelineOf(r, at)}`);
    createdOf(r.created, r.name, 'the create commits first');
    editedOf(r.edited, 'sales_staff', 'view', 'the edit commits after it', { version: 1 });
  }));
});

// ===========================================================================
// M7RL-G01..G04 (M7A-CUSTOMERS-P3-R2): the owner's read-back, GET /api/v1/roles/levels
// ===========================================================================

test('M7RL-G01: the owner reads the built-in Customers levels back — every catalog default for a fresh tenant, 020\'s NULL lock row still the default, each edit as stored, in a second session and under a stale sign-in too; no-store, no session material, and the read writes nothing', async () => {
  const { tenant, boss } = await shop('m7rlg01');
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    const fresh = await ctx.levels(o);
    readBackOf(fresh, tenant, {}, 'a fresh tenant: every role at its catalog default');
    for (const [label, secret] of [['the cookie identifier', o.cookie.slice(o.cookie.indexOf('=') + 1)], ['the session CSRF token', o.csrf], ['the store key', o.key]]) {
      assert.ok(!fresh.body.includes(secret), `the answer carries no ${label}`);
    }
    // A lock row (a create or an edit takes one before it locks) holds no level: it decides, and reads, as the default.
    await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${tenant}, 'manager', 'customers', null, now())`;
    assert.equal(await levelOf(tenant, 'manager'), null, 'the lock row is there (control)');
    readBackOf(await ctx.levels(o), tenant, {}, 'a NULL lock row reads as the default');
    // Edits read back as stored — a narrowing, a widening, and a level equal to the default, which is still an override.
    await edit(ctx, o, 'sales_staff', 'view');
    await edit(ctx, o, 'technician', 'create');
    await edit(ctx, o, 'manager', 'full');
    const edited = { sales_staff: 'view', technician: 'create', manager: 'full' };
    // M7A-CUSTOMERS-P4: each role edited once is at version 1; the owner's record carries none.
    const versions = { sales_staff: 1, technician: 1, manager: 1 };
    readBackOf(await ctx.levels(o), tenant, edited, 'after the edits', versions);
    readBackOf(await ctx.levels(await signIn(ctx, boss)), tenant, edited, 'a second session of the owner', versions);
    // Reading is not the sensitive change: a sign-in the edit would refuse as stale still reads.
    readBackOf(await ctx.levels(await signIn(ctx, boss, { token: boss.staleToken })), tenant, edited, 'a stale sign-in reads', versions);
    const before = await counts();
    readBackOf(await ctx.levels(o), tenant, edited, 'once more', versions);
    await assertDelta(before, { ...NOTHING, L: 0 }, 'a read writes no customer, audit record, key or event');
  });
});

test('M7RL-G02: only the tenant\'s store owner reads the levels back — a manager, a technician, a sales_staff and a store-scope owner are 403; no session and an administrative session 401; the admin or an unknown Host 404; any query 400; nothing is written', async () => {
  const { tenant, boss } = await shop('m7rlg02');
  const [{ store_id: store }] = await owner`insert into store (tenant_id, store_name, status)
    values (${tenant}, ${`m7rlg02-store-${SUFFIX}`}, 'active') returning store_id`;
  const refusedReaders = [
    ['a manager', await actor('m7rlg02-manager', [tenantGrant(tenant, 'manager')])],
    ['a technician', await actor('m7rlg02-tech', [tenantGrant(tenant, 'technician')])],
    ['a sales_staff', await actor('m7rlg02-sales', [tenantGrant(tenant, 'sales_staff')])],
    ['a store-scope store_owner', await actor('m7rlg02-store-owner', [{ scope: 'store', tenant, store, role: 'store_owner' }])],
  ];
  const admin = await actor('m7rlg02-admin', [{ scope: 'platform', role: 'system_owner' }]);
  const adminId = await adminSessionId(admin);
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    readBackOf(await ctx.levels(o), tenant, {}, 'the owner (control)');
    const before = await counts();
    for (const [label, who] of refusedReaders) assertRefusal(await ctx.levels(await signIn(ctx, who)), 403, 'forbidden', label);
    for (const [label, request, status, error, reason] of [
      ['no session', () => ctx.levels(null), 401, 'unauthenticated', null],
      ['an administrative session under its own cookie', () => ctx.levels({ cookie: `${SESSION_COOKIES.admin}=${adminId}` }), 401, 'unauthenticated', 'session_missing'],
      ['an administrative session under the tenant cookie', () => ctx.levels({ cookie: `${SESSION_COOKIES.tenant}=${adminId}` }), 401, 'unauthenticated', 'session_wrong_audience'],
      ['the admin host', () => ctx.levels(o, { headers: { host: ADMIN_HOST } }), 404, 'not_found', null],
      ['an unknown host', () => ctx.levels(o, { headers: { host: 'unknown.tmpos.test' } }), 404, 'not_found', null],
      ['a tenant in the query', () => ctx.levels(o, { query: `?tenantId=${tenant}` }), 400, 'invalid_request', 'role_level_directory_query_invalid'],
      ['an empty query', () => ctx.levels(o, { query: '?' }), 400, 'invalid_request', 'role_level_directory_query_invalid'],
    ]) {
      const reply = await request();
      assertRefusal(reply, status, error, label);
      if (reason !== null) assert.equal(ctx.reason(reply), reason, label);
    }
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused reads');
  });
});

test('M7RL-G03: each owner reads its own tenant alone — tenant A\'s edit never appears in tenant B\'s answer, neither answer names the other tenant, and a header naming the other tenant is no authority', async () => {
  const a = await shop('m7rlg03-a');
  const b = await shop('m7rlg03-b');
  await withEntry({}, async (ctx) => {
    const oa = await signIn(ctx, a.boss);
    const ob = await signIn(ctx, b.boss);
    await edit(ctx, oa, 'sales_staff', 'none');
    await edit(ctx, ob, 'technician', 'edit');
    const ra = await ctx.levels(oa);
    const rb = await ctx.levels(ob);
    readBackOf(ra, a.tenant, { sales_staff: 'none' }, 'tenant A', { sales_staff: 1 });
    readBackOf(rb, b.tenant, { technician: 'edit' }, 'tenant B', { technician: 1 });
    assert.ok(!ra.body.includes(b.tenant) && !rb.body.includes(a.tenant), 'neither answer names the other tenant');
    readBackOf(await ctx.levels(oa, { headers: { 'x-tenant-id': b.tenant } }), a.tenant, { sales_staff: 'none' }, 'a header is no authority', { sales_staff: 1 });
  });
});

test('M7RL-G04: a live owner session demoted (or its grant suspended) after login is refused on its next read — 401, never the old answer — and re-login as a manager is 403; every 401/403 is no-store; a stored `manage` round-trips through the read-back', async () => {
  const { tenant, boss } = await shop('m7rlg04');
  const suspended = await actor('m7rlg04-suspended', [tenantGrant(tenant, 'store_owner')]);
  const noStore = (reply, label) => assert.equal(reply.headers['cache-control'], 'no-store', `${label}: never cached`);
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    // A level the edit accepts but the shop's grid never offers: stored, and read back as stored.
    await edit(ctx, o, 'manager', 'manage');
    assert.equal(await levelOf(tenant, 'manager'), 'manage', 'stored as manage (control)');
    readBackOf(await ctx.levels(o), tenant, { manager: 'manage' }, 'a stored manage round-trips', { manager: 1 });
    const before = await counts();
    for (const [label, who, session, change] of [
      ['the owner demoted to manager', boss, o, () => owner`update user_membership set role_id = 'manager' where internal_user_id = ${boss.id}`],
      ['the owner grant suspended', suspended, await signIn(ctx, suspended), () => owner`update user_membership set status = 'suspended' where internal_user_id = ${suspended.id}`],
    ]) {
      readBackOf(await ctx.levels(session), tenant, { manager: 'manage' }, `${label}: the live owner session reads (control)`, { manager: 1 });
      await change();
      const after = await ctx.levels(session);
      // The chain ends a session whose standing changed after login (401), as M7CC-03 proves for the create.
      assertRefusal(after, 401, 'unauthenticated', label);
      assert.ok(!after.body.includes('manage') && !after.body.includes(tenant), `${label}: nothing of the old answer`);
      noStore(after, label);
      if (who === boss) {
        const again = await ctx.levels(await signIn(ctx, boss));
        assertRefusal(again, 403, 'forbidden', `${label}: re-login as a manager`);
        noStore(again, `${label}: re-login as a manager`);
      }
    }
    const anonymous = await ctx.levels(null);
    assertRefusal(anonymous, 401, 'unauthenticated', 'no session');
    noStore(anonymous, 'no session');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'refused reads write nothing');
    assert.equal(await levelOf(tenant, 'manager'), 'manage', 'the stored level is untouched by the refusals');
  });
});

// ===========================================================================
// M7RLH-10 (M7A-CUSTOMERS-P4): the precondition through the route
// ===========================================================================

test('M7RLH-10: a stale version or another tenant\'s id is an UNSEALED 409 write_conflict — nothing written, the lease kept, the same key decided afresh once it lapses; a committed key replays after a later edit; default -> None -> Create moves the version twice, so the first read\'s draft stays refused', async () => {
  const { tenant, boss } = await shop('m7rlh10');
  const elsewhere = await shop('m7rlh10-elsewhere');
  const sales = await actor('m7rlh10-sales', [tenantGrant(tenant, 'sales_staff')]);
  await withEntry({}, async (ctx) => {
    const o = await signIn(ctx, boss);
    const s = await signIn(ctx, sales);
    /** A precondition refusal: the chain's own 409, logged as the store's answer, never a recorded body or a replay. */
    const conflictOf = (reply, label) => {
      assertRefusal(reply, 409, 'write_conflict', label);
      assert.equal(ctx.reason(reply), 'transaction_precondition_failed', label);
      assert.equal(reply.headers['idempotent-replayed'], undefined, `${label}: a decision, not a replay`);
    };
    const [{ n: elsewhereEditsBefore }] = await owner`select count(*)::int as n from public.audit_event where action_id = ${EDIT_ACTION} and tenant_id = ${elsewhere.tenant}`;

    // (a) The first read's draft (version 0), sent after another edit moved the role to version 1: refused, nothing written.
    const firstRead = JSON.parse((await ctx.levels(o)).body);
    const stalePre = { tenant: firstRead.tenant, version: firstRead.roles.find((r) => r.roleId === 'sales_staff').version };
    assert.deepEqual(stalePre, { tenant, version: 0 }, 'a never-edited role reads version 0');
    const keyA = randomUUID();
    const bodyA = levelBody('sales_staff', 'none', stalePre);
    const committed = await ctx.put(o, bodyA, { key: keyA });
    editedOf(committed, 'sales_staff', 'none', 'the first edit commits at version 1', { version: 1 });
    const staleBody = levelBody('sales_staff', 'create', stalePre);
    const staleKey = randomUUID();
    const leasesBefore = await openLeases();
    let before = await counts();
    conflictOf(await ctx.put(o, staleBody, { key: staleKey }), 'the older draft');
    await assertDelta(before, { ...NOTHING, L: 1 }, 'the older draft: no level, audit record or completion — only its lease');
    assert.deepEqual([await levelOf(tenant, 'sales_staff'), await versionOf(tenant, 'sales_staff')], ['none', 1], 'None stands at version 1');
    assertRefusal(await ctx.post(s, { name: nameOf('m7rlh10 after the stale draft') }), 403, 'forbidden', 'Create was not restored');
    const lease = [...(await openLeases())].filter((scope) => !leasesBefore.has(scope));
    assert.equal(lease.length, 1, 'the refused draft left exactly its lease: unsealed, so the key is not terminal');
    // The same key and body within the lease: in progress, never planned twice.
    before = await counts();
    assertRefusal(await ctx.put(o, staleBody, { key: staleKey }), 409, 'request_in_progress', 'the same key within its lease');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'the same key within its lease');
    // The lease lapsed (moved into the past, as time would): the key is reclaimed and decided afresh — still stale, still 409.
    await owner`update tmpos_internal.idempotency_record set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
      where scope = ${lease[0]}`;
    before = await counts();
    const reclaimed = await ctx.put(o, staleBody, { key: staleKey });
    conflictOf(reclaimed, 'the same key once its lease lapsed');
    assert.equal(ctx.records(reclaimed).filter((r) => r.event === 'idempotency_reclaimed').length, 1, 'the runtime reclaimed the lapsed lease');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'decided afresh on its existing record: nothing written');

    // (b) A draft asserting ANOTHER tenant (well formed: the other store's id) at the current version: refused, and neither
    //     tenant changes — the session's own tenant is never swapped for the asserted one, nor the asserted one written.
    const foreign = levelBody('sales_staff', 'create', { tenant: elsewhere.tenant, version: 1 });
    before = await counts();
    conflictOf(await ctx.put(o, foreign), 'another tenant asserted');
    await assertDelta(before, { ...NOTHING, L: 1 }, 'another tenant asserted: its lease only');
    assert.deepEqual([await levelOf(tenant, 'sales_staff'), await versionOf(tenant, 'sales_staff')], ['none', 1], 'this tenant unchanged');
    assert.deepEqual([await levelOf(elsewhere.tenant, 'sales_staff'), await versionOf(elsewhere.tenant, 'sales_staff')], [undefined, 0], 'the other tenant unchanged');
    const [{ n: elsewhereEdits }] = await owner`select count(*)::int as n from public.audit_event where action_id = ${EDIT_ACTION} and tenant_id = ${elsewhere.tenant}`;
    assert.equal(elsewhereEdits, elsewhereEditsBefore, 'no edit audit record in the other tenant');

    // (c) Restoring the catalog default is an edit like any other: None (1) -> Create (2). The version-1 draft of View, made
    //     before the restore, is refused, and Create — the level the owner restored — stands.
    const beforeRestore = await preOf(tenant, 'sales_staff');
    await edit(ctx, o, 'sales_staff', 'create', 'the owner restores the default');
    assert.deepEqual([await levelOf(tenant, 'sales_staff'), await versionOf(tenant, 'sales_staff')], ['create', 2], 'the default word stored, at version 2');
    before = await counts();
    conflictOf(await ctx.put(o, levelBody('sales_staff', 'view', beforeRestore)), 'the draft from before the restore');
    conflictOf(await ctx.put(o, levelBody('sales_staff', 'view', stalePre)), 'the first read\'s draft, once more');
    await assertDelta(before, { ...NOTHING, L: 2 }, 'the old drafts: their leases only');
    readBackOf(await ctx.levels(o), tenant, { sales_staff: 'create' }, 'Create stands, stored, at version 2', { sales_staff: 2 });
    // The first edit's key, once a later edit superseded it: it replays its own sealed 200 — None at version 1, byte for
    // byte, writing nothing — while the directory shows Create at version 2.
    before = await counts();
    const replay = await ctx.put(o, bodyA, { key: keyA });
    editedOf(replay, 'sales_staff', 'none', 'the committed key replays after the version-2 edit', { replayed: true, version: 1 });
    assert.equal(replay.body, committed.body, 'byte for byte');
    await assertDelta(before, { ...NOTHING, L: 0 }, 'a replay writes nothing');
    readBackOf(await ctx.levels(o), tenant, { sales_staff: 'create' }, 'the directory after the replay: Create at version 2', { sales_staff: 2 });
    createdOf(await ctx.post(s, { name: nameOf('m7rlh10 restored') }), nameOf('m7rlh10 restored'), 'sales_staff creates again');
  });
});

// ===========================================================================
// M7RLH-C1: the COMPILED tenant entry
// ===========================================================================

test('M7RLH-C1: the compiled tenant entry serves exactly its twenty routes — the owner\'s PUT, its read-back and the Invoices read-back among them — applies an owner\'s edit, reads it back, reads the Invoices defaults back, and refuses the narrowed role\'s POST; the administrative inventory is still its eight routes', async () => {
  assert.deepEqual(canonical(TENANT_SHIPPING_ROUTES), [...TENANT_TWENTY], 'the source tenant inventory');
  // The administrative artifact is compiled from productionEntry.ts's SHIPPING_ROUTES: unchanged by this correction.
  assert.deepEqual(canonical(SHIPPING_ROUTES), [
    'GET /admin/v1/session session none none',
    'GET /admin/v1/tenants session none none',
    'GET /health public none none',
    'GET /readiness public none none',
    'PATCH /admin/v1/tenants/display-name session json required',
    'PATCH /admin/v1/tenants/status session json required',
    'POST /admin/v1/session/login login none none',
    'POST /admin/v1/session/logout session none none',
  ]);
  // Built as tests/db/tenantEntry.integration.test.mjs M7TE-C1 builds it: into node_modules/.cache (gitignored), so the
  // emitted ESM resolves its packages from the repository's node_modules; the compiled ENTRY module is started, over the
  // compiled kernel and client options.
  mkdirSync(join(REPO, 'node_modules', '.cache'), { recursive: true });
  const out = mkdtempSync(join(REPO, 'node_modules', '.cache', 'tmpos-m7rlh-tenant-build-'));
  try {
    const build = spawnSync(join(REPO, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.server.tenant.json', '--outDir', out],
      { cwd: REPO, env: childEnv(undefined), encoding: 'utf8', timeout: 180_000 });
    assert.equal(build.status, 0, `the tenant build succeeds:\n${(build.stdout || '') + (build.stderr || '')}`);
    const compiled = (m) => import(pathToFileURL(join(out, m)).href);
    const entry = await compiled('server/entry/tenantEntry.js');
    const kernel = await compiled('server/persistence/supervisedPgClient.js');
    const { runtimeClientOptions: compiledClientOptions } = await compiled('server/platform-identity/db.js');
    assert.notEqual(entry.startTenantEntry, startTenantEntry, 'the compiled module, not the source');
    assert.deepEqual(canonical(entry.TENANT_SHIPPING_ROUTES), [...TENANT_TWENTY], 'the compiled inventory');

    const { tenant, boss } = await shop('m7rlh-c1');
    const sales = await actor('m7rlh-c1-sales', [tenantGrant(tenant, 'sales_staff')]);
    const kernelModule = { createSupervisedPgClient: kernel.createSupervisedPgClient, MAX_POOLS: kernel.MAX_POOLS, runtimeClientOptions: compiledClientOptions };
    await withEntry({ start: entry.startTenantEntry, kernelModule }, async (ctx) => {
      assert.deepEqual(canonical(ctx.result.routes), [...TENANT_TWENTY], 'the compiled entry serves exactly the twenty');
      const s = await signIn(ctx, sales);
      const o = await signIn(ctx, boss);
      const name = nameOf('m7rlh-c1 default');
      createdOf(await ctx.post(s, { name }), name, 'compiled: the default role creates');
      let before = await counts();
      await edit(ctx, o, 'sales_staff', 'view', 'compiled: the owner\'s edit');
      await assertDelta(before, { ...EDIT, L: 1 }, 'compiled: the edit');
      readBackOf(await ctx.levels(o), tenant, { sales_staff: 'view' }, 'compiled: the owner reads the edit back', { sales_staff: 1 });
      // M5-INVOICES-AUTH-P1: the compiled artifact serves the Invoices read-back too — the catalog defaults, untouched by the
      // Customers edit (tests/db/invoiceRoleLevels.integration.test.mjs proves the Invoices edit over HTTP).
      const invoices = await send(ctx.port, 'GET', `${ROLE_LEVELS_PATH}/invoices`, { host: TENANT_HOST, cookie: o.cookie }, undefined, { localAddress: ctx.clientAddress });
      assert.equal(invoices.status, 200, `compiled: the Invoices read-back: ${invoices.body}`);
      assert.deepEqual(JSON.parse(invoices.body), {
        tenant, domain: 'invoices', roles: [
          { roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null },
          { roleId: 'manager', level: 'full', defaultLevel: 'full', source: 'default', editable: true, version: 0 },
          { roleId: 'technician', level: 'view', defaultLevel: 'view', source: 'default', editable: true, version: 0 },
          { roleId: 'sales_staff', level: 'create', defaultLevel: 'create', source: 'default', editable: true, version: 0 },
        ],
      }, 'compiled: the Invoices defaults, apart from the Customers edit');
      assert.equal(invoices.headers['cache-control'], 'no-store', 'compiled: the Invoices read-back is never cached');
      before = await counts();
      assertRefusal(await ctx.post(s, { name: nameOf('m7rlh-c1 narrowed') }), 403, 'forbidden', 'compiled: the narrowed role');
      await assertDelta(before, { ...NOTHING, L: 0 }, 'compiled: the narrowed role');
      ctx.cap.proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; ctx.cap.codes.length === 0 && Date.now() < until;) await delay(10);
      assert.deepEqual(ctx.cap.codes, [0], 'the compiled entry stops cleanly, exit 0');
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
