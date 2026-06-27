// Phase 2.0 M14 — DEV-only read-only client + safe view-model for the C-04 route-exposure lens.
//
// Calls the isolated M14 route through the same-origin dev Vite proxy:
//   GET {IDENTITY_API_BASE}/dev/bcp/route-exposure-readiness
// Mirrors the frozen C-01/C-02/C-03 client pattern.
//
// SAFETY (binding):
//   - GET only. NO request body. NO credentials. NO Authorization header. NO query params.
//   - Sends NO client UID/email/tenant/store/customer/identity field and NO principal/entries/routes/
//     mode/sourceMode/schemaVersion — authority and content are server-side only.
//   - Renders ONLY safe bounded LABELS / enums / bounded counts. Route-path fields are validated against
//     a client-side ALLOW-LIST (only the 4 accepted Backend CP DEV routes); any other path → 'redacted'.
//     A defense-in-depth `safeLabel` strips anything unsafe from non-path fields.
//   - Reads ONLY the known, fixed envelope/item fields — never any other field, never a raw object.
//   - DEV-only: imported only by the DEV-gated Backend Control Plane shell.
//   - No-throw: every failure maps to a safe state.

const viteEnv = (import.meta as unknown as { env?: { VITE_IDENTITY_API_BASE?: string } }).env ?? {};

/** Same-origin dev proxy base to the isolated identity API (default `/__identity`). */
const C04_API_BASE = (viteEnv.VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '');

/** The DEV-only C-04 route-exposure URL (same-origin via the dev proxy). */
export const C04_ROUTE_EXPOSURE_READINESS_URL = `${C04_API_BASE}/dev/bcp/route-exposure-readiness`;

// Client-side hard allow-list — only the 4 accepted Backend CP DEV routes may render as valid paths.
const ALLOWED_BACKEND_ROUTES = new Set<string>([
  '/dev/bcp/readiness-summary', '/dev/bcp/registry-readiness',
  '/dev/bcp/ui-coverage-readiness', '/dev/bcp/route-exposure-readiness',
]);
const ALLOWED_PROXY_ROUTES = new Set<string>([
  '/__identity/dev/bcp/readiness-summary', '/__identity/dev/bcp/registry-readiness',
  '/__identity/dev/bcp/ui-coverage-readiness', '/__identity/dev/bcp/route-exposure-readiness',
]);

export interface SafeC04Item {
  routeKey: string;
  routeLabel: string;
  backendRoutePath: string;
  frontendProxyPath: string;
  featureFlag: string;
  methodPosture: string;
  exposurePosture: string;
  productionPosture: string;
  readOnlyPosture: string;
  mutationPosture: string;
  dataSourcePosture: string;
  registrationPosture: string;
  authorityPosture: string;
  evidenceStatus: string;
}

export interface SafeC04SummaryCounts {
  total: number;
  devOnly: number;
  productionDisabled: number;
  readOnly: number;
  mutationBlocked: number;
  internalOnly: number;
  unknown: number;
}

export interface SafeC04EmptyState {
  isEmpty: boolean;
  reason: string;
}

/** Discriminated result. Every non-success kind is a safe, render-ready state (no raw error data). */
export type C04Result =
  | {
      kind: 'success';
      schemaVersion: string;
      sourceMode: string;
      freshness: string;
      generatedAt?: string;
      summaryCounts: SafeC04SummaryCounts;
      items: SafeC04Item[];
      emptyState: SafeC04EmptyState;
      warnings: string[];
      redactionPosture: string;
      routePosture: string;
      productionPosture: string;
      mutationPosture: string;
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
// NOTE (deliberate defense-in-depth): this client allow-list intentionally diverges from the server
// read model's; keep both — the server is authoritative and the client only ever sees safe values.
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

/** Returns the route path only if it is in the client allow-list; otherwise 'redacted'. */
export function safeRoutePath(value: unknown, allowed: Set<string>): string {
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

/** Map a raw route item to a safe item, reading ONLY known fields (each content-validated). */
function toSafeItem(raw: unknown): SafeC04Item | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    routeKey: safeLabel(r.routeKey),
    routeLabel: safeLabel(r.routeLabel),
    backendRoutePath: safeRoutePath(r.backendRoutePath, ALLOWED_BACKEND_ROUTES),
    frontendProxyPath: safeRoutePath(r.frontendProxyPath, ALLOWED_PROXY_ROUTES),
    featureFlag: safeLabel(r.featureFlag),
    methodPosture: safeLabel(r.methodPosture),
    exposurePosture: safeLabel(r.exposurePosture),
    productionPosture: safeLabel(r.productionPosture),
    readOnlyPosture: safeLabel(r.readOnlyPosture),
    mutationPosture: safeLabel(r.mutationPosture),
    dataSourcePosture: safeLabel(r.dataSourcePosture),
    registrationPosture: safeLabel(r.registrationPosture),
    authorityPosture: safeLabel(r.authorityPosture),
    evidenceStatus: safeLabel(r.evidenceStatus),
  };
}

/** Pure classification of an HTTP status + parsed body into a safe C-04 result. Version-tolerant. */
export function classifyC04Response(status: number, body: unknown): C04Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    if (typeof b.schemaVersion === 'string') {
      const items = (Array.isArray(b.routeItems) ? b.routeItems : [])
        .slice(0, 500) // defense-in-depth bound: never render an unbounded list from an unexpected payload
        .map(toSafeItem)
        .filter((i): i is SafeC04Item => i !== null);
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
          readOnly: safeCount(sc.readOnly),
          mutationBlocked: safeCount(sc.mutationBlocked),
          internalOnly: safeCount(sc.internalOnly),
          unknown: safeCount(sc.unknown),
        },
        items,
        emptyState: { isEmpty: es.isEmpty === true, reason: safeLabel(es.reason) },
        warnings: safeLabelArray(b.warnings),
        redactionPosture: safeLabel(b.redactionPosture),
        routePosture: safeLabel(b.routePosture),
        productionPosture: safeLabel(b.productionPosture),
        mutationPosture: safeLabel(b.mutationPosture),
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
 * Fetch the C-04 route-exposure readiness. GET only, no body, no credentials, no identity/authority
 * fields. No-throw: any transport/shape failure maps to a safe state. `deps` are injectable for tests.
 */
export async function fetchC04RouteExposureReadiness(
  deps: { fetchImpl?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<C04Result> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? C04_ROUTE_EXPOSURE_READINESS_URL;
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
      // NO body, NO query params, NO client UID/email/tenant/store/identity/principal/entries/routes.
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
  return classifyC04Response(res.status, json);
}
