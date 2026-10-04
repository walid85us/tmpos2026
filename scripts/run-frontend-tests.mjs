#!/usr/bin/env node
// Phase 4.0 M3 — frontend (vitest) test-execution ratchet.
//
// The two lanes are deliberately separate. The Node runner (scripts/run-tests.mjs)
// collects `.test.ts` / `.test.mjs`; vitest collects `src/**/*.test.tsx`. Neither
// can see the other, and until now only the Node lane had a ratchet.
//
// WHY THIS EXISTS. The Node runner lists the React suites as sentinels, but its
// sentinel check for a `.test.tsx` path can only ask "does a non-empty file exist
// here?" — that runner never executes those files, so it cannot know whether they
// asserted anything. `vitest run` then reports success on whatever it happens to
// collect, with no floor of its own. Measured on this repository: replacing
// src/components/ShippingCenter.test.tsx with a non-empty stub carrying one
// trivial passing test took the suite from 104 cases to 96 while `vitest run`
// exited 0 AND the Node discovery ratchet still reported PASS. Eight real
// regression tests disappeared behind two green gates.
//
// So this gate judges the RUN, not the files. It reads vitest's machine-readable
// report and requires: the run actually succeeded, the number of executed test
// FILES has not fallen, the number of executed test CASES has not fallen, and every
// named critical suite was collected and executed at least one assertion.
//
// Deliberately NOT how this is implemented, because each is satisfiable by a file
// that tests nothing: a file-size check, a non-empty check, a grep for `it(`/
// `test(`/`describe(`, any source-text token scan, or a pass-through that ignores
// vitest's own result.
//
// "Executed" means a case vitest actually ran — status passed or failed. A skipped
// or todo case is NOT executed, so `it.skip` cannot hold the case count up while
// the assertions stop running.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/**
 * Floors, equal to the exact verified counts of the current suite. Raise them when
 * frontend tests are added; they may never be lowered to accommodate a deletion.
 */
export const MIN_FRONTEND_FILES = 28; // M7A-CUSTOMERS-P3-R2: +2, src/tenant/ServerCustomerLevels.test.tsx, src/context/AccessContext.tenantSession.test.tsx; M7A-CUSTOMERS-P5: +3, src/tenant/ServerCustomerDirectory.test.tsx, src/layouts/TenantLayout.customerDirectory.test.tsx, src/components/Customers.localBanner.test.tsx; M7A-CUSTOMERS-P9: +2, src/tenant/ServerCustomerPicker.test.tsx, src/components/Invoices.serverCustomer.test.tsx; M7A-CUSTOMERS-P10: +1, src/components/RepairTickets.serverCustomer.test.tsx; M5-INVOICES-AUTH-P1: +1, src/tenant/ServerInvoiceLevels.test.tsx
export const MIN_FRONTEND_CASES = 743; // M7A-CUSTOMERS-P3-R2: +28 (SCL-01..25, ATS-01..03); M7A-CUSTOMERS-P4: +27 (SCL-26..52); M7A-CUSTOMERS-P5: +52 (SCD-00..45, NAV-01..04, LCB-01..02), fix batch 1: +10 (SCD-46..55), fix batch 2: +6 (SCD-56..61); M7A-CUSTOMERS-P5-R1: +3 (SCD-62..64); review fixes: +8 (SCD-65..71, SCL-53); SCD-72; M7A-CUSTOMERS-P6: +8 (SCD-73..78, SCL-54..55); fix batch: +3 (SCD-79..81), re-review: SCD-82; contact UI: +10 (SCD-83..92); M7A-CUSTOMERS-P7: +13 (SCD-93..105), review fixes: +7 (SCD-106..112), round 2: +15 (SCD-113..127), round 3: +12 (SCD-128..139), round 4: +4 (SCD-140..143), round 5: +3 (SCD-144..146); M7A-CUSTOMERS-P8: +15 (SCD-147..161), fix batch: +1 (SCD-162), review fixes: +3 (SCD-163..165); M7A-CUSTOMERS-P9: +52 (SCP-01..39, INV-01..13), review fixes: +9 (SCP-40..46, INV-14..15), round 2: +1 (SCP-47); M7A-CUSTOMERS-P10: +8 (SCP-48..55), +20 (REP-01..18; REP-09 and REP-16 run twice), review fixes: +4 (SCP-56, SCP-57 ×3); M5-INVOICES-AUTH-P1: +18 (SIL-01..18); M5-INVOICES-AUTH-P1-R1: +13 (SCL-56..62, SIL-20..25), and +1 to the measured total (the floor sat one below the executed count)

