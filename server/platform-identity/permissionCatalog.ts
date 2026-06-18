// Phase 1.6 M1 — Pure, INERT, server-only PERMISSION & CAPABILITY CATALOG.
//
// PURPOSE: the single server-side source the M11 authorization resolver uses to
// MATERIALIZE effective `permissions` (domain/feature -> level) and
// `subPermissions` (id -> boolean) on an ALLOW decision. Until this milestone the
// resolver emitted `permissions: {}` / `subPermissions: {}` (deferred). This
// module fills them with role-derived, plan/entitlement-capped, status-capped
// values — WITHOUT changing any deny / fail-closed behavior.
//
// PURE / INERT (binding):
//   - No DB, no env, no network, no Express, no Supabase, no Firebase, no audit,
//     no side effects, no process.env, no I/O. It imports ONLY the inert M9
//     constants (one runtime import for the two orderings) and `import type` from
//     the M9 contract (erased at compile time).
//   - It does NOT import any frontend file (src/**). It MIRRORS the frozen client
//     engines by read-only parity (see PARITY SOURCES) — it never imports them.
//   - Imported at runtime ONLY by authorizationResolver.ts. Never by the client
//     bundle, the M7 route, the M8 pilot, the M11.4 service, or the M11.5 route.
//
// SERVER-AUTHORITATIVE (binding): operates ONLY on a server-resolved role id +
// the server-resolved, enabled-only entitlement map + a server-resolved
// read-only limitation flag. It NEVER reads a request body, a token's
// user_metadata, or any client-asserted role / permission / entitlement.
//
// SECURITY (binding): references NO access token, refresh token, raw JWT, JWT
// payload, JWKS, service-role key, DB URL, connection string, or password. None
// is an input or an output. Output values are permission-level strings and
// sub-permission booleans only.
//
// PARITY SOURCES (mirrored by read-only inspection, NOT imported):
//   - src/context/accessConfig.ts        — tenant ordering, PERMISSION_DOMAINS,
//                                           SUB_PERMISSIONS, FEATURE_PERMISSION_
//                                           DEPENDENCIES, tenant role defaults,
//                                           planFeatures.
//   - src/owner/platformPermissionsConfig.ts — platform ordering, the 11 feature
//                                           groups + sub-permissions + thresholds,
//                                           PLATFORM_PERMISSION_DEPENDENCIES,
//                                           DEFAULT_PLATFORM_FEATURE_LEVELS.
//   - server/platform-identity/permissionDecision.ts — the existing server mirror
//                                           of both orderings + checkSubPermission
//                                           precedence (plan -> owner -> parent
//                                           level -> explicit -> default).
//
// ⚠ TWO ORDERINGS ARE INTENTIONAL (binding): tenant/store ordering keeps
// `manage < approve`; platform ordering keeps `approve < manage`. They are NOT
// unified. Collapsing them is a correctness bug.

import {
  TENANT_PERMISSION_ORDERING,
  PLATFORM_PERMISSION_ORDERING,
} from './authorizationConstants';
import type {
  PermissionLevelValue,
  PlatformRoleId,
  TenantRoleId,
} from './authorizationConstants';
import type {
  EffectivePermissions,
  EffectiveSubPermissions,
  FeatureEntitlements,
} from './authorizationContract';

type Level = PermissionLevelValue;

// =============================================================================
// 7-token vocabulary + the two distinct orderings + per-ordering comparison
// =============================================================================

/** The canonical 7-token permission vocabulary (both contexts share it). */
export const PERMISSION_TOKENS: readonly Level[] = [
  'none',
  'view',
  'create',
  'edit',
  'manage',
  'approve',
  'full',
] as const;

/** Tenant/store ordering: none < view < create < edit < manage < approve < full. */
export const TENANT_ORDERING: readonly Level[] = TENANT_PERMISSION_ORDERING;

/** Platform ordering: none < view < create < edit < approve < manage < full. */
export const PLATFORM_ORDERING: readonly Level[] = PLATFORM_PERMISSION_ORDERING;

function rankIn(order: readonly Level[], level: Level | null | undefined): number {
  const idx = order.indexOf((level ?? 'none') as Level);
  return idx < 0 ? 0 : idx; // unknown level ⇒ treated as 'none' (fail closed)
}

/** Mirrors accessConfig.meetsPermissionLevel — uses the TENANT ordering. */
export function meetsTenantPermissionLevel(actual: Level, required: Level): boolean {
  return rankIn(TENANT_ORDERING, actual) >= rankIn(TENANT_ORDERING, required);
}

/** Mirrors platformPermissionsConfig.platformPermissionMeets — PLATFORM ordering. */
export function meetsPlatformPermissionLevel(actual: Level, threshold: Level): boolean {
  if (threshold === 'none') return true;
  return rankIn(PLATFORM_ORDERING, actual) >= rankIn(PLATFORM_ORDERING, threshold);
}

// =============================================================================
// Status / read-only capping helpers
// =============================================================================

/** Cap any write level down to `view` (read_only / overdue). none/view unchanged. */
export function capTenantLevelForReadOnly(level: Level): Level {
  return rankIn(TENANT_ORDERING, level) > rankIn(TENANT_ORDERING, 'view') ? 'view' : level;
}

/** Platform-ordering variant of the read-only level cap. */
export function capPlatformLevelForReadOnly(level: Level): Level {
  return rankIn(PLATFORM_ORDERING, level) > rankIn(PLATFORM_ORDERING, 'view') ? 'view' : level;
}

// =============================================================================
// TENANT / STORE permission domains (mirror PERMISSION_DOMAINS ids)
// =============================================================================

export const TENANT_PERMISSION_DOMAINS: readonly string[] = [
  'dashboard',
  'sales',
  'repairs',
  'inventory',
  'customers',
  'employees',
  'warranties',
  'refunds',
  'invoices',
  'services',
  'reports',
  'prospects',
  'marketing',
  'suggestive_sales',
  'settings',
  'support',
  'supply_chain',
  'integrations',
  'widgets',
  'shipping',
  'returns',
] as const;

