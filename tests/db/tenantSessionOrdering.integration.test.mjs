// Phase 4.0 M5-TENANT-SESSION-P1 — TENANT SESSION ORDERING UNDER CONCURRENCY: the stage's ordering rule (ADR-31) asserted
// against TWO separately composed production runtimes, REAL loopback sockets and one disposable PostgreSQL.
//
// THE RULE UNDER TEST (design §1). Every tenant-plane standing change — an account status or column, an identity anchor, a
// grant inserted, changed, removed, restored or re-pointed, a tenant or store status — takes effect when its transaction
// COMMITS, and a tenant login or recent sign-in takes effect when its ONE establish transaction commits:
//   * the login holds the actor's standing rows first and re-reads admission under them: a change committed after the
//     login's own admission read refuses it (401 login_standing_changed, nothing ended, created or recorded), and a change
//     not yet committed waits for the login's COMMIT — the next protected request then refuses the session it issued;
//   * a recent sign-in whose presented session this transaction did not end creates nothing (401 login_reauth_no_session),
//     and a logout presenting a cookie a recent sign-in already rotated ends nothing (204 logout_session_absent);
//   * a standing that goes away and comes back never revives an idle session (DA-41): grants and stores carry versions too;
//   * a login, a recent sign-in and a logout each write exactly one tenant.session.* record, and a refusal writes none;
//   * an outage is a bounded 503 that revokes nothing; a lost COMMIT answer is a 503 whose outcome the records describe.
//
// WHAT IS COMPOSED HERE IS PRODUCTION'S. Each instance is composeProductionTransactions(env, client) — the production root
// and the factories it ships, so the session store's establish check and the tenant admission read are exactly what an
// entry would serve — over its OWN supervised kernel of four one-connection pools; the session root is assembleSessions
// over durableSessionAdapters with BOTH audiences; createApp serves the result through createBoundedServer on 127.0.0.1.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY. Six things, none of them inside a transaction under test:
//   * THE DATABASE CLIENT: a supervised kernel over the disposable cluster as a non-owner runtime LOGIN holding tmpos_app and
//     tmpos_audit_writer only (in M5T-J5, through a byte relay that can drop one COMMIT answer).
//   * THE SESSION STORE'S ISSUER KEY (M7A-CUSTOMERS-P2, migration 018): every tenant session is minted under the tenant
//     issuer key, which no production root composes until the tenant entry does. So each instance's store is the
//     production store rebuilt over the root's own kernel, with the root's standing check, plus a synthetic key the owner
//     installed here; nothing else about it differs.
//   * THE IDENTITY VERIFIER: a bearer token maps to a synthetic provider reference, authenticated now with a TOTP factor.
//   * THE RATE LIMITER: the testkit's in-memory limiter, fresh for every instance.
//   * THE ROUTES: no tenant business route ships (D1/GAP-11), so the protected tenant requests are the harness-only witness
//     routes (tenantAdmissionWitness.harness.mjs), served beside the production inventory; M5T-L1 asserts they stay out of it.
//   * PASS-THROUGH GATES on the session root's side only: the store's get and update and the tenant admission read as the
//     root receives them, each holding ONE armed call (by session key or provider reference) until the scenario releases it.
//     Establish's own hold and re-read run over the root's client inside its transaction and are never wrapped.
//
// SCHEDULING IS CONDITION-BASED. A competing write happens only once pg_stat_activity shows the runtime backend waiting on
// a Lock held by the named backend (pg_blocking_pids), or once a gate reports its call arrived; every wait is bounded and a
// timeout fails with "lever did not engage", never a pass. Nothing sleeps for synchronization. A login parked on its
// presented session is under the store's 2100 ms lock_timeout, so each such scenario releases its hold at once.
//
// COMMIT ORDER. The cluster this file creates is restarted with track_commit_timestamp on, and order is then also asserted
// from pg_xact_commit_timestamp; on a bound service (CI's) it is asserted through the lock wait alone.
//
// THE SAME FILE RUNS ON THE BASE. Nothing here imports what migration 016 or the P1 adapters add: the admission routine to
// fault and the standing hold are detected in the catalog, the ledger is compared to the files on disk, and a login parked
// on its presented row is found at its touch (establish) or its revoke (the base's two-call rotation).
//
// DISPOSABLE ONLY. The target is TM_POS_TEST_DATABASE_URL when CI binds one, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. Fixtures are synthetic and randomly named;
// every actor, tenant and store a test changes is its own, and every privilege or trigger a test changes is undone before
// it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

import { installTestIssuerKey, startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import { STORE_WITNESS_PATH, WITNESS_PATH, WITNESS_READS, WITNESS_ROUTES } from './tenantAdmissionWitness.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresSessionStore } from '../../server/persistence/postgresSessionStore.ts';
import { holdTenantStanding, readTenantAdmission } from '../../server/persistence/postgresTenantAdmission.ts';
import { readPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';
import { lockPlatformAuthority } from '../../server/persistence/postgresPrincipalResolver.ts';
import { createTenantEstablishCheck } from '../../server/composition/tenantAuthorization.ts';
import { createPlatformEstablishCheck } from '../../server/composition/platformAuthorization.ts';
import {
  composeProductionTransactions, productionRouteDeclarations, uncataloguedRoutePermissions,
} from '../../server/composition/productionTransactions.ts';
import { assembleSessions, durableSessionAdapters } from '../../server/composition/productionSessions.ts';
import { SHIPPING_ROUTES } from '../../server/entry/productionEntry.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { testRequestLimits } from '../../server/runtime/rateLimiter.testkit.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { REAUTHENTICATE_HEADER, REAUTHENTICATE_VALUE, SESSION_COOKIES, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { TENANT_DISPLAY_NAME_EVENTS } from '../../server/runtime/tenantDisplayName.ts';
import { TENANT_STATUS_EVENTS } from '../../server/runtime/tenantStatus.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5ts-migrator', runtimeRef: 'm5ts-runtime' };
const LOCK_KEY = 528_519;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m5ts_probe';
const TENANT_ORIGIN = 'http://pos.trusted.test';
const ADMIN_ORIGIN = 'http://admin.trusted.test';
/** Four one-connection pools per instance: two instances, the owner, the observer and the runtime writer stay inside 20. */
const KERNEL_MAX = 4;
/** The bound on every lever and every awaited outcome. */
const WAIT_MS = 10_000;
const SESSION_GET = 'tmpos_session.m5_session_get(text, bigint)';
const ADMIT_V1 = 'tmpos_session.m5_admit_tenant_session(text, text)';
const ADMIT_V2 = 'tmpos_session.m5_admit_tenant_session_v2(text, text)';
const HOLD_STANDING = 'tmpos_session.m5_hold_tenant_standing(text, text)';
/** Where a login or logout parks on a held session row: establish and end touch it; the base's rotation deletes it. */
const AT_SESSION_ROW = /m5_session_(touch|revoke)/;
const SESSION_ACTIONS = 'tenant.session.';
const AUDIT_FAULT_SCHEMA = `m5ts_fault_${SUFFIX}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEARED_COOKIE = `${SESSION_COOKIES.tenant}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;

// The configuration the transaction root reads. Synthetic: the URL only has to classify as a direct endpoint on 5432, and
// the client constructor below never connects to it. The keys are 32 bytes of 0x09 and 0x07 — never a deployment's.
const CONFIGURED_ENV = Object.freeze({
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  IDEMPOTENCY_KEY: Buffer.alloc(32, 9).toString('base64url'),
  RATE_LIMIT_KEY: Buffer.alloc(32, 7).toString('base64url'),
});

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const ambient = process.env.TM_POS_TEST_DATABASE_URL;
let cluster = null;
let TARGET_DSN = null;
let CLIENT_OPTS = {};

if (typeof ambient === 'string' && ambient.trim() !== '') {
  TARGET_DSN = ambient.trim();
  const target = new URL(TARGET_DSN);
  const socketDir = target.hostname === '' ? target.searchParams.get('host') : null;
  if (socketDir !== null) {
    const user = target.searchParams.get('user');
    CLIENT_OPTS = { host: socketDir, ...(user !== null ? { user } : {}) };
  }
} else if (localPostgresAvailable()) {
  cluster = startDisposablePostgres();
  TARGET_DSN = cluster.dsn;
  CLIENT_OPTS = cluster.clientOptions;
  // Commit timestamps make commit ORDER observable. Only a cluster this file created is reconfigured, and it is restarted
  // before any client connects; the harness still stops and removes it.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('PG') || k.endsWith('DATABASE_URL')) delete env[k];
  appendFileSync(join(cluster.root, 'data', 'postgresql.conf'), '\ntrack_commit_timestamp = on\n');
  execFileSync('pg_ctl', ['--pgdata', join(cluster.root, 'data'), '--log', join(cluster.root, 'postgres.log'),
    '--timeout', '60', '-w', '-m', 'fast', 'restart'], { env, stdio: 'ignore' });
} else {
  throw new Error(
    'M5T INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
    'Docker and remote databases are not substitutes.',
  );
}

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** `host`/`user` travel in client options, never the URL; a named role REPLACES the userinfo. */
function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}

/** The owner: applies the migrations, writes fixtures, holds the levers and makes the competing changes. */
const owner = postgres(driverDsn(TARGET_DSN), { ...CLIENT_OPTS, max: 6, onnotice: () => {} });
/** The observer: pg_stat_activity polls and every evidence read, on its own connection. */
const probe = postgres(driverDsn(TARGET_DSN), { ...CLIENT_OPTS, max: 1, onnotice: () => {} });
/** The runtime login outside any kernel: 010's status command as the runtime calls it, and the audit-insert probe. */
let runtime = null;
const INSTANCES = new Set();

test.after(async () => {
  for (const instance of [...INSTANCES]) await instance.close().catch(() => {});
  if (runtime) await runtime.end({ timeout: 5 });
  await probe.end({ timeout: 5 });
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: the migrations on disk, a real non-owner runtime login
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

let applyReport;
{
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    applyReport = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
runtime = postgres(driverDsn(TARGET_DSN, RUNTIME_LOGIN), { ...CLIENT_OPTS, user: RUNTIME_LOGIN, max: 2, onnotice: () => {} });
/** The synthetic tenant issuer key the owner installs (migration 018), which every instance's store mints under. */
const ISSUER_KEY = await installTestIssuerKey(owner);

const COMMIT_TS = (await probe`select current_setting('track_commit_timestamp') as v`)[0].v === 'on';
const ON_DISK = readdirSync(MIG_DIR).filter((f) => /^\d{3}_.+\.up\.sql$/.test(f)).map((f) => f.slice(0, 3)).sort();
/** The target contract is on disk (migration 016): its routines are then required, never detected away. */
const TARGET = ON_DISK.includes('016');
const routineExists = async (signature) => (await probe`select pg_catalog.to_regprocedure(${signature}) is not null as v`)[0].v;
/** The admission read the tenant adapter calls: 016's v2 where it exists, else 011's. */
const ADMIT_READ = (await routineExists(ADMIT_V2)) ? ADMIT_V2 : ADMIT_V1;
/** Whether 016's standing hold exists: absent, there is nothing a login holds to fault (M5T-I2 skips, saying so). */
const HAS_HOLD = await routineExists(HOLD_STANDING);

// ---------------------------------------------------------------------------
// small tools
// ---------------------------------------------------------------------------

const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
/** A request a failing test may abandon: its rejection is observed here, and still reaches whoever awaits it. */
const quietly = (p) => { p.catch(() => {}); return p; };
async function within(promise, label) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: label }), WAIT_MS); });
  try { return await Promise.race([promise, bound]); } finally { clearTimeout(timer); }
}
const ROLLBACK = Symbol('rollback');
/** Holds and writes a failing test may leave open; every instance close settles them first. */
const OPEN = new Set();

