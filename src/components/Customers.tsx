import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

type CustomerView = 'list' | 'profile';

interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  phoneLabel: string;
  tier: string;
  points: number;
  repairs: number;
  lastVisit: string;
  avatar: string;
  group: string;
  notes: { text: string; date: string; flagged: boolean }[];
  assets: { model: string; serial: string; type: string }[];
  customFields: { label: string; value: string }[];
  gdprCompliant: boolean;
  campaignerStatus: 'Subscribed' | 'Unsubscribed' | 'Pending';
  thirdPartyBilling: boolean;
}

const mockCustomers: Customer[] = [
  { 
    id: 'CUST-001', 
    name: 'Alexander Wright', 
    email: 'alex@wright.com', 
    phone: '555-0123', 
    phoneLabel: 'Mobile',
    tier: 'Platinum', 
    points: 2450, 
    repairs: 12, 
    lastVisit: '2 days ago', 
    avatar: 'https://i.pravatar.cc/100?img=1',
    group: 'VIP Corporate',
    notes: [
      { text: 'Customer prefers original parts only.', date: '2024-03-15', flagged: true },
      { text: 'Always pays via corporate card.', date: '2024-02-10', flagged: false }
    ],
    assets: [
      { model: 'iPhone 15 Pro', serial: 'SN-99283-X', type: 'Smartphone' },
      { model: 'MacBook Pro 14"', serial: 'SN-11223-M', type: 'Laptop' }
    ],
    customFields: [
      { label: 'Company Name', value: 'Wright Tech Solutions' },
      { label: 'Referred By', value: 'Google Search' }
    ],
    gdprCompliant: true,
    campaignerStatus: 'Subscribed',
    thirdPartyBilling: true
  },
  { 
    id: 'CUST-002', 
    name: 'Sarah Jenkins', 
    email: 'sarah.j@gmail.com', 
    phone: '555-0199', 
    phoneLabel: 'Home',
    tier: 'Gold', 
    points: 1200, 
    repairs: 4, 
    lastVisit: '1 week ago', 
    avatar: 'https://i.pravatar.cc/100?img=5',
    group: 'Retail',
    notes: [],
    assets: [],
    customFields: [],
    gdprCompliant: true,
    campaignerStatus: 'Pending',
    thirdPartyBilling: false
  }
];

