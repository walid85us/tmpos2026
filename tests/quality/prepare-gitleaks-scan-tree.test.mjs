// Phase 4.0 M2 — scan-tree containment tests (§3). Builds a synthetic temp git
// repo and proves prepareScanTree copies ordinary/modified/untracked files,
// excludes protected paths, handles spaces in filenames, and never follows a
// symlink pointing outside the repository or copies a non-regular object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareScanTree, collectRepoFiles } from '../../scripts/prepare-gitleaks-scan-tree.mjs';
import { reconcileGitleaks, normalizeGitleaks, gitBlobOid } from '../../scripts/check-security-gates.mjs';

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'scan-src-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@synthetic.test');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'ordinary.txt'), 'hello');
  writeFileSync(join(repo, 'with space.txt'), 'spaced');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'sub', 'mod.txt'), 'v1');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'sub', 'mod.txt'), 'v2 modified'); // modified in worktree
  writeFileSync(join(repo, 'untracked.txt'), 'u');
  for (const d of ['node_modules', 'dist', 'agency-agents']) {
    mkdirSync(join(repo, d), { recursive: true });
    writeFileSync(join(repo, d, 'x.js'), 'excluded');
  }
  symlinkSync('/etc/hostname', join(repo, 'extlink')); // external symlink target
  let fifo = false;
  try { execFileSync('mkfifo', [join(repo, 'myfifo')]); fifo = true; } catch { /* mkfifo unavailable */ }
  return { repo, fifo };
}

