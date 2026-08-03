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

/**
 * Phase 1.5 M7 — session-resolve prototype flag. SEPARATE from the M3 diagnostics
 * flag so the dev-only /auth/session/resolve route is independently gated.
 * Default behaviour is OFF.
 */
export const SESSION_RESOLVE_FLAG = 'ENABLE_SESSION_RESOLVE';

/**
 * True ONLY when the session-resolve prototype is explicitly enabled AND the
 * process is non-production. Conservative on purpose: NEVER rely on NODE_ENV
 * alone, and NEVER enable in production. The platform-identity feature flag is
 * checked SEPARATELY by the route (both must hold). This is a NON-SECRET flag, so
 * it is intentionally NOT added to the secret-presence map below.
 */
export function isSessionResolveEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env[SESSION_RESOLVE_FLAG] === 'true';
}

/**
 * Phase 1.5 M11.5 — live server-derived authorization flag. SEPARATE from the M7
 * session-resolve flag so live `/auth/session/resolve` authorization is
 * independently gated. Default behaviour is OFF.
 */
export const LIVE_SESSION_AUTHORIZATION_FLAG = 'ENABLE_LIVE_SESSION_AUTHORIZATION';

/**
 * True ONLY when live session authorization is explicitly enabled AND the process
 * is non-production. Conservative on purpose: NEVER rely on NODE_ENV alone, and
 * NEVER enable in production. The platform-identity and session-resolve flags are
 * checked SEPARATELY by the route (all must hold). Non-secret flag, so it is
 * intentionally NOT added to the secret-presence map below.
 */
export function isLiveSessionAuthorizationEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env[LIVE_SESSION_AUTHORIZATION_FLAG] === 'true';
}

/**
 * Phase 4.0 M3 S2 — the two database principals are sourced from two DISTINCT variables and
 * are never interchangeable. The names are exported so diagnostics and errors can identify a
 * missing variable without any caller inlining a literal (and without ever touching a value).
 *
 *   SUPABASE_DATABASE_URL  the migration/admin principal — owns the tables, bypasses RLS.
 *   APP_DATABASE_URL       the tenant-runtime principal — non-owner, RLS-bound.
 */
export const SUPABASE_DATABASE_URL_VAR = 'SUPABASE_DATABASE_URL';
export const APP_DATABASE_URL_VAR = 'APP_DATABASE_URL';

/**
 * Phase 4.0 M3 S4.1a — the certificate authority every database endpoint is verified against.
 *
 * Deliberately provider-neutral and deliberately SHARED by both principals: they address the
 * same cluster, so a per-principal CA would be two names for one fact and would invite the two
 * to drift apart. The name follows the existing `*_DATABASE_*` vocabulary and encodes no vendor,
 * because the trust anchor is a property of the deployment, not of whoever operates it.
 */
export const DATABASE_CA_CERT_VAR = 'DATABASE_CA_CERT';

/** Presence-only view of the relevant secrets. Booleans only — never values. */
export interface ConfigPresence {
  supabaseUrl: boolean;
  databaseUrl: boolean;
  serviceRoleKey: boolean;
  anonKey: boolean;
  /** S2: the tenant-runtime principal. Reported for visibility; see isServerConfigComplete. */
  appDatabaseUrl: boolean;
  /** S4.1a: the database trust anchor. Reported for visibility; enforced at construction. */
  databaseCaCert: boolean;
}

export function getConfigPresence(): ConfigPresence {
  return {
    supabaseUrl: !!process.env.SUPABASE_URL,
    databaseUrl: !!process.env[SUPABASE_DATABASE_URL_VAR],
    serviceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: !!process.env.SUPABASE_ANON_KEY,
    appDatabaseUrl: !!process.env[APP_DATABASE_URL_VAR],
    databaseCaCert: !!getDatabaseCaConfig(),
  };
}

/**
 * Phase 4.0 M3 S4.1a — the PEM CA material for the database endpoints, or null when it is not
 * usably configured.
 *
 * A whitespace-only value counts as ABSENT, not present. `!!process.env.X` would report a blank
 * secret as configured, and the connection would then be attempted with an empty trust anchor —
 * a presence check that passes while the property it stands for does not hold.
 *
 * Callers MUST NOT log the returned value.
 */
export function getDatabaseCaConfig(): { ca: string } | null {
  const raw = process.env[DATABASE_CA_CERT_VAR];
  if (typeof raw !== 'string') return null;
  const ca = raw.trim();
  return ca === '' ? null : { ca };
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
  const databaseUrl = process.env[SUPABASE_DATABASE_URL_VAR];
  if (!databaseUrl) return null;
  return { databaseUrl };
}

/**
 * Phase 4.0 M3 S2 — the connection string for the TENANT-RUNTIME principal, or null when it is
 * not configured.
 *
 * This reads APP_DATABASE_URL and NOTHING else. There is deliberately no fallback to
 * SUPABASE_DATABASE_URL: that fallback would be silent, and its effect would be to run the
 * tenant request path as the table OWNER, which bypasses every RLS policy migration 005
 * installs. A missing runtime URL must surface as an absent runtime principal, never as an
 * accidentally privileged one.
 *
 * Callers MUST NOT log the returned value.
 */
export function getRuntimePrincipalConfig(): { databaseUrl: string } | null {
  const databaseUrl = process.env[APP_DATABASE_URL_VAR];
  if (!databaseUrl) return null;
  return { databaseUrl };
}

/**
 * True when every secret the M1 server path expects is present.
 *
 * S2 deliberately does NOT add APP_DATABASE_URL to this gate. Readiness here controls the
 * existing owner-backed DEV/admin path, which S2 leaves untouched; requiring the runtime
 * principal would take that path offline the moment 005 landed, for a principal no caller uses
 * yet. Its presence is reported by getConfigPresence() instead, so the gap is visible without
 * being load-bearing. Tightening this is part of the caller cutover that keeps G-DBROLE open.
 */
export function isServerConfigComplete(): boolean {
  const p = getConfigPresence();
  // databaseUrl is the only one strictly required to connect; supabaseUrl +
  // serviceRoleKey are required by the M1 evidence pack for completeness.
  return p.databaseUrl && p.supabaseUrl && p.serviceRoleKey;
}
