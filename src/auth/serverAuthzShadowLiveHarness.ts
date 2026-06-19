// Phase 1.6 M15 — Dormant, DEV-only, owner-confirmation-gated GUARDED LIVE ONE-SHOT HARNESS
// (Option C). It is the SINGLE auditable execution path that — WHEN EXPLICITLY INVOKED BY A FUTURE,
// SEPARATELY OWNER-APPROVED M16 EXECUTION PASS — would invoke the M14 server-authz shadow feed
// (`runServerAuthzShadowFeed`) EXACTLY ONCE and surface ONLY the feed's NON-SECRET result.
//
// WHAT THIS IS NOT (binding for M15): it changes NO current behavior, invokes NOTHING, and reads
// NOTHING live in M15. Firebase remains the sole active / default / authoritative session source.
// This module is DORMANT:
//   - It is imported by NOTHING active — not AccessContext, Login, AccessGuard, App routing,
//     src/main.tsx, or the pilot — so the bundler tree-shakes it (and, through it, the M14 feed +
//     the M11 bridge/foundation + the M13 comparison helper) out of production. (Proven by the M15
//     harness dormancy diagnostic + the bundle scan.)
//   - It has NO import-time side effects and NO top-level await. The feed is invoked ONLY when
//     `runServerAuthzShadowLiveOneShot()` is explicitly called — and NO call site is added in M15.
//     NOTHING invokes this harness in M15.
//   - In M15 the feed is NEVER called, no token is acquired, no route is reached, and no live
//     authorization is read: there is no active caller and no QA invocation. A LIVE feed run (which
//     reaches the backend session-resolve route and, when backend flags are enabled, may upsert a
//     durable identity row, emit advisory audit envelopes, and write a durable audit_event row under
//     the live-authorization gate) requires a SEPARATE explicit owner-approved M16 execution pass
//     with identity/audit guardrails. The harness itself contains NO route literal — it reaches the
//     route ONLY transitively, through the M14 feed.
//
// ISOLATION (binding): imports the M14 feed helper + its own/shared types ONLY — NOT the M11 token
// bridge directly, NOT the M12 shadow client, NOT the M13 comparison helper directly, NOT
// `@supabase/supabase-js`, NOT React, NOT Firebase, NOT the M5 foundation / M6 bootstrap / M7
// awareness, NOT AccessContext / Login / AccessGuard / App / main, NOT the pilot, and NOT any server
// module. It reaches the route ONLY transitively, through the M14 feed, and only on a future call.
//
// TOKEN / RESPONSE / AUTHORIZATION SAFETY (binding, inherited from M14): the harness NEVER reads a
// raw access/refresh token, the raw route response body, the raw server-derived authorization DTO,
// or identity fields. It only forwards an optional AbortSignal to the feed and returns the feed's
// NON-SECRET result. The harness NEVER logs anything (no console), NEVER persists anything, NEVER
// touches window/globalThis/DOM, and NEVER enforces anything.
//
// GATING (binding): a FOUR-condition AND-gate, all DEV-only and default OFF. NO single condition arms
// the harness:
//   - a Vite DEV build (`import.meta.env.DEV === true`; production is ALWAYS blocked), AND
//   - the upstream M11–M14 feed enablement chain is satisfied (`isServerAuthzShadowFeedEnabled()`),
//     AND
//   - the NEW dedicated DEV-only arming flag `VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT === 'true'`, AND
//   - the NEW owner confirmation env `VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT` EXACTLY equals the
//     required phrase. The confirmation value is compared by exact equality and is NEVER printed,
//     logged, returned, or otherwise echoed — only its presence/match BOOLEANS are reported.
// No other new flag is introduced.
//
// ONE-SHOT (binding): an in-memory, module-scoped re-entrancy guard only. NO persisted marker (no
// localStorage / sessionStorage / IndexedDB / cookie / file / DB / window/global). A second armed
// invocation in the same runtime instance returns an 'already_ran' result and does NOT call the feed
// again. No retry loop, no batch mode, no automatic invocation.

