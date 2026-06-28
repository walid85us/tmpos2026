// Phase 2.0 M20 — C-06 Backend CP Quality Gates / Evidence Coverage Posture Lens: PURE read model + DTO.
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW, DETERMINISTIC builder that maps server-owned, code/config
// quality-gate / evidence-coverage POSTURE entries (the TWELVE accepted evidence categories only) into a
// safe, bounded C-06 envelope. It mirrors the hardened C-02..C-05 read models and adds a HARD ALLOW-LIST
// for evidence category KEYS + index-aligned canonical tuples (key ↔ label ↔ ownerSurface ↔ purpose) — and
// emits ONLY bounded posture labels, NEVER a raw log, command output, file path, package detail, runtime
// diagnostic, build internal, or production-readiness claim.
//
// BINDING SAFETY:
//   - No DB/Supabase/provider/fetch/network/filesystem/I/O. No Express/router/request/auth dependency.
//   - NEVER reads process.env for output, never enumerates env, never reads logs/test/typecheck/static-scan
//     output, never reads packages, never executes a command.
//   - evidenceKey/evidenceLabel/ownerSurface/evidencePurpose are validated against HARD ALLOW-LISTS; any
//     non-allow-listed value is redacted and never emitted as valid. Every posture field becomes a safe
//     bounded enum label or 'unknown'.
//   - NEVER tenant/store/customer rows, identity/audit rows, permission/RBAC keys, secrets, tokens, DB URLs,
//     emails, domains, raw env values, raw file paths/filenames, package/version strings, or raw identifiers.
//   - This is NOT a log viewer, diagnostics console, test/build-output viewer, package inventory, or
//     production-readiness claim. It shows safe coverage POSTURE labels only.

export const C06_QUALITY_GATES_EVIDENCE_SCHEMA_VERSION_V1 = 'bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config';
export type C06SourceMode = 'code_config';
const FRESHNESS_LABEL = 'code-config-no-live-read';
const WARNING_LABEL = 'code_config';
// Synthetic constant — never the real server clock, so generatedAt can never become a runtime oracle.
const C06_GENERATED_AT = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// HARD ALLOW-LIST — the ONLY accepted evidence-coverage category KEYS, with index-aligned canonical tuples
// (label ↔ ownerSurface ↔ purpose). Single source of truth, reused by the provider, its allow-list fitness
// function, and the read model's category/label validators.
// ---------------------------------------------------------------------------
export const ALLOWED_EVIDENCE_KEYS: readonly string[] = [
  'test_coverage',
  'typecheck_posture',
  'static_scan_posture',
  'transport_verification',
  'frontend_proxy_review',
  'browser_evidence_governance',
  'independent_review',
  'scoped_commit_backup',
  'source_scope_control',
  'baseline_freeze',
  'regression_coverage',
  'non_readiness_statements',
];
// Index-aligned with ALLOWED_EVIDENCE_KEYS. Bounded safe labels only.
export const CANON_EVIDENCE_LABELS: readonly string[] = [
  'Test Coverage',
  'Typecheck Posture',
  'Static Scan Posture',
  'Transport Verification',
  'Frontend Proxy Review',
  'Browser Evidence Governance',
  'Independent Review',
  'Scoped Commit Backup',
  'Source Scope Control',
  'Baseline Freeze',
  'Regression Coverage',
  'Non Readiness Statements',
];
export const CANON_OWNER_SURFACES: readonly string[] = [
  'backend_cp_quality_gates',
  'backend_cp_quality_gates',
  'backend_cp_quality_gates',
  'backend_cp_evidence_coverage',
  'backend_cp_evidence_coverage',
  'backend_cp_governance',
  'backend_cp_review',
  'backend_cp_governance',
  'backend_cp_governance',
  'backend_cp_baseline',
  'backend_cp_quality_gates',
  'backend_cp_governance',
];
export const CANON_EVIDENCE_PURPOSES: readonly string[] = [
  'test_coverage_posture',
  'typecheck_posture_evidence',
  'static_scan_posture_evidence',
  'transport_verification_posture',
  'frontend_proxy_review_posture',
  'browser_evidence_governance_posture',
  'independent_review_posture',
  'scoped_commit_backup_posture',
  'source_scope_control_posture',
  'baseline_freeze_posture',
  'regression_coverage_posture',
  'non_readiness_statements_posture',
];