// ---------------------------------------------------------------------------
// the instances
// ---------------------------------------------------------------------------

const TOKENS = new Map();
const VERIFIER = Object.freeze({
  async verify(view) {
    const uid = TOKENS.get(view.bearerToken);
    return uid === undefined ? null : { verified: true, authProvider: 'firebase', authProviderUid: uid, authenticatedAt: Date.now(), secondFactor: 'totp' };
  },
});
const EVENTS = Object.freeze([...TENANT_DISPLAY_NAME_EVENTS, ...TENANT_STATUS_EVENTS]);
const ORIGINS = Object.freeze({ tenant: Object.freeze([TENANT_ORIGIN]), admin: Object.freeze([ADMIN_ORIGIN]) });

/** How many kernels the production root has asked for: one per composed instance. */
let kernelsBuilt = 0;
/** The kernel constructor handed to composeProductionTransactions: the cluster (or a relay to it), as the runtime login. */
function kernel(relay) {
  kernelsBuilt += 1;
  return createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max: KERNEL_MAX, idle_timeout: 0, ...CLIENT_OPTS,
    ...(relay === null ? {} : { host: relay.dir, port: 5432 }), user: RUNTIME_LOGIN,
  });
}

/**
 * The standing check the production root binds its session store to, built from the same functions and dispatching on the
 * record's audience as productionTransactions.ts does: the rebuilt store below differs from the root's only by the key.
 */
const adminStanding = createPlatformEstablishCheck({ read: readPlatformAdmission, authority: lockPlatformAuthority });
const tenantStanding = createTenantEstablishCheck({ hold: holdTenantStanding, read: readTenantAdmission });
const STANDING = async (sql, record) => {
  if (record.audience === 'admin') return adminStanding(sql, record);
  if (record.audience === 'tenant') return tenantStanding(sql, record);
  throw new Error('session standing unavailable');
};

/** One-shot gates, each armed for one (site, id): the first matching call waits until the scenario releases it. */
function gateBox() {
  const armed = new Map();
  const all = [];
  return {
    arm(site, id) {
      const gate = { entered: deferred(), release: deferred() };
      armed.set(`${site}\n${id}`, gate);
      all.push(gate);
      return gate;
    },
    async pass(site, id) {
      const gate = armed.get(`${site}\n${id}`);
      if (gate === undefined) return;
      armed.delete(`${site}\n${id}`);
      gate.entered.resolve(true);
      await gate.release.promise;
    },
    releaseAll() { armed.clear(); for (const gate of all) gate.release.resolve(); },
  };
}

function send(port, method, path, headers = {}) {
  const framed = method === 'GET' ? headers : { 'content-length': '0', ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: framed, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end();
  });
}

const valueOf = (cookie) => cookie.slice(cookie.indexOf('=') + 1);
const keyOf = (cookie) => createHash('sha256').update(valueOf(cookie)).digest('base64url');
const refOf = (key) => createHash('sha256').update(`tmpos-audit-session-ref:v1\n${key}`).digest('base64url');

/** One runtime instance with both boundaries, composed from its configuration exactly as an entry composes one, and served. */
async function compose(label, relay = null) {
  let client = null;
  const tx = composeProductionTransactions(CONFIGURED_ENV, () => (client = kernel(relay)));
  const gates = gateBox();
  const refreshes = [];
  // The root's store, rebuilt over the root's own kernel with the issuer key it does not yet compose (see the header).
  const inner = createPostgresSessionStore({ client, standing: STANDING, issuerKey: ISSUER_KEY });
  const store = Object.freeze({
    ...inner,
    get: async (key, signal) => { await gates.pass('get', key); return inner.get(key, signal); },
    update: (key, fields, signal) => {
      const p = gates.pass('update', key).then(() => inner.update(key, fields, signal));
      refreshes.push({ key, settled: p.then(() => 'ok', (e) => `threw:${e?.message ?? e}`) });
      return p;
    },
  });
  const tenant = tx.tenantAdmission;
  const tenantAdmission = Object.freeze({
    ...tenant,
    admit: async (principal, signal) => {
      await gates.pass('admitBefore', principal.authProviderUid);
      const answer = await tenant.admit(principal, signal);
      await gates.pass('admitAfter', principal.authProviderUid);
      return answer;
    },
  });
  const limits = testRequestLimits();
  const sessions = assembleSessions({
    origins: ORIGINS, verifier: VERIFIER, trustedProxies: limits.trustedProxies, keySecret: limits.keySecret,
    ...durableSessionAdapters({ store, tenantAdmission, platformAdmission: tx.platformAdmission, tenantReads: WITNESS_READS }),
    limiter: limits.limiter,
  });
  const logs = [];
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line) => { logs.push(line); } }, routes: [...tx.routes, ...WITNESS_ROUTES], limits: sessions.limits,
    idempotency: tx.idempotency, transactions: tx.transactions, events: EVENTS, sessions: sessions.sessions,
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const guarded = (audience) => ({
    origin: audience === 'tenant' ? TENANT_ORIGIN : ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
  });
  const sessionOf = (reply) => {
    const cookie = (reply.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    return { cookie, csrf: JSON.parse(reply.body).csrfToken, key: keyOf(cookie) };
  };
  const records = () => logs.map((line) => { try { return JSON.parse(line); } catch { return {}; } });
  const login = (who, extra = {}, audience = 'tenant') =>
    quietly(send(port, 'POST', sessionPaths(audience).login, { ...guarded(audience), authorization: `Bearer tok-${who.uid}`, ...extra }));
  let closed = false;
  const instance = {
    label, tx, relay, gates, refreshes, records, sessionOf, login,
    reauth: (who, s) => login(who, { cookie: s.cookie, [REAUTHENTICATE_HEADER]: REAUTHENTICATE_VALUE }),
    async signIn(who, audience = 'tenant') {
      const reply = await login(who, {}, audience);
      assert.equal(reply.status, 200, `${audience} login for ${who.uid} on ${label}: ${reply.body}`);
      return sessionOf(reply);
    },
    logout: (s, audience = 'tenant') => quietly(send(port, 'POST', sessionPaths(audience).logout, {
      ...guarded(audience), [SESSION_CSRF_HEADER]: s.csrf, cookie: s.cookie,
    })),
    current: (s, audience = 'tenant') => quietly(send(port, 'GET', sessionPaths(audience).current, { cookie: s.cookie })),
    witness: (s, path = WITNESS_PATH) => quietly(send(port, 'GET', path, { cookie: s.cookie })),
    /** The request log line of one reply, found by its request id (null when none was written within the bound). */
    async line(reply) {
      const id = reply.headers['x-request-id'];
      const until = Date.now() + WAIT_MS;
      while (Date.now() < until) {
        const hit = records().find((r) => r.event === 'request' && r.requestId === id);
        if (hit !== undefined) return hit;
        await tick();
      }
      return null;
    },
    /** The refusal the runtime LOGGED for one reply ('-' when it logged none). */
    async reason(reply) {
      const line = await instance.line(reply);
      return line === null ? 'NO_LOG_LINE' : line.reason ?? '-';
    },
    /** The outcome of the first idle refresh of `key` this instance issued, once it settled. */
    async refreshOf(key) {
      const until = Date.now() + WAIT_MS;
      while (Date.now() < until) {
        const hit = refreshes.find((r) => r.key === key);
        if (hit !== undefined) return within(hit.settled, 'refresh');
        await tick();
      }
      return 'no refresh issued';
    },
    async close() {
      if (closed) return;
      closed = true;
      INSTANCES.delete(instance);
      gates.releaseAll();
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await tx.close();
    },
  };
  INSTANCES.add(instance);
  return instance;
}

/**
 * Close `instances` after a test — every hold it left open rolled back and every write it started settled first — and run
 * `fn`'s failure, if any, past it: a lever still open afterwards fails the test that left it, not a later one.
 */
async function settled(instances, run) {
  let failure = null;
  try { await run(); } catch (err) { failure = err; }
  for (const open of [...OPEN]) if (open.settle) await open.settle();
  for (const inst of instances) inst.gates.releaseAll();
  const stuck = [];
  for (const open of [...OPEN]) if ((await within(open.done, open.label))?.timeout !== undefined) stuck.push(open.label);
  for (const inst of instances) await inst.close();
  if (failure !== null) throw failure;
  assert.deepEqual(stuck, [], 'every hold and write the test opened settled');
}
/** Two instances for one test. */
async function withPair(fn) {
  const instances = [await compose('A')];
  await settled(instances, async () => {
    instances.push(await compose('B'));
    await fn({ A: instances[0], B: instances[1] });
  });
}
/** One instance whose every database byte passes a relay the test may trap. */
async function withRelayed(fn) {
  const relay = startRelay();
  const instances = [];
  try {
    await relay.listening;
    instances.push(await compose('A', relay));
    await settled(instances, () => fn(instances[0]));
  } finally {
    for (const inst of instances) await inst.close();
    await relay.close();
  }
}

