// Phase 4.0 M5-ADMIN-REVOKE-P1 — ADMINISTRATIVE REVOCATION UNDER CONCURRENCY: the stage's ordering rule asserted against
// TWO separately composed production runtimes, REAL loopback sockets and one disposable PostgreSQL.
//
// THE RULE UNDER TEST (design §1). Every administrative change — a logout, a revocation, a grant removal or restoration, an
// account-status change, an identity-link insert or an identity-anchor change — takes effect when its transaction COMMITS.
//   * R-READ: a protected request's session is decided by its session read and its authority by its admission read; a
//     change committed before the read refuses it (401), a request whose reads both preceded the change may complete (200),
//     and nothing it does afterwards — its idle refresh included — recreates a session that was deleted.
//   * R-COMMAND: a tenant-management command holds the actor's account row, identity links and grants (009) and the
//     presented session row until its COMMIT, and re-reads admission under them: a change committed first refuses it
//     (503 transaction_unavailable, nothing committed); a change not yet committed waits for the command's COMMIT.
//   * R-LOGIN: a login or recent sign-in takes effect when establish commits; standing that changed after its admission
//     read refuses it (401 login_standing_changed), and a recent sign-in whose presented session this transaction did not
//     end creates nothing (401 login_reauth_no_session).
//   * An outage anywhere is a bounded 503 that revokes nothing; a revoked cookie never becomes valid again; a logout
//     presenting a cookie a concurrent recent sign-in already rotated ends nothing (204, no record).
//
// WHAT IS COMPOSED HERE IS PRODUCTION'S. Each instance is composed on its own, exactly as the deployable entry composes
// one: composeProductionTransactions(env, client) — the production root over PRODUCTION_INVENTORY with the factories
// production ships (never a hand-copied factory table), so the command revalidator, the session store and its establish
// check, 013's admission read and 012's directory are exactly what an entry serves — over its OWN supervised kernel of four
// one-connection pools; the session root is assembleSessions over durableSessionAdapters, the one table production binds
// the administrative admission and its authorizer through; createApp serves the result through createBoundedServer on
// 127.0.0.1. Two instances are two roots, two kernels and two listeners over one database, composed afresh for every test.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY. Four things, none of them inside a transaction under test:
//   * THE DATABASE CLIENT. The constructor is handed the classified endpoint of a synthetic direct URL (it only has to pass
//     classification) and returns instead a supervised kernel over the disposable cluster, as a non-owner runtime LOGIN
//     holding tmpos_app and tmpos_audit_writer and nothing else — the posture G-DBROLE provisions.
//   * THE IDENTITY VERIFIER. A bearer token maps to a synthetic provider reference, authenticated now with a TOTP second
//     factor. Everything after that point is the composed production path.
//   * THE RATE LIMITER. The testkit's in-memory limiter, fresh for every instance of every test, so no test's logins spend
//     another's budget; the PostgreSQL limiter is proved in tests/db/rateLimitRuntime.integration.test.mjs.
//   * TWO PASS-THROUGH GATES, on the session root's side only: the session store's get and update and the platform
//     admission read, as the session root receives them. Each calls the composed port unchanged and only holds ONE armed
//     call (named by session key or provider reference) until the scenario releases it. The command's and establish's own
//     reads run over the root's client inside their transactions and are never wrapped.
//
// SCHEDULING IS CONDITION-BASED. A competing write happens only once pg_stat_activity shows the runtime backend waiting on
// a Lock held by the named backend (pg_blocking_pids), or once a gate reports its call arrived; every wait is bounded and a
// timeout fails with "lever did not engage", never a pass. Nothing sleeps for synchronization.
//
// COMMIT ORDER. The cluster this file creates is restarted with track_commit_timestamp on before any client connects, and
// order is then also asserted from pg_xact_commit_timestamp. A bound service (CI's) is never reconfigured: there, order is
// asserted through the lock wait alone — the later writer was observed waiting on the earlier one's backend.
//
// DISPOSABLE ONLY. The target is whatever the harness resolves — a supplied disposable target or a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Fixtures are synthetic and randomly named;
// every actor and tenant a test changes is its own, and every privilege a test revokes is granted back before it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveDisposableTarget, testClient, testDriver, childEnv } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { composeProductionTransactions } from '../../server/composition/productionTransactions.ts';
import { assembleSessions, durableSessionAdapters } from '../../server/composition/productionSessions.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { testRequestLimits } from '../../server/runtime/rateLimiter.testkit.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { REAUTHENTICATE_HEADER, REAUTHENTICATE_VALUE, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { TENANT_DISPLAY_NAME_EVENTS } from '../../server/runtime/tenantDisplayName.ts';
import { TENANT_STATUS_EVENTS, TENANT_STATUS_PATH } from '../../server/runtime/tenantStatus.ts';
import { TENANT_DIRECTORY_PATH } from '../../server/runtime/tenantDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5r-migrator', runtimeRef: 'm5r-runtime' };
const LOCK_KEY = 528_518;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m5r_probe';
const TENANT_ORIGIN = 'http://pos.trusted.test';
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const REASON = 'Synthetic proof of administrative revocation ordering.';
/** Four one-connection pools per instance: two instances, the owner and the observer stay inside a 20-connection cluster. */
const KERNEL_MAX = 4;
/** The bound on every lever and every awaited outcome. */
const WAIT_MS = 10_000;
const SESSION_GET = 'tmpos_session.m5_session_get(text, bigint)';
const ADMIT_READ = 'tmpos_admission.m5_admit_platform_session(text, text)';
const AT_009 = /m5_revalidate_platform_authority/;
const AT_MUTATOR = /m5_tenant_status_change/;
const AT_TOUCH = /m5_session_touch/;
const SESSION_ACTIONS = 'platform.admin.session.';

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

const TARGET = resolveDisposableTarget('M5R');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

