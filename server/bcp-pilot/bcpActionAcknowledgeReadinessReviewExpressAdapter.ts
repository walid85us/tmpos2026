// Phase 3.0 M3 Gate 1 — Express adapter for the "Acknowledge Backend CP Readiness Review" controlled action.
//
// WHAT CHANGED FROM M2: the FIXED SYNTHETIC principal is GONE. The mounted route now resolves a GENUINE,
// server-derived principal from a verified Firebase ID token (Authorization: Bearer), a READ-ONLY identity
// lookup, and READ-ONLY canonical authorization — then the existing `bcpActionAuthorizationGuard` is the FINAL
// authority. NOTHING in the request is read as authority except the Bearer credential (cryptographically
// verified) and req.body (validated as untrusted data by the pure handler).
//
// ORDER (fail-closed): method/dev/flag gates (no Firebase/DB when flag OFF) → verify Bearer (401) → read-only
// identity (403 unmapped / 5xx db) → read-only authz → translate → guard (deny ⇒ 403 SAFE DENIED, NO marker) →
// pure handler (body validation + idempotency + exactly one advisory success marker). No privileged fallback.
//
// This is the composition root: it wires the real (injectable) verify/lookup/authz seams. It imports NO
// durable-audit writer, NO Supabase verifier, and firebase-admin ONLY transitively via the dedicated adapter.
// Reads NOTHING durable itself beyond the authorized read-only identity/authorization queries.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { handleBcpActionAcknowledgeReadinessReview, BCP_ACTION_ACK_KEY } from './bcpActionAcknowledgeReadinessReview';
import { authorizeBcpAction } from './bcpActionAuthorizationGuard';
import { advisoryLogActionAuditSink, type BcpActionAuditSink } from './bcpActionAuditSink';
import { verifyFirebaseBearer, type FirebaseVerifyResult } from '../platform-identity/firebaseAdminAuthAdapter';
import { findInternalUserIdByProviderSubject, type ProviderSubjectLookupResult } from '../platform-identity/identityRepository';
import { resolveCanonicalPlatformAuthz } from './bcpActionCanonicalAuthzResolver';
import { resolveLiveBcpActionPrincipal, type CanonicalAuthzView } from './bcpActionLivePrincipalResolver';

/** The DEV-only controlled-action route path on the ISOLATED platform-identity API (POST only). */
export const BCP_ACTION_ACK_ROUTE_PATH = '/dev/bcp/actions/acknowledge-readiness-review';
/** The DEV-only same-origin frontend proxy path (reserved for the later UI milestone). */
export const BCP_ACTION_ACK_PROXY_PATH = '/__identity/dev/bcp/actions/acknowledge-readiness-review';
/** Default-OFF feature flag name for the controlled action. */
export const BCP_ACTION_ACK_FLAG = 'ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW';

export { BCP_ACTION_ACK_KEY };

/** Process-lifetime in-memory idempotency store (DEV-only; no DB). Injectable for tests. */
const DEFAULT_IDEMPOTENCY_STORE = new Set<string>();

/** Injectable dependencies — all default to safe, server-derived, default-off, read-only behavior. */
export interface BcpActionAckHandlerDeps {
  /** Defaults to NODE_ENV !== 'production'. */
  isDevEnvironment?: () => boolean;
  /** Defaults to the default-OFF action flag (env value === 'true'). Boolean GATE only. */
  featureEnabled?: () => boolean;
  /** Firebase Bearer verifier (default: real firebase-admin lazy verifier). */
  verifyBearer?: (authorizationHeader: string | string[] | undefined) => Promise<FirebaseVerifyResult>;
  /** Read-only (provider, subject) → internalUserId lookup (default: identityRepository). */
  lookupInternalUserId?: (authProvider: string, authProviderUid: string) => Promise<ProviderSubjectLookupResult>;
  /** Read-only canonical platform authorization (default: bcpActionCanonicalAuthzResolver). */
  resolveCanonicalAuthz?: (internalUserId: string, firebaseUid: string) => Promise<CanonicalAuthzView | null>;
  /** Advisory audit sink (default: the DEV-only advisory log sink; never durable). */
  sink?: BcpActionAuditSink;
  /** Idempotency store (default: a process-lifetime in-memory Set). */
  idempotencyStore?: Set<string>;
}

