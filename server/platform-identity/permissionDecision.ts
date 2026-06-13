// Phase 1.5 M2 — Server-side permission decision contract.
//
// Thin server-side authorization checks that MIRROR the existing, frozen
// client-side permission engine semantics WITHOUT importing or editing the
// frontend config:
//   - tenant 7-level hierarchy + meetsPermissionLevel → src/context/accessConfig.ts
//   - platform threshold semantics                    → src/owner/platformPermissionsConfig.ts
//   - sub-permission precedence                       → src/context/AccessContext.tsx (checkSubPermission)
//
// ⚠ DRIFT RISK (must stay in sync): the level orderings below are intentionally
// duplicated here so the server can evaluate WITHOUT pulling the client bundle.
// They MUST be kept consistent with the frontend config. A future milestone
// should unify them into a shared package imported by BOTH src/ and server/.
//
// M2 evaluates ONLY against the dev-asserted permission snapshot
// (source 'dev_asserted_snapshot'); it does NOT read durable roles. Deny by
// default. Server-side only. Never imported by src/.

import type { PermissionLevel, RequestContext } from './requestContext';

// MIRRORS src/context/accessConfig.ts PERMISSION_HIERARCHY.
// Tenant ordering: note manage < approve. Keep in sync.
const TENANT_HIERARCHY: PermissionLevel[] = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];

// MIRRORS src/owner/platformPermissionsConfig.ts PLATFORM_PERMISSION_LEVELS.
// Platform ordering: note approve < manage (differs from tenant). Keep in sync.
const PLATFORM_LEVELS: PermissionLevel[] = ['none', 'view', 'create', 'edit', 'approve', 'manage', 'full'];

function levelIndex(order: PermissionLevel[], level: string | undefined | null): number {
  const idx = order.indexOf((level ?? 'none') as PermissionLevel);
  return idx < 0 ? 0 : idx; // unknown level ⇒ treated as 'none'
}

/** Mirrors accessConfig.meetsPermissionLevel (tenant ordering). */
export function meetsPermissionLevel(actual: string, required: PermissionLevel): boolean {
  return levelIndex(TENANT_HIERARCHY, actual) >= levelIndex(TENANT_HIERARCHY, required);
}

/** Mirrors platformPermissionsConfig.platformPermissionMeets (platform ordering). */
export function platformPermissionMeets(actual: string, threshold: PermissionLevel): boolean {
  return levelIndex(PLATFORM_LEVELS, actual) >= levelIndex(PLATFORM_LEVELS, threshold);
}

export type DecisionOutcome = 'allow' | 'deny' | 'deferred' | 'not_applicable';

export interface DecisionResult {
  decision: DecisionOutcome;
  reasonCode: string;
  humanReadableReason: string; // safe, non-leaking
}

function allow(reasonCode: string, reason: string): DecisionResult {
  return { decision: 'allow', reasonCode, humanReadableReason: reason };
}
function deny(reasonCode: string, reason: string): DecisionResult {
  return { decision: 'deny', reasonCode, humanReadableReason: reason };
}

/** Sub-permission definition needed to mirror checkSubPermission precedence. */
export interface SubPermissionContext {
  parentDomain: string;
  minModuleLevel: PermissionLevel;
  defaultLevel: PermissionLevel;
  /** Plan availability — supplied (dev-asserted) since the catalog + plan live client-side. */
  planAvailable: boolean;
}

function isAuthenticated(ctx: RequestContext): boolean {
  return ctx.authState === 'dev-asserted' && !!ctx.permissionSnapshot;
}

/**
 * Platform action check. Mirrors:
 *   - scope disjointness (platform actions require platform scope)
 *   - System Owner short-circuit (accessConfig: system_owner ⇒ all; locked Full)
 *   - platform threshold semantics
 * Order: authenticated → scope → owner short-circuit → permission.
 */
export function requirePlatformPermission(
  ctx: RequestContext,
  featureKey: string,
  threshold: PermissionLevel,
): DecisionResult {
  if (!isAuthenticated(ctx)) {
    return deny('denied_unauthenticated', 'No authenticated actor or permission snapshot.');
  }
  if (ctx.scope.scopeType !== 'platform' || !ctx.scope.platformScope) {
    return deny('denied_scope_mismatch', 'Platform action requires platform scope.');
  }
  const snap = ctx.permissionSnapshot!;
  if (snap.platformRoleId === 'system_owner') {
    return allow('allowed_system_owner', 'System Owner has full platform access.');
  }
  const actual = snap.permissions[featureKey] ?? 'none';
  return platformPermissionMeets(actual, threshold)
    ? allow('allowed_permission_met', `Actor meets ${featureKey}:${threshold}.`)
    : deny('denied_missing_permission', `Actor lacks ${featureKey}:${threshold}.`);
}