import {
  isServerAuthzShadowFeedEnabled,
  runServerAuthzShadowFeed,
} from './serverAuthzShadowFeed';
import type {
  ServerAuthzShadowLiveOneShotPhase,
  ServerAuthzShadowLiveOneShotResult,
  ServerAuthzShadowLiveOneShotRunOptions,
} from './serverAuthzShadowLiveHarnessTypes';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast so this harness
// adds NO new ImportMeta typing error and does not alter the baseline. PURE reads only.
// -----------------------------------------------------------------------------

interface HarnessPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** DEV-only dedicated arming flag — must equal the string 'true' to permit arming. */
  VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT?: string;
  /** Owner confirmation env — must EXACTLY equal CONFIRMATION_PHRASE. Value never echoed. */
  VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): HarnessPublicEnv {
  return (import.meta as unknown as { env?: HarnessPublicEnv }).env ?? {};
}

/**
 * The EXACT owner confirmation phrase. The owner must set
 * `VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT` to this exact value to arm the one-shot. This literal is
 * used ONLY in an equality comparison; it is NEVER returned, logged, or placed in a result/message.
 */
const CONFIRMATION_PHRASE = 'I_APPROVE_M15_ONE_SHOT_SERVER_AUTHZ_SHADOW_FEED_DEV_ONLY';

/** True only under a Vite DEV build (never in a production build). */
function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/** True only when the dedicated arming flag is explicitly the string 'true'. */
function isLiveOneShotFlagOn(): boolean {
  return readEnv().VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT === 'true';
}

/**
 * Confirmation presence/match — BOOLEANS ONLY. The raw confirmation value is read into a local for
 * the equality comparison and is NEVER returned or logged. Callers receive only the two booleans.
 */
function confirmationState(): { present: boolean; matches: boolean } {
  const value = readEnv().VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT ?? '';
  return { present: value.length > 0, matches: value === CONFIRMATION_PHRASE };
}

// -----------------------------------------------------------------------------
// Gate evaluation + safe, PHASE-DERIVED status notes (never echo the confirmation value).
// -----------------------------------------------------------------------------

const PHASE_MESSAGE: Record<ServerAuthzShadowLiveOneShotPhase, string> = {
  production_blocked:
    'Live one-shot harness is BLOCKED: not a DEV build (production is always blocked; arming requires import.meta.env.DEV === true).',
  feed_not_enabled:
    'Live one-shot harness is dormant: the upstream M11–M14 feed enablement chain (isServerAuthzShadowFeedEnabled) is not satisfied (default OFF).',
  disabled:
    'Live one-shot harness is dormant: the dedicated DEV-only arming flag VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT is not set to "true" (default OFF).',
  confirmation_missing:
    'Live one-shot harness is not armed: the owner confirmation env VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT is absent/empty.',
  confirmation_mismatch:
    'Live one-shot harness is not armed: the owner confirmation value did not match the required phrase (value not echoed).',
  ready:
    'Live one-shot harness is ARMED (DEV + feed-enabled + arming flag + exact owner confirmation). M15 invokes nothing; a live run is a separate owner-approved M16 execution pass.',
  already_ran:
    'Live one-shot harness already fired in this runtime instance (in-memory guard) — the feed was NOT called again.',
  cancelled:
    'Live one-shot harness run was cancelled before the feed was called (no result retained).',
  completed:
    'Live one-shot harness invoked the M14 feed exactly once; the NON-SECRET feed result is attached (comparable only — not authoritative, not enforceable).',
};

interface ArmingEvaluation {
  phase: ServerAuthzShadowLiveOneShotPhase;
  armed: boolean;
  confirmationPresent: boolean;
  confirmationMatches: boolean;
}

/**
 * Evaluate every gate in honest default-OFF order and report the resting phase + booleans. PURE: no
 * feed call, no I/O, no side effects. When all gates pass the phase is 'ready' (armed). This is also
 * what `isServerAuthzShadowLiveOneShotArmed()` reports.
 */
