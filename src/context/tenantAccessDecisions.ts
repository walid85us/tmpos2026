// M5-GAP11-P5 — the store-plane decisions AccessContext makes, as pure functions of runtime data.
//
// Every answer here is computed from the RUNTIME role configuration only (tenantRolesState: built-in,
// owner-edited and custom roles alike) plus the session, the tenant's plan and the permission being
// checked. Nothing branches on where a role value came from — a built-in default, an owner edit, a
// custom role or a test fixture — so equivalent runtime data always produces the same decision.
//
// Level comparisons use the tenant/store family ordering (none < view < create < edit < manage <
// approve < full), named explicitly at every call. Money capabilities (approve_refunds,
// approve_return) are decided by the explicit grant alone, on top of the tenant, plan and parent-module gates;
// no level, and no owner-role shortcut, grants one.
import type { EmployeeRole, PermissionLevel } from '../types';
import { PERMISSION_DOMAINS, SUB_PERMISSIONS, isSubPermissionPlanAvailable, type SubPermissionDef } from './accessConfig';
import { meetsFamilyLevel } from '../authorization/permissionFamilies';
import {
  hasExplicitMoneyGrant,
  isRetiredMoneyLevelForm,
  isTenantMoneyCapability,
  type TenantMoneyCapability,
} from '../authorization/moneyCapabilities';

