// Phase 1.5 M4 — Supabase Auth Frontend Login Pilot.
//
// Centralized, audit-friendly reader for the PILOT's public Vite env vars.
//
// SECURITY (binding):
//   - This module reads ONLY client-safe, `VITE_`-prefixed public values.
//   - It NEVER reads a service-role key, DB URL, JWT secret, or test token.
//     Those are server-only and are not `VITE_`-prefixed, so Vite would never
//     expose them to the browser bundle anyway. Keeping every pilot env read in
//     ONE file makes the client-safe boundary trivial to audit.
//
// TYPING NOTE: the project does not wire `vite/client` types, so `import.meta.env`
// is untyped here. We read it through a single narrow cast so the pilot adds NO
// new `Property 'env' does not exist on type 'ImportMeta'` errors and does not
// alter the global type baseline.

interface PilotPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** Supabase project URL — client-safe public value. */
  VITE_SUPABASE_URL?: string;
  /** Supabase anon/publishable key — client-safe by design (RLS is the real guard). */
  VITE_SUPABASE_ANON_KEY?: string;
  /** Pilot visibility flag — must equal the string 'true' to surface the route. */
  VITE_ENABLE_SUPABASE_PILOT?: string;
  /** Base path/URL for the isolated identity diagnostic API (default: dev proxy). */
  VITE_IDENTITY_API_BASE?: string;
}

const env: PilotPublicEnv = (import.meta as unknown as { env?: PilotPublicEnv }).env ?? {};

/** True only under a Vite dev server build (never in a production build). */
export const IS_DEV = env.DEV === true;

/** True only when the operator has explicitly opted the pilot in. */
export const PILOT_FLAG_ON = env.VITE_ENABLE_SUPABASE_PILOT === 'true';

/**
 * The dev-only pilot route is registered ONLY when BOTH hold:
 *   - we are in a Vite dev build (production builds exclude it), AND
 *   - the explicit opt-in flag is 'true'.
 * Default behaviour is OFF.
 */
export const PILOT_ROUTE_ENABLED = IS_DEV && PILOT_FLAG_ON;

/** Public Supabase project URL (undefined ⇒ pilot renders a not-configured state). */
export const SUPABASE_URL: string | undefined = env.VITE_SUPABASE_URL;

/** Public Supabase anon key (undefined ⇒ pilot renders a not-configured state). */
export const SUPABASE_ANON_KEY: string | undefined = env.VITE_SUPABASE_ANON_KEY;

/**
 * Identity diagnostic API base. Defaults to the dev Vite proxy prefix `/__identity`
 * so the browser calls a same-origin path (no backend CORS change in M4).
 */
export const IDENTITY_API_BASE: string = env.VITE_IDENTITY_API_BASE || '/__identity';
