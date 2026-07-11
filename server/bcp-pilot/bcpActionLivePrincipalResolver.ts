// Phase 3.0 M3 Gate 1 — live-principal resolver: verified Firebase identity + canonical authorization →
// the existing BCP action-principal contract. PURE translation + a NO-THROW async orchestration over three
// INJECTED read-only dependencies (Firebase verify / identity lookup / canonical authz). It constructs NO
// authority from the request; every authority field is derived from the canonical authorization result. The
// existing `bcpActionAuthorizationGuard` remains the final allow/deny authority (run by the caller). The
// principal carries NO Firebase token, decoded claim, or email — only the durable app-owned internalUserId.
//
// Type-only imports of the identity/firebase adapters keep this module free of their runtime DB/firebase graph.
// Server-side only. Never imported by src/ (the client bundle).

import type { SyntheticServerPrincipal, BcpVisibilityClass } from './bcpAuthorizationGuard';
import type { ScopeType } from '../platform-identity/requestContext';
import type { PermissionLevelValue } from '../platform-identity/authorizationConstants';
import { PLATFORM_ORDERING } from '../platform-identity/permissionCatalog';
import type { FirebaseVerifyResult } from '../platform-identity/firebaseAdminAuthAdapter';
import type { ProviderSubjectLookupResult } from '../platform-identity/identityRepository';

/** The minimal, authority-neutral view of a canonical `AuthorizationResolverResult` this translator consumes. */
export interface CanonicalAuthzView {
  decision: 'allow' | 'deny';
  reasonCode: string;
  limitation: 'none' | 'read_only';
  platformRoleId: string | null;
  /** Canonical per-feature effective platform permissions (Record<featureKey, PermissionLevelValue>). */
  permissions: Record<string, string>;
  /** [userStatus, tenantStatus, storeStatus] with nulls dropped (used ONLY for the overdue cap signal). */
  statusValues: string[];
  scopeType: string;
}

export interface PrincipalTranslation {
  principal: SyntheticServerPrincipal;
  platformPermissionLevel: PermissionLevelValue | null;
  planReadOnly: boolean;
  planOverdue: boolean;
}

const KNOWN_SCOPES: readonly ScopeType[] = ['platform', 'tenant', 'store', 'none'];
/** Canonical deny reason-codes that mean "authorization could not be ESTABLISHED" (missing identity/membership/
 *  role/context) → parity 'unresolved'. Hard ACCOUNT/TENANT/STORE status blocks (e.g. denied_account_suspended,
 *  denied_account_pending_activation, denied_tenant_status, denied_store_status) fall through to 'blocked'.
 *  NOTE: this label is telemetry only — the guard treats EVERY non-'ready' parity identically (it blocks before
 *  visibility/permission), so the unresolved-vs-blocked split has no functional/security effect. Reconciled to the
 *  codes `resolveAuthorization` actually emits (service-layer-only codes removed). */
const UNRESOLVED_REASONS = new Set([
  'denied_no_app_user', 'denied_no_membership', 'denied_membership_not_active',
  'denied_unresolvable_role', 'denied_scope_context_invalid',
  'denied_tenant_missing', 'denied_store_missing', 'denied_store_tenant_mismatch',
]);

/** ONLY canonical `system_owner` maps to the strongest class; every other/unknown/missing role is insufficient. */
function deriveVisibility(platformRoleId: string | null): BcpVisibilityClass {
  if (platformRoleId === 'system_owner') return 'system_owner';
  return platformRoleId ? 'overview_viewer' : 'none';
}

/** Derived from canonical decision/reasonCode — never manufactured. Allow ⇒ ready; else unresolved/blocked. */
function deriveParity(decision: string, reasonCode: string): 'ready' | 'unresolved' | 'blocked' {
  if (decision === 'allow') return 'ready';
  if (UNRESOLVED_REASONS.has(reasonCode)) return 'unresolved';
  return 'blocked';
}

/**
 * Effective platform permission = the FLOOR (minimum) level across canonical platform features — derived from
 * canonical permission DATA, NEVER from the role name. Empty map or an unrecognized level ⇒ null (fail closed).
 * A genuine system_owner yields 'full' on every feature, so its floor is 'full'.
 */
