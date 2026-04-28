import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { plans as initialPlans, featureMatrix as initialFeatures, addOns as initialAddOns } from './mockData';
import type { FeatureLifecycle, AddOnLifecycle, AddOn, AddOnGovernanceStatus } from './mockData';
import { pushCommercialAudit, getCommercialAuditLog } from './commercialAudit';

type PlanData = Omit<typeof initialPlans[0], 'status'> & { status: 'active' | 'archived' };
type FeatureData = { id: string; name: string; planAvailability: Record<string, boolean>; source: 'inherited' | 'custom'; lifecycle: FeatureLifecycle };
type AddOnData = AddOn;

const LIFECYCLE_ORDER: FeatureLifecycle[] = ['draft', 'planned', 'in_development', 'implemented', 'deprecated', 'archived'];
const ADDON_LIFECYCLE_ORDER: AddOnLifecycle[] = ['draft', 'planned', 'in_development', 'active', 'deprecated', 'archived'];

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
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const initialTab = tabFromUrl === 'features' ? 'features' : tabFromUrl === 'addons' ? 'addons' : 'plans';
  const [activeTab, setActiveTab] = useState<'plans' | 'features' | 'addons'>(initialTab);

  useEffect(() => {
    if (tabFromUrl === 'features' || tabFromUrl === 'addons' || tabFromUrl === 'plans') {
      setActiveTab(tabFromUrl as 'plans' | 'features' | 'addons');
    }
  }, [tabFromUrl]);

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
    try { const saved = sessionStorage.getItem('addons_data'); return saved ? JSON.parse(saved) : [...initialAddOns]; } catch { return [...initialAddOns]; }
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
  });
  const [showArchivedAddOns, setShowArchivedAddOns] = useState(false);
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
    setPlansData(prev => prev.map(p => p.id === planId ? { ...p, status: 'archived' as const } : p));
    setShowArchiveConfirm(null);
  };

  const restorePlan = (planId: string) => {
    setPlansData(prev => prev.map(p => p.id === planId ? { ...p, status: 'active' as const } : p));
  };

  const activePlans = plansData.filter(p => p.status === 'active');

  const toggleFeature = (featureId: string, planId: string) => {
    const feature = featuresData.find(f => f.id === featureId);
    if (!feature || feature.lifecycle !== 'implemented') return;
    setFeaturesData(prev => prev.map(f => f.id === featureId ? { ...f, planAvailability: { ...f.planAvailability, [planId]: !f.planAvailability[planId] } } : f));
  };

  const changeLifecycle = (featureId: string, newLifecycle: FeatureLifecycle) => {
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
    setFeaturesData(prev => prev.filter(f => f.id !== featureId));
    setShowDeleteConfirm(null);
  };

  const getAddOnDependencies = (addonId: string) => {
    const addon = addOnsData.find(a => a.id === addonId);
    if (!addon) return [];
    return activePlans.filter(p => addon.compatiblePlans.includes(p.id));
  };

  const removeAddOn = (addonId: string) => {
    setAddOnsData(prev => prev.filter(a => a.id !== addonId));
    setShowAddOnDelete(null);
  };

  const openCreateAddOn = () => {
    setAddOnForm({
      name: '',
      price: '',
      description: '',
      compatiblePlans: [],
      lifecycle: 'active',
      governanceStatus: 'active',
      billingCadence: 'monthly',
      linkedFeatureId: '',
    });
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
    });
    setEditingAddOn(addon);
    setShowAddOnModal(true);
  };

  const saveAddOn = () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const isCreate = !editingAddOn;
    const id = editingAddOn?.id || addOnForm.name.toLowerCase().replace(/\s+/g, '-');
    const oldAddOn = editingAddOn;
    const newAddOn: AddOnData = {
      id,
      name: addOnForm.name,
      price: Number(addOnForm.price),
      description: addOnForm.description,
      compatiblePlans: addOnForm.lifecycle === 'active' ? addOnForm.compatiblePlans : [],
      status: addOnForm.governanceStatus === 'archived' ? 'archived' : 'active',
      lifecycle: addOnForm.lifecycle,
      governanceStatus: addOnForm.governanceStatus,
      billingCadence: addOnForm.billingCadence,
      linkedFeatureId: addOnForm.linkedFeatureId || null,
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
        newValue: newAddOn.price,
        note: `${newAddOn.name} (${newAddOn.governanceStatus}, ${newAddOn.billingCadence})`,
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

  const setAddOnGovernance = (addonId: string, next: AddOnGovernanceStatus) => {
    const todayIso = new Date().toISOString().slice(0, 10);
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
        // Mirror legacy `lifecycle` so the rest of the page stays in sync.
        lifecycle: next === 'archived'
          ? 'archived'
          : (a.lifecycle === 'archived' ? 'active' : a.lifecycle),
        updatedAt: todayIso,
        updatedBy: 'System Owner',
      };
    }));
    setShowAddOnArchive(null);
    setShowAddOnDisableConfirm(null);
    setAuditTick(t => t + 1);
  };

  const archiveAddOn = (addonId: string) => setAddOnGovernance(addonId, 'archived');
  const restoreAddOn = (addonId: string) => setAddOnGovernance(addonId, 'active');

  const toggleAddOnPlan = (plan: string) => {
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
    { id: 'addons' as const, label: 'Add-ons', icon: 'extension' },
  ];

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Plans & Features</h2>
          <p className="text-slate-500 font-medium">Manage subscription plans, feature access, and add-ons.</p>
        </div>
        {activeTab === 'plans' && (
          <button onClick={openCreatePlan} className="px-5 py-3 bg-primary text-white font-black text-[10px] rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
            <span className="material-symbols-outlined text-sm">add</span>
            Create New Plan
          </button>
        )}
        {activeTab === 'features' && (
          <button onClick={() => setShowFeatureModal(true)} className="px-5 py-3 bg-primary text-white font-black text-[10px] rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
            <span className="material-symbols-outlined text-sm">add</span>
            Add Feature
          </button>
        )}
        {activeTab === 'addons' && (
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
                <button onClick={() => openEditPlan(plan)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                  Edit
                </button>
                {plan.status === 'archived' ? (
                  <button onClick={() => restorePlan(plan.id)} className="flex-1 py-3 bg-lime-100 hover:bg-lime-200 text-lime-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                    Restore
                  </button>
                ) : (
                  <button onClick={() => setShowArchiveConfirm(plan.id)} className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                    Archive
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {activeTab === 'features' && (
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
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
                {featuresData.map((feature) => {
                  const isAssignable = feature.lifecycle === 'implemented';
                  return (
                    <tr key={feature.id} className={`hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 ${feature.lifecycle === 'archived' || feature.lifecycle === 'deprecated' ? 'opacity-60' : ''}`}>
                      <td className="px-8 py-4">
                        <span className="font-bold text-slate-900">{feature.name}</span>
                        <span className={`ml-2 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md border ${
                          feature.source === 'inherited'
                            ? 'bg-blue-400/10 text-blue-600 border-blue-400/20'
                            : 'bg-violet-400/10 text-violet-600 border-violet-400/20'
                        }`}>{feature.source}</span>
                      </td>
                      <td className="px-4 py-4">
                        <select
                          value={feature.lifecycle}
                          onChange={e => changeLifecycle(feature.id, e.target.value as FeatureLifecycle)}
                          className="text-[9px] font-black uppercase tracking-widest bg-transparent border border-slate-200 rounded-lg px-2 py-1.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/20"
                        >
                          {LIFECYCLE_ORDER.map(lc => (
                            <option key={lc} value={lc}>{lc === 'in_development' ? 'In Dev' : lc.charAt(0).toUpperCase() + lc.slice(1)}</option>
                          ))}
                        </select>
                      </td>
                      {activePlans.map(plan => (
                        <td key={plan.id} className="px-6 py-4 text-center">
                          {isAssignable ? (
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
                          ) : (
                            <span className="material-symbols-outlined text-slate-200 text-sm" title="Only implemented features can be assigned">lock</span>
                          )}
                        </td>
                      ))}
                      <td className="px-8 py-4 text-center">
                        {feature.source === 'custom' ? (
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

      {activeTab === 'addons' && (
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
                const linkedFeatureName = addon.linkedFeatureId ? (featuresData.find(f => f.id === addon.linkedFeatureId)?.name || addon.linkedFeatureId) : null;
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
                        disabled={addon.governanceStatus === 'active'}
                        className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-xl transition-all ${
                          addon.governanceStatus === 'active'
                            ? 'bg-lime-500 text-white shadow-sm cursor-default'
                            : 'bg-lime-100 hover:bg-lime-200 text-lime-700'
                        }`}
                      >Active</button>
                      <button
                        onClick={() => addon.governanceStatus === 'disabled' ? undefined : setShowAddOnDisableConfirm(addon.id)}
                        disabled={addon.governanceStatus === 'disabled'}
                        className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-xl transition-all ${
                          addon.governanceStatus === 'disabled'
                            ? 'bg-amber-500 text-white shadow-sm cursor-default'
                            : 'bg-amber-100 hover:bg-amber-200 text-amber-700'
                        }`}
                      >Disabled</button>
                      <button
                        onClick={() => addon.governanceStatus === 'archived' ? undefined : setShowAddOnArchive(addon.id)}
                        disabled={addon.governanceStatus === 'archived'}
                        className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-xl transition-all ${
                          addon.governanceStatus === 'archived'
                            ? 'bg-slate-500 text-white shadow-sm cursor-default'
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
                      <button onClick={() => openEditAddOn(addon)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                        Edit
                      </button>
                      <button onClick={() => setShowAddOnDelete(addon.id)} className="py-3 px-4 bg-red-50 hover:bg-red-100 text-red-500 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                        <span className="material-symbols-outlined text-sm">delete</span>
                      </button>
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
          const deps = addon ? getAddOnDependencies(showAddOnDelete) : [];
          return (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowAddOnDelete(null)}>
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
                  <h3 className="text-lg font-black text-primary tracking-tight mb-2">Delete Add-on?</h3>
                  <p className="text-sm text-slate-500 mb-3">
                    Permanently remove &quot;{addon?.name}&quot;. This action cannot be undone.
                  </p>
                  {deps.length > 0 && (
                    <div className="bg-amber-50 rounded-xl border border-amber-200 p-3 text-left">
                      <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2 flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">warning</span>
                        Used by {deps.length} plan{deps.length !== 1 ? 's' : ''}
                      </p>
                      <div className="flex gap-1.5 flex-wrap">
                        {deps.map(p => (
                          <span key={p.id} className="px-2 py-0.5 bg-amber-100 text-amber-800 text-[9px] font-black uppercase tracking-widest rounded-md">{p.name}</span>
                        ))}
                      </div>
                      <p className="text-[10px] text-amber-600 font-bold mt-2">Remove this add-on from all plans before deleting.</p>
                    </div>
                  )}
                </div>
                <div className="p-8 pt-0 flex gap-3">
                  <button onClick={() => setShowAddOnDelete(null)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                  <button onClick={() => removeAddOn(showAddOnDelete)} disabled={deps.length > 0} className="flex-1 py-3.5 bg-red-500 text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-red-600 transition-all shadow-lg shadow-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed">
                    {deps.length > 0 ? 'Remove from Plans First' : 'Delete'}
                  </button>
                </div>
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
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center">
                <div>
                  <h3 className="text-xl font-black text-primary tracking-tight">{editingAddOn ? 'Edit Add-on' : 'Create Add-on'}</h3>
                  <p className="text-sm text-slate-500 mt-1">Define add-on details, lifecycle, and plan compatibility.</p>
                </div>
                <button onClick={() => setShowAddOnModal(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="p-8 space-y-5">
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
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Linked Feature (optional)</label>
                    <select value={addOnForm.linkedFeatureId} onChange={e => setAddOnForm(p => ({ ...p, linkedFeatureId: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                      <option value="">— none —</option>
                      {featuresData.filter(f => f.lifecycle === 'implemented').map(f => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Description</label>
                  <textarea value={addOnForm.description} onChange={e => setAddOnForm(p => ({ ...p, description: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none" rows={3} placeholder="What this add-on provides..." />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Compatible Plans</label>
                  {addOnForm.lifecycle === 'active' ? (
                    <div className="flex gap-2 flex-wrap">
                      {plansData.filter(p => p.status === 'active').map(plan => (
                        <button
                          key={plan.id}
                          onClick={() => toggleAddOnPlan(plan.id)}
                          className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl border transition-all ${
                            addOnForm.compatiblePlans.includes(plan.id)
                              ? 'bg-primary text-white border-primary'
                              : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                          }`}
                        >{plan.name}</button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] text-amber-600 font-bold bg-amber-50 p-3 rounded-xl border border-amber-100">Only &quot;Active&quot; add-ons can be assigned to plans. Change lifecycle to Active first.</p>
                  )}
                </div>
              </div>
              <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button onClick={() => setShowAddOnModal(false)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={saveAddOn} disabled={!addOnForm.name || !addOnForm.price} className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed">{editingAddOn ? 'Save Changes' : 'Create Add-on'}</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddOnArchive && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setShowAddOnArchive(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="p-8 text-center">
                <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <span className="material-symbols-outlined text-slate-600 text-2xl">archive</span>
                </div>
                <h3 className="text-lg font-black text-primary tracking-tight mb-2">Archive Add-on?</h3>
                <p className="text-sm text-slate-500">The add-on will be hidden from the catalog and no longer offerable. Existing tenant overrides for the linked feature stop enabling it. The record stays for audit history and can be reactivated.</p>
              </div>
              <div className="p-8 pt-0 flex gap-3">
                <button onClick={() => setShowAddOnArchive(null)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={() => archiveAddOn(showAddOnArchive)} className="flex-1 py-3.5 bg-slate-700 text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg shadow-slate-500/20">Archive</button>
              </div>
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
