// Phase 1.5 M11 — Pure, INERT server-derived authorization resolver.
//
// Maps a SERVER-ASSEMBLED snapshot of durable rows (platform_identity-derived
// identity, app_user, user_membership[], tenant, store, tenant_feature_entitlement[])
// to the M9 `ServerDerivedAuthorizationV1` shape — WITHOUT any I/O.
//
// PURE / INERT (binding):
//   - No DB, no env, no network, no Express, no Supabase, no Firebase, no audit,
//     no side effects, no process.env. It imports ONLY inert M9 contract data/types
//     and the inert Phase 1.6 M1 permission catalog (server-only; itself imports
//     only the inert M9 constants + contract types) — the same import style M9 uses.
//   - Imported by NOTHING at runtime. NOT imported by sessionResolve.ts, the M7
//     route, the M8 pilot, or the client bundle. Consumed only by the M11 diagnostic
//     and referenced by the M11 doc. `/auth/session/resolve` STILL returns
//     `authorization: null`; this module does not change that.
//
// SERVER-AUTHORITATIVE (binding):
//   - Operates ONLY on the server-provided snapshot. It NEVER reads a request body,
//     a provider token's user_metadata, or any client-asserted role / permission /
//     entitlement / tenant / store. Reference identity fields (email/uid) are NEVER
//     authority.
//
// SECURITY (binding): references NO access token, refresh token, raw JWT, JWT
// payload, JWKS, service-role key, DB URL, connection string, or password. None is
// an input or an output of this resolver.
//
// PLATFORM-ROLE VOCABULARY (reconciled — Phase 1.5 M11.1 / Phase 1.6 M2): the
// CANONICAL durable platform `role_id` vocabulary is the SAME as the M9 contract +
// the live frontend engine:
//   system_owner | support_admin | billing_admin | operations_admin | security_admin.
// Migration 003 (`003_platform_role_vocabulary_alignment`) aligned the durable DB
// to this canonical vocabulary and is APPLIED TO DEV (production untouched; see
// docs/phase-1.5-milestone-11.1.1-dev-003-applied.md). The LEGACY 002 placeholder
// vocabulary (platform_owner | platform_admin | platform_ops | platform_support |
// platform_readonly) is SUPERSEDED. This resolver resolves canonical ids DIRECTLY
// (PLATFORM_ROLE_IDS) and keeps PLATFORM_ROLE_COMPAT_MAP only as a LEGACY-COMPAT
// FALLBACK for environments not yet confirmed on 003. By design:
//   - `platform_admin` / `platform_readonly` have NO honest canonical target
//     (ambiguous / status-modeled) and FAIL CLOSED (denied_unresolvable_role);
//   - `billing_admin` / `security_admin` are first-class canonical roles (no legacy
//     id, no compat entry) and resolve directly.
// An unresolvable platform role still FAILS CLOSED — the resolver never papers over
// a role it cannot honestly reconcile.

import {
  ACCOUNT_STATUS_VALUES,
  AUTHORIZATION_CONTRACT_VERSION,
  AUTHORIZATION_EVALUATED_BY,
  STATUS_DENY_BEFORE_ROLE,
  PLATFORM_ROLE_IDS,
  TENANT_ROLE_IDS,
} from './authorizationConstants';
import type {
  AccountStatusValue,
  MembershipStatusValue,
  AuthProviderValue,
  PlatformRoleId,
  TenantRoleId,
  UserType,
  ScopeTypeValue,
} from './authorizationConstants';
import type {
  ServerDerivedAuthorizationV1,
  FeatureEntitlements,
} from './authorizationContract';
// Phase 1.6 M1 — pure, inert, server-only permission/capability catalog. Fills
// the effective permissions/subPermissions on an ALLOW decision (deny path is
// untouched). The catalog performs no I/O and imports no frontend file.
import { materializeCapabilities } from './permissionCatalog';

// =============================================================================
// Input model (server-assembled snapshot — never client-asserted)
// =============================================================================

/** Server-verified identity (reference-only fields are NEVER authority). */
export interface ResolverIdentity {
  internalUserId: string;
  authProvider: AuthProviderValue;
  authProviderUid: string | null;
  email: string | null;
}

/** Durable app_user row (or null when no durable user exists yet). */
export interface AppUserSnapshot {
  internal_user_id: string;
  status: AccountStatusValue;
  display_name: string | null;
}