export interface TenantDecisionInput {
  readonly hasSession: boolean;
  /** The role the decision is for — the POS operator's role when one is active. */
  readonly effectiveRole: string;
  /** The runtime store roles: built-in, owner-edited and custom. */
  readonly roles: readonly EmployeeRole[];
  /** The tenant whose plan gates sub-permissions, or null. */
  readonly tenant: { readonly id: string; readonly plan: string } | null;
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isKnownDomain = (domain: string): boolean => PERMISSION_DOMAINS.some(d => d.id === domain);
const isOwnerRole = (roleId: string): boolean => roleId === 'system_owner' || roleId === 'store_owner';

/** The level a role configuration holds on a domain. Own-property reads; absent is `none`. */
export function resolveRoleLevel(roleConfig: EmployeeRole, domain: string): PermissionLevel {
  const perms = roleConfig.permissions;
  if (Array.isArray(perms)) {
    if (perms.includes('all')) return 'full';
    if (perms.includes(domain)) return 'full';
    if (perms.includes(`${domain}_read`)) return 'view';
    return 'none';
  }
  const record = perms as Record<string, PermissionLevel>;
  // A present malformed value is returned as stored; the family comparison denies it.
  if (hasOwn(record, '_grant') && record['_grant'] === 'full') return 'full';
  return hasOwn(record, domain) ? record[domain] : 'none';
}

function roleConfigFor(input: TenantDecisionInput, roleId: string): EmployeeRole | undefined {
  return input.roles.find(r => r.id === roleId);
}

/** getPermissionLevel: the effective role's level on a domain. */
export function tenantPermissionLevel(input: TenantDecisionInput, domain: string): PermissionLevel {
  if (!input.hasSession) return 'none';
  if (!isKnownDomain(domain)) return 'none';
  if (isOwnerRole(input.effectiveRole)) return 'full';
  const roleConfig = roleConfigFor(input, input.effectiveRole);
  return roleConfig ? resolveRoleLevel(roleConfig, domain) : 'none';
}

/**
 * checkPermission: the effective role's domain level against a required level, tenant/store family.
 * The retired level form of refund approval (Refunds at Approve) is refused: refund approval is the
 * approve_refunds capability, never a level comparison.
 */
export function decideTenantPermission(input: TenantDecisionInput, domain: string, required: PermissionLevel): boolean {
  if (!isKnownDomain(domain)) return false;
  if (isRetiredMoneyLevelForm(domain, required)) return false;
  return meetsFamilyLevel('tenant_store', tenantPermissionLevel(input, domain), required);
}

/**
 * The one store money-capability decision. Refund approval (the sub-permission and the POS supervisor
 * check) and return approval both come here. Gates, in order: session; a tenant (no store context, no
 * money approval — the DEV spine's denied_missing_tenant); the tenant's plan; a store role
 * configuration (the platform System Owner has none, so it is denied); the catalog's parent-module
 * minimum; and finally the explicit grant, which must be exactly `true`.
 */
export function decideTenantMoneyCapability(
  input: { readonly hasSession: boolean; readonly tenant: TenantDecisionInput['tenant']; readonly roleConfig: EmployeeRole | undefined },
  capability: TenantMoneyCapability,
): boolean {
  if (!input.hasSession) return false;
  if (!isTenantMoneyCapability(capability)) return false;
  const def = SUB_PERMISSIONS.find(sp => sp.id === capability);
  if (!def) return false;
  if (!input.tenant || !isSubPermissionPlanAvailable(def, input.tenant.plan, input.tenant.id)) return false;
  const roleConfig = input.roleConfig;
  if (!roleConfig) return false;
  if (!meetsFamilyLevel('tenant_store', resolveRoleLevel(roleConfig, def.parentDomain), def.minModuleLevel)) return false;
  return hasExplicitMoneyGrant(roleConfig.subPermissions, capability);
}

/** checkSubPermission: the effective role's named sub-permission. */
export function decideTenantSubPermission(input: TenantDecisionInput, actionId: string): boolean {
  if (!input.hasSession) return false;
  const actionDef = SUB_PERMISSIONS.find(sp => sp.id === actionId);
  if (!actionDef) return false;
  if (isTenantMoneyCapability(actionId)) {
    return decideTenantMoneyCapability(
      { hasSession: input.hasSession, tenant: input.tenant, roleConfig: roleConfigFor(input, input.effectiveRole) },
      actionId,
    );
  }
  // Plan decides whether the capability exists at all — before every shortcut, owners included.
  if (input.tenant && !isSubPermissionPlanAvailable(actionDef, input.tenant.plan, input.tenant.id)) return false;
  if (isOwnerRole(input.effectiveRole)) return true;
  const parentLevel = tenantPermissionLevel(input, actionDef.parentDomain);
  if (!meetsFamilyLevel('tenant_store', parentLevel, actionDef.minModuleLevel)) return false;
  const roleConfig = roleConfigFor(input, input.effectiveRole);
  if (!roleConfig) return false;
  // Own-property read; a present entry must be exactly `true` — anything else denies.
  if (roleConfig.subPermissions && hasOwn(roleConfig.subPermissions, actionId)) {
    return roleConfig.subPermissions[actionId] === true;
  }
  return meetsFamilyLevel('tenant_store', parentLevel, actionDef.defaultLevel);
}

/** requestSupervisorRefundAuth (after the PIN): the supervisor role's refund-approval capability. */
export function decideSupervisorRefundApproval(input: TenantDecisionInput, supervisorRoleId: string): boolean {
  return decideTenantMoneyCapability(
    { hasSession: input.hasSession, tenant: input.tenant, roleConfig: roleConfigFor(input, supervisorRoleId) },
    'approve_refunds',
  );
}

/**
 * What the role editors show for one role and one sub-permission: 'na' below the parent-module
 * minimum, otherwise the same answer the runtime check gives that role configuration — a money
 * capability shows its explicit grant only; any other sub-permission shows its explicit entry
 * (exactly `true` grants) or, when it has none, its default at the parent level.
 */
export function subPermissionMatrixStatus(roleConfig: EmployeeRole, sub: SubPermissionDef): 'granted' | 'denied' | 'na' {
  const parentLevel = resolveRoleLevel(roleConfig, sub.parentDomain);
  if (!meetsFamilyLevel('tenant_store', parentLevel, sub.minModuleLevel)) return 'na';
  if (isTenantMoneyCapability(sub.id)) {
    return hasExplicitMoneyGrant(roleConfig.subPermissions, sub.id) ? 'granted' : 'denied';
  }
  if (roleConfig.subPermissions && hasOwn(roleConfig.subPermissions, sub.id)) {
    return roleConfig.subPermissions[sub.id] === true ? 'granted' : 'denied';
  }
  return meetsFamilyLevel('tenant_store', parentLevel, sub.defaultLevel) ? 'granted' : 'denied';
}
