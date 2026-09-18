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
  invalidRequirement,
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

/**
 * The route's declared requirement, read ONCE when the route is defined: a frozen copy whose fields
 * have the declared types, or null. It decides nothing about vocabulary — the permission decision
 * checks every name and level against the catalog — but it is what turns a malformed declaration (an
 * unknown kind, a missing or non-string field, a getter that throws) into a denial on every request,
 * rather than a crash, a coercion, or a second read that answers differently.
 */
function readRequirement(required: unknown): RequiredPermission | null {
  try {
    if (typeof required !== 'object' || required === null || Array.isArray(required)) return null;
    const r = required as Record<string, unknown>;
    const kind = r.kind;
    if (kind === 'platform') {
      const { featureKey, threshold } = r;
      if (typeof featureKey !== 'string' || typeof threshold !== 'string') return null;
      return Object.freeze({ kind, featureKey, threshold: threshold as PermissionLevel });
    }
    if (kind === 'tenant') {
      const { domain, level } = r;
      if (typeof domain !== 'string' || typeof level !== 'string') return null;
      return Object.freeze({ kind, domain, level: level as PermissionLevel });
    }
    if (kind === 'sub') {
      const { subPermissionId, subDef } = r;
      if (typeof subPermissionId !== 'string' || typeof subDef !== 'object' || subDef === null || Array.isArray(subDef)) return null;
      const { parentDomain, minModuleLevel, defaultLevel, planAvailable } = subDef as Record<string, unknown>;
      if (typeof parentDomain !== 'string' || typeof minModuleLevel !== 'string'
        || typeof defaultLevel !== 'string' || typeof planAvailable !== 'boolean') return null;
      return Object.freeze({
        kind,
        subPermissionId,
        subDef: Object.freeze({
          parentDomain,
          minModuleLevel: minModuleLevel as PermissionLevel,
          defaultLevel: defaultLevel as PermissionLevel,
          planAvailable,
        }),
      });
    }
    return null; // an unknown kind names no plane
  } catch {
    return null;
  }
}

function requiredToString(required: RequiredPermission | null): string {
  if (required === null) return 'invalid_requirement';
  switch (required.kind) {
    case 'platform': return `${required.featureKey}:${required.threshold}`;
    case 'tenant': return `${required.domain}:${required.level}`;
    case 'sub': return `sub:${required.subPermissionId}`;
  }
}

const EVALUATION_FAILED: DecisionResult = Object.freeze({
  decision: 'deny',
  reasonCode: 'denied_evaluation_failed',
  humanReadableReason: 'The permission decision could not be evaluated.',
});

/** Never throws and never allows by default: a malformed requirement or context is a denial. */
function evaluate(ctx: RequestContext, required: RequiredPermission | null): DecisionResult {
  if (required === null) return invalidRequirement();
  try {
    switch (required.kind) {
      case 'platform': return requirePlatformPermission(ctx, required.featureKey, required.threshold);
      case 'tenant': return requireTenantPermission(ctx, required.domain, required.level);
      case 'sub': return requireSubPermission(ctx, required.subPermissionId, required.subDef);
      default: return invalidRequirement();
    }
  } catch {
    return EVALUATION_FAILED;
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
  const requirement = readRequirement(required);
  const requiredPermission = requiredToString(requirement);
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
    const result = evaluate(ctx, requirement);

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
