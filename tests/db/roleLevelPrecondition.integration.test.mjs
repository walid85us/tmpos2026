// M7A-CUSTOMERS-P4 CHECKPOINT 1 — DA-125 WITNESSES: does a Customers role-level save land where, and when, the owner meant
// it to? The tenant entry (server/entry/tenantEntry.ts, startTenantEntry) over REAL loopback HTTP and a disposable
// PostgreSQL holding every migration in the directory, composed as tests/db/roleLevels.integration.test.mjs composes it:
// the database client (a supervised kernel over the cluster as the least-privilege runtime LOGIN tmpos_p4w_probe, holding
// tmpos_app and tmpos_audit_writer only), the identity verifier (a synthetic bearer-token map) and the listener
// (127.0.0.1:0) are substituted; everything on the path under test is production's own code.
//
// CLIENT-FAITHFUL ACROSS VERSIONS. Every save is built the way the shop builds it from the read that produced the draft:
// when GET /api/v1/roles/levels answers role entries carrying `version` (a server with the write precondition), the body is
// { roleId, domain, level, reason, expectedTenant, expectedVersion } from THAT read; otherwise (the entry server, 86c4ce8)
// it is the entry shop's four fields { roleId, domain, level, reason }. Each save carries a fresh Idempotency-Key.
//
// CASES (each in tenants of its own; counts are owner reads around the decisive request: the (tenant, sales_staff) level,
// the tenant's role-edit audit records, the global C/A/E/K/O/L of roleLevels.integration):
//   P4W-01 tenant switch: the owner reads A, the same account is moved to B and signs in again, and the A draft is sent on
//          the new session. SAFE: not 200 (409 write_conflict), neither A nor B changes, no edit audit, no completion.
//   P4W-02 in flight under A: (a) the A save is parked inside its transaction after its write, the switch is then attempted;
//          (b) the switch is held uncommitted while the A save is sent (and is seen waiting on it), then committed. SAFE: no
//          write in B; any write is A's.
//   P4W-03 two tabs, two instances: both read one version; tab 1 narrows sales_staff to None (200); tab 2 sends its older
//          Create draft. SAFE: not 200 (409), None stands, one edit audit, sales_staff create/read refused; tab 2 then
//          re-reads and deliberately reapplies (200, Create; sales_staff creates and reads).
//   P4W-04 reset ABA: read v0, edit None (v1), edit back to the catalog default Create (v2), send the v0 draft (View).
//          SAFE: the versions read 0, 0, 1, 2; not 200 (409), Create stands (sales_staff creates and reads), no edit audit,
//          no completion.
// Every observation is printed as a TAP diagnostic before the SAFE checks, so a red run records what actually happened.
//
// LITERALS, NOT IMPORTS: the edit path and audit actions are pinned here so this file loads on the entry commit and after
// the correction alike. DISPOSABLE ONLY: the harness's resolved target; assertDisposableTestDsn refuses anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'p4w-migrator', runtimeRef: 'p4w-runtime' };
const LOCK_KEY = 528_526;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_p4w_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_ORIGIN = 'https://admin.tmpos.test';
const ROLE_LEVELS_PATH = '/api/v1/roles/levels';
const CUSTOMERS_PATH = '/api/v1/customers';
const CREATE_ACTION = 'tenant.customer.create';
const EDIT_ACTION = 'tenant.role.level.update';
const REASON = 'Owner review of customer access';
const WAIT_MS = 10_000;
const PARK = [528_526, 21];
const SMALL_KERNEL = Object.freeze({ createSupervisedPgClient, MAX_POOLS: 4, runtimeClientOptions });