/**
 * Build the Express handler for the controlled acknowledgement. Async, fail-closed, no-throw (safe 500 at the
 * edge). Resolves a genuine server-derived principal, runs the guard as final authority, and only then invokes
 * the pure handler. Reads NO authority from the request except the verified Bearer credential.
 */
export function createBcpActionAcknowledgeReadinessReviewHandler(deps: BcpActionAckHandlerDeps = {}) {
  const resolveIsDev = deps.isDevEnvironment ?? (() => process.env.NODE_ENV !== 'production');
  const resolveFeatureEnabled = deps.featureEnabled ?? (() => process.env[BCP_ACTION_ACK_FLAG] === 'true');
  const verifyBearer = deps.verifyBearer ?? ((h) => verifyFirebaseBearer(h));
  const lookupInternalUserId = deps.lookupInternalUserId ?? ((p, u) => findInternalUserIdByProviderSubject(p, u));
  const resolveCanonicalAuthz = deps.resolveCanonicalAuthz ?? ((_iu, uid) => resolveCanonicalPlatformAuthz(uid));
  const sink = deps.sink ?? advisoryLogActionAuditSink;
  const idempotencyStore = deps.idempotencyStore ?? DEFAULT_IDEMPOTENCY_STORE;

  return (req: Request, res: Response): void => {
    void (async () => {
      try {
        const isDev = resolveIsDev();
        const flagOn = resolveFeatureEnabled();

        // 1. Method / dev / flag gates via the pure handler with a NULL principal. When not (POST && dev && flag),
        //    this returns 405/404 BEFORE any Firebase init, token verification, or DB query.
        if (req.method !== 'POST' || !isDev || !flagOn) {
          const gated = handleBcpActionAcknowledgeReadinessReview({
            method: req.method, isDevEnvironment: isDev, featureEnabled: flagOn,
            principal: null, platformPermissionLevel: null, body: req.body, sink, idempotencyStore,
          });
          res.status(gated.httpStatus).json(gated.body);
          return;
        }

        // 2. Genuine principal resolution: verify Bearer → read-only identity → read-only authz → translate.
        const resolution = await resolveLiveBcpActionPrincipal(req.headers['authorization'], {
          verifyBearer, lookupInternalUserId, resolveCanonicalAuthz,
        });
        if (resolution.outcome === 'auth_failed') {
          if (resolution.authCode === 'authentication_unavailable') { res.status(503).json({ status: 'unavailable', reason: 'authentication_unavailable' }); return; }
          res.status(401).json({ status: 'unauthenticated', reason: resolution.authCode ?? 'authentication_required' });
          return;
        }
        if (resolution.outcome === 'resolver_error') { res.status(503).json({ status: 'unavailable', reason: 'resolver_unavailable' }); return; }
        if (resolution.outcome === 'unmapped' || !resolution.principal) { res.status(403).json({ status: 'not_authorized' }); return; }

        // 3. Guard = FINAL authority. Deny/blocked ⇒ 403 SAFE DENIED, NO marker (pure handler NOT reached). We do
        //    not disclose whether the denial was mapping/role/permission/cap.
        const guard = authorizeBcpAction({
          actionKey: BCP_ACTION_ACK_KEY, isDevEnvironment: isDev, featureEnabled: flagOn,
          principal: resolution.principal, platformPermissionLevel: resolution.platformPermissionLevel ?? null,
          planReadOnly: resolution.planReadOnly, planOverdue: resolution.planOverdue,
        });
        if (guard.decision !== 'allow') { res.status(403).json({ status: 'not_authorized' }); return; }

        // 4. Authorized ⇒ pure handler: body validation (400 SAFE INVALID) + idempotency + exactly one advisory
        //    success marker (or SAFE DUPLICATE). The UNTRUSTED body is validated here; it is never authority.
        const result = handleBcpActionAcknowledgeReadinessReview({
          method: req.method, isDevEnvironment: isDev, featureEnabled: flagOn,
          principal: resolution.principal, platformPermissionLevel: resolution.platformPermissionLevel ?? null,
          planReadOnly: resolution.planReadOnly, planOverdue: resolution.planOverdue,
          body: req.body, sink, idempotencyStore,
        });
        res.status(result.httpStatus).json(result.body);
      } catch {
        if (!res.headersSent) { res.status(500); res.json({ status: 'error' }); }
      }
    })();
  };
}