if (cluster !== null) {
  // Commit timestamps make commit ORDER observable. Only a cluster this file created is reconfigured, and it is restarted
  // before any client connects; the harness still stops and removes it.
  appendFileSync(join(cluster.root, 'data', 'postgresql.conf'), '\ntrack_commit_timestamp = on\n');
  execFileSync('pg_ctl', ['--pgdata', join(cluster.root, 'data'), '--log', join(cluster.root, 'postgres.log'),
    '--timeout', '60', '-w', '-m', 'fast', 'restart'], { env: childEnv(undefined), stdio: 'ignore' });
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
const owner = testClient(TARGET, { max: 6, onnotice: () => {} });
/** The observer: pg_stat_activity polls and every evidence read, on its own connection. */
const probe = testClient(TARGET, { max: 1, onnotice: () => {} });
const INSTANCES = new Set();

test.after(async () => {
  for (const instance of [...INSTANCES]) await instance.close().catch(() => {});
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

const COMMIT_TS = (await probe`select current_setting('track_commit_timestamp') as v`)[0].v === 'on';

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
/** Holds and owner writes a failing test may leave open; withPair settles every one before it closes the instances. */
const OPEN = new Set();

// ---------------------------------------------------------------------------
// the two instances
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
/** The kernel constructor handed to composeProductionTransactions: the disposable cluster, as the runtime login. */
function kernel() {
  kernelsBuilt += 1;
  return createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max: KERNEL_MAX, idle_timeout: 0, user: RUNTIME_LOGIN,
  });
}

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

function send(port, method, path, headers = {}, body) {
  const payload = body === undefined ? undefined : Buffer.from(body);
  const framed = method === 'GET' ? headers : { 'content-length': String(payload?.length ?? 0), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: framed, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
const refOf = (key) => createHash('sha256').update(`tmpos-audit-session-ref:v1\n${key}`).digest('base64url');

/** One runtime instance, composed from its configuration exactly as an entry composes one, and served. */
async function compose(label) {
  const tx = composeProductionTransactions(CONFIGURED_ENV, kernel);
  const gates = gateBox();
  const refreshes = [];
  const inner = tx.sessionStore;
  const store = Object.freeze({
    ...inner,
    get: async (key, signal) => { await gates.pass('get', key); return inner.get(key, signal); },
    update: (key, fields, signal) => {
      const p = gates.pass('update', key).then(() => inner.update(key, fields, signal));
      refreshes.push({ key, settled: p.then(() => 'ok', (e) => `threw:${e?.message ?? e}`) });
      return p;
    },
  });
  const platform = tx.platformAdmission;
  const platformAdmission = Object.freeze({
    ...platform,
    admit: async (principal, signal) => {
      await gates.pass('admitBefore', principal.authProviderUid);
      const answer = await platform.admit(principal, signal);
      await gates.pass('admitAfter', principal.authProviderUid);
      return answer;
    },
  });
  const limits = testRequestLimits();
  const sessions = assembleSessions({
    origins: ORIGINS, verifier: VERIFIER, trustedProxies: limits.trustedProxies, keySecret: limits.keySecret,
    ...durableSessionAdapters({ store, tenantAdmission: tx.tenantAdmission, platformAdmission }),
    limiter: limits.limiter,
  });
  const logs = [];
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line) => { logs.push(line); } }, routes: tx.routes, limits: sessions.limits,
    idempotency: tx.idempotency, transactions: tx.transactions, events: EVENTS, sessions: sessions.sessions,
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const loginHeaders = (who) => ({
    origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer tok-${who.uid}`,
  });
  const unsafe = (s) => ({
    origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, [SESSION_CSRF_HEADER]: s.csrf, cookie: s.cookie,
  });
  const sessionOf = (reply) => {
    const cookie = (reply.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    return { cookie, csrf: JSON.parse(reply.body).csrfToken, key: keyOf(cookie) };
  };
  const login = (who, extra = {}) => quietly(send(port, 'POST', sessionPaths('admin').login, { ...loginHeaders(who), ...extra }));
  let closed = false;
  const instance = {
    label, tx, logs, gates, refreshes, sessionOf, login,
    reauth: (who, s) => login(who, { cookie: s.cookie, [REAUTHENTICATE_HEADER]: REAUTHENTICATE_VALUE }),
    async signIn(who) {
      const reply = await login(who);
      assert.equal(reply.status, 200, `admin login for ${who.uid} on ${label}: ${reply.body}`);
      return sessionOf(reply);
    },
    logout: (s) => quietly(send(port, 'POST', sessionPaths('admin').logout, unsafe(s))),
    current: (s) => quietly(send(port, 'GET', sessionPaths('admin').current, { cookie: s.cookie })),
    list: (s) => quietly(send(port, 'GET', `${TENANT_DIRECTORY_PATH}?limit=5`, { cookie: s.cookie })),
    status: (s, body) => quietly(send(port, 'PATCH', TENANT_STATUS_PATH, {
      ...unsafe(s), 'content-type': 'application/json', 'idempotency-key': randomUUID(),
    }, JSON.stringify(body))),
    /** The refusal the runtime LOGGED for one reply, found by its request id ('-' when it logged none). */
    async reason(reply) {
      const id = reply.headers['x-request-id'];
      const until = Date.now() + WAIT_MS;
      while (Date.now() < until) {
        for (const line of logs) {
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (record.event === 'request' && record.requestId === id) return record.reason ?? '-';
        }
        await tick();
      }
      return 'NO_LOG_LINE';
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

/** Two instances for one test, closed after it — with every lever it left open settled first. */
async function withPair(fn) {
  const A = await compose('A');
  const B = await compose('B');
  try {
    await fn({ A, B });
  } finally {
    for (const open of [...OPEN]) if (open.settle) await open.settle();
    A.gates.releaseAll();
    B.gates.releaseAll();
    for (const open of [...OPEN]) await within(open.done, open.label);
    await A.close();
    await B.close();
  }
}

// ---------------------------------------------------------------------------
// fixtures and observations
// ---------------------------------------------------------------------------

async function actor(label, memberships) {
  const uid = `m5r-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  TOKENS.set(`tok-${uid}`, uid);
  return { id, uid };
}
const admin = (label) => actor(label, [{ scope: 'platform', role: 'system_owner' }]);
const newTenant = async (label) =>
  (await owner`insert into tenant (display_name) values (${`m5r-${label}-${SUFFIX}`}) returning tenant_id`)[0].tenant_id;
const grantOf = async (who) =>
  (await owner`select membership_id from user_membership where internal_user_id = ${who.id} and scope_type = 'platform'`)[0].membership_id;
const suspend = (tenant, expectedVersion) => ({ tenantId: tenant, status: 'suspended', reason: REASON, expectedVersion });
const authorityOf = async (who) => BigInt((await probe`select coalesce((select authority_version
    from tmpos_admission.platform_authority_version where internal_user_id = ${who.id}), 0)::text as v`)[0].v);
const witnessOf = async (key) => (await probe`select security_version from tmpos_session.session where session_key = ${key}`)[0]?.security_version;

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
/** Every session row the principal holds, as labels — the rows the runtime role acts on, read as the owner. */
async function liveLabels(who, lab) {
  return (await probe`select session_key from tmpos_session.session where auth_provider_uid = ${who.uid}`)
    .map((r) => lab.key(r.session_key)).sort();
}
/** Every administrative-session record naming this actor or one of the labelled sessions, with its transaction. */
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
/** The tenant row, the command's audit records and its outbox events. */
async function tenantState(tenant) {
  const [row] = await probe`select status, row_version::int as rv from public.tenant where tenant_id = ${tenant}`;
  const audits = await probe`select action_id, xmin::text as xid from public.audit_event where subject_tenant_id = ${tenant}`;
  const [{ n }] = await probe`select count(*)::int as n from tmpos_internal.outbox_event where aggregate_id = ${tenant}`;
  return { status: row.status, rv: row.rv, audits: audits.map((a) => ({ action: a.action_id, xid: a.xid })), events: n };
}
const shapeOf = (s) => ({ status: s.status, rv: s.rv, audits: s.audits.length, events: s.events });
function assertUnchanged(before, after, why) {
  assert.deepEqual(shapeOf(after), shapeOf(before), `${why}: nothing committed — tenant row, audit and events as before`);
}
function assertChangedOnce(before, after, why) {
  assert.deepEqual(shapeOf(after), { status: 'suspended', rv: before.rv + 1, audits: before.audits.length + 1, events: before.events + 1 },
    `${why}: the command committed exactly once`);
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
// levers: owner-held locks and competing owner writes, observed through pg_stat_activity
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
const holdAccount = (who) => hold('app_user A for update', (sql) => sql`select 1 from public.app_user where internal_user_id = ${who.id} for update`);
const holdTenant = (tenant) => hold('tenant T for update', (sql) => sql`select 1 from public.tenant where tenant_id = ${tenant} for update`);
const holdSession = (key) => hold('session K1 for update', (sql) => sql`select 1 from tmpos_session.session where session_key = ${key} for update`);

/** A committed owner write: its transaction (pid, xid) once started, and 'committed' | 'failed:...' once settled. */
function ownerWrite(label, fn) {
  const started = deferred();
  const done = owner.begin(async (sql) => {
    const [{ pid, xid }] = await sql`select pg_backend_pid() as pid, pg_current_xact_id()::text as xid`;
    started.resolve({ pid, xid });
    await fn(sql);
  }).then(() => 'committed', (e) => `failed:${e?.message ?? e}`);
  const write = { label, done, started: Promise.race([started.promise, done.then((v) => ({ early: v }))]) };
  OPEN.add(write);
  done.then(() => OPEN.delete(write));
  return write;
}
/** Wait until an owner write settles or waits on a Lock: { settled, xid } | { blocked, blockers, xid } | null (bound). */
async function ownerOutcome(write) {
  const s = await write.started;
  if ('early' in s) return { settled: s.early };
  let settled = null;
  write.done.then((v) => { settled = v; });
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
/** An owner write that must commit at once: its xid. */
async function committed(label, fn) {
  const write = ownerWrite(label, fn);
  const outcome = await within(write.done, label);
  assert.equal(outcome, 'committed', `${label}: ${j(outcome)}`);
  return (await write.started).xid;
}

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
    if (n === 0) return true;
    await tick();
  }
  return false;
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
// M5R-00: the composition itself
// ---------------------------------------------------------------------------

test('M5R-00: every migration on disk is applied, and two instances are two production roots over two kernels', async (t) => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const onDisk = readdirSync(MIG_DIR).filter((f) => /^\d{3}_.+\.up\.sql$/.test(f)).map((f) => f.slice(0, 3)).sort();
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), onDisk.map((v) => [v, false]), 'the ledger is exactly the migrations on disk');
  t.diagnostic(`ledger ${onDisk[0]}..${onDisk.at(-1)}; track_commit_timestamp=${COMMIT_TS ? 'on' : 'off'}`);
  const before = kernelsBuilt;
  await withPair(async ({ A, B }) => {
    assert.equal(kernelsBuilt - before, 2, 'each instance asked the production root for its own kernel');
    assert.notEqual(A.tx, B.tx, 'two separately composed roots');
    for (const inst of [A, B]) {
      // Only the production factory table builds the entry's startup preflight: this is composeProductionTransactions.
      assert.notEqual(inst.tx.preflight, null, `${inst.label}: composed through the production factories`);
    }
    const who = await admin('00');
    const s = await A.signIn(who);
    assert.equal((await B.current(s)).status, 200, 'a session issued through A is served by B: one durable store');
  });
});

// ---------------------------------------------------------------------------
// M5R-01..02: R-READ
// ---------------------------------------------------------------------------

test('M5R-01: two requests revalidating one session on two instances across a grant removal: 200 only if decided before, never revived', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('01');
    const grant = await grantOf(who);
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const late = A.gates.arm('admitBefore', who.uid); // request 1 (A): session read done, admission read held
    const refresh = B.gates.arm('update', s.key); // request 2 (B): both reads done, its idle refresh held
    const pending = A.list(s);
    await entered(late, 'request 1 reaching its admission read');
    const early = await B.list(s);
    assert.equal(early.status, 200, 'request 2 decided both reads before the removal');
    await entered(refresh, "request 2's idle refresh");
    const removal = await committed('grant removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
    late.release.resolve();
    await refusedWith(A, await pending, 401, 'session_admission_denied', 'request 1 read admission after the removal committed');
    refresh.release.resolve();
    assert.equal(await B.refreshOf(s.key), 'ok', 'the held refresh ran (and found nothing to touch)');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), [], 'final: no session; the late refresh recreated nothing');
    for (const inst of [A, B]) await refusedWith(inst, await inst.current(s), 401, 'session_unknown', `${inst.label}: the cookie stays dead`);
    await assertRecords(who, lab, ['login:K1'], 'a revocation by admission records nothing');
    t.diagnostic(j({ removalXid: removal, request2: early.status }));
  }));

