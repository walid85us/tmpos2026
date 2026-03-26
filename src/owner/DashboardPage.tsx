import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { tenants, auditLogs, billingTransactions } from './mockData';

type DrillDown = 'tenants' | 'revenue' | 'failed' | 'alerts' | null;

const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const [drillDown, setDrillDown] = useState<DrillDown>(null);

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

  const closeDrillDown = () => setDrillDown(null);

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
        <button onClick={() => setDrillDown('tenants')} className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Tenants</p>
          <p className="text-3xl font-black text-primary">{tenants.length}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-lime-600 bg-lime-50 px-2 py-0.5 rounded-md">{activeTenants.length} Active</span>
            <span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md">{trialTenants.length} Trial</span>
          </div>
          <p className="text-[9px] font-black text-primary/0 group-hover:text-primary/60 uppercase tracking-widest mt-2 transition-colors">View Details →</p>
        </button>
        <button onClick={() => setDrillDown('revenue')} className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Monthly Recurring Revenue</p>
          <p className="text-3xl font-black text-primary">${totalMrr.toLocaleString()}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-slate-500">{activeTenants.length + overdueTenants.length} paying</span>
          </div>
          <p className="text-[9px] font-black text-primary/0 group-hover:text-primary/60 uppercase tracking-widest mt-2 transition-colors">View Details →</p>
        </button>
        <button onClick={() => setDrillDown('failed')} className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Failed Payments</p>
          <p className="text-3xl font-black text-orange-500">{failedPayments.length}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-orange-500 bg-orange-50 px-2 py-0.5 rounded-md">${failedPayments.reduce((s, p) => s + p.amount, 0)} at risk</span>
          </div>
          <p className="text-[9px] font-black text-primary/0 group-hover:text-primary/60 uppercase tracking-widest mt-2 transition-colors">View Details →</p>
        </button>
        <button onClick={() => setDrillDown('alerts')} className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm text-left hover:shadow-md hover:border-primary/30 transition-all group">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Support Alerts</p>
          <p className="text-3xl font-black text-red-500">{flaggedTenants.length}</p>
          <div className="flex gap-2 mt-2 flex-wrap">
            <span className="text-[9px] font-black text-red-500 bg-red-50 px-2 py-0.5 rounded-md">{flaggedTenants.length} flagged</span>
          </div>
          <p className="text-[9px] font-black text-primary/0 group-hover:text-primary/60 uppercase tracking-widest mt-2 transition-colors">View Details →</p>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Tenant Health</p>
          <div className="space-y-2">
            {([
              { label: 'Active', count: activeTenants.length, style: 'bg-lime-400/10 text-lime-700 border-lime-400/20' },
              { label: 'Trialing', count: trialTenants.length, style: 'bg-indigo-400/10 text-indigo-700 border-indigo-200' },
              { label: 'Overdue', count: overdueTenants.length, style: 'bg-red-400/10 text-red-700 border-red-400/20' },
              { label: 'Suspended', count: suspendedTenants.length, style: 'bg-slate-400/10 text-slate-700 border-slate-200' },
            ] as const).map(row => (
              <div key={row.label} className="flex justify-between items-center">
                <span className="text-sm font-bold text-slate-600">{row.label}</span>
                <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${row.style}`}>{row.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Upcoming Renewals</p>
          <div className="space-y-2">
            {expiringSubscriptions.length === 0 && <p className="text-sm text-slate-400 font-bold">No renewals in next 30 days.</p>}
            {expiringSubscriptions.slice(0, 4).map(t => {
              const daysUntil = Math.ceil((new Date(t.renewal).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
              return (
                <button key={t.id} onClick={() => navigate(`/owner/tenants/${t.id}`)} className="flex justify-between items-center w-full p-2.5 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors text-left">
                  <div>
                    <p className="text-sm font-bold text-slate-900">{t.name}</p>
                    <p className="text-[10px] text-slate-400">{t.renewal}</p>
                  </div>
                  <span className={`text-[10px] font-black uppercase tracking-widest ${daysUntil <= 7 ? 'text-red-500' : daysUntil <= 14 ? 'text-amber-600' : 'text-slate-500'}`}>{daysUntil}d</span>
                </button>
              );
            })}
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
                    {drillDown === 'failed' && 'Failed Payments'}
                    {drillDown === 'alerts' && 'Support Alerts'}
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
                      <p className="text-[10px] text-slate-400 mt-0.5">{t.plan} · {t.owner.email}</p>
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

                {drillDown === 'revenue' && tenants.filter(t => t.mrr > 0).map(t => (
                  <button key={t.id} onClick={() => { closeDrillDown(); navigate(`/owner/tenants/${t.id}`); }} className="w-full flex justify-between items-center p-4 bg-slate-50 rounded-2xl hover:bg-slate-100 transition-colors text-left">
                    <div>
                      <p className="font-bold text-slate-900">{t.name}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{t.plan} plan</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-black text-primary text-lg">${t.mrr}/mo</span>
                      <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                    </div>
                  </button>
                ))}

                {drillDown === 'failed' && (
                  <>
                    <div className="p-4 bg-red-50 rounded-2xl border border-red-100 mb-4">
                      <p className="text-sm font-bold text-red-700">{failedPayments.length} failed payment{failedPayments.length !== 1 ? 's' : ''} totaling ${failedPayments.reduce((s, p) => s + p.amount, 0)}</p>
                    </div>
                    {failedPayments.map(tx => (
                      <div key={tx.id} className="flex justify-between items-center p-4 bg-slate-50 rounded-2xl">
                        <div>
                          <p className="font-bold text-slate-900">{tx.tenant}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">{tx.date} · {tx.method} · {tx.invoiceNo}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-black text-red-600">${tx.amount}</span>
                          <button onClick={() => { closeDrillDown(); navigate('/owner/billing'); }} className="px-3 py-1.5 bg-blue-600 text-white text-[9px] font-black uppercase tracking-widest rounded-lg hover:bg-blue-700 transition-colors">
                            Go to Billing
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {drillDown === 'alerts' && flaggedTenants.map(t => (
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
