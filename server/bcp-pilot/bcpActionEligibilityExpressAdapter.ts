// Phase 3.0 M3 — Express adapter for the DEV-only, READ-ONLY controlled-action ELIGIBILITY probe.
//
// Answers "would the controlled-action guard ALLOW this principal now?" by running the EXACT server-authoritative
// chain used by the POST action — verify Firebase Bearer → read-only identity lookup → read-only canonical
// authorization → BCP principal translation → BCP action guard — and returning a BOUNDED { eligible, status }.
// It NEVER executes the action: it imports NO action handler, NO advisory audit sink, and NO idempotency store, so
// it cannot emit a marker, write an audit row, or consume idempotency state. The action key is a local literal
// (mirroring BCP_ACTION_ACK_KEY, which the guard uses only as a pinned telemetry label) precisely to keep this
// read probe out of the action's execution import graph.
//
// ORDER (fail-closed): method/dev/flag gate (404 unavailable — no origin/rate/auth/DB work) → request-security
// (EXACT trusted-origin + cross-site + dedicated eligibility intent; 403 request_denied / 503 unavailable) → empty
// body enforcement (400) → GLOBAL rate ceiling on a SEPARATE bounded limiter (429; NEVER the action limiter) →
// missing-Bearer check (401 authentication_required, before any verify) → read-only principal resolution → BCP
// action guard → bounded eligibility mapping. Every failure is sanitized: nothing about role/permission/parity/
// cap/identity/membership/claims/token/denial-stage is ever returned.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { authorizeBcpAction } from './bcpActionAuthorizationGuard';
import { verifyFirebaseBearer, type FirebaseVerifyResult } from '../platform-identity/firebaseAdminAuthAdapter';
import { findInternalUserIdByProviderSubject, type ProviderSubjectLookupResult } from '../platform-identity/identityRepository';
import { resolveCanonicalPlatformAuthz } from './bcpActionCanonicalAuthzResolver';
import { resolveLiveBcpActionPrincipal, type CanonicalAuthzView } from './bcpActionLivePrincipalResolver';
import { resolveTrustedOrigin, type TrustedOriginResolution } from './bcpActionRequestSecurityGuard';
import { BcpActionRateLimiter } from './bcpActionRateLimiter';
import {
  evaluateEligibilitySecurity,
  readEligibilitySecurityInput,
  eligibilityDecision,
  BCP_ELIGIBILITY_ROUTE_PATH,
} from './bcpActionEligibility';

export { BCP_ELIGIBILITY_ROUTE_PATH };

/** Default-OFF feature flag name — the SAME flag as the controlled action (one gate governs both surfaces). */
export const BCP_ELIGIBILITY_FLAG = 'ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW';
/** Pinned action key literal (mirrors BCP_ACTION_ACK_KEY; the guard reads it only as a telemetry label). Kept
 *  local so the read probe does NOT import the action handler module (side-effect boundary). */
const BCP_ACTION_ACK_KEY = 'bcp.action.acknowledge_readiness_review';

/** SEPARATE bounded rate limiter instance + keyspace — NEVER the action-execution limiter (§6 isolation). */
const DEFAULT_ELIGIBILITY_RATE_LIMITER = new BcpActionRateLimiter();

/** Injectable dependencies — all default to safe, server-derived, default-off, read-only behavior. */
export interface BcpActionEligibilityDeps {
  isDevEnvironment?: () => boolean;
  featureEnabled?: () => boolean;
  verifyBearer?: (authorizationHeader: string | string[] | undefined) => Promise<FirebaseVerifyResult>;
  lookupInternalUserId?: (authProvider: string, authProviderUid: string) => Promise<ProviderSubjectLookupResult>;
  resolveCanonicalAuthz?: (internalUserId: string, firebaseUid: string) => Promise<CanonicalAuthzView | null>;
  trustedOrigin?: () => TrustedOriginResolution;
  /** SEPARATE bounded rate limiter (default: a process-lifetime instance distinct from the action limiter). */
  rateLimiter?: BcpActionRateLimiter;
}

/** True only for a present, non-empty `Authorization: Bearer <token>` header. */
function hasBearer(authorizationHeader: string | string[] | undefined): boolean {
  return typeof authorizationHeader === 'string' && /^Bearer\s+\S/.test(authorizationHeader);
}

/**
 * Build the Express handler for the READ-ONLY eligibility probe. Async, fail-closed, no-throw (safe 503 at the
 * edge). Reads NO authority from the request except the verified Bearer credential; returns only { eligible, status }.
 */
