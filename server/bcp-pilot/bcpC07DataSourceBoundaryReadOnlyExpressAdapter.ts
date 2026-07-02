// Phase 2.0 M35 — Thin Express adapter for the inert C-07 data-source-boundary route handler.
//
// WHAT THIS IS: the smallest possible HTTP boundary that translates an Express request into the pure C-07
// transport-agnostic input, calls handleBcpC07DataSourceBoundaryRequest, and writes its safe response.
// Adds NO business/authorization/redaction/mapper logic. Mirrors the frozen C-02..C-06 adapters.
//
// SAFETY (binding):
//   - Authority is server-constructed only: a FIXED SYNTHETIC principal (no live session resolver). Nothing
//     from the request (UID/email/body/query/headers/cookies/params) is read as authority.
//   - DEV-only + default-off: isDevEnvironment from NODE_ENV; featureEnabled from the default-OFF C-07 flag.
//     Both dependency-injectable so tests need not mutate global env. The flag read is a boolean GATE only.
//   - The declared-item registry is server-supplied via an injectable provider (default: EMPTY). Does NOT
//     import src/.../mockData.ts and, in M35, is NOT wired to the C-07 provider. Gates-first: resolved ONLY
//     when DEV + enabled.
//   - Reads NOTHING live; no DB/Supabase/getDb/fetch; NO env enumeration; NO log/test/scan/package read.
//   - NOT mounted: this factory is exported for a future authorization/mount gate (M36); M35 does not
//     register it and does not touch server/platform-identity/server.ts.
//
// GUARD-GAP (M34 §12): with the fixed always-`ready` synthetic principal, an enabled+DEV GET currently
// serializes the fail-closed 403 not_authorized (the shared guard has no 'C-07' entry), NOT a 200. That is
// expected and correct for M35; the 200 path is unlocked only by the separate M36 guard entry.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { handleBcpC07DataSourceBoundaryRequest } from './bcpC07DataSourceBoundaryReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { C07BoundaryItemInput } from './bcpC07DataSourceBoundaryReadModel';

/** The DEV-only C-07 route path on the ISOLATED platform-identity API. */
export const BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH = '/dev/bcp/data-source-boundary-readiness';
/** The DEV-only C-07 frontend proxy label (reserved for a future client milestone). */
export const BCP_C07_DATA_SOURCE_BOUNDARY_PROXY_PATH = '/__identity/dev/bcp/data-source-boundary-readiness';
/** Default-OFF feature flag name for the C-07 route. */
export const BCP_C07_DATA_SOURCE_BOUNDARY_FLAG = 'ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS';

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
export interface BcpC07HandlerDeps {
  /** Defaults to NODE_ENV !== 'production'. */
  isDevEnvironment?: () => boolean;
  /** Defaults to the default-OFF C-07 flag (env value === 'true'). Boolean GATE only; never surfaced. */
  featureEnabled?: () => boolean;
  /** Server-supplied code/config declared boundary items. Defaults to EMPTY (no src import, no live read,
   *  no C-07 provider wiring in M35). */
  getDataSourceBoundaryItems?: () => readonly C07BoundaryItemInput[];
}

/**
 * Build the Express handler for the inert C-07 data-source-boundary route. Pure boundary: it resolves
 * server-side gate inputs + the server-supplied registry, calls the C-07 handler, and serializes its safe
 * result. Adds NO authorization/redaction/mapper/business logic, registers nothing, reads no env for output.
 */
export function createBcpC07DataSourceBoundaryReadinessHandler(deps: BcpC07HandlerDeps = {}) {
  const resolveIsDev = deps.isDevEnvironment ?? (() => process.env.NODE_ENV !== 'production');
  const resolveFeatureEnabled = deps.featureEnabled ?? (() => process.env[BCP_C07_DATA_SOURCE_BOUNDARY_FLAG] === 'true');
  const resolveItems = deps.getDataSourceBoundaryItems ?? ((): readonly C07BoundaryItemInput[] => []);

  return (req: Request, res: Response): void => {
    try {
      // Server-derived gate inputs; never from the request. The flag boolean is a GATE, never output.
      const isDevEnvironment = resolveIsDev();
      const featureEnabled = resolveFeatureEnabled();
      // GATES FIRST (defense-in-depth): resolve the registry provider ONLY when DEV + enabled.
      const items = isDevEnvironment && featureEnabled ? resolveItems() : [];
      const result = handleBcpC07DataSourceBoundaryRequest({
        method: req.method,
        isDevEnvironment,
        featureEnabled,
        principal: SYNTHETIC_PRINCIPAL,
        // Server-supplied registry; never mapped from untrusted request input.
        items,
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
