export const roles = [
  { id: 'store_owner', name: 'Store Owner', level: 'tenant' },
  { id: 'manager', name: 'Manager', level: 'tenant' },
  { id: 'technician', name: 'Technician', level: 'tenant' },
  { id: 'sales_staff', name: 'Sales Staff', level: 'tenant' },
];

export const permissions = [
  { group: 'Sales', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { group: 'Repairs', actions: ['view', 'create', 'edit', 'manage'] },
  { group: 'Inventory', actions: ['view', 'create', 'edit', 'manage'] },
];

export const tenantUsers = [
  { id: 'u1', name: 'Alice Smith', email: 'alice@techrepair.pro', role: 'store_owner', status: 'active' },
  { id: 'u2', name: 'Bob Jones', email: 'bob@techrepair.pro', role: 'technician', status: 'invited' },
];

export const accessStates = {
  overdue: { active: false, message: 'Your payment is overdue. Please update your billing information to avoid service interruption.' },
  trialEnding: { active: true, message: 'Your trial ends in 3 days. Upgrade now to keep your data.' },
};
