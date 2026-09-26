// Phase 4.0 M6-ENTRY-P1 — DATABASE-ROLE, MIGRATION-LEDGER and LIMITER-BOOT: the deployable entry's startup preflight
// (server/persistence/postgresStartupPreflight.ts, server/persistence/postgresRateLimiter.ts) and the entry itself
// (server/entry/productionEntry.ts), proved end to end over a disposable PostgreSQL and a real non-owner runtime login.
//
// Two lenses, as the stage brief asks: createPostgresStartupPreflight driven directly over a supervised kernel for
// each login shape (the exact violation list), and startProductionEntry driven end to end (outcome, failure, exit
// code, no listener) for the ledger and limiter-boot cases. Every mutating case restores the shared CI database
// exactly — the ledger row-for-row (re-read and compared), the rate-limit key fingerprint to the row this suite found,
// every created role and database dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { REQUIRED_MIGRATIONS, createPostgresStartupPreflight } from '../../server/persistence/postgresStartupPreflight.ts';
import { probeRateLimitKey, rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startProductionEntry } from '../../server/entry/productionEntry.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm6pf-migrator', runtimeRef: 'm6pf-runtime' };
const LOCK_KEY = 528_517;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
/** M6PF-35's second database of the cluster; teardown drops it too, before the roles a grant in it would pin. */
const OTHER_DB = `m6pf_other_${SUFFIX}`;
const signal = () => AbortSignal.timeout(10_000);

/** Mirrors createApp's PROBE_REUSE_MS (server/runtime/app.ts, not exported): how long a readiness answer is cached. */
const READINESS_PROBE_REUSE_MS = 1_000;

/** Never asked to verify: constructionFor hands this to every entry so the real Firebase Admin SDK is never built. */
const SYNTHETIC_TOKEN_VERIFIER = Object.freeze({
  verify: async () => { throw Object.assign(new Error('synthetic'), { code: 'auth/invalid-id-token' }); },
});

/**
 * A scoped spy on the one call that actually binds a socket (net.Server.prototype.listen, which http.Server inherits):
 * `count()` while active, `restore()` always in a finally. Global by nature (there is one prototype), so callers scope
 * it tightly around the entry(ies) under test. `onBind`, when given, runs at each bind attempt, before the socket binds.
 */
