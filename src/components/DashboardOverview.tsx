import React, { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useAccess } from '../context/AccessContext';
import type { OnboardingStage, OnboardingChecklist, TenantDomainInfo, DomainMode } from '../context/AccessContext';
import { planFeatures } from '../context/accessConfig';
import { useStoreLocalState } from '../context/StoreLocalState';
import type { StockItem } from '../context/StoreLocalState';
import type { Customer } from '../types';
import ApprovalQueue from './ApprovalQueue';

function DomainStatusCard({ domainInfo, onDomainAction }: { domainInfo: TenantDomainInfo; onDomainAction?: (action: string) => void }) {
  const modeLabels: Record<DomainMode, { label: string; color: string; icon: string; desc: string }> = {
    platform_subdomain: { label: 'Platform Subdomain', color: 'text-blue-700 bg-blue-50 border-blue-200', icon: 'dns', desc: 'Your store is accessible via platform subdomain.' },
    custom_pending: { label: 'Custom Domain Pending', color: 'text-amber-700 bg-amber-50 border-amber-200', icon: 'pending', desc: 'Custom domain registration is being processed.' },
    custom_dns_pending: { label: 'DNS Verification Pending', color: 'text-orange-700 bg-orange-50 border-orange-200', icon: 'domain_verification', desc: 'Add DNS records to verify your domain ownership.' },
    custom_ssl_pending: { label: 'SSL Provisioning', color: 'text-violet-700 bg-violet-50 border-violet-200', icon: 'lock', desc: 'DNS verified. SSL certificate is being provisioned.' },
    custom_active: { label: 'Custom Domain Active', color: 'text-lime-700 bg-lime-50 border-lime-200', icon: 'verified', desc: 'Your custom domain is live and secured with SSL.' },
  };

  const mode = modeLabels[domainInfo.mode];

  return (
    <div className={`p-4 rounded-2xl border ${mode.color} space-y-3`}>
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-sm">{mode.icon}</span>
        <span className="text-[10px] font-black uppercase tracking-widest">{mode.label}</span>
      </div>
      <p className="text-[11px] font-bold opacity-80">{mode.desc}</p>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold opacity-60">Platform URL</span>
          <span className="text-[10px] font-black">{domainInfo.subdomain}</span>
        </div>
        {domainInfo.customDomain && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold opacity-60">Custom Domain</span>
            <span className="text-[10px] font-black">{domainInfo.customDomain}</span>
          </div>
        )}
      </div>
      <div className="flex gap-2 flex-wrap pt-1">
        <StatusChip label="DNS" done={domainInfo.dnsVerified} />
        <StatusChip label="Propagated" done={domainInfo.propagated} />
        <StatusChip label="SSL" done={domainInfo.sslProvisioned} />
      </div>
      {domainInfo.mode === 'custom_dns_pending' && onDomainAction && (
        <div className="p-3 bg-white/60 rounded-xl border border-orange-100 mt-1">
          <p className="text-[10px] font-black text-orange-800 uppercase tracking-widest mb-1">Action Required</p>
          <p className="text-[10px] font-bold text-orange-600">Add the following DNS records at your domain registrar, then wait for propagation (up to 48 hours).</p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => onDomainAction('verify_dns')} className="px-3 py-1.5 bg-orange-500 text-white text-[9px] font-black rounded-lg uppercase tracking-widest hover:bg-orange-600 transition-colors">Verify DNS</button>
            <button onClick={() => onDomainAction('check_propagation')} className="px-3 py-1.5 bg-white text-orange-600 text-[9px] font-black rounded-lg uppercase tracking-widest border border-orange-200 hover:bg-orange-50 transition-colors">Check Propagation</button>
          </div>
        </div>
      )}
      {domainInfo.mode === 'custom_pending' && onDomainAction && (
        <div className="p-3 bg-white/60 rounded-xl border border-amber-100 mt-1">
          <p className="text-[10px] font-bold text-amber-600">Domain registration is processing. Once complete, DNS verification will begin.</p>
          <button onClick={() => onDomainAction('confirm_registration')} className="mt-2 px-3 py-1.5 bg-amber-500 text-white text-[9px] font-black rounded-lg uppercase tracking-widest hover:bg-amber-600 transition-colors">Confirm Registration</button>
        </div>
      )}
      {domainInfo.mode === 'custom_ssl_pending' && onDomainAction && (
        <div className="p-3 bg-white/60 rounded-xl border border-violet-100 mt-1">
          <p className="text-[10px] font-bold text-violet-600">DNS is verified. SSL certificate is being provisioned automatically.</p>
          <button onClick={() => onDomainAction('provision_ssl')} className="mt-2 px-3 py-1.5 bg-violet-500 text-white text-[9px] font-black rounded-lg uppercase tracking-widest hover:bg-violet-600 transition-colors">Complete SSL Setup</button>
        </div>
      )}
      {domainInfo.mode === 'platform_subdomain' && !domainInfo.customDomain && onDomainAction && (
        <button onClick={() => onDomainAction('connect_custom')} className="w-full py-2 bg-blue-500 text-white text-[9px] font-black rounded-xl uppercase tracking-widest hover:bg-blue-600 transition-colors mt-1">
          <span className="material-symbols-outlined text-xs mr-1 align-middle">add</span>
          Connect Custom Domain
        </button>
      )}
    </div>
  );
}