test('M5R-02a: a logout committed on A before B reads the session refuses B (401 session_unknown)', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('02a');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const gate = B.gates.arm('get', s.key);
    const pending = B.list(s);
    await entered(gate, "B's request reaching its session read");
    const lo = await A.logout(s);
    assert.equal(lo.status, 204, 'the logout committed first');
    gate.release.resolve();
    await refusedWith(B, await pending, 401, 'session_unknown', 'the session read came after the logout committed');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), []);
    const records = await assertRecords(who, lab, ['login:K1', 'logout:K1'], 'one login, one logout');
    t.diagnostic(j(records));
  }));

test('M5R-02b: a grant removal, account suspension or anchor repoint committed before the admission read refuses (401 session_admission_denied)', (t) =>
  withPair(async ({ A, B }) => {
    const CHANGES = [
      ['grant removed', (who) => (sql) => sql`update user_membership set status = 'suspended' where internal_user_id = ${who.id} and scope_type = 'platform'`],
      ['account suspended', (who) => (sql) => sql`update app_user set status = 'suspended' where internal_user_id = ${who.id}`],
      ['anchor repointed', (who) => (sql) => sql`update platform_identity set auth_provider_uid = ${`${who.uid}-moved`} where internal_user_id = ${who.id}`],
    ];
    for (const [i, [what, change]] of CHANGES.entries()) {
      const who = await admin(`02b-${i}`);
      const lab = labeller();
      const s = await A.signIn(who);
      lab.name('K1', s.key);
      const gate = B.gates.arm('admitBefore', who.uid);
      const pending = B.list(s);
      await entered(gate, `${what}: B's request reaching its admission read`);
      const xid = await committed(what, change(who));
      gate.release.resolve();
      await refusedWith(B, await pending, 401, 'session_admission_denied', `${what}: committed before the admission read`);
      await waitIdle();
      assert.deepEqual(await liveLabels(who, lab), [], `${what}: every administrative session of the principal ended`);
      await refusedWith(A, await A.current(s), 401, 'session_unknown', `${what}: A refuses it at once`);
      t.diagnostic(`${what}: change xid ${xid}; request 401 session_admission_denied; 0 sessions`);
    }
  }));