function watchBinds(onBind) {
  const original = net.Server.prototype.listen;
  let calls = 0;
  net.Server.prototype.listen = function patchedListen(...args) {
    calls += 1;
    if (onBind !== undefined) onBind();
    return original.apply(this, args);
  };
  return { count: () => calls, restore: () => { net.Server.prototype.listen = original; } };
}

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
} else {
  throw new Error(
    'M6PF INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
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

/** The owner: applies the migrations, creates roles, mutates the ledger and the fingerprint. RLS does not restrict it. */
const owner = postgres(driverDsn(TARGET_DSN), { ...CLIENT_OPTS, max: 3, onnotice: () => {} });

// ---------------------------------------------------------------------------
// teardown: registered before the first mutation, and run by setupStep should top-level setup stop part-way — node:test
// runs no hook at all once the module itself has thrown
// ---------------------------------------------------------------------------

/** Every role this suite creates (tmpos_m6pf_*): teardown ends its backends, drops what it owns, then drops it. */
const createdRoles = new Set();
const liveEntries = [];
/** The registered rate-limit key fingerprint as this suite found it: undefined until taken, then the row or null. */
let fingerprintBeforeSuite;

async function teardown() {
  // Each step runs whatever an earlier one (or a setup that stopped part-way) left; failures are reported, after cleanup.
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    for (const handle of [...liveEntries]) await step(() => stopEntry(handle));
    if (fingerprintBeforeSuite !== undefined) {
      await step(async () => {
        await restoreFingerprint(fingerprintBeforeSuite);
        assert.deepEqual(await fingerprintRow(), fingerprintBeforeSuite);
      });
    }
    await step(() => owner.unsafe(`drop database if exists ${OTHER_DB} with (force)`));
    for (const name of [...createdRoles]) {
      await step(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${name}`);
      await step(() => owner.unsafe(`drop owned by ${name}`));
      await step(() => owner.unsafe(`drop role if exists ${name}`));
    }
    await step(async () => {
      const roles = await owner`select rolname from pg_catalog.pg_roles where starts_with(rolname, 'tmpos_m6pf_') order by 1`;
      const databases = await owner`select datname from pg_catalog.pg_database where starts_with(datname, 'm6pf_other_') order by 1`;
      assert.deepEqual({ roles: roles.map((r) => r.rolname), databases: databases.map((d) => d.datname) }, { roles: [], databases: [] });
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M6PF teardown: a cleanup step failed');
}
test.after(teardown);

/** A top-level setup step that creates state teardown owns: should it throw, teardown runs before the failure propagates. */
async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'M6PF setup failed, and so did its teardown'); });
    throw err;
  }
}

// The roles the migrations name, PUBLIC's CREATE and TEMPORARY on the database revoked (the preflight refuses a login
// holding either: database_temporary_privilege) and migrations 001-015: the approved production state, which every
// earlier database suite also establishes, so teardown leaves it in place. The runtime suite after this one
// re-establishes all of it itself, so it inherits nothing it does not prove.
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

// ---------------------------------------------------------------------------
// roles: every login this suite creates is tmpos_m6pf_*, dropped by teardown
// ---------------------------------------------------------------------------

/** A login over the disposable cluster, compliant by default (the approved runtime boundary), one override at a time. */
async function createLogin(label, opts = {}) {
  const {
    attrs = 'nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit',
    memberships = ['tmpos_app', 'tmpos_audit_writer'],
    ledgerGrant = true,
  } = opts;
  const name = `tmpos_m6pf_${label}_${SUFFIX}`;
  await owner.unsafe(`create role ${name} login ${attrs}`);
  createdRoles.add(name);
  for (const role of memberships) await owner.unsafe(`grant ${role} to ${name}`);
  if (ledgerGrant) await owner.unsafe(`grant select on public.schema_migrations to ${name}`);
  return name;
}

const RUNTIME_LOGIN = await setupStep(() => createLogin('probe'));

function clientAs(login, max = 2) {
  return createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, login), {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max, idle_timeout: 0, ...CLIENT_OPTS, user: login,
  });
}

/** createPostgresStartupPreflight over a fresh supervised kernel for `login`; the client always ends. */
async function runtimeLoginViolations(login) {
  const client = clientAs(login);
  try {
    return await createPostgresStartupPreflight({ client }).runtimeLogin(signal());
  } finally {
    await client.end();
  }
}
async function ledgerViolations(login) {
  const client = clientAs(login);
  try {
    return await createPostgresStartupPreflight({ client }).migrationLedger(signal());
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// the ledger: snapshot every row, mutate, always restore exactly — and prove it
// ---------------------------------------------------------------------------

/** Every row, every column, as plain objects (timestamps as text: a JS Date would drop the microseconds). */
async function ledgerSnapshot() {
  const rows = await owner`select version, checksum, dirty, started_at::text as started_at, finished_at::text as finished_at
    from public.schema_migrations order by version`;
  return rows.map((r) => ({ version: r.version, checksum: r.checksum, dirty: r.dirty, started_at: r.started_at, finished_at: r.finished_at }));
}
// Timestamps go back as text parameters the server parses (`::text::timestamptz`): a bare `${x}::timestamptz` makes
// the driver serialise the parameter through a JS Date, truncating the microseconds to milliseconds.
async function restoreLedger(rows) {
  await owner.begin(async (sql) => {
    await sql`delete from public.schema_migrations`;
    for (const r of rows) {
      await sql`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
        values (${r.version}, ${r.checksum}, ${r.dirty}, ${r.started_at}::text::timestamptz, ${r.finished_at}::text::timestamptz)`;
    }
  });
  assert.deepEqual(await ledgerSnapshot(), rows, 'the ledger is back exactly as snapshotted, every column of every row');
}
async function withLedgerMutation(mutate, fn) {
  const before = await ledgerSnapshot();
  try {
    await mutate();
    return await fn();
  } finally {
    await restoreLedger(before);
  }
}

// ---------------------------------------------------------------------------
// the limiter key fingerprint: always restored to the canonical key
// ---------------------------------------------------------------------------

const CANONICAL_KEY = Buffer.alloc(32, 7);
const SECOND_KEY = Buffer.alloc(32, 8);

/** Every column, as a plain object (registered_at as text) so a restore round-trips it exactly, and deepEqual compares it cleanly. */
async function fingerprintRow() {
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint`;
  return rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
}
/** Every bucket row, every column, as plain objects (registered_at-style timestamptz columns as text) for a clean deepEqual. */
async function bucketRows() {
  const rows = await owner`select namespace, dimension, limiter_key, limit_count, window_ms, consumed,
      window_start::text as window_start, expires_at::text as expires_at
    from tmpos_rate_limit.bucket order by namespace, dimension, limiter_key, limit_count, window_ms`;
  return rows.map((r) => ({
    namespace: r.namespace, dimension: r.dimension, limiter_key: r.limiter_key, limit_count: r.limit_count,
    window_ms: r.window_ms, consumed: r.consumed, window_start: r.window_start, expires_at: r.expires_at,
  }));
}

/**
 * Replaces tmpos_rate_limit.key_fingerprint with exactly `row`, every column (registered_at included, as a text parameter
 * the server parses — a bare `::timestamptz` parameter goes through a JS Date and loses the microseconds), or with no row
 * for null — in one transaction, so a failed insert never leaves the table empty.
 */
async function restoreFingerprint(row) {
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    if (row !== null) {
      await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
        values (${row.singleton}, ${row.fingerprint}, ${row.registered_at}::text::timestamptz)`;
    }
  });
}

// The row as this suite found it (or its absence), taken before the first write to it: teardown restores exactly that.
// Then the suite's one canonical row, established once and snapshotted exactly as it landed: every in-suite restore
// replays this snapshot byte for byte (registered_at included), never a fresh insert that would re-stamp clock_timestamp().
const FINGERPRINT_SNAPSHOT = await setupStep(async () => {
  fingerprintBeforeSuite = await fingerprintRow();
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(CANONICAL_KEY)})`;
  });
  return fingerprintRow();
});
const restoreCanonicalFingerprint = () => restoreFingerprint(FINGERPRINT_SNAPSHOT);

// ---------------------------------------------------------------------------
// the entry: a full production composition over the disposable cluster
// ---------------------------------------------------------------------------

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const BASE_ENV = Object.freeze({
  NODE_ENV: 'production', PORT: '8080',
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  DATABASE_CA_CERT: rootCertificates[0],
  IDEMPOTENCY_KEY: Buffer.alloc(32, 9).toString('base64url'),
  RATE_LIMIT_KEY: CANONICAL_KEY.toString('base64url'),
  TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
  SESSION_ADMIN_ORIGINS: 'https://admin.m6pf.test',
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', project_id: 'm6pf-synthetic',
    client_email: 'x@m6pf-synthetic.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }),
});

/**
 * The construction an entry composes over: the disposable cluster as `login`, a synthetic token verifier (so the real
 * Firebase Admin verifier is never built), an ephemeral loopback port. `wrapEnd`, when given, replaces the composed
 * client's own end() with `wrapEnd(() => client.end())` — M6PF-03's controllable deferred over the real shutdown.
 */
function constructionFor(login, { wrapEnd } = {}) {
  return {
    tokenVerifier: SYNTHETIC_TOKEN_VERIFIER,
    databaseClient: () => {
      const client = createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, login), {
        ...runtimeClientOptions(TARGET_DSN), ssl: false, max: MAX_POOLS, idle_timeout: 0, ...CLIENT_OPTS, user: login,
      });
      return wrapEnd === undefined ? client : Object.freeze({ transaction: client.transaction.bind(client), end: wrapEnd(() => client.end()) });
    },
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
}

async function startEntry(envOverrides, login = RUNTIME_LOGIN, constructionOpts = {}) {
  const proc = new EventEmitter();
  const exits = [];
  const logs = [];
  const result = await startProductionEntry({
    env: { ...BASE_ENV, ...envOverrides }, construction: constructionFor(login, constructionOpts), proc, exit: (c) => exits.push(c), log: { log: (l) => logs.push(l) },
  });
  const handle = { result, proc, exits, logs };
  if (result.outcome === 'listening') liveEntries.push(handle);
  return handle;
}
/** SIGTERM a listening entry and wait for its (graceful) exit; no-op for a refused or interrupted one — already torn down. */
async function stopEntry(handle) {
  if (handle.result.outcome !== 'listening') return;
  handle.proc.emit('SIGTERM');
  const deadline = Date.now() + 15_000;
  while (handle.exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(handle.exits, [0], `graceful shutdown: ${handle.exits.join()}`);
  const at = liveEntries.indexOf(handle);
  if (at >= 0) liveEntries.splice(at, 1);
}
/** GET over loopback, bounded: past GET_TIMEOUT_MS the request is destroyed and the promise rejects. 10s, matching signal()'s bound above — this suite's readiness probes do real round trips and occasionally queue behind other work. */
const GET_TIMEOUT_MS = 10_000;
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers, signal: AbortSignal.timeout(GET_TIMEOUT_MS) }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// M6PF-01..03: the intended least-privilege login, and the entry it lets listen
// ---------------------------------------------------------------------------

test('M6PF-01: the least-privilege runtime login has no violations — APPROVED_ROLE_GRANTS matches a fresh 001-015 apply exactly, both directions', async () => {
  assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), []);
});