/**
 * Tenant DOMAIN -> the plan/entitlement feature key that must be entitled for the
 * domain to exist (cap-only). A `null` gate marks a CORE domain that is always
 * available (present even on the starter plan) and is NEVER plan-capped.
 *
 * ⚠ DRIFT (documented): the frontend planFeatures uses the hyphenated key
 * `supply-chain` while the domain id is `supply_chain`. The server gate uses the
 * planFeatures key form so entitlement rows assembled from durable state line up.
 */
export const TENANT_DOMAIN_ENTITLEMENT: Readonly<Record<string, string | null>> = {
  // Core domains (starter plan) — never plan-capped.
  dashboard: null,
  sales: null,
  customers: null,
  invoices: null,
  support: null,
  // Plan-optional modules — present only on growth/advanced plans.
  repairs: 'repairs',
  inventory: 'inventory',
  employees: 'employees',
  warranties: 'warranties',
  refunds: 'refunds',
  services: 'services',
  reports: 'reports',
  prospects: 'prospects',
  marketing: 'marketing',
  suggestive_sales: 'suggestive_sales',
  settings: 'settings',
  supply_chain: 'supply-chain',
  integrations: 'integrations',
  widgets: 'widgets',
  shipping: 'shipping',
  returns: 'returns',
};

// =============================================================================
// TENANT / STORE sub-permission definitions (mirror SUB_PERMISSIONS)
// =============================================================================

export interface TenantSubPermissionDef {
  id: string;
  parentDomain: string;
  /** Minimum parent-domain level for this sub to be considered. */
  minModuleLevel: Level;
  /** Level the parent must meet for a default (no-explicit-grant) true. */
  defaultLevel: Level;
  /**
   * Read-only capping classification. `true` ⇒ write/approve/manage/override/
   * configure/execute capability → forced false under read_only/overdue.
   * `false` ⇒ safe read/view/audit-view capability → preserved if already granted.
   */
  mutating: boolean;
}

// Read-safe (non-mutating) tenant sub-permissions: view_* visibility + benign
// open/print. Everything else is a mutating capability for read-only capping.
const TENANT_READ_SAFE_SUBS: ReadonlySet<string> = new Set<string>([
  'view_shipping_costs',
  'view_carrier_analytics',
  'view_carrier_scorecards',
  'view_pickup_analytics',
  'view_shipping_automation_results',
  'view_shipping_automation_outcomes',
  'view_packing_workflows',
  'view_shipping_sla',
  'print_shipping_label',
]);

function tenantSub(
  id: string,
  parentDomain: string,
  minModuleLevel: Level,
  defaultLevel: Level,
): TenantSubPermissionDef {
  return { id, parentDomain, minModuleLevel, defaultLevel, mutating: !TENANT_READ_SAFE_SUBS.has(id) };
}