test('M5R-02c: a logout committing between a request\'s session read and its admission read may complete it; its refresh never recreates', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('02c');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const gate = B.gates.arm('admitBefore', who.uid);
    const pending = B.list(s);
    await entered(gate, "B's request between its two reads");
    const lo = await A.logout(s);
    assert.equal(lo.status, 204);
    gate.release.resolve();
    const reply = await pending;
    const reason = await B.reason(reply);
    assert.ok([200, 401].includes(reply.status), `${reply.status} ${reason}`);
    if (reply.status === 200) assert.equal(await B.refreshOf(s.key), 'ok', 'its refresh ran against the deleted row');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), [], 'nothing recreated the logged-out session');
    await refusedWith(B, await B.current(s), 401, 'session_unknown', 'the next request');
    await assertRecords(who, lab, ['login:K1', 'logout:K1'], 'one login, one logout');
    t.diagnostic(`in-between request: ${reply.status} ${reason} (design §1 R-READ permits 200)`);
  }));

// ---------------------------------------------------------------------------
// M5R-03, M5R-08c/d: R-COMMAND against a logout of the command's own session
// ---------------------------------------------------------------------------

/** A tenant status command on `cmd` racing a logout of its own session on `off`; `first` names who takes effect first. */
async function commandVsLogout(t, cmd, off, first) {
  const who = await admin(`cl-${first}-${cmd.label}${off.label}`);
  const tenant = await newTenant(`cl-${first}-${cmd.label}${off.label}`);
  const lab = labeller();
  const s = await cmd.signIn(who);
  lab.name('K1', s.key);
  const before = await tenantState(tenant);
  if (first === 'logout') {
    // The command is held BEFORE its session hold: the owner holds the actor's account row, so it waits at 009.
    const h = await holdAccount(who);
    const pending = cmd.status(s, suspend(tenant, before.rv));
    waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_009 }), 'the command waiting at 009 on the account row');
    const lo = await replyTo(off.logout(s), 'logout');
    assert.equal(lo.status, 204, `the logout committed while the command waited: ${j(lo)}`);
    assert.deepEqual(await liveLabels(who, lab), [], 'the session row is gone at the logout');
    assertUnchanged(before, await tenantState(tenant), 'at the logout');
    assert.equal(await h.commit(), 'committed');
    await refusedWith(cmd, await pending, 503, 'transaction_unavailable',
      'design §1 R-COMMAND: the logout committed before the command held its session — the command commits nothing');
    await waitIdle();
    const after = await tenantState(tenant);
    assertUnchanged(before, after, 'logout first');
    await refusedWith(cmd, await cmd.current(s), 401, 'session_unknown', 'the next request');
    const records = await assertRecords(who, lab, ['login:K1', 'logout:K1'], 'one login, one logout');
    t.diagnostic(j({ order: 'logout then command', tenant: after, records }));
    return;
  }
  // The command holds its session: the owner holds the tenant row, so it waits at its mutator, AFTER 009 and its session hold.
  const h = await holdTenant(tenant);
  const pending = cmd.status(s, suspend(tenant, before.rv));
  const cmdPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_MUTATOR }), 'the command waiting at its mutator');
  const logout = off.logout(s);
  const waited = await blockedOrSettled(logout, { by: cmdPid, query: AT_TOUCH });
  waitingPid(waited, "design §1 R-COMMAND (command first): the logout waiting on the command's hold of its session row");
  assert.equal(await h.commit(), 'committed');
  const reply = await pending;
  assert.equal(reply.status, 200, `the command took effect first: ${reply.status} ${await cmd.reason(reply)}`);
  const lo = await replyTo(logout, 'logout');
  assert.equal(lo.status, 204, `then the logout: ${j(lo)}`);
  assert.equal(await off.reason(lo), '-', 'the logout ended a live session (not logout_session_absent)');
  await waitIdle();
  const after = await tenantState(tenant);
  assertChangedOnce(before, after, 'command first');
  const records = await assertRecords(who, lab, ['login:K1', 'logout:K1'], 'one login, one logout');
  await assertCommitOrder(t, 'command before logout', after.audits[0].xid, records.find((r) => r.action === 'logout').xid);
  assert.deepEqual(await liveLabels(who, lab), []);
  await refusedWith(off, await off.current(s), 401, 'session_unknown', 'the next request');
  t.diagnostic(j({ order: 'command then logout', tenant: after }));
}