// ---------------------------------------------------------------------------
// fixtures and observations
// ---------------------------------------------------------------------------

async function actor(label, grants) {
  const uid = `m5ts-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const g of grants) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${g.tenant ?? null}, ${g.store ?? null}, ${g.scope}, ${g.role}, 'active')`;
  }
  TOKENS.set(`tok-${uid}`, uid);
  return { id, uid };
}
const admin = (label) => actor(label, [{ scope: 'platform', role: 'system_owner' }]);
const newTenant = async (label) =>
  (await owner`insert into tenant (display_name) values (${`m5ts-${label}-${SUFFIX}`}) returning tenant_id`)[0].tenant_id;
const newStore = async (tenant, label) =>
  (await owner`insert into store (tenant_id, store_name) values (${tenant}, ${`m5ts-${label}-${SUFFIX}`}) returning store_id`)[0].store_id;
const grantOf = async (who) => (await owner`select membership_id from user_membership where internal_user_id = ${who.id}`)[0].membership_id;
/** A tenant of its own and an actor holding one active tenant grant on it. */
async function tenantActor(label) {
  const tenant = await newTenant(label);
  const who = await actor(label, [{ scope: 'tenant', tenant, role: 'store_owner' }]);
  return { who, tenant, store: null, grant: await grantOf(who) };
}
/** A tenant and a store of their own and an actor holding one active store grant on it. */
async function storeActor(label) {
  const tenant = await newTenant(label);
  const store = await newStore(tenant, label);
  const who = await actor(label, [{ scope: 'store', tenant, store, role: 'manager' }]);
  return { who, tenant, store, grant: await grantOf(who) };
}
const witnessOf = async (key) => (await probe`select security_version from tmpos_session.session where session_key = ${key}`)[0]?.security_version;
const boundAt = async (key) => Number((await probe`select authenticated_at from tmpos_session.session where session_key = ${key}`)[0].authenticated_at);

/** Readable names for session keys (K1, K2, ...) and for the audit references derived from them. */
function labeller() {
  const keys = new Map();
  const refs = new Map();
  return {
    name(label, key) { keys.set(key, label); refs.set(refOf(key), label); return key; },
    key: (k) => keys.get(k) ?? `other:${k.slice(0, 6)}`,
    ref: (r) => (r == null ? null : refs.get(r) ?? `other:${r.slice(0, 6)}`),
    keys: () => [...keys.keys()],
  };
}
/** Every session row the principal holds, in either audience, as labels — read as the owner. */
async function liveLabels(who, lab) {
  return (await probe`select session_key from tmpos_session.session where auth_provider_uid = ${who.uid}`)
    .map((r) => lab.key(r.session_key)).sort();
}
/** Every tenant-session record naming this actor or one of the labelled sessions, with its transaction. */
async function sessionRecords(who, lab) {
  const refs = lab.keys().map(refOf);
  return (await probe`select action_id, metadata->>'sessionRef' as sref, metadata->>'replacedSessionRef' as rref, xmin::text as xid
      from public.audit_event where action_id like ${`${SESSION_ACTIONS}%`}
        and (actor_internal_user_id = ${who.id} or metadata->>'sessionRef' = any(${refs}::text[]))`)
    .map((r) => ({ action: r.action_id.slice(SESSION_ACTIONS.length), session: lab.ref(r.sref), replaced: lab.ref(r.rref), xid: r.xid }));
}
/** What the records claim, one line each: `action:session` or `action:session<-replaced`. */
const claims = (records) => records.map((r) => `${r.action}:${r.session}${r.replaced ? `<-${r.replaced}` : ''}`).sort();
/** No record claims a login, logout or recent sign-in that did not happen: the records are exactly `expected`. */
async function assertRecords(who, lab, expected, why) {
  const records = await sessionRecords(who, lab);
  assert.deepEqual(claims(records), [...expected].sort(), `${why}: ${j(records)}`);
  return records;
}
/**
 * Every tenant-session record in the database — any actor, any reference: a refusal must leave it as it found it.
 * Unscoped on purpose, so a record written for the wrong actor is caught too; it relies on CI running each
 * tests/db suite as its own sequential step against the shared database.
 */
const tenantRecordTotal = async () =>
  (await probe`select count(*)::int as n from public.audit_event where action_id like ${`${SESSION_ACTIONS}%`}`)[0].n;
/** The one `action` record naming the session `key`, every column. */
async function recordOf(action, key) {
  const rows = await probe`select * from public.audit_event
    where action_id = ${SESSION_ACTIONS + action} and metadata->>'sessionRef' = ${refOf(key)}`;
  assert.equal(rows.length, 1, `exactly one ${action} record naming the session: ${rows.length}`);
  return rows[0];
}
const RECORD_WORDS = Object.freeze({
  login: ['allow', 'tenant_session_created'],
  reauthenticate: ['allow', 'tenant_session_reauthenticated'],
  logout: ['not_applicable', 'tenant_session_ended'],
});
/** The columns every tenant-session record carries (design §3): the admin row's, but no scope. */
function assertRecordRow(row, action, actorId, operationId) {
  const [decision, reasonCode] = RECORD_WORDS[action];
  const expected = {
    action_id: SESSION_ACTIONS + action, audit_version: 'audit.v1', request_id: operationId, trace_id: null,
    actor_internal_user_id: actorId, actor_auth_provider: null, on_behalf_of_internal_user_id: null,
    scope_type: 'none', tenant_id: null, store_id: null, subject_tenant_id: null,
    required_permission: 'n_a', decision, reason_code: reasonCode, result_status: 'succeeded',
    source_of_truth: 'session_transaction', evaluated_by: 'm6_postgres_session_store@v1', evidence_level: 'durable_compliance_event',
  };
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((k) => [k, row[k]])), expected);
}

/** With commit timestamps on, `earlier` committed strictly before `later`; without them the lock wait already proved it. */
async function assertCommitOrder(t, label, earlierXid, laterXid) {
  if (!COMMIT_TS) {
    t.diagnostic(`${label}: order proved by the lock wait (track_commit_timestamp off on this service)`);
    return;
  }
  const [row] = await probe`select pg_xact_commit_timestamp(${earlierXid}::xid) < pg_xact_commit_timestamp(${laterXid}::xid) as ordered,
      pg_xact_commit_timestamp(${earlierXid}::xid)::text as a, pg_xact_commit_timestamp(${laterXid}::xid)::text as b`;
  t.diagnostic(`${label}: committed ${row.a} then ${row.b}`);
  assert.equal(row.ordered, true, `${label}: commit order ${row.a} then ${row.b}`);
}

// ---------------------------------------------------------------------------
// levers: owner-held locks and competing writes, observed through pg_stat_activity
// ---------------------------------------------------------------------------

