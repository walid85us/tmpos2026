// M7A-DBTEST-ISOLATION-P0 — the incident reproduced against the real suites (its own CI step; slower than the runner allows).
//
// Incident (M7A-CUSTOMERS-P2, 2026-09-27): `npm run test:db` given a socket-form TM_POS_TEST_DATABASE_URL; the
// migration-engine suite stripped its `?host=` and postgres.js reached the server the ambient PG* settings named.
// Here each affected suite, and `npm run test:db`, get that exact shape of target — a disposable database on a socket
// directory where nothing listens — while the synthetic ambient settings point at the sentinel (dbSentinel.mjs). A fixed
// suite dials only its own socket and fails with ENOENT; the entry code dialed the sentinel (21, 2, 2 and 28 times).
// Run: node_modules/.bin/tsx --test tests/quality/db-test-ambient-fallback.suites.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TSX, AFFECTED, reachedSocket, startSentinel } from './dbSentinel.mjs';

let sentinel;
const scratch = mkdtempSync(join(tmpdir(), 'tmpos-sentinel-'));
const NO_SOCKET = join(scratch, 'no-socket');
const INCIDENT_TARGET = `postgres:///tmpos_s1b_sentinel?host=${encodeURIComponent(NO_SOCKET)}&user=synthetic_owner`;
const REACHED_OWN_SOCKET = reachedSocket(NO_SOCKET);
test.before(async () => { sentinel = await startSentinel(); });
test.after(async () => { await sentinel.close(); rmSync(scratch, { recursive: true, force: true }); });

test('DBISO-1: given the incident target, each affected suite keeps its socket host and never dials the ambient server', async () => {
  for (const suite of AFFECTED) {
    const r = await sentinel.run(TSX, ['--test', suite], { TM_POS_TEST_DATABASE_URL: INCIDENT_TARGET }, 300_000);
    assert.equal(r.dials, 0, `${suite} dialed the ambient sentinel`);
    assert.notEqual(r.code, 0, `${suite} must fail: nothing listens on the supplied socket`);
    assert.match(r.output, REACHED_OWN_SOCKET, `${suite} must fail by dialing the supplied socket, not before connecting`);
  }
});

test('DBISO-2: npm run test:db given the incident target never dials the ambient server and fails', async () => {
  const r = await sentinel.run('npm', ['run', '--silent', 'test:db'], { TM_POS_TEST_DATABASE_URL: INCIDENT_TARGET }, 300_000);
  assert.equal(r.dials, 0, 'test:db dialed the ambient sentinel');
  assert.notEqual(r.code, 0);
  assert.match(r.output, REACHED_OWN_SOCKET, 'test:db must fail by dialing the supplied socket, not before connecting');
});
