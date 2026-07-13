// Phase 3.0 M3 — Express adapter for the "Acknowledge Backend CP Readiness Review" controlled action.
//
// Gate 1 established GENUINE server-derived principal resolution (verified Firebase Bearer → read-only identity →
// read-only canonical authorization → the `bcpActionAuthorizationGuard` as FINAL authority). This milestone adds
// the hardening layers around it: a same-origin / CSRF request-security guard, a bounded process-local rate
// limiter (global ceiling + per-principal window), and a bounded, concurrency-safe idempotency store (replacing
// the M2 unbounded Set). NOTHING in the request is read as authority except the Bearer credential
// (cryptographically verified) and req.body (validated as untrusted data by the pure handler).
//
// ORDER (fail-closed): method/dev/flag gates (no Firebase/DB/origin/rate/idempotency work when flag OFF) →
// request-security guard (403 SAFE DENIED, before auth, no marker/rate/idempotency consumption) → GLOBAL
// rate-limit ceiling (429, caps unauthenticated floods) → verify Bearer (401) → read-only identity (403 unmapped
// / 5xx db) → read-only authz → translate → PER-PRINCIPAL rate-limit (429) → guard (deny ⇒ 403 SAFE DENIED, NO
// marker) → pure handler (body validation + bounded idempotency + exactly one advisory success marker).
//
// The rate limiter and idempotency store are keyed ONLY by a one-way fingerprint of the server-derived internal
// identity — never a raw token/UID/email/IP. This is the composition root: it wires the real (injectable)
// verify/lookup/authz seams and imports NO durable-audit writer, NO Supabase verifier; firebase-admin is pulled
// ONLY transitively via the dedicated adapter. Reads NOTHING durable beyond the authorized read-only queries.
//
// Server-side only. Never imported by src/ (the client bundle).

import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express'; // type-only: erased at runtime.
import { handleBcpActionAcknowledgeReadinessReview, BCP_ACTION_ACK_KEY } from './bcpActionAcknowledgeReadinessReview';
import { authorizeBcpAction } from './bcpActionAuthorizationGuard';
import { advisoryLogActionAuditSink, type BcpActionAuditSink } from './bcpActionAuditSink';
import { verifyFirebaseBearer, type FirebaseVerifyResult } from '../platform-identity/firebaseAdminAuthAdapter';
import { findInternalUserIdByProviderSubject, type ProviderSubjectLookupResult } from '../platform-identity/identityRepository';
import { resolveCanonicalPlatformAuthz } from './bcpActionCanonicalAuthzResolver';
import { resolveLiveBcpActionPrincipal, type CanonicalAuthzView } from './bcpActionLivePrincipalResolver';
import { evaluateRequestSecurity, readRequestSecurityInput, resolveTrustedOrigin, type TrustedOriginResolution } from './bcpActionRequestSecurityGuard';
import { BcpActionRateLimiter } from './bcpActionRateLimiter';
import { BcpActionIdempotencyStore } from './bcpActionIdempotencyStore';

/** The DEV-only controlled-action route path on the ISOLATED platform-identity API (POST only). */
export const BCP_ACTION_ACK_ROUTE_PATH = '/dev/bcp/actions/acknowledge-readiness-review';
/** The DEV-only same-origin frontend proxy path used by the browser client. */
export const BCP_ACTION_ACK_PROXY_PATH = '/__identity/dev/bcp/actions/acknowledge-readiness-review';
/** Default-OFF feature flag name for the controlled action. */
export const BCP_ACTION_ACK_FLAG = 'ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW';

export { BCP_ACTION_ACK_KEY };

/** Process-lifetime bounded idempotency store + rate limiter (DEV-only; no DB). Injectable for tests. */
const DEFAULT_IDEMPOTENCY_STORE = new BcpActionIdempotencyStore();
const DEFAULT_RATE_LIMITER = new BcpActionRateLimiter();

