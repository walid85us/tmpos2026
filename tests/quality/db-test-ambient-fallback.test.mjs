// M7A-DBTEST-ISOLATION-P0 — database tests never fall back to an ambient database (the fast half; the runner runs it).
//
// Incident (M7A-CUSTOMERS-P2, 2026-09-27): a CI-order replay gave `npm run test:db` a socket-form
// TM_POS_TEST_DATABASE_URL. The migration-engine suite stripped its `?host=`, and postgres.js filled
// host, port, user and password from the ambient PG* variables, reaching a managed server.
//
// SYNTHETIC values only: the ambient PG* settings and DATABASE_URL point at a listener this file owns (see
// dbSentinel.mjs), so any dial it sees is a fallback. No PostgreSQL is needed and nothing else is reachable.
// Here: targets refused before any dial, the driver boundary, and the static guard over every database suite.
// The slower half — real suites and `npm run test:db` given the incident's own target — is
// db-test-ambient-fallback.suites.mjs, its own CI step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, TSX, AFFECTED, DIALED_A_SOCKET, REFUSED, startSentinel } from './dbSentinel.mjs';

let sentinel;
const scratch = mkdtempSync(join(tmpdir(), 'tmpos-sentinel-'));
const NO_SOCKET = join(scratch, 'no-socket');
test.before(async () => { sentinel = await startSentinel(); });
test.after(async () => { await sentinel.close(); rmSync(scratch, { recursive: true, force: true }); });

test('DBISO-3: a target with its host stripped, a loopback TCP target outside the declared CI service, or an altered target is refused before any dial', async () => {
  const cases = [
    'postgres:///tmpos_s1b_sentinel',                                                       // host missing entirely
    'postgres:///tmpos_s1b_sentinel?user=synthetic_owner',                                  // host stripped, user kept
    `postgres://synthetic_owner@127.0.0.1:${sentinel.port}/tmpos_s1b_sentinel`,             // arbitrary loopback, no CI declaration
    `postgres:///tmpos_s1b_sentinel?host=${encodeURIComponent(NO_SOCKET)}&dbname=other`,    // altered: libpq would select another database
  ];
  for (const target of cases) {
    const r = await sentinel.run(TSX, ['--test', AFFECTED[0]], { TM_POS_TEST_DATABASE_URL: target }, 30_000);
    assert.equal(r.dials, 0, 'a refused target was dialed');
    assert.notEqual(r.code, 0, 'a refused target must fail the suite, not select another database');
    assert.match(r.output, REFUSED, 'the failure must be the bounded target refusal');
    assert.doesNotMatch(r.output, DIALED_A_SOCKET, 'a refused target must not be dialed at all');
  }
  // A step that declares the CI service but supplies no target is refused, not quietly given a local cluster.
  const r = await sentinel.run(TSX, ['scripts/run-db-tests.mjs', AFFECTED[0]], { TM_POS_TEST_DATABASE_KIND: 'ci-disposable-service' }, 30_000);
  assert.equal(r.dials, 0);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /disposable test target refused: a target kind is declared but no target is supplied/);
});

