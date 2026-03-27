export const plans = [
  { id: 'essential', name: 'Essential', price: 49, annualPrice: 490, annualDiscount: { type: 'percentage' as const, value: 17 }, savingsLabel: 'Save 17%', features: ['Sales', 'Repairs', 'Inventory'], limits: { seats: 3, locations: 1 }, billingCycle: 'monthly' as const, status: 'active' as const },
  { id: 'growth', name: 'Growth', price: 99, annualPrice: 990, annualDiscount: { type: 'percentage' as const, value: 17 }, savingsLabel: 'Save 17%', features: ['Sales', 'Repairs', 'Inventory', 'Customers', 'Marketing'], limits: { seats: 10, locations: 3 }, billingCycle: 'monthly' as const, status: 'active' as const },
  { id: 'advanced', name: 'Advanced', price: 199, annualPrice: 1990, annualDiscount: { type: 'percentage' as const, value: 17 }, savingsLabel: 'Save 17%', features: ['All Modules', 'API Access', 'Custom Domains'], limits: { seats: 50, locations: 10 }, billingCycle: 'monthly' as const, status: 'active' as const },
];

export const provisioningTemplates = [
  { id: 'standard', name: 'Standard Repair Shop', description: 'Default configuration for a single-location repair shop.', plan: 'essential', features: ['sales', 'repairs', 'inventory'], settings: { currency: 'USD', timezone: 'America/New_York', taxRate: 8.25, locale: 'en-US' } },
  { id: 'multi_location', name: 'Multi-Location Store', description: 'Pre-configured for multi-store operations with inventory sync.', plan: 'growth', features: ['sales', 'repairs', 'inventory', 'customers', 'marketing', 'supply_chain', 'reports', 'employees'], settings: { currency: 'USD', timezone: 'America/Chicago', taxRate: 7.5, locale: 'en-US' } },
  { id: 'enterprise', name: 'Enterprise Trial', description: 'Full-feature trial for evaluating the complete platform.', plan: 'advanced', features: ['sales', 'repairs', 'inventory', 'customers', 'marketing', 'supply_chain', 'reports', 'employees', 'integrations', 'api', 'domains'], settings: { currency: 'USD', timezone: 'America/Los_Angeles', taxRate: 9.5, locale: 'en-US' } },
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
    billingCycle: 'monthly' as const,
    trialEnd: null as string | null,
    activationStatus: 'active' as ActivationStatus,
    inviteSentDate: '2025-11-10',
    activatedDate: '2025-11-11',
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
    billingCycle: 'monthly' as const,
    trialEnd: null as string | null,
    activationStatus: 'active' as ActivationStatus,
    inviteSentDate: '2026-02-18',
    activatedDate: '2026-02-19',
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
    billingCycle: 'monthly' as const,
    trialEnd: '2026-03-28',
    activationStatus: 'account_setup' as ActivationStatus,
    inviteSentDate: '2026-03-14',
    activatedDate: null as string | null,
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
    billingCycle: 'monthly' as const,
    trialEnd: null as string | null,
    activationStatus: 'active' as ActivationStatus,
    inviteSentDate: '2025-09-05',
    activatedDate: '2025-09-06',
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
    billingCycle: 'monthly' as const,
    trialEnd: null as string | null,
    activationStatus: 'active' as ActivationStatus,
    inviteSentDate: '2025-06-20',
    activatedDate: '2025-06-21',
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

export type FeatureOverrideType = 'inherited' | 'overridden' | 'paid_override' | 'pending_payment' | 'trial' | 'disabled' | 'addon';

export type ActivationStatus = 'invited' | 'pending_activation' | 'account_setup' | 'active';

export const tenantFeatureOverrides: { tenantId: string; featureId: string; type: FeatureOverrideType; trialEnd?: string; addedBy?: string; addedDate?: string; price?: number; pricingModel?: 'monthly' | 'one_time' | 'annual'; pricingNotes?: string; }[] = [
  { tenantId: 't1', featureId: 'api', type: 'overridden', addedBy: 'Admin Alice', addedDate: '2026-01-15' },
  { tenantId: 't1', featureId: 'reporting', type: 'addon', addedBy: 'System', addedDate: '2026-03-12' },
  { tenantId: 't2', featureId: 'customers', type: 'trial', trialEnd: '2026-04-18', addedBy: 'Admin Alice', addedDate: '2026-03-20' },
  { tenantId: 't4', featureId: 'api', type: 'trial', trialEnd: '2026-04-10', addedBy: 'Admin Bob', addedDate: '2026-03-10' },
  { tenantId: 't2', featureId: 'reports', type: 'disabled', addedBy: 'Admin Bob', addedDate: '2026-03-01' },
];

export const auditLogs = [
  { id: 'a1', tenantId: 't2', actor: 'Admin Alice', action: 'Provisioned Tenant', target: 'Gadget Fixers', date: '2026-03-22', severity: 'info', category: 'provisioning' },
  { id: 'a2', tenantId: 't1', actor: 'System', action: 'Subscription Renewal', target: 'Tech Repair Pro', date: '2026-03-21', severity: 'info', category: 'billing' },
  { id: 'a3', tenantId: 't5', actor: 'Admin Bob', action: 'Suspended Tenant', target: 'Old Parts Shop', date: '2026-03-20', severity: 'warning', category: 'lifecycle' },
  { id: 'a4', tenantId: 't4', actor: 'System', action: 'Payment Failed', target: 'QuickFix Electronics', date: '2026-03-18', severity: 'warning', category: 'billing' },
  { id: 'a5', tenantId: null, actor: 'Admin Alice', action: 'Updated Plan Features', target: 'Growth Plan', date: '2026-03-17', severity: 'info', category: 'configuration' },
  { id: 'a6', tenantId: 't1', actor: 'System', action: 'SSL Certificate Renewed', target: 'techrepair.pro', date: '2026-03-16', severity: 'info', category: 'domains' },
  { id: 'a7', tenantId: null, actor: 'Admin Carol', action: 'Created Add-on', target: 'Priority Support', date: '2026-03-15', severity: 'info', category: 'configuration' },
  { id: 'a8', tenantId: 't3', actor: 'System', action: 'Trial Expiring Soon', target: 'Mobile Fix Hub', date: '2026-03-14', severity: 'warning', category: 'lifecycle' },
  { id: 'a9', tenantId: 't1', actor: 'Admin Alice', action: 'Feature Override Added', target: 'Tech Repair Pro — API Access', date: '2026-01-15', severity: 'info', category: 'features' },
  { id: 'a10', tenantId: 't1', actor: 'Admin Alice', action: 'User Invited', target: 'Bob Jones (bob@techrepair.pro)', date: '2026-02-10', severity: 'info', category: 'users' },
  { id: 'a11', tenantId: 't4', actor: 'System', action: 'Payment Retry Failed', target: 'QuickFix Electronics', date: '2026-03-20', severity: 'warning', category: 'billing' },
  { id: 'a12', tenantId: 't1', actor: 'System', action: 'Seat Limit Reached', target: 'Tech Repair Pro (10/10)', date: '2026-03-15', severity: 'warning', category: 'usage' },
  { id: 'a13', tenantId: 't2', actor: 'Admin Alice', action: 'Feature Trial Enabled', target: 'Gadget Fixers — Customer CRM', date: '2026-03-20', severity: 'info', category: 'features' },
  { id: 'a14', tenantId: 't1', actor: 'Admin Bob', action: 'Domain Verified', target: 'techrepair.pro', date: '2025-11-12', severity: 'info', category: 'domains' },
  { id: 'a15', tenantId: 't5', actor: 'System', action: 'Access Suspended', target: 'Old Parts Shop', date: '2026-02-15', severity: 'warning', category: 'lifecycle' },
  { id: 'a16', tenantId: 't4', actor: 'Admin Alice', action: 'Support Note Added', target: 'QuickFix Electronics', date: '2026-03-19', severity: 'info', category: 'support' },
];

export const platformSettings = {
  branding: { name: 'RepairPlatform', logoUrl: '/logo.png' },
  maintenance: { enabled: false, message: '' },
};

export const billingTransactions = [
  { id: 'bt1', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-03-20', amount: 99, type: 'subscription' as const, status: 'paid' as const, method: 'Visa •••• 4242', invoiceNo: 'INV-2026-0047' },
  { id: 'bt2', tenant: 'QuickFix Electronics', tenantId: 't4', date: '2026-03-18', amount: 99, type: 'subscription' as const, status: 'failed' as const, method: 'Mastercard •••• 8888', invoiceNo: 'INV-2026-0046' },
  { id: 'bt3', tenant: 'Gadget Fixers', tenantId: 't2', date: '2026-03-15', amount: 49, type: 'subscription' as const, status: 'paid' as const, method: 'Visa •••• 1234', invoiceNo: 'INV-2026-0045' },
  { id: 'bt4', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-03-12', amount: 15, type: 'addon' as const, status: 'paid' as const, method: 'Visa •••• 4242', invoiceNo: 'INV-2026-0044' },
  { id: 'bt5', tenant: 'Old Parts Shop', tenantId: 't5', date: '2026-03-01', amount: 49, type: 'subscription' as const, status: 'failed' as const, method: 'ACH •••• 9012', invoiceNo: 'INV-2026-0041' },
  { id: 'bt6', tenant: 'QuickFix Electronics', tenantId: 't4', date: '2026-02-18', amount: 99, type: 'subscription' as const, status: 'paid' as const, method: 'Mastercard •••• 8888', invoiceNo: 'INV-2026-0038' },
  { id: 'bt7', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-02-20', amount: 99, type: 'subscription' as const, status: 'paid' as const, method: 'Visa •••• 4242', invoiceNo: 'INV-2026-0035' },
  { id: 'bt8', tenant: 'Gadget Fixers', tenantId: 't2', date: '2026-02-15', amount: 49, type: 'subscription' as const, status: 'paid' as const, method: 'Visa •••• 1234', invoiceNo: 'INV-2026-0032' },
  { id: 'bt9', tenant: 'Mobile Fix Hub', tenantId: 't3', date: '2026-03-14', amount: 0, type: 'trial' as const, status: 'paid' as const, method: 'N/A', invoiceNo: 'INV-2026-0043' },
  { id: 'bt10', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-03-05', amount: 25, type: 'addon' as const, status: 'paid' as const, method: 'Visa •••• 4242', invoiceNo: 'INV-2026-0042' },
  { id: 'bt11', tenant: 'Old Parts Shop', tenantId: 't5', date: '2026-02-01', amount: 49, type: 'subscription' as const, status: 'failed' as const, method: 'ACH •••• 9012', invoiceNo: 'INV-2026-0029' },
  { id: 'bt12', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-02-05', amount: 35, type: 'addon' as const, status: 'refunded' as const, method: 'Visa •••• 4242', invoiceNo: 'CR-2026-0003' },
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
  { id: 'cr4', creditNo: 'CR-2026-0004', tenant: 'Gadget Fixers', tenantId: 't2', date: '2026-03-10', amount: 53.90, appliedAmount: 0, reason: 'Billing adjustment — duplicate charge correction', relatedInvoice: 'INV-2026-0032', appliedToInvoice: null, appliedDate: null, status: 'pending' as const, type: 'goodwill' as const },
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

export const tenantUsagePrior = [
  { tenantId: 't1', apiCalls: 11200, storageMb: 2100, smsUsed: 420, ticketsThisMonth: 210, invoicesThisMonth: 170 },
  { tenantId: 't2', apiCalls: 0, storageMb: 95, smsUsed: 0, ticketsThisMonth: 32, invoicesThisMonth: 28 },
  { tenantId: 't3', apiCalls: 0, storageMb: 0, smsUsed: 0, ticketsThisMonth: 0, invoicesThisMonth: 0 },
  { tenantId: 't4', apiCalls: 7800, storageMb: 1600, smsUsed: 280, ticketsThisMonth: 140, invoicesThisMonth: 118 },
  { tenantId: 't5', apiCalls: 0, storageMb: 450, smsUsed: 0, ticketsThisMonth: 0, invoicesThisMonth: 0 },
];

export type SupportNoteCategory = 'general' | 'billing' | 'technical' | 'escalation' | 'onboarding';

export const tenantSupportNotes: { id: string; tenantId: string; text: string; category: SupportNoteCategory; pinned: boolean; followUpDate: string | null; assignedTo: string | null; createdBy: string; createdDate: string; isEscalated: boolean; }[] = [
  { id: 'sn1', tenantId: 't1', text: 'High volume, needs attention on inventory sync. Sync errors happening 2x/day during peak hours.', category: 'technical', pinned: true, followUpDate: '2026-04-01', assignedTo: 'Admin Alice', createdBy: 'Admin Alice', createdDate: '2026-03-10', isEscalated: true },
  { id: 'sn2', tenantId: 't1', text: 'Requested additional seats but at capacity. Consider recommending upgrade to Advanced.', category: 'general', pinned: false, followUpDate: null, assignedTo: null, createdBy: 'Admin Bob', createdDate: '2026-03-18', isEscalated: false },
  { id: 'sn3', tenantId: 't2', text: 'New tenant, onboarding in progress. Initial setup call scheduled.', category: 'onboarding', pinned: false, followUpDate: '2026-03-30', assignedTo: 'Admin Carol', createdBy: 'Admin Carol', createdDate: '2026-02-20', isEscalated: false },
  { id: 'sn4', tenantId: 't4', text: 'Payment failed, contacted via email. Card on file expired. Owner notified 3x.', category: 'billing', pinned: true, followUpDate: '2026-03-28', assignedTo: 'Admin Alice', createdBy: 'Admin Alice', createdDate: '2026-03-19', isEscalated: true },
  { id: 'sn5', tenantId: 't4', text: 'Dan mentioned considering downgrade if payment issues persist.', category: 'general', pinned: false, followUpDate: null, assignedTo: null, createdBy: 'Admin Bob', createdDate: '2026-03-20', isEscalated: false },
  { id: 'sn6', tenantId: 't5', text: 'Suspended due to non-payment. Last contact 2026-02-15. Account data retained for 90 days.', category: 'billing', pinned: true, followUpDate: null, assignedTo: null, createdBy: 'System', createdDate: '2026-02-15', isEscalated: false },
  { id: 'sn7', tenantId: 't3', text: 'Trial tenant, evaluating Advanced plan. Very engaged — demo call went well.', category: 'onboarding', pinned: false, followUpDate: '2026-03-27', assignedTo: 'Admin Carol', createdBy: 'Admin Carol', createdDate: '2026-03-15', isEscalated: false },
];

export const tenantDomainHistory: { id: string; tenantId: string; action: string; domain: string; date: string; actor: string; }[] = [
  { id: 'dh1', tenantId: 't1', action: 'Subdomain Created', domain: 'techrepair.repairplatform.com', date: '2025-11-10', actor: 'System' },
  { id: 'dh2', tenantId: 't1', action: 'Custom Domain Added', domain: 'techrepair.pro', date: '2025-11-12', actor: 'Admin Alice' },
  { id: 'dh3', tenantId: 't1', action: 'DNS Verified', domain: 'techrepair.pro', date: '2025-11-12', actor: 'System' },
  { id: 'dh4', tenantId: 't1', action: 'SSL Provisioned', domain: 'techrepair.pro', date: '2025-11-13', actor: 'System' },
  { id: 'dh5', tenantId: 't1', action: 'SSL Renewed', domain: 'techrepair.pro', date: '2026-03-16', actor: 'System' },
  { id: 'dh6', tenantId: 't4', action: 'Subdomain Created', domain: 'quickfix.repairplatform.com', date: '2025-09-05', actor: 'System' },
  { id: 'dh7', tenantId: 't4', action: 'Custom Domain Added', domain: 'quickfixelec.com', date: '2025-09-06', actor: 'Admin Bob' },
  { id: 'dh8', tenantId: 't4', action: 'DNS Verified', domain: 'quickfixelec.com', date: '2025-09-07', actor: 'System' },
];
