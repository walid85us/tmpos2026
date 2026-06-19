// Phase 1.6 M14 — Dormant Server-Authz Shadow FEED helper: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of the dormant feed helper's NON-SECRET result. This file is INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads, no fetch, no
//     import-time execution, no top-level await.
//   - Imports ONE type only: the M13 NON-SECRET structural comparison RESULT
//     (`ServerAuthzShadowComparisonResult`), which it re-uses as the feed result's `comparison`
//     field. That M13 result type is itself non-secret (no token / identity / tenant / store /
//     role / plan / permission-LEVEL / raw authorization DTO).
//
// SECURITY (binding): the feed result carries ONLY: a presence/parity-free transport status, a
// phase, a presence boolean, the M13 structural comparison result (or null), and a phase-derived
// message. It NEVER carries — and the feed helper NEVER reads/returns — an access/refresh token,
// raw JWT, provider token, the raw route response body, the raw server-derived `authorization`
// DTO, identity fields (internalUserId / authProvider / authProviderUid / email / displayName /
// identity), tenantId / storeId, role values, plan values, or permission-LEVEL values.

import type { ServerAuthzShadowComparisonResult } from './serverAuthzShadowComparisonTypes';

/**
 * Outcome phase of a single (future-invoked) feed run, in honest default-OFF order:
 *   - 'disabled'                 → not DEV, or one of the four required flags/enablements is off
 *                                  (token-bridge, session-resolve-shadow, server-authz-shadow,
 *                                  server-authz-shadow-FEED). The feed short-circuits (default OFF).
 *   - 'token_bridge_disabled'    → the M11 token bridge/foundation was not ready (no token path).
 *   - 'no_session'               → no Supabase session present (Firebase remains authoritative).
 *   - 'no_token'                 → a session exists, but no access token was available.
 *   - 'cancelled'                → the run was aborted (no result retained).
 *   - 'route_disabled'           → the route returned 404 (backend session-resolve flags off).
 *   - 'denied'                   → the route denied the request (401/403).
 *   - 'unreachable'              → the route was unreachable (network/transport error).
 *   - 'server_error'             → the route returned a server error (5xx).
 *   - 'malformed'                → the route returned an unclassifiable / malformed response.
 *   - 'server_authz_unavailable' → the route resolved (200) but `authorization` was null. The
 *                                  legacy client engine remains authoritative — not deny, not
 *                                  fail-open, not enforceable.
 *   - 'compared'                 → the route resolved (200) with a non-null `authorization`; it was
 *                                  passed transiently to the M13 helper for a STRUCTURAL key-space
 *                                  comparison. COMPARABLE ONLY — never authoritative/enforceable.
 */
export type ServerAuthzShadowFeedPhase =
  | 'disabled'
  | 'token_bridge_disabled'
  | 'no_session'
  | 'no_token'
  | 'cancelled'
  | 'route_disabled'
  | 'denied'
  | 'unreachable'
  | 'server_error'
  | 'malformed'
  | 'server_authz_unavailable'
  | 'compared';

/** Options for a single (future-invoked) feed run. Cancellation is honored if provided. */
export interface ServerAuthzShadowFeedRunOptions {
  /** Optional AbortSignal so a future caller can cancel (forwarded to the bridge AND the fetch). */
  signal?: AbortSignal;
}

/**
 * Non-secret result of a single feed run. Carries ONLY:
 *   - `ok`                 : true only on a clean 200 resolution (route reached + parsed).
 *   - `status`             : the HTTP TRANSPORT status (0 ⇒ the route was never reached). This is
 *                            NOT a route-body field — it is the transport-level status code.
 *   - `phase`              : honest, default-OFF phase (see ServerAuthzShadowFeedPhase).
 *   - `serverAuthzPresent` : true ONLY when the 200 body carried a non-null `authorization`.
 *   - `comparison`         : the M13 NON-SECRET structural comparison result, or null when no
 *                            comparison ran (any non-200 / short-circuit phase).
 *   - `message`            : a PHASE-DERIVED status note (never echoes server/response content).
 *
 * It NEVER carries a token / access_token / refresh_token / JWT / provider token, the raw response
 * body, the raw `authorization` DTO, identity (internalUserId / authProvider / authProviderUid /
 * email / displayName / identity), tenantId / storeId, role values, plan values, or
 * permission-LEVEL values.
 */
export interface ServerAuthzShadowFeedResult {
  ok: boolean;
  status: number;
  phase: ServerAuthzShadowFeedPhase;
  serverAuthzPresent: boolean;
  comparison: ServerAuthzShadowComparisonResult | null;
  message: string;
}
