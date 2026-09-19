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
  readonly tenant: { readonly id: string; readonly plan: string; readonly status?: string } | null;
}

/** Account statuses in which the store is read-only: no money action runs (M5-GAP11-P5-R1). */
const READ_ONLY_TENANT_STATUSES: readonly string[] = ['read_only', 'suspended'];

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
 * money approval — the DEV spine's denied_missing_tenant); the tenant's plan; a tenant that is not
 * read-only or suspended (other writes stay GAP-13); a store role
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
  if (input.tenant.status !== undefined && READ_ONLY_TENANT_STATUSES.includes(input.tenant.status)) return false;
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

/** A POS refund decision: the store decision input plus who is at the till, the request and the write block. */
export interface PosRefundInput extends TenantDecisionInput {
  /** The signed-in user. */
  readonly userId: string | null;
  /** The active POS operator (the signed-in user when no operator is switched in). */
  readonly operatorKey: string | null;
  /** The refund request being authorized or executed; null when none is open. */
  readonly requestId: string | null;
  /** Read-only mode: every state-changing money action is denied. */
  readonly writeBlocked: boolean;
}

/**
 * A supervisor's refund approval (M5-GAP11-P5-R1). It is not an authorization on its own: it records
 * what it was decided on, decidePosRefundExecution re-decides from current state at execution, and any
 * recorded input that no longer matches voids it. It covers one refund request, under one operator.
 */
export interface SupervisorRefundApproval {
  readonly supervisorRoleId: string;
  readonly supervisorName: string;
  readonly userId: string;
  readonly operatorKey: string;
  readonly operatorRole: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly plan: string;
  /** The supervisor role configuration decided on. Roles are replaced, never mutated, on every edit,
   * so a changed Refunds level or approve_refunds value (even one changed back) no longer matches. */
  readonly supervisorConfig: EmployeeRole;
}

/** The gates every POS refund decision shares; returns the operator's runtime store role or undefined. */
function posRefundOperator(input: PosRefundInput): EmployeeRole | undefined {
  if (!input.hasSession || !input.tenant || input.writeBlocked || !input.userId || !input.operatorKey) return undefined;
  // A store role only: the platform System Owner and unknown roles have none and are denied.
  return roleConfigFor(input, input.effectiveRole);
}

/** requestSupervisorRefundAuth (after the PIN): the approval, bound to this request, or null. */
export function grantSupervisorRefundApproval(
  input: PosRefundInput,
  supervisorRoleId: string,
  supervisorName: string,
): SupervisorRefundApproval | null {
  if (!posRefundOperator(input) || !input.requestId || !input.userId || !input.operatorKey || !input.tenant) return null;
  const supervisorConfig = roleConfigFor(input, supervisorRoleId);
  if (!supervisorConfig || !decideSupervisorRefundApproval(input, supervisorRoleId)) return null;
  return Object.freeze({
    supervisorRoleId, supervisorName,
    userId: input.userId, operatorKey: input.operatorKey, operatorRole: input.effectiveRole, requestId: input.requestId,
    tenantId: input.tenant.id, plan: input.tenant.plan, supervisorConfig,
  });
}

/**
 * Whether the POS may execute a refund now, decided from current state only. The operator's own
 * authority is Process Refunds plus the explicit approve_refunds grant (Refunds at View or above); a
 * level alone never suffices. Otherwise a supervisor approval counts only for the request it was given
 * for, under the same user, operator and operator role, tenant and plan, and the same supervisor role
 * configuration — and the supervisor's approve_refunds decision is then taken again.
 */
export function decidePosRefundExecution(input: PosRefundInput, approval: SupervisorRefundApproval | null): boolean {
  const operatorConfig = posRefundOperator(input);
  if (!operatorConfig || !input.tenant) return false;
  if (
    decideTenantSubPermission(input, 'process_refunds') &&
    decideTenantMoneyCapability({ hasSession: input.hasSession, tenant: input.tenant, roleConfig: operatorConfig }, 'approve_refunds')
  ) return true;
  if (!approval || !input.requestId) return false;
  if (
    approval.requestId !== input.requestId ||
    approval.userId !== input.userId ||
    approval.operatorKey !== input.operatorKey ||
    approval.operatorRole !== input.effectiveRole ||
    approval.tenantId !== input.tenant.id ||
    approval.plan !== input.tenant.plan ||
    roleConfigFor(input, approval.supervisorRoleId) !== approval.supervisorConfig
  ) return false;
  return decideSupervisorRefundApproval(input, approval.supervisorRoleId);
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
