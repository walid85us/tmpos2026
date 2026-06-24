// Phase 2.0 M7G — Thin Express adapter that registers the inert M7E BCP read-only handler.
//
// WHAT THIS IS: the smallest possible HTTP boundary that translates an Express request into the
// pure M7E transport-agnostic input, calls handleBcpReadinessSummaryRequest, and writes its safe
// response. It adds NO business/authorization/redaction/mapper logic of its own.
//
// SAFETY (binding):
//   - Authority is server-constructed only: a FIXED SYNTHETIC principal (no live session resolver,
//     per the M7F plan). Nothing from the request (UID/email/body/query) is ever read as authority.
//   - The envelope-shaping inputs (syntheticSource/generatedAt/environment) are server-constructed,
//     NEVER mapped from the request (honors the handler's FORWARD-GUARD).
//   - DEV-only + default-off: isDevEnvironment is derived server-side from NODE_ENV; featureEnabled
//     comes from the production-disabled M7C flag helper. Off/production ⇒ uniform unavailable.
//   - Reads NOTHING live: no DB, Supabase, provider, fetch. Only the pure M7C/M7E modules.
//
// Server-side only. Mounted only on the ISOLATED platform-identity API (its own port, run via
// `npm run identity:api`), never on the SaaS app, never in the client bundle.

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { isBcpDevReadonlyPilotEnabled } from './bcpPilotConfig';
import { handleBcpReadinessSummaryRequest } from './bcpReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { SyntheticReadinessSource } from './bcpReadinessSummaryHarness';

/** The DEV-only route path on the ISOLATED platform API (never the SaaS app). */
export const BCP_READINESS_ROUTE_PATH = '/dev/bcp/readiness-summary';

// FIXED synthetic, server-derived principal. Obvious fake placeholder id. M7G wires NO live session
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

// Server-constructed synthetic posture source (never from the request).
const SYNTHETIC_SOURCE: SyntheticReadinessSource = {
  categories: [{ category: 'readiness_posture', status: 'synthetic_ok', severity: 'low' }],
};

/**
 * Build the Express handler for the inert BCP readiness-summary route. Pure boundary: it only
 * resolves the server-side gate inputs, calls the M7E handler, and serializes its safe result.
 */
export function createBcpReadinessSummaryHandler() {
  return (req: Request, res: Response): void => {
    const result = handleBcpReadinessSummaryRequest({
      method: req.method,
      // Server-derived; never from the request. The flag helper is independently production-disabled.
      isDevEnvironment: process.env.NODE_ENV !== 'production',
      featureEnabled: isBcpDevReadonlyPilotEnabled(),
      principal: SYNTHETIC_PRINCIPAL,
      syntheticSource: SYNTHETIC_SOURCE,
      // generatedAt/environment intentionally omitted → the handler uses safe server-side defaults.
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
  };
}