function StatusChip({ label, done }: { label: string; done: boolean }) {
  return (
    <div className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest ${
      done ? 'bg-lime-100 text-lime-700 border border-lime-200' : 'bg-slate-100 text-slate-400 border border-slate-200'
    }`}>
      <span className="material-symbols-outlined" style={{ fontSize: '10px' }}>{done ? 'check_circle' : 'radio_button_unchecked'}</span>
      {label}
    </div>
  );
}

function OnboardingChecklistCard({ checklist, onboardingStage, onToggleItem, isLocked, employeesEntitled, onAddEmployee }: {
  checklist: OnboardingChecklist;
  onboardingStage: OnboardingStage;
  onToggleItem?: (key: keyof OnboardingChecklist) => void;
  isLocked?: boolean;
  employeesEntitled: boolean;
  onAddEmployee?: () => void;
}) {
  const items: { key: keyof OnboardingChecklist; label: string; icon: string; action: string; route?: string; systemDriven?: boolean; onClick?: () => void }[] = [
    { key: 'storeSetupComplete', label: 'Set up store profile & branding', icon: 'storefront', action: 'Go to Settings', route: '/settings' },
  ];
  if (employeesEntitled) {
    items.push({ key: 'teamInvited', label: 'Invite team members', icon: 'group_add', action: 'Add Employee', systemDriven: true, onClick: onAddEmployee });
  }

  const completedCount = items.filter(item => checklist[item.key]).length;
  const totalCount = items.length;
  const progress = Math.round((completedCount / totalCount) * 100);
  const allDone = completedCount === totalCount;

  if (allDone && onboardingStage === 'active') return null;

  if (isLocked) {
    return (
      <div className="p-4 bg-white rounded-2xl ghost-border shadow-sm space-y-3 opacity-60">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-sm text-slate-400">lock</span>
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Setup Checklist</span>
          </div>
          <span className="text-[10px] font-black text-slate-400">0/{totalCount}</span>
        </div>
        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-slate-200 rounded-full" style={{ width: '0%' }} />
        </div>
        <p className="text-[10px] font-bold text-slate-400 text-center py-2">Click "Begin Store Setup" above to unlock the checklist</p>
      </div>
    );
  }

  return (
    <div className="p-4 bg-white rounded-2xl ghost-border shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-sm text-primary">checklist</span>
          <span className="text-[10px] font-black text-primary uppercase tracking-widest">Setup Checklist</span>
        </div>
        <span className="text-[10px] font-black text-slate-500">{completedCount}/{totalCount}</span>
      </div>
      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full bg-lime-500 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>
      <div className="space-y-1">
        {items.map(item => (
          <div key={item.key} className={`flex items-center justify-between p-2.5 rounded-xl transition-colors ${checklist[item.key] ? 'bg-lime-50/50' : 'bg-slate-50 hover:bg-slate-100'}`}>
            <div className="flex items-center gap-2.5">
              <span className={`material-symbols-outlined text-sm ${checklist[item.key] ? 'text-lime-500' : 'text-slate-300'}`}>
                {checklist[item.key] ? 'check_circle' : 'radio_button_unchecked'}
              </span>
              <span className={`text-[11px] font-bold ${checklist[item.key] ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                {item.label}
              </span>
            </div>
            {!checklist[item.key] && (
              <div className="flex items-center gap-2">
                {onToggleItem && !item.systemDriven && (
                  <button onClick={() => onToggleItem(item.key)} className="text-[8px] font-black text-lime-600 bg-lime-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-lime-100 transition-colors border border-lime-200">
                    Mark Done
                  </button>
                )}
                {item.onClick ? (
                  <button onClick={item.onClick} className="text-[8px] font-black text-primary uppercase tracking-widest hover:text-primary/80 transition-colors">
                    {item.action}
                  </button>
                ) : item.route ? (
                  <Link to={item.route} className="text-[8px] font-black text-primary uppercase tracking-widest hover:text-primary/80 transition-colors">
                    {item.action}
                  </Link>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LifecycleStepper({ onboardingStage, inviteSentDate, setupStartedDate, activatedDate }: {
  onboardingStage: OnboardingStage;
  inviteSentDate?: string;
  setupStartedDate?: string;
  activatedDate?: string;
}) {
  const stages: { key: OnboardingStage; label: string; icon: string; date?: string }[] = [
    { key: 'invited', label: 'Invited', icon: 'mail', date: inviteSentDate },
    { key: 'pending_setup', label: 'Setup Started', icon: 'engineering', date: setupStartedDate },
    { key: 'setup_incomplete', label: 'Setup In Progress', icon: 'build', date: undefined },
    { key: 'pending_activation', label: 'Pending Activation', icon: 'hourglass_top', date: undefined },
    { key: 'active', label: 'Active & Live', icon: 'check_circle', date: activatedDate },
  ];

  const stageOrder: OnboardingStage[] = ['invited', 'pending_setup', 'setup_incomplete', 'pending_activation', 'active'];
  const currentIdx = stageOrder.indexOf(onboardingStage);

  return (
    <div className="flex items-center gap-0 w-full">
      {stages.map((stage, i) => {
        const isDone = i < currentIdx;
        const isCurrent = i === currentIdx;
        return (
          <React.Fragment key={stage.key}>
            <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                isDone ? 'bg-lime-100 border-2 border-lime-400' :
                isCurrent ? 'bg-blue-100 border-2 border-blue-400 ring-2 ring-blue-200' :
                'bg-slate-100 border-2 border-slate-200'
              }`}>
                <span className={`material-symbols-outlined text-sm ${
                  isDone ? 'text-lime-600' : isCurrent ? 'text-blue-600' : 'text-slate-400'
                }`}>{isDone ? 'check' : stage.icon}</span>
              </div>
              <span className={`text-[7px] font-black uppercase tracking-widest text-center leading-tight ${
                isDone ? 'text-lime-700' : isCurrent ? 'text-blue-700' : 'text-slate-400'
              }`}>{stage.label}</span>
              {stage.date && (
                <span className="text-[7px] font-bold text-slate-400">{stage.date}</span>
              )}
            </div>
            {i < stages.length - 1 && (
              <div className={`h-0.5 w-4 mt-[-20px] flex-shrink-0 ${isDone ? 'bg-lime-400' : 'bg-slate-200'}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function StoreActivationPanel() {
  const { session, tenant, setPreviewTenant, isPreviewModeEnabled } = useAccess();
  if (!session || session.role !== 'store_owner' || !tenant) return null;

  const onboardingStage = tenant.onboardingStage || (tenant.status === 'active' || tenant.status === 'trialing' ? 'active' : 'pending_setup');
  const isOnboardedByStage = onboardingStage === 'active';
  const checklist = tenant.onboardingChecklist || {
    profileComplete: isOnboardedByStage, paymentMethodAdded: isOnboardedByStage, firstProductAdded: isOnboardedByStage,
    domainConfigured: isOnboardedByStage, teamInvited: isOnboardedByStage, storeCustomized: isOnboardedByStage,
    storeSetupComplete: isOnboardedByStage,
  };
  const domainInfo = tenant.domainInfo || {
    mode: 'platform_subdomain' as const, subdomain: `${tenant.name.toLowerCase().replace(/\s/g, '-')}.repairplatform.io`,
    dnsVerified: false, sslProvisioned: false, propagated: false,
  };

  const employeesEntitled = (planFeatures[tenant.plan] || []).includes('employees');
  const storeChecklistKeys: (keyof OnboardingChecklist)[] = employeesEntitled
    ? ['storeSetupComplete', 'teamInvited']
    : ['storeSetupComplete'];

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [showAddEmployeeModal, setShowAddEmployeeModal] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  }, []);

  const updateTenant = useCallback((updates: Partial<typeof tenant>) => {
    if (!isPreviewModeEnabled) return;
    setPreviewTenant({ ...tenant, ...updates });
  }, [tenant, isPreviewModeEnabled, setPreviewTenant]);

  const advanceStage = useCallback((nextStage: OnboardingStage) => {
    const today = new Date().toISOString().split('T')[0];
    const dateUpdates: Record<string, string> = {};
    if (nextStage === 'pending_setup') dateUpdates.setupStartedDate = today;
    if (nextStage === 'active') dateUpdates.activatedDate = today;

    const statusUpdate = nextStage === 'active' ? 'active' as const : tenant.status;
    updateTenant({ onboardingStage: nextStage, status: statusUpdate, ...dateUpdates });
    const stageLabels: Record<OnboardingStage, string> = {
      invited: 'Invited', pending_setup: 'Setup Started', setup_incomplete: 'Setup In Progress',
      pending_activation: 'Pending Activation', active: 'Active & Live'
    };
    showToast(`Stage advanced to: ${stageLabels[nextStage]}`);
  }, [tenant, updateTenant, showToast]);

  const toggleChecklistItem = useCallback((key: keyof OnboardingChecklist) => {
    const newChecklist = { ...checklist, [key]: !checklist[key] };
    const allDone = storeChecklistKeys.every(k => newChecklist[k]);
    const anyDone = storeChecklistKeys.some(k => newChecklist[k]);
    let newStage = onboardingStage;
    if (allDone && onboardingStage !== 'active') {
      newStage = 'pending_activation';
    } else if (anyDone) {
      newStage = onboardingStage === 'invited' ? 'pending_setup' : 'setup_incomplete';
    } else if (!anyDone && onboardingStage !== 'invited') {
      newStage = 'pending_setup';
    }
    const today = new Date().toISOString().split('T')[0];
    const dateUpdates: Record<string, string> = {};
    if (newStage === 'pending_setup' && !tenant.setupStartedDate) dateUpdates.setupStartedDate = today;
    updateTenant({ onboardingChecklist: newChecklist, onboardingStage: newStage, ...dateUpdates });
    showToast(`${checklist[key] ? 'Unchecked' : 'Completed'}: ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
  }, [checklist, onboardingStage, tenant, updateTenant, showToast]);

  const handleInlineAddEmployee = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const firstName = fd.get('firstName') as string;
    const lastName = fd.get('lastName') as string;
    if (!firstName?.trim() || !lastName?.trim()) return;
    const updatedChecklist = { ...checklist, teamInvited: true };
    const allDone = storeChecklistKeys.every(k => updatedChecklist[k]);
    let newStage = onboardingStage;
    if (allDone && onboardingStage !== 'active') {
      newStage = 'pending_activation';
    } else if (onboardingStage === 'invited') {
      newStage = 'pending_setup';
    } else if (onboardingStage !== 'active') {
      newStage = 'setup_incomplete';
    }
    const today = new Date().toISOString().split('T')[0];
    const dateUpdates: Record<string, string> = {};
    if (newStage === 'pending_setup' && !tenant.setupStartedDate) dateUpdates.setupStartedDate = today;
    updateTenant({ onboardingChecklist: updatedChecklist, onboardingStage: newStage, ...dateUpdates });
    setShowAddEmployeeModal(false);
    showToast(`Employee ${firstName} ${lastName} invited successfully`);
  }, [checklist, storeChecklistKeys, onboardingStage, tenant, updateTenant, showToast]);

  const handleDomainAction = useCallback((action: string) => {
    const di = { ...domainInfo };
    switch (action) {
      case 'connect_custom':
        updateTenant({
          domainInfo: { ...di, mode: 'custom_pending', customDomain: 'my-custom-store.com' },
          onboardingChecklist: { ...checklist, domainConfigured: true },
        });
        showToast('Custom domain connection initiated: my-custom-store.com');
        break;
      case 'confirm_registration':
        updateTenant({ domainInfo: { ...di, mode: 'custom_dns_pending' } });
        showToast('Domain registration confirmed — DNS verification required');
        break;
      case 'check_propagation':
        updateTenant({ domainInfo: { ...di, propagated: true } });
        showToast('DNS propagation confirmed');
        break;
      case 'verify_dns':
        updateTenant({ domainInfo: { ...di, mode: 'custom_ssl_pending', dnsVerified: true, propagated: true } });
        showToast('DNS records verified — SSL provisioning started');
        break;
      case 'provision_ssl':
        updateTenant({ domainInfo: { ...di, mode: 'custom_active', sslProvisioned: true, dnsVerified: true, propagated: true } });
        showToast('SSL certificate provisioned — custom domain is now active');
        break;
    }
  }, [domainInfo, checklist, updateTenant, showToast]);

  const isLive = tenant.status === 'active' || tenant.status === 'trialing';
  const isSuspended = tenant.status === 'suspended';
  const isOverdue = tenant.status === 'overdue';
  const isReadOnly = tenant.status === 'read_only';
  const isFullyOnboarded = onboardingStage === 'active' && isLive;
  const checklistComplete = storeChecklistKeys.every(k => checklist[k]);

  const toast = toastMsg ? (
    <div className="fixed top-6 right-6 z-[200] px-5 py-3 bg-slate-900 text-white text-sm font-bold rounded-2xl shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
      <span className="material-symbols-outlined text-sm text-lime-400">info</span>
      {toastMsg}
    </div>
  ) : null;

  if (isSuspended) {
    return (
      <>
        {toast}
        <div className="space-y-4">
          <div className="p-5 bg-red-50 rounded-2xl border border-red-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-red-600">block</span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-black text-red-800">Your store has been suspended</p>
                <p className="text-[10px] text-red-600 font-bold">Please contact support or resolve outstanding billing issues to restore access.</p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/80 rounded-lg border border-red-200">
                <span className="material-symbols-outlined text-xs text-red-400">error</span>
                <span className="text-[9px] font-black text-red-600 uppercase tracking-widest">Access Blocked</span>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/80 rounded-lg border border-red-200">
                <span className="material-symbols-outlined text-xs text-red-400">support_agent</span>
                <span className="text-[9px] font-black text-red-600 uppercase tracking-widest">Contact Support</span>
              </div>
            </div>
          </div>
          {(domainInfo.mode !== 'platform_subdomain' || !!domainInfo.customDomain) && (
            <DomainStatusCard domainInfo={domainInfo} onDomainAction={isPreviewModeEnabled ? handleDomainAction : undefined} />
          )}
        </div>
      </>
    );
  }

  if (isReadOnly) {
    return (
      <>
        {toast}
        <div className="space-y-4">
          <div className="p-5 bg-violet-50 rounded-2xl border border-violet-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-violet-100 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-violet-600">visibility</span>
              </div>
              <div>
                <p className="text-sm font-black text-violet-800">Your store is in read-only mode</p>
                <p className="text-[10px] text-violet-600 font-bold">You can view data but editing is disabled. Contact your platform admin to restore full access.</p>
              </div>
            </div>
          </div>
          {(domainInfo.mode !== 'platform_subdomain' || !!domainInfo.customDomain) && (
            <DomainStatusCard domainInfo={domainInfo} onDomainAction={isPreviewModeEnabled ? handleDomainAction : undefined} />
          )}
        </div>
      </>
    );
  }

  if (isOverdue) {
    return (
      <>
        {toast}
        <div className="space-y-4">
          <div className="p-5 bg-amber-50 rounded-2xl border border-amber-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-amber-600">warning</span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-black text-amber-800">Payment overdue — action required</p>
                <p className="text-[10px] text-amber-600 font-bold">Your store is still accessible, but please update your payment method to avoid interruption.</p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button className="px-3 py-1.5 bg-amber-500 text-white text-[9px] font-black rounded-lg uppercase tracking-widest hover:bg-amber-600 transition-colors">Update Payment</button>
            </div>
          </div>
          {(domainInfo.mode !== 'platform_subdomain' || !!domainInfo.customDomain) && (
            <DomainStatusCard domainInfo={domainInfo} onDomainAction={isPreviewModeEnabled ? handleDomainAction : undefined} />
          )}
        </div>
      </>
    );
  }

  if (isFullyOnboarded && checklistComplete) {
    return (
      <>
        {toast}
        <div className="space-y-4">
          <div className="p-5 bg-lime-50 rounded-2xl border border-lime-200 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-lime-100 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-lime-600">check_circle</span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-black text-lime-800">
                  {tenant.status === 'trialing' ? 'Your store is active (trial)' : 'Your store is fully active and live'}
                </p>
                <p className="text-[10px] text-lime-600 font-bold">
                  {tenant.status === 'trialing' && tenant.trialEndsDate
                    ? `Free trial ends ${tenant.trialEndsDate}. Upgrade to keep your store running.`
                    : tenant.status === 'trialing'
                    ? 'You are on a free trial. Upgrade before it expires to keep your store running.'
                    : 'All setup steps are complete. Your store is accessible to customers.'}
                </p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/80 rounded-lg border border-lime-200">
                <span className="material-symbols-outlined text-xs text-lime-600">rocket_launch</span>
                <span className="text-[9px] font-black text-lime-700 uppercase tracking-widest">Onboarding Complete</span>
              </div>
              {tenant.activatedDate && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/80 rounded-lg border border-lime-200">
                  <span className="material-symbols-outlined text-xs text-lime-600">event_available</span>
                  <span className="text-[9px] font-black text-lime-700 uppercase tracking-widest">Since {tenant.activatedDate}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/80 rounded-lg border border-lime-200">
                <span className="material-symbols-outlined text-xs text-lime-600">verified_user</span>
                <span className="text-[9px] font-black text-lime-700 uppercase tracking-widest">{tenant.plan} Plan</span>
              </div>
            </div>
          </div>
          {(domainInfo.mode !== 'platform_subdomain' || !!domainInfo.customDomain) && (
            <DomainStatusCard domainInfo={domainInfo} onDomainAction={isPreviewModeEnabled ? handleDomainAction : undefined} />
          )}
        </div>
      </>
    );
  }

  const stageMessages: Record<OnboardingStage, { title: string; subtitle: string; color: string; bg: string; border: string; iconBg: string }> = {
    invited: {
      title: 'Welcome! Your store invitation is ready',
      subtitle: 'Complete your account setup to get started. Follow the checklist below.',
      color: 'text-indigo-800', bg: 'bg-indigo-50', border: 'border-indigo-200', iconBg: 'bg-indigo-100',
    },
    pending_setup: {
      title: 'Account setup started',
      subtitle: 'Continue setting up your store. Complete the required items in the checklist.',
      color: 'text-blue-800', bg: 'bg-blue-50', border: 'border-blue-200', iconBg: 'bg-blue-100',
    },
    setup_incomplete: {
      title: 'Setup in progress — items remaining',
      subtitle: 'You still have setup steps to complete before your store can go live.',
      color: 'text-amber-800', bg: 'bg-amber-50', border: 'border-amber-200', iconBg: 'bg-amber-100',
    },
    pending_activation: {
      title: 'Almost there — activation pending',
      subtitle: 'Your setup is being reviewed. Your store will be activated shortly.',
      color: 'text-violet-800', bg: 'bg-violet-50', border: 'border-violet-200', iconBg: 'bg-violet-100',
    },
    active: {
      title: 'Your store is active — finish remaining setup',
      subtitle: 'Your store is live but some optional setup items remain. Complete them for the best experience.',
      color: 'text-lime-800', bg: 'bg-lime-50', border: 'border-lime-200', iconBg: 'bg-lime-100',
    },
  };

  const msg = stageMessages[onboardingStage];
  const stageIcons: Record<OnboardingStage, string> = {
    invited: 'mail',
    pending_setup: 'engineering',
    setup_incomplete: 'build',
    pending_activation: 'hourglass_top',
    active: 'check_circle',
  };

  return (
    <>
      {toast}
      <div className="space-y-4">
        <div className={`p-5 ${msg.bg} rounded-2xl ${msg.border} border space-y-4`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 ${msg.iconBg} rounded-full flex items-center justify-center`}>
              <span className={`material-symbols-outlined ${msg.color}`}>{stageIcons[onboardingStage]}</span>
            </div>
            <div className="flex-1">
              <p className={`text-sm font-black ${msg.color}`}>{msg.title}</p>
              <p className={`text-[10px] font-bold ${msg.color} opacity-70`}>{msg.subtitle}</p>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/70 rounded-lg border border-slate-200/50">
              <span className="material-symbols-outlined text-xs text-slate-500">verified_user</span>
              <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">{tenant.plan} Plan</span>
            </div>
            {onboardingStage !== 'active' && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/70 rounded-lg border border-slate-200/50">
                <span className="material-symbols-outlined text-xs text-slate-500">lock_open</span>
                <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Modules unlock after activation</span>
              </div>
            )}
          </div>
          <LifecycleStepper
            onboardingStage={onboardingStage}
            inviteSentDate={tenant.inviteSentDate}
            setupStartedDate={tenant.setupStartedDate}
            activatedDate={tenant.activatedDate}
          />
          {onboardingStage === 'invited' && (
            <div className="p-3 bg-white/60 rounded-xl border border-indigo-100">
              <p className="text-[10px] font-black text-indigo-700 uppercase tracking-widest mb-1">Get Started</p>
              <p className="text-[10px] font-bold text-indigo-600">
                {tenant.inviteSentDate
                  ? `Welcome! Your ${tenant.plan} plan is ready. Click below to begin setting up your store.`
                  : 'Welcome! Click below to begin setting up your store.'}
              </p>
              <div className="mt-2 flex gap-2 flex-wrap">
                {isPreviewModeEnabled ? (
                  <button onClick={() => advanceStage('pending_setup')} className="px-4 py-2 bg-indigo-500 text-white text-[9px] font-black rounded-xl uppercase tracking-widest hover:bg-indigo-600 transition-colors">
                    Begin Store Setup
                  </button>
                ) : (
                  <Link to="/settings" className="px-4 py-2 bg-indigo-500 text-white text-[9px] font-black rounded-xl uppercase tracking-widest hover:bg-indigo-600 transition-colors inline-block">
                    Begin Store Setup
                  </Link>
                )}
              </div>
            </div>
          )}
          {onboardingStage === 'pending_activation' && (
            <div className="p-3 bg-white/60 rounded-xl border border-violet-100">
              <p className="text-[10px] font-bold text-violet-600 flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">info</span>
                Your store activation is in progress. You will be notified once it is complete.
              </p>
              {isPreviewModeEnabled && (
                <button onClick={() => advanceStage('active')} className="mt-2 px-4 py-2 bg-violet-500 text-white text-[9px] font-black rounded-xl uppercase tracking-widest hover:bg-violet-600 transition-colors">
                  Activate Store Now
                </button>
              )}
            </div>
          )}
          {(onboardingStage === 'setup_incomplete' || onboardingStage === 'pending_setup') && (
            <div className="p-3 bg-white/60 rounded-xl border border-amber-100">
              <p className="text-[10px] font-bold text-amber-600 flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">info</span>
                {storeChecklistKeys.filter(k => checklist[k]).length}/{storeChecklistKeys.length} completed — complete the required items below to proceed to activation.
              </p>
              <div className="mt-2">
                <Link to="/settings" className="px-4 py-2 bg-amber-500 text-white text-[9px] font-black rounded-xl uppercase tracking-widest hover:bg-amber-600 transition-colors inline-block">
                  Continue Setup
                </Link>
              </div>
            </div>
          )}
        </div>
        <OnboardingChecklistCard
          checklist={checklist}
          onboardingStage={onboardingStage}
          onToggleItem={isPreviewModeEnabled ? toggleChecklistItem : undefined}
          isLocked={onboardingStage === 'invited'}
          employeesEntitled={employeesEntitled}
          onAddEmployee={() => setShowAddEmployeeModal(true)}
        />
        {(domainInfo.mode !== 'platform_subdomain' || !!domainInfo.customDomain) && (
          <DomainStatusCard domainInfo={domainInfo} onDomainAction={isPreviewModeEnabled ? handleDomainAction : undefined} />
        )}
      </div>

      <AnimatePresence>
        {showAddEmployeeModal && (
          <div key="add-emp-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAddEmployeeModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Add Employee</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Invite a team member to get started</p>
                </div>
                <button onClick={() => setShowAddEmployeeModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <form onSubmit={handleInlineAddEmployee} className="p-8 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">First Name</label>
                    <input name="firstName" required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="John" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Last Name</label>
                    <input name="lastName" required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="Doe" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Email Address</label>
                  <input name="email" type="email" required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="john@example.com" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Role</label>
                  <select name="role" required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                    <option value="technician">Technician</option>
                    <option value="sales_associate">Sales Associate</option>
                    <option value="manager">Manager</option>
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button type="button" onClick={() => setShowAddEmployeeModal(false)} className="flex-1 px-6 py-4 bg-slate-100 text-slate-600 font-black text-sm rounded-2xl uppercase tracking-widest hover:bg-slate-200 transition-colors">
                    Cancel
                  </button>
                  <button type="submit" className="flex-1 px-6 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-xl shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
                    Send Invite
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

export default function DashboardOverview({ onNewRepair }: { onNewRepair: () => void }) {
  const { session, canAccess } = useAccess();
  const navigate = useNavigate();
  const { addCustomer, addStockItem, updateStockItem, stockItems: sharedStockItems, approvedStockItems, pendingStockItems, heldOrders, removeHeldOrder } = useStoreLocalState();
  const hasInventoryPermission = canAccess('inventory');
  const [showPrintLabelModal, setShowPrintLabelModal] = useState(false);
  const [showScanQRModal, setShowScanQRModal] = useState(false);
  const [showAddStockModal, setShowAddStockModal] = useState(false);
  const [showNewCustomerModal, setShowNewCustomerModal] = useState(false);
  const [showQuickIntakeModal, setShowQuickIntakeModal] = useState(false);
  const [showHeldOrdersModal, setShowHeldOrdersModal] = useState(false);
  const [printLabelText, setPrintLabelText] = useState('');
  const [printLabelQty, setPrintLabelQty] = useState(1);
  const [printLabelType, setPrintLabelType] = useState<'barcode' | 'price' | 'asset'>('barcode');
  const [printSent, setPrintSent] = useState(false);
  const [selectedPrintItem, setSelectedPrintItem] = useState<StockItem | null>(null);
  const [scanResult, setScanResult] = useState('');
  const [stockSaved, setStockSaved] = useState(false);
  const [customerSaved, setCustomerSaved] = useState(false);
  const [lastAddedStock, setLastAddedStock] = useState<StockItem | null>(null);
  const [intakeDetails, setIntakeDetails] = useState({ imei: '', serialNumber: '', passcode: '', network: '' });
  const [intakeValidationError, setIntakeValidationError] = useState('');
  const [dashStockName, setDashStockName] = useState('');
  const [dashStockSku, setDashStockSku] = useState('');
  const [dashStockQty, setDashStockQty] = useState('1');
  const [dashStockCost, setDashStockCost] = useState('');
  const [dashStockPrice, setDashStockPrice] = useState('');
  const [dashStockCategory, setDashStockCategory] = useState('Parts');

  const role = session?.role;
  const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  const allActions = [
    { label: 'New Sale', icon: 'shopping_cart', color: 'bg-primary', roles: ['store_owner', 'manager', 'sales_staff'] },
    { label: 'Quick Intake', icon: 'bolt', color: 'bg-secondary', roles: ['store_owner', 'manager', 'technician'] },
    { label: 'Add Stock', icon: 'inventory_2', color: 'bg-teal-800', roles: ['store_owner', 'manager', 'technician', 'sales_staff'] },
    { label: 'New Customer', icon: 'person_add', color: 'bg-secondary', roles: ['store_owner', 'manager', 'sales_staff'] },
    { label: 'Print Label', icon: 'print', color: 'bg-slate-800', roles: ['store_owner', 'manager', 'technician', 'sales_staff'] },
    { label: 'Held Orders', icon: 'history', color: 'bg-slate-600', roles: ['store_owner', 'manager', 'sales_staff'] },
    { label: 'Scan QR', icon: 'qr_code_scanner', color: 'bg-lime-600', roles: ['store_owner', 'manager', 'technician', 'sales_staff'] },
  ];

  const visibleActions = allActions.filter(a => {
    if (!a.roles.includes(role || '')) return false;
    if (a.requires && !canAccess(a.requires)) return false;
    return true;
  });

  const handleQuickAction = (label: string) => {
    switch (label) {
      case 'New Sale':
        navigate('/sales');
        break;
      case 'Quick Intake':
        setShowQuickIntakeModal(true);
        break;
      case 'Add Stock':
        setShowAddStockModal(true);
        break;
      case 'New Customer':
        setShowNewCustomerModal(true);
        break;
      case 'Print Label':
        setShowPrintLabelModal(true);
        break;
      case 'Held Orders':
        setShowHeldOrdersModal(true);
        break;
      case 'Scan QR':
        setShowScanQRModal(true);
        break;
    }
  };

  const statCards: { label: string; value: string; color: string; bg: string; border: string; icon: string; route: string; sub?: string; roles: string[] }[] = [
    { label: "Today's Revenue", value: '$4,285.50', color: 'text-white', bg: 'signature-gradient', border: '', icon: 'payments', route: '/reports', sub: '+12.5% vs yesterday', roles: ['store_owner', 'manager', 'sales_staff'] },
    { label: 'Active Repairs', value: '18', color: 'text-primary', bg: 'bg-white', border: 'border border-outline-variant/10', icon: 'build', route: '/repairs', sub: '3 awaiting parts', roles: ['store_owner', 'manager', 'technician'] },
    { label: 'Critical Stock', value: '04', color: 'text-red-700', bg: 'bg-red-50', border: 'border border-red-100', icon: 'warning', route: '/inventory', sub: 'Immediate reorder required', roles: ['store_owner', 'manager'] },
  ];

  const visibleStats = statCards.filter(s => s.roles.includes(role || ''));

  return (
    <div className="space-y-8">
      {session?.role === 'store_owner' && <StoreActivationPanel />}
      {(session?.role === 'store_owner' || session?.role === 'system_owner' || session?.role === 'manager') && <ApprovalQueue />}
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Operational Overview</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Welcome back, {session?.user?.name?.split(' ')[0] || 'Architect'}</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-slate-100 px-4 py-2 rounded-xl ghost-border">
            <span className="material-symbols-outlined text-sm">calendar_today</span>
            <span className="text-sm font-semibold">{todayStr}</span>
          </div>
          {(role === 'store_owner' || role === 'manager' || role === 'technician') && (
            <button 
              onClick={() => setShowQuickIntakeModal(true)}
              className="bg-secondary text-white px-6 py-2 rounded-xl font-bold text-sm shadow-lg flex items-center gap-2 active:scale-95 transition-transform"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              Quick Intake
            </button>
          )}
        </div>
      </header>

      <div className={`grid grid-cols-2 md:grid-cols-4 ${visibleActions.length > 4 ? 'lg:grid-cols-' + Math.min(visibleActions.length, 7) : ''} gap-4`}>
        {visibleActions.map((action, i) => (
          <button key={i} onClick={() => handleQuickAction(action.label)} className="flex flex-col items-center justify-center p-4 bg-white rounded-2xl ghost-border shadow-sm hover:shadow-md transition-all group active:scale-95">
            <div className={`w-10 h-10 ${action.color} text-white rounded-xl flex items-center justify-center mb-2 group-hover:scale-110 transition-transform`}>
              <span className="material-symbols-outlined text-xl">{action.icon}</span>
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">{action.label}</span>
          </button>
        ))}
      </div>

      <div className={`grid grid-cols-1 md:grid-cols-${visibleStats.length} gap-6`}>
        {visibleStats.map((stat, i) => (
          <div key={i} onClick={() => navigate(stat.route)} className={`${stat.bg} p-8 rounded-[2rem] shadow-sm ${stat.border} flex flex-col justify-between h-52 cursor-pointer hover:shadow-xl transition-shadow relative overflow-hidden`}>
            <div className="z-10">
              <span className={`${stat.color === 'text-white' ? 'text-white/60' : stat.color} uppercase text-[10px] font-bold tracking-widest opacity-70`}>{stat.label}</span>
              <div className={`text-5xl font-black mt-2 tracking-tighter ${stat.color}`}>{stat.value}</div>
            </div>
            {stat.sub && (
              <div className="z-10 flex items-center gap-2">
                {stat.label === "Today's Revenue" ? (
                  <>
                    <span className="bg-lime-400 text-teal-950 px-2 py-0.5 rounded text-[10px] font-bold">+12.5%</span>
                    <span className="text-teal-100/50 text-xs">vs yesterday</span>
                  </>
                ) : (
                  <span className={`text-xs font-bold uppercase tracking-wider ${stat.color} opacity-70`}>{stat.sub}</span>
                )}
              </div>
            )}
            <span className="material-symbols-outlined absolute -right-4 -bottom-4 text-9xl opacity-10">{stat.icon}</span>
          </div>
        ))}
      </div>

      {hasInventoryPermission && pendingStockItems.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-[2rem] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center">
                <span className="material-symbols-outlined text-amber-600">pending_actions</span>
              </div>
              <div>
                <h3 className="text-sm font-black text-amber-900 uppercase tracking-widest">Pending Stock Approval</h3>
                <p className="text-[10px] text-amber-600 font-bold">{pendingStockItems.length} item{pendingStockItems.length !== 1 ? 's' : ''} awaiting review</p>
              </div>
            </div>
          </div>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {pendingStockItems.map(item => (
              <div key={item.id} className="flex items-center justify-between bg-white p-4 rounded-2xl border border-amber-100">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-800 truncate">{item.name}</p>
                  <p className="text-[10px] text-slate-400">SKU: {item.sku} · Qty: {item.qty} · ${item.price.toFixed(2)}</p>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <button onClick={() => updateStockItem(item.id, { status: 'approved' })} className="px-4 py-2 bg-lime-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-lime-600 transition-all flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs">check</span>
                    Approve
                  </button>
                  <button onClick={() => updateStockItem(item.id, { status: 'rejected' })} className="px-3 py-2 bg-red-100 text-red-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-red-200 transition-all">
                    <span className="material-symbols-outlined text-xs">close</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <AnimatePresence>
        {showPrintLabelModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => setShowPrintLabelModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Print Label</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Generate barcode / price labels</p>
                </div>
                <button onClick={() => setShowPrintLabelModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 space-y-6">
                {printSent ? (
                  <div className="py-8 text-center space-y-4">
                    <div className="w-16 h-16 bg-lime-100 rounded-full flex items-center justify-center mx-auto">
                      <span className="material-symbols-outlined text-3xl text-lime-600" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
                    </div>
                    <p className="text-lg font-black text-primary">Sent to Printer</p>
                    <p className="text-xs text-slate-500 font-bold">{printLabelQty} {printLabelType} label{printLabelQty > 1 ? 's' : ''} queued{selectedPrintItem ? ` — ${selectedPrintItem.name}` : ''}</p>
                    <button onClick={() => { setShowPrintLabelModal(false); setPrintLabelText(''); setPrintLabelQty(1); setPrintSent(false); setSelectedPrintItem(null); }} className="px-8 py-3 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest">Done</button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Label Type</label>
                      <div className="grid grid-cols-3 gap-2">
                        {([['barcode', 'qr_code_2', 'Barcode'], ['price', 'sell', 'Price Tag'], ['asset', 'inventory', 'Asset']] as const).map(([val, icon, lbl]) => (
                          <button key={val} onClick={() => setPrintLabelType(val)} className={`py-3 rounded-xl text-[10px] font-black uppercase tracking-widest flex flex-col items-center gap-1 border transition-all ${printLabelType === val ? 'bg-primary text-white border-primary' : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-primary/30'}`}>
                            <span className="material-symbols-outlined text-sm">{icon}</span>
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Search Inventory</label>
                      <input
                        value={printLabelText}
                        onChange={(e) => { setPrintLabelText(e.target.value); setSelectedPrintItem(null); }}
                        className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                        placeholder="Search by name or SKU..."
                      />
                      {printLabelText.trim() && !selectedPrintItem && (() => {
                        const matches = approvedStockItems.filter(si =>
                          si.name.toLowerCase().includes(printLabelText.toLowerCase()) ||
                          si.sku.toLowerCase().includes(printLabelText.toLowerCase())
                        );
                        return matches.length > 0 ? (
                          <div className="bg-white border border-slate-200 rounded-xl max-h-40 overflow-y-auto shadow-lg">
                            {matches.map(si => (
                              <button key={si.id} onClick={() => { setSelectedPrintItem(si); setPrintLabelText(si.name); }} className="w-full px-4 py-3 text-left hover:bg-slate-50 border-b border-slate-100 last:border-0">
                                <p className="text-sm font-bold text-slate-700">{si.name}</p>
                                <p className="text-[10px] text-slate-400">SKU: {si.sku} · ${si.price.toFixed(2)} · {si.qty} in stock</p>
                              </button>
                            ))}
                          </div>
                        ) : null;
                      })()}
                      {selectedPrintItem && (
                        <div className="flex items-center gap-2 px-4 py-2 bg-lime-50 border border-lime-200 rounded-xl">
                          <span className="material-symbols-outlined text-lime-600 text-sm" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
                          <p className="text-xs font-bold text-lime-700">{selectedPrintItem.name} · SKU: {selectedPrintItem.sku}</p>
                          <button onClick={() => { setSelectedPrintItem(null); setPrintLabelText(''); }} className="ml-auto text-slate-400 hover:text-red-500">
                            <span className="material-symbols-outlined text-sm">close</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Quantity</label>
                      <input
                        type="number"
                        min={1}
                        value={printLabelQty}
                        onChange={(e) => setPrintLabelQty(Number(e.target.value))}
                        className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                      />
                    </div>
                    <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                      <div className="text-center">
                        {printLabelType === 'barcode' ? (
                          <div>
                            <div className="flex items-center justify-center gap-[2px] mb-2">
                              {[3,2,3,1,2,3,2,1,3,2,1,2,3,1,2,3,2,1,3,2].map((w, i) => (
                                <div key={i} className="bg-slate-800 rounded-sm" style={{ width: w, height: 40 }} />
                              ))}
                            </div>
                            <p className="text-xs font-mono font-bold text-slate-600">{selectedPrintItem?.sku || printLabelText || '—'}</p>
                            {selectedPrintItem && <p className="text-[10px] text-slate-400 mt-1">{selectedPrintItem.name}</p>}
                          </div>
                        ) : printLabelType === 'price' ? (
                          <div>
                            <span className="material-symbols-outlined text-3xl text-slate-300 mb-1">sell</span>
                            <p className="text-2xl font-black text-primary">{selectedPrintItem ? `$${selectedPrintItem.price.toFixed(2)}` : '—'}</p>
                            <p className="text-xs font-bold text-slate-500 mt-1">{selectedPrintItem?.name || printLabelText || 'Select an item'}</p>
                            {selectedPrintItem && <p className="text-[10px] text-slate-400">SKU: {selectedPrintItem.sku}</p>}
                          </div>
                        ) : (
                          <div>
                            <span className="material-symbols-outlined text-3xl text-slate-300 mb-1">inventory</span>
                            <p className="text-sm font-bold text-slate-600">{selectedPrintItem?.name || printLabelText || 'Select an item'}</p>
                            {selectedPrintItem && (
                              <>
                                <p className="text-[10px] text-slate-400 mt-1">SKU: {selectedPrintItem.sku}</p>
                                <p className="text-[10px] text-slate-400">Category: {selectedPrintItem.category}</p>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setPrintSent(true)}
                      disabled={!printLabelText.trim()}
                      className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">print</span>
                      Print {printLabelQty} Label{printLabelQty > 1 ? 's' : ''}
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showScanQRModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => { setShowScanQRModal(false); setScanResult(''); }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Scan QR / Barcode</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Add item to checkout</p>
                </div>
                <button onClick={() => { setShowScanQRModal(false); setScanResult(''); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 space-y-6">
                <div className="bg-slate-900 rounded-2xl p-8 flex flex-col items-center justify-center">
                  <span className="material-symbols-outlined text-5xl text-teal-400 mb-2">qr_code_scanner</span>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Camera scanner ready</p>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Enter barcode / SKU</label>
                  <input
                    value={scanResult}
                    onChange={(e) => setScanResult(e.target.value)}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    placeholder="Scan or type SKU..."
                  />
                </div>
                {scanResult.trim() && (() => {
                  const query = scanResult.toLowerCase().trim();
                  const exactSku = approvedStockItems.filter(si => si.sku.toLowerCase() === query);
                  const partialMatches = approvedStockItems.filter(si =>
                    si.sku.toLowerCase() !== query && (
                      si.sku.toLowerCase().includes(query) ||
                      si.name.toLowerCase().includes(query)
                    )
                  );
                  const matches = [...exactSku, ...partialMatches];
                  return matches.length > 0 ? (
                    <div className="space-y-2">
                      {matches.slice(0, 5).map((si, idx) => (
                        <button key={si.id} onClick={() => {
                          setShowScanQRModal(false);
                          setScanResult('');
                          navigate('/sales', { state: { addToCart: { id: si.id, name: si.name, description: `SKU: ${si.sku}`, price: si.price, icon: si.category === 'Parts' ? 'build' : 'cable', type: 'product' } } });
                        }} className={`w-full p-4 rounded-2xl text-left transition-all group flex items-center justify-between ${idx === 0 && exactSku.length > 0 ? 'bg-teal-50 border-2 border-teal-200 hover:bg-teal-100' : 'bg-slate-50 hover:bg-primary hover:text-white'}`}>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-sm">{si.name}</p>
                              {idx === 0 && exactSku.length > 0 && <span className="text-[8px] font-black bg-teal-600 text-white px-1.5 py-0.5 rounded uppercase">Exact Match</span>}
                            </div>
                            <p className="text-[10px] opacity-60">SKU: {si.sku} · {si.qty} in stock</p>
                          </div>
                          <div className="text-right">
                            <p className="font-black text-sm">${si.price.toFixed(2)}</p>
                            <p className="text-[10px] font-bold opacity-60 flex items-center gap-1 justify-end"><span className="material-symbols-outlined text-xs">add_shopping_cart</span> Add</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-sm text-slate-400 py-4">No matching items in inventory</p>
                  );
                })()}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddStockModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => { setShowAddStockModal(false); setStockSaved(false); setLastAddedStock(null); }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Quick Add Stock</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Add inventory from the counter</p>
                </div>
                <button onClick={() => { setShowAddStockModal(false); setStockSaved(false); setLastAddedStock(null); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8">
                {stockSaved ? (
                  <div className="py-8 text-center space-y-4">
                    <div className="w-16 h-16 bg-lime-100 rounded-full flex items-center justify-center mx-auto">
                      <span className="material-symbols-outlined text-3xl text-lime-600" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
                    </div>
                    <p className="text-lg font-black text-primary">{lastAddedStock?.status === 'approved' ? 'Added to Inventory' : 'Submitted for Approval'}</p>
                    {lastAddedStock && (
                      <div className="bg-slate-50 rounded-2xl p-4 text-left space-y-1">
                        <p className="text-sm font-bold text-slate-700">{lastAddedStock.name}</p>
                        <p className="text-[10px] text-slate-400">SKU: {lastAddedStock.sku} · Qty: {lastAddedStock.qty}</p>
                        <p className="text-[10px] text-slate-400">Cost: ${lastAddedStock.cost.toFixed(2)} · Sell: ${lastAddedStock.price.toFixed(2)}</p>
                      </div>
                    )}
                    <p className="text-[10px] font-bold" style={{color: lastAddedStock?.status === 'approved' ? '#0d9488' : '#d97706'}}>{lastAddedStock?.status === 'approved' ? 'Now available in POS Add Item catalog' : 'Pending manager approval before appearing in POS'}</p>
                    <button onClick={() => { setShowAddStockModal(false); setStockSaved(false); setLastAddedStock(null); setDashStockName(''); setDashStockSku(''); setDashStockQty('1'); setDashStockCost(''); setDashStockPrice(''); setDashStockCategory('Parts'); }} className="px-8 py-3 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest">Done</button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Product Name *</label>
                      <input value={dashStockName} onChange={(e) => setDashStockName(e.target.value)} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="iPhone 13 Screen" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">SKU</label>
                        <input value={dashStockSku} onChange={(e) => setDashStockSku(e.target.value)} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="IP13-SCR-001" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Quantity</label>
                        <input value={dashStockQty} onChange={(e) => setDashStockQty(e.target.value)} type="number" min="1" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Cost Price</label>
                        <input value={dashStockCost} onChange={(e) => setDashStockCost(e.target.value)} type="number" step="0.01" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="0.00" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Sell Price</label>
                        <input value={dashStockPrice} onChange={(e) => setDashStockPrice(e.target.value)} type="number" step="0.01" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="0.00" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Category</label>
                        <select value={dashStockCategory} onChange={(e) => setDashStockCategory(e.target.value)} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                          <option>Parts</option>
                          <option>Accessories</option>
                          <option>Devices</option>
                          <option>Other</option>
                        </select>
                      </div>
                    </div>
                    {hasInventoryPermission ? (
                      <button type="button" disabled={!dashStockName.trim()} onClick={() => {
                        const item: StockItem = {
                          id: `stk-${Date.now()}`,
                          name: dashStockName.trim(),
                          sku: dashStockSku || `SKU-${Date.now().toString().slice(-6)}`,
                          qty: parseInt(dashStockQty) || 1,
                          cost: parseFloat(dashStockCost) || 0,
                          price: parseFloat(dashStockPrice) || 0,
                          category: dashStockCategory,
                          addedAt: new Date().toISOString(),
                          status: 'approved',
                        };
                        addStockItem(item);
                        setLastAddedStock(item);
                        setStockSaved(true);
                      }} className="w-full py-4 bg-primary text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg hover:bg-primary/90 transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
                        <span className="material-symbols-outlined text-sm">inventory_2</span>
                        Add to Inventory
                      </button>
                    ) : (
                      <button type="button" disabled={!dashStockName.trim()} onClick={() => {
                        const item: StockItem = {
                          id: `stk-${Date.now()}`,
                          name: dashStockName.trim(),
                          sku: dashStockSku || `SKU-${Date.now().toString().slice(-6)}`,
                          qty: parseInt(dashStockQty) || 1,
                          cost: parseFloat(dashStockCost) || 0,
                          price: parseFloat(dashStockPrice) || 0,
                          category: dashStockCategory,
                          addedAt: new Date().toISOString(),
                          status: 'pending_approval',
                        };
                        addStockItem(item);
                        setLastAddedStock(item);
                        setStockSaved(true);
                      }} className="w-full py-4 bg-amber-500 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg hover:bg-amber-600 transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
                        <span className="material-symbols-outlined text-sm">pending_actions</span>
                        Submit for Approval
                      </button>
                    )}
                    <p className="text-[9px] text-center text-slate-400">{hasInventoryPermission ? 'Item will be immediately available in POS catalog.' : 'Item will be sent to manager for approval before appearing in POS.'}</p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showQuickIntakeModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => { setShowQuickIntakeModal(false); setIntakeValidationError(''); }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Quick Repair Intake</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Device check-in from dashboard</p>
                </div>
                <button onClick={() => { setShowQuickIntakeModal(false); setIntakeValidationError(''); setIntakeDetails({ imei: '', serialNumber: '', passcode: '', network: '' }); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8">
                <div className="grid grid-cols-2 gap-6 mb-6">
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Device Identity</label>
                      <input value={intakeDetails.imei} onChange={(e) => setIntakeDetails({...intakeDetails, imei: e.target.value})} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="IMEI Number" type="text" />
                    </div>
                    <input value={intakeDetails.serialNumber} onChange={(e) => setIntakeDetails({...intakeDetails, serialNumber: e.target.value})} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="Serial Number" type="text" />
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Security</label>
                      <input value={intakeDetails.passcode} onChange={(e) => setIntakeDetails({...intakeDetails, passcode: e.target.value})} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="Passcode / PIN" type="text" />
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Network & Carrier</label>
                      <select value={intakeDetails.network} onChange={(e) => setIntakeDetails({...intakeDetails, network: e.target.value})} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/20">
                        <option value="">Select Network</option>
                        <option>Verizon</option>
                        <option>AT&T</option>
                        <option>T-Mobile</option>
                        <option>Unlocked</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Custom Fields</label>
                      <input className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold mb-2 focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="Color" type="text" />
                      <input className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="Condition" type="text" />
                    </div>
                  </div>
                </div>
                {intakeValidationError && (
                  <div className="flex items-center gap-2 p-3 bg-rose-50 border border-rose-200 rounded-xl mb-4">
                    <span className="material-symbols-outlined text-rose-500 text-sm">error</span>
                    <p className="text-xs font-bold text-rose-600">{intakeValidationError}</p>
                  </div>
                )}
                <button onClick={() => {
                  if (!intakeDetails.imei || !intakeDetails.passcode || !intakeDetails.network) {
                    setIntakeValidationError('IMEI, Passcode, and Network are mandatory for repair tickets.');
                    return;
                  }
                  setIntakeValidationError('');
                  const repairItem = {
                    id: `QR-${Date.now()}`,
                    name: 'Quick Check-in Repair',
                    description: 'Standard diagnostic & repair',
                    price: 0,
                    icon: 'bolt',
                    type: 'repair' as const,
                    imei: intakeDetails.imei,
                    serialNumber: intakeDetails.serialNumber,
                    passcode: intakeDetails.passcode,
                    network: intakeDetails.network,
                  };
                  setShowQuickIntakeModal(false);
                  setIntakeDetails({ imei: '', serialNumber: '', passcode: '', network: '' });
                  navigate('/sales', { state: { autoRepairItem: repairItem } });
                }} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase tracking-[0.2em] shadow-lg shadow-secondary/20 active:scale-95 transition-all flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-sm">bolt</span>
                  Finalize Intake & Open Checkout
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showNewCustomerModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => { setShowNewCustomerModal(false); setCustomerSaved(false); }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">New Customer</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Create a customer record</p>
                </div>
                <button onClick={() => { setShowNewCustomerModal(false); setCustomerSaved(false); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8">
                {customerSaved ? (
                  <div className="py-8 text-center space-y-4">
                    <div className="w-16 h-16 bg-lime-100 rounded-full flex items-center justify-center mx-auto">
                      <span className="material-symbols-outlined text-3xl text-lime-600" style={{fontVariationSettings: "'FILL' 1"}}>person_add</span>
                    </div>
                    <p className="text-lg font-black text-primary">Customer Created</p>
                    <button onClick={() => { setShowNewCustomerModal(false); setCustomerSaved(false); }} className="px-8 py-3 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest">Done</button>
                  </div>
                ) : (
                  <form onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const newCust: Customer = {
                      id: `c-${Date.now()}`,
                      name: `${fd.get('firstName')} ${fd.get('lastName')}`,
                      phone: fd.get('phone') as string || '',
                      email: fd.get('email') as string || '',
                      totalSpent: 0,
                      lastVisit: '',
                      loyaltyPoints: 0,
                    };
                    addCustomer(newCust);
                    setCustomerSaved(true);
                  }} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">First Name</label>
                        <input name="firstName" required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="John" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Last Name</label>
                        <input name="lastName" required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="Doe" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Phone</label>
                      <input name="phone" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="555-0000" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Email</label>
                      <input name="email" type="email" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="john@example.com" />
                    </div>
                    <button type="submit" className="w-full py-4 bg-secondary text-white font-black text-sm rounded-2xl shadow-lg shadow-secondary/20 uppercase tracking-widest hover:bg-secondary/90 transition-all flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined text-sm">person_add</span>
                      Create Customer
                    </button>
                  </form>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showHeldOrdersModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => setShowHeldOrdersModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Held Orders</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{heldOrders.length} order{heldOrders.length !== 1 ? 's' : ''} on hold</p>
                </div>
                <button onClick={() => setShowHeldOrdersModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8">
                {heldOrders.length === 0 ? (
                  <div className="py-12 text-center">
                    <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                      <span className="material-symbols-outlined text-3xl text-slate-300">pause_circle</span>
                    </div>
                    <p className="text-sm font-bold text-slate-400">No held orders</p>
                    <p className="text-xs text-slate-300 mt-1">Hold a sale from the POS to suspend it for later</p>
                  </div>
                ) : (
                  <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
                    {heldOrders.map(order => (
                      <div key={order.id} className="p-6 bg-slate-50 rounded-3xl border border-slate-100 hover:bg-white hover:shadow-lg transition-all">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-slate-900">{order.id}</p>
                              <span className="text-[9px] font-black px-2 py-0.5 rounded uppercase bg-amber-100 text-amber-700">Held</span>
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5">{order.customerName} &bull; {new Date(order.createdAt).toLocaleString()}</p>
                          </div>
                          <p className="text-lg font-black text-primary">${order.total.toFixed(2)}</p>
                        </div>
                        <div className="flex flex-wrap gap-2 mb-4">
                          {order.items.map((item, idx) => (
                            <span key={idx} className="text-[10px] font-bold bg-white px-2 py-1 rounded-lg border border-slate-100 text-slate-600">{item.name}</span>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => {
                            setShowHeldOrdersModal(false);
                            navigate('/sales', { state: { resumeHeldOrderId: order.id } });
                          }} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2">
                            <span className="material-symbols-outlined text-sm">play_arrow</span>
                            Resume in POS
                          </button>
                          <button onClick={() => removeHeldOrder(order.id)} className="py-3 px-4 bg-slate-100 text-slate-500 rounded-xl hover:bg-red-50 hover:text-red-500 transition-all">
                            <span className="material-symbols-outlined text-sm">delete</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