/** Per-process random salt so the principal fingerprint is one-way and not correlatable across processes. */
const PRINCIPAL_FP_SALT = randomBytes(16).toString('hex');
/** One-way fingerprint of the server-derived internal identity (never the raw id). */
function defaultFingerprintPrincipal(internalUserId: string): string {
  return createHash('sha256').update(`${PRINCIPAL_FP_SALT} ${internalUserId}`).digest('hex').slice(0, 32);
}

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
  /** Bounded idempotency store (default: a process-lifetime bounded store). */
  idempotencyStore?: BcpActionIdempotencyStore;
  /** Bounded rate limiter (default: a process-lifetime limiter). */
  rateLimiter?: BcpActionRateLimiter;
  /** One-way principal fingerprint fn (default: salted sha256). Injectable for deterministic tests. */
  fingerprintPrincipal?: (internalUserId: string) => string;
  /** Trusted development origin resolver (default: resolveTrustedOrigin(REPLIT_DEV_DOMAIN)). Injectable for tests. */
  trustedOrigin?: () => TrustedOriginResolution;
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
  const rateLimiter = deps.rateLimiter ?? DEFAULT_RATE_LIMITER;
  const fingerprintPrincipal = deps.fingerprintPrincipal ?? defaultFingerprintPrincipal;
  const resolveTrusted = deps.trustedOrigin ?? (() => resolveTrustedOrigin(process.env.REPLIT_DEV_DOMAIN));

  return (req: Request, res: Response): void => {
    void (async () => {
      try {
        const isDev = resolveIsDev();
        const flagOn = resolveFeatureEnabled();

        // 1. Method / dev / flag gates via the pure handler with a NULL principal. When not (POST && dev && flag),
        //    this returns 405/404 BEFORE any origin/rate/idempotency/Firebase/DB work.
        if (req.method !== 'POST' || !isDev || !flagOn) {
          const gated = handleBcpActionAcknowledgeReadinessReview({
            method: req.method, isDevEnvironment: isDev, featureEnabled: flagOn,
            principal: null, platformPermissionLevel: null, principalFingerprint: '', body: req.body, sink, idempotencyStore,
          });
          res.status(gated.httpStatus).json(gated.body);
          return;
        }

        // 2. Request-security guard (same-origin / CSRF, EXACT trusted-origin match) BEFORE auth. A denial is 403
        //    SAFE DENIED and consumes NO rate-limit slot, NO idempotency state, and emits NO marker. If the trusted
        //    origin cannot be resolved from REPLIT_DEV_DOMAIN, fail closed as 503 (no downstream work).
        const sec = evaluateRequestSecurity(readRequestSecurityInput(req.headers, req.method), resolveTrusted());
        if (!sec.ok) {
          if (sec.code === 'trusted_origin_unavailable') { res.status(503).json({ status: 'request_security_unavailable' }); return; }
          res.status(403).json({ status: 'request_denied' });
          return;
        }

        // 3. GLOBAL rate-limit ceiling (pre-auth) — caps unauthenticated floods regardless of principal.
        const globalCheck = rateLimiter.recordAndCheckGlobal();
        if (!globalCheck.allowed) {
          res.setHeader('Retry-After', String(globalCheck.retryAfterSeconds ?? 60));
          res.status(429).json({ status: 'rate_limited' });
          return;
        }

        // 4. Genuine principal resolution: verify Bearer → read-only identity → read-only authz → translate.
        const resolution = await resolveLiveBcpActionPrincipal(req.headers['authorization'], {
          verifyBearer, lookupInternalUserId, resolveCanonicalAuthz,
        });
        if (resolution.outcome === 'auth_failed') {
          if (resolution.authCode === 'authentication_unavailable') { res.status(503).json({ status: 'unavailable', reason: 'authentication_unavailable' }); return; }
          res.status(401).json({ status: 'unauthenticated', reason: resolution.authCode ?? 'authentication_required' });
          return;
        }
        if (resolution.outcome === 'resolver_error') { res.status(503).json({ status: 'unavailable', reason: 'resolver_unavailable' }); return; }
        if (resolution.outcome === 'unmapped' || !resolution.principal || !resolution.internalUserId) { res.status(403).json({ status: 'not_authorized' }); return; }

        // 5. PER-PRINCIPAL rate-limit (post-auth), keyed on a one-way fingerprint of the internal identity. The
        //    SAME fingerprint scopes the idempotency store below (no raw id ever leaves this line).
        const principalFingerprint = fingerprintPrincipal(resolution.internalUserId);
        const principalCheck = rateLimiter.recordAndCheckPrincipal(principalFingerprint);
        if (!principalCheck.allowed) {
          res.setHeader('Retry-After', String(principalCheck.retryAfterSeconds ?? 60));
          res.status(429).json({ status: 'rate_limited' });
          return;
        }

        // 6. Guard = FINAL authority. Deny/blocked ⇒ 403 SAFE DENIED, NO marker (pure handler NOT reached). We do
        //    not disclose whether the denial was mapping/role/permission/cap.
        const guard = authorizeBcpAction({
          actionKey: BCP_ACTION_ACK_KEY, isDevEnvironment: isDev, featureEnabled: flagOn,
          principal: resolution.principal, platformPermissionLevel: resolution.platformPermissionLevel ?? null,
          planReadOnly: resolution.planReadOnly, planOverdue: resolution.planOverdue,
        });
        if (guard.decision !== 'allow') { res.status(403).json({ status: 'not_authorized' }); return; }

        // 7. Authorized ⇒ pure handler: body validation (400 SAFE INVALID) + bounded idempotency (200 duplicate /
        //    409 conflict / 503 busy) + exactly one advisory success marker. The UNTRUSTED body is never authority.
        const result = handleBcpActionAcknowledgeReadinessReview({
          method: req.method, isDevEnvironment: isDev, featureEnabled: flagOn,
          principal: resolution.principal, platformPermissionLevel: resolution.platformPermissionLevel ?? null,
          planReadOnly: resolution.planReadOnly, planOverdue: resolution.planOverdue,
          principalFingerprint, body: req.body, sink, idempotencyStore,
        });
        res.status(result.httpStatus).json(result.body);
      } catch {
        if (!res.headersSent) { res.status(500); res.json({ status: 'error' }); }
      }
    })();
  };
}
