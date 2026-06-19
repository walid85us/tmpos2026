// Phase 1.6 M11 — Dormant Supabase TOKEN BRIDGE: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of the dormant token bridge's NON-SECRET result. This file
// is INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads.
//   - Imports NOTHING.
//   - Imported only by `supabaseTokenBridge.ts` and the M11 dormancy diagnostic.
//
// SECURITY (binding): the result is NON-SECRET. It NEVER contains or references an access
// token, refresh token, raw JWT, provider token, authorization payload, permissions,
// subPermissions, role, tenant, or plan. The raw access token is passed ONLY to the
// caller's immediate-use callback (never returned, stored, logged, or surfaced).

/**
 * Outcome of a single token-bridge invocation, in honest default-OFF order:
 *   - 'disabled'               → not DEV, or the token-bridge/foundation flags are not on.
 *   - 'foundation_unavailable' → enabled, but the Supabase foundation is not 'ready'
 *                                (or the session read failed safely).
 *   - 'no_session'             → enabled and ready, but no Supabase session is present.
 *   - 'no_token'               → a session exists, but no access token was available.
 *   - 'cancelled'              → the run was aborted (before/after acquisition or after callback).
 *   - 'callback_error'         → the caller's immediate-use callback threw (made safe; no detail).
 *   - 'success'               → the callback ran with a token (the token is NOT retained).
 */
export type SupabaseTokenBridgeStatus =
  | 'disabled'
  | 'foundation_unavailable'
  | 'no_session'
  | 'no_token'
  | 'cancelled'
  | 'callback_error'
  | 'success';

/**
 * Non-secret result of a single `withSupabaseAccessToken` run. Carries ONLY the callback's
 * own return value (`result`) plus non-secret status — NEVER the token or any session/authz
 * payload. The CALLER owns whatever `T` is; the bridge itself never places a token in it.
 */
export interface SupabaseTokenBridgeResult<T> {
  /** True only on the 'success' path (callback ran to completion, not aborted). */
  ok: boolean;
  /** True when DEV AND the token-bridge flag AND the foundation are enabled. */
  enabled: boolean;
  status: SupabaseTokenBridgeStatus;
  /** The caller callback's return value (success only). Never a token. */
  result?: T;
  /** Safe, non-secret status message for diagnostics/developer inspection. Never a secret. */
  message: string;
}

/** Options for a single token-bridge run. Cancellation is honored if provided. */
export interface SupabaseTokenBridgeRunOptions {
  /** Optional AbortSignal so a caller (e.g. a useEffect cleanup) can cancel. */
  signal?: AbortSignal;
}

/**
 * Immediate-use consumer of the raw access token. The token is valid ONLY for the synchronous
 * duration of this call (and any promise it returns); it MUST NOT be stored, logged, returned,
 * or persisted by the consumer. This callback shape is the only way the bridge yields a token —
 * there is deliberately NO `getAccessToken()` that returns the raw string to a storable caller.
 */
export type SupabaseAccessTokenConsumer<T> = (accessToken: string) => Promise<T> | T;
