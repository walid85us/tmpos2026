// Phase 4.0 M2 — tests for the deterministic runner's discovery ratchet.
//
// Discovery used to fail OPEN: `walk()` swallowed a missing root, and zero discovered files
// reported `suites=0 pass=0 fail=0` and exited 0 — a green run that tested nothing. Deleting
// or renaming `tests/quality/` would have silently uncollected the gate suites while CI stayed
// green. These tests hold the ratchet closed from both directions: it must reject an
// incomplete discovery, and it must not reject the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  REPO_ROOT,
  ROOTS,
  MIN_SUITES,
  REQUIRED_SENTINELS,
  isTestPath,
  isInsideRepo,
  discover,
  validateDiscovery,
  formatRatchet,
  suiteContentProblem,
} from '../../scripts/run-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const RUNNER = join(REPO, 'scripts', 'run-tests.mjs');
const created = [];

test.after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

/** A throwaway repo root carrying the configured roots and the sentinel files. */
function makeTreeFixture({ omitRoot = null, omitSentinel = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-'));
  created.push(dir);
  for (const r of ROOTS) {
    if (r === omitRoot) continue;
    mkdirSync(join(dir, r), { recursive: true });
  }
  for (const s of REQUIRED_SENTINELS) {
    if (s === omitSentinel) continue;
    // Writing a sentinel would re-create the very root under test, since mkdir is
    // recursive — so a sentinel inside an omitted root is skipped too.
    if (omitRoot !== null && s.startsWith(`${omitRoot}/`)) continue;
    mkdirSync(join(dir, dirname(s)), { recursive: true });
    writeFileSync(join(dir, s), '// fixture\n');
  }
  return dir;
}

/** Sentinels this runner is expected to collect (the .tsx harness runs under vitest). */
const RUNNABLE_SENTINELS = REQUIRED_SENTINELS.filter(isTestPath);

/** `n` distinct suite paths that include the runnable sentinels, as a real discovery would. */
function suites(n) {
  const out = [...RUNNABLE_SENTINELS];
  for (let i = out.length; i < n; i++) out.push(`server/fixture-${i}.test.ts`);
  return out.slice(0, n);
}

const check = (files, dir, extra = {}) => validateDiscovery({ files, repoRoot: dir, ...extra });

test('isTestPath accepts the deterministic suites and excludes the emulator suite', () => {
  assert.equal(isTestPath('server/a.test.ts'), true);
  assert.equal(isTestPath('tests/quality/a.test.mjs'), true);
  // The emulator suite runs separately via `firebase emulators:exec`, never here.
  assert.equal(isTestPath('tests/firestore/a.emulator.test.mjs'), false);
  // Frontend render tests are vitest's, not this runner's.
  assert.equal(isTestPath('src/components/AccessGuard.test.tsx'), false);
  assert.equal(isTestPath('server/index.ts'), false);
  assert.equal(isTestPath('README.md'), false);
});

test('zero discovered suites fails', () => {
  const dir = makeTreeFixture();
  const { ok, problems, summary } = check([], dir);
  assert.equal(ok, false);
  assert.equal(summary.discoveredSuites, 0);
  assert.ok(problems.some((p) => p.includes('no test suites were discovered')), problems.join('; '));
});

test('a missing configured root fails', () => {
  // The exact fail-open: walk() swallows a missing root, so discovery silently shrinks.
  const dir = makeTreeFixture({ omitRoot: 'tests/quality' });
  const { ok, problems } = check(suites(MIN_SUITES), dir);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('configured test root is absent: tests/quality')), problems.join('; '));
});

test('a discovered count below the ratchet fails', () => {
  const dir = makeTreeFixture();
  const { ok, problems, summary } = check(suites(MIN_SUITES - 1), dir);
  assert.equal(ok, false);
  assert.equal(summary.discoveredSuites, MIN_SUITES - 1);
  assert.ok(problems.some((p) => p.includes(`below the ratchet minimum of ${MIN_SUITES}`)), problems.join('; '));
});

