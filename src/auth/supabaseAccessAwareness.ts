// Phase 1.6 M7 — Dormant, DEV-flag-gated AccessContext Supabase AWARENESS helper
// (Stage-3b groundwork).
//
// WHAT THIS IS: a clean, standalone helper that encapsulates the one-shot,
// cancellation-safe, no-throw lifecycle a FUTURE AccessContext wiring pass (M8) would
// call to OBSERVE Supabase session presence. It goes THROUGH the dormant M6 session
// bootstrap (`./supabaseSessionBootstrap`) — it is the first and only permitted importer
// of that bootstrap.
//
// WHAT THIS IS NOT (binding for M7): it changes NO current behavior. Firebase remains the
// sole active/default/authoritative session source. AccessContext is NOT modified and does
// NOT import this helper. This module is DORMANT:
//   - It is imported by NOTHING active — not AccessContext, Login, AccessGuard, App
//     routing, or src/main.tsx — so the bundler tree-shakes it (and, through it, the
//     bootstrap + foundation) out of production. (Proven by the M7 observational diagnostic.)
//   - It has NO import-time side effects and NO top-level await. An observation runs ONLY
//     when `runAccessContextSupabaseAwarenessObservation()` is explicitly called — and NO
//     call site is added in M7.
//
// SECURITY (binding):
//   - Imports the M6 bootstrap ONLY — NOT `@supabase/supabase-js`, NOT React, NOT Firebase,
//     NOT AccessContext, NOT the M5 foundation directly. The direct SDK import stays
//     confined to the foundation + `src/pilot/**`.
//   - The awareness record is NON-SECRET: it NEVER contains or references an access token,
//     a refresh token, a raw JWT, a provider token, an authorization payload, permissions,
//     subPermissions, role, tenant, or plan.
//   - It NEVER mutates app/session/tenant/role/plan/permission/loading/routing state,
//     imports no React, and touches AccessContext in no way. It NEVER authorizes anything.
//   - It does NOT call the backend session-resolve route, any protected business API, any
//     backend control API, or any database-control API, and reads NO server-derived
//     authorization. It NEVER connects to the database and NEVER logs tokens/session payloads.
//
// FLAG (binding): VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS is DEV-only and default OFF.
// It is intentionally SEPARATE from the foundation flag, the bootstrap flag, the dev pilot's
// flag, and the future server-authz shadow flag. Enablement ALSO requires the M6 bootstrap
// to be enabled. Even when 'true', M7 wires this helper to nothing — the flag only gates a
// FUTURE AccessContext one-shot observer (M8).

import {
  readSupabaseSessionSnapshot,
  isSupabaseSessionBootstrapEnabled,
} from './supabaseSessionBootstrap';
import type { SupabaseSessionSnapshot } from './supabaseSessionBootstrapTypes';
import type {
  AccessAwarenessRecord,
  AccessAwarenessStatus,
  AccessAwarenessRunOptions,
} from './supabaseAccessAwarenessTypes';

const SOURCE = 'supabase_session_bootstrap';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast
// so this helper adds NO new ImportMeta typing error and does not alter the baseline.
// -----------------------------------------------------------------------------

interface AwarenessPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** DEV-only awareness opt-in — must equal the string 'true' to enable. */
  VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): AwarenessPublicEnv {
  return (import.meta as unknown as { env?: AwarenessPublicEnv }).env ?? {};
}

/** True only under a Vite DEV build (never in a production build). */
export function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/** True only when the operator has explicitly opted awareness in. */
export function isAwarenessFlagOn(): boolean {
  return readEnv().VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS === 'true';
}

/**
 * Awareness is ENABLED only when ALL hold:
 *   - we are in a Vite DEV build (production is always OFF), AND
 *   - the explicit awareness opt-in flag is 'true', AND
 *   - the M6 session bootstrap is itself enabled.
 * Default behaviour is OFF.
 */
export function isAccessContextSupabaseAwarenessEnabled(): boolean {
  return isDevBuild() && isAwarenessFlagOn() && isSupabaseSessionBootstrapEnabled();
}

// -----------------------------------------------------------------------------
// Non-secret awareness record builders.
// -----------------------------------------------------------------------------

function record(
  status: AccessAwarenessStatus,
  enabled: boolean,
  cancelled: boolean,
  hasSession: boolean,
  email: string | null,
  message: string,
): AccessAwarenessRecord {
  return { enabled, cancelled, hasSession, status, email, source: SOURCE, message };
}

/** Map the bootstrap's (already non-secret) snapshot onto an awareness record. */
function fromSnapshot(snapshot: SupabaseSessionSnapshot): AccessAwarenessRecord {
  switch (snapshot.status) {
    case 'session_present':
      return record('session_present', true, false, true, snapshot.email,
        'Supabase session present (observational only; Firebase remains authoritative).');
    case 'no_session':
      return record('no_session', true, false, false, null,
        'Awareness enabled; no Supabase session present (Firebase remains authoritative).');
    case 'foundation_unavailable':
      return record('foundation_unavailable', true, false, false, null,
        'Awareness enabled, but the Supabase foundation is not ready.');
    case 'disabled_not_dev':
    case 'disabled_flag_off':
    default:
      return record('disabled', false, false, false, null,
        'Supabase awareness is dormant (disabled).');
  }
}

// -----------------------------------------------------------------------------
// One-shot, cancellation-safe, no-throw observation runner. Reads NOTHING at import;
// observes ONLY when explicitly called. In M7 NOTHING calls this — the helper is dormant.
// -----------------------------------------------------------------------------

/**
 * Perform a SINGLE awareness observation (one-shot — no subscription, no polling). It is
 * cancellation-safe (honors an optional AbortSignal before and after the async read) and
 * no-throw: expected disabled/no-session/error/cancelled conditions all resolve to a
 * NON-SECRET awareness record. It reads `readSupabaseSessionSnapshot()` AT MOST ONCE per
 * call and NEVER mutates any app/session/permission/loading/routing state.
 */
export async function runAccessContextSupabaseAwarenessObservation(
  options: AccessAwarenessRunOptions = {},
): Promise<AccessAwarenessRecord> {
  const { signal } = options;

  if (!isAccessContextSupabaseAwarenessEnabled()) {
    return record('disabled', false, false, false, null,
      'Supabase awareness is dormant: DEV + awareness flag + bootstrap enablement are required.');
  }

  // Cancellation BEFORE the async read.
  if (signal?.aborted) {
    return record('cancelled', true, true, false, null, 'Awareness observation cancelled before read.');
  }

  try {
    const snapshot = await readSupabaseSessionSnapshot();

    // Cancellation AFTER the async read (caller may have torn down meanwhile).
    if (signal?.aborted) {
      return record('cancelled', true, true, false, null, 'Awareness observation cancelled after read.');
    }

    return fromSnapshot(snapshot);
  } catch {
    // No-throw: convert any unexpected error to a safe, non-secret record.
    return record('error', true, false, false, null, 'Awareness observation failed safely (no detail surfaced).');
  }
}
