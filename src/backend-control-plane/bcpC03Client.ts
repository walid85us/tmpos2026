// Phase 2.0 M12 — DEV-only read-only client + safe view-model for the C-03 UI coverage readiness lens.
//
// Calls the isolated M12 route through the same-origin dev Vite proxy:
//   GET {IDENTITY_API_BASE}/dev/bcp/ui-coverage-readiness
// (the `/__identity` prefix is proxied to the isolated platform-identity API and stripped). Mirrors the
// frozen C-01/C-02 client pattern.
//
// SAFETY (binding):
//   - GET only. NO request body. NO credentials. NO Authorization header. NO query params.
//   - Sends NO client UID/email/tenant/store/customer/identity field and NO principal/entries/mode/
//     sourceMode/schemaVersion — authority and content are server-side only.
//   - Renders ONLY safe bounded LABELS / enums / bounded counts. A defense-in-depth allow-list
//     (`safeLabel`) strips anything that is not a safe label, so a malicious/unexpected payload can never
//     surface a raw id, secret, token, DB URL, email, '@', '://', permission key, or component path.
//   - Reads ONLY the known, fixed envelope/item fields — never any other field, never a raw object.
//   - DEV-only: imported only by the DEV-gated Backend Control Plane shell.
//   - No-throw: every failure (proxy down, API not running, flag off, bad shape) maps to a safe state.

const viteEnv = (import.meta as unknown as { env?: { VITE_IDENTITY_API_BASE?: string } }).env ?? {};

/** Same-origin dev proxy base to the isolated identity API (default `/__identity`). */
const C03_API_BASE = (viteEnv.VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '');

/** The DEV-only C-03 UI coverage readiness URL (same-origin via the dev proxy). */
export const C03_UI_COVERAGE_READINESS_URL = `${C03_API_BASE}/dev/bcp/ui-coverage-readiness`;

export interface SafeC03Item {
  screenKey: string;
  screenLabel: string;
  screenStatus: string;
  coverageClass: string;
  previewCardStatus: string;
  clientStatus: string;
  routeStatus: string;
  dataSourceClass: string;
  devGatePosture: string;
  productionPosture: string;
  readOnlyPosture: string;
  mutationPosture: string;
  exposurePosture: string;
  evidenceStatus: string;
}

export interface SafeC03SummaryCounts {
  total: number;
  implemented: number;
  preview: number;
  placeholder: number;
  deferred: number;
  blocked: number;
  unknown: number;
}

export interface SafeC03EmptyState {
  isEmpty: boolean;
  reason: string;
}

/** Discriminated result. Every non-success kind is a safe, render-ready state (no raw error data). */
export type C03Result =
  | {
      kind: 'success';
      schemaVersion: string;
      sourceMode: string;
      freshness: string;
      generatedAt?: string;
      summaryCounts: SafeC03SummaryCounts;
      items: SafeC03Item[];
      emptyState: SafeC03EmptyState;
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

// A safe bounded label: short, conservative charset, free of '@'/'://'/whitespace tricks.
// NOTE (deliberate defense-in-depth): this client allow-list intentionally DIVERGES from the server
// read model's `safeLabel` (the client's DOMAIN_RE is the stricter trailing-TLD form, and the forbidden
// lists differ — `iu_`/`mysql`/`mongodb` are client-only; `audit_`/`mismatch_`/`eyj` are server-only).
// The server is authoritative and the client only ever sees already-safe values; keep both — do NOT
// "reconcile" them into one, which would weaken a layer. Mirrors the frozen C-02 client.
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
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

/** A bounded, non-negative integer count; anything else ⇒ 0. */
export function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0;
}

function safeTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_TS_RE.test(value) ? value : undefined;
}

const safeLabelArray = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map(safeLabel).filter((x) => x !== 'redacted');

/** Map a raw coverage item to a safe item, reading ONLY known fields (each content-validated). */
function toSafeItem(raw: unknown): SafeC03Item | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    screenKey: safeLabel(r.screenKey),
    screenLabel: safeLabel(r.screenLabel),
    screenStatus: safeLabel(r.screenStatus),
    coverageClass: safeLabel(r.coverageClass),
    previewCardStatus: safeLabel(r.previewCardStatus),
    clientStatus: safeLabel(r.clientStatus),
    routeStatus: safeLabel(r.routeStatus),
    dataSourceClass: safeLabel(r.dataSourceClass),
    devGatePosture: safeLabel(r.devGatePosture),
    productionPosture: safeLabel(r.productionPosture),
    readOnlyPosture: safeLabel(r.readOnlyPosture),
    mutationPosture: safeLabel(r.mutationPosture),
    exposurePosture: safeLabel(r.exposurePosture),
    evidenceStatus: safeLabel(r.evidenceStatus),
  };
}

/** Pure classification of an HTTP status + parsed body into a safe C-03 result. Version-tolerant. */
export function classifyC03Response(status: number, body: unknown): C03Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    if (typeof b.schemaVersion === 'string') {
      const items = (Array.isArray(b.coverageItems) ? b.coverageItems : [])
        .slice(0, 500) // defense-in-depth bound: never render an unbounded list from an unexpected payload
        .map(toSafeItem)
        .filter((i): i is SafeC03Item => i !== null);
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
          implemented: safeCount(sc.implemented),
          preview: safeCount(sc.preview),
          placeholder: safeCount(sc.placeholder),
          deferred: safeCount(sc.deferred),
          blocked: safeCount(sc.blocked),
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
 * Fetch the C-03 UI coverage readiness. GET only, no body, no credentials, no identity/authority fields.
 * No-throw: any transport/shape failure maps to a safe state. `deps` are injectable for tests.
 */
export async function fetchC03UiCoverageReadiness(
  deps: { fetchImpl?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<C03Result> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? C03_UI_COVERAGE_READINESS_URL;
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
      // NO body, NO query params, NO client UID/email/tenant/store/identity/principal/entries fields.
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
  return classifyC03Response(res.status, json);
}