test('exactly the ratchet minimum passes', () => {
  const dir = makeTreeFixture();
  const { ok, problems, summary } = check(suites(MIN_SUITES), dir);
  assert.equal(problems.length, 0, problems.join('; '));
  assert.equal(ok, true);
  assert.equal(summary.discoveredSuites, MIN_SUITES);
});

test('more than the ratchet minimum passes', () => {
  const dir = makeTreeFixture();
  const { ok } = check(suites(MIN_SUITES + 25), dir);
  assert.equal(ok, true, 'future additions must not be blocked');
});

test('each required sentinel, removed individually, fails', () => {
  // A count alone is not enough: MIN_SUITES unrelated files would satisfy it while a
  // specific control silently disappeared.
  assert.ok(REQUIRED_SENTINELS.length >= 7, 'expected the full sentinel inventory');
  for (const sentinel of REQUIRED_SENTINELS) {
    const dir = makeTreeFixture({ omitSentinel: sentinel });
    const { ok, problems, summary } = check(suites(MIN_SUITES), dir);
    assert.equal(ok, false, `removing ${sentinel} must fail the ratchet`);
    assert.deepEqual(summary.missingSentinels, [sentinel]);
    assert.ok(problems.some((p) => p.includes(`required sentinel suite is missing, empty, or uncollected: ${sentinel}`)), problems.join('; '));
  }
});

test('all required sentinels present passes', () => {
  const dir = makeTreeFixture();
  const { ok, summary } = check(suites(MIN_SUITES), dir);
  assert.equal(ok, true);
  assert.deepEqual(summary.missingSentinels, []);
  assert.equal(summary.requiredSentinels, REQUIRED_SENTINELS.length);
});

test('the sentinel inventory covers every required control, by literal path', () => {
  // Each control named in the gate contract must map to a real file, so a sentinel cannot
  // be satisfied by an empty directory or a pattern that matches nothing.
  const required = {
    'Firestore static rules regression': 'tests/firestore/firestore.rules.static.test.mjs',
    'dependency-audit reconciliation': 'tests/quality/check-dependency-audit.test.mjs',
    'Gitleaks scan-tree/reconciliation': 'tests/quality/prepare-gitleaks-scan-tree.test.mjs',
    'typecheck contract': 'tests/quality/check-typecheck-contract.test.mjs',
    'lockfile portability': 'tests/quality/check-lockfile-portability.test.mjs',
    'controlled-action/BCP security corpus': 'server/bcp-pilot/bcpPilot.test.ts',
    'frontend render tests': 'src/components/AccessGuard.test.tsx',
  };
  for (const [control, path] of Object.entries(required)) {
    assert.ok(REQUIRED_SENTINELS.includes(path), `${control} must be a sentinel (${path})`);
  }
  for (const s of REQUIRED_SENTINELS) {
    assert.ok(/\.(test\.ts|test\.mjs|test\.tsx)$/.test(s), `sentinel must be a test file, not a directory: ${s}`);
  }
});

test('duplicate paths do not inflate the count', () => {
  const dir = makeTreeFixture();
  const base = suites(MIN_SUITES - 1);
  const dupes = [...base, base[0], base[1]];
  assert.equal(dupes.length, MIN_SUITES + 1, 'fixture must look like it clears the ratchet');
  const { ok, summary } = check(dupes, dir);
  assert.equal(summary.discoveredSuites, MIN_SUITES - 1, 'duplicates must collapse');
  assert.equal(ok, false, 'a padded count must not satisfy the ratchet');
});

test('a non-canonical path is not banked twice', () => {
  // `a/../a.test.ts` and `a.test.ts` are the same file; exact-string dedupe would miss it,
  // and a partial collapse to exactly MIN_SUITES would sneak a duplicate past the ratchet.
  const dir = makeTreeFixture();
  const base = suites(MIN_SUITES - 1);
  const target = base[base.length - 1]; // e.g. server/fixture-62.test.ts
  const sneaky = [...base, `server/sub/../${target.slice('server/'.length)}`, `./${target}`];
  const { ok, summary } = check(sneaky, dir);
  assert.equal(summary.discoveredSuites, MIN_SUITES - 1, 'all spellings of one file must collapse to a single entry');
  assert.equal(ok, false, 'a duplicate must not lift the count to the ratchet minimum');
});

