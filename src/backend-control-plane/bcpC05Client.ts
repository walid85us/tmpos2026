// Phase 2.0 M17 — DEV-only read-only client + safe view-model for the C-05 feature-flag-posture lens.
//
// Calls the isolated M17 route through the same-origin dev Vite proxy:
//   GET {IDENTITY_API_BASE}/dev/bcp/feature-flag-posture-readiness
// Mirrors the frozen C-01/C-02/C-03/C-04 client pattern.
//
// SAFETY (binding):
//   - GET only. NO request body. NO credentials. NO Authorization header. NO query params.
//   - Sends NO client UID/email/tenant/store/customer/identity field and NO principal/flags/env values/
//     mode/sourceMode/schemaVersion — authority and content are server-side only.
//   - Renders ONLY safe bounded LABELS / enums / bounded counts. flagName/flagKey are validated against a
//     client-side ALLOW-LIST (only the 6 accepted Backend CP feature flags); any other value → 'redacted'.
//     A defense-in-depth `safeLabel` strips anything unsafe from posture fields. NEVER an env VALUE or
//     value-oracle (the server never sends one; the client also reads only the known posture fields).
//   - Reads ONLY the known, fixed envelope/item fields — never any other field, never a raw object.
//   - DEV-only: imported only by the DEV-gated Backend Control Plane shell. No-throw: failure ⇒ safe state.

const viteEnv = (import.meta as unknown as { env?: { VITE_IDENTITY_API_BASE?: string } }).env ?? {};

/** Same-origin dev proxy base to the isolated identity API (default `/__identity`). */
const C05_API_BASE = (viteEnv.VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '');

/** The DEV-only C-05 feature-flag-posture URL (same-origin via the dev proxy). */
export const C05_FEATURE_FLAG_POSTURE_READINESS_URL = `${C05_API_BASE}/dev/bcp/feature-flag-posture-readiness`;

// Client-side hard allow-list — only the 6 accepted Backend CP feature flag names/keys may render as valid.
const ALLOWED_FLAG_NAMES = new Set<string>([
  'ENABLE_BCP_DEV_READONLY_PILOT', 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS',
  'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS', 'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS',
  'VITE_ENABLE_BACKEND_CONTROL_PLANE', 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS',
]);
const ALLOWED_FLAG_KEYS = new Set<string>([
  'c01_readiness_summary_backend_gate', 'c02_registry_readiness_backend_gate',
  'c03_ui_coverage_backend_gate', 'c04_route_exposure_backend_gate',
  'backend_cp_dev_shell_frontend_gate', 'c05_feature_flag_posture_backend_gate',
]);

export interface SafeC05Item {
  flagKey: string;
  flagName: string;
  flagPurpose: string;
  ownerSurface: string;
  defaultPosture: string;
  devGatePosture: string;
  productionPosture: string;
  exposurePosture: string;
  dataSourcePosture: string;
  valueExposurePosture: string;
  mutationPosture: string;
  evidenceStatus: string;
}

export interface SafeC05SummaryCounts {
  total: number;
  devOnly: number;
  productionDisabled: number;
  defaultOff: number;
  valueHidden: number;
  noValueOracle: number;
  internalOnly: number;
  unknown: number;
}

export interface SafeC05EmptyState {
  isEmpty: boolean;
  reason: string;
}

/** Discriminated result. Every non-success kind is a safe, render-ready state (no raw error data). */
export type C05Result =
  | {
      kind: 'success';
      schemaVersion: string;
      sourceMode: string;
      freshness: string;
      generatedAt?: string;
      summaryCounts: SafeC05SummaryCounts;
      items: SafeC05Item[];
      emptyState: SafeC05EmptyState;
      warnings: string[];
      redactionPosture: string;
      productionPosture: string;
      exposurePosture: string;
      mutationPosture: string;
      valueExposurePosture: string;
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
// NOTE (deliberate defense-in-depth): this client allow-list intentionally diverges from the server read
// model's; keep both — the server is authoritative and the client only ever sees safe values.
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'postgres', 'mysql', 'mongodb', 'supabase',
  'iu_', 'sk-', 'sk_', 'pk_', 'cus_', 'acct_', 'secret', 'token', 'password', 'apikey', 'api_key',
  'tenant_', 'store_', 'customer_', 'identity_link', 'provider_uid', 'internal_user',
  'permission_', 'entitlement_',
];
const ID_SHAPED_RE = /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/i;
const DOMAIN_RE = /\.[A-Za-z]{2,}$/;

