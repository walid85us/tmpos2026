// Phase 1.6 M14 — Dormant, DEV-flag-gated SERVER-AUTHZ SHADOW FEED helper (Stage 4d, Option C /
// Approach X).
//
// WHAT THIS IS: a clean, standalone helper that — WHEN EXPLICITLY INVOKED BY A FUTURE,
// SEPARATELY-APPROVED CALLER — would build the path from a LIVE server session-resolve response to
// the M13 structural comparison. It would: acquire the Supabase access token via the M11 token
// bridge's immediate-use callback, call the backend `/auth/session/resolve` route in a SHADOW
// (observational) mode (Bearer header + EXACTLY-empty `{}` body), extract ONLY the response's
// server-derived `authorization` object, pass it (or null) TRANSIENTLY into the M13 helper
// (`compareServerAuthzShadow`), and return a NON-SECRET feed/comparison result.
//
// WHAT THIS IS NOT (binding for M14): it changes NO current behavior and reads NOTHING live in M14.
// Firebase remains the sole active/default/authoritative session source. This module is DORMANT:
//   - It is imported by NOTHING active — not AccessContext, Login, AccessGuard, App routing,
//     src/main.tsx, or the pilot — so the bundler tree-shakes it (and, through it, the M11 bridge +
//     foundation and the M13 helper) out of production. (Proven by the M14 feed dormancy diagnostic
//     + the bundle scan.)
//   - It has NO import-time side effects and NO top-level await. The token bridge is invoked, the
//     route is called, and the comparison runs ONLY when `runServerAuthzShadowFeed()` is explicitly
//     called — and NO call site is added in M14. NOTHING invokes this helper in M14.
//   - In M14 the route is NEVER called and NO live `authorization` is read: there is no active caller
//     and no QA invocation. A LIVE `/auth/session/resolve` call (which, when backend flags are
//     enabled, may upsert a durable identity row, emit advisory audit envelopes, and write durable
//     audit_event rows under the live-authorization gate) requires SEPARATE explicit owner approval +
//     identity/audit guardrails (deferred to a future M15-style milestone).
//
// WHY NOT IMPORT M12: the M12 session-resolve shadow client deliberately DISCARDS `authorization`
// (it reads only safe shape fields and never returns the authz payload). To obtain `authorization`
// this helper performs its OWN authorization-extracting route read, mirroring M12's exact token/route
// discipline — and does NOT import or modify M12. (Approach X from the accepted M14 plan.)
//
// TOKEN SAFETY (binding):
//   - The raw access token is obtained ONLY inside the M11 token bridge's immediate-use callback and
//     is used ONLY as the outgoing `Authorization: Bearer <token>` header value. It is NEVER sent in
//     the body, placed in the URL/query, logged, persisted, stored in module scope / React state / a
//     ref / context / provider value / window / globalThis, returned, or included in the result or
//     any message/error.
//
// RESPONSE / AUTHORIZATION SAFETY (binding):
//   - Only the response's `authorization` object is read from the parsed body — NEVER the raw body,
//     identity (internalUserId / authProvider / authProviderUid / email / displayName / identity),
//     `scope`/tenantId/storeId, `roles`, `status`, or `userType`. The `authorization` object is
//     passed TRANSIENTLY to `compareServerAuthzShadow(...)` and is NOT retained, returned, or logged.
//   - The result carries ONLY a transport status, phase, presence boolean, the M13 NON-SECRET
//     structural comparison result (or null), and a phase-derived message. NEVER a token / raw body /
//     raw authorization DTO / identity / tenant / store / role / plan / permission-LEVEL value.
//   - `authorization: null` ⇒ phase 'server_authz_unavailable' (legacy client engine authoritative;
//     NOT deny, NOT fail-open, NOT enforceable). Non-null ⇒ phase 'compared' (COMPARABLE ONLY — NOT
//     authoritative, NOT enforceable, NOT a replacement for AccessContext).
//
// ISOLATION: imports the M11 token bridge + the M13 comparison helper + the M13/own types ONLY —
// NOT the M12 shadow client, NOT `@supabase/supabase-js`, NOT React, NOT Firebase, NOT the M5
// foundation / M6 bootstrap / M7 awareness directly, NOT AccessContext / Login / AccessGuard / App /
// main, NOT the pilot, and NOT any server module. Reads the route base from the public
// `VITE_IDENTITY_API_BASE` via a local narrow cast (default `/__identity`).
//
// FLAG (binding): a FOUR-flag AND-gate, all DEV-only and default OFF. NO single flag implies live
// route/feed behavior:
//   - DEV build, AND
//   - M11 token bridge enabled (VITE_ENABLE_SUPABASE_TOKEN_BRIDGE, via isSupabaseTokenBridgeEnabled),
//   - M12 session-resolve-shadow flag on (VITE_ENABLE_SESSION_RESOLVE_SHADOW, read directly here
//     because M12 is intentionally NOT imported),
//   - M13 server-authz-shadow comparison enabled (VITE_ENABLE_SERVER_AUTHZ_SHADOW, via
//     isServerAuthzShadowEnabled), AND
//   - the NEW dedicated M14 feed flag VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED.
// No other new flag is introduced.

