export const plans = [
  { id: 'essential', name: 'Essential', price: 49, features: ['Sales', 'Repairs', 'Inventory'], limits: { seats: 3, locations: 1 }, billingCycle: 'monthly' as const, status: 'active' as const },
  { id: 'growth', name: 'Growth', price: 99, features: ['Sales', 'Repairs', 'Inventory', 'Customers', 'Marketing'], limits: { seats: 10, locations: 3 }, billingCycle: 'monthly' as const, status: 'active' as const },
  { id: 'advanced', name: 'Advanced', price: 199, features: ['All Modules', 'API Access', 'Custom Domains'], limits: { seats: 50, locations: 10 }, billingCycle: 'monthly' as const, status: 'active' as const },
];

export const tenants = [
  { 
    id: 't1', 
    name: 'Tech Repair Pro', 
    plan: 'growth', 
    status: 'active' as const, 
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
    flags: ['high-priority'],
    mrr: 99,
    onboardedDate: '2025-11-10',
  },
  { 
    id: 't2', 
    name: 'Gadget Fixers', 
    plan: 'essential', 
    status: 'active' as const, 
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
    flags: [],
    mrr: 49,
    onboardedDate: '2026-02-18',
  },
  {
    id: 't3',
    name: 'Mobile Fix Hub',
    plan: 'advanced',
    status: 'trialing' as const,
    renewal: '2026-04-28',
    owner: { name: 'Carol Davis', email: 'carol@mobilefixhub.com' },
    subdomain: 'mobilefixhub',
    customDomain: null,
    ssl: 'pending',
    verification: 'pending',
    seatsUsed: 2,
    seatsAllowed: 50,
    locationsUsed: 1,
    locationsAllowed: 10,
    supportNotes: 'Trial tenant, evaluating Advanced plan.',
    flags: [],
    mrr: 0,
    onboardedDate: '2026-03-14',
  },
  {
    id: 't4',
    name: 'QuickFix Electronics',
    plan: 'growth',
    status: 'overdue' as const,
    renewal: '2026-03-10',
    owner: { name: 'Dan Martinez', email: 'dan@quickfixelec.com' },
    subdomain: 'quickfix',
    customDomain: 'quickfixelec.com',
    ssl: 'active',
    verification: 'verified',
    seatsUsed: 7,
    seatsAllowed: 10,
    locationsUsed: 2,
    locationsAllowed: 3,
    supportNotes: 'Payment failed, contacted via email.',
    flags: ['payment-issue'],
    mrr: 99,
    onboardedDate: '2025-09-05',
  },
  {
    id: 't5',
    name: 'Old Parts Shop',
    plan: 'essential',
    status: 'suspended' as const,
    renewal: '2026-02-01',
    owner: { name: 'Eve Wilson', email: 'eve@oldparts.com' },
    subdomain: 'oldparts',
    customDomain: null,
    ssl: 'inactive',
    verification: 'failed',
    seatsUsed: 0,
    seatsAllowed: 3,
    locationsUsed: 1,
    locationsAllowed: 1,
    supportNotes: 'Suspended due to non-payment. Last contact 2026-02-15.',
    flags: ['suspended', 'payment-issue'],
    mrr: 0,
    onboardedDate: '2025-06-20',
  },
];

export type AddOnLifecycle = 'draft' | 'planned' | 'in_development' | 'active' | 'deprecated' | 'archived';

