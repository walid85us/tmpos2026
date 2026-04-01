import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState, type LoyaltyTier } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import type { Customer, Invoice } from '../types';
import type { CompletedOrder } from '../context/StoreLocalState';

type CustomerView = 'list' | 'profile';
type HistoryTab = 'orders' | 'invoices';

export default function Customers() {
  const { customers, addCustomer, updateCustomer, completedOrders, invoices, findDuplicateCustomers, loyaltyConfig, updateLoyaltyConfig, loyaltyAdjustments, addLoyaltyAdjustment } = useStoreLocalState();
  const { canAccess } = useAccess();
  const hasLoyalty = canAccess('loyalty_management');
  const navigate = useNavigate();
  const [view, setView] = useState<CustomerView>('list');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewCustomerModal, setShowNewCustomerModal] = useState(false);
  const [historyTab, setHistoryTab] = useState<HistoryTab>('orders');
  const [duplicateWarning, setDuplicateWarning] = useState<Customer[]>([]);
  const [newCustomerForm, setNewCustomerForm] = useState({ firstName: '', lastName: '', email: '', phone: '', phoneLabel: 'Mobile', group: 'Retail' });
  const [duplicateOverride, setDuplicateOverride] = useState(false);

  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState({
    name: '', email: '', phone: '', phoneLabel: 'Mobile', group: 'Retail',
    tier: 'Bronze' as Customer['tier'], loyaltyPoints: 0,
    address: '', tags: '', gdprCompliant: true,
    campaignerStatus: 'Pending' as 'Subscribed' | 'Unsubscribed' | 'Pending',
    thirdPartyBilling: false,
  });

  const [showLoyaltyEdit, setShowLoyaltyEdit] = useState(false);
  const [loyaltyForm, setLoyaltyForm] = useState({ tier: 'Bronze' as Customer['tier'], points: 0 });

  const [invoiceDetailData, setInvoiceDetailData] = useState<Invoice | null>(null);
  const [orderDetailData, setOrderDetailData] = useState<CompletedOrder | null>(null);

  const [showLoyaltyConfig, setShowLoyaltyConfig] = useState(false);
  const [loyaltyPointsPerDollar, setLoyaltyPointsPerDollar] = useState(loyaltyConfig.pointsPerDollar);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(loyaltyConfig.enabled);
  const [editTier, setEditTier] = useState<LoyaltyTier | null>(null);
  const [newTierForm, setNewTierForm] = useState({ name: '', minPoints: '', description: '' });

  const [showAdjustPoints, setShowAdjustPoints] = useState(false);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setActionMenuId(null);
      }
    };
    if (actionMenuId) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [actionMenuId]);

  const filteredCustomers = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return customers;
    return customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      c.phone.includes(q) ||
      (c.group || '').toLowerCase().includes(q) ||
      (c.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }, [customers, searchQuery]);

  const stats = useMemo(() => {
    const total = customers.length;
    const withLoyalty = customers.filter(c => (c.loyaltyPoints ?? 0) > 0).length;
    const avgLtv = total > 0 ? customers.reduce((sum, c) => sum + c.totalSpent, 0) / total : 0;
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const newThisWeek = customers.filter(c => c.createdAt && new Date(c.createdAt) >= oneWeekAgo).length;
    return { total, withLoyalty, avgLtv, newThisWeek };
  }, [customers]);

  const customerOrders = useMemo(() => {
    if (!selectedCustomer) return [];
    return completedOrders.filter(o => o.customerId === selectedCustomer.id);
  }, [selectedCustomer, completedOrders]);

  const customerInvoices = useMemo(() => {
    if (!selectedCustomer) return [];
    return invoices.filter(inv => inv.customerId === selectedCustomer.id);
  }, [selectedCustomer, invoices]);

  const handleFormChange = (field: string, value: string) => {
    const next = { ...newCustomerForm, [field]: value };
    setNewCustomerForm(next);
    setDuplicateOverride(false);
    if (field === 'email' || field === 'phone') {
      const dupes = findDuplicateCustomers('', next.email, next.phone);
      setDuplicateWarning(dupes);
    }
  };

  const handleMergeIntoExisting = (existing: Customer) => {
    const updates: Partial<Customer> = {};
    const formName = `${newCustomerForm.firstName} ${newCustomerForm.lastName}`.trim();
    if (newCustomerForm.email && newCustomerForm.email !== existing.email) updates.email = newCustomerForm.email;
    if (newCustomerForm.phone && newCustomerForm.phone !== existing.phone) updates.phone = newCustomerForm.phone;
    if (formName && formName !== existing.name) updates.name = formName;
    if (newCustomerForm.phoneLabel && newCustomerForm.phoneLabel !== existing.phoneLabel) updates.phoneLabel = newCustomerForm.phoneLabel;
    if (newCustomerForm.group && newCustomerForm.group !== existing.group) updates.group = newCustomerForm.group;
    if (Object.keys(updates).length > 0) {
      updateCustomer(existing.id, updates);
    }
    setNewCustomerForm({ firstName: '', lastName: '', email: '', phone: '', phoneLabel: 'Mobile', group: 'Retail' });
    setDuplicateWarning([]);
    setDuplicateOverride(false);
    setShowNewCustomerModal(false);
    handleCustomerClick({ ...existing, ...updates });
  };

  const handleCreateCustomer = () => {
    if (!newCustomerForm.firstName.trim() || !newCustomerForm.lastName.trim()) return;
    if (duplicateWarning.length > 0 && !duplicateOverride) return;
    const newCust: Customer = {
      id: `c${Date.now()}`,
      name: `${newCustomerForm.firstName} ${newCustomerForm.lastName}`,
      email: newCustomerForm.email,
      phone: newCustomerForm.phone,
      phoneLabel: newCustomerForm.phoneLabel,
      totalSpent: 0,
      lastVisit: new Date().toISOString().slice(0, 10),
      loyaltyPoints: 0,
      tier: 'Bronze',
      group: newCustomerForm.group,
      tags: [],
      notes: [],
      assets: [],
      customFields: [],
      gdprCompliant: true,
      campaignerStatus: 'Pending',
      thirdPartyBilling: false,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    addCustomer(newCust);
    setNewCustomerForm({ firstName: '', lastName: '', email: '', phone: '', phoneLabel: 'Mobile', group: 'Retail' });
    setDuplicateWarning([]);
    setDuplicateOverride(false);
    setShowNewCustomerModal(false);
  };

  const handleCustomerClick = (customer: Customer) => {
    setSelectedCustomer(customer);
    setHistoryTab('orders');
    setView('profile');
  };

  const openEditModal = (customer: Customer) => {
    setEditForm({
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      phoneLabel: customer.phoneLabel || 'Mobile',
      group: customer.group || 'Retail',
      tier: customer.tier || 'Bronze',
      loyaltyPoints: customer.loyaltyPoints ?? 0,
      address: customer.address || '',
      tags: (customer.tags || []).join(', '),
      gdprCompliant: customer.gdprCompliant ?? true,
      campaignerStatus: customer.campaignerStatus || 'Pending',
      thirdPartyBilling: customer.thirdPartyBilling ?? false,
    });
    setSelectedCustomer(customer);
    setShowEditModal(true);
    setActionMenuId(null);
  };

  const handleSaveEdit = () => {
    if (!selectedCustomer || !editForm.name.trim()) return;
    const updates: Partial<Customer> = {
      name: editForm.name,
      email: editForm.email,
      phone: editForm.phone,
      phoneLabel: editForm.phoneLabel,
      group: editForm.group,
      tier: editForm.tier,
      loyaltyPoints: editForm.loyaltyPoints,
      address: editForm.address || undefined,
      tags: editForm.tags.split(',').map(t => t.trim()).filter(Boolean),
      gdprCompliant: editForm.gdprCompliant,
      campaignerStatus: editForm.campaignerStatus,
      thirdPartyBilling: editForm.thirdPartyBilling,
    };
    updateCustomer(selectedCustomer.id, updates);
    setSelectedCustomer(prev => prev ? { ...prev, ...updates } : null);
    setShowEditModal(false);
  };

  const handleStartSale = (customer: Customer) => {
    setActionMenuId(null);
    navigate('/sales', { state: { selectedCustomer: customer } });
  };

  const handleCreateTicket = (customer: Customer) => {
    setActionMenuId(null);
    navigate('/sales', { state: { autoQuickCheckIn: true, selectedCustomer: customer } });
  };

  const openLoyaltyEdit = () => {
    if (!selectedCustomer) return;
    setLoyaltyForm({ tier: selectedCustomer.tier || 'Bronze', points: selectedCustomer.loyaltyPoints ?? 0 });
    setShowLoyaltyEdit(true);
  };

  const handleSaveLoyalty = () => {
    if (!selectedCustomer) return;
    updateCustomer(selectedCustomer.id, { tier: loyaltyForm.tier, loyaltyPoints: loyaltyForm.points });
    setSelectedCustomer(prev => prev ? { ...prev, tier: loyaltyForm.tier, loyaltyPoints: loyaltyForm.points } : null);
    setShowLoyaltyEdit(false);
  };

  const getTierStyle = (tier?: string) => {
    switch (tier) {
      case 'Platinum': return 'bg-primary text-white';
      case 'Gold': return 'bg-amber-100 text-amber-800';
      case 'Silver': return 'bg-slate-200 text-slate-700';
      default: return 'bg-slate-100 text-slate-600';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Paid': return 'bg-emerald-100 text-emerald-600';
      case 'Partially Paid': return 'bg-amber-100 text-amber-600';
      case 'Overdue': return 'bg-rose-100 text-rose-600';
      default: return 'bg-slate-100 text-slate-600';
    }
  };

  const renderListView = () => (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">CRM Engine</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Customer Insights</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            <button className="p-3 bg-white rounded-xl border border-slate-200 text-slate-400 hover:text-primary transition-all shadow-sm" title="Import CSV">
              <span className="material-symbols-outlined text-sm">upload</span>
            </button>
            <button className="p-3 bg-white rounded-xl border border-slate-200 text-slate-400 hover:text-primary transition-all shadow-sm" title="Export CSV">
              <span className="material-symbols-outlined text-sm">download</span>
            </button>
          </div>
          <div className="relative w-64">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-xl py-2.5 pl-10 text-sm focus:ring-2 focus:ring-primary/20 shadow-sm"
              placeholder="Name, email, phone, tag..."
              type="text"
            />
          </div>
          {hasLoyalty && (
          <button
            onClick={() => { setShowLoyaltyConfig(true); setLoyaltyEnabled(loyaltyConfig.enabled); setLoyaltyPointsPerDollar(loyaltyConfig.pointsPerDollar); }}
            className="bg-white text-primary px-6 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest border border-slate-200 shadow-sm hover:bg-slate-50 transition-all flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">loyalty</span>
            Loyalty Settings
          </button>
          )}
          <button
            onClick={() => { setShowNewCustomerModal(true); setDuplicateOverride(false); setDuplicateWarning([]); }}
            className="bg-primary text-white px-8 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all"
          >
            + New Customer
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Customers</p>
          <p className="text-4xl font-black text-primary mt-2 tracking-tighter">{stats.total.toLocaleString()}</p>
        </div>
        <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Loyalty</p>
          <p className="text-4xl font-black text-secondary mt-2 tracking-tighter">{stats.withLoyalty.toLocaleString()}</p>
        </div>
        <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Avg. Lifetime Value</p>
          <p className="text-4xl font-black text-primary mt-2 tracking-tighter">${stats.avgLtv.toFixed(2)}</p>
        </div>
        <div className="bg-teal-950 p-8 rounded-[2rem] shadow-xl text-white">
          <p className="text-[10px] font-black uppercase tracking-widest text-teal-100/60">New This Week</p>
          <p className="text-4xl font-black mt-2 tracking-tighter text-lime-400">+{stats.newThisWeek}</p>
        </div>
      </div>

      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50/50 border-b border-slate-100">
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Contact Info</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Group</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Loyalty Tier</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Spent</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filteredCustomers.map((customer) => (
              <tr
                key={customer.id}
                onClick={() => handleCustomerClick(customer)}
                className="hover:bg-slate-50/50 transition-colors group cursor-pointer"
              >
                <td className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-slate-100 overflow-hidden border-2 border-white shadow-sm flex items-center justify-center">
                      <span className="material-symbols-outlined text-2xl text-primary/40">person</span>
                    </div>
                    <div>
                      <p className="font-black text-primary tracking-tight">{customer.name}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{customer.id}</p>
                    </div>
                  </div>
                </td>
                <td className="p-6">
                  <p className="text-xs font-bold text-slate-600">{customer.email}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{customer.phoneLabel || 'Phone'}:</span>
                    <span className="text-[10px] font-bold text-slate-500">{customer.phone}</span>
                  </div>
                </td>
                <td className="p-6">
                  <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-black uppercase tracking-widest">
                    {customer.group || 'General'}
                  </span>
                </td>
                <td className="p-6">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-tighter ${getTierStyle(customer.tier)}`}>
                      {customer.tier || 'Bronze'}
                    </span>
                    <span className="text-[10px] font-bold text-slate-400">{customer.loyaltyPoints ?? 0} pts</span>
                  </div>
                </td>
                <td className="p-6">
                  <span className="font-black text-primary">${customer.totalSpent.toFixed(2)}</span>
                </td>
                <td className="p-6 text-right relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setActionMenuId(actionMenuId === customer.id ? null : customer.id); }}
                    className="p-2 bg-slate-50 text-slate-400 rounded-xl group-hover:bg-primary group-hover:text-white transition-all"
                  >
                    <span className="material-symbols-outlined text-sm">more_vert</span>
                  </button>
                  {actionMenuId === customer.id && (
                    <div ref={actionMenuRef} className="absolute right-6 top-14 z-50 w-56 bg-white rounded-2xl shadow-2xl border border-slate-200 py-2 animate-in fade-in slide-in-from-top-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCustomerClick(customer); setActionMenuId(null); }}
                        className="w-full flex items-center gap-3 px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <span className="material-symbols-outlined text-sm text-primary">visibility</span>
                        View Customer
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); openEditModal(customer); }}
                        className="w-full flex items-center gap-3 px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <span className="material-symbols-outlined text-sm text-primary">edit</span>
                        Edit Customer
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleStartSale(customer); }}
                        className="w-full flex items-center gap-3 px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <span className="material-symbols-outlined text-sm text-emerald-600">point_of_sale</span>
                        Start New Sale
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCreateTicket(customer); }}
                        className="w-full flex items-center gap-3 px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <span className="material-symbols-outlined text-sm text-amber-600">confirmation_number</span>
                        Create Ticket
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {filteredCustomers.length === 0 && (
              <tr>
                <td colSpan={6} className="p-12 text-center text-slate-400 text-sm font-bold">
                  No customers found matching your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderProfileView = () => {
    if (!selectedCustomer) return null;

    return (
      <div className="space-y-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <button
              onClick={() => setView('list')}
              className="w-12 h-12 bg-white rounded-2xl border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary transition-all shadow-sm"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div>
              <h2 className="text-3xl font-black text-primary tracking-tight font-headline">{selectedCustomer.name}</h2>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{selectedCustomer.id}</span>
                <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                {selectedCustomer.gdprCompliant && (
                  <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest flex items-center gap-1">
                    <span className="material-symbols-outlined text-[10px]">verified_user</span> GDPR Compliant
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-4">
            <button
              onClick={() => openEditModal(selectedCustomer)}
              className="px-6 py-2.5 bg-white text-primary border border-slate-200 rounded-xl font-black text-xs uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-sm">edit</span>
              Edit Profile
            </button>
            <button
              onClick={() => handleStartSale(selectedCustomer)}
              className="px-6 py-2.5 bg-emerald-500 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-emerald-500/20 active:scale-95 transition-all flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-sm">point_of_sale</span>
              New Sale
            </button>
            <button
              onClick={() => handleCreateTicket(selectedCustomer)}
              className="px-6 py-2.5 bg-primary text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-sm">confirmation_number</span>
              Create Ticket
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-4 space-y-8">
            <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
              <div className="flex items-center gap-6 mb-8">
                <div className="w-20 h-20 rounded-[2rem] bg-primary/5 flex items-center justify-center border-4 border-white shadow-lg">
                  <span className="material-symbols-outlined text-4xl text-primary/40">person</span>
                </div>
                <div>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-tighter ${getTierStyle(selectedCustomer.tier)}`}>
                    {selectedCustomer.tier || 'Bronze'} Tier
                  </span>
                  <p className="text-xl font-black text-primary mt-1">{selectedCustomer.loyaltyPoints ?? 0} <span className="text-xs text-slate-400 font-bold uppercase tracking-widest">Points</span></p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Email Address</label>
                  <p className="text-sm font-bold text-slate-700">{selectedCustomer.email}</p>
                  <p className="text-[8px] font-medium text-emerald-600 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[10px]">check_circle</span> Verified
                  </p>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Phone Number</label>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-[8px] font-black uppercase">{selectedCustomer.phoneLabel || 'Mobile'}</span>
                    <p className="text-sm font-bold text-slate-700">{selectedCustomer.phone}</p>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer Group</label>
                  <p className="text-sm font-bold text-slate-700">{selectedCustomer.group || 'General'}</p>
                  {selectedCustomer.thirdPartyBilling && (
                    <span className="text-[8px] font-black text-primary uppercase tracking-widest mt-1 block">Third-Party Billing Enabled</span>
                  )}
                </div>
                {(selectedCustomer.tags || []).length > 0 && (
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tags</label>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedCustomer.tags!.map(tag => (
                        <span key={tag} className="px-2 py-0.5 bg-primary/10 text-primary text-[8px] font-black uppercase rounded-full">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Spent</label>
                  <p className="text-lg font-black text-primary">${selectedCustomer.totalSpent.toFixed(2)}</p>
                </div>
              </div>
            </section>

            {hasLoyalty && (
            <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Loyalty Program</h3>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowAdjustPoints(true)} className="text-[10px] font-black text-secondary uppercase tracking-widest hover:underline flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs">tune</span> Adjust
                  </button>
                  <button onClick={openLoyaltyEdit} className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs">edit</span> Manage
                  </button>
                </div>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Current Tier</span>
                  <span className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-tighter ${getTierStyle(selectedCustomer.tier)}`}>
                    {selectedCustomer.tier || 'Bronze'}
                  </span>
                </div>
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Points Balance</span>
                  <span className="text-lg font-black text-primary">{selectedCustomer.loyaltyPoints ?? 0}</span>
                </div>
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Next Tier</span>
                  <span className="text-xs font-bold text-slate-500">
                    {selectedCustomer.tier === 'Platinum' ? 'Max Tier Reached' :
                     selectedCustomer.tier === 'Gold' ? 'Platinum (5000 pts)' :
                     selectedCustomer.tier === 'Silver' ? 'Gold (2000 pts)' : 'Silver (500 pts)'}
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, ((selectedCustomer.loyaltyPoints ?? 0) / (
                        selectedCustomer.tier === 'Gold' ? 5000 :
                        selectedCustomer.tier === 'Silver' ? 2000 : 500
                      )) * 100)}%`
                    }}
                  />
                </div>
              </div>
            </section>
            )}

            <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Asset Management</h3>
                <button className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">+ Add Asset</button>
              </div>
              <div className="space-y-3">
                {(selectedCustomer.assets || []).map((asset) => (
                  <div key={asset.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex items-center gap-4">
                    <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm">
                      <span className="material-symbols-outlined text-xl">
                        {asset.type === 'Smartphone' ? 'smartphone' : asset.type === 'Tablet' ? 'tablet_mac' : 'laptop_mac'}
                      </span>
                    </div>
                    <div>
                      <p className="text-xs font-black text-primary">{asset.model}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{asset.serial}</p>
                    </div>
                  </div>
                ))}
                {(selectedCustomer.assets || []).length === 0 && (
                  <p className="text-xs text-slate-400 italic text-center py-4">No assets recorded.</p>
                )}
              </div>
            </section>
          </div>

          <div className="lg:col-span-8 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-sm font-black text-primary uppercase tracking-widest">Internal Notes</h3>
                  <button className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">+ Add Note</button>
                </div>
                <div className="space-y-4">
                  {(selectedCustomer.notes || []).map((note) => (
                    <div key={note.id} className={`p-4 rounded-2xl border ${note.flagged ? 'bg-rose-50 border-rose-100' : 'bg-slate-50 border-slate-100'}`}>
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{note.date}</span>
                        {note.flagged && <span className="material-symbols-outlined text-rose-500 text-sm">flag</span>}
                      </div>
                      <p className="text-xs font-medium text-slate-600 leading-relaxed">{note.text}</p>
                    </div>
                  ))}
                  {(selectedCustomer.notes || []).length === 0 && (
                    <p className="text-xs text-slate-400 italic text-center py-4">No notes recorded for this customer.</p>
                  )}
                </div>
              </section>

              <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-6">Custom Fields</h3>
                <div className="space-y-4">
                  {(selectedCustomer.customFields || []).map((field, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{field.label}</span>
                      <span className="text-xs font-bold text-primary">{field.value}</span>
                    </div>
                  ))}
                  <div className="pt-4">
                    <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                      <span className="text-[10px] font-black text-emerald-800 uppercase tracking-widest">Campaigner Status</span>
                      <span className="px-2 py-1 bg-emerald-600 text-white rounded-lg text-[8px] font-black uppercase tracking-widest">
                        {selectedCustomer.campaignerStatus || 'Pending'}
                      </span>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <section className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Interaction History</h3>
                <div className="flex gap-4">
                  <button
                    onClick={() => setHistoryTab('orders')}
                    className={`text-[10px] font-black uppercase tracking-widest pb-1 transition-colors ${historyTab === 'orders' ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-primary'}`}
                  >
                    Orders ({customerOrders.length})
                  </button>
                  <button
                    onClick={() => setHistoryTab('invoices')}
                    className={`text-[10px] font-black uppercase tracking-widest pb-1 transition-colors ${historyTab === 'invoices' ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-primary'}`}
                  >
                    Invoices ({customerInvoices.length})
                  </button>
                </div>
              </div>
              <div className="p-0">
                {historyTab === 'orders' && (
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50/50">
                      <tr>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoice #</th>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount</th>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {customerOrders.map((order) => (
                        <tr key={order.id} onClick={() => setOrderDetailData(order)} className="hover:bg-slate-50/50 transition-colors cursor-pointer">
                          <td className="p-6">
                            <button onClick={(e) => { e.stopPropagation(); setOrderDetailData(order); }} className="text-xs font-black text-primary hover:underline">{order.invoiceNumber}</button>
                          </td>
                          <td className="p-6 text-xs font-bold text-slate-600">{order.items.map(i => i.name).join(', ')}</td>
                          <td className="p-6 text-xs font-medium text-slate-500">{new Date(order.createdAt).toLocaleDateString()}</td>
                          <td className="p-6 text-xs font-black text-primary">${order.total.toFixed(2)}</td>
                          <td className="p-6 text-right">
                            <span className="px-2 py-1 bg-emerald-100 text-emerald-600 rounded-lg text-[8px] font-black uppercase tracking-widest">
                              {order.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {customerOrders.length === 0 && (
                        <tr><td colSpan={5} className="p-8 text-center text-xs text-slate-400 italic">No orders found for this customer.</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
                {historyTab === 'invoices' && (
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50/50">
                      <tr>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoice #</th>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Total</th>
                        <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {customerInvoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-slate-50/50 transition-colors cursor-pointer" onClick={() => setInvoiceDetailData(inv)}>
                          <td className="p-6">
                            <button
                              onClick={(e) => { e.stopPropagation(); setInvoiceDetailData(inv); }}
                              className="text-xs font-black text-primary hover:underline"
                            >
                              {inv.invoiceNumber}
                            </button>
                          </td>
                          <td className="p-6 text-xs font-bold text-slate-600">{inv.items.map(i => i.name).join(', ')}</td>
                          <td className="p-6 text-xs font-medium text-slate-500">{inv.createdAt}</td>
                          <td className="p-6 text-xs font-black text-primary">${inv.total.toFixed(2)}</td>
                          <td className="p-6 text-right">
                            <span className={`px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest ${getStatusColor(inv.status)}`}>
                              {inv.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {customerInvoices.length === 0 && (
                        <tr><td colSpan={5} className="p-8 text-center text-xs text-slate-400 italic">No invoices found for this customer.</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto">
      <AnimatePresence mode="wait">
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {view === 'list' ? renderListView() : renderProfileView()}
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {showNewCustomerModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">New Customer</h3>
                <button onClick={() => { setShowNewCustomerModal(false); setDuplicateWarning([]); setDuplicateOverride(false); }} className="text-slate-400 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {duplicateWarning.length > 0 && (
                <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-2xl">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="material-symbols-outlined text-amber-600 text-sm">warning</span>
                    <span className="text-xs font-black text-amber-700 uppercase tracking-widest">Matching Customer Found</span>
                  </div>
                  <p className="text-[10px] font-bold text-amber-600 mb-2">A customer with this phone or email already exists. You can merge into the existing record or create a new one if both phone and email are different.</p>
                  {duplicateWarning.map(d => (
                    <div key={d.id} className="flex items-center justify-between py-2 px-3 bg-amber-100/50 rounded-lg mb-1">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-amber-500 text-xs">person</span>
                        <span className="text-xs font-bold text-amber-700">{d.name}</span>
                        <span className="text-[10px] text-amber-500">&bull;</span>
                        <span className="text-[10px] text-amber-600">{d.email}</span>
                        <span className="text-[10px] text-amber-500">&bull;</span>
                        <span className="text-[10px] text-amber-600">{d.phone}</span>
                      </div>
                      <button
                        onClick={() => handleMergeIntoExisting(d)}
                        className="px-3 py-1 bg-primary text-white text-[9px] font-black uppercase tracking-widest rounded-lg hover:bg-primary/90 transition-colors"
                      >
                        Merge
                      </button>
                    </div>
                  ))}
                  {!duplicateOverride && (
                    <button
                      onClick={() => setDuplicateOverride(true)}
                      className="mt-3 px-4 py-2 bg-amber-100 border border-amber-300 text-amber-700 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-amber-200 transition-colors"
                    >
                      I understand — Create Anyway
                    </button>
                  )}
                  {duplicateOverride && (
                    <p className="mt-2 text-[10px] font-black text-emerald-600 uppercase tracking-widest flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">check_circle</span> Duplicate override confirmed
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">First Name *</label>
                    <input
                      value={newCustomerForm.firstName}
                      onChange={(e) => handleFormChange('firstName', e.target.value)}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Last Name *</label>
                    <input
                      value={newCustomerForm.lastName}
                      onChange={(e) => handleFormChange('lastName', e.target.value)}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Email</label>
                  <input
                    value={newCustomerForm.email}
                    onChange={(e) => handleFormChange('email', e.target.value)}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                    type="email"
                  />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Phone</label>
                    <input
                      value={newCustomerForm.phone}
                      onChange={(e) => handleFormChange('phone', e.target.value)}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Label</label>
                    <select
                      value={newCustomerForm.phoneLabel}
                      onChange={(e) => handleFormChange('phoneLabel', e.target.value)}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20 appearance-none"
                    >
                      <option>Mobile</option>
                      <option>Home</option>
                      <option>Work</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Customer Group</label>
                  <select
                    value={newCustomerForm.group}
                    onChange={(e) => handleFormChange('group', e.target.value)}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20 appearance-none"
                  >
                    <option>Retail</option>
                    <option>VIP Corporate</option>
                    <option>Wholesale</option>
                    <option>Walk-in</option>
                  </select>
                </div>
                {duplicateWarning.length > 0 && !duplicateOverride ? (
                  <button
                    disabled
                    className="w-full py-4 bg-slate-300 text-white font-black text-xs rounded-2xl uppercase tracking-widest cursor-not-allowed"
                  >
                    Resolve Duplicate to Continue
                  </button>
                ) : (
                  <button
                    onClick={handleCreateCustomer}
                    disabled={!newCustomerForm.firstName.trim() || !newCustomerForm.lastName.trim()}
                    className="w-full py-4 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Create Customer
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showEditModal && selectedCustomer && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl max-w-2xl w-full overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Edit Customer</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{selectedCustomer.id}</p>
                </div>
                <button onClick={() => setShowEditModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 space-y-5 overflow-y-auto flex-1">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Full Name *</label>
                  <input
                    value={editForm.name}
                    onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Email</label>
                    <input
                      value={editForm.email}
                      onChange={(e) => setEditForm(prev => ({ ...prev, email: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                      type="email"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Phone</label>
                    <input
                      value={editForm.phone}
                      onChange={(e) => setEditForm(prev => ({ ...prev, phone: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Phone Label</label>
                    <select
                      value={editForm.phoneLabel}
                      onChange={(e) => setEditForm(prev => ({ ...prev, phoneLabel: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20 appearance-none"
                    >
                      <option>Mobile</option><option>Home</option><option>Work</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Group</label>
                    <select
                      value={editForm.group}
                      onChange={(e) => setEditForm(prev => ({ ...prev, group: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20 appearance-none"
                    >
                      <option>Retail</option><option>VIP Corporate</option><option>Wholesale</option><option>Walk-in</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Campaigner</label>
                    <select
                      value={editForm.campaignerStatus}
                      onChange={(e) => setEditForm(prev => ({ ...prev, campaignerStatus: e.target.value as any }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20 appearance-none"
                    >
                      <option>Subscribed</option><option>Unsubscribed</option><option>Pending</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Loyalty Tier</label>
                    <select
                      value={editForm.tier}
                      onChange={(e) => setEditForm(prev => ({ ...prev, tier: e.target.value as any }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20 appearance-none"
                    >
                      <option>Bronze</option><option>Silver</option><option>Gold</option><option>Platinum</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Loyalty Points</label>
                    <input
                      type="number"
                      value={editForm.loyaltyPoints}
                      onChange={(e) => setEditForm(prev => ({ ...prev, loyaltyPoints: parseInt(e.target.value) || 0 }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Address</label>
                  <input
                    value={editForm.address}
                    onChange={(e) => setEditForm(prev => ({ ...prev, address: e.target.value }))}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                    placeholder="Street, City, State, ZIP"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Tags (comma-separated)</label>
                  <input
                    value={editForm.tags}
                    onChange={(e) => setEditForm(prev => ({ ...prev, tags: e.target.value }))}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                    placeholder="VIP, Corporate, Bulk..."
                  />
                </div>
                <div className="flex gap-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={editForm.gdprCompliant} onChange={(e) => setEditForm(prev => ({ ...prev, gdprCompliant: e.target.checked }))} className="w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary" />
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">GDPR Compliant</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={editForm.thirdPartyBilling} onChange={(e) => setEditForm(prev => ({ ...prev, thirdPartyBilling: e.target.checked }))} className="w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary" />
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Third-Party Billing</span>
                  </label>
                </div>
              </div>
              <div className="p-8 border-t border-slate-100 flex justify-end gap-4 shrink-0">
                <button onClick={() => setShowEditModal(false)} className="px-8 py-3 bg-slate-100 text-slate-600 font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-slate-200 transition-all">
                  Cancel
                </button>
                <button onClick={handleSaveEdit} disabled={!editForm.name.trim()} className="px-8 py-3 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50">
                  Save Changes
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showLoyaltyEdit && selectedCustomer && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl max-w-md w-full p-8">
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Manage Loyalty</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{selectedCustomer.name}</p>
                </div>
                <button onClick={() => setShowLoyaltyEdit(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="space-y-5">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Tier</label>
                  <select
                    value={loyaltyForm.tier}
                    onChange={(e) => setLoyaltyForm(prev => ({ ...prev, tier: e.target.value as Customer['tier'] }))}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20 appearance-none"
                  >
                    <option>Bronze</option><option>Silver</option><option>Gold</option><option>Platinum</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Points Balance</label>
                  <input
                    type="number"
                    value={loyaltyForm.points}
                    onChange={(e) => setLoyaltyForm(prev => ({ ...prev, points: parseInt(e.target.value) || 0 }))}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <div className="flex gap-4 pt-4">
                  <button onClick={() => setShowLoyaltyEdit(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-slate-200 transition-all">
                    Cancel
                  </button>
                  <button onClick={handleSaveLoyalty} className="flex-1 py-3 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all">
                    Save
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {orderDetailData && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl max-w-2xl w-full overflow-hidden max-h-[85vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{orderDetailData.invoiceNumber}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg bg-emerald-100 text-emerald-600">{orderDetailData.status}</span>
                    <span className="text-xs font-bold text-slate-400">{new Date(orderDetailData.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <button onClick={() => setOrderDetailData(null)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer</p>
                    <p className="text-sm font-black text-primary mt-1">{orderDetailData.customerName}</p>
                    <p className="text-[10px] font-bold text-slate-400 mt-0.5">{orderDetailData.customerPhone}</p>
                  </div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Operator</p>
                    <p className="text-sm font-black text-primary mt-1">{orderDetailData.operatorName}</p>
                  </div>
                </div>
                <div>
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Items</h4>
                  <div className="space-y-2">
                    {orderDetailData.items.map(item => (
                      <div key={item.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${item.type === 'repair' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{item.type}</span>
                          <span className="text-sm font-bold text-slate-700">{item.name}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-bold text-slate-400">{item.qty} × ${item.unitPrice.toFixed(2)}</span>
                          <span className="ml-3 text-sm font-black text-primary">${(item.qty * item.unitPrice).toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="pt-4 border-t border-slate-100 space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-slate-500 font-bold">Subtotal</span><span className="font-black text-slate-900">${orderDetailData.subtotal.toFixed(2)}</span></div>
                  {orderDetailData.discountTotal > 0 && (
                    <div className="flex justify-between text-sm"><span className="text-emerald-500 font-bold">Discount</span><span className="font-black text-emerald-600">-${orderDetailData.discountTotal.toFixed(2)}</span></div>
                  )}
                  <div className="flex justify-between text-sm"><span className="text-slate-500 font-bold">Tax</span><span className="font-black text-slate-900">${orderDetailData.tax.toFixed(2)}</span></div>
                  <div className="flex justify-between text-lg pt-2 border-t border-slate-100"><span className="font-black text-primary">Total</span><span className="font-black text-primary">${orderDetailData.total.toFixed(2)}</span></div>
                </div>
                {orderDetailData.payments.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Payments</h4>
                    <div className="space-y-2">
                      {orderDetailData.payments.map((pay, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-emerald-600 text-sm">check_circle</span>
                            <span className="text-sm font-black text-emerald-700">${pay.amount.toFixed(2)}</span>
                            <span className="text-[10px] font-bold text-emerald-500 uppercase">{pay.method}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAdjustPoints && selectedCustomer && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl max-w-md w-full p-8">
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Adjust Points</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{selectedCustomer.name}</p>
                </div>
                <button onClick={() => { setShowAdjustPoints(false); setAdjustAmount(''); setAdjustReason(''); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="space-y-5">
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 text-center">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Current Balance</p>
                  <p className="text-3xl font-black text-primary mt-1">{selectedCustomer.loyaltyPoints ?? 0}</p>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Adjustment (negative to deduct) *</label>
                  <input type="number" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20" placeholder="e.g. 100 or -50" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Reason *</label>
                  <select value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20 appearance-none">
                    <option value="">Select reason...</option>
                    <option>Goodwill credit</option>
                    <option>Data correction</option>
                    <option>Promotion bonus</option>
                    <option>Refund adjustment</option>
                    <option>Manual deduction</option>
                    <option>Other</option>
                  </select>
                </div>
                <div className="flex gap-4 pt-4">
                  <button onClick={() => { setShowAdjustPoints(false); setAdjustAmount(''); setAdjustReason(''); }} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-xs rounded-2xl uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                  <button disabled={!adjustAmount || !adjustReason || parseInt(adjustAmount) === 0} onClick={() => {
                    const adj = parseInt(adjustAmount) || 0;
                    const newPoints = Math.max(0, (selectedCustomer.loyaltyPoints ?? 0) + adj);
                    updateCustomer(selectedCustomer.id, { loyaltyPoints: newPoints });
                    setSelectedCustomer(prev => prev ? { ...prev, loyaltyPoints: newPoints } : null);
                    addLoyaltyAdjustment({ id: `la-${Date.now()}`, customerId: selectedCustomer.id, adjustment: adj, reason: adjustReason, adjustedBy: 'Current User', timestamp: new Date().toISOString() });
                    setShowAdjustPoints(false); setAdjustAmount(''); setAdjustReason('');
                  }} className="flex-1 py-3 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50">Apply</button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showLoyaltyConfig && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl max-w-2xl w-full overflow-hidden max-h-[85vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <h3 className="text-2xl font-black text-primary tracking-tight">Loyalty Program Settings</h3>
                <button onClick={() => setShowLoyaltyConfig(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <div>
                    <p className="text-sm font-black text-primary">Program Status</p>
                    <p className="text-[10px] font-bold text-slate-400">Enable or disable the loyalty program</p>
                  </div>
                  <button onClick={() => { setLoyaltyEnabled(!loyaltyEnabled); updateLoyaltyConfig({ enabled: !loyaltyEnabled }); }} className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${loyaltyEnabled ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-500'}`}>
                    {loyaltyEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Points Per Dollar Spent</label>
                  <div className="flex gap-3 items-center">
                    <input type="number" value={loyaltyPointsPerDollar} onChange={(e) => setLoyaltyPointsPerDollar(parseInt(e.target.value) || 0)} className="w-32 bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20" min="0" />
                    <button onClick={() => updateLoyaltyConfig({ pointsPerDollar: loyaltyPointsPerDollar })} className="px-4 py-3 bg-primary text-white rounded-xl text-xs font-black uppercase">Save</button>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-black text-primary uppercase tracking-widest">Tiers</h4>
                  </div>
                  <div className="space-y-2">
                    {loyaltyConfig.tiers.map(tier => (
                      <div key={tier.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-black text-primary">{tier.name}</p>
                            <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${tier.status === 'active' ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-200 text-slate-500'}`}>{tier.status}</span>
                          </div>
                          <p className="text-[10px] font-bold text-slate-400">{tier.minPoints} pts minimum{tier.description ? ` — ${tier.description}` : ''}</p>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => setEditTier(tier)} className="p-2 bg-white rounded-xl border border-slate-200 text-slate-400 hover:text-primary transition-all">
                            <span className="material-symbols-outlined text-sm">edit</span>
                          </button>
                          <button onClick={() => {
                            const updated = loyaltyConfig.tiers.map(t => t.id === tier.id ? { ...t, status: t.status === 'active' ? 'inactive' as const : 'active' as const } : t);
                            updateLoyaltyConfig({ tiers: updated });
                          }} className="p-2 bg-white rounded-xl border border-slate-200 text-slate-400 hover:text-primary transition-all">
                            <span className="material-symbols-outlined text-sm">{tier.status === 'active' ? 'toggle_on' : 'toggle_off'}</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 p-4 bg-primary/5 rounded-2xl border border-primary/10">
                    <p className="text-[10px] font-black text-primary uppercase tracking-widest mb-3">Add Tier</p>
                    <div className="grid grid-cols-3 gap-3">
                      <input value={newTierForm.name} onChange={(e) => setNewTierForm(prev => ({ ...prev, name: e.target.value }))} className="bg-white border-none rounded-xl px-4 py-2 text-sm font-bold" placeholder="Tier Name" />
                      <input type="number" value={newTierForm.minPoints} onChange={(e) => setNewTierForm(prev => ({ ...prev, minPoints: e.target.value }))} className="bg-white border-none rounded-xl px-4 py-2 text-sm font-bold" placeholder="Min Points" />
                      <button disabled={!newTierForm.name.trim() || !newTierForm.minPoints} onClick={() => {
                        const newTier: LoyaltyTier = { id: `lt-${Date.now()}`, name: newTierForm.name.trim(), minPoints: parseInt(newTierForm.minPoints) || 0, status: 'active', description: newTierForm.description || undefined };
                        updateLoyaltyConfig({ tiers: [...loyaltyConfig.tiers, newTier].sort((a, b) => a.minPoints - b.minPoints) });
                        setNewTierForm({ name: '', minPoints: '', description: '' });
                      }} className="py-2 bg-primary text-white rounded-xl text-xs font-black uppercase disabled:opacity-40">Add</button>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editTier && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl max-w-md w-full p-8">
              <h3 className="text-2xl font-black text-primary tracking-tight mb-6">Edit Tier</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Name</label>
                  <input value={editTier.name} onChange={(e) => setEditTier(prev => prev ? { ...prev, name: e.target.value } : null)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Min Points</label>
                  <input type="number" value={editTier.minPoints} onChange={(e) => setEditTier(prev => prev ? { ...prev, minPoints: parseInt(e.target.value) || 0 } : null)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Description</label>
                  <input value={editTier.description || ''} onChange={(e) => setEditTier(prev => prev ? { ...prev, description: e.target.value } : null)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" />
                </div>
                <div className="flex gap-4 pt-4">
                  <button onClick={() => setEditTier(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-xs rounded-2xl uppercase tracking-widest">Cancel</button>
                  <button onClick={() => {
                    if (!editTier) return;
                    const updated = loyaltyConfig.tiers.map(t => t.id === editTier.id ? editTier : t).sort((a, b) => a.minPoints - b.minPoints);
                    updateLoyaltyConfig({ tiers: updated });
                    setEditTier(null);
                  }} className="flex-1 py-3 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest">Save</button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {invoiceDetailData && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl max-w-2xl w-full overflow-hidden max-h-[85vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{invoiceDetailData.invoiceNumber}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg ${getStatusColor(invoiceDetailData.status)}`}>
                      {invoiceDetailData.status}
                    </span>
                    <span className="text-xs font-bold text-slate-400">{invoiceDetailData.createdAt}</span>
                  </div>
                </div>
                <button onClick={() => setInvoiceDetailData(null)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer</p>
                    <p className="text-sm font-black text-primary mt-1">{invoiceDetailData.customerName}</p>
                    {invoiceDetailData.customerEmail && <p className="text-[10px] font-bold text-slate-400 mt-0.5">{invoiceDetailData.customerEmail}</p>}
                  </div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance Due</p>
                    <p className="text-xl font-black text-rose-500 mt-1">${invoiceDetailData.balance.toFixed(2)}</p>
                  </div>
                </div>
                <div>
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Line Items</h4>
                  <div className="space-y-2">
                    {invoiceDetailData.items.map(item => (
                      <div key={item.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${
                            item.type === 'repair' ? 'bg-blue-100 text-blue-700' :
                            item.type === 'service' ? 'bg-violet-100 text-violet-700' :
                            'bg-slate-100 text-slate-600'
                          }`}>{item.type}</span>
                          <span className="text-sm font-bold text-slate-700">{item.name}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-bold text-slate-400">{item.quantity} × ${item.price.toFixed(2)}</span>
                          <span className="ml-3 text-sm font-black text-primary">${(item.quantity * item.price).toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="pt-4 border-t border-slate-100 space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-slate-500 font-bold">Subtotal</span><span className="font-black text-slate-900">${invoiceDetailData.subtotal.toFixed(2)}</span></div>
                  {invoiceDetailData.discount > 0 && (
                    <div className="flex justify-between text-sm"><span className="text-emerald-500 font-bold">Discount</span><span className="font-black text-emerald-600">-${invoiceDetailData.discount.toFixed(2)}</span></div>
                  )}
                  <div className="flex justify-between text-sm"><span className="text-slate-500 font-bold">Tax</span><span className="font-black text-slate-900">${invoiceDetailData.tax.toFixed(2)}</span></div>
                  <div className="flex justify-between text-lg pt-2 border-t border-slate-100"><span className="font-black text-primary">Total</span><span className="font-black text-primary">${invoiceDetailData.total.toFixed(2)}</span></div>
                </div>
                {invoiceDetailData.paymentHistory.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Payment History</h4>
                    <div className="space-y-2">
                      {invoiceDetailData.paymentHistory.map(pay => (
                        <div key={pay.id} className="flex items-center justify-between p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-emerald-600 text-sm">check_circle</span>
                            <span className="text-sm font-black text-emerald-700">${pay.amount.toFixed(2)}</span>
                            <span className="text-[10px] font-bold text-emerald-500 uppercase">{pay.method}</span>
                          </div>
                          <span className="text-[10px] font-bold text-slate-400">{pay.timestamp}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="p-6 border-t border-slate-100 flex justify-end shrink-0">
                <button onClick={() => { setInvoiceDetailData(null); navigate('/invoices'); }} className="px-6 py-2.5 bg-primary text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 active:scale-95 transition-all flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm">receipt_long</span>
                  Open in Invoices
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
