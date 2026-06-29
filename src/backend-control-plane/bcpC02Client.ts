// Phase 2.0 M8F — DEV-only read-only client + safe view-model for the C-02 registry-readiness lens.
//
// Calls the EXISTING, UNCHANGED M8E isolated route through the same-origin dev Vite proxy:
//   GET {IDENTITY_API_BASE}/dev/bcp/registry-readiness
// (the `/__identity` prefix is proxied to the isolated platform-identity API and stripped; no backend
// change is required — mirrors the accepted C-01 client pattern).
//
// SAFETY (binding):
//   - GET only. NO request body. NO credentials. NO Authorization header. NO query params.
//   - Sends NO client UID/email/tenant/store/customer/identity field and NO principal/modules/mode/
//     sourceMode/schemaVersion — authority and content are server-side only.
//   - Renders ONLY safe bounded LABELS / enums / booleans / bounded counts. A defense-in-depth
//     allow-list (`safeLabel`) strips anything that is not a safe label, so a malicious/unexpected
//     payload can never surface a raw id, internal_user_id, secret, token, DB URL, email, '@', or '://'.
//   - Reads ONLY the known, fixed envelope/item fields — never any other field, never a raw object.
//   - DEV-only: imported only by the DEV-gated Backend Control Plane shell.
//   - No-throw: every failure (proxy down, API not running, flag off, bad shape) maps to a safe state.
//
// TYPING NOTE: the project does not wire `vite/client` types, so `import.meta.env` is read through a
// single narrow cast (mirrors bcpC01Client.ts / bcpEnv.ts) so this adds NO new type errors.

const viteEnv = (import.meta as unknown as { env?: { VITE_IDENTITY_API_BASE?: string } }).env ?? {};

/** Same-origin dev proxy base to the isolated identity API (default `/__identity`). */
const C02_API_BASE = (viteEnv.VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '');

/** The DEV-only C-02 registry-readiness URL (same-origin via the dev proxy). */
export const C02_REGISTRY_READINESS_URL = `${C02_API_BASE}/dev/bcp/registry-readiness`;

export interface SafeC02Item {
  moduleKey: string;
  moduleLabel: string;
  moduleStatus: string;
  routeBoundaryCategory: string;
  devGatePosture: string;
  productionPosture: string;
  readOnlyPosture: boolean;
  mutationPosture: string;
  testCoveragePosture: string;
  dtoSchemaPosture: string;
  uiPreviewPosture: string;
  dataSourceClass: string;
  redactionPosture: string;
  rbacVisibilityPosture: string;
  implementationStatus: string;
  evidenceStatus: string;
}

export interface SafeC02SummaryCounts {
  total: number;
  included: number;
  placeholder: number;
  deferred: number;
  blocked: number;
  unknown: number;
}

export interface SafeC02EmptyState {
  isEmpty: boolean;
  reason: string;
}

/** Discriminated result. Every non-success kind is a safe, render-ready state (no raw error data). */
export type C02Result =
  | {
      kind: 'success';
      schemaVersion: string;
      sourceMode: string;
      freshness: string;
      generatedAt?: string;
      summaryCounts: SafeC02SummaryCounts;
      items: SafeC02Item[];
      emptyState: SafeC02EmptyState;
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
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// Defense-in-depth denylist: substrings that must never render even inside a charset-valid label.
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'postgres', 'mysql', 'mongodb', 'supabase',
  'iu_', 'sk-', 'sk_', 'pk_', 'cus_', 'acct_', 'secret', 'token', 'password', 'apikey', 'api_key',
  'tenant_', 'store_', 'customer_', 'identity_link', 'provider_uid', 'internal_user',
];
// Id-shaped values (UUIDs, long digit runs, long hex runs) are redacted even when charset-valid.
// A 16+ char hex run never appears in a legit kebab/snake enum label but does in tokens/hashes/raw ids.
const ID_SHAPED_RE = /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/i;
// Domain/hostname shape (trailing TLD): the C-02 enum labels never end in `.<letters>` (e.g.
// `…v1-code-config`), so this redacts `acme.com` / `db.internal.acme` without hitting real labels.
const DOMAIN_RE = /\.[A-Za-z]{2,}$/;

// Phase 2.0 M24 — closed allow-lists (PRIMARY validation) for the discrete enum fields. Each set is the
// complete accepted server vocabulary (from the frozen C-02 read model), so valid data passes byte-
// equivalently and anything else normalizes to a safe fallback. safeLabel remains the SECONDARY denylist
// defense for the free-text / posture fields (moduleKey/moduleLabel/postures), which keep their behavior.
const SAFE_SOURCE_MODES = new Set<string>(['code_config', 'synthetic']);
const SAFE_FRESHNESS = new Set<string>(['code-config-no-live-read', 'synthetic-no-live-read']);
const SAFE_MODULE_STATUS = new Set<string>(['included', 'placeholder', 'deferred', 'blocked', 'unknown']);
const SAFE_EVIDENCE_LABELS = new Set<string>([
  'code_config_only', 'no_live_source', 'read_only', 'no_mutation', 'production_disabled',
  'dev_only', 'no_external_source', 'route_not_registered', 'ui_not_implemented', 'read_model_only',
]);

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

