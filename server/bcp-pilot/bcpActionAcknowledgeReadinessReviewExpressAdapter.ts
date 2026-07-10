// Phase 3.0 M2 — Thin Express adapter for the "Acknowledge Backend CP Readiness Review" controlled action.
//
// WHAT THIS IS: the smallest possible HTTP boundary that translates an Express POST into the pure handler
// input, calls handleBcpActionAcknowledgeReadinessReview, and writes its safe response. Adds NO
// authorization/validation/audit logic. Mirrors the frozen C-02..C-07 read adapters, but POST-only.
//
// SAFETY (binding):
//   - Authority is server-constructed only: a FIXED SYNTHETIC system_owner principal + server-supplied
//     platform `manage` level (no live session resolver). NOTHING from the request (headers/cookies/query/
//     params, or any body actor/role/permission field) is read as authority — only req.body is passed as the
//     UNTRUSTED data the pure handler validates, and only req.method for the method gate.
//   - DEV-only + default-off: isDevEnvironment from NODE_ENV; featureEnabled from the default-OFF flag. Both
//     dependency-injectable so tests need not mutate global env. The flag read is a boolean GATE only.
//   - The advisory audit sink and the idempotency store are injectable; the runtime defaults are the DEV-only
//     advisory log sink and an in-memory Set — NEVER a durable DB/Supabase/provider sink.
//   - Reads NOTHING live; no DB/Supabase/getDb/fetch; NO env enumeration; NO log/test/scan/package read.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { PermissionLevelValue } from '../platform-identity/authorizationConstants';
import { handleBcpActionAcknowledgeReadinessReview, BCP_ACTION_ACK_KEY } from './bcpActionAcknowledgeReadinessReview';
import { advisoryLogActionAuditSink, type BcpActionAuditSink } from './bcpActionAuditSink';

/** The DEV-only controlled-action route path on the ISOLATED platform-identity API (POST only). */
export const BCP_ACTION_ACK_ROUTE_PATH = '/dev/bcp/actions/acknowledge-readiness-review';
/** The DEV-only frontend proxy label (reserved for a future client/UI milestone). */
export const BCP_ACTION_ACK_PROXY_PATH = '/__identity/dev/bcp/actions/acknowledge-readiness-review';
/** Default-OFF feature flag name for the controlled action. */
export const BCP_ACTION_ACK_FLAG = 'ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW';

export { BCP_ACTION_ACK_KEY };

// FIXED synthetic, server-derived principal: the action floor (system_owner). Obvious fake placeholder id.
// Wires NO live session resolver (a real per-user principal + permission resolver is a later milestone).
const SYNTHETIC_ACTION_PRINCIPAL: SyntheticServerPrincipal = {
  source: 'server_derived',
  internalUserId: 'iu_synthetic_dev',
  authProvider: 'supabase',
  verified: true,
  scopeType: 'platform',
  parityState: 'ready',
  visibilityClass: 'system_owner',
};

/** Process-lifetime in-memory idempotency store (DEV-only; no DB). Injectable for tests. */
const DEFAULT_IDEMPOTENCY_STORE = new Set<string>();

/** Injectable dependencies — all default to safe, server-derived, default-off behavior. */
export interface BcpActionAckHandlerDeps {
  /** Defaults to NODE_ENV !== 'production'. */
  isDevEnvironment?: () => boolean;
  /** Defaults to the default-OFF action flag (env value === 'true'). Boolean GATE only. */
  featureEnabled?: () => boolean;
  /** Server-derived principal (default: fixed synthetic system_owner). NEVER from the request. */
  principal?: () => SyntheticServerPrincipal | null;
  /** Server-resolved platform permission level (default: manage). NEVER from the request. */
  platformPermissionLevel?: () => PermissionLevelValue | null;
  planReadOnly?: () => boolean;
  planOverdue?: () => boolean;
  /** Advisory audit sink (default: the DEV-only advisory log sink; never durable). */
  sink?: BcpActionAuditSink;
  /** Idempotency store (default: a process-lifetime in-memory Set). */
  idempotencyStore?: Set<string>;
}

/**
 * Build the Express handler for the controlled acknowledgement action. Pure boundary: resolves server-side
 * gate inputs + the server-supplied principal/permission/sink/store, calls the pure handler, and serializes
 * its safe result. Reads NO authority from the request. Never throws (safe 500 at the edge).
 */
export function createBcpActionAcknowledgeReadinessReviewHandler(deps: BcpActionAckHandlerDeps = {}) {
  const resolveIsDev = deps.isDevEnvironment ?? (() => process.env.NODE_ENV !== 'production');
  const resolveFeatureEnabled = deps.featureEnabled ?? (() => process.env[BCP_ACTION_ACK_FLAG] === 'true');
  const resolvePrincipal = deps.principal ?? (() => SYNTHETIC_ACTION_PRINCIPAL);
  const resolvePermission = deps.platformPermissionLevel ?? ((): PermissionLevelValue => 'manage');
  const resolveReadOnly = deps.planReadOnly ?? (() => false);
  const resolveOverdue = deps.planOverdue ?? (() => false);
  const sink = deps.sink ?? advisoryLogActionAuditSink;
  const idempotencyStore = deps.idempotencyStore ?? DEFAULT_IDEMPOTENCY_STORE;

  return (req: Request, res: Response): void => {
    try {
      const result = handleBcpActionAcknowledgeReadinessReview({
        method: req.method,
        isDevEnvironment: resolveIsDev(),
        featureEnabled: resolveFeatureEnabled(),
        principal: resolvePrincipal(),
        platformPermissionLevel: resolvePermission(),
        planReadOnly: resolveReadOnly(),
        planOverdue: resolveOverdue(),
        // The UNTRUSTED request body — validated by the pure handler; never a source of authority.
        body: req.body,
        sink,
        idempotencyStore,
      });
      res.status(result.httpStatus).json(result.body);
    } catch {
      // Safe error at the transport edge: never leak an exception or stack trace.
      if (!res.headersSent) {
        res.status(500);
        res.json({ status: 'error' });
      }
    }
  };
}
