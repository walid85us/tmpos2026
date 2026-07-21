#!/usr/bin/env node
// Phase 4.0 M2 — deterministic, non-watch runner for the existing tsx/node:test
// suites (BCP corpus, platform-identity, Firestore STATIC guard). Explicit
// discovery roots; excludes node_modules/dist/.git/agency-agents and the
// Firestore *emulator* suite (that runs separately via `firebase emulators:exec`).
// Fail-fast disabled (reports every failure); non-zero exit on any failure.
//
// DISCOVERY RATCHET. Discovery used to fail OPEN: a missing root was swallowed, and zero
// discovered files reported `suites=0 pass=0 fail=0` and exited 0 — a green run that tested
// nothing. That is the same silent-absence class as an `npm ci` that skips a package and
// still exits 0. So before executing anything the runner proves it found the suites it is
// supposed to find: every configured root exists, the discovered count never falls below
// the recorded baseline, and each named sentinel suite is still present. A count alone is
// not enough — 63 unrelated files would satisfy it — hence the sentinels.
import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

export const ROOTS = ['server', 'src', 'tests/firestore', 'tests/quality'];
const EXCLUDE_DIR = new Set(['node_modules', 'dist', '.git', 'agency-agents', '.cache']);

/**
 * Baseline count of deterministic suites. Raise it when suites are added; it may never be
 * lowered to accommodate a deletion — that is the whole point of the ratchet.
 */
export const MIN_SUITES = 74;

/**
 * Literal sentinel suites. Each names a specific control whose loss must fail the run even
 * if the total still clears MIN_SUITES. Literal paths only: a directory check would pass on
 * an empty directory and prove nothing.
 */
export const REQUIRED_SENTINELS = [
  'tests/firestore/firestore.rules.static.test.mjs',           // Firestore static rules regression
  'tests/quality/check-dependency-audit.test.mjs',             // dependency-audit reconciliation
  'tests/quality/prepare-gitleaks-scan-tree.test.mjs',         // Gitleaks scan-tree / reconciliation
  'tests/quality/check-typecheck-contract.test.mjs',           // typecheck contract
  'tests/quality/check-lockfile-portability.test.mjs',         // lockfile portability
  'server/bcp-pilot/bcpActionCanonicalAuthzResolver.test.ts',  // controlled-action authorization
  'server/bcp-pilot/bcpActionRequestSecurityGuard.test.ts',    // controlled-action request security
  'server/bcp-pilot/bcpPilot.test.ts',                         // BCP security corpus
  'server/platform-identity/identityUnauthenticatedSurfaceElimination.test.ts', // unauth identity-surface elimination + bounded 404/500
  'tests/quality/run-tests-discovery.test.mjs',                // the Node ratchet's own guard test
  'tests/quality/run-frontend-tests-contract.test.mjs',        // the frontend ratchet's own guard test
  'tests/quality/shipping-sidecar-containment.test.mjs',       // sidecar elimination / SSRF containment
  'tests/quality/shipping-client-type-contract.test.mjs',      // Shipping result is a required discriminated union
  'src/shipping/shippingApiClient.test.ts',                    // Shipping client is network-free
  // Frontend render tests are `.test.tsx` and run under vitest, not here; this runner still
  // asserts the harness exists so deleting it cannot pass unnoticed. vitest has no count
  // ratchet of its own, so without these entries deleting one is a SILENT green — and
  // ReturnsPortal.test.tsx is the only guard covering the clipboard/mailto/rendered-text
  // channel, which no `.mjs` suite can see.
  'src/components/AccessGuard.test.tsx',
  'src/components/ReturnsPortal.test.tsx',             // label URL: text/clipboard/mailto channel
  'src/components/ShippingCenter.test.tsx',            // label URL: DOM/attribute/request channel
  'src/components/ShippingProvidersPage.test.tsx',     // provider action result handling
  'src/context/StoreLocalState.test.tsx',              // availability vs. configured state
];

export const isTestPath = (f) =>
  (f.endsWith('.test.ts') || f.endsWith('.test.mjs')) && !f.endsWith('.emulator.test.mjs');

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!EXCLUDE_DIR.has(e.name)) walk(join(dir, e.name), acc); }
    else if (isTestPath(e.name)) acc.push(join(dir, e.name));
  }
  return acc;
}

