// Phase 1.6 M12 — Dormant, DEV-flag-gated SESSION-RESOLVE SHADOW route-call helper (Stage 4b).
//
// WHAT THIS IS: a clean, standalone helper that — WHEN EXPLICITLY INVOKED BY A FUTURE,
// SEPARATELY-APPROVED CALLER — would call the backend `/auth/session/resolve` route in a
// SHADOW / observational mode, using the M11 token bridge (`withSupabaseAccessToken`) to supply
// the Supabase access token as an `Authorization: Bearer` header and an EXACTLY-empty `{}` body.
// It reads ONLY safe status/shape fields and returns a NON-SECRET status record.
//
// WHAT THIS IS NOT (binding for M12): it changes NO current behavior. Firebase remains the sole
// active/default/authoritative session source. This module is DORMANT:
//   - It is imported by NOTHING active — not AccessContext, Login, AccessGuard, App routing,
//     src/main.tsx, or the pilot — so the bundler tree-shakes it (and, through it, the token
//     bridge + foundation) out of production. (Proven by the M12 dormancy diagnostic + bundle scan.)
//   - It has NO import-time side effects and NO top-level await. The token bridge is invoked, and
//     the route is called, ONLY when `runSessionResolveShadowCheck()` is explicitly called — and
//     NO call site is added in M12. NOTHING invokes this helper in M12.
//   - In M12 the route is NEVER called: there is no active caller and no QA invocation. A LIVE
//     `/auth/session/resolve` call (which, when backend flags are enabled, may upsert a durable
//     identity row, emit advisory audit envelopes, and write durable audit_event rows under the
//     live-authorization gate) requires SEPARATE explicit owner approval + identity/audit guardrails.
//
// TOKEN SAFETY (binding):
//   - The raw access token is obtained ONLY inside the M11 token bridge's immediate-use callback
//     and is used ONLY as the outgoing `Authorization: Bearer <token>` header value. It is NEVER
//     sent in the body, placed in the URL/query, logged, persisted, stored in module scope /
//     React state / a ref / context / provider value / window / globalThis, returned, or included
//     in the status record or any message/error.
//
// RESPONSE SAFETY (binding):
//   - The status record carries ONLY safe shape fields (ok/status/phase/requestId/authState/
//     decision/reasonCode/sourceOfTruth/message). It NEVER reads/returns the raw response body,
//     server-derived `authorization`, permissions/subPermissions/role/tenant/plan, or any identity
//     field (internalUserId/authProvider/authProviderUid/email/displayName/identity). `authorization`
//     comparison is DEFERRED to M13. Messages are PHASE-DERIVED — they never echo server content.
//
// ISOLATION: imports the M11 token bridge + its own types ONLY — NOT `@supabase/supabase-js`,
// NOT React, NOT Firebase, NOT the M5 foundation / M6 bootstrap / M7 awareness directly, NOT
// AccessContext / Login / AccessGuard / App / main, NOT the pilot (no `pilotEnv`, no
// `sessionResolvePilotClient`, no `runSessionResolve`), and NOT any server module. Reads the route
// base from the public `VITE_IDENTITY_API_BASE` via a local narrow cast (default `/__identity`).
//
// FLAG (binding): VITE_ENABLE_SESSION_RESOLVE_SHADOW is DEV-only and default OFF. It is SEPARATE
// from the foundation/bootstrap/awareness/diagnostic-surface/token-bridge/server-authz-shadow
// flags. Enablement ALSO requires the M11 token bridge to be enabled. Even when 'true', M12 wires
// this helper to nothing — the flag only gates a FUTURE caller. No redundant route-helper flag is
// introduced, and the M13 server-authz-shadow flag is deliberately NOT referenced here.

import {
  isSupabaseTokenBridgeEnabled,
  withSupabaseAccessToken,
} from './supabaseTokenBridge';
import type {
  SessionResolveShadowResult,
  SessionResolveShadowPhase,
  SessionResolveShadowRunOptions,
} from './sessionResolveShadowClientTypes';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast so this
// helper adds NO new ImportMeta typing error and does not alter the baseline.
// -----------------------------------------------------------------------------

interface ShadowPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** DEV-only session-resolve-shadow opt-in — must equal the string 'true' to enable. */
  VITE_ENABLE_SESSION_RESOLVE_SHADOW?: string;
  /** Base path/URL for the identity API (default: dev proxy `/__identity`). */
  VITE_IDENTITY_API_BASE?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): ShadowPublicEnv {
  return (import.meta as unknown as { env?: ShadowPublicEnv }).env ?? {};
}

/** True only under a Vite DEV build (never in a production build). */
export function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/** True only when the operator has explicitly opted the session-resolve shadow in. */
export function isSessionResolveShadowFlagOn(): boolean {
  return readEnv().VITE_ENABLE_SESSION_RESOLVE_SHADOW === 'true';
}

/**
 * The session-resolve shadow helper is ENABLED only when ALL hold:
 *   - we are in a Vite DEV build (production is always OFF), AND
 *   - the explicit shadow opt-in flag is 'true', AND
 *   - the M11 token bridge is itself enabled (`isSupabaseTokenBridgeEnabled()`).
 * Default behaviour is OFF. Even when enabled, M12 invokes this from nowhere.
 */
export function isSessionResolveShadowEnabled(): boolean {
  return isDevBuild() && isSessionResolveShadowFlagOn() && isSupabaseTokenBridgeEnabled();
}

// -----------------------------------------------------------------------------
// Route identity + safe, PHASE-DERIVED status notes (never echo server/response content).
// -----------------------------------------------------------------------------