const EVIDENCE_KEY_SET = new Set<string>(ALLOWED_EVIDENCE_KEYS);
const LABEL_SET = new Set<string>(CANON_EVIDENCE_LABELS);
const OWNER_SURFACE_SET = new Set<string>(CANON_OWNER_SURFACES);
const PURPOSE_SET = new Set<string>(CANON_EVIDENCE_PURPOSES);
const REDACTED_CATEGORY = 'redacted_category';
const REDACTED_LABEL = 'redacted_label';

// ---------------------------------------------------------------------------
// Safe bounded enum vocabularies (closed). No free text, no dynamic strings, no raw-evidence-derived values.
// ---------------------------------------------------------------------------
export type C06CoveragePosture = 'documented' | 'expected' | 'required' | 'regression_required' | 'not_applicable' | 'unknown';
export type C06TypecheckPosture = 'documented' | 'expected' | 'static_contract_only' | 'not_applicable' | 'unknown';
export type C06StaticScanPosture = 'documented' | 'static_contract_only' | 'no_raw_logs' | 'not_applicable' | 'unknown';
export type C06TransportPosture = 'documented' | 'expected' | 'not_applicable' | 'unknown';
export type C06BrowserEvidencePosture = 'browser_waived_phase_2_only' | 'future_reopen_required' | 'not_applicable' | 'unknown';
export type C06SourceScopePosture = 'code_config_only' | 'server_owned' | 'static_contract_only' | 'not_applicable' | 'unknown';
export type C06ProductionPosture = 'production_disabled' | 'no_production_claim' | 'not_applicable' | 'unknown';
export type C06MutationPosture = 'no_mutation' | 'no_backend_action' | 'not_applicable' | 'unknown';
export type C06DataSourcePosture = 'code_config_only' | 'server_owned' | 'static_contract_only' | 'not_applicable' | 'unknown';
export type C06LogExposurePosture =
  | 'no_raw_logs' | 'no_command_output' | 'no_stack_traces' | 'no_file_paths' | 'no_package_details'
  | 'no_runtime_diagnostics' | 'no_build_internals' | 'no_ci_log_surface' | 'no_artifact_surface'
  | 'no_raw_reports' | 'not_applicable' | 'unknown';
export type C06EvidenceStatus =
  | 'documented' | 'static_reviewed' | 'tested' | 'transport_verified' | 'browser_waived_phase_2_only'
  | 'frozen_baseline' | 'regression_required' | 'independent_review_required' | 'scoped_backup_required' | 'unknown';

const COVERAGE_POSTURE = new Set<string>(['documented', 'expected', 'required', 'regression_required', 'not_applicable']);
const TYPECHECK_POSTURE = new Set<string>(['documented', 'expected', 'static_contract_only', 'not_applicable']);
const STATIC_SCAN_POSTURE = new Set<string>(['documented', 'static_contract_only', 'no_raw_logs', 'not_applicable']);
const TRANSPORT_POSTURE = new Set<string>(['documented', 'expected', 'not_applicable']);
const BROWSER_POSTURE = new Set<string>(['browser_waived_phase_2_only', 'future_reopen_required', 'not_applicable']);
const SOURCE_SCOPE_POSTURE = new Set<string>(['code_config_only', 'server_owned', 'static_contract_only', 'not_applicable']);
const PRODUCTION_POSTURE = new Set<string>(['production_disabled', 'no_production_claim', 'not_applicable']);
const MUTATION_POSTURE = new Set<string>(['no_mutation', 'no_backend_action', 'not_applicable']);
const DATA_SOURCE_POSTURE = new Set<string>(['code_config_only', 'server_owned', 'static_contract_only', 'not_applicable']);
const LOG_EXPOSURE_POSTURE = new Set<string>([
  'no_raw_logs', 'no_command_output', 'no_stack_traces', 'no_file_paths', 'no_package_details',
  'no_runtime_diagnostics', 'no_build_internals', 'no_ci_log_surface', 'no_artifact_surface', 'no_raw_reports', 'not_applicable',
]);
const EVIDENCE_STATUS = new Set<string>([
  'documented', 'static_reviewed', 'tested', 'transport_verified', 'browser_waived_phase_2_only',
  'frozen_baseline', 'regression_required', 'independent_review_required', 'scoped_backup_required',
]);