/**
 * Tenant / store action check. Mirrors AccessContext getPermissionLevel /
 * checkPermission:
 *   - tenant/store scope + tenant_id required
 *   - store_owner short-circuit ⇒ full
 *   - 7-level tenant hierarchy
 * Order: authenticated → scope → tenant id → owner short-circuit → permission.
 */
export function requireTenantPermission(
  ctx: RequestContext,
  domain: string,
  level: PermissionLevel,
): DecisionResult {
  if (!isAuthenticated(ctx)) {
    return deny('denied_unauthenticated', 'No authenticated actor or permission snapshot.');
  }
  if (ctx.scope.scopeType !== 'tenant' && ctx.scope.scopeType !== 'store') {
    return deny('denied_scope_mismatch', 'Tenant action requires tenant or store scope.');
  }
  if (!ctx.scope.tenantId) {
    return deny('denied_missing_tenant', 'Tenant action requires a resolvable tenant.');
  }
  const snap = ctx.permissionSnapshot!;
  if (snap.tenantRoleId === 'store_owner') {
    return allow('allowed_store_owner', 'Store Owner has full tenant access.');
  }
  const actual = snap.permissions[domain] ?? 'none';
  return meetsPermissionLevel(actual, level)
    ? allow('allowed_permission_met', `Actor meets ${domain}:${level}.`)
    : deny('denied_missing_permission', `Actor lacks ${domain}:${level}.`);
}

/**
 * Sub-permission check. Mirrors AccessContext.checkSubPermission precedence:
 *   1. plan availability (deny if plan-locked) — runs BEFORE the owner short-circuit
 *   2. system_owner / store_owner short-circuit
 *   3. parent-domain minimum module level
 *   4. explicit per-role sub-permission grant
 *   5. default level fallback
 * (scope + tenant_id are server-side preconditions, checked first.)
 */
export function requireSubPermission(
  ctx: RequestContext,
  subPermissionId: string,
  subDef: SubPermissionContext,
): DecisionResult {
  if (!isAuthenticated(ctx)) {
    return deny('denied_unauthenticated', 'No authenticated actor or permission snapshot.');
  }
  if (ctx.scope.scopeType !== 'tenant' && ctx.scope.scopeType !== 'store') {
    return deny('denied_scope_mismatch', 'Sub-permission action requires tenant or store scope.');
  }
  if (!ctx.scope.tenantId) {
    return deny('denied_missing_tenant', 'Sub-permission action requires a resolvable tenant.');
  }
  const snap = ctx.permissionSnapshot!;
  // 1. Plan availability runs BEFORE the owner short-circuit (mirrors the frontend).
  if (!subDef.planAvailable) {
    return deny('denied_plan_locked', 'Capability is not available on the current plan.');
  }
  // 2. Owner short-circuit.
  if (snap.platformRoleId === 'system_owner' || snap.tenantRoleId === 'store_owner') {
    return allow('allowed_owner', 'Owner role grants this sub-permission.');
  }
  // 3. Parent-domain minimum level.
  const parentLevel = snap.permissions[subDef.parentDomain] ?? 'none';
  if (!meetsPermissionLevel(parentLevel, subDef.minModuleLevel)) {
    return deny('denied_parent_level', 'Actor lacks the required module level.');
  }
  // 4. Explicit grant.
  if (Object.prototype.hasOwnProperty.call(snap.subPermissions, subPermissionId)) {
    return snap.subPermissions[subPermissionId]
      ? allow('allowed_explicit_grant', 'Sub-permission explicitly granted.')
      : deny('denied_explicit_revoke', 'Sub-permission explicitly revoked.');
  }
  // 5. Default fallback.
  return meetsPermissionLevel(parentLevel, subDef.defaultLevel)
    ? allow('allowed_default', 'Sub-permission granted by default for module level.')
    : deny('denied_default', 'Sub-permission not granted by default.');
}