export const TENANT_SUB_PERMISSIONS: readonly TenantSubPermissionDef[] = [
  tenantSub('manage_employees', 'employees', 'view', 'manage'),
  tenantSub('manage_attendance', 'employees', 'view', 'manage'),
  tenantSub('create_roles', 'employees', 'view', 'manage'),
  tenantSub('edit_roles', 'employees', 'view', 'manage'),
  tenantSub('manage_role_permissions', 'employees', 'view', 'manage'),
  tenantSub('assign_roles', 'employees', 'view', 'manage'),
  tenantSub('assign_manager_role', 'employees', 'view', 'manage'),
  tenantSub('approve_requests', 'employees', 'view', 'approve'),
  tenantSub('manage_compensation', 'employees', 'view', 'manage'),
  tenantSub('approve_inventory', 'inventory', 'view', 'approve'),
  tenantSub('manage_warranty_claims', 'warranties', 'view', 'manage'),
  tenantSub('process_refunds', 'refunds', 'view', 'create'),
  tenantSub('approve_refunds', 'refunds', 'view', 'approve'),
  tenantSub('process_expired_warranty', 'warranties', 'view', 'manage'),
  tenantSub('loyalty_customer_edit', 'customers', 'view', 'edit'),
  tenantSub('loyalty_settings_manage', 'customers', 'view', 'manage'),
  tenantSub('reopen_invoice', 'invoices', 'view', 'manage'),
  tenantSub('assign_technician', 'repairs', 'edit', 'manage'),
  tenantSub('adjust_stock', 'inventory', 'edit', 'manage'),
  tenantSub('manage_transfers', 'inventory', 'edit', 'manage'),
  tenantSub('manage_purchase_orders', 'supply_chain', 'edit', 'manage'),
  tenantSub('manage_trade_ins', 'inventory', 'edit', 'manage'),
  tenantSub('manage_refurbishment', 'inventory', 'edit', 'manage'),
  tenantSub('manage_stock_counts', 'inventory', 'edit', 'manage'),
  tenantSub('manage_goods_received_notes', 'supply_chain', 'edit', 'manage'),
  tenantSub('manage_rmas', 'supply_chain', 'edit', 'manage'),
  tenantSub('manage_suppliers', 'supply_chain', 'edit', 'manage'),
  tenantSub('create_inventory_items', 'inventory', 'create', 'create'),
  tenantSub('create_shipment', 'shipping', 'create', 'create'),
  tenantSub('edit_shipment_pre_dispatch', 'shipping', 'edit', 'edit'),
  tenantSub('dispatch_shipment', 'shipping', 'edit', 'manage'),
  tenantSub('update_tracking_events', 'shipping', 'edit', 'edit'),
  tenantSub('cancel_shipment', 'shipping', 'edit', 'manage'),
  tenantSub('view_shipping_costs', 'shipping', 'view', 'edit'),
  tenantSub('manage_shipping_settings', 'shipping', 'manage', 'manage'),
  tenantSub('configure_shipping_provider', 'shipping', 'manage', 'manage'),
  tenantSub('validate_shipping_address', 'shipping', 'edit', 'edit'),
  tenantSub('fetch_shipping_rates', 'shipping', 'edit', 'edit'),
  tenantSub('purchase_shipping_label', 'shipping', 'edit', 'manage'),
  tenantSub('print_shipping_label', 'shipping', 'view', 'view'),
  tenantSub('sync_shipping_tracking', 'shipping', 'edit', 'edit'),
  tenantSub('select_service_point', 'shipping', 'edit', 'edit'),
  tenantSub('request_carrier_pickup', 'shipping', 'edit', 'edit'),
  tenantSub('cancel_carrier_pickup', 'shipping', 'edit', 'manage'),
  tenantSub('view_carrier_analytics', 'shipping', 'view', 'manage'),
  tenantSub('view_carrier_scorecards', 'shipping', 'view', 'view'),
  tenantSub('view_pickup_analytics', 'shipping', 'view', 'manage'),
  tenantSub('manage_carrier_locator_settings', 'shipping', 'manage', 'manage'),
  tenantSub('manage_shipping_automation_rules', 'shipping', 'manage', 'manage'),
  tenantSub('view_shipping_automation_results', 'shipping', 'view', 'view'),
  tenantSub('view_shipping_automation_outcomes', 'shipping', 'view', 'view'),
  tenantSub('resolve_shipping_automation_reviews', 'shipping', 'edit', 'edit'),
  tenantSub('approve_shipping_automation_exceptions', 'shipping', 'edit', 'manage'),
  tenantSub('override_shipping_automation_guardrails', 'shipping', 'manage', 'manage'),
  tenantSub('run_shipping_automation_backfill', 'shipping', 'manage', 'manage'),
  tenantSub('manage_batch_labels', 'shipping', 'manage', 'manage'),
  tenantSub('purchase_batch_labels', 'shipping', 'manage', 'manage'),
  tenantSub('view_packing_workflows', 'shipping', 'view', 'view'),
  tenantSub('manage_packing_workflows', 'shipping', 'edit', 'edit'),
  tenantSub('complete_packing', 'shipping', 'edit', 'manage'),
  tenantSub('resolve_packing_exceptions', 'shipping', 'edit', 'manage'),
  tenantSub('override_packing_requirements', 'shipping', 'manage', 'manage'),
  tenantSub('view_shipping_sla', 'shipping', 'view', 'view'),
  tenantSub('manage_shipping_sla_policies', 'shipping', 'manage', 'manage'),
  tenantSub('pause_shipping_sla', 'shipping', 'edit', 'manage'),
  tenantSub('resolve_shipping_sla_exceptions', 'shipping', 'edit', 'manage'),
  tenantSub('edit_shipping_sla_delay_reasons', 'shipping', 'edit', 'edit'),
  tenantSub('create_return', 'returns', 'create', 'create'),
  tenantSub('approve_return', 'returns', 'manage', 'approve'),
  tenantSub('receive_return', 'returns', 'edit', 'manage'),
  tenantSub('inspect_return', 'returns', 'edit', 'manage'),
  tenantSub('complete_return_disposition', 'returns', 'manage', 'manage'),
  tenantSub('cancel_return', 'returns', 'edit', 'manage'),
  tenantSub('create_return_shipment', 'returns', 'edit', 'manage'),
];

/**
 * FEATURE -> dependent tenant sub-permissions (mirror
 * FEATURE_PERMISSION_DEPENDENCIES). Plan disabling a feature plan-locks EVERY sub
 * listed under it, regardless of role grant (role can never override plan).
 */
export const TENANT_FEATURE_PERMISSION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  shipping_providers: [
    'configure_shipping_provider',
    'fetch_shipping_rates',
    'purchase_shipping_label',
    'validate_shipping_address',
    'sync_shipping_tracking',
    'purchase_batch_labels',
  ],
  shipping_automation_rules: [
    'manage_shipping_automation_rules',
    'view_shipping_automation_results',
    'view_shipping_automation_outcomes',
    'resolve_shipping_automation_reviews',
    'approve_shipping_automation_exceptions',
    'override_shipping_automation_guardrails',
    'run_shipping_automation_backfill',
  ],
  batch_labels: ['manage_batch_labels', 'purchase_batch_labels'],
  packing_workflows: [
    'view_packing_workflows',
    'manage_packing_workflows',
    'complete_packing',
    'resolve_packing_exceptions',
    'override_packing_requirements',
  ],
  pickup_requests: ['request_carrier_pickup', 'cancel_carrier_pickup', 'view_pickup_analytics'],
  service_points: ['select_service_point', 'manage_carrier_locator_settings'],
  carrier_analytics: ['view_carrier_analytics'],
  carrier_scorecards: ['view_carrier_scorecards'],
  shipping_sla_optimization: [
    'view_shipping_sla',
    'manage_shipping_sla_policies',
    'pause_shipping_sla',
    'resolve_shipping_sla_exceptions',
    'edit_shipping_sla_delay_reasons',
    'run_shipping_automation_backfill',
  ],
};

// Reverse index: tenant sub id -> feature gate keys that must be entitled.
const TENANT_SUB_FEATURE_GATES: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [feature, subs] of Object.entries(TENANT_FEATURE_PERMISSION_DEPENDENCIES)) {
    for (const sub of subs) {
      const list = m.get(sub) ?? [];
      list.push(feature);
      m.set(sub, list);
    }
  }
  return m;
})();

/**
 * Every entitlement feature key a tenant sub-permission requires (cap-only):
 *   (parent-domain gate, if the domain is plan-optional) ∪ (feature gates).
 * Mirrors isSubPermissionPlanAvailable (parent domain in plan AND feature gates
 * live). All returned keys must be present in the enabled-entitlement map.
 */
