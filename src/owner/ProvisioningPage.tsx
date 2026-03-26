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

  const applyTemplate = (templateId: string) => {
    const tpl = provisioningTemplates.find(t => t.id === templateId);
    if (!tpl) return;
    setSelectedTemplate(templateId);
    setSelectedPlan(tpl.plan);
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
          <motion.div key="form" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-8 py-5 border-b border-slate-100">
              <h3 className="text-sm font-black text-primary uppercase tracking-widest">Tenant Details</h3>
            </div>
            <div className="p-8 space-y-6">
              <div>
                <label className={labelClass}>Quick Start Template</label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {provisioningTemplates.map(tpl => (
                    <button key={tpl.id} onClick={() => applyTemplate(tpl.id)} className={`p-4 rounded-2xl border text-left transition-all ${selectedTemplate === tpl.id ? 'bg-primary/5 border-primary/30 ring-2 ring-primary/20' : 'bg-slate-50 border-slate-200 hover:border-primary/20'}`}>
                      <p className="font-black text-slate-900 text-sm">{tpl.name}</p>
                      <p className="text-[10px] text-slate-400 mt-1">{tpl.description}</p>
                      <p className="text-[10px] font-bold text-primary mt-1 capitalize">{tpl.plan} plan</p>
                    </button>
                  ))}
                </div>
                <button onClick={() => setSelectedTemplate(null)} className={`mt-2 text-[10px] font-black uppercase tracking-widest transition-colors ${selectedTemplate ? 'text-primary hover:text-primary/80' : 'text-slate-300 cursor-default'}`}>
                  {selectedTemplate ? 'Clear Template' : 'Or configure manually below'}
                </button>
              </div>

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

              <div>
                <label className={labelClass}>Select Plan *</label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {plans.map(p => (
                    <button key={p.id} onClick={() => setSelectedPlan(p.id)} className={`p-5 rounded-2xl border text-left transition-all ${selectedPlan === p.id ? 'bg-primary/5 border-primary/30 ring-2 ring-primary/20' : 'bg-slate-50 border-slate-200 hover:border-primary/20'}`}>
                      <p className="font-black text-slate-900">{p.name}</p>
                      <div className="mt-1">
                        <p className="text-lg font-black text-primary">${billingCycle === 'annual' ? p.annualPrice : p.price}<span className="text-[10px] text-slate-400 font-bold">/{billingCycle === 'annual' ? 'yr' : 'mo'}</span></p>
                        {billingCycle === 'annual' && <p className="text-[10px] font-bold text-lime-600">{p.savingsLabel} vs monthly</p>}
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1">{p.limits.seats} seats · {p.limits.locations} location{p.limits.locations !== 1 ? 's' : ''}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {p.features.slice(0, 3).map(f => <span key={f} className="text-[8px] font-black text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded uppercase tracking-widest">{f}</span>)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelClass}>Billing Cycle</label>
                <div className="flex gap-3">
                  <button onClick={() => setBillingCycle('monthly')} className={`px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${billingCycle === 'monthly' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>Monthly</button>
                  <button onClick={() => setBillingCycle('annual')} className={`px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${billingCycle === 'annual' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                    Annual {savingsLabel && <span className="text-lime-300 ml-1">{savingsLabel}</span>}
                  </button>
                </div>
              </div>
            </div>

            <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <button onClick={() => navigate('/owner/tenants')} className="px-6 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">Cancel</button>
              <button onClick={() => setStep('confirm')} disabled={!isValid} className="px-8 py-3.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-95">Review & Confirm</button>
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

              {selectedTemplate && (
                <div className="p-4 bg-primary/5 rounded-xl border border-primary/10">
                  <p className="text-[10px] font-black text-primary uppercase tracking-widest mb-1">Template Applied</p>
                  <p className="font-bold text-slate-900">{provisioningTemplates.find(t => t.id === selectedTemplate)?.name}</p>
                  <p className="text-[10px] text-slate-400">{provisioningTemplates.find(t => t.id === selectedTemplate)?.description}</p>
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
              <p className="text-slate-500 font-medium">The tenant workspace has been created and is ready.</p>
            </div>
            <div className="px-8 pb-4">
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
              <div className="mt-4 grid grid-cols-3 md:grid-cols-6 gap-3">
                {onboardingChecklist.map(item => (
                  <div key={item.id} className="p-3 bg-lime-50 rounded-xl border border-lime-100 text-center">
                    <span className="material-symbols-outlined text-lime-600 text-sm">{item.icon}</span>
                    <p className="text-[8px] font-black text-lime-700 uppercase tracking-widest mt-1">{item.label.split(' ').slice(0, 2).join(' ')}</p>
                  </div>
                ))}
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
