import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { plans as initialPlans, featureMatrix as initialFeatures, addOns as initialAddOns } from './mockData';

type PlanData = typeof initialPlans[0];
type FeatureData = typeof initialFeatures[0];
type AddOnData = typeof initialAddOns[0];

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
  const [plansData, setPlansData] = useState([...initialPlans]);
  const [featuresData, setFeaturesData] = useState([...initialFeatures]);
  const [addOnsData, setAddOnsData] = useState([...initialAddOns]);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [editingPlan, setEditingPlan] = useState<PlanData | null>(null);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState<string | null>(null);
  const [showAddOnModal, setShowAddOnModal] = useState(false);
  const [editingAddOn, setEditingAddOn] = useState<AddOnData | null>(null);
  const [showAddOnArchive, setShowAddOnArchive] = useState<string | null>(null);
  const [showFeatureModal, setShowFeatureModal] = useState(false);

  const [planForm, setPlanForm] = useState({ name: '', price: '', seats: '', locations: '', features: '' as string, billingCycle: 'monthly' as 'monthly' | 'annual' });
  const [addOnForm, setAddOnForm] = useState({ name: '', price: '', description: '', compatiblePlans: [] as string[] });
  const [newFeatureName, setNewFeatureName] = useState('');

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
      features: planForm.features.split(',').map(f => f.trim()).filter(Boolean),
      limits: { seats: Number(planForm.seats), locations: Number(planForm.locations) },
      billingCycle: planForm.billingCycle,
      status: 'active',
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

  const toggleFeature = (featureId: string, planKey: 'essential' | 'growth' | 'advanced') => {
    setFeaturesData(prev => prev.map(f => f.id === featureId ? { ...f, [planKey]: !f[planKey] } : f));
  };

  const addFeature = () => {
    if (!newFeatureName.trim()) return;
    const id = newFeatureName.toLowerCase().replace(/\s+/g, '_');
    setFeaturesData(prev => [...prev, { id, name: newFeatureName.trim(), essential: false, growth: false, advanced: false }]);
    setNewFeatureName('');
    setShowFeatureModal(false);
  };

  const removeFeature = (featureId: string) => {
    setFeaturesData(prev => prev.filter(f => f.id !== featureId));
  };

  const openCreateAddOn = () => {
    setAddOnForm({ name: '', price: '', description: '', compatiblePlans: [] });
    setEditingAddOn(null);
    setShowAddOnModal(true);
  };

  const openEditAddOn = (addon: AddOnData) => {
    setAddOnForm({ name: addon.name, price: String(addon.price), description: addon.description, compatiblePlans: [...addon.compatiblePlans] });
    setEditingAddOn(addon);
    setShowAddOnModal(true);
  };

  const saveAddOn = () => {
    const newAddOn: AddOnData = {
      id: editingAddOn?.id || addOnForm.name.toLowerCase().replace(/\s+/g, '-'),
      name: addOnForm.name,
      price: Number(addOnForm.price),
      description: addOnForm.description,
      compatiblePlans: addOnForm.compatiblePlans,
      status: 'active',
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
    setAddOnsData(prev => prev.map(a => a.id === addonId ? { ...a, status: 'archived' as const } : a));
    setShowAddOnArchive(null);
  };

  const restoreAddOn = (addonId: string) => {
    setAddOnsData(prev => prev.map(a => a.id === addonId ? { ...a, status: 'active' as const } : a));
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
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Feature</th>
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Essential</th>
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Growth</th>
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Advanced</th>
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {featuresData.map((feature) => (
                <tr key={feature.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                  <td className="px-8 py-4 font-bold text-slate-900">{feature.name}</td>
                  {(['essential', 'growth', 'advanced'] as const).map(planKey => (
                    <td key={planKey} className="px-8 py-4 text-center">
                      <button
                        onClick={() => toggleFeature(feature.id, planKey)}
                        className="transition-all hover:scale-110 active:scale-95"
                      >
                        {feature[planKey] ? (
                          <span className="material-symbols-outlined text-lime-500">toggle_on</span>
                        ) : (
                          <span className="material-symbols-outlined text-slate-300">toggle_off</span>
                        )}
                      </button>
                    </td>
                  ))}
                  <td className="px-8 py-4 text-center">
                    <button onClick={() => removeFeature(feature.id)} className="text-slate-400 hover:text-red-500 transition-colors">
                      <span className="material-symbols-outlined text-sm">delete</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'addons' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {addOnsData.map((addon) => (
            <motion.div
              key={addon.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className={`bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border shadow-sm hover:shadow-md transition-all ${
                addon.status === 'archived' ? 'border-slate-300 opacity-60' : 'border-slate-200'
              }`}
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-lg font-black text-primary tracking-tight">{addon.name}</h3>
                <div className="flex items-center gap-2">
                  {addon.status === 'archived' && (
                    <span className="px-2 py-0.5 bg-slate-400/10 text-slate-500 text-[9px] font-black uppercase tracking-widest rounded-md border border-slate-200">Archived</span>
                  )}
                  <span className="text-xl font-black text-primary">${addon.price}</span>
                </div>
              </div>
              <p className="text-sm text-slate-500 mb-4 leading-relaxed">{addon.description}</p>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Compatible Plans</p>
              <div className="flex gap-2 flex-wrap mb-4">
                {addon.compatiblePlans.map((plan, i) => (
                  <span key={i} className="px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">
                    {plan}
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={() => openEditAddOn(addon)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                  Edit
                </button>
                {addon.status === 'archived' ? (
                  <button onClick={() => restoreAddOn(addon.id)} className="flex-1 py-3 bg-lime-100 hover:bg-lime-200 text-lime-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                    Restore
                  </button>
                ) : (
                  <button onClick={() => setShowAddOnArchive(addon.id)} className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                    Archive
                  </button>
                )}
              </div>
            </motion.div>
          ))}
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
              <div className="p-8">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Feature Name</label>
                <input value={newFeatureName} onChange={e => setNewFeatureName(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="e.g., Advanced Analytics" />
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
                  <p className="text-sm text-slate-500 mt-1">Define add-on details and plan compatibility.</p>
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
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Price (USD/mo)</label>
                  <input type="number" value={addOnForm.price} onChange={e => setAddOnForm(p => ({ ...p, price: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" placeholder="25" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Description</label>
                  <textarea value={addOnForm.description} onChange={e => setAddOnForm(p => ({ ...p, description: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none" rows={3} placeholder="What this add-on provides..." />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Compatible Plans</label>
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