export function requiredEntitlementsForTenantSub(sub: TenantSubPermissionDef): readonly string[] {
  const keys: string[] = [];
  const domainGate = TENANT_DOMAIN_ENTITLEMENT[sub.parentDomain];
  if (domainGate) keys.push(domainGate);
  for (const f of TENANT_SUB_FEATURE_GATES.get(sub.id) ?? []) keys.push(f);
  return keys;
}

// The closed set of entitlement feature keys the catalog knows about. An
// entitlement key outside this set can NEVER expand a capability (fail closed) —
// the materializers only ever TEST membership of these known gates against the
// enabled-entitlement map.
export const KNOWN_TENANT_ENTITLEMENT_KEYS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const v of Object.values(TENANT_DOMAIN_ENTITLEMENT)) if (v) s.add(v);
  for (const f of Object.keys(TENANT_FEATURE_PERMISSION_DEPENDENCIES)) s.add(f);
  return s;
})();

// =============================================================================
// TENANT / STORE role defaults (mirror tenantRoles in accessConfig)
// =============================================================================

// store_owner uses the `_grant: 'full'` owner short-circuit (handled in the
// materializer) so it carries no explicit map here.
export const TENANT_ROLE_PERMISSION_DEFAULTS: Readonly<
  Record<Exclude<TenantRoleId, 'store_owner'>, Readonly<Record<string, Level>>>
> = {
  manager: {
    dashboard: 'full', sales: 'full', repairs: 'full', inventory: 'manage',
    customers: 'full', employees: 'manage', warranties: 'manage', refunds: 'approve',
    invoices: 'full', services: 'full', reports: 'full', prospects: 'full',
    marketing: 'manage', suggestive_sales: 'manage', settings: 'manage', support: 'full',
    supply_chain: 'manage', integrations: 'manage', widgets: 'manage', shipping: 'manage',
    returns: 'manage',
  },
  technician: {
    dashboard: 'view', sales: 'none', repairs: 'manage', inventory: 'create',
    customers: 'view', employees: 'none', warranties: 'create', refunds: 'none',
    invoices: 'view', services: 'view', reports: 'none', prospects: 'none',
    marketing: 'none', suggestive_sales: 'none', settings: 'none', support: 'view',
    supply_chain: 'none', integrations: 'none', widgets: 'none', shipping: 'view',
    returns: 'view',
  },
  sales_staff: {
    dashboard: 'view', sales: 'create', repairs: 'none', inventory: 'view',
    customers: 'create', employees: 'none', warranties: 'none', refunds: 'none',
    invoices: 'create', services: 'none', reports: 'none', prospects: 'create',
    marketing: 'none', suggestive_sales: 'view', settings: 'none', support: 'view',
    supply_chain: 'none', integrations: 'none', widgets: 'none', shipping: 'view',
    returns: 'view',
  },
};

// Explicit per-role sub-permission grants (mirror tenantRoles[].subPermissions).
// store_owner is intentionally absent (owner short-circuit). manager/technician/
// sales_staff carry an explicit boolean for every tenant sub.
export const TENANT_ROLE_SUBPERMISSION_DEFAULTS: Readonly<
  Record<Exclude<TenantRoleId, 'store_owner'>, Readonly<Record<string, boolean>>>
