// Phase 4.0 M3 S1b — disposable local PostgreSQL harness (D3 architecture).
//
// Starts a THROWAWAY PostgreSQL cluster that belongs to this task and nothing else:
//   * created with the already-installed local `initdb` / `pg_ctl` — never Docker, never a
//     managed provider, never an existing cluster;
//   * living entirely inside one `mktemp -d` directory;
//   * listening ONLY on a Unix socket inside that directory (`listen_addresses = ''`), so it
//     binds no TCP port and is unreachable from outside this process tree;
//   * holding one synthetic database named `tmpos_s1b_*` with synthetic local trust auth.
//
// It reports its lifecycle honestly: starting this cluster starts a postgres process, and
// stopping it STOPS that process. That is a task-created process being stopped on purpose —
// it is not a claim that nothing was stopped.
//
// No CREATE ROLE is issued. The bootstrap superuser is the one `initdb` creates inherently.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, appendFileSync, existsSync, realpathSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, posix } from 'node:path';
import postgres from 'postgres';
import { assertDisposableTestDsn } from '../../server/platform-identity/migrationExecutor.ts';

/**
 * Bootstrap role, created by initdb itself and never by a CREATE ROLE statement.
 *
 * It is deliberately the OS account name. libpq's socket URI form carries no userinfo, and the
 * driver falls back to the OS username, so any other name would need a credential in the DSN to
 * authenticate against a cluster that has none — the exact thing this harness must not produce.
 */
const BOOTSTRAP_ROLE = userInfo().username;
/** Every disposable database this harness creates carries this prefix. */
const DB_PREFIX = 'tmpos_s1b_';

/** Child environment with every ambient PG* / application DSN stripped, so a machine that
 *  exports a production connection string cannot influence this cluster. */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (isAmbientDatabaseVar(k)) delete env[k];
  }
  return env;
}

