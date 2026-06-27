// Phase 2.0 M12 — Thin Express adapter for the inert C-03 UI coverage readiness route handler.
//
// WHAT THIS IS: the smallest possible HTTP boundary that translates an Express request into the pure
// C-03 transport-agnostic input, calls handleBcpC03UiCoverageRequest, and writes its safe response. It
// adds NO business/authorization/redaction/mapper logic of its own. Mirrors the frozen C-02 adapter.
//
// SAFETY (binding):
//   - Authority is server-constructed only: a FIXED SYNTHETIC principal (no live session resolver).
//     Nothing from the request (UID/email/body/query/headers/cookies/params) is ever read as authority.
//   - DEV-only + default-off: isDevEnvironment derives from NODE_ENV; featureEnabled derives from the
//     default-OFF C-03 flag. Both are dependency-injectable so tests need not mutate global env.
//   - The UI coverage registry is server-supplied via an injectable provider (default: EMPTY). This
//     adapter does NOT import src/.../mockData.ts. An empty registry yields a safe emptyState DTO.
//   - Gates-first: the (possibly injected) provider is resolved ONLY when DEV + enabled.
//   - Reads NOTHING live: no DB, Supabase, provider, fetch, getDb. Only the pure C-03 modules.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { handleBcpC03UiCoverageRequest } from './bcpC03ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { C03UiCoverageEntryInput } from './bcpC03UiCoverageReadModel';

/** The DEV-only C-03 route path on the ISOLATED platform-identity API. */
export const BCP_C03_UI_COVERAGE_ROUTE_PATH = '/dev/bcp/ui-coverage-readiness';
/** The DEV-only C-03 frontend proxy label. */
export const BCP_C03_UI_COVERAGE_PROXY_PATH = '/__identity/dev/bcp/ui-coverage-readiness';
/** Default-OFF feature flag name for the C-03 route. */
export const BCP_C03_FEATURE_FLAG = 'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS';

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
export interface BcpC03HandlerDeps {
  /** Defaults to NODE_ENV !== 'production'. */
  isDevEnvironment?: () => boolean;
  /** Defaults to the default-OFF C-03 flag (env value === 'true'). */
  featureEnabled?: () => boolean;
  /** Server-supplied code/config UI coverage registry. Defaults to EMPTY (no src import). */
  getCoverageEntries?: () => readonly C03UiCoverageEntryInput[];
}

/**
 * Build the Express handler for the inert C-03 UI coverage readiness route. Pure boundary: it resolves
 * server-side gate inputs + the server-supplied registry, calls the C-03 handler, and serializes its
 * safe result. It adds NO authorization/redaction/mapper/business logic, and registers nothing.
 */
export function createBcpC03UiCoverageReadinessHandler(deps: BcpC03HandlerDeps = {}) {
  const resolveIsDev = deps.isDevEnvironment ?? (() => process.env.NODE_ENV !== 'production');
  const resolveFeatureEnabled = deps.featureEnabled ?? (() => process.env[BCP_C03_FEATURE_FLAG] === 'true');
  const resolveEntries = deps.getCoverageEntries ?? ((): readonly C03UiCoverageEntryInput[] => []);

  return (req: Request, res: Response): void => {
    try {
      // Server-derived gate inputs; never from the request.
      const isDevEnvironment = resolveIsDev();
      const featureEnabled = resolveFeatureEnabled();
      // GATES FIRST (defense-in-depth, mirrors the handler): only resolve the (possibly injected /
      // future-expensive) registry provider when DEV + enabled — never in production or flag-off.
      const entries = isDevEnvironment && featureEnabled ? resolveEntries() : [];
      const result = handleBcpC03UiCoverageRequest({
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
