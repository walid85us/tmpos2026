// Phase 2.0 M20 — Safe server-owned C-06 Backend CP Quality Gates / Evidence Coverage POSTURE provider +
// fitness functions.
//
// WHAT THIS IS: a PURE, server-owned, code/config-only source of the TWELVE accepted evidence-coverage
// category KEYS with safe bounded POSTURE labels. It is NOT a log/test/typecheck/static-scan/transport
// reader and does NOT inspect process.env, the filesystem, the clock, packages, or any command output — it
// is a hand-curated, allow-listed constant, mirroring the proven C-02..C-05 provider pattern.
//
// BINDING SAFETY:
//   - PURE + DETERMINISTIC + NO-THROW + side-effect-free. No I/O. No DB/Supabase/getDb/live/network/fetch/
//     filesystem. NO process.env read for output, NO process.env enumeration, NO dotenv parsing, NO command
//     execution, NO package/dependency read, NO clock read. No request. No auth. No tenant/store/customer/
//     identity/audit. No mutation. No backend action.
//   - Emits ONLY the TWELVE accepted evidence category keys with safe bounded labels. NEVER a raw log,
//     command output, stdout/stderr, stack trace, raw error, file path, source filename, package/dependency/
//     version detail, screenshot/trace/video/report, runtime diagnostic, build internal, secret, token, DB
//     url, email, domain, permission/RBAC key, tenant/store/customer/identity/audit value, or a
//     production-readiness claim.
//   - No import from src/ (the client bundle); no mockData import; no sensitive row-shaped type import.
//   - Deeply frozen constant + defensive-copy getter. SIX ENFORCED fitness functions mechanically prove the
//     category allow-list, the recursive output-key allow-list, value-content safety, env/fs/clock
//     invariance, the production-readiness-claim ban, and C-05 decoupling.

import {
  ALLOWED_EVIDENCE_KEYS,
  CANON_EVIDENCE_LABELS,
  CANON_OWNER_SURFACES,
  CANON_EVIDENCE_PURPOSES,
  buildC06QualityGatesEvidenceEnvelope,
  type C06CoveragePosture,
  type C06TypecheckPosture,
  type C06StaticScanPosture,
  type C06TransportPosture,
  type C06BrowserEvidencePosture,
  type C06SourceScopePosture,
  type C06ProductionPosture,
  type C06MutationPosture,
  type C06DataSourcePosture,
  type C06LogExposurePosture,
  type C06EvidenceStatus,
} from './bcpC06QualityGatesEvidenceReadModel';

/** Safe, server-owned quality-gate / evidence-coverage posture entry — accepted bounded fields only. */
export interface BcpC06QualityGatesEvidenceEntry {
  evidenceKey: string;
  evidenceLabel: string;
  ownerSurface: string;
  evidencePurpose: string;
  expectedCoveragePosture: C06CoveragePosture;
  testCoveragePosture: C06CoveragePosture;
  typecheckPosture: C06TypecheckPosture;
  staticScanPosture: C06StaticScanPosture;
  transportPosture: C06TransportPosture;
  browserEvidencePosture: C06BrowserEvidencePosture;
  regressionPosture: C06CoveragePosture;
  sourceScopePosture: C06SourceScopePosture;
  productionPosture: C06ProductionPosture;
  mutationPosture: C06MutationPosture;
  dataSourcePosture: C06DataSourcePosture;
  logExposurePosture: C06LogExposurePosture;
  evidenceStatus: C06EvidenceStatus;
}

// Shared posture constants — EVERY accepted evidence category is documented, code/config-only, internal-
// only, production-disabled, no-mutation, with no raw-log/command-output exposure. Uniform across all twelve
// (only key/label/ownerSurface/purpose vary), so the bounded counts are static and never a live result.
const EXPECTED: C06CoveragePosture = 'expected';
const TESTCOV: C06CoveragePosture = 'documented';
const TYPECHK: C06TypecheckPosture = 'documented';
const STATICSCAN: C06StaticScanPosture = 'documented';
const TRANSPORT: C06TransportPosture = 'documented';
const BROWSER: C06BrowserEvidencePosture = 'browser_waived_phase_2_only';
const REGRESSION: C06CoveragePosture = 'regression_required';
const SOURCESCOPE: C06SourceScopePosture = 'code_config_only';
const PROD: C06ProductionPosture = 'production_disabled';
const MUT: C06MutationPosture = 'no_mutation';
const DS: C06DataSourcePosture = 'code_config_only';
const LOGX: C06LogExposurePosture = 'no_raw_logs';
const EV: C06EvidenceStatus = 'documented';

