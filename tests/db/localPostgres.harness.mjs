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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

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
    if (k.startsWith('PG') || k.endsWith('DATABASE_URL')) delete env[k];
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
 */
export function startDisposablePostgres() {
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
      '--no-sync',
    ], env);

    // Socket-only: no TCP listener at all, so no local port is exposed.
    appendFileSync(join(dataDir, 'postgresql.conf'), [
      '',
      "# S1b disposable cluster: socket-only, no TCP port.",
      "listen_addresses = ''",
      `unix_socket_directories = '${sockDir}'`,
      'fsync = off',
      'full_page_writes = off',
      'synchronous_commit = off',
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

export { BOOTSTRAP_ROLE, DB_PREFIX };
