import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState, SEED_POS_OPERATORS } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { tenantRoles } from '../context/accessConfig';
import type { Invoice, RepairService, Shipment, ShipmentEvent } from '../types';
import { renderTemplate, buildLineItemsHtml, buildReceiptLineItemsHtml } from '../utils/templateBuilder';

export default function Invoices() {
  const { invoices, addInvoice, updateInvoice, customers, services, serviceCategories, approvedStockItems, storeBranding, documentTemplates, shipments, addShipment } = useStoreLocalState();
  const { checkPermission, checkSubPermission, canAccess } = useAccess();
  const canReopenInvoice = checkSubPermission('reopen_invoice');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');

  const [detailInvoice, setDetailInvoice] = useState<Invoice | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showSmsModal, setShowSmsModal] = useState(false);
  const [showOnlinePayModal, setShowOnlinePayModal] = useState(false);

  const [newInv, setNewInv] = useState({
    customerId: '',
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    isRecurring: false,
    recurringInterval: 'monthly' as 'monthly' | 'weekly' | 'yearly',
    notes: '',
    terms: '',
    items: [{ name: '', quantity: 1, price: 0, type: 'product' as 'product' | 'repair' | 'service', stockItemId: undefined as string | undefined }],
    discount: 0,
  });

  const [editInv, setEditInv] = useState({
    customerId: '',
    dueDate: '',
    isRecurring: false,
    recurringInterval: 'monthly' as 'monthly' | 'weekly' | 'yearly',
    notes: '',
    terms: '',
    items: [{ name: '', quantity: 1, price: 0, type: 'product' as 'product' | 'repair' | 'service', stockItemId: undefined as string | undefined }],
    discount: 0,
  });
  const [editingInvoiceId, setEditingInvoiceId] = useState('');

  const [paymentAmount, setPaymentAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [terminalState, setTerminalState] = useState<'idle' | 'pending_terminal' | 'confirmed' | 'failed' | 'cancelled'>('idle');
  const [cashConfirmPending, setCashConfirmPending] = useState(false);

  const [reopenPinModal, setReopenPinModal] = useState(false);
  const [reopenPin, setReopenPin] = useState('');
  const [reopenPinError, setReopenPinError] = useState('');
  const [printMode, setPrintMode] = useState<'fullpage' | 'receipt'>('fullpage');
  const printSurfaceRef = useRef<HTMLDivElement>(null);

  const [emailForm, setEmailForm] = useState({ to: '', subject: '', body: '' });
  const [smsBody, setSmsBody] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [smsSent, setSmsSent] = useState(false);

  const [productSearch, setProductSearch] = useState('');
  const [activeProductPickerIdx, setActiveProductPickerIdx] = useState<number | null>(null);
  const productPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (productPickerRef.current && !productPickerRef.current.contains(e.target as Node)) {
        setActiveProductPickerIdx(null);
      }
    };
    if (activeProductPickerIdx !== null) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [activeProductPickerIdx]);

  const canCreate = checkPermission('invoices', 'create');
  const canEdit = checkPermission('invoices', 'edit');

  const filteredInvoices = useMemo(() => {
    let result = invoices;
    if (statusFilter !== 'All') result = result.filter(inv => inv.status === statusFilter);
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
      customerId: '', dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      isRecurring: false, recurringInterval: 'monthly', notes: '', terms: '',
      items: [{ name: '', quantity: 1, price: 0, type: 'product' }], discount: 0,
    });
    setProductSearch('');
    setActiveProductPickerIdx(null);
  };

  const computeTotals = (items: typeof newInv.items, discount: number) => {
    const subtotal = items.reduce((s, i) => s + i.quantity * i.price, 0);
    const tax = (subtotal - discount) * 0.08;
    const total = subtotal - discount + tax;
    return { subtotal, tax: Math.round(tax * 100) / 100, total: Math.round(total * 100) / 100 };
  };

  const newInvTotals = useMemo(() => computeTotals(newInv.items, newInv.discount), [newInv.items, newInv.discount]);
  const editInvTotals = useMemo(() => computeTotals(editInv.items, editInv.discount), [editInv.items, editInv.discount]);

  const filteredProducts = useMemo(() => {
    if (!productSearch.trim()) return approvedStockItems.slice(0, 10);
    const q = productSearch.toLowerCase();
    return approvedStockItems.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
  }, [productSearch, approvedStockItems]);

  const servicesByCategory = useMemo(() => {
    const map: Record<string, RepairService[]> = {};
    services.filter(s => s.status === 'Active').forEach(s => {
      const catName = s.categoryName || 'Uncategorized';
      if (!map[catName]) map[catName] = [];
      map[catName].push(s);
    });
    return map;
  }, [services]);

  const handleCreateInvoice = useCallback(() => {
    const customer = customers.find(c => c.id === newInv.customerId);
    if (!customer || newInv.items.every(i => !i.name.trim())) return;
    const validItems = newInv.items.filter(i => i.name.trim());
    const { subtotal, tax, total } = computeTotals(validItems, newInv.discount);
    const inv: Invoice = {
      id: `inv-${Date.now()}`,
      invoiceNumber: `INV-${new Date().getFullYear()}-${String(invoices.length + 1).padStart(3, '0')}`,
      customerId: customer.id, customerName: customer.name, customerEmail: customer.email, customerPhone: customer.phone,
      items: validItems.map((it, idx) => ({ id: `ii-${Date.now()}-${idx}`, name: it.name, quantity: it.quantity, price: it.price, type: it.type, ...(it.stockItemId ? { stockItemId: it.stockItemId } : {}) })),
      subtotal, discount: newInv.discount, tax, total, amountPaid: 0, balance: total,
      status: 'Unpaid', createdAt: new Date().toISOString().slice(0, 10), dueDate: newInv.dueDate,
      notes: newInv.notes || undefined, terms: newInv.terms || undefined,
      isRecurring: newInv.isRecurring || undefined, recurringInterval: newInv.isRecurring ? newInv.recurringInterval : undefined,
      paymentHistory: [], remindersSent: 0,
      statusHistory: [{
        id: `sh-${Date.now()}`,
        action: 'created',
        fromStatus: '',
        toStatus: 'Unpaid',
        timestamp: new Date().toISOString(),
        note: 'Invoice created',
      }],
    };
    addInvoice(inv);
    resetNewInv();
    setShowAddModal(false);
  }, [newInv, customers, invoices, addInvoice]);

  const openEditInvoice = (inv: Invoice) => {
    const canEditFields = inv.status !== 'Paid' && inv.status !== 'Cancelled';
    if (!canEditFields) return;
    setEditInv({
      customerId: inv.customerId, dueDate: inv.dueDate,
      isRecurring: inv.isRecurring ?? false, recurringInterval: inv.recurringInterval || 'monthly',
      notes: inv.notes || '', terms: inv.terms || '',
      items: inv.items.map(it => ({ name: it.name, quantity: it.quantity, price: it.price, type: it.type, stockItemId: it.stockItemId })),
      discount: inv.discount,
    });
    setEditingInvoiceId(inv.id);
    setShowEditModal(true);
    setProductSearch('');
    setActiveProductPickerIdx(null);
  };

  const handleSaveEdit = useCallback(() => {
    const customer = customers.find(c => c.id === editInv.customerId);
    if (!customer) return;
    const validItems = editInv.items.filter(i => i.name.trim());
    if (validItems.length === 0) return;
    const { subtotal, tax, total } = computeTotals(validItems, editInv.discount);
    const existing = invoices.find(i => i.id === editingInvoiceId);
    if (!existing) return;
    const amountPaid = existing.amountPaid;
    const balance = Math.max(0, Math.round((total - amountPaid) * 100) / 100);
    const status: Invoice['status'] = balance <= 0 ? 'Paid' : amountPaid > 0 ? 'Partially Paid' : existing.status === 'Overdue' ? 'Overdue' : 'Unpaid';
    updateInvoice(editingInvoiceId, {
      customerId: customer.id, customerName: customer.name, customerEmail: customer.email, customerPhone: customer.phone,
      items: validItems.map((it, idx) => ({ id: `ii-${Date.now()}-${idx}`, name: it.name, quantity: it.quantity, price: it.price, type: it.type, ...(it.stockItemId ? { stockItemId: it.stockItemId } : {}) })),
      subtotal, discount: editInv.discount, tax, total, balance, status,
      dueDate: editInv.dueDate, notes: editInv.notes || undefined, terms: editInv.terms || undefined,
      isRecurring: editInv.isRecurring || undefined, recurringInterval: editInv.isRecurring ? editInv.recurringInterval : undefined,
    });
    const updated = { ...existing, customerId: customer.id, customerName: customer.name, customerEmail: customer.email, customerPhone: customer.phone,
      items: validItems.map((it, idx) => ({ id: `ii-${Date.now()}-${idx}`, name: it.name, quantity: it.quantity, price: it.price, type: it.type, ...(it.stockItemId ? { stockItemId: it.stockItemId } : {}) })),
      subtotal, discount: editInv.discount, tax, total, balance, status, dueDate: editInv.dueDate };
    setDetailInvoice(updated as Invoice);
    setShowEditModal(false);
  }, [editInv, editingInvoiceId, customers, invoices, updateInvoice]);

  const handleApplyPayment = useCallback(() => {
    if (!detailInvoice || paymentAmount <= 0) return;
    if (paymentMethod === 'Card Terminal' && terminalState !== 'confirmed') return;
    if (paymentMethod === 'Cash' && !cashConfirmPending) {
      setCashConfirmPending(true);
      return;
    }
    const newPaid = detailInvoice.amountPaid + paymentAmount;
    const newBalance = Math.max(0, Math.round((detailInvoice.total - newPaid) * 100) / 100);
    const newStatus: Invoice['status'] = newBalance <= 0 ? 'Paid' : 'Partially Paid';
    const payment = { id: `pay-${Date.now()}`, amount: paymentAmount, method: paymentMethod, timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16) };
    const statusEntry = {
      id: `sh-${Date.now()}`,
      action: (newBalance <= 0 ? 'paid' : 'partially_paid') as 'paid' | 'partially_paid',
      fromStatus: detailInvoice.status,
      toStatus: newStatus,
      timestamp: new Date().toISOString(),
      note: `$${paymentAmount.toFixed(2)} via ${paymentMethod}`,
    };
    const updatedStatusHistory = [...(detailInvoice.statusHistory || []), statusEntry];
    updateInvoice(detailInvoice.id, {
      amountPaid: Math.round(newPaid * 100) / 100, balance: newBalance, status: newStatus,
      paymentHistory: [...detailInvoice.paymentHistory, payment],
      statusHistory: updatedStatusHistory,
    });
    setDetailInvoice(prev => prev ? { ...prev, amountPaid: Math.round(newPaid * 100) / 100, balance: newBalance, status: newStatus, paymentHistory: [...prev.paymentHistory, payment], statusHistory: updatedStatusHistory } : null);
    setShowPaymentModal(false);
    setPaymentAmount(0);
    setPaymentMethod('Cash');
    setTerminalState('idle');
    setCashConfirmPending(false);
  }, [detailInvoice, paymentAmount, paymentMethod, terminalState, cashConfirmPending, updateInvoice]);

  const isCashPaidInvoice = useCallback((inv: Invoice | null): boolean => {
    if (!inv) return false;
    if (inv.paymentHistory.length === 0) return false;
    return inv.paymentHistory.every(p => p.method === 'Cash');
  }, []);

  const handleReopenInvoice = useCallback((supervisorName?: string) => {
    if (!detailInvoice) return;
    const total = detailInvoice.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const discount = detailInvoice.discount || 0;
    const subtotal = total - discount;
    const tax = subtotal * 0.08;
    const grandTotal = subtotal + tax;
    const historyEntry = {
      id: `sh-${Date.now()}`,
      action: (supervisorName ? 'reopened_supervisor' : 'reopened') as 'reopened' | 'reopened_supervisor',
      fromStatus: detailInvoice.status,
      toStatus: 'Unpaid',
      timestamp: new Date().toISOString(),
      actor: supervisorName || 'Current User',
      note: supervisorName ? `Supervisor authorization by ${supervisorName}` : 'Invoice reopened for editing',
    };
    const updatedHistory = [...(detailInvoice.statusHistory || []), historyEntry];
    updateInvoice(detailInvoice.id, { status: 'Unpaid', amountPaid: 0, balance: grandTotal, statusHistory: updatedHistory });
    setDetailInvoice(prev => prev ? { ...prev, status: 'Unpaid', amountPaid: 0, balance: grandTotal, statusHistory: updatedHistory } : null);
    setReopenPinModal(false);
    setReopenPin('');
    setReopenPinError('');
  }, [detailInvoice, updateInvoice]);

  const handleReopenPinSubmit = useCallback(() => {
    const supervisor = SEED_POS_OPERATORS.find(op => op.pin === reopenPin && op.role === 'Manager');
    if (!supervisor) {
      setReopenPinError('Invalid supervisor PIN');
      return;
    }
    const roleDef = tenantRoles.find(r => r.id === 'manager');
    if (roleDef && roleDef.subPermissions && !roleDef.subPermissions.reopen_invoice) {
      setReopenPinError('Supervisor role does not have reopen permission');
      return;
    }
    handleReopenInvoice(supervisor.name);
  }, [reopenPin, handleReopenInvoice]);

  const brandColor = '#003633';

  const renderedInvoiceHtml = useMemo(() => {
    if (!detailInvoice) return '';
    const invoiceTemplate = documentTemplates.find(t => t.type === 'invoice');
    if (!invoiceTemplate) return '';
    const latestPay = detailInvoice.paymentHistory.length > 0 ? detailInvoice.paymentHistory[detailInvoice.paymentHistory.length - 1] : null;
    const data: Record<string, string> = {
      '{{storeName}}': 'RepairHub',
      '{{storeTagline}}': 'Professional Repair Services',
      '{{brandColor}}': brandColor,
      '{{invoiceNumber}}': detailInvoice.invoiceNumber,
      '{{createdAt}}': detailInvoice.createdAt,
      '{{dueDate}}': detailInvoice.dueDate,
      '{{status}}': detailInvoice.status,
      '{{customerName}}': detailInvoice.customerName,
      '{{customerEmail}}': detailInvoice.customerEmail || '',
      '{{customerPhone}}': detailInvoice.customerPhone || '',
      '{{lineItems}}': buildLineItemsHtml(detailInvoice.items, brandColor),
      '{{subtotal}}': `$${detailInvoice.subtotal.toFixed(2)}`,
      '{{discount}}': detailInvoice.discount > 0 ? `$${detailInvoice.discount.toFixed(2)}` : '',
      '{{tax}}': `$${detailInvoice.tax.toFixed(2)}`,
      '{{total}}': `$${detailInvoice.total.toFixed(2)}`,
      '{{amountPaid}}': detailInvoice.amountPaid > 0 ? `$${detailInvoice.amountPaid.toFixed(2)}` : '',
      '{{balance}}': detailInvoice.balance > 0 ? `$${detailInvoice.balance.toFixed(2)}` : '',
      '{{latestPaymentAmount}}': latestPay ? `$${latestPay.amount.toFixed(2)}` : '',
      '{{latestPaymentMethod}}': latestPay ? latestPay.method : '',
      '{{latestPaymentDate}}': latestPay ? latestPay.timestamp.slice(0, 10) : '',
      '{{notes}}': detailInvoice.notes || '',
      '{{terms}}': detailInvoice.terms || '',
    };
    let html = renderTemplate(invoiceTemplate.content, data);
    if (storeBranding.logoUrl) {
      const justify = storeBranding.logoPlacement === 'top-left' ? 'flex-start' : storeBranding.logoPlacement === 'top-center' ? 'center' : 'flex-end';
      html = `<div style="display: flex; justify-content: ${justify}; margin-bottom: 12px;"><img src="${storeBranding.logoUrl}" alt="Logo" style="max-height: 48px; max-width: 200px; object-fit: contain;" /></div>` + html;
    }
    return html;
  }, [detailInvoice, documentTemplates, storeBranding, brandColor]);

  const renderedReceiptHtml = useMemo(() => {
    if (!detailInvoice) return '';
    const receiptTemplate = documentTemplates.find(t => t.type === 'receipt');
    if (!receiptTemplate) return '';
    const latestPayment = detailInvoice.paymentHistory.length > 0 ? detailInvoice.paymentHistory[detailInvoice.paymentHistory.length - 1] : null;
    const data: Record<string, string> = {
      '{{storeName}}': 'RepairHub',
      '{{storeTagline}}': 'Professional Repair Services',
      '{{brandColor}}': brandColor,
      '{{receiptNumber}}': detailInvoice.invoiceNumber,
      '{{date}}': detailInvoice.createdAt,
      '{{customerName}}': detailInvoice.customerName,
      '{{customerPhone}}': detailInvoice.customerPhone || '',
      '{{lineItems}}': buildReceiptLineItemsHtml(detailInvoice.items),
      '{{subtotal}}': `$${detailInvoice.subtotal.toFixed(2)}`,
      '{{tax}}': `$${detailInvoice.tax.toFixed(2)}`,
      '{{total}}': `$${detailInvoice.total.toFixed(2)}`,
      '{{amountPaid}}': `$${detailInvoice.amountPaid.toFixed(2)}`,
      '{{balance}}': detailInvoice.balance > 0 ? `$${detailInvoice.balance.toFixed(2)}` : '',
      '{{latestPaymentAmount}}': latestPayment ? `$${latestPayment.amount.toFixed(2)}` : '',
      '{{latestPaymentMethod}}': latestPayment ? latestPayment.method : '',
      '{{latestPaymentDate}}': latestPayment ? latestPayment.timestamp.slice(0, 10) : '',
    };
    let html = renderTemplate(receiptTemplate.content, data);
    if (storeBranding.logoUrl) {
      html = `<div style="display: flex; justify-content: center; margin-bottom: 6px;"><img src="${storeBranding.logoUrl}" alt="Logo" style="max-height: 32px; max-width: 60mm; object-fit: contain;" /></div>` + html;
    }
    return html;
  }, [detailInvoice, documentTemplates, storeBranding, brandColor]);

  const terminalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTerminalSend = useCallback(() => {
    if (paymentAmount <= 0) return;
    setTerminalState('pending_terminal');
    if (terminalTimerRef.current) clearTimeout(terminalTimerRef.current);
    terminalTimerRef.current = setTimeout(() => {
      setTerminalState(prev => prev === 'pending_terminal' ? 'confirmed' : prev);
      terminalTimerRef.current = null;
    }, 3000);
  }, [paymentAmount]);

  const addLineItem = (setter: typeof setNewInv) => setter(prev => ({ ...prev, items: [...prev.items, { name: '', quantity: 1, price: 0, type: 'product' as const, stockItemId: undefined as string | undefined }] }));
  const removeLineItem = (setter: typeof setNewInv, idx: number) => setter(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));
  const updateLineItem = (setter: typeof setNewInv, idx: number, field: string, value: string | number) => {
    setter(prev => ({ ...prev, items: prev.items.map((it, i) => i === idx ? { ...it, [field]: value } : it) }));
  };

  const pickService = (setter: typeof setNewInv, idx: number, serviceId: string) => {
    const svc = services.find(s => s.id === serviceId);
    if (!svc) return;
    setter(prev => ({
      ...prev,
      items: prev.items.map((it, i) => i === idx ? { ...it, name: svc.name, price: svc.price, type: 'service' as const } : it),
    }));
  };

  const pickProduct = (setter: typeof setNewInv, idx: number, productId: string) => {
    const prod = approvedStockItems.find(p => p.id === productId);
    if (!prod) return;
    setter(prev => ({
      ...prev,
      items: prev.items.map((it, i) => i === idx ? { ...it, name: prod.name, price: prod.price, type: 'product' as const, stockItemId: prod.id } : it),
    }));
    setActiveProductPickerIdx(null);
    setProductSearch('');
  };

  const openPaymentModal = (inv: Invoice) => {
    setDetailInvoice(inv);
    setPaymentAmount(inv.balance);
    setPaymentMethod('Cash');
    setShowPaymentModal(true);
  };

  const openEmailModal = (inv: Invoice) => {
    setEmailForm({
      to: inv.customerEmail || '',
      subject: `Invoice ${inv.invoiceNumber} — $${inv.total.toFixed(2)}`,
      body: `Dear ${inv.customerName},\n\nPlease find attached Invoice ${inv.invoiceNumber} for $${inv.total.toFixed(2)}.\n\nBalance Due: $${inv.balance.toFixed(2)}\nDue Date: ${inv.dueDate}\n\nThank you for your business.`,
    });
    setEmailSent(false);
    setShowEmailModal(true);
  };

  const openSmsModal = (inv: Invoice) => {
    setSmsBody(`Hi ${inv.customerName}, your invoice ${inv.invoiceNumber} for $${inv.total.toFixed(2)} is ready. Balance: $${inv.balance.toFixed(2)}. Due: ${inv.dueDate}. Pay online: [payment-link]`);
    setSmsSent(false);
    setShowSmsModal(true);
  };

  const renderLineItemEditor = (items: typeof newInv.items, setter: typeof setNewInv, mode: 'create' | 'edit') => (
    <div className="space-y-3 max-h-64 overflow-y-auto pr-2">
      {items.map((item, idx) => (
        <div key={idx} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
          <div className="flex items-center gap-2">
            <select
              value={item.type}
              onChange={(e) => updateLineItem(setter, idx, 'type', e.target.value)}
              className="px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold text-slate-600 appearance-none"
            >
              <option value="product">Product / Inventory</option>
              <option value="service">Service Catalog</option>
              <option value="repair">Repair Job</option>
            </select>
            {items.length > 1 && (
              <button onClick={() => removeLineItem(setter, idx)} className="ml-auto p-1.5 text-rose-400 hover:bg-rose-50 rounded-lg transition-colors">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            )}
          </div>

          {item.type === 'product' && (
            <div className="relative" ref={activeProductPickerIdx === idx ? productPickerRef : undefined}>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-slate-400 text-sm">search</span>
                <input
                  type="text"
                  value={activeProductPickerIdx === idx ? productSearch : item.name}
                  onChange={(e) => { setProductSearch(e.target.value); setActiveProductPickerIdx(idx); }}
                  onFocus={() => setActiveProductPickerIdx(idx)}
                  placeholder="Search inventory by name or SKU..."
                  className="flex-1 px-3 py-2 bg-white rounded-xl border border-slate-200 text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              {activeProductPickerIdx === idx && (
                <div className="absolute z-20 left-0 right-0 mt-1 bg-white rounded-xl border border-slate-200 shadow-xl max-h-40 overflow-y-auto">
                  {filteredProducts.length > 0 ? filteredProducts.map(p => (
                    <button
                      key={p.id}
                      onClick={() => pickProduct(setter, idx, p.id)}
                      className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors text-left"
                    >
                      <div>
                        <p className="text-sm font-bold text-slate-700">{p.name}</p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase">{p.sku} · {p.qty} in stock</p>
                      </div>
                      <span className="text-sm font-black text-primary">${p.price.toFixed(2)}</span>
                    </button>
                  )) : (
                    <p className="px-4 py-3 text-xs text-slate-400 italic">No matching inventory items</p>
                  )}
                </div>
              )}
            </div>
          )}

          {item.type === 'service' && (
            <select
              onChange={(e) => pickService(setter, idx, e.target.value)}
              className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold text-slate-600 appearance-none"
              value=""
            >
              <option value="">Pick from service catalog...</option>
              {(Object.entries(servicesByCategory) as [string, RepairService[]][]).map(([catName, svcs]) => (
                <optgroup key={catName} label={catName}>
                  {svcs.map(s => <option key={s.id} value={s.id}>{s.name} — ${s.price.toFixed(2)}</option>)}
                </optgroup>
              ))}
            </select>
          )}

          {item.type === 'repair' && (
            <select
              onChange={(e) => pickService(setter, idx, e.target.value)}
              className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold text-slate-600 appearance-none"
              value=""
            >
              <option value="">Pick a repair service...</option>
              {(Object.entries(servicesByCategory) as [string, RepairService[]][]).map(([catName, svcs]) => (
                <optgroup key={catName} label={`⚙ ${catName}`}>
                  {svcs.map(s => <option key={s.id} value={s.id}>{s.name} — ${s.price.toFixed(2)}{s.warrantyPeriod ? ` (${s.warrantyPeriod} warranty)` : ''}</option>)}
                </optgroup>
              ))}
            </select>
          )}

          {item.name && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-slate-100">
              <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${
                item.type === 'repair' ? 'bg-blue-100 text-blue-700' :
                item.type === 'service' ? 'bg-violet-100 text-violet-700' :
                'bg-slate-100 text-slate-600'
              }`}>{item.type}</span>
              <span className="text-xs font-bold text-slate-700 flex-1">{item.name}</span>
            </div>
          )}

          <div className="flex gap-2">
            <div className="w-20">
              <label className="text-[8px] font-black text-slate-400 uppercase block ml-1 mb-0.5">Qty</label>
              <input type="number" min={1} value={item.quantity} onChange={(e) => updateLineItem(setter, idx, 'quantity', parseInt(e.target.value) || 1)}
                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-sm font-bold text-slate-700" />
            </div>
            <div className="flex-1">
              <label className="text-[8px] font-black text-slate-400 uppercase block ml-1 mb-0.5">Price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                <input type="number" step="0.01" value={item.price} onChange={(e) => updateLineItem(setter, idx, 'price', parseFloat(e.target.value) || 0)}
                  className="w-full pl-7 pr-3 py-2 bg-white rounded-xl border border-slate-200 text-sm font-bold text-slate-700" />
              </div>
            </div>
            <div className="w-24 text-right pt-5">
              <span className="text-sm font-black text-primary">${(item.quantity * item.price).toFixed(2)}</span>
            </div>
          </div>
        </div>
      ))}
      <button onClick={() => addLineItem(setter)}
        className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 text-[10px] font-black uppercase tracking-widest hover:border-primary/40 hover:text-primary active:scale-95 transition-all">
        + Add Line Item
      </button>
    </div>
  );

  const renderInvoiceFormModal = (
    data: typeof newInv,
    setter: typeof setNewInv,
    totals: ReturnType<typeof computeTotals>,
    onSave: () => void,
    onClose: () => void,
    title: string,
    saveLabel: string,
  ) => (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
      <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="relative w-full max-w-4xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
        <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">{title}</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Fill in the details below</p>
          </div>
          <button onClick={onClose} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
            <span className="material-symbols-outlined text-slate-400">close</span>
          </button>
        </div>
        <div className="p-8 grid grid-cols-2 gap-8 overflow-y-auto flex-1">
          <div className="space-y-6">
            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Customer *</label>
              <select value={data.customerId} onChange={(e) => setter(prev => ({ ...prev, customerId: e.target.value }))}
                className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                <option value="">Select Customer...</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Invoice Date</label>
                <input type="date" value={new Date().toISOString().slice(0, 10)} readOnly className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700" />
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Due Date</label>
                <input type="date" value={data.dueDate} onChange={(e) => setter(prev => ({ ...prev, dueDate: e.target.value }))}
                  className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" />
              </div>
            </div>
            <div className="flex items-center gap-4 p-4 bg-primary/5 rounded-2xl border border-primary/10">
              <input type="checkbox" checked={data.isRecurring} onChange={(e) => setter(prev => ({ ...prev, isRecurring: e.target.checked }))}
                className="w-5 h-5 rounded border-primary text-primary focus:ring-primary" />
              <div className="flex-1">
                <p className="text-xs font-black text-primary uppercase tracking-widest">Recurring Invoice</p>
                <p className="text-[10px] text-primary/60 font-bold">Automatically generate on schedule</p>
              </div>
              {data.isRecurring && (
                <select value={data.recurringInterval} onChange={(e) => setter(prev => ({ ...prev, recurringInterval: e.target.value as any }))}
                  className="px-3 py-1.5 bg-white rounded-xl border border-primary/20 text-xs font-bold text-primary appearance-none">
                  <option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option>
                </select>
              )}
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Notes</label>
              <textarea value={data.notes} onChange={(e) => setter(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Internal notes..." className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-medium text-sm h-20 resize-none" />
            </div>
          </div>
          <div className="space-y-6">
            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Line Items</label>
              {renderLineItemEditor(data.items, setter, title.includes('Edit') ? 'edit' : 'create')}
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Discount ($)</label>
              <div className="relative">
                <span className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                <input type="number" step="0.01" value={data.discount} onChange={(e) => setter(prev => ({ ...prev, discount: parseFloat(e.target.value) || 0 }))}
                  className="w-full pl-10 pr-6 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" />
              </div>
            </div>
          </div>
        </div>
        <div className="p-8 bg-slate-50/50 border-t border-slate-100 flex justify-between items-center shrink-0">
          <div className="flex gap-6">
            <div className="text-right"><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subtotal</p><p className="text-lg font-black text-slate-900">${totals.subtotal.toFixed(2)}</p></div>
            {data.discount > 0 && <div className="text-right"><p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Discount</p><p className="text-lg font-black text-emerald-600">-${data.discount.toFixed(2)}</p></div>}
            <div className="text-right"><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tax (8%)</p><p className="text-lg font-black text-slate-900">${totals.tax.toFixed(2)}</p></div>
            <div className="text-right px-6 border-l border-slate-200"><p className="text-[10px] font-black text-primary uppercase tracking-widest">Total</p><p className="text-2xl font-black text-primary">${totals.total.toFixed(2)}</p></div>
          </div>
          <button onClick={onSave} disabled={!data.customerId || data.items.every(i => !i.name.trim())}
            className="px-12 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            {saveLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Billing & Sales</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Invoices</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input type="text" placeholder="Search invoices..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-11 pr-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-900 w-64 shadow-sm" />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-600 shadow-sm appearance-none">
            <option>All</option><option>Unpaid</option><option>Partially Paid</option><option>Paid</option><option>Overdue</option><option>Cancelled</option>
          </select>
          {canCreate && (
            <button onClick={() => { resetNewInv(); setShowAddModal(true); }}
              className="bg-primary text-white px-6 py-3 rounded-2xl font-black text-xs shadow-lg shadow-primary/20 flex items-center gap-2 uppercase tracking-widest hover:bg-primary/90 transition-all">
              <span className="material-symbols-outlined text-sm">add</span> Create Invoice
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
              <tr key={inv.id} onClick={() => setDetailInvoice(inv)} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group cursor-pointer">
                <td className="px-8 py-6">
                  <span className="font-black text-primary text-xs">{inv.invoiceNumber}</span>
                  {inv.isRecurring && <span className="ml-2 px-2 py-0.5 bg-primary/10 text-primary text-[8px] font-black uppercase rounded-full">Recurring</span>}
                </td>
                <td className="px-8 py-6">
                  <p className="text-sm font-bold text-slate-900">{inv.customerName}</p>
                  <p className="text-[10px] text-slate-400 font-medium">{inv.customerEmail}</p>
                </td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{inv.createdAt}</td>
                <td className="px-8 py-6 text-sm font-black text-slate-900">${inv.total.toFixed(2)}</td>
                <td className="px-8 py-6 text-sm font-black text-rose-500">${inv.balance.toFixed(2)}</td>
                <td className="px-8 py-6">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(inv.status)}`}>{inv.status}</span>
                </td>
                <td className="px-8 py-6 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                    {canEdit && inv.status !== 'Paid' && inv.status !== 'Cancelled' && (
                      <button onClick={() => openPaymentModal(inv)} className="p-2 hover:bg-emerald-50 text-emerald-600 rounded-xl transition-colors" title="Add Payment">
                        <span className="material-symbols-outlined text-sm">payments</span>
                      </button>
                    )}
                    <button onClick={() => setDetailInvoice(inv)} className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="View Details">
                      <span className="material-symbols-outlined text-sm">visibility</span>
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

      <AnimatePresence>
        {detailInvoice && !showPaymentModal && !showEditModal && !showEmailModal && !showSmsModal && !showOnlinePayModal && !showPrintModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDetailInvoice(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-4xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{detailInvoice.invoiceNumber}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(detailInvoice.status)}`}>{detailInvoice.status}</span>
                    {detailInvoice.isRecurring && <span className="px-2 py-0.5 bg-primary/10 text-primary text-[8px] font-black uppercase rounded-full">Recurring · {detailInvoice.recurringInterval}</span>}
                  </div>
                </div>
                <button onClick={() => setDetailInvoice(null)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>

              <div className="p-8 overflow-y-auto flex-1">
                <div className="flex flex-wrap gap-2 mb-8">
                  {canEdit && detailInvoice.status !== 'Paid' && detailInvoice.status !== 'Cancelled' && (
                    <>
                      <button onClick={() => { setPaymentAmount(detailInvoice.balance); setShowPaymentModal(true); }}
                        className="px-4 py-2 bg-emerald-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 active:scale-95 transition-all flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-sm">payments</span> Add Payment
                      </button>
                      <button onClick={() => openEditInvoice(detailInvoice)}
                        className="px-4 py-2 bg-white text-primary border border-slate-200 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-sm">edit</span> Edit Invoice
                      </button>
                    </>
                  )}
                  {(detailInvoice.status === 'Paid' || detailInvoice.status === 'Cancelled') && isCashPaidInvoice(detailInvoice) && canReopenInvoice && (
                    <button onClick={() => handleReopenInvoice()}
                      className="px-4 py-2 bg-emerald-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 active:scale-95 transition-all flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">lock_open</span> Reopen Invoice
                    </button>
                  )}
                  {(detailInvoice.status === 'Paid' || detailInvoice.status === 'Cancelled') && isCashPaidInvoice(detailInvoice) && !canReopenInvoice && (
                    <button onClick={() => { setReopenPinModal(true); setReopenPin(''); setReopenPinError(''); }}
                      className="px-4 py-2 bg-amber-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-amber-500/20 hover:bg-amber-600 active:scale-95 transition-all flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">lock</span> Reopen Invoice
                    </button>
                  )}
                  <button onClick={() => setShowPrintModal(true)}
                    className="px-4 py-2 bg-white text-slate-600 border border-slate-200 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">print</span> Print
                  </button>
                  <button onClick={() => openEmailModal(detailInvoice)}
                    className="px-4 py-2 bg-white text-slate-600 border border-slate-200 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">email</span> Email
                  </button>
                  <button onClick={() => openSmsModal(detailInvoice)}
                    className="px-4 py-2 bg-white text-slate-600 border border-slate-200 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">sms</span> SMS
                  </button>
                  {detailInvoice.balance > 0 && (
                    <button onClick={() => setShowOnlinePayModal(true)}
                      className="px-4 py-2 bg-white text-slate-600 border border-slate-200 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">link</span> Online Pay Link
                    </button>
                  )}
                  {canAccess('shipping') && checkSubPermission('create_shipment') && detailInvoice.status === 'Paid' && (() => {
                    const linkedShipments = shipments.filter(s => s.sourceType === 'invoice' && s.sourceNumber === detailInvoice.invoiceNumber);
                    return linkedShipments.length > 0 ? (
                      <span className="px-4 py-2 bg-sky-50 text-sky-700 border border-sky-200 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-sm">package_2</span> {linkedShipments.length} Shipment{linkedShipments.length > 1 ? 's' : ''} · {linkedShipments[0].status}
                      </span>
                    ) : (
                      <button onClick={() => {
                        const now = new Date().toISOString();
                        const customer = customers.find(c => c.id === detailInvoice.customerId);
                        const addrParts = (customer?.address || '').split(',').map(s => s.trim());
                        const newShipment: Shipment = {
                          id: `shp-${Date.now()}`,
                          shipmentNumber: `SHP-${new Date().getFullYear()}-${String(shipments.length + 1).padStart(3, '0')}`,
                          type: 'customer_delivery',
                          status: 'Draft',
                          sourceType: 'invoice',
                          sourceId: detailInvoice.id,
                          sourceNumber: detailInvoice.invoiceNumber,
                          originAddress: { name: 'Main Warehouse', line1: '123 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
                          destinationAddress: { name: customer?.name || detailInvoice.customerName || 'Customer', line1: addrParts[0] || '', city: addrParts[1] || '', state: addrParts[2] || '', postalCode: addrParts[3] || '', country: 'US', email: customer?.email, phone: customer?.phone },
                          packages: [],
                          events: [{ id: `evt-${Date.now()}`, timestamp: now, status: 'Created', description: `Shipment created from invoice ${detailInvoice.invoiceNumber}`, performedBy: 'Current User' }],
                          createdBy: 'Current User',
                          createdAt: now,
                          updatedAt: now,
                        };
                        addShipment(newShipment);
                      }}
                        className="px-4 py-2 bg-white text-slate-600 border border-slate-200 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-sm">package_2</span> Create Shipment
                      </button>
                    );
                  })()}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                  <div className="lg:col-span-8 space-y-6">
                    <div>
                      <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-4">Line Items</h4>
                      <table className="w-full text-left border-collapse">
                        <thead><tr className="border-b border-slate-100">
                          <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Item</th>
                          <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Type</th>
                          <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Qty</th>
                          <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Price</th>
                          <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Total</th>
                        </tr></thead>
                        <tbody>
                          {detailInvoice.items.map(item => (
                            <tr key={item.id} className="border-b border-slate-50 last:border-0">
                              <td className="py-3 text-sm font-bold text-slate-900">{item.name}</td>
                              <td className="py-3 text-center"><span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${item.type === 'repair' ? 'bg-blue-100 text-blue-700' : item.type === 'service' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>{item.type}</span></td>
                              <td className="py-3 text-center text-sm font-bold text-slate-600">{item.quantity}</td>
                              <td className="py-3 text-right text-sm font-bold text-slate-600">${item.price.toFixed(2)}</td>
                              <td className="py-3 text-right text-sm font-black text-primary">${(item.quantity * item.price).toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="mt-4 pt-4 border-t border-slate-100 space-y-2">
                        <div className="flex justify-between text-sm"><span className="text-slate-500 font-bold">Subtotal</span><span className="font-black text-slate-900">${detailInvoice.subtotal.toFixed(2)}</span></div>
                        {detailInvoice.discount > 0 && <div className="flex justify-between text-sm"><span className="text-emerald-500 font-bold">Discount</span><span className="font-black text-emerald-600">-${detailInvoice.discount.toFixed(2)}</span></div>}
                        <div className="flex justify-between text-sm"><span className="text-slate-500 font-bold">Tax</span><span className="font-black text-slate-900">${detailInvoice.tax.toFixed(2)}</span></div>
                        <div className="flex justify-between text-lg pt-2 border-t border-slate-100"><span className="font-black text-primary">Total</span><span className="font-black text-primary">${detailInvoice.total.toFixed(2)}</span></div>
                      </div>
                    </div>
                    {detailInvoice.paymentHistory.length > 0 && (
                      <div>
                        <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-4">Payment History</h4>
                        <div className="space-y-2">
                          {detailInvoice.paymentHistory.map(pay => (
                            <div key={pay.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                              <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center"><span className="material-symbols-outlined text-emerald-600 text-sm">check_circle</span></div>
                                <div><p className="text-sm font-black text-slate-900">${pay.amount.toFixed(2)}</p><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{pay.method}</p></div>
                              </div>
                              <span className="text-xs font-bold text-slate-400">{pay.timestamp}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="lg:col-span-4 space-y-6">
                    <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100 space-y-4">
                      <h4 className="text-sm font-black text-primary uppercase tracking-widest">Customer</h4>
                      <div><p className="text-sm font-bold text-slate-900">{detailInvoice.customerName}</p>
                        {detailInvoice.customerEmail && <p className="text-xs font-medium text-slate-500 mt-1">{detailInvoice.customerEmail}</p>}
                        {detailInvoice.customerPhone && <p className="text-xs font-medium text-slate-500">{detailInvoice.customerPhone}</p>}
                      </div>
                    </div>
                    <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100 space-y-3">
                      <h4 className="text-sm font-black text-primary uppercase tracking-widest">Details</h4>
                      <div className="flex justify-between"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Created</span><span className="text-xs font-bold text-slate-700">{detailInvoice.createdAt}</span></div>
                      <div className="flex justify-between"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Due Date</span><span className="text-xs font-bold text-slate-700">{detailInvoice.dueDate}</span></div>
                      <div className="flex justify-between"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount Paid</span><span className="text-xs font-black text-emerald-600">${detailInvoice.amountPaid.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance</span><span className="text-xs font-black text-rose-600">${detailInvoice.balance.toFixed(2)}</span></div>
                      {detailInvoice.remindersSent > 0 && <div className="flex justify-between"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reminders Sent</span><span className="text-xs font-bold text-amber-600">{detailInvoice.remindersSent}</span></div>}
                    </div>
                    {detailInvoice.notes && (
                      <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
                        <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-2">Notes</h4>
                        <p className="text-xs font-medium text-slate-600 leading-relaxed">{detailInvoice.notes}</p>
                      </div>
                    )}
                    {(detailInvoice.statusHistory || []).length > 0 && (
                      <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
                        <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-3">Status History</h4>
                        <div className="space-y-2">
                          {(detailInvoice.statusHistory || []).slice().reverse().map(sh => (
                            <div key={sh.id} className="p-3 bg-white rounded-xl border border-slate-100">
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`w-2 h-2 rounded-full ${sh.action === 'paid' ? 'bg-emerald-500' : sh.action === 'reopened_supervisor' || sh.action === 'reopened' ? 'bg-amber-500' : sh.action === 'cancelled' ? 'bg-rose-500' : 'bg-blue-500'}`} />
                                <span className="text-[10px] font-black uppercase tracking-widest text-slate-700">
                                  {sh.action.replace(/_/g, ' ')}
                                </span>
                              </div>
                              <p className="text-[9px] font-bold text-slate-400">{sh.fromStatus} → {sh.toStatus}</p>
                              {sh.note && <p className="text-[9px] font-medium text-slate-500 mt-1">{sh.note}</p>}
                              {sh.actor && <p className="text-[9px] font-bold text-slate-400 mt-0.5">by {sh.actor}</p>}
                              <p className="text-[8px] font-medium text-slate-300 mt-1">{new Date(sh.timestamp).toLocaleString()}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showPaymentModal && detailInvoice && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setShowPaymentModal(false); setTerminalState('idle'); setPaymentAmount(0); setPaymentMethod('Cash'); setCashConfirmPending(false); }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-2xl font-black text-primary tracking-tight">Process Payment</h3>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Invoice: {detailInvoice.invoiceNumber}</p>
                  </div>
                  <button onClick={() => { setShowPaymentModal(false); setTerminalState('idle'); setPaymentAmount(0); setPaymentMethod('Cash'); setCashConfirmPending(false); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-slate-400">close</span>
                  </button>
                </div>
                <div className="mt-4 p-4 bg-white rounded-2xl border border-slate-200">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="material-symbols-outlined text-primary text-sm">person</span>
                    <span className="text-sm font-bold text-slate-900">{detailInvoice.customerName}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="text-center p-2 bg-slate-50 rounded-xl">
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Total</p>
                      <p className="text-sm font-black text-slate-900">${detailInvoice.total.toFixed(2)}</p>
                    </div>
                    <div className="text-center p-2 bg-emerald-50 rounded-xl">
                      <p className="text-[8px] font-black text-emerald-400 uppercase tracking-widest">Paid</p>
                      <p className="text-sm font-black text-emerald-600">${detailInvoice.amountPaid.toFixed(2)}</p>
                    </div>
                    <div className="text-center p-2 bg-rose-50 rounded-xl">
                      <p className="text-[8px] font-black text-rose-400 uppercase tracking-widest">Due</p>
                      <p className="text-sm font-black text-rose-600">${detailInvoice.balance.toFixed(2)}</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="p-8 space-y-6">
                {detailInvoice.paymentHistory.length > 0 && (
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Prior Payments</p>
                    <div className="space-y-1.5 max-h-24 overflow-y-auto">
                      {detailInvoice.paymentHistory.map(p => (
                        <div key={p.id} className="flex justify-between text-xs px-3 py-1.5 bg-slate-50 rounded-lg">
                          <span className="font-bold text-slate-600">${p.amount.toFixed(2)} via {p.method}</span>
                          <span className="text-slate-400">{p.timestamp}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Payment Amount</label>
                  <div className="relative">
                    <span className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                    <input type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(parseFloat(e.target.value) || 0)} max={detailInvoice.balance}
                      className="w-full pl-10 pr-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-black text-primary text-lg" />
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => setPaymentAmount(detailInvoice.balance)} className="px-3 py-1 bg-primary/10 text-primary text-[10px] font-black rounded-lg uppercase">Full Balance</button>
                    <button onClick={() => setPaymentAmount(Math.round(detailInvoice.balance / 2 * 100) / 100)} className="px-3 py-1 bg-slate-100 text-slate-500 text-[10px] font-black rounded-lg uppercase">50%</button>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Payment Method</label>
                  <div className="grid grid-cols-2 gap-3">
                    {['Cash', 'Card Terminal'].map(m => (
                      <button key={m} onClick={() => { setPaymentMethod(m); setTerminalState('idle'); }}
                        className={`py-4 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${paymentMethod === m ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100'}`}>
                        <span className="material-symbols-outlined text-sm">{m === 'Cash' ? 'payments' : 'credit_card'}</span>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
                {paymentMethod === 'Card Terminal' && (
                  <div className="space-y-3">
                    {terminalState === 'idle' && (
                      <button onClick={handleTerminalSend} disabled={paymentAmount <= 0}
                        className="w-full py-4 bg-secondary text-white font-black text-sm rounded-2xl shadow-lg uppercase tracking-widest hover:bg-secondary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined text-sm">send</span>
                        Send ${paymentAmount.toFixed(2)} to Terminal
                      </button>
                    )}
                    {terminalState === 'pending_terminal' && (
                      <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-center space-y-2">
                        <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center mx-auto animate-pulse">
                          <span className="material-symbols-outlined text-amber-600">credit_card</span>
                        </div>
                        <p className="text-sm font-black text-amber-700">Waiting for Terminal...</p>
                        <p className="text-[10px] font-bold text-amber-500">Customer is completing payment on the card terminal</p>
                        <button onClick={() => { if (terminalTimerRef.current) { clearTimeout(terminalTimerRef.current); terminalTimerRef.current = null; } setTerminalState('cancelled'); }} className="px-6 py-2 bg-amber-100 text-amber-700 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-amber-200 transition-all">Cancel</button>
                      </div>
                    )}
                    {terminalState === 'confirmed' && (
                      <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl space-y-2">
                        <div className="flex items-center gap-3">
                          <span className="material-symbols-outlined text-emerald-600">check_circle</span>
                          <div>
                            <p className="text-sm font-black text-emerald-700">Terminal Payment Confirmed</p>
                            <p className="text-[10px] font-bold text-emerald-500">${paymentAmount.toFixed(2)} authorized</p>
                          </div>
                        </div>
                        <button onClick={() => setTerminalState('idle')}
                          className="px-6 py-2 bg-rose-100 text-rose-700 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-rose-200 transition-all">
                          Cancel / Reject
                        </button>
                      </div>
                    )}
                    {terminalState === 'failed' && (
                      <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-rose-600">error</span>
                          <p className="text-sm font-black text-rose-700">Terminal Payment Failed</p>
                        </div>
                        <button onClick={() => setTerminalState('idle')} className="px-6 py-2 bg-rose-100 text-rose-700 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-rose-200 transition-all">Retry</button>
                      </div>
                    )}
                    {terminalState === 'cancelled' && (
                      <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-slate-500">cancel</span>
                          <p className="text-sm font-black text-slate-600">Terminal Payment Cancelled</p>
                        </div>
                        <button onClick={() => setTerminalState('idle')} className="px-6 py-2 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-200 transition-all">Try Again</button>
                      </div>
                    )}
                  </div>
                )}
                {cashConfirmPending && paymentMethod === 'Cash' && (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-amber-600">warning</span>
                      <p className="text-sm font-black text-amber-700">Confirm Cash Received</p>
                    </div>
                    <p className="text-xs font-bold text-amber-600">Have you received ${paymentAmount.toFixed(2)} in cash from the customer?</p>
                    <div className="flex gap-2">
                      <button onClick={handleApplyPayment}
                        className="flex-1 py-2.5 bg-emerald-500 text-white font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-emerald-600 active:scale-95 transition-all">
                        Yes, Cash Received
                      </button>
                      <button onClick={() => setCashConfirmPending(false)}
                        className="flex-1 py-2.5 bg-slate-100 text-slate-600 font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-slate-200 transition-all">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <button onClick={handleApplyPayment} disabled={paymentAmount <= 0 || (paymentMethod === 'Card Terminal' && terminalState !== 'confirmed') || cashConfirmPending}
                  className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                  Apply Payment — ${paymentAmount.toFixed(2)}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddModal && renderInvoiceFormModal(newInv, setNewInv, newInvTotals, handleCreateInvoice, () => setShowAddModal(false), 'Create New Invoice', 'Generate Invoice')}
      </AnimatePresence>

      <AnimatePresence>
        {showEditModal && renderInvoiceFormModal(editInv, setEditInv, editInvTotals, handleSaveEdit, () => setShowEditModal(false), 'Edit Invoice', 'Save Changes')}
      </AnimatePresence>

      {detailInvoice && (
        <div ref={printSurfaceRef} id="print-surface" className={printMode === 'receipt' ? 'print-receipt' : 'print-fullpage'} style={{ position: 'fixed', left: '-9999px', top: 0, width: printMode === 'receipt' ? '80mm' : '210mm', background: 'white' }}>
          <div dangerouslySetInnerHTML={{ __html: printMode === 'receipt' ? renderedReceiptHtml : renderedInvoiceHtml }} />
        </div>
      )}

      <AnimatePresence>
        {showPrintModal && detailInvoice && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowPrintModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden max-h-[85vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <h3 className="text-2xl font-black text-primary tracking-tight">Print Invoice</h3>
                <button onClick={() => setShowPrintModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 overflow-y-auto flex-1">
                <div className="flex gap-3 mb-6">
                  <button onClick={() => setPrintMode('fullpage')} className={`flex-1 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${printMode === 'fullpage' ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    <span className="material-symbols-outlined text-sm">description</span> Full Page
                  </button>
                  <button onClick={() => setPrintMode('receipt')} className={`flex-1 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${printMode === 'receipt' ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    <span className="material-symbols-outlined text-sm">receipt_long</span> Receipt
                  </button>
                </div>
                <div className={`border border-slate-200 rounded-2xl overflow-hidden ${printMode === 'receipt' ? 'max-w-[320px] mx-auto' : ''}`}>
                  <div className={`bg-white p-6 ${printMode === 'receipt' ? 'text-xs' : ''}`}
                    dangerouslySetInnerHTML={{ __html: printMode === 'receipt' ? renderedReceiptHtml : renderedInvoiceHtml }} />
                </div>
              </div>
              <div className="p-6 border-t border-slate-100 flex justify-end gap-4 shrink-0 no-print">
                <button onClick={() => setShowPrintModal(false)} className="px-6 py-3 bg-slate-100 text-slate-600 font-black text-xs rounded-2xl uppercase tracking-widest">Cancel</button>
                <button onClick={() => window.print()} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm">print</span>
                  {printMode === 'receipt' ? 'Print Receipt' : 'Print Invoice'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {reopenPinModal && detailInvoice && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setReopenPinModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-amber-50/50">
                <div>
                  <h3 className="text-xl font-black text-amber-700 tracking-tight flex items-center gap-2">
                    <span className="material-symbols-outlined text-amber-500">lock</span> Supervisor Authorization
                  </h3>
                  <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mt-1">Reopen Cash Invoice · {detailInvoice.invoiceNumber}</p>
                </div>
                <button onClick={() => setReopenPinModal(false)} className="w-10 h-10 rounded-full hover:bg-amber-100 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-amber-400">close</span>
                </button>
              </div>
              <div className="p-8 space-y-5">
                <div className="p-4 bg-amber-50 rounded-2xl border border-amber-200">
                  <p className="text-xs font-bold text-amber-700">You do not have permission to reopen invoices. A supervisor must approve this action by entering their PIN.</p>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Supervisor PIN</label>
                  <input
                    type="password"
                    value={reopenPin}
                    onChange={(e) => { setReopenPin(e.target.value); setReopenPinError(''); }}
                    className="w-full bg-slate-50 border border-amber-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-amber-400/40"
                    placeholder="Enter 4-digit PIN"
                    maxLength={4}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleReopenPinSubmit(); }}
                  />
                  {reopenPinError && <p className="text-[10px] font-bold text-rose-600 mt-1">{reopenPinError}</p>}
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setReopenPinModal(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-xs rounded-2xl uppercase tracking-widest">Cancel</button>
                  <button onClick={handleReopenPinSubmit} className="flex-1 py-3 bg-amber-500 text-white font-black text-xs rounded-2xl shadow-lg shadow-amber-500/20 uppercase tracking-widest hover:bg-amber-600 active:scale-95 transition-all flex items-center justify-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">verified_user</span> Authorize Reopen
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showEmailModal && detailInvoice && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowEmailModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div><h3 className="text-2xl font-black text-primary tracking-tight">Email Invoice</h3><p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{detailInvoice.invoiceNumber}</p></div>
                <button onClick={() => setShowEmailModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors"><span className="material-symbols-outlined text-slate-400">close</span></button>
              </div>
              <div className="p-8 space-y-5">
                {emailSent ? (
                  <div className="text-center py-8">
                    <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4"><span className="material-symbols-outlined text-emerald-600 text-3xl">check_circle</span></div>
                    <h4 className="text-lg font-black text-primary">Email Queued</h4>
                    <p className="text-xs text-slate-500 mt-2">Invoice will be sent to {emailForm.to} when email delivery is configured.</p>
                  </div>
                ) : (
                  <>
                    <div><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">To</label><input value={emailForm.to} onChange={(e) => setEmailForm(prev => ({ ...prev, to: e.target.value }))} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20" /></div>
                    <div><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Subject</label><input value={emailForm.subject} onChange={(e) => setEmailForm(prev => ({ ...prev, subject: e.target.value }))} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20" /></div>
                    <div><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Body</label><textarea value={emailForm.body} onChange={(e) => setEmailForm(prev => ({ ...prev, body: e.target.value }))} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-medium text-slate-700 focus:ring-2 focus:ring-primary/20 h-32 resize-none" /></div>
                    <p className="text-[10px] font-bold text-amber-500 bg-amber-50 px-3 py-2 rounded-lg border border-amber-100 flex items-center gap-1"><span className="material-symbols-outlined text-xs">info</span> Email delivery requires backend email service configuration.</p>
                    <button onClick={() => setEmailSent(true)} className="w-full py-4 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all">Queue Email</button>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSmsModal && detailInvoice && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowSmsModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div><h3 className="text-2xl font-black text-primary tracking-tight">SMS Payment Link</h3><p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{detailInvoice.invoiceNumber}</p></div>
                <button onClick={() => setShowSmsModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors"><span className="material-symbols-outlined text-slate-400">close</span></button>
              </div>
              <div className="p-8 space-y-5">
                {smsSent ? (
                  <div className="text-center py-8">
                    <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4"><span className="material-symbols-outlined text-emerald-600 text-3xl">check_circle</span></div>
                    <h4 className="text-lg font-black text-primary">SMS Queued</h4>
                    <p className="text-xs text-slate-500 mt-2">Message will be sent to {detailInvoice.customerPhone || 'customer phone'} when SMS gateway is configured.</p>
                  </div>
                ) : (
                  <>
                    <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100"><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Recipient</p><p className="text-sm font-bold text-slate-900">{detailInvoice.customerName} — {detailInvoice.customerPhone || 'No phone'}</p></div>
                    <div><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Message Preview</label><textarea value={smsBody} onChange={(e) => setSmsBody(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-medium text-slate-700 focus:ring-2 focus:ring-primary/20 h-24 resize-none" /></div>
                    <div className="flex gap-2">
                      <button onClick={() => { navigator.clipboard.writeText(smsBody); }} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center justify-center gap-1.5"><span className="material-symbols-outlined text-sm">content_copy</span> Copy Text</button>
                      <button onClick={() => setSmsSent(true)} className="flex-1 py-3 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all">Queue SMS</button>
                    </div>
                    <p className="text-[10px] font-bold text-amber-500 bg-amber-50 px-3 py-2 rounded-lg border border-amber-100 flex items-center gap-1"><span className="material-symbols-outlined text-xs">info</span> SMS delivery requires SMS gateway configuration.</p>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showOnlinePayModal && detailInvoice && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowOnlinePayModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div><h3 className="text-2xl font-black text-primary tracking-tight">Online Payment Link</h3></div>
                <button onClick={() => setShowOnlinePayModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors"><span className="material-symbols-outlined text-slate-400">close</span></button>
              </div>
              <div className="p-8 space-y-5">
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                  <div className="flex justify-between"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoice</span><span className="text-xs font-bold text-primary">{detailInvoice.invoiceNumber}</span></div>
                  <div className="flex justify-between"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount Due</span><span className="text-lg font-black text-rose-500">${detailInvoice.balance.toFixed(2)}</span></div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Payment Link</label>
                  <div className="flex gap-2">
                    <input readOnly value={`https://pay.store.app/inv/${detailInvoice.id}`} className="flex-1 bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-600 focus:ring-2 focus:ring-primary/20" />
                    <button onClick={() => navigator.clipboard.writeText(`https://pay.store.app/inv/${detailInvoice.id}`)} className="px-4 py-3 bg-primary text-white rounded-xl font-black text-xs uppercase"><span className="material-symbols-outlined text-sm">content_copy</span></button>
                  </div>
                </div>
                <p className="text-[10px] font-bold text-amber-500 bg-amber-50 px-3 py-2 rounded-lg border border-amber-100 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">info</span> Payment gateway integration required for live online payments. Link structure is ready for configuration.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