/**
 * Critical frontend suites, by literal path. A count alone is not enough — unrelated
 * files would satisfy it while a specific control silently disappeared.
 *
 * The other two critical shipping suites (src/shipping/shippingApiClient.test.ts and
 * tests/quality/shipping-sidecar-containment.test.mjs) are `node:test` suites that
 * vitest does not collect; they are enforced as sentinels in their own Node lane.
 */
export const REQUIRED_FRONTEND_SUITES = [
  'src/components/ShippingProvidersPage.test.tsx',  // provider action result handling
  'src/components/ShippingCenter.test.tsx',         // probe sites + label/webhook surfaces
  'src/components/ReturnsPortal.test.tsx',          // label URL: text/clipboard/mailto channel
  'src/context/StoreLocalState.test.tsx',           // availability vs. configured state
  'src/backend-control-plane/console/AdminConsole.test.tsx',          // admin console states, token/CSRF lifecycle, shell
  'src/backend-control-plane/console/firebaseAdminIdentity.test.tsx', // in-memory provider, one token, discarded session
  'src/backend-control-plane/console/CommandCenter.test.tsx',         // read-only command center states and refusals
  'src/backend-control-plane/console/ApiPathNotFound.test.tsx',       // an API address loads a bounded page, never the console shell
  'src/backend-control-plane/console/TenantManagement.test.tsx',      // tenant workspace: server-decided actions, one key per intent, confirmed-only changes (M5-GIAM-D1-P3)
  'src/tenant/ServerCustomerLevels.test.tsx',                         // shop Customers levels: saved only after the server's read-back (M7A-CUSTOMERS-P3-R2)
  'src/context/AccessContext.tenantSession.test.tsx',                 // tenant session follows the Firebase user: logout before the next user (M7A-CUSTOMERS-P3-R2)
  'src/tenant/ServerCustomerDirectory.test.tsx',                      // shop Customer directory: saved only on a validated 201, an uncertain create held and never re-sent under another connection (M7A-CUSTOMERS-P5)
  'src/layouts/TenantLayout.customerDirectory.test.tsx',              // sidebar Customer Directory entry: the customers feature gates it, exact highlight with sub-paths only for the directory (M7A-CUSTOMERS-P5)
  'src/components/Customers.localBanner.test.tsx',                    // local Customers screen: the browser-only banner, a local create sends no request (M7A-CUSTOMERS-P5)
  'src/tenant/ServerCustomerPicker.test.tsx',                         // server-customer picker: reads only, a choice bound to the session it was read under, dropped when that session is over (M7A-CUSTOMERS-P9)
  'src/components/Invoices.serverCustomer.test.tsx',                  // invoice draft: a server customer never reaches the local list or an invoice; a local one creates as before (M7A-CUSTOMERS-P9)
  'src/components/RepairTickets.serverCustomer.test.tsx',             // new repair ticket: a server customer never reaches the local list or a ticket; local and walk-in tickets create as before (M7A-CUSTOMERS-P10)
  'src/tenant/ServerInvoiceLevels.test.tsx',                          // shop Invoices level (the level only): saved only after the server's read-back, independent of Customers, one tenant session shared (M5-INVOICES-AUTH-P1)
];

/** A case vitest actually ran. Skipped and todo cases are not executed. */
const isExecuted = (a) => a && (a.status === 'passed' || a.status === 'failed');

/**
 * Fail-closed validation of one vitest run. Pure over its inputs so the ratchet is
 * testable without invoking vitest.
 * Returns { ok, problems, summary } — summary carries counts and suite paths only.
 */