> = {
  manager: {
    manage_employees: true, manage_attendance: true, create_roles: true, edit_roles: true,
    manage_role_permissions: true, assign_roles: true, assign_manager_role: false,
    approve_requests: false, manage_compensation: true, approve_inventory: false,
    manage_warranty_claims: true, process_refunds: true, approve_refunds: true,
    process_expired_warranty: true, loyalty_customer_edit: true, loyalty_settings_manage: true,
    reopen_invoice: true, assign_technician: true, adjust_stock: true, create_inventory_items: true,
    manage_transfers: true, manage_purchase_orders: true, manage_trade_ins: true,
    manage_refurbishment: true, manage_stock_counts: true, manage_goods_received_notes: true,
    manage_rmas: true, manage_suppliers: true, create_shipment: true,
    edit_shipment_pre_dispatch: true, dispatch_shipment: true, update_tracking_events: true,
    cancel_shipment: true, view_shipping_costs: true, view_carrier_analytics: true,
    view_carrier_scorecards: true, view_pickup_analytics: true, manage_shipping_settings: true,
    configure_shipping_provider: true, manage_carrier_locator_settings: true,
    validate_shipping_address: true, fetch_shipping_rates: true, purchase_shipping_label: true,
    print_shipping_label: true, sync_shipping_tracking: true, create_return: true,
    approve_return: true, receive_return: true, inspect_return: true,
    complete_return_disposition: true, cancel_return: true, create_return_shipment: true,
    manage_shipping_automation_rules: true, view_shipping_automation_results: true,
    view_shipping_automation_outcomes: true, resolve_shipping_automation_reviews: true,
    approve_shipping_automation_exceptions: true, override_shipping_automation_guardrails: true,
    run_shipping_automation_backfill: true, manage_batch_labels: true, purchase_batch_labels: true,
    view_packing_workflows: true, manage_packing_workflows: true, complete_packing: true,
    resolve_packing_exceptions: true, override_packing_requirements: true, view_shipping_sla: true,
    manage_shipping_sla_policies: true, pause_shipping_sla: true,
    resolve_shipping_sla_exceptions: true, edit_shipping_sla_delay_reasons: true,
    // select_service_point / request_carrier_pickup / cancel_carrier_pickup are
    // not explicitly listed on the manager role default → default-by-level applies.
  },
  technician: {
    manage_employees: false, manage_attendance: false, create_roles: false, edit_roles: false,
    manage_role_permissions: false, assign_roles: false, assign_manager_role: false,
    approve_requests: false, manage_compensation: false, approve_inventory: false,
    manage_warranty_claims: false, process_refunds: false, approve_refunds: false,
    process_expired_warranty: false, loyalty_customer_edit: false, loyalty_settings_manage: false,
    reopen_invoice: false, assign_technician: false, adjust_stock: true, create_inventory_items: true,
    manage_transfers: false, manage_purchase_orders: false, manage_trade_ins: false,
    manage_refurbishment: true, manage_stock_counts: false, manage_goods_received_notes: false,
    manage_rmas: false, manage_suppliers: false, create_shipment: false,
    edit_shipment_pre_dispatch: false, dispatch_shipment: false, update_tracking_events: false,
    cancel_shipment: false, view_shipping_costs: false, view_carrier_analytics: false,
    view_carrier_scorecards: false, view_pickup_analytics: false, manage_shipping_settings: false,
    configure_shipping_provider: false, manage_carrier_locator_settings: false,
    validate_shipping_address: false, fetch_shipping_rates: false, purchase_shipping_label: false,
    print_shipping_label: false, sync_shipping_tracking: false, create_return: false,
    approve_return: false, receive_return: false, inspect_return: false,
    complete_return_disposition: false, cancel_return: false, create_return_shipment: false,
    manage_shipping_automation_rules: false, view_shipping_automation_results: false,
    view_shipping_automation_outcomes: false, resolve_shipping_automation_reviews: false,
    approve_shipping_automation_exceptions: false, override_shipping_automation_guardrails: false,
    run_shipping_automation_backfill: false, manage_batch_labels: false, purchase_batch_labels: false,
    view_packing_workflows: false, manage_packing_workflows: false, complete_packing: false,
    resolve_packing_exceptions: false, override_packing_requirements: false, view_shipping_sla: false,
    manage_shipping_sla_policies: false, pause_shipping_sla: false,
    resolve_shipping_sla_exceptions: false, edit_shipping_sla_delay_reasons: false,
  },
  sales_staff: {
    manage_employees: false, manage_attendance: false, create_roles: false, edit_roles: false,
    manage_role_permissions: false, assign_roles: false, assign_manager_role: false,
    approve_requests: false, manage_compensation: false, approve_inventory: false,
    manage_warranty_claims: false, process_refunds: false, approve_refunds: false,
    process_expired_warranty: false, loyalty_customer_edit: false, loyalty_settings_manage: false,
    reopen_invoice: false, assign_technician: false, adjust_stock: false, create_inventory_items: false,
    manage_transfers: false, manage_purchase_orders: false, manage_trade_ins: false,
    manage_refurbishment: false, manage_stock_counts: false, manage_goods_received_notes: false,
    manage_rmas: false, manage_suppliers: false, create_shipment: false,
    edit_shipment_pre_dispatch: false, dispatch_shipment: false, update_tracking_events: false,
    cancel_shipment: false, view_shipping_costs: false, view_carrier_analytics: false,
    view_carrier_scorecards: false, view_pickup_analytics: false, manage_shipping_settings: false,
    configure_shipping_provider: false, manage_carrier_locator_settings: false,
    validate_shipping_address: false, fetch_shipping_rates: false, purchase_shipping_label: false,
    print_shipping_label: false, sync_shipping_tracking: false, create_return: false,
    approve_return: false, receive_return: false, inspect_return: false,
    complete_return_disposition: false, cancel_return: false, create_return_shipment: false,
    manage_shipping_automation_rules: false, view_shipping_automation_results: false,
    view_shipping_automation_outcomes: false, resolve_shipping_automation_reviews: false,
    approve_shipping_automation_exceptions: false, override_shipping_automation_guardrails: false,
    run_shipping_automation_backfill: false, manage_batch_labels: false, purchase_batch_labels: false,
    view_packing_workflows: false, manage_packing_workflows: false, complete_packing: false,
    resolve_packing_exceptions: false, override_packing_requirements: false, view_shipping_sla: false,
    manage_shipping_sla_policies: false, pause_shipping_sla: false,
    resolve_shipping_sla_exceptions: false, edit_shipping_sla_delay_reasons: false,
  },
};

const TENANT_ROLE_IDS_SET: ReadonlySet<string> = new Set<string>([
  'store_owner',
  'manager',
  'technician',
  'sales_staff',
]);

// =============================================================================
// PLATFORM feature groups + sub-permissions (mirror PLATFORM_FEATURE_GROUPS)
// =============================================================================

export const PLATFORM_FEATURE_KEYS: readonly string[] = [
  'command_center',
  'audit_security',
  'support_tools',
  'tenant_management',
  'billing_subscriptions',
  'platform_settings',
  'domains',
  'team_management',
  'provisioning',
  'feature_matrix',
  'addon_governance',
] as const;

export interface PlatformSubPermissionDef {
  id: string;
  feature: string;
  threshold: Level;
  sensitive: boolean;
}

function platSub(id: string, feature: string, threshold: Level, sensitive = false): PlatformSubPermissionDef {
  return { id, feature, threshold, sensitive };
}