test('M6PF-02: the ledger holds exactly REQUIRED_MIGRATIONS (version, checksum), and the preflight agrees', async () => {
  const rows = await owner`select version, checksum from public.schema_migrations order by version`;
  assert.deepEqual(rows.map((r) => ({ version: r.version, checksum: r.checksum })), REQUIRED_MIGRATIONS.map((m) => ({ version: m.version, checksum: m.checksum })));
  assert.deepEqual(await ledgerViolations(RUNTIME_LOGIN), []);
});

test('M6PF-03: the least-privilege login listens end to end, and a double SIGTERM held open over shutdown is one graceful exit', async () => {
  let releaseEnd = () => {};
  const held = new Promise((resolve) => { releaseEnd = resolve; });
  let clientEnded = () => {};
  const clientEndedSentinel = new Promise((resolve) => { clientEnded = resolve; });
  const wrapEnd = (realEnd) => async () => { await held; await realEnd(); clientEnded(); };
  const handle = await startEntry({}, RUNTIME_LOGIN, { wrapEnd });
  try {
    assert.equal(handle.result.outcome, 'listening', JSON.stringify(handle.result));
    assert.deepEqual(handle.result.reasons, []);
    const port = handle.result.address.port;
    assert.equal((await get(port, '/health')).status, 200);
    assert.equal((await get(port, '/readiness')).status, 200);

    handle.proc.emit('SIGTERM'); // begins shutdown, held open on the deferred client end()
    handle.proc.emit('SIGTERM'); // a second signal while shutdown is genuinely still in flight: still one shutdown
    assert.equal(handle.exits.length, 0, 'shutdown is held open on the deferred client end(); nothing has exited yet');
    releaseEnd();
    await clientEndedSentinel; // the real client.end() has now actually finished
    const deadline = Date.now() + 15_000;
    while (handle.exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(handle.exits, [0]); // exactly one exit(0): the second SIGTERM never called exit again
  } finally {
    releaseEnd(); // never leaves a suspended shutdown behind if an assertion above threw
    await stopEntry(handle); // nor the listener and pool: shuts it down if it never got the signal, a no-op SIGTERM once exited
  }
});

// ---------------------------------------------------------------------------
// M6PF-04..16: login safety — the exact violation each shape earns
// ---------------------------------------------------------------------------

test('M6PF-04: a NOSUPERUSER login made owner of a schema (the migration-owner shape) violates login_owns_objects', async () => {
  const login = await createLogin('owns');
  const schema = `m6pf_owned_${SUFFIX}`;
  await owner.unsafe(`create schema ${schema} authorization ${login}`);
  try {
    // Owning the schema also grants its owner CREATE on it (schema ownership implies that privilege).
    assert.deepEqual(await runtimeLoginViolations(login), ['login_owns_objects', 'schema_create_privilege']);
  } finally {
    await owner.unsafe(`drop schema if exists ${schema} cascade`);
  }
});

test('M6PF-05: the cluster superuser fails many checks, login_superuser among them', async () => {
  // The exact list is not pinned here: the bootstrap superuser's ownership and grants (it owns the whole database,
  // every migration-created object, and every role) vary with how the disposable cluster was initialized, so unlike
  // the shapes below this one legitimately differs across environments. Only the one violation this case exists to
  // prove is asserted.
  const [{ u: superuser }] = await owner`select current_user as u`;
  assert.ok((await runtimeLoginViolations(superuser)).includes('login_superuser'));
});

test('M6PF-06: a BYPASSRLS login is refused with EXACTLY [login_bypassrls]', async () => {
  const login = await createLogin('bypassrls', { attrs: 'nosuperuser nocreatedb nocreaterole noreplication bypassrls inherit' });
  assert.deepEqual(await runtimeLoginViolations(login), ['login_bypassrls']);
});

test('M6PF-07: a SET-only membership on a NOLOGIN role that owns objects violates membership_unexpected and role_owns_objects', async () => {
  const login = await createLogin('setonly');
  const extra = `tmpos_m6pf_extra_${SUFFIX}`;
  const schema = `m6pf_extra_${SUFFIX}`;
  await owner.unsafe(`create role ${extra} nologin`);
  createdRoles.add(extra);
  await owner.unsafe(`create schema ${schema} authorization ${extra}`);
  await owner.unsafe(`grant ${extra} to ${login} with inherit false, set true`);
  try {
    assert.deepEqual(await runtimeLoginViolations(login), ['membership_unexpected', 'role_owns_objects']);
  } finally {
    await owner.unsafe(`drop schema if exists ${schema} cascade`);
  }
});

test('M6PF-08: an unexpected direct table privilege violates login_privilege_unexpected', async () => {
  const login = await createLogin('directpriv');
  await owner.unsafe(`grant select on tmpos_rate_limit.bucket to ${login}`);
  assert.deepEqual(await runtimeLoginViolations(login), ['login_privilege_unexpected']);
});

const SIMPLE_LOGIN_CASES = [
  { label: '09', name: 'CREATEDB', code: 'login_createdb', opts: { attrs: 'nosuperuser createdb nocreaterole noreplication nobypassrls inherit' } },
  { label: '10', name: 'CREATEROLE', code: 'login_createrole', opts: { attrs: 'nosuperuser nocreatedb createrole noreplication nobypassrls inherit' } },
  { label: '12', name: 'a missing tmpos_audit_writer membership', code: 'membership_missing', opts: { memberships: ['tmpos_app'] } },
  { label: '13', name: 'a missing ledger SELECT', code: 'login_ledger_read_missing', opts: { ledgerGrant: false } },
];
for (const { label, name, code, opts } of SIMPLE_LOGIN_CASES) {
  test(`M6PF-${label}: ${name} violates exactly ${code}`, async () => {
    const login = await createLogin(`c${label}`, opts);
    assert.deepEqual(await runtimeLoginViolations(login), [code]);
  });
}

test('M6PF-11: ADMIN OPTION on tmpos_app violates membership_admin_option', async () => {
  const login = await createLogin('adminopt', { memberships: [] });
  await owner.unsafe(`grant tmpos_app to ${login} with admin option`);
  await owner.unsafe(`grant tmpos_audit_writer to ${login}`);
  assert.deepEqual(await runtimeLoginViolations(login), ['membership_admin_option']);
});

test('M6PF-14: a stray privilege granted to tmpos_app violates role_privilege_unexpected — revoked in finally', async () => {
  await owner.unsafe(`grant select on tmpos_rate_limit.bucket to tmpos_app`);
  try {
    assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['role_privilege_unexpected']);
  } finally {
    await owner.unsafe(`revoke select on tmpos_rate_limit.bucket from tmpos_app`);
  }
});

