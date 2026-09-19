// M5-GAP11-P5 — explicit, editable money-action capabilities (docs/phase-4/10 ADR-19).
//
// Money approval is an explicit capability, not an implication of a permission level. A role may
// approve a refund, a return or a platform billing action ONLY when its runtime configuration carries
// the explicit boolean `true` for that capability. `approve`, `manage`, `full` or any ordering
// comparison never grants one by itself; the existing plan, entitlement, parent-module, read-only,
// identity, tenant, store and scope gates still deny on top of a `true` grant.
//
// BUILT-IN DEFAULTS, NOT RUNTIME AUTHORITY. Owner decision D2 (M5-GAP11-P2) fixed these per-role
// values; P5 reclassifies them as the defaults a built-in role STARTS with. An owner edit to `true`
// grants, an edit to `false` revokes, a custom role starts with no grant (denied), and a decision
// reads only the role's runtime configuration — never this table by role name.
//
// PURE: no runtime imports, no DOM, no storage — safe to import from the server.
import type { PermissionFamily } from './permissionFamilies';

export type TenantMoneyCapability = 'approve_refunds' | 'approve_return';
export type PlatformMoneyCapability = 'approve_billing_actions';
export type MoneyCapability = TenantMoneyCapability | PlatformMoneyCapability;

export interface MoneyCapabilityDef {
  readonly id: MoneyCapability;
  /** Which role plane holds the grant: store roles or platform roles. */
  readonly plane: 'tenant' | 'platform';
  /** The family of the parent module the capability sits under. */
  readonly family: PermissionFamily;
  /** The parent domain (tenant) or feature group (platform). */
  readonly parent: string;
}

export const MONEY_CAPABILITIES: readonly MoneyCapabilityDef[] = Object.freeze([
  Object.freeze({ id: 'approve_refunds', plane: 'tenant', family: 'tenant_store', parent: 'refunds' } as const),
  Object.freeze({ id: 'approve_return', plane: 'tenant', family: 'tenant_store', parent: 'returns' } as const),
  Object.freeze({ id: 'approve_billing_actions', plane: 'platform', family: 'platform', parent: 'billing_subscriptions' } as const),
]);

/**
 * The parent-module minimum for the platform capability: the role must hold at least View on Billing &
 * Subscriptions. It is a denying gate only. (The store capabilities use their catalog sub-permission's
 * minModuleLevel — Refunds View for refund approval, Returns Manage for return approval.)
 */
export const PLATFORM_MONEY_PARENT_MINIMUM = 'view' as const;

export function isTenantMoneyCapability(id: unknown): id is TenantMoneyCapability {
  return id === 'approve_refunds' || id === 'approve_return';
}

export function isPlatformMoneyCapability(id: unknown): id is PlatformMoneyCapability {
  return id === 'approve_billing_actions';
}

/**
 * The retired LEVEL form of a money approval. docs/phase-4/04 §3 named `refunds: approve` as a
 * representation of refund approval, and the POS supervisor check used it. P5 converged it into the one
 * explicit capability approve_refunds, so a domain requirement of Refunds at Approve is refused (denied)
 * wherever it is asked, never answered by a level comparison. Ask approve_refunds instead.
 */
export function isRetiredMoneyLevelForm(domain: unknown, level: unknown): boolean {
  return domain === 'refunds' && level === 'approve';
}

/**
 * Built-in default grants (owner decision D2, reclassified as defaults in P5). Store roles hold the
 * store capabilities; platform roles hold the platform capability. A role absent here — any custom
 * role — starts with no grant.
 */
export const BUILT_IN_MONEY_GRANT_DEFAULTS: Readonly<Record<string, Readonly<Partial<Record<MoneyCapability, boolean>>>>> = Object.freeze({
  store_owner: Object.freeze({ approve_refunds: true, approve_return: true }),
  manager: Object.freeze({ approve_refunds: true, approve_return: true }),
  sales_staff: Object.freeze({ approve_refunds: false, approve_return: false }),
  technician: Object.freeze({ approve_refunds: false, approve_return: false }),
  system_owner: Object.freeze({ approve_billing_actions: true }),
  billing_admin: Object.freeze({ approve_billing_actions: true }),
  operations_admin: Object.freeze({ approve_billing_actions: false }),
  security_admin: Object.freeze({ approve_billing_actions: false }),
  support_admin: Object.freeze({ approve_billing_actions: false }),
});

/** A built-in role's default grants (a copy), or {} for any other role id — custom roles start denied. */
export function builtInMoneyGrants(roleId: string): Partial<Record<MoneyCapability, boolean>> {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_MONEY_GRANT_DEFAULTS, roleId)
    ? { ...BUILT_IN_MONEY_GRANT_DEFAULTS[roleId] }
    : {};
}

/**
 * Whether a runtime grant map carries the capability as exactly `true`. An absent entry, `false`, a
 * non-boolean (`'true'`, 1, null), an inherited name, or a map that is not a plain object all deny.
 */
export function hasExplicitMoneyGrant(grants: unknown, capability: MoneyCapability): boolean {
  if (typeof grants !== 'object' || grants === null || Array.isArray(grants)) return false;
  const proto = Object.getPrototypeOf(grants);
  if (proto !== Object.prototype && proto !== null) return false;
  if (!Object.prototype.hasOwnProperty.call(grants, capability)) return false;
  return (grants as Record<string, unknown>)[capability] === true;
}