export const PLATFORM_SUB_PERMISSIONS: readonly PlatformSubPermissionDef[] = [
  // command_center
  platSub('view_command_center', 'command_center', 'view'),
  platSub('view_operational_pulse', 'command_center', 'view'),
  platSub('view_needs_attention', 'command_center', 'view'),
  platSub('view_tenant_360', 'command_center', 'view'),
  platSub('use_command_quick_actions', 'command_center', 'view'),
  platSub('view_next_best_actions', 'command_center', 'view'),
  platSub('act_on_nba_recommendations', 'command_center', 'edit'),
  platSub('view_governance_signals', 'command_center', 'view'),
  // audit_security
  platSub('view_audit_security', 'audit_security', 'view'),
  platSub('view_audit_logs', 'audit_security', 'view'),
  platSub('view_actor_profile', 'audit_security', 'view'),
  platSub('view_related_event_timeline', 'audit_security', 'view'),
  platSub('export_audit_csv', 'audit_security', 'approve', true),
  platSub('add_security_note', 'audit_security', 'create'),
  platSub('delete_security_note', 'audit_security', 'approve', true),
  platSub('create_support_case_from_audit', 'audit_security', 'create'),
  platSub('view_restricted_audit_details', 'audit_security', 'approve'),
  platSub('view_escalation_lifecycle_audit', 'audit_security', 'view'),
  platSub('view_governance_audit_lens', 'audit_security', 'view'),
  // support_tools
  platSub('view_support_tools', 'support_tools', 'view'),
  platSub('view_escalation_history', 'support_tools', 'view'),
  platSub('create_support_case', 'support_tools', 'create'),
  platSub('change_support_status', 'support_tools', 'edit'),
  platSub('change_support_severity', 'support_tools', 'edit'),
  platSub('assign_support_case', 'support_tools', 'edit'),
  platSub('close_support_case', 'support_tools', 'manage', true),
  platSub('escalate_assigned_case', 'support_tools', 'edit'),
  platSub('escalate_any_case', 'support_tools', 'manage'),
  platSub('acknowledge_escalation', 'support_tools', 'edit'),
  platSub('assign_escalation_owner_team', 'support_tools', 'manage', true),
  platSub('change_escalation_level', 'support_tools', 'approve', true),
  platSub('deescalate_support_case', 'support_tools', 'edit'),
  platSub('resolve_escalation', 'support_tools', 'approve', true),
  platSub('close_with_active_escalation', 'support_tools', 'manage', true),
  platSub('view_support_sla', 'support_tools', 'view'),
  platSub('view_support_tenant_health', 'support_tools', 'view'),
  platSub('view_support_related_entities', 'support_tools', 'view'),
  platSub('add_internal_support_note', 'support_tools', 'create'),
  platSub('use_support_macro', 'support_tools', 'create'),
  platSub('manage_support_macros', 'support_tools', 'manage', true),
  platSub('edit_support_case', 'support_tools', 'edit'),
  platSub('reopen_support_case', 'support_tools', 'edit'),
  // tenant_management
  platSub('view_tenants', 'tenant_management', 'view'),
  platSub('edit_tenant_profile', 'tenant_management', 'edit'),
  platSub('change_tenant_status', 'tenant_management', 'manage', true),
  // billing_subscriptions
  platSub('view_billing', 'billing_subscriptions', 'view'),
  platSub('edit_subscriptions', 'billing_subscriptions', 'edit'),
  platSub('approve_billing_actions', 'billing_subscriptions', 'approve', true),
  // platform_settings
  platSub('view_platform_settings', 'platform_settings', 'view'),
  platSub('edit_platform_settings', 'platform_settings', 'manage', true),
  // domains
  platSub('view_domains', 'domains', 'view'),
  platSub('manage_domain_lifecycle', 'domains', 'manage', true),
  // team_management
  platSub('view_team', 'team_management', 'view'),
  platSub('manage_team_members', 'team_management', 'manage', true),
  platSub('manage_platform_roles', 'team_management', 'full', true),
  platSub('view_temporary_access', 'team_management', 'view'),
  platSub('manage_temporary_access', 'team_management', 'manage', true),
  platSub('view_access_reviews', 'team_management', 'view'),
  platSub('manage_access_reviews', 'team_management', 'manage', true),
  platSub('capture_sensitive_action_reasons', 'team_management', 'manage', true),
  // provisioning
  platSub('view_provisioning', 'provisioning', 'view'),
  platSub('run_provisioning', 'provisioning', 'manage', true),
  // feature_matrix
  platSub('view_feature_matrix', 'feature_matrix', 'view'),
  platSub('create_plan', 'feature_matrix', 'create'),
  platSub('edit_plan', 'feature_matrix', 'edit'),
  platSub('archive_plan', 'feature_matrix', 'manage', true),
  platSub('edit_feature_matrix', 'feature_matrix', 'manage', true),
  // addon_governance
  platSub('view_addon_governance', 'addon_governance', 'view'),
  platSub('create_addon', 'addon_governance', 'create'),
  platSub('edit_addon', 'addon_governance', 'edit'),
  platSub('archive_delete_addon', 'addon_governance', 'manage', true),
  platSub('manage_addon_compatible_plans', 'addon_governance', 'edit'),
  platSub('manage_addon_readiness', 'addon_governance', 'edit'),
  platSub('generate_addon_implementation_brief', 'addon_governance', 'view'),
  platSub('grant_trial', 'addon_governance', 'approve', true),
  platSub('grant_paid_override', 'addon_governance', 'approve', true),
  platSub('revoke_addon_override', 'addon_governance', 'approve', true),
  platSub('edit_addon_overrides', 'addon_governance', 'approve', true),
];

const PLATFORM_SUB_BY_ID: ReadonlyMap<string, PlatformSubPermissionDef> = new Map(
  PLATFORM_SUB_PERMISSIONS.map((s) => [s.id, s]),
);

