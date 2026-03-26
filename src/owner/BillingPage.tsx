import React, { useState, useMemo } from 'react';
import { tenants, billingTransactions, invoiceHistory, creditNotes } from './mockData';
import { motion, AnimatePresence } from 'motion/react';

type BillingTab = 'transactions' | 'invoices' | 'credits';
type TxFilter = 'all' | 'paid' | 'failed' | 'refunded';
type InvFilter = 'all' | 'paid' | 'overdue' | 'void';
type ConfirmAction = { type: 'retry' | 'refund'; tenant: string; amount: number; invoiceNo: string } | null;
type DetailModal = { type: 'invoice'; data: typeof invoiceHistory[0] } | { type: 'credit'; data: typeof creditNotes[0] } | null;
type FormModal = 'invoice' | 'refund' | 'credit' | null;

const BillingPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<BillingTab>('transactions');
  const [txFilter, setTxFilter] = useState<TxFilter>('all');
  const [invFilter, setInvFilter] = useState<InvFilter>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [tenantFilter, setTenantFilter] = useState('all');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [detailModal, setDetailModal] = useState<DetailModal>(null);
  const [formModal, setFormModal] = useState<FormModal>(null);
  const [formTenant, setFormTenant] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formReason, setFormReason] = useState('');
  const [formPlan, setFormPlan] = useState('');

  const totalRevenue = billingTransactions.filter(t => t.status === 'paid').reduce((s, t) => s + t.amount, 0);
  const failedTotal = billingTransactions.filter(t => t.status === 'failed').reduce((s, t) => s + t.amount, 0);
  const failedCount = billingTransactions.filter(t => t.status === 'failed').length;
  const refundedTotal = billingTransactions.filter(t => t.status === 'refunded').reduce((s, t) => s + t.amount, 0);
  const mrr = tenants.reduce((s, t) => s + t.mrr, 0);
  const creditTotal = creditNotes.reduce((s, c) => s + c.amount, 0);

  const upcomingRenewals = tenants
    .filter(t => t.status === 'active' || t.status === 'trialing')
    .sort((a, b) => new Date(a.renewal).getTime() - new Date(b.renewal).getTime())
    .slice(0, 5);

  const applyDateFilter = <T extends { date: string }>(items: T[]) => {
    let result = items;
    if (dateFrom) result = result.filter(i => i.date >= dateFrom);
    if (dateTo) result = result.filter(i => i.date <= dateTo);
    if (tenantFilter !== 'all') result = result.filter(i => (i as T & { tenant?: string }).tenant === tenantFilter);
    return result;
  };

  const filteredTx = useMemo(() => {
    let items = txFilter === 'all' ? billingTransactions : billingTransactions.filter(t => t.status === txFilter);
    return applyDateFilter(items);
  }, [txFilter, dateFrom, dateTo, tenantFilter]);

  const filteredInv = useMemo(() => {
    let items = invFilter === 'all' ? invoiceHistory : invoiceHistory.filter(i => i.status === invFilter);
    return applyDateFilter(items);
  }, [invFilter, dateFrom, dateTo, tenantFilter]);

  const filteredCredits = useMemo(() => {
    return applyDateFilter(creditNotes);
  }, [dateFrom, dateTo, tenantFilter]);

  const uniqueTenants = [...new Set(billingTransactions.map(t => t.tenant))];

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      paid: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      failed: 'bg-red-400/10 text-red-700 border-red-400/20',
      refunded: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      overdue: 'bg-red-400/10 text-red-700 border-red-400/20',
      void: 'bg-slate-400/10 text-slate-500 border-slate-200',
      applied: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
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

  const tabs: { id: BillingTab; label: string; count: number }[] = [
    { id: 'transactions', label: 'Charges', count: billingTransactions.length },
    { id: 'invoices', label: 'Invoice History', count: invoiceHistory.length },
    { id: 'credits', label: 'Refunds / Credits', count: creditNotes.length },
  ];

  const executeConfirmedAction = () => {
    if (!confirmAction) return;
    const label = confirmAction.type === 'retry'
      ? `Payment retry queued for ${confirmAction.tenant}`
      : `Refund of $${confirmAction.amount} initiated for ${confirmAction.tenant}`;
    setConfirmAction(null);
    setActionSuccess(label);
    setTimeout(() => setActionSuccess(null), 3000);
  };

  const [formConfirmStep, setFormConfirmStep] = useState(false);

  const submitForm = () => {
    if (!formModal) return;
    if (!formConfirmStep) {
      setFormConfirmStep(true);
      return;
    }
    const label = formModal === 'invoice'
      ? `Invoice issued to ${formTenant} for $${formAmount}`
      : formModal === 'refund'
      ? `Refund of $${formAmount} issued to ${formTenant}`
      : `Credit note of $${formAmount} created for ${formTenant}`;
    setFormModal(null);
    setFormConfirmStep(false);
    setFormTenant('');
    setFormAmount('');
    setFormReason('');
    setFormPlan('');
    setActionSuccess(label);
    setTimeout(() => setActionSuccess(null), 3000);
  };

  const clearDateFilters = () => {
    setDateFrom('');
    setDateTo('');
    setTenantFilter('all');
  };

  const inputClass = "w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary";
  const labelClass = "text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2";

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Billing & Revenue</h2>
          <p className="text-slate-500 font-medium">Platform billing health, invoices, charges, and credit management.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setFormModal('invoice'); setFormTenant(''); setFormAmount(''); setFormPlan(''); setFormReason(''); }} className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">receipt</span>
            Issue Invoice
          </button>
          <button onClick={() => { setFormModal('credit'); setFormTenant(''); setFormAmount(''); setFormReason(''); }} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">note_add</span>
            Issue Credit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Outstanding Credits</p>
          <p className="text-3xl font-black text-violet-600">${creditTotal}</p>
          <p className="text-[10px] font-black text-violet-400 mt-1">{creditNotes.filter(c => c.status === 'pending').length} pending</p>
        </div>
      </div>

      <div className="flex gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 w-fit">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-5 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center gap-2 ${
              activeTab === tab.id ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            {tab.label}
            <span className={`text-[9px] px-1.5 py-0.5 rounded-md ${activeTab === tab.id ? 'bg-white/20' : 'bg-slate-200/60'}`}>{tab.count}</span>
          </button>
        ))}
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-4 rounded-2xl border border-slate-200 flex flex-wrap items-center gap-3">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Filters:</p>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold text-slate-500">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold text-slate-500">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
        </div>
        <select
          value={tenantFilter}
          onChange={e => setTenantFilter(e.target.value)}
          className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
        >
          <option value="all">All Tenants</option>
          {uniqueTenants.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {(dateFrom || dateTo || tenantFilter !== 'all') && (
          <button onClick={clearDateFilters} className="text-[10px] font-black text-red-500 uppercase tracking-widest hover:text-red-700">Clear</button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2">
          {activeTab === 'transactions' && (
            <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
              <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center flex-wrap gap-3">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Charges</h3>
                <div className="flex gap-2">
                  {(['all', 'paid', 'failed', 'refunded'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setTxFilter(f)}
                      className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-lg border transition-all ${
                        txFilter === f ? 'bg-primary text-white border-primary' : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
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
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTx.map(tx => (
                      <tr key={tx.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-3">
                          <button
                            onClick={() => {
                              const inv = invoiceHistory.find(i => i.invoiceNo === tx.invoiceNo);
                              if (inv) setDetailModal({ type: 'invoice', data: inv });
                            }}
                            className="text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                          >{tx.invoiceNo}</button>
                        </td>
                        <td className="px-6 py-3 font-bold text-slate-900 text-sm">{tx.tenant}</td>
                        <td className="px-6 py-3 text-sm text-slate-500">{tx.date}</td>
                        <td className="px-6 py-3">{typeBadge(tx.type)}</td>
                        <td className="px-6 py-3 font-black text-primary text-sm">{tx.amount === 0 ? 'Free' : `$${tx.amount}`}</td>
                        <td className="px-6 py-3 text-xs text-slate-500">{tx.method}</td>
                        <td className="px-6 py-3">{statusBadge(tx.status)}</td>
                        <td className="px-6 py-3">
                          <div className="flex gap-2">
                            {tx.status === 'failed' && (
                              <button onClick={() => setConfirmAction({ type: 'retry', tenant: tx.tenant, amount: tx.amount, invoiceNo: tx.invoiceNo })} className="text-[9px] font-black text-blue-600 uppercase tracking-widest hover:text-blue-800">Retry</button>
                            )}
                            {tx.status === 'paid' && tx.amount > 0 && (
                              <button onClick={() => setConfirmAction({ type: 'refund', tenant: tx.tenant, amount: tx.amount, invoiceNo: tx.invoiceNo })} className="text-[9px] font-black text-slate-400 uppercase tracking-widest hover:text-slate-600">Refund</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredTx.length === 0 && (
                      <tr><td colSpan={8} className="px-6 py-12 text-center text-slate-400 font-bold">No transactions match this filter.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'invoices' && (
            <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
              <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center flex-wrap gap-3">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Invoice History</h3>
                <div className="flex gap-2">
                  {(['all', 'paid', 'overdue', 'void'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setInvFilter(f)}
                      className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-lg border transition-all ${
                        invFilter === f ? 'bg-primary text-white border-primary' : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                      }`}
                    >{f}</button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50">
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoice #</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Plan</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Due Date</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tax</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Total</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInv.map(inv => (
                      <tr key={inv.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-3">
                          <button onClick={() => setDetailModal({ type: 'invoice', data: inv })} className="text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline transition-colors">{inv.invoiceNo}</button>
                        </td>
                        <td className="px-6 py-3 font-bold text-slate-900 text-sm">{inv.tenant}</td>
                        <td className="px-6 py-3 text-xs text-slate-500">{inv.plan}</td>
                        <td className="px-6 py-3 text-sm text-slate-500">{inv.date}</td>
                        <td className="px-6 py-3 text-sm text-slate-500">{inv.dueDate}</td>
                        <td className="px-6 py-3 font-black text-primary text-sm">${inv.amount}</td>
                        <td className="px-6 py-3 text-xs text-slate-400">${inv.tax.toFixed(2)}</td>
                        <td className="px-6 py-3 font-black text-slate-900 text-sm">${inv.total.toFixed(2)}</td>
                        <td className="px-6 py-3">{statusBadge(inv.status)}</td>
                      </tr>
                    ))}
                    {filteredInv.length === 0 && (
                      <tr><td colSpan={9} className="px-6 py-12 text-center text-slate-400 font-bold">No invoices match this filter.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'credits' && (
            <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
              <div className="px-8 py-5 border-b border-slate-100">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Refunds & Credit Notes</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50">
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Credit #</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Reason</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Related Invoice</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCredits.map(cr => (
                      <tr key={cr.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-3">
                          <button onClick={() => setDetailModal({ type: 'credit', data: cr })} className="text-xs font-bold text-violet-600 hover:text-violet-800 hover:underline transition-colors">{cr.creditNo}</button>
                        </td>
                        <td className="px-6 py-3 font-bold text-slate-900 text-sm">{cr.tenant}</td>
                        <td className="px-6 py-3 text-sm text-slate-500">{cr.date}</td>
                        <td className="px-6 py-3 font-black text-amber-600 text-sm">${cr.amount}</td>
                        <td className="px-6 py-3 text-xs text-slate-500 max-w-48 truncate">{cr.reason}</td>
                        <td className="px-6 py-3">
                          {cr.relatedInvoice ? (
                            <button
                              onClick={() => {
                                const inv = invoiceHistory.find(i => i.invoiceNo === cr.relatedInvoice);
                                if (inv) setDetailModal({ type: 'invoice', data: inv });
                              }}
                              className="text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                            >{cr.relatedInvoice}</button>
                          ) : '—'}
                        </td>
                        <td className="px-6 py-3">{statusBadge(cr.status)}</td>
                      </tr>
                    ))}
                    {filteredCredits.length === 0 && (
                      <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-400 font-bold">No credit notes found.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
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
                    <div className="flex items-center gap-2">
                      <span className="font-black text-red-600 text-sm">${tx.amount}</span>
                      <button onClick={() => setConfirmAction({ type: 'retry', tenant: tx.tenant, amount: tx.amount, invoiceNo: tx.invoiceNo })} className="text-[9px] font-black text-blue-600 uppercase hover:text-blue-800">Retry</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Tenant Billing Actions</p>
            <div className="space-y-2">
              {tenants.filter(t => t.status !== 'suspended').slice(0, 4).map(t => (
                <div key={t.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl">
                  <div>
                    <p className="text-sm font-bold text-slate-900">{t.name}</p>
                    <p className="text-[10px] text-slate-400">${t.mrr}/mo · {t.plan}</p>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => { setFormModal('invoice'); setFormTenant(t.name); setFormAmount(String(t.mrr)); setFormPlan(t.plan); setFormReason(''); }} className="text-[9px] font-black text-blue-600 uppercase tracking-widest hover:text-blue-800 px-2 py-1">Invoice</button>
                    <button onClick={() => { setFormModal('credit'); setFormTenant(t.name); setFormAmount(''); setFormReason(''); }} className="text-[9px] font-black text-amber-600 uppercase tracking-widest hover:text-amber-800 px-2 py-1">Credit</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {confirmAction && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setConfirmAction(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="p-8 text-center">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 ${confirmAction.type === 'retry' ? 'bg-blue-100' : 'bg-amber-100'}`}>
                  <span className={`material-symbols-outlined text-2xl ${confirmAction.type === 'retry' ? 'text-blue-600' : 'text-amber-600'}`}>
                    {confirmAction.type === 'retry' ? 'refresh' : 'undo'}
                  </span>
                </div>
                <h3 className="text-lg font-black text-primary tracking-tight mb-2">
                  {confirmAction.type === 'retry' ? 'Retry Payment?' : 'Issue Refund?'}
                </h3>
                <p className="text-sm text-slate-500">
                  {confirmAction.type === 'retry'
                    ? `Re-attempt payment of $${confirmAction.amount} for ${confirmAction.tenant} (${confirmAction.invoiceNo}).`
                    : `Refund $${confirmAction.amount} to ${confirmAction.tenant} for ${confirmAction.invoiceNo}. This action cannot be undone.`}
                </p>
              </div>
              <div className="p-8 pt-0 flex gap-3">
                <button onClick={() => setConfirmAction(null)} className="flex-1 py-3.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-xs rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                <button onClick={executeConfirmedAction} className={`flex-1 py-3.5 text-white font-black text-xs rounded-2xl uppercase tracking-widest transition-all shadow-lg ${
                  confirmAction.type === 'retry' ? 'bg-blue-600 hover:bg-blue-700 shadow-blue-600/20' : 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/20'
                }`}>
                  {confirmAction.type === 'retry' ? 'Retry Now' : 'Confirm Refund'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {detailModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setDetailModal(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden"
            >
              {detailModal.type === 'invoice' && (() => {
                const inv = detailModal.data;
                return (
                  <>
                    <div className="p-8 border-b border-slate-100 flex justify-between items-center">
                      <div>
                        <h3 className="text-xl font-black text-primary tracking-tight">{inv.invoiceNo}</h3>
                        <p className="text-sm text-slate-500 mt-1">{inv.tenant} · {inv.plan}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        {statusBadge(inv.status)}
                        <button onClick={() => setDetailModal(null)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                          <span className="material-symbols-outlined text-lg">close</span>
                        </button>
                      </div>
                    </div>
                    <div className="p-8 space-y-6">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className={labelClass}>Issue Date</p>
                          <p className="font-bold text-slate-900">{inv.date}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Due Date</p>
                          <p className="font-bold text-slate-900">{inv.dueDate}</p>
                        </div>
                        {inv.paidDate && (
                          <div>
                            <p className={labelClass}>Paid Date</p>
                            <p className="font-bold text-lime-700">{inv.paidDate}</p>
                          </div>
                        )}
                      </div>
                      <div>
                        <p className={labelClass}>Line Items</p>
                        <div className="bg-slate-50 rounded-xl border border-slate-100 overflow-hidden">
                          {inv.items.map((item, i) => (
                            <div key={i} className="flex justify-between items-center px-4 py-3 border-b border-slate-100 last:border-0">
                              <div>
                                <p className="text-sm font-bold text-slate-900">{item.description}</p>
                                <p className="text-[10px] text-slate-400">Qty: {item.qty}</p>
                              </div>
                              <span className="font-black text-primary">${item.amount}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="bg-primary/5 rounded-xl p-4 border border-primary/10">
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-slate-500">Subtotal</span>
                          <span className="font-bold text-slate-900">${inv.amount}</span>
                        </div>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-slate-500">Tax</span>
                          <span className="font-bold text-slate-900">${inv.tax.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-sm pt-2 border-t border-primary/10">
                          <span className="font-black text-primary">Total</span>
                          <span className="font-black text-primary text-lg">${inv.total.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}

              {detailModal.type === 'credit' && (() => {
                const cr = detailModal.data;
                return (
                  <>
                    <div className="p-8 border-b border-slate-100 flex justify-between items-center">
                      <div>
                        <h3 className="text-xl font-black text-primary tracking-tight">{cr.creditNo}</h3>
                        <p className="text-sm text-slate-500 mt-1">{cr.tenant}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        {statusBadge(cr.status)}
                        <button onClick={() => setDetailModal(null)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                          <span className="material-symbols-outlined text-lg">close</span>
                        </button>
                      </div>
                    </div>
                    <div className="p-8 space-y-6">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className={labelClass}>Date</p>
                          <p className="font-bold text-slate-900">{cr.date}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Amount</p>
                          <p className="font-black text-amber-600 text-xl">${cr.amount}</p>
                        </div>
                      </div>
                      <div>
                        <p className={labelClass}>Reason</p>
                        <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">{cr.reason}</p>
                      </div>
                      {cr.relatedInvoice && (
                        <div>
                          <p className={labelClass}>Related Invoice</p>
                          <button
                            onClick={() => {
                              const inv = invoiceHistory.find(i => i.invoiceNo === cr.relatedInvoice);
                              if (inv) setDetailModal({ type: 'invoice', data: inv });
                            }}
                            className="text-sm font-bold text-blue-600 hover:text-blue-800 hover:underline"
                          >{cr.relatedInvoice}</button>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {formModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setFormModal(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center">
                <div>
                  <h3 className="text-xl font-black text-primary tracking-tight">
                    {formModal === 'invoice' ? 'Issue Invoice' : formModal === 'refund' ? 'Issue Refund' : 'Issue Credit Note'}
                  </h3>
                  <p className="text-sm text-slate-500 mt-1">
                    {formModal === 'invoice' ? 'Create a new invoice for a tenant.' : formModal === 'refund' ? 'Process a refund to a tenant.' : 'Create a credit note for a tenant.'}
                  </p>
                </div>
                <button onClick={() => setFormModal(null)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="p-8 space-y-5">
                <div>
                  <label className={labelClass}>Tenant</label>
                  <select value={formTenant} onChange={e => setFormTenant(e.target.value)} className={inputClass}>
                    <option value="">Select tenant...</option>
                    {tenants.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Amount (USD)</label>
                  <input type="number" value={formAmount} onChange={e => setFormAmount(e.target.value)} className={inputClass} placeholder="0.00" />
                </div>
                {formModal === 'invoice' && (
                  <div>
                    <label className={labelClass}>Plan / Description</label>
                    <input value={formPlan} onChange={e => setFormPlan(e.target.value)} className={inputClass} placeholder="e.g., Growth Plan - Monthly" />
                  </div>
                )}
                {(formModal === 'refund' || formModal === 'credit') && (
                  <div>
                    <label className={labelClass}>Reason</label>
                    <textarea value={formReason} onChange={e => setFormReason(e.target.value)} className={`${inputClass} resize-none`} rows={3} placeholder="Reason for this credit/refund..." />
                  </div>
                )}
              </div>
              {formConfirmStep && (
                <div className="px-8 py-4 bg-amber-50 border-t border-amber-100">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-amber-600 text-sm">warning</span>
                    <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest">Confirm Action</p>
                  </div>
                  <p className="text-sm text-amber-700">
                    {formModal === 'invoice' ? `Issue invoice of $${formAmount} to ${formTenant}?` : formModal === 'refund' ? `Refund $${formAmount} to ${formTenant}? This cannot be undone.` : `Create credit note of $${formAmount} for ${formTenant}?`}
                  </p>
                </div>
              )}
              <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button onClick={() => { if (formConfirmStep) { setFormConfirmStep(false); } else { setFormModal(null); setFormConfirmStep(false); } }} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">
                  {formConfirmStep ? 'Go Back' : 'Cancel'}
                </button>
                <button onClick={submitForm} disabled={!formTenant || !formAmount} className={`flex-1 py-4 font-black text-sm rounded-2xl shadow-lg uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed ${formConfirmStep ? 'bg-amber-500 text-white shadow-amber-500/20 hover:bg-amber-600' : 'bg-primary text-white shadow-primary/20 hover:bg-primary/90'}`}>
                  {formConfirmStep
                    ? (formModal === 'invoice' ? 'Confirm & Issue' : formModal === 'refund' ? 'Confirm Refund' : 'Confirm Credit')
                    : (formModal === 'invoice' ? 'Issue Invoice' : formModal === 'refund' ? 'Process Refund' : 'Create Credit')
                  }
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {actionSuccess && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50"
          >
            <div className="bg-white rounded-2xl shadow-2xl border border-lime-200 px-6 py-4 flex items-center gap-3">
              <div className="w-8 h-8 bg-lime-100 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-lime-600 text-sm">check_circle</span>
              </div>
              <p className="font-bold text-slate-900 text-sm">{actionSuccess}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default BillingPage;
