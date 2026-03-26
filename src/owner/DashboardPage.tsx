import React from 'react';
import { useNavigate } from 'react-router-dom';
import { tenants, auditLogs, billingTransactions } from './mockData';

const DashboardPage: React.FC = () => {
  const navigate = useNavigate();

  const activeTenants = tenants.filter(t => t.status === 'active');
  const trialTenants = tenants.filter(t => t.status === 'trialing');
  const suspendedTenants = tenants.filter(t => t.status === 'suspended');
  const overdueTenants = tenants.filter(t => t.status === 'overdue');
  const totalMrr = tenants.reduce((sum, t) => sum + t.mrr, 0);
  const failedPayments = billingTransactions.filter(t => t.status === 'failed');
  const expiringSubscriptions = tenants.filter(t => {
    const renewal = new Date(t.renewal);
    const now = new Date();
    const daysUntil = (renewal.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return daysUntil <= 30 && daysUntil > 0 && t.status === 'active';
  });
  const pendingDomains = tenants.filter(t => t.verification === 'pending' || t.ssl === 'pending');
  const flaggedTenants = tenants.filter(t => t.flags.length > 0);

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Platform Command Center</h2>
          <p className="text-slate-500 font-medium">Real-time platform performance, health, and operations.</p>
        </div>
        <div className="flex gap-2">
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
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Tenants</p>
          <p className="text-3xl font-black text-primary">{tenants.length}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-lime-600 bg-lime-50 px-2 py-0.5 rounded-md">{activeTenants.length} Active</span>
            <span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md">{trialTenants.length} Trial</span>
          </div>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Monthly Recurring Revenue</p>
          <p className="text-3xl font-black text-primary">${totalMrr.toLocaleString()}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-slate-500">{activeTenants.length + overdueTenants.length} paying</span>
          </div>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Failed Payments</p>
          <p className="text-3xl font-black text-orange-500">{failedPayments.length}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-orange-500 bg-orange-50 px-2 py-0.5 rounded-md">${failedPayments.reduce((s, p) => s + p.amount, 0)} at risk</span>
          </div>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Support Alerts</p>
          <p className="text-3xl font-black text-red-500">{flaggedTenants.length}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-red-500 bg-red-50 px-2 py-0.5 rounded-md">{flaggedTenants.length} flagged</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Tenant Health</p>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Active</span>
              <span className="px-2.5 py-1 bg-lime-400/10 text-lime-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-400/20">{activeTenants.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Trialing</span>
              <span className="px-2.5 py-1 bg-indigo-400/10 text-indigo-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-indigo-200">{trialTenants.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Overdue</span>
              <span className="px-2.5 py-1 bg-red-400/10 text-red-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-red-400/20">{overdueTenants.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Suspended</span>
              <span className="px-2.5 py-1 bg-slate-400/10 text-slate-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-slate-200">{suspendedTenants.length}</span>
            </div>
          </div>
        </div>

        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Subscription KPIs</p>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Active Subscriptions</span>
              <span className="font-black text-primary">{activeTenants.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Expiring (30d)</span>
              <span className="font-black text-amber-600">{expiringSubscriptions.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Avg Revenue/Tenant</span>
              <span className="font-black text-primary">${activeTenants.length ? Math.round(totalMrr / (activeTenants.length + overdueTenants.length)) : 0}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Churn (suspended)</span>
              <span className="font-black text-red-500">{suspendedTenants.length}</span>
            </div>
          </div>
        </div>

        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Platform Status</p>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Domain/SSL Issues</span>
              <span className={`font-black ${pendingDomains.length > 0 ? 'text-amber-600' : 'text-lime-600'}`}>{pendingDomains.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Provisioning Queue</span>
              <span className="font-black text-indigo-600">{trialTenants.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Billing Issues</span>
              <span className={`font-black ${overdueTenants.length > 0 ? 'text-red-500' : 'text-lime-600'}`}>{overdueTenants.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-slate-600">Total Seats Used</span>
              <span className="font-black text-primary">{tenants.reduce((s, t) => s + t.seatsUsed, 0)}</span>
            </div>
          </div>
        </div>
      </div>

      {(overdueTenants.length > 0 || flaggedTenants.length > 0) && (
        <div className="bg-red-50/80 backdrop-blur-xl rounded-[2rem] border border-red-200 overflow-hidden shadow-sm">
          <div className="px-8 py-4 border-b border-red-100">
            <h3 className="text-sm font-black text-red-700 uppercase tracking-widest flex items-center gap-2">
              <span className="material-symbols-outlined text-base">warning</span>
              Attention Required
            </h3>
          </div>
          <div className="p-6 space-y-3">
            {overdueTenants.map(t => (
              <div key={t.id} className="flex justify-between items-center p-3 bg-white/60 rounded-xl">
                <div>
                  <span className="font-bold text-slate-900">{t.name}</span>
                  <span className="ml-2 px-2 py-0.5 bg-red-400/10 text-red-700 text-[9px] font-black uppercase tracking-widest rounded-md border border-red-400/20">Overdue</span>
                </div>
                <button onClick={() => navigate(`/owner/tenants/${t.id}`)} className="text-[10px] font-black text-red-600 uppercase tracking-widest hover:text-red-800 transition-colors">View →</button>
              </div>
            ))}
            {flaggedTenants.filter(t => t.status !== 'overdue').map(t => (
              <div key={t.id} className="flex justify-between items-center p-3 bg-white/60 rounded-xl">
                <div>
                  <span className="font-bold text-slate-900">{t.name}</span>
                  {t.flags.map((f, i) => (
                    <span key={i} className="ml-2 px-2 py-0.5 bg-amber-400/10 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-md border border-amber-400/20">{f}</span>
                  ))}
                </div>
                <button onClick={() => navigate(`/owner/tenants/${t.id}`)} className="text-[10px] font-black text-amber-600 uppercase tracking-widest hover:text-amber-800 transition-colors">View →</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center">
          <h3 className="text-sm font-black text-primary uppercase tracking-widest">Recent Platform Activity</h3>
          <button onClick={() => navigate('/owner/audit-security')} className="text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-primary transition-colors">View All →</button>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Actor</th>
              <th className="px-8 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
              <th className="px-8 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Target</th>
              <th className="px-8 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-8 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Severity</th>
            </tr>
          </thead>
          <tbody>
            {auditLogs.slice(0, 6).map((log) => (
              <tr key={log.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                <td className="px-8 py-3 font-bold text-slate-900 text-sm">{log.actor}</td>
                <td className="px-8 py-3 text-sm text-slate-600">{log.action}</td>
                <td className="px-8 py-3 font-bold text-slate-900 text-sm">{log.target}</td>
                <td className="px-8 py-3 text-sm text-slate-500">{log.date}</td>
                <td className="px-8 py-3">
                  <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${
                    log.severity === 'warning' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-blue-400/10 text-blue-700 border-blue-400/20'
                  }`}>{log.severity}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default DashboardPage;
