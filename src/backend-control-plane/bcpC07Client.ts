// Phase 2.0 M41 — DEV-only read-only client + safe view-model for the C-07 data-source-boundary readiness lens.
//
// Calls the isolated C-07 route through the same-origin dev Vite proxy:
//   GET {IDENTITY_API_BASE}/dev/bcp/data-source-boundary-readiness
// Mirrors the frozen C-01..C-06 client pattern (src/backend-control-plane/bcpC06Client.ts), adapted to the
// C-07 closed-enum vocabulary (mirrored — never imported — from the frozen server-side C-07 read model's
// closed vocabulary; this client imports no server module and names no backend internals).
//
// SAFETY (binding):
//   - GET only. NO request body. NO credentials. NO Authorization header. NO query params.
//   - Sends NO client UID/email/tenant/store/customer/identity field and NO principal/mode/schemaVersion —
//     authority and content are server-side only.
//   - Renders ONLY safe bounded LABELS / closed enums / bounded counts. For EVERY posture field the CLOSED
//     ALLOW-LIST is the PRIMARY gate (a legitimate read-model value such as `no_customer_exposure` contains
//     the denylist substring `customer_`; gating enums by the allow-list — not the substring denylist —
//     avoids over-redacting valid values). The substring denylist (`safeLabel`) is a defense-in-depth
//     SECONDARY check on the two free-text display fields (boundaryLabel/boundaryPurpose) only.
//   - `generatedAt` and every timestamp are PERMANENTLY EXCLUDED for C-07 — the client neither validates nor
//     surfaces any timestamp field (no `safeTimestamp` helper exists here, unlike the C-06 client).
//   - Reads ONLY the known, fixed envelope/item fields — never any other field, never a raw object. Raw logs,
//     command output, file paths, package details, stack traces, DB/Supabase/live-provider detail, env values,
//     value-oracle output, and production-readiness claims are never surfaced.
//   - DEV-only: imported only by the DEV-gated Backend Control Plane shell. No-throw: failure ⇒ safe state.

const viteEnv = (import.meta as unknown as { env?: { VITE_IDENTITY_API_BASE?: string } }).env ?? {};

/** Same-origin dev proxy base to the isolated identity API (default `/__identity`). */
const C07_API_BASE = (viteEnv.VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '');

/** The DEV-only C-07 data-source-boundary readiness URL (same-origin via the dev proxy). */
export const C07_DATA_SOURCE_BOUNDARY_READINESS_URL = `${C07_API_BASE}/dev/bcp/data-source-boundary-readiness`;

// Exact-match contract constants — mirror (never import) the frozen C-07 read model. A 200 body is accepted as
// `success` ONLY when BOTH match exactly; anything else normalizes to the safe `unexpected` state.
const C07_SCHEMA_VERSION = 'bcp.c07.data-source-boundary-readiness.v1-code-config';
const C07_SELF_ATTESTATION = 'design_time_code_config';