function derivePlatformLevel(permissions: Record<string, string>): PermissionLevelValue | null {
  const values = Object.values(permissions ?? {});
  if (values.length === 0) return null;
  let minRank = Number.POSITIVE_INFINITY;
  let minLevel: PermissionLevelValue | null = null;
  for (const v of values) {
    const rank = PLATFORM_ORDERING.indexOf(v as PermissionLevelValue);
    if (rank < 0) return null; // unrecognized level ⇒ fail closed
    if (rank < minRank) { minRank = rank; minLevel = v as PermissionLevelValue; }
  }
  return minLevel;
}

/** Pure translation. Exhaustive + fail-closed. The guard makes the final decision from these outputs. */
export function translateToBcpActionPrincipal(internalUserId: string, authz: CanonicalAuthzView): PrincipalTranslation {
  const scopeType: ScopeType = (KNOWN_SCOPES as readonly string[]).includes(authz.scopeType) ? (authz.scopeType as ScopeType) : 'none';
  const principal: SyntheticServerPrincipal = {
    source: 'server_derived',
    internalUserId,
    authProvider: 'firebase',
    verified: true,
    scopeType,
    parityState: deriveParity(authz.decision, authz.reasonCode),
    visibilityClass: deriveVisibility(authz.platformRoleId),
  };
  return {
    principal,
    platformPermissionLevel: derivePlatformLevel(authz.permissions),
    planReadOnly: authz.limitation === 'read_only',
    planOverdue: Array.isArray(authz.statusValues) && authz.statusValues.includes('overdue'),
  };
}

// ---------------- orchestration ----------------

export interface LivePrincipalDeps {
  verifyBearer: (authorizationHeader: string | string[] | undefined) => Promise<FirebaseVerifyResult>;
  lookupInternalUserId: (authProvider: string, authProviderUid: string) => Promise<ProviderSubjectLookupResult>;
  /** Canonical read-only authorization for the resolved internalUserId. Returns null on resolution error. */
  resolveCanonicalAuthz: (internalUserId: string, firebaseUid: string) => Promise<CanonicalAuthzView | null>;
}

export interface LivePrincipalResolution {
  outcome: 'authenticated' | 'auth_failed' | 'unmapped' | 'resolver_error';
  authCode?: string;
  principal?: SyntheticServerPrincipal;
  platformPermissionLevel?: PermissionLevelValue | null;
  planReadOnly?: boolean;
  planOverdue?: boolean;
  internalUserId?: string;
}

/**
 * Ordered, fail-closed resolution: verify Firebase Bearer → read-only identity mapping → read-only canonical
 * authorization → translate. NEVER throws. Auth failure ⇒ 'auth_failed' (401); unmapped/ambiguous identity ⇒
 * 'unmapped' (403 SAFE DENIED); any DB/verifier/resolver error ⇒ 'resolver_error' (sanitized fail-closed). The
 * caller runs the guard on the returned principal for the FINAL allow/deny (a denial-shaped principal is still
 * returned as 'authenticated' so the guard — not this resolver — decides).
 */
export async function resolveLiveBcpActionPrincipal(
  authorizationHeader: string | string[] | undefined,
  deps: LivePrincipalDeps,
): Promise<LivePrincipalResolution> {
  const verified = await deps.verifyBearer(authorizationHeader).catch(() => ({ ok: false, code: 'authentication_unavailable' } as FirebaseVerifyResult));
  if (!verified.ok || !verified.firebaseUid) return { outcome: 'auth_failed', authCode: verified.code ?? 'authentication_invalid' };

  let lookup: ProviderSubjectLookupResult;
  try { lookup = await deps.lookupInternalUserId('firebase', verified.firebaseUid); }
  catch { return { outcome: 'resolver_error' }; }
  if (!lookup.ok || !lookup.internalUserId) {
    return { outcome: lookup.reason === 'db_error' ? 'resolver_error' : 'unmapped' };
  }

  let authz: CanonicalAuthzView | null;
  try { authz = await deps.resolveCanonicalAuthz(lookup.internalUserId, verified.firebaseUid); }
  catch { return { outcome: 'resolver_error' }; }
  if (!authz) return { outcome: 'resolver_error' };

  const t = translateToBcpActionPrincipal(lookup.internalUserId, authz);
  return {
    outcome: 'authenticated',
    principal: t.principal,
    platformPermissionLevel: t.platformPermissionLevel,
    planReadOnly: t.planReadOnly,
    planOverdue: t.planOverdue,
    internalUserId: lookup.internalUserId,
  };
}
