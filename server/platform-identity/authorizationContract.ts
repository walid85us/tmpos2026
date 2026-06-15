// Phase 1.5 M9 — Inert server-derived AUTHORIZATION contract (Option B).
//
// PURPOSE: declare the SHAPE of a future, SERVER-DERIVED authorization result —
// roles, scope, account/tenant/store status, plan entitlements, effective
// permissions, and effective sub-permissions — that a later, separately-approved
// slice will return from `/auth/session/resolve` for a genuinely authenticated
// app actor.
//
// This file is INERT (contract-only):
//   - TypeScript types + a tiny amount of guard DATA only. No functions that do
//     work, no env/DB/network, no side effects, no runtime adoption.
//   - Imported by NOTHING at runtime. It uses `import type` from the inert M9
//     constants (erased at compile time), so it has NO runtime imports at all.
//     Consumed only by the M9 diagnostic and referenced by the M9 doc.
//   - Does NOT modify `/auth/session/resolve` (M7) or the M6 DTO. The runtime
//     endpoint CONTINUES to return `authorization: null` until a future approved
//     wiring slice (see RUNTIME_SESSION_RESOLVE_AUTHORIZATION).
//
// BOUNDARY (binding):
//   - SERVER-DERIVED ONLY. Every field here is computed server-side from durable,
//     app-owned state. NONE of it is ever read from the request body, a provider
//     token's `user_metadata`, or any client-asserted role/tenant/store/permission.
//   - Identity is proven SERVER-SIDE first (verified token → app-owned
//     internal_user_id). Authorization is layered ON TOP of a real identity.
//
// SECURITY (binding): references NO access token, refresh token, raw JWT, JWT
// payload, JWKS, service-role key, DB URL, or connection string. None of those
// is part of this contract, by design.

import type {
  UserType,
  ScopeTypeValue,
  AccountStatusValue,
  PermissionLevelValue,
  PlatformRoleId,
  TenantRoleId,
} from './authorizationConstants';
import { AUTHORIZATION_CONTRACT_VERSION, AUTHORIZATION_EVALUATED_BY } from './authorizationConstants';

// =============================================================================
// Structured sub-shapes
// =============================================================================

/** Server-resolved scope. tenantId/storeId are null unless the scope resolves them. */
export interface AuthorizationScope {
  scopeType: ScopeTypeValue;
  tenantId: string | null;
  storeId: string | null;
}

/** Server-resolved role assignment. A platform actor and/or a tenant/store actor. */
export interface AuthorizationRoles {
  platformRoleId: PlatformRoleId | null;
  tenantRoleId: TenantRoleId | null;
}

/**
 * Server-resolved status, evaluated with PRECEDENCE BEFORE role grants. A
 * non-active user/tenant/store denies (or read-only-limits) regardless of role.
 * tenant/store are null when out of scope.
 */
export interface AuthorizationStatus {
  user: AccountStatusValue;
  tenant: AccountStatusValue | null;
  store: AccountStatusValue | null;
}

/**
 * Plan/feature ENTITLEMENTS, server-resolved from the tenant's plan. Entitlement
 * decides whether a capability EXISTS; role decides who may use it. A
 * plan-disabled capability can NEVER be re-enabled by a role (mirrors the client
 * `checkSubPermission` precedence). featureKey -> enabled.
 */
export type FeatureEntitlements = Record<string, boolean>;

/** EFFECTIVE permission levels, server-resolved. domain/featureKey -> level. */
export type EffectivePermissions = Record<string, PermissionLevelValue>;

/** EFFECTIVE sub-permission grants, server-resolved. subPermissionId -> granted. */
export type EffectiveSubPermissions = Record<string, boolean>;

// =============================================================================
// The versioned authorization DTO
// =============================================================================

/**
 * Server-derived authorization, version `authz.v1`. Returned (in a FUTURE slice)
 * ONLY for an authenticated app actor; until then the wire value stays `null`.
 *
 * INVARIANTS:
 *   - SERVER-DERIVED ONLY; never client-asserted.
 *   - Carries NO token/JWT/secret field (see AUTHORIZATION_FORBIDDEN_FIELDS).
 *   - Status + entitlements are evaluated with precedence BEFORE role grants.
 */
export interface ServerDerivedAuthorizationV1 {
  authorizationVersion: typeof AUTHORIZATION_CONTRACT_VERSION;
  userType: UserType;
  scope: AuthorizationScope;
  roles: AuthorizationRoles;
  status: AuthorizationStatus;
  entitlements: FeatureEntitlements;
  permissions: EffectivePermissions;
  subPermissions: EffectiveSubPermissions;
  /** Evaluator provenance label (e.g. AUTHORIZATION_EVALUATED_BY). */
  derivedBy: string;
}

/** Convenience alias for the current authorization contract version. */
export type ServerDerivedAuthorization = ServerDerivedAuthorizationV1;

/**
 * The wire value of `authorization` on `/auth/session/resolve` in THIS era. It is
 * ALWAYS `null` — server-derived authorization is DEFERRED until a future
 * approved wiring slice. M9 changes NO runtime behavior; this constant documents
 * the standing invariant for the diagnostic.
 */
export const RUNTIME_SESSION_RESOLVE_AUTHORIZATION: null = null;

/** Evaluator label re-exported for callers/diagnostics that build sample DTOs. */
export const AUTHORIZATION_DERIVED_BY = AUTHORIZATION_EVALUATED_BY;

// =============================================================================
// Forbidden-field guard (compile-time + runtime)
// =============================================================================

/**
 * Field names that MUST NEVER appear on the authorization DTO. Used by the M9
 * diagnostic to assert no secret/token field can be present. (The names appear
 * here ONLY as a never-include guard list — never as actual DTO fields.)
 */
export type AuthorizationForbiddenField =
  | 'accessToken'
  | 'refreshToken'
  | 'rawJwt'
  | 'jwtPayload'
  | 'jwks'
  | 'serviceRoleKey'
  | 'databaseUrl'
  | 'connectionString'
  | 'password';

/** Runtime mirror of AuthorizationForbiddenField for the offline diagnostic. */
export const AUTHORIZATION_FORBIDDEN_FIELDS: readonly AuthorizationForbiddenField[] = [
  'accessToken',
  'refreshToken',
  'rawJwt',
  'jwtPayload',
  'jwks',
  'serviceRoleKey',
  'databaseUrl',
  'connectionString',
  'password',
];
