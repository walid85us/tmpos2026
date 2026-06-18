// Phase 1.6 M7 — Dormant AccessContext Supabase awareness helper: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of a future, NON-SECRET, observational "awareness record"
// that a later AccessContext wiring pass (M8) could read from a one-shot observer. This
// file is INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads.
//   - Imports NOTHING.
//   - Imported only by `supabaseAccessAwareness.ts` and the M7 observational diagnostic.
//
// SECURITY (binding): the record is observational only. It NEVER contains an access
// token, refresh token, raw JWT, provider token, authorization payload, permissions,
// subPermissions, role, tenant, or plan. It NEVER authorizes anything. Firebase remains
// the sole authoritative session source.

/**
 * Outcome of a single awareness observation, in honest default-OFF order:
 *   - 'disabled'              → not DEV, or the awareness/bootstrap flags are not on.
 *   - 'cancelled'             → the runner was aborted before/after the async read.
 *   - 'foundation_unavailable'→ enabled, but the underlying Supabase foundation is
 *                               disabled / unconfigured / not 'ready'.
 *   - 'no_session'            → enabled and ready, but no Supabase session is present.
 *   - 'session_present'       → a Supabase session exists (observational only).
 *   - 'error'                 → an unexpected error was caught and made safe (no throw).
 */
export type AccessAwarenessStatus =
  | 'disabled'
  | 'cancelled'
  | 'foundation_unavailable'
  | 'no_session'
  | 'session_present'
  | 'error';

/**
 * Non-secret, observational awareness record. Contains NO token of any kind and NO
 * authorization data. `email` is an OPTIONAL, already-REDACTED, reference-only hint
 * (never a credential) and is null unless a session is present.
 */
export interface AccessAwarenessRecord {
  /** True only when DEV AND the awareness flag AND the bootstrap are enabled. */
  enabled: boolean;
  /** True only when the runner was aborted. */
  cancelled: boolean;
  /** True only when a Supabase session is currently present. */
  hasSession: boolean;
  status: AccessAwarenessStatus;
  /** Redacted, reference-only identity hint (e.g. "a***@example.com"); never a secret. */
  email: string | null;
  /** Provenance label for the observation source; never a secret. */
  source: string;
  /** Safe, non-secret status message for diagnostics/developer inspection. */
  message: string;
}

/** Options for a single one-shot observation. Cancellation is honored if provided. */
export interface AccessAwarenessRunOptions {
  /** Optional AbortSignal so a future caller (e.g. a useEffect cleanup) can cancel. */
  signal?: AbortSignal;
}