// ---------------------------------------------------------------------------
// Closed allow-lists — the PRIMARY gate. Each set mirrors the read model's closed vocabulary EXACTLY and is
// intentionally no wider than the server's; a value outside its set normalizes to the closed member `redacted`
// (never the raw value). M41 invents no field the read model does not emit.
// ---------------------------------------------------------------------------
const SOURCE_MODE_SET = new Set<string>(['code_config', 'synthetic', 'none']);
const BOUNDARY_KEY_SET = new Set<string>([
  'c01_readiness_summary', 'c02_registry_readiness', 'c03_ui_coverage_readiness',
  'c04_route_exposure_readiness', 'c05_feature_flag_posture', 'c06_quality_gates_evidence',
  'boundary_transport_matrix',
]);
const BOUNDARY_LABEL_SET = new Set<string>([
  'C-01 Readiness Summary', 'C-02 Registry Readiness', 'C-03 UI Coverage Readiness',
  'C-04 Route Exposure Readiness', 'C-05 Feature-Flag Posture', 'C-06 Quality-Gates Evidence',
  'Boundary Transport Harness',
]);
const BOUNDARY_PURPOSE_SET = new Set<string>([
  'Readiness summary evidence', 'Registry readiness evidence', 'UI coverage readiness evidence',
  'Route exposure readiness evidence', 'Feature-flag posture evidence', 'Quality-gates evidence',
  'Boundary transport harness evidence', 'Redacted',
]);
const OWNER_SURFACE_SET = new Set<string>(['bcp_evidence_lens', 'bcp_transport_harness', 'redacted']);
const DATA_SOURCE_POSTURE_SET = new Set<string>(['code_config_only', 'synthetic_only', 'not_applicable', 'redacted']);
const ABSENCE_POSTURE_SET = new Set<string>(['asserted_absent_code_config', 'not_applicable', 'redacted']);
const VALUE_ORACLE_POSTURE_SET = new Set<string>(['no_value_oracle', 'not_applicable', 'redacted']);
const PRODUCTION_POSTURE_SET = new Set<string>(['production_disabled', 'not_applicable', 'redacted']);
const MUTATION_POSTURE_SET = new Set<string>(['mutation_blocked', 'not_applicable', 'redacted']);
const CUSTOMER_EXPOSURE_POSTURE_SET = new Set<string>(['no_customer_exposure', 'not_applicable', 'redacted']);
const EVIDENCE_STATUS_SET = new Set<string>(['asserted_within_boundary', 'redacted', 'unknown_redacted']);
const EMPTY_STATE_REASON_SET = new Set<string>(['no_boundary_items', 'no_live_source', 'input_redacted']);
const WARNING_SET = new Set<string>([
  'source_mode_redacted', 'posture_value_redacted', 'boundary_key_redacted',
  'item_count_capped', 'warning_count_capped', 'no_live_source',
]);
const EVIDENCE_LABEL_SET = new Set<string>(['code_config_declared', 'synthetic_fixture', 'none_empty', 'redacted']);
// Envelope-level fixed constants (server emits exactly one value each; `redacted` is the closed fallback).
const FRESHNESS_SET = new Set<string>(['static_code_config', 'redacted']);
const REDACTION_POSTURE_SET = new Set<string>(['enforced', 'redacted']);
const LOG_EXPOSURE_POSTURE_SET = new Set<string>(['no_raw_logs', 'redacted']);

// Caps — mirror the read model (item ceiling 12, warnings 12, labels 4). The client independently bounds so a
// hostile oversize payload can never render an unbounded list.
const MAX_ITEMS = 12;
const MAX_WARNINGS = 12;
const MAX_EVIDENCE_LABELS = 4;

// ---------------------------------------------------------------------------
// Defense-in-depth denylist (SECONDARY) — mirrors the frozen C-06 client, applied ONLY to the two free-text
// display fields (boundaryLabel/boundaryPurpose) after the closed allow-list has already gated them.
// ---------------------------------------------------------------------------
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'postgres', 'mysql', 'mongodb', 'supabase',
  'iu_', 'sk-', 'sk_', 'pk_', 'cus_', 'acct_', 'secret', 'token', 'password', 'apikey', 'api_key',
  'stdout', 'stderr', 'tenant_', 'store_', 'customer_', 'identity_link', 'provider_uid', 'internal_user',
  'permission_', 'entitlement_',
];
const READINESS_CLAIM_RE = /production\s*ready|ready\s*for\s*(production|customer|release)|customer\s*ready|fully\s*(certified|compliant)|all\s*quality\s*gates\s*passed|complete\s*assurance|production\s*approved|phase\s*[34]\s*ready|no\s*risk|safe\s*to\s*deploy|ready\s*to\s*(ship|release)|ship\s*it|go\s*live|release\s*ready|good\s*to\s*go|deploy\s*to\s*production/i;
const ID_SHAPED_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{7,}|@\d|\b\d+\.\d+\.\d+\b/i;
const DOMAIN_RE = /\b[a-z0-9-]+\.(?:com|net|org|io|co|dev|app|gov|edu|info|biz|cloud|sh|ai)\b/i;
const PATH_RE = /\/|\.(ts|tsx|js|jsx|json|env|key|pem|sql|sh|ya?ml|toml|lock|log|txt|md)\b/i;

// ---------------------------------------------------------------------------
// Safe primitives.
// ---------------------------------------------------------------------------
/** PRIMARY gate: return the value only if it is a member of the closed allow-list; otherwise 'redacted'. */
export function safeEnum(value: unknown, allowed: Set<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'redacted';
}

/** A bounded, non-negative integer count; anything else ⇒ 0. */
export function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0;
}

/**
 * SECONDARY defense-in-depth denylist for free-text display labels: returns the value only if it is a safe
 * bounded label carrying no path/domain/id/readiness/secret marker; otherwise 'redacted'. Never leaks.
 */
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

