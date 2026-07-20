// Phase 4.0 M3 — tests for the frontend (vitest) ratchet's pure validator.
//
// scripts/run-frontend-tests.mjs invokes vitest and judges its machine-readable report.
// The invocation is exercised end-to-end by the mutation harness; these tests pin the
// DECISION logic — validateFrontendRun — directly, over synthesised reports, so every
// fail-closed branch is covered without a 20-second vitest run per case.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_FRONTEND_FILES,
  MIN_FRONTEND_CASES,
  REQUIRED_FRONTEND_SUITES,
  validateFrontendRun,
  formatFrontendRatchet,
} from '../../scripts/run-frontend-tests.mjs';

const REPO = '/repo';

/** A suite entry as vitest reports it: absolute path + per-assertion statuses. */
function suite(rel, executed, { failed = false } = {}) {
  return {
    name: `${REPO}/${rel}`,
    status: failed ? 'failed' : 'passed',
    assertionResults: Array.from({ length: executed }, () => ({ status: failed ? 'failed' : 'passed' })),
  };
}

/** A full report at exactly the ratchet floor, with every required suite executed. */
function healthyReport({ extraFiles = 0, casesPerExtra = 1 } = {}) {
  const results = REQUIRED_FRONTEND_SUITES.map((s) => suite(s, 1));
  let files = results.length;
  let cases = results.length;
  // Pad files up to the file floor.
  for (let i = 0; files < MIN_FRONTEND_FILES; i++, files++) { results.push(suite(`src/pad-${i}.test.tsx`, 1)); cases++; }
  // Top up remaining cases on one dedicated file.
  if (cases < MIN_FRONTEND_CASES) { results.push(suite('src/pad-cases.test.tsx', MIN_FRONTEND_CASES - cases)); cases = MIN_FRONTEND_CASES; files++; }
  for (let i = 0; i < extraFiles; i++) results.push(suite(`src/extra-${i}.test.tsx`, casesPerExtra));
  return { success: true, numFailedTests: 0, testResults: results };
}

const check = (report, exitCode = 0) => validateFrontendRun({ report, exitCode, repoRoot: REPO });

test('a healthy run at the floor passes', () => {
  const { ok, problems, summary } = check(healthyReport());
  assert.equal(ok, true, problems.join('; '));
  assert.ok(summary.executedFiles >= MIN_FRONTEND_FILES);
  assert.ok(summary.executedCases >= MIN_FRONTEND_CASES);
  assert.deepEqual(summary.missingSuites, []);
});

test('a run above the floor passes — future additions are not blocked', () => {
  const { ok } = check(healthyReport({ extraFiles: 3, casesPerExtra: 4 }));
  assert.equal(ok, true);
});

test('a non-zero exit fails even when the counts are met', () => {
  const { ok, problems } = check(healthyReport(), 1);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('vitest exited 1')), problems.join('; '));
});

test('a self-reported failure fails even when the counts are met', () => {
  const { ok, problems } = check({ ...healthyReport(), success: false });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('reported the run as failed')), problems.join('; '));
});

test('a failed test case fails the ratchet', () => {
  const { ok, problems } = check({ ...healthyReport(), numFailedTests: 2 });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('2 frontend test case(s) failed')), problems.join('; '));
});

test('no machine-readable report at all fails', () => {
  for (const bad of [null, undefined, {}, { testResults: 'nope' }]) {
    const { ok, problems } = validateFrontendRun({ report: bad, exitCode: 0, repoRoot: REPO });
    assert.equal(ok, false, `report ${JSON.stringify(bad)} must fail`);
    assert.ok(problems.some((p) => p.includes('no machine-readable report')), problems.join('; '));
  }
});

test('fewer executed files than the floor fails', () => {
  // One file, but it runs enough cases that the CASE floor is met — so the FILE floor trips.
  const results = [suite('src/only.test.tsx', MIN_FRONTEND_CASES)];
  for (const s of REQUIRED_FRONTEND_SUITES) results.push(suite(s, 1));
  // That is REQUIRED_FRONTEND_SUITES.length + 1 files, still below MIN_FRONTEND_FILES.
  const { ok, problems, summary } = check({ success: true, numFailedTests: 0, testResults: results });
  assert.ok(summary.executedFiles < MIN_FRONTEND_FILES, 'fixture must be below the file floor');
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('frontend test files, below the ratchet minimum')), problems.join('; '));
});

