import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RepairService, RepairCategory } from '../types';
import ContextualHelp from './ContextualHelp';

const MOCK_CATEGORIES: RepairCategory[] = [
  { id: 'cat1', name: 'Smartphones', icon: 'smartphone' },
  { id: 'cat2', name: 'Laptops', icon: 'laptop_mac' },
  { id: 'cat3', name: 'Tablets', icon: 'tablet_mac' },
  { id: 'cat4', name: 'Game Consoles', icon: 'videogame_asset' }
];

const MOCK_SERVICES: RepairService[] = [
  {
    id: 's1',
    name: 'iPhone 13 Screen Replacement',
    categoryId: 'cat1',
    categoryName: 'Smartphones',
    price: 129.99,
    cost: 45.00,
    estimatedTime: 45,
    flagNotes: 'Handle OLED with care. Check FaceID after repair.',
    status: 'Active',
    sku: 'SRV-IP13-SCR',
    image: 'https://picsum.photos/seed/iphone/200/200'
  },
  {
    id: 's2',
    name: 'MacBook Air M1 Battery Replacement',
    categoryId: 'cat2',
    categoryName: 'Laptops',
    price: 199.99,
    cost: 80.00,
    estimatedTime: 60,
    status: 'Active',
    sku: 'SRV-MBA-BAT',
    image: 'https://picsum.photos/seed/macbook/200/200'
  },
  {
    id: 's3',
    name: 'iPad Pro 11 Charging Port Repair',
    categoryId: 'cat3',
    categoryName: 'Tablets',
    price: 89.99,
    cost: 15.00,
    estimatedTime: 90,
    flagNotes: 'Requires micro-soldering.',
    status: 'Active',
    sku: 'SRV-IPP-CHG'
  }
];

export default function Services() {
  const [activeTab, setActiveTab] = useState<'services' | 'categories' | 'bulk-price' | 'bulk-images'>('services');
  const [services, setServices] = useState<RepairService[]>(MOCK_SERVICES);
  const [categories, setCategories] = useState<RepairCategory[]>(MOCK_CATEGORIES);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddServiceModal, setShowAddServiceModal] = useState(false);

  const filteredServices = services.filter(s => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.categoryName.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
          <select className="px-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-600 shadow-sm appearance-none">
            <option>All Categories</option>
            {categories.map(cat => <option key={cat.id}>{cat.name}</option>)}
          </select>
        </div>
        <button 
          onClick={() => setShowAddServiceModal(true)}
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
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{s.sku}</p>
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
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors">
                      <span className="material-symbols-outlined text-sm">edit</span>
                    </button>
                    <button className="p-2 hover:bg-rose-50 text-rose-400 rounded-xl transition-colors">
                      <span className="material-symbols-outlined text-sm">delete</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderCategories = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Repair Categories</h2>
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
          <span className="material-symbols-outlined text-sm">add</span>
          New Category
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {categories.map(cat => (
          <div key={cat.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all group">
            <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-3xl text-primary">{cat.icon}</span>
            </div>
            <h3 className="text-xl font-black text-primary mb-2">{cat.name}</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">12 Active Services</p>
            <div className="mt-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button className="flex-1 py-2 bg-slate-50 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-100">Edit</button>
              <button className="flex-1 py-2 bg-rose-50 text-rose-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-rose-100">Delete</button>
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
          <button className="px-8 py-3 bg-emerald-500 text-white font-black text-xs rounded-2xl shadow-lg shadow-emerald-500/20 uppercase tracking-widest">
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
                  <input type="number" defaultValue={s.price} className="w-full pl-8 pr-4 py-2 bg-white rounded-xl border border-slate-200 text-sm font-black text-primary" />
                </div>
              </div>
              <div className="w-32">
                <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest block mb-1 ml-2">New Price</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                  <input type="number" placeholder="0.00" className="w-full pl-8 pr-4 py-2 bg-white rounded-xl border border-slate-200 text-sm font-black text-emerald-600" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderBulkImageUpdate = () => (
    <div className="space-y-6">
      <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 bg-primary/5 rounded-full flex items-center justify-center mb-6">
          <span className="material-symbols-outlined text-4xl text-primary">add_photo_alternate</span>
        </div>
        <h3 className="text-2xl font-black text-primary tracking-tight mb-2">Bulk Image Update Tool</h3>
        <p className="text-sm font-bold text-slate-400 max-w-md mb-8">
          Upload a ZIP file containing images named by SKU or Service ID to automatically update your service catalog.
        </p>
        <button className="px-12 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-xl shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
          Upload ZIP Archive
        </button>
      </div>
    </div>
  );

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
            { id: 'bulk-images', label: 'Image Tool', icon: 'image' }
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
          {activeTab === 'bulk-images' && renderBulkImageUpdate()}
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

      {/* Add Service Modal Placeholder */}
      <AnimatePresence>
        {showAddServiceModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAddServiceModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Add New Service</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Configure repair service details</p>
                </div>
                <button onClick={() => setShowAddServiceModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              
              <div className="p-8 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Service Name</label>
                    <input className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="e.g. iPhone 13 Screen Replacement" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Category</label>
                    <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                      {categories.map(cat => <option key={cat.id}>{cat.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Price ($)</label>
                    <input type="number" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="0.00" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Est. Time (mins)</label>
                    <input type="number" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="45" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Flag Notes</label>
                  <textarea 
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-medium text-sm h-24 resize-none"
                    placeholder="Special instructions for technicians..."
                  />
                </div>
                <button className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
                  Create Service
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