export const addOns = [
  { id: 'sms', name: 'SMS Credits', price: 10, compatiblePlans: ['growth', 'advanced'], status: 'active' as const, lifecycle: 'active' as AddOnLifecycle, description: 'Bulk SMS credits for customer notifications, marketing campaigns, and ticket updates.' },
  { id: 'loyalty', name: 'Loyalty Program', price: 20, compatiblePlans: ['advanced'], status: 'active' as const, lifecycle: 'active' as AddOnLifecycle, description: 'Customer loyalty points, rewards tiers, and automated engagement campaigns.' },
  { id: 'reporting', name: 'Advanced Reporting', price: 15, compatiblePlans: ['growth', 'advanced'], status: 'active' as const, lifecycle: 'active' as AddOnLifecycle, description: 'Custom report builder, scheduled reports, and advanced analytics dashboards.' },
  { id: 'multistore', name: 'Multi-Store Pack', price: 30, compatiblePlans: ['growth', 'advanced'], status: 'active' as const, lifecycle: 'active' as AddOnLifecycle, description: 'Extra store locations, inter-store inventory transfers, and consolidated reporting.' },
  { id: 'api', name: 'API Access', price: 25, compatiblePlans: ['advanced'], status: 'active' as const, lifecycle: 'active' as AddOnLifecycle, description: 'REST API access for custom integrations, webhooks, and third-party app connectivity.' },
  { id: 'whitelabel', name: 'White-Label', price: 50, compatiblePlans: ['advanced'], status: 'active' as const, lifecycle: 'deprecated' as AddOnLifecycle, description: 'Remove platform branding, custom domain, and branded customer-facing portal.' },
  { id: 'priority', name: 'Priority Support', price: 35, compatiblePlans: ['growth', 'advanced'], status: 'active' as const, lifecycle: 'active' as AddOnLifecycle, description: 'Dedicated support agent, 1-hour response SLA, and priority issue resolution.' },
];

export type FeatureLifecycle = 'draft' | 'planned' | 'in_development' | 'implemented' | 'deprecated' | 'archived';