/** Returns the value only if it is a safe bounded label; otherwise 'redacted'. Never leaks. */
export function safeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'redacted';
  if (value.trim() === '') return 'redacted';
  if (!SAFE_LABEL_RE.test(value)) return 'redacted';
  if (ID_SHAPED_RE.test(value) || DOMAIN_RE.test(value)) return 'redacted';
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return 'redacted';
  return value;
}

/** Returns the flag name/key only if it is in the client allow-list; otherwise 'redacted'. */
export function safeFlag(value: unknown, allowed: Set<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'redacted';
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

/** Map a raw flag item to a safe item, reading ONLY the known posture fields (each content-validated). */
function toSafeItem(raw: unknown): SafeC05Item | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    flagKey: safeFlag(r.flagKey, ALLOWED_FLAG_KEYS),
    flagName: safeFlag(r.flagName, ALLOWED_FLAG_NAMES),
    flagPurpose: safeLabel(r.flagPurpose),
    ownerSurface: safeLabel(r.ownerSurface),
    defaultPosture: safeLabel(r.defaultPosture),
    devGatePosture: safeLabel(r.devGatePosture),
    productionPosture: safeLabel(r.productionPosture),
    exposurePosture: safeLabel(r.exposurePosture),
    dataSourcePosture: safeLabel(r.dataSourcePosture),
    valueExposurePosture: safeLabel(r.valueExposurePosture),
    mutationPosture: safeLabel(r.mutationPosture),
    evidenceStatus: safeLabel(r.evidenceStatus),
  };
}

/** Pure classification of an HTTP status + parsed body into a safe C-05 result. Version-tolerant. */
export function classifyC05Response(status: number, body: unknown): C05Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    if (typeof b.schemaVersion === 'string') {
      const items = (Array.isArray(b.flagItems) ? b.flagItems : [])
        .slice(0, 500) // defense-in-depth bound: never render an unbounded list from an unexpected payload
        .map(toSafeItem)
        .filter((i): i is SafeC05Item => i !== null);
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
          devOnly: safeCount(sc.devOnly),
          productionDisabled: safeCount(sc.productionDisabled),
          defaultOff: safeCount(sc.defaultOff),
          valueHidden: safeCount(sc.valueHidden),
          noValueOracle: safeCount(sc.noValueOracle),
          internalOnly: safeCount(sc.internalOnly),
          unknown: safeCount(sc.unknown),
        },
        items,
        emptyState: { isEmpty: es.isEmpty === true, reason: safeLabel(es.reason) },
        warnings: safeLabelArray(b.warnings),
        redactionPosture: safeLabel(b.redactionPosture),
        productionPosture: safeLabel(b.productionPosture),
        exposurePosture: safeLabel(b.exposurePosture),
        mutationPosture: safeLabel(b.mutationPosture),
        valueExposurePosture: safeLabel(b.valueExposurePosture),
        evidenceLabels: safeLabelArray(b.evidenceLabels),
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
 * Fetch the C-05 feature-flag-posture readiness. GET only, no body, no credentials, no identity/authority
 * fields. No-throw: any transport/shape failure maps to a safe state. `deps` are injectable for tests.
 */
export async function fetchC05FeatureFlagPostureReadiness(
  deps: { fetchImpl?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<C05Result> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? C05_FEATURE_FLAG_POSTURE_READINESS_URL;
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
      // NO body, NO query params, NO client UID/email/tenant/store/identity/principal/flags/env values.
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
  return classifyC05Response(res.status, json);
}
