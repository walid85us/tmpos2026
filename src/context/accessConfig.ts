import { EmployeeRole, PermissionLevel } from '../types';

export type Role = 'system_owner' | 'support_admin' | 'billing_admin' | 'operations_admin' | 'security_admin' | 'store_owner' | 'manager' | 'technician' | 'sales_staff';
export type Plan = 'starter' | 'growth' | 'advanced';
export type AccountStatus = 'active' | 'trialing' | 'overdue' | 'suspended' | 'read_only' | 'pending_activation';

export const PERMISSION_HIERARCHY: PermissionLevel[] = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];

export function meetsPermissionLevel(actual: PermissionLevel, required: PermissionLevel): boolean {
  return PERMISSION_HIERARCHY.indexOf(actual) >= PERMISSION_HIERARCHY.indexOf(required);
}

export const PERMISSION_DOMAINS = [
  { id: 'dashboard', label: 'Dashboard', levels: ['none', 'view', 'full'] as PermissionLevel[] },
  { id: 'sales', label: 'Sales / POS', levels: ['none', 'view', 'create', 'edit', 'manage', 'full'] as PermissionLevel[] },
  { id: 'repairs', label: 'Repairs', levels: ['none', 'view', 'create', 'edit', 'manage', 'full'] as PermissionLevel[] },
  { id: 'inventory', label: 'Inventory', levels: ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'] as PermissionLevel[] },
  { id: 'customers', label: 'Customers', levels: ['none', 'view', 'create', 'edit', 'full'] as PermissionLevel[] },
  { id: 'employees', label: 'Employees / Team', levels: ['none', 'view', 'manage', 'full'] as PermissionLevel[] },
  { id: 'warranties', label: 'Warranties', levels: ['none', 'view', 'create', 'manage', 'full'] as PermissionLevel[] },
  { id: 'refunds', label: 'Refunds', levels: ['none', 'view', 'create', 'approve', 'full'] as PermissionLevel[] },
  { id: 'invoices', label: 'Invoices', levels: ['none', 'view', 'create', 'edit', 'full'] as PermissionLevel[] },
  { id: 'services', label: 'Services', levels: ['none', 'view', 'create', 'edit', 'manage', 'full'] as PermissionLevel[] },
  { id: 'reports', label: 'Reports', levels: ['none', 'view', 'full'] as PermissionLevel[] },
  { id: 'prospects', label: 'Prospects', levels: ['none', 'view', 'create', 'edit', 'full'] as PermissionLevel[] },
  { id: 'marketing', label: 'Marketing', levels: ['none', 'view', 'create', 'manage', 'full'] as PermissionLevel[] },
  { id: 'suggestive_sales', label: 'Suggestive Sales', levels: ['none', 'view', 'manage', 'full'] as PermissionLevel[] },
  { id: 'settings', label: 'Settings', levels: ['none', 'view', 'manage', 'full'] as PermissionLevel[] },
  { id: 'support', label: 'Support', levels: ['none', 'view', 'create', 'full'] as PermissionLevel[] },
  { id: 'supply_chain', label: 'Supply Chain', levels: ['none', 'view', 'create', 'edit', 'manage', 'full'] as PermissionLevel[] },
  { id: 'integrations', label: 'Integrations', levels: ['none', 'view', 'manage', 'full'] as PermissionLevel[] },
  { id: 'widgets', label: 'Widgets', levels: ['none', 'view', 'manage', 'full'] as PermissionLevel[] },
  { id: 'shipping', label: 'Shipping', levels: ['none', 'view', 'create', 'edit', 'manage', 'full'] as PermissionLevel[] },
  { id: 'returns', label: 'Returns', levels: ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'] as PermissionLevel[] },
] as const;

export const adminPermissions = [
  'manage_employees',
  'create_roles',
  'edit_roles',
  'manage_role_permissions',
  'assign_roles',
  'assign_same_role',
  'assign_manager_role',
  'manage_attendance',
  'manage_compensation',
  'approve_requests',
];

export interface SubPermissionDef {
  id: string;
  label: string;
  parentDomain: string;
  minModuleLevel: PermissionLevel;
  defaultLevel: PermissionLevel;
  description: string;
}

export const SUB_PERMISSIONS: SubPermissionDef[] = [
  { id: 'manage_employees', label: 'Manage Employees', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Add, edit, and remove employees' },
  { id: 'manage_attendance', label: 'Manage Attendance', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Manage time tracking and attendance' },
  { id: 'create_roles', label: 'Create Roles', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Create new store roles' },
  { id: 'edit_roles', label: 'Edit Roles', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Edit existing roles' },
  { id: 'manage_role_permissions', label: 'Manage Role Permissions', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Modify permissions for roles' },
  { id: 'assign_roles', label: 'Assign Roles', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Assign roles to employees' },
  { id: 'assign_manager_role', label: 'Assign Manager Role', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Assign the Manager role' },
  { id: 'approve_requests', label: 'Approve Requests', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'approve', description: 'Approve employee and role requests' },
  { id: 'manage_compensation', label: 'Manage Compensation', parentDomain: 'employees', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Manage pay rates and commissions' },
  { id: 'approve_inventory', label: 'Approve Inventory Requests', parentDomain: 'inventory', minModuleLevel: 'view', defaultLevel: 'approve', description: 'Approve stock additions and adjustments' },
  { id: 'manage_warranty_claims', label: 'Manage Warranty Claims', parentDomain: 'warranties', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Process and resolve warranty claims' },
  { id: 'process_refunds', label: 'Process Refunds', parentDomain: 'refunds', minModuleLevel: 'view', defaultLevel: 'create', description: 'Initiate and process customer refunds' },
  { id: 'approve_refunds', label: 'Approve Refunds', parentDomain: 'refunds', minModuleLevel: 'view', defaultLevel: 'approve', description: 'Approve refund requests' },
  { id: 'process_expired_warranty', label: 'Process Expired Warranty', parentDomain: 'warranties', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Allow processing of warranty claims on expired warranty items' },
  { id: 'loyalty_customer_edit', label: 'Edit Customer Loyalty', parentDomain: 'customers', minModuleLevel: 'view', defaultLevel: 'edit', description: 'Edit customer loyalty tier and points' },
  { id: 'loyalty_settings_manage', label: 'Manage Loyalty Settings', parentDomain: 'customers', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Configure loyalty program settings, tiers, and privileges' },
  { id: 'reopen_invoice', label: 'Reopen Invoice', parentDomain: 'invoices', minModuleLevel: 'view', defaultLevel: 'manage', description: 'Reopen a paid or cancelled invoice for further editing' },
  { id: 'assign_technician', label: 'Assign Technician', parentDomain: 'repairs', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Assign or reassign technicians to repair tickets' },
  { id: 'adjust_stock', label: 'Adjust Stock', parentDomain: 'inventory', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Increase or decrease stock levels with reason tracking' },
  { id: 'manage_transfers', label: 'Manage Transfers', parentDomain: 'inventory', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Create and manage inventory transfers between locations' },
  { id: 'manage_purchase_orders', label: 'Manage Purchase Orders', parentDomain: 'supply_chain', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Create, send, and receive purchase orders from suppliers' },
  { id: 'manage_trade_ins', label: 'Manage Trade-Ins', parentDomain: 'inventory', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Create and process trade-in items' },
  { id: 'manage_refurbishment', label: 'Manage Refurbishment', parentDomain: 'inventory', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Create and manage refurbishment jobs' },
  { id: 'manage_stock_counts', label: 'Manage Stock Counts', parentDomain: 'inventory', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Start and complete stock count audits' },
  { id: 'manage_goods_received_notes', label: 'Manage GRNs', parentDomain: 'supply_chain', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Process and record goods received notes' },
  { id: 'manage_rmas', label: 'Manage RMAs', parentDomain: 'supply_chain', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Create and manage return merchandise authorizations' },
  { id: 'manage_suppliers', label: 'Manage Suppliers', parentDomain: 'supply_chain', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Add and edit supplier records' },
  { id: 'create_inventory_items', label: 'Create Inventory Items', parentDomain: 'inventory', minModuleLevel: 'create', defaultLevel: 'create', description: 'Add new products to inventory' },
  { id: 'create_shipment', label: 'Create Shipment', parentDomain: 'shipping', minModuleLevel: 'create', defaultLevel: 'create', description: 'Create new shipment records' },
  { id: 'edit_shipment_pre_dispatch', label: 'Edit Shipment (Pre-Dispatch)', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'edit', description: 'Edit shipment details before dispatch' },
  { id: 'dispatch_shipment', label: 'Dispatch Shipment', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Mark shipments as dispatched' },
  { id: 'update_tracking_events', label: 'Update Tracking', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'edit', description: 'Add tracking events and updates' },
  { id: 'cancel_shipment', label: 'Cancel Shipment', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Cancel shipment records' },
  { id: 'view_shipping_costs', label: 'View Shipping Costs', parentDomain: 'shipping', minModuleLevel: 'view', defaultLevel: 'edit', description: 'View shipment cost and financial details' },
  { id: 'manage_shipping_settings', label: 'Manage Shipping Settings', parentDomain: 'shipping', minModuleLevel: 'manage', defaultLevel: 'manage', description: 'Configure carrier providers and shipping settings' },
  { id: 'validate_shipping_address', label: 'Validate Address', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'edit', description: 'Validate shipping addresses via provider' },
  { id: 'fetch_shipping_rates', label: 'Fetch Rates', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'edit', description: 'Retrieve shipping rates from provider' },
  { id: 'purchase_shipping_label', label: 'Purchase Label', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Purchase shipping labels via provider' },
  { id: 'print_shipping_label', label: 'Print/Open Label', parentDomain: 'shipping', minModuleLevel: 'view', defaultLevel: 'view', description: 'Open or print purchased shipping labels' },
  { id: 'sync_shipping_tracking', label: 'Sync Tracking', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'edit', description: 'Sync tracking updates from shipping provider' },
  { id: 'select_service_point', label: 'Select Service Point', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'edit', description: 'Select or change a carrier service-point / drop-off location for a shipment' },
  { id: 'request_carrier_pickup', label: 'Request Carrier Pickup', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'edit', description: 'Schedule a carrier pickup for a shipment where supported' },
  { id: 'cancel_carrier_pickup', label: 'Cancel Carrier Pickup', parentDomain: 'shipping', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Cancel a previously requested carrier pickup' },
  { id: 'view_carrier_analytics', label: 'View Carrier Analytics', parentDomain: 'shipping', minModuleLevel: 'view', defaultLevel: 'manage', description: 'View Shipping Center carrier analytics — shipment counts, status buckets (Dispatched separate from In Transit), carrier/service distribution, and lifecycle timing derived from real shipment, pickup, and event data. Default-grants only at manage-level on Shipping (admin/manager); other roles must be explicitly opted in. Cost-related metrics also require View Shipping Costs. Pickup analytics blocks additionally require the View Pickup Analytics sub-permission and the Pickup Requests plan feature.' },
  { id: 'view_pickup_analytics', label: 'View Pickup Analytics', parentDomain: 'shipping', minModuleLevel: 'view', defaultLevel: 'manage', description: 'View pickup-analytics surfaces inside Carrier Analytics — counts of requested / provider-confirmed / local-only / cancelled / failed pickups. Independently gated from operational pickup permissions so analytics visibility can be granted (or withheld) without giving the operator the ability to schedule or cancel pickups. Also requires the Pickup Requests plan feature.' },
  { id: 'manage_carrier_locator_settings', label: 'Manage Carrier Locator Settings', parentDomain: 'shipping', minModuleLevel: 'manage', defaultLevel: 'manage', description: 'Configure per-store carrier-locator adapters (USPS / FedEx / UPS / DHL / GLS) used for live service-point lookup. Independent of Manage Shipping Settings (which controls aggregator-level provider configuration like EasyPost / Shippo / ShipStation). Requires the Service Points plan feature.' },
  { id: 'create_return', label: 'Create Return', parentDomain: 'returns', minModuleLevel: 'create', defaultLevel: 'create', description: 'Initiate a new return request' },
  { id: 'approve_return', label: 'Approve Return', parentDomain: 'returns', minModuleLevel: 'manage', defaultLevel: 'approve', description: 'Approve or reject return requests' },
  { id: 'receive_return', label: 'Receive Return', parentDomain: 'returns', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Mark returns as received and perform intake' },
  { id: 'inspect_return', label: 'Inspect Return', parentDomain: 'returns', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Perform return inspection and record condition' },
  { id: 'complete_return_disposition', label: 'Complete Disposition', parentDomain: 'returns', minModuleLevel: 'manage', defaultLevel: 'manage', description: 'Finalize return disposition and resolution' },
  { id: 'cancel_return', label: 'Cancel Return', parentDomain: 'returns', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Cancel a return request' },
  { id: 'create_return_shipment', label: 'Create Return Shipment', parentDomain: 'returns', minModuleLevel: 'edit', defaultLevel: 'manage', description: 'Create a return shipment and generate return label' },
];

export const ADMIN_ACTION_LEVEL_MAP = SUB_PERMISSIONS;

// =============================================================================
// FEATURE → PERMISSION DEPENDENCY MAP (Phase 2 plan-to-permission propagation)
// =============================================================================
//
// General rule: If a tenant's plan disables a feature, every sub-permission
// listed under that feature here is treated as PLAN-LOCKED in the Store
// Permissions Matrix and cannot be granted to any role. The runtime evaluator
// (`checkSubPermission`) ALSO short-circuits to denied for plan-locked
// sub-permissions, so a stale role grant cannot resurrect a plan-disabled
// capability — plan decides whether the feature exists, role decides who can
// use it, and role can never override plan.
//
// This map is the SINGLE source of truth for that propagation. Adding a new
// feature with related sub-permissions only requires adding the row here and
// the matrix UI / runtime guards pick it up automatically — there is no need
// to touch Employees.tsx or per-feature gating sites.
//
// Note: a sub-permission's parent module (e.g. `shipping`) is also implicitly
// a plan dependency, handled separately by `isSubPermissionPlanAvailable()`.
// This map is for FEATURE-level dependencies WITHIN an enabled module.
export const FEATURE_PERMISSION_DEPENDENCIES: Record<string, string[]> = {
  // Shipping Provider Configuration controls aggregator-backed actions. When
  // the plan excludes it, no role can configure providers, fetch live rates,
  // purchase labels, validate addresses against carriers, or sync tracking —
  // all of these require an active aggregator connection.
  shipping_providers: [
    'manage_shipping_settings',
    'fetch_shipping_rates',
    'purchase_shipping_label',
    'validate_shipping_address',
    'sync_shipping_tracking',
  ],
  // Pickup Requests controls operational pickup flows AND pickup analytics
  // visibility. Without the plan feature there is nothing to schedule, cancel,
  // or analyze — so all related sub-permissions are plan-locked.
  pickup_requests: [
    'request_carrier_pickup',
    'cancel_carrier_pickup',
    'view_pickup_analytics',
  ],
  // Service Points (Carrier Locators) controls per-store locator adapter
  // configuration AND the operator's ability to pick a service point for a
  // shipment. Both depend on the plan including locator capability.
  service_points: [
    'select_service_point',
    'manage_carrier_locator_settings',
  ],
  // Carrier Analytics controls the analytics surface; the view-permission is
  // meaningless without the analytics feature being available at the plan
  // level.
  carrier_analytics: [
    'view_carrier_analytics',
  ],
};

// Reverse lookup: which plan features must be live for this sub-permission to
// be assignable to a role.
export function getFeatureGatesForSubPermission(subPermId: string): string[] {
  return Object.entries(FEATURE_PERMISSION_DEPENDENCIES)
    .filter(([, perms]) => perms.includes(subPermId))
    .map(([feature]) => feature);
}

// Plan-feature live check that reads the System Owner's runtime override from
// sessionStorage (`features_data`) when present, falls back to the static
// `planFeatures` map otherwise. Mirrors the behavior of
// ShippingCenter.isPlanFeatureLive but in a context-free helper so any
// component (Employees matrix, ShippingCenter, AccessContext) can call it
// consistently.
export function isPlanFeatureLiveFor(plan: Plan | string | undefined | null, featureId: string): boolean {
  if (!plan) return false;
  const planKey = (plan as string) === 'starter' ? 'essential' : (plan as string);
  let matrix: Array<{ id: string; planAvailability?: Record<string, boolean> }> = [];
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem('features_data');
      if (raw) matrix = JSON.parse(raw);
    }
  } catch { /* ignore parse errors — fall back to static planFeatures */ }
  if (Array.isArray(matrix) && matrix.length > 0) {
    const entry = matrix.find(f => f.id === featureId);
    if (entry && entry.planAvailability) return !!entry.planAvailability[planKey];
  }
  return (planFeatures[plan as Plan] || []).includes(featureId);
}

// Returns true if the sub-permission is plan-eligible for the given tenant
// plan: BOTH (a) the sub-permission's parent domain must be in the plan AND
// (b) every feature gate from FEATURE_PERMISSION_DEPENDENCIES must be live.
// Returns false when EITHER condition fails — i.e. the sub-permission is
// plan-locked and must not be assignable in the matrix.
export function isSubPermissionPlanAvailable(sub: SubPermissionDef, plan: Plan | string | undefined | null): boolean {
  if (!plan) return false;
  const planFeats = planFeatures[plan as Plan] || [];
  if (!planFeats.includes(sub.parentDomain)) return false;
  const gates = getFeatureGatesForSubPermission(sub.id);
  return gates.every(f => isPlanFeatureLiveFor(plan, f));
}

export function getSubPermissionsForDomain(domainId: string): SubPermissionDef[] {
  return SUB_PERMISSIONS.filter(sp => sp.parentDomain === domainId);
}

export function getDomainsWithSubPermissions(): string[] {
  return [...new Set(SUB_PERMISSIONS.map(sp => sp.parentDomain))];
}

export const platformRoles = [
  { id: 'system_owner', name: 'System Owner', permissions: ['all'], description: 'Full platform access' },
  { id: 'support_admin', name: 'Support Admin', permissions: ['tenants', 'support_tools'], description: 'Customer support and troubleshooting' },
  { id: 'billing_admin', name: 'Billing Admin', permissions: ['billing', 'subscriptions', 'plans', 'usage'], description: 'Financial and subscription management' },
  { id: 'operations_admin', name: 'Operations Admin', permissions: ['tenants', 'provisioning', 'domains', 'plans'], description: 'Infrastructure and tenant operations' },
  { id: 'security_admin', name: 'Security/Audit Admin', permissions: ['audit_security', 'team_management', 'platform_settings'], description: 'Security, compliance, and team access' },
];

export const tenantRoles: EmployeeRole[] = [
  {
    id: 'store_owner', name: 'Store Owner',
    permissions: { _grant: 'full' } as Record<string, PermissionLevel>,
    description: 'Full system access'
  },
  {
    id: 'manager', name: 'Manager',
    permissions: {
      dashboard: 'full',
      sales: 'full',
      repairs: 'full',
      inventory: 'manage',
      customers: 'full',
      employees: 'manage',
      warranties: 'manage',
      refunds: 'approve',
      invoices: 'full',
      services: 'full',
      reports: 'full',
      prospects: 'full',
      marketing: 'manage',
      suggestive_sales: 'manage',
      settings: 'manage',
      support: 'full',
      supply_chain: 'manage',
      integrations: 'manage',
      widgets: 'manage',
      shipping: 'manage',
      returns: 'manage',
    } as Record<string, PermissionLevel>,
    subPermissions: {
      manage_employees: true,
      manage_attendance: true,
      create_roles: true,
      edit_roles: true,
      manage_role_permissions: true,
      assign_roles: true,
      assign_manager_role: false,
      approve_requests: false,
      manage_compensation: true,
      approve_inventory: false,
      manage_warranty_claims: true,
      process_refunds: true,
      approve_refunds: true,
      process_expired_warranty: true,
      loyalty_customer_edit: true,
      loyalty_settings_manage: true,
      reopen_invoice: true,
      assign_technician: true,
      adjust_stock: true,
      create_inventory_items: true,
      manage_transfers: true,
      manage_purchase_orders: true,
      manage_trade_ins: true,
      manage_refurbishment: true,
      manage_stock_counts: true,
      manage_goods_received_notes: true,
      manage_rmas: true,
      manage_suppliers: true,
      create_shipment: true,
      edit_shipment_pre_dispatch: true,
      dispatch_shipment: true,
      update_tracking_events: true,
      cancel_shipment: true,
      view_shipping_costs: true,
      view_carrier_analytics: true,
      view_pickup_analytics: true,
      manage_shipping_settings: true,
      manage_carrier_locator_settings: true,
      validate_shipping_address: true,
      fetch_shipping_rates: true,
      purchase_shipping_label: true,
      print_shipping_label: true,
      sync_shipping_tracking: true,
      create_return: true,
      approve_return: true,
      receive_return: true,
      inspect_return: true,
      complete_return_disposition: true,
      cancel_return: true,
      create_return_shipment: true,
    },
    description: 'Store management access'
  },
  {
    id: 'technician', name: 'Technician',
    permissions: {
      dashboard: 'view',
      sales: 'none',
      repairs: 'manage',
      inventory: 'create',
      customers: 'view',
      employees: 'none',
      warranties: 'create',
      refunds: 'none',
      invoices: 'view',
      services: 'view',
      reports: 'none',
      prospects: 'none',
      marketing: 'none',
      suggestive_sales: 'none',
      settings: 'none',
      support: 'view',
      supply_chain: 'none',
      integrations: 'none',
      widgets: 'none',
      shipping: 'view',
      returns: 'view',
    } as Record<string, PermissionLevel>,
    subPermissions: {
      manage_employees: false,
      manage_attendance: false,
      create_roles: false,
      edit_roles: false,
      manage_role_permissions: false,
      assign_roles: false,
      assign_manager_role: false,
      approve_requests: false,
      manage_compensation: false,
      approve_inventory: false,
      manage_warranty_claims: false,
      process_refunds: false,
      approve_refunds: false,
      process_expired_warranty: false,
      loyalty_customer_edit: false,
      loyalty_settings_manage: false,
      reopen_invoice: false,
      assign_technician: false,
      adjust_stock: true,
      create_inventory_items: true,
      manage_transfers: false,
      manage_purchase_orders: false,
      manage_trade_ins: false,
      manage_refurbishment: true,
      manage_stock_counts: false,
      manage_goods_received_notes: false,
      manage_rmas: false,
      manage_suppliers: false,
      create_shipment: false,
      edit_shipment_pre_dispatch: false,
      dispatch_shipment: false,
      update_tracking_events: false,
      cancel_shipment: false,
      view_shipping_costs: false,
      view_carrier_analytics: false,
      view_pickup_analytics: false,
      manage_shipping_settings: false,
      manage_carrier_locator_settings: false,
      validate_shipping_address: false,
      fetch_shipping_rates: false,
      purchase_shipping_label: false,
      print_shipping_label: false,
      sync_shipping_tracking: false,
      create_return: false,
      approve_return: false,
      receive_return: false,
      inspect_return: false,
      complete_return_disposition: false,
      cancel_return: false,
      create_return_shipment: false,
    },
    description: 'Repair and parts access'
  },
  {
    id: 'sales_staff', name: 'Sales Associate',
    permissions: {
      dashboard: 'view',
      sales: 'create',
      repairs: 'none',
      inventory: 'view',
      customers: 'create',
      employees: 'none',
      warranties: 'none',
      refunds: 'none',
      invoices: 'create',
      services: 'none',
      reports: 'none',
      prospects: 'create',
      marketing: 'none',
      suggestive_sales: 'view',
      settings: 'none',
      support: 'view',
      supply_chain: 'none',
      integrations: 'none',
      widgets: 'none',
      shipping: 'view',
      returns: 'view',
    } as Record<string, PermissionLevel>,
    subPermissions: {
      manage_employees: false,
      manage_attendance: false,
      create_roles: false,
      edit_roles: false,
      manage_role_permissions: false,
      assign_roles: false,
      assign_manager_role: false,
      approve_requests: false,
      manage_compensation: false,
      approve_inventory: false,
      manage_warranty_claims: false,
      process_refunds: false,
      approve_refunds: false,
      process_expired_warranty: false,
      loyalty_customer_edit: false,
      loyalty_settings_manage: false,
      reopen_invoice: false,
      assign_technician: false,
      adjust_stock: false,
      create_inventory_items: false,
      manage_transfers: false,
      manage_purchase_orders: false,
      manage_trade_ins: false,
      manage_refurbishment: false,
      manage_stock_counts: false,
      manage_goods_received_notes: false,
      manage_rmas: false,
      manage_suppliers: false,
      create_shipment: false,
      edit_shipment_pre_dispatch: false,
      dispatch_shipment: false,
      update_tracking_events: false,
      cancel_shipment: false,
      view_shipping_costs: false,
      view_carrier_analytics: false,
      view_pickup_analytics: false,
      manage_shipping_settings: false,
      manage_carrier_locator_settings: false,
      validate_shipping_address: false,
      fetch_shipping_rates: false,
      purchase_shipping_label: false,
      print_shipping_label: false,
      sync_shipping_tracking: false,
      create_return: false,
      approve_return: false,
      receive_return: false,
      inspect_return: false,
      complete_return_disposition: false,
      cancel_return: false,
      create_return_shipment: false,
    },
    description: 'Sales and customer access'
  },
];

export const roles = [...platformRoles, ...tenantRoles];

export const planFeatures: Record<Plan, string[]> = {
  starter: ['dashboard', 'sales', 'customers', 'invoices', 'support'],
  growth: ['dashboard', 'sales', 'customers', 'repairs', 'inventory', 'invoices', 'services', 'supply-chain', 'settings', 'support', 'reports', 'integrations', 'widgets', 'prospects', 'marketing', 'employees', 'warranties', 'suggestive_sales', 'refunds', 'loyalty_management', 'shipping', 'returns', 'service_points', 'pickup_requests', 'shipping_providers', 'carrier_analytics'],
  advanced: ['dashboard', 'sales', 'customers', 'repairs', 'inventory', 'employees', 'invoices', 'services', 'supply-chain', 'settings', 'support', 'reports', 'integrations', 'widgets', 'prospects', 'marketing', 'warranties', 'suggestive_sales', 'refunds', 'loyalty_management', 'shipping', 'returns', 'service_points', 'pickup_requests', 'shipping_providers', 'carrier_analytics'],
};

export const permissions = PERMISSION_DOMAINS;

export const accountStatusConfig = {
  active: { label: 'Active', color: 'bg-lime-400/10 text-lime-700 border-lime-400/20' },
  trialing: { label: 'Trialing', color: 'bg-indigo-400/10 text-indigo-700 border-indigo-200' },
  overdue: { label: 'Overdue', color: 'bg-red-400/10 text-red-700 border-red-400/20' },
  suspended: { label: 'Suspended', color: 'bg-slate-400/10 text-slate-700 border-slate-200' },
  read_only: { label: 'Read Only', color: 'bg-amber-400/10 text-amber-700 border-amber-400/20' },
  pending_activation: { label: 'Pending', color: 'bg-slate-400/10 text-slate-700 border-slate-200' },
};