const TARGET = resolveDisposableTarget('P4W');
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

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const open of [...OPEN]) await step(async () => { open.settle?.(); await within(open.done, 'an open lever'); });
    await step(() => owner.unsafe('drop schema if exists p4w_proof cascade'));
    if (TENANTS.length > 0) {
      // 021's rollback refuses while a version row exists and 020's while a stored level differs from its default: this
      // suite's per-tenant role state is removed, version rows (tmpos_role_edit) first, then levels (tmpos_role), so a
      // shared database can still roll back.
      await step(async () => {
        const tables = await owner`select c.table_schema, c.table_name from information_schema.columns c
          where c.table_schema in ('tmpos_role_edit', 'tmpos_role') and c.column_name = 'tenant_id'
          order by c.table_schema = 'tmpos_role', c.table_name`;
        for (const { table_schema: s, table_name: t } of tables) {
          await owner.unsafe(`delete from "${s}"."${t.replace(/"/g, '""')}" where tenant_id = any($1::uuid[])`, [TENANTS]);
        }
      });
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
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_mint.issuer_key where singleton`;
        if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
      }));
    }
  } finally {
    await step(() => probe.end({ timeout: 5 }));
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'P4W teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'P4W setup failed, and so did its teardown'); });
    throw err;
  }
}

const databaseClient = (kernelModule = { createSupervisedPgClient, MAX_POOLS, runtimeClientOptions }) => () =>
  kernelModule.createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...kernelModule.runtimeClientOptions(TARGET_DSN), ssl: false, max: kernelModule.MAX_POOLS, idle_timeout: 0, user: RUNTIME_LOGIN,
  });

// ---------------------------------------------------------------------------
// setup: every migration in the directory, the runtime login, the keys, the proof schema
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
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
});

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
  await owner.unsafe('drop schema if exists p4w_proof cascade');
  await owner.unsafe('create schema p4w_proof');
  await owner.unsafe('revoke all on schema p4w_proof from public');
});

// ---------------------------------------------------------------------------
// the synthetic identity provider and the entry configuration
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
    type: 'service_account', project_id: 'p4w-test-project', client_email: 'p4w-test@p4w-test-project.iam.gserviceaccount.com',
    private_key: FIREBASE_PRIVATE_KEY,
  }),
});

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}
const nameOf = (label) => `P4W ${label} ${SUFFIX}`;

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

function unsafeHeaders(s, key) {
  return {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    cookie: s.cookie, [SESSION_CSRF_HEADER]: s.csrf, 'content-type': 'application/json', 'idempotency-key': key,
  };
}

async function withEntry(overrides, fn) {
  const clientAddress = randomLoopback();
  const cap = { codes: [], lines: [], proc: new EventEmitter() };
  const result = await startTenantEntry({
    env: ENV,
    construction: { databaseClient: databaseClient(overrides.kernelModule), tokenVerifier: VERIFIER, listen: () => ({ port: 0, host: '127.0.0.1' }) },
    proc: cap.proc, exit: (code) => { cap.codes.push(code); }, log: { log: (line) => { cap.lines.push(line); } },
  });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  const port = result.address.port;
  const unsafe = (method, path) => (s, body, { key = randomUUID() } = {}) =>
    send(port, method, path, unsafeHeaders(s, key), JSON.stringify(body), { localAddress: clientAddress });
  const get = (path) => (s) => send(port, 'GET', path, { host: TENANT_HOST, cookie: s.cookie }, undefined, { localAddress: clientAddress });
  const ctx = {
    port,
    put: unsafe('PUT', ROLE_LEVELS_PATH),
    post: unsafe('POST', CUSTOMERS_PATH),
    levels: get(ROLE_LEVELS_PATH),
    list: get(`${CUSTOMERS_PATH}?limit=100`),
    /** The runtime's logged reason for one reply (by its request id), or '-'. */
    reason: (reply) => cap.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
      .filter((r) => r.requestId === reply.headers['x-request-id'] && r.event === 'request').map((r) => r.reason ?? '-')[0] ?? '-',
  };
  try {
    return await fn(ctx);
  } finally {
    if (cap.codes.length === 0) {
      cap.proc.emit('SIGTERM');
      for (const until = Date.now() + 5_000; cap.codes.length === 0 && Date.now() < until;) await delay(10);
    }
  }
}

const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');

async function signIn(ctx, who) {
  const reply = await send(ctx.port, 'POST', sessionPaths('tenant').login, {
    host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${who.token}`,
  }, undefined, { localAddress: randomLoopback() });
  assert.equal(reply.status, 200, `login ${who.label}: ${reply.body}`);
  const cookie = reply.headers['set-cookie'][0].split('; ')[0];
  KEYS.add(keyOf(cookie));
  return { cookie, csrf: JSON.parse(reply.body).csrfToken };
}