// Server-authored, code/config evidence-coverage posture registry — ONLY the twelve accepted categories.
const ENTRIES: readonly BcpC06QualityGatesEvidenceEntry[] = ALLOWED_EVIDENCE_KEYS.map((evidenceKey, i) => ({
  evidenceKey,
  evidenceLabel: CANON_EVIDENCE_LABELS[i],
  ownerSurface: CANON_OWNER_SURFACES[i],
  evidencePurpose: CANON_EVIDENCE_PURPOSES[i],
  expectedCoveragePosture: EXPECTED,
  testCoveragePosture: TESTCOV,
  typecheckPosture: TYPECHK,
  staticScanPosture: STATICSCAN,
  transportPosture: TRANSPORT,
  browserEvidencePosture: BROWSER,
  regressionPosture: REGRESSION,
  sourceScopePosture: SOURCESCOPE,
  productionPosture: PROD,
  mutationPosture: MUT,
  dataSourcePosture: DS,
  logExposurePosture: LOGX,
  evidenceStatus: EV,
}));

/** The server-owned C-06 quality-gates / evidence-coverage registry, DEEPLY FROZEN. Safe bounded labels +
 *  allow-listed category keys only. Read via getBcpC06QualityGatesEvidenceEntries() for a copy. */
export const BCP_C06_QUALITY_GATES_EVIDENCE_ENTRIES: readonly Readonly<BcpC06QualityGatesEvidenceEntry>[] =
  Object.freeze(ENTRIES.map((e) => Object.freeze({ ...e })));

/**
 * Return the server-owned C-06 evidence-coverage entries as a FRESH defensive copy. PURE, DETERMINISTIC,
 * NO-THROW. Takes NO arguments and reads NO env/request/global/live/filesystem/clock state. Mutating the
 * result never affects the constant or a later call.
 */
export function getBcpC06QualityGatesEvidenceEntries(): BcpC06QualityGatesEvidenceEntry[] {
  return BCP_C06_QUALITY_GATES_EVIDENCE_ENTRIES.map((e) => ({ ...e }));
}

// ===========================================================================
// FITNESS FUNCTION 1 — ENFORCED EVIDENCE-CATEGORY ALLOW-LIST (Section D).
// ===========================================================================
const EVIDENCE_KEY_SHAPE_RE = /^[a-z0-9_]+$/;
// Substrings that must NEVER appear in an accepted evidence category KEY (a key must not encode a secret,
// credential, DB/Supabase target, or identity).
const EVIDENCE_KEY_DENY = [
  'tenant', 'store', 'customer', 'secret', 'token', 'password', 'credential', 'apikey', 'api_key',
  'private_key', 'privatekey', 'url', 'supabase', 'database', 'connection', 'auth', 'rbac', 'permission',
];

/**
 * ENFORCED ALLOW-LIST FITNESS FUNCTION. Mechanically proves the C-06 posture registry exposes ONLY the
 * twelve accepted evidence-coverage category keys, in index-aligned tuples (key ↔ label ↔ ownerSurface ↔
 * purpose), each key shaped safely and free of secret/identity/DB substrings. THROWS with a descriptive
 * message on ANY violation. Not on the no-throw data path. Accepts an optional entries array so tests can
 * prove a tampered set is rejected.
 */
