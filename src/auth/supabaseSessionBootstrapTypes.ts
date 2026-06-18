// Phase 1.6 M6 — Dormant dual-provider session bootstrap: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of a future, app-level Supabase SESSION SNAPSHOT that a
// dual-provider bootstrap could read. This file is INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads.
//   - Imports NOTHING.
//   - Imported only by `supabaseSessionBootstrap.ts` and the M6 dormancy diagnostic.
//
// SECURITY (binding): the snapshot is a NON-SECRET, observational view. It NEVER
// contains an access token, refresh token, raw JWT, provider token, authorization
// payload, permissions, subPermissions, role, tenant, or plan. It is NOT used to
// authorize anything. Firebase remains the sole authoritative session source.

/**
 * Why the snapshot is (or is not) populated, in honest default-OFF order:
 *   - 'disabled_not_dev'        → not a Vite DEV build (production is always OFF).
 *   - 'disabled_flag_off'       → DEV, but VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP !== 'true'.
 *   - 'foundation_unavailable'  → bootstrap enabled, but the M5 foundation is
 *                                 disabled / unconfigured / not 'ready' (no client).
 *   - 'no_session'              → foundation ready, but no Supabase session present.
 *   - 'session_present'         → a Supabase session exists (observational only).
 */
export type SupabaseSessionSnapshotStatus =
  | 'disabled_not_dev'
  | 'disabled_flag_off'
  | 'foundation_unavailable'
  | 'no_session'
  | 'session_present';

/**
 * Non-secret, observational snapshot of Supabase session presence. Contains NO
 * token of any kind and NO authorization data. `email` is an OPTIONAL, REDACTED,
 * reference-only identity hint (never a credential) and is null unless a session
 * is present.
 */
export interface SupabaseSessionSnapshot {
  /** True only when DEV build AND the DEV-only bootstrap flag is 'true'. */
  enabled: boolean;
  /** True only when a Supabase session is currently present. */
  hasSession: boolean;
  status: SupabaseSessionSnapshotStatus;
  /** Redacted, reference-only identity hint (e.g. "a***@example.com"); never a secret. */
  email: string | null;
  /** Safe, non-secret status message for diagnostics/UI. Never a secret. */
  message: string;
}
