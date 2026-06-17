// Phase 1.5 M11.4 — Server-only Session Authorization Service (composition).
//
// PURPOSE: compose the already-proven durable authorization stack into ONE
// server-side path, WITHOUT wiring any HTTP route:
//   1. read durable identity/auth rows via the M11.2 read-only repository,
//   2. assemble the resolver input (buildResolverInputForContext),
//   3. derive the decision with the PURE M11 resolver (resolveAuthorization),
//   4. write a durable audit event via the M11.3 append-only writer,
//   5. return the resolved authorization ONLY when an allow is durably audited.
//
// FAIL-CLOSED (binding):
//   - The resolver runs first (pure, no I/O).
//   - A DENY may attempt a best-effort audit; an audit failure leaves it DENY
//     (deny is already the safe outcome).
//   - An ALLOW MUST be durably audited before it is returned. If the audit write
//     fails, the ALLOW is DOWNGRADED to a forced deny with authorization=null.
//     An UNAUDITED ALLOW IS NEVER RETURNED.
//
// ISOLATION (binding): server-side only — NEVER imported by src/ (the client
// bundle). Imports NO Express, NO frontend, NO sessionResolve, NO route/server
// registration. It registers NO route and changes NO runtime path:
// `/auth/session/resolve` STILL returns `authorization: null` (untouched here).
// It is consumed only by the M11.4 diagnostics and referenced by the M11.4 doc.
//
// SERVER-AUTHORITATIVE (binding): identity is selected ONLY by the durable,
// app-owned (auth_provider, auth_provider_uid) key. NOTHING here trusts a request
// body, a token's user_metadata, a JWT, or any client-asserted role/tenant/store/
// permission. It verifies NO token and reads NO secret.
//
// SAFETY: this module logs NOTHING (no console output) — it never prints the UID,
// email, DB URL, project ref, or any secret. It runs NO direct SQL (every read is
// through the repository; every write is through the audit writer) and contains
// no migration/seed/rollback logic and no Supabase MCP usage.

import { randomUUID } from 'crypto';
import {
  buildResolverInputForContext,
  getIdentityByProviderUid,
  getMembershipsForUser,
  type IdentityKey,
  type SqlExecutor,
} from './authorizationRepository';
import {
  resolveAuthorization,
  type AuthorizationResolverInput,
  type RequestedContext,
  type MembershipSnapshot,
  type ResolverDecision,
  type ResolverLimitation,
} from './authorizationResolver';
import {
  buildAuthorizationDecisionAuditEvent,
  writeAuditEvent,
  type AuditEventWriteInput,
  type WriteAuditEventOptions,
  type WrittenAuditEvent,
} from './auditEventWriter';
import type { AuthProviderValue } from './authorizationConstants';
import type { ServerDerivedAuthorizationV1 } from './authorizationContract';

// =============================================================================
// Stable service vocabulary
// =============================================================================

/** Action id for a server-derived authorization-decision evaluation. */
export const SESSION_AUTHZ_ACTION_ID = 'auth.authorization.decision_evaluated' as const;
/** The (abstract) permission this evaluation answers. */
export const SESSION_AUTHZ_REQUIRED_PERMISSION = 'session:authorization' as const;
/** Safe, allow-listed route/source label stored in audit metadata. */
export const SESSION_AUTHZ_ROUTE_LABEL = 'session-authorization-service' as const;
/** Reason code used when an ALLOW is downgraded because its audit could not be written. */
export const SESSION_AUTHZ_DENIED_AUDIT_FAILED = 'denied_audit_write_failed' as const;
/** Reason code used when no durable identity matches the supplied provider key. */
export const SESSION_AUTHZ_DENIED_NO_IDENTITY = 'denied_no_identity' as const;
/** Reason code used when no active membership yields a default context. */
export const SESSION_AUTHZ_DENIED_NO_DEFAULT_CONTEXT = 'denied_no_default_context' as const;

// =============================================================================
// Injectable seams (so diagnostics can prove behavior without a live DB)
// =============================================================================

/** The durable-read seam (defaults to the M11.2 repository). */
export type BuildResolverInputFn = (
  identityKey: IdentityKey,
  requestedContext: RequestedContext,
  executor?: SqlExecutor,
) => Promise<AuthorizationResolverInput | null>;

