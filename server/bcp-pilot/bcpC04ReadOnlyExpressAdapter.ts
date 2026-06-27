// Phase 2.0 M14 — Thin Express adapter for the inert C-04 route-exposure route handler.
//
// WHAT THIS IS: the smallest possible HTTP boundary that translates an Express request into the pure
// C-04 transport-agnostic input, calls handleBcpC04RouteExposureRequest, and writes its safe response.
// Adds NO business/authorization/redaction/mapper logic. Mirrors the frozen C-02/C-03 adapters.
//
// SAFETY (binding):
//   - Authority is server-constructed only: a FIXED SYNTHETIC principal (no live session resolver).
//     Nothing from the request (UID/email/body/query/headers/cookies/params) is read as authority.
//   - DEV-only + default-off: isDevEnvironment from NODE_ENV; featureEnabled from the default-OFF C-04
//     flag. Both dependency-injectable so tests need not mutate global env.
//   - The route registry is server-supplied via an injectable provider (default: EMPTY). Does NOT import
//     src/.../mockData.ts. Gates-first: provider resolved ONLY when DEV + enabled.
//   - Reads NOTHING live; no DB/Supabase/getDb/fetch; NO runtime route scan / router introspection.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { handleBcpC04RouteExposureRequest } from './bcpC04ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { C04RouteExposureEntryInput } from './bcpC04RouteExposureReadModel';

/** The DEV-only C-04 route path on the ISOLATED platform-identity API. */
export const BCP_C04_ROUTE_EXPOSURE_ROUTE_PATH = '/dev/bcp/route-exposure-readiness';
/** The DEV-only C-04 frontend proxy label. */
export const BCP_C04_ROUTE_EXPOSURE_PROXY_PATH = '/__identity/dev/bcp/route-exposure-readiness';
/** Default-OFF feature flag name for the C-04 route. */
export const BCP_C04_FEATURE_FLAG = 'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS';

// FIXED synthetic, server-derived principal. Obvious fake placeholder id. Wires NO live session resolver.
const SYNTHETIC_PRINCIPAL: SyntheticServerPrincipal = {
  source: 'server_derived',
  internalUserId: 'iu_synthetic_dev',
  authProvider: 'supabase',
  verified: true,
  scopeType: 'platform',
  parityState: 'ready',
  visibilityClass: 'overview_viewer',
};

/** Injectable dependencies — all default to safe, server-derived, default-off behavior. */
export interface BcpC04HandlerDeps {
  /** Defaults to NODE_ENV !== 'production'. */
  isDevEnvironment?: () => boolean;
  /** Defaults to the default-OFF C-04 flag (env value === 'true'). */
  featureEnabled?: () => boolean;
  /** Server-supplied code/config route-exposure registry. Defaults to EMPTY (no src import, no scan). */
  getRouteExposureEntries?: () => readonly C04RouteExposureEntryInput[];
}

/**
 * Build the Express handler for the inert C-04 route-exposure route. Pure boundary: it resolves
 * server-side gate inputs + the server-supplied registry, calls the C-04 handler, and serializes its
 * safe result. Adds NO authorization/redaction/mapper/business logic, registers nothing, scans nothing.
 */
export function createBcpC04RouteExposureReadinessHandler(deps: BcpC04HandlerDeps = {}) {
  const resolveIsDev = deps.isDevEnvironment ?? (() => process.env.NODE_ENV !== 'production');
  const resolveFeatureEnabled = deps.featureEnabled ?? (() => process.env[BCP_C04_FEATURE_FLAG] === 'true');
  const resolveEntries = deps.getRouteExposureEntries ?? ((): readonly C04RouteExposureEntryInput[] => []);

  return (req: Request, res: Response): void => {
    try {
      // Server-derived gate inputs; never from the request.
      const isDevEnvironment = resolveIsDev();
      const featureEnabled = resolveFeatureEnabled();
      // GATES FIRST (defense-in-depth): resolve the registry provider ONLY when DEV + enabled.
      const entries = isDevEnvironment && featureEnabled ? resolveEntries() : [];
      const result = handleBcpC04RouteExposureRequest({
        method: req.method,
        isDevEnvironment,
        featureEnabled,
        principal: SYNTHETIC_PRINCIPAL,
        // Server-supplied registry; never mapped from untrusted request input.
        entries,
      });

      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      }
      res.status(result.httpStatus);
      if (result.body === null) {
        res.end(); // HEAD / OPTIONS / no-body responses
      } else {
        res.json(result.body);
      }
    } catch {
      // Safe error at the transport edge: never leak an exception or stack trace.
      if (!res.headersSent) {
        res.status(500);
        res.json({ status: 'error' });
      }
    }
  };
}