test('fewer executed cases than the floor fails', () => {
  // Enough files, but each runs a single case — below the case floor.
  const results = [];
  for (let i = 0; i < MIN_FRONTEND_FILES; i++) results.push(suite(`src/f-${i}.test.tsx`, 1));
  for (const s of REQUIRED_FRONTEND_SUITES) results.push(suite(s, 1));
  const { ok, problems } = check({ success: true, numFailedTests: 0, testResults: results });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('frontend test cases, below the ratchet minimum')), problems.join('; '));
});

test('a required suite present but executing zero cases fails', () => {
  const report = healthyReport();
  const target = REQUIRED_FRONTEND_SUITES[0];
  report.testResults = report.testResults.map((s) => (s.name.endsWith(target) ? suite(target, 0) : s));
  report.testResults.push(suite('src/topup.test.tsx', MIN_FRONTEND_CASES)); // keep the case floor met
  const { ok, problems, summary } = check(report);
  assert.equal(ok, false);
  assert.deepEqual(summary.missingSuites, [target]);
  assert.ok(problems.some((p) => p.includes(`not executed (missing, empty, or asserting nothing): ${target}`)), problems.join('; '));
});

test('a required suite absent from the report entirely fails', () => {
  const report = healthyReport();
  const target = REQUIRED_FRONTEND_SUITES[1];
  report.testResults = report.testResults.filter((s) => !s.name.endsWith(target));
  report.testResults.push(suite('src/topup2.test.tsx', MIN_FRONTEND_CASES));
  const { ok, summary } = check(report);
  assert.equal(ok, false);
  assert.ok(summary.missingSuites.includes(target));
});

test('skipped and todo cases do not count toward the case floor', () => {
  const skippy = {
    name: `${REPO}/${REQUIRED_FRONTEND_SUITES[0]}`,
    status: 'passed',
    assertionResults: [{ status: 'skipped' }, { status: 'todo' }, { status: 'skipped' }],
  };
  const report = healthyReport();
  report.testResults = report.testResults.map((s) => (s.name.endsWith(REQUIRED_FRONTEND_SUITES[0]) ? skippy : s));
  const { ok, summary } = check(report);
  assert.equal(ok, false, 'a suite of only skipped/todo cases must not satisfy the required-suite rule');
  assert.ok(summary.missingSuites.includes(REQUIRED_FRONTEND_SUITES[0]));
});

test('a duplicated suite path is not banked twice', () => {
  const results = [];
  for (let i = 0; i < MIN_FRONTEND_FILES - 1; i++) results.push(suite(`src/u-${i}.test.tsx`, 1));
  for (const s of REQUIRED_FRONTEND_SUITES) results.push(suite(s, 1));
  results.push(suite('src/u-0.test.tsx', 1)); // duplicate of an existing path
  const { summary } = check({ success: true, numFailedTests: 0, testResults: results });
  const distinct = new Set(results.map((s) => s.name)).size;
  assert.equal(summary.executedFiles, distinct, 'a repeated path must not inflate the file count');
});

test('a required suite reported as failed is flagged even if it executed cases', () => {
  const report = healthyReport();
  const target = REQUIRED_FRONTEND_SUITES[2];
  report.testResults = report.testResults.map((s) => (s.name.endsWith(target) ? suite(target, 1, { failed: true }) : s));
  const { ok, problems } = check(report);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes(`required frontend suite failed: ${target}`)), problems.join('; '));
});

test('the floors match the exact verified counts of the current suite', () => {
  // A guard on the guard: these must be the real numbers, not placeholders. If the suite
  // legitimately grows, both are raised deliberately and this updates with them.
  assert.equal(MIN_FRONTEND_FILES, 13);
  assert.equal(MIN_FRONTEND_CASES, 114);
  assert.ok(REQUIRED_FRONTEND_SUITES.length >= 4);
});

test('the ratchet output is bounded: counts and suite paths only', () => {
  const report = healthyReport();
  const target = REQUIRED_FRONTEND_SUITES[0];
  report.testResults = report.testResults.map((s) => (s.name.endsWith(target) ? suite(target, 0) : s));
  const { summary, ok } = check(report);
  const out = formatFrontendRatchet(summary, ok);
  assert.match(out, /executed files\s+\d+/);
  assert.match(out, /executed cases\s+\d+/);
  assert.match(out, /frontend ratchet\s+(PASS|FAIL)/);
  assert.ok(!out.includes(REPO), 'must not leak an absolute path');
});
