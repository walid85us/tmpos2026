import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { tenants, auditLogs, billingTransactions, creditNotes, invoiceHistory, planHistory, tenantUsage } from './mockData';

type DrillDown = 'tenants' | 'revenue' | 'alerts' | 'onboarding' | 'billing_issues' | null;

const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const [drillDown, setDrillDown] = useState<DrillDown>(null);

  const activeTenants = tenants.filter(t => t.status === 'active');
  const trialTenants = tenants.filter(t => t.status === 'trialing');
  const suspendedTenants = tenants.filter(t => t.status === 'suspended');
  const overdueTenants = tenants.filter(t => t.status === 'overdue');
  const totalMrr = tenants.reduce((sum, t) => sum + t.mrr, 0);
  const failedPayments = billingTransactions.filter(t => t.status === 'failed');
  const failedTotal = failedPayments.reduce((s, p) => s + p.amount, 0);
  const totalCollected = billingTransactions.filter(t => t.status === 'paid' && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const expiringSubscriptions = tenants.filter(t => {
    const daysUntil = (new Date(t.renewal).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24);
    return daysUntil <= 30 && daysUntil > 0 && t.status === 'active';
  });
  const pendingDomains = tenants.filter(t => t.verification === 'pending' || t.ssl === 'pending');
  const flaggedTenants = tenants.filter(t => t.flags.length > 0);
  const unappliedCredits = creditNotes.filter(c => c.status === 'pending');
  const unappliedTotal = unappliedCredits.reduce((s, c) => s + (c.amount - c.appliedAmount), 0);
  const overdueInvoices = invoiceHistory.filter(i => i.status === 'overdue');
  const overdueInvoiceTotal = overdueInvoices.reduce((s, i) => s + i.total, 0);

  const totalSeats = tenants.reduce((s, t) => s + t.seatsUsed, 0);
  const totalSeatsAllowed = tenants.reduce((s, t) => s + t.seatsAllowed, 0);
  const seatPct = totalSeatsAllowed > 0 ? Math.round((totalSeats / totalSeatsAllowed) * 100) : 0;
  const atCapacityTenants = tenantUsage.filter(u => u.seatsAllowed > 0 && (u.seatsUsed / u.seatsAllowed) >= 0.9);
  const revenueAtRisk = overdueTenants.reduce((s, t) => s + t.mrr, 0) + failedTotal;
  const closeDrillDown = () => setDrillDown(null);

  const urgentItems = [
    ...overdueTenants.map(t => ({ id: `overdue-${t.id}`, severity: 'critical' as const, icon: 'error', label: `${t.name} — Overdue`, sublabel: `$${t.mrr}/mo at risk`, action: () => navigate(`/owner/tenants/${t.id}`), actionLabel: 'View', color: 'text-red-600' })),
    ...failedPayments.map(tx => ({ id: `failed-${tx.id}`, severity: 'critical' as const, icon: 'credit_card_off', label: `${tx.tenant} — Payment Failed`, sublabel: `$${tx.amount} · ${tx.invoiceNo}`, action: () => navigate('/owner/billing'), actionLabel: 'Billing', color: 'text-red-600' })),
    ...flaggedTenants.filter(t => t.status !== 'overdue').map(t => ({ id: `flag-${t.id}`, severity: 'warning' as const, icon: 'flag', label: `${t.name} — ${t.flags.join(', ')}`, sublabel: t.plan + ' plan', action: () => navigate(`/owner/tenants/${t.id}`), actionLabel: 'View', color: 'text-amber-600' })),
    ...pendingDomains.map(t => ({ id: `dns-${t.id}`, severity: 'info' as const, icon: 'dns', label: `${t.name} — ${t.ssl === 'pending' ? 'SSL' : 'DNS'} Pending`, sublabel: t.customDomain || t.subdomain, action: () => navigate(`/owner/tenants/${t.id}`), actionLabel: 'View', color: 'text-blue-600' })),
  ];

  const statusDistribution = [
    { label: 'Active', count: activeTenants.length, pct: Math.round((activeTenants.length / tenants.length) * 100), bar: 'bg-lime-500', badge: 'bg-lime-400/10 text-lime-700 border-lime-400/20' },
    { label: 'Trialing', count: trialTenants.length, pct: Math.round((trialTenants.length / tenants.length) * 100), bar: 'bg-indigo-500', badge: 'bg-indigo-400/10 text-indigo-700 border-indigo-200' },
    { label: 'Overdue', count: overdueTenants.length, pct: Math.round((overdueTenants.length / tenants.length) * 100), bar: 'bg-red-500', badge: 'bg-red-400/10 text-red-700 border-red-400/20' },
    { label: 'Suspended', count: suspendedTenants.length, pct: Math.round((suspendedTenants.length / tenants.length) * 100), bar: 'bg-slate-400', badge: 'bg-slate-400/10 text-slate-700 border-slate-200' },
  ];

  const recentActivity = auditLogs.slice(0, 6);

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Platform Command Center</h2>
          <p className="text-slate-500 font-medium">Real-time platform performance, health, and operations.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => navigate('/owner/provisioning')} className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">add</span>
            Provision Tenant
          </button>
          <button onClick={() => navigate('/owner/billing')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">receipt_long</span>
            Billing
          </button>
          <button onClick={() => navigate('/owner/plans')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">workspace_premium</span>
            Plans
          </button>
          <button onClick={() => navigate('/owner/support-tools')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">support_agent</span>
            Support
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <button onClick={() => setDrillDown('tenants')} className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group">
          <div className="flex justify-between items-start mb-1">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Tenants</p>
            <span className="material-symbols-outlined text-slate-300 text-sm group-hover:text-primary/60 transition-colors">open_in_new</span>
          </div>
          <p className="text-3xl font-black text-primary">{tenants.length}</p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-lime-600 bg-lime-50 px-1.5 py-0.5 rounded-md">{activeTenants.length} active</span>
            <span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded-md">{trialTenants.length} trial</span>
            {overdueTenants.length > 0 && <span className="text-[9px] font-black text-red-600 bg-red-50 px-1.5 py-0.5 rounded-md">{overdueTenants.length} overdue</span>}
          </div>
        </button>

        <button onClick={() => setDrillDown('revenue')} className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group">
          <div className="flex justify-between items-start mb-1">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Monthly Revenue</p>
            <span className="material-symbols-outlined text-slate-300 text-sm group-hover:text-primary/60 transition-colors">open_in_new</span>
          </div>
          <p className="text-3xl font-black text-primary">${totalMrr.toLocaleString()}</p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-lime-600 bg-lime-50 px-1.5 py-0.5 rounded-md">${totalCollected.toLocaleString()} collected</span>
          </div>
        </button>

        <button onClick={() => setDrillDown('billing_issues')} className={`bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group ${revenueAtRisk > 0 ? 'border-red-200' : 'border-slate-200'}`}>
          <div className="flex justify-between items-start mb-1">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Revenue at Risk</p>
            <span className="material-symbols-outlined text-slate-300 text-sm group-hover:text-primary/60 transition-colors">open_in_new</span>
          </div>
          <p className={`text-3xl font-black ${revenueAtRisk > 0 ? 'text-red-500' : 'text-lime-600'}`}>${revenueAtRisk.toLocaleString()}</p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {failedPayments.length > 0 && <span className="text-[9px] font-black text-red-500 bg-red-50 px-1.5 py-0.5 rounded-md">{failedPayments.length} failed</span>}
            {overdueTenants.length > 0 && <span className="text-[9px] font-black text-red-500 bg-red-50 px-1.5 py-0.5 rounded-md">{overdueTenants.length} overdue</span>}
            {revenueAtRisk === 0 && <span className="text-[9px] font-black text-lime-600 bg-lime-50 px-1.5 py-0.5 rounded-md">All clear</span>}
          </div>
        </button>

        <button onClick={() => setDrillDown('alerts')} className={`bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group ${flaggedTenants.length > 0 ? 'border-amber-200' : 'border-slate-200'}`}>
          <div className="flex justify-between items-start mb-1">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Support Alerts</p>
            <span className="material-symbols-outlined text-slate-300 text-sm group-hover:text-primary/60 transition-colors">open_in_new</span>
          </div>
          <p className={`text-3xl font-black ${flaggedTenants.length > 0 ? 'text-amber-500' : 'text-lime-600'}`}>{flaggedTenants.length}</p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {flaggedTenants.length > 0
              ? <span className="text-[9px] font-black text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-md">{flaggedTenants.length} flagged</span>
              : <span className="text-[9px] font-black text-lime-600 bg-lime-50 px-1.5 py-0.5 rounded-md">No flags</span>}
          </div>
        </button>

        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm text-left">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Platform Seats</p>
          <p className="text-3xl font-black text-primary">{totalSeats}<span className="text-lg text-slate-400 font-bold">/{totalSeatsAllowed}</span></p>
          <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-100 mt-2 mb-1">
            <div className={`${seatPct >= 90 ? 'bg-red-500' : seatPct >= 70 ? 'bg-amber-500' : 'bg-lime-500'} rounded-full transition-all`} style={{ width: `${seatPct}%` }} />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <span className={`text-[9px] font-black ${seatPct >= 90 ? 'text-red-500' : 'text-slate-500'}`}>{seatPct}% utilized</span>
            {atCapacityTenants.length > 0 && <span className="text-[9px] font-black text-red-500 bg-red-50 px-1.5 py-0.5 rounded-md">{atCapacityTenants.length} at cap</span>}
          </div>
        </div>
      </div>

      {urgentItems.length > 0 && (
        <div className="bg-red-50/80 backdrop-blur-xl rounded-[2rem] border border-red-200 overflow-hidden shadow-sm">
          <div className="px-6 py-3.5 border-b border-red-100 flex justify-between items-center">
            <h3 className="text-[10px] font-black text-red-700 uppercase tracking-widest flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">priority_high</span>
              Action Required — {urgentItems.filter(i => i.severity === 'critical').length} Critical · {urgentItems.filter(i => i.severity === 'warning').length} Warning · {urgentItems.filter(i => i.severity === 'info').length} Info
            </h3>
          </div>
          <div className="divide-y divide-red-100/60">
            {urgentItems.slice(0, 8).map(item => (
              <div key={item.id} className="flex justify-between items-center px-6 py-3 hover:bg-white/40 transition-colors">
                <div className="flex items-center gap-3">
                  <span className={`material-symbols-outlined text-base ${item.color}`}>{item.icon}</span>
                  <div>
                    <p className="text-sm font-bold text-slate-900">{item.label}</p>
                    <p className="text-[10px] text-slate-400">{item.sublabel}</p>
                  </div>
                </div>
                <button onClick={item.action} className={`text-[9px] font-black uppercase tracking-widest hover:underline transition-colors ${item.color}`}>{item.actionLabel} →</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-3 bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Tenant Distribution</p>
          <div className="flex h-3 rounded-full overflow-hidden mb-4 bg-slate-100">
            {statusDistribution.filter(s => s.count > 0).map(s => (
              <div key={s.label} className={`${s.bar} transition-all`} style={{ width: `${s.pct}%` }} title={`${s.label}: ${s.count}`} />
            ))}
          </div>
          <div className="space-y-2.5">
            {statusDistribution.map(row => (
              <div key={row.label} className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${row.bar}`} />
                  <span className="text-sm font-bold text-slate-600">{row.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black text-slate-400">{row.pct}%</span>
                  <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${row.badge}`}>{row.count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="md:col-span-3 bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Billing Health</p>
            <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${
              (failedPayments.length + overdueInvoices.length) > 0 ? 'bg-red-400/10 text-red-700 border-red-400/20' : 'bg-lime-400/10 text-lime-700 border-lime-400/20'
            }`}>
              {(failedPayments.length + overdueInvoices.length) > 0 ? `${failedPayments.length + overdueInvoices.length} Issues` : 'Healthy'}
            </span>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-sm text-red-400">credit_card_off</span>
                <span className="text-sm font-bold text-slate-600">Failed</span>
              </div>
              <div className="text-right">
                <span className={`font-black ${failedPayments.length > 0 ? 'text-red-500' : 'text-lime-600'}`}>{failedPayments.length}</span>
                {failedTotal > 0 && <p className="text-[9px] text-red-400 font-bold">${failedTotal}</p>}
              </div>
            </div>
            <div className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-sm text-amber-400">schedule</span>
                <span className="text-sm font-bold text-slate-600">Overdue Inv.</span>
              </div>
              <div className="text-right">
                <span className={`font-black ${overdueInvoices.length > 0 ? 'text-amber-600' : 'text-lime-600'}`}>{overdueInvoices.length}</span>
                {overdueInvoiceTotal > 0 && <p className="text-[9px] text-amber-500 font-bold">${overdueInvoiceTotal.toFixed(0)}</p>}
              </div>
            </div>
            <div className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-sm text-violet-400">account_balance_wallet</span>
                <span className="text-sm font-bold text-slate-600">Unapplied Credits</span>
              </div>
              <div className="text-right">
                <span className={`font-black ${unappliedTotal > 0 ? 'text-violet-600' : 'text-slate-400'}`}>${unappliedTotal}</span>
                <p className="text-[9px] text-slate-400 font-bold">{unappliedCredits.length} note{unappliedCredits.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <button onClick={() => navigate('/owner/billing')} className="w-full py-2 text-[9px] font-black text-primary uppercase tracking-widest hover:bg-primary/5 rounded-lg transition-colors text-center">
              Open Billing →
            </button>
          </div>
        </div>

        <div className="md:col-span-3 bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subscription Health</p>
            <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${expiringSubscriptions.length > 0 ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-lime-400/10 text-lime-700 border-lime-400/20'}`}>
              {expiringSubscriptions.length > 0 ? `${expiringSubscriptions.length} Due` : 'Healthy'}
            </span>
          </div>
          <div className="space-y-2">
            {expiringSubscriptions.length === 0 && <p className="text-sm text-slate-400 font-bold">No renewals in next 30 days.</p>}
            {expiringSubscriptions.slice(0, 4).map(t => {
              const daysUntil = Math.ceil((new Date(t.renewal).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
              return (
                <button key={t.id} onClick={() => navigate(`/owner/tenants/${t.id}`)} className="flex justify-between items-center w-full p-2.5 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors text-left">
                  <div>
                    <p className="text-sm font-bold text-slate-900">{t.name}</p>
                    <p className="text-[10px] text-slate-400">{t.renewal} · ${t.mrr}/mo</p>
                  </div>
                  <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md ${
                    daysUntil <= 7 ? 'text-red-600 bg-red-50' : daysUntil <= 14 ? 'text-amber-600 bg-amber-50' : 'text-slate-500 bg-slate-100'
                  }`}>{daysUntil}d</span>
                </button>
              );
            })}
          </div>
        </div>

        <button onClick={() => setDrillDown('onboarding')} className="md:col-span-3 bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group">
          <div className="flex justify-between items-center mb-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Onboarding Queue</p>
            <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${trialTenants.length > 0 ? 'bg-indigo-400/10 text-indigo-700 border-indigo-200' : 'bg-slate-400/10 text-slate-500 border-slate-200'}`}>
              {trialTenants.length} in queue
            </span>
          </div>
          <div className="space-y-2">
            {trialTenants.map(t => (
              <div key={t.id} className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl">
                <div>
                  <p className="text-sm font-bold text-slate-900">{t.name}</p>
                  <p className="text-[10px] text-slate-400">Since {t.onboardedDate}</p>
                </div>
                <div className="flex items-center gap-2">
                  {t.ssl === 'pending' && <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" title="SSL Pending" />}
                  {t.verification === 'pending' && <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" title="DNS Pending" />}
                  <span className="px-2 py-0.5 bg-indigo-100 text-indigo-600 text-[9px] font-black uppercase tracking-widest rounded-md">Trial</span>
                </div>
              </div>
            ))}
            {trialTenants.length === 0 && <p className="text-sm text-slate-400 font-bold">No tenants onboarding.</p>}
            {pendingDomains.length > 0 && (
              <div className="p-2.5 bg-amber-50 rounded-xl border border-amber-100">
                <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest">{pendingDomains.length} Domain/SSL Pending</p>
              </div>
            )}
          </div>
          <p className="text-[9px] font-black text-primary/0 group-hover:text-primary/60 uppercase tracking-widest mt-3 transition-colors">View Details →</p>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center">
            <h3 className="text-[10px] font-black text-primary uppercase tracking-widest">Recent Platform Activity</h3>
            <button onClick={() => navigate('/owner/audit-security')} className="text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-primary transition-colors">Full Audit Log →</button>
          </div>
          <div className="divide-y divide-slate-50">
            {recentActivity.map((log) => (
              <div key={log.id} className="px-6 py-3 flex justify-between items-center hover:bg-slate-50/50 transition-colors">
                <div className="flex items-center gap-3">
                  <span className={`material-symbols-outlined text-sm ${log.severity === 'warning' ? 'text-amber-500' : 'text-blue-400'}`}>
                    {log.severity === 'warning' ? 'warning' : 'info'}
                  </span>
                  <div>
                    <p className="text-sm font-bold text-slate-900">{log.action}</p>
                    <p className="text-[10px] text-slate-400">{log.actor} → {log.target}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-slate-400 font-bold">{log.date}</span>
                  <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md border ${
                    log.severity === 'warning' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-blue-400/10 text-blue-700 border-blue-400/20'
                  }`}>{log.severity}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Recent Plan Changes</p>
            <div className="space-y-2">
              {planHistory.slice(0, 5).map(ph => (
                <div key={ph.id} className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl">
                  <div>
                    <p className="text-sm font-bold text-slate-900">{ph.tenant}</p>
                    <p className="text-[10px] text-slate-400">{ph.fromPlan || 'New'} → {ph.toPlan}</p>
                  </div>
                  <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${
                    ph.type === 'upgrade' ? 'bg-lime-400/10 text-lime-700 border-lime-400/20' :
                    ph.type === 'new' || ph.type === 'trial_start' ? 'bg-blue-400/10 text-blue-700 border-blue-400/20' :
                    'bg-red-400/10 text-red-600 border-red-400/20'
                  }`}>{ph.type.replace('_', ' ')}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Platform Vitals</p>
            <div className="space-y-2.5">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-slate-400">dns</span>
                  <span className="text-sm font-bold text-slate-600">Domain/SSL Issues</span>
                </div>
                <span className={`font-black ${pendingDomains.length > 0 ? 'text-amber-600' : 'text-lime-600'}`}>{pendingDomains.length}</span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-slate-400">rocket_launch</span>
                  <span className="text-sm font-bold text-slate-600">Provisioning</span>
                </div>
                <span className="font-black text-indigo-600">{trialTenants.length}</span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-slate-400">group</span>
                  <span className="text-sm font-bold text-slate-600">Seats ({seatPct}%)</span>
                </div>
                <span className={`font-black ${seatPct >= 90 ? 'text-red-500' : 'text-primary'}`}>{totalSeats}/{totalSeatsAllowed}</span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-slate-400">location_on</span>
                  <span className="text-sm font-bold text-slate-600">Locations</span>
                </div>
                <span className="font-black text-primary">{tenants.reduce((s, t) => s + t.locationsUsed, 0)}/{tenants.reduce((s, t) => s + t.locationsAllowed, 0)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {drillDown && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={closeDrillDown}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center shrink-0">
                <div>
                  <h3 className="text-xl font-black text-primary tracking-tight">
                    {drillDown === 'tenants' && 'Tenant Breakdown'}
                    {drillDown === 'revenue' && 'Revenue Breakdown'}
                    {drillDown === 'alerts' && 'Support Alerts'}
                    {drillDown === 'onboarding' && 'Onboarding & Provisioning'}
                    {drillDown === 'billing_issues' && 'Billing Issues Summary'}
                  </h3>
                </div>
                <button onClick={closeDrillDown} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="p-8 overflow-y-auto space-y-3">
                {drillDown === 'tenants' && tenants.map(t => (
                  <button key={t.id} onClick={() => { closeDrillDown(); navigate(`/owner/tenants/${t.id}`); }} className="w-full flex justify-between items-center p-4 bg-slate-50 rounded-2xl hover:bg-slate-100 transition-colors text-left">
                    <div>
                      <p className="font-bold text-slate-900">{t.name}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{t.plan} · {t.owner.email} · ${t.mrr}/mo</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`px-2.5 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg border ${
                        t.status === 'active' ? 'bg-lime-400/10 text-lime-700 border-lime-400/20' :
                        t.status === 'trialing' ? 'bg-indigo-400/10 text-indigo-700 border-indigo-200' :
                        t.status === 'overdue' ? 'bg-red-400/10 text-red-700 border-red-400/20' :
                        'bg-slate-400/10 text-slate-500 border-slate-200'
                      }`}>{t.status}</span>
                      <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                    </div>
                  </button>
                ))}

                {drillDown === 'revenue' && (
                  <>
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <div className="p-3 bg-primary/5 rounded-xl border border-primary/10 text-center">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">MRR</p>
                        <p className="text-lg font-black text-primary">${totalMrr}</p>
                      </div>
                      <div className="p-3 bg-lime-50 rounded-xl border border-lime-100 text-center">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Collected</p>
                        <p className="text-lg font-black text-lime-600">${totalCollected}</p>
                      </div>
                      <div className="p-3 bg-red-50 rounded-xl border border-red-100 text-center">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">At Risk</p>
                        <p className="text-lg font-black text-red-500">${revenueAtRisk}</p>
                      </div>
                    </div>
                    {tenants.filter(t => t.mrr > 0).sort((a, b) => b.mrr - a.mrr).map(t => (
                      <button key={t.id} onClick={() => { closeDrillDown(); navigate(`/owner/tenants/${t.id}`); }} className="w-full flex justify-between items-center p-4 bg-slate-50 rounded-2xl hover:bg-slate-100 transition-colors text-left">
                        <div>
                          <p className="font-bold text-slate-900">{t.name}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">{t.plan} plan · {t.status}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-black text-primary text-lg">${t.mrr}/mo</span>
                          <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                        </div>
                      </button>
                    ))}
                  </>
                )}

                {drillDown === 'alerts' && (
                  <>
                    {flaggedTenants.length === 0 && <p className="text-sm text-slate-400 font-bold text-center py-8">No active support alerts.</p>}
                    {flaggedTenants.map(t => (
                      <button key={t.id} onClick={() => { closeDrillDown(); navigate(`/owner/tenants/${t.id}`); }} className="w-full flex justify-between items-center p-4 bg-slate-50 rounded-2xl hover:bg-slate-100 transition-colors text-left">
                        <div>
                          <p className="font-bold text-slate-900">{t.name}</p>
                          <div className="flex gap-1.5 mt-1">
                            {t.flags.map((f, i) => (
                              <span key={i} className="px-2 py-0.5 bg-amber-400/10 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-md border border-amber-400/20">{f}</span>
                            ))}
                          </div>
                        </div>
                        <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                      </button>
                    ))}
                  </>
                )}

                {drillDown === 'onboarding' && (
                  <>
                    <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100 mb-4">
                      <p className="text-sm font-bold text-indigo-700">{trialTenants.length} tenant{trialTenants.length !== 1 ? 's' : ''} in onboarding/trial</p>
                    </div>
                    {trialTenants.map(t => (
                      <button key={t.id} onClick={() => { closeDrillDown(); navigate(`/owner/tenants/${t.id}`); }} className="w-full flex justify-between items-center p-4 bg-slate-50 rounded-2xl hover:bg-slate-100 transition-colors text-left">
                        <div>
                          <p className="font-bold text-slate-900">{t.name}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">Trial started {t.onboardedDate} · {t.plan} plan</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className="text-[10px] font-black text-slate-400">SSL: <span className={t.ssl === 'pending' ? 'text-amber-600' : 'text-lime-600'}>{t.ssl}</span></p>
                            <p className="text-[10px] font-black text-slate-400">DNS: <span className={t.verification === 'pending' ? 'text-amber-600' : 'text-lime-600'}>{t.verification}</span></p>
                          </div>
                          <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                        </div>
                      </button>
                    ))}
                    {pendingDomains.filter(t => t.status !== 'trialing').length > 0 && (
                      <>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest pt-4 pb-1">Active Tenants with Pending DNS/SSL</p>
                        {pendingDomains.filter(t => t.status !== 'trialing').map(t => (
                          <button key={t.id} onClick={() => { closeDrillDown(); navigate(`/owner/tenants/${t.id}`); }} className="w-full flex justify-between items-center p-4 bg-amber-50 rounded-2xl hover:bg-amber-100 transition-colors text-left">
                            <div>
                              <p className="font-bold text-slate-900">{t.name}</p>
                              <p className="text-[10px] text-slate-400 mt-0.5">{t.plan} plan</p>
                            </div>
                            <div className="flex items-center gap-2">
                              {t.ssl === 'pending' && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[9px] font-black uppercase rounded-md">SSL Pending</span>}
                              {t.verification === 'pending' && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[9px] font-black uppercase rounded-md">DNS Pending</span>}
                            </div>
                          </button>
                        ))}
                      </>
                    )}
                  </>
                )}

                {drillDown === 'billing_issues' && (
                  <>
                    {failedPayments.length > 0 && (
                      <>
                        <p className="text-[10px] font-black text-red-600 uppercase tracking-widest pb-1">Failed Payments</p>
                        {failedPayments.map(tx => (
                          <div key={tx.id} className="flex justify-between items-center p-4 bg-red-50 rounded-2xl">
                            <div>
                              <p className="font-bold text-slate-900">{tx.tenant}</p>
                              <p className="text-[10px] text-slate-400 mt-0.5">{tx.date} · {tx.invoiceNo}</p>
                            </div>
                            <span className="font-black text-red-600">${tx.amount}</span>
                          </div>
                        ))}
                      </>
                    )}
                    {overdueInvoices.length > 0 && (
                      <>
                        <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest pt-4 pb-1">Overdue Invoices</p>
                        {overdueInvoices.map(inv => (
                          <div key={inv.id} className="flex justify-between items-center p-4 bg-amber-50 rounded-2xl">
                            <div>
                              <p className="font-bold text-slate-900">{inv.tenant}</p>
                              <p className="text-[10px] text-slate-400 mt-0.5">{inv.invoiceNo} · Due {inv.dueDate}</p>
                            </div>
                            <span className="font-black text-amber-600">${inv.total.toFixed(2)}</span>
                          </div>
                        ))}
                      </>
                    )}
                    {unappliedCredits.length > 0 && (
                      <>
                        <p className="text-[10px] font-black text-violet-600 uppercase tracking-widest pt-4 pb-1">Unapplied Credits</p>
                        {unappliedCredits.map(cr => (
                          <div key={cr.id} className="flex justify-between items-center p-4 bg-violet-50 rounded-2xl">
                            <div>
                              <p className="font-bold text-slate-900">{cr.tenant}</p>
                              <p className="text-[10px] text-slate-400 mt-0.5">{cr.creditNo} · {cr.reason}</p>
                            </div>
                            <span className="font-black text-violet-600">${cr.amount - cr.appliedAmount}</span>
                          </div>
                        ))}
                      </>
                    )}
                    <div className="mt-4">
                      <button onClick={() => { closeDrillDown(); navigate('/owner/billing'); }} className="w-full py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all">
                        Open Billing →
                      </button>
                    </div>
                  </>
                )}
              </div>
              <div className="p-6 border-t border-slate-100 bg-slate-50/50 shrink-0">
                <button onClick={closeDrillDown} className="w-full py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Close</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default DashboardPage;
