// Phase 1.6 M5 — Dormant Supabase Auth frontend foundation: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of the future, app-level Supabase browser-auth
// foundation. This file is INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads.
//   - Imports NOTHING (deliberately no `@supabase/supabase-js` import here, so the
//     controlled SDK import stays confined to the single foundation module
//     `supabaseAuthFoundation.ts` — see the M4 inventory diagnostic allowlist).
//   - Imported only by `supabaseAuthFoundation.ts` and the M5 dormancy diagnostic.
//
// SECURITY: references NO service-role key, NO DB URL, NO connection string, NO raw
// JWT secret, and NO server-only Supabase env name. It describes a PUBLIC anon-key
// browser foundation only and NEVER grants app authorization on its own.

/**
 * Why the foundation is (or is not) active, in honest, default-OFF order:
 *   - 'dormant_not_dev'   → not a Vite DEV build (production builds are always OFF).
 *   - 'dormant_flag_off'  → DEV, but VITE_ENABLE_SUPABASE_AUTH_FOUNDATION !== 'true'.
 *   - 'unconfigured_env'  → DEV + flag ON, but a public VITE_ value is missing.
 *   - 'ready'             → DEV + flag ON + public env present (client buildable
 *                           ON DEMAND only — never at import time).
 */
export type SupabaseAuthFoundationStatus =
  | 'dormant_not_dev'
  | 'dormant_flag_off'
  | 'unconfigured_env'
  | 'ready';

/**
 * Non-secret, render-safe description of the foundation's dormancy/readiness.
 * Contains NO token, NO key, NO URL value — only a status + a human-readable,
 * non-secret message.
 */
export interface SupabaseAuthFoundationState {
  /** True only when DEV build AND the DEV-only opt-in flag is 'true'. */
  enabled: boolean;
  /** True only when both public VITE_ Supabase values are present. */
  configured: boolean;
  status: SupabaseAuthFoundationStatus;
  /** Safe, non-secret status message for diagnostics/UI. Never a secret. */
  message: string;
}

/**
 * Result of explicitly asking the foundation for a client. `client` is the opaque
 * Supabase browser client (typed as `unknown` here to keep this types file free of
 * any `@supabase/supabase-js` import) and is non-null ONLY when status is 'ready'
 * AND the lazy factory was explicitly invoked. In M5 nothing invokes it.
 */
export interface SupabaseAuthFoundationHandle {
  state: SupabaseAuthFoundationState;
  /** Non-null only when 'ready' and explicitly built on demand; else null. */
  client: unknown | null;
}
