// M7B-PAYMENTS-P1 — owner-approved exact Semgrep fixture inventory (scripts/check-security-gates.mjs).
// The approved scope is ONE rule (tmpos-raw-cardholder-data-field) at six counted tuples in two test
// files: server/runtime/invoicePayments.test.ts:499 ×1 and server/safe-log.test.ts:9 ×3, :16 ×1, :17 ×1.
// SER-01..05 replay CI's Semgrep reconciliation through the real checker and the real manifest; the six
// tuples are the ones CI run 42415653947 reported (paths as CI emits them, under /src/). The POS result
// stands in for the existing loose baseline TMPOS-HARDCODED-PIN-POS (its line is not part of that entry).
// SER-10.. probe the pure functions. No fixture value is read or printed: only rule/path/line/blob OIDs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = join(ROOT, 'scripts', 'check-security-gates.mjs');
const RULE = 'tmpos-raw-cardholder-data-field';
const IP = 'server/runtime/invoicePayments.test.ts';
const SL = 'server/safe-log.test.ts';
const sg = (file, line, rule = RULE, severity = 'ERROR') => ({ check_id: `semgrep.${rule}`, path: `/src/${file}`, start: { line }, extra: { severity } });
const POS_HIT = sg('src/components/POS.tsx', 626, 'tmpos-hardcoded-pin');
const CI_SIX = [sg(IP, 499), sg(SL, 9), sg(SL, 9), sg(SL, 9), sg(SL, 16), sg(SL, 17)];

function gates(results) {
  const dir = mkdtempSync(join(tmpdir(), 'semgrep-exact-'));
  const file = join(dir, 'semgrep-results.json');
  writeFileSync(file, JSON.stringify({ results }));
  const env = { ...process.env, SEMGREP_RESULTS: file };
  delete env.GITLEAKS_CURRENT; delete env.GITLEAKS_HISTORY;
  const r = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('SER-01 the six CI results plus the existing POS baseline reconcile: PASS', () => {
  const r = gates([...CI_SIX, POS_HIT]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /manifest OK .* PASS/);
});

test('SER-02 a seventh match on an inventoried line (a duplicate of :9) fails', () => {
  const r = gates([...CI_SIX, sg(SL, 9), POS_HIT]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /unbaselined semgrep finding: semgrep\.tmpos-raw-cardholder-data-field @ \/src\/server\/safe-log\.test\.ts:9/);
});

test('SER-03 a missing match (two of the three at :9) fails', () => {
  const r = gates([CI_SIX[0], CI_SIX[1], CI_SIX[2], CI_SIX[4], CI_SIX[5], POS_HIT]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /expected finding\(s\) missing.*server\/safe-log\.test\.ts:9/);
});

test('SER-04 a moved match (:499 -> :500) fails as new and missing', () => {
  const r = gates([sg(IP, 500), ...CI_SIX.slice(1), POS_HIT]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /unbaselined semgrep finding: .* @ \/src\/server\/runtime\/invoicePayments\.test\.ts:500/);
  assert.match(r.out, /expected finding\(s\) missing.*invoicePayments\.test\.ts:499/);
});

test('SER-05 an unbaselined ERROR in production code fails; so does the rule in another test file', () => {
  const r = gates([...CI_SIX, sg('server/runtime/invoicePayments.ts', 10), sg('server/other.test.ts', 3), POS_HIT]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /@ \/src\/server\/runtime\/invoicePayments\.ts:10/);
  assert.match(r.out, /@ \/src\/server\/other\.test\.ts:3/);
});

// ---- pure-function probes ---------------------------------------------------
const { reconcileSemgrep, checkSemgrepExactEntries, gitBlobOid } = await import('../../scripts/check-security-gates.mjs');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'docs/phase-4/m2-security-gate-manifest.json'), 'utf8'));
const SEMGREP = MANIFEST.findings.filter((f) => f.evidenceType === 'semgrep');
const EXACT = SEMGREP.filter((f) => f.expectedFindings !== undefined);
const POS = SEMGREP.find((f) => f.id === 'TMPOS-HARDCODED-PIN-POS');
const TODAY = '2026-11-07';
const OIDS = { [IP]: gitBlobOid(join(ROOT, IP)), [SL]: gitBlobOid(join(ROOT, SL)) };
const recon = (results, { entries = SEMGREP, oids = OIDS, today = TODAY } = {}) => reconcileSemgrep(entries, results, { currentOids: oids, today });
const SAFE_LOG = EXACT.find((f) => f.path === SL);
const edit = (patch) => ({ ...SAFE_LOG, ...patch });
const others = EXACT.filter((f) => f !== SAFE_LOG);

test('SER-10 the manifest carries exactly the approved two entries, pinned to the current fixture bytes', () => {
  assert.deepEqual(EXACT.map((f) => [f.rule, f.path, f.severity, f.blocker, f.status, f.expiry, f.expectedFindings.map((e) => e.line)]), [
    [RULE, IP, 'high', true, 'open', '2027-03-31', [499]],
    [RULE, SL, 'high', true, 'open', '2027-03-31', [9, 9, 9, 16, 17]],
  ]);
  for (const f of EXACT) assert.equal(f.containingFiles[0].blobOid, OIDS[f.path], `${f.path} pinned to its current blob`);
  assert.deepEqual(checkSemgrepExactEntries(EXACT, TODAY).problems, []);
  assert.deepEqual(recon([...CI_SIX, POS_HIT]), []);
});

