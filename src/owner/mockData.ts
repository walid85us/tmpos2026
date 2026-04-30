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
    accountSetupDate: '2025-11-10',
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
    accountSetupDate: '2026-02-18',
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
    accountSetupDate: null as string | null,
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
    accountSetupDate: '2025-09-05',
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
    accountSetupDate: '2025-06-20',
    activatedDate: '2025-06-21',
  },
];

export type AddOnLifecycle = 'draft' | 'planned' | 'in_development' | 'active' | 'deprecated' | 'archived';

// System Owner commercial governance state for an add-on. Decides whether
// the add-on is offerable to tenants. Independent of `lifecycle` (PM)
// (which is product/PM intent only) and of legacy `status` (kept for
// back-compat).
//   - active   → may be granted as trial / paid override; visible in tenant
//                Features tab as available when plan-inclusion or
//                compatible-plan rules allow it; permissions for linked
//                feature appear when an active grant exists.
//   - disabled → not offerable; existing active grants stop enabling the
//                feature; permissions for linked feature disappear; record
//                stays in catalog so it can be reactivated.
//   - archived → terminal hidden state; not offerable; existing grants stop
//                enabling the feature; hidden from default catalog views.
//                Archive is BLOCKED while the linked feature/capability is
//                included in any plan, while the add-on has compatiblePlans
//                selected, or while any active trial / paid override /
//                pending payment references the add-on or its linked
//                feature/capability. See replit.md → "Add-on Governance
//                & Archive Protection Rule".
export type AddOnGovernanceStatus = 'active' | 'disabled' | 'archived';

// Add-on Implementation Readiness model. Distinct from Lifecycle (PM
// roadmap state) and Governance Status (commercial gate). Readiness
// answers: "is this add-on actually backed by implemented runtime
// behavior?" and drives Tenant Trial / Paid Override grant safety.
// See replit.md → "Add-on Implementation Readiness".
//   runtime_backed:         linked to implemented capability; safe to grant
//   partially_backed:       capability exists but missing checklist items
//   parent_feature_linked:  linked to a broad parent module — may overgrant
//   implementation_required: catalog placeholder, no app functionality yet
//   commercial_placeholder: roadmap/listing only; not tenant-grantable by default
export type AddOnReadinessStatus =
  | 'runtime_backed'
  | 'partially_backed'
  | 'parent_feature_linked'
  | 'implementation_required'
  | 'commercial_placeholder';

// Each runtime backing checklist item is graded with one of four states.
// `unknown` is the safe default — never auto-promote to `complete`
// without evidence. The Generate Implementation Brief surface lists
// every `missing` and `unknown` item as work the dev workstream must
// complete before the add-on can be marked Runtime-backed.
export type RuntimeChecklistState = 'complete' | 'missing' | 'not_required' | 'unknown';

export type RuntimeChecklistKey =
  | 'capability_key'
  | 'plan_matrix_row'
  | 'runtime_ui_surface'
  | 'entitlement_check'
  | 'permission_dependency'
  | 'data_model'
  | 'audit_behavior'
  | 'billing_behavior'
  | 'documentation';

export type RuntimeChecklist = Record<RuntimeChecklistKey, RuntimeChecklistState>;

export const DEFAULT_RUNTIME_CHECKLIST: RuntimeChecklist = {
  capability_key: 'unknown',
  plan_matrix_row: 'unknown',
  runtime_ui_surface: 'unknown',
  entitlement_check: 'unknown',
  permission_dependency: 'unknown',
  data_model: 'unknown',
  audit_behavior: 'unknown',
  billing_behavior: 'unknown',
  documentation: 'unknown',
};

export const RUNTIME_CHECKLIST_LABELS: Record<RuntimeChecklistKey, string> = {
  capability_key: 'Capability Key Exists',
  plan_matrix_row: 'Plans & Features Matrix Row',
  runtime_ui_surface: 'Runtime UI Surface',
  entitlement_check: 'Entitlement Check',
  permission_dependency: 'Permission Dependency',
  data_model: 'Data Model',
  audit_behavior: 'Audit Behavior',
  billing_behavior: 'Billing Behavior',
  documentation: 'Documentation',
};