// Count-derivation sets — counts derive ONLY from these static label memberships, invariant to runtime env/
// filesystem/clock. Never a count of live test/typecheck/scan results.
const DOCUMENTED_STATUS_SET = new Set<string>([
  'documented', 'static_reviewed', 'tested', 'transport_verified', 'browser_waived_phase_2_only',
  'frozen_baseline', 'regression_required', 'independent_review_required', 'scoped_backup_required',
]);
const CODE_CONFIG_SET = new Set<string>(['code_config_only', 'server_owned', 'static_contract_only']);
const NO_LOG_SET = new Set<string>([
  'no_raw_logs', 'no_command_output', 'no_stack_traces', 'no_file_paths', 'no_package_details',
  'no_runtime_diagnostics', 'no_build_internals', 'no_ci_log_surface', 'no_artifact_surface', 'no_raw_reports',
]);
const NO_PROD_CLAIM_SET = new Set<string>(['production_disabled', 'no_production_claim']);

// ---------------------------------------------------------------------------
// Untrusted input + safe output shapes.
// ---------------------------------------------------------------------------
export interface C06QualityGatesEvidenceEntryInput {
  evidenceKey?: unknown;
  evidenceLabel?: unknown;
  ownerSurface?: unknown;
  evidencePurpose?: unknown;
  expectedCoveragePosture?: unknown;
  testCoveragePosture?: unknown;
  typecheckPosture?: unknown;
  staticScanPosture?: unknown;
  transportPosture?: unknown;
  browserEvidencePosture?: unknown;
  regressionPosture?: unknown;
  sourceScopePosture?: unknown;
  productionPosture?: unknown;
  mutationPosture?: unknown;
  dataSourcePosture?: unknown;
  logExposurePosture?: unknown;
  evidenceStatus?: unknown;
}

export interface C06EvidenceItem {
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

export interface C06SummaryCounts {
  total: number;
  documented: number;
  codeConfigOnly: number;
  noRawLogs: number;
  noCommandOutput: number;
  noProductionClaim: number;
  internalOnly: number;
  unknown: number;
}

export interface C06EmptyState {
  isEmpty: boolean;
  reason: string;
}

export interface C06QualityGatesEvidenceEnvelope {
  schemaVersion: string;
  sourceMode: C06SourceMode;
  generatedAt: string;
  freshness: { lastSuccessfulReadLabel: string };
  summaryCounts: C06SummaryCounts;
  evidenceItems: C06EvidenceItem[];
  emptyState: C06EmptyState;
  warnings: string[];
  redactionPosture: string;
  logExposurePosture: string;
  productionPosture: string;
  mutationPosture: string;
  dataSourcePosture: string;
  evidenceLabels: string[];
}

// ---------------------------------------------------------------------------
// Safe-label + safe-category + enum strategy (self-contained; same hardening lineage as C-02..C-05).
// ---------------------------------------------------------------------------
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'secret', 'token', 'password',
  'postgres', 'supabase', 'apikey', 'api_key', 'stdout', 'stderr',
  'sk_', 'sk-', 'pk_', 'pk-', 'rk_', 'ak_', 'cus_', 'acct_', 'usr_', 'txn_', 'tok_', 'card_',
  'tenant_', 'store_', 'customer_', 'identity_link', 'identitylink', 'provider_uid', 'internal_user',
  'audit_', 'permission_', 'entitlement_', 'mismatch_',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_ALNUM_RUN_RE = /[A-Za-z0-9]{24,}/;
const DIGIT_RUN_RE = /\d{4,}/;
const DOMAINISH_RE = /\b[a-z0-9-]+\.(?:com|net|org|io|co|dev|app|gov|edu|info|biz|cloud|sh|ai)\b/i;
const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|env|key|pem|sql|sh|ya?ml|toml|lock|log|txt|md)\b/i;