/** Durable user_membership row. role_id is the RAW durable text id. */
export interface MembershipSnapshot {
  membership_id: string;
  internal_user_id: string;
  tenant_id: string | null;
  store_id: string | null;
  scope_type: 'platform' | 'tenant' | 'store';
  role_id: string;
  status: MembershipStatusValue;
}

/** Durable tenant row. */
export interface TenantSnapshot {
  tenant_id: string;
  plan_key: string;
  status: AccountStatusValue;
}

/** Durable store row. */
export interface StoreSnapshot {
  store_id: string;
  tenant_id: string;
  status: AccountStatusValue;
}

/** Durable tenant_feature_entitlement row. */
export interface EntitlementSnapshot {
  tenant_id: string;
  feature_key: string;
  enabled: boolean;
  source: string;
}

/** The requested scope/context — SERVER-validated against memberships below. */
export interface RequestedContext {
  scopeType: 'platform' | 'tenant' | 'store';
  tenantId?: string | null;
  storeId?: string | null;
}

/** The full server-assembled snapshot the resolver consumes. */
export interface AuthorizationResolverInput {
  identity: ResolverIdentity;
  appUser: AppUserSnapshot | null;
  memberships: MembershipSnapshot[];
  tenant: TenantSnapshot | null;
  store: StoreSnapshot | null;
  entitlements: EntitlementSnapshot[];
  requestedContext: RequestedContext;
}

// =============================================================================
// Output model
// =============================================================================

export type ResolverDecision = 'allow' | 'deny';
export type ResolverLimitation = 'none' | 'read_only';

/**
 * Resolver-LOCAL reason codes (NOT part of — and NOT modifying — the M9
 * contracts). They surface why authorization was granted/limited/denied for the
 * diagnostic and a future audit writer.
 */
export const AUTHORIZATION_RESOLVER_REASON_CODES = {
  RESOLVED: 'resolved',
  RESOLVED_READ_ONLY: 'resolved_read_only',
  DENIED_NO_APP_USER: 'denied_no_app_user',
  DENIED_ACCOUNT_SUSPENDED: 'denied_account_suspended',
  DENIED_ACCOUNT_PENDING_ACTIVATION: 'denied_account_pending_activation',
  DENIED_SCOPE_CONTEXT_INVALID: 'denied_scope_context_invalid',
  DENIED_TENANT_MISSING: 'denied_tenant_missing',
  DENIED_TENANT_STATUS: 'denied_tenant_status',
  DENIED_STORE_MISSING: 'denied_store_missing',
  DENIED_STORE_TENANT_MISMATCH: 'denied_store_tenant_mismatch',
  DENIED_STORE_STATUS: 'denied_store_status',
  DENIED_NO_MEMBERSHIP: 'denied_no_membership',
  DENIED_MEMBERSHIP_NOT_ACTIVE: 'denied_membership_not_active',
  DENIED_UNRESOLVABLE_ROLE: 'denied_unresolvable_role',
  /** M5-GAP11-P1-R1: an account status outside the contract vocabulary is not "active". */
  DENIED_ACCOUNT_STATUS_UNRECOGNIZED: 'denied_account_status_unrecognized',
  /** M5-GAP11-P1-R1: two active memberships at one scope are two answers; neither is chosen. */
  DENIED_AMBIGUOUS_MEMBERSHIP: 'denied_ambiguous_membership',
} as const;

export type AuthorizationResolverReasonCode =
  (typeof AUTHORIZATION_RESOLVER_REASON_CODES)[keyof typeof AUTHORIZATION_RESOLVER_REASON_CODES];

export interface AuthorizationResolverResult {
  authorization: ServerDerivedAuthorizationV1 | null;
  decision: ResolverDecision;
  reasonCode: AuthorizationResolverReasonCode;
  humanReadableReason: string;
  /** Documents read-only limiting (read_only / overdue). Permission/sub-permission
   *  capping for this limitation is applied by the M1 permission catalog during
   *  materialization (write/manage/approve capped to view/false). */
  limitation: ResolverLimitation;
}

// =============================================================================
// Provisional, DOCUMENTED platform-role compatibility (unambiguous subset only)
// =============================================================================

