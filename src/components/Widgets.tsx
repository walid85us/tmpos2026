import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

type WidgetType = 
  | 'appointments' 
  | 'tracker' 
  | 'buyback' 
  | 'portal' 
  | 'cfd' 
  | 'self-checkin' 
  | 'tcd';

export default function Widgets() {
  const [activeWidget, setActiveWidget] = useState<WidgetType>('appointments');

  const renderAppointments = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-xl font-black text-primary tracking-tight">Appointment Booking Widget</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Online Scheduling Configuration</p>
          </div>
          <div className="w-12 h-6 bg-emerald-500 rounded-full relative cursor-pointer">
            <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm"></div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Available Services</label>
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                {['Screen Repair', 'Battery Replacement', 'Water Damage', 'Diagnostic'].map(s => (
                  <div key={s} className="flex items-center justify-between p-2 bg-white rounded-xl border border-slate-100">
                    <span className="text-xs font-bold text-slate-600">{s}</span>
                    <input type="checkbox" defaultChecked className="rounded text-primary focus:ring-primary" />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Lead Time (Hours)</label>
              <input type="number" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700" defaultValue={2} />
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Widget Preview</h4>
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
                <div className="w-full h-4 bg-slate-100 rounded mb-4"></div>
                <div className="grid grid-cols-7 gap-1 mb-4">
                  {Array.from({length: 14}).map((_, i) => (
                    <div key={i} className="aspect-square bg-slate-50 rounded-md"></div>
                  ))}
                </div>
                <div className="w-full h-10 bg-primary rounded-xl"></div>
              </div>
            </div>
            <div className="p-4 bg-slate-900 rounded-2xl">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Embed Code</p>
              <code className="text-[9px] text-emerald-400 font-mono break-all">
                {`<script src="https://widgets.repairdesk.co/appointments.js" data-id="TM-101"></script>`}
              </code>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderTracker = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-xl font-black text-primary tracking-tight mb-8">Repair Tracker Configuration</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Display Options</label>
              {[
                { label: 'Show Estimated Completion', id: 'est' },
                { label: 'Show Assigned Technician', id: 'tech' },
                { label: 'Show Parts Used', id: 'parts' },
                { label: 'Allow Online Payment', id: 'pay' }
              ].map(opt => (
                <div key={opt.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-600">{opt.label}</span>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Tracking Page Branding</h4>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Primary Color</label>
                  <div className="flex gap-2">
                    <div className="w-10 h-10 bg-primary rounded-xl border-2 border-white shadow-sm"></div>
                    <input className="flex-1 px-4 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold" defaultValue="#0D2E2E" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Custom CSS</label>
                  <textarea className="w-full px-4 py-3 bg-white rounded-xl border border-slate-200 text-[10px] font-mono h-24" placeholder=".tracker-container { ... }"></textarea>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderBuyback = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-xl font-black text-primary tracking-tight mb-8">Buyback & Trade-in Widget</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Device Categories</label>
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                {['Smartphones', 'Tablets', 'Laptops', 'Consoles'].map(c => (
                  <div key={c} className="flex items-center justify-between p-2 bg-white rounded-xl border border-slate-100">
                    <span className="text-xs font-bold text-slate-600">{c}</span>
                    <input type="checkbox" defaultChecked />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Pricing Logic</label>
              <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700">
                <option>Fixed Price List</option>
                <option>Dynamic (Market Value)</option>
                <option>Manual Quote Only</option>
              </select>
            </div>
            <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100">
              <p className="text-[10px] font-black text-amber-900 uppercase tracking-widest mb-1">Pro Tip</p>
              <p className="text-[10px] font-medium text-amber-700 leading-relaxed">Integrate with Reusely for automated market pricing updates.</p>
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Intake Questions</h4>
              <div className="space-y-2">
                {['Power On?', 'Cracked Screen?', 'Water Damage?', 'iCloud Locked?'].map(q => (
                  <div key={q} className="p-3 bg-white rounded-xl border border-slate-100 text-[10px] font-bold text-slate-600">
                    {q}
                  </div>
                ))}
                <button className="w-full py-2 border-2 border-dashed border-slate-200 text-slate-400 text-[8px] font-black uppercase tracking-widest rounded-xl">+ Add Question</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderPortal = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-xl font-black text-primary tracking-tight mb-8">Customer Portal Settings</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Portal Modules</label>
              {[
                { label: 'Repair History', id: 'hist' },
                { label: 'Invoice Downloads', id: 'inv' },
                { label: 'Device Management', id: 'dev' },
                { label: 'Warranty Tracking', id: 'war' },
                { label: 'Marketing Preferences', id: 'pref' }
              ].map(mod => (
                <div key={mod.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-600">{mod.label}</span>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Access Control</h4>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Login Method</label>
                  <select className="w-full px-6 py-4 bg-white rounded-2xl border border-slate-200 font-bold text-slate-700">
                    <option>Email & Password</option>
                    <option>OTP (Email/SMS)</option>
                    <option>Social Login (Google/FB)</option>
                  </select>
                </div>
                <div className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-200">
                  <span className="text-xs font-bold text-slate-600">Allow Guest Access</span>
                  <div className="w-10 h-5 bg-slate-200 rounded-full relative">
                    <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderCFD = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-xl font-black text-primary tracking-tight mb-8">Customer Facing Display (CFD)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Display Content</label>
              {[
                { label: 'Show Line Item Prices', id: 'prices' },
                { label: 'Show Tax Breakdown', id: 'tax' },
                { label: 'Show Promotional Slideshow', id: 'promo' },
                { label: 'Enable Digital Signature', id: 'sig' }
              ].map(item => (
                <div key={item.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-600">{item.label}</span>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Media Management</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="aspect-video bg-white rounded-2xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined mb-1">add_photo_alternate</span>
                  <span className="text-[8px] font-black uppercase">Add Slide</span>
                </div>
                <div className="aspect-video bg-slate-200 rounded-2xl overflow-hidden relative group">
                  <img src="https://picsum.photos/seed/repair/400/225" alt="promo" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="material-symbols-outlined text-white cursor-pointer">delete</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderSelfCheckin = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-xl font-black text-primary tracking-tight mb-8">Self Check-in Kiosk</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Intake Flow Steps</label>
              <div className="space-y-2">
                {['Customer Info', 'Device Selection', 'Issue Description', 'Pre-repair Condition', 'Terms & Signature'].map((step, i) => (
                  <div key={step} className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <span className="w-6 h-6 bg-primary text-white text-[10px] font-black rounded-full flex items-center justify-center">{i + 1}</span>
                    <span className="text-xs font-bold text-slate-600">{step}</span>
                    <span className="material-symbols-outlined text-slate-300 text-sm ml-auto">drag_indicator</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Kiosk Branding</h4>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Welcome Message</label>
                  <input className="w-full px-6 py-4 bg-white rounded-2xl border border-slate-200 font-bold text-slate-700" defaultValue="Welcome to Teal Metrics Repair!" />
                </div>
                <div className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-200">
                  <span className="text-xs font-bold text-slate-600">Require Phone Verification</span>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderTCD = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-xl font-black text-primary tracking-tight mb-8">Ticket Counter Display (TCD)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Display Columns</label>
              {['Ticket #', 'Customer Name', 'Device', 'Status', 'Technician'].map(col => (
                <div key={col} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-600">{col}</span>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-6">
            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary mb-4">Layout Options</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="aspect-video bg-primary rounded-2xl border-4 border-white shadow-lg flex items-center justify-center">
                  <span className="text-[10px] font-black text-white uppercase">Dark Theme</span>
                </div>
                <div className="aspect-video bg-white rounded-2xl border-4 border-slate-100 shadow-sm flex items-center justify-center">
                  <span className="text-[10px] font-black text-slate-400 uppercase">Light Theme</span>
                </div>
              </div>
              <div className="mt-6 space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Refresh Interval (Seconds)</label>
                <input type="number" className="w-full px-6 py-4 bg-white rounded-2xl border border-slate-200 font-bold text-slate-700" defaultValue={30} />
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
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Customer Experience</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Embeddable Widgets</h2>
        </div>
        <button className="bg-primary text-white px-8 py-3 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 hover:bg-primary/90 transition-all">
          Save Widget Config
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-3">
          <div className="bg-white/80 backdrop-blur-xl p-2 rounded-[2rem] border border-slate-200 shadow-sm space-y-1 sticky top-8">
            {[
              { id: 'appointments', label: 'Booking', icon: 'calendar_add_on' },
              { id: 'tracker', label: 'Tracker', icon: 'track_changes' },
              { id: 'buyback', label: 'Buyback', icon: 'currency_exchange' },
              { id: 'portal', label: 'Portal', icon: 'account_circle' },
              { id: 'cfd', label: 'CFD', icon: 'monitor' },
              { id: 'self-checkin', label: 'Kiosk', icon: 'touch_app' },
              { id: 'tcd', label: 'TCD', icon: 'tv' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveWidget(tab.id as WidgetType)}
                className={`w-full flex items-center gap-4 px-6 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${
                  activeWidget === tab.id 
                    ? 'bg-primary text-white shadow-lg shadow-primary/20' 
                    : 'text-slate-400 hover:text-primary hover:bg-slate-50'
                }`}
              >
                <span className="material-symbols-outlined text-xl">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="lg:col-span-9">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeWidget}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {activeWidget === 'appointments' && renderAppointments()}
              {activeWidget === 'tracker' && renderTracker()}
              {activeWidget === 'buyback' && renderBuyback()}
              {activeWidget === 'portal' && renderPortal()}
              {activeWidget === 'cfd' && renderCFD()}
              {activeWidget === 'self-checkin' && renderSelfCheckin()}
              {activeWidget === 'tcd' && renderTCD()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
