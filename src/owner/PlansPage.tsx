import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { plans as initialPlans, featureMatrix as initialFeatures, addOns as initialAddOns, DEFAULT_RUNTIME_CHECKLIST, RUNTIME_CHECKLIST_LABELS } from './mockData';
import type { FeatureLifecycle, AddOnLifecycle, AddOn, AddOnGovernanceStatus, AddOnReadinessStatus, RuntimeChecklist, RuntimeChecklistKey, RuntimeChecklistState } from './mockData';
import { pushCommercialAudit, getCommercialAuditLog } from './commercialAudit';
import { readInvoices } from './commercialInvoices';
import {
  READINESS_LABELS,
  READINESS_DESCRIPTIONS,
  READINESS_BADGE_STYLES,
  deriveSuggestedReadiness,
  getReadinessStatus,
  generateImplementationBrief,
} from './readiness';
import { useAccess } from '../context/AccessContext';
import { hasPlatformPermission, hasEffectiveFeatureAccess } from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';

// `initialPlans` seeds every plan with `billingCycle: 'monthly' as const`, which would
// narrow PlanData to the 'monthly' literal even though 'annual' is a first-class value
// (selectable in the plan form and rendered as '/yr'). Represent both canonical values.
type PlanData = Omit<typeof initialPlans[0], 'status' | 'billingCycle'> & { status: 'active' | 'archived'; billingCycle: 'monthly' | 'annual' };
type FeatureData = { id: string; name: string; planAvailability: Record<string, boolean>; source: 'inherited' | 'custom'; lifecycle: FeatureLifecycle };
type AddOnData = AddOn;

const LIFECYCLE_ORDER: FeatureLifecycle[] = ['draft', 'planned', 'in_development', 'implemented', 'deprecated', 'archived'];
const ADDON_LIFECYCLE_ORDER: AddOnLifecycle[] = ['draft', 'planned', 'in_development', 'active', 'deprecated', 'archived'];

// Add-on Runtime Linkage — known broad parent / module-level features.
// Linking an add-on to one of these surfaces a warning in the Add-on
// modal because the add-on will then control entitlement for the entire
// parent feature surface. The preferred linkage is a specific implemented
// sub-feature/capability listed in `SUB_FEATURE_HINTS`. See replit.md →
// "Add-on Runtime Linkage & Delete/Archive Matrix Behavior".
const PARENT_FEATURE_IDS: ReadonlySet<string> = new Set([
  'shipping',
  'sales',
  'repairs',
  'inventory',
  'customers',
  'marketing',
  'reports',
  'employees',
  'integrations',
  'supply_chain',
]);

// Suggested specific sub-feature/capability ids per parent. Rendered in
// the Add-on modal warning so the System Owner can pick the smallest
// real capability the add-on should control. Keep ids in sync with
// `featureMatrix` in mockData.ts; missing ids are skipped at render time.
const SUB_FEATURE_HINTS: Readonly<Record<string, readonly string[]>> = {
  shipping: [
    'shipping_providers',
    'shipping_automation_rules',
    'shipping_sla_optimization',
    'batch_labels',
    'packing_workflows',
    'carrier_analytics',
    'carrier_scorecards',
    'service_points',
    'pickup_requests',
    'returns',
  ],
  sales: [],
  repairs: [],
  inventory: [],
  customers: ['loyalty_management'],
  marketing: [],
  reports: [],
  employees: [],
  integrations: ['api', 'domains', 'whitelabel'],
  supply_chain: [],
};