export interface AddOn {
  id: string;
  name: string;
  description: string;
  price: number;
  compatiblePlans: string[];
  // Legacy gate. 'active' means listable; 'archived' means hidden. The
  // governanceStatus field below is the authoritative commercial gate.
  status: 'active' | 'archived';
  lifecycle: AddOnLifecycle;
  // Commercial governance fields (System Owner Commercial Controls).
  governanceStatus: AddOnGovernanceStatus;
  billingCadence: 'monthly' | 'annual' | 'one_time';
  // Optional linkage to a feature in `featureMatrix` — when set, the add-on
  // is the entitlement vehicle for that feature, and the resolver / matrix
  // use this to decide whether the linked feature appears for a tenant.
  linkedFeatureId?: string | null;
  // Implementation Readiness — see AddOnReadinessStatus.
  readinessStatus?: AddOnReadinessStatus;
  // Per-item runtime backing checklist. Optional: rows without a stored
  // checklist render against DEFAULT_RUNTIME_CHECKLIST (all 'unknown').
  runtimeChecklist?: RuntimeChecklist;
  // Free-form description of the runtime UI surface (route, tab, page)
  // where this add-on's capability becomes visible to a tenant.
  runtimeSurface?: string;
  // Explicit System Owner opt-in to allow tenant grant for an add-on
  // whose readiness is `commercial_placeholder` or `implementation_required`.
  // Without this flag set, Tenant Trial / Paid Override is blocked.
  // See replit.md → "Add-on Implementation Readiness" → Grant Safety.
  allowManualPresaleGrant?: boolean;
  // System Owner has acknowledged the parent-feature warning. When true
  // the readiness derivation may keep `runtime_backed` instead of
  // downgrading to `parent_feature_linked`.
  parentLinkAcknowledged?: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy?: string;
}

// Known implemented capability registry. Source-of-truth list of feature
// ids that the platform actually has implemented runtime behavior for.
// Used by `deriveSuggestedReadiness()` to suggest `runtime_backed` when
// an add-on links to one of these. Keep ids in sync with `featureMatrix`.
// See replit.md → "Add-on Implementation Readiness" → Capability Registry.
export interface KnownCapabilityEntry {
  featureId: string;
  displayName: string;
  parentModule: string;
  isParentFeature: boolean;
  runtimeSurfaceExists: 'yes' | 'no' | 'unknown';
  permissionIds: string[];
  planMatrixRowExists: 'yes' | 'no' | 'unknown';
  notes?: string;
}

