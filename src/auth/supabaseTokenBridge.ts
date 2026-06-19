// Phase 1.6 M11 — Dormant, DEV-flag-gated Supabase TOKEN BRIDGE (Stage-4 groundwork).
//
// WHAT THIS IS: a clean, standalone helper that yields a Supabase access token to an
// IMMEDIATE-USE callback and nothing else. It goes THROUGH the dormant M5 auth foundation
// (`./supabaseAuthFoundation`) to obtain the browser client, reads the current session's
// access token, and passes it ONLY to the caller's callback for the synchronous duration of
// the call. This is the token-safety foundation a FUTURE route-call shadow (M12) would build on.
//
// WHAT THIS IS NOT (binding for M11): it changes NO current behavior. Firebase remains the
// sole active/default/authoritative session source. This module is DORMANT:
//   - It is imported by NOTHING active — not AccessContext, Login, AccessGuard, App routing,
//     src/main.tsx, or the pilot — so the bundler tree-shakes it (and, through it, the
//     foundation) out of production. (Proven by the M11 dormancy diagnostic + bundle scan.)
//   - It has NO import-time side effects and NO top-level await. A token is read ONLY when
//     `withSupabaseAccessToken()` is explicitly called — and NO call site is added in M11.
//   - It does NOT call the backend session-resolve route, any identity/protected/control API,
//     or make ANY network request itself. (The only network is the foundation client's own
//     session read, if invoked.) Sending the token anywhere is a later, separately-approved stage.
//
// TOKEN SAFETY (binding):
//   - The raw access token is passed ONLY to the immediate-use callback. It is NEVER returned
//     to a storable caller, stored in module scope / React state / a ref / context / provider
//     value, written to localStorage / sessionStorage / IndexedDB / window / globalThis,
//     logged, rendered, serialized, or placed in a URL/query/body.
//   - There is intentionally NO `getAccessToken()` / `getToken()` that returns the raw string.
//     The callback pattern makes accidental storage harder than a plain getter.
//   - The result is NON-SECRET: it carries only the callback's own return value + a status; it
//     NEVER contains the token, a JWT, a refresh token, a provider token, or any authz payload.
//   - Imports the M5 foundation ONLY — NOT `@supabase/supabase-js`, NOT React, NOT Firebase,
//     NOT AccessContext, NOT the M6 bootstrap / M7 helper, NOT the pilot, NOT any server module.
//   - Reads ONLY public VITE_ config indirectly via the foundation; references NO service-role
//     key and NO database URL; never connects to the database.
//
// FLAG (binding): VITE_ENABLE_SUPABASE_TOKEN_BRIDGE is DEV-only and default OFF. It is
// SEPARATE from the foundation/bootstrap/awareness/diagnostic-surface/session-resolve-shadow/
// server-authz-shadow flags. Enablement ALSO requires the M5 foundation to be enabled. Even
// when 'true', M11 wires this helper to nothing — the flag only gates a FUTURE caller.

import {
  getSupabaseAuthFoundation,
  isSupabaseAuthFoundationEnabled,
} from './supabaseAuthFoundation';
import type {
  SupabaseTokenBridgeResult,
  SupabaseTokenBridgeStatus,
  SupabaseTokenBridgeRunOptions,
  SupabaseAccessTokenConsumer,
} from './supabaseTokenBridgeTypes';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast
// so this helper adds NO new ImportMeta typing error and does not alter the baseline.
// -----------------------------------------------------------------------------

interface TokenBridgePublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** DEV-only token-bridge opt-in — must equal the string 'true' to enable. */
  VITE_ENABLE_SUPABASE_TOKEN_BRIDGE?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): TokenBridgePublicEnv {
  return (import.meta as unknown as { env?: TokenBridgePublicEnv }).env ?? {};
}

/** True only under a Vite DEV build (never in a production build). */
export function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/** True only when the operator has explicitly opted the token bridge in. */
export function isTokenBridgeFlagOn(): boolean {
  return readEnv().VITE_ENABLE_SUPABASE_TOKEN_BRIDGE === 'true';
}

/**
 * The token bridge is ENABLED only when ALL hold:
 *   - we are in a Vite DEV build (production is always OFF), AND
 *   - the explicit token-bridge opt-in flag is 'true', AND
 *   - the M5 foundation is itself enabled.
 * Default behaviour is OFF.
 */
export function isSupabaseTokenBridgeEnabled(): boolean {
  return isDevBuild() && isTokenBridgeFlagOn() && isSupabaseAuthFoundationEnabled();
}