test('M5R-03a: logout first — a command waiting before its session hold commits nothing (503), the next request is 401', (t) =>
  withPair(({ A }) => commandVsLogout(t, A, A, 'logout')));

test('M5R-03b: command first — the logout waits on the command\'s session hold, then ends the session (200, then 204 with its record)', (t) =>
  withPair(({ A }) => commandVsLogout(t, A, A, 'command')));

// ---------------------------------------------------------------------------
// M5R-04: R-COMMAND against changes to the actor's standing
// ---------------------------------------------------------------------------

/** An admin, a tenant, a signed-in session on `inst`, and the tenant before any command. */
async function commandFixture(inst, label) {
  const who = await admin(label);
  const tenant = await newTenant(label);
  const grant = await grantOf(who);
  const lab = labeller();
  const s = await inst.signIn(who);
  lab.name('K1', s.key);
  return { who, tenant, grant, lab, s, before: await tenantState(tenant) };
}

test('M5R-04a: grant removal committed before the command\'s locks: 503, nothing committed; next request 401', (t) =>
  withPair(async ({ A }) => {
    const { who, tenant, grant, lab, s, before } = await commandFixture(A, '04a');
    const h = await holdAccount(who);
    const pending = A.status(s, suspend(tenant, before.rv));
    waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_009 }), 'the command waiting at 009');
    const removal = ownerWrite('removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
    const r = await ownerOutcome(removal);
    assert.equal(r?.settled, 'committed', `lever did not engage: the removal must commit while the command waits (${j(r)})`);
    assert.equal(await h.commit(), 'committed');
    await refusedWith(A, await pending, 503, 'transaction_unavailable', 'removal first: the command commits nothing');
    await waitIdle();
    assertUnchanged(before, await tenantState(tenant), 'removal first');
    await refusedWith(A, await A.current(s), 401, 'session_admission_denied', 'the next request');
    assert.deepEqual(await liveLabels(who, lab), []);
    t.diagnostic(j({ removalXid: r.xid }));
  }));

test('M5R-04b: command first — the grant removal waits for the command\'s COMMIT and takes effect after it', (t) =>
  withPair(async ({ A }) => {
    const { who, tenant, grant, lab, s, before } = await commandFixture(A, '04b');
    const h = await holdTenant(tenant);
    const pending = A.status(s, suspend(tenant, before.rv));
    const cmdPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_MUTATOR }), 'the command waiting at its mutator');
    const removal = ownerWrite('removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
    const r = await ownerOutcome(removal);
    assert.ok(r?.blocked && r.blockers.includes(cmdPid), `the removal must wait on the command (${j(r)})`);
    assert.equal(await h.commit(), 'committed');
    const reply = await pending;
    assert.equal(reply.status, 200, `${reply.status} ${await A.reason(reply)}`);
    assert.equal(await within(removal.done, 'removal'), 'committed');
    await waitIdle();
    const after = await tenantState(tenant);
    assertChangedOnce(before, after, 'command first');
    await assertCommitOrder(t, 'command before removal', after.audits[0].xid, r.xid);
    await refusedWith(A, await A.current(s), 401, 'session_admission_denied', 'the removal then takes effect');
    assert.deepEqual(await liveLabels(who, lab), []);
  }));

test('M5R-04c: grant removal AND restoration committed before the command\'s recheck: 503, nothing committed (was 200, R4)', (t) =>
  withPair(async ({ A }) => {
    const { who, tenant, grant, lab, s, before } = await commandFixture(A, '04c');
    const h = await holdAccount(who);
    const pending = A.status(s, suspend(tenant, before.rv));
    waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_009 }), 'the command waiting at 009');
    const av0 = await authorityOf(who);
    const removed = await ownerOutcome(ownerWrite('removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`));
    assert.equal(removed?.settled, 'committed', `lever did not engage: removal (${j(removed)})`);
    const restored = await ownerOutcome(ownerWrite('restoration', (sql) => sql`update user_membership set status = 'active' where membership_id = ${grant}`));
    assert.equal(restored?.settled, 'committed', `lever did not engage: restoration (${j(restored)})`);
    assert.equal(await authorityOf(who), av0 + 2n, 'each change moved the monotonic authority version');
    assert.equal(await h.commit(), 'committed');
    await refusedWith(A, await pending, 503, 'transaction_unavailable',
      'design §1 R-COMMAND: the witness moved before the command re-read admission — it commits nothing');
    await waitIdle();
    assertUnchanged(before, await tenantState(tenant), 'removal and restoration first');
    await refusedWith(A, await A.current(s), 401, 'session_version_mismatch', 'the next request');
    assert.deepEqual(await liveLabels(who, lab), []);
    t.diagnostic(j({ authorityVersion: `${av0} -> ${av0 + 2n}` }));
  }));