/** The owner's read: 200 with { tenant, domain, roles } (structural — every case needs it). */
async function readLevels(ctx, s, label) {
  const reply = await ctx.levels(s);
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.ok(typeof body.tenant === 'string' && Array.isArray(body.roles), `${label}: ${reply.body}`);
  return body;
}
const roleOf = (read, roleId) => read.roles.find((r) => r.roleId === roleId);
const versionOf = (read, roleId) => roleOf(read, roleId)?.version;

/** The shop's save body, built from the read that produced the draft (see the header). */
function draftFrom(read, roleId, level) {
  const role = roleOf(read, roleId);
  assert.ok(role !== undefined, `the read lists ${roleId}`);
  const body = { roleId, domain: 'customers', level, reason: REASON };
  return 'version' in role ? { ...body, expectedTenant: read.tenant, expectedVersion: role.version } : body;
}

/** A deliberate owner edit: a fresh read, then its draft; must answer 200. Answers the read it was built from. */
async function editVia(ctx, s, roleId, level, label) {
  const read = await readLevels(ctx, s, `${label}: read`);
  const reply = await ctx.put(s, draftFrom(read, roleId, level));
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  return read;
}

const errorOf = (reply) => { try { return JSON.parse(reply.body).error ?? null; } catch { return null; } };
const brief = (reply) => ({ status: reply.status, error: reply.status >= 400 ? errorOf(reply) : undefined, body: reply.status < 400 ? reply.body : undefined });

// ---------------------------------------------------------------------------
// fixtures and counts
// ---------------------------------------------------------------------------

async function actor(label, memberships) {
  const uid = `p4w-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, null, 'tenant', ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  UIDS.push(uid);
  return { id, uid, token, label };
}
async function newTenant(label) {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`p4w-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(id);
  return id;
}
async function shop(label) {
  const tenant = await newTenant(label);
  const boss = await actor(`${label}-owner`, [{ tenant, role: 'store_owner' }]);
  return { tenant, boss };
}

/** The same account's only tenant grant moves from `from` to `to` (delete, then insert: two grants at once would be 403). */
const switchSql = (sql, who, from, to) => sql`delete from user_membership where internal_user_id = ${who.id} and tenant_id = ${from}`
  .then(() => sql`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
    values (${who.id}, ${to}, null, 'tenant', 'store_owner', 'active')`);

async function levelOf(tenant, roleId) {
  const rows = await owner`select level from tmpos_role.tenant_role_level
    where tenant_id = ${tenant} and role_id = ${roleId} and domain = 'customers'`;
  return rows.length === 0 ? undefined : rows[0].level;
}
/** The role-edit audit records of one tenant (action tenant.role.level.update, reason code role_*). */
async function editAudits(tenant) {
  const [{ n }] = await owner`select count(*)::int as n from public.audit_event
    where tenant_id = ${tenant} and action_id = ${EDIT_ACTION} and pg_catalog.starts_with(reason_code, 'role_')`;
  return n;
}
async function counts() {
  const [r] = await owner`select
    (select count(*) from tmpos_customer.customer)::int as "C",
    (select count(*) from public.audit_event where action_id = ${CREATE_ACTION})::int as "A",
    (select count(*) from public.audit_event where action_id = ${EDIT_ACTION})::int as "E",
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as "K",
    (select count(*) from tmpos_internal.outbox_event)::int as "O",
    (select count(*) from tmpos_internal.idempotency_record)::int as "L"`;
  return { ...r };
}
/** Levels (sales_staff) and edit audits per named tenant, plus the global counts. */
async function snapshot(tenants) {
  const out = { levels: {}, editAudits: {}, ...(await counts()) };
  for (const [name, t] of Object.entries(tenants)) {
    out.levels[name] = (await levelOf(t, 'sales_staff')) ?? '(no row: default)';
    out.editAudits[name] = await editAudits(t);
  }
  return out;
}
const delta = (a, b) => Object.fromEntries(['C', 'A', 'E', 'K', 'O', 'L'].map((k) => [k, b[k] - a[k]]));

/** Soft SAFE checks: every failed one is listed, after the observations are printed. */
function safety(t, id) {
  const failed = [];
  return {
    check(ok, what) { if (!ok) failed.push(what); },
    report(obs) {
      const line = `${id} OBSERVED ${JSON.stringify(obs)}`;
      console.log(line);
      t.diagnostic(line);
      t.diagnostic(`${id} SAFE-FAILED ${JSON.stringify(failed)}`);
      assert.deepEqual(failed, [], `${id}: SAFE assertions failed — ${failed.join('; ')}`);
    },
  };
}