/**
 * LEGACY-COMPAT FALLBACK only. Post-migration-003 the durable `role_id` IS already
 * the canonical contract id, which `resolvePlatformRoleId` resolves DIRECTLY before
 * ever consulting this map; this map exists purely to keep environments NOT YET
 * confirmed on 003 (e.g. production, which 003 has not touched) resolving the three
 * UNAMBIGUOUS legacy ids. The ambiguous `platform_admin` and the status-modeled
 * `platform_readonly` are intentionally OMITTED so they FAIL CLOSED, and the
 * canonical-only roles `billing_admin` / `security_admin` deliberately have NO
 * legacy entry (none exists). Do NOT add mappings for any of those four. This map
 * is slated for removal once all environments are confirmed on 003.
 */
export const PLATFORM_ROLE_COMPAT_MAP: Readonly<Record<string, PlatformRoleId>> = {
  platform_owner: 'system_owner',
  platform_support: 'support_admin',
  platform_ops: 'operations_admin',
};

const R = AUTHORIZATION_RESOLVER_REASON_CODES;

function resolvePlatformRoleId(rawRoleId: string): PlatformRoleId | null {
  if (typeof rawRoleId !== 'string') return null;
  if ((PLATFORM_ROLE_IDS as readonly string[]).includes(rawRoleId)) return rawRoleId as PlatformRoleId;
  // Own entries only: an inherited name ('constructor', '__proto__') is not a legacy role id.
  return Object.prototype.hasOwnProperty.call(PLATFORM_ROLE_COMPAT_MAP, rawRoleId)
    ? PLATFORM_ROLE_COMPAT_MAP[rawRoleId]
    : null;
}

function resolveTenantRoleId(rawRoleId: string): TenantRoleId | null {
  return typeof rawRoleId === 'string' && (TENANT_ROLE_IDS as readonly string[]).includes(rawRoleId)
    ? (rawRoleId as TenantRoleId)
    : null;
}

/**
 * 'deny' (suspended/pending_activation), 'read_only' (read_only/overdue), 'normal' (active/trialing),
 * or 'unrecognized' — any value outside the contract vocabulary, which every caller denies. It is not
 * silently 'normal': a status nobody can name grants nothing.
 */
function statusDisposition(status: AccountStatusValue): 'deny' | 'read_only' | 'normal' | 'unrecognized' {
  if (typeof status !== 'string' || !(ACCOUNT_STATUS_VALUES as readonly string[]).includes(status)) return 'unrecognized';
  if ((STATUS_DENY_BEFORE_ROLE as readonly AccountStatusValue[]).includes(status)) return 'deny';
  if (status === 'read_only' || status === 'overdue') return 'read_only';
  return 'normal';
}

/**
 * The one active membership among `ms`, or why there is not exactly one. The durable uniqueness
 * constraint includes `role_id`, so two active rows at one scope carry two different roles — ambiguous
 * authority this resolver does not choose between.
 */
function soleActive(ms: readonly MembershipSnapshot[]): MembershipSnapshot | 'none' | 'ambiguous' {
  const active = ms.filter((m) => m.status === 'active');
  if (active.length === 0) return 'none';
  return active.length === 1 ? active[0] : 'ambiguous';
}

function deny(reasonCode: AuthorizationResolverReasonCode, humanReadableReason: string): AuthorizationResolverResult {
  return { authorization: null, decision: 'deny', reasonCode, humanReadableReason, limitation: 'none' };
}

interface AllowParams {
  userType: UserType;
  scopeType: ScopeTypeValue;
  tenantId: string | null;
  storeId: string | null;
  platformRoleId: PlatformRoleId | null;
  tenantRoleId: TenantRoleId | null;
  userStatus: AccountStatusValue;
  tenantStatus: AccountStatusValue | null;
  storeStatus: AccountStatusValue | null;
  entitlements: FeatureEntitlements;
  limited: boolean;
}

function allow(p: AllowParams): AuthorizationResolverResult {
  // Phase 1.6 M1: materialize effective permissions/sub-permissions from the
  // shared server permission catalog. Cap-only: role grants are intersected with
  // plan/entitlement availability and read-only status — never expanded. Empty
  // maps occur ONLY when no role resolved (never reached here — allow() always
  // carries a resolved role), so an empty map is never interpreted as "full".
  const { permissions, subPermissions } = materializeCapabilities({
    platformRoleId: p.platformRoleId,
    tenantRoleId: p.tenantRoleId,
    entitlements: p.entitlements,
    limited: p.limited,
  });
  const authorization: ServerDerivedAuthorizationV1 = {
    authorizationVersion: AUTHORIZATION_CONTRACT_VERSION,
    userType: p.userType,
    scope: { scopeType: p.scopeType, tenantId: p.tenantId, storeId: p.storeId },
    roles: { platformRoleId: p.platformRoleId, tenantRoleId: p.tenantRoleId },
    status: { user: p.userStatus, tenant: p.tenantStatus, store: p.storeStatus },
    entitlements: p.entitlements,
    permissions,
    subPermissions,
    derivedBy: AUTHORIZATION_EVALUATED_BY,
  };
  return {
    authorization,
    decision: 'allow',
    reasonCode: p.limited ? R.RESOLVED_READ_ONLY : R.RESOLVED,
    humanReadableReason: p.limited
      ? 'Authorization resolved with read-only limiting (account/tenant/store is read_only or overdue).'
      : 'Authorization resolved from durable server-owned state.',
    limitation: p.limited ? 'read_only' : 'none',
  };
}