test('M6PF-15: a revoked approved privilege on tmpos_app violates role_privilege_missing — re-granted exactly in finally', async () => {
  await owner.unsafe(`revoke usage on schema public from tmpos_app`);
  try {
    assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['role_privilege_missing']);
  } finally {
    await owner.unsafe(`grant usage on schema public to tmpos_app`);
  }
});

test('M6PF-16: a login role-defaulted to switch role violates login_role_switched', async () => {
  const login = await createLogin('roleswitch');
  await owner.unsafe(`alter role ${login} set role = tmpos_app`);
  assert.deepEqual(await runtimeLoginViolations(login), ['login_role_switched']);
});

// ---------------------------------------------------------------------------
// M6PF-17..22: the ledger, driven through the entry end to end
// ---------------------------------------------------------------------------

const LEDGER_ENTRY_CASES = [
  { label: '17', name: 'missing 015', code: 'migration_missing', mutate: () => owner`delete from public.schema_migrations where version = '015'` },
  { label: '18', name: 'a gap (010 removed)', code: 'migration_not_contiguous', mutate: () => owner`delete from public.schema_migrations where version = '010'` },
  { label: '19', name: 'dirty 013', code: 'migration_dirty', mutate: () => owner`update public.schema_migrations set dirty = true where version = '013'` },
  { label: '20', name: 'finished_at null on 013', code: 'migration_dirty', mutate: () => owner`update public.schema_migrations set finished_at = null where version = '013'` },
  { label: '21', name: "an extra '016' row", code: 'migration_unknown', mutate: () => owner`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at) values ('016', ${'0'.repeat(64)}, false, now(), now())` },
  { label: '22', name: 'a changed checksum on 015', code: 'migration_checksum_mismatch', mutate: () => owner`update public.schema_migrations set checksum = ${'f'.repeat(64)} where version = '015'` },
];
for (const { label, name, code, mutate } of LEDGER_ENTRY_CASES) {
  test(`M6PF-${label}: ${name}, driven through the entry, refuses migration_state_invalid[${code}], exit [1], no listener`, async () => {
    await withLedgerMutation(mutate, async () => {
      const watch = watchBinds();
      try {
        const handle = await startEntry({});
        assert.equal(handle.result.outcome, 'refused');
        assert.equal(handle.result.failure, 'migration_state_invalid');
        assert.deepEqual(handle.result.reasons, [code]);
        assert.equal(handle.result.address, null);
        assert.deepEqual(handle.exits, [1]);
        assert.equal(watch.count(), 0, 'a refused entry never reaches step 10: no socket was ever bound');
      } finally {
        watch.restore();
      }
    });
  });
}