import {
  isSupabaseTokenBridgeEnabled,
  withSupabaseAccessToken,
} from './supabaseTokenBridge';
import {
  isServerAuthzShadowEnabled,
  compareServerAuthzShadow,
} from './serverAuthzShadowComparison';
import type { ServerDerivedAuthorizationLike } from './serverAuthzShadowComparisonTypes';
import type {
  ServerAuthzShadowFeedPhase,
  ServerAuthzShadowFeedResult,
  ServerAuthzShadowFeedRunOptions,
} from './serverAuthzShadowFeedTypes';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast so this helper
// adds NO new ImportMeta typing error and does not alter the baseline. PURE reads only.
// -----------------------------------------------------------------------------

interface FeedPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** M12 route-shadow opt-in (read here because M12 is intentionally NOT imported). */
  VITE_ENABLE_SESSION_RESOLVE_SHADOW?: string;
  /** DEV-only dedicated M14 feed opt-in — must equal the string 'true' to enable. */
  VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED?: string;
  /** Base path/URL for the identity API (default: dev proxy `/__identity`). */
  VITE_IDENTITY_API_BASE?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): FeedPublicEnv {
  return (import.meta as unknown as { env?: FeedPublicEnv }).env ?? {};
}

/** True only under a Vite DEV build (never in a production build). */
export function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/** True only when the M12 route-shadow flag is explicitly on (read directly; M12 not imported). */
function isSessionResolveShadowFlagOn(): boolean {
  return readEnv().VITE_ENABLE_SESSION_RESOLVE_SHADOW === 'true';
}

/** True only when the operator has explicitly opted the M14 feed in. */
function isServerAuthzShadowFeedFlagOn(): boolean {
  return readEnv().VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED === 'true';
}

/**
 * The feed is ENABLED only when ALL FIVE hold (default OFF; no single flag implies route/feed
 * behavior):
 *   - we are in a Vite DEV build (production is always OFF), AND
 *   - the M11 token bridge is enabled (DEV + token-bridge flag + foundation), AND
 *   - the M12 session-resolve-shadow flag is 'true', AND
 *   - the M13 server-authz-shadow comparison is enabled (DEV + comparison flag), AND
 *   - the dedicated M14 feed flag is 'true'.
 * Even when enabled, M14 invokes this from nowhere.
 */
export function isServerAuthzShadowFeedEnabled(): boolean {
  return (
    isDevBuild() &&
    isSupabaseTokenBridgeEnabled() &&
    isSessionResolveShadowFlagOn() &&
    isServerAuthzShadowEnabled() &&
    isServerAuthzShadowFeedFlagOn()
  );
}

// -----------------------------------------------------------------------------
// Route identity + safe, PHASE-DERIVED status notes (never echo server/response content).
// -----------------------------------------------------------------------------

/** The backend route this feed targets. Kept as an explicit, auditable literal. */
const SESSION_RESOLVE_PATH = '/auth/session/resolve';

const PHASE_MESSAGE: Record<ServerAuthzShadowFeedPhase, string> = {
  disabled:
    'Server-authz shadow feed is dormant: DEV + token-bridge + VITE_ENABLE_SESSION_RESOLVE_SHADOW + server-authz-shadow + VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED are all required (default OFF).',
  token_bridge_disabled: 'Server-authz shadow feed: the Supabase token bridge/foundation is not ready.',
  no_session: 'Server-authz shadow feed: no Supabase session present (Firebase remains authoritative).',
  no_token: 'Server-authz shadow feed: a Supabase session exists but no access token was available.',
  cancelled: 'Server-authz shadow feed cancelled (no result retained).',
  route_disabled: 'Server-authz shadow feed: session-resolve route disabled (404) — backend flags off.',
  denied: 'Server-authz shadow feed: session-resolve route denied the request (401/403).',
  unreachable: 'Server-authz shadow feed: session-resolve route unreachable (network/transport error).',
  server_error: 'Server-authz shadow feed: session-resolve route returned a server error (5xx).',
  malformed: 'Server-authz shadow feed: session-resolve route returned an unclassifiable / malformed response.',
  server_authz_unavailable:
    'Server-authz shadow feed: route resolved (200) but authorization is null (server authorization unavailable / not evaluated). The legacy client engine remains authoritative — not deny, not fail-open.',
  compared:
    'Server-authz shadow feed: route resolved (200) with non-null authorization; structural key-space comparison complete (comparable only — not authoritative, not enforceable).',
};

