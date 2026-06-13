// Phase 1.5 M2 — Protected-action wrapper (dev-only enforcement spine).
//
// Composes the spine for a single protected action:
//   gate(feature flag) → gate(dev diagnostics) → build request context →
//   permission decision → run handler (allow) / safe refusal (deny|deferred) →
//   emit advisory audit envelope (every decision path) → safe response.
//
// Deny by default at every step. No secrets or raw DB errors are returned to the
// caller. Server-side only. Never imported by src/.

import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { isPlatformIdentityEnabled } from './config';
import { safeLog, sanitizeError } from '../safe-log';
import { buildRequestContext, type PermissionLevel, type RequestContext } from './requestContext';
import {
  devDiagnosticAuthAdapter,
  stubFirebaseAuthAdapter,
  FirebaseVerificationNotImplementedError,
  FIREBASE_NOT_IMPLEMENTED,
  type AuthAdapter,
} from './authAdapter';
import {
  requirePlatformPermission,
  requireTenantPermission,
  requireSubPermission,
  type DecisionResult,
  type SubPermissionContext,
} from './permissionDecision';
import { buildAuditEnvelope, emitAuditEnvelope, EVALUATED_BY } from './auditEnvelope';

/**
 * The dev-diagnostics guard. M2 diagnostics require BOTH the platform-identity
 * feature flag (checked separately by the wrapper) AND this explicit, separate
 * opt-in, AND a non-production process. Default is OFF.
 *
 * Conservative on purpose: NEVER rely on NODE_ENV alone. All three of
 * { NODE_ENV !== 'production', PLATFORM_IDENTITY_DEV_DIAGNOSTICS === 'true',
 *   ENABLE_SUPABASE_PLATFORM_IDENTITY === 'true' } must hold for the route to do
 * anything. This function covers the first two; the wrapper enforces the flag.
 */
export function isDevDiagnosticsEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.PLATFORM_IDENTITY_DEV_DIAGNOSTICS !== 'true') return false;
  return true;
}

export type RequiredPermission =
  | { kind: 'platform'; featureKey: string; threshold: PermissionLevel }
  | { kind: 'tenant'; domain: string; level: PermissionLevel }
  | { kind: 'sub'; subPermissionId: string; subDef: SubPermissionContext };

export type SafeResult = Record<string, unknown>;

export type ProtectedHandler = (ctx: RequestContext) => Promise<SafeResult> | SafeResult;

function requiredToString(required: RequiredPermission): string {
  switch (required.kind) {
    case 'platform': return `${required.featureKey}:${required.threshold}`;
    case 'tenant': return `${required.domain}:${required.level}`;
    case 'sub': return `sub:${required.subPermissionId}`;
  }
}

function evaluate(ctx: RequestContext, required: RequiredPermission): DecisionResult {
  switch (required.kind) {
    case 'platform': return requirePlatformPermission(ctx, required.featureKey, required.threshold);
    case 'tenant': return requireTenantPermission(ctx, required.domain, required.level);
    case 'sub': return requireSubPermission(ctx, required.subPermissionId, required.subDef);
  }
}

/** 401 for unauthenticated, 403 for an authenticated-but-unauthorized deny. */
function statusForDeny(reasonCode: string): number {
  return reasonCode === 'denied_unauthenticated' ? 401 : 403;
}

/**
 * Wrap a handler so it only runs when the actor is authorized. Returns an
 * Express request handler. The route stays diagnostic-only and dev-only.
 */
export function withProtectedAction(
  actionId: string,
  required: RequiredPermission,
  handler: ProtectedHandler,
) {
  return async (req: Request, res: Response): Promise<void> => {
    // --- Gate 1: feature flag (default OFF) ---
    if (!isPlatformIdentityEnabled()) {
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Platform identity is disabled.' } });
      return;
    }
    // --- Gate 2: explicit dev-diagnostics opt-in (default OFF; never in prod) ---
    if (!isDevDiagnosticsEnabled()) {
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Diagnostics are disabled.' } });
      return;
    }

    const requestId = randomUUID();
    const requiredPermission = requiredToString(required);

    // --- Select the auth adapter. Dev assertion by default; the stub Firebase
    //     verifier can be selected (dev) to demonstrate the not-implemented seam. ---
    const useStub = !!(req.body && (req.body as Record<string, unknown>).verifier === 'stub-firebase');
    const adapter: AuthAdapter = useStub ? stubFirebaseAuthAdapter : devDiagnosticAuthAdapter;

    // --- Build the request context (deny-by-default on any failure) ---
    let ctx: RequestContext;
    try {
      const assertion = await adapter.verify(req);
      ctx = await buildRequestContext(requestId, assertion);
    } catch (err) {
      // The stub Firebase verifier lands here: respond truthfully (deferred),
      // never a silent allow.
      const isNotImplemented = err instanceof FirebaseVerificationNotImplementedError;
      const reasonCode = isNotImplemented ? FIREBASE_NOT_IMPLEMENTED : 'auth_adapter_error';
      if (!isNotImplemented) safeLog.error('[platform-identity] M2 auth adapter error', sanitizeError(err));
      emitAuditEnvelope(buildAuditEnvelope({
        requestId,
        actionId,
        actorId: null,
        scope: { scopeType: 'none', tenantId: null, storeId: null, platformScope: false },
        requiredPermission,
        decision: 'deferred',
        reasonCode,
        humanReadableReason: isNotImplemented
          ? 'Firebase verification is not implemented in M2.'
          : 'Auth adapter failed to produce an assertion.',
      }));
      res.status(isNotImplemented ? 501 : 500).json({ requestId, actionId, decision: 'deferred', reasonCode });
      return;
    }

    // --- Permission decision ---
    const result = evaluate(ctx, required);

    // --- Emit advisory audit envelope (every decision path: allow AND deny) ---
    emitAuditEnvelope(buildAuditEnvelope({
      requestId,
      actionId,
      actorId: ctx.actor.internalUserId,
      scope: ctx.scope,
      requiredPermission,
      decision: result.decision,
      reasonCode: result.reasonCode,
      humanReadableReason: result.humanReadableReason,
    }));

    if (result.decision !== 'allow') {
      // Safe, generic refusal — no leakage of "why" beyond a stable reason code.
      const status = result.decision === 'deferred' ? 501 : statusForDeny(result.reasonCode);
      res.status(status).json({ requestId, actionId, decision: result.decision, reasonCode: result.reasonCode });
      return;
    }

    // --- Authorized: run the (no-business-effect) handler ---
    try {
      const handlerResult = await handler(ctx);
      res.status(200).json({
        requestId,
        actionId,
        decision: 'allow',
        evaluatedBy: EVALUATED_BY,
        ...handlerResult,
      });
    } catch (err) {
      safeLog.error('[platform-identity] M2 protected handler error', sanitizeError(err));
      res.status(500).json({ requestId, actionId, error: { code: 'HANDLER_ERROR', message: 'Action failed.' } });
    }
  };
}