test('M6PF-23: a login without the ledger SELECT gets migration_ledger_unreadable from the module directly (the login check runs first in the entry)', async () => {
  const login = await createLogin('unreadable', { ledgerGrant: false });
  assert.deepEqual(await ledgerViolations(login), ['migration_ledger_unreadable']);
});

// ---------------------------------------------------------------------------
// M6PF-24..29: the limiter key's boot check
// ---------------------------------------------------------------------------

test('M6PF-24: with no fingerprint registered, the entry registers the canonical key before listening', async () => {
  await owner`delete from tmpos_rate_limit.key_fingerprint`;
  try {
    // The row as the store holds it at the moment the entry attempts its bind: an entry that binds first and registers
    // the key later is caught here, since its registration has not committed when the bind is attempted.
    let atBind = null;
    const watch = watchBinds(() => { atBind ??= fingerprintRow(); });
    let handle;
    try {
      handle = await startEntry({});
    } finally {
      watch.restore();
    }
    try {
      assert.equal(handle.result.outcome, 'listening', JSON.stringify(handle.result));
      assert.equal(watch.count(), 1, 'the entry binds exactly one socket');
      const row = await fingerprintRow();
      assert.notEqual(row, null);
      assert.ok(Buffer.from(row.fingerprint).equals(rateLimitKeyFingerprint(CANONICAL_KEY)));
      assert.deepEqual(await atBind, row, 'the canonical key was registered before the socket was bound');
    } finally {
      await stopEntry(handle);
    }
  } finally {
    await restoreCanonicalFingerprint();
  }
});