test('DBISO-4: the driver boundary refuses an incomplete or retargeted client even in a clean environment', async () => {
  const port = sentinel.port;
  // A child, so the harness's import-time scrub cannot touch this process.
  const r = await sentinel.run(TSX, ['--input-type=module', '-e', `
    import { targetFromSupplied, testClient, testDriver, checkedDriver } from './tests/db/localPostgres.harness.mjs';
    import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
    const tcp = targetFromSupplied('postgres://synthetic_owner@127.0.0.1:${port}/tmpos_s1b_sentinel', { kind: 'ci-disposable-service', ciDeclared: true });
    const out = [];
    const tryIt = (name, fn) => { try { fn(); out.push(name + ':accepted'); } catch (e) { out.push(name + ':' + (e.code ?? 'error')); } };
    tryIt('unresolved', () => testClient({ host: '127.0.0.1', port: ${port}, user: 'x', database: 'tmpos_s1b_x' }));
    tryIt('retarget', () => testClient(tcp, { host: '10.0.0.1' }));
    tryIt('notDisposable', () => testClient(tcp, { database: 'postgres' }));
    tryIt('emptyUser', () => testClient(tcp, { user: '' }));
    tryIt('driverNoRole', () => testDriver(tcp)('postgres:///tmpos_s1b_sentinel', { max: 1 })); // a socket URL cannot carry one
    tryIt('driverEmptyRole', () => testDriver(tcp)('postgres:///tmpos_s1b_sentinel', { max: 1, user: '' }));
    process.env.PGHOST = '127.0.0.1';
    tryIt('ambientPresent', () => testClient(tcp));
    delete process.env.PGHOST;
    const tmp = encodeURIComponent(${JSON.stringify(tmpdir())});
    const links = mkdtempSync(${JSON.stringify(tmpdir())} + '/tmpos-links-');
    const escape = links + '/out';
    const dangling = links + '/dangling';
    symlinkSync('/', escape);
    symlinkSync('/tmpos-no-such-target', dangling);
    tryIt('checkedTraversal', () => checkedDriver(tcp)('postgres://synthetic_owner@/tmpos_s1b_sentinel', { host: ${JSON.stringify(tmpdir())} + '/../var/run/postgresql', port: 5432 }));
    for (const raw of [
      'postgres://u@127.0.0.1/tmpos_s1b_x',                                   // CI service without its port
      'postgres://u@db.example.com:5432/tmpos_s1b_x',                         // remote host
      'postgres://u@localhost:5432/tmpos_s1b_x',                              // a name, not the literal address
      \`postgres:///tmpos_s1b_x?host=\${tmp}%2Fs&service=x\`,                   // libpq service lookup
      \`postgres:///tmpos_s1b_x?host=\${tmp}%2Fs&passfile=x\`,                  // libpq password file
      \`postgres:///tmpos_s1b_x?host=\${tmp}%2Fs&port=5433\`,                   // a socket target naming another port
      \`postgres:///postgres?host=\${tmp}%2Fs\`,                                // not a disposable database
      \`postgres:///tmpos_s1b_x?host=\${tmp}\`,                                 // the temp root itself (a standing cluster's default)
      \`postgres:///tmpos_s1b_x?host=\${tmp}%2F..%2Fvar%2Frun%2Fpostgresql\`,     // leaves the temp root through '..'
      \`postgres:///tmpos_s1b_x?host=\${encodeURIComponent(escape)}%2Fvar%2Frun%2Fpostgresql\`, // a symlink below the root leading out of it
      \`postgres:///tmpos_s1b_x?host=\${encodeURIComponent(dangling)}\`,          // a dangling symlink
    ]) {
      tryIt('supplied', () => targetFromSupplied(raw, { kind: 'ci-disposable-service', ciDeclared: true }));
    }
    tryIt('tcpUndeclared', () => targetFromSupplied('postgres://u@127.0.0.1:${port}/tmpos_s1b_x', { kind: undefined, ciDeclared: false }));
    rmSync(links, { recursive: true, force: true });
    console.log('CASES ' + JSON.stringify(out));
  `], {}, 30_000);
  assert.equal(r.code, 0);
  const out = JSON.parse(/^CASES (.+)$/m.exec(r.output)[1]);
  assert.ok(out.length === 20 && out.every((o) => /:(disposable_target_refused|test_dsn_[a-z_]+)$/.test(o)), `every case must be refused with a bounded code: ${out.join(' ')}`);
  assert.equal(r.dials, 0, 'no refused client may dial');
});

test('DBISO-5: every database suite and launcher goes through the harness target, never a raw driver, the variable itself, or the inherited environment', () => {
  const dbDir = join(REPO, 'tests', 'db');
  for (const f of readdirSync(dbDir).filter((n) => n.endsWith('.mjs') && n !== 'localPostgres.harness.mjs')) {
    const src = readFileSync(join(dbDir, f), 'utf8');
    assert.ok(!/['"]postgres['"]\s*\)|from\s*['"]postgres['"]|createRequire/.test(src), `${f} loads the driver directly; use testClient, testDriver or testDriverVia`);
    assert.ok(!/TM_POS_TEST_DATABASE_URL/.test(src), `${f} reads the target variable itself; use resolveDisposableTarget`);
    assert.ok(!/\.\.\.\s*process\.env\b|Object\.assign\([^)]*process\.env|env\s*:\s*process\.env\b/.test(src), `${f} hands a child the inherited environment; use childEnv`);
  }
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:db'], /^tsx scripts\/run-db-tests\.mjs /);
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const dbRuns = ci.split('\n').filter((l) => /run:.*tests\/db\/\S+\.integration\.test\.mjs/.test(l));
  assert.ok(dbRuns.length > 0 && dbRuns.every((l) => l.includes('scripts/run-db-tests.mjs')), 'every CI database step goes through the launcher');
  assert.ok(ci.includes('tests/quality/db-test-ambient-fallback.suites.mjs'), 'the incident reproduction runs in CI');
});