/** Hold row locks in an OPEN owner transaction until released. */
async function hold(label, setup) {
  const ready = deferred();
  const release = deferred();
  const done = owner.begin(async (sql) => {
    const [{ pid, xid }] = await sql`select pg_backend_pid() as pid, pg_current_xact_id()::text as xid`;
    await setup(sql);
    ready.resolve({ pid, xid });
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
const holdSession = (key) => hold('session K1 for update', (sql) => sql`select 1 from tmpos_session.session where session_key = ${key} for update`);

/** A committed write on `client` (the owner unless named): its transaction (pid, xid) once started, and its settlement. */
function write(label, fn, client = owner) {
  const started = deferred();
  const done = client.begin(async (sql) => {
    const [{ pid, xid }] = await sql`select pg_backend_pid() as pid, pg_current_xact_id()::text as xid`;
    started.resolve({ pid, xid });
    await fn(sql);
  }).then(() => 'committed', (e) => `failed:${e?.message ?? e}`);
  const w = { label, done, started: Promise.race([started.promise, done.then((v) => ({ early: v }))]) };
  OPEN.add(w);
  done.then(() => OPEN.delete(w));
  return w;
}
/** Wait until a write settles or waits on a Lock: { settled, xid } | { blocked, blockers, xid } | null (bound). */
async function outcomeOf(w) {
  const s = await w.started;
  if ('early' in s) return { settled: s.early };
  let settled = null;
  w.done.then((v) => { settled = v; });
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    if (settled !== null) return { settled, xid: s.xid };
    const [row] = await probe`select wait_event_type, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = ${s.pid}`;
    if (settled !== null) return { settled, xid: s.xid };
    if (row?.wait_event_type === 'Lock') return { blocked: true, blockers: row.blockers, xid: s.xid };
    await tick();
  }
  return null;
}
/** A write that must commit at once: its xid. */
async function committed(label, fn, client = owner) {
  const w = write(label, fn, client);
  const outcome = await within(w.done, label);
  assert.equal(outcome, 'committed', `${label}: ${j(outcome)}`);
  return (await w.started).xid;
}
/** 010's status command on `tenant`, as the runtime login calls it — the only sanctioned path — as an observable write. */
async function statusWrite(tenant, from, to) {
  const [{ rv }] = await probe`select row_version::text as rv from public.tenant where tenant_id = ${tenant}`;
  return write(`status ${from} -> ${to}`, async (sql) => {
    const [answer] = await sql`select o_outcome from tmpos_command.m5_tenant_status_change(
      ${tenant}::uuid, ${rv}::bigint, ${from}::text, ${to}::text)`;
    if (answer?.o_outcome !== 'applied') throw new Error(`status ${from} -> ${to}: ${answer?.o_outcome}`);
  }, runtime);
}
async function setStatus(tenant, from, to) {
  const w = await statusWrite(tenant, from, to);
  assert.equal(await within(w.done, w.label), 'committed', w.label);
}
const setStore = (store, status) => committed(`store ${status}`, (sql) => sql`update public.store set status = ${status} where store_id = ${store}`);

/** Runtime-login backends waiting on a Lock now, filtered by blocker pid, statement text and exclusions. */
async function blockedNow({ by = null, query = null, exclude = [] } = {}) {
  const rows = await probe`select pid, query, pg_blocking_pids(pid) as blockers from pg_stat_activity
    where usename = ${RUNTIME_LOGIN} and wait_event_type = 'Lock'`;
  return rows
    .filter((r) => !exclude.includes(r.pid) && (query === null || query.test(r.query)) && (by === null || r.blockers.includes(by)))
    .map((r) => ({ pid: r.pid, blockers: r.blockers, at: r.query.replace(/\s+/g, ' ').slice(0, 80) }));
}
async function waitBlocked(criteria, count = 1) {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    const hit = await blockedNow(criteria);
    if (hit.length >= count) return hit;
    await tick();
  }
  return null;
}
/** Wait until `request` settles or a runtime backend matching `criteria` waits on a Lock: { settled } | { blocked } | null. */
async function blockedOrSettled(request, criteria) {
  let settled = null;
  request.then((value) => { settled = { value }; }, (error) => { settled = { error: String(error) }; });
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    if (settled !== null) return { settled };
    const hit = await blockedNow(criteria);
    if (hit.length > 0) return { blocked: hit };
    await tick();
  }
  return settled !== null ? { settled } : null;
}
/** A request that must be waiting at `what`: the backend's pid — or a failure naming what happened instead. */
function waitingPid(outcome, what) {
  assert.ok(outcome !== null, `lever did not engage: ${what} not observed within ${WAIT_MS} ms`);
  assert.ok(outcome.blocked, `${what}: the request completed instead of waiting (${j(outcome.settled?.value?.status ?? outcome.settled)})`);
  return outcome.blocked[0].pid;
}
/** Poll until no runtime-login backend is active or inside a transaction (bounded). */
async function waitIdle() {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    const [{ n }] = await probe`select count(*)::int as n from pg_stat_activity where usename = ${RUNTIME_LOGIN} and state <> 'idle'`;
    if (n === 0) return;
    await tick();
  }
  assert.fail(`runtime-login backends still busy after ${WAIT_MS} ms`);
}
const entered = async (gate, what) => assert.equal(await within(gate.entered.promise, what), true, `lever did not engage: ${what}`);
/** The reply to `request`, which must arrive within the bound. */
async function replyTo(request, label) {
  const reply = await within(request, label);
  assert.ok(typeof reply?.status === 'number', `no reply to ${label} within ${WAIT_MS} ms: ${j(reply)}`);
  return reply;
}
async function refusedWith(inst, reply, status, reason, why) {
  assert.ok(typeof reply?.status === 'number', `${why}: no reply (${j(reply)})`);
  const got = await inst.reason(reply);
  assert.equal(reply.status, status, `${why}: got ${reply.status} ${got} ${reply.body.slice(0, 120)}`);
  assert.equal(got, reason, `${why}: reason`);
}

// ---------------------------------------------------------------------------
// faults: the audit store (productionEntry M6AA-08's technique) and a lost COMMIT answer (M6AA-10's relay)
// ---------------------------------------------------------------------------

/** What an audit INSERT by the runtime login answers right now — its row count, or its SQLSTATE — rolled back either way. */
async function probeAuditInsert() {
  const undo = new Error('m5ts probe: rolled back');
  try {
    await runtime.begin(async (tx) => {
      const result = await tx`insert into public.audit_event (request_id, scope_type, action_id, required_permission, decision,
          reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level)
        values (${randomUUID()}, 'platform', 'm5ts.probe', 'n_a', 'not_applicable', 'm5ts_probe', 'A rolled-back probe.', 'n_a',
          'm5ts_probe', 'm5ts_probe', 'durable_compliance_event')`;
      undo.count = result.count;
      throw undo;
    });
  } catch (err) {
    return err === undo ? { count: undo.count } : { code: err.code };
  }
  throw new Error('the probe did not roll back');
}
/** A trigger raising on every audit INSERT, or the audit writer's INSERT revoked; proven in place, then exactly undone. */
async function withAuditFault(fault, fn) {
  try {
    if (fault === 'revoked') {
      await owner.unsafe('revoke insert on table public.audit_event from tmpos_audit_writer');
    } else {
      await owner.unsafe(`create schema ${AUDIT_FAULT_SCHEMA};
        create function ${AUDIT_FAULT_SCHEMA}.inject() returns trigger language plpgsql as $$
          begin raise exception 'M5T injected audit fault' using errcode = 'M5T00'; end $$;
        create trigger m5ts_audit_fault before insert on public.audit_event for each row execute function ${AUDIT_FAULT_SCHEMA}.inject();`);
    }
    assert.deepEqual(await probeAuditInsert(), fault === 'revoked' ? { code: '42501' } : { code: 'M5T00' }, `${fault}: the fault is in place`);
    return await fn();
  } finally {
    await owner.unsafe(`drop schema if exists ${AUDIT_FAULT_SCHEMA} cascade`);
    if (fault === 'revoked') await owner.unsafe('grant insert on table public.audit_event to tmpos_audit_writer');
    assert.deepEqual(await probeAuditInsert(), { count: 1 }, `${fault}: the runtime login's audit INSERT works again`);
  }
}

/** A unix-socket byte relay to the cluster: a trap may read what the client sends and silence the server's side. */
function startRelay() {
  const u = new URL(TARGET_DSN);
  const upstream = CLIENT_OPTS.host
    ? { path: join(CLIENT_OPTS.host, `.s.PGSQL.${u.port || 5432}`) }
    : { host: u.hostname, port: Number(u.port || 5432) };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m5ts-relay-'));
  const pairs = new Set();
  const state = { pairs, trap: null };
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
  return {
    dir,
    state,
    listening: new Promise((done) => server.listen(join(dir, '.s.PGSQL.5432'), done)),
    async close() {
      const drained = new Promise((done) => server.close(done));
      for (const pair of [...pairs]) pair.cut();
      await drained;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const AUDIT_INSERT_TEXT = Buffer.from('insert into public.audit_event');
const COMMIT_PARSE = Buffer.from('\0commit\0'); // the kernel's own `commit`, as an unnamed Parse message carries it
/** On the first connection that sends the audit INSERT, forward its COMMIT — the server commits — and drop the answer. */
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

// ---------------------------------------------------------------------------
// M5T-A: the composition, a valid login and its record
// ---------------------------------------------------------------------------

test('M5T-A0: every migration on disk is applied, and two instances are two production roots serving one durable tenant session', async (t) => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), ON_DISK.map((v) => [v, false]), 'the ledger is exactly the migrations on disk');
  t.diagnostic(`ledger ${ON_DISK[0]}..${ON_DISK.at(-1)}; admission read ${ADMIT_READ}; standing hold ${HAS_HOLD ? 'present' : 'absent'}; `
    + `track_commit_timestamp=${COMMIT_TS ? 'on' : 'off'}`);
  if (TARGET) {
    assert.equal(ADMIT_READ, ADMIT_V2, 'design §2e: 016 applied, the admission read is v2');
    assert.ok(HAS_HOLD, `design §2f: 016 applied, ${HOLD_STANDING} exists`);
  }
  const before = kernelsBuilt;
  await withPair(async ({ A, B }) => {
    assert.equal(kernelsBuilt - before, 2, 'each instance asked the production root for its own kernel');
    assert.notEqual(A.tx, B.tx, 'two separately composed roots');
    for (const inst of [A, B]) assert.notEqual(inst.tx.preflight, null, `${inst.label}: composed through the production factories`);
    const { who } = await tenantActor('a0');
    const s = await A.signIn(who);
    assert.equal((await B.witness(s)).status, 200, 'a tenant session issued through A is served by B: one durable store');
  });
});

test('M5T-A1: a valid tenant login is 200 with one durable row, and a protected request on it is served on either instance', () =>
  withPair(async ({ A, B }) => {
    const { who, tenant } = await tenantActor('a1');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    assert.deepEqual(await liveLabels(who, lab), ['K1'], 'exactly one durable row');
    assert.match(await witnessOf(s.key), new RegExp(`^${TARGET ? 't2' : 't1'}:[A-Za-z0-9_-]{43}$`), 'bound to the admission witness');
    const served = await B.witness(s);
    assert.equal(served.status, 200, served.body);
    const body = JSON.parse(served.body);
    assert.deepEqual({ ...body, securityVersion: typeof body.securityVersion },
      { actor: who.id, tenant, store: null, roleId: 'store_owner', limitation: 'none', securityVersion: 'string' });
    assert.equal((await A.current(s)).status, 200);
  }));

test('M5T-A2: the login writes exactly one tenant.session.login record: the internal user, no scope, its operation id, a one-way session reference', () =>
  withPair(async ({ A }) => {
    const { who } = await tenantActor('a2');
    const lab = labeller();
    const reply = await A.login(who);
    assert.equal(reply.status, 200, reply.body);
    const s = A.sessionOf(reply);
    lab.name('K1', s.key);
    const line = await A.line(reply);
    assert.match(line?.operationId ?? '', UUID_RE, `the request log carries the login's operation id: ${j(line)}`);
    await assertRecords(who, lab, ['login:K1'], 'one login record');
    const row = await recordOf('login', s.key);
    assertRecordRow(row, 'login', who.id, line.operationId);
    assert.deepEqual(row.metadata, { sessionRef: refOf(s.key), authenticatedAt: await boundAt(s.key) },
      'a one-way reference and the bound sign-in time; never the key or the cookie');
  }));

// ---------------------------------------------------------------------------
// M5T-B, C: a login against a suspension
// ---------------------------------------------------------------------------

test('M5T-B1: a suspension committed before the login refuses it: 401 login_admission_denied, no session, no record', () =>
  withPair(async ({ A }) => {
    const { who, tenant } = await tenantActor('b1');
    const lab = labeller();
    await setStatus(tenant, 'active', 'suspended');
    const total = await tenantRecordTotal();
    const reply = await A.login(who);
    await refusedWith(A, reply, 401, 'login_admission_denied', 'suspended before the login');
    assert.equal(reply.headers['set-cookie'], undefined, 'no cookie');
    assert.deepEqual(await liveLabels(who, lab), []);
    assert.equal(await tenantRecordTotal(), total, 'a refusal records nothing');
  }));