test('M6PF-25: a second key is refused rate_limit_key_mismatch — the fingerprint row and every bucket row are byte-identical after', async () => {
  await restoreCanonicalFingerprint();
  const before = { fp: await fingerprintRow(), buckets: await bucketRows() };
  const watch = watchBinds();
  try {
    const handle = await startEntry({ RATE_LIMIT_KEY: SECOND_KEY.toString('base64url') });
    assert.equal(handle.result.outcome, 'refused');
    assert.equal(handle.result.failure, 'rate_limit_key_mismatch');
    assert.equal(handle.result.address, null);
    assert.deepEqual(handle.exits, [1]);
    assert.equal(watch.count(), 0, 'refused before step 10: no socket was ever bound');
  } finally {
    watch.restore();
  }
  const after = { fp: await fingerprintRow(), buckets: await bucketRows() };
  assert.deepEqual(after.fp, before.fp); // singleton, fingerprint bytes and registered_at, all unchanged
  assert.deepEqual(after.buckets, before.buckets); // every column of every row, unchanged (none written)
});

test('M6PF-26: KEY SKEW — an instance keyed differently is refused at boot while the canonically keyed instance keeps serving', async () => {
  await restoreCanonicalFingerprint();
  const watchA = watchBinds();
  let a;
  try {
    a = await startEntry({});
  } finally {
    watchA.restore();
  }
  assert.equal(watchA.count(), 1, 'the canonical instance binds exactly one socket');
  try {
    assert.equal(a.result.outcome, 'listening');
    assert.equal((await get(a.result.address.port, '/readiness')).status, 200);

    const watchC = watchBinds();
    let c;
    try {
      c = await startEntry({ RATE_LIMIT_KEY: SECOND_KEY.toString('base64url') });
    } finally {
      watchC.restore();
    }
    assert.equal(c.result.outcome, 'refused');
    assert.equal(c.result.failure, 'rate_limit_key_mismatch');
    assert.equal(watchC.count(), 0, 'the skewed instance is refused before step 10: no socket was ever bound');

    // The first /readiness above cached its answer for READINESS_PROBE_REUSE_MS: wait past it so this one is a
    // fresh probe of the shared store, not the cached 200 — proof the store is still genuinely ready after the skew.
    await new Promise((r) => setTimeout(r, READINESS_PROBE_REUSE_MS + 200));
    assert.equal((await get(a.result.address.port, '/readiness')).status, 200, 'the first keeps serving');
  } finally {
    await stopEntry(a);
  }
});

