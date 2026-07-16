#!/usr/bin/env node
// Phase 4.0 M2 — security gate manifest validator (owner decisions D3 + evidence types).
// Validates docs/phase-4/m2-security-gate-manifest.json and reconciles scanner evidence:
//   • SEMGREP_RESULTS=path  → SEMGREP-evidence entries are reconciled against a Semgrep
//     results JSON so the manifest can never hide a new/relocated/stale Semgrep finding.
//   • GITLEAKS_CURRENT=path / GITLEAKS_HISTORY=path → the gitleaks entries' EXACT
//     expectedFindings inventory (rule+path+line) is reconciled finding-by-finding against
//     a live gitleaks report — no directory waiver; a new finding (new line, new rule, or
//     app path) fails. Every gitleaks "containing file" is additionally bound to its
//     whole-file Git blob OID, so an in-place same-line secret substitution fails too, and
//     every current finding's file MUST be OID-bound (coverage invariant enforced below).
//     Dependency (dependency_audit) entries are reconciled by scripts/check-dependency-audit.mjs.
//
// FAILS on: missing base/per-type field, unknown evidenceType, invalid reachability enum,
// blanket wildcard, duplicate id, expired entry, Critical/High not marked blocker, resolved
// without removalEvidence, a manual_static/semgrep/gitleaks path that no longer exists, a
// gitleaks entry without a consistent exact expectedFindings inventory, a finding file not
// OID-bound, a malformed containingFiles/historyOnlyFindings entry, and — with scanner
// results supplied — any new/relocated/stale Semgrep finding, any unexpected gitleaks secret
// finding, or any changed containing-file blob OID. Never prints secret values (only
// rule/path/line/counts and whole-file blob OIDs).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MANIFEST = 'docs/phase-4/m2-security-gate-manifest.json';
const BASE = ['id', 'evidenceType', 'fingerprint', 'severity', 'gate', 'milestone', 'rationale', 'compensatingControl', 'removalCriterion', 'expiry', 'status'];
const PER_TYPE = {
  semgrep: ['rule', 'path'],
  manual_static: ['path'],
  gitleaks: ['path'],
  dependency_audit: ['package', 'advisories', 'scope', 'reachability'],
  runtime_test: [],
  emulator_test: [],
};
const PATH_MUST_EXIST = new Set(['semgrep', 'manual_static', 'gitleaks']);
const REACHABILITY_ENUM = new Set(['browser_runtime', 'server_runtime', 'build_only', 'dev_only', 'not_reachable', 'unresolved']);
const WILDCARD = /[*?]|(^|\/)\*\*|^src\/?$|^server\/?$|^\.$/;

// ---- gitleaks exact-inventory reconciliation (pure; unit-tested) -----------
// Key on a JSON tuple (delimiter-free, injective) so a rule id / path containing a
// space can never collide two distinct findings onto one key nor garble a message.
const gkey = (f) => JSON.stringify([f.rule, f.file, f.line]);
const VENDORED_PREFIX = 'knowledge-work-plugins/';

