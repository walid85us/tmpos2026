// M7A-CUSTOMERS-P2 — tenantMain.ts, mirroring main.test.ts: importing it starts nothing; run as the real entry point
// (spawned under tsx, exactly as `npm run start:tenant` would run it, compiled or not) it fails closed on a missing/invalid
// configuration — a planted tenant minting key included — without ever leaking a configuration value, a stack trace or
// the word "Error" to stdout or stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MAIN = join(REPO, 'server', 'entry', 'tenantMain.ts');

// Preloaded into the child (before tsx): counts every net.Server.prototype.listen call — http.Server inherits it, so
// this is every listener the process could open — and reports the total on stderr as the process exits.
const LISTEN_COUNTER = 'data:text/javascript,' + encodeURIComponent('import net from "node:net"; let n = 0; '
  + 'const listen = net.Server.prototype.listen; '
  + 'net.Server.prototype.listen = function (...args) { n += 1; return listen.apply(this, args); }; '
  + 'process.on("exit", () => { process.stderr.write("listen-calls=" + n + "\\n"); });');

test('M7TM-01 importing tenantMain.ts in a child process with only PATH set starts nothing: clean exit 0, empty stdout, zero listen calls', () => {
  // A regressed entry guard must never be able to run against THIS process's own environment (which may carry real
  // secrets on this machine): the probe runs in a child that inherits only PATH, spawned fresh under tsx exactly as
  // `npm start` would launch it. A bare import (process.argv[1] is absent under `-e`, so tenantMain.ts's own isEntry guard
  // stays false) must reach the end of module evaluation with nothing pending, exit 0 on its own within the bound,
  // and never have called listen at all — a listener opened and closed again would still leave a clean exit behind,
  // so the preloaded counter, not the exit alone, is what proves nothing was bound. The child imports tenantMain.ts by a
  // literal path relative to its cwd (the repository root).
  const run = spawnSync(process.execPath, ['--import', LISTEN_COUNTER, '--import', 'tsx', '-e', 'await import("./server/entry/tenantMain.ts");'], {
    cwd: REPO, encoding: 'utf8', timeout: 5_000, env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(run.error, undefined, `spawnSync must not fail to start the process: ${String(run.error)}`);
  assert.equal(run.signal, null, `must not be killed by the bound (something kept the event loop alive): ${JSON.stringify(run)}`);
  assert.equal(run.status, 0, `a plain import must exit 0\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.equal(run.stdout, '', 'a plain import must print nothing to stdout');
  assert.match(run.stderr, /^listen-calls=0$/m, `a plain import must never call listen\nstderr:\n${run.stderr}`);

  // Positive control: the same preload counts a listener that is opened and closed again, so the zero above is real.
  const control = spawnSync(process.execPath, ['--import', LISTEN_COUNTER, '-e',
    'require("node:http").createServer().listen(0, "127.0.0.1", function () { this.close(); });'], {
    cwd: REPO, encoding: 'utf8', timeout: 5_000, env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(control.status, 0, `the control must exit 0\nstderr:\n${control.stderr}`);
  assert.match(control.stderr, /^listen-calls=1$/m, `the counter must see the control's listen call\nstderr:\n${control.stderr}`);
});

test('M7TM-02 spawned as the entry point under tsx with only NODE_ENV=production and planted distinctive invalid values: exits 1 within 10s, logs a bounded config_invalid refusal, and leaks nothing', () => {
  // PLANT_A: an identifier with no KEY/SECRET/TOKEN word, whose value carries no such word next to its
  // high-entropy suffix either — so a word-adjacent-to-entropy scanner over this SOURCE file has nothing to flag,
  // while the value is still distinctive enough (per-run random) to prove absent from the child's stdout/stderr.
  const PLANT_A = `m7tm-marker-${randomBytes(8).toString('hex')}`;
  // A well-formed but planted minting key: canonical base64url of 32 random bytes, which must never be echoed either.
  const PLANT_KEY = randomBytes(32).toString('base64url');
  // Deliberately minimal: only NODE_ENV=production plus a handful of clearly-invalid, marker-bearing values.
  // PORT, TRUSTED_PROXY_CIDRS's validity, and everything else the baseline would supply are left absent, so
  // this can never dial a real endpoint — and the parent's own environment (which may carry real secrets on
  // this machine) is never inherited.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '/tmp',
    NODE_ENV: 'production',
    APP_DATABASE_URL: `postgres://runtime:${PLANT_A}@notarealhost.invalid:5432/postgres`,
    DATABASE_CA_CERT: PLANT_A,
    RATE_LIMIT_KEY: PLANT_A,
    IDEMPOTENCY_KEY: PLANT_A,
    TRUSTED_PROXY_CIDRS: PLANT_A,
    SESSION_ADMIN_ORIGINS: `https://${PLANT_A}.invalid`,
    SESSION_TENANT_ORIGINS: `https://${PLANT_A}.tenant.invalid/`,
    TENANT_SESSION_ISSUER_KEY: PLANT_KEY,
    FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: PLANT_A,
    // PORT is deliberately absent: port_missing.
  };
  // Launched as `npm run start:tenant` would under tsx, with the same listen counter preloaded as the import test above:
  // argv[1] is still MAIN, so tenantMain.ts's own guard selects main(), and the counter proves the refusal never called listen.
  const run = spawnSync(process.execPath, ['--import', LISTEN_COUNTER, '--import', 'tsx', MAIN], { cwd: REPO, encoding: 'utf8', timeout: 10_000, env });
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  const combined = stdout + stderr;

  assert.equal(run.error, undefined, `spawnSync must not fail to start the process: ${String(run.error)}`);
  assert.equal(run.signal, null, `must not be killed by the spawnSync timeout: ${combined}`);
  assert.equal(run.status, 1, `must exit 1\nstdout:\n${stdout}\nstderr:\n${stderr}`);

  assert.match(stdout, /"event":"startup_refused"/, 'stdout must carry the startup_refused event');
  assert.match(stdout, /"reason":"config_invalid[:,]/, 'the refusal category must be config_invalid');
  for (const pair of ['PORT:port_missing', 'DATABASE_CA_CERT:database_ca_invalid', 'RATE_LIMIT_KEY:rate_limit_key_invalid',
    'IDEMPOTENCY_KEY:idempotency_key_present', 'TRUSTED_PROXY_CIDRS:trusted_proxies_invalid', 'SESSION_TENANT_ORIGINS:session_tenant_origin_invalid',
    'FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON:identity_verifier_unconfigured']) {
    assert.ok(stdout.includes(pair), `stdout must carry the field:code pair ${pair}\n${stdout}`);
  }

  assert.ok(!combined.includes(PLANT_A), `no planted configuration value may appear anywhere in stdout/stderr:\n${combined}`);
  assert.ok(!combined.includes(PLANT_KEY), `the planted minting key may appear nowhere in stdout/stderr:\n${combined}`);
  assert.ok(!/\bError\b/.test(combined), `no 'Error' text may appear in stdout/stderr:\n${combined}`);
  assert.ok(!/\bat\s+.*:\d+:\d+/.test(combined), `no stack trace frame may appear in stdout/stderr:\n${combined}`);
  assert.ok(!combined.includes('node_modules'), `no stack-trace-shaped path may appear in stdout/stderr:\n${combined}`);
  assert.match(stderr, /^listen-calls=0$/m, `a config refusal must never call listen\nstderr:\n${stderr}`);
});

test('M7TM-03 launched through a symlinked directory under --preserve-symlinks-main, tenantMain.ts still recognises itself as the entry and reaches the config refusal', () => {
  // --preserve-symlinks-main keeps import.meta.url on the symlinked path while realpath(argv[1]) resolves it: a guard that
  // canonicalises only one side would see two different paths and silently exit 0 without starting. The link names the
  // server/ directory, so tenantMain.ts's relative imports still resolve; the child inherits PATH alone and has no PORT (nor
  // anything else), so it can never dial or bind — it must refuse config_invalid and exit 1.
  const dir = mkdtempSync(join(tmpdir(), 'm7tm-link-'));
  try {
    const link = join(dir, 'server');
    symlinkSync(resolve(REPO, 'server'), link, 'dir');
    const run = spawnSync(process.execPath, ['--preserve-symlinks-main', '--import', LISTEN_COUNTER, '--import', 'tsx', join(link, 'entry', 'tenantMain.ts')], {
      cwd: REPO, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '' },
    });
    assert.equal(run.error, undefined, `spawnSync must not fail to start the process: ${String(run.error)}`);
    assert.equal(run.signal, null, `must not be killed by the spawnSync timeout\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.equal(run.status, 1, `a symlinked launch must start and refuse, not exit silently\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /"event":"startup_refused"/);
    assert.match(run.stdout, /"reason":"config_invalid[:,]/);
    assert.match(run.stderr, /^listen-calls=0$/m, `a config refusal must never call listen\nstderr:\n${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
