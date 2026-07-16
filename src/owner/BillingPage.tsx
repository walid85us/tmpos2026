import React, { useState, useMemo } from 'react';
import { tenants, billingTransactions, invoiceHistory, creditNotes as initialCreditNotes } from './mockData';
import { motion, AnimatePresence } from 'motion/react';

type BillingTab = 'transactions' | 'invoices' | 'credits' | 'ledger';
type TxFilter = 'all' | 'paid' | 'failed' | 'refunded';
type InvFilter = 'all' | 'paid' | 'overdue' | 'void';
type ConfirmAction = { type: 'retry' | 'refund'; tenant: string; amount: number; invoiceNo: string } | null;
// Each seed credit note narrows `status` to its own literal ('applied' or 'issued'),
// so the inferred element type cannot represent a note transitioning between the two.
// Widen `status` to the canonical credit domain only; every other field keeps the
// seed-derived type (including the string | null fields).
type CreditNote = Omit<typeof initialCreditNotes[number], 'status'> & { status: 'applied' | 'issued' };
type DetailModal = { type: 'invoice'; data: typeof invoiceHistory[0] } | { type: 'credit'; data: CreditNote } | null;
type FormModal = 'invoice' | 'refund' | 'credit' | 'apply_credit' | null;

// A credit note can only be applied to an invoice with an outstanding balance.
// In the invoice status domain ('void' | 'paid' | 'overdue') that is exactly
// the tenant's overdue invoices.
export function getCreditEligibleInvoices<T extends { tenant: string; status: string }>(
  invoices: readonly T[],
  tenant: string,
): T[] {
  return invoices.filter((i) => i.tenant === tenant && i.status === 'overdue');
}

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
  const [formCreditId, setFormCreditId] = useState('');
  const [formInvoiceId, setFormInvoiceId] = useState('');
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>(() => [...initialCreditNotes]);

  const totalRevenue = billingTransactions.filter(t => t.status === 'paid').reduce((s, t) => s + t.amount, 0);
  const failedTotal = billingTransactions.filter(t => t.status === 'failed').reduce((s, t) => s + t.amount, 0);
  const failedCount = billingTransactions.filter(t => t.status === 'failed').length;
  const refundedTotal = billingTransactions.filter(t => t.status === 'refunded').reduce((s, t) => s + t.amount, 0);
  const mrr = tenants.reduce((s, t) => s + t.mrr, 0);
  const creditTotal = creditNotes.reduce((s, c) => s + c.amount, 0);
  const appliedCreditTotal = creditNotes.reduce((s, c) => s + c.appliedAmount, 0);
  const unappliedCreditTotal = creditTotal - appliedCreditTotal;

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
  }, [dateFrom, dateTo, tenantFilter, creditNotes]);

  const uniqueTenants = [...new Set(billingTransactions.map(t => t.tenant))];

  const tenantLedger = useMemo(() => {
    return tenants.map(t => {
      const tenantTx = billingTransactions.filter(tx => tx.tenantId === t.id);
      const tenantInv = invoiceHistory.filter(i => i.tenantId === t.id);
      const tenantCredits = creditNotes.filter(c => c.tenantId === t.id);
      const totalBilled = tenantInv.reduce((s, i) => s + i.total, 0);
      const totalPaid = tenantTx.filter(tx => tx.status === 'paid').reduce((s, tx) => s + tx.amount, 0);
      const totalCredits = tenantCredits.reduce((s, c) => s + c.amount, 0);
      const unapplied = tenantCredits.reduce((s, c) => s + (c.amount - c.appliedAmount), 0);
      const tenantAppliedCredits = tenantCredits.reduce((s, c) => s + c.appliedAmount, 0);
      const overdueAmount = tenantInv.filter(i => i.status === 'overdue').reduce((s, i) => s + i.total, 0);
      return {
        ...t,
        totalBilled,
        totalPaid,
        totalCredits,
        unapplied,
        overdueAmount,
        balance: totalBilled - totalPaid - tenantAppliedCredits,
        invoiceCount: tenantInv.length,
        creditCount: tenantCredits.length,
      };
    });
  }, [creditNotes]);

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      paid: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      failed: 'bg-red-400/10 text-red-700 border-red-400/20',
      refunded: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      overdue: 'bg-red-400/10 text-red-700 border-red-400/20',
      void: 'bg-slate-400/10 text-slate-500 border-slate-200',
      applied: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      partial: 'bg-violet-400/10 text-violet-600 border-violet-400/20',
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
      refund: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      goodwill: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
      cancellation: 'bg-red-400/10 text-red-600 border-red-400/20',
    };
    return (
      <span className={`px-2.5 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg border ${styles[type] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
        {type}
      </span>
    );
  };

  const tabs: { id: BillingTab; label: string; count: number; icon: string }[] = [
    { id: 'transactions', label: 'Charges', count: billingTransactions.length, icon: 'payments' },
    { id: 'invoices', label: 'Invoices', count: invoiceHistory.length, icon: 'receipt_long' },
    { id: 'credits', label: 'Credits & Refunds', count: creditNotes.length, icon: 'credit_card_off' },
    { id: 'ledger', label: 'Tenant Ledger', count: tenants.length, icon: 'account_balance' },
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

  const closeFormModal = () => {
    setFormModal(null);
    setFormConfirmStep(false);
    setFormTenant('');
    setFormAmount('');
    setFormReason('');
    setFormPlan('');
    setFormCreditId('');
    setFormInvoiceId('');
  };

  const submitForm = () => {
    if (!formModal) return;
    if (!formConfirmStep) {
      setFormConfirmStep(true);
      return;
    }
    let label = '';
    if (formModal === 'invoice') label = `Invoice issued to ${formTenant} for $${formAmount}`;
    else if (formModal === 'refund') label = `Refund of $${formAmount} issued to ${formTenant}`;
    else if (formModal === 'credit') label = `Credit note of $${formAmount} created for ${formTenant}`;
    else if (formModal === 'apply_credit') {
      const credit = creditNotes.find(c => c.creditNo === formCreditId);
      const invoice = invoiceHistory.find(i => i.invoiceNo === formInvoiceId);
      if (credit && invoice) {
        const creditRemaining = credit.amount - credit.appliedAmount;
        const applyAmount = Math.min(creditRemaining, invoice.total);
        const newApplied = credit.appliedAmount + applyAmount;
        label = `$${applyAmount.toFixed(2)} from ${formCreditId} applied to ${formInvoiceId}`;
        setCreditNotes(prev => prev.map(c =>
          c.creditNo === formCreditId
            ? { ...c, appliedAmount: newApplied, appliedToInvoice: formInvoiceId, appliedDate: new Date().toISOString().split('T')[0], status: newApplied >= c.amount ? 'applied' as const : 'issued' as const }
            : c
        ));
      } else {
        label = `Credit ${formCreditId} applied to ${formInvoiceId}`;
      }
    }
    setFormModal(null);
    setFormConfirmStep(false);
    setFormTenant('');
    setFormAmount('');
    setFormReason('');
    setFormPlan('');
    setFormCreditId('');
    setFormInvoiceId('');
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
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => { setFormModal('invoice'); setFormTenant(''); setFormAmount(''); setFormPlan(''); setFormReason(''); }} className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">receipt</span>
            Issue Invoice
          </button>
          <button onClick={() => { setFormModal('credit'); setFormTenant(''); setFormAmount(''); setFormReason(''); }} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">note_add</span>
            Issue Credit
          </button>
          <button onClick={() => { setFormModal('apply_credit'); setFormCreditId(''); setFormInvoiceId(''); }} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">link</span>
            Apply Credit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
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
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Refunded</p>
          <p className="text-3xl font-black text-amber-600">${refundedTotal}</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Credits</p>
          <p className="text-3xl font-black text-violet-600">${creditTotal}</p>
          <p className="text-[10px] font-black text-violet-400 mt-1">${appliedCreditTotal} applied</p>
        </div>
        <div className={`bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border shadow-sm ${unappliedCreditTotal > 0 ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Unapplied Credits</p>
          <p className={`text-3xl font-black ${unappliedCreditTotal > 0 ? 'text-amber-600' : 'text-lime-600'}`}>${unappliedCreditTotal}</p>
          <p className="text-[10px] font-black text-amber-400 mt-1">{creditNotes.filter(c => c.status === 'issued').length} unapplied</p>
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
            <span className="material-symbols-outlined text-sm">{tab.icon}</span>
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
              <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Credits & Refund Notes</h3>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    Total: <span className="text-violet-600">${creditTotal}</span> · Applied: <span className="text-lime-600">${appliedCreditTotal}</span> · Unapplied: <span className="text-amber-600">${unappliedCreditTotal}</span>
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50">
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Credit #</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Type</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Applied</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Remaining</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Source Invoice</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Applied To</th>
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
                        <td className="px-6 py-3">{typeBadge(cr.type)}</td>
                        <td className="px-6 py-3 text-sm text-slate-500">{cr.date}</td>
                        <td className="px-6 py-3 font-black text-violet-600 text-sm">${cr.amount}</td>
                        <td className="px-6 py-3 font-bold text-lime-600 text-sm">${cr.appliedAmount}</td>
                        <td className="px-6 py-3 font-bold text-sm">
                          <span className={cr.amount - cr.appliedAmount > 0 ? 'text-amber-600' : 'text-slate-400'}>${cr.amount - cr.appliedAmount}</span>
                        </td>
                        <td className="px-6 py-3">
                          {cr.relatedInvoice ? (
                            <button
                              onClick={() => {
                                const inv = invoiceHistory.find(i => i.invoiceNo === cr.relatedInvoice);
                                if (inv) setDetailModal({ type: 'invoice', data: inv });
                              }}
                              className="text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                            >{cr.relatedInvoice}</button>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-6 py-3">
                          {cr.appliedToInvoice ? (
                            <button
                              onClick={() => {
                                const inv = invoiceHistory.find(i => i.invoiceNo === cr.appliedToInvoice);
                                if (inv) setDetailModal({ type: 'invoice', data: inv });
                              }}
                              className="text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                            >{cr.appliedToInvoice}</button>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-6 py-3">{statusBadge(cr.status)}</td>
                      </tr>
                    ))}
                    {filteredCredits.length === 0 && (
                      <tr><td colSpan={10} className="px-6 py-12 text-center text-slate-400 font-bold">No credit notes found.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'ledger' && (
            <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
              <div className="px-8 py-5 border-b border-slate-100">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Tenant Billing Ledger</h3>
                <p className="text-[10px] text-slate-400 font-bold mt-1">Account balances, billing history, and credit positions per tenant.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50">
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Plan</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">MRR</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Billed</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Paid</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Overdue</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Credits</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Unapplied</th>
                      <th className="px-6 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenantLedger.map(t => (
                      <tr key={t.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-3 font-bold text-slate-900 text-sm">{t.name}</td>
                        <td className="px-6 py-3 text-xs text-slate-500">{t.plan}</td>
                        <td className="px-6 py-3 font-black text-primary text-sm">${t.mrr}/mo</td>
                        <td className="px-6 py-3 font-bold text-slate-900 text-sm">${t.totalBilled.toFixed(2)}</td>
                        <td className="px-6 py-3 font-bold text-lime-600 text-sm">${t.totalPaid.toFixed(2)}</td>
                        <td className="px-6 py-3 font-black text-sm">
                          <span className={t.overdueAmount > 0 ? 'text-red-600' : 'text-slate-300'}>${t.overdueAmount.toFixed(2)}</span>
                        </td>
                        <td className="px-6 py-3 font-bold text-violet-600 text-sm">${t.totalCredits.toFixed(2)}</td>
                        <td className="px-6 py-3 font-bold text-sm">
                          <span className={t.unapplied > 0 ? 'text-amber-600' : 'text-slate-300'}>${t.unapplied.toFixed(2)}</span>
                        </td>
                        <td className="px-6 py-3">{statusBadge(t.status)}</td>
                      </tr>
                    ))}
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

          {unappliedCreditTotal > 0 && (
            <div className="bg-violet-50/80 backdrop-blur-xl p-6 rounded-[2rem] border border-violet-200 shadow-sm">
              <p className="text-[10px] font-black text-violet-700 uppercase tracking-widest mb-4 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">account_balance_wallet</span>
                Unapplied Credits
              </p>
              <div className="space-y-3">
                {creditNotes.filter(c => c.amount - c.appliedAmount > 0).map(cr => (
                  <div key={cr.id} className="flex justify-between items-center p-3 bg-white/60 rounded-xl">
                    <div>
                      <p className="text-sm font-bold text-slate-900">{cr.tenant}</p>
                      <p className="text-[10px] text-slate-400">{cr.creditNo} · ${cr.amount - cr.appliedAmount} remaining</p>
                    </div>
                    <button onClick={() => { setFormModal('apply_credit'); setFormCreditId(cr.creditNo); setFormInvoiceId(''); }} className="text-[9px] font-black text-violet-600 uppercase tracking-widest hover:text-violet-800">Apply</button>
                  </div>
                ))}
              </div>
            </div>
          )}
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
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden max-h-[85vh] overflow-y-auto"
            >
              {detailModal.type === 'invoice' && (() => {
                const inv = detailModal.data;
                const relatedCredits = creditNotes.filter(c => c.relatedInvoice === inv.invoiceNo || c.appliedToInvoice === inv.invoiceNo);
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
                      {relatedCredits.length > 0 && (
                        <div>
                          <p className={labelClass}>Related Credits</p>
                          <div className="space-y-2">
                            {relatedCredits.map(cr => (
                              <button key={cr.id} onClick={() => setDetailModal({ type: 'credit', data: cr })} className="w-full flex justify-between items-center p-3 bg-violet-50 rounded-xl hover:bg-violet-100 transition-colors text-left">
                                <div>
                                  <p className="text-sm font-bold text-violet-700">{cr.creditNo}</p>
                                  <p className="text-[10px] text-slate-400">{cr.reason}</p>
                                </div>
                                <div className="text-right">
                                  <p className="font-black text-violet-600">${cr.amount}</p>
                                  <p className="text-[9px] font-bold text-slate-400">{cr.status}</p>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}

              {detailModal.type === 'credit' && (() => {
                const cr = detailModal.data;
                const remaining = cr.amount - cr.appliedAmount;
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
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <p className={labelClass}>Date Issued</p>
                          <p className="font-bold text-slate-900">{cr.date}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Credit Amount</p>
                          <p className="font-black text-violet-600 text-xl">${cr.amount}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Type</p>
                          {typeBadge(cr.type)}
                        </div>
                      </div>

                      <div className="bg-violet-50 rounded-xl p-4 border border-violet-100">
                        <p className={labelClass}>Application Status</p>
                        <div className="grid grid-cols-3 gap-4 mt-2">
                          <div>
                            <p className="text-[10px] font-bold text-slate-500">Applied</p>
                            <p className="font-black text-lime-600 text-lg">${cr.appliedAmount}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-slate-500">Remaining</p>
                            <p className={`font-black text-lg ${remaining > 0 ? 'text-amber-600' : 'text-slate-400'}`}>${remaining}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-slate-500">Coverage</p>
                            <p className="font-black text-primary text-lg">{cr.amount > 0 ? Math.round((cr.appliedAmount / cr.amount) * 100) : 0}%</p>
                          </div>
                        </div>
                        {cr.amount === cr.appliedAmount && (
                          <div className="mt-3 p-2 bg-lime-50 rounded-lg border border-lime-100">
                            <p className="text-[10px] font-black text-lime-700 uppercase tracking-widest flex items-center gap-1">
                              <span className="material-symbols-outlined text-xs">check_circle</span>
                              Fully Applied
                            </p>
                          </div>
                        )}
                        {remaining > 0 && (
                          <div className="mt-3 p-2 bg-amber-50 rounded-lg border border-amber-100">
                            <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest flex items-center gap-1">
                              <span className="material-symbols-outlined text-xs">schedule</span>
                              ${remaining} remains on account
                            </p>
                          </div>
                        )}
                      </div>

                      <div>
                        <p className={labelClass}>Reason</p>
                        <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">{cr.reason}</p>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        {cr.relatedInvoice && (
                          <div>
                            <p className={labelClass}>Source Invoice</p>
                            <button
                              onClick={() => {
                                const inv = invoiceHistory.find(i => i.invoiceNo === cr.relatedInvoice);
                                if (inv) setDetailModal({ type: 'invoice', data: inv });
                              }}
                              className="text-sm font-bold text-blue-600 hover:text-blue-800 hover:underline"
                            >{cr.relatedInvoice}</button>
                            <p className="text-[10px] text-slate-400 mt-0.5">Original charge this credit relates to</p>
                          </div>
                        )}
                        {cr.appliedToInvoice && (
                          <div>
                            <p className={labelClass}>Applied To Invoice</p>
                            <button
                              onClick={() => {
                                const inv = invoiceHistory.find(i => i.invoiceNo === cr.appliedToInvoice);
                                if (inv) setDetailModal({ type: 'invoice', data: inv });
                              }}
                              className="text-sm font-bold text-blue-600 hover:text-blue-800 hover:underline"
                            >{cr.appliedToInvoice}</button>
                            {cr.appliedDate && <p className="text-[10px] text-slate-400 mt-0.5">Applied on {cr.appliedDate}</p>}
                          </div>
                        )}
                      </div>

                      {remaining > 0 && (
                        <button
                          onClick={() => { setDetailModal(null); setFormModal('apply_credit'); setFormCreditId(cr.creditNo); setFormInvoiceId(''); }}
                          className="w-full py-3 bg-violet-600 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-violet-700 transition-all shadow-lg shadow-violet-600/20"
                        >Apply Remaining ${remaining} to Invoice</button>
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
          <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={closeFormModal}>
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
                    {formModal === 'invoice' ? 'Issue Invoice' : formModal === 'refund' ? 'Issue Refund' : formModal === 'apply_credit' ? 'Apply Credit to Invoice' : 'Issue Credit Note'}
                  </h3>
                  <p className="text-sm text-slate-500 mt-1">
                    {formModal === 'invoice' ? 'Create a new invoice for a tenant.' : formModal === 'refund' ? 'Process a refund to a tenant.' : formModal === 'apply_credit' ? 'Apply an existing credit note against an invoice.' : 'Create a credit note for a tenant.'}
                  </p>
                </div>
                <button onClick={closeFormModal} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="p-8 space-y-5">
                {formModal === 'apply_credit' ? (
                  (() => {
                    const selectedCredit = formCreditId ? creditNotes.find(c => c.creditNo === formCreditId) : null;
                    const creditRemaining = selectedCredit ? selectedCredit.amount - selectedCredit.appliedAmount : 0;
                    const creditTenant = selectedCredit?.tenant || '';
                    const eligibleInvoices = creditTenant
                      ? getCreditEligibleInvoices(invoiceHistory, creditTenant)
                      : [];
                    const noBalance = selectedCredit && creditRemaining <= 0;
                    const noEligible = selectedCredit && !noBalance && eligibleInvoices.length === 0;
                    const eligibilityLabel = 'overdue';
                    return (
                      <>
                        <div>
                          <label className={labelClass}>Credit Note</label>
                          <select value={formCreditId} onChange={e => { setFormCreditId(e.target.value); setFormInvoiceId(''); }} className={inputClass}>
                            <option value="">Select credit note...</option>
                            {creditNotes.map(c => {
                              const rem = c.amount - c.appliedAmount;
                              return (
                                <option key={c.id} value={c.creditNo}>
                                  {c.creditNo} — {c.tenant} — {rem > 0 ? `$${rem.toFixed(2)} remaining` : 'Fully applied'}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                        {selectedCredit && (
                          <div className={`rounded-xl p-4 border ${noBalance ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100'}`}>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Selected Credit</p>
                            <p className="text-sm font-bold text-slate-900">{selectedCredit.creditNo} · {creditTenant}</p>
                            <p className="text-[10px] text-slate-500 mt-0.5">{selectedCredit.reason} · Total: ${selectedCredit.amount.toFixed(2)}</p>
                            {noBalance
                              ? <p className="text-[10px] font-black text-red-600 mt-1 uppercase tracking-widest">No available balance — fully applied</p>
                              : <p className="text-[10px] font-black text-violet-600 mt-1">${creditRemaining.toFixed(2)} available to apply</p>
                            }
                          </div>
                        )}
                        <div>
                          <label className={labelClass}>Apply to Invoice</label>
                          <select
                            value={formInvoiceId}
                            onChange={e => setFormInvoiceId(e.target.value)}
                            className={`${inputClass} ${(!formCreditId || noBalance || noEligible) ? 'opacity-50 cursor-not-allowed' : ''}`}
                            disabled={!formCreditId || !!noBalance || !!noEligible}
                          >
                            <option value="">{!formCreditId ? 'Select a credit note first...' : noBalance ? 'No balance available' : noEligible ? `No eligible invoices for ${creditTenant}` : `Select invoice (${eligibilityLabel})...`}</option>
                            {eligibleInvoices.map(i => (
                              <option key={i.id} value={i.invoiceNo}>{i.invoiceNo} — {i.tenant} — ${i.total.toFixed(2)} ({i.status})</option>
                            ))}
                          </select>
                          {noEligible && (
                            <p className="text-[10px] font-black text-amber-600 mt-2 flex items-center gap-1">
                              <span className="material-symbols-outlined text-sm">info</span>
                              No {eligibilityLabel} invoices found for {creditTenant}. Only {eligibilityLabel} invoices are eligible for credit application.
                            </p>
                          )}
                        </div>
                        {formCreditId && formInvoiceId && !noBalance && (
                          <div className="bg-violet-50 rounded-xl p-4 border border-violet-100">
                            <p className="text-[10px] font-black text-violet-700 uppercase tracking-widest mb-1">Preview</p>
                            <p className="text-sm text-slate-700">{formCreditId} (${creditRemaining.toFixed(2)} available) will be applied to {formInvoiceId}.</p>
                          </div>
                        )}
                      </>
                    );
                  })()
                ) : (
                  <>
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
                    {formModal === 'credit' && (
                      <div>
                        <label className={labelClass}>Related Invoice (Optional)</label>
                        <select value={formInvoiceId} onChange={e => setFormInvoiceId(e.target.value)} className={inputClass}>
                          <option value="">No related invoice</option>
                          {invoiceHistory.filter(i => formTenant ? i.tenant === formTenant : true).map(i => (
                            <option key={i.id} value={i.invoiceNo}>{i.invoiceNo} — ${i.total.toFixed(2)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>
              {formConfirmStep && (
                <div className="px-8 py-4 bg-amber-50 border-t border-amber-100">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-amber-600 text-sm">warning</span>
                    <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest">Confirm Action</p>
                  </div>
                  <p className="text-sm text-amber-700">
                    {formModal === 'invoice' ? `Issue invoice of $${formAmount} to ${formTenant}?`
                      : formModal === 'refund' ? `Refund $${formAmount} to ${formTenant}? This cannot be undone.`
                      : formModal === 'apply_credit' ? `Apply ${formCreditId} to ${formInvoiceId}?`
                      : `Create credit note of $${formAmount} for ${formTenant}?`}
                  </p>
                </div>
              )}
              <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <button onClick={() => { if (formConfirmStep) { setFormConfirmStep(false); } else { closeFormModal(); } }} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">
                  {formConfirmStep ? 'Go Back' : 'Cancel'}
                </button>
                <button
                  onClick={submitForm}
                  disabled={formModal === 'apply_credit' ? (!formCreditId || !formInvoiceId) : (!formTenant || !formAmount)}
                  className={`flex-1 py-4 font-black text-sm rounded-2xl shadow-lg uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed ${formConfirmStep ? 'bg-amber-500 text-white shadow-amber-500/20 hover:bg-amber-600' : 'bg-primary text-white shadow-primary/20 hover:bg-primary/90'}`}
                >
                  {formConfirmStep
                    ? (formModal === 'invoice' ? 'Confirm & Issue' : formModal === 'refund' ? 'Confirm Refund' : formModal === 'apply_credit' ? 'Confirm Apply' : 'Confirm Credit')
                    : (formModal === 'invoice' ? 'Issue Invoice' : formModal === 'refund' ? 'Process Refund' : formModal === 'apply_credit' ? 'Apply Credit' : 'Create Credit')
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