function run(bin, args, env) {
  return execFileSync(bin, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
}

/** Absolute paths this harness is allowed to delete: only directories it created itself. */
const OWNED_DIRS = new Set();

function removeOwned(dir) {
  // Refuse to delete anything this harness did not create under the system temp directory.
  if (!OWNED_DIRS.has(dir)) return false;
  if (!dir.startsWith(tmpdir()) || dir === tmpdir()) return false;
  rmSync(dir, { recursive: true, force: true });
  OWNED_DIRS.delete(dir);
  return true;
}

/**
 * Start a disposable cluster. Returns the socket DSN plus a `stop()` that gracefully stops the
 * cluster this harness started and removes only the directory it created.
 *
 * `durable: true` (M7B-PAYMENTS-P2 PRQ-1) starts the single primary crash-durable instead of fast: fsync,
 * full_page_writes and the default synchronous_commit on, and initdb syncs its files. A suite that proves a WAL
 * flush claim needs this; every other suite keeps the fast default. `walSegmentMb` (a power of two, 1-1024) is
 * initdb's --wal-segsize, for a suite that must prove WAL arithmetic on a non-default segment size.
 */
export function startDisposablePostgres({ durable = false, walSegmentMb } = {}) {
  if (walSegmentMb !== undefined && !(Number.isInteger(walSegmentMb) && walSegmentMb >= 1 && walSegmentMb <= 1024
      && (walSegmentMb & (walSegmentMb - 1)) === 0)) {
    throw new Error('walSegmentMb must be a power of two between 1 and 1024');
  }
  const root = mkdtempSync(join(tmpdir(), 'tmpos-s1b-'));
  OWNED_DIRS.add(root);
  const dataDir = join(root, 'data');
  const sockDir = join(root, 'sock');
  const logFile = join(root, 'postgres.log');
  const pwFile = join(root, 'bootstrap.pw');
  const database = `${DB_PREFIX}${process.pid.toString(36)}${Date.now().toString(36)}`;
  const env = cleanEnv();

  const lifecycle = { started: false, stopped: false, removed: false, root, database };

  // Cleanup on every exit path, including an interrupted run. Registered BEFORE the first
  // failable step so a failure anywhere below cannot leak the directory or the cluster.
  const onExit = () => { try { stop(); } catch { /* exit path: nothing left to report to */ } };
  process.once('exit', onExit);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { onExit(); process.exit(1); });
  }

  function stop() {
    if (lifecycle.started && !lifecycle.stopped) {
      try {
        // 'fast' = graceful: roll back open transactions and shut down cleanly.
        run('pg_ctl', ['--pgdata', dataDir, '--timeout', '60', '-w', '-m', 'fast', 'stop'], env);
        lifecycle.stopped = true;
      } catch {
        try {
          run('pg_ctl', ['--pgdata', dataDir, '--timeout', '30', '-w', '-m', 'immediate', 'stop'], env);
          lifecycle.stopped = true;
        } catch {
          lifecycle.stopped = false;
        }
      }
    }
    lifecycle.removed = removeOwned(root);
    return { ...lifecycle };
  }

  /**
   * An abrupt crash of this cluster, then a restart of the SAME data directory (M7B-PAYMENTS-P2 PRQ-1, D-R4-1):
   * `pg_ctl stop -m immediate` (no shutdown checkpoint, no clean shutdown, nothing written beyond what already was), then
   * a normal start on the same data directory and log, which runs crash recovery from WAL before it accepts a connection.
   * Answers `{ log }`: the server-log text written from just before the stop through the restart (its recovery lines), for
   * the caller to parse; the harness never prints it. A failure throws a fixed message; stop() still tries to stop the
   * cluster and removes its directory.
   * Async only to yield before it answers: pg_ctl runs synchronously, so a client in this process has not yet seen its
   * connections closed by the crash, and a query sent at once would be written to a dead socket (EPIPE).
   */
  async function crashRestart() {
    if (!lifecycle.started || lifecycle.stopped) throw new Error('crashRestart: the cluster is not running');
    const from = existsSync(logFile) ? statSync(logFile).size : 0;
    try {
      run('pg_ctl', ['--pgdata', dataDir, '--timeout', '60', '-w', '-m', 'immediate', 'stop'], env);
    } catch {
      throw new Error('crashRestart: the immediate stop failed');
    }
    try {
      run('pg_ctl', ['--pgdata', dataDir, '--log', logFile, '--timeout', '120', '-w', 'start'], env);
      run('pg_isready', ['-h', sockDir, '-U', BOOTSTRAP_ROLE, '-d', database, '-t', '30'], env);
    } catch {
      // Marked stopped only once a stop succeeded: a postmaster still starting must not have its directory removed under it.
      try { run('pg_ctl', ['--pgdata', dataDir, '--timeout', '30', '-w', '-m', 'immediate', 'stop'], env); lifecycle.stopped = true; } catch { /* stop() retries */ }
      throw new Error('crashRestart: the cluster did not come back after the immediate stop');
    }
    const log = readFileSync(logFile).subarray(from).toString('utf8');
    await new Promise((resolve) => setTimeout(resolve, 250)); // let every client here process its closed connections
    return { log };
  }

  try {
    // A synthetic, throwaway bootstrap password. It never reaches a DSN (socket + local trust
    // auth) and it dies with the directory.
    writeFileSync(pwFile, `s1b-${process.pid}-${Date.now()}\n`, { mode: 0o600 });

    run('initdb', [
      '--pgdata', dataDir,
      '--username', BOOTSTRAP_ROLE,
      '--pwfile', pwFile,
      '--auth-local=trust',
      '--auth-host=reject',
      '--encoding=UTF8',
      ...(durable ? [] : ['--no-sync']),
      ...(walSegmentMb === undefined ? [] : [`--wal-segsize=${walSegmentMb}`]),
    ], env);

    // Socket-only: no TCP listener at all, so no local port is exposed.
    appendFileSync(join(dataDir, 'postgresql.conf'), [
      '',
      "# S1b disposable cluster: socket-only, no TCP port.",
      "listen_addresses = ''",
      `unix_socket_directories = '${sockDir}'`,
      ...(durable
        // lc_messages C: the server log a crash-recovery check parses is English whatever the machine's locale.
        ? ['fsync = on', 'full_page_writes = on', 'synchronous_commit = on', "lc_messages = 'C'"]
        : ['fsync = off', 'full_page_writes = off', 'synchronous_commit = off']),
      'max_connections = 20',
      '',
    ].join('\n'));

    mkdirSync(sockDir, { recursive: true });
    run('pg_ctl', ['--pgdata', dataDir, '--log', logFile, '--timeout', '60', '-w', 'start'], env);
    lifecycle.started = true;

    run('createdb', ['-h', sockDir, '-U', BOOTSTRAP_ROLE, database], env);
    // Bounded health check: the cluster must actually accept a connection on its socket.
    run('pg_isready', ['-h', sockDir, '-U', BOOTSTRAP_ROLE, '-d', database, '-t', '30'], env);
  } catch (e) {
    stop();
    throw e;
  }

  return {
    /** libpq socket form. No userinfo and no password: local trust auth over a task-owned
     *  socket, authenticated as the OS account that initdb bootstrapped. */
    dsn: `postgres:///${database}?host=${sockDir}&user=${encodeURIComponent(BOOTSTRAP_ROLE)}`,
    /** Driver options a second, test-owned connection needs to reach the same socket. */
    clientOptions: { host: sockDir, user: BOOTSTRAP_ROLE },
    socketDir: sockDir,
    database,
    root,
    stop,
    crashRestart,
    lifecycle: () => ({ ...lifecycle }),
  };
}

