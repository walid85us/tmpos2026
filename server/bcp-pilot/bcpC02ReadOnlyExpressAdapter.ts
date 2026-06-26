// Phase 2.0 M8D — Thin Express adapter for the inert C-02 registry-readiness route handler.
//
// WHAT THIS IS: the smallest possible HTTP boundary that translates an Express request into the pure
// M8D transport-agnostic input, calls handleBcpC02RegistryReadinessRequest, and writes its safe
// response. It adds NO business/authorization/redaction/mapper logic of its own.
//
// INERT (binding): this adapter only EXPORTS a handler factory. It does NOT create an Express app,
// does NOT call app.get/app.use/app.all, does NOT call listen, and does NOT register with
// server/platform-identity/server.ts. Mounting on the ISOLATED platform-identity API is DEFERRED to
// the separately-authorized M8E milestone.
//
// SAFETY (binding):
//   - Authority is server-constructed only: a FIXED SYNTHETIC principal (no live session resolver).
//     Nothing from the request (UID/email/body/query/headers) is ever read as authority.
//   - DEV-only + default-off: isDevEnvironment derives from NODE_ENV; featureEnabled derives from the
//     default-OFF C-02 flag. Both are dependency-injectable so tests need not mutate global env.
//   - The module registry is server-supplied via an injectable provider (default: EMPTY). M8D does NOT
//     import src/.../mockData.ts; a future milestone supplies the real registry. An empty registry
//     yields a safe emptyState DTO.
//   - Reads NOTHING live: no DB, Supabase, provider, fetch, getDb. Only the pure M8C/M8D modules.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { handleBcpC02RegistryReadinessRequest } from './bcpC02ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { C02RegistryModuleInput, C02SourceMode } from './bcpC02RegistryReadModel';

/** The DEV-only future route path on the ISOLATED platform API (NOT registered in M8D). */
export const BCP_C02_REGISTRY_READINESS_ROUTE_PATH = '/dev/bcp/registry-readiness';
/** The DEV-only future frontend proxy label (NOT wired in M8D). */
export const BCP_C02_REGISTRY_READINESS_PROXY_PATH = '/__identity/dev/bcp/registry-readiness';
/** Default-OFF feature flag name for the future C-02 route. */
export const BCP_C02_FEATURE_FLAG = 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS';

// FIXED synthetic, server-derived principal. Obvious fake placeholder id. M8D wires NO live session
// resolver — a later, separately-authorized milestone may replace this with a real principal.
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
export interface BcpC02HandlerDeps {
  /** Defaults to NODE_ENV !== 'production'. */
  isDevEnvironment?: () => boolean;
  /** Defaults to the default-OFF C-02 flag (env value === 'true'). */
  featureEnabled?: () => boolean;
  /** Server-supplied code/config module registry. Defaults to EMPTY (no src import in M8D). */
  getModules?: () => readonly C02RegistryModuleInput[];
  /** DTO mode. Defaults to code_config. */
  mode?: C02SourceMode;
}

/**
 * Build the Express handler for the inert C-02 registry-readiness route. Pure boundary: it resolves
 * server-side gate inputs + the server-supplied registry, calls the M8D handler, and serializes its
 * safe result. It adds NO authorization/redaction/mapper/business logic, and registers nothing.
 */
export function createBcpC02RegistryReadinessHandler(deps: BcpC02HandlerDeps = {}) {
  const resolveIsDev = deps.isDevEnvironment ?? (() => process.env.NODE_ENV !== 'production');
  const resolveFeatureEnabled = deps.featureEnabled ?? (() => process.env[BCP_C02_FEATURE_FLAG] === 'true');
  const resolveModules = deps.getModules ?? ((): readonly C02RegistryModuleInput[] => []);

  return (req: Request, res: Response): void => {
    try {
      // Server-derived gate inputs; never from the request.
      const isDevEnvironment = resolveIsDev();
      const featureEnabled = resolveFeatureEnabled();
      // GATES FIRST (defense-in-depth, mirrors the handler): only resolve the (possibly injected /
      // future-expensive) registry provider when DEV + enabled — never in production or flag-off.
      const modules = isDevEnvironment && featureEnabled ? resolveModules() : [];
      const result = handleBcpC02RegistryReadinessRequest({
        method: req.method,
        isDevEnvironment,
        featureEnabled,
        principal: SYNTHETIC_PRINCIPAL,
        // Server-supplied registry + mode; never mapped from untrusted request input.
        modules,
        mode: deps.mode,
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
      // Safe error at the transport edge: a dependency/serialization failure must never leak an
      // exception or stack trace to the Express default error handler.
      if (!res.headersSent) {
        res.status(500);
        res.json({ status: 'error' });
      }
    }
  };
}