export function assertBcpC06EvidenceCategoryAllowList(
  entries: readonly BcpC06QualityGatesEvidenceEntry[] = getBcpC06QualityGatesEvidenceEntries(),
): void {
  if (!Array.isArray(entries)) {
    throw new Error('C-06 evidence-category allow-list violation(s): entries is not an array');
  }
  const violations: string[] = [];
  const tupleByKey = new Map<string, { label: string; surface: string; purpose: string }>();
  for (let i = 0; i < ALLOWED_EVIDENCE_KEYS.length; i++) {
    tupleByKey.set(ALLOWED_EVIDENCE_KEYS[i], { label: CANON_EVIDENCE_LABELS[i], surface: CANON_OWNER_SURFACES[i], purpose: CANON_EVIDENCE_PURPOSES[i] });
  }

  if (entries.length !== ALLOWED_EVIDENCE_KEYS.length) {
    violations.push(`expected exactly ${ALLOWED_EVIDENCE_KEYS.length} entries, got ${entries.length}`);
  }
  const seenKeys = new Set<string>();
  const seenLabels = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== 'object') { violations.push('non-object entry'); continue; }
    const tuple = tupleByKey.get(e.evidenceKey);
    if (!tuple) {
      violations.push(`evidence category not allow-listed: ${String(e.evidenceKey)}`);
    } else {
      if (e.evidenceLabel !== tuple.label) violations.push(`evidence label mismatch for ${e.evidenceKey}: ${String(e.evidenceLabel)}`);
      if (e.ownerSurface !== tuple.surface) violations.push(`owner surface mismatch for ${e.evidenceKey}: ${String(e.ownerSurface)}`);
      if (e.evidencePurpose !== tuple.purpose) violations.push(`evidence purpose mismatch for ${e.evidenceKey}: ${String(e.evidencePurpose)}`);
    }
    if (typeof e.evidenceKey !== 'string' || !EVIDENCE_KEY_SHAPE_RE.test(e.evidenceKey)) {
      violations.push(`evidence key unsafe shape: ${String(e.evidenceKey)}`);
    } else {
      const lower = e.evidenceKey.toLowerCase();
      for (const bad of EVIDENCE_KEY_DENY) if (lower.includes(bad)) violations.push(`evidence key contains forbidden substring "${bad}": ${e.evidenceKey}`);
    }
    if (seenKeys.has(e.evidenceKey)) violations.push(`duplicate evidence key: ${String(e.evidenceKey)}`);
    if (seenLabels.has(e.evidenceLabel)) violations.push(`duplicate evidence label: ${String(e.evidenceLabel)}`);
    seenKeys.add(e.evidenceKey);
    seenLabels.add(e.evidenceLabel);
  }
  for (const k of ALLOWED_EVIDENCE_KEYS) if (!seenKeys.has(k)) violations.push(`missing accepted evidence key: ${k}`);

  if (violations.length > 0) {
    throw new Error(`C-06 evidence-category allow-list violation(s): ${violations.join('; ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 2 — ENFORCED RECURSIVE OUTPUT-KEY ALLOW-LIST (Section E).
// ===========================================================================
// The ONLY object keys C-06 output may contain, at any depth (envelope + freshness + summaryCounts +
// emptyState + evidence item). Anything else fails closed.
export const ALLOWED_OUTPUT_KEYS: ReadonlySet<string> = new Set<string>([
  // envelope
  'schemaVersion', 'sourceMode', 'generatedAt', 'freshness', 'summaryCounts', 'evidenceItems', 'emptyState',
  'warnings', 'redactionPosture', 'logExposurePosture', 'productionPosture', 'mutationPosture',
  'dataSourcePosture', 'evidenceLabels',
  // freshness
  'lastSuccessfulReadLabel',
  // summaryCounts
  'total', 'documented', 'codeConfigOnly', 'noRawLogs', 'noCommandOutput', 'noProductionClaim',
  'internalOnly', 'unknown',
  // emptyState
  'isEmpty', 'reason',
  // evidence item
  'evidenceKey', 'evidenceLabel', 'ownerSurface', 'evidencePurpose', 'expectedCoveragePosture',
  'testCoveragePosture', 'typecheckPosture', 'staticScanPosture', 'transportPosture',
  'browserEvidencePosture', 'regressionPosture', 'sourceScopePosture', 'evidenceStatus',
]);

// Keys (case-insensitive) that must NEVER appear in C-06 output at any depth — raw evidence / logs / command
// output / diagnostics / paths / packages / artifacts / secrets / identity / arbitrary detail objects.
export const PROHIBITED_OUTPUT_KEYS: ReadonlySet<string> = new Set<string>([
  'log', 'logs', 'rawlog', 'rawlogs', 'output', 'rawoutput', 'commandoutput', 'stdout', 'stderr',
  'stack', 'stacktrace', 'error', 'rawerror', 'exception',
  'details', 'metadata', 'diagnostics', 'diagnosticoutput', 'runtime', 'runtimestate',
  'build', 'buildoutput', 'buildid', 'command', 'shell',
  'file', 'files', 'filepath', 'path', 'paths', 'filename', 'sourcepath', 'line', 'column',
  'package', 'packages', 'dependency', 'dependencies', 'version', 'versions',
  'artifact', 'artifacts', 'trace', 'traces', 'screenshot', 'screenshots', 'video', 'videos',
  'report', 'reports', 'reportpath', 'cijob', 'cilog', 'raw',
  'env', 'secret', 'token', 'credential', 'password', 'privatekey',
  'url', 'domain', 'databaseurl', 'supabaseurl', 'authprovider',
  'tenantid', 'storeid', 'userid', 'email', 'permission', 'permissions', 'rbac', 'connection',
  'connectionstring', 'mismatch',
]);

const MAX_OUTPUT_DEPTH = 4;

/**
 * ENFORCED RECURSIVE OUTPUT-KEY ALLOW-LIST FITNESS FUNCTION (Section E). Path-aware, recursive, bounded to
 * depth 4, ATOMIC FAIL-CLOSED. Mechanically proves a structure (a DTO envelope, item, or client-normalized
 * shape) contains ONLY frozen, allow-listed object keys at every depth — and NO prohibited key (raw log /
 * command output / stack / error / details / metadata / diagnostics / path / package / artifact / secret /
 * identity, etc.). THROWS with the offending path(s). Over-depth ⇒ fail closed. Not on the no-throw path.
 */
export function assertBcpC06OutputKeyAllowList(value: unknown = buildC06QualityGatesEvidenceEnvelope(getBcpC06QualityGatesEvidenceEntries())): void {
  const violations: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (node === null || typeof node !== 'object') return;
    if (depth > MAX_OUTPUT_DEPTH) { violations.push(`over-depth (>${MAX_OUTPUT_DEPTH}) at ${path}`); return; }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const p = `${path}.${key}`;
      if (PROHIBITED_OUTPUT_KEYS.has(key.toLowerCase())) violations.push(`prohibited output key "${key}" at ${p}`);
      else if (!ALLOWED_OUTPUT_KEYS.has(key)) violations.push(`non-allow-listed output key "${key}" at ${p}`);
      let child: unknown;
      try { child = (node as Record<string, unknown>)[key]; } catch { child = undefined; }
      walk(child, p, depth + 1);
    }
  };
  walk(value, '$', 0);
  if (violations.length > 0) {
    throw new Error(`C-06 output-key allow-list violation(s): ${violations.join('; ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 3 — VALUE-CONTENT SCAN (Section F).
// ===========================================================================
// Threat-targeted detectors: they match genuine leaked evidence content (paths, filenames, stack/command/
// stdout fragments, package/version strings, SHA-like hex ≥7, CVE ids, URLs, domains, emails, tokens, DB
// strings, percent-pass / C-0x count claims, production-readiness claims) but NOT the bounded snake_case
// posture vocabulary, the schemaVersion, the ISO synthetic timestamp, or the safe negation labels
// (no_command_output, no_raw_logs, …). M19A: SHA threshold = hex length ≥ 7; ZERO exemptions on emitted
// values (the detectors are tuned so every legitimately-emitted value passes on its own merit).
const UNSAFE_VALUE_DETECTORS: { name: string; re: RegExp }[] = [
  { name: 'url', re: /:\/\// },
  { name: 'email_or_at', re: /@/ },
  { name: 'path', re: /\// },
  { name: 'file_extension', re: /\.(ts|tsx|js|jsx|mjs|cjs|json|env|key|pem|sql|sh|ya?ml|toml|lock|log|txt|md)\b/i },
  { name: 'stack_or_error', re: /\bat\s+[A-Za-z_$][\w$.]*\s*\(|Error:|Exception|\bstack\s?trace\b|\bthrow\b/i },
  { name: 'std_stream', re: /\b(stdout|stderr)\b/i },
  { name: 'command', re: /\b(npm|npx|tsx|node|bash|git|sudo|curl|wget|grep|chmod)\b|&&|\|\||\$\(|`/i },
  { name: 'semver_or_pkgver', re: /\b\d+\.\d+\.\d+\b|@\d/ },
  { name: 'sha_like_hex', re: /\b[0-9a-f]{7,}\b/i },
  { name: 'cve', re: /\bCVE-\d{4}-\d+\b/i },
  { name: 'domain', re: /\b[a-z0-9-]+\.(?:com|net|org|io|co|dev|app|gov|edu|info|biz|cloud|sh|ai)\b/i },
  { name: 'secret_marker', re: /bearer|eyj|service_role|sk_live|\bsecret\b|\btoken\b|\bpassword\b|postgres|supabase|\bapi_?key\b/i },
  { name: 'percent_pass', re: /%/ },
  // A C-0x reference immediately followed by a count (e.g. "C-05 170"), or an "N/N" ratio. NOT a bare
  // "c06" (the schemaVersion contains that), so the schema string passes on its own merit.
  { name: 'count_or_ratio_claim', re: /\bc-?0\d[^A-Za-z0-9]{0,4}\d|\b\d+\s*\/\s*\d+\b/i },
  { name: 'cloud_access_key', re: /\b(AKIA|ASIA|AIza|ghp_|gho_|xox[baprs]-)[0-9A-Za-z_-]{6,}\b/ },
  { name: 'errno_or_screaming_token', re: /\bE[A-Z]{3,}\b|\b[A-Z]{4,}_[A-Z0-9_]{3,}\b/ },
  { name: 'named_build_file', re: /\b(Dockerfile|Makefile|Jenkinsfile|Procfile|Gemfile|Rakefile)\b/ },
  { name: 'name_space_version', re: /\b[A-Za-z][A-Za-z.+-]{1,}\s+v?\d+\.\d+\b/ },
];

// Production-readiness claim detector — shared with the dedicated ban (Section H). Operates on a normalized
// string (lowercased; _,-,space collapsed to single space). Matches affirmative readiness claims ONLY; does
// NOT match the allowed posture labels ('production disabled', 'no production claim', 'non readiness …').
const READINESS_CLAIM_PHRASES = [
  'production ready', 'ready for production', 'ready for customer', 'customer ready',
  'fully certified', 'fully compliant', 'all quality gates passed', 'no risk',
  'complete assurance', 'production approved', 'phase 3 ready', 'phase 4 ready',
  'safe to deploy', 'ready to ship', 'ship it', 'go live', 'ready for release',
  'release ready', 'good to go', 'deploy to production', 'ready to release',
];
function normalizeForClaim(s: string): string {
  return s.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function isProductionReadinessClaim(value: string): boolean {
  const n = normalizeForClaim(value);
  return READINESS_CLAIM_PHRASES.some((p) => n.includes(p));
}

function collectStringsDeep(value: unknown, acc: string[], depth = 0): void {
  if (depth > 8 || value === null) return;
  if (typeof value === 'string') { acc.push(value); return; }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) collectStringsDeep(v, acc, depth + 1); return; }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    try { collectStringsDeep((value as Record<string, unknown>)[k], acc, depth + 1); } catch { /* throwing getter */ }
  }
}

/**
 * ENFORCED VALUE-CONTENT SCAN FITNESS FUNCTION (Section F). Recursively inspects EVERY emitted string value
 * and THROWS if any contains unsafe raw-evidence content (path / filename / stack / command / stdout /
 * package-version / SHA-like hex ≥ 7 / CVE / URL / domain / email / token / DB string / percent-pass /
 * C-0x count / production-readiness claim). Safe bounded labels, the schemaVersion, and the synthetic
 * timestamp pass on their own merit (no exemption list). Not on the no-throw data path.
 */
export function assertBcpC06ValueContentSafety(value: unknown = buildC06QualityGatesEvidenceEnvelope(getBcpC06QualityGatesEvidenceEntries())): void {
  const strings: string[] = [];
  collectStringsDeep(value, strings);
  const violations: string[] = [];
  for (const s of strings) {
    for (const d of UNSAFE_VALUE_DETECTORS) if (d.re.test(s)) violations.push(`${d.name}: ${JSON.stringify(s).slice(0, 80)}`);
    if (isProductionReadinessClaim(s)) violations.push(`production_readiness_claim: ${JSON.stringify(s).slice(0, 80)}`);
  }
  if (violations.length > 0) {
    throw new Error(`C-06 value-content violation(s): ${violations.join('; ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 4 — ENV / FILESYSTEM / CLOCK INVARIANCE (Section G).
// ===========================================================================
/**
 * ENFORCED INVARIANCE FITNESS FUNCTION (Section G). Proves the provider entries and the built envelope are
 * DETERMINISTIC and carry a FIXED synthetic generatedAt — i.e. they cannot vary with runtime state because
 * they read none. THROWS on any non-determinism. (The companion test additionally mutates process.env / the
 * filesystem around these calls to prove byte-identical output.) Not on the no-throw data path.
 */
export function assertBcpC06InvarianceContract(): void {
  const violations: string[] = [];
  const e1 = JSON.stringify(getBcpC06QualityGatesEvidenceEntries());
  const e2 = JSON.stringify(getBcpC06QualityGatesEvidenceEntries());
  if (e1 !== e2) violations.push('provider entries are not deterministic across calls');
  const env1 = buildC06QualityGatesEvidenceEnvelope(getBcpC06QualityGatesEvidenceEntries());
  const env2 = buildC06QualityGatesEvidenceEnvelope(getBcpC06QualityGatesEvidenceEntries());
  if (JSON.stringify(env1) !== JSON.stringify(env2)) violations.push('built envelope is not deterministic across calls');
  if (env1.generatedAt !== '2026-01-01T00:00:00.000Z') violations.push(`generatedAt is not the fixed synthetic constant: ${env1.generatedAt}`);
  if (env1.generatedAt !== buildC06QualityGatesEvidenceEnvelope([]).generatedAt) violations.push('generatedAt varies with input');
  if (violations.length > 0) {
    throw new Error(`C-06 invariance violation(s): ${violations.join('; ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 5 — PRODUCTION-READINESS-CLAIM BAN (Section H).
// ===========================================================================
/**
 * ENFORCED PRODUCTION-READINESS-CLAIM BAN (Section H). Recursively inspects every emitted string value and
 * THROWS if any states/implies production/customer readiness, certification, full compliance, no-risk, or
 * Phase 3/4 readiness. Allowed non-readiness statements (production_disabled, no_production_claim,
 * non_readiness_statements, …) pass. Not on the no-throw data path.
 */
export function assertBcpC06ProductionReadinessClaimBan(value: unknown = buildC06QualityGatesEvidenceEnvelope(getBcpC06QualityGatesEvidenceEntries())): void {
  const strings: string[] = [];
  collectStringsDeep(value, strings);
  const offenders = strings.filter(isProductionReadinessClaim);
  if (offenders.length > 0) {
    throw new Error(`C-06 production-readiness-claim violation(s): ${offenders.map((s) => JSON.stringify(s)).join(', ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 6 — C-05 DECOUPLING (Section I).
// ===========================================================================
// C-05 tokens that must never appear as a C-06 evidence category / label / surface / purpose. (Static import
// decoupling — that no C-06 file imports a C-05 module — is proven separately by the file-walk in the tests.)
const C05_TOKENS = [
  'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS',
  'VITE_ENABLE_BACKEND_CONTROL_PLANE',
  'c05_feature_flag_posture_backend_gate',
  'c05_feature_flag_posture',
  'feature_flag_posture_lens_gate',
];

/**
 * ENFORCED C-05 DECOUPLING FITNESS FUNCTION (Section I). Proves no C-06 evidence entry reinterprets a C-05
 * feature-flag name / gate key / lens-gate purpose as an evidence category. THROWS on any reuse. Not on the
 * no-throw data path.
 */
export function assertBcpC06NoC05Coupling(
  entries: readonly BcpC06QualityGatesEvidenceEntry[] = getBcpC06QualityGatesEvidenceEntries(),
): void {
  const violations: string[] = [];
  for (const e of entries) {
    const fields = [e.evidenceKey, e.evidenceLabel, e.ownerSurface, e.evidencePurpose];
    for (const v of fields) {
      if (typeof v !== 'string') continue;
      for (const tok of C05_TOKENS) if (v.includes(tok)) violations.push(`C-05 token "${tok}" reused in: ${v}`);
      if (/\bc-?05\b/i.test(v) || v.toLowerCase().includes('feature_flag_posture')) violations.push(`C-05 reference in C-06 field: ${v}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`C-06 C-05 decoupling violation(s): ${violations.join('; ')}`);
  }
}
