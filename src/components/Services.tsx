import React, { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState } from '../context/StoreLocalState';
import type { RepairService, RepairCategory } from '../types';
import ContextualHelp from './ContextualHelp';

type ServiceModalMode = 'add' | 'edit';
type CategoryModalMode = 'add' | 'edit';

export default function Services() {
  const {
    services, addService, updateService, deleteService,
    serviceCategories, addServiceCategory, updateServiceCategory, deleteServiceCategory,
  } = useStoreLocalState();

  const [activeTab, setActiveTab] = useState<'services' | 'categories' | 'bulk-price'>('services');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('All');

  const [showServiceModal, setShowServiceModal] = useState(false);
  const [serviceModalMode, setServiceModalMode] = useState<ServiceModalMode>('add');
  const [editingService, setEditingService] = useState<RepairService | null>(null);
  const [svcForm, setSvcForm] = useState({ name: '', categoryId: '', price: 0, cost: 0, estimatedTime: 45, flagNotes: '', sku: '', status: 'Active' as 'Active' | 'Inactive' });

  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [catModalMode, setCatModalMode] = useState<CategoryModalMode>('add');
  const [editingCategory, setEditingCategory] = useState<RepairCategory | null>(null);
  const [catForm, setCatForm] = useState({ name: '', icon: 'build' });

  const [bulkPrices, setBulkPrices] = useState<Record<string, string>>({});

  const filteredServices = useMemo(() => {
    let result = services;
    if (categoryFilter !== 'All') {
      result = result.filter(s => s.categoryName === categoryFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.categoryName.toLowerCase().includes(q) ||
        (s.sku || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [services, searchQuery, categoryFilter]);

  const serviceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    services.forEach(s => { counts[s.categoryId] = (counts[s.categoryId] || 0) + 1; });
    return counts;
  }, [services]);

  const openAddService = () => {
    setSvcForm({ name: '', categoryId: serviceCategories[0]?.id || '', price: 0, cost: 0, estimatedTime: 45, flagNotes: '', sku: '', status: 'Active' });
    setServiceModalMode('add');
    setEditingService(null);
    setShowServiceModal(true);
  };

  const openEditService = (s: RepairService) => {
    setSvcForm({ name: s.name, categoryId: s.categoryId, price: s.price, cost: s.cost, estimatedTime: s.estimatedTime, flagNotes: s.flagNotes || '', sku: s.sku || '', status: s.status });
    setServiceModalMode('edit');
    setEditingService(s);
    setShowServiceModal(true);
  };

  const handleSaveService = useCallback(() => {
    if (!svcForm.name.trim() || !svcForm.categoryId) return;
    const cat = serviceCategories.find(c => c.id === svcForm.categoryId);
    if (!cat) return;
    if (serviceModalMode === 'add') {
      const newSvc: RepairService = {
        id: `s-${Date.now()}`,
        name: svcForm.name,
        categoryId: svcForm.categoryId,
        categoryName: cat.name,
        price: svcForm.price,
        cost: svcForm.cost,
        estimatedTime: svcForm.estimatedTime,
        flagNotes: svcForm.flagNotes || undefined,
        status: svcForm.status,
        sku: svcForm.sku || undefined,
      };
      addService(newSvc);
    } else if (editingService) {
      updateService(editingService.id, {
        name: svcForm.name,
        categoryId: svcForm.categoryId,
        categoryName: cat.name,
        price: svcForm.price,
        cost: svcForm.cost,
        estimatedTime: svcForm.estimatedTime,
        flagNotes: svcForm.flagNotes || undefined,
        status: svcForm.status,
        sku: svcForm.sku || undefined,
      });
    }
    setShowServiceModal(false);
  }, [svcForm, serviceModalMode, editingService, serviceCategories, addService, updateService]);

  const handleDeleteService = (id: string) => {
    if (confirm('Delete this service?')) deleteService(id);
  };

  const openAddCategory = () => {
    setCatForm({ name: '', icon: 'build' });
    setCatModalMode('add');
    setEditingCategory(null);
    setShowCategoryModal(true);
  };

  const openEditCategory = (c: RepairCategory) => {
    setCatForm({ name: c.name, icon: c.icon });
    setCatModalMode('edit');
    setEditingCategory(c);
    setShowCategoryModal(true);
  };

  const handleSaveCategory = useCallback(() => {
    if (!catForm.name.trim()) return;
    if (catModalMode === 'add') {
      addServiceCategory({ id: `cat-${Date.now()}`, name: catForm.name, icon: catForm.icon });
    } else if (editingCategory) {
      updateServiceCategory(editingCategory.id, { name: catForm.name, icon: catForm.icon });
      services.filter(s => s.categoryId === editingCategory.id).forEach(s => {
        updateService(s.id, { categoryName: catForm.name });
      });
    }
    setShowCategoryModal(false);
  }, [catForm, catModalMode, editingCategory, addServiceCategory, updateServiceCategory, services, updateService]);

  const handleDeleteCategory = (id: string) => {
    const count = serviceCounts[id] || 0;
    if (count > 0) {
      alert(`Cannot delete category with ${count} active service(s). Remove or reassign services first.`);
      return;
    }
    if (confirm('Delete this category?')) deleteServiceCategory(id);
  };

  const handleBulkPriceSave = () => {
    Object.entries(bulkPrices).forEach(([id, priceStr]) => {
      const price = parseFloat(priceStr as string);
      if (!isNaN(price) && price > 0) {
        updateService(id, { price });
      }
    });
    setBulkPrices({});
  };

  const renderServices = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input
              type="text"
              placeholder="Search services..."
              className="pl-11 pr-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-900 w-64 shadow-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-600 shadow-sm appearance-none"
          >
            <option>All</option>
            {serviceCategories.map(cat => <option key={cat.id} value={cat.name}>{cat.name}</option>)}
          </select>
        </div>
        <button
          onClick={openAddService}
          className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2"
        >
          <span className="material-symbols-outlined text-sm">add</span>
          Add New Service
        </button>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Service Details</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Price</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Cost</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Est. Time</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredServices.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group">
                <td className="px-8 py-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-slate-100 overflow-hidden border border-slate-200 flex items-center justify-center">
                      {s.image ? (
                        <img src={s.image} alt={s.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="material-symbols-outlined text-slate-300">build</span>
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-black text-primary">{s.name}</p>
                      {s.sku && <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{s.sku}</p>}
                      {s.flagNotes && (
                        <div className="flex items-center gap-1 mt-1 text-amber-600">
                          <span className="material-symbols-outlined text-[10px]">flag</span>
                          <span className="text-[8px] font-black uppercase tracking-tighter truncate max-w-[150px]">{s.flagNotes}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-8 py-6">
                  <span className="px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg border border-slate-200">
                    {s.categoryName}
                  </span>
                </td>
                <td className="px-8 py-6 text-right font-black text-slate-900">${s.price.toFixed(2)}</td>
                <td className="px-8 py-6 text-right font-bold text-slate-500">${s.cost.toFixed(2)}</td>
                <td className="px-8 py-6 text-center text-sm font-bold text-slate-600">{s.estimatedTime}m</td>
                <td className="px-8 py-6">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${
                    s.status === 'Active' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' : 'bg-slate-500/10 text-slate-600 border-slate-500/20'
                  }`}>
                    {s.status}
                  </span>
                </td>
                <td className="px-8 py-6 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => openEditService(s)} className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Edit Service">
                      <span className="material-symbols-outlined text-sm">edit</span>
                    </button>
                    <button onClick={() => handleDeleteService(s.id)} className="p-2 hover:bg-rose-50 text-rose-400 rounded-xl transition-colors" title="Delete Service">
                      <span className="material-symbols-outlined text-sm">delete</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredServices.length === 0 && (
              <tr><td colSpan={7} className="px-8 py-12 text-center text-sm text-slate-400 font-bold">No services found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderCategories = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Repair Categories</h2>
        <button onClick={openAddCategory} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>
          New Category
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {serviceCategories.map(cat => (
          <div key={cat.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all group">
            <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-3xl text-primary">{cat.icon}</span>
            </div>
            <h3 className="text-xl font-black text-primary mb-2">{cat.name}</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{serviceCounts[cat.id] || 0} Active Services</p>
            <div className="mt-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => openEditCategory(cat)} className="flex-1 py-2 bg-slate-50 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-100">Edit</button>
              <button onClick={() => handleDeleteCategory(cat.id)} className="flex-1 py-2 bg-rose-50 text-rose-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-rose-100">Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderBulkPriceEditor = () => (
    <div className="space-y-6">
      <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h2 className="text-2xl font-black text-primary tracking-tight">Bulk Price Editor</h2>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Update multiple service prices at once</p>
          </div>
          <button
            onClick={handleBulkPriceSave}
            className="px-8 py-3 bg-emerald-500 text-white font-black text-xs rounded-2xl shadow-lg shadow-emerald-500/20 uppercase tracking-widest hover:bg-emerald-600 active:scale-95 transition-all"
          >
            Save All Changes
          </button>
        </div>
        <div className="space-y-4">
          {services.map(s => (
            <div key={s.id} className="flex items-center gap-6 p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex-1">
                <p className="text-sm font-black text-primary">{s.name}</p>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{s.categoryName}</p>
              </div>
              <div className="w-32">
                <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest block mb-1 ml-2">Current Price</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                  <input type="number" value={s.price} readOnly className="w-full pl-8 pr-4 py-2 bg-white rounded-xl border border-slate-200 text-sm font-black text-primary" />
                </div>
              </div>
              <div className="w-32">
                <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest block mb-1 ml-2">New Price</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                  <input
                    type="number"
                    placeholder="0.00"
                    value={bulkPrices[s.id] || ''}
                    onChange={(e) => setBulkPrices(prev => ({ ...prev, [s.id]: e.target.value }))}
                    className="w-full pl-8 pr-4 py-2 bg-white rounded-xl border border-slate-200 text-sm font-black text-emerald-600"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const ICON_OPTIONS = ['smartphone', 'laptop_mac', 'tablet_mac', 'videogame_asset', 'watch', 'headphones', 'speaker', 'tv', 'build', 'memory', 'cable', 'battery_charging_full'];

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Service Catalog</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Services</h2>
        </div>
        <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm">
          {[
            { id: 'services', label: 'Services', icon: 'build' },
            { id: 'categories', label: 'Categories', icon: 'category' },
            { id: 'bulk-price', label: 'Price Editor', icon: 'price_check' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                activeTab === tab.id
                  ? 'bg-primary text-white shadow-lg shadow-primary/20'
                  : 'text-slate-400 hover:text-primary hover:bg-slate-50'
              }`}
            >
              <span className="material-symbols-outlined text-sm">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'services' && renderServices()}
          {activeTab === 'categories' && renderCategories()}
          {activeTab === 'bulk-price' && renderBulkPriceEditor()}
        </motion.div>
      </AnimatePresence>

      <ContextualHelp
        title="Service & Warranty Guide"
        items={[
          { title: 'Warranty: Service vs Part', description: 'Warranty for services covers labor and workmanship, while part warranty covers the physical component.', icon: 'verified' },
          { title: 'Service Warranty Setup', description: 'Define custom warranty periods for each repair service to automate customer support and claims.', icon: 'history_edu' },
          { title: 'Inventory vs Service Items', description: 'Categorize labor as "Service Items" and physical stock as "Inventory Items" for cleaner accounting.', icon: 'category' },
          { title: 'Device & Repair Logic', description: 'Link specific devices to repair services to track common issues and successful fixes over time.', icon: 'build' }
        ]}
        accentColor="secondary"
      />

      <AnimatePresence>
        {showServiceModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowServiceModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{serviceModalMode === 'add' ? 'Add New Service' : 'Edit Service'}</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Configure repair service details</p>
                </div>
                <button onClick={() => setShowServiceModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>

              <div className="p-8 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Service Name *</label>
                    <input
                      value={svcForm.name}
                      onChange={(e) => setSvcForm(prev => ({ ...prev, name: e.target.value }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                      placeholder="e.g. iPhone 13 Screen Replacement"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Category *</label>
                    <select
                      value={svcForm.categoryId}
                      onChange={(e) => setSvcForm(prev => ({ ...prev, categoryId: e.target.value }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    >
                      <option value="">Select...</option>
                      {serviceCategories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Price ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={svcForm.price}
                      onChange={(e) => setSvcForm(prev => ({ ...prev, price: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Cost ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={svcForm.cost}
                      onChange={(e) => setSvcForm(prev => ({ ...prev, cost: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Est. Time (mins)</label>
                    <input
                      type="number"
                      value={svcForm.estimatedTime}
                      onChange={(e) => setSvcForm(prev => ({ ...prev, estimatedTime: parseInt(e.target.value) || 0 }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">SKU</label>
                    <input
                      value={svcForm.sku}
                      onChange={(e) => setSvcForm(prev => ({ ...prev, sku: e.target.value }))}
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                      placeholder="SRV-XXX-YYY"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Status</label>
                  <select
                    value={svcForm.status}
                    onChange={(e) => setSvcForm(prev => ({ ...prev, status: e.target.value as any }))}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Flag Notes</label>
                  <textarea
                    value={svcForm.flagNotes}
                    onChange={(e) => setSvcForm(prev => ({ ...prev, flagNotes: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-medium text-sm h-24 resize-none"
                    placeholder="Special instructions for technicians..."
                  />
                </div>
                <button
                  onClick={handleSaveService}
                  disabled={!svcForm.name.trim() || !svcForm.categoryId}
                  className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {serviceModalMode === 'add' ? 'Create Service' : 'Save Changes'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showCategoryModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowCategoryModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{catModalMode === 'add' ? 'New Category' : 'Edit Category'}</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Configure category details</p>
                </div>
                <button onClick={() => setShowCategoryModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>

              <div className="p-8 space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Category Name *</label>
                  <input
                    value={catForm.name}
                    onChange={(e) => setCatForm(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    placeholder="e.g. Wearables"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Icon</label>
                  <div className="flex flex-wrap gap-2">
                    {ICON_OPTIONS.map(icon => (
                      <button
                        key={icon}
                        onClick={() => setCatForm(prev => ({ ...prev, icon }))}
                        className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
                          catForm.icon === icon ? 'bg-primary text-white shadow-lg' : 'bg-slate-50 text-slate-400 hover:bg-slate-100 border border-slate-200'
                        }`}
                      >
                        <span className="material-symbols-outlined">{icon}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={handleSaveCategory}
                  disabled={!catForm.name.trim()}
                  className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {catModalMode === 'add' ? 'Create Category' : 'Save Changes'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