// -----------------------------------------------------------------------------
// Minimal STRUCTURAL view of the Supabase client's auth surface. We read ONLY the
// session's access token — deliberately nothing else — so this module never imports
// `@supabase/supabase-js`. (The token is consumed immediately; never retained.)
// -----------------------------------------------------------------------------

interface MinimalSupabaseSession {
  access_token?: string | null;
}
interface MinimalSupabaseAuthClient {
  auth: {
    getSession(): Promise<{ data: { session: MinimalSupabaseSession | null } }>;
  };
}

/** Build a NON-SECRET result. `value` is set only on the success path. */
function build<T>(
  status: SupabaseTokenBridgeStatus,
  ok: boolean,
  enabled: boolean,
  message: string,
  value?: T,
): SupabaseTokenBridgeResult<T> {
  const result: SupabaseTokenBridgeResult<T> = { ok, enabled, status, message };
  if (value !== undefined) result.result = value;
  return result;
}

// -----------------------------------------------------------------------------
// Immediate-use token bridge. Reads NOTHING at import; acquires a token ONLY when
// explicitly called. In M11 NOTHING calls this — the bridge stays dormant.
// -----------------------------------------------------------------------------

/**
 * Acquire the current Supabase access token (via the dormant M5 foundation client) and pass it
 * to `use(token)` for IMMEDIATE use only. No-throw in every branch: expected disabled / not-ready
 * / no-session / no-token / cancelled / callback-error conditions all resolve to a NON-SECRET
 * result. Cancellation-safe (honors an optional AbortSignal before acquisition, after acquisition
 * and before the callback, and after the callback). The raw token is NEVER returned, stored,
 * logged, or surfaced — only the callback's own return value is carried back in `result`.
 */
export async function withSupabaseAccessToken<T>(
  use: SupabaseAccessTokenConsumer<T>,
  options: SupabaseTokenBridgeRunOptions = {},
): Promise<SupabaseTokenBridgeResult<T>> {
  const { signal } = options;

  if (!isSupabaseTokenBridgeEnabled()) {
    return build('disabled', false, false,
      'Supabase token bridge is dormant: DEV + token-bridge flag + foundation enablement are required.');
  }

  // Cancellation BEFORE token acquisition.
  if (signal?.aborted) {
    return build('cancelled', false, true, 'Token bridge cancelled before token acquisition.');
  }

  // Obtain the browser client ONLY through the foundation; never construct one here.
  const handle = getSupabaseAuthFoundation();
  if (handle.state.status !== 'ready' || !handle.client) {
    return build('foundation_unavailable', false, true,
      `Token bridge enabled but the Supabase foundation is not ready (${handle.state.status}).`);
  }

  // Read ONLY the session's access token. Any read failure stays foundation_unavailable
  // (safe, non-secret) — we never surface a token or a raw error.
  let hasSession = false;
  let accessToken: string | null = null;
  try {
    const client = handle.client as MinimalSupabaseAuthClient;
    const res = await client.auth.getSession();
    const session = res?.data?.session ?? null;
    hasSession = session !== null;
    accessToken = session?.access_token ?? null;
  } catch {
    return build('foundation_unavailable', false, true,
      'Token bridge could not read the Supabase session safely (no detail surfaced).');
  }

  // Cancellation AFTER acquisition, BEFORE invoking the callback (caller may have torn down).
  if (signal?.aborted) {
    return build('cancelled', false, true, 'Token bridge cancelled after acquisition (callback not invoked).');
  }
  if (!hasSession) {
    return build('no_session', false, true,
      'Token bridge enabled; no Supabase session present (Firebase remains authoritative).');
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return build('no_token', false, true,
      'Token bridge enabled; a Supabase session exists but no access token was available.');
  }

  // IMMEDIATE USE: hand the token to the callback only. It is never returned or stored.
  let value: T;
  try {
    value = await use(accessToken);
  } catch {
    // No-throw: the caller's callback failed; surface a safe status with NO token detail.
    return build('callback_error', false, true, 'Token bridge callback threw; no token detail surfaced.');
  }

  // Cancellation AFTER the callback: discard the result if the caller was torn down.
  if (signal?.aborted) {
    return build('cancelled', false, true, 'Token bridge cancelled after callback (result discarded).');
  }

  return build('success', true, true,
    'Token bridge invoked the callback with a Supabase access token (token not retained).', value);
}