/** True only when `p` is a repo-relative path that stays inside `root`. */
export function isInsideRepo(root, p) {
  if (typeof p !== 'string' || p === '' || isAbsolute(p)) return false;
  const base = resolve(root);
  const rel = relative(base, resolve(base, p));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Discover the deterministic suites under `repoRoot`, as sorted repo-relative paths. */
export function discover(repoRoot = REPO_ROOT, roots = ROOTS) {
  return roots.flatMap((r) => walk(join(repoRoot, r), []))
    .map((f) => relative(repoRoot, f))
    .sort();
}

/**
 * Fail-closed validation of a discovery result. Pure over its inputs so the ratchet itself
 * is testable without touching the real tree.
 * Returns { ok, problems, summary } — summary carries counts only, never test content.
 */
export function validateDiscovery({
  files,
  repoRoot = REPO_ROOT,
  roots = ROOTS,
  minSuites = MIN_SUITES,
  sentinels = REQUIRED_SENTINELS,
} = {}) {
  const problems = [];

  const missingRoots = roots.filter((r) => {
    const abs = join(repoRoot, r);
    return !existsSync(abs) || !statSync(abs).isDirectory();
  });
  for (const r of missingRoots) problems.push(`configured test root is absent: ${r}`);

  // Duplicates must not inflate the count, and nothing outside the repository or that is not
  // a test file may be counted toward the ratchet. Paths are canonicalised first, so
  // `a/../a.test.ts` cannot be banked twice as a distinct suite.
  const seen = new Set();
  const unique = [];
  for (const f of files ?? []) {
    if (typeof f !== 'string' || f === '') { problems.push('discovered a malformed path'); continue; }
    if (!isInsideRepo(repoRoot, f)) { problems.push(`discovered path escapes the repository: ${String(f)}`); continue; }
    const canonical = relative(resolve(repoRoot), resolve(repoRoot, f));
    if (!isTestPath(canonical)) { problems.push(`discovered path is not a test suite: ${canonical}`); continue; }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(canonical);
  }

  if (unique.length === 0) problems.push('no test suites were discovered');
  else if (unique.length < minSuites) {
    problems.push(`discovered ${unique.length} suites, below the ratchet minimum of ${minSuites}`);
  }

  // A sentinel must be a real, non-empty FILE: `existsSync` alone is satisfied by a
  // directory of the same name or an empty stub, which would prove nothing. And a sentinel
  // this runner is supposed to execute must actually be in the discovered set — present but
  // uncollected (moved out of a root) has to fail just as loudly as deleted.
  // RESIDUAL (not closed here): a `.test.tsx` sentinel runs under vitest, so this runner
  // never executes it and `suiteContentProblem` never sees it — leaving `exists && size
  // > 0`, which a non-empty stub satisfies, and vitest has no count ratchet of its own.
  // Requiring a real `it(`/`test(` declaration closes that, but it changes the contract
  // this function's own guard suite asserts (tests/quality/run-tests-discovery.test.mjs),
  // which is outside this pass's authorised file set. Tracked as an open residual.
  const missingSentinels = sentinels.filter((s) => {
    const abs = join(repoRoot, s);
    if (!existsSync(abs)) return true;
    const st = statSync(abs);
    if (!st.isFile() || st.size === 0) return true;
    if (isTestPath(s) && !seen.has(s)) return true;
    return false;
  });
  for (const s of missingSentinels) problems.push(`required sentinel suite is missing, empty, or uncollected: ${s}`);

  return {
    ok: problems.length === 0,
    problems,
    summary: {
      configuredRoots: roots.length,
      discoveredSuites: unique.length,
      requiredSentinels: sentinels.length,
      missingSentinels,
      minSuites,
    },
    files: unique,
  };
}

/** Bounded rendering: counts and sentinel paths only. Never test source or environment. */
export function formatRatchet(summary, ok) {
  const lines = [
    `configured roots    ${summary.configuredRoots}`,
    `discovered suites   ${summary.discoveredSuites} (minimum ${summary.minSuites})`,
    `required sentinels  ${summary.requiredSentinels}`,
  ];
  if (summary.missingSentinels.length) {
    lines.push(`missing sentinels   ${summary.missingSentinels.length}`);
    for (const s of summary.missingSentinels) lines.push(`  - ${s}`);
  }
  lines.push(`discovery           ${ok ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

/**
 * A collected suite that runs zero assertions is a green run that tested nothing — the
 * content half of the failure the ratchet's collection half (deletion/rename/move) cannot
 * see. This repo has two harnesses: the gate suites (lockfile, dependency-audit, gitleaks,
 * typecheck, firestore, this ratchet) import `node:test` and emit a TAP `# tests N` line;
 * the bcp suites are plain `node:assert` scripts that never emit one. So the rule keys off
 * the source: a `node:test` suite MUST report at least one test — if it emits `# tests 0`
 * or no count at all (a gutted body emits nothing, verified), it ran nothing and fails. A
 * non-`node:test` suite is judged on its exit code alone, exactly as before, so this cannot
 * break the assertion-script suites.
 * Returns a reason string, or null when there is nothing to flag.
 */
export function suiteContentProblem(result, source = '') {
  if (!/from\s+['"]node:test['"]/.test(source)) return null;
  const m = /^# tests (\d+)$/m.exec((result && result.stdout) || '');
  if (!m) return 'node:test suite emitted no test count — it ran zero tests';
  if (Number(m[1]) === 0) return 'node:test suite reported 0 tests — asserted nothing';
  return null;
}

function main() {
  const result = validateDiscovery({ files: discover() });
  console.log(`[run-tests] ${formatRatchet(result.summary, result.ok).split('\n').join('\n[run-tests] ')}`);
  if (!result.ok) {
    for (const p of result.problems) console.error(`[run-tests] ${p}`);
    console.error('[run-tests] discovery ratchet FAILED — refusing to report a green run over an incomplete suite set');
    return 1;
  }

  let pass = 0, fail = 0;
  for (const f of result.files) {
    const r = spawnSync('node_modules/.bin/tsx', [f], { encoding: 'utf8', timeout: 90000 });
    let source = '';
    try { source = readFileSync(join(REPO_ROOT, f), 'utf8'); } catch { /* judged on exit code */ }
    const problem = suiteContentProblem(r, source);
    if (r.status === 0 && !problem) { pass++; }
    else {
      fail++;
      const why = r.status === 0 ? `${problem}\n` : '';
      process.stdout.write(`\nFAIL ${f}\n${why}${((r.stdout || '') + (r.stderr || '')).slice(-1200)}\n`);
    }
  }
  console.log(`\n[run-tests] suites=${result.files.length} pass=${pass} fail=${fail}`);
  return fail ? 1 : 0;
}

// Node realpaths ESM modules, so `import.meta.url` is the resolved path while
// `process.argv[1]` is literal. Under a symlinked checkout they would differ, this block
// would never run, and the runner would exit 0 having executed nothing — the same
// silent-absence the ratchet exists to prevent.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