/** The backend route this shadow helper targets. Kept as an explicit, auditable literal. */
const SESSION_RESOLVE_PATH = '/auth/session/resolve';

const PHASE_MESSAGE: Record<SessionResolveShadowPhase, string> = {
  disabled:
    'Session-resolve shadow is dormant: DEV + VITE_ENABLE_SESSION_RESOLVE_SHADOW + token-bridge enablement are required.',
  token_bridge_disabled: 'Session-resolve shadow: the Supabase token bridge/foundation is not ready.',
  no_session: 'Session-resolve shadow: no Supabase session present (Firebase remains authoritative).',
  no_token: 'Session-resolve shadow: a Supabase session exists but no access token was available.',
  cancelled: 'Session-resolve shadow cancelled (no result retained).',
  route_disabled: 'Session-resolve route is disabled (404) — backend session-resolve flags are off.',
  denied: 'Session-resolve route denied the request (401/403).',
  resolved: 'Session-resolve route resolved an authenticated app actor (200).',
  unreachable: 'Session-resolve route unreachable through the dev proxy (network/transport error).',
  server_error: 'Session-resolve route returned a server error (5xx).',
  malformed: 'Session-resolve route returned an unclassifiable / malformed response.',
};

/** Build a NON-SECRET, status-0 result for a short-circuit / bridge-state phase. */
function status0(phase: SessionResolveShadowPhase): SessionResolveShadowResult {
  return { ok: false, status: 0, phase, message: PHASE_MESSAGE[phase] };
}

/** Read a string field from the parsed DTO, or undefined. NEVER reads identity/authorization. */
function pickString(json: Record<string, unknown> | null, key: string): string | undefined {
  const v = json?.[key];
  return typeof v === 'string' ? v : undefined;
}

// -----------------------------------------------------------------------------
// The route call itself — invoked ONLY inside the token bridge's immediate-use callback. The token
// is used ONLY as the Bearer header; the body is EXACTLY `{}`. No-throw in every branch.
// -----------------------------------------------------------------------------

async function callSessionResolveRoute(
  accessToken: string,
  signal?: AbortSignal,
): Promise<SessionResolveShadowResult> {
  const url = `${(readEnv().VITE_IDENTITY_API_BASE || '/__identity').replace(/\/+$/, '')}${SESSION_RESOLVE_PATH}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The ONLY thing we send as authority: a Bearer token. No claims, no body field.
        authorization: `Bearer ${accessToken}`,
      },
      // Exactly an empty object. The server reads NO body field for authority.
      body: '{}',
      signal,
    });
  } catch {
    // Network/transport failure (most commonly the identity API is not running / proxy down).
    return { ok: false, status: 0, phase: 'unreachable', message: PHASE_MESSAGE.unreachable };
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }

  const status = res.status;
  let phase: SessionResolveShadowPhase;
  if (status === 200) phase = json ? 'resolved' : 'malformed';
  else if (status === 404) phase = 'route_disabled';
  else if (status === 401 || status === 403) phase = 'denied';
  else if (status >= 500) phase = 'server_error';
  else phase = 'malformed';

  // Read ONLY safe, non-leaking shape fields. NEVER read internalUserId / authProvider /
  // authProviderUid / email / displayName / identity / authorization from the body.
  return {
    ok: res.ok && phase === 'resolved',
    status,
    phase,
    requestId: pickString(json, 'requestId'),
    authState: pickString(json, 'authState'),
    decision: pickString(json, 'decision'),
    reasonCode: pickString(json, 'reasonCode'),
    sourceOfTruth: pickString(json, 'sourceOfTruth'),
    message: PHASE_MESSAGE[phase],
  };
}

// -----------------------------------------------------------------------------
// Exported lazy helper. Reads NOTHING at import; acquires a token + calls the route ONLY when
// explicitly invoked. In M12 NOTHING calls this — the helper stays dormant. No-throw in every
// branch; cancellation-safe via an optional AbortSignal (forwarded to the bridge AND the fetch).
// -----------------------------------------------------------------------------

/**
 * SHADOW-call `/auth/session/resolve` via the M11 token bridge and classify the response into a
 * NON-SECRET status record. No-throw: disabled / token-bridge-not-ready / no-session / no-token /
 * cancelled / route-disabled (404) / denied (401/403) / unreachable / server-error / malformed all
 * resolve to a safe result. The token is NEVER returned/stored/logged; the response body is NEVER
 * returned/logged/persisted; `authorization` and identity fields are NEVER read.
 *
 * NOTE (binding): M12 adds NO call site. Any live invocation is a future, separately-approved step.
 */
export async function runSessionResolveShadowCheck(
  options: SessionResolveShadowRunOptions = {},
): Promise<SessionResolveShadowResult> {
  const { signal } = options;

  if (!isSessionResolveShadowEnabled()) {
    return status0('disabled');
  }
  if (signal?.aborted) {
    return status0('cancelled');
  }

  // Acquire the token via the M11 bridge and call the route INSIDE the immediate-use callback.
  const bridged = await withSupabaseAccessToken<SessionResolveShadowResult>(
    (accessToken) => callSessionResolveRoute(accessToken, signal),
    { signal },
  );

  switch (bridged.status) {
    case 'success':
      return bridged.result ?? status0('malformed');
    case 'no_session':
      return status0('no_session');
    case 'no_token':
      return status0('no_token');
    case 'cancelled':
      return status0('cancelled');
    case 'callback_error':
      // The fetch callback is itself no-throw, so this is defensive only.
      return status0('malformed');
    case 'foundation_unavailable':
    case 'disabled':
    default:
      return status0('token_bridge_disabled');
  }
}
