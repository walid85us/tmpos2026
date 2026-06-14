// Phase 1.5 M4 — Supabase Auth Frontend Login Pilot.
//
// Thin client for the EXISTING, UNCHANGED M3 backend diagnostic:
//   POST {IDENTITY_API_BASE}/diagnostics/supabase-whoami
//
// CONTRACT (binding):
//   - Sends ONLY `Authorization: Bearer <access token>` + an empty JSON body.
//   - Sends NO user object, role, tenant, store, permission snapshot, or any
//     client-asserted claim of authority. Identity is proven server-side; this
//     call proves IDENTITY, not authorization.
//   - The raw access token is used ONLY as the Bearer header value here. It is
//     never returned, stored, logged, or rendered by this module or its callers.
//   - Returns only safe, non-secret response fields. A non-200 is surfaced as a
//     DIAGNOSTIC failure, never as an app authorization decision.

import { IDENTITY_API_BASE } from './pilotEnv';

export interface WhoamiResult {
  /** True only on an HTTP 200 from the diagnostic. */
  ok: boolean;
  /** HTTP status (0 ⇒ the request never reached the server). */
  status: number;
  requestId?: string;
  authState?: string;
  internalUserId?: string;
  decision?: string;
  reasonCode?: string;
  sourceOfTruth?: string;
  /** Error code from a `{ error: { code } }` body (e.g. FEATURE_DISABLED). */
  errorCode?: string;
  /** Safe, human-readable note for the UI (never contains a token/secret). */
  message?: string;
}

/**
 * Call the verified whoami diagnostic with a Supabase access token.
 *
 * The `accessToken` is consumed ONLY as the Bearer header value. It is never
 * persisted or echoed back in the returned object.
 */
export async function runWhoamiDiagnostic(accessToken: string): Promise<WhoamiResult> {
  const base = IDENTITY_API_BASE.replace(/\/+$/, '');
  const url = `${base}/diagnostics/supabase-whoami`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The ONLY thing we send as authority: a Bearer token. No claims.
        authorization: `Bearer ${accessToken}`,
      },
      body: '{}',
    });
  } catch {
    // Network/connection failure — most commonly the identity API is not running
    // (`npm run identity:api`) or the dev proxy target is down. Safe, generic note.
    return {
      ok: false,
      status: 0,
      message:
        'Could not reach the identity diagnostic API. In dev, ensure `npm run identity:api` is running with the M3 flags enabled.',
    };
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }

  const error = (json?.error ?? null) as { code?: string; message?: string } | null;

  // Surface the backend's structured error message when present. Otherwise, an
  // upstream/proxy failure status with an EMPTY or non-JSON body (the classic
  // "identity API not running" case: the dev Vite proxy answers 500/502/503/504
  // with no body) gets a clear, actionable runtime note. This is a DIAGNOSTIC
  // runtime issue, never an app authorization decision. The note contains no
  // token, JWT, Supabase URL, anon key, DB URL, service-role key, or secret.
  const PROXY_UPSTREAM_STATUSES = [500, 502, 503, 504];
  let message: string | undefined;
  if (error && typeof error.message === 'string') {
    message = error.message;
  } else if (json === null && PROXY_UPSTREAM_STATUSES.includes(res.status)) {
    message =
      'Diagnostic API is unreachable through the dev proxy. Start `npm run identity:api` ' +
      'with the required M3 flags, then retry. (Diagnostic runtime issue — not app authorization.)';
  }

  return {
    ok: res.ok,
    status: res.status,
    requestId: typeof json?.requestId === 'string' ? json.requestId : undefined,
    authState: typeof json?.authState === 'string' ? json.authState : undefined,
    internalUserId: typeof json?.internalUserId === 'string' ? json.internalUserId : undefined,
    decision: typeof json?.decision === 'string' ? json.decision : undefined,
    reasonCode: typeof json?.reasonCode === 'string' ? json.reasonCode : undefined,
    sourceOfTruth: typeof json?.sourceOfTruth === 'string' ? json.sourceOfTruth : undefined,
    errorCode: error && typeof error.code === 'string' ? error.code : undefined,
    message,
  };
}