export function validateFrontendRun({
  report,
  exitCode,
  repoRoot = REPO_ROOT,
  minFiles = MIN_FRONTEND_FILES,
  minCases = MIN_FRONTEND_CASES,
  required = REQUIRED_FRONTEND_SUITES,
} = {}) {
  const problems = [];

  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return {
      ok: false,
      problems: ['vitest produced no machine-readable report — the run cannot be judged'],
      summary: {
        executedFiles: 0, executedCases: 0, minFiles, minCases,
        requiredSuites: required.length, missingSuites: [...required], exitCode,
      },
    };
  }

  // A non-zero exit or a self-reported failure is fatal on its own: the counts below
  // could otherwise be satisfied by a run that failed.
  if (exitCode !== 0) problems.push(`vitest exited ${exitCode}`);
  if (report.success !== true) problems.push('vitest reported the run as failed');
  if (Number(report.numFailedTests) > 0) problems.push(`${report.numFailedTests} frontend test case(s) failed`);

  // Index by repo-relative path; vitest reports absolute paths.
  const perSuite = new Map();
  for (const suite of report.testResults) {
    if (!suite || typeof suite.name !== 'string') continue;
    const rel = relative(resolve(repoRoot), resolve(suite.name));
    const executed = (suite.assertionResults ?? []).filter(isExecuted).length;
    // A path repeated within one report must not be banked twice.
    const prev = perSuite.get(rel);
    perSuite.set(rel, {
      executed: (prev?.executed ?? 0) + executed,
      failed: prev?.failed === true || suite.status === 'failed',
    });
  }

  const executedFiles = [...perSuite.values()].filter((s) => s.executed > 0).length;
  const executedCases = [...perSuite.values()].reduce((n, s) => n + s.executed, 0);

  if (executedCases === 0) problems.push('no frontend test cases were executed');
  if (executedFiles < minFiles) {
    problems.push(`executed ${executedFiles} frontend test files, below the ratchet minimum of ${minFiles}`);
  }
  if (executedCases < minCases) {
    problems.push(`executed ${executedCases} frontend test cases, below the ratchet minimum of ${minCases}`);
  }

  // Present-but-not-executed must fail as loudly as deleted: a suite vitest collected
  // but that ran zero assertions proves nothing.
  const missingSuites = required.filter((s) => !((perSuite.get(s)?.executed ?? 0) > 0));
  for (const s of missingSuites) {
    problems.push(`required frontend suite was not executed (missing, empty, or asserting nothing): ${s}`);
  }
  for (const s of required) {
    if (perSuite.get(s)?.failed) problems.push(`required frontend suite failed: ${s}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    summary: {
      executedFiles, executedCases, minFiles, minCases,
      requiredSuites: required.length, missingSuites, exitCode,
    },
  };
}

/** Bounded rendering: counts and suite paths only. Never test source or environment. */
export function formatFrontendRatchet(summary, ok) {
  const lines = [
    `executed files      ${summary.executedFiles} (minimum ${summary.minFiles})`,
    `executed cases      ${summary.executedCases} (minimum ${summary.minCases})`,
    `required suites     ${summary.requiredSuites}`,
  ];
  if (summary.missingSuites.length) {
    lines.push(`not executed        ${summary.missingSuites.length}`);
    for (const s of summary.missingSuites) lines.push(`  - ${s}`);
  }
  lines.push(`frontend ratchet    ${ok ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

function main() {
  // The report goes to a fresh OS temp dir, never into the repository — a stray
  // report file would otherwise surface in the forbidden-artifact scan.
  const dir = mkdtempSync(join(tmpdir(), 'frontend-gate-'));
  const reportPath = join(dir, 'vitest-report.json');
  try {
    // stdio inherited so vitest's own failure output still reaches the operator; the
    // ratchet judges the machine-readable report rather than parsing that text.
    const r = spawnSync(
      'node_modules/.bin/vitest',
      ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );

    let report = null;
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* judged as absent */ }

    const result = validateFrontendRun({ report, exitCode: r.status });
    console.log(`[frontend-tests] ${formatFrontendRatchet(result.summary, result.ok).split('\n').join('\n[frontend-tests] ')}`);
    if (!result.ok) {
      for (const p of result.problems) console.error(`[frontend-tests] ${p}`);
      console.error('[frontend-tests] frontend ratchet FAILED — refusing to report a green run over an incomplete suite');
      return 1;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