/** Defense-in-depth: true only when the value is a safe bounded label (no secrets/ids/domains/filenames).
 *  Not used to validate the closed enum labels (those are allow-listed); exposed for the fitness functions. */
export function isSafeC06Label(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  if (!SAFE_LABEL_RE.test(value)) return false;
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return false;
  if (UUID_RE.test(value) || LONG_ALNUM_RUN_RE.test(value) || DIGIT_RUN_RE.test(value) ||
      DOMAINISH_RE.test(value) || FILE_EXT_RE.test(value)) {
    return false;
  }
  return true;
}

/** Return the evidence KEY only if it is in the hard allow-list; otherwise `redacted_category`. */
function safeEvidenceKey(value: unknown): string {
  return typeof value === 'string' && EVIDENCE_KEY_SET.has(value) ? value : REDACTED_CATEGORY;
}

/** Return the evidence LABEL only if it is in the canonical allow-list; otherwise `redacted_label`. */
function safeEvidenceLabel(value: unknown): string {
  return typeof value === 'string' && LABEL_SET.has(value) ? value : REDACTED_LABEL;
}

/** Normalize an untrusted value to a member of `allowed` or the `fallback` (never the raw value). */
function normalizeEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : fallback;
}

/** Read one untrusted field defensively — a throwing getter/proxy yields `undefined`, never a throw. */
function readField(obj: object, key: keyof C06QualityGatesEvidenceEntryInput): unknown {
  try {
    return (obj as Record<string, unknown>)[key as string];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Builder — PURE + NO-THROW + DETERMINISTIC.
// ---------------------------------------------------------------------------

/**
 * Build the C-06 quality-gates / evidence-coverage DTO envelope from server-owned code/config posture
 * entries. PURE, SYNCHRONOUS, NO-THROW, DETERMINISTIC. evidenceKey/label/ownerSurface/purpose are
 * allow-list-validated; every posture field is a bounded enum; non-array input and non-object entries are
 * handled safely (no throw, no invented entries). Reads ONLY the seventeen known fields — an injected raw
 * log / command output / path / package field is never copied into output.
 */
export function buildC06QualityGatesEvidenceEnvelope(
  entries: readonly C06QualityGatesEvidenceEntryInput[],
): C06QualityGatesEvidenceEnvelope {
  const list: readonly unknown[] = Array.isArray(entries) ? entries : [];

  const evidenceItems: C06EvidenceItem[] = [];
  for (let idx = 0; idx < list.length; idx++) {
    let item: C06EvidenceItem | null = null;
    try {
      const entry = list[idx];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      item = {
        evidenceKey: safeEvidenceKey(readField(entry, 'evidenceKey')),
        evidenceLabel: safeEvidenceLabel(readField(entry, 'evidenceLabel')),
        ownerSurface: normalizeEnum(readField(entry, 'ownerSurface'), OWNER_SURFACE_SET, 'unknown'),
        evidencePurpose: normalizeEnum(readField(entry, 'evidencePurpose'), PURPOSE_SET, 'unknown'),
        expectedCoveragePosture: normalizeEnum(readField(entry, 'expectedCoveragePosture'), COVERAGE_POSTURE, 'unknown'),
        testCoveragePosture: normalizeEnum(readField(entry, 'testCoveragePosture'), COVERAGE_POSTURE, 'unknown'),
        typecheckPosture: normalizeEnum(readField(entry, 'typecheckPosture'), TYPECHECK_POSTURE, 'unknown'),
        staticScanPosture: normalizeEnum(readField(entry, 'staticScanPosture'), STATIC_SCAN_POSTURE, 'unknown'),
        transportPosture: normalizeEnum(readField(entry, 'transportPosture'), TRANSPORT_POSTURE, 'unknown'),
        browserEvidencePosture: normalizeEnum(readField(entry, 'browserEvidencePosture'), BROWSER_POSTURE, 'unknown'),
        regressionPosture: normalizeEnum(readField(entry, 'regressionPosture'), COVERAGE_POSTURE, 'unknown'),
        sourceScopePosture: normalizeEnum(readField(entry, 'sourceScopePosture'), SOURCE_SCOPE_POSTURE, 'unknown'),
        productionPosture: normalizeEnum(readField(entry, 'productionPosture'), PRODUCTION_POSTURE, 'unknown'),
        mutationPosture: normalizeEnum(readField(entry, 'mutationPosture'), MUTATION_POSTURE, 'unknown'),
        dataSourcePosture: normalizeEnum(readField(entry, 'dataSourcePosture'), DATA_SOURCE_POSTURE, 'unknown'),
        logExposurePosture: normalizeEnum(readField(entry, 'logExposurePosture'), LOG_EXPOSURE_POSTURE, 'unknown'),
        evidenceStatus: normalizeEnum(readField(entry, 'evidenceStatus'), EVIDENCE_STATUS, 'unknown'),
      };
    } catch {
      item = null;
    }
    if (item) evidenceItems.push(item);
  }

  // Counts are STATIC posture facts derived ONLY from bounded labels — byte-identical regardless of the
  // runtime environment, filesystem, clock, or whether any gate has actually been run. Never a live result.
  const summaryCounts: C06SummaryCounts = {
    total: evidenceItems.length,
    documented: evidenceItems.filter((i) => DOCUMENTED_STATUS_SET.has(i.evidenceStatus)).length,
    codeConfigOnly: evidenceItems.filter((i) => CODE_CONFIG_SET.has(i.dataSourcePosture)).length,
    noRawLogs: evidenceItems.filter((i) => NO_LOG_SET.has(i.logExposurePosture)).length,
    noCommandOutput: evidenceItems.filter((i) => NO_LOG_SET.has(i.logExposurePosture)).length,
    noProductionClaim: evidenceItems.filter((i) => NO_PROD_CLAIM_SET.has(i.productionPosture)).length,
    internalOnly: evidenceItems.filter((i) => CODE_CONFIG_SET.has(i.sourceScopePosture)).length,
    unknown: evidenceItems.filter((i) => i.evidenceStatus === 'unknown').length,
  };

  const isEmpty = evidenceItems.length === 0;

  return {
    schemaVersion: C06_QUALITY_GATES_EVIDENCE_SCHEMA_VERSION_V1,
    sourceMode: 'code_config',
    generatedAt: C06_GENERATED_AT,
    freshness: { lastSuccessfulReadLabel: FRESHNESS_LABEL },
    summaryCounts,
    evidenceItems,
    emptyState: isEmpty
      ? { isEmpty: true, reason: 'no_quality_gate_evidence_entries' }
      : { isEmpty: false, reason: 'none' },
    warnings: [WARNING_LABEL],
    redactionPosture: 'safe_labels_only',
    logExposurePosture: 'no_raw_logs',
    productionPosture: 'production_disabled',
    mutationPosture: 'no_mutation',
    dataSourcePosture: 'code_config_only',
    evidenceLabels: [
      'code_config_only',
      'static_contract_only',
      'server_owned',
      'no_raw_logs',
      'no_command_output',
      'no_stack_traces',
      'no_file_paths',
      'no_package_details',
      'no_runtime_diagnostics',
      'no_build_internals',
      'no_ci_log_surface',
      'no_artifact_surface',
      'no_raw_reports',
      'no_production_claim',
      'production_disabled',
      'read_only',
      'no_mutation',
      'no_backend_action',
      'backend_cp_internal_only',
      'no_customer_facing_exposure',
      'no_saas_nav_exposure',
      'browser_waived_phase_2_only',
      'future_reopen_required',
      'regression_required',
      'independent_review_required',
      'scoped_backup_required',
    ],
  };
}
