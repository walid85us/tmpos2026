import React, { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import type { Invoice } from '../types';

type InvoiceView = 'list' | 'detail';

export default function Invoices() {
  const { invoices, addInvoice, updateInvoice, customers, services } = useStoreLocalState();
  const { checkPermission } = useAccess();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [view, setView] = useState<InvoiceView>('list');
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);

  const [newInv, setNewInv] = useState({
    customerId: '',
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    isRecurring: false,
    recurringInterval: 'monthly' as 'monthly' | 'weekly' | 'yearly',
    notes: '',
    terms: '',
    items: [{ name: '', quantity: 1, price: 0, type: 'product' as 'product' | 'repair' | 'service' }],
    discount: 0,
  });

  const [paymentAmount, setPaymentAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('Cash');

  const canCreate = checkPermission('invoices', 'create');
  const canEdit = checkPermission('invoices', 'edit');

  const filteredInvoices = useMemo(() => {
    let result = invoices;
    if (statusFilter !== 'All') {
      result = result.filter(inv => inv.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(inv =>
        inv.invoiceNumber.toLowerCase().includes(q) ||
        inv.customerName.toLowerCase().includes(q) ||
        (inv.customerEmail || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [invoices, searchQuery, statusFilter]);

  const stats = useMemo(() => {
    const outstanding = invoices.filter(i => i.status !== 'Paid' && i.status !== 'Cancelled').reduce((s, i) => s + i.balance, 0);
    const today = new Date().toISOString().slice(0, 10);
    const paidToday = invoices.filter(i => i.status === 'Paid' && i.paymentHistory.some(p => p.timestamp.startsWith(today))).reduce((s, i) => s + i.total, 0);
    const overdue = invoices.filter(i => i.status === 'Overdue').length;
    const recurring = invoices.filter(i => i.isRecurring).reduce((s, i) => s + i.total, 0);
    return { outstanding, paidToday, overdue, recurring };
  }, [invoices]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Paid': return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
      case 'Partially Paid': return 'bg-amber-500/10 text-amber-600 border-amber-500/20';
      case 'Unpaid': return 'bg-slate-500/10 text-slate-600 border-slate-500/20';
      case 'Overdue': return 'bg-rose-500/10 text-rose-600 border-rose-500/20';
      case 'Cancelled': return 'bg-red-500/10 text-red-600 border-red-500/20';
      default: return 'bg-slate-500/10 text-slate-600 border-slate-500/20';
    }
  };

  const resetNewInv = () => {
    setNewInv({
      customerId: '',
      dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      isRecurring: false,
      recurringInterval: 'monthly',
      notes: '',
      terms: '',
      items: [{ name: '', quantity: 1, price: 0, type: 'product' }],
      discount: 0,
    });
  };

  const newInvSubtotal = useMemo(() => newInv.items.reduce((s, i) => s + i.quantity * i.price, 0), [newInv.items]);
  const newInvTax = useMemo(() => (newInvSubtotal - newInv.discount) * 0.08, [newInvSubtotal, newInv.discount]);
  const newInvTotal = useMemo(() => newInvSubtotal - newInv.discount + newInvTax, [newInvSubtotal, newInv.discount, newInvTax]);

  const handleCreateInvoice = useCallback(() => {
    const customer = customers.find(c => c.id === newInv.customerId);
    if (!customer || newInv.items.every(i => !i.name.trim())) return;
    const validItems = newInv.items.filter(i => i.name.trim());
    const subtotal = validItems.reduce((s, i) => s + i.quantity * i.price, 0);
    const disc = newInv.discount;
    const tax = (subtotal - disc) * 0.08;
    const total = subtotal - disc + tax;
    const inv: Invoice = {
      id: `inv-${Date.now()}`,
      invoiceNumber: `INV-${new Date().getFullYear()}-${String(invoices.length + 1).padStart(3, '0')}`,
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      items: validItems.map((it, idx) => ({ id: `ii-${Date.now()}-${idx}`, name: it.name, quantity: it.quantity, price: it.price, type: it.type })),
      subtotal,
      discount: disc,
      tax: Math.round(tax * 100) / 100,
      total: Math.round(total * 100) / 100,
      amountPaid: 0,
      balance: Math.round(total * 100) / 100,
      status: 'Unpaid',
      createdAt: new Date().toISOString().slice(0, 10),
      dueDate: newInv.dueDate,
      notes: newInv.notes || undefined,
      terms: newInv.terms || undefined,
      isRecurring: newInv.isRecurring || undefined,
      recurringInterval: newInv.isRecurring ? newInv.recurringInterval : undefined,
      paymentHistory: [],
      remindersSent: 0,
    };
    addInvoice(inv);
    resetNewInv();
    setShowAddModal(false);
  }, [newInv, customers, invoices, addInvoice]);

  const handleApplyPayment = useCallback(() => {
    if (!selectedInvoice || paymentAmount <= 0) return;
    const newPaid = selectedInvoice.amountPaid + paymentAmount;
    const newBalance = Math.max(0, Math.round((selectedInvoice.total - newPaid) * 100) / 100);
    const newStatus: Invoice['status'] = newBalance <= 0 ? 'Paid' : 'Partially Paid';
    const payment = { id: `pay-${Date.now()}`, amount: paymentAmount, method: paymentMethod, timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16) };
    updateInvoice(selectedInvoice.id, {
      amountPaid: Math.round(newPaid * 100) / 100,
      balance: newBalance,
      status: newStatus,
      paymentHistory: [...selectedInvoice.paymentHistory, payment],
    });
    setSelectedInvoice(prev => prev ? { ...prev, amountPaid: Math.round(newPaid * 100) / 100, balance: newBalance, status: newStatus, paymentHistory: [...prev.paymentHistory, payment] } : null);
    setShowPaymentModal(false);
    setPaymentAmount(0);
    setPaymentMethod('Cash');
  }, [selectedInvoice, paymentAmount, paymentMethod, updateInvoice]);

  const addLineItem = () => setNewInv(prev => ({ ...prev, items: [...prev.items, { name: '', quantity: 1, price: 0, type: 'product' }] }));
  const removeLineItem = (idx: number) => setNewInv(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));
  const updateLineItem = (idx: number, field: string, value: string | number) => {
    setNewInv(prev => ({ ...prev, items: prev.items.map((it, i) => i === idx ? { ...it, [field]: value } : it) }));
  };

  const pickService = (idx: number, serviceId: string) => {
    const svc = services.find(s => s.id === serviceId);
    if (!svc) return;
    setNewInv(prev => ({
      ...prev,
      items: prev.items.map((it, i) => i === idx ? { ...it, name: svc.name, price: svc.price, type: 'repair' } : it),
    }));
  };

  const openInvoiceDetail = (inv: Invoice) => {
    setSelectedInvoice(inv);
    setView('detail');
  };

  const renderList = () => (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Billing & Sales</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Invoices</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input
              type="text"
              placeholder="Search invoices..."
              className="pl-11 pr-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-900 w-64 shadow-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-600 shadow-sm appearance-none"
          >
            <option>All</option>
            <option>Unpaid</option>
            <option>Partially Paid</option>
            <option>Paid</option>
            <option>Overdue</option>
            <option>Cancelled</option>
          </select>
          {canCreate && (
            <button
              onClick={() => { resetNewInv(); setShowAddModal(true); }}
              className="bg-primary text-white px-6 py-3 rounded-2xl font-black text-xs shadow-lg shadow-primary/20 flex items-center gap-2 uppercase tracking-widest hover:bg-primary/90 transition-all"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              Create Invoice
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { label: 'Total Outstanding', value: `$${stats.outstanding.toFixed(2)}`, color: 'text-rose-500', icon: 'account_balance_wallet' },
          { label: 'Paid Today', value: `$${stats.paidToday.toFixed(2)}`, color: 'text-emerald-500', icon: 'payments' },
          { label: 'Overdue Invoices', value: String(stats.overdue), color: 'text-amber-500', icon: 'event_busy' },
          { label: 'Recurring Revenue', value: `$${stats.recurring.toFixed(2)}/cycle`, color: 'text-primary', icon: 'sync' }
        ].map((stat, i) => (
          <div key={i} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm flex items-center gap-4">
            <div className={`w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center ${stat.color}`}>
              <span className="material-symbols-outlined">{stat.icon}</span>
            </div>
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</p>
              <p className={`text-2xl font-black ${stat.color}`}>{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoice #</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Total</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredInvoices.map((inv) => (
              <tr key={inv.id} onClick={() => openInvoiceDetail(inv)} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group cursor-pointer">
                <td className="px-8 py-6">
                  <span className="font-black text-primary text-xs">{inv.invoiceNumber}</span>
                  {inv.isRecurring && (
                    <span className="ml-2 px-2 py-0.5 bg-primary/10 text-primary text-[8px] font-black uppercase rounded-full">Recurring</span>
                  )}
                </td>
                <td className="px-8 py-6">
                  <p className="text-sm font-bold text-slate-900">{inv.customerName}</p>
                  <p className="text-[10px] text-slate-400 font-medium">{inv.customerEmail}</p>
                </td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{inv.createdAt}</td>
                <td className="px-8 py-6 text-sm font-black text-slate-900">${inv.total.toFixed(2)}</td>
                <td className="px-8 py-6 text-sm font-black text-rose-500">${inv.balance.toFixed(2)}</td>
                <td className="px-8 py-6">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(inv.status)}`}>
                    {inv.status}
                  </span>
                </td>
                <td className="px-8 py-6 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                    {canEdit && inv.status !== 'Paid' && inv.status !== 'Cancelled' && (
                      <button
                        onClick={() => { setSelectedInvoice(inv); setPaymentAmount(inv.balance); setShowPaymentModal(true); }}
                        className="p-2 hover:bg-emerald-50 text-emerald-600 rounded-xl transition-colors"
                        title="Add Payment"
                      >
                        <span className="material-symbols-outlined text-sm">payments</span>
                      </button>
                    )}
                    <button onClick={() => window.print()} className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Print">
                      <span className="material-symbols-outlined text-sm">print</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredInvoices.length === 0 && (
              <tr><td colSpan={7} className="px-8 py-12 text-center text-sm text-slate-400 font-bold">No invoices found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderDetail = () => {
    if (!selectedInvoice) return null;
    return (
      <div className="space-y-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <button onClick={() => setView('list')} className="w-12 h-12 bg-white rounded-2xl border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary transition-all shadow-sm">
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div>
              <h2 className="text-3xl font-black text-primary tracking-tight font-headline">{selectedInvoice.invoiceNumber}</h2>
              <div className="flex items-center gap-3 mt-1">
                <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(selectedInvoice.status)}`}>
                  {selectedInvoice.status}
                </span>
                {selectedInvoice.isRecurring && (
                  <span className="px-2 py-0.5 bg-primary/10 text-primary text-[8px] font-black uppercase rounded-full">Recurring · {selectedInvoice.recurringInterval}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            {canEdit && selectedInvoice.status !== 'Paid' && selectedInvoice.status !== 'Cancelled' && (
              <button
                onClick={() => { setPaymentAmount(selectedInvoice.balance); setShowPaymentModal(true); }}
                className="px-6 py-2.5 bg-emerald-500 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 active:scale-95 transition-all flex items-center gap-2"
              >
                <span className="material-symbols-outlined text-sm">payments</span>
                Add Payment
              </button>
            )}
            <button onClick={() => window.print()} className="px-6 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-black text-xs uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">print</span>
              Print
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-8 space-y-8">
            <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
              <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-6">Line Items</h3>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Item</th>
                    <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Type</th>
                    <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Qty</th>
                    <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Price</th>
                    <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedInvoice.items.map(item => (
                    <tr key={item.id} className="border-b border-slate-50 last:border-0">
                      <td className="py-4 text-sm font-bold text-slate-900">{item.name}</td>
                      <td className="py-4 text-center">
                        <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${
                          item.type === 'repair' ? 'bg-blue-100 text-blue-700' :
                          item.type === 'service' ? 'bg-violet-100 text-violet-700' :
                          'bg-slate-100 text-slate-600'
                        }`}>{item.type}</span>
                      </td>
                      <td className="py-4 text-center text-sm font-bold text-slate-600">{item.quantity}</td>
                      <td className="py-4 text-right text-sm font-bold text-slate-600">${item.price.toFixed(2)}</td>
                      <td className="py-4 text-right text-sm font-black text-primary">${(item.quantity * item.price).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-6 pt-6 border-t border-slate-100 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-slate-500 font-bold">Subtotal</span><span className="font-black text-slate-900">${selectedInvoice.subtotal.toFixed(2)}</span></div>
                {selectedInvoice.discount > 0 && (
                  <div className="flex justify-between text-sm"><span className="text-emerald-500 font-bold">Discount</span><span className="font-black text-emerald-600">-${selectedInvoice.discount.toFixed(2)}</span></div>
                )}
                <div className="flex justify-between text-sm"><span className="text-slate-500 font-bold">Tax</span><span className="font-black text-slate-900">${selectedInvoice.tax.toFixed(2)}</span></div>
                <div className="flex justify-between text-lg pt-2 border-t border-slate-100"><span className="font-black text-primary">Total</span><span className="font-black text-primary">${selectedInvoice.total.toFixed(2)}</span></div>
              </div>
            </section>

            {selectedInvoice.paymentHistory.length > 0 && (
              <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-6">Payment History</h3>
                <div className="space-y-3">
                  {selectedInvoice.paymentHistory.map(pay => (
                    <div key={pay.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
                          <span className="material-symbols-outlined text-emerald-600 text-sm">check_circle</span>
                        </div>
                        <div>
                          <p className="text-sm font-black text-slate-900">${pay.amount.toFixed(2)}</p>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{pay.method}</p>
                        </div>
                      </div>
                      <span className="text-xs font-bold text-slate-400">{pay.timestamp}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div className="lg:col-span-4 space-y-8">
            <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
              <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-6">Customer</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Name</label>
                  <p className="text-sm font-bold text-slate-900">{selectedInvoice.customerName}</p>
                </div>
                {selectedInvoice.customerEmail && (
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Email</label>
                    <p className="text-sm font-bold text-slate-700">{selectedInvoice.customerEmail}</p>
                  </div>
                )}
                {selectedInvoice.customerPhone && (
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Phone</label>
                    <p className="text-sm font-bold text-slate-700">{selectedInvoice.customerPhone}</p>
                  </div>
                )}
              </div>
            </section>

            <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
              <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-6">Details</h3>
              <div className="space-y-4">
                <div className="flex justify-between">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Created</span>
                  <span className="text-xs font-bold text-slate-700">{selectedInvoice.createdAt}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Due Date</span>
                  <span className="text-xs font-bold text-slate-700">{selectedInvoice.dueDate}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount Paid</span>
                  <span className="text-xs font-black text-emerald-600">${selectedInvoice.amountPaid.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance</span>
                  <span className="text-xs font-black text-rose-600">${selectedInvoice.balance.toFixed(2)}</span>
                </div>
                {selectedInvoice.remindersSent !== undefined && selectedInvoice.remindersSent > 0 && (
                  <div className="flex justify-between">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reminders Sent</span>
                    <span className="text-xs font-bold text-amber-600">{selectedInvoice.remindersSent}</span>
                  </div>
                )}
              </div>
            </section>

            {selectedInvoice.notes && (
              <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-4">Notes</h3>
                <p className="text-xs font-medium text-slate-600 leading-relaxed">{selectedInvoice.notes}</p>
              </section>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <AnimatePresence mode="wait">
        <motion.div key={view} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}>
          {view === 'list' ? renderList() : renderDetail()}
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {showPaymentModal && selectedInvoice && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowPaymentModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Add Payment</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Invoice: {selectedInvoice.invoiceNumber}</p>
                </div>
                <button onClick={() => setShowPaymentModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Amount</p>
                    <p className="text-xl font-black text-slate-900">${selectedInvoice.total.toFixed(2)}</p>
                  </div>
                  <div className="p-4 bg-rose-50 rounded-2xl border border-rose-100">
                    <p className="text-[10px] font-black text-rose-400 uppercase tracking-widest">Remaining Balance</p>
                    <p className="text-xl font-black text-rose-600">${selectedInvoice.balance.toFixed(2)}</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Payment Amount</label>
                    <div className="relative">
                      <span className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                      <input
                        type="number"
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(parseFloat(e.target.value) || 0)}
                        max={selectedInvoice.balance}
                        className="w-full pl-10 pr-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-black text-primary"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Payment Method</label>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 appearance-none"
                    >
                      <option>Cash</option>
                      <option>Credit Card</option>
                      <option>Debit Card</option>
                      <option>Bank Transfer</option>
                      <option>Check</option>
                    </select>
                  </div>
                </div>
                <div className="pt-4">
                  <button onClick={handleApplyPayment} className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all">
                    Apply Payment
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowAddModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-4xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Create New Invoice</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Fill in the details below</p>
                </div>
                <button onClick={() => setShowAddModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>

              <div className="p-8 grid grid-cols-2 gap-8 overflow-y-auto flex-1">
                <div className="space-y-6">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Customer *</label>
                    <select
                      value={newInv.customerId}
                      onChange={(e) => setNewInv(prev => ({ ...prev, customerId: e.target.value }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    >
                      <option value="">Select Customer...</option>
                      {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Invoice Date</label>
                      <input type="date" value={new Date().toISOString().slice(0, 10)} readOnly className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Due Date</label>
                      <input
                        type="date"
                        value={newInv.dueDate}
                        onChange={(e) => setNewInv(prev => ({ ...prev, dueDate: e.target.value }))}
                        className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-4 p-4 bg-primary/5 rounded-2xl border border-primary/10">
                    <input
                      type="checkbox"
                      checked={newInv.isRecurring}
                      onChange={(e) => setNewInv(prev => ({ ...prev, isRecurring: e.target.checked }))}
                      className="w-5 h-5 rounded border-primary text-primary focus:ring-primary"
                    />
                    <div className="flex-1">
                      <p className="text-xs font-black text-primary uppercase tracking-widest">Recurring Invoice</p>
                      <p className="text-[10px] text-primary/60 font-bold">Automatically generate on schedule</p>
                    </div>
                    {newInv.isRecurring && (
                      <select
                        value={newInv.recurringInterval}
                        onChange={(e) => setNewInv(prev => ({ ...prev, recurringInterval: e.target.value as any }))}
                        className="px-3 py-1.5 bg-white rounded-xl border border-primary/20 text-xs font-bold text-primary appearance-none"
                      >
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="yearly">Yearly</option>
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Notes</label>
                    <textarea
                      value={newInv.notes}
                      onChange={(e) => setNewInv(prev => ({ ...prev, notes: e.target.value }))}
                      placeholder="Internal notes..."
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-medium text-sm h-20 resize-none"
                    />
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Line Items</label>
                    <div className="space-y-3 max-h-64 overflow-y-auto pr-2">
                      {newInv.items.map((item, idx) => (
                        <div key={idx} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={item.name}
                              onChange={(e) => updateLineItem(idx, 'name', e.target.value)}
                              placeholder="Item name..."
                              className="flex-1 px-4 py-2 bg-white rounded-xl border border-slate-200 text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20"
                            />
                            {newInv.items.length > 1 && (
                              <button onClick={() => removeLineItem(idx)} className="p-1.5 text-rose-400 hover:bg-rose-50 rounded-lg transition-colors">
                                <span className="material-symbols-outlined text-sm">close</span>
                              </button>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <select
                              value={item.type}
                              onChange={(e) => updateLineItem(idx, 'type', e.target.value)}
                              className="px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold text-slate-600 appearance-none"
                            >
                              <option value="product">Product</option>
                              <option value="repair">Repair</option>
                              <option value="service">Service</option>
                            </select>
                            {(item.type === 'repair' || item.type === 'service') && (
                              <select
                                onChange={(e) => pickService(idx, e.target.value)}
                                className="flex-1 px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold text-slate-600 appearance-none"
                                value=""
                              >
                                <option value="">Pick a service...</option>
                                {services.filter(s => s.status === 'Active').map(s => (
                                  <option key={s.id} value={s.id}>{s.name} — ${s.price.toFixed(2)}</option>
                                ))}
                              </select>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <div className="w-20">
                              <label className="text-[8px] font-black text-slate-400 uppercase block ml-1 mb-0.5">Qty</label>
                              <input
                                type="number"
                                min={1}
                                value={item.quantity}
                                onChange={(e) => updateLineItem(idx, 'quantity', parseInt(e.target.value) || 1)}
                                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-sm font-bold text-slate-700"
                              />
                            </div>
                            <div className="flex-1">
                              <label className="text-[8px] font-black text-slate-400 uppercase block ml-1 mb-0.5">Price</label>
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={item.price}
                                  onChange={(e) => updateLineItem(idx, 'price', parseFloat(e.target.value) || 0)}
                                  className="w-full pl-7 pr-3 py-2 bg-white rounded-xl border border-slate-200 text-sm font-bold text-slate-700"
                                />
                              </div>
                            </div>
                            <div className="w-24 text-right pt-5">
                              <span className="text-sm font-black text-primary">${(item.quantity * item.price).toFixed(2)}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                      <button
                        onClick={addLineItem}
                        className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 text-[10px] font-black uppercase tracking-widest hover:border-primary/40 hover:text-primary active:scale-95 transition-all"
                      >
                        + Add Line Item
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Discount ($)</label>
                    <div className="relative">
                      <span className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                      <input
                        type="number"
                        step="0.01"
                        value={newInv.discount}
                        onChange={(e) => setNewInv(prev => ({ ...prev, discount: parseFloat(e.target.value) || 0 }))}
                        className="w-full pl-10 pr-6 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-8 bg-slate-50/50 border-t border-slate-100 flex justify-between items-center shrink-0">
                <div className="flex gap-6">
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subtotal</p>
                    <p className="text-lg font-black text-slate-900">${newInvSubtotal.toFixed(2)}</p>
                  </div>
                  {newInv.discount > 0 && (
                    <div className="text-right">
                      <p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Discount</p>
                      <p className="text-lg font-black text-emerald-600">-${newInv.discount.toFixed(2)}</p>
                    </div>
                  )}
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tax (8%)</p>
                    <p className="text-lg font-black text-slate-900">${newInvTax.toFixed(2)}</p>
                  </div>
                  <div className="text-right px-6 border-l border-slate-200">
                    <p className="text-[10px] font-black text-primary uppercase tracking-widest">Total</p>
                    <p className="text-2xl font-black text-primary">${newInvTotal.toFixed(2)}</p>
                  </div>
                </div>
                <button
                  onClick={handleCreateInvoice}
                  disabled={!newInv.customerId || newInv.items.every(i => !i.name.trim())}
                  className="px-12 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Generate Invoice
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
