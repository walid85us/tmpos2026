// Phase 1.6 M12 — Dormant Session-Resolve SHADOW route-call client: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of the dormant shadow client's NON-SECRET status record. This
// file is INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads, no fetch.
//   - Imports NOTHING.
//   - Imported only by `sessionResolveShadowClient.ts` and the M12 dormancy diagnostic.
//
// SECURITY (binding): the status record is NON-SECRET. It NEVER contains or references an
// access token, refresh token, raw JWT, provider token, the raw response body, server-derived
// `authorization`, permissions, subPermissions, role, tenant, plan, OR any identity field
// (`internalUserId`, `authProvider`, `authProviderUid`, `email`, `displayName`, `identity`).
// The raw access token is passed ONLY to the M11 token bridge's immediate-use callback as the
// outgoing `Authorization: Bearer` header value — never returned, stored, logged, or surfaced.

/**
 * Outcome phase of a single (future-invoked) shadow route call, in honest default-OFF order:
 *   - 'disabled'              → not DEV, or the shadow flag / token-bridge enablement is off
 *                               (the helper short-circuits and performs NO fetch).
 *   - 'token_bridge_disabled' → the M11 token bridge/foundation was not ready at call time.
 *   - 'no_session'            → token bridge reports no Supabase session (Firebase authoritative).
 *   - 'no_token'              → a Supabase session exists but no access token was available.
 *   - 'cancelled'            → the run was aborted (before invocation, or during the bridge/fetch).
 *   - 'route_disabled'       → HTTP 404 — backend session-resolve flags are disabled.
 *   - 'denied'               → HTTP 401/403 — the route denied the request.
 *   - 'resolved'             → HTTP 200 with a classifiable DTO — authenticated app actor.
 *   - 'unreachable'          → network/transport error (status 0); the call never reached the server.
 *   - 'server_error'         → HTTP 5xx — the route (or proxy) returned a server error.
 *   - 'malformed'            → unexpected status, non-JSON 200, or an unclassifiable response shape.
 */
export type SessionResolveShadowPhase =
  | 'disabled'
  | 'token_bridge_disabled'
  | 'no_session'
  | 'no_token'
  | 'cancelled'
  | 'route_disabled'
  | 'denied'
  | 'resolved'
  | 'unreachable'
  | 'server_error'
  | 'malformed';

/**
 * Non-secret status record returned by a single dormant shadow route-call run. It carries
 * ONLY safe status/shape fields — NEVER the token, the raw response body, server-derived
 * authorization, or any identity field. `requestId`/`authState`/`decision`/`reasonCode`/
 * `sourceOfTruth` are the server's own safe, non-leaking shape fields (display-safe enums/ids).
 */
export interface SessionResolveShadowResult {
  /** True ONLY on the 'resolved' path (HTTP 200 with a classifiable DTO). */
  ok: boolean;
  /** HTTP status (0 ⇒ the request never reached the server, or the helper short-circuited). */
  status: number;
  phase: SessionResolveShadowPhase;
  /** Server request id (safe correlation id). */
  requestId?: string;
  /** 'authenticated' | 'token-verified' | 'unauthenticated' (server-honest). */
  authState?: string;
  /** 'allow' | 'deny' | 'deferred'. */
  decision?: string;
  /** Stable, non-leaking server reason code. */
  reasonCode?: string;
  /** Server provenance label (e.g. 'supabase_verified_token'). */
  sourceOfTruth?: string;
  /** Safe, non-secret, PHASE-DERIVED status note (never echoes server/response content). */
  message: string;
}

/** Options for a single shadow run. Cancellation is honored (and forwarded) if provided. */
export interface SessionResolveShadowRunOptions {
  /** Optional AbortSignal — forwarded to BOTH the token bridge and the fetch. */
  signal?: AbortSignal;
}