/** Platform prerequisite/dependency map (mirror PLATFORM_PERMISSION_DEPENDENCIES). */
export const PLATFORM_PERMISSION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  act_on_nba_recommendations: ['view_next_best_actions'],
  view_escalation_history: ['view_support_tools'],
  create_support_case: ['view_support_tools'],
  change_support_status: ['view_support_tools'],
  change_support_severity: ['view_support_tools'],
  assign_support_case: ['view_support_tools'],
  close_support_case: ['view_support_tools'],
  reopen_support_case: ['view_support_tools'],
  edit_support_case: ['view_support_tools'],
  escalate_assigned_case: ['view_support_tools'],
  escalate_any_case: ['view_support_tools'],
  acknowledge_escalation: ['view_support_tools'],
  assign_escalation_owner_team: ['view_support_tools'],
  change_escalation_level: ['view_support_tools'],
  deescalate_support_case: ['view_support_tools'],
  resolve_escalation: ['view_support_tools'],
  close_with_active_escalation: ['view_support_tools', 'close_support_case'],
  view_support_sla: ['view_support_tools'],
  view_support_tenant_health: ['view_support_tools'],
  view_support_related_entities: ['view_support_tools'],
  add_internal_support_note: ['view_support_tools'],
  use_support_macro: ['add_internal_support_note'],
  manage_support_macros: ['view_support_tools'],
  view_audit_logs: ['view_audit_security'],
  view_actor_profile: ['view_audit_security'],
  view_related_event_timeline: ['view_audit_security'],
  view_restricted_audit_details: ['view_audit_security'],
  view_escalation_lifecycle_audit: ['view_audit_security'],
  export_audit_csv: ['view_audit_logs'],
  add_security_note: ['view_audit_security'],
  delete_security_note: ['view_audit_security'],
  create_support_case_from_audit: ['view_audit_security', 'create_support_case'],
  manage_temporary_access: ['view_temporary_access'],
  manage_access_reviews: ['view_access_reviews'],
  capture_sensitive_action_reasons: ['view_access_reviews'],
  view_governance_signals: ['view_command_center'],
  view_governance_audit_lens: ['view_audit_security'],
  create_addon: ['view_addon_governance'],
  edit_addon: ['view_addon_governance'],
  archive_delete_addon: ['view_addon_governance'],
  manage_addon_compatible_plans: ['view_addon_governance'],
  manage_addon_readiness: ['view_addon_governance'],
  generate_addon_implementation_brief: ['view_addon_governance'],
  grant_trial: ['view_addon_governance'],
  grant_paid_override: ['view_addon_governance'],
  revoke_addon_override: ['view_addon_governance'],
  edit_addon_overrides: ['view_addon_governance'],
};

// =============================================================================
// PLATFORM role defaults (mirror DEFAULT_PLATFORM_FEATURE_LEVELS)
// =============================================================================

const PLATFORM_ALL_FULL: Readonly<Record<string, Level>> = Object.fromEntries(
  PLATFORM_FEATURE_KEYS.map((k) => [k, 'full' as Level]),
);

export const PLATFORM_ROLE_FEATURE_DEFAULTS: Readonly<
  Record<PlatformRoleId, Readonly<Record<string, Level>>>
> = {
  system_owner: { ...PLATFORM_ALL_FULL },
  support_admin: {
    command_center: 'manage', audit_security: 'view', support_tools: 'full',
    tenant_management: 'edit', billing_subscriptions: 'view', platform_settings: 'view',
    domains: 'view', team_management: 'view', provisioning: 'view',
    feature_matrix: 'view', addon_governance: 'view',
  },
  billing_admin: {
    command_center: 'view', audit_security: 'view', support_tools: 'view',
    tenant_management: 'view', billing_subscriptions: 'full', platform_settings: 'view',
    domains: 'none', team_management: 'view', provisioning: 'none',
    feature_matrix: 'manage', addon_governance: 'manage',
  },
  operations_admin: {
    command_center: 'manage', audit_security: 'view', support_tools: 'manage',
    tenant_management: 'full', billing_subscriptions: 'view', platform_settings: 'edit',
    domains: 'full', team_management: 'view', provisioning: 'full',
    feature_matrix: 'manage', addon_governance: 'edit',
  },
  security_admin: {
    command_center: 'manage', audit_security: 'full', support_tools: 'approve',
    tenant_management: 'view', billing_subscriptions: 'view', platform_settings: 'manage',
    domains: 'view', team_management: 'manage', provisioning: 'view',
    feature_matrix: 'view', addon_governance: 'view',
  },
};

const PLATFORM_ROLE_IDS_SET: ReadonlySet<string> = new Set<string>(Object.keys(PLATFORM_ROLE_FEATURE_DEFAULTS));

// =============================================================================
// Pure materializers
// =============================================================================

function tenantBaseDomainLevel(role: TenantRoleId, domain: string): Level {
  if (role === 'store_owner') return 'full'; // _grant: 'full' owner short-circuit
  const map = (TENANT_ROLE_PERMISSION_DEFAULTS as Record<string, Record<string, Level>>)[role];
  return (map?.[domain] ?? 'none') as Level;
}

/** Role base level capped by entitlement gate only (NOT status). */
function tenantEntitledDomainLevel(role: TenantRoleId, domain: string, ent: FeatureEntitlements): Level {
  const base = tenantBaseDomainLevel(role, domain);
  if (base === 'none') return 'none';
  const gate = TENANT_DOMAIN_ENTITLEMENT[domain];
  if (gate && ent[gate] !== true) return 'none'; // plan-disabled domain → removed (cap-only)
  return base;
}

/**
 * Materialize tenant/store DOMAIN permissions. Role defaults capped by
 * plan/entitlement (cap-only) then by read-only status. Returns a complete map
 * over every tenant domain (explicit `none` entries included — never empty on a
 * resolvable role).
 */
export function materializeTenantPermissions(
  role: TenantRoleId | string,
  entitlements: FeatureEntitlements,
  limited: boolean,
): EffectivePermissions {
  if (!TENANT_ROLE_IDS_SET.has(role)) return {}; // fail closed on unknown role
  const r = role as TenantRoleId;
  const out: EffectivePermissions = {};
  for (const domain of TENANT_PERMISSION_DOMAINS) {
    let level = tenantEntitledDomainLevel(r, domain, entitlements);
    if (limited) level = capTenantLevelForReadOnly(level);
    out[domain] = level;
  }
  return out;
}

/**
 * Materialize tenant/store SUB-permissions with the binding precedence:
 *   1. plan/entitlement availability (false if any required gate not entitled),
 *   2. owner short-circuit (store_owner) — ONLY after plan gating,
 *   3. parent-domain minModuleLevel,
 *   4. explicit per-role grant,
 *   5. default-by-level fallback,
 *   6. read-only status cap (mutating subs → false; read-safe subs preserved).
 */
