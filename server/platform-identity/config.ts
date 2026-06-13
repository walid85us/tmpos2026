// Phase 1.5 M1 — Platform Identity: configuration & feature-flag helpers.
//
// SECURITY: This module reads environment variables but NEVER returns, logs, or
// exposes their VALUES. It only reports presence (booleans). Secret values stay
// inside process.env and the server-side DB connection helper.
//
// This file is server-side only. It is never imported by `src/` (the client
// bundle), so no secret can reach the browser through it.

/** Feature flag name. Default behaviour is OFF unless set to exactly "true". */
export const FEATURE_FLAG = 'ENABLE_SUPABASE_PLATFORM_IDENTITY';

/**
 * The platform-identity backend path is DISABLED by default. It is enabled only
 * when ENABLE_SUPABASE_PLATFORM_IDENTITY === 'true'. Any other value (unset,
 * '', 'false', '1', 'yes', …) is treated as OFF.
 */
export function isPlatformIdentityEnabled(): boolean {
  return process.env[FEATURE_FLAG] === 'true';
}

/**
 * Phase 1.5 M3-Revised — verified-actor diagnostics flag. SEPARATE from the M2
 * dev-asserted flag (PLATFORM_IDENTITY_DEV_DIAGNOSTICS) so the two diagnostic
 * paths are independently gated. Default behaviour is OFF.
 */
export const VERIFIED_DIAGNOSTICS_FLAG = 'PLATFORM_IDENTITY_VERIFIED_DIAGNOSTICS';

/**
 * True ONLY when verified Supabase diagnostics are explicitly enabled AND the
 * process is non-production. Conservative on purpose: NEVER rely on NODE_ENV
 * alone, and never enable in production. The platform-identity feature flag is
 * checked SEPARATELY by the endpoint (both must hold).
 */
export function isVerifiedDiagnosticsEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env[VERIFIED_DIAGNOSTICS_FLAG] === 'true';
}

/** Presence-only view of the relevant secrets. Booleans only — never values. */
export interface ConfigPresence {
  supabaseUrl: boolean;
  databaseUrl: boolean;
  serviceRoleKey: boolean;
  anonKey: boolean;
}

export function getConfigPresence(): ConfigPresence {
  return {
    supabaseUrl: !!process.env.SUPABASE_URL,
    databaseUrl: !!process.env.SUPABASE_DATABASE_URL,
    serviceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: !!process.env.SUPABASE_ANON_KEY,
  };
}

/**
 * The minimum config required for the M1 server-side DB path. M1 talks to
 * Postgres DIRECTLY via the connection string (SUPABASE_DATABASE_URL), so that
 * is the only value strictly required to connect. SUPABASE_URL and the
 * service-role key are validated-present (for forward-compatibility with a
 * future Supabase REST client) but are NOT used for DB access in M1.
 *
 * Returns the connection string when present, or null when missing. Callers
 * MUST NOT log the returned value.
 */
export function getRequiredServerConfig(): { databaseUrl: string } | null {
  const databaseUrl = process.env.SUPABASE_DATABASE_URL;
  if (!databaseUrl) return null;
  return { databaseUrl };
}

/** True when every secret the M1 server path expects is present. */
export function isServerConfigComplete(): boolean {
  const p = getConfigPresence();
  // databaseUrl is the only one strictly required to connect; supabaseUrl +
  // serviceRoleKey are required by the M1 evidence pack for completeness.
  return p.databaseUrl && p.supabaseUrl && p.serviceRoleKey;
}
