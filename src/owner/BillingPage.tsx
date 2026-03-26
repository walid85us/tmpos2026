import React, { useState } from 'react';
import { tenants, billingTransactions } from './mockData';

const BillingPage: React.FC = () => {
  const [filter, setFilter] = useState<'all' | 'paid' | 'failed' | 'refunded'>('all');

  const totalRevenue = billingTransactions.filter(t => t.status === 'paid').reduce((s, t) => s + t.amount, 0);
  const failedTotal = billingTransactions.filter(t => t.status === 'failed').reduce((s, t) => s + t.amount, 0);
  const failedCount = billingTransactions.filter(t => t.status === 'failed').length;
  const refundedTotal = billingTransactions.filter(t => t.status === 'refunded').reduce((s, t) => s + t.amount, 0);
  const mrr = tenants.reduce((s, t) => s + t.mrr, 0);

  const upcomingRenewals = tenants
    .filter(t => t.status === 'active' || t.status === 'trialing')
    .sort((a, b) => new Date(a.renewal).getTime() - new Date(b.renewal).getTime())
    .slice(0, 5);

  const filtered = filter === 'all' ? billingTransactions : billingTransactions.filter(t => t.status === filter);

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      paid: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      failed: 'bg-red-400/10 text-red-700 border-red-400/20',
      refunded: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
    };
    return (
      <span className={`px-2.5 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg border ${styles[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
        {status}
      </span>
    );
  };

  const typeBadge = (type: string) => {
    const styles: Record<string, string> = {
      subscription: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      addon: 'bg-indigo-400/10 text-indigo-700 border-indigo-200',
      trial: 'bg-slate-400/10 text-slate-600 border-slate-200',
    };
    return (
      <span className={`px-2.5 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg border ${styles[type] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
        {type}
      </span>
    );
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Billing & Revenue</h2>
        <p className="text-slate-500 font-medium">Platform billing health, invoices, and transaction history.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">MRR</p>
          <p className="text-3xl font-black text-primary">${mrr.toLocaleString()}</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Collected</p>
          <p className="text-3xl font-black text-lime-600">${totalRevenue.toLocaleString()}</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Failed Payments</p>
          <p className="text-3xl font-black text-red-500">{failedCount}</p>
          <p className="text-[10px] font-black text-red-400 mt-1">${failedTotal} at risk</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Refunds / Credits</p>
          <p className="text-3xl font-black text-amber-600">${refundedTotal}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center flex-wrap gap-3">
            <h3 className="text-sm font-black text-primary uppercase tracking-widest">Transaction History</h3>
            <div className="flex gap-2">
              {(['all', 'paid', 'failed', 'refunded'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-lg border transition-all ${
                    filter === f ? 'bg-primary text-white border-primary' : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                  }`}
                >{f}</button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoice</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Type</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Method</th>
                  <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(tx => (
                  <tr key={tx.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-3 text-xs font-bold text-slate-500">{tx.invoiceNo}</td>
                    <td className="px-6 py-3 font-bold text-slate-900 text-sm">{tx.tenant}</td>
                    <td className="px-6 py-3 text-sm text-slate-500">{tx.date}</td>
                    <td className="px-6 py-3">{typeBadge(tx.type)}</td>
                    <td className="px-6 py-3 font-black text-primary text-sm">{tx.amount === 0 ? 'Free' : `$${tx.amount}`}</td>
                    <td className="px-6 py-3 text-xs text-slate-500">{tx.method}</td>
                    <td className="px-6 py-3">{statusBadge(tx.status)}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-400 font-bold">No transactions match this filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Upcoming Renewals</p>
            <div className="space-y-3">
              {upcomingRenewals.map(t => {
                const daysUntil = Math.ceil((new Date(t.renewal).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
                return (
                  <div key={t.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl">
                    <div>
                      <p className="text-sm font-bold text-slate-900">{t.name}</p>
                      <p className="text-[10px] text-slate-400">{t.renewal}</p>
                    </div>
                    <span className={`text-[10px] font-black uppercase tracking-widest ${
                      daysUntil <= 7 ? 'text-red-500' : daysUntil <= 14 ? 'text-amber-600' : 'text-slate-500'
                    }`}>{daysUntil}d</span>
                  </div>
                );
              })}
            </div>
          </div>

          {failedCount > 0 && (
            <div className="bg-red-50/80 backdrop-blur-xl p-6 rounded-[2rem] border border-red-200 shadow-sm">
              <p className="text-[10px] font-black text-red-600 uppercase tracking-widest mb-4 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">error</span>
                Failed Payments
              </p>
              <div className="space-y-3">
                {billingTransactions.filter(t => t.status === 'failed').map(tx => (
                  <div key={tx.id} className="flex justify-between items-center p-3 bg-white/60 rounded-xl">
                    <div>
                      <p className="text-sm font-bold text-slate-900">{tx.tenant}</p>
                      <p className="text-[10px] text-slate-400">{tx.date} · {tx.method}</p>
                    </div>
                    <span className="font-black text-red-600 text-sm">${tx.amount}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BillingPage;