function evaluateArming(): ArmingEvaluation {
  const { present, matches } = confirmationState();
  let phase: ServerAuthzShadowLiveOneShotPhase;
  if (!isDevBuild()) {
    phase = 'production_blocked';
  } else if (!isServerAuthzShadowFeedEnabled()) {
    phase = 'feed_not_enabled';
  } else if (!isLiveOneShotFlagOn()) {
    phase = 'disabled';
  } else if (!present) {
    phase = 'confirmation_missing';
  } else if (!matches) {
    phase = 'confirmation_mismatch';
  } else {
    phase = 'ready';
  }
  return { phase, armed: phase === 'ready', confirmationPresent: present, confirmationMatches: matches };
}

/** Build a NON-SECRET result for a non-completed (guard / already-ran / cancelled) phase. */
function buildResult(
  phase: ServerAuthzShadowLiveOneShotPhase,
  evaluation: ArmingEvaluation,
  overrides: Partial<ServerAuthzShadowLiveOneShotResult> = {},
): ServerAuthzShadowLiveOneShotResult {
  return {
    ok: false,
    phase,
    armed: evaluation.armed,
    alreadyRan: false,
    confirmationPresent: evaluation.confirmationPresent,
    confirmationMatches: evaluation.confirmationMatches,
    message: PHASE_MESSAGE[phase],
    feed: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// In-memory one-shot guard (module scope). NOT persisted: no storage / cookie / file / DB / global.
// -----------------------------------------------------------------------------

let hasRun = false;

// -----------------------------------------------------------------------------
// Exported, pure ARMED check — reports whether every gate passes. No feed call, no I/O.
// -----------------------------------------------------------------------------

/**
 * True ONLY when every gate holds: DEV build, the upstream M11–M14 feed enablement chain, the
 * dedicated arming flag === 'true', and the owner confirmation env EXACTLY equals the required
 * phrase. Even when armed, M15 invokes the one-shot from nowhere.
 */
export function isServerAuthzShadowLiveOneShotArmed(): boolean {
  return evaluateArming().armed;
}

// -----------------------------------------------------------------------------
// Exported lazy one-shot. Calls the M14 feed ONLY here, ONLY when armed, ONLY once per runtime
// instance. In M15 NOTHING calls this — the harness stays dormant. No-throw in every branch.
// -----------------------------------------------------------------------------

/**
 * Evaluate the gates; if armed and not already fired and not cancelled, invoke the M14 feed EXACTLY
 * ONCE and return the NON-SECRET harness result (with the M14 feed result attached). Otherwise return
 * a NON-SECRET guard result ('production_blocked' / 'feed_not_enabled' / 'disabled' /
 * 'confirmation_missing' / 'confirmation_mismatch' / 'already_ran' / 'cancelled'). No-throw: the M14
 * feed is itself no-throw. The confirmation value, raw token, raw response body, and raw
 * authorization DTO are NEVER returned/logged/persisted.
 *
 * NOTE (binding): M15 adds NO call site. Any live invocation is a future, separately owner-approved
 * M16 execution step.
 */
export async function runServerAuthzShadowLiveOneShot(
  options: ServerAuthzShadowLiveOneShotRunOptions = {},
): Promise<ServerAuthzShadowLiveOneShotResult> {
  const { signal } = options;
  const evaluation = evaluateArming();

  if (!evaluation.armed) {
    return buildResult(evaluation.phase, evaluation);
  }
  if (hasRun) {
    return buildResult('already_ran', evaluation, { alreadyRan: true });
  }
  if (signal?.aborted) {
    return buildResult('cancelled', evaluation);
  }

  // Latch the in-memory one-shot guard BEFORE awaiting so a concurrent re-entry sees 'already_ran'.
  hasRun = true;

  const feed = await runServerAuthzShadowFeed({ signal });
  return {
    ok: feed.ok,
    phase: 'completed',
    armed: true,
    alreadyRan: false,
    confirmationPresent: evaluation.confirmationPresent,
    confirmationMatches: evaluation.confirmationMatches,
    message: PHASE_MESSAGE.completed,
    feed,
  };
}
