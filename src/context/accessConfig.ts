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
];

export const ADMIN_ACTION_LEVEL_MAP = SUB_PERMISSIONS;

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
      manage_shipping_settings: true,
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
      manage_shipping_settings: false,
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
      manage_shipping_settings: false,
    },
    description: 'Sales and customer access'
  },
];

export const roles = [...platformRoles, ...tenantRoles];

export const planFeatures: Record<Plan, string[]> = {
  starter: ['dashboard', 'sales', 'customers', 'invoices', 'support'],
  growth: ['dashboard', 'sales', 'customers', 'repairs', 'inventory', 'invoices', 'services', 'supply-chain', 'settings', 'support', 'reports', 'integrations', 'widgets', 'prospects', 'marketing', 'employees', 'warranties', 'suggestive_sales', 'refunds', 'loyalty_management', 'shipping'],
  advanced: ['dashboard', 'sales', 'customers', 'repairs', 'inventory', 'employees', 'invoices', 'services', 'supply-chain', 'settings', 'support', 'reports', 'integrations', 'widgets', 'prospects', 'marketing', 'warranties', 'suggestive_sales', 'refunds', 'loyalty_management', 'shipping'],
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