test('M6PF-27: CONCURRENT FIRST REGISTRATION — two entries race the first fingerprint; exactly one listens, and the stored fingerprint is its key', async () => {
  await owner`delete from tmpos_rate_limit.key_fingerprint`;
  let x = null;
  let y = null;
  try {
    const watch = watchBinds();
    try {
      [x, y] = await Promise.all([startEntry({}), startEntry({ RATE_LIMIT_KEY: SECOND_KEY.toString('base64url') })]);
    } finally {
      watch.restore();
    }
    const outcomes = [x.result.outcome, y.result.outcome].sort();
    assert.deepEqual(outcomes, ['listening', 'refused']);
    const xWon = x.result.outcome === 'listening';
    const refused = xWon ? y : x;
    const winningKey = xWon ? CANONICAL_KEY : SECOND_KEY; // x used startEntry({}) — BASE_ENV's CANONICAL_KEY; y used SECOND_KEY
    assert.equal(refused.result.failure, 'rate_limit_key_mismatch');
    assert.deepEqual(refused.exits, [1]);
    // Exactly one socket was bound across the whole race: since the listening entry alone reaches step 10 (and does
    // so exactly once), this also proves the loser — whichever it was — attempted zero binds.
    assert.equal(watch.count(), 1, 'exactly one of the race actually bound a socket');
    const row = await fingerprintRow();
    assert.notEqual(row, null);
    assert.ok(row.fingerprint.equals(rateLimitKeyFingerprint(winningKey)));
  } finally {
    if (x !== null) await stopEntry(x); // a no-op for whichever was refused; stops the other
    if (y !== null) await stopEntry(y);
    await restoreCanonicalFingerprint();
  }
});

test('M6PF-28: a read-only login answers rate_limit_store_read_only, driven through the entry', async () => {
  await restoreCanonicalFingerprint();
  await owner.unsafe(`alter role ${RUNTIME_LOGIN} set default_transaction_read_only = on`);
  const watch = watchBinds();
  try {
    const handle = await startEntry({});
    assert.equal(handle.result.outcome, 'refused');
    assert.equal(handle.result.failure, 'rate_limit_store_read_only');
    assert.equal(handle.result.address, null);
    assert.deepEqual(handle.exits, [1]);
    assert.equal(watch.count(), 0, 'refused before step 10: no socket was ever bound');
  } finally {
    watch.restore();
    await owner.unsafe(`alter role ${RUNTIME_LOGIN} reset default_transaction_read_only`);
  }
});

test('M6PF-29: probeRateLimitKey answers consume_unavailable when the login cannot execute the consume routine (module level)', async () => {
  const CONSUME_FN = 'tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer)';
  await owner.unsafe(`revoke execute on function ${CONSUME_FN} from tmpos_app`);
  try {
    const client = clientAs(RUNTIME_LOGIN);
    try {
      assert.equal(await probeRateLimitKey(client, CANONICAL_KEY, signal()), 'consume_unavailable');
    } finally {
      await client.end();
    }
  } finally {
    await owner.unsafe(`grant execute on function ${CONSUME_FN} to tmpos_app`);
  }
});

// ---------------------------------------------------------------------------
// M6PF-30..36: PUBLIC exposure, foreign-database dependency, role membership, and RLS-shape drift
// ---------------------------------------------------------------------------

test('M6PF-30: a PUBLIC relation grant and a PUBLIC column grant on an application table both violate public_privilege_unexpected', async () => {
  await owner.unsafe(`grant select on public.tenant to public`);
  try {
    assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['public_privilege_unexpected']);
  } finally {
    await owner.unsafe(`revoke select on public.tenant from public`);
  }

  await owner.unsafe(`grant update (legal_name) on public.tenant to public`);
  try {
    assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['public_privilege_unexpected']);
  } finally {
    await owner.unsafe(`revoke update (legal_name) on public.tenant from public`);
  }
});