export function createBcpActionEligibilityHandler(deps: BcpActionEligibilityDeps = {}) {
  const resolveIsDev = deps.isDevEnvironment ?? (() => process.env.NODE_ENV !== 'production');
  const resolveFeatureEnabled = deps.featureEnabled ?? (() => process.env[BCP_ELIGIBILITY_FLAG] === 'true');
  const verifyBearer = deps.verifyBearer ?? ((h) => verifyFirebaseBearer(h));
  const lookupInternalUserId = deps.lookupInternalUserId ?? ((p, u) => findInternalUserIdByProviderSubject(p, u));
  const resolveCanonicalAuthz = deps.resolveCanonicalAuthz ?? ((_iu, uid) => resolveCanonicalPlatformAuthz(uid));
  const resolveTrusted = deps.trustedOrigin ?? (() => resolveTrustedOrigin(process.env.REPLIT_DEV_DOMAIN));
  const rateLimiter = deps.rateLimiter ?? DEFAULT_ELIGIBILITY_RATE_LIMITER;

  return async (req: Request, res: Response): Promise<void> => {
    try {
      const isDev = resolveIsDev();
      const flagOn = resolveFeatureEnabled();

      // 1. Dev + flag gate. Flag OFF / production ⇒ 404 unavailable BEFORE any origin/rate/auth/DB work.
      if (!isDev || !flagOn) { res.status(404).json({ eligible: false, status: 'unavailable' }); return; }

      // 1b. Method contract: POST is the ONLY supported method. Registered via app.all so GET/PUT/PATCH/DELETE/…
      //     reach here and get the BOUNDED JSON 404 unavailable — side-effect-free, NO auth/authz work, and never
      //     Express's default HTML "Cannot GET". (The eligibility POST is a bodyless read-only RPC-style probe.)
      if (req.method !== 'POST') { res.status(404).json({ eligible: false, status: 'unavailable' }); return; }

      // 2. Request-security (same-origin / CSRF, EXACT trusted-origin, dedicated eligibility intent).
      const sec = evaluateEligibilitySecurity(readEligibilitySecurityInput(req.headers, req.method), resolveTrusted());
      if (!sec.ok) {
        if (sec.code === 'trusted_origin_unavailable') { res.status(503).json({ eligible: false, status: 'unavailable' }); return; }
        res.status(403).json({ eligible: false, status: 'request_denied' }); return;
      }

      // 3. The read probe accepts NO request body. Reject ANY present body — a non-empty object, an array, OR a
      //    JSON primitive (string/number/boolean). Only "no body" is allowed: undefined/null/empty-string/empty
      //    plain object. (The body is never read for authority regardless; this enforces the no-body contract.)
      const body = req.body as unknown;
      const isEmptyObject = body != null && typeof body === 'object' && !Array.isArray(body)
        && Object.keys(body as Record<string, unknown>).length === 0;
      const isNoBody = body === undefined || body === null || body === '' || isEmptyObject;
      if (!isNoBody) {
        res.status(400).json({ eligible: false, status: 'request_denied' }); return;
      }

      // 4. GLOBAL rate ceiling on the SEPARATE limiter (caps unauthenticated floods against Firebase verify).
      const globalCheck = rateLimiter.recordAndCheckGlobal();
      if (!globalCheck.allowed) {
        res.setHeader('Retry-After', String(globalCheck.retryAfterSeconds ?? 60));
        res.status(429).json({ eligible: false, status: 'rate_limited' }); return;
      }

      // 5. A missing credential is authentication_required — decided BEFORE any verify call.
      if (!hasBearer(req.headers['authorization'])) {
        res.status(401).json({ eligible: false, status: 'authentication_required' }); return;
      }

      // 6. Read-only principal resolution: verify Bearer → read-only identity → read-only canonical authz → translate.
      const resolution = await resolveLiveBcpActionPrincipal(req.headers['authorization'], {
        verifyBearer, lookupInternalUserId, resolveCanonicalAuthz,
      });

      // 7. Guard = the EXACT action guard, run WITHOUT invoking the action handler. Bounded mapping only.
      if (resolution.outcome === 'authenticated' && resolution.principal && resolution.internalUserId) {
        const guard = authorizeBcpAction({
          actionKey: BCP_ACTION_ACK_KEY, isDevEnvironment: isDev, featureEnabled: flagOn,
          principal: resolution.principal, platformPermissionLevel: resolution.platformPermissionLevel ?? null,
          planReadOnly: resolution.planReadOnly, planOverdue: resolution.planOverdue,
        });
        const decision = eligibilityDecision(resolution, guard.decision === 'allow');
        res.status(decision.httpStatus).json(decision.body); return;
      }

      const decision = eligibilityDecision(resolution, null);
      res.status(decision.httpStatus).json(decision.body);
    } catch {
      if (!res.headersSent) { res.status(503).json({ eligible: false, status: 'unavailable' }); }
    }
  };
}
