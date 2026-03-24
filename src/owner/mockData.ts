export const plans = [
  { id: 'essential', name: 'Essential', price: 49, features: ['Sales', 'Repairs', 'Inventory'], limits: { seats: 3, locations: 1 } },
  { id: 'growth', name: 'Growth', price: 99, features: ['Sales', 'Repairs', 'Inventory', 'Customers', 'Marketing'], limits: { seats: 10, locations: 3 } },
  { id: 'advanced', name: 'Advanced', price: 199, features: ['All Modules', 'API Access', 'Custom Domains'], limits: { seats: 50, locations: 10 } },
];

export const tenants = [
  { 
    id: 't1', 
    name: 'Tech Repair Pro', 
    plan: 'growth', 
    status: 'active', 
    renewal: '2026-04-15',
    owner: { name: 'Alice Smith', email: 'alice@techrepair.pro' },
    subdomain: 'techrepair',
    customDomain: 'techrepair.pro',
    ssl: 'active',
    verification: 'verified',
    seatsUsed: 10,
    seatsAllowed: 10,
    locationsUsed: 3,
    locationsAllowed: 3,
    supportNotes: 'High volume, needs attention on inventory sync.',
    flags: ['high-priority']
  },
  { 
    id: 't2', 
    name: 'Gadget Fixers', 
    plan: 'essential', 
    status: 'active', 
    renewal: '2026-05-01',
    owner: { name: 'Bob Jones', email: 'bob@gadgetfixers.com' },
    subdomain: 'gadgetfixers',
    customDomain: null,
    ssl: 'active',
    verification: 'pending',
    seatsUsed: 3,
    seatsAllowed: 3,
    locationsUsed: 1,
    locationsAllowed: 1,
    supportNotes: 'New tenant, onboarding in progress.',
    flags: []
  },
];

export const addOns = [
  { id: 'sms', name: 'SMS Bundle', price: 10, compatiblePlans: ['growth', 'advanced'] },
  { id: 'loyalty', name: 'Loyalty Program', price: 20, compatiblePlans: ['advanced'] },
];

export const featureMatrix = [
  { id: 'sales', name: 'Sales Module', essential: true, growth: true, advanced: true },
  { id: 'repairs', name: 'Repair Tickets', essential: true, growth: true, advanced: true },
  { id: 'inventory', name: 'Inventory Management', essential: true, growth: true, advanced: true },
  { id: 'customers', name: 'Customer CRM', essential: false, growth: true, advanced: true },
  { id: 'marketing', name: 'Marketing Automation', essential: false, growth: true, advanced: true },
  { id: 'api', name: 'API Access', essential: false, growth: false, advanced: true },
  { id: 'domains', name: 'Custom Domains', essential: false, growth: false, advanced: true },
];

export const auditLogs = [
  { id: 'a1', actor: 'Admin Alice', action: 'Provisioned Tenant', target: 'Gadget Fixers', date: '2026-03-22', severity: 'info' },
  { id: 'a2', actor: 'System', action: 'Subscription Renewal', target: 'Tech Repair Pro', date: '2026-03-21', severity: 'info' },
  { id: 'a3', actor: 'Admin Bob', action: 'Suspended Tenant', target: 'Old Shop', date: '2026-03-20', severity: 'warning' },
];

export const platformSettings = {
  branding: { name: 'RepairPlatform', logoUrl: '/logo.png' },
  maintenance: { enabled: false, message: '' },
};
