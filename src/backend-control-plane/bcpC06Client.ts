// Phase 2.0 M20 — DEV-only read-only client + safe view-model for the C-06 quality-gates / evidence-coverage lens.
//
// Calls the isolated M20 route through the same-origin dev Vite proxy:
//   GET {IDENTITY_API_BASE}/dev/bcp/quality-gates-evidence-coverage-readiness
// Mirrors the frozen C-01..C-05 client pattern.
//
// SAFETY (binding):
//   - GET only. NO request body. NO credentials. NO Authorization header. NO query params.
//   - Sends NO client UID/email/tenant/store/customer/identity field and NO principal/evidence/rawEvidence/
//     mode/sourceMode/schemaVersion — authority and content are server-side only.
//   - Renders ONLY safe bounded LABELS / enums / bounded counts. evidenceKey is validated against a
//     client-side ALLOW-LIST (only the 12 accepted evidence categories); any other value → 'redacted'.
//     A defense-in-depth `safeLabel` strips anything unsafe (raw log/path/package/version/url/secret/
//     production-readiness claim) from every posture field. Raw logs, command output, file paths, package
//     details, stack traces, and production-readiness claims are never surfaced.
//   - Reads ONLY the known, fixed envelope/item fields — never any other field, never a raw object.
//   - DEV-only: imported only by the DEV-gated Backend Control Plane shell. No-throw: failure ⇒ safe state.

const viteEnv = (import.meta as unknown as { env?: { VITE_IDENTITY_API_BASE?: string } }).env ?? {};

/** Same-origin dev proxy base to the isolated identity API (default `/__identity`). */
const C06_API_BASE = (viteEnv.VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '');

/** The DEV-only C-06 evidence-coverage URL (same-origin via the dev proxy). */
export const C06_QUALITY_GATES_EVIDENCE_READINESS_URL = `${C06_API_BASE}/dev/bcp/quality-gates-evidence-coverage-readiness`;

// Client-side hard allow-list — only the 12 accepted evidence categories may render as valid.
const ALLOWED_EVIDENCE_KEYS = new Set<string>([
  'test_coverage', 'typecheck_posture', 'static_scan_posture', 'transport_verification',
  'frontend_proxy_review', 'browser_evidence_governance', 'independent_review', 'scoped_commit_backup',
  'source_scope_control', 'baseline_freeze', 'regression_coverage', 'non_readiness_statements',
]);

// Closed safe vocabulary for the envelope-level evidenceLabels — a defense-in-depth ALLOW-LIST (strictly
// safer than the generic substring denylist, and avoids over-redacting safe negation labels such as
// `no_customer_facing_exposure`, whose `customer_` substring the denylist would otherwise drop).
const SAFE_EVIDENCE_LABELS = new Set<string>([
  'code_config_only', 'static_contract_only', 'server_owned', 'no_raw_logs', 'no_command_output',
  'no_stack_traces', 'no_file_paths', 'no_package_details', 'no_runtime_diagnostics', 'no_build_internals',
  'no_ci_log_surface', 'no_artifact_surface', 'no_raw_reports', 'no_production_claim', 'production_disabled',
  'read_only', 'no_mutation', 'no_backend_action', 'backend_cp_internal_only', 'no_customer_facing_exposure',
  'no_saas_nav_exposure', 'browser_waived_phase_2_only', 'future_reopen_required', 'regression_required',
  'independent_review_required', 'scoped_backup_required',
]);

export interface SafeC06Item {
  evidenceKey: string;
  evidenceLabel: string;
  ownerSurface: string;
  evidencePurpose: string;
  expectedCoveragePosture: string;
  testCoveragePosture: string;
  typecheckPosture: string;
  staticScanPosture: string;
  transportPosture: string;
  browserEvidencePosture: string;
  regressionPosture: string;
  sourceScopePosture: string;
  productionPosture: string;
  mutationPosture: string;
  dataSourcePosture: string;
  logExposurePosture: string;
  evidenceStatus: string;
}

export interface SafeC06SummaryCounts {
  total: number;
  documented: number;
  codeConfigOnly: number;
  noRawLogs: number;
  noCommandOutput: number;
  noProductionClaim: number;
  internalOnly: number;
  unknown: number;
}

export interface SafeC06EmptyState {
  isEmpty: boolean;
  reason: string;
}

