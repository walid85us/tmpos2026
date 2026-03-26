import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { tenants, tenantUsage, plans, featureMatrix, billingTransactions, invoiceHistory, creditNotes, auditLogs, addOns } from './mockData';
import { tenantUsers } from './accessMockData';

type Tab = 'Overview' | 'Owner & Users' | 'Subscription' | 'Features' | 'Billing' | 'Domains' | 'Usage' | 'Activity / Audit' | 'Support Notes';

const TenantDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const tenant = tenants.find(t => t.id === id);
  const [activeTab, setActiveTab] = useState<Tab>('Overview');
  const [noteInput, setNoteInput] = useState('');
  const [localNotes, setLocalNotes] = useState<string[]>([]);
  const [inviteModal, setInviteModal] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('technician');
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  if (!tenant) return (
    <div className="text-center py-20">
      <p className="text-xl font-black text-slate-400">Tenant not found</p>
      <button onClick={() => navigate('/owner/tenants')} className="mt-4 px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest">Back to Tenants</button>
    </div>
  );

  const plan = plans.find(p => p.id === tenant.plan);
  const usage = tenantUsage.find(u => u.tenantId === tenant.id);
  const scopedUsers = tenantUsers.filter(u => u.tenantId === tenant.id);
  const tenantTx = billingTransactions.filter(tx => tx.tenant === tenant.name);
  const tenantInv = invoiceHistory.filter(i => i.tenant === tenant.name);
  const tenantCredits = creditNotes.filter(c => c.tenant === tenant.name);
  const tenantLogs = auditLogs.filter(l => l.target === tenant.name || l.target.includes(tenant.name));
  const tenantAddOns = addOns.filter(a => a.lifecycle === 'active' && a.compatiblePlans.includes(tenant.plan));

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

  const inputClass = "w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary";
  const labelClass = "text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2";

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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Onboarded</p>
                <p className="font-black text-slate-900">{tenant.onboardedDate}</p>
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
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">SSL / DNS</p>
                <div className="flex gap-1.5">
                  {statusBadge(tenant.ssl === 'active' ? 'active' : tenant.ssl)}
                  {statusBadge(tenant.verification === 'verified' ? 'verified' : tenant.verification)}
                </div>
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
            </div>
          </div>
        )}

        {activeTab === 'Owner & Users' && (
          <div className="space-y-6">
            <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 flex justify-between items-center">
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Store Owner</p>
                <p className="font-bold text-slate-900">{tenant.owner.name}</p>
                <p className="text-sm text-slate-500">{tenant.owner.email}</p>
              </div>
              {statusBadge('active')}
            </div>

            <div className="flex justify-between items-center">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Team Members</p>
              <button onClick={() => setInviteModal(true)} className="px-4 py-2 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">person_add</span> Invite User
              </button>
            </div>

            <div className="space-y-2">
              {scopedUsers.length === 0 && <p className="text-sm text-slate-400 font-bold py-4">No team members for this tenant.</p>}
              {scopedUsers.map(user => (
                <div key={user.id} className="flex justify-between items-center p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <div>
                    <p className="font-bold text-slate-900">{user.name}</p>
                    <p className="text-[10px] text-slate-400">{user.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-slate-600 capitalize">{user.role.replace('_', ' ')}</span>
                    {statusBadge(user.status)}
                  </div>
                </div>
              ))}
            </div>

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
                <p className="font-black text-slate-900">Monthly</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Next Renewal</p>
                <p className="font-black text-slate-900">{tenant.renewal}</p>
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
                  <span className={`font-black ${tenant.seatsUsed >= tenant.seatsAllowed ? 'text-red-500' : 'text-slate-900'}`}>{tenant.seatsUsed} / {tenant.seatsAllowed}</span>
                </div>
                <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-sm font-bold text-slate-600">Locations</span>
                  <span className="font-black text-slate-900">{tenant.locationsUsed} / {tenant.locationsAllowed}</span>
                </div>
              </div>
            </div>

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

            <div className="flex gap-2 flex-wrap">
              {plans.filter(p => p.id !== tenant.plan).map(p => (
                <button key={p.id} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">
                  {plans.findIndex(pl => pl.id === p.id) > plans.findIndex(pl => pl.id === tenant.plan) ? 'Upgrade' : 'Downgrade'} to {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'Features' && (
          <div className="space-y-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Features available on <span className="text-primary capitalize">{tenant.plan}</span> plan</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {featureMatrix.filter(f => f.lifecycle !== 'draft').map(feature => {
                const enabled = feature.planAvailability[tenant.plan] === true;
                return (
                  <div key={feature.id} className={`p-4 rounded-xl border flex justify-between items-center ${enabled ? 'bg-slate-50 border-slate-100' : 'bg-slate-50/50 border-slate-100/50'}`}>
                    <div className="flex items-center gap-3">
                      <span className={`material-symbols-outlined text-sm ${enabled ? 'text-lime-600' : 'text-slate-300'}`}>{enabled ? 'check_circle' : 'remove_circle_outline'}</span>
                      <div>
                        <span className={`font-bold ${enabled ? 'text-slate-900' : 'text-slate-400'}`}>{feature.name}</span>
                        {feature.lifecycle !== 'implemented' && (
                          <span className="ml-2 text-[8px] font-black text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded uppercase tracking-widest">{feature.lifecycle}</span>
                        )}
                      </div>
                    </div>
                    {statusBadge(enabled ? 'active' : 'disabled')}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'Billing' && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Billed</p>
                <p className="text-lg font-black text-primary">${tenantInv.reduce((s, i) => s + i.total, 0).toFixed(2)}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Paid</p>
                <p className="text-lg font-black text-lime-600">${tenantTx.filter(tx => tx.status === 'paid').reduce((s, tx) => s + tx.amount, 0).toFixed(2)}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Credits</p>
                <p className="text-lg font-black text-violet-600">${tenantCredits.reduce((s, c) => s + c.amount, 0).toFixed(2)}</p>
              </div>
            </div>

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Invoices</p>
              <div className="space-y-2">
                {tenantInv.length === 0 && <p className="text-sm text-slate-400 font-bold">No invoices.</p>}
                {tenantInv.map(inv => (
                  <div key={inv.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <div>
                      <p className="font-bold text-slate-900 text-sm">{inv.invoiceNo}</p>
                      <p className="text-[10px] text-slate-400">{inv.date} · {inv.plan} · Due {inv.dueDate}</p>
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
                  <p className="text-sm text-slate-400 font-bold">No custom domain configured</p>
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
          </div>
        )}

        {activeTab === 'Usage' && (() => {
          if (!usage) return <p className="text-slate-400 font-bold">No usage data available for this tenant.</p>;
          return (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Seats</p>
                  <p className="font-black text-primary">{usage.seatsUsed}/{usage.seatsAllowed}</p>
                  {usageBar(usage.seatsUsed, usage.seatsAllowed)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Locations</p>
                  <p className="font-black text-primary">{usage.locationsUsed}/{usage.locationsAllowed}</p>
                  {usageBar(usage.locationsUsed, usage.locationsAllowed)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">API Calls</p>
                  <p className="font-black text-primary">{usage.apiCalls.toLocaleString()}/{usage.apiLimit.toLocaleString()}</p>
                  {usageBar(usage.apiCalls, usage.apiLimit)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Storage</p>
                  <p className="font-black text-primary">{usage.storageMb}MB/{usage.storageLimitMb}MB</p>
                  {usageBar(usage.storageMb, usage.storageLimitMb)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">SMS</p>
                  <p className="font-black text-primary">{usage.smsUsed}/{usage.smsLimit}</p>
                  {usageBar(usage.smsUsed, usage.smsLimit)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Tickets / Invoices</p>
                  <p className="font-black text-primary">{usage.ticketsThisMonth} / {usage.invoicesThisMonth}</p>
                  <p className="text-[10px] text-slate-400">this month</p>
                </div>
              </div>
              <Link to={`/owner/usage?tenant=${tenant.id}`} className="inline-flex items-center gap-2 px-5 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 active:scale-95 transition-all uppercase tracking-widest">
                <span className="material-symbols-outlined text-sm">open_in_new</span>
                View Platform Usage
              </Link>
            </div>
          );
        })()}

        {activeTab === 'Activity / Audit' && (
          <div className="space-y-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Activity log for {tenant.name}</p>
            {tenantLogs.length === 0 && <p className="text-sm text-slate-400 font-bold py-4">No activity recorded for this tenant.</p>}
            <div className="space-y-2">
              {tenantLogs.map(log => (
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
                  {statusBadge(log.severity === 'warning' ? 'warning' : 'info')}
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
            {tenant.flags.length > 0 && (
              <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2">Active Flags</p>
                <div className="flex gap-2 flex-wrap">
                  {tenant.flags.map((f, i) => <span key={i} className="px-2.5 py-1 bg-amber-400/10 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-lg border border-amber-400/20">{f}</span>)}
                </div>
              </div>
            )}

            <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Platform Support Notes</p>
              <p className="text-sm text-slate-700 font-medium">{tenant.supportNotes}</p>
            </div>

            {localNotes.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Added Notes</p>
                {localNotes.map((note, i) => (
                  <div key={i} className="p-4 bg-blue-50 rounded-xl border border-blue-100">
                    <p className="text-sm text-slate-700">{note}</p>
                    <p className="text-[10px] text-slate-400 mt-1">Just now</p>
                  </div>
                ))}
              </div>
            )}

            <div>
              <label htmlFor="support-note" className={labelClass}>Add Note</label>
              <textarea id="support-note" value={noteInput} onChange={e => setNoteInput(e.target.value)} className={`${inputClass} resize-none`} rows={3} placeholder="Add a support note for this tenant..." />
              <button onClick={() => { if (noteInput.trim()) { setLocalNotes(prev => [...prev, noteInput.trim()]); setNoteInput(''); } }} disabled={!noteInput.trim()} className="mt-3 px-5 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-95">
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