export function normalizeGitleaks(raw) {
  // Raw gitleaks JSON → {rule,file,line}; strip the container mount prefixes so a
  // report from /scan (current-tree) or /repo (history) is repository-relative.
  return (Array.isArray(raw) ? raw : []).map((x) => ({
    rule: x.RuleID,
    file: String(x.File || '').replace(/^\/scan\//, '').replace(/^\/repo\//, ''),
    line: x.StartLine,
  }));
}

// Whole-file git blob OID (sha1 of "blob <bytelen>\0<content>") — matches `git hash-object`
// for non-adversarial files. Binds a containing file so an in-place same-line secret
// substitution (which changes the file) is detected WITHOUT hashing/storing the secret value.
export function gitBlobOid(path) {
  const buf = readFileSync(path);
  const h = createHash('sha1');
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
}

export function reconcileGitleaks(expectedCurrent, { current = null, history = null, expectedHistory = null, containingFiles = [], currentOids = {} } = {}) {
  const problems = [];
  const expC = new Set((expectedCurrent || []).map(gkey));
  if (!expC.size) { problems.push('gitleaks reconcile: manifest expectedFindings inventory is empty'); return problems; }
  // History may legitimately carry additional findings that exist only in old commit blobs
  // (e.g. a public client key baked into a removed dist/ bundle) — allowed, never new leaks.
  const expH = new Set([...(expectedCurrent || []), ...(expectedHistory || [])].map(gkey));

  if (Array.isArray(current)) {
    const cur = new Set(current.map(gkey));
    for (const f of current) {
      if (!expC.has(gkey(f))) {
        const where = f.file.startsWith(VENDORED_PREFIX) ? 'vendored path (finding-32)' : 'APP/M2 path';
        problems.push(`gitleaks current-tree: UNEXPECTED secret finding in ${where}: ${f.rule} ${f.file}:${f.line}`);
      }
    }
    for (const k of expC) {
      if (!cur.has(k)) {
        const [rule, file, line] = JSON.parse(k);
        problems.push(`gitleaks current-tree: expected finding missing (stale inventory): ${rule} ${file}:${line}`);
      }
    }
    if (current.length !== expC.size) problems.push(`gitleaks current-tree: expected exactly ${expC.size} findings, got ${current.length}`);
  }

  if (Array.isArray(history)) {
    // Commit-scoped: every finding must be a KNOWN expected finding (current or history-only),
    // no new leak anywhere; we do not require every finding to appear at every commit.
    for (const f of history) {
      if (!expH.has(gkey(f))) {
        const where = f.file.startsWith(VENDORED_PREFIX) ? 'vendored path' : 'APP/M2 path';
        problems.push(`gitleaks history: UNEXPECTED secret finding in ${where}: ${f.rule} ${f.file}:${f.line}`);
      }
    }
  }

  // Whole-file blob-OID binding: a same-line secret substitution changes the containing
  // file → its OID changes → mismatch. Never involves the secret value.
  for (const cf of containingFiles) {
    const got = currentOids[cf.file];
    if (got === undefined) problems.push(`gitleaks reconcile: containing file for OID binding not found/readable: ${cf.file}`);
    else if (got !== cf.blobOid) problems.push(`gitleaks reconcile: containing file CHANGED (content substitution): ${cf.file} (expected blob ${cf.blobOid}, got ${got})`);
  }
  return problems;
}

// ---- main -----------------------------------------------------------------
export function runGates() {
  const problems = [];
  let m;
  try { m = JSON.parse(readFileSync(MANIFEST, 'utf8')); }
  catch (e) { console.error(`[security-gates] cannot read/parse ${MANIFEST}: ${e.message}`); process.exit(1); }

  const findings = Array.isArray(m.findings) ? m.findings : [];
  if (!findings.length) problems.push('manifest has no findings');
  const allowedTypes = new Set(m.policy?.evidenceTypes || []);
  const ids = new Set();
  const today = new Date().toISOString().slice(0, 10);

  for (const f of findings) {
    const tag = f.id || '<no-id>';
    for (const k of BASE) if (f[k] === undefined || f[k] === null || f[k] === '') problems.push(`${tag}: missing base field '${k}'`);
    if (f.id) { if (ids.has(f.id)) problems.push(`${tag}: duplicate finding id`); ids.add(f.id); }
    const et = f.evidenceType;
    if (et && !allowedTypes.has(et)) problems.push(`${tag}: unknown evidenceType '${et}'`);
    for (const k of PER_TYPE[et] || []) {
      const v = f[k];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) problems.push(`${tag}: evidenceType '${et}' requires non-empty '${k}'`);
    }
    if (et === 'dependency_audit' && f.reachability && !REACHABILITY_ENUM.has(f.reachability)) problems.push(`${tag}: invalid reachability '${f.reachability}' (not in reachabilityEnum)`);
    if (et === 'gitleaks') {
      if (!Array.isArray(f.expectedFindings) || f.expectedFindings.length === 0) problems.push(`${tag}: gitleaks entry requires a non-empty expectedFindings inventory (exact reconciliation, not a directory waiver)`);
      else if (f.expectedFindingCount !== undefined && f.expectedFindingCount !== f.expectedFindings.length) problems.push(`${tag}: expectedFindingCount (${f.expectedFindingCount}) != expectedFindings.length (${f.expectedFindings.length})`);
      // Coverage invariant: every current finding's containing file MUST be OID-bound,
      // otherwise an in-place same-line substitution in that file would go undetected.
      const cfFiles = new Set((f.containingFiles || []).map((c) => c.file));
      for (const ef of f.expectedFindings || []) if (!cfFiles.has(ef.file)) problems.push(`${tag}: expectedFindings file '${ef.file}' is not blob-OID bound — every current-tree finding's containing file must appear in containingFiles`);
      for (const cf of f.containingFiles || []) {
        if (!cf.file || !/^[0-9a-f]{40}$/.test(cf.blobOid || '')) problems.push(`${tag}: containingFiles entry needs a file + 40-hex blobOid`);
        else if (!existsSync(cf.file)) problems.push(`${tag}: containingFiles path '${cf.file}' no longer exists`);
      }
      for (const h of f.historyOnlyFindings || []) if (!h.rule || !h.file || h.line === undefined) problems.push(`${tag}: historyOnlyFindings entry needs rule + file + line`);
    }
    if (f.path && WILDCARD.test(f.path)) problems.push(`${tag}: path '${f.path}' is a blanket/wildcard scope`);
    if (f.fingerprint && WILDCARD.test(f.fingerprint)) problems.push(`${tag}: wildcard fingerprint`);
    if (PATH_MUST_EXIST.has(et) && f.path && !existsSync(f.path)) problems.push(`${tag}: ${et} path '${f.path}' no longer exists`);
    if (f.expiry && f.expiry < today) problems.push(`${tag}: entry expired (${f.expiry} < ${today})`);
    const sev = String(f.severity || '').toLowerCase();
    if (!['critical', 'high', 'medium', 'low'].includes(sev)) problems.push(`${tag}: invalid severity '${f.severity}'`);
    if ((sev === 'critical' || sev === 'high') && f.blocker !== true) problems.push(`${tag}: ${sev} finding must be "blocker": true`);
    if (String(f.status).toLowerCase() === 'resolved' && !f.removalEvidence) problems.push(`${tag}: status=resolved requires 'removalEvidence'`);
  }

  // Semgrep reconciliation — SEMGREP-evidence entries only (manual_static/dependency_audit/
  // gitleaks/runtime_test entries can NEVER satisfy a Semgrep result).
  const resultsPath = process.env.SEMGREP_RESULTS;
  if (resultsPath) {
    let sr;
    try { sr = JSON.parse(readFileSync(resultsPath, 'utf8')); } catch (e) { console.error(`[security-gates] cannot read SEMGREP_RESULTS: ${e.message}`); process.exit(1); }
    const results = Array.isArray(sr.results) ? sr.results : [];
    const sgEntries = findings.filter((f) => f.evidenceType === 'semgrep');
    const ruleMatches = (r, f) => r.check_id?.split('.').pop() === f.rule || r.check_id?.endsWith(f.rule);
    const coveringEntry = (r) => sgEntries.find((f) => ruleMatches(r, f) && (r.path || '').includes(f.path));
    for (const r of results) {
      const sev = (r.extra?.severity || '').toUpperCase();
      if (sev !== 'ERROR') continue;
      const ce = coveringEntry(r);
      if (!ce) { problems.push(`NEW/relocated unbaselined semgrep finding: ${r.check_id} @ ${r.path}:${r.start?.line}`); continue; }
      // An ERROR-severity scanner result must map to a critical/high manifest entry —
      // block mislabelling a real High as Low to dodge the blocker invariant.
      const csev = String(ce.severity || '').toLowerCase();
      if (csev !== 'critical' && csev !== 'high') problems.push(`${ce.id}: ERROR-severity semgrep result mapped to a '${ce.severity}' manifest entry — an ERROR finding must be baselined critical/high`);
    }
    for (const f of sgEntries) {
      const detected = results.some((r) => ruleMatches(r, f) && (r.path || '').includes(f.path));
      if (String(f.status).toLowerCase() === 'resolved') {
        if (detected) problems.push(`${f.id}: marked resolved but semgrep still detects it`);
      } else if (!detected) {
        problems.push(`${f.id}: open semgrep finding no longer detected (stale) — code changed; update the manifest`);
      }
    }
  } else {
    console.log('[security-gates] note: SEMGREP_RESULTS not provided — semgrep reconciliation skipped (CI supplies scanner results).');
  }

  // Gitleaks exact-inventory reconciliation (union across all gitleaks entries) +
  // whole-file blob-OID binding (catches an in-place same-line secret substitution).
  const glCur = process.env.GITLEAKS_CURRENT;
  const glHist = process.env.GITLEAKS_HISTORY;
  if (glCur || glHist) {
    const glEntries = findings.filter((f) => f.evidenceType === 'gitleaks' && Array.isArray(f.expectedFindings));
    if (!glEntries.length) problems.push('gitleaks reconcile: no gitleaks entry with expectedFindings in manifest');
    else {
      const expectedCurrent = glEntries.flatMap((e) => e.expectedFindings);
      const expectedHistory = glEntries.flatMap((e) => e.historyOnlyFindings || []);
      const containingFiles = glEntries.flatMap((e) => e.containingFiles || []);
      const currentOids = {};
      for (const cf of containingFiles) { try { currentOids[cf.file] = gitBlobOid(cf.file); } catch { /* missing → reconcile flags it */ } }
      const load = (p) => { if (!p) return null; try { return normalizeGitleaks(JSON.parse(readFileSync(p, 'utf8'))); } catch (e) { problems.push(`gitleaks reconcile: cannot read ${p}: ${e.message}`); return null; } };
      const current = load(glCur);
      const history = load(glHist);
      for (const p of reconcileGitleaks(expectedCurrent, { current, history, expectedHistory, containingFiles, currentOids })) problems.push(p);
      if (current) console.log(`[security-gates] gitleaks current-tree reconciled: ${current.length} finding(s) vs ${expectedCurrent.length} expected; ${containingFiles.length} containing file(s) blob-OID-bound.`);
      if (history) console.log(`[security-gates] gitleaks history reconciled: ${history.length} finding(s) vs ${expectedCurrent.length + expectedHistory.length} allowed (current + history-only).`);
    }
  }

  if (problems.length) {
    console.error('SECURITY GATE MANIFEST: FAIL\n' + problems.map((p) => ' - ' + p).join('\n'));
    process.exit(1);
  }
  const scannerSupplied = !!(process.env.SEMGREP_RESULTS || process.env.GITLEAKS_CURRENT || process.env.GITLEAKS_HISTORY);
  const verdict = scannerSupplied ? 'PASS' : 'STRUCTURAL-ONLY PASS — scanner reconciliation NOT run (supply SEMGREP_RESULTS / GITLEAKS_CURRENT / GITLEAKS_HISTORY for the full gate; CI does)';
  console.log(`[security-gates] manifest OK — ${findings.length} itemized findings (evidence types + reachability validated, paths present, no wildcard/dup/expired/mislabelled; scanner evidence reconciled where supplied). ${verdict}`);
}

// Encoding-robust main-guard: compare against pathToFileURL(argv[1]).href rather
// than a raw `file://${argv[1]}` template, so a checkout path containing a space
// (or other URL-reserved char) can never make the gate silently no-op (fail-open).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runGates();