/** Enabled entitlements for the in-scope tenant only (disabled/other-tenant excluded). */
function entitlementsForTenant(rows: EntitlementSnapshot[], tenantId: string): FeatureEntitlements {
  const map: FeatureEntitlements = {};
  for (const e of rows) {
    if (e.tenant_id === tenantId && e.enabled === true) map[e.feature_key] = true;
  }
  return map;
}

// =============================================================================
// The resolver
// =============================================================================

/**
 * Resolve server-derived authorization from a server-assembled snapshot. Pure: no
 * I/O, no env, no side effects. Status precedence (deny statuses) runs BEFORE role
 * grants. Returns `authorization: null` on every denial.
 */
export function resolveAuthorization(input: AuthorizationResolverInput): AuthorizationResolverResult {
  const { identity, appUser, requestedContext } = input;

  // 0) app_user must exist and belong to the verified identity (fail closed). A missing id on both
  //    sides is not a match: `undefined === undefined` is no identity.
  // Every field below is read ONCE into a local, so a value cannot pass a check and then differ in use.
  const actorId = identity.internalUserId;
  if (!appUser || typeof actorId !== 'string' || actorId === '' || appUser.internal_user_id !== actorId) {
    return deny(R.DENIED_NO_APP_USER, 'No durable app_user for the verified identity.');
  }

  // 1) Account-status precedence — BEFORE any role grant.
  const userStatus = appUser.status;
  const userDisp = statusDisposition(userStatus);
  if (userDisp === 'unrecognized') {
    return deny(R.DENIED_ACCOUNT_STATUS_UNRECOGNIZED, 'Account status is not in the contract vocabulary.');
  }
  if (userDisp === 'deny') {
    if (userStatus === 'suspended') return deny(R.DENIED_ACCOUNT_SUSPENDED, 'Account is suspended.');
    return deny(R.DENIED_ACCOUNT_PENDING_ACTIVATION, 'Account is pending activation.');
  }

  // Defensive: only ever consider memberships belonging to this identity.
  const ownMemberships = input.memberships.filter((m) => m.internal_user_id === actorId);
  let userLimited = userDisp === 'read_only';

  // 2) Scope-specific resolution.
  if (requestedContext.scopeType === 'platform') {
    const platformMs = ownMemberships.filter((m) => m.scope_type === 'platform');
    const active = soleActive(platformMs);
    if (active === 'ambiguous') return deny(R.DENIED_AMBIGUOUS_MEMBERSHIP, 'More than one active platform membership.');
    if (active === 'none') {
      return platformMs.length
        ? deny(R.DENIED_MEMBERSHIP_NOT_ACTIVE, 'Platform membership is not active.')
        : deny(R.DENIED_NO_MEMBERSHIP, 'No platform membership.');
    }
    const platformRoleId = resolvePlatformRoleId(active.role_id);
    if (!platformRoleId) {
      return deny(R.DENIED_UNRESOLVABLE_ROLE, 'Platform role id is not reconcilable to the contract vocabulary.');
    }
    return allow({
      userType: 'platform', scopeType: 'platform', tenantId: null, storeId: null,
      platformRoleId, tenantRoleId: null,
      userStatus, tenantStatus: null, storeStatus: null,
      entitlements: {}, limited: userLimited,
    });
  }

  if (requestedContext.scopeType === 'tenant') {
    const tenantId = requestedContext.tenantId ?? null;
    if (!tenantId) return deny(R.DENIED_SCOPE_CONTEXT_INVALID, 'Tenant scope requires a tenantId.');
    const tenant = input.tenant;
    if (!tenant || tenant.tenant_id !== tenantId) {
      return deny(R.DENIED_TENANT_MISSING, 'Tenant row is missing or does not match the requested tenant.');
    }
    const tenantStatus = tenant.status;
    const tenantDisp = statusDisposition(tenantStatus);
    if (tenantDisp === 'deny' || tenantDisp === 'unrecognized') {
      return deny(R.DENIED_TENANT_STATUS, 'Tenant is suspended, not yet active, or in an unrecognized status.');
    }

    const tenantMs = ownMemberships.filter((m) => m.scope_type === 'tenant' && m.tenant_id === tenantId);
    const active = soleActive(tenantMs);
    if (active === 'ambiguous') return deny(R.DENIED_AMBIGUOUS_MEMBERSHIP, 'More than one active tenant membership.');
    if (active === 'none') {
      return tenantMs.length
        ? deny(R.DENIED_MEMBERSHIP_NOT_ACTIVE, 'Tenant membership is not active.')
        : deny(R.DENIED_NO_MEMBERSHIP, 'No active tenant membership.');
    }
    const tenantRoleId = resolveTenantRoleId(active.role_id);
    if (!tenantRoleId) return deny(R.DENIED_UNRESOLVABLE_ROLE, 'Tenant role id is not in the contract vocabulary.');

    return allow({
      userType: 'tenant', scopeType: 'tenant', tenantId, storeId: null,
      platformRoleId: null, tenantRoleId,
      userStatus, tenantStatus, storeStatus: null,
      entitlements: entitlementsForTenant(input.entitlements, tenantId),
      limited: userLimited || tenantDisp === 'read_only',
    });
  }

  if (requestedContext.scopeType === 'store') {
    const tenantId = requestedContext.tenantId ?? null;
    const storeId = requestedContext.storeId ?? null;
    if (!tenantId || !storeId) return deny(R.DENIED_SCOPE_CONTEXT_INVALID, 'Store scope requires tenantId and storeId.');
    const tenant = input.tenant;
    if (!tenant || tenant.tenant_id !== tenantId) {
      return deny(R.DENIED_TENANT_MISSING, 'Tenant row is missing or does not match the requested tenant.');
    }
    const tenantStatus = tenant.status;
    const tenantDisp = statusDisposition(tenantStatus);
    if (tenantDisp === 'deny' || tenantDisp === 'unrecognized') {
      return deny(R.DENIED_TENANT_STATUS, 'Tenant is suspended, not yet active, or in an unrecognized status.');
    }
    const store = input.store;
    if (!store || store.store_id !== storeId) {
      return deny(R.DENIED_STORE_MISSING, 'Store row is missing or does not match the requested store.');
    }
    if (store.tenant_id !== tenantId) {
      return deny(R.DENIED_STORE_TENANT_MISMATCH, 'Store does not belong to the requested tenant.');
    }
    const storeStatus = store.status;
    const storeDisp = statusDisposition(storeStatus);
    if (storeDisp === 'deny' || storeDisp === 'unrecognized') {
      return deny(R.DENIED_STORE_STATUS, 'Store is suspended, not yet active, or in an unrecognized status.');
    }

    const storeMs = ownMemberships.filter(
      (m) => m.scope_type === 'store' && m.tenant_id === tenantId && m.store_id === storeId,
    );
    const active = soleActive(storeMs);
    if (active === 'ambiguous') return deny(R.DENIED_AMBIGUOUS_MEMBERSHIP, 'More than one active store membership.');
    if (active === 'none') {
      return storeMs.length
        ? deny(R.DENIED_MEMBERSHIP_NOT_ACTIVE, 'Store membership is not active.')
        : deny(R.DENIED_NO_MEMBERSHIP, 'No active store membership.');
    }
    const tenantRoleId = resolveTenantRoleId(active.role_id);
    if (!tenantRoleId) return deny(R.DENIED_UNRESOLVABLE_ROLE, 'Store role id is not in the contract vocabulary.');

    return allow({
      userType: 'tenant', scopeType: 'store', tenantId, storeId,
      platformRoleId: null, tenantRoleId,
      userStatus, tenantStatus, storeStatus,
      entitlements: entitlementsForTenant(input.entitlements, tenantId),
      limited: userLimited || tenantDisp === 'read_only' || storeDisp === 'read_only',
    });
  }

  return deny(R.DENIED_SCOPE_CONTEXT_INVALID, 'Unsupported requested scope type.');
}