test('M5T-C1: a suspension committed after the login\'s admission read: 401 login_standing_changed, nothing created or recorded', () =>
  withPair(async ({ A }) => {
    const { who, tenant } = await tenantActor('c1');
    const lab = labeller();
    const total = await tenantRecordTotal();
    const gate = A.gates.arm('admitAfter', who.uid);
    const pending = A.login(who);
    await entered(gate, 'the login past its admission read');
    await setStatus(tenant, 'active', 'suspended');
    gate.release.resolve();
    await refusedWith(A, await pending, 401, 'login_standing_changed', 'design §1: the standing changed before establish re-read it');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), [], 'no session created');
    assert.equal(await tenantRecordTotal(), total, 'no login recorded');
  }));

test('M5T-C2: a login parked inside its transaction: the suspension waits for its COMMIT; the login is 200 and its next request 401', (t) =>
  withPair(async ({ A, B }) => {
    const { who, tenant } = await tenantActor('c2');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const h = await holdSession(s.key);
    const pending = B.login(who, { cookie: s.cookie });
    const loginPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_SESSION_ROW }),
      'the login waiting on its presented session inside its transaction');
    const suspension = await statusWrite(tenant, 'active', 'suspended');
    const r = await outcomeOf(suspension);
    assert.ok(r?.blocked && r.blockers.includes(loginPid), `design §1: the suspension must wait for the login's COMMIT (${j(r)})`);
    assert.equal(await h.commit(), 'committed');
    const reply = await replyTo(pending, 'login');
    assert.equal(reply.status, 200, `${reply.status} ${await B.reason(reply)}`);
    const successor = B.sessionOf(reply);
    lab.name('K2', successor.key);
    assert.equal(await within(suspension.done, 'suspension'), 'committed');
    await waitIdle();
    const records = await assertRecords(who, lab, ['login:K1', 'login:K2<-K1'], 'the login rotated K1 and was recorded');
    await assertCommitOrder(t, 'login before suspension', records.find((x) => x.session === 'K2').xid, r.xid);
    await refusedWith(A, await A.witness(successor), 401, 'session_admission_denied', 'the suspension then takes effect');
    assert.deepEqual(await liveLabels(who, lab), []);
  }));

// ---------------------------------------------------------------------------
// M5T-D, H2-H5: round trips on an IDLE session — a standing that returns never revives it (DA-41)
// ---------------------------------------------------------------------------

/** An idle session across `roundTrip`, all committed before its next request: refused for its witness, never revived. */
async function idleAcross({ A, B }, fixture, roundTrip, path = WITNESS_PATH) {
  const f = await fixture;
  const lab = labeller();
  const s = await A.signIn(f.who);
  lab.name('K1', s.key);
  assert.equal((await A.witness(s, path)).status, 200, 'served before the episode');
  const bound = await witnessOf(s.key);
  await roundTrip(f);
  assert.deepEqual(await liveLabels(f.who, lab), ['K1'], 'the idle session made no request: nothing ended it');
  assert.equal(await witnessOf(s.key), bound, 'still bound to the witness it was admitted at');
  await refusedWith(B, await B.witness(s, path), 401, 'session_version_mismatch', 'design §0.3: the standing is back, its witness is not');
  await waitIdle();
  assert.deepEqual(await liveLabels(f.who, lab), [], 'and that session ended');
  for (const inst of [A, B]) await refusedWith(inst, await inst.witness(s, path), 401, 'session_unknown', `${inst.label}: the old cookie never works again`);
  const fresh = await B.signIn(f.who);
  lab.name('K2', fresh.key);
  assert.notEqual(await witnessOf(fresh.key), bound, 'admitted anew under a witness the old cookie never had');
  assert.equal((await A.witness(fresh, path)).status, 200, 'a fresh login works');
  assert.deepEqual(await liveLabels(f.who, lab), ['K2']);
}

test('M5T-D1: a tenant suspended and reactivated by 010 while a session is idle: 401 session_version_mismatch, never revived', () =>
  withPair((pair) => idleAcross(pair, tenantActor('d1'), async ({ tenant }) => {
    await setStatus(tenant, 'active', 'suspended');
    await setStatus(tenant, 'suspended', 'active');
  })));

test('M5T-D2: a grant suspended and restored while a session is idle: 401 session_version_mismatch, never revived', () =>
  withPair((pair) => idleAcross(pair, tenantActor('d2'), async ({ grant }) => {
    await committed('grant suspended', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
    await committed('grant restored', (sql) => sql`update user_membership set status = 'active' where membership_id = ${grant}`);
  })));

test('M5T-D3: a grant deleted and re-inserted under the same id while a session is idle: 401 session_version_mismatch, never revived', () =>
  withPair((pair) => idleAcross(pair, tenantActor('d3'), async ({ who, tenant, grant }) => {
    await committed('grant deleted', (sql) => sql`delete from user_membership where membership_id = ${grant}`);
    await committed('grant re-inserted', (sql) => sql`insert into user_membership
      (membership_id, internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${grant}, ${who.id}, ${tenant}, null, 'tenant', 'store_owner', 'active')`);
  })));

test('M5T-D4: a raw owner tenant status round trip while a session is idle: 401 session_version_mismatch, never revived', () =>
  withPair((pair) => idleAcross(pair, tenantActor('d4'), async ({ tenant }) => {
    await committed('tenant suspended (raw)', (sql) => sql`update public.tenant set status = 'suspended' where tenant_id = ${tenant}`);
    await committed('tenant reactivated (raw)', (sql) => sql`update public.tenant set status = 'active' where tenant_id = ${tenant}`);
  })));

// ---------------------------------------------------------------------------
// M5T-E: a login against the actor's own standing changes
// ---------------------------------------------------------------------------

// [what, the next request's refusal once it lands, the change]
const STANDING_CHANGES = [
  ['grant removal', 'session_admission_denied',
    ({ grant }) => (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`],
  ['role change', 'session_version_mismatch',
    ({ grant }) => (sql) => sql`update user_membership set role_id = 'manager' where membership_id = ${grant}`],
  ['account status change', 'session_admission_denied',
    ({ who }) => (sql) => sql`update app_user set status = 'suspended' where internal_user_id = ${who.id}`],
  ['anchor repoint', 'session_admission_denied',
    ({ who }) => (sql) => sql`update platform_identity set auth_provider_uid = ${`${who.uid}-moved`} where internal_user_id = ${who.id}`],
];

for (const [i, [what, next, change]] of STANDING_CHANGES.entries()) {
  const n = 'abcd'[i];
  test(`M5T-E1${n}: the actor's ${what}, committed after the login's admission read: 401 login_standing_changed, nothing created or recorded`, () =>
    withPair(async ({ A }) => {
      const f = await tenantActor(`e1${n}`);
      const lab = labeller();
      const total = await tenantRecordTotal();
      const gate = A.gates.arm('admitAfter', f.who.uid);
      const pending = A.login(f.who);
      await entered(gate, 'the login past its admission read');
      await committed(what, change(f));
      gate.release.resolve();
      await refusedWith(A, await pending, 401, 'login_standing_changed', `design §1: the ${what} committed before establish re-read`);
      await waitIdle();
      assert.deepEqual(await liveLabels(f.who, lab), [], 'no session created');
      assert.equal(await tenantRecordTotal(), total, 'no login recorded');
    }));

  test(`M5T-E2${n}: the actor's ${what} waits for a login parked inside its transaction; its next request is then 401 ${next}`, (t) =>
    withPair(async ({ A, B }) => {
      const f = await tenantActor(`e2${n}`);
      const lab = labeller();
      const s = await A.signIn(f.who);
      lab.name('K1', s.key);
      const h = await holdSession(s.key);
      const pending = B.login(f.who, { cookie: s.cookie });
      const loginPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_SESSION_ROW }),
        'the login waiting on its presented session inside its transaction');
      const w = write(what, change(f));
      const r = await outcomeOf(w);
      assert.ok(r?.blocked && r.blockers.includes(loginPid), `design §1: the ${what} must wait for the login's COMMIT (${j(r)})`);
      assert.equal(await h.commit(), 'committed');
      const reply = await replyTo(pending, 'login');
      assert.equal(reply.status, 200, `${reply.status} ${await B.reason(reply)}`);
      const successor = B.sessionOf(reply);
      lab.name('K2', successor.key);
      assert.equal(await within(w.done, what), 'committed');
      await waitIdle();
      const records = await assertRecords(f.who, lab, ['login:K1', 'login:K2<-K1'], 'the login rotated K1 and was recorded');
      await assertCommitOrder(t, `login before ${what}`, records.find((x) => x.session === 'K2').xid, r.xid);
      await refusedWith(A, await A.witness(successor), 401, next, `the ${what} then takes effect`);
      assert.deepEqual(await liveLabels(f.who, lab), []);
    }));
}

// ---------------------------------------------------------------------------
// M5T-F, K3/K4: recent sign-in and logout
// ---------------------------------------------------------------------------

/** A logout (on `off`) queued first on the session row, a recent sign-in (on `re`) second: the sign-in creates nothing. */
async function logoutThenReauth(re, off, label) {
  const { who } = await tenantActor(label);
  const lab = labeller();
  const s = await re.signIn(who);
  lab.name('K1', s.key);
  const h = await holdSession(s.key);
  const logout = off.logout(s);
  const loPid = waitingPid(await blockedOrSettled(logout, { by: h.pid, query: AT_SESSION_ROW }), 'the logout queued first on K1');
  const reauth = re.reauth(who, s);
  waitingPid(await blockedOrSettled(reauth, { query: AT_SESSION_ROW, exclude: [loPid] }), 'the recent sign-in queued second on K1');
  assert.equal(await h.commit(), 'committed');
  const lo = await replyTo(logout, 'logout');
  assert.equal(lo.status, 204, lo.body);
  assert.equal(await off.reason(lo), '-', 'the logout ended the live session');
  await refusedWith(re, await replyTo(reauth, 'reauth'), 401, 'login_reauth_no_session',
    'design §0.2: the presented session ended before this establish');
  await waitIdle();
  assert.deepEqual(await liveLabels(who, lab), [], 'no successor was created');
  await assertRecords(who, lab, ['login:K1', 'logout:K1'], 'no reauthenticate record');
}

