import React, { useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  tenants, tenantUsage, tenantUsagePrior, plans, featureMatrix, billingTransactions,
  invoiceHistory, creditNotes, auditLogs, addOns, tenantFeatureOverrides,
  tenantSupportNotes, tenantDomainHistory, planHistory,
} from './mockData';
import type { SupportNoteCategory, FeatureOverrideType } from './mockData';
import { tenantUsers } from './accessMockData';

type Tab = 'Overview' | 'Owner & Users' | 'Subscription' | 'Features' | 'Billing' | 'Domains' | 'Usage' | 'Activity / Audit' | 'Support Notes';

const TenantDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const tenant = tenants.find(t => t.id === id);
  const [activeTab, setActiveTab] = useState<Tab>('Overview');
  const [noteInput, setNoteInput] = useState('');
  const [noteCategory, setNoteCategory] = useState<SupportNoteCategory>('general');
  const [noteAssignee, setNoteAssignee] = useState('');
  const [noteFollowUp, setNoteFollowUp] = useState('');
  const [localNotes, setLocalNotes] = useState<typeof tenantSupportNotes>([]);
  const [inviteModal, setInviteModal] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('technician');
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [userDetailId, setUserDetailId] = useState<string | null>(null);
  const [planChangeModal, setPlanChangeModal] = useState<string | null>(null);
  const [trialExtendModal, setTrialExtendModal] = useState(false);
  const [trialDays, setTrialDays] = useState('7');
  const [auditCategoryFilter, setAuditCategoryFilter] = useState('all');
  const [auditActorFilter, setAuditActorFilter] = useState('all');
  const [supportCategoryFilter, setSupportCategoryFilter] = useState<string>('all');
  const [copiedDns, setCopiedDns] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState('');

  if (!tenant) return (
    <div className="text-center py-20">
      <p className="text-xl font-black text-slate-400">Tenant not found</p>
      <button onClick={() => navigate('/owner/tenants')} className="mt-4 px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest">Back to Tenants</button>
    </div>
  );

  const plan = plans.find(p => p.id === tenant.plan);
  const usage = tenantUsage.find(u => u.tenantId === tenant.id);
  const priorUsage = tenantUsagePrior.find(u => u.tenantId === tenant.id);
  const scopedUsers = tenantUsers.filter(u => u.tenantId === tenant.id);
  const tenantTx = billingTransactions.filter(tx => tx.tenantId === tenant.id);
  const tenantInv = invoiceHistory.filter(i => i.tenantId === tenant.id);
  const tenantCredits = creditNotes.filter(c => c.tenantId === tenant.id);
  const tenantLogs = auditLogs.filter(l => l.tenantId === tenant.id);
  const tenantAddOns = addOns.filter(a => a.lifecycle === 'active' && a.compatiblePlans.includes(tenant.plan));
  const tenantOverrides = tenantFeatureOverrides.filter(o => o.tenantId === tenant.id);
  const supportNotes = [...tenantSupportNotes.filter(n => n.tenantId === tenant.id), ...localNotes];
  const domainHistory = tenantDomainHistory.filter(d => d.tenantId === tenant.id);
  const tenantPlanHistory = planHistory.filter(ph => ph.tenantId === tenant.id);

  const accountBalance = useMemo(() => {
    const totalBilled = tenantInv.reduce((s, i) => s + i.total, 0);
    const totalPaid = tenantTx.filter(tx => tx.status === 'paid').reduce((s, tx) => s + tx.amount, 0);
    const appliedCredits = tenantCredits.filter(c => c.status === 'applied').reduce((s, c) => s + c.appliedAmount, 0);
    const unappliedCredits = tenantCredits.filter(c => c.status === 'pending').reduce((s, c) => s + c.amount, 0);
    return { totalBilled, totalPaid, appliedCredits, unappliedCredits, balance: totalBilled - totalPaid - appliedCredits };
  }, [tenantInv, tenantTx, tenantCredits]);

  const healthScore = useMemo(() => {
    let score = 100;
    if (tenant.status === 'overdue') score -= 30;
    if (tenant.status === 'suspended') score -= 50;
    if (usage) {
      if (usage.seatsAllowed > 0 && usage.seatsUsed / usage.seatsAllowed >= 0.95) score -= 10;
      if (usage.apiLimit > 0 && usage.apiCalls / usage.apiLimit >= 0.9) score -= 10;
      if (usage.smsLimit > 0 && usage.smsUsed / usage.smsLimit >= 0.9) score -= 5;
      if (usage.storageLimitMb > 0 && usage.storageMb / usage.storageLimitMb >= 0.9) score -= 5;
    }
    const failedTx = tenantTx.filter(tx => tx.status === 'failed');
    if (failedTx.length > 0) score -= 15;
    if (tenant.ssl !== 'active') score -= 5;
    if (tenant.verification !== 'verified') score -= 5;
    return Math.max(0, Math.min(100, score));
  }, [tenant, usage, tenantTx]);

  const daysUntilRenewal = useMemo(() => {
    const today = new Date('2026-03-26');
    const renewal = new Date(tenant.renewal);
    return Math.ceil((renewal.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  }, [tenant.renewal]);

  const tabs: Tab[] = ['Overview', 'Owner & Users', 'Subscription', 'Features', 'Billing', 'Domains', 'Usage', 'Activity / Audit', 'Support Notes'];

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      trialing: 'bg-indigo-400/10 text-indigo-700 border-indigo-200',
      overdue: 'bg-red-400/10 text-red-700 border-red-400/20',
      suspended: 'bg-slate-400/10 text-slate-500 border-slate-200',
      paid: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      failed: 'bg-red-400/10 text-red-700 border-red-400/20',
      refunded: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      void: 'bg-slate-400/10 text-slate-500 border-slate-200',
      pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      verified: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      invited: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      applied: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      inherited: 'bg-slate-400/10 text-slate-500 border-slate-200',
      overridden: 'bg-violet-400/10 text-violet-700 border-violet-200',
      trial: 'bg-indigo-400/10 text-indigo-700 border-indigo-200',
      disabled: 'bg-red-400/10 text-red-700 border-red-400/20',
      addon: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      upgrade: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      new: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      trial_start: 'bg-indigo-400/10 text-indigo-700 border-indigo-200',
      suspension: 'bg-red-400/10 text-red-700 border-red-400/20',
      warning: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      info: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      general: 'bg-slate-400/10 text-slate-500 border-slate-200',
      billing: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      technical: 'bg-red-400/10 text-red-700 border-red-400/20',
      escalation: 'bg-red-400/10 text-red-700 border-red-400/20',
      onboarding: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
    };
    return <span className={`px-2.5 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg border ${styles[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>{status}</span>;
  };

  const usageBar = (used: number, limit: number) => {
    if (limit === 0) return <span className="text-[10px] text-slate-400 font-bold">N/A</span>;
    const pct = Math.round((used / limit) * 100);
    const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-lime-500';
    return (
      <div className="flex items-center gap-2">
        <div className="w-20 h-1.5 bg-slate-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
        <span className={`text-[10px] font-black ${pct >= 90 ? 'text-red-500' : 'text-slate-500'}`}>{pct}%</span>
      </div>
    );
  };

  const trendArrow = (current: number, previous: number) => {
    if (previous === 0 && current === 0) return <span className="text-[10px] text-slate-400 font-bold">—</span>;
    if (previous === 0) return <span className="text-[10px] text-lime-600 font-black flex items-center gap-0.5"><span className="material-symbols-outlined text-xs">trending_up</span>New</span>;
    const pctChange = Math.round(((current - previous) / previous) * 100);
    if (pctChange === 0) return <span className="text-[10px] text-slate-400 font-bold">0%</span>;
    return (
      <span className={`text-[10px] font-black flex items-center gap-0.5 ${pctChange > 0 ? 'text-lime-600' : 'text-red-500'}`}>
        <span className="material-symbols-outlined text-xs">{pctChange > 0 ? 'trending_up' : 'trending_down'}</span>
        {pctChange > 0 ? '+' : ''}{pctChange}%
      </span>
    );
  };

  const healthColor = healthScore >= 80 ? 'text-lime-600' : healthScore >= 50 ? 'text-amber-600' : 'text-red-600';
  const healthBg = healthScore >= 80 ? 'bg-lime-50 border-lime-100' : healthScore >= 50 ? 'bg-amber-50 border-amber-100' : 'bg-red-50 border-red-100';

  const inputClass = "w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary";
  const labelClass = "text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2";

  const dnsRecords = tenant.customDomain ? [
    { type: 'CNAME', name: tenant.customDomain, value: `${tenant.subdomain}.repairplatform.com`, ttl: '3600' },
    { type: 'TXT', name: `_verify.${tenant.customDomain}`, value: `rp-verify=${tenant.id}`, ttl: '3600' },
  ] : [];

  const copyToClipboard = (text: string, id: string) => {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedDns(id);
    setTimeout(() => setCopiedDns(null), 2000);
  };

  const getFeatureState = (featureId: string): { type: FeatureOverrideType; trialEnd?: string } => {
    const override = tenantOverrides.find(o => o.featureId === featureId);
    if (override) return { type: override.type, trialEnd: override.trialEnd };
    const feature = featureMatrix.find(f => f.id === featureId);
    if (feature && feature.planAvailability[tenant.plan]) return { type: 'inherited' };
    return { type: 'disabled' };
  };

  const pinnedNotes = supportNotes.filter(n => n.pinned);
  const unpinnedNotes = supportNotes.filter(n => !n.pinned);
  const filteredSupportNotes = supportCategoryFilter === 'all' ? [...pinnedNotes, ...unpinnedNotes] : [...pinnedNotes.filter(n => n.category === supportCategoryFilter), ...unpinnedNotes.filter(n => n.category === supportCategoryFilter)];

  const filteredLogs = useMemo(() => {
    let logs = [...tenantLogs];
    if (auditCategoryFilter !== 'all') logs = logs.filter(l => l.category === auditCategoryFilter);
    if (auditActorFilter !== 'all') logs = logs.filter(l => l.actor === auditActorFilter);
    return logs;
  }, [tenantLogs, auditCategoryFilter, auditActorFilter]);

  const auditCategories = [...new Set(tenantLogs.map(l => l.category))];
  const auditActors = [...new Set(tenantLogs.map(l => l.actor))];

  const selectedUserDetail = userDetailId ? tenantUsers.find(u => u.id === userDetailId) : null;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/owner/tenants')} className="w-10 h-10 flex items-center justify-center rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 transition-all">
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-black text-primary tracking-tight">{tenant.name}</h2>
              {statusBadge(tenant.status)}
              <div className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border ${healthBg}`}>
                <span className={`material-symbols-outlined text-xs ${healthColor}`}>monitor_heart</span>
                <span className={`text-[9px] font-black ${healthColor}`}>{healthScore}</span>
              </div>
            </div>
            <p className="text-slate-500 font-medium text-sm">{tenant.id} · {tenant.owner.email} · {tenant.plan} plan</p>
          </div>
        </div>
        <div className="flex gap-2">
          {tenant.status === 'overdue' && <button className="px-4 py-2.5 bg-red-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-600 transition-all active:scale-95">Suspend</button>}
          {tenant.status === 'suspended' && <button className="px-4 py-2.5 bg-lime-600 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-lime-700 transition-all active:scale-95">Reactivate</button>}
          {tenant.status === 'trialing' && <button className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95">Convert to Paid</button>}
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all whitespace-nowrap ${activeTab === tab ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'bg-white/80 text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
        {activeTab === 'Overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className={`p-4 rounded-xl border ${healthBg}`}>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Health Score</p>
                <p className={`text-2xl font-black ${healthColor}`}>{healthScore}</p>
                <p className="text-[10px] text-slate-400">{healthScore >= 80 ? 'Healthy' : healthScore >= 50 ? 'Needs Attention' : 'Critical'}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Plan</p>
                <p className="font-black text-primary capitalize">{tenant.plan}</p>
                <p className="text-[10px] text-slate-400">{plan ? `$${plan.price}/mo` : ''}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">MRR</p>
                <p className="font-black text-primary">${tenant.mrr}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Renewal</p>
                <p className="font-black text-slate-900">{tenant.renewal}</p>
                <p className={`text-[10px] font-bold ${daysUntilRenewal <= 7 ? 'text-red-500' : daysUntilRenewal <= 30 ? 'text-amber-600' : 'text-slate-400'}`}>
                  {daysUntilRenewal > 0 ? `${daysUntilRenewal} days` : daysUntilRenewal === 0 ? 'Today' : `${Math.abs(daysUntilRenewal)}d overdue`}
                </p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Balance</p>
                <p className={`font-black ${accountBalance.balance > 0 ? 'text-red-500' : 'text-lime-600'}`}>${accountBalance.balance.toFixed(2)}</p>
                {accountBalance.unappliedCredits > 0 && <p className="text-[10px] text-violet-600 font-bold">${accountBalance.unappliedCredits.toFixed(2)} credit</p>}
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Seats</p>
                <p className={`font-black ${tenant.seatsUsed >= tenant.seatsAllowed ? 'text-red-500' : 'text-slate-900'}`}>{tenant.seatsUsed}/{tenant.seatsAllowed}</p>
                {usageBar(tenant.seatsUsed, tenant.seatsAllowed)}
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Locations</p>
                <p className="font-black text-slate-900">{tenant.locationsUsed}/{tenant.locationsAllowed}</p>
                {usageBar(tenant.locationsUsed, tenant.locationsAllowed)}
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Domain</p>
                <p className="font-bold text-slate-900 text-sm">{tenant.customDomain || `${tenant.subdomain}.repairplatform.com`}</p>
                <div className="flex gap-1 mt-1">
                  {statusBadge(tenant.ssl === 'active' ? 'active' : tenant.ssl)}
                  {statusBadge(tenant.verification === 'verified' ? 'verified' : tenant.verification)}
                </div>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Onboarded</p>
                <p className="font-black text-slate-900">{tenant.onboardedDate}</p>
              </div>
            </div>

            {tenant.flags.length > 0 && (
              <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2 flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">flag</span> Flags
                </p>
                <div className="flex gap-2 flex-wrap">
                  {tenant.flags.map((f, i) => <span key={i} className="px-2.5 py-1 bg-amber-400/10 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-lg border border-amber-400/20">{f}</span>)}
                </div>
              </div>
            )}

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Recent Activity</p>
              <div className="space-y-2">
                {tenantLogs.slice(0, 5).map(log => (
                  <div key={log.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <span className={`material-symbols-outlined text-sm ${log.severity === 'warning' ? 'text-amber-500' : 'text-blue-400'}`}>
                      {log.severity === 'warning' ? 'warning' : 'info'}
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-bold text-slate-900">{log.action}</p>
                      <p className="text-[10px] text-slate-400">{log.actor} · {log.date}</p>
                    </div>
                    {statusBadge(log.category)}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              <button onClick={() => setActiveTab('Billing')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">receipt_long</span> View Billing
              </button>
              <button onClick={() => setActiveTab('Usage')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">analytics</span> View Usage
              </button>
              <button onClick={() => setActiveTab('Support Notes')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">support_agent</span> Support Notes
              </button>
              <button onClick={() => setActiveTab('Features')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">tune</span> Features
              </button>
            </div>
          </div>
        )}

        {activeTab === 'Owner & Users' && (
          <div className="space-y-6">
            <button type="button" className="w-full bg-slate-50 p-5 rounded-2xl border border-slate-100 flex justify-between items-center cursor-pointer hover:bg-slate-100 transition-colors text-left" onClick={() => setUserDetailId(scopedUsers.find(u => u.role === 'store_owner')?.id || null)}>
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Store Owner</p>
                <p className="font-bold text-slate-900">{tenant.owner.name}</p>
                <p className="text-sm text-slate-500">{tenant.owner.email}</p>
              </div>
              <div className="flex items-center gap-3">
                {statusBadge('active')}
                <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
              </div>
            </button>

            <div className="flex justify-between items-center">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Team Members ({scopedUsers.length})</p>
              <button onClick={() => setInviteModal(true)} className="px-4 py-2 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">person_add</span> Invite User
              </button>
            </div>

            <div className="space-y-2">
              {scopedUsers.length === 0 && <p className="text-sm text-slate-400 font-bold py-4">No team members for this tenant.</p>}
              {scopedUsers.map(user => (
                <button type="button" key={user.id} className="w-full flex justify-between items-center p-4 bg-slate-50 rounded-xl border border-slate-100 cursor-pointer hover:bg-slate-100 transition-colors text-left" onClick={() => setUserDetailId(user.id)}>
                  <div>
                    <p className="font-bold text-slate-900">{user.name}</p>
                    <p className="text-[10px] text-slate-400">{user.email}</p>
                    {user.lastActive && <p className="text-[10px] text-slate-400">Last active: {user.lastActive}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-slate-600 capitalize">{user.role.replace('_', ' ')}</span>
                    {statusBadge(user.status)}
                    <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                  </div>
                </button>
              ))}
            </div>

            <AnimatePresence>
              {selectedUserDetail && (
                <div role="dialog" aria-modal="true" aria-label="User Detail" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setUserDetailId(null)} onKeyDown={e => { if (e.key === 'Escape') setUserDetailId(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">{selectedUserDetail.name}</h3>
                      <p className="text-sm text-slate-500 mt-1">{selectedUserDetail.email}</p>
                    </div>
                    <div className="p-8 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className={labelClass}>Role</p>
                          <p className="font-bold text-slate-900 capitalize">{selectedUserDetail.role.replace('_', ' ')}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Status</p>
                          {statusBadge(selectedUserDetail.status)}
                        </div>
                        <div>
                          <p className={labelClass}>Last Active</p>
                          <p className="font-bold text-slate-900 text-sm">{selectedUserDetail.lastActive || 'Never'}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Phone</p>
                          <p className="font-bold text-slate-900 text-sm">{selectedUserDetail.phone || '—'}</p>
                        </div>
                      </div>
                      {selectedUserDetail.notes && (
                        <div>
                          <p className={labelClass}>Notes</p>
                          <p className="text-sm text-slate-600">{selectedUserDetail.notes}</p>
                        </div>
                      )}
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3 flex-wrap">
                      {selectedUserDetail.status === 'invited' && (
                        <button className="px-4 py-2.5 bg-blue-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-blue-600 transition-all">Resend Invite</button>
                      )}
                      {selectedUserDetail.status === 'active' && selectedUserDetail.role !== 'store_owner' && (
                        <button className="px-4 py-2.5 bg-red-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-600 transition-all">Deactivate</button>
                      )}
                      <button onClick={() => setUserDetailId(null)} className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all ml-auto">Close</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {inviteModal && (
                <div role="dialog" aria-modal="true" aria-label="Invite User" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setInviteModal(false)} onKeyDown={e => { if (e.key === 'Escape') setInviteModal(false); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Invite User</h3>
                      <p className="text-sm text-slate-500 mt-1">Invite a team member to {tenant.name}.</p>
                    </div>
                    <div className="p-8 space-y-5">
                      <div>
                        <label htmlFor="invite-name" className={labelClass}>Name</label>
                        <input id="invite-name" value={inviteName} onChange={e => setInviteName(e.target.value)} className={inputClass} placeholder="Full name" />
                      </div>
                      <div>
                        <label htmlFor="invite-email" className={labelClass}>Email</label>
                        <input id="invite-email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} className={inputClass} placeholder="user@business.com" type="email" />
                      </div>
                      <div>
                        <label htmlFor="invite-role" className={labelClass}>Role</label>
                        <select id="invite-role" value={inviteRole} onChange={e => setInviteRole(e.target.value)} className={inputClass}>
                          <option value="technician">Technician</option>
                          <option value="manager">Manager</option>
                          <option value="sales_staff">Sales Staff</option>
                        </select>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => { setInviteModal(false); setInviteName(''); setInviteEmail(''); }} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button disabled={!inviteName || !inviteEmail.includes('@')} onClick={() => { setInviteModal(false); setInviteSuccess(`Invitation sent to ${inviteEmail}`); setInviteName(''); setInviteEmail(''); setTimeout(() => setInviteSuccess(null), 3000); }} className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90">Send Invite</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          </div>
        )}

        {activeTab === 'Subscription' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-primary/5 rounded-xl border border-primary/10">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Current Plan</p>
                <p className="font-black text-primary text-lg capitalize">{tenant.plan}</p>
                <p className="text-[10px] text-slate-400">${tenant.mrr}/mo</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Billing Cycle</p>
                <p className="font-black text-slate-900 capitalize">{tenant.billingCycle}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Next Renewal</p>
                <p className="font-black text-slate-900">{tenant.renewal}</p>
                <p className={`text-[10px] font-bold ${daysUntilRenewal <= 7 ? 'text-red-500' : 'text-slate-400'}`}>{daysUntilRenewal > 0 ? `${daysUntilRenewal} days` : 'Overdue'}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Status</p>
                {statusBadge(tenant.status)}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Plan Limits</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-sm font-bold text-slate-600">Seats</span>
                  <div className="flex items-center gap-2">
                    <span className={`font-black ${tenant.seatsUsed >= tenant.seatsAllowed ? 'text-red-500' : 'text-slate-900'}`}>{tenant.seatsUsed} / {tenant.seatsAllowed}</span>
                    {tenant.seatsUsed >= tenant.seatsAllowed && <span className="text-[8px] font-black text-red-500 bg-red-50 px-1.5 py-0.5 rounded uppercase">At Limit</span>}
                  </div>
                </div>
                <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-sm font-bold text-slate-600">Locations</span>
                  <span className="font-black text-slate-900">{tenant.locationsUsed} / {tenant.locationsAllowed}</span>
                </div>
              </div>
            </div>

            {tenant.status === 'trialing' && tenant.trialEnd && (
              <div className="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-[10px] font-black text-indigo-700 uppercase tracking-widest mb-1">Trial Period</p>
                    <p className="font-bold text-indigo-900">Expires {tenant.trialEnd}</p>
                    <p className="text-[10px] text-indigo-500">
                      {Math.ceil((new Date(tenant.trialEnd).getTime() - new Date('2026-03-26').getTime()) / (1000 * 60 * 60 * 24))} days remaining
                    </p>
                  </div>
                  <button onClick={() => setTrialExtendModal(true)} className="px-4 py-2 bg-indigo-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-indigo-600 transition-all">Extend Trial</button>
                </div>
              </div>
            )}

            {tenantAddOns.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Available Add-ons</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {tenantAddOns.map(addon => (
                    <div key={addon.id} className="flex justify-between items-center p-4 bg-slate-50 rounded-xl border border-slate-100">
                      <div>
                        <p className="font-bold text-slate-900">{addon.name}</p>
                        <p className="text-[10px] text-slate-400">{addon.description.slice(0, 60)}...</p>
                      </div>
                      <span className="font-black text-primary">${addon.price}/mo</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Change Plan</p>
              <div className="flex gap-2 flex-wrap">
                {plans.filter(p => p.id !== tenant.plan).map(p => {
                  const isUpgrade = plans.findIndex(pl => pl.id === p.id) > plans.findIndex(pl => pl.id === tenant.plan);
                  return (
                    <button key={p.id} onClick={() => setPlanChangeModal(p.id)} className={`px-4 py-2.5 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all ${isUpgrade ? 'bg-lime-500 hover:bg-lime-600 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}>
                      {isUpgrade ? 'Upgrade' : 'Downgrade'} to {p.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {tenantPlanHistory.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Plan History</p>
                <div className="space-y-2">
                  {tenantPlanHistory.map(ph => (
                    <div key={ph.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-sm text-slate-400">history</span>
                        <div>
                          <p className="font-bold text-slate-900 text-sm">{ph.fromPlan ? `${ph.fromPlan} → ${ph.toPlan}` : ph.toPlan}</p>
                          <p className="text-[10px] text-slate-400">{ph.date}</p>
                        </div>
                      </div>
                      {statusBadge(ph.type)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <AnimatePresence>
              {planChangeModal && (() => {
                const targetPlan = plans.find(p => p.id === planChangeModal);
                const isUp = plans.findIndex(pl => pl.id === planChangeModal) > plans.findIndex(pl => pl.id === tenant.plan);
                return (
                  <div role="dialog" aria-modal="true" aria-label="Plan Change" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setPlanChangeModal(null)} onKeyDown={e => { if (e.key === 'Escape') setPlanChangeModal(null); }}>
                    <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                      <div className="p-8 border-b border-slate-100">
                        <h3 className="text-xl font-black text-primary tracking-tight">{isUp ? 'Upgrade' : 'Downgrade'} Plan</h3>
                        <p className="text-sm text-slate-500 mt-1">{tenant.name}: {tenant.plan} → {targetPlan?.name}</p>
                      </div>
                      <div className="p-8 space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Current</p>
                            <p className="font-black text-slate-900 capitalize">{tenant.plan}</p>
                            <p className="text-sm text-slate-500">${tenant.mrr}/mo</p>
                          </div>
                          <div className={`p-4 rounded-xl border ${isUp ? 'bg-lime-50 border-lime-100' : 'bg-amber-50 border-amber-100'}`}>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">New</p>
                            <p className="font-black text-slate-900">{targetPlan?.name}</p>
                            <p className="text-sm text-slate-500">${targetPlan?.price}/mo</p>
                          </div>
                        </div>
                        <div className="p-3 bg-amber-50 rounded-xl border border-amber-100">
                          <p className="text-sm text-amber-700 font-bold">
                            {isUp ? 'Upgrade is effective immediately. Pro-rated charges will apply.' : 'Downgrade takes effect at next billing cycle. Features may be reduced.'}
                          </p>
                        </div>
                      </div>
                      <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                        <button onClick={() => setPlanChangeModal(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                        <button onClick={() => { setPlanChangeModal(null); setInviteSuccess(`Plan ${isUp ? 'upgraded' : 'downgraded'} to ${targetPlan?.name}`); setTimeout(() => setInviteSuccess(null), 3000); }} className={`flex-1 py-4 text-white font-black text-sm rounded-2xl shadow-lg uppercase tracking-widest transition-all ${isUp ? 'bg-lime-600 hover:bg-lime-700 shadow-lime-600/20' : 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/20'}`}>Confirm {isUp ? 'Upgrade' : 'Downgrade'}</button>
                      </div>
                    </motion.div>
                  </div>
                );
              })()}
            </AnimatePresence>

            <AnimatePresence>
              {trialExtendModal && (
                <div role="dialog" aria-modal="true" aria-label="Extend Trial" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setTrialExtendModal(false)} onKeyDown={e => { if (e.key === 'Escape') setTrialExtendModal(false); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Extend Trial</h3>
                      <p className="text-sm text-slate-500 mt-1">Extend the trial period for {tenant.name}.</p>
                    </div>
                    <div className="p-8 space-y-4">
                      <div>
                        <label htmlFor="trial-days" className={labelClass}>Extension Days</label>
                        <select id="trial-days" value={trialDays} onChange={e => setTrialDays(e.target.value)} className={inputClass}>
                          <option value="7">7 days</option>
                          <option value="14">14 days</option>
                          <option value="30">30 days</option>
                        </select>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => setTrialExtendModal(false)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button onClick={() => { setTrialExtendModal(false); setInviteSuccess(`Trial extended by ${trialDays} days`); setTimeout(() => setInviteSuccess(null), 3000); }} className="flex-1 py-4 bg-indigo-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-indigo-500/20 uppercase tracking-widest transition-all hover:bg-indigo-600">Extend</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          </div>
        )}

        {activeTab === 'Features' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Features for <span className="text-primary capitalize">{tenant.plan}</span> plan</p>
              <div className="flex gap-1.5 flex-wrap">
                {statusBadge('inherited')}
                {statusBadge('overridden')}
                {statusBadge('trial')}
                {statusBadge('addon')}
                {statusBadge('disabled')}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {featureMatrix.filter(f => f.lifecycle !== 'draft').map(feature => {
                const state = getFeatureState(feature.id);
                const enabled = state.type !== 'disabled';
                return (
                  <div key={feature.id} className={`p-4 rounded-xl border ${enabled ? 'bg-slate-50 border-slate-100' : 'bg-slate-50/50 border-slate-100/50'}`}>
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-3">
                        <span className={`material-symbols-outlined text-sm ${enabled ? 'text-lime-600' : 'text-slate-300'}`}>{enabled ? 'check_circle' : 'remove_circle_outline'}</span>
                        <div>
                          <span className={`font-bold ${enabled ? 'text-slate-900' : 'text-slate-400'}`}>{feature.name}</span>
                          {feature.lifecycle !== 'implemented' && (
                            <span className="ml-2 text-[8px] font-black text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded uppercase tracking-widest">{feature.lifecycle}</span>
                          )}
                          {state.trialEnd && <p className="text-[10px] text-indigo-500 font-bold">Trial until {state.trialEnd}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {statusBadge(state.type)}
                        {state.type === 'inherited' && !enabled && (
                          <button className="text-[8px] font-black text-primary bg-primary/5 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-primary/10 transition-colors">Enable</button>
                        )}
                        {state.type === 'disabled' && (
                          <button className="text-[8px] font-black text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-indigo-100 transition-colors">Trial</button>
                        )}
                        {state.type === 'overridden' && (
                          <button className="text-[8px] font-black text-red-500 bg-red-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-red-100 transition-colors">Revoke</button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {tenantOverrides.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 mt-4">Override History</p>
                <div className="space-y-2">
                  {tenantOverrides.map((o, i) => {
                    const f = featureMatrix.find(ft => ft.id === o.featureId);
                    return (
                      <div key={i} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <div>
                          <p className="font-bold text-slate-900 text-sm">{f?.name || o.featureId}</p>
                          <p className="text-[10px] text-slate-400">{o.addedBy} · {o.addedDate}{o.trialEnd ? ` · Trial until ${o.trialEnd}` : ''}</p>
                        </div>
                        {statusBadge(o.type)}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Billing' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Billed</p>
                <p className="text-lg font-black text-primary">${accountBalance.totalBilled.toFixed(2)}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Paid</p>
                <p className="text-lg font-black text-lime-600">${accountBalance.totalPaid.toFixed(2)}</p>
              </div>
              <div className={`p-4 rounded-xl border text-center ${accountBalance.balance > 0 ? 'bg-red-50 border-red-100' : 'bg-lime-50 border-lime-100'}`}>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Balance Due</p>
                <p className={`text-lg font-black ${accountBalance.balance > 0 ? 'text-red-600' : 'text-lime-600'}`}>${accountBalance.balance.toFixed(2)}</p>
              </div>
              <div className="p-4 bg-violet-50 rounded-xl border border-violet-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Unapplied Credits</p>
                <p className="text-lg font-black text-violet-600">${accountBalance.unappliedCredits.toFixed(2)}</p>
              </div>
            </div>

            {tenantTx.some(tx => tx.status === 'failed') && (
              <div className="p-4 bg-red-50 rounded-xl border border-red-100">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-red-500 text-sm">error</span>
                    <div>
                      <p className="text-[10px] font-black text-red-700 uppercase tracking-widest">Failed Payments</p>
                      <p className="text-sm font-bold text-red-600">{tenantTx.filter(tx => tx.status === 'failed').length} failed transaction(s)</p>
                    </div>
                  </div>
                  <button className="px-4 py-2 bg-red-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-600 transition-all">Retry Payment</button>
                </div>
              </div>
            )}

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Invoices</p>
              <div className="space-y-2">
                {tenantInv.length === 0 && <p className="text-sm text-slate-400 font-bold">No invoices.</p>}
                {tenantInv.map(inv => (
                  <div key={inv.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <div>
                      <p className="font-bold text-slate-900 text-sm">{inv.invoiceNo}</p>
                      <p className="text-[10px] text-slate-400">{inv.date} · {inv.plan} · Due {inv.dueDate}</p>
                      {inv.items.map((item, idx) => <p key={idx} className="text-[10px] text-slate-400">{item.description} × {item.qty}</p>)}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-black text-primary">${inv.total.toFixed(2)}</span>
                      {statusBadge(inv.status)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Transactions</p>
              <div className="space-y-2">
                {tenantTx.length === 0 && <p className="text-sm text-slate-400 font-bold">No transactions.</p>}
                {tenantTx.map(tx => (
                  <div key={tx.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <div>
                      <p className="font-bold text-slate-900 text-sm">{tx.invoiceNo}</p>
                      <p className="text-[10px] text-slate-400">{tx.date} · {tx.method} · {tx.type}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-black text-slate-900">${tx.amount}</span>
                      {statusBadge(tx.status)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {tenantCredits.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Credit Notes</p>
                <div className="space-y-2">
                  {tenantCredits.map(cr => (
                    <div key={cr.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <div>
                        <p className="font-bold text-slate-900 text-sm">{cr.creditNo}</p>
                        <p className="text-[10px] text-slate-400">{cr.date} · {cr.reason}</p>
                        <p className="text-[10px] text-slate-400">{cr.type} · {cr.appliedToInvoice ? `Applied to ${cr.appliedToInvoice}` : 'Unapplied'}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-black text-violet-600">${cr.amount.toFixed(2)}</span>
                        {statusBadge(cr.status)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button onClick={() => navigate('/owner/billing')} className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">open_in_new</span> Open Platform Billing
            </button>
          </div>
        )}

        {activeTab === 'Domains' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Subdomain</p>
                <p className="font-black text-primary text-lg">{tenant.subdomain}.repairplatform.com</p>
                <p className="text-[10px] text-slate-400 mt-1">Platform-managed subdomain</p>
              </div>
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Custom Domain</p>
                {tenant.customDomain ? (
                  <>
                    <p className="font-black text-primary text-lg">{tenant.customDomain}</p>
                    <p className="text-[10px] text-slate-400 mt-1">Tenant-owned domain</p>
                  </>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-slate-400 font-bold">No custom domain configured</p>
                    <div className="flex gap-2">
                      <input value={domainInput} onChange={e => setDomainInput(e.target.value)} className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="example.com" />
                      <button disabled={!domainInput.includes('.')} className="px-3 py-2 bg-primary text-white font-black text-[10px] rounded-lg uppercase tracking-widest disabled:opacity-40">Add</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">SSL Certificate</p>
                  {statusBadge(tenant.ssl)}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-sm ${tenant.ssl === 'active' ? 'text-lime-600' : tenant.ssl === 'pending' ? 'text-amber-500' : 'text-red-500'}`}>
                    {tenant.ssl === 'active' ? 'verified_user' : tenant.ssl === 'pending' ? 'hourglass_top' : 'gpp_bad'}
                  </span>
                  <p className="text-sm font-bold text-slate-600">
                    {tenant.ssl === 'active' ? 'SSL is active and valid' : tenant.ssl === 'pending' ? 'SSL certificate is being provisioned' : 'SSL certificate is inactive'}
                  </p>
                </div>
              </div>
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">DNS Verification</p>
                  {statusBadge(tenant.verification)}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-sm ${tenant.verification === 'verified' ? 'text-lime-600' : tenant.verification === 'pending' ? 'text-amber-500' : 'text-red-500'}`}>
                    {tenant.verification === 'verified' ? 'check_circle' : tenant.verification === 'pending' ? 'pending' : 'cancel'}
                  </span>
                  <p className="text-sm font-bold text-slate-600">
                    {tenant.verification === 'verified' ? 'DNS records verified' : tenant.verification === 'pending' ? 'Awaiting DNS propagation' : 'DNS verification failed'}
                  </p>
                </div>
              </div>
            </div>

            {tenant.customDomain && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Verification Checklist</p>
                <div className="space-y-2">
                  {[
                    { label: 'CNAME record points to platform', done: tenant.verification === 'verified' },
                    { label: 'TXT verification record added', done: tenant.verification === 'verified' },
                    { label: 'DNS propagation complete', done: tenant.verification === 'verified' },
                    { label: 'SSL certificate provisioned', done: tenant.ssl === 'active' },
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <span className={`material-symbols-outlined text-sm ${item.done ? 'text-lime-600' : 'text-slate-300'}`}>{item.done ? 'check_circle' : 'radio_button_unchecked'}</span>
                      <span className={`text-sm font-bold ${item.done ? 'text-slate-900' : 'text-slate-400'}`}>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {dnsRecords.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Required DNS Records</p>
                <div className="space-y-2">
                  {dnsRecords.map((rec, i) => (
                    <div key={i} className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{rec.type} Record</p>
                          <p className="text-sm font-bold text-slate-900">Name: <span className="font-mono text-primary">{rec.name}</span></p>
                          <p className="text-sm font-bold text-slate-900">Value: <span className="font-mono text-primary">{rec.value}</span></p>
                          <p className="text-[10px] text-slate-400">TTL: {rec.ttl}</p>
                        </div>
                        <button onClick={() => copyToClipboard(`${rec.type}\t${rec.name}\t${rec.value}\t${rec.ttl}`, `dns-${i}`)} className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-600 font-black text-[10px] rounded-lg uppercase tracking-widest transition-all flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">{copiedDns === `dns-${i}` ? 'check' : 'content_copy'}</span>
                          {copiedDns === `dns-${i}` ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {domainHistory.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Domain History</p>
                <div className="space-y-2">
                  {domainHistory.map(dh => (
                    <div key={dh.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-sm text-slate-400">history</span>
                        <div>
                          <p className="font-bold text-slate-900 text-sm">{dh.action}</p>
                          <p className="text-[10px] text-slate-400">{dh.domain} · {dh.actor} · {dh.date}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Usage' && (() => {
          if (!usage) return <p className="text-slate-400 font-bold">No usage data available for this tenant.</p>;
          return (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Seats</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.seatsUsed}/{usage.seatsAllowed}</p>
                    {usage.seatsUsed >= usage.seatsAllowed && <span className="text-[8px] font-black text-red-500 bg-red-50 px-1.5 py-0.5 rounded uppercase">At Limit</span>}
                  </div>
                  {usageBar(usage.seatsUsed, usage.seatsAllowed)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Locations</p>
                  <p className="font-black text-primary">{usage.locationsUsed}/{usage.locationsAllowed}</p>
                  {usageBar(usage.locationsUsed, usage.locationsAllowed)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">API Calls</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.apiCalls.toLocaleString()}/{usage.apiLimit.toLocaleString()}</p>
                    {priorUsage && trendArrow(usage.apiCalls, priorUsage.apiCalls)}
                  </div>
                  {usageBar(usage.apiCalls, usage.apiLimit)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Storage</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.storageMb}MB/{usage.storageLimitMb}MB</p>
                    {priorUsage && trendArrow(usage.storageMb, priorUsage.storageMb)}
                  </div>
                  {usageBar(usage.storageMb, usage.storageLimitMb)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">SMS</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.smsUsed}/{usage.smsLimit}</p>
                    {priorUsage && trendArrow(usage.smsUsed, priorUsage.smsUsed)}
                  </div>
                  {usageBar(usage.smsUsed, usage.smsLimit)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Tickets / Invoices</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.ticketsThisMonth} / {usage.invoicesThisMonth}</p>
                    {priorUsage && trendArrow(usage.ticketsThisMonth, priorUsage.ticketsThisMonth)}
                  </div>
                  <p className="text-[10px] text-slate-400">this month</p>
                </div>
              </div>

              {priorUsage && (
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Period Comparison</p>
                  <div className="bg-slate-50 rounded-xl border border-slate-100 overflow-hidden">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Metric</th>
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Prior</th>
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Current</th>
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          { label: 'API Calls', current: usage.apiCalls, prior: priorUsage.apiCalls },
                          { label: 'Storage (MB)', current: usage.storageMb, prior: priorUsage.storageMb },
                          { label: 'SMS', current: usage.smsUsed, prior: priorUsage.smsUsed },
                          { label: 'Tickets', current: usage.ticketsThisMonth, prior: priorUsage.ticketsThisMonth },
                          { label: 'Invoices', current: usage.invoicesThisMonth, prior: priorUsage.invoicesThisMonth },
                        ].map(row => (
                          <tr key={row.label} className="border-b border-slate-100 last:border-0">
                            <td className="px-4 py-3 text-sm font-bold text-slate-700">{row.label}</td>
                            <td className="px-4 py-3 text-sm font-bold text-slate-500 text-right">{row.prior.toLocaleString()}</td>
                            <td className="px-4 py-3 text-sm font-black text-slate-900 text-right">{row.current.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right">{trendArrow(row.current, row.prior)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <Link to={`/owner/usage?tenant=${tenant.id}`} className="inline-flex items-center gap-2 px-5 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 active:scale-95 transition-all uppercase tracking-widest">
                <span className="material-symbols-outlined text-sm">open_in_new</span>
                View Platform Usage
              </Link>
            </div>
          );
        })()}

        {activeTab === 'Activity / Audit' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center flex-wrap gap-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Activity log for {tenant.name}</p>
              <div className="flex gap-2 flex-wrap">
                <select value={auditCategoryFilter} onChange={e => setAuditCategoryFilter(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20">
                  <option value="all">All Categories</option>
                  {auditCategories.map(c => <option key={c} value={c} className="capitalize">{c}</option>)}
                </select>
                <select value={auditActorFilter} onChange={e => setAuditActorFilter(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20">
                  <option value="all">All Actors</option>
                  {auditActors.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <button className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-lg uppercase tracking-widest transition-all flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">download</span> Export
                </button>
              </div>
            </div>
            {filteredLogs.length === 0 && <p className="text-sm text-slate-400 font-bold py-4">No activity matches your filters.</p>}
            <div className="space-y-2">
              {filteredLogs.map(log => (
                <div key={log.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <div className="flex items-center gap-3">
                    <span className={`material-symbols-outlined text-sm ${log.severity === 'warning' ? 'text-amber-500' : 'text-blue-400'}`}>
                      {log.severity === 'warning' ? 'warning' : 'info'}
                    </span>
                    <div>
                      <p className="font-bold text-slate-900 text-sm">{log.action}</p>
                      <p className="text-[10px] text-slate-400">{log.actor} · {log.date}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(log.category)}
                    {statusBadge(log.severity === 'warning' ? 'warning' : 'info')}
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => navigate('/owner/audit-security')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">open_in_new</span> Full Audit Log
            </button>
          </div>
        )}

        {activeTab === 'Support Notes' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center flex-wrap gap-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Support Notes ({supportNotes.length})</p>
              <div className="flex gap-2">
                <select value={supportCategoryFilter} onChange={e => setSupportCategoryFilter(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20">
                  <option value="all">All Categories</option>
                  <option value="general">General</option>
                  <option value="billing">Billing</option>
                  <option value="technical">Technical</option>
                  <option value="escalation">Escalation</option>
                  <option value="onboarding">Onboarding</option>
                </select>
              </div>
            </div>

            {tenant.flags.length > 0 && (
              <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2">Active Flags</p>
                <div className="flex gap-2 flex-wrap">
                  {tenant.flags.map((f, i) => <span key={i} className="px-2.5 py-1 bg-amber-400/10 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-lg border border-amber-400/20">{f}</span>)}
                </div>
              </div>
            )}

            <div className="space-y-3">
              {filteredSupportNotes.length === 0 && <p className="text-sm text-slate-400 font-bold py-4">No support notes match your filter.</p>}
              {filteredSupportNotes.map(note => (
                <div key={note.id} className={`p-4 rounded-xl border ${note.pinned ? 'bg-amber-50 border-amber-100' : note.isEscalated ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100'}`}>
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      {note.pinned && <span className="material-symbols-outlined text-amber-500 text-sm">push_pin</span>}
                      {note.isEscalated && <span className="material-symbols-outlined text-red-500 text-sm">priority_high</span>}
                      {statusBadge(note.category)}
                    </div>
                    <div className="flex items-center gap-2">
                      {note.assignedTo && <span className="text-[10px] font-bold text-slate-500">{note.assignedTo}</span>}
                      {note.followUpDate && (
                        <span className={`text-[10px] font-bold ${new Date(note.followUpDate) <= new Date('2026-03-26') ? 'text-red-500' : 'text-slate-400'}`}>
                          Follow-up: {note.followUpDate}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-slate-700 font-medium">{note.text}</p>
                  <p className="text-[10px] text-slate-400 mt-2">{note.createdBy} · {note.createdDate}</p>
                </div>
              ))}
            </div>

            <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 space-y-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Add Note</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="note-category" className={labelClass}>Category</label>
                  <select id="note-category" value={noteCategory} onChange={e => setNoteCategory(e.target.value as SupportNoteCategory)} className={inputClass}>
                    <option value="general">General</option>
                    <option value="billing">Billing</option>
                    <option value="technical">Technical</option>
                    <option value="escalation">Escalation</option>
                    <option value="onboarding">Onboarding</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="note-assignee" className={labelClass}>Assign To</label>
                  <input id="note-assignee" value={noteAssignee} onChange={e => setNoteAssignee(e.target.value)} className={inputClass} placeholder="Admin name" />
                </div>
                <div>
                  <label htmlFor="note-followup" className={labelClass}>Follow-up Date</label>
                  <input id="note-followup" type="date" value={noteFollowUp} onChange={e => setNoteFollowUp(e.target.value)} className={inputClass} />
                </div>
              </div>
              <div>
                <label htmlFor="support-note" className={labelClass}>Note</label>
                <textarea id="support-note" value={noteInput} onChange={e => setNoteInput(e.target.value)} className={`${inputClass} resize-none`} rows={3} placeholder="Add a support note for this tenant..." />
              </div>
              <button onClick={() => {
                if (noteInput.trim()) {
                  setLocalNotes(prev => [...prev, {
                    id: `sn-local-${Date.now()}`,
                    tenantId: tenant.id,
                    text: noteInput.trim(),
                    category: noteCategory,
                    pinned: false,
                    followUpDate: noteFollowUp || null,
                    assignedTo: noteAssignee || null,
                    createdBy: 'You',
                    createdDate: '2026-03-26',
                    isEscalated: noteCategory === 'escalation',
                  }]);
                  setNoteInput('');
                  setNoteAssignee('');
                  setNoteFollowUp('');
                  setNoteCategory('general');
                }
              }} disabled={!noteInput.trim()} className="px-5 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-95">
                Save Note
              </button>
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {inviteSuccess && (
          <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }} className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50">
            <div className="bg-white rounded-2xl shadow-2xl border border-lime-200 px-6 py-4 flex items-center gap-3">
              <div className="w-8 h-8 bg-lime-100 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-lime-600 text-sm">check_circle</span>
              </div>
              <p className="font-bold text-slate-900 text-sm">{inviteSuccess}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default TenantDetailPage;
