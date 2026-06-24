// Phase 2.0 M7L — DEV-only read-only client + safe view-model for the C-01 readiness summary.
//
// Calls the EXISTING, UNCHANGED M7K code/config route through the same-origin dev Vite proxy:
//   GET {IDENTITY_API_BASE}/dev/bcp/readiness-summary
// (the `/__identity` prefix is proxied to the isolated platform-identity API on :5002 and stripped;
// no backend CORS change is required — mirrors the accepted Phase 1.5 pilot client pattern).
//
// SAFETY (binding):
//   - GET only. NO request body. NO credentials. NO Authorization header. NO query params.
//   - Sends NO client UID/email/tenant/store/identity field — authority is server-side only.
//   - Renders ONLY safe bounded posture LABELS. A defense-in-depth allow-list (`safeLabel`) strips
//     anything that is not a safe label, so a malicious/unexpected payload can never surface a raw
//     id, internal_user_id, secret, token, DB URL, email, '@', or '://'.
//   - Reads ONLY `category`/`status` from each posture entry — never any other field.
//   - DEV-only: imported only by the DEV-gated Backend Control Plane shell.
//   - No-throw: every failure (proxy down, API not running, flag off, bad shape) maps to a safe state.
//
// TYPING NOTE: the project does not wire `vite/client` types, so `import.meta.env` is read through a
// single narrow cast (mirrors src/backend-control-plane/bcpEnv.ts) so this adds NO new type errors.

const viteEnv = (import.meta as unknown as { env?: { VITE_IDENTITY_API_BASE?: string } }).env ?? {};

/** Same-origin dev proxy base to the isolated identity API (default `/__identity`). */
const C01_API_BASE = (viteEnv.VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '');

/** The DEV-only C-01 readiness-summary URL (same-origin via the dev proxy). */
export const C01_READINESS_URL = `${C01_API_BASE}/dev/bcp/readiness-summary`;

export type Tone = 'healthy' | 'warning' | 'blocked' | 'neutral';

export interface SafeReadinessRow {
  label: string;
  status: string;
  tone: Tone;
}

/** Discriminated result. Every non-success kind is a safe, render-ready state (no raw error data). */
export type C01Result =
  | {
      kind: 'success';
      rows: SafeReadinessRow[];
      sourceMode: string;
      parity: string;
      environment: string;
      generatedAt?: string;
      warnings: string[];
    }
  | { kind: 'feature_disabled' }
  | { kind: 'dev_only' }
  | { kind: 'unauthorized' }
  | { kind: 'parity_blocked' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'unexpected' };

// A safe bounded label: short, conservative charset, free of '@'/'://'/whitespace tricks.
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// Defense-in-depth denylist: substrings that must never render even inside an otherwise
// charset-valid label (e.g. 'service_role_key', 'Bearer eyJ', 'iu_<id>'). Lowercased compare.
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'postgres', 'mysql', 'mongodb',
  'iu_', 'sk-', 'secret', 'token', 'password', 'apikey', 'api_key',
];
// Id-shaped values (UUIDs, long digit runs) are redacted even when charset-valid, so a stray
// identifier can never render as a label.
const ID_SHAPED_RE = /\d{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Returns the value only if it is a safe bounded label; otherwise 'redacted'. Never leaks.
 * NOTE: the charset alone is not the safety guarantee — the boundary is that callers read ONLY the
 * fixed `category`/`status` posture fields (see toSafeReadinessRows) and the M7K backend never
 * places an id/secret there. The denylist + id-shape guard are defense-in-depth on top of that.
 */
export function safeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'redacted';
  if (!SAFE_LABEL_RE.test(value)) return 'redacted';
  if (ID_SHAPED_RE.test(value)) return 'redacted';
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return 'redacted';
  return value;
}

function safeTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_TS_RE.test(value) ? value : undefined;
}

/** Map a safe status label to a display tone. */
export function toneForStatus(status: string): Tone {
  const s = status.toLowerCase();
  if (['ready', 'enabled', 'ok', 'active', 'healthy'].includes(s)) return 'healthy';
  if (['blocked', 'disabled', 'production_disabled'].includes(s)) return 'blocked';
  if (s.includes('warn') || s.includes('defer') || s.includes('unresolved') || s.includes('guard')) return 'warning';
  return 'neutral';
}

/**
 * Map an envelope's posture categories to safe display rows. Reads ONLY `category`/`status`,
 * content-validates each (anything unsafe ⇒ 'redacted'), and ignores every other field — so no
 * raw id/secret/token can ever surface even from a malicious payload.
 */
export function toSafeReadinessRows(body: unknown): SafeReadinessRow[] {
  const data = (body as { data?: unknown })?.data as { categories?: unknown } | null | undefined;
  const categories = data && Array.isArray(data.categories) ? data.categories : [];
  const rows: SafeReadinessRow[] = [];
  for (const c of categories) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    const status = safeLabel(rec.status);
    rows.push({ label: safeLabel(rec.category), status, tone: toneForStatus(status) });
  }
  return rows;
}

/** Pure classification of an HTTP status + parsed body into a safe C-01 result. */
export function classifyC01Response(status: number, body: unknown): C01Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    if (typeof b.schemaVersion === 'string' && 'data' in b) {
      const ac = (b.authorizationContext ?? {}) as Record<string, unknown>;
      const rows = toSafeReadinessRows(b);
      const find = (label: string) => rows.find((r) => r.label === label)?.status ?? 'unknown';
      const warnings = (Array.isArray(b.warnings) ? b.warnings : [])
        .map(safeLabel)
        .filter((w) => w !== 'redacted');
      return {
        kind: 'success',
        rows,
        sourceMode: find('synthetic_live_boundary_posture'),
        parity: find('parity_posture'),
        environment: safeLabel(ac.environment),
        generatedAt: safeTimestamp(b.generatedAt),
        warnings,
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
  if (status >= 500) return { kind: 'error' };
  if (status === 0) return { kind: 'unavailable' };
  return { kind: 'unexpected' };
}

/**
 * Fetch the C-01 readiness summary. GET only, no body, no credentials, no identity fields.
 * No-throw: any transport/shape failure maps to a safe state. `deps` are injectable for tests.
 */
export async function fetchC01Readiness(
  deps: { fetchImpl?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<C01Result> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const url = deps.url ?? C01_READINESS_URL;
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
      // NO body, NO query params, NO client UID/email/tenant/store fields.
    });
  } catch {
    // Proxy down / identity API not running / network / CORS / abort — safe generic state.
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
  // Empty/non-JSON 5xx from the dev proxy is the classic "identity API not running".
  if (json === null && res.status >= 500) return { kind: 'unavailable' };
  return classifyC01Response(res.status, json);
}