/** A recent sign-in (on `re`) queued first on the session row, a logout (on `off`) second: the logout ends nothing. */
async function reauthThenLogout(re, off, label) {
  const { who } = await tenantActor(label);
  const lab = labeller();
  const s = await re.signIn(who);
  lab.name('K1', s.key);
  const h = await holdSession(s.key);
  const reauth = re.reauth(who, s);
  const rePid = waitingPid(await blockedOrSettled(reauth, { by: h.pid, query: AT_SESSION_ROW }), 'the recent sign-in queued first on K1');
  const logout = off.logout(s);
  waitingPid(await blockedOrSettled(logout, { query: AT_SESSION_ROW, exclude: [rePid] }), 'the logout queued second on K1');
  assert.equal(await h.commit(), 'committed');
  const reply = await replyTo(reauth, 'reauth');
  assert.equal(reply.status, 200, `${reply.status} ${await re.reason(reply)}`);
  const successor = re.sessionOf(reply);
  lab.name('K2', successor.key);
  const lo = await replyTo(logout, 'logout');
  assert.equal(lo.status, 204, lo.body);
  assert.equal(await off.reason(lo), 'logout_session_absent', 'the rotated cookie named nothing to end');
  await waitIdle();
  assert.deepEqual(await liveLabels(who, lab), ['K2'], 'exactly one successor lives');
  await assertRecords(who, lab, ['login:K1', 'reauthenticate:K2<-K1'], 'no logout record');
  assert.equal((await off.witness(successor)).status, 200, 'the successor works');
  await refusedWith(off, await off.witness(s), 401, 'session_unknown', 'the rotated cookie');
}

test('M5T-F1: a logout committed before a recent sign-in\'s establish: 401 login_reauth_no_session, nothing created, no reauthenticate record', () =>
  withPair(({ A }) => logoutThenReauth(A, A, 'f1')));

test('M5T-F2: a recent sign-in first: the logout of the rotated cookie ends nothing (204 logout_session_absent, no record); one successor', () =>
  withPair(({ A }) => reauthThenLogout(A, A, 'f2')));

test('M5T-F3: three concurrent recent sign-ins presenting one cookie across two instances: exactly one succeeds', (t) =>
  withPair(async ({ A, B }) => {
    const { who } = await tenantActor('f3');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const h = await holdSession(s.key);
    const first = A.reauth(who, s);
    const firstPid = waitingPid(await blockedOrSettled(first, { by: h.pid, query: AT_SESSION_ROW }), 'the first recent sign-in on K1');
    const others = [B.reauth(who, s), A.reauth(who, s)];
    assert.ok(await waitBlocked({ exclude: [firstPid] }, 2) !== null, 'lever did not engage: two more recent sign-ins waiting');
    assert.equal(await h.commit(), 'committed');
    const replies = await Promise.all([first, ...others].map((p) => replyTo(p, 'reauth')));
    const reasons = await Promise.all(replies.map((r, i) => (i === 1 ? B : A).reason(r)));
    t.diagnostic(j(replies.map((r, i) => `${r.status} ${reasons[i]}`)));
    const delivered = replies.filter((r) => r.status === 200);
    assert.equal(delivered.length, 1, `design §0.2: exactly one recent sign-in presenting one cookie succeeds: ${j(replies.map((r) => r.status))}`);
    replies.forEach((r, i) => {
      if (r.status !== 200) assert.deepEqual([r.status, reasons[i]], [401, 'login_reauth_no_session']);
    });
    const successor = A.sessionOf(delivered[0]);
    lab.name('D', successor.key);
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), ['D'], 'exactly the delivered session lives');
    await assertRecords(who, lab, ['login:K1', 'reauthenticate:D<-K1'], 'exactly one reauthenticate record, naming the delivered session');
  }));

test('M5T-F4: a logout committing between a request\'s session read and its admission read may complete it; its refresh never recreates', (t) =>
  withPair(async ({ A, B }) => {
    const { who } = await tenantActor('f4');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const gate = B.gates.arm('admitBefore', who.uid);
    const pending = B.witness(s);
    await entered(gate, "B's request between its session read and its admission read");
    const lo = await A.logout(s);
    assert.equal(lo.status, 204, lo.body);
    gate.release.resolve();
    const reply = await replyTo(pending, 'request');
    const reason = await B.reason(reply);
    assert.ok(reply.status === 200 || (reply.status === 401 && reason === 'session_unknown'), `${reply.status} ${reason}`);
    if (reply.status === 200) assert.equal(await B.refreshOf(s.key), 'ok', 'its refresh ran against the deleted row');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), [], 'nothing recreated the logged-out session');
    for (const inst of [A, B]) await refusedWith(inst, await inst.witness(s), 401, 'session_unknown', `${inst.label}: the next request`);
    t.diagnostic(`in-between request: ${reply.status} ${reason} (ADR-30's read rule permits 200)`);
  }));

// ---------------------------------------------------------------------------
// M5T-G: substitution — no grant, scope or audience stands in for another
// ---------------------------------------------------------------------------

test('M5T-G1: a platform-only actor\'s tenant login is 401 login_admission_denied; the same actor\'s admin login is admitted', () =>
  withPair(async ({ A }) => {
    const who = await admin('g1');
    const lab = labeller();
    const total = await tenantRecordTotal();
    await refusedWith(A, await A.login(who), 401, 'login_admission_denied', 'a platform grant admits no tenant session');
    assert.deepEqual(await liveLabels(who, lab), []);
    assert.equal(await tenantRecordTotal(), total, 'a refusal records nothing');
    const s = await A.signIn(who, 'admin');
    assert.equal((await A.current(s, 'admin')).status, 200, 'the refusal was the tenant plane\'s alone');
  }));

test('M5T-G2: a tenant-grant session on the store route and a store-grant session on the tenant route are 403 authz_denied, and end nothing', () =>
  withPair(async ({ A, B }) => {
    const byTenant = await tenantActor('g2-tenant');
    const byStore = await storeActor('g2-store');
    const lab = labeller();
    const sT = await A.signIn(byTenant.who);
    const sS = await A.signIn(byStore.who);
    lab.name('T1', sT.key);
    lab.name('S1', sS.key);
    await refusedWith(B, await B.witness(sT, STORE_WITNESS_PATH), 403, 'authz_denied', 'a tenant grant selects no store');
    await refusedWith(B, await B.witness(sS, WITNESS_PATH), 403, 'authz_denied', 'a store grant selects no tenant scope');
    assert.equal((await A.witness(sT, WITNESS_PATH)).status, 200, 'the tenant session still serves its own scope');
    assert.equal((await A.witness(sS, STORE_WITNESS_PATH)).status, 200, 'the store session still serves its own scope');
    assert.deepEqual([await liveLabels(byTenant.who, lab), await liveLabels(byStore.who, lab)], [['T1'], ['S1']], 'a 403 ends no session');
  }));

test('M5T-G3: an administrative cookie on /api/v1 and a tenant cookie on /admin/v1 are 401, by name and by value', () =>
  withPair(async ({ A, B }) => {
    const { who } = await tenantActor('g3');
    const boss = await admin('g3-admin');
    const sT = await A.signIn(who);
    const sA = await A.signIn(boss, 'admin');
    const renamed = (s, audience) => ({ cookie: `${SESSION_COOKIES[audience]}=${valueOf(s.cookie)}` });
    await refusedWith(B, await B.current(sA, 'tenant'), 401, 'session_missing', 'an admin cookie names no tenant session');
    await refusedWith(B, await B.witness(renamed(sA, 'tenant')), 401, 'session_wrong_audience', 'an admin session read by the tenant boundary');
    await refusedWith(B, await B.current(sT, 'admin'), 401, 'session_missing', 'a tenant cookie names no administrative session');
    await refusedWith(B, await B.current(renamed(sT, 'admin'), 'admin'), 401, 'session_wrong_audience', 'a tenant session read by the admin boundary');
    assert.equal((await B.witness(sT)).status, 200, 'each session still works on its own boundary');
    assert.equal((await B.current(sA, 'admin')).status, 200);
  }));

test('M5T-G4: a tenant grant never admits an administrative login', () =>
  withPair(async ({ A }) => {
    const { who } = await tenantActor('g4');
    const lab = labeller();
    await refusedWith(A, await A.login(who, {}, 'admin'), 401, 'login_admission_denied', 'a tenant grant admits no administrative session');
    assert.deepEqual(await liveLabels(who, lab), [], 'no session in either audience');
    const [{ n }] = await probe`select count(*)::int as n from public.audit_event where actor_internal_user_id = ${who.id}`;
    assert.equal(n, 0, 'no record of any kind');
  }));

// ---------------------------------------------------------------------------
// M5T-H: a store session across a store suspension, a re-parenting, and a replica's delete and re-insert
// ---------------------------------------------------------------------------

test('M5T-H1: a store suspended under an active tenant ends an ACTIVE store session at once and refuses its login; reactivated, a new login works', () =>
  withPair(async ({ A, B }) => {
    const { who, store } = await storeActor('h1');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    assert.equal((await A.witness(s, STORE_WITNESS_PATH)).status, 200);
    await setStore(store, 'suspended');
    await refusedWith(B, await B.witness(s, STORE_WITNESS_PATH), 401, 'session_admission_denied', 'the next request while suspended');
    assert.deepEqual(await liveLabels(who, lab), [], 'the session ended, not merely refused');
    await refusedWith(A, await A.login(who), 401, 'login_admission_denied', 'no login under a suspended store');
    await setStore(store, 'active');
    const fresh = await A.signIn(who);
    assert.equal((await B.witness(fresh, STORE_WITNESS_PATH)).status, 200);
  }));