/** The durable-write seam (defaults to the M11.3 append-only writer). */
export type WriteAuditEventFn = (
  event: AuditEventWriteInput,
  options?: WriteAuditEventOptions,
) => Promise<WrittenAuditEvent>;

export interface SessionAuthorizationOptions {
  /** Optional shared executor / transaction handle (defaults to the repo/writer's getDb()). */
  executor?: SqlExecutor;
  /** Injectable durable-read seam (the live DB read by default). */
  buildResolverInput?: BuildResolverInputFn;
  /** Injectable durable-write seam (the live audit writer by default). */
  writeAuditEvent?: WriteAuditEventFn;
  /** Correlates the audit row; generated when omitted. */
  requestId?: string;
  traceId?: string | null;
}

// =============================================================================
// Result shape
// =============================================================================

export interface SessionAuthorizationResult {
  decision: ResolverDecision;
  reasonCode: string;
  humanReadableReason: string;
  authorization: ServerDerivedAuthorizationV1 | null;
  limitation: ResolverLimitation;
  /** True when a durable audit row was successfully written for this decision. */
  audited: boolean;
  /** True when the durable audit write was attempted and failed. */
  auditFailed: boolean;
  /** True when an ALLOW was downgraded to deny because its audit could not be written. */
  forcedDeny: boolean;
}

// =============================================================================
// Server-derived default context selection (platform-first)
// =============================================================================

/**
 * Choose a default requested context from durable membership rows, PLATFORM-FIRST:
 * prefer an active platform membership, else an active tenant membership, else an
 * active store membership. Returns null when no active membership yields a context.
 * Pure (no I/O); NEVER trusts a client-asserted role/scope claim.
 */
export function deriveDefaultRequestedContextFromMemberships(
  memberships: MembershipSnapshot[],
): RequestedContext | null {
  const platform = memberships.find((m) => m.scope_type === 'platform' && m.status === 'active');
  if (platform) return { scopeType: 'platform' };

  const tenant = memberships.find(
    (m) => m.scope_type === 'tenant' && m.status === 'active' && !!m.tenant_id,
  );
  if (tenant && tenant.tenant_id) return { scopeType: 'tenant', tenantId: tenant.tenant_id };

  const store = memberships.find(
    (m) => m.scope_type === 'store' && m.status === 'active' && !!m.tenant_id && !!m.store_id,
  );
  if (store && store.tenant_id && store.store_id) {
    return { scopeType: 'store', tenantId: store.tenant_id, storeId: store.store_id };
  }
  return null;
}

// =============================================================================
// Core: resolve + audit + fail-closed finalize
// =============================================================================

/**
 * A resolver-or-synthetic outcome. Identical to the resolver's result shape, but
 * with `reasonCode: string` so the service can attach its OWN reason codes (e.g.
 * `denied_no_identity`) without widening the resolver's narrow reason-code union.
 * `resolveAuthorization()`'s result is assignable to this (its reasonCode is a
 * string subtype).
 */
interface ResolverOutcome {
  authorization: ServerDerivedAuthorizationV1 | null;
  decision: ResolverDecision;
  reasonCode: string;
  humanReadableReason: string;
  limitation: ResolverLimitation;
}

function denyResult(reasonCode: string, humanReadableReason: string): ResolverOutcome {
  return { authorization: null, decision: 'deny', reasonCode, humanReadableReason, limitation: 'none' };
}

/**
 * Resolve server-derived authorization for ONE explicit requested context, then
 * durably audit the decision with fail-closed semantics (see file header).
 */
