// Phase 2.0 M7C — Backend Control Panel (BCP) DEV-only read-only pilot: feature-flag gate.
//
// SCOPE (binding): this is the FOUNDATION/test-harness flag only. It does NOT enable any
// live read-only API, live data integration, DB access, Supabase access, or production path.
// Mirrors the established server-side flag convention in
// `server/platform-identity/config.ts`: read process.env, report a boolean only, NEVER expose
// values, default OFF, and NEVER enable in production.
//
// Server-side only. Never imported by src/ (the client bundle). Inert/dormant in M7C: imported
// only by the M7C test harness, so it is not wired into any live route or runtime path.

/** Feature flag name. Default behaviour is OFF unless set to exactly "true". */
export const BCP_DEV_READONLY_PILOT_FLAG = 'ENABLE_BCP_DEV_READONLY_PILOT';

/**
 * True ONLY when the BCP DEV read-only pilot foundation is explicitly enabled AND the process is
 * non-production. Conservative on purpose: NEVER rely on NODE_ENV alone, and NEVER enable in
 * production. Any other value (unset, '', 'false', '1', 'yes', …) is treated as OFF.
 *
 * Even when this returns true, it only unlocks the INERT foundation/harness — never live data.
 */
export function isBcpDevReadonlyPilotEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env[BCP_DEV_READONLY_PILOT_FLAG] === 'true';
}