/**
 * Display fields (boundaryLabel/boundaryPurpose): closed allow-list PRIMARY, `safeLabel` denylist SECONDARY.
 * The secondary pass is belt-and-suspenders defense-in-depth — it re-guards if the closed set ever drifts to
 * include an unsafe value; for the current frozen vocabulary it always passes.
 */
function safeDisplay(value: unknown, allowed: Set<string>): string {
  const gated = safeEnum(value, allowed); // PRIMARY: closed allow-list
  return gated === 'redacted' ? 'redacted' : safeLabel(gated); // SECONDARY: denylist defense-in-depth
}

/** Keep only allow-listed members of an array, bounded to `cap`. Bounds the RAW input scan first (a hostile
 *  oversize array is never fully traversed — the server envelope emits <=12), then filters, then caps output. */
const safeEnumArray = (v: unknown, allowed: Set<string>, cap: number): string[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, 1024) // defense-in-depth: cap raw traversal well above any real envelope before filtering
    .filter((x): x is string => typeof x === 'string' && allowed.has(x))
    .slice(0, cap);

// ---------------------------------------------------------------------------
// Safe view-model shapes.
// ---------------------------------------------------------------------------
export interface SafeC07Item {
  boundaryKey: string;
  boundaryLabel: string;
  boundaryPurpose: string;
  ownerSurface: string;
  sourceMode: string;
  dataSourcePosture: string;
  dbPosture: string;
  sqlPosture: string;
  supabasePosture: string;
  liveProviderPosture: string;
  runtimeEnvPosture: string;
  commandOutputPosture: string;
  diagnosticsPosture: string;
  rawEvidencePosture: string;
  valueOraclePosture: string;
  productionPosture: string;
  mutationPosture: string;
  customerExposurePosture: string;
  evidenceStatus: string;
}

export interface SafeC07SummaryCounts {
  total: number;
  codeConfigOnly: number;
  syntheticOnly: number;
  noDb: number;
  noSql: number;
  noSupabase: number;
  noLiveProvider: number;
  noRuntimeEnvValues: number;
  noRawDiagnostics: number;
  noCommandOutput: number;
  productionDisabled: number;
  readOnly: number;
  mutationBlocked: number;
  valueOracleBlocked: number;
  customerExposureBlocked: number;
  unknownRedacted: number;
}

/** Discriminated result. Every non-success kind is a safe, render-ready state (no raw error data). NOTE: no
 *  `generatedAt`/timestamp field exists on `success` — C-07 permanently excludes it. */
export type C07Result =
  | {
      kind: 'success';
      schemaVersion: string;
      selfAttestation: string;
      sourceMode: string;
      freshness: string;
      summaryCounts: SafeC07SummaryCounts;
      items: SafeC07Item[];
      emptyState: boolean;
      emptyStateReason: string;
      warnings: string[];
      redactionPosture: string;
      productionPosture: string;
      mutationPosture: string;
      dataSourcePosture: string;
      logExposurePosture: string;
      valueOraclePosture: string;
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

/** Map a raw boundary item to a safe item, reading ONLY the 19 known fields (each closed-set gated). */
function toSafeItem(raw: unknown): SafeC07Item | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    boundaryKey: safeEnum(r.boundaryKey, BOUNDARY_KEY_SET),
    boundaryLabel: safeDisplay(r.boundaryLabel, BOUNDARY_LABEL_SET),
    boundaryPurpose: safeDisplay(r.boundaryPurpose, BOUNDARY_PURPOSE_SET),
    ownerSurface: safeEnum(r.ownerSurface, OWNER_SURFACE_SET),
    sourceMode: safeEnum(r.sourceMode, SOURCE_MODE_SET),
    dataSourcePosture: safeEnum(r.dataSourcePosture, DATA_SOURCE_POSTURE_SET),
    dbPosture: safeEnum(r.dbPosture, ABSENCE_POSTURE_SET),
    sqlPosture: safeEnum(r.sqlPosture, ABSENCE_POSTURE_SET),
    supabasePosture: safeEnum(r.supabasePosture, ABSENCE_POSTURE_SET),
    liveProviderPosture: safeEnum(r.liveProviderPosture, ABSENCE_POSTURE_SET),
    runtimeEnvPosture: safeEnum(r.runtimeEnvPosture, ABSENCE_POSTURE_SET),
    commandOutputPosture: safeEnum(r.commandOutputPosture, ABSENCE_POSTURE_SET),
    diagnosticsPosture: safeEnum(r.diagnosticsPosture, ABSENCE_POSTURE_SET),
    rawEvidencePosture: safeEnum(r.rawEvidencePosture, ABSENCE_POSTURE_SET),
    valueOraclePosture: safeEnum(r.valueOraclePosture, VALUE_ORACLE_POSTURE_SET),
    productionPosture: safeEnum(r.productionPosture, PRODUCTION_POSTURE_SET),
    mutationPosture: safeEnum(r.mutationPosture, MUTATION_POSTURE_SET),
    customerExposurePosture: safeEnum(r.customerExposurePosture, CUSTOMER_EXPOSURE_POSTURE_SET),
    evidenceStatus: safeEnum(r.evidenceStatus, EVIDENCE_STATUS_SET),
  };
}

