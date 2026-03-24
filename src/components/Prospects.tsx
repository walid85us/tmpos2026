import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

type ProspectTab = 'estimates' | 'leads' | 'inquiries';

export default function Prospects() {
  const [activeTab, setActiveTab] = useState<ProspectTab>('estimates');

  const renderEstimates = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: 'Draft', count: 12, color: 'bg-slate-100 text-slate-600' },
          { label: 'Sent', count: 24, color: 'bg-primary/10 text-primary' },
          { label: 'Accepted', count: 45, color: 'bg-emerald-100 text-emerald-600' },
          { label: 'Rejected', count: 8, color: 'bg-rose-100 text-rose-600' }
        ].map(stat => (
          <div key={stat.label} className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 block mb-2">{stat.label}</span>
            <div className="flex items-center justify-between">
              <span className="text-3xl font-black text-primary">{stat.count}</span>
              <span className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase ${stat.color}`}>Estimates</span>
            </div>
          </div>
        ))}
      </div>

      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-xl font-black text-primary tracking-tight">Recent Estimates</h3>
          <button className="px-6 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">+ Create Estimate</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-50">
                <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest px-4">Estimate #</th>
                <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest px-4">Customer</th>
                <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest px-4">Device</th>
                <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest px-4">Amount</th>
                <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest px-4">Status</th>
                <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {[
                { id: 'EST-2045', customer: 'Alice Johnson', device: 'iPhone 15 Pro', amount: '$249.00', status: 'Sent', date: '2h ago' },
                { id: 'EST-2044', customer: 'Bob Smith', device: 'MacBook Air M2', amount: '$499.00', status: 'Accepted', date: '5h ago' },
                { id: 'EST-2043', customer: 'Charlie Brown', device: 'iPad Pro 11"', amount: '$189.00', status: 'Draft', date: '1d ago' },
                { id: 'EST-2042', customer: 'Diana Prince', device: 'Apple Watch S9', amount: '$99.00', status: 'Rejected', date: '2d ago' }
              ].map(est => (
                <tr key={est.id} className="group hover:bg-slate-50/50 transition-colors">
                  <td className="py-4 px-4 text-xs font-black text-primary">{est.id}</td>
                  <td className="py-4 px-4 text-xs font-bold text-slate-600">{est.customer}</td>
                  <td className="py-4 px-4 text-xs font-medium text-slate-500">{est.device}</td>
                  <td className="py-4 px-4 text-xs font-black text-primary">{est.amount}</td>
                  <td className="py-4 px-4">
                    <span className={`px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest ${
                      est.status === 'Sent' ? 'bg-primary/10 text-primary' :
                      est.status === 'Accepted' ? 'bg-emerald-100 text-emerald-600' :
                      est.status === 'Draft' ? 'bg-slate-100 text-slate-400' :
                      'bg-rose-100 text-rose-600'
                    }`}>
                      {est.status}
                    </span>
                  </td>
                  <td className="py-4 px-4 text-right">
                    <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="p-2 hover:bg-white rounded-lg text-slate-400 hover:text-primary transition-colors">
                        <span className="material-symbols-outlined text-sm">visibility</span>
                      </button>
                      <button className="p-2 hover:bg-white rounded-lg text-slate-400 hover:text-emerald-600 transition-colors">
                        <span className="material-symbols-outlined text-sm">check_circle</span>
                      </button>
                      <button className="p-2 hover:bg-white rounded-lg text-slate-400 hover:text-primary transition-colors">
                        <span className="material-symbols-outlined text-sm">send</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );

  const renderLeads = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="w-12 h-12 bg-primary/5 rounded-2xl flex items-center justify-center text-primary mb-6">
            <span className="material-symbols-outlined text-2xl">mail</span>
          </div>
          <h4 className="text-lg font-black text-primary mb-2">Auto-Generated Leads</h4>
          <p className="text-xs font-medium text-slate-500 mb-6">Track inquiries automatically captured from your website and support emails.</p>
          <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
            <span className="text-[10px] font-black text-primary uppercase tracking-widest">Email Tracking</span>
            <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
              <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
            </div>
          </div>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="w-12 h-12 bg-secondary/5 rounded-2xl flex items-center justify-center text-secondary mb-6">
            <span className="material-symbols-outlined text-2xl">trending_up</span>
          </div>
          <h4 className="text-lg font-black text-primary mb-2">Lead Conversion</h4>
          <p className="text-xs font-medium text-slate-500 mb-6">Monitor your conversion rates from initial inquiry to finalized repair ticket.</p>
          <div className="flex items-end gap-2">
            <span className="text-3xl font-black text-primary">32%</span>
            <span className="text-[10px] font-bold text-emerald-500 mb-1">+5.2% this month</span>
          </div>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="w-12 h-12 bg-emerald-50/50 rounded-2xl flex items-center justify-center text-emerald-600 mb-6">
            <span className="material-symbols-outlined text-2xl">group</span>
          </div>
          <h4 className="text-lg font-black text-primary mb-2">Active Leads</h4>
          <p className="text-xs font-medium text-slate-500 mb-6">Currently pending potential customers awaiting follow-up or quote acceptance.</p>
          <span className="text-3xl font-black text-primary">156</span>
        </div>
      </div>

      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-xl font-black text-primary tracking-tight">Lead Pipeline</h3>
          <div className="flex gap-2">
            <button className="px-4 py-2 bg-slate-50 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200">Filter</button>
            <button className="px-6 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">+ Add Lead</button>
          </div>
        </div>
        <div className="space-y-4">
          {[
            { name: 'Kevin Durant', source: 'Website Form', interest: 'iPhone 15 Screen', date: '10m ago', status: 'New' },
            { name: 'LeBron James', source: 'Direct Email', interest: 'MacBook Battery', date: '1h ago', status: 'Contacted' },
            { name: 'Stephen Curry', source: 'Phone Call', interest: 'iPad Charging Port', date: '3h ago', status: 'Qualified' },
            { name: 'Kyrie Irving', source: 'Walk-in', interest: 'PS5 HDMI Port', date: '5h ago', status: 'New' }
          ].map(lead => (
            <div key={lead.name} className="flex items-center justify-between p-6 bg-slate-50 rounded-[2rem] border border-slate-100 group hover:bg-white hover:shadow-md transition-all">
              <div className="flex items-center gap-6">
                <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-primary shadow-sm">
                  <span className="material-symbols-outlined text-xl">person</span>
                </div>
                <div>
                  <h4 className="text-sm font-black text-primary">{lead.name}</h4>
                  <p className="text-[10px] font-medium text-slate-400 uppercase tracking-widest">{lead.source} • {lead.interest}</p>
                </div>
              </div>
              <div className="flex items-center gap-8">
                <div className="text-right">
                  <span className={`px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest ${
                    lead.status === 'New' ? 'bg-primary/10 text-primary' :
                    lead.status === 'Contacted' ? 'bg-amber-100 text-amber-600' :
                    'bg-emerald-100 text-emerald-600'
                  }`}>
                    {lead.status}
                  </span>
                  <p className="text-[10px] font-bold text-slate-400 mt-1">{lead.date}</p>
                </div>
                <button className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-slate-400 hover:text-primary transition-colors shadow-sm">
                  <span className="material-symbols-outlined text-sm">arrow_forward</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const renderInquiries = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-xl font-black text-primary tracking-tight">Customer Inquiries</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Service Requests & Communication</p>
          </div>
          <button className="px-6 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">+ New Inquiry</button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1 space-y-4">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
              <input className="w-full pl-10 pr-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="Search inquiries..." />
            </div>
            <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
              {[
                { name: 'James Harden', subject: 'Screen Repair Quote', time: '5m ago', active: true },
                { name: 'Russell Westbrook', subject: 'Battery Life Issue', time: '15m ago', active: false },
                { name: 'Chris Paul', subject: 'Water Damage Inquiry', time: '1h ago', active: false },
                { name: 'Devin Booker', subject: 'Laptop Fan Noise', time: '3h ago', active: false },
                { name: 'Kevin Love', subject: 'Tablet Screen Replacement', time: '5h ago', active: false }
              ].map(inq => (
                <div key={inq.name} className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                  inq.active ? 'bg-primary text-white border-primary shadow-lg shadow-primary/20' : 'bg-slate-50 border-slate-100 hover:bg-white hover:shadow-md'
                }`}>
                  <div className="flex justify-between items-start mb-1">
                    <h4 className={`text-xs font-black ${inq.active ? 'text-white' : 'text-primary'}`}>{inq.name}</h4>
                    <span className={`text-[8px] font-bold ${inq.active ? 'text-white/60' : 'text-slate-400'}`}>{inq.time}</span>
                  </div>
                  <p className={`text-[10px] font-medium ${inq.active ? 'text-white/80' : 'text-slate-500'}`}>{inq.subject}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="lg:col-span-2">
            <div className="bg-slate-50 rounded-[2.5rem] border border-slate-100 h-full flex flex-col">
              <div className="p-6 border-b border-slate-200 flex items-center justify-between bg-white rounded-t-[2.5rem]">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-primary/5 rounded-xl flex items-center justify-center text-primary">
                    <span className="material-symbols-outlined">person</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-black text-primary">James Harden</h4>
                    <p className="text-[10px] font-medium text-slate-400 uppercase tracking-widest">james.h@example.com • +1 (555) 987-6543</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="p-2 bg-slate-50 text-slate-400 rounded-xl hover:text-primary transition-colors">
                    <span className="material-symbols-outlined text-sm">call</span>
                  </button>
                  <button className="p-2 bg-slate-50 text-slate-400 rounded-xl hover:text-primary transition-colors">
                    <span className="material-symbols-outlined text-sm">mail</span>
                  </button>
                </div>
              </div>
              <div className="flex-1 p-8 space-y-6 overflow-y-auto max-h-[400px]">
                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-slate-200 rounded-lg flex-shrink-0"></div>
                  <div className="bg-white p-4 rounded-2xl rounded-tl-none border border-slate-100 max-w-[80%]">
                    <p className="text-xs font-medium text-slate-600 leading-relaxed">Hi, I'm looking for a quote to replace the screen on my iPhone 15 Pro. It's cracked but the touch still works. How much would it cost and how long does it take?</p>
                    <span className="text-[8px] font-bold text-slate-400 mt-2 block">10:45 AM</span>
                  </div>
                </div>
                <div className="flex gap-4 flex-row-reverse">
                  <div className="w-8 h-8 bg-primary rounded-lg flex-shrink-0"></div>
                  <div className="bg-primary text-white p-4 rounded-2xl rounded-tr-none max-w-[80%]">
                    <p className="text-xs font-medium leading-relaxed">Hello James! For the iPhone 15 Pro screen replacement, it's $249.00. We use original parts and it usually takes about 45-60 minutes. Would you like to book an appointment?</p>
                    <span className="text-[8px] font-bold text-white/60 mt-2 block">10:52 AM</span>
                  </div>
                </div>
              </div>
              <div className="p-6 bg-white rounded-b-[2.5rem] border-t border-slate-200">
                <div className="relative">
                  <textarea className="w-full pl-4 pr-16 py-4 bg-slate-50 rounded-2xl border border-slate-200 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 h-24 resize-none" placeholder="Type your response..."></textarea>
                  <button className="absolute right-4 bottom-4 p-3 bg-primary text-white rounded-xl shadow-lg shadow-primary/20">
                    <span className="material-symbols-outlined text-sm">send</span>
                  </button>
                </div>
              </div>
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
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Sales Pipeline</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Prospects</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-white/80 backdrop-blur-xl px-4 py-2 rounded-xl border border-slate-200 shadow-sm">
            <span className="material-symbols-outlined text-sm">trending_up</span>
            <span className="text-sm font-semibold">12 New Leads Today</span>
          </div>
        </div>
      </header>

      <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm w-fit">
        {[
          { id: 'estimates', label: 'Estimates', icon: 'request_quote' },
          { id: 'leads', label: 'Leads', icon: 'person_search' },
          { id: 'inquiries', label: 'Inquiries', icon: 'forum' }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as ProspectTab)}
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
          {activeTab === 'estimates' && renderEstimates()}
          {activeTab === 'leads' && renderLeads()}
          {activeTab === 'inquiries' && renderInquiries()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