/** True when a usable local PostgreSQL toolchain is present. */
export function localPostgresAvailable() {
  for (const bin of ['initdb', 'pg_ctl', 'createdb', 'psql', 'pg_isready']) {
    try {
      execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Installs a synthetic tenant issuer key (migration 018, M7A-CUSTOMERS-P2) as the database OWNER, with the owner's own
 * statement (design-B §3.12): a bound parameter, and an upsert, so it is also a rotation. The key is `issuerKey` when a
 * suite reinstalls its own, otherwise 32 random bytes made in this process — never written anywhere, never a literal.
 * The suites run one at a time on the shared CI service, so each installs its own at setup and none contends for the
 * singleton. Answers the key, for the session store's `issuerKey`.
 */
export async function installTestIssuerKey(owner, issuerKey) {
  try {
    if (issuerKey === undefined) issuerKey = randomBytes(32); // a default parameter, but inside the seal
    await owner`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKey})
      on conflict (singleton) do update set key = excluded.key`;
  } catch (e) {
    throw sealedInstallError('installTestIssuerKey', e);
  }
  return issuerKey;
}

/**
 * A key install's failure, sealed for every caller: a fixed operation label and a validated SQLSTATE (also kept as `code`
 * so a caller can still branch on it), or a fixed fallback. The raw error never leaves: its message, detail, hint, where,
 * query, bound parameters and cause can all carry the key bytes (a failing row is echoed in `detail`), and node:test prints
 * every one of them for an uncaught rejection.
 */
function sealedInstallError(label, e) {
  let raw;
  try { raw = e?.code; } catch { raw = undefined; } // read once: a getter cannot pass the check and then answer other text
  const code = typeof raw === 'string' && /^[0-9A-Z]{5}$/.test(raw) && /\d/.test(raw) ? raw : null;
  const sealed = new Error(code === null ? `${label} failed (no SQLSTATE)` : `${label} failed: SQLSTATE ${code}`);
  if (code !== null) sealed.code = code;
  return sealed;
}

/**
 * Installs a synthetic payment proof key (migration 037, M7B-PAYMENTS-P2) as the database OWNER, as installTestIssuerKey
 * does for 018: a bound parameter, 32 random bytes made in this process, never written anywhere, under the next
 * generation (037's install trigger refuses any other). The tenant entry refuses to start without one, so every suite
 * that starts it installs one at setup. A database below 037 has no such table and nothing to install: answers false.
 */
export async function installTestPaymentProofKey(owner, key) {
  try {
    if (key === undefined) key = randomBytes(32); // a default parameter, but inside the seal
    const [{ present }] = await owner`select pg_catalog.to_regclass('tmpos_invoice_payment.payment_proof_key') is not null as present`;
    if (!present) return false;
    const [{ g }] = await owner`select (coalesce(pg_catalog.max(generation), 0) + 1)::text as g from tmpos_invoice_payment.payment_proof_key_generation`;
    await owner`insert into tmpos_invoice_payment.payment_proof_key (singleton, key, generation) values (true, ${key}, ${g}::bigint)
      on conflict (singleton) do update set key = excluded.key, generation = excluded.generation`;
  } catch (e) {
    throw sealedInstallError('installTestPaymentProofKey', e);
  }
  return true;
}

// ---------------------------------------------------------------------------
// M7A-DBTEST-ISOLATION-P0 — one explicit, validated target for every database test.
//
// postgres.js fills every connection field it is not given from the environment: PGHOST,
// PGPORT, PGUSER/PGUSERNAME, PGPASSWORD (an empty password counts as "not given"), PGDATABASE,
// and PG<OPTION> for its other defaults. The suites used to strip `?host=` from a supplied socket
// DSN and re-add it only for a cluster they had started themselves, so a supplied socket target
// fell back to the ambient PG* settings and reached whatever server those named. Here the target
// is resolved and checked once, every client is built from explicit options only (never a URL),
// and the ambient database variables are removed from this process and from every child.
// ---------------------------------------------------------------------------

/** The only variable naming a supplied target, and the declaration the CI service step sets. */
export const TARGET_VAR = 'TM_POS_TEST_DATABASE_URL';
export const TARGET_KIND_VAR = 'TM_POS_TEST_DATABASE_KIND';
/** The one TCP target accepted: the loopback service GitHub Actions provisions for this job. */
export const CI_SERVICE_KIND = 'ci-disposable-service';

/** Names a driver or libpq tool could read as connection settings: every PG* (connection,
 *  service, passfile, SSL, options), and any project database URL or database setting. */
export const isAmbientDatabaseVar = (name) => name.startsWith('PG') || name.includes('DATABASE') || /(^|_)DB_URL$/.test(name);

// Captured once, then removed: nothing later in this process can read an ambient setting.
const SUPPLIED = Object.freeze({ dsn: process.env[TARGET_VAR], kind: process.env[TARGET_KIND_VAR] });
const CI_DECLARED = process.env.GITHUB_ACTIONS === 'true';
for (const k of Object.keys(process.env)) if (isAmbientDatabaseVar(k)) delete process.env[k];

export class DisposableTargetRefused extends Error {
  constructor(reason) {
    // Fixed reason strings only; a DSN, credential or host is never part of the message.
    super(`disposable test target refused: ${reason}`);
    this.name = 'DisposableTargetRefused';
    this.code = 'disposable_target_refused';
  }
}
const refuse = (reason) => { throw new DisposableTargetRefused(reason); };

const TARGETS = new WeakSet();

/**
 * A socket directory strictly below the temp root: in normal form (no `..`, not the root itself, where a standing
 * cluster keeps its socket), and still below the root's real path once every existing component's symlinks resolve.
 * A path that does not exist yet is judged by its nearest existing ancestor; a dangling symlink on the way is refused.
 */
function underTempRoot(path) {
  const dir = path.replace(/\/+$/, '');
  const root = tmpdir();
  if (!dir.startsWith(`${root}/`) || posix.normalize(dir) !== dir) return false;
  let existing = dir;
  while (!existsSync(existing)) {
    if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) return false; // dangling link
    existing = posix.dirname(existing);
  }
  return `${realpathSync(existing)}${dir.slice(existing.length)}`.startsWith(`${realpathSync(root)}/`);
}
const ALLOWED_PARAMS = new Set(['host', 'user']);

/** Validate a supplied DSN into a complete target, without connecting and without a fallback. */
export function targetFromSupplied(raw, { kind = SUPPLIED.kind, ciDeclared = CI_DECLARED } = {}) {
  const handle = assertDisposableTestDsn(raw); // host class, disposable name, pool mode, TLS downgrade
  const url = new URL(raw.trim());
  for (const k of url.searchParams.keys()) if (!ALLOWED_PARAMS.has(k)) refuse('unsupported DSN parameter');
  let host;
  let port;
  if (handle.hostKind === 'unix_socket') {
    // A harness cluster listens on the default port; a socket target naming another is altered.
    if (url.port !== '') refuse('a socket target may not name a port');
    host = url.searchParams.get('host');
    port = 5432;
  } else {
    // A loopback address proves nothing about what listens there. TCP is accepted only as the
    // service CI provisions for this job, only when the step says so, and only at the literal
    // address the workflow maps (never a name /etc/hosts could redirect).
    if (!(ciDeclared && kind === CI_SERVICE_KIND)) refuse('a TCP target is accepted only as the declared CI disposable service');
    if (url.hostname !== '127.0.0.1') refuse('the CI service target must be 127.0.0.1');
    if (url.port === '') refuse('the CI service target must name its port');
    host = url.hostname;
    port = Number(url.port);
  }
  const user = decodeURIComponent(url.username) || url.searchParams.get('user') || '';
  const password = url.password === '' ? null : decodeURIComponent(url.password);
  return register({ source: 'supplied', hostKind: handle.hostKind, host, port, user, password, database: handle.database, dsn: raw.trim() });
}

function register(target) {
  if (typeof target.host !== 'string' || target.host === '') refuse('host missing');
  if (target.hostKind === 'unix_socket' && !underTempRoot(target.host)) refuse('socket directory is not confined below the temp root');
  if (!Number.isSafeInteger(target.port) || target.port <= 0 || target.port > 65535) refuse('port missing or invalid');
  if (typeof target.user !== 'string' || target.user === '') refuse('user missing');
  if (typeof target.database !== 'string' || !target.database.startsWith(DB_PREFIX)) refuse('database is not disposable');
  const frozen = Object.freeze(target);
  TARGETS.add(frozen);
  return frozen;
}

/** The supplied target, validated without connecting, or undefined when none was supplied. */
export function suppliedTarget() {
  const supplied = typeof SUPPLIED.dsn === 'string' ? SUPPLIED.dsn.trim() : '';
  // A declared CI service with no target is a broken step, not a request for a local cluster.
  if (supplied === '' && SUPPLIED.kind !== undefined) refuse('a target kind is declared but no target is supplied');
  return supplied === '' ? undefined : targetFromSupplied(supplied);
}

/**
 * The target for one suite: the supplied TM_POS_TEST_DATABASE_URL when present (validated, never
 * repaired), otherwise a fresh cluster this harness starts. There is no third source. `durable` is passed to
 * startDisposablePostgres; a supplied target is never reconfigured, so a durable suite checks its settings itself.
 */
export function resolveDisposableTarget(label, { durable = false, walSegmentMb } = {}) {
  const supplied = suppliedTarget();
  if (supplied !== undefined) {
    // A supplied target is never reconfigured, so a WAL segment size cannot be honoured; refuse rather than run on the wrong size.
    if (walSegmentMb !== undefined) throw new Error(`${label} REFUSED: walSegmentMb=${String(walSegmentMb).slice(0, 16)} cannot be honoured on a supplied target (${TARGET_VAR}); run this suite with no supplied target so the harness starts its own cluster.`);
    return supplied;
  }
  if (!localPostgresAvailable()) {
    throw new Error(`${label} INFRASTRUCTURE BLOCKER: no ${TARGET_VAR} and no local initdb/pg_ctl. Docker and remote databases are not substitutes.`);
  }
  const cluster = startDisposablePostgres({ durable, walSegmentMb });
  return register({
    source: 'harness', hostKind: 'unix_socket', host: cluster.socketDir, port: 5432, user: BOOTSTRAP_ROLE,
    password: null, database: cluster.database, dsn: cluster.dsn, cluster,
  });
}

/**
 * The ONLY way a suite builds a driver client. Host, port, user, database and password are always
 * passed explicitly, so no field is left for the driver to fill from the environment; a caller may
 * pick another role or another disposable database on the same server, never another server.
 * Checked here, at the driver boundary, independently of the resolver and of the scrub above.
 */
export function testClient(target, options = {}) {
  if (!TARGETS.has(target)) refuse('client target was not resolved by the harness');
  for (const k of ['host', 'hostname', 'port', 'path', 'socket']) if (k in options) refuse('a client option may not retarget the server');
  // Another role never inherits the target's own password.
  const { user = target.user, username, database = target.database, db, password = options.user === undefined ? target.password : null, pass, connection, ...rest } = options;
  if (username !== undefined || db !== undefined || pass !== undefined) refuse('use user, database and password');
  if (typeof user !== 'string' || user === '') refuse('user missing');
  if (typeof database !== 'string' || !database.startsWith(DB_PREFIX)) refuse('database is not disposable');
  const ambient = Object.keys(process.env).filter(isAmbientDatabaseVar);
  if (ambient.length > 0) refuse(`ambient database settings present (${ambient.join(',')})`);
  const secret = password ?? '';
  return postgres({
    ...rest,
    host: target.host,
    port: target.port,
    user,
    database,
    pass: () => secret, // a function, so an empty password cannot fall back to PGPASSWORD
    connection: { application_name: 'tmpos-db-test', ...connection },
  });
}

/**
 * A `postgres`-shaped factory bound to one target, for production code that takes the driver as a
 * parameter (createSupervisedPgClient, adapters). The URL may name a role and a disposable database
 * on the SAME server; its host is never used, and a URL naming another host is refused.
 */
export function testDriver(target) {
  return driverOver(target, target);
}

/**
 * The same factory, dialing a socket directory the TEST owns under the temp root instead of the server:
 * a byte relay that forwards only to `target` (so a suite can take the store down), a directory where
 * nothing listens, or a listener that never answers. Role, database and password stay the target's;
 * no field is left to the environment.
 */
export function testDriverVia(target, socketDir) {
  if (!TARGETS.has(target)) refuse('driver target was not resolved by the harness');
  if (typeof socketDir !== 'string' || !socketDir.startsWith(`${tmpdir()}/`)) refuse('a relay must be a socket directory under the temp root');
  const { cluster: _cluster, ...fields } = target;
  return driverOver(target, register({ ...fields, source: 'relay', hostKind: 'unix_socket', host: socketDir, port: 5432 }));
}

function driverOver(named, dial) {
  if (!TARGETS.has(named) || !TARGETS.has(dial)) refuse('driver target was not resolved by the harness');
  return (url, options = {}) => {
    let u;
    try { u = new URL(url); } catch { refuse('driver URL is not a URL'); }
    if (u.hostname !== '' && u.hostname !== named.host) refuse('a driver URL may not retarget the server');
    const database = decodeURIComponent(u.pathname.slice(1)) || named.database;
    // The role must be named: a socket URL has no host, so WHATWG URL silently drops a username set on it,
    // and falling back to the target's own (owner) role would run a least-privilege test as the owner.
    const urlUser = decodeURIComponent(u.username);
    const { user = urlUser === '' ? undefined : urlUser, ...rest } = options;
    if (typeof user !== 'string' || user === '') refuse('a driver call must name its role');
    return testClient(dial, { ...rest, database, user });
  };
}

/**
 * A driver factory for a store that cannot be reached: an explicit socket in a fresh, empty directory
 * this harness owns, so nothing listens there and nothing ambient can be consulted. For the tests that
 * prove the unreachable-database path; it never reaches any server.
 */
export function unreachableTestDriver() {
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-unreachable-'));
  OWNED_DIRS.add(dir);
  process.once('exit', () => removeOwned(dir));
  return testDriver(register({
    source: 'unreachable', hostKind: 'unix_socket', host: join(dir, 'no-socket'), port: 5432, user: 'tmpos_unreachable',
    password: null, database: `${DB_PREFIX}unreachable`, dsn: '',
  }));
}

/**
 * A `postgres`-shaped function for the driver-defect probes (pgDriverDefects.child.mjs), which must place the transport
 * themselves: a socket hook, or a local relay. Every other field is still explicit, and the transport must be local.
 * Accepted transports: `socket` (a hook the probe owns); the target's own host; 127.0.0.1 (a relay the probe listens on);
 * a socket directory under the temp root. Refused: a missing user or transport, a non-disposable database, anything ambient.
 */
export function checkedDriver(target) {
  if (!TARGETS.has(target)) refuse('driver target was not resolved by the harness');
  return (url, options = {}) => {
    let u;
    try { u = new URL(url); } catch { refuse('driver URL is not a URL'); }
    const ambient = Object.keys(process.env).filter(isAmbientDatabaseVar);
    if (ambient.length > 0) refuse(`ambient database settings present (${ambient.join(',')})`);
    const database = options.database ?? decodeURIComponent(u.pathname.slice(1));
    if (!database.startsWith(DB_PREFIX)) refuse('database is not disposable');
    const user = options.user ?? decodeURIComponent(u.username);
    if (typeof user !== 'string' || user === '') refuse('user missing');
    if ('hostname' in options || 'path' in options) refuse('use host and port');
    const host = options.host ?? (u.hostname === '' ? undefined : u.hostname);
    const port = options.port ?? (u.port === '' ? undefined : Number(u.port));
    if (typeof options.socket !== 'function') {
      const local = host === target.host || host === '127.0.0.1' || (typeof host === 'string' && underTempRoot(host));
      if (!local || !Number.isSafeInteger(port)) refuse('a probe transport must be explicit and local');
    }
    const secret = options.password ?? options.pass ?? (u.password === '' ? '' : decodeURIComponent(u.password));
    return postgres(url, { ...options, user, database, pass: typeof secret === 'function' ? secret : () => secret });
  };
}

/** Variables a child process may inherit. Everything else, and every database setting, is dropped. */
const CHILD_PASS_THROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALE_ARCHIVE', 'TZ', 'TZDIR', 'TERM', 'NODE_OPTIONS', 'CI', 'GITHUB_ACTIONS', 'NO_COLOR', 'FORCE_COLOR'];

/**
 * A minimal, explicit child environment: the pass-through list, the target this process resolved
 * (when given), and the caller's own values. An ambient database setting cannot ride along.
 */
export function childEnv(target, extra = {}) {
  const env = {};
  for (const k of CHILD_PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (target !== undefined) {
    if (!TARGETS.has(target)) refuse('child target was not resolved by the harness');
    env[TARGET_VAR] = target.dsn;
    if (target.hostKind === 'loopback') { env[TARGET_KIND_VAR] = CI_SERVICE_KIND; }
  }
  return { ...env, ...extra };
}

/** Supplied-target facts a launcher may print: the host class and the disposable database name. */
export function describeTarget(target) {
  return { source: target.source, hostKind: target.hostKind, database: target.database };
}

export { BOOTSTRAP_ROLE, DB_PREFIX };
