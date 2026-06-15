// Phase 1.5 M8 — Optional pilot client for the M7 /auth/session/resolve prototype.
//
// Thin, dev-only client for the EXISTING, UNCHANGED M7 backend prototype:
//   POST {IDENTITY_API_BASE}/auth/session/resolve
//
// This is a DIAGNOSTIC validation that the browser can round-trip a Supabase
// access token to the M7 session-resolve endpoint through the existing dev Vite
// proxy. It proves IDENTITY resolution end-to-end; it is NOT app authorization.
//
// CONTRACT (binding — mirrors identityDiagnosticClient.ts discipline):
//   - Sends ONLY `Authorization: Bearer <access token>` + an EXACTLY-empty JSON
//     body (`{}`). The server reads NO body field for authority.
//   - Sends NO user object, user_metadata, role, userType, tenantId, storeId,
//     permissions, subPermissions, internalUserId, provider claims, or any other
//     client-asserted authority field. Identity is proven server-side.
//   - The raw access token is consumed ONLY as the Bearer header value. It is
//     NEVER returned, stored, logged, or rendered by this module or its callers.
//   - Returns ONLY safe, non-secret response fields. `authorization` is always
//     null in this era (server-derived authorization is deferred). A non-200 is
//     surfaced as a DIAGNOSTIC failure, never as an app authorization decision.
//   - NEVER returns/echoes: the access token, refresh token, raw JWT, JWT
//     payload, JWKS, service-role key, database URL, or connection string.
//
// ISOLATION: imported ONLY by src/pilot/SupabaseAuthPilot.tsx (and the optional
// M8 static diagnostic). Imports NO Firebase, AccessContext, AccessGuard, Login,
// App routing, business module, or any server/backend file.

import { IDENTITY_API_BASE } from './pilotEnv';

/**
 * Safe, non-secret view of the M7 `/auth/session/resolve` response. Every field
 * here is display-safe — NO token/JWT/secret field is ever represented.
 */
export interface SessionResolveResult {
  /** True only on an HTTP 200 from the prototype (authenticated app actor). */
  ok: boolean;
  /** HTTP status (0 ⇒ the request never reached the server). */
  status: number;
  requestId?: string;
  /** 'authenticated' | 'token-verified' | 'unauthenticated' (server-honest). */
  authState?: string;
  /** 'allow' | 'deny' | 'deferred'. */
  decision?: string;
  reasonCode?: string;
  sourceOfTruth?: string;
  /** App-owned internal user id — caller MUST redact before display. */
  internalUserId?: string;
  authProvider?: string;
  /** Opaque provider subject — caller MUST redact before display. */
  authProviderUid?: string;
  email?: string;
  displayName?: string | null;
  /** Structured error code from a `{ error: { code } }` body. */
  errorCode?: string;
  /** Structured error message from a `{ error: { message } }` body (safe text). */
  errorMessage?: string;
  /**
   * Server-derived authorization. ALWAYS null in this era — the field is carried
   * explicitly so the UI can state "authorization: null — deferred".
   */
  authorization: null;
  /** Safe, human-readable runtime note for the UI (never contains a token/secret). */
  message?: string;
}

/**
 * Call the M7 session-resolve prototype with a Supabase access token.
 *
 * The `accessToken` is consumed ONLY as the Bearer header value. It is never
 * persisted, logged, or echoed back in the returned object. The request body is
 * an EXACTLY-empty JSON object — no client authority is ever sent.
 */
export async function runSessionResolve(accessToken: string): Promise<SessionResolveResult> {
  const base = IDENTITY_API_BASE.replace(/\/+$/, '');
  const url = `${base}/auth/session/resolve`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The ONLY thing we send as authority: a Bearer token. No claims, no body.
        authorization: `Bearer ${accessToken}`,
      },
      // Exactly an empty object. The server reads NO body field for authority.
      body: '{}',
    });
  } catch {
    // Network/connection failure — most commonly the identity API is not running
    // (`npm run identity:api`) or the dev proxy target is down. Safe generic note.
    return {
      ok: false,
      status: 0,
      authorization: null,
      message:
        'Session resolve API unreachable through the dev proxy. Start `npm run identity:api` with the M7 flags, then retry.',
    };
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }

  const error = (json?.error ?? null) as { code?: string; message?: string } | null;

  // Map the runtime/transport states to safe, actionable notes (mirrors the M3
  // whoami client). These are DIAGNOSTIC runtime issues — never app authorization
  // decisions. No note contains a token, JWT, Supabase URL, anon key, DB URL,
  // service-role key, or any secret.
  const PROXY_UPSTREAM_STATUSES = [500, 502, 503, 504];
  const errorCode = error && typeof error.code === 'string' ? error.code : undefined;
  let message: string | undefined;

  if (res.status === 404 && errorCode === 'FEATURE_DISABLED') {
    // Flags off / feature disabled — actionable enable-flags note.
    message =
      'Session resolve is disabled. Enable ENABLE_SUPABASE_PLATFORM_IDENTITY=true and ' +
      'ENABLE_SESSION_RESOLVE=true on the identity API.';
  } else if (json === null && PROXY_UPSTREAM_STATUSES.includes(res.status)) {
    // Empty/non-JSON upstream failure (the classic "identity API not running":
    // the dev Vite proxy answers 500/502/503/504 with no body).
    message =
      'Session resolve API unreachable through the dev proxy. Start `npm run identity:api` ' +
      'with the M7 flags, then retry. (Diagnostic runtime issue — not app authorization.)';
  } else if (error && typeof error.message === 'string') {
    // Surface the backend's structured, already-safe message (token verification
    // failures / identity resolution failures / unexpected errors).
    message = error.message;
  }

  return {
    ok: res.ok,
    status: res.status,
    requestId: typeof json?.requestId === 'string' ? json.requestId : undefined,
    authState: typeof json?.authState === 'string' ? json.authState : undefined,
    decision: typeof json?.decision === 'string' ? json.decision : undefined,
    reasonCode: typeof json?.reasonCode === 'string' ? json.reasonCode : undefined,
    sourceOfTruth: typeof json?.sourceOfTruth === 'string' ? json.sourceOfTruth : undefined,
    internalUserId: typeof json?.internalUserId === 'string' ? json.internalUserId : undefined,
    authProvider: typeof json?.authProvider === 'string' ? json.authProvider : undefined,
    authProviderUid: typeof json?.authProviderUid === 'string' ? json.authProviderUid : undefined,
    email: typeof json?.email === 'string' ? json.email : undefined,
    displayName: typeof json?.displayName === 'string' ? json.displayName : null,
    errorCode,
    errorMessage: error && typeof error.message === 'string' ? error.message : undefined,
    // Server-derived authorization is ALWAYS null in this era — pinned, never read
    // from the wire as authority.
    authorization: null,
    message,
  };
}