test('a directory named like a sentinel does not satisfy it', () => {
  // existsSync alone is true for a directory — which proves nothing about test coverage.
  const dir = makeTreeFixture({ omitSentinel: REQUIRED_SENTINELS[0] });
  mkdirSync(join(dir, REQUIRED_SENTINELS[0]), { recursive: true });
  const { ok, summary } = check(suites(MIN_SUITES), dir);
  assert.equal(ok, false, 'a directory must not stand in for a sentinel suite');
  assert.deepEqual(summary.missingSentinels, [REQUIRED_SENTINELS[0]]);
});

test('an empty sentinel file does not satisfy it', () => {
  const dir = makeTreeFixture({ omitSentinel: REQUIRED_SENTINELS[1] });
  mkdirSync(join(dir, dirname(REQUIRED_SENTINELS[1])), { recursive: true });
  writeFileSync(join(dir, REQUIRED_SENTINELS[1]), '');
  const { ok, summary } = check(suites(MIN_SUITES), dir);
  assert.equal(ok, false, 'an empty stub must not stand in for a sentinel suite');
  assert.deepEqual(summary.missingSentinels, [REQUIRED_SENTINELS[1]]);
});

test('a sentinel that exists but is never collected fails', () => {
  // Moved out of a configured root: present on disk, silently not run.
  const dir = makeTreeFixture();
  const withoutOne = suites(MIN_SUITES).filter((f) => f !== RUNNABLE_SENTINELS[0]);
  const padded = [...withoutOne, 'server/extra-pad.test.ts'];
  const { ok, summary } = check(padded, dir);
  assert.equal(ok, false, 'a present-but-uncollected sentinel must fail');
  assert.deepEqual(summary.missingSentinels, [RUNNABLE_SENTINELS[0]]);
});

test('paths outside the repository fail', () => {
  const dir = makeTreeFixture();
  for (const bad of ['../outside/x.test.ts', '../../etc/x.test.ts', '/etc/x.test.ts']) {
    const { ok, problems } = check([...suites(MIN_SUITES), bad], dir);
    assert.equal(ok, false, `${bad} must be rejected`);
    assert.ok(problems.some((p) => p.includes('escapes the repository')), problems.join('; '));
  }
});

test('malformed and non-test paths fail', () => {
  const dir = makeTreeFixture();
  for (const bad of ['', null, 42]) {
    const { ok, problems } = check([...suites(MIN_SUITES), bad], dir);
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('malformed path')), problems.join('; '));
  }
  const { ok, problems } = check([...suites(MIN_SUITES), 'server/index.ts'], dir);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('not a test suite')), problems.join('; '));
});

test('isInsideRepo rejects escapes and the root itself', () => {
  assert.equal(isInsideRepo(REPO_ROOT, 'server/a.test.ts'), true);
  assert.equal(isInsideRepo(REPO_ROOT, '../a.test.ts'), false);
  assert.equal(isInsideRepo(REPO_ROOT, '.'), false);
});

test('the ratchet output is bounded: counts and sentinel paths only', () => {
  const dir = makeTreeFixture({ omitSentinel: REQUIRED_SENTINELS[0] });
  const { ok, summary } = check(suites(MIN_SUITES), dir);
  const out = formatRatchet(summary, ok);
  assert.match(out, /configured roots\s+\d+/);
  assert.match(out, /discovered suites\s+\d+/);
  assert.match(out, /required sentinels\s+\d+/);
  assert.match(out, /discovery\s+FAIL/);
  assert.ok(!out.includes(dir), 'must not leak an absolute path');
  assert.ok(!out.includes(REPO_ROOT), 'must not leak the repository path');
  assert.ok(!out.includes(process.env.HOME ?? ' never'), 'must not leak environment data');
});

