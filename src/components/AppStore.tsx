import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

type AppStoreTab = 'connect' | 'appointments' | 'ordersync' | 'scanpro' | 'calculator';

export default function AppStore() {
  const [activeTab, setActiveTab] = useState<AppStoreTab>('connect');

  const renderConnect = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="w-12 h-12 bg-primary/5 rounded-2xl flex items-center justify-center text-primary mb-6">
            <span className="material-symbols-outlined text-2xl">hub</span>
          </div>
          <h4 className="text-lg font-black text-primary mb-2">Multi-Channel Sync</h4>
          <p className="text-xs font-medium text-slate-500 mb-6">Connect Google Business Profile and Facebook Page to manage all conversations in one place.</p>
          <div className="space-y-3">
            <button className="w-full py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 flex items-center justify-center gap-2">
              <span className="material-symbols-outlined text-sm">google</span> Connect Google
            </button>
            <button className="w-full py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 flex items-center justify-center gap-2">
              <span className="material-symbols-outlined text-sm">facebook</span> Connect Facebook
            </button>
          </div>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="w-12 h-12 bg-secondary/5 rounded-2xl flex items-center justify-center text-secondary mb-6">
            <span className="material-symbols-outlined text-2xl">reviews</span>
          </div>
          <h4 className="text-lg font-black text-primary mb-2">Review Automation</h4>
          <p className="text-xs font-medium text-slate-500 mb-6">Automate review requests via SMS and use AI to generate smart replies to customer feedback.</p>
          <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
            <span className="text-[10px] font-black text-primary uppercase tracking-widest">AI Smart Reply</span>
            <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
              <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
            </div>
          </div>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="w-12 h-12 bg-emerald-50/50 rounded-2xl flex items-center justify-center text-emerald-600 mb-6">
            <span className="material-symbols-outlined text-2xl">chat</span>
          </div>
          <h4 className="text-lg font-black text-primary mb-2">Connect Inbox</h4>
          <p className="text-xs font-medium text-slate-500 mb-6">Manage MMS, canned responses, and inquiry widgets from a unified communication hub.</p>
          <button className="w-full py-3 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">Open Connect Inbox</button>
        </div>
      </div>

      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-xl font-black text-primary tracking-tight mb-8">Connect Configuration</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Core Features</label>
              {[
                { label: 'Email Forwarder Setup', id: 'email' },
                { label: 'Inquiry Widget Embedding', id: 'inquiry' },
                { label: 'Canned Responses', id: 'canned' },
                { label: 'Feedback Module', id: 'feedback' },
                { label: 'Internal Notes in Chat', id: 'notes' }
              ].map(feat => (
                <div key={feat.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-600">{feat.label}</span>
                  <button className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">Configure</button>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Website Integration</h4>
              <div className="space-y-4">
                <div className="p-4 bg-white rounded-2xl border border-slate-200">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">HTML Embed Code</p>
                  <code className="text-[9px] text-slate-600 font-mono break-all bg-slate-50 p-2 rounded block border border-slate-100">
                    {`<div id="rd-connect-widget"></div><script src="https://connect.repairdesk.co/widget.js"></script>`}
                  </code>
                </div>
                <button className="w-full py-3 bg-white text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200">WordPress iFrame Guide</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderAppointmentsPro = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-xl font-black text-primary tracking-tight">Appointments Pro</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Advanced Scheduling Engine</p>
          </div>
          <div className="flex gap-2">
            <button className="px-6 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">Manage Quotes</button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Module Setup</label>
              <div className="space-y-2">
                {['Repair Categories', 'Brands & Models', 'Common Issues', 'Repair Services'].map(item => (
                  <div key={item} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <span className="text-xs font-bold text-slate-600">{item}</span>
                    <span className="material-symbols-outlined text-slate-300 text-sm">settings</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Widget Customization</h4>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Theme Color</label>
                  <div className="flex gap-2">
                    <div className="w-8 h-8 bg-primary rounded-lg border-2 border-white shadow-sm"></div>
                    <input className="flex-1 px-4 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold" defaultValue="#0D2E2E" />
                  </div>
                </div>
                <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Show Online Price</span>
                  <div className="w-8 h-4 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Notifications</h4>
              <div className="space-y-3">
                {['Booking Confirmation', 'Reminder SMS', 'Status Updates'].map(notif => (
                  <div key={notif} className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">{notif}</span>
                    <div className="w-8 h-4 bg-emerald-500 rounded-full relative">
                      <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderOrderSync = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center gap-6 mb-10">
          <div className="w-20 h-20 bg-primary/5 rounded-[2rem] flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-4xl">sync</span>
          </div>
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">OrderSync</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Automated Purchase Order Creation</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="space-y-8">
            <div className="space-y-4">
              <h4 className="text-sm font-black text-primary uppercase tracking-widest">How it works</h4>
              <div className="space-y-4">
                {[
                  { step: 1, text: 'Enter the Order ID from your integrated vendor website.' },
                  { step: 2, text: 'OrderSync fetches all item details automatically.' },
                  { step: 3, text: 'A Purchase Order is created in RepairDesk instantly.' }
                ].map(s => (
                  <div key={s.step} className="flex items-start gap-4">
                    <span className="w-6 h-6 bg-primary text-white text-[10px] font-black rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">{s.step}</span>
                    <p className="text-xs font-medium text-slate-600 leading-relaxed">{s.text}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Supported Vendors</label>
              <div className="flex flex-wrap gap-2">
                {['MobileSentrix', 'Injured Gadgets', 'Parts4Cells', 'Nexus Cellular'].map(v => (
                  <span key={v} className="px-3 py-1 bg-white rounded-lg border border-slate-200 text-[10px] font-bold text-slate-600">{v}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="bg-slate-50 p-8 rounded-[2.5rem] border border-slate-100 flex flex-col justify-center">
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Vendor Order ID</label>
                <input className="w-full px-6 py-4 bg-white rounded-2xl border border-slate-200 font-bold text-slate-700" placeholder="e.g. MS-992831" />
              </div>
              <button className="w-full py-4 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-xl shadow-primary/20 active:scale-95 transition-all">
                Sync Order & Create PO
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderScanPro = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center gap-6 mb-10">
          <div className="w-20 h-20 bg-secondary/5 rounded-[2rem] flex items-center justify-center text-secondary">
            <span className="material-symbols-outlined text-4xl">barcode_scanner</span>
          </div>
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">ScanPro</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">AI-Powered Product Cataloging</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="bg-slate-50 p-8 rounded-[2.5rem] border border-slate-100 text-center">
            <span className="material-symbols-outlined text-4xl text-primary mb-4">qr_code_scanner</span>
            <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-2">Scan Barcode</h4>
            <p className="text-[10px] font-medium text-slate-500 leading-relaxed">Scan any vendor barcode to automatically fetch product attributes.</p>
          </div>
          <div className="bg-slate-50 p-8 rounded-[2.5rem] border border-slate-100 text-center">
            <span className="material-symbols-outlined text-4xl text-primary mb-4">edit_note</span>
            <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-2">Enter SKU</h4>
            <p className="text-[10px] font-medium text-slate-500 leading-relaxed">Manually enter a vendor SKU to populate item details using AI.</p>
          </div>
          <div className="bg-slate-50 p-8 rounded-[2.5rem] border border-slate-100 text-center">
            <span className="material-symbols-outlined text-4xl text-emerald-500 mb-4">psychology</span>
            <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-2">AI Population</h4>
            <p className="text-[10px] font-medium text-slate-500 leading-relaxed">Automatically fills Brand, Model, Color, and Category fields.</p>
          </div>
        </div>

        <div className="mt-12 p-8 bg-primary rounded-[2.5rem] text-white flex items-center justify-between">
          <div>
            <h4 className="text-xl font-black tracking-tight mb-1">Ready to speed up your inventory?</h4>
            <p className="text-white/60 text-xs font-medium">ScanPro reduces manual entry time by up to 85%.</p>
          </div>
          <button className="px-8 py-4 bg-white text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-xl active:scale-95 transition-all">
            Launch ScanPro
          </button>
        </div>
      </section>
    </div>
  );

  const renderCalculator = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center gap-6 mb-10">
          <div className="w-20 h-20 bg-emerald-50 rounded-[2rem] flex items-center justify-center text-emerald-600">
            <span className="material-symbols-outlined text-4xl">calculate</span>
          </div>
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">Repair Price Calculator</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Instant Cost Estimator</p>
          </div>
        </div>

        <div className="max-w-xl mx-auto space-y-8">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Device Brand</label>
              <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700">
                <option>Apple</option>
                <option>Samsung</option>
                <option>Google</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Model</label>
              <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700">
                <option>iPhone 15 Pro</option>
                <option>iPhone 14</option>
                <option>iPad Air</option>
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Repair Issue</label>
            <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700">
              <option>Screen Replacement</option>
              <option>Battery Replacement</option>
              <option>Charging Port</option>
            </select>
          </div>
          
          <div className="p-8 bg-slate-900 rounded-[2.5rem] text-center">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Estimated Repair Cost</p>
            <p className="text-5xl font-black text-emerald-400 tracking-tighter mb-6">$249.00</p>
            <div className="flex gap-4">
              <button className="flex-1 py-4 bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-xl shadow-emerald-500/20 active:scale-95 transition-all">
                Create Estimate
              </button>
              <button className="flex-1 py-4 bg-white/10 text-white text-[10px] font-black uppercase tracking-widest rounded-2xl border border-white/10 hover:bg-white/20 transition-all">
                Print Quote
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
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">In-App Extensions</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">App Store</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-white/80 backdrop-blur-xl px-4 py-2 rounded-xl border border-slate-200 shadow-sm">
            <span className="material-symbols-outlined text-sm">apps</span>
            <span className="text-sm font-semibold">30 Active Modules</span>
          </div>
        </div>
      </header>

      <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm w-fit">
        {[
          { id: 'connect', label: 'Connect', icon: 'hub' },
          { id: 'appointments', label: 'Appointments Pro', icon: 'calendar_add_on' },
          { id: 'ordersync', label: 'OrderSync', icon: 'sync' },
          { id: 'scanpro', label: 'ScanPro', icon: 'barcode_scanner' },
          { id: 'calculator', label: 'Calculator', icon: 'calculate' }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as AppStoreTab)}
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
          {activeTab === 'connect' && renderConnect()}
          {activeTab === 'appointments' && renderAppointmentsPro()}
          {activeTab === 'ordersync' && renderOrderSync()}
          {activeTab === 'scanpro' && renderScanPro()}
          {activeTab === 'calculator' && renderCalculator()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
