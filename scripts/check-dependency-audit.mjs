#!/usr/bin/env node
// Phase 4.0 M2 — fail-closed dependency-audit reconciler (owner decision, §7).
// Consumes SAVED `npm audit --json` output (npm exits 1 when vulnerabilities exist,
// so CI must capture the JSON while preserving the exit code and pass it here).
// Reconciles every High advisory individually against the security gate manifest's
// dependency_audit entries. G-APPSEC stays production-blocking while any High is open.
//
// Usage:  node scripts/check-dependency-audit.mjs <prod-audit.json> [full-audit.json]
// Env:    AUDIT_JSON, AUDIT_FULL_JSON, GATE_MANIFEST, AUDIT_EXIT (npm's exit code)
//
// FAILS on: missing/empty/malformed/truncated audit; unexpected npm exit (not 0/1);
// any Critical (prod or full); a new High package; a changed/new High advisory for a
// baselined package; a missing manifest entry; a stale entry (no longer High); an
// expired entry.
import { readFileSync, existsSync } from 'node:fs';

const auditPath = process.argv[2] || process.env.AUDIT_JSON;
const fullPath = process.argv[3] || process.env.AUDIT_FULL_JSON;
const manifestPath = process.env.GATE_MANIFEST || 'docs/phase-4/m2-security-gate-manifest.json';
const auditExit = process.env.AUDIT_EXIT;

function fail(lines) {
  console.error('DEPENDENCY AUDIT: FAIL\n' + (Array.isArray(lines) ? lines : [lines]).map((l) => ' - ' + l).join('\n'));
  process.exit(1);
}

// npm audit exits 0 (clean) or 1 (findings). Anything else is a real command failure.
if (auditExit !== undefined && !['0', '1'].includes(String(auditExit))) fail(`npm audit exited unexpectedly (code ${auditExit}) — treated as a crash, not a clean result`);

function loadAudit(p, label) {
  if (!p || !existsSync(p)) fail(`${label} audit output missing (${p ?? 'unset'})`);
  const raw = readFileSync(p, 'utf8');
  if (!raw.trim()) fail(`${label} audit output empty`);
  let j;
  try { j = JSON.parse(raw); } catch { fail(`${label} audit output malformed/truncated JSON`); }
  if (!j.metadata?.vulnerabilities || typeof j.vulnerabilities !== 'object') fail(`${label} audit output missing expected keys (metadata.vulnerabilities / vulnerabilities)`);
  return j;
}

const prod = loadAudit(auditPath, 'production');
const pm = prod.metadata.vulnerabilities;
console.log(`[dep-audit] PROD  matrix: critical=${pm.critical} high=${pm.high} moderate=${pm.moderate} low=${pm.low} total=${pm.total}`);
let full = null;
if (fullPath) {
  full = loadAudit(fullPath, 'full');
  const fm = full.metadata.vulnerabilities;
  console.log(`[dep-audit] FULL  matrix: critical=${fm.critical} high=${fm.high} moderate=${fm.moderate} low=${fm.low} total=${fm.total}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const depEntries = (manifest.findings || []).filter((f) => f.evidenceType === 'dependency_audit');
const manByPkg = new Map(depEntries.map((e) => [e.package, e]));
const today = new Date().toISOString().slice(0, 10);
const problems = [];

// Never reduce severity: any Critical is an immediate hard fail.
if (pm.critical > 0) problems.push(`${pm.critical} Critical advisory(ies) in the production tree`);
if (full && full.metadata.vulnerabilities.critical > 0) problems.push(`${full.metadata.vulnerabilities.critical} Critical advisory(ies) in the full/dev tree`);

// Build the current High set (per package) with its High advisories.
const highPkgs = {};
for (const [pkg, v] of Object.entries(prod.vulnerabilities)) {
  if (v.severity !== 'high') continue;
  const advisories = (v.via || [])
    .filter((x) => typeof x === 'object' && String(x.severity).toLowerCase() === 'high')
    .map((x) => x.url || String(x.source));
  highPkgs[pkg] = { range: v.range, advisories: [...new Set(advisories)] };
}

// Every current High package must be exactly baselined.
for (const [pkg, info] of Object.entries(highPkgs)) {
  const e = manByPkg.get(pkg);
  if (!e) { problems.push(`NEW High package not in manifest: ${pkg} [${info.advisories.join(', ')}]`); continue; }
  if (e.expiry < today) problems.push(`${e.id}: entry expired (${e.expiry} < ${today})`);
  const listed = e.advisories || [];
  const newAdv = info.advisories.filter((a) => !listed.some((l) => a.includes(l) || l.includes(a)));
  if (newAdv.length) problems.push(`${e.id}: changed/new High advisory for ${pkg}: ${newAdv.join(', ')}`);
}

// Any manifest dep entry not backed by a current High is stale.
for (const e of depEntries) {
  if (!highPkgs[e.package]) problems.push(`STALE manifest entry ${e.id}: '${e.package}' is no longer a High advisory — reconcile/remove`);
}

if (problems.length) fail(problems);

console.log(`[dep-audit] reconciled: ${Object.keys(highPkgs).length} High package(s) individually baselined; 0 Critical.`);
console.log('[dep-audit] G-APPSEC remains PRODUCTION-BLOCKING while any High is open. PASS (CI may continue).');
process.exit(0);