test('the runner CLI exits non-zero when the real discovery is below the ratchet', () => {
  // End-to-end against a real tree, not a stub: a copy of the runner in a repo whose suites
  // were removed must refuse to report green.
  const dir = makeTreeFixture();
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(RUNNER, join(dir, 'scripts', 'run-tests.mjs'));
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'run-tests.mjs')], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /discovery ratchet FAILED/);
  assert.match(r.stdout, /discovery\s+FAIL/);
});

test('a gutted node:test suite is failed; an assertion-script suite is exit-code-judged', () => {
  // The collection ratchet cannot see a gutted suite body; this closes the content half for
  // the node:test gate suites. A node:test suite that ran real tests emits `# tests N>=1`.
  const nodeTest = "import test from 'node:test';";
  const script = "import assert from 'node:assert/strict';";
  // node:test suite with real tests -> fine.
  assert.equal(suiteContentProblem({ status: 0, stdout: '# tests 20\n# pass 20\n' }, nodeTest), null);
  // node:test suite reporting zero, or (the real gutted case) emitting no count at all -> fail.
  assert.ok(suiteContentProblem({ status: 0, stdout: '# tests 0\n' }, nodeTest));
  assert.ok(suiteContentProblem({ status: 0, stdout: '' }, nodeTest), 'a gutted node:test suite emits no count and must fail');
  // An assertion-script suite (no node:test import) never emits a count — exit code only.
  assert.equal(suiteContentProblem({ status: 0, stdout: '' }, script), null);
  assert.equal(suiteContentProblem({ status: 0, stdout: 'passed\n' }, script), null);
  // No source available -> do not invent a failure.
  assert.equal(suiteContentProblem({ status: 0, stdout: '' }, ''), null);
});

test('the ratchet guard test is itself a sentinel', () => {
  // Deleting the ratchet's own test must fail the ratchet, or the guard could be removed
  // while the count is met by any other addition.
  assert.ok(REQUIRED_SENTINELS.includes('tests/quality/run-tests-discovery.test.mjs'));
  const dir = makeTreeFixture({ omitSentinel: 'tests/quality/run-tests-discovery.test.mjs' });
  const { ok, summary } = check(suites(MIN_SUITES), dir);
  assert.equal(ok, false);
  assert.deepEqual(summary.missingSentinels, ['tests/quality/run-tests-discovery.test.mjs']);
});

test('the runner still fires through a symlinked invocation path', () => {
  // Node realpaths ESM modules; a `resolve()`-only guard would no-op under a symlinked
  // checkout, exiting 0 having run nothing. mkdtemp on Linux is not a symlink, so the E2E
  // fixture cannot catch this — the symlink must be explicit.
  const dir = makeTreeFixture();
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(RUNNER, join(dir, 'scripts', 'run-tests.mjs'));
  const link = join(dir, 'runner-link.mjs');
  symlinkSync(join(dir, 'scripts', 'run-tests.mjs'), link);
  const r = spawnSync(process.execPath, [link], { cwd: dir, encoding: 'utf8' });
  // The fixture tree has no real suites, so discovery fails — the point is that main() RAN
  // (produced ratchet output and a non-zero exit) rather than silently no-opping to 0.
  assert.equal(r.status, 1, `runner must execute via a symlink, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /\[run-tests\]/);
});

test('the real repository discovery passes the ratchet', () => {
  const files = discover();
  const { ok, problems, summary } = validateDiscovery({ files });
  assert.equal(ok, true, problems.join('; '));
  assert.ok(summary.discoveredSuites >= MIN_SUITES, `discovered ${summary.discoveredSuites}, ratchet is ${MIN_SUITES}`);
  assert.deepEqual(summary.missingSentinels, []);
  assert.equal(summary.configuredRoots, ROOTS.length);
  // Discovery must be free of duplicates by construction.
  assert.equal(new Set(files).size, files.length);
});