test('M5T-H2: a store suspended and reactivated while a store session is idle: 401 session_version_mismatch, never revived (DA-41)', () =>
  withPair((pair) => idleAcross(pair, storeActor('h2'), async ({ store }) => {
    await setStore(store, 'suspended');
    await setStore(store, 'active');
  }, STORE_WITNESS_PATH)));

/** A store moved to `tenant` by the owner, committed. */
const reparent = (store, tenant) => committed('store re-parented', (sql) => sql`update public.store set tenant_id = ${tenant} where store_id = ${store}`);
/** `table`'s row deleted and inserted again under its key, every column as it was, by the owner running as a replica. */
const reinsertedAsReplica = (table, key, id) => committed(`${table} deleted and re-inserted as a replica`, async (sql) => {
  await sql`set local session_replication_role = replica`;
  const [{ row }] = await sql`select pg_catalog.to_jsonb(r)::text as row from ${sql(table)} r where ${sql(key)} = ${id}`;
  await sql`delete from ${sql(table)} where ${sql(key)} = ${id}`;
  await sql`insert into ${sql(table)} select * from pg_catalog.jsonb_populate_record(null::${sql(table)}, ${row}::text::jsonb)`;
});

test('M5T-H3: a store moved to another tenant and back by the owner while a store session is idle: 401 session_version_mismatch, never revived', () =>
  withPair((pair) => idleAcross(pair, storeActor('h3'), async ({ tenant, store }) => {
    await reparent(store, await newTenant('h3-elsewhere'));
    await reparent(store, tenant);
  }, STORE_WITNESS_PATH)));

test('M5T-H4: a store deleted and re-inserted as a replica, naming its old access version, while a store session is idle: 401 session_version_mismatch, never revived', () =>
  withPair((pair) => idleAcross(pair, storeActor('h4'), async ({ store }) => {
    await reinsertedAsReplica('public.store', 'store_id', store);
  }, STORE_WITNESS_PATH)));

test('M5T-H5: the tenant row deleted and re-inserted as a replica while a store session is idle: 401 session_version_mismatch, never revived', () =>
  withPair((pair) => idleAcross(pair, storeActor('h5'), async ({ tenant }) => {
    await reinsertedAsReplica('public.tenant', 'tenant_id', tenant);
  }, STORE_WITNESS_PATH)));

test('M5T-H6: another store of the same tenant moved away and back while a store session is idle: served, its witness unchanged', () =>
  withPair(async ({ A, B }) => {
    const { who, tenant } = await storeActor('h6');
    const unrelated = await newStore(tenant, 'h6-unrelated');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const bound = await witnessOf(s.key);
    await reparent(unrelated, await newTenant('h6-elsewhere'));
    await reparent(unrelated, tenant);
    const served = await B.witness(s, STORE_WITNESS_PATH);
    assert.equal(served.status, 200, `a store no grant of this actor names moved nothing it is bound to: ${served.body}`);
    assert.equal(await witnessOf(s.key), bound);
    assert.deepEqual(await liveLabels(who, lab), ['K1']);
  }));

test('M5T-H7: a store suspension committed after a store login\'s admission read: 401 login_standing_changed, nothing created or recorded', () =>
  withPair(async ({ A }) => {
    const { who, store } = await storeActor('h7');
    const lab = labeller();
    const total = await tenantRecordTotal();
    const gate = A.gates.arm('admitAfter', who.uid);
    const pending = A.login(who);
    await entered(gate, 'the login past its admission read');
    await setStore(store, 'suspended');
    gate.release.resolve();
    await refusedWith(A, await pending, 401, 'login_standing_changed', 'design §1: the store changed before establish re-read it');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), [], 'no session created');
    assert.equal(await tenantRecordTotal(), total, 'no login recorded');
  }));

test('M5T-H8: a store login parked inside its transaction: the store suspension waits for its COMMIT; the login is 200 and its next request 401', (t) =>
  withPair(async ({ A, B }) => {
    const { who, store } = await storeActor('h8');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const h = await holdSession(s.key);
    const pending = B.login(who, { cookie: s.cookie });
    const loginPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_SESSION_ROW }),
      'the login waiting on its presented session inside its transaction');
    const suspension = write('store suspended', (sql) => sql`update public.store set status = 'suspended' where store_id = ${store}`);
    const r = await outcomeOf(suspension);
    assert.ok(r?.blocked && r.blockers.includes(loginPid), `design §1: the store suspension must wait for the login's COMMIT (${j(r)})`);
    assert.equal(await h.commit(), 'committed');
    const reply = await replyTo(pending, 'login');
    assert.equal(reply.status, 200, `${reply.status} ${await B.reason(reply)}`);
    const successor = B.sessionOf(reply);
    lab.name('K2', successor.key);
    assert.equal(await within(suspension.done, 'store suspension'), 'committed');
    await waitIdle();
    const records = await assertRecords(who, lab, ['login:K1', 'login:K2<-K1'], 'the login rotated K1 and was recorded');
    await assertCommitOrder(t, 'login before store suspension', records.find((x) => x.session === 'K2').xid, r.xid);
    await refusedWith(A, await A.witness(successor, STORE_WITNESS_PATH), 401, 'session_admission_denied', 'the store suspension then takes effect');
    assert.deepEqual(await liveLabels(who, lab), []);
  }));

// ---------------------------------------------------------------------------
// M5T-I: outages
// ---------------------------------------------------------------------------

test('M5T-I1: the tenant admission read unanswerable: login and requests are a bounded 503 that revokes nothing; restored, the session works', (t) =>
  withPair(async ({ A, B }) => {
    const { who } = await tenantActor('i1');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    t.diagnostic(`faulting ${ADMIT_READ}`);
    await owner.unsafe(`revoke execute on function ${ADMIT_READ} from tmpos_app`);
    try {
      const reply = await A.login(who, { cookie: s.cookie });
      await refusedWith(A, reply, 503, 'admission_unavailable', 'a login during the outage');
      assert.equal(reply.headers['set-cookie'], undefined);
      await refusedWith(B, await B.witness(s), 503, 'admission_unavailable', 'a protected request during the outage');
      assert.deepEqual(await liveLabels(who, lab), ['K1'], 'nothing revoked');
    } finally {
      await owner.unsafe(`grant execute on function ${ADMIT_READ} to tmpos_app`);
    }
    assert.equal((await B.witness(s)).status, 200, 'restored: the session works');
  }));

test('M5T-I2: the standing hold unanswerable: the login is a bounded 503, the presented session intact, nothing written', async (t) => {
  if (!TARGET) {
    t.skip(`migration 016 is not on disk here: ${HOLD_STANDING} does not exist, so there is no standing hold to fault`);
    return;
  }
  assert.ok(HAS_HOLD, `design §2f: ${HOLD_STANDING} exists`);
  await withPair(async ({ A, B }) => {
    const { who } = await tenantActor('i2');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const total = await tenantRecordTotal();
    await owner.unsafe(`revoke execute on function ${HOLD_STANDING} from tmpos_app`);
    try {
      const reply = await B.login(who, { cookie: s.cookie });
      await refusedWith(B, reply, 503, 'session_unavailable', 'design §4: the login\'s transaction could not hold the standing');
      assert.equal(reply.headers['set-cookie'], undefined);
      await waitIdle();
      assert.deepEqual(await liveLabels(who, lab), ['K1'], 'no new session, the presented one intact');
      assert.equal((await A.witness(s)).status, 200, 'the presented session still works: reads never take the hold');
    } finally {
      await owner.unsafe(`grant execute on function ${HOLD_STANDING} to tmpos_app`);
    }
    assert.equal(await tenantRecordTotal(), total, 'nothing recorded for the refused login');
  });
});

test('M5T-I3: the session read unanswerable: every tenant session operation is a bounded 503 that revokes nothing; restored, it works', () =>
  withPair(async ({ A, B }) => {
    const { who } = await tenantActor('i3');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    await owner.unsafe(`revoke execute on function ${SESSION_GET} from tmpos_app`);
    try {
      await refusedWith(B, await B.witness(s), 503, 'session_unavailable', 'a protected request');
      await refusedWith(A, await A.current(s), 503, 'session_unavailable', 'the current session');
      await refusedWith(A, await A.reauth(who, s), 503, 'session_unavailable', 'a recent sign-in');
      const lo = await B.logout(s);
      await refusedWith(B, lo, 503, 'session_unavailable', 'a logout');
      assert.equal(lo.headers['set-cookie']?.[0], CLEARED_COOKIE, 'the logout still clears the cookie');
      await waitIdle();
      assert.deepEqual(await liveLabels(who, lab), ['K1'], 'nothing revoked, nothing created');
    } finally {
      await owner.unsafe(`grant execute on function ${SESSION_GET} to tmpos_app`);
    }
    assert.equal((await B.witness(s)).status, 200, 'restored: the session works');
  }));

// I4 and J5 use a tenant-grant actor only: the audit write and the COMMIT are the session store's establish, which
// holds and re-reads whatever grants the actor has — a store-grant actor takes the same statements (H7/H8).
test('M5T-I4: an audit record that cannot be written (a raising trigger, a revoked INSERT) fails the login closed: 503, presented intact, no session', () =>
  withPair(async ({ A }) => {
    for (const fault of ['raise', 'revoked']) {
      const { who } = await tenantActor(`i4-${fault}`);
      const lab = labeller();
      const s = await A.signIn(who);
      lab.name('K1', s.key);
      const total = await tenantRecordTotal();
      const reply = await withAuditFault(fault, () => A.login(who, { cookie: s.cookie }));
      await refusedWith(A, reply, 503, 'session_unavailable', `${fault}: design §4, the login and its record commit together or not at all`);
      assert.equal(reply.headers['set-cookie'], undefined, `${fault}: no cookie`);
      await waitIdle();
      assert.deepEqual(await liveLabels(who, lab), ['K1'], `${fault}: no new session, the presented one intact`);
      assert.equal((await A.witness(s)).status, 200, `${fault}: the presented session still works`);
      assert.equal(await tenantRecordTotal(), total, `${fault}: nothing recorded for the refused login`);
    }
  }));

// ---------------------------------------------------------------------------
// M5T-J: the records
// ---------------------------------------------------------------------------

