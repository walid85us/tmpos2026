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
    } as Record<string, PermissionLevel>,
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
    } as Record<string, PermissionLevel>,
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
    } as Record<string, PermissionLevel>,
    description: 'Sales and customer access'
  },
];

export const roles = [...platformRoles, ...tenantRoles];

export const planFeatures: Record<Plan, string[]> = {
  starter: ['dashboard', 'sales', 'customers', 'invoices', 'support'],
  growth: ['dashboard', 'sales', 'customers', 'repairs', 'inventory', 'invoices', 'services', 'supply-chain', 'settings', 'support', 'reports', 'integrations', 'widgets', 'prospects', 'marketing', 'employees', 'warranties', 'suggestive_sales', 'refunds'],
  advanced: ['dashboard', 'sales', 'customers', 'repairs', 'inventory', 'employees', 'invoices', 'services', 'supply-chain', 'settings', 'support', 'reports', 'integrations', 'widgets', 'prospects', 'marketing', 'warranties', 'suggestive_sales', 'refunds'],
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