test('SER-11 an extra match in an exact file never falls back to a loose path-substring entry', () => {
  const loose = { ...POS, id: 'LOOSE-SAFE-LOG', rule: RULE, path: 'server/safe-log', severity: 'high' };
  const p = recon([...CI_SIX, sg(SL, 9), sg(SL, 20), POS_HIT], { entries: [...SEMGREP, loose] }).join('\n');
  assert.match(p, /unbaselined .*safe-log\.test\.ts:9/);
  assert.match(p, /unbaselined .*safe-log\.test\.ts:20/);
  assert.doesNotMatch(p, /LOOSE-SAFE-LOG: ERROR-severity/);
});

test('SER-12 a same-line content change (blob OID) fails and the entry consumes nothing', () => {
  const p = recon([...CI_SIX, POS_HIT], { oids: { ...OIDS, [SL]: '0'.repeat(40) } }).join('\n');
  assert.match(p, /safe-log\.test\.ts CHANGED since the reviewed blob/);
  assert.match(p, /unbaselined .*safe-log\.test\.ts:16/);
});

test('SER-13 invalid severity or scope is refused and consumes nothing', () => {
  const cases = [
    [edit({ severity: 'low' }), /must be critical\/high/],
    [edit({ blocker: false }), /blocker: true/],
    [edit({ rule: 'tmpos-hardcoded-pin', expectedFindings: SAFE_LOG.expectedFindings.map((e) => ({ ...e, rule: 'tmpos-hardcoded-pin' })) }), /limited to rule/],
    [edit({ path: 'server/safe-log.ts' }), /test file under server\/ or src\//],
    [edit({ path: 'server/../server/safe-log.test.ts' }), /test file under server\/ or src\//],
    [edit({ expectedFindingCount: 6 }), /expectedFindingCount/],
    [edit({ expectedFindings: [...SAFE_LOG.expectedFindings.slice(0, 4), { rule: RULE, file: IP, line: 17 }] }), /each expectedFindings entry/],
    [edit({ containingFiles: [] }), /containingFiles/],
    [edit({ ownerApproval: '' }), /ownerApproval/],
  ];
  for (const [bad, why] of cases) {
    assert.match(checkSemgrepExactEntries([...others, bad], TODAY).problems.join('\n'), why);
    assert.match(recon([...CI_SIX, POS_HIT], { entries: [POS, ...others, bad] }).join('\n'), /unbaselined/, `${why}: consumed nothing`);
  }
});

test('SER-14 an expired or resolved exception is refused and consumes nothing', () => {
  for (const [bad, why] of [[edit({ expiry: '2026-11-06' }), /expired/], [edit({ status: 'resolved', removalEvidence: 'x' }), /must be open/]]) {
    assert.match(checkSemgrepExactEntries([...others, bad], TODAY).problems.join('\n'), why);
    assert.match(recon([...CI_SIX, POS_HIT], { entries: [POS, ...others, bad] }).join('\n'), /unbaselined .*safe-log\.test\.ts:9/);
  }
});

test('SER-17 a missing, malformed or impossible expiry is refused and consumes nothing (never compared as a string)', () => {
  for (const expiry of [undefined, '', 'zzzz', '2027-02-30', '2027-13-01', '2027-3-31', '2027-03-31T00:00:00Z', 20270331]) {
    const bad = edit({ expiry });
    assert.match(checkSemgrepExactEntries([...others, bad], TODAY).problems.join('\n'), /expiry must be a real YYYY-MM-DD calendar date/, String(expiry));
    assert.match(recon([...CI_SIX, POS_HIT], { entries: [POS, ...others, bad] }).join('\n'), /unbaselined .*safe-log\.test\.ts:9/, `${expiry}: consumed nothing`);
  }
  assert.deepEqual(checkSemgrepExactEntries([...others, edit({ expiry: '2028-02-29' })], TODAY).problems, [], 'a real leap day is accepted');
});

test('SER-15 two exact entries for the same rule and file are ambiguous: both refused', () => {
  const twin = { ...SAFE_LOG, id: 'TWIN' };
  assert.match(checkSemgrepExactEntries([...EXACT, twin], TODAY).problems.join('\n'), /ambiguous/);
  assert.match(recon([...CI_SIX, POS_HIT], { entries: [...SEMGREP, twin] }).join('\n'), /unbaselined .*safe-log\.test\.ts:17/);
});

test('SER-16 unrelated entries keep their behaviour: the loose POS entry is covered, and stale when absent', () => {
  assert.deepEqual(recon([...CI_SIX, POS_HIT]), []);
  assert.match(recon([...CI_SIX]).join('\n'), /TMPOS-HARDCODED-PIN-POS: open semgrep finding no longer detected/);
  assert.match(recon([...CI_SIX, POS_HIT], { entries: [POS] }).join('\n'), /unbaselined/, 'without the exact entries the six fail as in CI');
});