test('M5R-04d: an identity-anchor repoint for the actor waits for an in-flight command (was not serialized, R6)', (t) =>
  withPair(async ({ A }) => {
    const { who, tenant, lab, s, before } = await commandFixture(A, '04d');
    const h = await holdTenant(tenant);
    const pending = A.status(s, suspend(tenant, before.rv));
    const cmdPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_MUTATOR }), 'the command waiting at its mutator');
    const repoint = ownerWrite('anchor repoint', (sql) => sql`update platform_identity set auth_provider_uid = ${`${who.uid}-moved`} where internal_user_id = ${who.id}`);
    const r = await ownerOutcome(repoint);
    assert.ok(r?.blocked && r.blockers.includes(cmdPid),
      `design §1 R-COMMAND: the anchor repoint must wait for the command's COMMIT (${j(r)})`);
    assert.equal(await h.commit(), 'committed');
    const reply = await pending;
    assert.equal(reply.status, 200, `${reply.status} ${await A.reason(reply)}`);
    assert.equal(await within(repoint.done, 'repoint'), 'committed');
    await waitIdle();
    const after = await tenantState(tenant);
    assertChangedOnce(before, after, 'command first');
    await assertCommitOrder(t, 'command before repoint', after.audits[0].xid, r.xid);
    await refusedWith(A, await A.current(s), 401, 'session_admission_denied', 'the repoint then takes effect');
    assert.deepEqual(await liveLabels(who, lab), []);
  }));

test('M5R-04e: an identity-link insert for the actor waits for an in-flight command (was not serialized)', (t) =>
  withPair(async ({ A }) => {
    const { who, tenant, lab, s, before } = await commandFixture(A, '04e');
    const linked = `m5r-04e-sb-${SUFFIX}`;
    await owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('supabase', ${linked})`;
    const h = await holdTenant(tenant);
    const pending = A.status(s, suspend(tenant, before.rv));
    const cmdPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_MUTATOR }), 'the command waiting at its mutator');
    const link = ownerWrite('identity link insert', (sql) => sql`insert into identity_link
      (internal_user_id, firebase_auth_provider_uid, supabase_auth_provider_uid, status) values (${who.id}, ${who.uid}, ${linked}, 'active')`);
    const r = await ownerOutcome(link);
    assert.ok(r?.blocked && r.blockers.includes(cmdPid),
      `design §1 R-COMMAND: the identity-link insert must wait for the command's COMMIT (${j(r)})`);
    assert.equal(await h.commit(), 'committed');
    const reply = await pending;
    assert.equal(reply.status, 200, `${reply.status} ${await A.reason(reply)}`);
    assert.equal(await within(link.done, 'link'), 'committed');
    await waitIdle();
    const after = await tenantState(tenant);
    assertChangedOnce(before, after, 'command first');
    await assertCommitOrder(t, 'command before link insert', after.audits[0].xid, r.xid);
    const next = await A.current(s);
    const reason = await A.reason(next);
    assert.equal(next.status, 401, `the link then takes effect: ${next.status} ${reason}`);
    assert.ok(['session_version_mismatch', 'session_admission_denied'].includes(reason), reason);
    assert.deepEqual(await liveLabels(who, lab), []);
    t.diagnostic(`next request: 401 ${reason}`);
  }));

// ---------------------------------------------------------------------------
// M5R-05: removal followed by restoration
// ---------------------------------------------------------------------------

test('M5R-05: after a removal and a restoration the old cookie never revives, even with requests in flight across both', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('05');
    const grant = await grantOf(who);
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const oldWitness = await witnessOf(s.key);
    const across = B.gates.arm('admitBefore', who.uid); // in flight across both changes: session read done, admission read held
    const refresh = A.gates.arm('update', s.key); // decided before both changes, its refresh held across them
    const inFlight = B.list(s);
    await entered(across, "B's request reaching its admission read");
    const done = await A.list(s);
    assert.equal(done.status, 200, 'decided entirely before the changes');
    await entered(refresh, "A's idle refresh");
    const av0 = await authorityOf(who);
    await committed('grant removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
    await committed('grant restoration', (sql) => sql`update user_membership set status = 'active' where membership_id = ${grant}`);
    assert.equal(await authorityOf(who), av0 + 2n, 'the witness input moved twice and never returns');
    across.release.resolve();
    await refusedWith(B, await inFlight, 401, 'session_version_mismatch', 'the request in flight across both changes');
    refresh.release.resolve();
    assert.equal(await A.refreshOf(s.key), 'ok', 'the held refresh ran');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), [], 'the old session is gone and nothing recreated it');
    for (const inst of [A, B]) await refusedWith(inst, await inst.current(s), 401, 'session_unknown', `${inst.label}: old cookie`);
    const fresh = await B.signIn(who);
    lab.name('K2', fresh.key);
    assert.notEqual(await witnessOf(fresh.key), oldWitness, 'the restored standing is admitted anew under a witness the old cookie never had');
    await refusedWith(A, await A.current(s), 401, 'session_unknown', 'the old cookie still never revives');
    assert.deepEqual(await liveLabels(who, lab), ['K2']);
    await assertRecords(who, lab, ['login:K1', 'login:K2'], 'two logins, nothing else');
  }));

// ---------------------------------------------------------------------------
// M5R-06: outages during the race
// ---------------------------------------------------------------------------

test('M5R-06a: a session-store outage is a bounded 503 on both instances that revokes nothing; restored, the session works', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('06a');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    await owner.unsafe(`revoke execute on function ${SESSION_GET} from tmpos_app`);
    try {
      await refusedWith(B, await B.current(s), 503, 'session_unavailable', 'B during the outage');
      await refusedWith(A, await A.list(s), 503, 'session_unavailable', 'A during the outage');
      assert.deepEqual(await liveLabels(who, lab), ['K1'], 'nothing revoked');
    } finally {
      await owner.unsafe(`grant execute on function ${SESSION_GET} to tmpos_app`);
    }
    assert.equal((await B.current(s)).status, 200, 'restored: the session works');
    assert.equal((await A.list(s)).status, 200);
  }));