/** Discriminated result. Every non-success kind is a safe, render-ready state (no raw error data). */
export type C06Result =
  | {
      kind: 'success';
      schemaVersion: string;
      sourceMode: string;
      freshness: string;
      generatedAt?: string;
      summaryCounts: SafeC06SummaryCounts;
      items: SafeC06Item[];
      emptyState: SafeC06EmptyState;
      warnings: string[];
      redactionPosture: string;
      logExposurePosture: string;
      productionPosture: string;
      mutationPosture: string;
      dataSourcePosture: string;
      evidenceLabels: string[];
    }
  | { kind: 'feature_disabled' }
  | { kind: 'dev_only' }
  | { kind: 'unauthorized' }
  | { kind: 'parity_blocked' }
  | { kind: 'method_not_allowed' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'unexpected' };

const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// NOTE (deliberate defense-in-depth): the client allow-list intentionally diverges from the server read
// model's; keep both — the server is authoritative and the client only ever sees safe values.
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'postgres', 'mysql', 'mongodb', 'supabase',
  'iu_', 'sk-', 'sk_', 'pk_', 'cus_', 'acct_', 'secret', 'token', 'password', 'apikey', 'api_key',
  'stdout', 'stderr', 'tenant_', 'store_', 'customer_', 'identity_link', 'provider_uid', 'internal_user',
  'permission_', 'entitlement_',
];
// Affirmative production-readiness claims (normalized) — never surfaced even if a payload tries to.
const READINESS_CLAIM_RE = /production\s*ready|ready\s*for\s*(production|customer|release)|customer\s*ready|fully\s*(certified|compliant)|all\s*quality\s*gates\s*passed|complete\s*assurance|production\s*approved|phase\s*[34]\s*ready|no\s*risk|safe\s*to\s*deploy|ready\s*to\s*(ship|release)|ship\s*it|go\s*live|release\s*ready|good\s*to\s*go|deploy\s*to\s*production/i;
const ID_SHAPED_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{7,}|@\d|\b\d+\.\d+\.\d+\b/i;
const DOMAIN_RE = /\b[a-z0-9-]+\.(?:com|net|org|io|co|dev|app|gov|edu|info|biz|cloud|sh|ai)\b/i;
const PATH_RE = /\/|\.(ts|tsx|js|jsx|json|env|key|pem|sql|sh|ya?ml|toml|lock|log|txt|md)\b/i;

/** Returns the value only if it is a safe bounded label; otherwise 'redacted'. Never leaks. */
export function safeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'redacted';
  if (value.trim() === '') return 'redacted';
  if (!SAFE_LABEL_RE.test(value)) return 'redacted';
  if (ID_SHAPED_RE.test(value) || DOMAIN_RE.test(value) || PATH_RE.test(value)) return 'redacted';
  if (READINESS_CLAIM_RE.test(value.replace(/[_\-]+/g, ' '))) return 'redacted';
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return 'redacted';
  return value;
}

/** Returns the evidence category only if it is in the client allow-list; otherwise 'redacted'. */
export function safeCategory(value: unknown): string {
  return typeof value === 'string' && ALLOWED_EVIDENCE_KEYS.has(value) ? value : 'redacted';
}

/** A bounded, non-negative integer count; anything else ⇒ 0. */
export function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0;
}

function safeTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_TS_RE.test(value) ? value : undefined;
}

const safeLabelArray = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map(safeLabel).filter((x) => x !== 'redacted');

/** Map a raw evidence item to a safe item, reading ONLY the known fields (each content-validated). */
function toSafeItem(raw: unknown): SafeC06Item | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    evidenceKey: safeCategory(r.evidenceKey),
    evidenceLabel: safeLabel(r.evidenceLabel),
    ownerSurface: safeLabel(r.ownerSurface),
    evidencePurpose: safeLabel(r.evidencePurpose),
    expectedCoveragePosture: safeLabel(r.expectedCoveragePosture),
    testCoveragePosture: safeLabel(r.testCoveragePosture),
    typecheckPosture: safeLabel(r.typecheckPosture),
    staticScanPosture: safeLabel(r.staticScanPosture),
    transportPosture: safeLabel(r.transportPosture),
    browserEvidencePosture: safeLabel(r.browserEvidencePosture),
    regressionPosture: safeLabel(r.regressionPosture),
    sourceScopePosture: safeLabel(r.sourceScopePosture),
    productionPosture: safeLabel(r.productionPosture),
    mutationPosture: safeLabel(r.mutationPosture),
    dataSourcePosture: safeLabel(r.dataSourcePosture),
    logExposurePosture: safeLabel(r.logExposurePosture),
    evidenceStatus: safeLabel(r.evidenceStatus),
  };
}