// ---------------------------------------------------------------------------
// levers (roleLevels.integration's): an open owner transaction, a parking trigger, lock observation
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
const holdPark = () => hold('the parking key', (sql) => sql`select pg_catalog.pg_advisory_xact_lock(${PARK[0]}::int, ${PARK[1]}::int)`);

async function blockedNow({ by = null, user = RUNTIME_LOGIN } = {}) {
  const rows = await probe`select pid, usename, query, pg_blocking_pids(pid) as blockers from pg_stat_activity
    where wait_event_type = 'Lock'`;
  return rows.filter((r) => (user === null || r.usename === user) && (by === null || r.blockers.includes(by)))
    .map((r) => ({ pid: r.pid, query: r.query.slice(0, 120) }));
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
async function replyTo(request, label) {
  const reply = await within(request, label);
  assert.ok(typeof reply?.status === 'number', `no reply to ${label} within ${WAIT_MS} ms: ${JSON.stringify(reply)}`);
  return reply;
}
async function withParkedEditAudit(work) {
  await owner.unsafe(`create function p4w_proof.fire() returns trigger language plpgsql security definer
    set search_path = pg_catalog, pg_temp as $$ begin perform pg_catalog.pg_advisory_xact_lock(${PARK[0]}, ${PARK[1]}); return new; end $$`);
  await owner.unsafe('revoke all on function p4w_proof.fire() from public');
  await owner.unsafe(`create trigger p4w_fire before insert on public.audit_event for each row
    when (new.action_id = '${EDIT_ACTION}') execute function p4w_proof.fire()`);
  try {
    return await work();
  } finally {
    await owner.unsafe('drop trigger if exists p4w_fire on public.audit_event');
    await owner.unsafe('drop function if exists p4w_proof.fire()');
  }
}

// ===========================================================================
// P4W-01: tenant switch, then the A draft on the new session
// ===========================================================================

test('P4W-01: the owner reads A, the same account is moved to B and signs in again, and the A draft (sales_staff Create) is sent on the new session — SAFE: refused (409 write_conflict), neither A nor B changes, no edit audit, no completion', async (t) => {
  const a = await shop('p4w01a');
  const b = await newTenant('p4w01b');
  const bBoss = await actor('p4w01b-owner', [{ tenant: b, role: 'store_owner' }]);
  const safe = safety(t, 'P4W-01');
  await withEntry({}, async (ctx) => {
    const sA = await signIn(ctx, a.boss);
    // A at View (so the Create draft is an effective change in A), B at None (so Create would widen B).
    await editVia(ctx, sA, 'sales_staff', 'view', 'A narrowed to View');
    await editVia(ctx, await signIn(ctx, bBoss), 'sales_staff', 'none', 'B narrowed to None');
    const readA = await readLevels(ctx, sA, 'the owner reads A');
    assert.equal(readA.tenant, a.tenant, 'the read is A\'s');
    const draft = draftFrom(readA, 'sales_staff', 'create');

    await owner.begin((sql) => switchSql(sql, a.boss, a.tenant, b));
    const oldSession = await ctx.levels(sA);
    const sB = await signIn(ctx, a.boss);
    const readNew = await readLevels(ctx, sB, 'the new session reads');
    assert.equal(readNew.tenant, b, 'the re-established session is scoped to B');

    const before = await snapshot({ A: a.tenant, B: b });
    const reply = await ctx.put(sB, draft);
    const after = await snapshot({ A: a.tenant, B: b });
    const d = delta(before, after);

    safe.check(reply.status !== 200, `the A draft on the B session answered ${reply.status}, not a refusal`);
    safe.check(reply.status === 409 && errorOf(reply) === 'write_conflict', `the A draft answered ${reply.status} ${errorOf(reply)}, not 409 write_conflict`);
    safe.check(after.levels.B === before.levels.B, `B's sales_staff moved ${before.levels.B} -> ${after.levels.B}`);
    safe.check(after.levels.A === before.levels.A, `A's sales_staff moved ${before.levels.A} -> ${after.levels.A}`);
    safe.check(after.editAudits.A === before.editAudits.A, `A edit audits +${after.editAudits.A - before.editAudits.A}`);
    safe.check(after.editAudits.B === before.editAudits.B, `B edit audits +${after.editAudits.B - before.editAudits.B}`);
    safe.check(d.E === 0 && d.K === 0, `edit audits/completions written: E=${d.E} K=${d.K}`);
    safe.report({
      draftShape: Object.keys(draft), draftVersion: draft.expectedVersion ?? null,
      oldSessionAfterSwitch: brief(oldSession), put: brief(reply), before, after, delta: d,
    });
  });
});

// ===========================================================================
// P4W-02: a save already in flight under A when the switch happens
// ===========================================================================

test('P4W-02: a save sent under A — (a) parked inside its transaction after its write while the switch is attempted, (b) sent while the switch is held uncommitted — SAFE: no write in B; any write is A\'s', async (t) => {
  const safe = safety(t, 'P4W-02');
  const obs = {};

  // (a) the save has written A's row and parks at its audit INSERT; the switch is then attempted.
  {
    const a = await shop('p4w02a');
    const b = await newTenant('p4w02a-b');
    await withEntry({}, async (ctx) => {
      const sA = await signIn(ctx, a.boss);
      const draft = draftFrom(await readLevels(ctx, sA, '(a) the owner reads A'), 'sales_staff', 'view');
      const before = await snapshot({ A: a.tenant, B: b });
      let reply;
      let sw;
      let switchWhileParked;
      await withParkedEditAudit(async () => {
        const lever = await holdPark();
        let req;
        try {
          req = quietly(ctx.put(sA, draft));
          const parked = await blockedOrSettled(req, { by: lever.pid });
          assert.ok(parked?.blocked, `(a) the save parked at its audit INSERT: ${JSON.stringify(parked?.settled?.value?.status ?? parked)}`);
          sw = quietly(owner.begin((sql) => switchSql(sql, a.boss, a.tenant, b)).then(() => 'committed', (e) => `failed:${e.message}`));
          switchWhileParked = await Promise.race([sw, delay(1_500).then(() => 'still waiting')]);
          if (switchWhileParked === 'still waiting') {
            const waits = await blockedNow({ user: null });
            switchWhileParked = `still waiting (lock waits: ${JSON.stringify(waits.map((w) => w.query))})`;
          }
        } finally {
          await lever.commit();
        }
        reply = await replyTo(req, '(a) the parked save');
      });
      const switchOutcome = await within(sw, '(a) the switch');
      const oldSession = await ctx.levels(sA);
      const readNew = await readLevels(ctx, await signIn(ctx, a.boss), '(a) the new session reads');
      const after = await snapshot({ A: a.tenant, B: b });
      obs.a = { put: brief(reply), putReason: ctx.reason(reply), switchWhileParked, switchOutcome, oldSessionAfterSwitch: brief(oldSession), newSessionTenantIsB: readNew.tenant === b, before, after, delta: delta(before, after) };
      safe.check(after.levels.B === before.levels.B && after.editAudits.B === before.editAudits.B, '(a) B changed');
      if (reply.status === 200) safe.check(after.levels.A === 'view' && after.editAudits.A === before.editAudits.A + 1, '(a) a 200 that is not exactly A\'s write');
      else safe.check(after.levels.A === before.levels.A && after.editAudits.A === before.editAudits.A, '(a) a refusal that changed A');
    });
  }

  // (b) the switch is held uncommitted (its grant rows locked) while the save is sent, then committed.
  {
    const a = await shop('p4w02b');
    const b = await newTenant('p4w02b-b');
    await withEntry({}, async (ctx) => {
      const sA = await signIn(ctx, a.boss);
      const draft = draftFrom(await readLevels(ctx, sA, '(b) the owner reads A'), 'sales_staff', 'view');
      const before = await snapshot({ A: a.tenant, B: b });
      const sw = await hold('(b) the switch', (sql) => switchSql(sql, a.boss, a.tenant, b));
      let engaged;
      let req;
      try {
        req = quietly(ctx.put(sA, draft));
        const outcome = await blockedOrSettled(req, { by: sw.pid });
        engaged = outcome === null ? 'neither blocked nor settled' : outcome.blocked
          ? `blocked on the uncommitted switch at: ${outcome.blocked[0].query}` : `settled before the switch committed: ${outcome.settled?.value?.status ?? outcome.settled?.error}`;
        assert.ok(outcome?.blocked, `(b) the save waited on the uncommitted switch: ${engaged}`);
      } finally {
        await sw.commit();
      }
      const reply = await replyTo(req, '(b) the save');
      const oldSession = await ctx.levels(sA);
      const readNew = await readLevels(ctx, await signIn(ctx, a.boss), '(b) the new session reads');
      const after = await snapshot({ A: a.tenant, B: b });
      obs.b = { put: brief(reply), putReason: ctx.reason(reply), engaged, oldSessionAfterSwitch: brief(oldSession), newSessionTenantIsB: readNew.tenant === b, before, after, delta: delta(before, after) };
      safe.check(after.levels.B === before.levels.B && after.editAudits.B === before.editAudits.B, '(b) B changed');
      if (reply.status === 200) safe.check(after.levels.A === 'view' && after.editAudits.A === before.editAudits.A + 1, '(b) a 200 that is not exactly A\'s write');
      else safe.check(after.levels.A === before.levels.A && after.editAudits.A === before.editAudits.A, '(b) a refusal that changed A');
    });
  }
  safe.report(obs);
});

// ===========================================================================
// P4W-03: two tabs, two instances, one version
// ===========================================================================

test('P4W-03: two tabs of one owner on two instances read one version; tab 1 narrows sales_staff to None (200); tab 2\'s older Create draft — SAFE: refused (409), None stands, one edit audit, sales_staff create/read refused; an explicit re-read and reapply then saves Create', async (t) => {
  const { tenant, boss } = await shop('p4w03');
  const sales = await actor('p4w03-sales', [{ tenant, role: 'sales_staff' }]);
  const safe = safety(t, 'P4W-03');
  await withEntry({ kernelModule: SMALL_KERNEL }, (x) => withEntry({ kernelModule: SMALL_KERNEL }, async (y) => {
    const t1 = await signIn(x, boss);
    const t2 = await signIn(y, boss);
    const ss = await signIn(y, sales);
    const r1 = await readLevels(x, t1, 'tab 1 reads');
    const r2 = await readLevels(y, t2, 'tab 2 reads');
    assert.equal(versionOf(r1, 'sales_staff'), versionOf(r2, 'sales_staff'), 'both tabs read one version');
    const d1 = draftFrom(r1, 'sales_staff', 'none');
    const d2 = draftFrom(r2, 'sales_staff', 'create');

    const before = await snapshot({ T: tenant });
    const p1 = await x.put(t1, d1);
    assert.equal(p1.status, 200, `tab 1's restrictive save: ${p1.body}`);
    const mid = await snapshot({ T: tenant });
    const p2 = await y.put(t2, d2);
    const afterStale = await snapshot({ T: tenant });
    const create1 = await y.post(ss, { name: nameOf('p4w03 after stale') });
    const read1 = await y.list(ss);
    const afterAuthority = await snapshot({ T: tenant });

    // Tab 2 deliberately refreshes and reapplies against the version it now reads, with a new key.
    const r2b = await readLevels(y, t2, 'tab 2 re-reads');
    const p3 = await y.put(t2, draftFrom(r2b, 'sales_staff', 'create'));
    const create2 = await y.post(ss, { name: nameOf('p4w03 after reapply') });
    const read2 = await y.list(ss);
    const final = await snapshot({ T: tenant });

    safe.check(p2.status !== 200, `tab 2's stale Create answered ${p2.status}, not a refusal`);
    safe.check(p2.status === 409 && errorOf(p2) === 'write_conflict', `tab 2's stale Create answered ${p2.status} ${errorOf(p2)}, not 409 write_conflict`);
    safe.check(afterStale.levels.T === 'none', `the stored level after the stale save is ${afterStale.levels.T}, not none`);
    safe.check(afterStale.editAudits.T - before.editAudits.T === 1, `edit audits +${afterStale.editAudits.T - before.editAudits.T} over both saves, not exactly 1`);
    safe.check(afterStale.K - mid.K === 0, `the stale save wrote ${afterStale.K - mid.K} completion(s)`);
    safe.check(create1.status === 403, `sales_staff create after the stale save answered ${create1.status}, not 403`);
    safe.check(read1.status === 403, `sales_staff read after the stale save answered ${read1.status}, not 403`);
    safe.check(p3.status === 200 && final.levels.T === 'create', `the deliberate reapply answered ${p3.status}, level ${final.levels.T}`);
    safe.check(create2.status === 201 && read2.status === 200, `after the reapply sales_staff create ${create2.status}, read ${read2.status}`);
    safe.report({
      version: versionOf(r1, 'sales_staff') ?? null, reReadVersion: versionOf(r2b, 'sales_staff') ?? null,
      tab1: brief(p1), tab2Stale: brief(p2), salesCreateAfterStale: brief(create1), salesReadAfterStale: read1.status,
      reapply: brief(p3), salesCreateAfterReapply: create2.status, salesReadAfterReapply: read2.status,
      before, mid, afterStale, afterAuthority, final, deltaStale: delta(mid, afterStale), deltaAll: delta(before, final),
    });
  }));
});

// ===========================================================================
// P4W-04: reset to the default, then a v0 draft (ABA)
// ===========================================================================

test('P4W-04: reset ABA — read v0 (default Create), edit None (v1), edit back to Create (v2), send the v0 draft (View) — SAFE: refused (409), Create stands, no edit audit, no completion', async (t) => {
  const { tenant, boss } = await shop('p4w04');
  const sales = await actor('p4w04-sales', [{ tenant, role: 'sales_staff' }]);
  const safe = safety(t, 'P4W-04');
  await withEntry({}, async (ctx) => {
    const s = await signIn(ctx, boss);
    const ss = await signIn(ctx, sales);
    const r0 = await readLevels(ctx, s, 'v0');
    const stale = draftFrom(r0, 'sales_staff', 'view');
    const authority = async (label) => ({
      at: label, level: await levelOf(tenant, 'sales_staff'),
      create: (await ctx.post(ss, { name: nameOf(`p4w04 ${label}`) })).status, read: (await ctx.list(ss)).status,
    });
    const r1 = await editVia(ctx, s, 'sales_staff', 'none', 'v0 -> None');
    const atNone = await authority('none');
    const r2 = await editVia(ctx, s, 'sales_staff', 'create', 'v1 -> Create (reset)');
    const atReset = await authority('reset');
    const rReset = await readLevels(ctx, s, 'after the reset');

    const before = await snapshot({ T: tenant });
    const reply = await ctx.put(s, stale);
    const after = await snapshot({ T: tenant });
    const atStale = await authority('stale');
    const d = delta(before, after);

    // The levers: None refuses sales_staff's create and read; the reset to Create allows both.
    assert.deepEqual([atNone, atReset].map(({ create, read }) => ({ create, read })), [{ create: 403, read: 403 }, { create: 201, read: 200 }],
      'sales_staff at None, then at the reset Create');
    // editVia answers the read its draft came from: r1 is v0 re-read, r2 is v1; rReset is v2.
    const v = [r0, r1, r2, rReset].map((r) => versionOf(r, 'sales_staff') ?? null);
    safe.check(v[0] === 0 && v[1] === 0 && v[2] === 1 && v[3] === 2, `the versions read were ${JSON.stringify(v)}, not [0,0,1,2] (a reset that recreates v0, or no version)`);
    safe.check(atStale.create === 201 && atStale.read === 200, `after the v0 draft sales_staff create ${atStale.create}, read ${atStale.read}, not Create's 201 and 200`);
    safe.check(reply.status !== 200, `the v0 draft answered ${reply.status}, not a refusal`);
    safe.check(reply.status === 409 && errorOf(reply) === 'write_conflict', `the v0 draft answered ${reply.status} ${errorOf(reply)}, not 409 write_conflict`);
    safe.check(after.levels.T === 'create', `the stored level after the v0 draft is ${after.levels.T}, not create`);
    safe.check(after.editAudits.T === before.editAudits.T && d.E === 0 && d.K === 0, `the v0 draft wrote audits/completions: E=${d.E} K=${d.K}`);
    safe.report({
      versions: { v0: v[0], v0reread: v[1], v1: v[2], v2: v[3] }, sourceAfterReset: roleOf(rReset, 'sales_staff').source,
      authority: [atNone, atReset, atStale], staleDraft: stale, put: brief(reply), before, after, delta: d,
    });
  });
});