const lifecycleBadge = (lifecycle: FeatureLifecycle | AddOnLifecycle) => {
  const styles: Record<string, string> = {
    draft: 'bg-slate-400/10 text-slate-500 border-slate-200',
    planned: 'bg-blue-400/10 text-blue-600 border-blue-400/20',
    in_development: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
    implemented: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
    active: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
    deprecated: 'bg-red-400/10 text-red-600 border-red-400/20',
    archived: 'bg-slate-400/10 text-slate-400 border-slate-200',
  };
  const labels: Record<string, string> = {
    draft: 'Draft',
    planned: 'Planned',
    in_development: 'In Dev',
    implemented: 'Live',
    active: 'Active',
    deprecated: 'Deprecated',
    archived: 'Archived',
  };
  return (
    <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md border ${styles[lifecycle] || styles.draft}`}>
      {labels[lifecycle] || lifecycle}
    </span>
  );
};

const PlansPage: React.FC = () => {
  const { session } = useAccess();
  const pRole = (session?.role as Role | undefined) || null;
  const canCreatePlan = hasPlatformPermission(pRole, 'create_plan').allowed;
  const canEditPlan = hasPlatformPermission(pRole, 'edit_plan').allowed;
  const canArchivePlan = hasPlatformPermission(pRole, 'archive_plan').allowed;
  const canEditMatrix = hasPlatformPermission(pRole, 'edit_feature_matrix').allowed;
  const canCreateAddon = hasPlatformPermission(pRole, 'create_addon').allowed;
  const canEditAddon = hasPlatformPermission(pRole, 'edit_addon').allowed;
  const canArchiveDeleteAddon = hasPlatformPermission(pRole, 'archive_delete_addon').allowed;
  const canGrantTrial = hasPlatformPermission(pRole, 'grant_trial').allowed;
  const canGrantPaidOverride = hasPlatformPermission(pRole, 'grant_paid_override').allowed;
  const canRevokeOverride = hasPlatformPermission(pRole, 'revoke_addon_override').allowed;
  const canGenBrief = hasPlatformPermission(pRole, 'generate_addon_implementation_brief').allowed;
  const canSeeAddons = pRole ? hasEffectiveFeatureAccess(pRole, 'addon_governance') : false;

  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const initialTab = tabFromUrl === 'features' ? 'features' : (tabFromUrl === 'addons' && canSeeAddons) ? 'addons' : 'plans';
  const [activeTab, setActiveTab] = useState<'plans' | 'features' | 'addons'>(initialTab);

  useEffect(() => {
    if (tabFromUrl === 'features' || tabFromUrl === 'plans') {
      setActiveTab(tabFromUrl as 'plans' | 'features');
    } else if (tabFromUrl === 'addons' && canSeeAddons) {
      setActiveTab('addons');
    }
  }, [tabFromUrl, canSeeAddons]);

  const switchTab = (tab: 'plans' | 'features' | 'addons') => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };
  const [plansData, setPlansData] = useState(() => {
    try { const saved = sessionStorage.getItem('plans_data'); return saved ? JSON.parse(saved) : [...initialPlans]; } catch { return [...initialPlans]; }
  });
  const [featuresData, setFeaturesData] = useState<FeatureData[]>(() => {
    try { const saved = sessionStorage.getItem('features_data'); return saved ? JSON.parse(saved) : [...initialFeatures]; } catch { return [...initialFeatures]; }
  });
  const [addOnsData, setAddOnsData] = useState(() => {
    try {
      const saved = sessionStorage.getItem('addons_data');
      if (!saved) return [...initialAddOns];
      // Legacy normalization: a previous build briefly persisted
      // `governanceStatus: 'draft'`. The current model is
      // active/disabled/archived only — coerce any stale 'draft'
      // value to 'disabled' so the UI's gov style/label maps don't
      // hit an undefined key. See replit.md → "Add-on Governance &
      // Archive Protection Rule".
      const parsed = JSON.parse(saved) as AddOnData[];
      return parsed.map(a => (
        (a.governanceStatus as string) === 'draft'
          ? { ...a, governanceStatus: 'disabled' as AddOnGovernanceStatus }
          : a
      ));
    } catch { return [...initialAddOns]; }
  });

  useEffect(() => { try { sessionStorage.setItem('plans_data', JSON.stringify(plansData)); } catch {} }, [plansData]);
  useEffect(() => {
    try {
      sessionStorage.setItem('features_data', JSON.stringify(featuresData));
      // Notify same-tab listeners (e.g. ShippingCenter eligibility evaluators) that
      // the live plan/feature matrix changed. Storage events only fire cross-tab,
      // so this custom event covers the in-tab case.
      window.dispatchEvent(new Event('features_data:changed'));
    } catch {}
  }, [featuresData]);
  useEffect(() => { try { sessionStorage.setItem('addons_data', JSON.stringify(addOnsData)); } catch {} }, [addOnsData]);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [editingPlan, setEditingPlan] = useState<PlanData | null>(null);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState<string | null>(null);
  const [showAddOnModal, setShowAddOnModal] = useState(false);
  const [editingAddOn, setEditingAddOn] = useState<AddOnData | null>(null);
  const [showAddOnArchive, setShowAddOnArchive] = useState<string | null>(null);
  const [showAddOnDelete, setShowAddOnDelete] = useState<string | null>(null);
  const [showFeatureModal, setShowFeatureModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  const [planForm, setPlanForm] = useState({ name: '', price: '', seats: '', locations: '', features: '' as string, billingCycle: 'monthly' as 'monthly' | 'annual' });
  const [addOnForm, setAddOnForm] = useState({
    name: '',
    price: '',
    description: '',
    compatiblePlans: [] as string[],
    lifecycle: 'active' as AddOnLifecycle,
    governanceStatus: 'active' as AddOnGovernanceStatus,
    billingCadence: 'monthly' as 'monthly' | 'annual' | 'one_time',
    linkedFeatureId: '' as string,
    // Add-on Implementation Readiness fields. Stored separately on the
    // form so the modal can edit them without touching legacy fields.
    // See replit.md → "Add-on Implementation Readiness".
    readinessStatus: 'commercial_placeholder' as AddOnReadinessStatus,
    runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST } as RuntimeChecklist,
    runtimeSurface: '' as string,
    allowManualPresaleGrant: false,
    parentLinkAcknowledged: false,
  });
  // Implementation Brief modal — when non-null shows the generated brief
  // for the addon id; the user can copy it to the clipboard.
  const [briefModalAddOnId, setBriefModalAddOnId] = useState<string | null>(null);
  const [briefCopyToast, setBriefCopyToast] = useState(false);
  // Inline "Register new feature" mode for the Add-on modal. New
  // add-ons must be linked to a feature in the Plans & Features
  // Matrix (Add-on Governance & Archive Protection Rule).
  // The modal lets the System Owner either pick an existing
  // implemented feature or scaffold a new one inline (which adds a
  // row to `featuresData` with `source: 'custom'`,
  // `lifecycle: 'implemented'`, and all plan toggles off so the
  // matrix reflects the new capability immediately).
  const [showInlineNewFeature, setShowInlineNewFeature] = useState(false);
  const [inlineNewFeatureName, setInlineNewFeatureName] = useState('');
  // Archive blocker reason set for the currently-targeted add-on.
  // When non-null the Archive modal renders the BLOCKED variant
  // (read-only dependency list) instead of the confirm variant.
  const [addOnArchiveBlockers, setAddOnArchiveBlockers] = useState<{
    inPlanFeatureNames: string[];
    compatiblePlanNames: string[];
    activeTrials: number;
    activePaidOverrides: number;
    pendingPayments: number;
  } | null>(null);
  const [showArchivedAddOns, setShowArchivedAddOns] = useState(false);
  // Features tab "Show archived/deprecated" filter. Default false so the
  // matrix surfaces only live rows; archived/deprecated rows (including
  // standalone-cap rows belonging to archived add-ons) are visible when
  // toggled on. See replit.md → "Add-on Runtime Linkage & Delete/Archive
  // Matrix Behavior" → Archived standalone capability rows.
  const [showArchivedFeatures, setShowArchivedFeatures] = useState(false);
  // Delete blocker reason set for the currently-targeted add-on. When
  // non-null the Delete modal renders the BLOCKED variant (read-only
  // dependency list) instead of the confirm variant. See replit.md →
  // "Add-on Runtime Linkage & Delete/Archive Matrix Behavior" →
  // Delete vs Archive policy.
  const [addOnDeleteBlockers, setAddOnDeleteBlockers] = useState<{
    inPlanFeatureNames: string[];
    compatiblePlanNames: string[];
    activeTrials: number;
    activePaidOverrides: number;
    pendingPayments: number;
    openInvoiceIds: string[];
  } | null>(null);
  const [showAddOnDisableConfirm, setShowAddOnDisableConfirm] = useState<string | null>(null);
  const [showCommercialAudit, setShowCommercialAudit] = useState(false);
  const [auditTick, setAuditTick] = useState(0);
  const recentAudit = React.useMemo(() => getCommercialAuditLog().slice(0, 25), [auditTick, addOnsData]);
  const [newFeatureName, setNewFeatureName] = useState('');
  const [newFeatureLifecycle, setNewFeatureLifecycle] = useState<FeatureLifecycle>('draft');

  const openCreatePlan = () => {
    setPlanForm({ name: '', price: '', seats: '', locations: '', features: '', billingCycle: 'monthly' });
    setEditingPlan(null);
    setShowPlanModal(true);
  };

  const openEditPlan = (plan: PlanData) => {
    setPlanForm({
      name: plan.name,
      price: String(plan.price),
      seats: String(plan.limits.seats),
      locations: String(plan.limits.locations),
      features: plan.features.join(', '),
      billingCycle: plan.billingCycle,
    });
    setEditingPlan(plan);
    setShowPlanModal(true);
  };

  const savePlan = () => {
    if (editingPlan ? !canEditPlan : !canCreatePlan) return;
    const newPlan: PlanData = {
      id: editingPlan?.id || planForm.name.toLowerCase().replace(/\s+/g, '-'),
      name: planForm.name,
      price: Number(planForm.price),
      annualPrice: editingPlan?.annualPrice ?? Math.round(Number(planForm.price) * 10),
      annualDiscount: editingPlan?.annualDiscount ?? { type: 'percentage' as const, value: 17 },
      savingsLabel: editingPlan?.savingsLabel ?? 'Save 17%',
      features: planForm.features.split(',').map(f => f.trim()).filter(Boolean),
      limits: { seats: Number(planForm.seats), locations: Number(planForm.locations) },
      billingCycle: planForm.billingCycle,
      status: editingPlan?.status || 'active' as const,
    };
    if (editingPlan) {
      setPlansData(prev => prev.map(p => p.id === editingPlan.id ? newPlan : p));
    } else {
      setPlansData(prev => [...prev, newPlan]);
    }
    setShowPlanModal(false);
    setEditingPlan(null);
  };

  const archivePlan = (planId: string) => {
    if (!canArchivePlan) return;
    setPlansData(prev => prev.map(p => p.id === planId ? { ...p, status: 'archived' as const } : p));
    setShowArchiveConfirm(null);
  };

  const restorePlan = (planId: string) => {
    if (!canArchivePlan) return;
    setPlansData(prev => prev.map(p => p.id === planId ? { ...p, status: 'active' as const } : p));
  };

  const activePlans = plansData.filter(p => p.status === 'active');

  // Handler-level protection for archived standalone add-on
  // capability rows. A row is locked iff its id is `cap_<addonId>`
  // for an add-on whose `governanceStatus === 'archived'`. Once
  // locked, the matrix MUST refuse plan-toggle, lifecycle, and
  // delete mutations regardless of UI state — defense in depth
  // beyond the disabled controls. Linked-feature add-ons (where
  // the add-on points at a pre-existing feature row) do NOT lock
  // the underlying feature row; the row is shared and other plans/
  // permissions still own it. See replit.md → "Add-on Runtime
  // Linkage & Delete/Archive Matrix Behavior" → Archived
  // standalone capability rows.
  const isArchivedStandaloneCapRow = (featureId: string): boolean => {
    if (!featureId.startsWith('cap_')) return false;
    const owner = addOnsData.find(a => `cap_${a.id}` === featureId);
    return !!(owner && owner.governanceStatus === 'archived');
  };

  const toggleFeature = (featureId: string, planId: string) => {
    if (!canEditMatrix) return;
    const feature = featuresData.find(f => f.id === featureId);
    if (!feature || feature.lifecycle !== 'implemented') return;
    // Archived standalone add-on cap rows are read-only at the
    // handler level. Stale UI / bulk paths must not be able to
    // mutate planAvailability for these rows.
    if (isArchivedStandaloneCapRow(featureId)) return;
    setFeaturesData(prev => prev.map(f => f.id === featureId ? { ...f, planAvailability: { ...f.planAvailability, [planId]: !f.planAvailability[planId] } } : f));
  };

  const changeLifecycle = (featureId: string, newLifecycle: FeatureLifecycle) => {
    if (!canEditMatrix) return;
    // Archived standalone add-on cap rows are read-only at the
    // handler level. Lifecycle is owned by the add-on governance
    // transition; the matrix cannot drift from it.
    if (isArchivedStandaloneCapRow(featureId)) return;
    setFeaturesData(prev => prev.map(f => {
      if (f.id !== featureId) return f;
      if (newLifecycle !== 'implemented') {
        const cleared: Record<string, boolean> = {};
        Object.keys(f.planAvailability).forEach(k => { cleared[k] = false; });
        return { ...f, lifecycle: newLifecycle, planAvailability: cleared };
      }
      return { ...f, lifecycle: newLifecycle };
    }));
  };

  const addFeature = () => {
    if (!canEditMatrix) return;
    if (!newFeatureName.trim()) return;
    const id = newFeatureName.toLowerCase().replace(/\s+/g, '_');
    const defaultAvailability: Record<string, boolean> = {};
    plansData.forEach(p => { defaultAvailability[p.id] = false; });
    setFeaturesData(prev => [...prev, { id, name: newFeatureName.trim(), planAvailability: defaultAvailability, source: 'custom' as const, lifecycle: newFeatureLifecycle }]);
    setNewFeatureName('');
    setNewFeatureLifecycle('draft');
    setShowFeatureModal(false);
  };

  const getFeatureDependencies = (featureId: string) => {
    const feature = featuresData.find(f => f.id === featureId);
    if (!feature) return [];
    return activePlans.filter(p => feature.planAvailability[p.id]);
  };

  const removeFeature = (featureId: string) => {
    if (!canEditMatrix) { setShowDeleteConfirm(null); return; }
    // Archived standalone add-on cap rows are read-only at the
    // handler level. They cannot be deleted directly from the
    // Plans & Features Matrix — they are owned by the add-on
    // catalog record and only `removeAddOn` (after passing all
    // dependency blockers) may remove them.
    if (isArchivedStandaloneCapRow(featureId)) {
      setShowDeleteConfirm(null);
      return;
    }
    setFeaturesData(prev => prev.filter(f => f.id !== featureId));
    setShowDeleteConfirm(null);
  };

  // Add-on Runtime Linkage — Delete Policy.
  // A delete is BLOCKED while any of the following reference the add-on
  // or its linked capability key:
  //   1. The linked feature/capability is included in any active plan
  //      in the Plans & Features Matrix.
  //   2. The add-on has any Compatible Plans selected.
  //   3. There is an active tenant trial linked to the add-on or its
  //      linked feature/capability.
  //   4. There is an active paid override linked to the add-on or its
  //      linked feature/capability.
  //   5. There is a pending payment linked to the add-on or its linked
  //      feature/capability.
  //   6. There is an open / overdue / pending internal SaaS invoice
  //      tied to the add-on or its linked feature/capability.
  // Returns null when no blockers are present (Delete may proceed).
  const getAddOnDeleteBlockers = (addonId: string) => {
    const addon = addOnsData.find(a => a.id === addonId);
    if (!addon) return null;
    const inPlanFeatureNames: string[] = [];
    if (addon.linkedFeatureId) {
      const linkedFeature = featuresData.find(f => f.id === addon.linkedFeatureId);
      if (linkedFeature) {
        plansData.filter(p => p.status === 'active').forEach(p => {
          const planKey = p.id === 'starter' ? 'essential' : p.id;
          if (linkedFeature.planAvailability[planKey]) {
            inPlanFeatureNames.push(`${linkedFeature.name} included in ${p.name} plan`);
          }
        });
      }
    }
    const compatiblePlanNames: string[] = addon.compatiblePlans
      .map(pid => plansData.find(p => p.id === pid)?.name || pid);
    let activeTrials = 0;
    let activePaidOverrides = 0;
    let pendingPayments = 0;
    let openInvoiceIds: string[] = [];
    try {
      if (typeof window !== 'undefined') {
        const raw = window.sessionStorage.getItem('tenant_overrides_data');
        if (raw) {
          const all = JSON.parse(raw) as Array<{
            featureId: string;
            type: string;
            revokedDate?: string;
            addOnId?: string | null;
            invoiceId?: string;
          }>;
          for (const o of all) {
            if (o.revokedDate) continue;
            const matchesAddon = o.addOnId === addonId;
            const matchesFeature =
              !!addon.linkedFeatureId && o.featureId === addon.linkedFeatureId;
            if (!matchesAddon && !matchesFeature) continue;
            if (o.type === 'trial') activeTrials++;
            else if (o.type === 'overridden' || o.type === 'addon' || o.type === 'paid_override') activePaidOverrides++;
            else if (o.type === 'pending_payment') pendingPayments++;
            if (o.invoiceId) openInvoiceIds.push(o.invoiceId);
          }
        }
        // Cross-check the commercial invoice store for open/overdue
        // invoices that reference this add-on (always) or its linked
        // feature/cap (when present). Add-ons without a linkedFeatureId
        // — including legacy seed entries — must still gate delete on
        // any open `inv.addOnId === addonId` row. We read through the
        // canonical helper `readInvoices()` (sessionStorage key
        // `commercial_invoices_data`) so a hand-rolled key here can
        // never drift from the real billing store.
        for (const inv of readInvoices()) {
          if (inv.status !== 'open' && inv.status !== 'overdue') continue;
          const matchesAddon = inv.addOnId === addonId;
          const matchesFeature = !!addon.linkedFeatureId && inv.featureId === addon.linkedFeatureId;
          if ((matchesAddon || matchesFeature) && !openInvoiceIds.includes(inv.invoiceId)) {
            openInvoiceIds.push(inv.invoiceId);
          }
        }
      }
    } catch {}
    const hasAny =
      inPlanFeatureNames.length > 0 ||
      compatiblePlanNames.length > 0 ||
      activeTrials > 0 ||
      activePaidOverrides > 0 ||
      pendingPayments > 0 ||
      openInvoiceIds.length > 0;
    if (!hasAny) return null;
    return {
      inPlanFeatureNames,
      compatiblePlanNames,
      activeTrials,
      activePaidOverrides,
      pendingPayments,
      openInvoiceIds,
    };
  };

  // Classify the linked feature row for the delete modal copy and for
  // the standalone-cap cleanup. A row is treated as a standalone
  // capability row created by this add-on iff ALL of the following:
  //   1. The linked id matches the stable key `cap_<addonId>`.
  //   2. No OTHER add-on currently references the same id (defensive
  //      check — saveAddOn never shares cap_ ids across add-ons but
  //      stale data could).
  //   3. The matrix row exists with `source: 'custom'` AND
  //      `lifecycle: 'implemented'` — the same shape `saveAddOn`
  //      auto-registers. Inherited rows or rows that were promoted/
  //      demoted to a different lifecycle are NEVER auto-deleted as a
  //      side effect of removing the add-on; the System Owner must
  //      manage them explicitly via the Plans & Features Matrix.
  const classifyLinkedFeatureForAddOn = (addonId: string) => {
    const addon = addOnsData.find(a => a.id === addonId);
    if (!addon || !addon.linkedFeatureId) {
      return { isStandaloneCap: false, linkedFeatureName: null as string | null };
    }
    const linkedFeature = featuresData.find(f => f.id === addon.linkedFeatureId);
    const linkedFeatureName = linkedFeature?.name || addon.linkedFeatureId;
    const expectedCapKey = `cap_${addonId}`;
    const idMatches = addon.linkedFeatureId === expectedCapKey;
    const noOtherAddonRefs = !addOnsData.some(a => a.id !== addonId && a.linkedFeatureId === expectedCapKey);
    const rowShapeMatches = !!linkedFeature
      && linkedFeature.source === 'custom'
      && linkedFeature.lifecycle === 'implemented';
    const isStandaloneCap = idMatches && noOtherAddonRefs && rowShapeMatches;
    return { isStandaloneCap, linkedFeatureName };
  };

  // Add-on Runtime Linkage — perform a delete.
  // Re-checks the dependency gate (defense in depth — the modal also
  // disables the button when blockers are present) and emits
  // `addon_delete_blocked` if anything is found. On success:
  //   - Always remove the Add-on Catalog record.
  //   - If the add-on is standalone (linked to its own `cap_<addonId>`
  //     row that no other add-on references), remove the matrix row
  //     and emit `standalone_capability_row_deleted`.
  //   - If linked to an existing feature row, the feature row is
  //     PRESERVED — only the Add-on Catalog association is removed.
  //   - Emit `addon_deleted` summarizing what was removed/preserved.
  const removeAddOn = (addonId: string) => {
    if (!canArchiveDeleteAddon) { setShowAddOnDelete(null); return; }
    const addon = addOnsData.find(a => a.id === addonId);
    if (!addon) return;
    const blockers = getAddOnDeleteBlockers(addonId);
    if (blockers) {
      const reasonParts: string[] = [];
      if (blockers.inPlanFeatureNames.length > 0) reasonParts.push(`included-by-plan: ${blockers.inPlanFeatureNames.join('; ')}`);
      if (blockers.compatiblePlanNames.length > 0) reasonParts.push(`compatiblePlans: ${blockers.compatiblePlanNames.join(', ')}`);
      if (blockers.activeTrials > 0) reasonParts.push(`activeTrials=${blockers.activeTrials}`);
      if (blockers.activePaidOverrides > 0) reasonParts.push(`activePaidOverrides=${blockers.activePaidOverrides}`);
      if (blockers.pendingPayments > 0) reasonParts.push(`pendingPayments=${blockers.pendingPayments}`);
      if (blockers.openInvoiceIds.length > 0) reasonParts.push(`openInvoices=${blockers.openInvoiceIds.join(',')}`);
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'addon_delete_blocked',
        addOnId: addonId,
        note: reasonParts.join(' | ') || 'Dependencies present',
      });
      setAddOnDeleteBlockers(blockers);
      setAuditTick(t => t + 1);
      return;
    }
    const { isStandaloneCap, linkedFeatureName } = classifyLinkedFeatureForAddOn(addonId);
    setAddOnsData(prev => prev.filter(a => a.id !== addonId));
    if (isStandaloneCap && addon.linkedFeatureId) {
      const capId = addon.linkedFeatureId;
      setFeaturesData(prev => prev.filter(f => f.id !== capId));
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'standalone_capability_row_deleted',
        addOnId: addonId,
        featureId: capId,
        note: `Removed generated capability row "${linkedFeatureName || capId}" from Plans & Features Matrix`,
      });
    }
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'addon_deleted',
      addOnId: addonId,
      featureId: addon.linkedFeatureId || null,
      note: isStandaloneCap
        ? `Catalog record removed; standalone capability row "${linkedFeatureName}" removed`
        : addon.linkedFeatureId
          ? `Catalog record removed; linked feature row "${linkedFeatureName}" preserved`
          : 'Catalog record removed',
    });
    setAuditTick(t => t + 1);
    setShowAddOnDelete(null);
    setAddOnDeleteBlockers(null);
  };

  const openCreateAddOn = () => {
    setAddOnForm({
      name: '',
      price: '',
      description: '',
      compatiblePlans: [],
      // New add-ons default to Active commercial governance.
      // Governance Status is one of Active / Disabled / Archived
      // (no Draft — see "Add-on Governance & Archive Protection Rule"
      // in replit.md). Lifecycle (PM) is a separate concept and may
      // be edited independently in the form.
      lifecycle: 'active',
      governanceStatus: 'active',
      billingCadence: 'monthly',
      linkedFeatureId: '',
      // Readiness defaults: standalone-no-link → commercial_placeholder.
      // The Readiness section in the modal will derive a suggestion
      // when the user picks a Linked Feature.
      readinessStatus: 'commercial_placeholder',
      runtimeChecklist: { ...DEFAULT_RUNTIME_CHECKLIST },
      runtimeSurface: '',
      allowManualPresaleGrant: false,
      parentLinkAcknowledged: false,
    });
    setShowInlineNewFeature(false);
    setInlineNewFeatureName('');
    setEditingAddOn(null);
    setShowAddOnModal(true);
  };

  const openEditAddOn = (addon: AddOnData) => {
    setAddOnForm({
      name: addon.name,
      price: String(addon.price),
      description: addon.description,
      compatiblePlans: [...addon.compatiblePlans],
      lifecycle: addon.lifecycle,
      governanceStatus: addon.governanceStatus,
      billingCadence: addon.billingCadence,
      linkedFeatureId: addon.linkedFeatureId || '',
      readinessStatus: addon.readinessStatus || deriveSuggestedReadiness(addon),
      runtimeChecklist: addon.runtimeChecklist
        ? { ...addon.runtimeChecklist }
        : { ...DEFAULT_RUNTIME_CHECKLIST },
      runtimeSurface: addon.runtimeSurface || '',
      allowManualPresaleGrant: !!addon.allowManualPresaleGrant,
      parentLinkAcknowledged: !!addon.parentLinkAcknowledged,
    });
    setShowInlineNewFeature(false);
    setInlineNewFeatureName('');
    setEditingAddOn(addon);
    setShowAddOnModal(true);
  };

  // Derive checklist diff between old and new add-ons, returning the
  // ordered list of changed keys for audit purposes.
  const diffRuntimeChecklist = (
    oldCl: RuntimeChecklist | undefined,
    newCl: RuntimeChecklist,
  ): RuntimeChecklistKey[] => {
    const base = oldCl || DEFAULT_RUNTIME_CHECKLIST;
    return (Object.keys(newCl) as RuntimeChecklistKey[]).filter(
      k => base[k] !== newCl[k],
    );
  };

  // Inline new-feature registration for the Add-on modal. Adds a row
  // to `featuresData` (no duplicate if the slug already exists),
  // selects it on the form, and emits `feature_registered_for_addon`
  // so the audit trail captures the side effect.
  const registerInlineFeature = () => {
    const name = inlineNewFeatureName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!id) return;
    const existing = featuresData.find(f => f.id === id);
    if (!existing) {
      const defaultAvailability: Record<string, boolean> = {};
      plansData.forEach(p => { defaultAvailability[p.id] = false; });
      setFeaturesData(prev => [...prev, {
        id,
        name,
        planAvailability: defaultAvailability,
        source: 'custom' as const,
        lifecycle: 'implemented' as FeatureLifecycle,
      }]);
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'feature_registered_for_addon',
        featureId: id,
        addOnId: addOnForm.name ? addOnForm.name.toLowerCase().replace(/\s+/g, '-') : null,
        note: `Registered "${name}" in Plans & Features Matrix for new add-on`,
      });
      setAuditTick(t => t + 1);
    }
    setAddOnForm(prev => ({ ...prev, linkedFeatureId: id }));
    setInlineNewFeatureName('');
    setShowInlineNewFeature(false);
  };

  // Compute Archive blockers for an add-on. Archive is blocked while
  // ANY of the following are true (Add-on Governance & Archive
  // Protection Rule):
  //   1. The linked feature is included in any plan in the Plans &
  //      Features Matrix.
  //   2. The add-on has any Compatible Plans selected.
  //   3. There are active tenant trials linked to the add-on.
  //   4. There are active paid overrides linked to the add-on.
  //   5. There are pending payment overrides linked to the add-on.
  // Returns null when no blockers are present (Archive may proceed).
  const getAddOnArchiveBlockers = (addonId: string) => {
    const addon = addOnsData.find(a => a.id === addonId);
    if (!addon) return null;
    const inPlanFeatureNames: string[] = [];
    if (addon.linkedFeatureId) {
      const linkedFeature = featuresData.find(f => f.id === addon.linkedFeatureId);
      if (linkedFeature) {
        plansData.filter(p => p.status === 'active').forEach(p => {
          const planKey = p.id === 'starter' ? 'essential' : p.id;
          if (linkedFeature.planAvailability[planKey]) {
            inPlanFeatureNames.push(`${linkedFeature.name} included in ${p.name} plan`);
          }
        });
      }
    }
    const compatiblePlanNames: string[] = addon.compatiblePlans
      .map(pid => plansData.find(p => p.id === pid)?.name || pid);
    let activeTrials = 0;
    let activePaidOverrides = 0;
    let pendingPayments = 0;
    try {
      if (typeof window !== 'undefined') {
        const raw = window.sessionStorage.getItem('tenant_overrides_data');
        if (raw) {
          const all = JSON.parse(raw) as Array<{
            featureId: string;
            type: string;
            revokedDate?: string;
            addOnId?: string | null;
          }>;
          for (const o of all) {
            if (o.revokedDate) continue;
            const matchesAddon = o.addOnId === addonId;
            const matchesFeature =
              !!addon.linkedFeatureId && o.featureId === addon.linkedFeatureId;
            if (!matchesAddon && !matchesFeature) continue;
            if (o.type === 'trial') activeTrials++;
            else if (o.type === 'overridden' || o.type === 'addon' || o.type === 'paid_override') activePaidOverrides++;
            else if (o.type === 'pending_payment') pendingPayments++;
          }
        }
      }
    } catch {}
    const hasAny =
      inPlanFeatureNames.length > 0 ||
      compatiblePlanNames.length > 0 ||
      activeTrials > 0 ||
      activePaidOverrides > 0 ||
      pendingPayments > 0;
    if (!hasAny) return null;
    return {
      inPlanFeatureNames,
      compatiblePlanNames,
      activeTrials,
      activePaidOverrides,
      pendingPayments,
    };
  };

  const requestArchiveAddOn = (addonId: string) => {
    const blockers = getAddOnArchiveBlockers(addonId);
    setAddOnArchiveBlockers(blockers);
    setShowAddOnArchive(addonId);
  };

  // Add-on Runtime Linkage — open the Delete modal with the BLOCKED
  // variant pre-rendered when dependencies exist, or the confirm
  // variant when the delete may proceed. Either way the modal is
  // opened from the same code path so the UI never has to recompute
  // blockers itself.
  const requestDeleteAddOn = (addonId: string) => {
    const blockers = getAddOnDeleteBlockers(addonId);
    setAddOnDeleteBlockers(blockers);
    setShowAddOnDelete(addonId);
  };

  const saveAddOn = () => {
    if (editingAddOn ? !canEditAddon : !canCreateAddon) return;
    const todayIso = new Date().toISOString().slice(0, 10);
    const isCreate = !editingAddOn;
    const id = editingAddOn?.id || addOnForm.name.toLowerCase().replace(/\s+/g, '-');
    const oldAddOn = editingAddOn;
    // Honor Archive Protection from the modal Governance Status
    // dropdown: if the user picks Archived while dependencies still
    // exist, refuse the save, push `addon_archive_blocked`, and pop
    // the blocked-variant Archive modal listing what to clear.
    if (oldAddOn && oldAddOn.governanceStatus !== 'archived' && addOnForm.governanceStatus === 'archived') {
      const blockers = getAddOnArchiveBlockers(id);
      if (blockers) {
        const reasonParts: string[] = [];
        if (blockers.inPlanFeatureNames.length > 0) reasonParts.push(`included-by-plan: ${blockers.inPlanFeatureNames.join('; ')}`);
        if (blockers.compatiblePlanNames.length > 0) reasonParts.push(`compatiblePlans: ${blockers.compatiblePlanNames.join(', ')}`);
        if (blockers.activeTrials > 0) reasonParts.push(`activeTrials=${blockers.activeTrials}`);
        if (blockers.activePaidOverrides > 0) reasonParts.push(`activePaidOverrides=${blockers.activePaidOverrides}`);
        if (blockers.pendingPayments > 0) reasonParts.push(`pendingPayments=${blockers.pendingPayments}`);
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'addon_archive_blocked',
          addOnId: id,
          note: reasonParts.join(' | ') || 'Dependencies present',
        });
        setAuditTick(t => t + 1);
        setShowAddOnModal(false);
        setEditingAddOn(null);
        setAddOnArchiveBlockers(blockers);
        setShowAddOnArchive(id);
        return;
      }
    }
    // Standalone-capability registration. When the user saves with
    // Linked Feature = None (and the existing record didn't already
    // have a generated capability key linked), auto-register a
    // capability row in the Plans & Features Matrix so the System
    // Owner can include the standalone add-on capability in plans
    // from the matrix. The capability key is stable per add-on
    // (`cap_<addonId>`) so re-saving / editing the same add-on
    // never duplicates the row. See replit.md → "Add-on Governance
    // & Archive Protection Rule" → Standalone capability
    // registration.
    let effectiveLinkedFeatureId: string | null =
      addOnForm.linkedFeatureId ? addOnForm.linkedFeatureId : null;
    if (!effectiveLinkedFeatureId) {
      const capKey = `cap_${id}`;
      effectiveLinkedFeatureId = capKey;
      const exists = featuresData.some(f => f.id === capKey);
      if (!exists) {
        const defaultAvailability: Record<string, boolean> = {};
        plansData.forEach(p => { defaultAvailability[p.id] = false; });
        setFeaturesData(prev => [...prev, {
          id: capKey,
          name: addOnForm.name,
          planAvailability: defaultAvailability,
          source: 'custom' as const,
          lifecycle: 'implemented' as FeatureLifecycle,
        }]);
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'feature_registered_for_addon',
          featureId: capKey,
          addOnId: id,
          note: `Registered standalone capability "${addOnForm.name}" in Plans & Features Matrix`,
        });
      }
    }
    // Force-include locked plans (plans where the effective linked
    // feature/capability is included by plan in Plans & Features
    // Matrix). The Plans & Features Matrix is the source of truth
    // for included-by-plan access, so the Add-on Catalog cannot opt
    // out of those plans.
    const linkedFeature = effectiveLinkedFeatureId
      ? featuresData.find(f => f.id === effectiveLinkedFeatureId)
      : undefined;
    const lockedPlanIds = linkedFeature
      ? plansData
          .filter(p => p.status === 'active')
          .map(p => p.id)
          .filter(planId => {
            const planKey = planId === 'starter' ? 'essential' : planId;
            return !!linkedFeature.planAvailability[planKey];
          })
      : [];
    const mergedCompatiblePlans = Array.from(
      new Set([...(addOnForm.compatiblePlans || []), ...lockedPlanIds]),
    );
    const newAddOn: AddOnData = {
      id,
      name: addOnForm.name,
      price: Number(addOnForm.price),
      description: addOnForm.description,
      // Persist compatible plans whenever the add-on is commercially
      // offerable (governanceStatus === 'active'). Locked plans from
      // the linked feature in the matrix are still merged in.
      compatiblePlans: addOnForm.governanceStatus === 'active' ? mergedCompatiblePlans : [],
      status: addOnForm.governanceStatus === 'archived' ? 'archived' : 'active',
      lifecycle: addOnForm.lifecycle,
      governanceStatus: addOnForm.governanceStatus,
      billingCadence: addOnForm.billingCadence,
      linkedFeatureId: effectiveLinkedFeatureId,
      // Implementation Readiness fields. These are persisted as-is from
      // the modal so the System Owner has explicit control over the
      // readiness status, runtime checklist, runtime surface, manual
      // presale flag, and parent-feature acknowledgement.
      readinessStatus: addOnForm.readinessStatus,
      runtimeChecklist: { ...addOnForm.runtimeChecklist },
      runtimeSurface: addOnForm.runtimeSurface || undefined,
      allowManualPresaleGrant: addOnForm.allowManualPresaleGrant,
      parentLinkAcknowledged: addOnForm.parentLinkAcknowledged,
      createdAt: editingAddOn?.createdAt || todayIso,
      createdBy: editingAddOn?.createdBy || 'System Owner',
      updatedAt: todayIso,
      updatedBy: editingAddOn ? 'System Owner' : (editingAddOn?.updatedBy ?? undefined),
    };
    if (editingAddOn) {
      setAddOnsData(prev => prev.map(a => a.id === editingAddOn.id ? newAddOn : a));
    } else {
      setAddOnsData(prev => [...prev, newAddOn]);
    }
    if (isCreate) {
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'addon_created',
        addOnId: id,
        featureId: newAddOn.linkedFeatureId,
        newValue: newAddOn.price,
        note: `${newAddOn.name} (${newAddOn.governanceStatus}, ${newAddOn.billingCadence})`,
      });
      // Initial readiness state on create — capture so the audit
      // trail records the Day-0 readiness assumption.
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'addon_readiness_changed',
        addOnId: id,
        oldValue: '(none)',
        newValue: newAddOn.readinessStatus || 'commercial_placeholder',
        note: 'Initial readiness on create',
      });
    } else if (oldAddOn) {
      if (oldAddOn.price !== newAddOn.price) {
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'addon_default_price_changed',
          addOnId: id,
          oldValue: oldAddOn.price,
          newValue: newAddOn.price,
        });
      }
      if (oldAddOn.governanceStatus !== newAddOn.governanceStatus) {
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'addon_status_changed',
          addOnId: id,
          oldValue: oldAddOn.governanceStatus,
          newValue: newAddOn.governanceStatus,
        });
        // Mirror setAddOnGovernance: when the modal Governance Status
        // dropdown transitions an add-on to `archived` and a
        // `cap_<addonId>` row exists in the matrix, that row's plan
        // toggles get locked read-only. Emit the lock audit exactly
        // once at the moment of transition so both code paths
        // (governance buttons + modal save) produce the same trail.
        if (newAddOn.governanceStatus === 'archived') {
          const capRowId = `cap_${id}`;
          const capRowExists = featuresData.some(f => f.id === capRowId)
            || (effectiveLinkedFeatureId === capRowId);
          if (capRowExists) {
            pushCommercialAudit({
              actor: 'System Owner',
              action: 'standalone_capability_row_archive_locked',
              addOnId: id,
              featureId: capRowId,
              note: 'Plan toggles locked because owning add-on is archived',
            });
          }
        }
      }
      // Add-on Runtime Linkage — record any change to linkedFeatureId
      // so the audit trail captures the new capability the add-on
      // controls. Both `null` (standalone) and a feature id are valid
      // values; the comparison normalizes undefined to the empty
      // string so the seed catalog (where linkedFeatureId may be
      // omitted) doesn't generate spurious change events.
      const oldLinked = oldAddOn.linkedFeatureId || '';
      const newLinked = newAddOn.linkedFeatureId || '';
      if (oldLinked !== newLinked) {
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'addon_linked_feature_changed',
          addOnId: id,
          oldValue: oldLinked || '(standalone)',
          newValue: newLinked || '(standalone)',
        });
      }
      // Implementation Readiness diffs. Each readiness-related field
      // gets its own audit entry so the trail captures exactly what
      // the System Owner changed (status, checklist items, manual
      // presale flag, parent-feature acknowledgement).
      const oldReadiness = oldAddOn.readinessStatus || deriveSuggestedReadiness(oldAddOn);
      if (oldReadiness !== newAddOn.readinessStatus) {
        const suggested = deriveSuggestedReadiness(newAddOn);
        const isOverride = newAddOn.readinessStatus !== suggested;
        pushCommercialAudit({
          actor: 'System Owner',
          action: isOverride ? 'addon_readiness_overridden' : 'addon_readiness_changed',
          addOnId: id,
          oldValue: oldReadiness,
          newValue: newAddOn.readinessStatus || 'commercial_placeholder',
          note: isOverride ? `Manual override (suggested was ${suggested})` : undefined,
        });
      }
      const changedChecklistKeys = diffRuntimeChecklist(oldAddOn.runtimeChecklist, newAddOn.runtimeChecklist!);
      if (changedChecklistKeys.length > 0) {
        const noteParts = changedChecklistKeys.map(k => {
          const oldVal = (oldAddOn.runtimeChecklist || DEFAULT_RUNTIME_CHECKLIST)[k];
          const newVal = newAddOn.runtimeChecklist![k];
          return `${RUNTIME_CHECKLIST_LABELS[k]}: ${oldVal} → ${newVal}`;
        });
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'addon_runtime_checklist_updated',
          addOnId: id,
          note: noteParts.join(' | '),
        });
      }
      if (!!oldAddOn.allowManualPresaleGrant !== !!newAddOn.allowManualPresaleGrant) {
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'addon_manual_presale_allowed',
          addOnId: id,
          oldValue: oldAddOn.allowManualPresaleGrant ? 'true' : 'false',
          newValue: newAddOn.allowManualPresaleGrant ? 'true' : 'false',
          note: newAddOn.allowManualPresaleGrant
            ? 'Manual / presale tenant grant explicitly enabled'
            : 'Manual / presale tenant grant disabled',
        });
      }
      if (!!oldAddOn.parentLinkAcknowledged !== !!newAddOn.parentLinkAcknowledged) {
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'addon_parent_link_acknowledged',
          addOnId: id,
          oldValue: oldAddOn.parentLinkAcknowledged ? 'true' : 'false',
          newValue: newAddOn.parentLinkAcknowledged ? 'true' : 'false',
        });
      }
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'addon_updated',
        addOnId: id,
        note: 'Catalog entry edited',
      });
    }
    setAuditTick(t => t + 1);
    setShowAddOnModal(false);
    setEditingAddOn(null);
  };

  // Generate Implementation Brief — opens the brief modal for the
  // selected add-on. The Copy action emits
  // `addon_implementation_brief_generated` so the trail captures the
  // export. See replit.md → "Add-on Implementation Readiness" →
  // Implementation Brief.
  const openBriefModal = (addonId: string) => {
    if (!canGenBrief) return;
    setBriefModalAddOnId(addonId);
    setBriefCopyToast(false);
  };
  const copyBriefToClipboard = async (addon: AddOnData, briefText: string) => {
    if (!canGenBrief) return;
    try {
      await navigator.clipboard.writeText(briefText);
      setBriefCopyToast(true);
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'addon_implementation_brief_generated',
        addOnId: addon.id,
        note: `Copied implementation brief (${briefText.length} chars)`,
      });
      setAuditTick(t => t + 1);
      window.setTimeout(() => setBriefCopyToast(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted browser contexts;
      // the user can still select-all the textarea and copy manually.
      setBriefCopyToast(false);
    }
  };

  const setAddOnGovernance = (addonId: string, next: AddOnGovernanceStatus) => {
    if (!canArchiveDeleteAddon) return;
    // Archive Protection. Refuse the transition when ANY dependency
    // still references the add-on (linked feature in plan,
    // compatiblePlans, active trial / paid override / pending
    // payment). Push `addon_archive_blocked` so the audit trail
    // captures the refused attempt + reason. The Archive modal is
    // already showing the blocked variant via `requestArchiveAddOn`.
    if (next === 'archived') {
      const blockers = getAddOnArchiveBlockers(addonId);
      if (blockers) {
        const reasonParts: string[] = [];
        if (blockers.inPlanFeatureNames.length > 0) reasonParts.push(`included-by-plan: ${blockers.inPlanFeatureNames.join('; ')}`);
        if (blockers.compatiblePlanNames.length > 0) reasonParts.push(`compatiblePlans: ${blockers.compatiblePlanNames.join(', ')}`);
        if (blockers.activeTrials > 0) reasonParts.push(`activeTrials=${blockers.activeTrials}`);
        if (blockers.activePaidOverrides > 0) reasonParts.push(`activePaidOverrides=${blockers.activePaidOverrides}`);
        if (blockers.pendingPayments > 0) reasonParts.push(`pendingPayments=${blockers.pendingPayments}`);
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'addon_archive_blocked',
          addOnId: addonId,
          note: reasonParts.join(' | ') || 'Dependencies present',
        });
        setAddOnArchiveBlockers(blockers);
        setAuditTick(t => t + 1);
        return;
      }
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    // Standalone-cap archive lock audit. When an add-on transitions
    // to `archived` and a `cap_<addonId>` row exists in the Plans &
    // Features Matrix, that row's plan toggles are locked read-only
    // (rendered with an "Add-on Archived" badge). We emit the audit
    // exactly once at the moment of transition; downstream renders
    // do not re-emit. See replit.md → "Add-on Runtime Linkage &
    // Delete/Archive Matrix Behavior" → Archived standalone
    // capability rows.
    if (next === 'archived') {
      const prevAddon = addOnsData.find(a => a.id === addonId);
      const capRowId = `cap_${addonId}`;
      const capRowExists = featuresData.some(f => f.id === capRowId);
      if (prevAddon && prevAddon.governanceStatus !== 'archived' && capRowExists) {
        pushCommercialAudit({
          actor: 'System Owner',
          action: 'standalone_capability_row_archive_locked',
          addOnId: addonId,
          featureId: capRowId,
          note: 'Plan toggles locked because owning add-on is archived',
        });
      }
    }
    setAddOnsData(prev => prev.map(a => {
      if (a.id !== addonId) return a;
      const oldStatus = a.governanceStatus;
      if (oldStatus === next) return a;
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'addon_status_changed',
        addOnId: addonId,
        oldValue: oldStatus,
        newValue: next,
      });
      return {
        ...a,
        governanceStatus: next,
        // Mirror legacy `status` so existing UI that reads it stays consistent.
        status: next === 'archived' ? 'archived' : 'active',
        // Mirror legacy PM `lifecycle` so the rest of the page stays in
        // sync when the add-on is archived/restored. PM lifecycle is
        // otherwise an independent concept and is edited via the form.
        lifecycle: next === 'archived'
          ? 'archived'
          : (a.lifecycle === 'archived' ? 'active' : a.lifecycle),
        updatedAt: todayIso,
        updatedBy: 'System Owner',
      };
    }));
    setShowAddOnArchive(null);
    setShowAddOnDisableConfirm(null);
    setAddOnArchiveBlockers(null);
    setAuditTick(t => t + 1);
  };

  const archiveAddOn = (addonId: string) => setAddOnGovernance(addonId, 'archived');
  const restoreAddOn = (addonId: string) => setAddOnGovernance(addonId, 'active');

  // Plans where the add-on's linked feature is included by plan are
  // locked — they MUST be in compatiblePlans and cannot be unchecked
  // from this editor. The Plans & Features Matrix is the source of
  // truth for included-by-plan access; the Add-on Catalog cannot
  // contradict it. See replit.md → "Add-on Plan Inclusion Source-
  // of-Truth Rule".
  const isPlanLockedForAddOn = (planId: string): boolean => {
    if (!addOnForm.linkedFeatureId) return false;
    const linkedFeature = featuresData.find(f => f.id === addOnForm.linkedFeatureId);
    if (!linkedFeature) return false;
    const planKey = planId === 'starter' ? 'essential' : planId;
    return !!linkedFeature.planAvailability[planKey];
  };

  const toggleAddOnPlan = (plan: string) => {
    if (isPlanLockedForAddOn(plan)) return;
    setAddOnForm(prev => ({
      ...prev,
      compatiblePlans: prev.compatiblePlans.includes(plan)
        ? prev.compatiblePlans.filter(p => p !== plan)
        : [...prev.compatiblePlans, plan]
    }));
  };

  const tabs = [
    { id: 'plans' as const, label: 'Plans', icon: 'workspace_premium' },
    { id: 'features' as const, label: 'Feature Matrix', icon: 'grid_view' },
    ...(canSeeAddons ? [{ id: 'addons' as const, label: 'Add-ons', icon: 'extension' }] : []),
  ];

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Plans & Features</h2>
          <p className="text-slate-500 font-medium">Manage subscription plans, feature access, and add-ons.</p>
        </div>
        {activeTab === 'plans' && canCreatePlan && (
          <button onClick={openCreatePlan} className="px-5 py-3 bg-primary text-white font-black text-[10px] rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
            <span className="material-symbols-outlined text-sm">add</span>
            Create New Plan
          </button>
        )}
        {activeTab === 'features' && canEditMatrix && (
          <button onClick={() => setShowFeatureModal(true)} className="px-5 py-3 bg-primary text-white font-black text-[10px] rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
            <span className="material-symbols-outlined text-sm">add</span>
            Add Feature
          </button>
        )}
        {activeTab === 'addons' && canCreateAddon && (
          <button onClick={openCreateAddOn} className="px-5 py-3 bg-primary text-white font-black text-[10px] rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
            <span className="material-symbols-outlined text-sm">add</span>
            Create Add-on
          </button>
        )}
      </div>

      <div className="flex gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 w-fit">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            className={`px-5 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center gap-2 ${
              activeTab === tab.id ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            <span className="material-symbols-outlined text-sm">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'plans' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plansData.map((plan) => (
            <motion.div
              key={plan.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className={`bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border shadow-sm hover:shadow-md transition-all flex flex-col ${
                plan.status === 'archived' ? 'border-slate-300 opacity-60' : 'border-slate-200'
              }`}
            >
              <div className="mb-6 flex justify-between items-start">
                <div>
                  <h3 className="text-xl font-black text-primary tracking-tight">{plan.name}</h3>
                  <div className="flex items-baseline gap-1 mt-2">
                    <span className="text-4xl font-black text-primary">${plan.price}</span>
                    <span className="text-slate-400 font-bold">/{plan.billingCycle === 'annual' ? 'yr' : 'mo'}</span>
                  </div>
                </div>
                {plan.status === 'archived' && (
                  <span className="px-2.5 py-1 bg-slate-400/10 text-slate-500 text-[9px] font-black uppercase tracking-widest rounded-lg border border-slate-200">Archived</span>
                )}
              </div>

              <div className="space-y-4 flex-grow mb-8">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Features</p>
                <ul className="space-y-2">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm font-bold text-slate-700">
                      <span className="material-symbols-outlined text-lime-500 text-sm">check</span>
                      {feature}
                    </li>
                  ))}
                </ul>

                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest pt-4">Limits</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Seats</p>
                    <p className="font-black text-primary">{plan.limits.seats}</p>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Locations</p>
                    <p className="font-black text-primary">{plan.limits.locations}</p>
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                {canEditPlan && (
                  <button onClick={() => openEditPlan(plan)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                    Edit
                  </button>
                )}
                {plan.status === 'archived' ? (
                  canArchivePlan && (
                    <button onClick={() => restorePlan(plan.id)} className="flex-1 py-3 bg-lime-100 hover:bg-lime-200 text-lime-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                      Restore
                    </button>
                  )
                ) : (
                  canArchivePlan && (
                    <button onClick={() => setShowArchiveConfirm(plan.id)} className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                      Archive
                    </button>
                  )
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {activeTab === 'features' && (
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-8 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <span className="material-symbols-outlined text-sm">filter_list</span>
              <span>Filters</span>
            </div>
            <label className="flex items-center gap-2 text-[10px] font-black text-slate-600 uppercase tracking-widest cursor-pointer">
              <input
                type="checkbox"
                checked={showArchivedFeatures}
                onChange={e => setShowArchivedFeatures(e.target.checked)}
                className="accent-primary"
              />
              Show archived / deprecated
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Feature</th>
                  <th className="px-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                  {activePlans.map(plan => (
                    <th key={plan.id} className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">{plan.name}</th>
                  ))}
                  <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {featuresData
                  // Archived/deprecated feature rows are filtered out
                  // by default; toggle "Show archived/deprecated" to
                  // surface them. Archived STANDALONE add-on cap rows
                  // (`cap_<addonId>` for an add-on whose
                  // governanceStatus === 'archived') are ALWAYS
                  // visible regardless of the toggle — they remain in
                  // the matrix as the System Owner's source-of-truth
                  // record (read-only with an "Add-on Archived"
                  // badge) so audit reviewers can always see what the
                  // archived add-on was wired to. See replit.md →
                  // "Add-on Runtime Linkage & Delete/Archive Matrix
                  // Behavior" → Archived standalone capability rows.
                  .filter(f => {
                    if (showArchivedFeatures) return true;
                    if (f.id.startsWith('cap_')) {
                      const owner = addOnsData.find(a => `cap_${a.id}` === f.id);
                      if (owner && owner.governanceStatus === 'archived') return true;
                    }
                    if (f.lifecycle === 'archived' || f.lifecycle === 'deprecated') return false;
                    return true;
                  })
                  .map((feature) => {
                  // Detect a standalone-cap row whose owning add-on is
                  // archived. When true the row is locked read-only:
                  // toggles render as a lock icon and the row carries
                  // an "Add-on Archived" badge. The owning add-on can
                  // be Restored from the Add-on Catalog to re-enable
                  // editing.
                  const capOwner = feature.id.startsWith('cap_')
                    ? addOnsData.find(a => `cap_${a.id}` === feature.id)
                    : undefined;
                  const isArchivedCapRow = !!(capOwner && capOwner.governanceStatus === 'archived');
                  const isAssignable = feature.lifecycle === 'implemented' && !isArchivedCapRow;
                  return (
                    <tr key={feature.id} className={`hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 ${feature.lifecycle === 'archived' || feature.lifecycle === 'deprecated' || isArchivedCapRow ? 'opacity-60' : ''}`}>
                      <td className="px-8 py-4">
                        <span className="font-bold text-slate-900">{feature.name}</span>
                        <span className={`ml-2 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md border ${
                          feature.source === 'inherited'
                            ? 'bg-blue-400/10 text-blue-600 border-blue-400/20'
                            : 'bg-violet-400/10 text-violet-600 border-violet-400/20'
                        }`}>{feature.source}</span>
                        {isArchivedCapRow && (
                          <>
                            <span
                              className="ml-2 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md border bg-amber-400/10 text-amber-700 border-amber-400/30"
                              title={`Owning add-on "${capOwner?.name}" is archived. Restore the add-on to re-enable editing.`}
                            >
                              Add-on Archived
                            </span>
                            <p className="mt-1 text-[10px] text-amber-700 font-medium leading-snug">
                              This add-on is archived. Its generated capability row is read-only — restore the add-on from the Add-on Catalog to re-enable editing.
                            </p>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <select
                          value={feature.lifecycle}
                          onChange={e => changeLifecycle(feature.id, e.target.value as FeatureLifecycle)}
                          disabled={isArchivedCapRow || !canEditMatrix}
                          className="text-[9px] font-black uppercase tracking-widest bg-transparent border border-slate-200 rounded-lg px-2 py-1.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {LIFECYCLE_ORDER.map(lc => (
                            <option key={lc} value={lc}>{lc === 'in_development' ? 'In Dev' : lc.charAt(0).toUpperCase() + lc.slice(1)}</option>
                          ))}
                        </select>
                      </td>
                      {activePlans.map(plan => (
                        <td key={plan.id} className="px-6 py-4 text-center">
                          {isAssignable && canEditMatrix ? (
                            <button
                              onClick={() => toggleFeature(feature.id, plan.id)}
                              className="transition-all hover:scale-110 active:scale-95"
                            >
                              {feature.planAvailability[plan.id] ? (
                                <span className="material-symbols-outlined text-lime-500">toggle_on</span>
                              ) : (
                                <span className="material-symbols-outlined text-slate-300">toggle_off</span>
                              )}
                            </button>
                          ) : isArchivedCapRow ? (
                            <span
                              className="material-symbols-outlined text-amber-400 text-sm"
                              title="Locked — owning add-on is archived"
                            >lock</span>
                          ) : (
                            <span className="material-symbols-outlined text-slate-200 text-sm" title="Only implemented features can be assigned">lock</span>
                          )}
                        </td>
                      ))}
                      <td className="px-8 py-4 text-center">
                        {feature.source === 'custom' && !isArchivedCapRow && canEditMatrix ? (
                          <button onClick={() => setShowDeleteConfirm(feature.id)} className="text-slate-400 hover:text-red-500 transition-colors">
                            <span className="material-symbols-outlined text-sm">delete</span>
                          </button>
                        ) : (
                          <span className="text-[9px] text-slate-300 font-bold uppercase tracking-widest">locked</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-8 py-4 border-t border-slate-100 bg-slate-50/30">
            <div className="flex gap-3 flex-wrap items-center">
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Legend:</span>
              {LIFECYCLE_ORDER.map(lc => (
                <span key={lc}>{lifecycleBadge(lc)}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'addons' && canSeeAddons && (
        <>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-2 items-center text-[10px] font-black uppercase tracking-widest">
              <span className="text-slate-400">Governance:</span>
              <span className="px-2 py-0.5 rounded-md border bg-lime-400/10 text-lime-700 border-lime-400/20">Active {addOnsData.filter(a => a.governanceStatus === 'active').length}</span>
              <span className="px-2 py-0.5 rounded-md border bg-amber-400/10 text-amber-700 border-amber-400/20">Disabled {addOnsData.filter(a => a.governanceStatus === 'disabled').length}</span>
              <span className="px-2 py-0.5 rounded-md border bg-slate-400/10 text-slate-500 border-slate-200">Archived {addOnsData.filter(a => a.governanceStatus === 'archived').length}</span>
            </div>
            <div className="flex gap-2 items-center">
              <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                <input type="checkbox" checked={showArchivedAddOns} onChange={e => setShowArchivedAddOns(e.target.checked)} className="accent-primary" />
                Show archived
              </label>
              <button onClick={() => setShowCommercialAudit(true)} className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">receipt_long</span>
                Audit log
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {addOnsData
              .filter(a => showArchivedAddOns || a.governanceStatus !== 'archived')
              .map((addon) => {
                const govStyles: Record<AddOnGovernanceStatus, string> = {
                  active: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
                  disabled: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
                  archived: 'bg-slate-400/10 text-slate-500 border-slate-200',
                };
                const govLabel: Record<AddOnGovernanceStatus, string> = {
                  active: 'Active',
                  disabled: 'Disabled',
                  archived: 'Archived',
                };
                const linkedFeatureName = addon.linkedFeatureId
                  ? (featuresData.find(f => f.id === addon.linkedFeatureId)?.name || addon.linkedFeatureId)
                  : null;
                const isOfferable = addon.governanceStatus === 'active';
                return (
                  <motion.div
                    key={addon.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border shadow-sm hover:shadow-md transition-all ${
                      addon.governanceStatus === 'archived' ? 'border-slate-300 opacity-60' :
                      addon.governanceStatus === 'disabled' ? 'border-amber-200 opacity-75' :
                      'border-slate-200'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2 gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-lg font-black text-primary tracking-tight">{addon.name}</h3>
                        <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md border ${govStyles[addon.governanceStatus]}`}>
                          {govLabel[addon.governanceStatus]}
                        </span>
                        {(() => {
                          const r = getReadinessStatus(addon);
                          return (
                            <span
                              className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md border ${READINESS_BADGE_STYLES[r]}`}
                              title={READINESS_DESCRIPTIONS[r]}
                            >
                              {READINESS_LABELS[r]}
                            </span>
                          );
                        })()}
                      </div>
                      <span className="text-xl font-black text-primary whitespace-nowrap">${addon.price}<span className="text-[10px] text-slate-400">/{addon.billingCadence === 'one_time' ? 'once' : addon.billingCadence === 'annual' ? 'yr' : 'mo'}</span></span>
                    </div>
                    <p className="text-sm text-slate-500 mb-4 leading-relaxed">{addon.description}</p>

                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Linked feature</p>
                        <p className="text-xs font-bold text-slate-700 truncate">{linkedFeatureName || '—'}</p>
                      </div>
                      <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Cadence</p>
                        <p className="text-xs font-bold text-slate-700 capitalize">{addon.billingCadence.replace('_', ' ')}</p>
                      </div>
                    </div>

                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Compatible Plans</p>
                    <div className="flex gap-2 flex-wrap mb-3">
                      {addon.compatiblePlans.length > 0 ? addon.compatiblePlans.map((planId, i) => {
                        const planObj = plansData.find(p => p.id === planId);
                        return (
                          <span key={i} className="px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">
                            {planObj?.name || planId}
                          </span>
                        );
                      }) : (
                        <span className="text-[10px] text-slate-300 font-bold">No plans assigned</span>
                      )}
                    </div>

                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Governance</p>
                    <div className="flex gap-1.5 mb-3">
                      <button
                        onClick={() => setAddOnGovernance(addon.id, 'active')}
                        disabled={addon.governanceStatus === 'active' || !canArchiveDeleteAddon}
                        className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-xl transition-all ${
                          addon.governanceStatus === 'active'
                            ? 'bg-lime-500 text-white shadow-sm cursor-default'
                            : !canArchiveDeleteAddon ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                            : 'bg-lime-100 hover:bg-lime-200 text-lime-700'
                        }`}
                      >Active</button>
                      <button
                        onClick={() => addon.governanceStatus === 'disabled' ? undefined : setShowAddOnDisableConfirm(addon.id)}
                        disabled={addon.governanceStatus === 'disabled' || !canArchiveDeleteAddon}
                        className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-xl transition-all ${
                          addon.governanceStatus === 'disabled'
                            ? 'bg-amber-500 text-white shadow-sm cursor-default'
                            : !canArchiveDeleteAddon ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                            : 'bg-amber-100 hover:bg-amber-200 text-amber-700'
                        }`}
                      >Disabled</button>
                      <button
                        onClick={() => addon.governanceStatus === 'archived' ? undefined : requestArchiveAddOn(addon.id)}
                        disabled={addon.governanceStatus === 'archived' || !canArchiveDeleteAddon}
                        className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-xl transition-all ${
                          addon.governanceStatus === 'archived'
                            ? 'bg-slate-500 text-white shadow-sm cursor-default'
                            : !canArchiveDeleteAddon ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                        }`}
                      >Archived</button>
                    </div>
                    {!isOfferable && (
                      <p className="text-[10px] text-amber-700 font-bold bg-amber-50 px-2 py-1.5 rounded-lg border border-amber-100 mb-3">
                        Not offerable. Existing tenant overrides for the linked feature are inactive until reactivated.
                      </p>
                    )}

                    <div className="border-t border-slate-100 pt-3 mb-3 grid grid-cols-2 gap-2 text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                      <span>Created {addon.createdAt} · {addon.createdBy}</span>
                      <span className="text-right">Updated {addon.updatedAt}{addon.updatedBy ? ` · ${addon.updatedBy}` : ''}</span>
                    </div>

                    <div className="flex gap-2">
                      {canEditAddon && (
                        <button onClick={() => openEditAddOn(addon)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                          Edit
                        </button>
                      )}
                      {canArchiveDeleteAddon && (
                        <button onClick={() => requestDeleteAddOn(addon.id)} className="py-3 px-4 bg-red-50 hover:bg-red-100 text-red-500 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                          <span className="material-symbols-outlined text-sm">delete</span>
                        </button>
                      )}
                    </div>
                  </motion.div>
                );
              })}
          </div>
        </>
      )}

      <AnimatePresence>
        {showPlanModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowPlanModal(false)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center">
                <div>
                  <h3 className="text-xl font-black text-primary tracking-tight">{editingPlan ? 'Edit Plan' : 'Create New Plan'}</h3>
                  <p className="text-sm text-slate-500 mt-1">Define plan details, pricing, and limits.</p>
                </div>
                <button onClick={() => setShowPlanModal(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="p-8 space-y-5">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Plan Name</label>
                  <input value={planForm.name} onChange={e => setPlanForm(p => ({ ...p, name: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="e.g., Professional" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Price (USD)</label>
                    <input type="number" value={planForm.price} onChange={e => setPlanForm(p => ({ ...p, price: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="99" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Billing Cycle</label>
                    <select value={planForm.billingCycle} onChange={e => setPlanForm(p => ({ ...p, billingCycle: e.target.value as 'monthly' | 'annual' }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Max Seats</label>
                    <input type="number" value={planForm.seats} onChange={e => setPlanForm(p => ({ ...p, seats: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="10" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Max Locations</label>
                    <input type="number" value={planForm.locations} onChange={e => setPlanForm(p => ({ ...p, locations: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="3" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Features (comma-separated)</label>
                  <textarea value={planForm.features} onChange={e => setPlanForm(p => ({ ...p, features: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none" rows={3} placeholder="Sales, Repairs, Inventory, Customers" />
                </div>
              </div>
              <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button onClick={() => setShowPlanModal(false)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={savePlan} disabled={!planForm.name || !planForm.price} className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed">{editingPlan ? 'Save Changes' : 'Create Plan'}</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showArchiveConfirm && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowArchiveConfirm(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="p-8 text-center">
                <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <span className="material-symbols-outlined text-amber-600 text-2xl">archive</span>
                </div>
                <h3 className="text-lg font-black text-primary tracking-tight mb-2">Archive Plan?</h3>
                <p className="text-sm text-slate-500">This plan will be hidden from new subscriptions. Existing tenants on this plan will not be affected.</p>
              </div>
              <div className="p-8 pt-0 flex gap-3">
                <button onClick={() => setShowArchiveConfirm(null)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={() => archivePlan(showArchiveConfirm)} className="flex-1 py-3.5 bg-amber-500 text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-amber-600 transition-all shadow-lg shadow-amber-500/20">Archive</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showFeatureModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowFeatureModal(false)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center">
                <h3 className="text-lg font-black text-primary tracking-tight">Add Feature</h3>
                <button onClick={() => setShowFeatureModal(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="p-8 space-y-5">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Feature Name</label>
                  <input value={newFeatureName} onChange={e => setNewFeatureName(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="e.g., Advanced Analytics" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Initial Status</label>
                  <select value={newFeatureLifecycle} onChange={e => setNewFeatureLifecycle(e.target.value as FeatureLifecycle)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                    {LIFECYCLE_ORDER.map(lc => (
                      <option key={lc} value={lc}>{lc === 'in_development' ? 'In Development' : lc.charAt(0).toUpperCase() + lc.slice(1).replace('_', ' ')}</option>
                    ))}
                  </select>
                  {newFeatureLifecycle !== 'implemented' && (
                    <p className="text-[10px] text-amber-600 font-bold mt-2">Only &quot;Implemented&quot; features can be assigned to plans.</p>
                  )}
                </div>
              </div>
              <div className="p-8 pt-0 flex gap-3">
                <button onClick={() => setShowFeatureModal(false)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={addFeature} disabled={!newFeatureName.trim()} className="flex-1 py-3.5 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 disabled:opacity-40">Add</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDeleteConfirm && (() => {
          const feature = featuresData.find(f => f.id === showDeleteConfirm);
          const deps = feature ? getFeatureDependencies(showDeleteConfirm) : [];
          return (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowDeleteConfirm(null)}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                onClick={e => e.stopPropagation()}
                className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden"
              >
                <div className="p-8 text-center">
                  <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <span className="material-symbols-outlined text-red-600 text-2xl">delete_forever</span>
                  </div>
                  <h3 className="text-lg font-black text-primary tracking-tight mb-2">Delete Feature?</h3>
                  <p className="text-sm text-slate-500 mb-3">
                    Remove &quot;{feature?.name}&quot; from the feature matrix. This action cannot be undone.
                  </p>
                  {deps.length > 0 && (
                    <div className="bg-amber-50 rounded-xl border border-amber-200 p-3 text-left">
                      <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2 flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">warning</span>
                        Active in {deps.length} plan{deps.length !== 1 ? 's' : ''}
                      </p>
                      <div className="flex gap-1.5 flex-wrap">
                        {deps.map(p => (
                          <span key={p.id} className="px-2 py-0.5 bg-amber-100 text-amber-800 text-[9px] font-black uppercase tracking-widest rounded-md">{p.name}</span>
                        ))}
                      </div>
                      <p className="text-[10px] text-amber-600 font-bold mt-2">Remove this feature from all plans before deleting.</p>
                    </div>
                  )}
                </div>
                <div className="p-8 pt-0 flex gap-3">
                  <button onClick={() => setShowDeleteConfirm(null)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                  <button onClick={() => removeFeature(showDeleteConfirm)} disabled={deps.length > 0} className="flex-1 py-3.5 bg-red-500 text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-red-600 transition-all shadow-lg shadow-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed">
                    {deps.length > 0 ? 'Remove from Plans First' : 'Delete'}
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {showAddOnDelete && (() => {
          const addon = addOnsData.find(a => a.id === showAddOnDelete);
          const blockers = addOnDeleteBlockers;
          const cls = addon ? classifyLinkedFeatureForAddOn(showAddOnDelete) : { isStandaloneCap: false, linkedFeatureName: null as string | null };
          const closeAndReset = () => {
            setShowAddOnDelete(null);
            setAddOnDeleteBlockers(null);
          };
          return (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={closeAndReset}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                onClick={e => e.stopPropagation()}
                className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden"
              >
                {blockers ? (
                  /* BLOCKED VARIANT — dependencies still reference the
                     add-on or its linked capability. The footer offers
                     "Got it" only; the user must clear the listed
                     dependencies (or use Archive) before deleting. */
                  <>
                    <div className="p-8 text-center">
                      <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <span className="material-symbols-outlined text-red-600 text-2xl">block</span>
                      </div>
                      <h3 className="text-lg font-black text-red-600 tracking-tight mb-2">Delete Blocked</h3>
                      <p className="text-sm text-slate-500 mb-4">
                        &quot;{addon?.name}&quot; cannot be deleted while these dependencies exist. Clear them in the Plans &amp; Features Matrix and tenant overrides — or Archive the add-on instead to preserve history.
                      </p>
                      <div className="text-left bg-red-50 border border-red-100 rounded-2xl p-4 space-y-2.5">
                        {blockers.inPlanFeatureNames.length > 0 && (
                          <div>
                            <p className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1">Linked feature included by plan</p>
                            <ul className="text-xs text-slate-700 font-bold space-y-0.5 list-disc list-inside">
                              {blockers.inPlanFeatureNames.map((n, i) => (<li key={i}>{n}</li>))}
                            </ul>
                          </div>
                        )}
                        {blockers.compatiblePlanNames.length > 0 && (
                          <div>
                            <p className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1">Compatible plans assigned</p>
                            <p className="text-xs text-slate-700 font-bold">{blockers.compatiblePlanNames.join(', ')}</p>
                          </div>
                        )}
                        {(blockers.activeTrials > 0 || blockers.activePaidOverrides > 0 || blockers.pendingPayments > 0) && (
                          <div>
                            <p className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1">Tenant entitlements active</p>
                            <ul className="text-xs text-slate-700 font-bold space-y-0.5 list-disc list-inside">
                              {blockers.activeTrials > 0 && <li>{blockers.activeTrials} active trial{blockers.activeTrials === 1 ? '' : 's'}</li>}
                              {blockers.activePaidOverrides > 0 && <li>{blockers.activePaidOverrides} active paid override{blockers.activePaidOverrides === 1 ? '' : 's'}</li>}
                              {blockers.pendingPayments > 0 && <li>{blockers.pendingPayments} pending payment{blockers.pendingPayments === 1 ? '' : 's'}</li>}
                            </ul>
                          </div>
                        )}
                        {blockers.openInvoiceIds.length > 0 && (
                          <div>
                            <p className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1">Open / overdue invoices</p>
                            <p className="text-xs text-slate-700 font-bold">{blockers.openInvoiceIds.join(', ')}</p>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="p-8 pt-0">
                      <button onClick={closeAndReset} className="w-full py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Got it</button>
                    </div>
                  </>
                ) : (
                  /* CONFIRM VARIANT — no dependencies. Modal explains
                     what will be removed and what will be preserved
                     based on whether the add-on owns its own
                     standalone capability row (`cap_<addonId>`) or
                     is linked to a pre-existing feature row. */
                  <>
                    <div className="p-8 text-center">
                      <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <span className="material-symbols-outlined text-red-600 text-2xl">delete_forever</span>
                      </div>
                      <h3 className="text-lg font-black text-primary tracking-tight mb-2">Delete Add-on?</h3>
                      <p className="text-sm text-slate-500 mb-4">
                        Permanently remove &quot;{addon?.name}&quot;. This action cannot be undone.
                      </p>
                      <div className="text-left bg-slate-50 border border-slate-100 rounded-2xl p-4 space-y-3">
                        <div>
                          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Will be removed</p>
                          <ul className="text-xs text-slate-700 font-bold space-y-0.5 list-disc list-inside">
                            <li>Add-on Catalog record</li>
                            {cls.isStandaloneCap && cls.linkedFeatureName && (
                              <li>Generated capability row &quot;{cls.linkedFeatureName}&quot; in Plans &amp; Features Matrix</li>
                            )}
                          </ul>
                        </div>
                        {!cls.isStandaloneCap && cls.linkedFeatureName && (
                          <div>
                            <p className="text-[10px] font-black text-emerald-700 uppercase tracking-widest mb-1">Will be preserved</p>
                            <ul className="text-xs text-slate-700 font-bold space-y-0.5 list-disc list-inside">
                              <li>Linked feature row &quot;{cls.linkedFeatureName}&quot; (independent feature, may be used by plans/permissions)</li>
                            </ul>
                          </div>
                        )}
                        <p className="text-[10px] text-slate-500 font-medium leading-snug">
                          To preserve history (billing/audit) instead of deleting, use Archive in the catalog card menu.
                        </p>
                      </div>
                    </div>
                    <div className="p-8 pt-0 flex gap-3">
                      <button onClick={closeAndReset} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button onClick={() => removeAddOn(showAddOnDelete)} className="flex-1 py-3.5 bg-red-500 text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-red-600 transition-all shadow-lg shadow-red-500/20">
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {showAddOnModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowAddOnModal(false)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-5xl max-h-[94vh] flex flex-col overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center shrink-0">
                <div>
                  <h3 className="text-xl font-black text-primary tracking-tight">{editingAddOn ? 'Edit Add-on' : 'Create Add-on'}</h3>
                  <p className="text-sm text-slate-500 mt-1">Define add-on details, lifecycle, plan compatibility, and runtime readiness.</p>
                </div>
                <button onClick={() => setShowAddOnModal(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="p-10 space-y-7 overflow-y-auto">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Add-on Name</label>
                  <input value={addOnForm.name} onChange={e => setAddOnForm(p => ({ ...p, name: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="e.g., Premium Support" />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Default Price (USD)</label>
                    <input type="number" value={addOnForm.price} onChange={e => setAddOnForm(p => ({ ...p, price: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="25" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Billing Cadence</label>
                    <select value={addOnForm.billingCadence} onChange={e => setAddOnForm(p => ({ ...p, billingCadence: e.target.value as 'monthly' | 'annual' | 'one_time' }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                      <option value="one_time">One-time</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Lifecycle (PM)</label>
                    <select value={addOnForm.lifecycle} onChange={e => setAddOnForm(p => ({ ...p, lifecycle: e.target.value as AddOnLifecycle }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                      {ADDON_LIFECYCLE_ORDER.map(lc => (
                        <option key={lc} value={lc}>{lc === 'in_development' ? 'In Development' : lc.charAt(0).toUpperCase() + lc.slice(1).replace('_', ' ')}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Governance Status</label>
                    <select value={addOnForm.governanceStatus} onChange={e => setAddOnForm(p => ({ ...p, governanceStatus: e.target.value as AddOnGovernanceStatus }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                      <option value="active">Active — offerable</option>
                      <option value="disabled">Disabled — paused</option>
                      <option value="archived">Archived — hidden</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
                      Linked Feature <span className="text-slate-400 font-medium normal-case tracking-normal">(optional)</span>
                    </label>
                    {showInlineNewFeature ? (
                      <div className="flex gap-2">
                        <input
                          autoFocus
                          value={inlineNewFeatureName}
                          onChange={e => setInlineNewFeatureName(e.target.value)}
                          placeholder="New feature name…"
                          className="flex-1 px-3 py-3 bg-indigo-50 border border-indigo-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-300/40 focus:border-indigo-400"
                        />
                        <button
                          type="button"
                          disabled={!inlineNewFeatureName.trim()}
                          onClick={() => registerInlineFeature()}
                          className="px-3 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-black text-[10px] rounded-xl uppercase tracking-widest transition-all"
                        >Register</button>
                        <button
                          type="button"
                          onClick={() => { setShowInlineNewFeature(false); setInlineNewFeatureName(''); }}
                          className="px-3 py-3 bg-slate-100 hover:bg-slate-200 text-slate-500 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all"
                        >Cancel</button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <select value={addOnForm.linkedFeatureId} onChange={e => setAddOnForm(p => ({ ...p, linkedFeatureId: e.target.value }))} className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                          <option value="">— none (standalone capability) —</option>
                          {featuresData.filter(f => f.lifecycle === 'implemented').map(f => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setShowInlineNewFeature(true)}
                          title="Register a new feature in the Plans & Features Matrix"
                          className="px-3 py-3 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all whitespace-nowrap"
                        >+ New</button>
                      </div>
                    )}
                    {!addOnForm.linkedFeatureId && !showInlineNewFeature && (
                      <p className="text-[9px] text-slate-500 font-medium mt-1.5 leading-snug">Optional. If left blank, a standalone capability row will be auto-registered in the Plans &amp; Features Matrix when you save.</p>
                    )}
                    {/* Add-on Runtime Linkage helper. Linked Feature is the
                        capability key the add-on controls entitlement for.
                        It does not create new app functionality on its own
                        — runtime behavior only kicks in if the linked
                        capability is wired into plan gating, permission
                        gating, or UI visibility. See replit.md →
                        "Add-on Runtime Linkage & Delete/Archive Matrix
                        Behavior". */}
                    {!showInlineNewFeature && (
                      <p className="text-[9px] text-slate-400 font-medium mt-1.5 leading-snug">
                        Linked Feature controls which capability this add-on grants. It does not create new app functionality by itself. Link to the smallest specific capability or sub-feature this add-on should control.
                      </p>
                    )}
                    {/* Parent-feature warning. When the System Owner picks a
                        broad / module-level feature (PARENT_FEATURE_IDS),
                        warn that the add-on will gate the whole module and
                        suggest specific sub-feature ids from
                        SUB_FEATURE_HINTS that exist in featuresData. The
                        warning is informational only — it does not block
                        the save. */}
                    {!showInlineNewFeature && addOnForm.linkedFeatureId && PARENT_FEATURE_IDS.has(addOnForm.linkedFeatureId) && (() => {
                      const subIds = (SUB_FEATURE_HINTS[addOnForm.linkedFeatureId] || [])
                        .filter(sid => featuresData.some(f => f.id === sid && f.lifecycle === 'implemented'));
                      return (
                        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5">
                          <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-1 flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">warning</span>
                            Parent feature selected
                          </p>
                          <p className="text-[10px] text-amber-700 font-medium leading-snug">
                            This is a parent feature. The add-on may control the entire feature unless a more specific sub-feature/capability is selected.
                          </p>
                          {subIds.length > 0 && (
                            <div className="mt-2">
                              <p className="text-[9px] font-black text-amber-600 uppercase tracking-widest mb-1">Suggested sub-features</p>
                              <div className="flex gap-1 flex-wrap">
                                {subIds.map(sid => {
                                  const f = featuresData.find(x => x.id === sid);
                                  if (!f) return null;
                                  return (
                                    <button
                                      key={sid}
                                      type="button"
                                      onClick={() => setAddOnForm(p => ({ ...p, linkedFeatureId: sid }))}
                                      className="px-2 py-1 bg-white hover:bg-amber-100 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-lg border border-amber-200 transition-colors"
                                    >{f.name}</button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Description</label>
                  <textarea value={addOnForm.description} onChange={e => setAddOnForm(p => ({ ...p, description: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none" rows={3} placeholder="What this add-on provides..." />
                </div>
                {/* Implementation Readiness section. Lets the System Owner
                    declare whether this add-on is wired into runtime
                    behavior, edit the runtime backing checklist, set the
                    runtime UI surface, optionally allow manual / presale
                    tenant grants for placeholders, acknowledge a parent
                    feature link, and generate a copyable Implementation
                    Brief for non-runtime-backed add-ons. See replit.md
                    → "Add-on Implementation Readiness". */}
                {(() => {
                  const previewAddon: AddOnData = {
                    id: editingAddOn?.id || 'preview',
                    name: addOnForm.name || 'New add-on',
                    price: Number(addOnForm.price) || 0,
                    description: addOnForm.description,
                    compatiblePlans: addOnForm.compatiblePlans,
                    status: addOnForm.governanceStatus === 'archived' ? 'archived' : 'active',
                    lifecycle: addOnForm.lifecycle,
                    governanceStatus: addOnForm.governanceStatus,
                    billingCadence: addOnForm.billingCadence,
                    linkedFeatureId: addOnForm.linkedFeatureId || undefined,
                    readinessStatus: addOnForm.readinessStatus,
                    runtimeChecklist: addOnForm.runtimeChecklist,
                    runtimeSurface: addOnForm.runtimeSurface || undefined,
                    allowManualPresaleGrant: addOnForm.allowManualPresaleGrant,
                    parentLinkAcknowledged: addOnForm.parentLinkAcknowledged,
                    createdAt: editingAddOn?.createdAt || '',
                    createdBy: editingAddOn?.createdBy || '',
                    updatedAt: editingAddOn?.updatedAt || '',
                  };
                  const suggested = deriveSuggestedReadiness(previewAddon);
                  const current = addOnForm.readinessStatus;
                  const isParentLink = !!addOnForm.linkedFeatureId && PARENT_FEATURE_IDS.has(addOnForm.linkedFeatureId);
                  const linkedFeatureName = addOnForm.linkedFeatureId
                    ? (featuresData.find(f => f.id === addOnForm.linkedFeatureId)?.name || null)
                    : null;
                  return (
                    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5 space-y-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h4 className="text-[11px] font-black text-indigo-700 uppercase tracking-widest flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-sm">verified</span>
                            Implementation Readiness
                          </h4>
                          <p className="text-[10px] text-slate-500 font-medium mt-1 leading-snug">Declare whether this add-on is connected to real runtime behavior. Used to gate tenant Trial / Paid Override grants.</p>
                        </div>
                        <span className={`shrink-0 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md border ${READINESS_BADGE_STYLES[current]}`}>
                          {READINESS_LABELS[current]}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Readiness Status</label>
                          <select
                            value={current}
                            onChange={e => setAddOnForm(p => ({ ...p, readinessStatus: e.target.value as AddOnReadinessStatus }))}
                            className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                          >
                            {(['runtime_backed','partially_backed','parent_feature_linked','implementation_required','commercial_placeholder'] as AddOnReadinessStatus[]).map(s => (
                              <option key={s} value={s}>{READINESS_LABELS[s]}</option>
                            ))}
                          </select>
                          <p className="text-[9px] text-slate-500 font-medium mt-1.5 leading-snug">{READINESS_DESCRIPTIONS[current]}</p>
                          {suggested !== current && (
                            <button
                              type="button"
                              onClick={() => setAddOnForm(p => ({ ...p, readinessStatus: suggested }))}
                              className="mt-2 px-2.5 py-1 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 font-black text-[9px] rounded-lg uppercase tracking-widest transition-all inline-flex items-center gap-1"
                              title={`Suggested: ${READINESS_LABELS[suggested]}`}
                            >
                              <span className="material-symbols-outlined text-[12px] leading-none">auto_awesome</span>
                              Use suggested: {READINESS_LABELS[suggested]}
                            </button>
                          )}
                        </div>
                        <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Runtime Surface <span className="text-slate-400 font-medium normal-case tracking-normal">(route or tab)</span></label>
                          <input
                            value={addOnForm.runtimeSurface}
                            onChange={e => setAddOnForm(p => ({ ...p, runtimeSurface: e.target.value }))}
                            placeholder="e.g., /tenant/inventory/labels"
                            className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                          />
                          <p className="text-[9px] text-slate-500 font-medium mt-1.5 leading-snug">Where the capability becomes visible to a tenant. Used in the Implementation Brief.</p>
                        </div>
                      </div>

                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Runtime Backing Checklist</label>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {(Object.keys(addOnForm.runtimeChecklist) as RuntimeChecklistKey[]).map(k => (
                            <div key={k} className="flex items-center gap-2 bg-white rounded-xl border border-slate-200 px-3 py-2">
                              <span className="flex-1 text-[10px] font-bold text-slate-600 leading-snug">{RUNTIME_CHECKLIST_LABELS[k]}</span>
                              <select
                                value={addOnForm.runtimeChecklist[k]}
                                onChange={e => setAddOnForm(p => ({
                                  ...p,
                                  runtimeChecklist: { ...p.runtimeChecklist, [k]: e.target.value as RuntimeChecklistState },
                                }))}
                                className={`text-[10px] font-black uppercase tracking-widest rounded-lg px-2 py-1 border focus:outline-none focus:ring-2 focus:ring-primary/20 ${
                                  addOnForm.runtimeChecklist[k] === 'complete' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                                  addOnForm.runtimeChecklist[k] === 'missing' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                                  addOnForm.runtimeChecklist[k] === 'not_required' ? 'bg-slate-50 text-slate-500 border-slate-200' :
                                  'bg-amber-50 text-amber-700 border-amber-200'
                                }`}
                              >
                                <option value="complete">Complete</option>
                                <option value="missing">Missing</option>
                                <option value="not_required">N/A</option>
                                <option value="unknown">Unknown</option>
                              </select>
                            </div>
                          ))}
                        </div>
                      </div>

                      {(current === 'implementation_required' || current === 'commercial_placeholder') && (
                        <label className="flex items-start gap-2 bg-white rounded-xl border border-amber-200 p-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={addOnForm.allowManualPresaleGrant}
                            onChange={e => setAddOnForm(p => ({ ...p, allowManualPresaleGrant: e.target.checked }))}
                            className="mt-0.5 w-4 h-4 accent-amber-500"
                          />
                          <div>
                            <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest">Allow manual / presale tenant grant</p>
                            <p className="text-[9px] text-slate-500 font-medium mt-0.5 leading-snug">By default, placeholders block tenant Trial / Paid Override. Tick this to allow manual grants for early-access or pre-sale customers (audit-tracked).</p>
                          </div>
                        </label>
                      )}

                      {isParentLink && (
                        <label className="flex items-start gap-2 bg-white rounded-xl border border-orange-200 p-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={addOnForm.parentLinkAcknowledged}
                            onChange={e => setAddOnForm(p => ({ ...p, parentLinkAcknowledged: e.target.checked }))}
                            className="mt-0.5 w-4 h-4 accent-orange-500"
                          />
                          <div>
                            <p className="text-[10px] font-black text-orange-700 uppercase tracking-widest">Acknowledge parent feature link</p>
                            <p className="text-[9px] text-slate-500 font-medium mt-0.5 leading-snug">Confirm the broad-module link is intentional. The catalog will still warn other System Owners on Tenant grant screens.</p>
                          </div>
                        </label>
                      )}

                      {(current === 'implementation_required' || current === 'commercial_placeholder' || current === 'partially_backed' || current === 'parent_feature_linked') && (
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-white rounded-xl border border-slate-200 p-3">
                          <div className="flex-1 min-w-[200px]">
                            <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest">Implementation Brief</p>
                            <p className="text-[9px] text-slate-500 font-medium mt-0.5 leading-snug">Generates a copyable spec for what's needed to make this add-on runtime-backed. Paste into your build prompt.</p>
                          </div>
                          <button
                            type="button"
                            disabled={!editingAddOn || !canGenBrief}
                            onClick={() => editingAddOn && canGenBrief && openBriefModal(editingAddOn.id)}
                            title={!canGenBrief ? 'No permission to generate brief' : editingAddOn ? 'Generate brief' : 'Save the add-on first to generate a brief'}
                            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-black text-[10px] rounded-xl uppercase tracking-widest transition-all inline-flex items-center gap-1.5"
                          >
                            <span className="material-symbols-outlined text-[14px] leading-none">description</span>
                            Generate Brief
                          </button>
                        </div>
                      )}
                      {linkedFeatureName && (
                        <p className="text-[9px] text-slate-400 font-medium leading-snug">Linked capability: <span className="font-black text-slate-600">{linkedFeatureName}</span> ({addOnForm.linkedFeatureId})</p>
                      )}
                    </div>
                  );
                })()}
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Compatible Plans</label>
                  {addOnForm.governanceStatus === 'active' ? (
                    <>
                      <div className="flex gap-2 flex-wrap">
                        {plansData.filter(p => p.status === 'active').map(plan => {
                          const locked = isPlanLockedForAddOn(plan.id);
                          const checked = locked || addOnForm.compatiblePlans.includes(plan.id);
                          return (
                            <button
                              key={plan.id}
                              onClick={() => toggleAddOnPlan(plan.id)}
                              disabled={locked}
                              title={locked ? 'Included by plan in the Plans & Features Matrix' : undefined}
                              className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl border transition-all flex items-center gap-1.5 ${
                                locked
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 cursor-not-allowed'
                                  : checked
                                    ? 'bg-primary text-white border-primary'
                                    : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                              }`}
                            >
                              {locked && <span className="material-symbols-outlined text-[12px] leading-none">lock</span>}
                              {plan.name}
                            </button>
                          );
                        })}
                      </div>
                      {addOnForm.linkedFeatureId && plansData.filter(p => p.status === 'active' && isPlanLockedForAddOn(p.id)).length > 0 && (
                        <p className="text-[10px] text-emerald-700 font-medium mt-2 leading-snug">
                          <span className="font-black uppercase tracking-widest">Locked plans</span> include the linked feature in the Plans &amp; Features Matrix. To change inclusion for those plans, edit the Plans &amp; Features Matrix.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-[10px] text-amber-600 font-bold bg-amber-50 p-3 rounded-xl border border-amber-100">Only &quot;Active&quot; add-ons can be assigned to plans. Change lifecycle to Active first.</p>
                  )}
                </div>
              </div>
              <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3 shrink-0">
                <button onClick={() => setShowAddOnModal(false)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button
                  onClick={saveAddOn}
                  disabled={!addOnForm.name || !addOnForm.price}
                  className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >{editingAddOn ? 'Save Changes' : 'Create Add-on'}</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddOnArchive && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => { setShowAddOnArchive(null); setAddOnArchiveBlockers(null); }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden"
            >
              {addOnArchiveBlockers ? (
                <>
                  <div className="p-8 text-center">
                    <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                      <span className="material-symbols-outlined text-red-600 text-2xl">block</span>
                    </div>
                    <h3 className="text-lg font-black text-red-600 tracking-tight mb-2">Archive Blocked</h3>
                    <p className="text-sm text-slate-500 mb-4">This add-on still has dependencies. Clear them in the Plans &amp; Features Matrix and tenant overrides before archiving.</p>
                    <div className="text-left bg-red-50 border border-red-100 rounded-2xl p-4 space-y-2.5">
                      {addOnArchiveBlockers.inPlanFeatureNames.length > 0 && (
                        <div>
                          <p className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1">Linked feature included by plan</p>
                          <ul className="text-xs text-slate-700 font-bold space-y-0.5 list-disc list-inside">
                            {addOnArchiveBlockers.inPlanFeatureNames.map((n, i) => (
                              <li key={i}>{n}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {addOnArchiveBlockers.compatiblePlanNames.length > 0 && (
                        <div>
                          <p className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1">Compatible plans assigned</p>
                          <p className="text-xs text-slate-700 font-bold">{addOnArchiveBlockers.compatiblePlanNames.join(', ')}</p>
                        </div>
                      )}
                      {(addOnArchiveBlockers.activeTrials > 0 || addOnArchiveBlockers.activePaidOverrides > 0 || addOnArchiveBlockers.pendingPayments > 0) && (
                        <div>
                          <p className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1">Tenant entitlements active</p>
                          <ul className="text-xs text-slate-700 font-bold space-y-0.5 list-disc list-inside">
                            {addOnArchiveBlockers.activeTrials > 0 && <li>{addOnArchiveBlockers.activeTrials} active trial{addOnArchiveBlockers.activeTrials === 1 ? '' : 's'}</li>}
                            {addOnArchiveBlockers.activePaidOverrides > 0 && <li>{addOnArchiveBlockers.activePaidOverrides} active paid override{addOnArchiveBlockers.activePaidOverrides === 1 ? '' : 's'}</li>}
                            {addOnArchiveBlockers.pendingPayments > 0 && <li>{addOnArchiveBlockers.pendingPayments} pending payment{addOnArchiveBlockers.pendingPayments === 1 ? '' : 's'}</li>}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="p-8 pt-0">
                    <button onClick={() => { setShowAddOnArchive(null); setAddOnArchiveBlockers(null); }} className="w-full py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Got it</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="p-8 text-center">
                    <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                      <span className="material-symbols-outlined text-slate-600 text-2xl">archive</span>
                    </div>
                    <h3 className="text-lg font-black text-primary tracking-tight mb-2">Archive Add-on?</h3>
                    <p className="text-sm text-slate-500">The add-on will be hidden from the catalog and no longer offerable. The record stays for audit history and can be reactivated later.</p>
                  </div>
                  <div className="p-8 pt-0 flex gap-3">
                    <button onClick={() => setShowAddOnArchive(null)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                    <button onClick={() => archiveAddOn(showAddOnArchive)} className="flex-1 py-3.5 bg-slate-700 text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg shadow-slate-500/20">Archive</button>
                  </div>
                </>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddOnDisableConfirm && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowAddOnDisableConfirm(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="p-8 text-center">
                <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <span className="material-symbols-outlined text-amber-600 text-2xl">pause_circle</span>
                </div>
                <h3 className="text-lg font-black text-primary tracking-tight mb-2">Disable Add-on?</h3>
                <p className="text-sm text-slate-500">The add-on stays in the catalog but is paused. Tenants cannot start a new trial or paid override; existing overrides for the linked feature stop enabling it until you reactivate.</p>
              </div>
              <div className="p-8 pt-0 flex gap-3">
                <button onClick={() => setShowAddOnDisableConfirm(null)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={() => setAddOnGovernance(showAddOnDisableConfirm, 'disabled')} className="flex-1 py-3.5 bg-amber-500 text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-amber-600 transition-all shadow-lg shadow-amber-500/20">Disable</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Implementation Brief Modal — shows the generated brief for the
          currently-edited add-on. Read-only textarea + Copy button. The
          brief generator is a pure function in src/owner/readiness.ts. */}
      <AnimatePresence>
        {briefModalAddOnId && (() => {
          const briefAddon = addOnsData.find(a => a.id === briefModalAddOnId);
          if (!briefAddon) return null;
          const linkedFeatureName = briefAddon.linkedFeatureId
            ? (featuresData.find(f => f.id === briefAddon.linkedFeatureId)?.name || null)
            : null;
          const briefText = generateImplementationBrief(briefAddon, linkedFeatureName);
          return (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setBriefModalAddOnId(null)}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                onClick={e => e.stopPropagation()}
                className="bg-white rounded-[3rem] shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
              >
                <div className="p-6 border-b border-slate-100 flex justify-between items-center shrink-0">
                  <div>
                    <h3 className="text-lg font-black text-primary tracking-tight">Implementation Brief — {briefAddon.name}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">Copy this brief and paste it into a build prompt to implement the missing runtime behavior.</p>
                  </div>
                  <button onClick={() => setBriefModalAddOnId(null)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                    <span className="material-symbols-outlined text-lg">close</span>
                  </button>
                </div>
                <div className="p-6 flex-1 overflow-y-auto">
                  <textarea
                    readOnly
                    value={briefText}
                    onFocus={e => e.currentTarget.select()}
                    className="w-full h-[55vh] px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl font-mono text-[11px] text-slate-700 leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
                  />
                </div>
                <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex items-center gap-3 shrink-0">
                  {briefCopyToast && (
                    <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      Copied to clipboard
                    </span>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => setBriefModalAddOnId(null)} className="px-5 py-3 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Close</button>
                  <button
                    onClick={() => copyBriefToClipboard(briefAddon, briefText)}
                    className="px-5 py-3 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all flex items-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-sm">content_copy</span>
                    Copy Brief
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {showCommercialAudit && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowCommercialAudit(false)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col"
              style={{ maxHeight: '85vh' }}
            >
              <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                <div>
                  <h3 className="text-lg font-black text-primary tracking-tight">Commercial Audit Log</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Most recent governance and override events. Mirrored into the platform audit feed.</p>
                </div>
                <button onClick={() => setShowCommercialAudit(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="overflow-y-auto p-4 flex-1">
                {recentAudit.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-8">No commercial events yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {recentAudit.map(e => (
                      <li key={e.id} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[10px] font-black uppercase tracking-widest text-primary">{e.action.replace(/_/g, ' ')}</span>
                          <span className="text-[10px] font-bold text-slate-400">{e.timestamp.slice(0, 19).replace('T', ' ')}</span>
                        </div>
                        <div className="text-xs text-slate-600 font-bold mt-1 flex flex-wrap gap-x-3 gap-y-1">
                          <span>by {e.actor}</span>
                          {e.addOnId && <span>add-on: {e.addOnId}</span>}
                          {e.tenantId && <span>tenant: {e.tenantId}</span>}
                          {e.featureId && <span>feature: {e.featureId}</span>}
                          {(e.oldValue !== null && e.oldValue !== undefined) && <span>{String(e.oldValue)} → {String(e.newValue ?? '')}</span>}
                          {(e.oldValue === null || e.oldValue === undefined) && (e.newValue !== null && e.newValue !== undefined) && <span>{String(e.newValue)}</span>}
                        </div>
                        {e.note && <p className="text-[11px] text-slate-500 italic mt-1">{e.note}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PlansPage;