/** Pure classification of an HTTP status + parsed body into a safe C-06 result. Version-tolerant. */
export function classifyC06Response(status: number, body: unknown): C06Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    if (typeof b.schemaVersion === 'string') {
      const items = (Array.isArray(b.evidenceItems) ? b.evidenceItems : [])
        .slice(0, 500) // defense-in-depth bound: never render an unbounded list from an unexpected payload
        .map(toSafeItem)
        .filter((i): i is SafeC06Item => i !== null);
      const sc = (b.summaryCounts ?? {}) as Record<string, unknown>;
      const es = (b.emptyState ?? {}) as Record<string, unknown>;
      const fr = (b.freshness ?? {}) as Record<string, unknown>;
      return {
        kind: 'success',
        schemaVersion: safeLabel(b.schemaVersion),
        sourceMode: safeLabel(b.sourceMode),
        freshness: safeLabel(fr.lastSuccessfulReadLabel),
        generatedAt: safeTimestamp(b.generatedAt),
        summaryCounts: {
          total: safeCount(sc.total),
          documented: safeCount(sc.documented),
          codeConfigOnly: safeCount(sc.codeConfigOnly),
          noRawLogs: safeCount(sc.noRawLogs),
          noCommandOutput: safeCount(sc.noCommandOutput),
          noProductionClaim: safeCount(sc.noProductionClaim),
          internalOnly: safeCount(sc.internalOnly),
          unknown: safeCount(sc.unknown),
        },
        items,
        emptyState: { isEmpty: es.isEmpty === true, reason: safeLabel(es.reason) },
        warnings: safeLabelArray(b.warnings),
        redactionPosture: safeLabel(b.redactionPosture),
        logExposurePosture: safeLabel(b.logExposurePosture),
        productionPosture: safeLabel(b.productionPosture),
        mutationPosture: safeLabel(b.mutationPosture),
        dataSourcePosture: safeLabel(b.dataSourcePosture),
        evidenceLabels: (Array.isArray(b.evidenceLabels) ? b.evidenceLabels : []).filter((x): x is string => typeof x === 'string' && SAFE_EVIDENCE_LABELS.has(x)),
      };
    }
    return { kind: 'unexpected' };
  }
  const reason = typeof b.reason === 'string' ? b.reason : '';
  if (status === 404 && reason === 'feature_disabled') return { kind: 'feature_disabled' };
  if (status === 404 && reason === 'dev_only') return { kind: 'dev_only' };
  if (status === 404) return { kind: 'unavailable' };
  if (status === 403) return { kind: 'unauthorized' };
  if (status === 409) return { kind: 'parity_blocked' };
  if (status === 405) return { kind: 'method_not_allowed' };
  if (status >= 500) return { kind: 'error' };
  if (status === 0) return { kind: 'unavailable' };
  return { kind: 'unexpected' };
}

/**
 * Fetch the C-06 quality-gates / evidence-coverage readiness. GET only, no body, no credentials, no
 * identity/authority fields. No-throw: any transport/shape failure maps to a safe state. `deps` injectable.
 */
export async function fetchC06QualityGatesEvidenceReadiness(
  deps: { fetchImpl?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<C06Result> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? C06_QUALITY_GATES_EVIDENCE_READINESS_URL;
  if (!fetchImpl) return { kind: 'unavailable' };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), deps.timeoutMs ?? 4000) : undefined;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET', // GET only — never a mutation
      credentials: 'omit', // no cookies/credentials
      headers: { accept: 'application/json' }, // no Authorization, no client identity
      signal: controller?.signal,
      // NO body, NO query params, NO client UID/email/tenant/store/identity/principal/evidence/env values.
    });
  } catch {
    return { kind: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (json === null && res.status >= 500) return { kind: 'unavailable' };
  return classifyC06Response(res.status, json);
}
