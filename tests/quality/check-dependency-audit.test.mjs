// Phase 4.0 M2 — fail-closed dependency-reconciler tests (§7). node:test, synthetic
// fixtures only (no real npm audit). Proves the reconciler passes clean/known-High
// and fails closed on new/changed/missing/stale/expired/Critical/malformed/empty/
// unexpected-exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'check-dependency-audit.mjs');

function audit({ high = 0, critical = 0, moderate = 0, low = 0, vulns = {} } = {}) {
  return JSON.stringify({
    metadata: { vulnerabilities: { info: 0, low, moderate, high, critical, total: high + critical + moderate + low } },
    vulnerabilities: vulns,
  });
}
const highVuln = (pkg, ghsa) => ({ [pkg]: { name: pkg, severity: 'high', range: '<1.0.0', via: [{ url: `https://github.com/advisories/${ghsa}`, severity: 'high', name: pkg }] } });
function manifest(entries) {
  return JSON.stringify({ policy: { evidenceTypes: ['dependency_audit'] }, findings: entries });
}
const depEntry = (pkg, ghsa, expiry = '2099-01-01') => ({
  id: `T-${pkg}`, evidenceType: 'dependency_audit', fingerprint: `sca:${pkg}`, severity: 'high', blocker: true,
  gate: 'G-APPSEC', milestone: 'M3', rationale: 'x', compensatingControl: 'x', removalCriterion: 'x', expiry, status: 'open',
  package: pkg, advisories: [ghsa], scope: 'production-tree', reachability: 'build_only',
});

function run(auditJson, manifestJson, { fullJson, auditExit, raw } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dep-recon-'));
  try {
    const ap = join(dir, 'audit.json');
    writeFileSync(ap, raw !== undefined ? raw : auditJson);
    const mp = join(dir, 'manifest.json');
    writeFileSync(mp, manifestJson);
    const args = [SCRIPT, ap];
    if (fullJson) { const fp = join(dir, 'full.json'); writeFileSync(fp, fullJson); args.push(fp); }
    const env = { ...process.env, GATE_MANIFEST: mp };
    if (auditExit !== undefined) env.AUDIT_EXIT = String(auditExit);
    const r = spawnSync('node', args, { encoding: 'utf8', env });
    return r.status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('clean audit + no dep entries → pass', () => {
  assert.equal(run(audit({}), manifest([])), 0);
});
test('known High exactly baselined → pass', () => {
  assert.equal(run(audit({ high: 1, vulns: highVuln('evilpkg', 'GHSA-TEST') }), manifest([depEntry('evilpkg', 'GHSA-TEST')])), 0);
});
test('new High package not in manifest → fail', () => {
  assert.equal(run(audit({ high: 1, vulns: highVuln('newpkg', 'GHSA-NEW') }), manifest([])), 1);
});
test('changed/new advisory for a baselined package → fail', () => {
  assert.equal(run(audit({ high: 1, vulns: highVuln('evilpkg', 'GHSA-DIFFERENT') }), manifest([depEntry('evilpkg', 'GHSA-TEST')])), 1);
});
test('missing entry (High present, no dep entry) → fail', () => {
  assert.equal(run(audit({ high: 1, vulns: highVuln('evilpkg', 'GHSA-TEST') }), manifest([])), 1);
});
test('stale entry (baselined package no longer High) → fail', () => {
  assert.equal(run(audit({}), manifest([depEntry('evilpkg', 'GHSA-TEST')])), 1);
});
test('expired entry → fail', () => {
  assert.equal(run(audit({ high: 1, vulns: highVuln('evilpkg', 'GHSA-TEST') }), manifest([depEntry('evilpkg', 'GHSA-TEST', '2000-01-01')])), 1);
});
test('any Critical → fail', () => {
  assert.equal(run(audit({ critical: 1, vulns: { c: { name: 'c', severity: 'critical', range: '*', via: [{ url: 'x', severity: 'critical', name: 'c' }] } } }), manifest([])), 1);
});
test('Critical in the full/dev tree → fail', () => {
  assert.equal(run(audit({}), manifest([]), { fullJson: audit({ critical: 1 }) }), 1);
});
test('malformed JSON → fail', () => {
  assert.equal(run(null, manifest([]), { raw: '{ this is not json' }), 1);
});
test('empty output → fail', () => {
  assert.equal(run(null, manifest([]), { raw: '' }), 1);
});
test('unexpected npm exit code → fail', () => {
  assert.equal(run(audit({}), manifest([]), { auditExit: 2 }), 1);
});
test('npm exit 1 (vulnerabilities found) is a valid, parseable result → pass', () => {
  assert.equal(run(audit({ high: 1, vulns: highVuln('evilpkg', 'GHSA-TEST') }), manifest([depEntry('evilpkg', 'GHSA-TEST')]), { auditExit: 1 }), 0);
});
