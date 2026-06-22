// Phase 1.6 M22B — Backend Control Plane (read-only / mock-only UI foundation).
//
// Centralized, audit-friendly reader for the BCP shell's ROUTE-VISIBILITY env vars.
//
// SECURITY (binding):
//   - This module reads ONLY Vite's built-in DEV flag and a single client-safe,
//     VITE_-prefixed visibility flag. It NEVER reads BCP DATA from env, and never
//     reads a service-role key, DB URL, secret, or token. The BCP shell renders
//     ONLY local static mock data (see ./mockData).
//   - The route is registered ONLY in a Vite dev build AND only when explicitly
//     opted in. Production builds exclude it. Default behaviour is OFF.
//   - This mirrors the accepted Phase 1.5 M4 pilot route pattern (src/pilot/pilotEnv.ts)
//     so the BCP adds NO new authority and NO impact on existing flows.
//
// TYPING NOTE: the project does not wire `vite/client` types, so `import.meta.env`
// is untyped here. We read it through a single narrow cast so the BCP adds NO new
// type errors and does not alter the global type baseline.

interface BcpPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** BCP shell visibility flag — must equal the string 'true' to surface the route. */
  VITE_ENABLE_BACKEND_CONTROL_PLANE?: string;
}

const env: BcpPublicEnv = (import.meta as unknown as { env?: BcpPublicEnv }).env ?? {};

/** True only under a Vite dev server build (never in a production build). */
export const IS_DEV = env.DEV === true;

/** True only when the operator has explicitly opted the BCP shell in. */
export const BCP_FLAG_ON = env.VITE_ENABLE_BACKEND_CONTROL_PLANE === 'true';

/**
 * The dev-only BCP route is registered ONLY when BOTH hold:
 *   - we are in a Vite dev build (production builds exclude it), AND
 *   - the explicit opt-in flag is 'true'.
 * Default behaviour is OFF.
 */
export const BCP_ROUTE_ENABLED = IS_DEV && BCP_FLAG_ON;

/** Isolated, dev-only path. Lives OUTSIDE the guarded '/' and '/owner' trees. */
export const BCP_ROUTE_PATH = '/dev/backend-control-plane';