/** Build a NON-SECRET, no-comparison result for a short-circuit / non-200 phase. */
function shortCircuit(phase: ServerAuthzShadowFeedPhase, status = 0): ServerAuthzShadowFeedResult {
  return { ok: false, status, phase, serverAuthzPresent: false, comparison: null, message: PHASE_MESSAGE[phase] };
}

// -----------------------------------------------------------------------------
// The route call + comparison — invoked ONLY inside the token bridge's immediate-use callback. The
// token is used ONLY as the Bearer header; the body is EXACTLY `{}`. ONLY the response's
// `authorization` object is read, and ONLY to pass it transiently into the M13 helper. No-throw in
// every branch.
// -----------------------------------------------------------------------------

async function callRouteAndCompare(
  accessToken: string,
  signal?: AbortSignal,
): Promise<ServerAuthzShadowFeedResult> {
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
    return shortCircuit('unreachable');
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }

  const status = res.status;
  if (status === 404) return shortCircuit('route_disabled', status);
  if (status === 401 || status === 403) return shortCircuit('denied', status);
  if (status >= 500) return shortCircuit('server_error', status);
  if (status !== 200 || !json) return shortCircuit('malformed', status);

  // Read ONLY the `authorization` object from the parsed body. NEVER read the raw body, identity,
  // scope/tenant/store, roles, status, or userType. Non-object/absent ⇒ treat as null (unavailable).
  const rawAuthorization = (json as { authorization?: unknown }).authorization;
  const authorizationInput: ServerDerivedAuthorizationLike | null =
    rawAuthorization && typeof rawAuthorization === 'object'
      ? (rawAuthorization as ServerDerivedAuthorizationLike)
      : null;

  // Compare TRANSIENTLY — the authorization object is not retained beyond this call. M13 reads only
  // permission/subPermission/entitlement KEYS and returns a NON-SECRET structural result.
  const comparison = compareServerAuthzShadow(authorizationInput);
  const serverAuthzPresent = authorizationInput !== null;
  const phase: ServerAuthzShadowFeedPhase = serverAuthzPresent ? 'compared' : 'server_authz_unavailable';

  return {
    ok: true,
    status,
    phase,
    serverAuthzPresent,
    comparison,
    message: PHASE_MESSAGE[phase],
  };
}

// -----------------------------------------------------------------------------
// Exported lazy helper. Reads NOTHING at import; acquires a token + calls the route + runs the
// comparison ONLY when explicitly invoked. In M14 NOTHING calls this — the helper stays dormant.
// No-throw in every branch; cancellation-safe via an optional AbortSignal.
// -----------------------------------------------------------------------------

/**
 * Acquire a Supabase token via the M11 bridge, SHADOW-call `/auth/session/resolve`, extract ONLY the
 * response `authorization` object, pass it transiently to `compareServerAuthzShadow`, and classify
 * into a NON-SECRET feed/comparison result. No-throw: disabled / token-bridge-not-ready / no-session /
 * no-token / cancelled / route-disabled (404) / denied (401/403) / unreachable / server-error /
 * malformed / server-authz-unavailable (200 + null authz) / compared (200 + non-null authz) all
 * resolve to a safe result. The token is NEVER returned/stored/logged; the raw body and raw
 * authorization DTO are NEVER returned/logged/persisted.
 *
 * NOTE (binding): M14 adds NO call site. Any live invocation is a future, separately-approved step.
 */
export async function runServerAuthzShadowFeed(
  options: ServerAuthzShadowFeedRunOptions = {},
): Promise<ServerAuthzShadowFeedResult> {
  const { signal } = options;

  if (!isServerAuthzShadowFeedEnabled()) {
    return shortCircuit('disabled');
  }
  if (signal?.aborted) {
    return shortCircuit('cancelled');
  }

  // Acquire the token via the M11 bridge and call the route INSIDE the immediate-use callback.
  const bridged = await withSupabaseAccessToken<ServerAuthzShadowFeedResult>(
    (accessToken) => callRouteAndCompare(accessToken, signal),
    { signal },
  );

  switch (bridged.status) {
    case 'success':
      return bridged.result ?? shortCircuit('malformed');
    case 'no_session':
      return shortCircuit('no_session');
    case 'no_token':
      return shortCircuit('no_token');
    case 'cancelled':
      return shortCircuit('cancelled');
    case 'callback_error':
      // The route+compare callback is itself no-throw, so this is defensive only.
      return shortCircuit('malformed');
    case 'foundation_unavailable':
    case 'disabled':
    default:
      return shortCircuit('token_bridge_disabled');
  }
}
