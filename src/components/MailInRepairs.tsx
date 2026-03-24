import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

type MailInTab = 'suite' | 'shipping' | 'forms' | 'payments' | 'portal';

export default function MailInRepairs() {
  const [activeTab, setActiveTab] = useState<MailInTab>('suite');

  const renderSuite = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: 'Pending Arrival', count: 18, color: 'bg-amber-100 text-amber-600' },
          { label: 'In Repair', count: 32, color: 'bg-primary/10 text-primary' },
          { label: 'Ready to Ship', count: 14, color: 'bg-emerald-100 text-emerald-600' },
          { label: 'Delivered', count: 156, color: 'bg-slate-100 text-slate-600' }
        ].map(stat => (
          <div key={stat.label} className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 block mb-2">{stat.label}</span>
            <div className="flex items-center justify-between">
              <span className="text-3xl font-black text-primary">{stat.count}</span>
              <span className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase ${stat.color}`}>Tickets</span>
            </div>
          </div>
        ))}
      </div>

      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-xl font-black text-primary tracking-tight">Mail-In Repair Suite</h3>
          <div className="flex gap-2">
            <button className="px-6 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">+ New Mail-In</button>
          </div>
        </div>
        <div className="space-y-4">
          {[
            { id: 'MI-1045', customer: 'John Wick', device: 'iPhone 15 Pro', tracking: 'UPS-992831', status: 'Pending Arrival', date: '2h ago' },
            { id: 'MI-1044', customer: 'Tony Stark', device: 'MacBook Pro M3', tracking: 'FEDEX-112233', status: 'In Repair', date: '5h ago' },
            { id: 'MI-1043', customer: 'Bruce Wayne', device: 'iPad Pro 12.9"', tracking: 'USPS-445566', status: 'Ready to Ship', date: '1d ago' }
          ].map(ticket => (
            <div key={ticket.id} className="flex items-center justify-between p-6 bg-slate-50 rounded-[2rem] border border-slate-100 group hover:bg-white hover:shadow-md transition-all">
              <div className="flex items-center gap-6">
                <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-primary shadow-sm">
                  <span className="material-symbols-outlined text-xl">mail</span>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-black text-primary">{ticket.customer}</h4>
                    <span className="text-[10px] font-bold text-slate-400">#{ticket.id}</span>
                  </div>
                  <p className="text-[10px] font-medium text-slate-400 uppercase tracking-widest">{ticket.device} • {ticket.tracking}</p>
                </div>
              </div>
              <div className="flex items-center gap-8">
                <div className="text-right">
                  <span className={`px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest ${
                    ticket.status === 'Pending Arrival' ? 'bg-amber-100 text-amber-600' :
                    ticket.status === 'In Repair' ? 'bg-primary/10 text-primary' :
                    'bg-emerald-100 text-emerald-600'
                  }`}>
                    {ticket.status}
                  </span>
                  <p className="text-[10px] font-bold text-slate-400 mt-1">{ticket.date}</p>
                </div>
                <button className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-slate-400 hover:text-primary transition-colors shadow-sm">
                  <span className="material-symbols-outlined text-sm">local_shipping</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const renderShipping = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center gap-6 mb-10">
          <div className="w-20 h-20 bg-primary/5 rounded-[2rem] flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-4xl">local_shipping</span>
          </div>
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">ShipStation Integration</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Automated Shipping Labels & Tracking</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Carrier Configuration</h4>
              <div className="space-y-3">
                {['UPS', 'FedEx', 'USPS', 'DHL'].map(carrier => (
                  <div key={carrier} className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100">
                    <span className="text-xs font-bold text-slate-600">{carrier}</span>
                    <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                      <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Label Automation</h4>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100">
                  <div>
                    <p className="text-xs font-black text-primary">Auto-Generate Return Labels</p>
                    <p className="text-[8px] font-medium text-slate-400">Send label to customer on ticket creation</p>
                  </div>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
                <button className="w-full py-3 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">Connect ShipStation API</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderForms = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-xl font-black text-primary tracking-tight">RepairDesk Forms</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Custom Mail-In Intake Forms</p>
          </div>
          <button className="px-6 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">+ Create Form</button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            { name: 'Standard Mail-In', responses: 145, status: 'Active' },
            { name: 'B2B Bulk Intake', responses: 28, status: 'Active' },
            { name: 'Warranty Claim', responses: 12, status: 'Draft' }
          ].map(form => (
            <div key={form.name} className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100 group hover:bg-white hover:shadow-md transition-all">
              <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-primary mb-4 shadow-sm">
                <span className="material-symbols-outlined">description</span>
              </div>
              <h4 className="text-sm font-black text-primary mb-1">{form.name}</h4>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-6">{form.responses} Submissions</p>
              <div className="flex gap-2">
                <button className="flex-1 py-2 bg-white text-primary text-[8px] font-black uppercase tracking-widest rounded-lg border border-slate-200">Edit</button>
                <button className="flex-1 py-2 bg-white text-primary text-[8px] font-black uppercase tracking-widest rounded-lg border border-slate-200">Embed</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const renderPayments = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <h3 className="text-xl font-black text-primary tracking-tight mb-8">Online Payments</h3>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Payment Methods</h4>
              <div className="space-y-3">
                {['Credit/Debit Card', 'PayPal', 'Apple Pay', 'Google Pay'].map(method => (
                  <div key={method} className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                    <span className="text-xs font-bold text-slate-600">{method}</span>
                    <div className="w-8 h-4 bg-emerald-500 rounded-full relative">
                      <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
              <span className="text-[10px] font-black text-emerald-800 uppercase tracking-widest">Auto-Charge on Completion</span>
              <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <h3 className="text-xl font-black text-primary tracking-tight mb-8">Estimate Module</h3>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Estimate Settings</h4>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100">
                  <div>
                    <p className="text-xs font-black text-primary">Require Deposit</p>
                    <p className="text-[8px] font-medium text-slate-400">Collect payment before starting repair</p>
                  </div>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Estimate Expiry (Days)</label>
                  <input type="number" className="w-full px-6 py-3 bg-white rounded-2xl border border-slate-200 font-bold text-slate-700" defaultValue={7} />
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );

  const renderPortal = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center gap-6 mb-10">
          <div className="w-20 h-20 bg-secondary/5 rounded-[2rem] flex items-center justify-center text-secondary">
            <span className="material-symbols-outlined text-4xl">business_center</span>
          </div>
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">B2B Mail-In Customer Portal</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Bulk Repair Management for Business Clients</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-100">
            <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-6">Portal Features</h4>
            <div className="space-y-4">
              {[
                { label: 'Bulk Ticket Upload', id: 'bulk' },
                { label: 'Custom Pricing Tiers', id: 'price' },
                { label: 'Monthly Invoicing', id: 'inv' },
                { label: 'Dedicated Support Chat', id: 'chat' }
              ].map(feat => (
                <div key={feat.id} className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-600">{feat.label}</span>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-100 flex flex-col justify-center">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-primary mx-auto shadow-sm">
                <span className="material-symbols-outlined text-3xl">link</span>
              </div>
              <h4 className="text-sm font-black text-primary uppercase tracking-widest">Portal Access Link</h4>
              <code className="text-[10px] text-slate-600 font-mono bg-white p-3 rounded-xl border border-slate-200 block">
                https://portal.tealmetrics.com/b2b/login
              </code>
              <button className="w-full py-4 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-xl shadow-primary/20 transition-all">
                Copy Portal Link
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Remote Logistics</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Mail-In Repairs</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-white/80 backdrop-blur-xl px-4 py-2 rounded-xl border border-slate-200 shadow-sm">
            <span className="material-symbols-outlined text-sm">local_shipping</span>
            <span className="text-sm font-semibold">24 Incoming Shipments</span>
          </div>
        </div>
      </header>

      <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm w-fit">
        {[
          { id: 'suite', label: 'Suite', icon: 'mail' },
          { id: 'shipping', label: 'Shipping', icon: 'local_shipping' },
          { id: 'forms', label: 'Forms', icon: 'description' },
          { id: 'payments', label: 'Payments', icon: 'payments' },
          { id: 'portal', label: 'B2B Portal', icon: 'business_center' }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as MailInTab)}
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

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'suite' && renderSuite()}
          {activeTab === 'shipping' && renderShipping()}
          {activeTab === 'forms' && renderForms()}
          {activeTab === 'payments' && renderPayments()}
          {activeTab === 'portal' && renderPortal()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