test('collectRepoFiles includes tracked + untracked and excludes protected paths', () => {
  const { repo } = makeRepo();
  try {
    const files = collectRepoFiles(repo);
    assert.ok(files.includes('ordinary.txt'));
    assert.ok(files.includes('with space.txt'));
    assert.ok(files.includes('sub/mod.txt'));
    assert.ok(files.includes('untracked.txt'));
    assert.ok(!files.some((f) => f.startsWith('node_modules/')));
    assert.ok(!files.some((f) => f.startsWith('dist/')));
    assert.ok(!files.some((f) => f.startsWith('agency-agents/')));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('prepareScanTree copies repo files, excludes protected, skips external symlink + non-regular', () => {
  const { repo, fifo } = makeRepo();
  let out;
  try {
    const r = prepareScanTree(repo, tmpdir());
    out = r.dir;
    // included
    assert.ok(existsSync(join(out, 'ordinary.txt')));
    assert.ok(existsSync(join(out, 'with space.txt')));
    assert.ok(existsSync(join(out, 'untracked.txt')));
    // modified content is the working-tree version
    assert.equal(readFileSync(join(out, 'sub', 'mod.txt'), 'utf8'), 'v2 modified');
    // excluded paths absent
    assert.ok(!existsSync(join(out, 'node_modules')));
    assert.ok(!existsSync(join(out, 'dist')));
    assert.ok(!existsSync(join(out, 'agency-agents')));
    // external symlink never dereferenced/copied
    assert.ok(!existsSync(join(out, 'extlink')));
    assert.ok(r.skipped.externalSymlink >= 1);
    // non-regular object never copied (git ls-files -o omits FIFOs; the helper
    // additionally guards non-regular objects defensively).
    assert.ok(!existsSync(join(out, 'myfifo')));
    void fifo;
  } finally {
    rmSync(repo, { recursive: true, force: true });
    if (out) rmSync(out, { recursive: true, force: true });
  }
});

// --- Exact-31 gitleaks reconciliation (§6) — synthetic, deterministic, no docker. ---
// Mirrors the real zoom-plugin vendored path structure so the finding-32 rejection is
// exercised against the SAME path family as the live bundle. No secret values are used.
const VP = 'knowledge-work-plugins/partner-built/zoom-plugin/skills';
const EXPECTED = [
  { rule: 'generic-api-key', file: `${VP}/rest-api/SKILL.md`, line: 91 },
  { rule: 'curl-auth-header', file: `${VP}/rest-api/SKILL.md`, line: 101 },
  { rule: 'curl-auth-user', file: `${VP}/zoom-mcp/concepts/oauth-setup.md`, line: 122 },
];

test('reconcileGitleaks: exact expected set (current+history) reconciles with zero problems', () => {
  const problems = reconcileGitleaks(EXPECTED, {
    current: EXPECTED.map((f) => ({ ...f })),
    history: EXPECTED.map((f) => ({ ...f })),
  });
  assert.deepEqual(problems, []);
});

test('reconcileGitleaks: a 32nd finding in the SAME vendored path is rejected (finding-32)', () => {
  const current = [...EXPECTED, { rule: 'generic-api-key', file: `${VP}/rest-api/SKILL.md`, line: 999 }];
  const problems = reconcileGitleaks(EXPECTED, { current });
  assert.ok(problems.some((p) => p.includes('finding-32')), `expected a finding-32 rejection, got: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes('expected exactly 3 findings, got 4')));
});

test('reconcileGitleaks: removing the synthetic 32nd finding reconciles exactly 31/N again', () => {
  // Same expected set, current == expected (the 32nd removed) → clean, proving the
  // rejection above was specific to the extra finding, not a broken reconciler.
  assert.deepEqual(reconcileGitleaks(EXPECTED, { current: EXPECTED.map((f) => ({ ...f })) }), []);
});

test('reconcileGitleaks: an app (src/) secret finding is rejected as APP/M2', () => {
  const current = [...EXPECTED, { rule: 'private-key', file: 'src/secrets.ts', line: 3 }];
  const problems = reconcileGitleaks(EXPECTED, { current });
  assert.ok(problems.some((p) => p.includes('APP/M2 path')), JSON.stringify(problems));
});

test('reconcileGitleaks: a missing expected finding fails the exact current-tree check', () => {
  const current = EXPECTED.slice(0, 2).map((f) => ({ ...f }));
  const problems = reconcileGitleaks(EXPECTED, { current });
  assert.ok(problems.some((p) => p.includes('missing (stale inventory)')), JSON.stringify(problems));
});

test('reconcileGitleaks: history tolerates a subset but rejects any new leak', () => {
  assert.deepEqual(reconcileGitleaks(EXPECTED, { history: EXPECTED.slice(0, 1) }), []);
  const problems = reconcileGitleaks(EXPECTED, { history: [...EXPECTED, { rule: 'aws-access-token', file: 'server/x.ts', line: 1 }] });
  assert.ok(problems.some((p) => p.includes('gitleaks history') && p.includes('APP/M2 path')), JSON.stringify(problems));
});

// --- Firebase public-client key + whole-file blob-OID binding (§1 red/green, §2 hardening) ---
const FB = { rule: 'gcp-api-key', file: 'firebase-applet-config.json', line: 4 };
const FB_OID = 'a'.repeat(40);
const V1 = { rule: 'generic-api-key', file: `${VP}/rest-api/SKILL.md`, line: 91 };
const V1_OID = 'b'.repeat(40);
const EXP2 = [FB, V1];
const CF = [{ file: FB.file, blobOid: FB_OID }, { file: V1.file, blobOid: V1_OID }];
const OIDS_OK = { [FB.file]: FB_OID, [V1.file]: V1_OID };

test('gitBlobOid matches `git hash-object` (whole-file digest, never a key-value hash)', () => {
  const git = execFileSync('git', ['hash-object', 'package.json']).toString().trim();
  assert.equal(gitBlobOid('package.json'), git);
});

test('§1 green: the known public-client + vendored findings reconcile with OIDs matching', () => {
  assert.deepEqual(reconcileGitleaks(EXP2, { current: [{ ...FB }, { ...V1 }], containingFiles: CF, currentOids: OIDS_OK }), []);
});

test('§1: a 2nd AIza-style key in the SAME file fails (unexpected + count)', () => {
  const current = [{ ...FB }, { ...V1 }, { rule: 'gcp-api-key', file: FB.file, line: 99 }];
  const p = reconcileGitleaks(EXP2, { current, containingFiles: CF, currentOids: OIDS_OK });
  assert.ok(p.some((x) => x.includes('UNEXPECTED') && x.includes('APP/M2 path')), JSON.stringify(p));
  assert.ok(p.some((x) => x.includes('expected exactly 2 findings, got 3')));
});

test('§1: an AIza-style key in ANOTHER file fails', () => {
  const current = [{ ...FB }, { ...V1 }, { rule: 'gcp-api-key', file: 'src/somewhere.ts', line: 5 }];
  const p = reconcileGitleaks(EXP2, { current, containingFiles: CF, currentOids: OIDS_OK });
  assert.ok(p.some((x) => x.includes('UNEXPECTED') && x.includes('src/somewhere.ts')), JSON.stringify(p));
});

test('§1: a same-line replacement that CHANGES the public-client file fails (OID mismatch)', () => {
  // findings identical (same rule/file/line) but the containing file content changed.
  const oids = { [FB.file]: 'c'.repeat(40), [V1.file]: V1_OID };
  const p = reconcileGitleaks(EXP2, { current: [{ ...FB }, { ...V1 }], containingFiles: CF, currentOids: oids });
  assert.ok(p.some((x) => x.includes('containing file CHANGED') && x.includes(FB.file)), JSON.stringify(p));
});

test('§1: removing the expected public-client finding fails as stale', () => {
  const p = reconcileGitleaks(EXP2, { current: [{ ...V1 }], containingFiles: CF, currentOids: OIDS_OK });
  assert.ok(p.some((x) => x.includes('missing (stale inventory)') && x.includes(FB.file)), JSON.stringify(p));
});

test('§2: a same-line replacement that CHANGES a vendored containing file fails (OID mismatch)', () => {
  const oids = { [FB.file]: FB_OID, [V1.file]: 'd'.repeat(40) };
  const p = reconcileGitleaks(EXP2, { current: [{ ...FB }, { ...V1 }], containingFiles: CF, currentOids: oids });
  assert.ok(p.some((x) => x.includes('containing file CHANGED') && x.includes(V1.file)), JSON.stringify(p));
});

test('§2: a rule/path/line change to an expected finding fails (missing + unexpected)', () => {
  const current = [{ ...FB }, { rule: V1.rule, file: V1.file, line: 999 }];
  const p = reconcileGitleaks(EXP2, { current, containingFiles: CF, currentOids: OIDS_OK });
  assert.ok(p.some((x) => x.includes('missing (stale inventory)')), JSON.stringify(p));
  assert.ok(p.some((x) => x.includes('UNEXPECTED')), JSON.stringify(p));
});

test('history allows a history-only (removed dist/) finding but rejects a new leak', () => {
  const HIST_ONLY = { rule: 'gcp-api-key', file: 'dist/assets/old-bundle.js', line: 100 };
  assert.deepEqual(reconcileGitleaks(EXP2, { history: [{ ...FB }, { ...V1 }, HIST_ONLY], expectedHistory: [HIST_ONLY] }), []);
  const p = reconcileGitleaks(EXP2, { history: [{ ...FB }, { rule: 'x', file: 'src/leak.ts', line: 1 }], expectedHistory: [HIST_ONLY] });
  assert.ok(p.some((x) => x.includes('gitleaks history') && x.includes('UNEXPECTED')), JSON.stringify(p));
});

test('§3 containment: an outside-repository fixture is neither listed nor copied into the scan tree', () => {
  const { repo } = makeRepo();
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'external-secret.txt'), 'placeholder-not-a-real-key');
  let out;
  try {
    const files = collectRepoFiles(repo);
    assert.ok(!files.some((f) => f.includes('external-secret') || f.startsWith('/') || f.includes('..')), 'no external/absolute/parent paths listed');
    const r = prepareScanTree(repo, tmpdir());
    out = r.dir;
    assert.ok(!existsSync(join(out, 'external-secret.txt')), 'external file must not be copied');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (out) rmSync(out, { recursive: true, force: true });
  }
});

test('normalizeGitleaks: strips /scan and /repo mount prefixes and maps raw fields', () => {
  const norm = normalizeGitleaks([
    { RuleID: 'generic-api-key', File: `/scan/${VP}/rest-api/SKILL.md`, StartLine: 91 },
    { RuleID: 'curl-auth-user', File: `/repo/${VP}/zoom-mcp/concepts/oauth-setup.md`, StartLine: 122 },
  ]);
  assert.deepEqual(norm, [
    { rule: 'generic-api-key', file: `${VP}/rest-api/SKILL.md`, line: 91 },
    { rule: 'curl-auth-user', file: `${VP}/zoom-mcp/concepts/oauth-setup.md`, line: 122 },
  ]);
});