export const KNOWN_CAPABILITY_REGISTRY: KnownCapabilityEntry[] = [
  // Shipping module — fully implemented (Phase 1-3 closures).
  { featureId: 'shipping', displayName: 'Shipping Center', parentModule: 'shipping', isParentFeature: true, runtimeSurfaceExists: 'yes', permissionIds: ['shipping.view'], planMatrixRowExists: 'yes', notes: 'Parent module — link sub-features instead of this row.' },
  { featureId: 'shipping_providers', displayName: 'Shipping Provider Configuration', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: ['shipping.providers.manage'], planMatrixRowExists: 'yes' },
  { featureId: 'returns', displayName: 'Returns Portal', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: ['shipping.returns.manage'], planMatrixRowExists: 'yes' },
  { featureId: 'service_points', displayName: 'Service Points (Carrier Locators)', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'pickup_requests', displayName: 'Pickup Requests', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: ['shipping.pickups.manage'], planMatrixRowExists: 'yes' },
  { featureId: 'carrier_analytics', displayName: 'Carrier Analytics', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'shipping_automation_rules', displayName: 'Shipping Automation Rules', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: ['shipping.automation.manage'], planMatrixRowExists: 'yes' },
  { featureId: 'batch_labels', displayName: 'Batch Labels', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'packing_workflows', displayName: 'Packing Workflows', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'shipping_sla_optimization', displayName: 'SLA Optimization', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'carrier_scorecards', displayName: 'Carrier Scorecards', parentModule: 'shipping', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  // Other implemented modules.
  { featureId: 'sales', displayName: 'Sales Module', parentModule: 'sales', isParentFeature: true, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Parent module.' },
  { featureId: 'repairs', displayName: 'Repair Tickets', parentModule: 'repairs', isParentFeature: true, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Parent module.' },
  { featureId: 'inventory', displayName: 'Inventory Management', parentModule: 'inventory', isParentFeature: true, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Parent module.' },
  { featureId: 'customers', displayName: 'Customer CRM', parentModule: 'customers', isParentFeature: true, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Parent module.' },
  { featureId: 'reports', displayName: 'Reports & Analytics', parentModule: 'reports', isParentFeature: true, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'employees', displayName: 'Employee Management', parentModule: 'employees', isParentFeature: true, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'integrations', displayName: 'Integrations', parentModule: 'integrations', isParentFeature: true, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'api', displayName: 'API Access', parentModule: 'integrations', isParentFeature: false, runtimeSurfaceExists: 'yes', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'loyalty_management', displayName: 'Loyalty Management', parentModule: 'customers', isParentFeature: false, runtimeSurfaceExists: 'unknown', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Capability row exists; runtime surface needs verification.' },
  { featureId: 'marketing', displayName: 'Marketing Automation', parentModule: 'marketing', isParentFeature: true, runtimeSurfaceExists: 'unknown', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'supply_chain', displayName: 'Supply Chain', parentModule: 'supply_chain', isParentFeature: true, runtimeSurfaceExists: 'unknown', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'widgets', displayName: 'Customer Widgets', parentModule: 'customers', isParentFeature: false, runtimeSurfaceExists: 'unknown', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'domains', displayName: 'Custom Domains', parentModule: 'integrations', isParentFeature: false, runtimeSurfaceExists: 'unknown', permissionIds: [], planMatrixRowExists: 'yes' },
  { featureId: 'whitelabel', displayName: 'White-Label Branding', parentModule: 'integrations', isParentFeature: false, runtimeSurfaceExists: 'no', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Lifecycle: deprecated.' },
  { featureId: 'prospects', displayName: 'Prospects & Leads', parentModule: 'customers', isParentFeature: false, runtimeSurfaceExists: 'no', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Lifecycle: in_development.' },
  { featureId: 'ai_diagnostics', displayName: 'AI Diagnostics', parentModule: 'repairs', isParentFeature: false, runtimeSurfaceExists: 'no', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Lifecycle: planned.' },
  { featureId: 'voice_assistant', displayName: 'Voice Assistant', parentModule: 'repairs', isParentFeature: false, runtimeSurfaceExists: 'no', permissionIds: [], planMatrixRowExists: 'yes', notes: 'Lifecycle: draft.' },
];

export const isKnownImplementedCapability = (featureId: string | null | undefined): boolean => {
  if (!featureId) return false;
  const entry = KNOWN_CAPABILITY_REGISTRY.find(e => e.featureId === featureId);
  return !!entry && entry.runtimeSurfaceExists === 'yes' && !entry.isParentFeature;
};

export const isParentFeatureCapability = (featureId: string | null | undefined): boolean => {
  if (!featureId) return false;
  const entry = KNOWN_CAPABILITY_REGISTRY.find(e => e.featureId === featureId);
  return !!entry && entry.isParentFeature;
};

export const addOns: AddOn[] = [
  { id: 'sms', name: 'SMS Credits', price: 10, compatiblePlans: ['growth', 'advanced'], status: 'active', lifecycle: 'active', governanceStatus: 'active', billingCadence: 'monthly', linkedFeatureId: null, description: 'Bulk SMS credits for customer notifications, marketing campaigns, and ticket updates.', createdAt: '2025-08-01', createdBy: 'System', updatedAt: '2025-08-01', readinessStatus: 'commercial_placeholder', runtimeSurface: '', runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST, capability_key: 'complete', plan_matrix_row: 'complete', runtime_ui_surface: 'missing', entitlement_check: 'missing', data_model: 'missing', billing_behavior: 'not_required' } },
  { id: 'loyalty', name: 'Loyalty Program', price: 20, compatiblePlans: ['growth', 'advanced'], status: 'active', lifecycle: 'active', governanceStatus: 'active', billingCadence: 'monthly', linkedFeatureId: 'loyalty_management', description: 'Customer loyalty points, rewards tiers, and automated engagement campaigns.', createdAt: '2025-08-01', createdBy: 'System', updatedAt: '2025-08-01', readinessStatus: 'partially_backed', runtimeSurface: 'Tenant → Customers → Loyalty (TBD)', runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST, capability_key: 'complete', plan_matrix_row: 'complete', runtime_ui_surface: 'unknown', entitlement_check: 'unknown', billing_behavior: 'complete', documentation: 'missing' } },
  { id: 'reporting', name: 'Advanced Reporting', price: 15, compatiblePlans: ['growth', 'advanced'], status: 'active', lifecycle: 'active', governanceStatus: 'active', billingCadence: 'monthly', linkedFeatureId: 'reports', description: 'Custom report builder, scheduled reports, and advanced analytics dashboards.', createdAt: '2025-08-01', createdBy: 'System', updatedAt: '2025-08-01', readinessStatus: 'parent_feature_linked', runtimeSurface: 'Tenant → Reports', runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST, capability_key: 'complete', plan_matrix_row: 'complete', runtime_ui_surface: 'complete', entitlement_check: 'complete', billing_behavior: 'complete', documentation: 'complete' } },
  { id: 'multistore', name: 'Multi-Store Pack', price: 30, compatiblePlans: ['growth', 'advanced'], status: 'active', lifecycle: 'active', governanceStatus: 'active', billingCadence: 'monthly', linkedFeatureId: null, description: 'Extra store locations, inter-store inventory transfers, and consolidated reporting.', createdAt: '2025-08-01', createdBy: 'System', updatedAt: '2025-08-01', readinessStatus: 'implementation_required', runtimeSurface: '', runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST, capability_key: 'complete', plan_matrix_row: 'complete', runtime_ui_surface: 'missing', entitlement_check: 'missing', permission_dependency: 'missing', data_model: 'missing' } },
  { id: 'api', name: 'API Access', price: 25, compatiblePlans: ['advanced'], status: 'active', lifecycle: 'active', governanceStatus: 'active', billingCadence: 'monthly', linkedFeatureId: 'api', description: 'REST API access for custom integrations, webhooks, and third-party app connectivity.', createdAt: '2025-08-01', createdBy: 'System', updatedAt: '2025-08-01', readinessStatus: 'runtime_backed', runtimeSurface: 'Tenant → Integrations → API', runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST, capability_key: 'complete', plan_matrix_row: 'complete', runtime_ui_surface: 'complete', entitlement_check: 'complete', permission_dependency: 'complete', data_model: 'complete', audit_behavior: 'complete', billing_behavior: 'complete', documentation: 'complete' } },
  { id: 'whitelabel', name: 'White-Label', price: 50, compatiblePlans: ['advanced'], status: 'active', lifecycle: 'deprecated', governanceStatus: 'disabled', billingCadence: 'monthly', linkedFeatureId: 'whitelabel', description: 'Remove platform branding, custom domain, and branded customer-facing portal.', createdAt: '2025-08-01', createdBy: 'System', updatedAt: '2026-02-10', updatedBy: 'Admin Carol', readinessStatus: 'implementation_required', runtimeSurface: '', runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST, capability_key: 'complete', plan_matrix_row: 'complete', runtime_ui_surface: 'missing', entitlement_check: 'missing' } },
  { id: 'priority', name: 'Priority Support', price: 35, compatiblePlans: ['growth', 'advanced'], status: 'active', lifecycle: 'active', governanceStatus: 'active', billingCadence: 'monthly', linkedFeatureId: null, description: 'Dedicated support agent, 1-hour response SLA, and priority issue resolution.', createdAt: '2025-08-01', createdBy: 'Admin Carol', updatedAt: '2026-03-15', updatedBy: 'Admin Carol', readinessStatus: 'commercial_placeholder', runtimeSurface: 'Operations playbook (no in-app surface)', runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST, capability_key: 'complete', plan_matrix_row: 'complete', runtime_ui_surface: 'not_required', entitlement_check: 'not_required', billing_behavior: 'complete', documentation: 'complete' } },
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
  { id: 'loyalty_management', name: 'Loyalty Management', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'ai_diagnostics', name: 'AI Diagnostics', planAvailability: { essential: false, growth: false, advanced: false } as Record<string, boolean>, source: 'custom' as const, lifecycle: 'planned' as FeatureLifecycle },
  { id: 'voice_assistant', name: 'Voice Assistant', planAvailability: { essential: false, growth: false, advanced: false } as Record<string, boolean>, source: 'custom' as const, lifecycle: 'draft' as FeatureLifecycle },
  { id: 'shipping', name: 'Shipping Center', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'shipping_providers', name: 'Shipping Provider Configuration', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'returns', name: 'Returns Portal', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'service_points', name: 'Service Points (Carrier Locators)', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'pickup_requests', name: 'Pickup Requests', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'carrier_analytics', name: 'Carrier Analytics', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'shipping_automation_rules', name: 'Shipping Automation Rules', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'batch_labels', name: 'Batch Labels', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'packing_workflows', name: 'Packing Workflows', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  { id: 'shipping_sla_optimization', name: 'SLA Optimization', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
  // Phase 3 — Carrier Scorecards Foundation. Truthful per-carrier/service
  // performance comparison surface inside Shipping Center built on top of
  // Carrier Analytics + SLA Optimization data. Provided on the same plans
  // that have Carrier Analytics so a tenant with analytics also gets the
  // scorecards comparison view.
  { id: 'carrier_scorecards', name: 'Carrier Scorecards', planAvailability: { essential: false, growth: true, advanced: true } as Record<string, boolean>, source: 'inherited' as const, lifecycle: 'implemented' as FeatureLifecycle },
];

export type FeatureOverrideType = 'inherited' | 'overridden' | 'paid_override' | 'pending_payment' | 'trial' | 'disabled' | 'addon';

export type ActivationStatus = 'invited' | 'pending_activation' | 'account_setup' | 'active';

// A tenant feature override row. The `type` column is preserved for
// back-compat with existing UI; the *derived* override status (used by the
// resolver) is computed from `type` + `trialEnd` + `revokedDate` + `nowMs`
// in `src/owner/entitlements.ts → deriveOverrideStatus`.
export type ActivationMode = 'after_payment' | 'immediate';

export interface TenantFeatureOverride {
  tenantId: string;
  featureId: string;
  type: FeatureOverrideType;
  trialEnd?: string;
  addedBy?: string;
  addedDate?: string;
  price?: number;
  pricingModel?: 'monthly' | 'one_time' | 'annual';
  pricingNotes?: string;
  // Optional commercial governance metadata.
  addOnId?: string | null;
  // When this override was revoked (ISO date) and by whom. Revoked
  // overrides are kept (not deleted) so audit history remains intact;
  // the resolver treats them as inactive.
  revokedDate?: string;
  revokedBy?: string;
  revokeReason?: string;
  // Internal SaaS billing wiring. Paid overrides and paid add-on
  // grants always create an internal `CommercialInvoice`; the System
  // Owner picks an activation mode at grant time. `after_payment`
  // keeps the override at type 'pending_payment' until the linked
  // invoice is marked paid; `immediate` flips the override to
  // 'paid_override' right away while the invoice stays open until
  // it's marked paid manually.
  activationMode?: ActivationMode;
  invoiceId?: string;
  dueDate?: string;
}

export const tenantFeatureOverrides: TenantFeatureOverride[] = [
  { tenantId: 't1', featureId: 'api', type: 'overridden', addedBy: 'Admin Alice', addedDate: '2026-01-15', addOnId: 'api', price: 25, pricingModel: 'monthly' },
  { tenantId: 't1', featureId: 'reporting', type: 'addon', addedBy: 'System', addedDate: '2026-03-12', addOnId: 'reporting' },
  { tenantId: 't2', featureId: 'customers', type: 'trial', trialEnd: '2026-04-18', addedBy: 'Admin Alice', addedDate: '2026-03-20' },
  { tenantId: 't4', featureId: 'api', type: 'trial', trialEnd: '2026-04-10', addedBy: 'Admin Bob', addedDate: '2026-03-10', addOnId: 'api' },
  { tenantId: 't2', featureId: 'reports', type: 'disabled', addedBy: 'Admin Bob', addedDate: '2026-03-01' },
];

// Commercial governance audit log — System Owner actions on the add-on
// catalog and tenant-specific overrides. Distinct surface from the general
// `auditLogs` array (which captures broad platform events). Entries here
// are also mirrored into `auditLogs` with category 'commercial' so the
// existing Audit / Activity surfaces continue to show them.
export type CommercialAuditAction =
  | 'addon_created'
  // Add-on archive protection (Add-on Governance & Archive Protection
  // Rule). `feature_registered_for_addon` fires when the create flow
  // auto-registers a new capability row in the Plans & Features
  // Matrix (standalone add-on with Linked Feature = None, or inline
  // user-supplied registration). `addon_archive_blocked` fires when
  // an Archive attempt is refused because dependencies still
  // reference the add-on or its linked capability.
  | 'addon_archive_blocked'
  | 'feature_registered_for_addon'
  // Add-on Runtime Linkage / Delete Policy (see replit.md →
  // "Add-on Runtime Linkage & Delete/Archive Matrix Behavior").
  // `addon_linked_feature_changed` records a linkedFeatureId edit
  // (oldValue/newValue carry the feature ids). `addon_deleted` is
  // emitted once a successful delete is performed and the note
  // describes what was removed (catalog record + optionally the
  // standalone capability row) and what was preserved (linked
  // existing feature rows). `addon_delete_blocked` mirrors
  // `addon_archive_blocked` and is emitted when delete is refused
  // because dependencies still reference the add-on. The two
  // standalone_capability_row_* actions cover the side effects on
  // the Plans & Features Matrix when an add-on with Linked Feature
  // = None is archived (row is locked / marked Archived) or
  // deleted (row is removed).
  | 'addon_deleted'
  | 'addon_delete_blocked'
  | 'addon_linked_feature_changed'
  | 'standalone_capability_row_deleted'
  | 'standalone_capability_row_archive_locked'
  | 'addon_updated'
  | 'addon_status_changed'
  | 'addon_default_price_changed'
  | 'tenant_trial_granted'
  | 'tenant_trial_revoked'
  | 'tenant_paid_override_granted'
  | 'tenant_paid_override_price_edited'
  | 'tenant_override_revoked'
  | 'tenant_pending_payment_approved'
  | 'tenant_pending_payment_cancelled'
  // Internal SaaS invoice / activation-mode lifecycle.
  | 'invoice_created'
  | 'invoice_marked_paid'
  | 'invoice_cancelled'
  | 'feature_activated_after_payment'
  | 'immediate_activation_granted'
  | 'paid_override_revoked_due_to_cancel'
  | 'manual_payment_confirmation'
  // Add-on Implementation Readiness audit actions. See replit.md →
  // "Add-on Implementation Readiness" → Audit.
  //   addon_readiness_changed:        readinessStatus transitioned
  //   addon_runtime_checklist_updated: any checklist item changed
  //   addon_manual_presale_allowed:   System Owner toggled the
  //                                    Allow Manual/Presale Grant flag
  //   addon_implementation_brief_generated: brief copied/exported
  //   addon_parent_link_acknowledged: System Owner accepted parent-feature warning
  //   addon_readiness_overridden:     readinessStatus set against the
  //                                    derived suggestion (manual override)
  | 'addon_readiness_changed'
  | 'addon_runtime_checklist_updated'
  | 'addon_manual_presale_allowed'
  | 'addon_implementation_brief_generated'
  | 'addon_parent_link_acknowledged'
  | 'addon_readiness_overridden';

export interface CommercialAuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: CommercialAuditAction;
  addOnId?: string | null;
  tenantId?: string | null;
  featureId?: string | null;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  note?: string;
}

export const commercialAuditLogs: CommercialAuditEntry[] = [
  { id: 'ca1', timestamp: '2025-08-01', actor: 'System', action: 'addon_created', addOnId: 'priority', note: 'Initial catalog seed' },
  { id: 'ca2', timestamp: '2026-02-10', actor: 'Admin Carol', action: 'addon_status_changed', addOnId: 'whitelabel', oldValue: 'active', newValue: 'disabled', note: 'White-Label deprecated; kept for existing tenants' },
  { id: 'ca3', timestamp: '2026-03-10', actor: 'Admin Bob', action: 'tenant_trial_granted', tenantId: 't4', addOnId: 'api', featureId: 'api', newValue: '2026-04-10', note: 'API trial — evaluating Advanced plan upgrade' },
  { id: 'ca4', timestamp: '2026-03-12', actor: 'System', action: 'tenant_paid_override_granted', tenantId: 't1', addOnId: 'reporting', featureId: 'reporting', newValue: 15 },
  { id: 'ca5', timestamp: '2026-03-15', actor: 'Admin Carol', action: 'addon_updated', addOnId: 'priority', note: 'Description refresh' },
  { id: 'ca6', timestamp: '2026-01-15', actor: 'Admin Alice', action: 'tenant_paid_override_granted', tenantId: 't1', addOnId: 'api', featureId: 'api', newValue: 25 },
];

// Internal SaaS invoice records for paid override / paid add-on grants.
// These are tenant-facing subscription invoices, NOT retail customer
// invoices. Stored in `sessionStorage('commercial_invoices_data')` at
// runtime; this seed array is the bootstrap default loaded the first
// time a System Owner opens the Tenant Detail Billing tab.
export type CommercialInvoiceStatus = 'open' | 'paid' | 'cancelled' | 'overdue';
export type CommercialInvoiceType = 'paid_override' | 'addon' | 'subscription_adjustment';

export interface CommercialInvoiceLineItem {
  description: string;
  amount: number;
  featureId?: string;
  addOnId?: string;
}

export interface CommercialInvoice {
  invoiceId: string;
  tenantId: string;
  status: CommercialInvoiceStatus;
  invoiceType: CommercialInvoiceType;
  amount: number;
  currency: string;
  cadence: 'monthly' | 'annual' | 'one_time';
  dueDate: string;
  issuedDate: string;
  paidDate?: string;
  cancelledDate?: string;
  lineItems: CommercialInvoiceLineItem[];
  notes?: string;
  // Cross-references back to the entitlement that triggered the
  // invoice. `overrideId` is a synthetic key of `${tenantId}:${featureId}`
  // since `TenantFeatureOverride` is keyed by that pair (one row per
  // tenant/feature). `featureId` and `addOnId` are duplicated for
  // ease of filtering.
  overrideId?: string;
  featureId?: string;
  addOnId?: string;
  activationMode: ActivationMode;
  createdBy: string;
}

export const commercialInvoices: CommercialInvoice[] = [
  {
    invoiceId: 'CINV-2026-0001',
    tenantId: 't1',
    status: 'paid',
    invoiceType: 'addon',
    amount: 25,
    currency: 'USD',
    cadence: 'monthly',
    dueDate: '2026-01-25',
    issuedDate: '2026-01-15',
    paidDate: '2026-01-20',
    lineItems: [{ description: 'API Access add-on (monthly)', amount: 25, featureId: 'api', addOnId: 'api' }],
    overrideId: 't1:api',
    featureId: 'api',
    addOnId: 'api',
    activationMode: 'after_payment',
    createdBy: 'Admin Alice',
  },
  {
    invoiceId: 'CINV-2026-0002',
    tenantId: 't1',
    status: 'paid',
    invoiceType: 'addon',
    amount: 15,
    currency: 'USD',
    cadence: 'monthly',
    dueDate: '2026-03-22',
    issuedDate: '2026-03-12',
    paidDate: '2026-03-15',
    lineItems: [{ description: 'Advanced Reporting add-on (monthly)', amount: 15, featureId: 'reporting', addOnId: 'reporting' }],
    overrideId: 't1:reporting',
    featureId: 'reporting',
    addOnId: 'reporting',
    activationMode: 'after_payment',
    createdBy: 'System',
  },
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
  { id: 'cr3', creditNo: 'CR-2026-0001', tenant: 'Old Parts Shop', tenantId: 't5', date: '2026-01-15', amount: 49, appliedAmount: 0, reason: 'Subscription cancellation pro-rata refund', relatedInvoice: 'INV-2026-0029', appliedToInvoice: null, appliedDate: null, status: 'issued' as const, type: 'cancellation' as const },
  { id: 'cr4', creditNo: 'CR-2026-0004', tenant: 'Gadget Fixers', tenantId: 't2', date: '2026-03-10', amount: 53.90, appliedAmount: 0, reason: 'Billing adjustment — duplicate charge correction', relatedInvoice: 'INV-2026-0032', appliedToInvoice: null, appliedDate: null, status: 'issued' as const, type: 'goodwill' as const },
  { id: 'cr5', creditNo: 'CR-2026-0005', tenant: 'Tech Repair Pro', tenantId: 't1', date: '2026-03-18', amount: 25, appliedAmount: 0, reason: 'Overcharge refund — pro-rated plan downgrade adjustment', relatedInvoice: 'INV-2026-0048', appliedToInvoice: null, appliedDate: null, status: 'issued' as const, type: 'refund' as const },
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

// ===========================================================================
// PLATFORM OPERATIONS & SECURITY (System Owner)
// New collections supporting the Platform Operations workstream surfaces:
//   - tenantDomains:        domain records, decoupled from tenant rows
//   - supportCases:         platform-side cases with internal notes timeline
//   - platformTeamMembers:  System Owner directory (auth NOT enforced — UI
//                            governance only; see replit.md)
//   - platformDefaults:     extended defaults consumed by PlatformSettingsPage
// All four are seed defaults; runtime state mirrors into sessionStorage /
// localStorage so cross-cutting Audit & Security continues to surface
// changes via `audit_logs:changed` (see `platformOpsAudit.ts`).
// ===========================================================================

export type PlatformAuditSeverity = 'info' | 'notice' | 'warning' | 'critical';

export type DomainStatus = 'pending' | 'verifying' | 'verified' | 'failed' | 'disabled';
export type DomainSslStatus = 'none' | 'pending' | 'active' | 'failed';
export type DomainKind = 'subdomain' | 'custom';

export interface TenantDomainRecord {
  id: string;
  tenantId: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  ssl: DomainSslStatus;
  createdAt: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  notes: string;
}

export const tenantDomains: TenantDomainRecord[] = [
  { id: 'dom1', tenantId: 't1', hostname: 'techrepair.repairplatform.com', kind: 'subdomain', status: 'verified', ssl: 'active', createdAt: '2025-11-10', verifiedAt: '2025-11-10', lastCheckedAt: '2026-04-25', notes: 'Auto-provisioned subdomain.' },
  { id: 'dom2', tenantId: 't1', hostname: 'techrepair.pro', kind: 'custom', status: 'verified', ssl: 'active', createdAt: '2025-11-12', verifiedAt: '2025-11-12', lastCheckedAt: '2026-04-26', notes: 'Manually verified by Admin Alice.' },
  { id: 'dom3', tenantId: 't2', hostname: 'gadgetfixers.repairplatform.com', kind: 'subdomain', status: 'verified', ssl: 'active', createdAt: '2026-02-18', verifiedAt: '2026-02-18', lastCheckedAt: '2026-04-20', notes: '' },
  { id: 'dom4', tenantId: 't3', hostname: 'mobilefixhub.repairplatform.com', kind: 'subdomain', status: 'verified', ssl: 'pending', createdAt: '2026-03-14', verifiedAt: '2026-03-14', lastCheckedAt: '2026-04-22', notes: 'Trial tenant — SSL still pending manual issue.' },
  { id: 'dom5', tenantId: 't4', hostname: 'quickfix.repairplatform.com', kind: 'subdomain', status: 'verified', ssl: 'active', createdAt: '2025-09-05', verifiedAt: '2025-09-05', lastCheckedAt: '2026-04-25', notes: '' },
  { id: 'dom6', tenantId: 't4', hostname: 'quickfixelec.com', kind: 'custom', status: 'verified', ssl: 'active', createdAt: '2025-09-06', verifiedAt: '2025-09-07', lastCheckedAt: '2026-04-26', notes: 'Verified after CNAME confirmed.' },
  { id: 'dom7', tenantId: 't5', hostname: 'oldparts.repairplatform.com', kind: 'subdomain', status: 'disabled', ssl: 'none', createdAt: '2025-06-20', verifiedAt: '2025-06-20', lastCheckedAt: '2026-02-15', notes: 'Disabled when tenant suspended for non-payment.' },
];

export type SupportCaseStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
export type SupportCaseSeverity = 'low' | 'normal' | 'high' | 'urgent';

export interface SupportCaseNote {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  // 'note' = internal note, 'status_change' = audit-style status transition
  kind: 'note' | 'status_change';
}

export interface SupportCaseRecord {
  id: string;
  tenantId: string;
  subject: string;
  description: string;
  status: SupportCaseStatus;
  severity: SupportCaseSeverity;
  assignee: string | null;
  openedAt: string;
  updatedAt: string;
  notes: SupportCaseNote[];
}

export const supportCases: SupportCaseRecord[] = [
  {
    id: 'case_001', tenantId: 't1', subject: 'Inventory sync failing during peak hours',
    description: 'Tech Repair Pro reports sync errors twice daily. Suspect rate limiting on inventory worker.',
    status: 'in_progress', severity: 'high', assignee: 'Admin Alice',
    openedAt: '2026-03-10', updatedAt: '2026-03-22',
    notes: [
      { id: 'cn_001a', author: 'Admin Alice', body: 'Reproduced on staging — opened internal ticket SHIP-441.', createdAt: '2026-03-12', kind: 'note' },
      { id: 'cn_001b', author: 'Admin Alice', body: 'Status: open → in_progress', createdAt: '2026-03-12', kind: 'status_change' },
      { id: 'cn_001c', author: 'Admin Bob', body: 'Customer confirmed last sync error 2026-03-22 14:02 UTC.', createdAt: '2026-03-22', kind: 'note' },
    ],
  },
  {
    id: 'case_002', tenantId: 't4', subject: 'Card on file expired — payment retries failing',
    description: 'Auto-renewal failed three times. Owner notified by email but card not updated.',
    status: 'waiting_customer', severity: 'urgent', assignee: 'Admin Alice',
    openedAt: '2026-03-18', updatedAt: '2026-03-25',
    notes: [
      { id: 'cn_002a', author: 'Admin Alice', body: 'Reached out to greg@quickfixelec.com and left voicemail.', createdAt: '2026-03-19', kind: 'note' },
      { id: 'cn_002b', author: 'Admin Alice', body: 'Status: open → waiting_customer', createdAt: '2026-03-25', kind: 'status_change' },
    ],
  },
  {
    id: 'case_003', tenantId: 't3', subject: 'Trial extension request — Mobile Fix Hub',
    description: 'Tenant evaluating Advanced plan, asked for a 14-day trial extension.',
    status: 'open', severity: 'normal', assignee: null,
    openedAt: '2026-03-26', updatedAt: '2026-03-26',
    notes: [],
  },
  {
    id: 'case_004', tenantId: 't2', subject: 'Onboarding follow-up — initial setup call',
    description: 'New tenant — schedule onboarding call and walk through Sales/Repairs/Inventory.',
    status: 'resolved', severity: 'low', assignee: 'Admin Carol',
    openedAt: '2026-02-22', updatedAt: '2026-03-03',
    notes: [
      { id: 'cn_004a', author: 'Admin Carol', body: 'Setup call completed 2026-03-03. Tenant comfortable with workflows.', createdAt: '2026-03-03', kind: 'note' },
      { id: 'cn_004b', author: 'Admin Carol', body: 'Status: in_progress → resolved', createdAt: '2026-03-03', kind: 'status_change' },
    ],
  },
];

export type PlatformTeamStatus = 'invited' | 'active' | 'suspended' | 'disabled';

export interface PlatformTeamMember {
  id: string;
  name: string;
  email: string;
  role: string; // role label, e.g. "System Owner", "Support Admin"
  status: PlatformTeamStatus;
  invitedAt: string;
  lastActiveAt: string | null;
}

export const platformTeamMembers: PlatformTeamMember[] = [
  { id: 'pt1', name: 'Admin User', email: 'admin@platform.com', role: 'System Owner', status: 'active', invitedAt: '2025-06-01', lastActiveAt: '2026-04-29' },
  { id: 'pt2', name: 'Support Rep', email: 'support@platform.com', role: 'Support Admin', status: 'active', invitedAt: '2025-07-12', lastActiveAt: '2026-04-28' },
  { id: 'pt3', name: 'Billing Admin', email: 'billing@platform.com', role: 'Billing Admin', status: 'active', invitedAt: '2025-08-04', lastActiveAt: '2026-04-26' },
  { id: 'pt4', name: 'Onboarding Specialist', email: 'onboarding@platform.com', role: 'Support Admin', status: 'invited', invitedAt: '2026-04-20', lastActiveAt: null },
];

// Extended platform defaults consumed by PlatformSettingsPage. Back-compat:
// `platformSettings` (above) is preserved for callers reading `branding`/
// `maintenance`. New surfaces should prefer `platformDefaults`.
export const platformDefaults = {
  branding: {
    name: 'RepairPlatform',
    supportEmail: 'support@repairplatform.com',
    logoUrl: '/logo.png',
  },
  maintenance: {
    enabled: false,
    message: '',
    scheduledStart: '' as string,
    scheduledEnd: '' as string,
  },
  security: {
    // Documentation only — not enforced by the app today.
    sessionTimeoutMinutes: 60,
    requireMfaForPlatformAdmins: false,
  },
  support: {
    supportEmail: 'support@repairplatform.com',
    onCallPhone: '',
    statusPageUrl: 'https://status.repairplatform.com',
  },
};

export type PlatformDefaults = typeof platformDefaults;