test('M5R-06b: an admission outage racing a grant removal: 503 that revokes nothing; restored, 401 only where a removal happened', (t) =>
  withPair(async ({ A, B }) => {
    const removed = await admin('06b-removed');
    const kept = await admin('06b-kept');
    const labR = labeller();
    const labK = labeller();
    const sR = await A.signIn(removed);
    const sK = await A.signIn(kept);
    labR.name('K1', sR.key);
    labK.name('K1', sK.key);
    const grant = await grantOf(removed);
    await owner.unsafe(`revoke execute on function ${ADMIT_READ} from tmpos_app`);
    try {
      await committed('grant removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
      await refusedWith(B, await B.current(sR), 503, 'admission_unavailable', 'removed admin during the outage');
      await refusedWith(B, await B.current(sK), 503, 'admission_unavailable', 'kept admin during the outage');
      assert.deepEqual(await liveLabels(removed, labR), ['K1'], 'the outage revoked nothing');
      assert.deepEqual(await liveLabels(kept, labK), ['K1'], 'the outage revoked nothing');
    } finally {
      await owner.unsafe(`grant execute on function ${ADMIT_READ} to tmpos_app`);
    }
    await refusedWith(B, await B.current(sR), 401, 'session_admission_denied', 'restored: the real removal takes effect');
    assert.deepEqual(await liveLabels(removed, labR), []);
    assert.equal((await A.current(sK)).status, 200, 'restored: the unchanged admin keeps working');
    assert.deepEqual(await liveLabels(kept, labK), ['K1']);
  }));

/** A command whose session-side reads passed, then an in-transaction read made unanswerable: 503, nothing committed or revoked. */
async function inTransactionOutage(t, A, label, fn) {
  const { who, tenant, lab, s, before } = await commandFixture(A, label);
  const gate = A.gates.arm('admitAfter', who.uid);
  const pending = A.status(s, suspend(tenant, before.rv));
  await entered(gate, 'the command past its session-side admission read');
  await owner.unsafe(`revoke execute on function ${fn} from tmpos_app`);
  try {
    gate.release.resolve();
    await refusedWith(A, await pending, 503, 'transaction_unavailable', `design §1: ${fn} unanswerable inside the command's transaction`);
    await waitIdle();
    assertUnchanged(before, await tenantState(tenant), 'in-transaction outage');
    assert.deepEqual(await liveLabels(who, lab), ['K1'], 'the outage revoked nothing');
  } finally {
    await owner.unsafe(`grant execute on function ${fn} to tmpos_app`);
  }
  const again = await A.status(s, suspend(tenant, before.rv));
  assert.equal(again.status, 200, `restored: the same session commits (${again.status} ${await A.reason(again)})`);
  await waitIdle();
  assertChangedOnce(before, await tenantState(tenant), 'after the outage');
}

test('M5R-06c: admission unanswerable inside the command\'s transaction: bounded 503, nothing committed or revoked; restored, it commits', (t) =>
  withPair(({ A }) => inTransactionOutage(t, A, '06c', ADMIT_READ)));

test('M5R-06d: session store unanswerable inside the command\'s transaction: bounded 503, nothing committed or revoked; restored, it commits', (t) =>
  withPair(({ A }) => inTransactionOutage(t, A, '06d', SESSION_GET)));

test('M5R-06e: a lock timeout inside the command is a bounded 503 that revokes nothing; released, the session commits', (t) =>
  withPair(async ({ A }) => {
    const { who, tenant, lab, s, before } = await commandFixture(A, '06e');
    const h = await holdAccount(who);
    const pending = A.status(s, suspend(tenant, before.rv));
    waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_009 }), 'the command waiting at 009');
    const reply = await replyTo(pending, 'lock timeout');
    const reason = await A.reason(reply);
    assert.equal(reply.status, 503, `${reply.status} ${reason}`);
    assert.ok(['transaction_unavailable', 'transaction_timeout'].includes(reason), reason);
    assert.equal(await h.settle(), 'rolled back');
    await waitIdle();
    assertUnchanged(before, await tenantState(tenant), 'lock timeout');
    assert.deepEqual(await liveLabels(who, lab), ['K1'], 'the timeout revoked nothing');
    const again = await A.status(s, suspend(tenant, before.rv));
    assert.equal(again.status, 200, `${again.status} ${await A.reason(again)}`);
    t.diagnostic(`held command: 503 ${reason}`);
  }));

// ---------------------------------------------------------------------------
// M5R-07: recent sign-in and revocation
// ---------------------------------------------------------------------------

test('M5R-07a: a logout committed before a recent sign-in\'s establish: 401 login_reauth_no_session, nothing created or recorded', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('07a');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const h = await holdSession(s.key);
    const logout = A.logout(s);
    const loPid = waitingPid(await blockedOrSettled(logout, { by: h.pid, query: AT_TOUCH }), 'the logout queued first on K1');
    const reauth = B.reauth(who, s);
    waitingPid(await blockedOrSettled(reauth, { query: AT_TOUCH, exclude: [loPid] }), 'the recent sign-in queued second on K1');
    assert.equal(await h.commit(), 'committed');
    const lo = await replyTo(logout, 'logout');
    assert.equal(lo.status, 204);
    assert.equal(await A.reason(lo), '-', 'the logout ended the live session');
    const re = await replyTo(reauth, 'reauth');
    await refusedWith(B, re, 401, 'login_reauth_no_session', 'design §1 R-LOGIN: the presented session ended before this establish');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), [], 'no successor was created');
    const records = await assertRecords(who, lab, ['login:K1', 'logout:K1'], 'no reauthenticate record');
    t.diagnostic(j(records));
  }));

test('M5R-07b: a recent sign-in first: the logout of the rotated cookie ends nothing (204, no record); exactly one successor lives', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('07b');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const h = await holdSession(s.key);
    const reauth = A.reauth(who, s);
    const rePid = waitingPid(await blockedOrSettled(reauth, { by: h.pid, query: AT_TOUCH }), 'the recent sign-in queued first on K1');
    const logout = B.logout(s);
    waitingPid(await blockedOrSettled(logout, { query: AT_TOUCH, exclude: [rePid] }), 'the logout queued second on K1');
    assert.equal(await h.commit(), 'committed');
    const re = await replyTo(reauth, 'reauth');
    assert.equal(re.status, 200, `${re.status} ${await A.reason(re)}`);
    const successor = A.sessionOf(re);
    lab.name('K2', successor.key);
    const lo = await replyTo(logout, 'logout');
    assert.equal(lo.status, 204);
    assert.equal(await B.reason(lo), 'logout_session_absent', 'the rotated cookie named nothing to end');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), ['K2'], 'exactly one successor lives');
    await assertRecords(who, lab, ['login:K1', 'reauthenticate:K2<-K1'], 'no logout record');
    assert.equal((await B.current(successor)).status, 200, 'the successor works on the other instance');
    await refusedWith(B, await B.current(s), 401, 'session_unknown', 'the rotated cookie');
  }));