test('M5T-J1: a recent sign-in writes one tenant.session.reauthenticate record naming the session it replaced', () =>
  withPair(async ({ A, B }) => {
    const { who } = await tenantActor('j1');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const reply = await B.reauth(who, s);
    assert.equal(reply.status, 200, `${reply.status} ${await B.reason(reply)}`);
    const successor = B.sessionOf(reply);
    lab.name('K2', successor.key);
    const line = await B.line(reply);
    await assertRecords(who, lab, ['login:K1', 'reauthenticate:K2<-K1'], 'one login, one recent sign-in');
    const row = await recordOf('reauthenticate', successor.key);
    assertRecordRow(row, 'reauthenticate', who.id, line?.operationId);
    assert.deepEqual(row.metadata, { sessionRef: refOf(successor.key), replacedSessionRef: refOf(s.key), authenticatedAt: await boundAt(successor.key) });
    await refusedWith(A, await A.witness(s), 401, 'session_unknown', 'the replaced session ended with it');
    assert.equal((await A.witness(successor)).status, 200);
  }));

test('M5T-J2: a logout on another instance writes one tenant.session.logout record: no actor, the login record\'s session reference', () =>
  withPair(async ({ A, B }) => {
    const { who } = await tenantActor('j2');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const lo = await B.logout(s);
    assert.equal(lo.status, 204, lo.body);
    const line = await B.line(lo);
    assert.equal(await B.reason(lo), '-', 'the logout ended a live session');
    await assertRecords(who, lab, ['login:K1', 'logout:K1'], 'one login, one logout');
    const row = await recordOf('logout', s.key);
    assertRecordRow(row, 'logout', null, line?.operationId);
    assert.deepEqual(row.metadata, { sessionRef: refOf(s.key) }, 'a logout carries the session reference alone');
    assert.equal(row.metadata.sessionRef, (await recordOf('login', s.key)).metadata.sessionRef, 'the same session the login recorded');
  }));

test('M5T-J3: no refusal writes a record: header, mismatch, absent, stale and denied logins leave the records and the sessions as they were', () =>
  withPair(async ({ A }) => {
    const mine = await tenantActor('j3');
    const other = await tenantActor('j3-other');
    const lab = labeller();
    const s = await A.signIn(mine.who);
    const o = await A.signIn(other.who);
    lab.name('K1', s.key);
    lab.name('O1', o.key);
    const total = await tenantRecordTotal();
    const never = { cookie: `${SESSION_COOKIES.tenant}=${'A'.repeat(43)}` };
    await refusedWith(A, await A.login(mine.who, { cookie: s.cookie, [REAUTHENTICATE_HEADER]: '2' }), 401, 'login_reauth_header_invalid', 'header');
    await refusedWith(A, await A.reauth(mine.who, o), 401, 'login_reauth_mismatch', 'another actor\'s session presented');
    await refusedWith(A, await A.reauth(mine.who, never), 401, 'login_reauth_no_session', 'no session presented');
    assert.deepEqual([await liveLabels(mine.who, lab), await liveLabels(other.who, lab)], [['K1'], ['O1']], 'nothing created or ended');
    await committed('role change', (sql) => sql`update user_membership set role_id = 'manager' where membership_id = ${mine.grant}`);
    await refusedWith(A, await A.reauth(mine.who, s), 401, 'login_reauth_stale_version', 'a session admitted before the change');
    assert.deepEqual(await liveLabels(mine.who, lab), ['K1'], 'left for its next request to end');
    await committed('account suspended', (sql) => sql`update app_user set status = 'suspended' where internal_user_id = ${other.who.id}`);
    await refusedWith(A, await A.login(other.who), 401, 'login_admission_denied', 'an account admission refuses');
    await waitIdle();
    assert.equal(await tenantRecordTotal(), total, 'the five refusals wrote no record of any actor or session');
  }));

test('M5T-J4: under an audit fault a logout still ends the session — 204, cookie cleared, row gone — writes no record, and logs it unconfirmed', () =>
  withPair(async ({ A }) => {
    for (const fault of ['raise', 'revoked']) {
      const { who } = await tenantActor(`j4-${fault}`);
      const lab = labeller();
      const s = await A.signIn(who);
      lab.name('K1', s.key);
      const total = await tenantRecordTotal();
      const reply = await withAuditFault(fault, () => A.logout(s));
      assert.equal(reply.status, 204, `${fault}: ${reply.body}`);
      assert.equal(reply.headers['set-cookie']?.[0], CLEARED_COOKIE, `${fault}: cookie cleared`);
      await waitIdle();
      assert.deepEqual(await liveLabels(who, lab), [], `${fault}: the row is gone`);
      const line = await A.line(reply);
      assert.equal(line?.reason, 'logout_audit_unconfirmed', `${fault}: design §4, the log says the record is unconfirmed`);
      const warned = A.records().filter((r) => r.event === 'session_logout_audit_unconfirmed' && r.requestId === line.requestId);
      assert.equal(warned.length, 1, `${fault}: one warning`);
      assert.equal(warned[0].level, 'warn');
      assert.equal(warned[0].operationId, line.operationId);
      assert.equal(await tenantRecordTotal(), total, `${fault}: no logout record`);
      await refusedWith(A, await A.witness(s), 401, 'session_unknown', `${fault}: the cookie is no session`);
    }
  }));

test('M5T-J5: a login whose COMMIT answer is lost is a 503 with no cookie; the undelivered session and its record exist', () =>
  withRelayed(async (A) => {
    const { who } = await tenantActor('j5');
    const trap = loseCommitAnswer(A.relay);
    let reply;
    try {
      reply = await A.login(who);
    } finally {
      trap.release();
    }
    assert.equal(reply.status, 503, `design §4: outcome unknown: ${reply.status} ${reply.body}`);
    assert.equal(trap.silenced.length, 1, 'one COMMIT reached the server, and its answer was dropped');
    assert.equal(reply.headers['set-cookie'], undefined, 'no cookie: nobody holds the new session\'s identifier');
    const line = await A.line(reply);
    assert.equal(line?.reason, 'session_timeout', 'the outcome was unknown at the port deadline');
    let rows = [];
    for (const until = Date.now() + 5_000; rows.length === 0 && Date.now() < until; await tick()) {
      rows = await probe`select request_id, metadata from public.audit_event
        where action_id = ${`${SESSION_ACTIONS}login`} and actor_internal_user_id = ${who.id}`;
    }
    assert.equal(rows.length, 1, 'the committed login\'s record');
    assert.equal(rows[0].request_id, line.operationId, 'joined to the 503 by the id this server generated');
    const live = await probe`select session_key from tmpos_session.session where auth_provider_uid = ${who.uid}`;
    assert.equal(live.length, 1, 'one session: the undelivered one');
    assert.equal(rows[0].metadata.sessionRef, refOf(live[0].session_key), 'the record names exactly the session that exists');
  }));

// ---------------------------------------------------------------------------
// M5T-K: two instances over one durable state
// ---------------------------------------------------------------------------

test('M5T-K1: a login on A and a logout on B: A refuses at once', () =>
  withPair(async ({ A, B }) => {
    const { who } = await tenantActor('k1');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    assert.equal((await A.witness(s)).status, 200);
    assert.equal((await B.logout(s)).status, 204);
    await refusedWith(A, await A.witness(s), 401, 'session_unknown', 'A, a protected request');
    await refusedWith(A, await A.current(s), 401, 'session_unknown', 'A, the current session');
    assert.deepEqual(await liveLabels(who, lab), []);
  }));

test('M5T-K2: a suspension refuses the session on both instances', () =>
  withPair(async ({ A, B }) => {
    const { who, tenant } = await tenantActor('k2');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    assert.equal((await B.witness(s)).status, 200);
    await setStatus(tenant, 'active', 'suspended');
    await refusedWith(B, await B.witness(s), 401, 'session_admission_denied', 'B revokes');
    await refusedWith(A, await A.witness(s), 401, 'session_unknown', 'A refuses at once');
    await refusedWith(A, await A.login(who), 401, 'login_admission_denied', 'and no login on A');
    assert.deepEqual(await liveLabels(who, lab), []);
  }));

test('M5T-K3: a recent sign-in on A against a logout on B, logout first: 401 login_reauth_no_session, nothing created', () =>
  withPair(({ A, B }) => logoutThenReauth(A, B, 'k3')));

test('M5T-K4: a recent sign-in on A against a logout on B, sign-in first: the logout ends nothing (204 logout_session_absent)', () =>
  withPair(({ A, B }) => reauthThenLogout(A, B, 'k4')));

// ---------------------------------------------------------------------------
// M5T-L: containment
// ---------------------------------------------------------------------------

test('M5T-L1: the witness routes stay harness-only: the production inventory serves no tenant path and the entry composes the admin boundary alone', () => {
  const declared = productionRouteDeclarations();
  const keys = declared.map((r) => `${r.method} ${r.path}`);
  for (const route of WITNESS_ROUTES) assert.ok(!keys.includes(`${route.method} ${route.path}`), `${route.path} is not declared by production`);
  assert.deepEqual(keys.filter((k) => / \/api\//.test(k)), [], 'no /api path in the production route declarations');
  assert.deepEqual(declared.filter((r) => ['tenant', 'store'].includes(r.policy?.authorization?.scope)).map((r) => r.path), [],
    'no tenant- or store-scope requirement in production');
  assert.ok(uncataloguedRoutePermissions(WITNESS_ROUTES).includes('route_permission_undecidable'),
    'the production composition would refuse the witness routes');
  const served = SHIPPING_ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(served.filter((k) => / \/api\//.test(k)), [], 'the entry serves no tenant path');
  const adminPaths = sessionPaths('admin');
  const tenantPaths = sessionPaths('tenant');
  assert.ok(served.includes(`POST ${adminPaths.login}`) && served.includes(`POST ${adminPaths.logout}`), 'the admin session routes ship');
  for (const path of [tenantPaths.login, tenantPaths.current, tenantPaths.logout]) {
    assert.ok(!served.some((k) => k.endsWith(` ${path}`)), `${path} does not ship`);
  }
});
