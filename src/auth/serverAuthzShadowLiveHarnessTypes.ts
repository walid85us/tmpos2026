// Phase 1.6 M15 — Dormant Guarded Live One-Shot HARNESS: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of the dormant harness's NON-SECRET result + run options. This file is
// INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads, no fetch, no
//     import-time execution, no top-level await.
//   - Imports ONE type only: the M14 NON-SECRET feed RESULT (`ServerAuthzShadowFeedResult`), re-used
//     as the harness result's optional `feed` field. That M14 result type is itself non-secret (no
//     token / identity / tenant / store / role / plan / permission-LEVEL / raw authorization DTO /
//     raw response body).
//
// SECURITY (binding): the harness result carries ONLY: a clean boolean, an honest phase, an `armed`
// boolean, an `alreadyRan` boolean, two confirmation BOOLEANS (presence + exact-match — NEVER the
// confirmation phrase value itself), a phase-derived message, and (only on a FUTURE, separately
// owner-approved execution) the M14 non-secret feed result. It NEVER carries — and the harness NEVER
// reads/returns — an access/refresh token, raw JWT, provider token, the raw route response body, the
// raw server-derived authorization DTO, identity fields (internalUserId / authProvider /
// authProviderUid / email / displayName / identity), tenantId / storeId, role values, plan values,
// permission-LEVEL values, or the owner confirmation phrase value.

import type { ServerAuthzShadowFeedResult } from './serverAuthzShadowFeedTypes';

/**
 * Outcome phase of a single (future-invoked) one-shot harness run, in honest default-OFF order:
 *   - 'production_blocked'   → not a Vite DEV build (production is ALWAYS blocked; the harness arms
 *                              only under `import.meta.env.DEV === true`).
 *   - 'feed_not_enabled'     → the upstream M11–M14 feed enablement chain
 *                              (`isServerAuthzShadowFeedEnabled()`) is not satisfied (default OFF).
 *   - 'disabled'             → the dedicated DEV-only arming flag is not exactly 'true' (default OFF).
 *   - 'confirmation_missing' → the owner confirmation env var is absent/empty.
 *   - 'confirmation_mismatch'→ the owner confirmation env var is present but does NOT exactly equal
 *                              the required phrase (the value is NEVER echoed — only this phase).
 *   - 'ready'                → all gates pass; the harness is ARMED. (M15 invokes nothing, so this is
 *                              the resting armed state reported by the gate evaluation.)
 *   - 'already_ran'          → the in-memory one-shot guard already fired in this runtime instance;
 *                              the feed is NOT called again.
 *   - 'cancelled'            → the run was aborted before the feed was called (no result retained).
 *   - 'completed'            → (FUTURE, owner-approved execution only) the armed one-shot invoked the
 *                              M14 feed exactly once; `feed` carries the M14 NON-SECRET result.
 *
 * No phase implies the server-derived authorization is authoritative, enforceable, or a replacement
 * for AccessContext. Firebase remains the sole authoritative session source.
 */
export type ServerAuthzShadowLiveOneShotPhase =
  | 'production_blocked'
  | 'feed_not_enabled'
  | 'disabled'
  | 'confirmation_missing'
  | 'confirmation_mismatch'
  | 'ready'
  | 'already_ran'
  | 'cancelled'
  | 'completed';

/** Options for a single (future-invoked) one-shot run. Cancellation is honored if provided. */
export interface ServerAuthzShadowLiveOneShotRunOptions {
  /** Optional AbortSignal so a future caller can cancel (forwarded to the M14 feed). */
  signal?: AbortSignal;
}

/**
 * Non-secret result of a single one-shot harness run. Carries ONLY:
 *   - `ok`                   : true only when the armed one-shot completed with a clean feed result.
 *   - `phase`                : honest, default-OFF phase (see ServerAuthzShadowLiveOneShotPhase).
 *   - `armed`                : true ONLY when every gate (DEV + feed-enabled + arming flag + exact
 *                              owner confirmation) passed.
 *   - `alreadyRan`           : true when the in-memory one-shot guard had already fired.
 *   - `confirmationPresent`  : true when the owner confirmation env var is present/non-empty. BOOLEAN
 *                              ONLY — never the value.
 *   - `confirmationMatches`  : true when the owner confirmation env var EXACTLY equals the required
 *                              phrase. BOOLEAN ONLY — never the value.
 *   - `message`              : a PHASE-DERIVED status note (never echoes the confirmation value or any
 *                              server/response content).
 *   - `feed`                 : the M14 NON-SECRET feed result on a FUTURE 'completed' run, else null.
 *
 * It NEVER carries a token / access_token / refresh_token / JWT / provider token, the raw response
 * body, the raw authorization DTO, identity (internalUserId / authProvider / authProviderUid / email
 * / displayName / identity), tenantId / storeId, role values, plan values, permission-LEVEL values,
 * or the owner confirmation phrase value.
 */
export interface ServerAuthzShadowLiveOneShotResult {
  ok: boolean;
  phase: ServerAuthzShadowLiveOneShotPhase;
  armed: boolean;
  alreadyRan: boolean;
  confirmationPresent: boolean;
  confirmationMatches: boolean;
  message: string;
  feed: ServerAuthzShadowFeedResult | null;
}