/** A bounded, non-negative integer count; anything else (negative, float, huge, non-number) ⇒ 0. */
export function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0;
}

function safeBool(value: unknown): boolean {
  return value === true;
}

function safeTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_TS_RE.test(value) ? value : undefined;
}

/** Map a safe status/posture label to a display tone. */
export type Tone = 'healthy' | 'warning' | 'blocked' | 'neutral';
export function toneForStatus(status: string): Tone {
  const s = status.toLowerCase();
  if (['included', 'ready', 'enabled', 'ok', 'active', 'healthy'].includes(s)) return 'healthy';
  if (['blocked', 'disabled', 'production_disabled', 'none'].includes(s)) return 'blocked';
  if (s.includes('warn') || s.includes('defer') || s.includes('placeholder') || s.includes('unknown') || s.includes('pending')) return 'warning';
  return 'neutral';
}

const safeLabelArray = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map(safeLabel).filter((x) => x !== 'redacted');

/** Closed allow-list lookup (PRIMARY). Returns the value only if it is in the accepted set; else `fallback`. */
function safeEnum(value: unknown, allowed: ReadonlySet<string>, fallback = 'redacted'): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}
/** Filter an array to the closed evidence-label allow-list (PRIMARY) — drops anything not accepted. */
const safeEvidenceLabels = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && SAFE_EVIDENCE_LABELS.has(x));

/** Map a raw registry item to a safe item, reading ONLY known fields (each content-validated). */
function toSafeItem(raw: unknown): SafeC02Item | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    moduleKey: safeLabel(r.moduleKey),
    moduleLabel: safeLabel(r.moduleLabel),
    moduleStatus: safeEnum(r.moduleStatus, SAFE_MODULE_STATUS), // M24: closed allow-list (primary)
    routeBoundaryCategory: safeLabel(r.routeBoundaryCategory),
    devGatePosture: safeLabel(r.devGatePosture),
    productionPosture: safeLabel(r.productionPosture),
    readOnlyPosture: safeBool(r.readOnlyPosture),
    mutationPosture: safeLabel(r.mutationPosture),
    testCoveragePosture: safeLabel(r.testCoveragePosture),
    dtoSchemaPosture: safeLabel(r.dtoSchemaPosture),
    uiPreviewPosture: safeLabel(r.uiPreviewPosture),
    dataSourceClass: safeLabel(r.dataSourceClass),
    redactionPosture: safeLabel(r.redactionPosture),
    rbacVisibilityPosture: safeLabel(r.rbacVisibilityPosture),
    implementationStatus: safeLabel(r.implementationStatus),
    evidenceStatus: safeLabel(r.evidenceStatus),
  };
}

/** Pure classification of an HTTP status + parsed body into a safe C-02 result. Version-tolerant. */
export function classifyC02Response(status: number, body: unknown): C02Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    // Version-tolerant: any 200 with a string schemaVersion is parsed defensively (unknown schema safe).
    if (typeof b.schemaVersion === 'string') {
      const items = (Array.isArray(b.registryItems) ? b.registryItems : [])
        .map(toSafeItem)
        .filter((i): i is SafeC02Item => i !== null);
      const sc = (b.summaryCounts ?? {}) as Record<string, unknown>;
      const es = (b.emptyState ?? {}) as Record<string, unknown>;
      const fr = (b.freshness ?? {}) as Record<string, unknown>;
      return {
        kind: 'success',
        schemaVersion: safeLabel(b.schemaVersion), // version-tolerant: NOT allow-listed (future schemas pass)
        sourceMode: safeEnum(b.sourceMode, SAFE_SOURCE_MODES), // M24: closed allow-list (primary)
        freshness: safeEnum(fr.lastSuccessfulReadLabel, SAFE_FRESHNESS), // M24: closed allow-list (primary)
        generatedAt: safeTimestamp(b.generatedAt),
        summaryCounts: {
          total: safeCount(sc.total),
          included: safeCount(sc.included),
          placeholder: safeCount(sc.placeholder),
          deferred: safeCount(sc.deferred),
          blocked: safeCount(sc.blocked),
          unknown: safeCount(sc.unknown),
        },
        items,
        emptyState: { isEmpty: safeBool(es.isEmpty), reason: safeLabel(es.reason) },
        warnings: safeLabelArray(b.warnings),
        redactionPosture: safeLabel(b.redactionPosture),
        routePosture: safeLabel(b.routePosture),
        productionPosture: safeLabel(b.productionPosture),
        mutationPosture: safeLabel(b.mutationPosture),
        evidenceLabels: safeEvidenceLabels(b.evidenceLabels), // M24: closed allow-list (primary)
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
 * Fetch the C-02 registry readiness. GET only, no body, no credentials, no identity/authority fields.
 * No-throw: any transport/shape failure maps to a safe state. `deps` are injectable for tests.
 */
export async function fetchC02RegistryReadiness(
  deps: { fetchImpl?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<C02Result> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? C02_REGISTRY_READINESS_URL;
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
      // NO body, NO query params, NO client UID/email/tenant/store/identity/principal/modules/mode fields.
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
  return classifyC02Response(res.status, json);
}