export const featureMatrix = [
  { id: 'sales', name: 'Sales Module', planAvailability: { essential: true, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'repairs', name: 'Repair Tickets', planAvailability: { essential: true, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'inventory', name: 'Inventory Management', planAvailability: { essential: true, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'customers', name: 'Customer CRM', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'marketing', name: 'Marketing Automation', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'custom' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'supply_chain', name: 'Supply Chain', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'reports', name: 'Reports & Analytics', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'employees', name: 'Employee Management', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'prospects', name: 'Prospects & Leads', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'custom' as const, lifecycle: 'in_development' as FeatureLifecycle },
  { id: 'widgets', name: 'Customer Widgets', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'integrations', name: 'Integrations', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'api', name: 'API Access', planAvailability: { essential: false, growth: false, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'domains', name: 'Custom Domains', planAvailability: { essential: false, growth: false, advanced: true } as Record<string, boolean>, source: 'custom' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'whitelabel', name: 'White-Label Branding', planAvailability: { essential: false, growth: false, advanced: true } as Record<string, boolean>, source: 'custom' as const, lifecycle: 'deprecated' as FeatureLifecycle },
  { id: 'ai_diagnostics', name: 'AI Diagnostics', planAvailability: { essential: false, growth: false, advanced: false } as Record<string, boolean>, source: 'custom' as const, lifecycle: 'planned' as FeatureLifecycle },
  { id: 'voice_assistant', name: 'Voice Assistant', planAvailability: { essential: false, growth: false, advanced: false } as Record<string, boolean>, source: 'custom' as const, lifecycle: 'draft' as FeatureLifecycle },
];

export const auditLogs = [
  { id: 'a1', actor: 'Admin Alice', action: 'Provisioned Tenant', target: 'Gadget Fixers', date: '2026-03-22', severity: 'info' },
  { id: 'a2', actor: 'System', action: 'Subscription Renewal', target: 'Tech Repair Pro', date: '2026-03-21', severity: 'info' },
  { id: 'a3', actor: 'Admin Bob', action: 'Suspended Tenant', target: 'Old Parts Shop', date: '2026-03-20', severity: 'warning' },
  { id: 'a4', actor: 'System', action: 'Payment Failed', target: 'QuickFix Electronics', date: '2026-03-18', severity: 'warning' },
  { id: 'a5', actor: 'Admin Alice', action: 'Updated Plan Features', target: 'Growth Plan', date: '2026-03-17', severity: 'info' },
  { id: 'a6', actor: 'System', action: 'SSL Certificate Renewed', target: 'techrepair.pro', date: '2026-03-16', severity: 'info' },
  { id: 'a7', actor: 'Admin Carol', action: 'Created Add-on', target: 'Priority Support', date: '2026-03-15', severity: 'info' },
  { id: 'a8', actor: 'System', action: 'Trial Expiring Soon', target: 'Mobile Fix Hub', date: '2026-03-14', severity: 'warning' },
];

export const platformSettings = {
  branding: { name: 'RepairPlatform', logoUrl: '/logo.png' },
  maintenance: { enabled: false, message: '' },
};

export const billingTransactions = [
  { id: 'bt1', tenant: 'Tech Repair Pro', date: '2026-03-20', amount: 99, type: 'subscription' as const, status: 'paid' as const, method: 'Visa •••• 4242', invoiceNo: 'INV-2026-0047' },
  { id: 'bt2', tenant: 'QuickFix Electronics', date: '2026-03-18', amount: 99, type: 'subscription' as const, status: 'failed' as const, method: 'Mastercard •••• 8888', invoiceNo: 'INV-2026-0046' },
  { id: 'bt3', tenant: 'Gadget Fixers', date: '2026-03-15', amount: 49, type: 'subscription' as const, status: 'paid' as const, method: 'Visa •••• 1234', invoiceNo: 'INV-2026-0045' },
  { id: 'bt4', tenant: 'Tech Repair Pro', date: '2026-03-12', amount: 15, type: 'addon' as const, status: 'paid' as const, method: 'Visa •••• 4242', invoiceNo: 'INV-2026-0044' },
  { id: 'bt5', tenant: 'Old Parts Shop', date: '2026-03-01', amount: 49, type: 'subscription' as const, status: 'failed' as const, method: 'ACH •••• 9012', invoiceNo: 'INV-2026-0041' },
  { id: 'bt6', tenant: 'QuickFix Electronics', date: '2026-02-18', amount: 99, type: 'subscription' as const, status: 'paid' as const, method: 'Mastercard •••• 8888', invoiceNo: 'INV-2026-0038' },
  { id: 'bt7', tenant: 'Tech Repair Pro', date: '2026-02-20', amount: 99, type: 'subscription' as const, status: 'paid' as const, method: 'Visa •••• 4242', invoiceNo: 'INV-2026-0035' },
  { id: 'bt8', tenant: 'Gadget Fixers', date: '2026-02-15', amount: 49, type: 'subscription' as const, status: 'paid' as const, method: 'Visa •••• 1234', invoiceNo: 'INV-2026-0032' },
  { id: 'bt9', tenant: 'Mobile Fix Hub', date: '2026-03-14', amount: 0, type: 'trial' as const, status: 'paid' as const, method: 'N/A', invoiceNo: 'INV-2026-0043' },
  { id: 'bt10', tenant: 'Tech Repair Pro', date: '2026-03-05', amount: 25, type: 'addon' as const, status: 'paid' as const, method: 'Visa •••• 4242', invoiceNo: 'INV-2026-0042' },
  { id: 'bt11', tenant: 'Old Parts Shop', date: '2026-02-01', amount: 49, type: 'subscription' as const, status: 'failed' as const, method: 'ACH •••• 9012', invoiceNo: 'INV-2026-0029' },
  { id: 'bt12', tenant: 'Tech Repair Pro', date: '2026-02-05', amount: 35, type: 'addon' as const, status: 'refunded' as const, method: 'Visa •••• 4242', invoiceNo: 'CR-2026-0003' },
];

export const invoiceHistory = [
  { id: 'inv1', invoiceNo: 'INV-2026-0047', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-03-20', dueDate: '2026-04-20', amount: 99, tax: 9.90, total: 108.90, status: 'paid' as const, plan: 'Growth', items: [{ description: 'Growth Plan - Monthly', qty: 1, amount: 99 }], paidDate: '2026-03-20' },
  { id: 'inv2', invoiceNo: 'INV-2026-0046', tenant: 'QuickFix Electronics', tenantId: 't4', date: '2026-03-18', dueDate: '2026-04-18', amount: 99, tax: 9.90, total: 108.90, status: 'overdue' as const, plan: 'Growth', items: [{ description: 'Growth Plan - Monthly', qty: 1, amount: 99 }], paidDate: null },
  { id: 'inv3', invoiceNo: 'INV-2026-0045', tenant: 'Gadget Fixers', tenantId: 't2', date: '2026-03-15', dueDate: '2026-04-15', amount: 49, tax: 4.90, total: 53.90, status: 'paid' as const, plan: 'Essential', items: [{ description: 'Essential Plan - Monthly', qty: 1, amount: 49 }], paidDate: '2026-03-15' },
  { id: 'inv4', invoiceNo: 'INV-2026-0044', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-03-12', dueDate: '2026-04-12', amount: 15, tax: 1.50, total: 16.50, status: 'paid' as const, plan: 'Growth', items: [{ description: 'Advanced Reporting Add-on', qty: 1, amount: 15 }], paidDate: '2026-03-12' },
  { id: 'inv5', invoiceNo: 'INV-2026-0043', tenant: 'Mobile Fix Hub', tenantId: 't3', date: '2026-03-14', dueDate: '2026-04-14', amount: 0, tax: 0, total: 0, status: 'paid' as const, plan: 'Advanced (Trial)', items: [{ description: 'Advanced Plan - Trial Period', qty: 1, amount: 0 }], paidDate: '2026-03-14' },
  { id: 'inv6', invoiceNo: 'INV-2026-0042', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-03-05', dueDate: '2026-04-05', amount: 25, tax: 2.50, total: 27.50, status: 'paid' as const, plan: 'Growth', items: [{ description: 'API Access Add-on', qty: 1, amount: 25 }], paidDate: '2026-03-05' },
  { id: 'inv7', invoiceNo: 'INV-2026-0041', tenant: 'Old Parts Shop', tenantId: 't5', date: '2026-03-01', dueDate: '2026-04-01', amount: 49, tax: 4.90, total: 53.90, status: 'void' as const, plan: 'Essential', items: [{ description: 'Essential Plan - Monthly', qty: 1, amount: 49 }], paidDate: null },
  { id: 'inv8', invoiceNo: 'INV-2026-0038', tenant: 'QuickFix Electronics', tenantId: 't4', date: '2026-02-18', dueDate: '2026-03-18', amount: 99, tax: 9.90, total: 108.90, status: 'paid' as const, plan: 'Growth', items: [{ description: 'Growth Plan - Monthly', qty: 1, amount: 99 }], paidDate: '2026-02-18' },
  { id: 'inv9', invoiceNo: 'INV-2026-0035', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-02-20', dueDate: '2026-03-20', amount: 99, tax: 9.90, total: 108.90, status: 'paid' as const, plan: 'Growth', items: [{ description: 'Growth Plan - Monthly', qty: 1, amount: 99 }], paidDate: '2026-02-20' },
  { id: 'inv10', invoiceNo: 'INV-2026-0032', tenant: 'Gadget Fixers', tenantId: 't2', date: '2026-02-15', dueDate: '2026-03-15', amount: 49, tax: 4.90, total: 53.90, status: 'paid' as const, plan: 'Essential', items: [{ description: 'Essential Plan - Monthly', qty: 1, amount: 49 }], paidDate: '2026-02-15' },
];

export const creditNotes = [
  { id: 'cr1', creditNo: 'CR-2026-0003', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-02-05', amount: 35, appliedAmount: 35, reason: 'API Access Add-on refund — billing error', relatedInvoice: 'INV-2026-0042', appliedToInvoice: 'INV-2026-0047', appliedDate: '2026-03-20', status: 'applied' as const, type: 'refund' as const },
  { id: 'cr2', creditNo: 'CR-2026-0002', tenant: 'QuickFix Electronics', tenantId: 't4', date: '2026-01-28', amount: 10, appliedAmount: 10, reason: 'Goodwill credit — service downtime Jan 25', relatedInvoice: null, appliedToInvoice: 'INV-2026-0046', appliedDate: '2026-03-18', status: 'applied' as const, type: 'goodwill' as const },
  { id: 'cr3', creditNo: 'CR-2026-0001', tenant: 'Old Parts Shop', tenantId: 't5', date: '2026-01-15', amount: 49, appliedAmount: 0, reason: 'Subscription cancellation pro-rata refund', relatedInvoice: 'INV-2026-0029', appliedToInvoice: null, appliedDate: null, status: 'pending' as const, type: 'cancellation' as const },
];

export const planHistory = [
  { id: 'ph1', tenant: 'Tech Repair Pro', tenantId: 't1', fromPlan: 'Essential', toPlan: 'Growth', date: '2025-12-01', type: 'upgrade' as const },
  { id: 'ph2', tenant: 'QuickFix Electronics', tenantId: 't4', fromPlan: 'Essential', toPlan: 'Growth', date: '2025-10-15', type: 'upgrade' as const },
  { id: 'ph3', tenant: 'Mobile Fix Hub', tenantId: 't3', fromPlan: null, toPlan: 'Advanced (Trial)', date: '2026-03-14', type: 'trial_start' as const },
  { id: 'ph4', tenant: 'Old Parts Shop', tenantId: 't5', fromPlan: 'Essential', toPlan: 'Suspended', date: '2026-02-15', type: 'suspension' as const },
  { id: 'ph5', tenant: 'Gadget Fixers', tenantId: 't2', fromPlan: null, toPlan: 'Essential', date: '2026-02-18', type: 'new' as const },
];

export const tenantUsage = [
  { tenantId: 't1', tenant: 'Tech Repair Pro', seatsUsed: 10, seatsAllowed: 10, locationsUsed: 3, locationsAllowed: 3, apiCalls: 12450, apiLimit: 50000, storageMb: 2340, storageLimitMb: 5000, smsUsed: 487, smsLimit: 500, ticketsThisMonth: 234, invoicesThisMonth: 189 },
  { tenantId: 't2', tenant: 'Gadget Fixers', seatsUsed: 3, seatsAllowed: 3, locationsUsed: 1, locationsAllowed: 1, apiCalls: 0, apiLimit: 0, storageMb: 120, storageLimitMb: 1000, smsUsed: 0, smsLimit: 0, ticketsThisMonth: 45, invoicesThisMonth: 38 },
  { tenantId: 't3', tenant: 'Mobile Fix Hub', seatsUsed: 2, seatsAllowed: 50, locationsUsed: 1, locationsAllowed: 10, apiCalls: 340, apiLimit: 100000, storageMb: 50, storageLimitMb: 10000, smsUsed: 12, smsLimit: 100, ticketsThisMonth: 8, invoicesThisMonth: 5 },
  { tenantId: 't4', tenant: 'QuickFix Electronics', seatsUsed: 7, seatsAllowed: 10, locationsUsed: 2, locationsAllowed: 3, apiCalls: 8900, apiLimit: 50000, storageMb: 1800, storageLimitMb: 5000, smsUsed: 320, smsLimit: 500, ticketsThisMonth: 156, invoicesThisMonth: 132 },
  { tenantId: 't5', tenant: 'Old Parts Shop', seatsUsed: 0, seatsAllowed: 3, locationsUsed: 1, locationsAllowed: 1, apiCalls: 0, apiLimit: 0, storageMb: 450, storageLimitMb: 1000, smsUsed: 0, smsLimit: 0, ticketsThisMonth: 0, invoicesThisMonth: 0 },
];
