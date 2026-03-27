import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { plans, provisioningTemplates } from './mockData';

type Step = 'form' | 'confirm' | 'success';

const onboardingChecklist = [
  { id: 'workspace', label: 'Tenant workspace created', icon: 'home' },
  { id: 'subdomain', label: 'Subdomain provisioned', icon: 'language' },
  { id: 'ssl', label: 'SSL certificate queued', icon: 'lock' },
  { id: 'invite', label: 'Owner invitation sent', icon: 'mail' },
  { id: 'trial', label: '14-day trial activated', icon: 'event' },
  { id: 'defaults', label: 'Default settings applied', icon: 'settings' },
  { id: 'features', label: 'Feature modules enabled', icon: 'toggle_on' },
  { id: 'branding', label: 'Branding defaults configured', icon: 'palette' },
];

const ProvisioningPage: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('form');
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('essential');
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly');
  const [provisioning, setProvisioning] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [checklistProgress, setChecklistProgress] = useState<string[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const plan = plans.find(p => p.id === selectedPlan);
  const price = plan ? (billingCycle === 'annual' ? plan.annualPrice : plan.price) : 0;
  const savingsLabel = plan?.savingsLabel || '';
  const subdomainSlug = subdomain || name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const effectiveSubdomain = subdomain || subdomainSlug;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const isValid = name.trim().length >= 2 && effectiveSubdomain.length >= 2 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(effectiveSubdomain) && ownerName.trim().length >= 2 && emailRegex.test(ownerEmail);

  const activeTemplate = selectedTemplate ? provisioningTemplates.find(t => t.id === selectedTemplate) : null;

  const applyTemplate = (templateId: string) => {
    const tpl = provisioningTemplates.find(t => t.id === templateId);
    if (!tpl) return;
    if (selectedTemplate === templateId) {
      setSelectedTemplate(null);
      return;
    }
    setSelectedTemplate(templateId);
    setSelectedPlan(tpl.plan);
    if (!subdomain && name) {
      setSubdomain(name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20));
    }
  };

  const handleConfirm = () => {
    setProvisioning(true);
    setChecklistProgress([]);
    let i = 0;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      if (i < onboardingChecklist.length) {
        const itemId = onboardingChecklist[i].id;
        i++;
        setChecklistProgress(prev => [...prev, itemId]);
      } else {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
        setProvisioning(false);
        setStep('success');
      }
    }, 350);
  };

  const inputClass = "w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary";
  const labelClass = "text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2";

  return (
    <div className="space-y-8 max-w-3xl mx-auto">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Provision New Tenant</h2>
        <p className="text-slate-500 font-medium">Onboard a new repair shop / phone store to the platform.</p>
      </div>

      <div className="flex items-center gap-3 mb-4">
        {['form', 'confirm', 'success'].map((s, i) => (
          <React.Fragment key={s}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black ${
              step === s ? 'bg-primary text-white' : i < ['form', 'confirm', 'success'].indexOf(step) ? 'bg-lime-500 text-white' : 'bg-slate-200 text-slate-500'
            }`}>{i < ['form', 'confirm', 'success'].indexOf(step) ? '✓' : i + 1}</div>
            {i < 2 && <div className={`flex-1 h-0.5 ${i < ['form', 'confirm', 'success'].indexOf(step) ? 'bg-lime-500' : 'bg-slate-200'}`} />}
          </React.Fragment>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {step === 'form' && (
          <motion.div key="form" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">

            <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center">
                <div>
                  <h3 className="text-sm font-black text-primary uppercase tracking-widest">Onboarding Presets</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">Pre-configured starting configurations for common shop types</p>
                </div>
                {selectedTemplate && (
                  <button onClick={() => { setSelectedTemplate(null); }} className="text-[10px] font-black text-primary uppercase tracking-widest hover:text-primary/80 transition-colors flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs">close</span> Clear Preset
                  </button>
                )}
              </div>
              <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {provisioningTemplates.map(tpl => {
                    const tplPlan = plans.find(p => p.id === tpl.plan);
                    const isSelected = selectedTemplate === tpl.id;
                    return (
                      <button key={tpl.id} onClick={() => applyTemplate(tpl.id)} className={`p-5 rounded-2xl border text-left transition-all ${isSelected ? 'bg-primary/5 border-primary/30 ring-2 ring-primary/20' : 'bg-slate-50 border-slate-200 hover:border-primary/20'}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`material-symbols-outlined text-lg ${isSelected ? 'text-primary' : 'text-slate-400'}`}>
                            {tpl.id === 'standard' ? 'storefront' : tpl.id === 'multi_location' ? 'location_city' : 'rocket_launch'}
                          </span>
                          <p className="font-black text-slate-900 text-sm">{tpl.name}</p>
                        </div>
                        <p className="text-[10px] text-slate-500 mb-3">{tpl.description}</p>

                        <div className="space-y-2 pt-3 border-t border-slate-100">
                          <div className="flex justify-between items-center">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Plan</span>
                            <span className="text-[10px] font-black text-primary capitalize">{tpl.plan}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Seats</span>
                            <span className="text-[10px] font-bold text-slate-600">{tplPlan?.limits.seats}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Locations</span>
                            <span className="text-[10px] font-bold text-slate-600">{tplPlan?.limits.locations}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Timezone</span>
                            <span className="text-[10px] font-bold text-slate-600">{(tpl.settings.timezone.split('/')[1] || tpl.settings.timezone).replace('_', ' ')}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Tax Rate</span>
                            <span className="text-[10px] font-bold text-slate-600">{tpl.settings.taxRate}%</span>
                          </div>
                          <div>
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Modules</span>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {tpl.features.slice(0, 5).map(f => (
                                <span key={f} className="text-[7px] font-black text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded uppercase tracking-widest">{f}</span>
                              ))}
                              {tpl.features.length > 5 && <span className="text-[7px] font-black text-primary bg-primary/5 px-1.5 py-0.5 rounded uppercase tracking-widest">+{tpl.features.length - 5}</span>}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-8 py-5 border-b border-slate-100">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Tenant Details</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">{selectedTemplate ? `Preset applied: ${activeTemplate?.name}. Customize below.` : 'Enter details manually or select a preset above.'}</p>
              </div>
              <div className="p-8 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label htmlFor="prov-name" className={labelClass}>Business Name *</label>
                    <input id="prov-name" value={name} onChange={e => setName(e.target.value)} className={inputClass} placeholder="e.g. Downtown Phone Repair" />
                  </div>
                  <div>
                    <label htmlFor="prov-subdomain" className={labelClass}>Subdomain</label>
                    <div className="flex items-center gap-0">
                      <input id="prov-subdomain" value={subdomain} onChange={e => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} className={`${inputClass} rounded-r-none border-r-0`} placeholder={subdomainSlug || 'subdomain'} />
                      <span className="px-3 py-3.5 bg-slate-100 border border-slate-200 rounded-r-xl text-[10px] font-black text-slate-400 whitespace-nowrap">.repairplatform.com</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label htmlFor="prov-owner" className={labelClass}>Owner Name *</label>
                    <input id="prov-owner" value={ownerName} onChange={e => setOwnerName(e.target.value)} className={inputClass} placeholder="Full name" />
                  </div>
                  <div>
                    <label htmlFor="prov-email" className={labelClass}>Owner Email *</label>
                    <input id="prov-email" value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} className={inputClass} placeholder="owner@business.com" type="email" />
                  </div>
                </div>

                {!selectedTemplate && (
                  <div>
                    <label htmlFor="prov-plan" className={labelClass}>Plan *</label>
                    <select id="prov-plan" value={selectedPlan} onChange={e => setSelectedPlan(e.target.value)} className={inputClass}>
                      {plans.map(p => (
                        <option key={p.id} value={p.id}>{p.name} — ${billingCycle === 'annual' ? p.annualPrice : p.price}/{billingCycle === 'annual' ? 'yr' : 'mo'} ({p.limits.seats} seats, {p.limits.locations} loc{p.limits.locations !== 1 ? 's' : ''})</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-slate-400 mt-1">Or select an Onboarding Preset above to auto-configure plan and settings.</p>
                  </div>
                )}
                {selectedTemplate && (
                  <div className="flex items-center gap-3 p-4 bg-primary/5 rounded-xl border border-primary/10">
                    <span className="material-symbols-outlined text-primary text-sm">check_circle</span>
                    <div className="flex-1">
                      <p className="text-[10px] font-black text-primary uppercase tracking-widest">Plan Auto-Selected by Preset</p>
                      <p className="font-bold text-slate-900 capitalize">{plan?.name} — ${billingCycle === 'annual' ? plan?.annualPrice : plan?.price}/{billingCycle === 'annual' ? 'yr' : 'mo'}</p>
                    </div>
                  </div>
                )}

                <div>
                  <label className={labelClass}>Billing Cycle</label>
                  <div className="flex gap-3">
                    <button onClick={() => setBillingCycle('monthly')} className={`px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${billingCycle === 'monthly' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>Monthly</button>
                    <button onClick={() => setBillingCycle('annual')} className={`px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${billingCycle === 'annual' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                      Annual {savingsLabel && <span className="text-lime-300 ml-1">{savingsLabel}</span>}
                    </button>
                  </div>
                </div>

                {activeTemplate && (
                  <div className="p-4 bg-primary/5 rounded-xl border border-primary/10">
                    <p className="text-[10px] font-black text-primary uppercase tracking-widest mb-2">Pre-configured Settings from Preset</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Currency</p>
                        <p className="text-sm font-bold text-slate-700">{activeTemplate.settings.currency}</p>
                      </div>
                      <div>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Timezone</p>
                        <p className="text-sm font-bold text-slate-700">{activeTemplate.settings.timezone}</p>
                      </div>
                      <div>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Tax Rate</p>
                        <p className="text-sm font-bold text-slate-700">{activeTemplate.settings.taxRate}%</p>
                      </div>
                      <div>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Locale</p>
                        <p className="text-sm font-bold text-slate-700">{activeTemplate.settings.locale}</p>
                      </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-primary/10">
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Enabled Modules ({activeTemplate.features.length})</p>
                      <div className="flex flex-wrap gap-1">
                        {activeTemplate.features.map(f => (
                          <span key={f} className="text-[8px] font-black text-primary bg-primary/10 px-2 py-0.5 rounded-lg uppercase tracking-widest">{f}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex justify-between items-center">
                <button onClick={() => navigate('/owner/tenants')} className="px-6 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={() => setStep('confirm')} disabled={!isValid} className="px-8 py-3.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-95">Review & Confirm</button>
              </div>
            </div>
          </motion.div>
        )}

        {step === 'confirm' && (
          <motion.div key="confirm" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-8 py-5 border-b border-slate-100">
              <h3 className="text-sm font-black text-primary uppercase tracking-widest">Review Provisioning</h3>
            </div>
            <div className="p-8 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Business Name</p>
                  <p className="font-bold text-slate-900">{name}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Subdomain</p>
                  <p className="font-bold text-slate-900">{subdomain || subdomainSlug}.repairplatform.com</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Owner</p>
                  <p className="font-bold text-slate-900">{ownerName}</p>
                  <p className="text-[10px] text-slate-400">{ownerEmail}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Plan</p>
                  <p className="font-bold text-slate-900">{plan?.name} — ${price}/{billingCycle === 'annual' ? 'yr' : 'mo'}</p>
                  <p className="text-[10px] text-slate-400">{plan?.limits.seats} seats · {plan?.limits.locations} location{(plan?.limits.locations || 0) !== 1 ? 's' : ''}</p>
                </div>
              </div>

              {activeTemplate && (
                <div className="p-4 bg-primary/5 rounded-xl border border-primary/10">
                  <p className="text-[10px] font-black text-primary uppercase tracking-widest mb-2">Preset Configuration</p>
                  <p className="font-bold text-slate-900">{activeTemplate.name}</p>
                  <p className="text-[10px] text-slate-500 mb-2">{activeTemplate.description}</p>
                  <div className="grid grid-cols-4 gap-2 mt-2 pt-2 border-t border-primary/10">
                    <div><p className="text-[8px] font-black text-slate-400 uppercase">Currency</p><p className="text-[10px] font-bold text-slate-700">{activeTemplate.settings.currency}</p></div>
                    <div><p className="text-[8px] font-black text-slate-400 uppercase">Timezone</p><p className="text-[10px] font-bold text-slate-700">{(activeTemplate.settings.timezone.split('/')[1] || activeTemplate.settings.timezone).replace('_', ' ')}</p></div>
                    <div><p className="text-[8px] font-black text-slate-400 uppercase">Tax</p><p className="text-[10px] font-bold text-slate-700">{activeTemplate.settings.taxRate}%</p></div>
                    <div><p className="text-[8px] font-black text-slate-400 uppercase">Modules</p><p className="text-[10px] font-bold text-slate-700">{activeTemplate.features.length}</p></div>
                  </div>
                </div>
              )}

              <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-amber-600 text-sm">info</span>
                  <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest">Onboarding Checklist</p>
                </div>
                <div className="space-y-2">
                  {onboardingChecklist.map(item => {
                    const done = checklistProgress.includes(item.id);
                    return (
                      <div key={item.id} className="flex items-center gap-2">
                        <span className={`material-symbols-outlined text-sm ${done ? 'text-lime-600' : provisioning ? 'text-slate-300' : 'text-amber-500'}`}>
                          {done ? 'check_circle' : provisioning ? 'radio_button_unchecked' : item.icon}
                        </span>
                        <span className={`text-sm font-bold ${done ? 'text-lime-700' : 'text-amber-700'}`}>{item.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <button onClick={() => setStep('form')} disabled={provisioning} className="px-6 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all disabled:opacity-50">Go Back</button>
              <button onClick={handleConfirm} disabled={provisioning} className="px-8 py-3.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-70 flex items-center gap-2">
                {provisioning && <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>}
                {provisioning ? 'Provisioning...' : 'Confirm & Provision'}
              </button>
            </div>
          </motion.div>
        )}

        {step === 'success' && (
          <motion.div key="success" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-lime-200 shadow-sm overflow-hidden">
            <div className="p-8 text-center space-y-4">
              <div className="w-16 h-16 bg-lime-100 rounded-full flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-lime-600 text-3xl">check_circle</span>
              </div>
              <h3 className="text-xl font-black text-primary tracking-tight">Tenant Provisioned Successfully</h3>
              <p className="text-slate-500 font-medium">The tenant workspace has been created and is ready for use.</p>
            </div>
            <div className="px-8 pb-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Business</p>
                  <p className="font-bold text-slate-900">{name}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">URL</p>
                  <p className="font-bold text-primary">{subdomain || subdomainSlug}.repairplatform.com</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Owner</p>
                  <p className="font-bold text-slate-900">{ownerName}</p>
                  <p className="text-[10px] text-slate-400">{ownerEmail}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Plan</p>
                  <p className="font-bold text-slate-900">{plan?.name} — ${price}/{billingCycle === 'annual' ? 'yr' : 'mo'}</p>
                </div>
              </div>

              {activeTemplate && (
                <div className="p-4 bg-primary/5 rounded-xl border border-primary/10">
                  <p className="text-[10px] font-black text-primary uppercase tracking-widest mb-1">Preset Applied</p>
                  <p className="font-bold text-slate-900">{activeTemplate.name}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {activeTemplate.features.map(f => (
                      <span key={f} className="text-[8px] font-black text-primary bg-primary/10 px-1.5 py-0.5 rounded uppercase tracking-widest">{f}</span>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                {onboardingChecklist.map(item => (
                  <div key={item.id} className="p-2 bg-lime-50 rounded-xl border border-lime-100 text-center">
                    <span className="material-symbols-outlined text-lime-600 text-sm">{item.icon}</span>
                    <p className="text-[7px] font-black text-lime-700 uppercase tracking-widest mt-1">{item.label.split(' ').slice(0, 2).join(' ')}</p>
                  </div>
                ))}
              </div>

              <div className="p-5 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-100 shadow-sm">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs text-primary">rocket_launch</span>
                  Activation Lifecycle
                </p>
                <div className="flex items-center justify-between gap-2 mb-4">
                  {[
                    { label: 'Invited', icon: 'mail', done: true, current: true },
                    { label: 'Pending', icon: 'hourglass_top', done: false, current: false },
                    { label: 'Setup', icon: 'settings', done: false, current: false },
                    { label: 'Active', icon: 'check_circle', done: false, current: false },
                  ].map((s, idx, arr) => (
                    <React.Fragment key={s.label}>
                      <div className={`flex flex-col items-center gap-1 ${s.done || s.current ? 'opacity-100' : 'opacity-30'}`}>
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${s.current ? 'bg-primary/10 text-primary ring-2 ring-primary/30' : s.done ? 'bg-lime-100 text-lime-600' : 'bg-slate-100 text-slate-400'}`}>
                          <span className="material-symbols-outlined text-sm">{s.done && !s.current ? 'check' : s.icon}</span>
                        </div>
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-600">{s.label}</span>
                      </div>
                      {idx < arr.length - 1 && <div className={`flex-1 h-0.5 ${idx === 0 && s.done ? 'bg-lime-300' : 'bg-slate-200'}`} />}
                    </React.Fragment>
                  ))}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-lime-700 font-bold bg-lime-50 p-2.5 rounded-xl border border-lime-100">
                    <span className="material-symbols-outlined text-xs">check_circle</span>
                    Invitation sent to {ownerEmail}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-blue-600 font-bold bg-blue-50 p-2.5 rounded-xl border border-blue-100">
                    <span className="material-symbols-outlined text-xs">schedule</span>
                    Awaiting owner account activation
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-slate-400 pl-1">
                    <span className="material-symbols-outlined text-xs">language</span>
                    {subdomain || subdomainSlug}.repairplatform.com · 14-day trial started · SSL provisioning
                  </div>
                </div>
              </div>
            </div>
            <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <button onClick={() => navigate('/owner/tenants')} className="px-6 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">Back to Tenants</button>
              <button onClick={() => { setStep('form'); setName(''); setSubdomain(''); setOwnerName(''); setOwnerEmail(''); setSelectedPlan('essential'); setBillingCycle('monthly'); setSelectedTemplate(null); setChecklistProgress([]); }} className="px-6 py-3.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95">Provision Another</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ProvisioningPage;
