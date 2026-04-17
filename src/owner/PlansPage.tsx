import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { plans as initialPlans, featureMatrix as initialFeatures, addOns as initialAddOns } from './mockData';
import type { FeatureLifecycle, AddOnLifecycle } from './mockData';

type PlanData = Omit<typeof initialPlans[0], 'status'> & { status: 'active' | 'archived' };
type FeatureData = { id: string; name: string; planAvailability: Record<string, boolean>; source: 'inherited' | 'custom'; lifecycle: FeatureLifecycle };
type AddOnData = Omit<typeof initialAddOns[0], 'status'> & { status: 'active' | 'archived' };

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
  const [addOnForm, setAddOnForm] = useState({ name: '', price: '', description: '', compatiblePlans: [] as string[], lifecycle: 'active' as AddOnLifecycle });
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

  const changeAddOnLifecycle = (addonId: string, newLifecycle: AddOnLifecycle) => {
    setAddOnsData(prev => prev.map(a => {
      if (a.id !== addonId) return a;
      if (newLifecycle !== 'active') {
        return { ...a, lifecycle: newLifecycle, compatiblePlans: [] };
      }
      return { ...a, lifecycle: newLifecycle };
    }));
  };

  const removeAddOn = (addonId: string) => {
    setAddOnsData(prev => prev.filter(a => a.id !== addonId));
    setShowAddOnDelete(null);
  };

  const openCreateAddOn = () => {
    setAddOnForm({ name: '', price: '', description: '', compatiblePlans: [], lifecycle: 'active' });
    setEditingAddOn(null);
    setShowAddOnModal(true);
  };

  const openEditAddOn = (addon: AddOnData) => {
    setAddOnForm({ name: addon.name, price: String(addon.price), description: addon.description, compatiblePlans: [...addon.compatiblePlans], lifecycle: addon.lifecycle });
    setEditingAddOn(addon);
    setShowAddOnModal(true);
  };

  const saveAddOn = () => {
    const newAddOn: AddOnData = {
      id: editingAddOn?.id || addOnForm.name.toLowerCase().replace(/\s+/g, '-'),
      name: addOnForm.name,
      price: Number(addOnForm.price),
      description: addOnForm.description,
      compatiblePlans: addOnForm.lifecycle === 'active' ? addOnForm.compatiblePlans : [],
      status: addOnForm.lifecycle === 'archived' ? 'archived' as const : 'active' as const,
      lifecycle: addOnForm.lifecycle,
    };
    if (editingAddOn) {
      setAddOnsData(prev => prev.map(a => a.id === editingAddOn.id ? newAddOn : a));
    } else {
      setAddOnsData(prev => [...prev, newAddOn]);
    }
    setShowAddOnModal(false);
    setEditingAddOn(null);
  };

  const archiveAddOn = (addonId: string) => {
    setAddOnsData(prev => prev.map(a => a.id === addonId ? { ...a, status: 'archived' as const, lifecycle: 'archived' as AddOnLifecycle } : a));
    setShowAddOnArchive(null);
  };

  const restoreAddOn = (addonId: string) => {
    setAddOnsData(prev => prev.map(a => a.id === addonId ? { ...a, status: 'active' as const, lifecycle: 'active' as AddOnLifecycle } : a));
  };

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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {addOnsData.map((addon) => {
            const deps = getAddOnDependencies(addon.id);
            const isActive = addon.lifecycle === 'active';
            return (
              <motion.div
                key={addon.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className={`bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border shadow-sm hover:shadow-md transition-all ${
                  addon.lifecycle === 'archived' ? 'border-slate-300 opacity-60' : addon.lifecycle === 'deprecated' ? 'border-red-200 opacity-75' : 'border-slate-200'
                }`}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-black text-primary tracking-tight">{addon.name}</h3>
                    {lifecycleBadge(addon.lifecycle)}
                  </div>
                  <span className="text-xl font-black text-primary">${addon.price}</span>
                </div>
                <p className="text-sm text-slate-500 mb-4 leading-relaxed">{addon.description}</p>

                <div className="mb-3">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Lifecycle</p>
                  <select
                    value={addon.lifecycle}
                    onChange={e => changeAddOnLifecycle(addon.id, e.target.value as AddOnLifecycle)}
                    className="text-[9px] font-black uppercase tracking-widest bg-transparent border border-slate-200 rounded-lg px-2 py-1.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/20 w-full"
                  >
                    {ADDON_LIFECYCLE_ORDER.map(lc => (
                      <option key={lc} value={lc}>{lc === 'in_development' ? 'In Development' : lc.charAt(0).toUpperCase() + lc.slice(1).replace('_', ' ')}</option>
                    ))}
                  </select>
                  {!isActive && addon.lifecycle !== 'archived' && (
                    <p className="text-[10px] text-amber-600 font-bold mt-1.5">Only &quot;Active&quot; add-ons can be assigned to plans.</p>
                  )}
                </div>

                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Compatible Plans</p>
                <div className="flex gap-2 flex-wrap mb-4">
                  {isActive && addon.compatiblePlans.length > 0 ? addon.compatiblePlans.map((planId, i) => {
                    const planObj = plansData.find(p => p.id === planId);
                    return (
                      <span key={i} className="px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">
                        {planObj?.name || planId}
                      </span>
                    );
                  }) : (
                    <span className="text-[10px] text-slate-300 font-bold">{isActive ? 'No plans assigned' : 'N/A — not active'}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => openEditAddOn(addon)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                    Edit
                  </button>
                  {addon.lifecycle === 'archived' ? (
                    <button onClick={() => restoreAddOn(addon.id)} className="flex-1 py-3 bg-lime-100 hover:bg-lime-200 text-lime-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                      Restore
                    </button>
                  ) : (
                    <button onClick={() => setShowAddOnArchive(addon.id)} className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                      Archive
                    </button>
                  )}
                  <button onClick={() => setShowAddOnDelete(addon.id)} className="py-3 px-4 bg-red-50 hover:bg-red-100 text-red-500 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                    <span className="material-symbols-outlined text-sm">delete</span>
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>
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
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Price (USD/mo)</label>
                    <input type="number" value={addOnForm.price} onChange={e => setAddOnForm(p => ({ ...p, price: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="25" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Lifecycle Status</label>
                    <select value={addOnForm.lifecycle} onChange={e => setAddOnForm(p => ({ ...p, lifecycle: e.target.value as AddOnLifecycle }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                      {ADDON_LIFECYCLE_ORDER.map(lc => (
                        <option key={lc} value={lc}>{lc === 'in_development' ? 'In Development' : lc.charAt(0).toUpperCase() + lc.slice(1).replace('_', ' ')}</option>
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
                <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <span className="material-symbols-outlined text-amber-600 text-2xl">archive</span>
                </div>
                <h3 className="text-lg font-black text-primary tracking-tight mb-2">Archive Add-on?</h3>
                <p className="text-sm text-slate-500">This add-on will be removed from availability. Existing subscribers will keep access until their next billing cycle.</p>
              </div>
              <div className="p-8 pt-0 flex gap-3">
                <button onClick={() => setShowAddOnArchive(null)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={() => archiveAddOn(showAddOnArchive)} className="flex-1 py-3.5 bg-amber-500 text-white font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-amber-600 transition-all shadow-lg shadow-amber-500/20">Archive</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PlansPage;