export default function Customers() {
  const [view, setView] = useState<CustomerView>('list');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewCustomerModal, setShowNewCustomerModal] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>(mockCustomers);
  const [newCustomerForm, setNewCustomerForm] = useState({ firstName: '', lastName: '', email: '', phone: '', phoneLabel: 'Mobile', group: 'Retail' });

  const handleCreateCustomer = () => {
    if (!newCustomerForm.firstName.trim() || !newCustomerForm.lastName.trim()) return;
    const newCustomer: Customer = {
      id: `CUST-${String(customers.length + 1).padStart(3, '0')}`,
      name: `${newCustomerForm.firstName} ${newCustomerForm.lastName}`,
      email: newCustomerForm.email,
      phone: newCustomerForm.phone,
      phoneLabel: newCustomerForm.phoneLabel,
      tier: 'Bronze',
      points: 0,
      repairs: 0,
      lastVisit: 'Just now',
      avatar: `https://i.pravatar.cc/100?img=${Math.floor(Math.random() * 70)}`,
      group: newCustomerForm.group,
      notes: [],
      assets: [],
      customFields: [],
      gdprCompliant: true,
      campaignerStatus: 'Pending',
      thirdPartyBilling: false
    };
    setCustomers(prev => [...prev, newCustomer]);
    setNewCustomerForm({ firstName: '', lastName: '', email: '', phone: '', phoneLabel: 'Mobile', group: 'Retail' });
    setShowNewCustomerModal(false);
  };

  const handleCustomerClick = (customer: Customer) => {
    setSelectedCustomer(customer);
    setView('profile');
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
            <button className="p-3 bg-white rounded-xl border border-slate-200 text-slate-400 hover:text-primary transition-all shadow-sm" title="Merge Customers">
              <span className="material-symbols-outlined text-sm">merge</span>
            </button>
          </div>
          <div className="relative w-64">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-xl py-2.5 pl-10 text-sm focus:ring-2 focus:ring-primary/20 shadow-sm" 
              placeholder="Search customers..." 
              type="text"
            />
          </div>
          <button 
            onClick={() => setShowNewCustomerModal(true)}
            className="bg-primary text-white px-8 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all"
          >
            + New Customer
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Customers</p>
          <p className="text-4xl font-black text-primary mt-2 tracking-tighter">2,840</p>
        </div>
        <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Loyalty</p>
          <p className="text-4xl font-black text-secondary mt-2 tracking-tighter">1,150</p>
        </div>
        <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Avg. Lifetime Value</p>
          <p className="text-4xl font-black text-primary mt-2 tracking-tighter">$412.50</p>
        </div>
        <div className="bg-teal-950 p-8 rounded-[2rem] shadow-xl text-white">
          <p className="text-[10px] font-black uppercase tracking-widest text-teal-100/60">New This Week</p>
          <p className="text-4xl font-black mt-2 tracking-tighter text-lime-400">+24</p>
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
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Repairs</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {customers.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.email.toLowerCase().includes(searchQuery.toLowerCase())).map((customer) => (
              <tr 
                key={customer.id} 
                onClick={() => handleCustomerClick(customer)}
                className="hover:bg-slate-50/50 transition-colors group cursor-pointer"
              >
                <td className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-slate-100 overflow-hidden border-2 border-white shadow-sm">
                      <img src={customer.avatar} alt="avatar" className="w-full h-full object-cover" />
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
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{customer.phoneLabel}:</span>
                    <span className="text-[10px] font-bold text-slate-500">{customer.phone}</span>
                  </div>
                </td>
                <td className="p-6">
                  <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-black uppercase tracking-widest">
                    {customer.group}
                  </span>
                </td>
                <td className="p-6">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-tighter ${
                      customer.tier === 'Platinum' ? 'bg-primary text-white' :
                      customer.tier === 'Gold' ? 'bg-amber-100 text-amber-800' :
                      'bg-slate-100 text-slate-800'
                    }`}>
                      {customer.tier}
                    </span>
                    <span className="text-[10px] font-bold text-slate-400">{customer.points} pts</span>
                  </div>
                </td>
                <td className="p-6">
                  <span className="font-black text-primary">{customer.repairs}</span>
                </td>
                <td className="p-6 text-right">
                  <button className="p-2 bg-slate-50 text-slate-400 rounded-xl group-hover:bg-primary group-hover:text-white transition-all">
                    <span className="material-symbols-outlined text-sm">arrow_forward</span>
                  </button>
                </td>
              </tr>
            ))}
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
                <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest flex items-center gap-1">
                  <span className="material-symbols-outlined text-[10px]">verified_user</span> GDPR Compliant
                </span>
              </div>
            </div>
          </div>
          <div className="flex gap-4">
            <button className="px-6 py-2.5 bg-white text-primary border border-slate-200 rounded-xl font-black text-xs uppercase tracking-widest shadow-sm hover:bg-slate-50 transition-all">
              Edit Profile
            </button>
            <button className="px-6 py-2.5 bg-primary text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all">
              Create Ticket
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Info & Assets */}
          <div className="lg:col-span-4 space-y-8">
            <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
              <div className="flex items-center gap-6 mb-8">
                <div className="w-20 h-20 rounded-[2rem] bg-slate-100 overflow-hidden border-4 border-white shadow-lg">
                  <img src={selectedCustomer.avatar} alt="avatar" className="w-full h-full object-cover" />
                </div>
                <div>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-tighter ${
                    selectedCustomer.tier === 'Platinum' ? 'bg-primary text-white' : 'bg-slate-100 text-slate-800'
                  }`}>
                    {selectedCustomer.tier} Tier
                  </span>
                  <p className="text-xl font-black text-primary mt-1">{selectedCustomer.points} <span className="text-xs text-slate-400 font-bold uppercase tracking-widest">Points</span></p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Email Address</label>
                  <p className="text-sm font-bold text-slate-700">{selectedCustomer.email}</p>
                  <p className="text-[8px] font-medium text-emerald-600 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[10px]">check_circle</span> Verified (Spam Safe)
                  </p>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Phone Number</label>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-[8px] font-black uppercase">{selectedCustomer.phoneLabel}</span>
                    <p className="text-sm font-bold text-slate-700">{selectedCustomer.phone}</p>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer Group</label>
                  <p className="text-sm font-bold text-slate-700">{selectedCustomer.group}</p>
                  {selectedCustomer.thirdPartyBilling && (
                    <span className="text-[8px] font-black text-primary uppercase tracking-widest mt-1 block">Third-Party Billing Enabled</span>
                  )}
                </div>
              </div>
            </section>

            <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest">Asset Management</h3>
                <button className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">+ Add Asset</button>
              </div>
              <div className="space-y-3">
                {selectedCustomer.assets.map((asset, i) => (
                  <div key={i} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex items-center gap-4">
                    <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm">
                      <span className="material-symbols-outlined text-xl">
                        {asset.type === 'Smartphone' ? 'smartphone' : 'laptop_mac'}
                      </span>
                    </div>
                    <div>
                      <p className="text-xs font-black text-primary">{asset.model}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{asset.serial}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Right Column: History, Notes, Custom Fields */}
          <div className="lg:col-span-8 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-sm font-black text-primary uppercase tracking-widest">Internal Notes</h3>
                  <button className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">+ Add Note</button>
                </div>
                <div className="space-y-4">
                  {selectedCustomer.notes.map((note, i) => (
                    <div key={i} className={`p-4 rounded-2xl border ${note.flagged ? 'bg-rose-50 border-rose-100' : 'bg-slate-50 border-slate-100'}`}>
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{note.date}</span>
                        {note.flagged && (
                          <span className="material-symbols-outlined text-rose-500 text-sm">flag</span>
                        )}
                      </div>
                      <p className="text-xs font-medium text-slate-600 leading-relaxed">{note.text}</p>
                    </div>
                  ))}
                  {selectedCustomer.notes.length === 0 && (
                    <p className="text-xs text-slate-400 italic text-center py-4">No notes recorded for this customer.</p>
                  )}
                </div>
              </section>

              <section className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-6">Custom Fields</h3>
                <div className="space-y-4">
                  {selectedCustomer.customFields.map((field, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{field.label}</span>
                      <span className="text-xs font-bold text-primary">{field.value}</span>
                    </div>
                  ))}
                  <div className="pt-4">
                    <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                      <span className="text-[10px] font-black text-emerald-800 uppercase tracking-widest">Campaigner Status</span>
                      <span className="px-2 py-1 bg-emerald-600 text-white rounded-lg text-[8px] font-black uppercase tracking-widest">
                        {selectedCustomer.campaignerStatus}
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
                  <button className="text-[10px] font-black text-primary uppercase tracking-widest border-b-2 border-primary pb-1">Tickets</button>
                  <button className="text-[10px] font-black text-slate-400 uppercase tracking-widest pb-1 hover:text-primary transition-colors">Invoices</button>
                  <button className="text-[10px] font-black text-slate-400 uppercase tracking-widest pb-1 hover:text-primary transition-colors">Estimates</button>
                </div>
              </div>
              <div className="p-0">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50/50">
                    <tr>
                      <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Order ID</th>
                      <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Device</th>
                      <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                      <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount</th>
                      <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {[
                      { id: 'RE-2041', device: 'iPhone 15 Pro', date: 'Oct 24, 2024', amount: '$249.00', status: 'Completed' },
                      { id: 'RE-1982', device: 'MacBook Pro 14"', date: 'Aug 12, 2024', amount: '$499.00', status: 'Completed' },
                      { id: 'RE-1850', device: 'iPhone 15 Pro', date: 'May 05, 2024', amount: '$89.00', status: 'Completed' }
                    ].map((order, i) => (
                      <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                        <td className="p-6 text-xs font-black text-primary">{order.id}</td>
                        <td className="p-6 text-xs font-bold text-slate-600">{order.device}</td>
                        <td className="p-6 text-xs font-medium text-slate-500">{order.date}</td>
                        <td className="p-6 text-xs font-black text-primary">{order.amount}</td>
                        <td className="p-6 text-right">
                          <span className="px-2 py-1 bg-emerald-100 text-emerald-600 rounded-lg text-[8px] font-black uppercase tracking-widest">
                            {order.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                <button onClick={() => setShowNewCustomerModal(false)} className="text-slate-400 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">First Name *</label>
                    <input 
                      value={newCustomerForm.firstName}
                      onChange={(e) => setNewCustomerForm(prev => ({ ...prev, firstName: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20" 
                      placeholder="First name" 
                      type="text" 
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Last Name *</label>
                    <input 
                      value={newCustomerForm.lastName}
                      onChange={(e) => setNewCustomerForm(prev => ({ ...prev, lastName: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20" 
                      placeholder="Last name" 
                      type="text" 
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Email Address</label>
                  <input 
                    value={newCustomerForm.email}
                    onChange={(e) => setNewCustomerForm(prev => ({ ...prev, email: e.target.value }))}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20" 
                    placeholder="email@example.com" 
                    type="email" 
                  />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Phone Number</label>
                    <input 
                      value={newCustomerForm.phone}
                      onChange={(e) => setNewCustomerForm(prev => ({ ...prev, phone: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20" 
                      placeholder="555-0000" 
                      type="tel" 
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Type</label>
                    <select 
                      value={newCustomerForm.phoneLabel}
                      onChange={(e) => setNewCustomerForm(prev => ({ ...prev, phoneLabel: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
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
                    onChange={(e) => setNewCustomerForm(prev => ({ ...prev, group: e.target.value }))}
                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-primary/20"
                  >
                    <option>Retail</option>
                    <option>VIP Corporate</option>
                    <option>Wholesale</option>
                    <option>Walk-in</option>
                  </select>
                </div>
                <button 
                  onClick={handleCreateCustomer}
                  disabled={!newCustomerForm.firstName.trim() || !newCustomerForm.lastName.trim()}
                  className="w-full py-4 bg-primary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg shadow-primary/20 active:scale-95 transition-all disabled:bg-slate-300 disabled:cursor-not-allowed disabled:shadow-none"
                >
                  Create Customer
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