export async function resolveSessionAuthorizationForContext(
  identityKey: IdentityKey,
  requestedContext: RequestedContext,
  options: SessionAuthorizationOptions = {},
): Promise<SessionAuthorizationResult> {
  const buildInput = options.buildResolverInput ?? buildResolverInputForContext;
  const writeAudit = options.writeAuditEvent ?? writeAuditEvent;
  const requestId = options.requestId ?? randomUUID();
  const executor = options.executor;

  // 1) Assemble the resolver input from durable rows (read-only).
  const input = await buildInput(identityKey, requestedContext, executor);

  // 2) Derive the decision (pure) — or a synthetic deny when no identity matched.
  let result: ResolverOutcome;
  let actorInternalUserId: string | null;
  let actorAuthProvider: AuthProviderValue | null;
  if (!input) {
    result = denyResult(
      SESSION_AUTHZ_DENIED_NO_IDENTITY,
      'No durable identity matched the supplied provider key.',
    );
    actorInternalUserId = null;
    actorAuthProvider = null;
  } else {
    result = resolveAuthorization(input);
    actorInternalUserId = input.identity.internalUserId;
    actorAuthProvider = input.identity.authProvider;
  }

  // 3) Build the REDACTED durable audit event for this decision.
  const auditInput = buildAuthorizationDecisionAuditEvent({
    requestId,
    traceId: options.traceId ?? null,
    actorInternalUserId,
    actorAuthProvider,
    scopeType: requestedContext.scopeType,
    tenantId: requestedContext.tenantId ?? null,
    storeId: requestedContext.storeId ?? null,
    actionId: SESSION_AUTHZ_ACTION_ID,
    requiredPermission: SESSION_AUTHZ_REQUIRED_PERMISSION,
    decision: result.decision,
    reasonCode: result.reasonCode,
    humanReadableReason: result.humanReadableReason,
    resultStatus: result.decision === 'allow' ? 'succeeded' : 'failed',
    metadata: { route: SESSION_AUTHZ_ROUTE_LABEL, phase: 'phase-1.5-m11.4' },
  });

  // 4) Attempt the durable write. Never log the error (it may carry a host) — the
  //    outcome is reflected in the returned flags only.
  let audited = false;
  let auditFailed = false;
  try {
    await writeAudit(auditInput, { executor });
    audited = true;
  } catch {
    auditFailed = true;
  }

  // 5) FAIL-CLOSED: an ALLOW that could not be durably audited becomes a deny.
  if (result.decision === 'allow' && !audited) {
    return {
      decision: 'deny',
      reasonCode: SESSION_AUTHZ_DENIED_AUDIT_FAILED,
      humanReadableReason:
        'Authorization was allowed by the resolver but could not be durably audited; failing closed.',
      authorization: null,
      limitation: 'none',
      audited: false,
      auditFailed: true,
      forcedDeny: true,
    };
  }

  return {
    decision: result.decision,
    reasonCode: result.reasonCode,
    humanReadableReason: result.humanReadableReason,
    authorization: result.authorization,
    limitation: result.limitation,
    audited,
    auditFailed,
    forcedDeny: false,
  };
}

/**
 * Resolve authorization for the SERVER-DERIVED default context (platform-first):
 * read the identity + memberships, pick the default scope, then delegate to
 * resolveSessionAuthorizationForContext. Fails closed (deny) when no identity or
 * no active membership exists.
 */
export async function resolveDefaultSessionAuthorization(
  identityKey: IdentityKey,
  options: SessionAuthorizationOptions = {},
): Promise<SessionAuthorizationResult> {
  const executor = options.executor;

  const identity = await getIdentityByProviderUid(
    identityKey.authProvider,
    identityKey.authProviderUid,
    executor,
  );
  if (!identity) {
    return {
      decision: 'deny',
      reasonCode: SESSION_AUTHZ_DENIED_NO_IDENTITY,
      humanReadableReason: 'No durable identity matched the supplied provider key.',
      authorization: null,
      limitation: 'none',
      audited: false,
      auditFailed: false,
      forcedDeny: false,
    };
  }

  const memberships = await getMembershipsForUser(identity.internalUserId, executor);
  const requestedContext = deriveDefaultRequestedContextFromMemberships(memberships);
  if (!requestedContext) {
    return {
      decision: 'deny',
      reasonCode: SESSION_AUTHZ_DENIED_NO_DEFAULT_CONTEXT,
      humanReadableReason: 'No active membership yields a default authorization context.',
      authorization: null,
      limitation: 'none',
      audited: false,
      auditFailed: false,
      forcedDeny: false,
    };
  }

  return resolveSessionAuthorizationForContext(identityKey, requestedContext, options);
}