export function materializeTenantSubPermissions(
  role: TenantRoleId | string,
  entitlements: FeatureEntitlements,
  limited: boolean,
): EffectiveSubPermissions {
  if (!TENANT_ROLE_IDS_SET.has(role)) return {}; // fail closed on unknown role
  const r = role as TenantRoleId;
  const explicitMap = (TENANT_ROLE_SUBPERMISSION_DEFAULTS as Record<string, Record<string, boolean>>)[r];
  const out: EffectiveSubPermissions = {};

  for (const sub of TENANT_SUB_PERMISSIONS) {
    let granted: boolean;
    // 1) Plan/entitlement availability FIRST.
    const required = requiredEntitlementsForTenantSub(sub);
    if (!required.every((k) => entitlements[k] === true)) {
      granted = false;
    } else if (r === 'store_owner') {
      // 2) Owner short-circuit, AFTER plan gating.
      granted = true;
    } else {
      // 3) Parent-domain minimum module level.
      const parent = tenantEntitledDomainLevel(r, sub.parentDomain, entitlements);
      if (!meetsTenantPermissionLevel(parent, sub.minModuleLevel)) {
        granted = false;
      } else {
        // 4) Explicit per-role grant wins, else 5) default-by-level.
        const explicit = explicitMap ? explicitMap[sub.id] : undefined;
        granted = explicit !== undefined ? explicit : meetsTenantPermissionLevel(parent, sub.defaultLevel);
      }
    }
    // 6) Read-only status cap.
    if (limited && sub.mutating) granted = false;
    out[sub.id] = granted;
  }
  return out;
}

function platformFeatureLevel(role: PlatformRoleId, feature: string): Level {
  if (role === 'system_owner') return 'full';
  const map = (PLATFORM_ROLE_FEATURE_DEFAULTS as Record<string, Record<string, Level>>)[role];
  return (map?.[feature] ?? 'none') as Level;
}

/**
 * Materialize platform FEATURE permissions for a platform role (defaults only —
 * there is no per-tenant plan/entitlement gating on the platform side). Capped by
 * read-only status. Fail-closed `{}` for an unmapped role.
 */
export function materializePlatformPermissions(
  role: PlatformRoleId | string,
  limited: boolean,
): EffectivePermissions {
  if (!PLATFORM_ROLE_IDS_SET.has(role)) return {}; // fail closed on unmapped role
  const r = role as PlatformRoleId;
  const out: EffectivePermissions = {};
  for (const feature of PLATFORM_FEATURE_KEYS) {
    let level = platformFeatureLevel(r, feature);
    if (limited) level = capPlatformLevelForReadOnly(level);
    out[feature] = level;
  }
  return out;
}

// Defaults-only platform sub resolution (no sessionStorage overrides exist
// server-side): inherited parent-feature level must meet the sub threshold AND
// every prerequisite must independently resolve allowed (transitive, cycle-safe).
function platformSubAllowedByDefaults(
  role: PlatformRoleId,
  subId: string,
  visiting: Set<string>,
): boolean {
  const def = PLATFORM_SUB_BY_ID.get(subId);
  if (!def) return false; // unknown sub → fail closed
  const level = role === 'system_owner' ? 'full' : platformFeatureLevel(role, def.feature);
  if (!meetsPlatformPermissionLevel(level, def.threshold)) return false;
  const deps = PLATFORM_PERMISSION_DEPENDENCIES[subId] ?? [];
  for (const dep of deps) {
    if (visiting.has(dep)) continue; // cycle guard
    const next = new Set(visiting);
    next.add(subId);
    if (!platformSubAllowedByDefaults(role, dep, next)) return false;
  }
  return true;
}

/**
 * Materialize platform SUB-permissions for a platform role. Each sub is granted
 * when its inherited parent-feature default level meets the sub threshold AND all
 * prerequisites resolve. Under read-only status only non-sensitive view-threshold
 * subs survive. Fail-closed `{}` for an unmapped role.
 */
export function materializePlatformSubPermissions(
  role: PlatformRoleId | string,
  limited: boolean,
): EffectiveSubPermissions {
  if (!PLATFORM_ROLE_IDS_SET.has(role)) return {}; // fail closed on unmapped role
  const r = role as PlatformRoleId;
  const out: EffectiveSubPermissions = {};
  for (const sub of PLATFORM_SUB_PERMISSIONS) {
    let granted = platformSubAllowedByDefaults(r, sub.id, new Set<string>());
    if (limited && granted && (sub.threshold !== 'view' || sub.sensitive)) granted = false;
    out[sub.id] = granted;
  }
  return out;
}

// =============================================================================
// Resolver entry point — selects the correct materializers by resolved role
// =============================================================================

export interface MaterializeCapabilitiesInput {
  /** Resolved platform role id (platform scope), else null. */
  platformRoleId: PlatformRoleId | null;
  /** Resolved tenant/store role id (tenant/store scope), else null. */
  tenantRoleId: TenantRoleId | null;
  /** Enabled-only entitlement map for the in-scope tenant (cap-only). */
  entitlements: FeatureEntitlements;
  /** read_only / overdue limitation flag (status-derived). */
  limited: boolean;
}

/**
 * Single entry point the resolver's allow() choke-point calls. Selects the
 * platform or tenant materializers by which role id is resolved. Returns empty
 * maps (fail closed) only when NEITHER role resolved — every genuine allow
 * carries a populated, non-empty map (empty is never "full").
 */
export function materializeCapabilities(
  input: MaterializeCapabilitiesInput,
): { permissions: EffectivePermissions; subPermissions: EffectiveSubPermissions } {
  if (input.platformRoleId) {
    return {
      permissions: materializePlatformPermissions(input.platformRoleId, input.limited),
      subPermissions: materializePlatformSubPermissions(input.platformRoleId, input.limited),
    };
  }
  if (input.tenantRoleId) {
    return {
      permissions: materializeTenantPermissions(input.tenantRoleId, input.entitlements, input.limited),
      subPermissions: materializeTenantSubPermissions(input.tenantRoleId, input.entitlements, input.limited),
    };
  }
  return { permissions: {}, subPermissions: {} };
}