test('M6PF-31: a SECURITY DEFINER routine left at its default ACL in public violates public_privilege_unexpected; SECURITY INVOKER is allowed', async () => {
  // proacl null (the true, uncustomized default) is a property of the CREATING role's own pg_default_acl. Migration 005's
  // "alter default privileges ... revoke all on functions from public" applied to the migration owner itself (owner, used
  // for every DDL in this suite), so a function it creates now gets an explicit ACL excluding public, not a null one. A
  // role that never ran that statement still gets the raw default, so the routine is created through one.
  const owningRole = `tmpos_m6pf_defowner_${SUFFIX}`;
  await owner.unsafe(`create role ${owningRole} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  createdRoles.add(owningRole);
  await owner.unsafe(`grant usage, create on schema public to ${owningRole}`);
  // CLIENT_OPTS may itself carry `user` (the ambient embedded socket user); it must lose to the explicit override,
  // exactly as clientAs() below orders it — otherwise the DDL silently runs as the cluster superuser again.
  const defOwner = postgres(driverDsn(TARGET_DSN, owningRole), { ...CLIENT_OPTS, max: 1, onnotice: () => {}, user: owningRole });
  try {
    const definerName = `m6pf_definer_${SUFFIX}`;
    await defOwner.unsafe(`create function public.${definerName}() returns int language sql security definer as 'select 1'`);
    try {
      assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['public_privilege_unexpected']);
    } finally {
      await defOwner.unsafe(`drop function public.${definerName}()`);
    }

    const invokerName = `m6pf_invoker_${SUFFIX}`;
    await defOwner.unsafe(`create function public.${invokerName}() returns int language sql security invoker as 'select 1'`);
    try {
      assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), []);
    } finally {
      await defOwner.unsafe(`drop function public.${invokerName}()`);
    }
  } finally {
    await defOwner.end({ timeout: 5 });
    await owner.unsafe(`revoke usage, create on schema public from ${owningRole}`);
  }
});

test('M6PF-32: a policy naming PUBLIC on an application table violates public_privilege_unexpected', async () => {
  const name = `m6pf_pub_${SUFFIX}`;
  await owner.unsafe(`create policy ${name} on public.tenant for select to public using (true)`);
  try {
    assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['public_privilege_unexpected']);
  } finally {
    await owner.unsafe(`drop policy ${name} on public.tenant`);
  }
});

test('M6PF-33: disabling row security on public.store changes the pinned policy line shape: exactly role_privilege_missing and role_privilege_unexpected', async () => {
  await owner.unsafe(`alter table public.store disable row level security`);
  try {
    assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['role_privilege_missing', 'role_privilege_unexpected']);
  } finally {
    await owner.unsafe(`alter table public.store enable row level security`);
  }
});

test('M6PF-34: granting tmpos_audit_writer to tmpos_app gives the login a further membership path — role_membership_unexpected', async () => {
  await owner.unsafe(`grant tmpos_audit_writer to tmpos_app`);
  try {
    assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['role_membership_unexpected']);
  } finally {
    await owner.unsafe(`revoke tmpos_audit_writer from tmpos_app`);
  }
});

test('M6PF-35: a privilege recorded in another database of the cluster violates foreign_database_dependency', async (t) => {
  try {
    await owner.unsafe(`create database ${OTHER_DB}`);
  } catch (err) {
    // A CI-provided cluster (TM_POS_TEST_DATABASE_URL) is expected to grant CREATE DATABASE to this suite's owner;
    // a refusal there is a real infrastructure regression, not a property of a restricted shared cluster, so it
    // fails the test. Only a local disposable cluster this harness cannot control may legitimately refuse it.
    if (typeof ambient === 'string' && ambient.trim() !== '') {
      throw new Error(`CREATE DATABASE refused on the CI-provided cluster (TM_POS_TEST_DATABASE_URL set): ${err.message}`);
    }
    t.skip(`CREATE DATABASE refused by the local disposable cluster: ${err.message}`);
    return;
  }
  const otherDsn = (() => {
    const url = new URL(driverDsn(TARGET_DSN));
    url.pathname = `/${OTHER_DB}`;
    return url.toString();
  })();
  let otherClient = null;
  try {
    otherClient = postgres(otherDsn, { ...CLIENT_OPTS, max: 1, onnotice: () => {} });
    await otherClient.unsafe(`create table t (x int)`);
    await otherClient.unsafe(`grant select on t to ${RUNTIME_LOGIN}`);
    assert.deepEqual(await runtimeLoginViolations(RUNTIME_LOGIN), ['foreign_database_dependency']);
  } finally {
    if (otherClient) await otherClient.end({ timeout: 5 });
    await owner.unsafe(`drop database if exists ${OTHER_DB} with (force)`); // FORCE ends any session still in it
  }
});

test('M6PF-36: a PUBLIC table grant, driven through the entry, refuses database_login_unsafe[public_privilege_unexpected], exit [1], no listener', async () => {
  await owner.unsafe(`grant select on public.tenant to public`);
  const watch = watchBinds();
  try {
    const handle = await startEntry({});
    assert.equal(handle.result.outcome, 'refused');
    assert.equal(handle.result.failure, 'database_login_unsafe');
    assert.deepEqual(handle.result.reasons, ['public_privilege_unexpected']);
    assert.equal(handle.result.address, null);
    assert.deepEqual(handle.exits, [1]);
    assert.equal(watch.count(), 0, 'refused before step 10: no socket was ever bound');
  } finally {
    watch.restore();
    await owner.unsafe(`revoke select on public.tenant from public`);
  }
});