/** Pure classification of an HTTP status + parsed body into a safe C-07 result. */
export function classifyC07Response(status: number, body: unknown): C07Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    // Success gate: BOTH the schema and the self-attestation must match exactly; anything else ⇒ unexpected.
    if (b.schemaVersion === C07_SCHEMA_VERSION && b.selfAttestation === C07_SELF_ATTESTATION) {
      const items = (Array.isArray(b.boundaryItems) ? b.boundaryItems : [])
        .slice(0, MAX_ITEMS) // defense-in-depth bound: never render an unbounded list from an unexpected payload
        .map(toSafeItem)
        .filter((i): i is SafeC07Item => i !== null);
      const sc = (b.summaryCounts ?? {}) as Record<string, unknown>;
      return {
        kind: 'success',
        schemaVersion: C07_SCHEMA_VERSION,
        selfAttestation: C07_SELF_ATTESTATION,
        sourceMode: safeEnum(b.sourceMode, SOURCE_MODE_SET),
        freshness: safeEnum(b.freshness, FRESHNESS_SET),
        summaryCounts: {
          total: safeCount(sc.total),
          codeConfigOnly: safeCount(sc.codeConfigOnly),
          syntheticOnly: safeCount(sc.syntheticOnly),
          noDb: safeCount(sc.noDb),
          noSql: safeCount(sc.noSql),
          noSupabase: safeCount(sc.noSupabase),
          noLiveProvider: safeCount(sc.noLiveProvider),
          noRuntimeEnvValues: safeCount(sc.noRuntimeEnvValues),
          noRawDiagnostics: safeCount(sc.noRawDiagnostics),
          noCommandOutput: safeCount(sc.noCommandOutput),
          productionDisabled: safeCount(sc.productionDisabled),
          readOnly: safeCount(sc.readOnly),
          mutationBlocked: safeCount(sc.mutationBlocked),
          valueOracleBlocked: safeCount(sc.valueOracleBlocked),
          customerExposureBlocked: safeCount(sc.customerExposureBlocked),
          unknownRedacted: safeCount(sc.unknownRedacted),
        },
        items,
        emptyState: b.emptyState === true,
        emptyStateReason: safeEnum(b.emptyStateReason, EMPTY_STATE_REASON_SET),
        warnings: safeEnumArray(b.warnings, WARNING_SET, MAX_WARNINGS),
        redactionPosture: safeEnum(b.redactionPosture, REDACTION_POSTURE_SET),
        productionPosture: safeEnum(b.productionPosture, PRODUCTION_POSTURE_SET),
        mutationPosture: safeEnum(b.mutationPosture, MUTATION_POSTURE_SET),
        dataSourcePosture: safeEnum(b.dataSourcePosture, DATA_SOURCE_POSTURE_SET),
        logExposurePosture: safeEnum(b.logExposurePosture, LOG_EXPOSURE_POSTURE_SET),
        valueOraclePosture: safeEnum(b.valueOraclePosture, VALUE_ORACLE_POSTURE_SET),
        evidenceLabels: safeEnumArray(b.evidenceLabels, EVIDENCE_LABEL_SET, MAX_EVIDENCE_LABELS),
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
 * Fetch the C-07 data-source-boundary readiness. GET only, no body, no credentials, no identity/authority
 * fields. No-throw: any transport/shape failure maps to a safe state. `deps` injectable for tests.
 */
export async function fetchC07DataSourceBoundaryReadiness(
  deps: { fetchImpl?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<C07Result> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? C07_DATA_SOURCE_BOUNDARY_READINESS_URL;
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
      // NO body, NO query params, NO client UID/email/tenant/store/identity/principal/env values.
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
  return classifyC07Response(res.status, json);
}
