// M7A-DBTEST-ISOLATION-P0 — the sentinel both ambient-fallback checks share (not a suite; the runner does not discover it).
//
// A short-lived listener on 127.0.0.1 stands in for the ambient database server: the synthetic PG* settings and
// DATABASE_URL a child is given point at it, so every connection it accepts is a fallback. Children get an environment
// built from scratch and run in their own process group, so a timeout kills grandchildren too (npm → launcher → tsx).
// Output stays in memory and is only matched, never printed.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const REPO = process.cwd();
export const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
export const AFFECTED = ['migrationEngine', 'rlsIsolation', 'auditAtomicity'].map((s) => `tests/db/${s}.integration.test.mjs`);
/** The corrected suite dialed the supplied socket file itself (nothing listens there), not some other server. */
export const reachedSocket = (dir) => new RegExp(`connect ENOENT ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.s\\.PGSQL\\.5432`);
/** Any socket dial at all. */
export const DIALED_A_SOCKET = /connect ENOENT/;
/** A bounded refusal from the harness or the executor's own DSN guard. */
export const REFUSED = /disposable test target refused|test_dsn_[a-z_]+/;

export async function startSentinel() {
  let dials = 0;
  const server = createServer((sock) => { dials += 1; sock.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  /** Tool paths only, then the synthetic ambient database settings, then the case's own values. */
  const env = (extra = {}) => {
    const base = {};
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LOCALE_ARCHIVE', 'TZDIR']) if (process.env[k] !== undefined) base[k] = process.env[k];
    return {
      ...base,
      PGHOST: '127.0.0.1',
      PGPORT: String(port),
      PGUSER: 'sentinel_user',
      PGPASSWORD: 'sentinel-synthetic-password',
      PGDATABASE: 'tmpos_s1b_sentinel',
      DATABASE_URL: `postgres://sentinel_user:sentinel-synthetic-password@127.0.0.1:${port}/tmpos_s1b_sentinel`,
      ...extra,
    };
  };

  /** Run to completion (or kill the whole group at `limitMs`); answer the exit code, the new dials and the output. */
  const run = (cmd, args, extra, limitMs = 60_000) => {
    const before = dials;
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: REPO, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let output = '';
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, limitMs);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, dials: dials - before, output }); });
    });
  };

  return { port, env, run, dials: () => dials, close: () => new Promise((resolve) => server.close(resolve)) };
}
