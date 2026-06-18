// Phase 1.6 M6 — Dormant, DEV-flag-gated Supabase SESSION BOOTSTRAP (Stage-3 groundwork).
//
// WHAT THIS IS: a clean, app-level helper that — when explicitly invoked — reads a
// NON-SECRET, observational snapshot of Supabase session presence by going THROUGH the
// dormant M5 auth foundation (`./supabaseAuthFoundation`). It is the FIRST and ONLY
// permitted importer of that foundation (see the controlled allowlist updates in the M5
// dormancy + inventory diagnostics).
//
// WHAT THIS IS NOT (binding for M6): it changes NO current behavior. Firebase remains the
// sole active/default/authoritative session source. This module is DORMANT:
//   - It is imported by NOTHING active — not Login, AccessContext, AccessGuard, App
//     routing, or src/main.tsx — so the bundler tree-shakes it (and, through it, the
//     foundation) out of the production bundle. (Proven by the M6 dormancy diagnostic.)
//   - It has NO import-time side effects, NO top-level await, and reads NO session at
//     import. The snapshot is produced ONLY when `readSupabaseSessionSnapshot()` is
//     explicitly called — and NO call site is added in M6.
//
// SECURITY (binding):
//   - Imports the M5 foundation ONLY — NOT `@supabase/supabase-js` directly. The direct
//     SDK import stays confined to the foundation + `src/pilot/**`.
//   - The snapshot is NON-SECRET: it NEVER contains or references an access token, a
//     refresh token, a raw JWT, a provider token, an authorization payload, permissions,
//     subPermissions, role, tenant, or plan. The session's token fields are NEVER read.
//   - It NEVER mutates app/session/tenant/role/permission state, imports no React, and
//     touches AccessContext in no way. It NEVER authorizes anything itself.
//   - It does NOT call the backend session-resolve route, any protected business API,
//     any backend control API, or any database-control API, and reads NO server-derived
//     authorization. It NEVER connects to the database.
//
// FLAG (binding): VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP is DEV-only and default OFF. It
// is intentionally SEPARATE from the foundation flag, the dev pilot's flag, and the future
// server-authz shadow flag. Even when 'true', M6 wires this module to nothing — the flag
// only gates FUTURE activation (a later, separately-approved AccessContext-awareness stage).

import { getSupabaseAuthFoundation } from './supabaseAuthFoundation';
import type {
  SupabaseSessionSnapshot,
  SupabaseSessionSnapshotStatus,
} from './supabaseSessionBootstrapTypes';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast
// so this module adds NO new ImportMeta typing error and does not alter the baseline.
// -----------------------------------------------------------------------------

interface BootstrapPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** DEV-only bootstrap opt-in — must equal the string 'true' to enable. */
  VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): BootstrapPublicEnv {
  return (import.meta as unknown as { env?: BootstrapPublicEnv }).env ?? {};
}

/** True only under a Vite DEV build (never in a production build). */
export function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/** True only when the operator has explicitly opted the bootstrap in. */
export function isBootstrapFlagOn(): boolean {
  return readEnv().VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP === 'true';
}

/**
 * The bootstrap is ENABLED only when BOTH hold:
 *   - we are in a Vite DEV build (production is always OFF), AND
 *   - the explicit opt-in flag is 'true'.
 * Default behaviour is OFF.
 */
export function isSupabaseSessionBootstrapEnabled(): boolean {
  return isDevBuild() && isBootstrapFlagOn();
}

// -----------------------------------------------------------------------------
// Minimal STRUCTURAL view of the Supabase browser client's auth surface. We read ONLY
// session presence and an optional reference email — deliberately NOT the token fields,
// so this module never even names them. This avoids importing `@supabase/supabase-js`.
// -----------------------------------------------------------------------------

interface MinimalSupabaseSessionUser {
  email?: string | null;
}
interface MinimalSupabaseSession {
  user?: MinimalSupabaseSessionUser | null;
}
interface MinimalSupabaseAuthClient {
  auth: {
    getSession(): Promise<{ data: { session: MinimalSupabaseSession | null } }>;
  };
}

/** Redact an email to a reference-only, non-secret hint (e.g. "a***@example.com"). */
function redactEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  const head = local.slice(0, 1) || '';
  return `${head}***@${domain}`;
}

function snapshot(
  status: SupabaseSessionSnapshotStatus,
  enabled: boolean,
  hasSession: boolean,
  email: string | null,
  message: string,
): SupabaseSessionSnapshot {
  return { enabled, hasSession, status, email, message };
}

// -----------------------------------------------------------------------------
// Lazy, no-throw snapshot reader. Builds nothing at import; reads the session ONLY
// when explicitly called, and ONLY through the (dormant) M5 foundation. In M6 NOTHING
// calls this — the bootstrap stays dormant.
// -----------------------------------------------------------------------------

/**
 * Read a NON-SECRET observational snapshot of Supabase session presence. No-throw in
 * every branch. Returns a disabled/unavailable state unless the bootstrap is enabled,
 * the M5 foundation is 'ready', and a session exists. Tokens are NEVER read or returned.
 */
export async function readSupabaseSessionSnapshot(): Promise<SupabaseSessionSnapshot> {
  const env = readEnv();

  if (env.DEV !== true) {
    return snapshot('disabled_not_dev', false, false, null,
      'Supabase session bootstrap is dormant: not a DEV build (production stays Firebase-only).');
  }
  if (env.VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP !== 'true') {
    return snapshot('disabled_flag_off', false, false, null,
      'Supabase session bootstrap is dormant: VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP is not "true".');
  }

  // Go THROUGH the M5 foundation — never construct a client here.
  const handle = getSupabaseAuthFoundation();
  if (handle.state.status !== 'ready' || !handle.client) {
    return snapshot('foundation_unavailable', true, false, null,
      `Supabase session bootstrap enabled but foundation not ready (${handle.state.status}).`);
  }

  // Structural cast: read ONLY session presence + reference email. Token fields are
  // deliberately not part of this view and are never accessed.
  const client = handle.client as MinimalSupabaseAuthClient;
  const result = await client.auth.getSession();
  const session = result?.data?.session ?? null;

  if (!session) {
    return snapshot('no_session', true, false, null,
      'Supabase session bootstrap enabled; no Supabase session present (Firebase remains authoritative).');
  }

  return snapshot('session_present', true, true, redactEmail(session.user?.email),
    'Supabase session present (observational only; Firebase remains authoritative).');
}
