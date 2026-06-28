// Phase 2.0 M17 — Thin Express adapter for the inert C-05 feature-flag-posture route handler.
//
// WHAT THIS IS: the smallest possible HTTP boundary that translates an Express request into the pure C-05
// transport-agnostic input, calls handleBcpC05FeatureFlagPostureRequest, and writes its safe response.
// Adds NO business/authorization/redaction/mapper logic. Mirrors the frozen C-02/C-03/C-04 adapters.
//
// SAFETY (binding):
//   - Authority is server-constructed only: a FIXED SYNTHETIC principal (no live session resolver).
//     Nothing from the request (UID/email/body/query/headers/cookies/params) is read as authority.
//   - DEV-only + default-off: isDevEnvironment from NODE_ENV; featureEnabled from the default-OFF C-05
//     flag. Both dependency-injectable so tests need not mutate global env. The flag read is a boolean
//     GATE only — its value is NEVER surfaced as data (no value oracle).
//   - The posture registry is server-supplied via an injectable provider (default: EMPTY). Does NOT import
//     src/.../mockData.ts. Gates-first: provider resolved ONLY when DEV + enabled.
//   - Reads NOTHING live; no DB/Supabase/getDb/fetch; NO process.env enumeration; NO env value output.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { handleBcpC05FeatureFlagPostureRequest } from './bcpC05ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { C05FeatureFlagPostureEntryInput } from './bcpC05FeatureFlagPostureReadModel';

/** The DEV-only C-05 route path on the ISOLATED platform-identity API. */
export const BCP_C05_FEATURE_FLAG_POSTURE_ROUTE_PATH = '/dev/bcp/feature-flag-posture-readiness';
/** The DEV-only C-05 frontend proxy label. */
export const BCP_C05_FEATURE_FLAG_POSTURE_PROXY_PATH = '/__identity/dev/bcp/feature-flag-posture-readiness';
/** Default-OFF feature flag name for the C-05 route. */
export const BCP_C05_FEATURE_FLAG = 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS';

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
export interface BcpC05HandlerDeps {
  /** Defaults to NODE_ENV !== 'production'. */
  isDevEnvironment?: () => boolean;
  /** Defaults to the default-OFF C-05 flag (env value === 'true'). Boolean GATE only; never surfaced. */
  featureEnabled?: () => boolean;
  /** Server-supplied code/config feature-flag posture registry. Defaults to EMPTY (no src import, no env read). */
  getFeatureFlagPostureEntries?: () => readonly C05FeatureFlagPostureEntryInput[];
}

/**
 * Build the Express handler for the inert C-05 feature-flag-posture route. Pure boundary: it resolves
 * server-side gate inputs + the server-supplied registry, calls the C-05 handler, and serializes its safe
 * result. Adds NO authorization/redaction/mapper/business logic, registers nothing, reads no env for output.
 */
export function createBcpC05FeatureFlagPostureReadinessHandler(deps: BcpC05HandlerDeps = {}) {
  const resolveIsDev = deps.isDevEnvironment ?? (() => process.env.NODE_ENV !== 'production');
  const resolveFeatureEnabled = deps.featureEnabled ?? (() => process.env[BCP_C05_FEATURE_FLAG] === 'true');
  const resolveEntries = deps.getFeatureFlagPostureEntries ?? ((): readonly C05FeatureFlagPostureEntryInput[] => []);

  return (req: Request, res: Response): void => {
    try {
      // Server-derived gate inputs; never from the request. The flag boolean is a GATE, never output.
      const isDevEnvironment = resolveIsDev();
      const featureEnabled = resolveFeatureEnabled();
      // GATES FIRST (defense-in-depth): resolve the registry provider ONLY when DEV + enabled.
      const entries = isDevEnvironment && featureEnabled ? resolveEntries() : [];
      const result = handleBcpC05FeatureFlagPostureRequest({
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