test('M5R-07c: concurrent recent sign-ins presenting one cookie across two instances: exactly one succeeds', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('07c');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const h = await holdSession(s.key);
    const first = A.reauth(who, s);
    const firstPid = waitingPid(await blockedOrSettled(first, { by: h.pid, query: AT_TOUCH }), 'the first recent sign-in on K1');
    const others = [B.reauth(who, s), A.reauth(who, s)];
    assert.ok(await waitBlocked({ exclude: [firstPid] }, 2) !== null, 'lever did not engage: two more recent sign-ins waiting');
    assert.equal(await h.commit(), 'committed');
    const replies = await Promise.all([first, ...others].map((p) => replyTo(p, 'reauth')));
    const reasons = await Promise.all(replies.map((r, i) => (i === 1 ? B : A).reason(r)));
    const delivered = replies.filter((r) => r.status === 200);
    t.diagnostic(j(replies.map((r, i) => `${r.status} ${reasons[i]}`)));
    assert.equal(delivered.length, 1, `design §1 R-LOGIN: exactly one recent sign-in presenting one cookie succeeds: ${j(replies.map((r) => r.status))}`);
    replies.forEach((r, i) => {
      if (r.status !== 200) assert.deepEqual([r.status, reasons[i]], [401, 'login_reauth_no_session']);
    });
    const successor = A.sessionOf(delivered[0]);
    lab.name('D', successor.key);
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), ['D'], 'exactly the delivered session lives');
    await assertRecords(who, lab, ['login:K1', 'reauthenticate:D<-K1'], 'exactly one reauthenticate record, naming the delivered session');
  }));

// ---------------------------------------------------------------------------
// M5R-08: two instances over one durable state
// ---------------------------------------------------------------------------

test('M5R-08a: a logout on A is refused on B at once', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('08a');
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    assert.equal((await B.current(s)).status, 200);
    assert.equal((await A.logout(s)).status, 204);
    await refusedWith(B, await B.current(s), 401, 'session_unknown', 'B, the very next request');
    await refusedWith(B, await B.list(s), 401, 'session_unknown', 'B, a protected read');
    assert.deepEqual(await liveLabels(who, lab), []);
    await assertRecords(who, lab, ['login:K1', 'logout:K1'], 'one login, one logout');
  }));

test('M5R-08b: a revocation observed on B is refused on A at once', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('08b');
    const grant = await grantOf(who);
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    assert.equal((await B.current(s)).status, 200);
    await committed('grant removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
    await refusedWith(B, await B.current(s), 401, 'session_admission_denied', 'B revokes');
    await refusedWith(A, await A.current(s), 401, 'session_unknown', 'A refuses at once');
    assert.deepEqual(await liveLabels(who, lab), []);
    await assertRecords(who, lab, ['login:K1'], 'a revocation by admission records nothing');
  }));

test('M5R-08c: a command on B racing a logout on A, logout first: 503, nothing committed', (t) =>
  withPair(({ A, B }) => commandVsLogout(t, B, A, 'logout')));

test('M5R-08d: a command on B racing a logout on A, command first: the logout on A waits, then ends the session', (t) =>
  withPair(({ A, B }) => commandVsLogout(t, B, A, 'command')));

// ---------------------------------------------------------------------------
// M5R-09: R-LOGIN against a grant removal
// ---------------------------------------------------------------------------

test('M5R-09a: a grant removal committed after a login\'s admission read but before its establish: 401 login_standing_changed, nothing written', (t) =>
  withPair(async ({ A }) => {
    const who = await admin('09a');
    const grant = await grantOf(who);
    const lab = labeller();
    const gate = A.gates.arm('admitAfter', who.uid);
    const pending = A.login(who);
    await entered(gate, "the login past its admission read");
    await committed('grant removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
    gate.release.resolve();
    await refusedWith(A, await pending, 401, 'login_standing_changed', 'design §1 R-LOGIN: standing changed before establish');
    await waitIdle();
    assert.deepEqual(await liveLabels(who, lab), [], 'no session created');
    await assertRecords(who, lab, [], 'no login recorded');
  }));

test('M5R-09b: a login first: the grant removal waits for its COMMIT, then its next request is 401', (t) =>
  withPair(async ({ A, B }) => {
    const who = await admin('09b');
    const grant = await grantOf(who);
    const lab = labeller();
    const s = await A.signIn(who);
    lab.name('K1', s.key);
    const h = await holdSession(s.key);
    const pending = B.login(who, { cookie: s.cookie });
    const loginPid = waitingPid(await blockedOrSettled(pending, { by: h.pid, query: AT_TOUCH }), "the login waiting in establish on its presented session");
    const removal = ownerWrite('grant removal', (sql) => sql`update user_membership set status = 'suspended' where membership_id = ${grant}`);
    const r = await ownerOutcome(removal);
    assert.ok(r?.blocked && r.blockers.includes(loginPid), `design §1 R-LOGIN: the removal must wait for the login's COMMIT (${j(r)})`);
    assert.equal(await h.commit(), 'committed');
    const reply = await pending;
    assert.equal(reply.status, 200, `${reply.status} ${await B.reason(reply)}`);
    const successor = B.sessionOf(reply);
    lab.name('K2', successor.key);
    assert.equal(await within(removal.done, 'removal'), 'committed');
    await waitIdle();
    const records = await assertRecords(who, lab, ['login:K1', 'login:K2<-K1'], 'the login rotated K1');
    await assertCommitOrder(t, 'login before removal', records.find((x) => x.session === 'K2').xid, r.xid);
    await refusedWith(A, await A.current(successor), 401, 'session_admission_denied', 'the removal then takes effect');
    assert.deepEqual(await liveLabels(who, lab), []);
  }));
