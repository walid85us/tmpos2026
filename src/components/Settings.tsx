import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

type SettingsTab = 'config' | 'hardware' | 'language';

export default function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('config');

  const renderConfig = () => (
    <div className="space-y-12 pb-20">
      {/* 1. Store Profile & Identity */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">storefront</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Store Profile & Identity</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Store Name</label>
              <input className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" defaultValue="Teal Metrics - Main Branch" />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Company Registration (VAT/ABN/ACN)</label>
              <input className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="e.g. VAT12345678" />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Store Type</label>
              <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                <option>Repair Shop</option>
                <option>Retail Store</option>
                <option>Wholesale</option>
              </select>
            </div>
          </div>
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Store Locations</label>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-700">Main Branch (Default)</span>
                  <span className="material-symbols-outlined text-slate-300 text-sm">location_on</span>
                </div>
                <button className="w-full py-3 border-2 border-dashed border-slate-200 text-slate-400 text-[10px] font-black uppercase tracking-widest rounded-2xl hover:border-primary hover:text-primary transition-all">
                  + Add New Location
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Franchise Management</label>
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div>
                  <p className="text-xs font-black text-primary">Inter-company Invoicing</p>
                  <p className="text-[8px] font-medium text-slate-400">Enable billing between store locations</p>
                </div>
                <div className="w-10 h-5 bg-slate-200 rounded-full relative cursor-pointer">
                  <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Security & Access */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">security</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Security & Access</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Account Password</label>
              <button className="w-full py-4 bg-slate-50 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 hover:bg-slate-100 transition-colors">Update Password</button>
            </div>
            <div className="p-6 bg-emerald-50 rounded-[2rem] border border-emerald-100">
              <div className="flex items-center gap-4 mb-2">
                <div className="w-10 h-10 bg-emerald-500 text-white rounded-xl flex items-center justify-center">
                  <span className="material-symbols-outlined">verified_user</span>
                </div>
                <h4 className="text-sm font-black text-emerald-900">Two-Factor Auth (2FA)</h4>
              </div>
              <p className="text-[10px] font-medium text-emerald-600 mb-4">Add an extra layer of security to your account.</p>
              <button className="w-full py-3 bg-white text-emerald-600 text-[10px] font-black uppercase tracking-widest rounded-xl border border-emerald-200 shadow-sm">Configure 2FA</button>
            </div>
          </div>
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Cash Register Module</label>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <div>
                    <p className="text-xs font-black text-primary">Enable Cash Register</p>
                    <p className="text-[8px] font-medium text-slate-400">Track cash in/out and daily shifts</p>
                  </div>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative cursor-pointer">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <div>
                    <p className="text-xs font-black text-primary">Blind Close</p>
                    <p className="text-[8px] font-medium text-slate-400">Hide expected balance during shift close</p>
                  </div>
                  <div className="w-10 h-5 bg-slate-200 rounded-full relative cursor-pointer">
                    <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Regional & Tax Settings */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">public</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Regional & Tax Settings</h3>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Currency Management</label>
                <div className="flex gap-2">
                  <select className="flex-1 px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700">
                    <option>USD ($)</option>
                    <option>EUR (€)</option>
                    <option>GBP (£)</option>
                  </select>
                  <button className="p-4 bg-primary text-white rounded-2xl shadow-lg shadow-primary/20">
                    <span className="material-symbols-outlined text-sm">add</span>
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Decimal Separator</label>
                <div className="flex gap-2">
                  <button className="flex-1 py-3 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl">Dot (.)</button>
                  <button className="flex-1 py-3 bg-slate-50 text-slate-400 text-[10px] font-black uppercase tracking-widest rounded-xl">Comma (,)</button>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Time Format</label>
                <div className="flex gap-2">
                  <button className="flex-1 py-3 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl">12 Hour</button>
                  <button className="flex-1 py-3 bg-slate-50 text-slate-400 text-[10px] font-black uppercase tracking-widest rounded-xl">24 Hour</button>
                </div>
              </div>
            </div>
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Global Tax Setup</label>
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <input type="number" className="flex-1 px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700" defaultValue={8.5} />
                    <span className="text-sm font-black text-slate-400">%</span>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-black text-primary uppercase tracking-widest">VAT Margin Scheme</p>
                    <div className="w-10 h-5 bg-slate-200 rounded-full relative cursor-pointer">
                      <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Tax Application</label>
                <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700">
                  <option>Tax on Retail Price Only</option>
                  <option>Tax on Part Cost Only</option>
                  <option>Tax on Both</option>
                </select>
              </div>
            </div>
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Dual Tax Rate (Canada/Peru)</label>
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-600">Enable Dual Tax</span>
                    <div className="w-10 h-5 bg-slate-200 rounded-full relative cursor-pointer">
                      <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                    </div>
                  </div>
                  <input className="w-full px-4 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold" placeholder="Second Tax Name (e.g. PST)" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Workflow & Statuses */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">account_tree</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Workflow & Statuses</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Network Carriers</label>
              <div className="flex flex-wrap gap-2 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                {['Verizon', 'AT&T', 'T-Mobile', 'Unlocked'].map(c => (
                  <span key={c} className="px-3 py-1 bg-white text-primary text-[10px] font-black uppercase tracking-widest rounded-lg border border-slate-200 flex items-center gap-2">
                    {c}
                    <span className="material-symbols-outlined text-[10px] cursor-pointer">close</span>
                  </span>
                ))}
                <button className="px-3 py-1 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-lg">+ Add</button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Device Locations</label>
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                {['Shelf A1', 'Repair Bench 1', 'Storage Bin 4'].map(l => (
                  <div key={l} className="flex items-center justify-between p-2 bg-white rounded-xl border border-slate-100">
                    <span className="text-xs font-bold text-slate-600">{l}</span>
                    <span className="material-symbols-outlined text-slate-300 text-sm">edit</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Order & PO Statuses</label>
              <div className="grid grid-cols-2 gap-4">
                <button className="py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 hover:bg-slate-100">Ticket Statuses</button>
                <button className="py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 hover:bg-slate-100">PO Statuses</button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Suppliers Management</label>
              <button className="w-full py-4 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-lg shadow-primary/20">Manage Global Suppliers</button>
            </div>
          </div>
        </div>
      </section>

      {/* 5. Communication & Notifications */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">notifications_active</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Communication & Notifications</h3>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div>
                  <p className="text-sm font-black text-primary">Desktop Notifications</p>
                  <p className="text-[10px] font-medium text-slate-400">Enable browser-level push alerts</p>
                </div>
                <div className="w-10 h-5 bg-emerald-500 rounded-full relative cursor-pointer">
                  <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div>
                  <p className="text-sm font-black text-primary">2-Way Email Communication</p>
                  <p className="text-[10px] font-medium text-slate-400">Send job updates via linked email</p>
                </div>
                <div className="w-10 h-5 bg-emerald-500 rounded-full relative cursor-pointer">
                  <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div>
                  <p className="text-sm font-black text-primary">Auto-Emails on Status Change</p>
                  <p className="text-[10px] font-medium text-slate-400">Notify customers when ticket status moves</p>
                </div>
                <div className="w-10 h-5 bg-emerald-500 rounded-full relative cursor-pointer">
                  <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
              <button className="w-full py-4 bg-slate-100 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200">Configure Linked Statuses</button>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Advanced POS & Invoicing */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">receipt_long</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Advanced POS & Invoicing</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Invoice Settings</label>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-black text-primary uppercase">Show SKU</span>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative cursor-pointer">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-black text-primary uppercase">Show Warranty</span>
                  <div className="w-10 h-5 bg-emerald-500 rounded-full relative cursor-pointer">
                    <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Additional Items</label>
              <p className="text-[10px] font-medium text-slate-400 mb-2">Manage items like cleaning cloths or screen protectors added at checkout.</p>
              <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200">Configure Upsells</button>
            </div>
          </div>
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Purchase Order Display</label>
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
                {['Show Supplier SKU', 'Show Unit Cost', 'Show Expected Date'].map(f => (
                  <div key={f} className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-600">{f}</span>
                    <div className="w-8 h-4 bg-emerald-500 rounded-full relative cursor-pointer">
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

  const renderHardware = () => (
    <div className="space-y-12 pb-20">
      {/* 1. Cloud Printing Solutions */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">cloud_done</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Cloud Printing Solutions</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 bg-primary/5 rounded-2xl flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-2xl">print_connect</span>
              </div>
              <div>
                <h4 className="text-lg font-black text-primary">PrintNode Integration</h4>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Complete Cloud Printing Guide</p>
              </div>
            </div>
            <div className="space-y-4 mb-8">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <span className="text-xs font-bold text-slate-600">Manual Printing via PrintNode</span>
                <div className="w-10 h-5 bg-emerald-500 rounded-full relative cursor-pointer">
                  <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
            </div>
            <button className="w-full py-4 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-lg shadow-primary/20">Configure API Key</button>
          </div>
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 bg-primary/5 rounded-2xl flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-2xl">settings_input_component</span>
              </div>
              <div>
                <h4 className="text-lg font-black text-primary">QZ Tray Setup</h4>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Direct Browser Printing</p>
              </div>
            </div>
            <p className="text-xs font-medium text-slate-500 mb-8">Enable direct communication between RepairDesk and your thermal printers.</p>
            <button className="w-full py-4 bg-slate-100 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200">Download Plugin</button>
          </div>
        </div>
      </section>

      {/* 2. Direct Print Integrations */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">desktop_windows</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Direct Print Integrations</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h4 className="text-sm font-black text-primary mb-4">Windows Printer Setup</h4>
            <p className="text-xs font-medium text-slate-500 mb-6">Install the RepairDesk direct print utility for high-speed local printing on Windows.</p>
            <button className="w-full py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200">Download for Windows</button>
          </div>
          <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h4 className="text-sm font-black text-primary mb-4">macOS Printer Setup</h4>
            <p className="text-xs font-medium text-slate-500 mb-6">Optimized printing drivers for Apple computers. Supports all major thermal printers.</p>
            <button className="w-full py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200">Download for macOS</button>
          </div>
        </div>
      </section>

      {/* 3. Hardware Device Setup */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">devices</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Hardware Device Setup</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            { title: 'Epson Thermal', model: 'TM-T88VI', icon: 'print' },
            { title: 'Rongta Thermal', model: 'RP326', icon: 'print' },
            { title: 'Star Micronics', model: 'TSP-143', icon: 'print' },
            { title: 'Dymo LabelWriter', model: '450 / 550', icon: 'label' },
            { title: 'Cash Drawer', model: 'RJ11 / USB', icon: 'payments' },
            { title: 'Barcode Scanner', model: '1D / 2D', icon: 'barcode_scanner' }
          ].map((hw) => (
            <div key={hw.title} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm group hover:shadow-md transition-all">
              <div className="w-10 h-10 bg-primary/5 rounded-xl flex items-center justify-center text-primary mb-4 group-hover:scale-110 transition-transform">
                <span className="material-symbols-outlined text-xl">{hw.icon}</span>
              </div>
              <h4 className="text-sm font-black text-primary">{hw.title}</h4>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">{hw.model}</p>
              <button className="w-full py-2 bg-slate-50 text-slate-600 text-[8px] font-black uppercase tracking-widest rounded-lg hover:bg-slate-100">Configure</button>
            </div>
          ))}
        </div>
      </section>

      {/* 4. Cash Drawer Automation */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">point_of_sale</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Cash Drawer Automation</h3>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div>
                  <p className="text-sm font-black text-primary">Auto-Open on Sale</p>
                  <p className="text-[10px] font-medium text-slate-400">Trigger drawer when transaction completes</p>
                </div>
                <div className="w-10 h-5 bg-emerald-500 rounded-full relative cursor-pointer">
                  <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div>
                  <p className="text-sm font-black text-primary">macOS Cash Drawer Support</p>
                  <p className="text-[10px] font-medium text-slate-400">Special configuration for Mac environments</p>
                </div>
                <div className="w-10 h-5 bg-slate-200 rounded-full relative cursor-pointer">
                  <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderLanguage = () => (
    <div className="space-y-12 pb-20">
      {/* 1. Language & Localization */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">translate</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Language & Localization</h3>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="w-20 h-20 bg-primary/5 rounded-[2rem] flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-4xl">language</span>
            </div>
            <div>
              <h4 className="text-2xl font-black text-primary tracking-tight">Language Editor</h4>
              <p className="text-sm font-medium text-slate-500 max-w-md">Customize every label, button, and message in the system to match your local dialect or preferred terminology.</p>
            </div>
          </div>
          <button className="px-12 py-4 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-2xl shadow-xl shadow-primary/20 hover:bg-primary/90 transition-all">
            Open Language Editor
          </button>
        </div>
      </section>

      {/* 2. Document Template Customization */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-primary">description</span>
          <h3 className="text-xl font-black text-primary tracking-tight">Document Template Customization</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            { id: 'invoice', label: 'Invoice Template', icon: 'receipt_long' },
            { id: 'ticket', label: 'Repair Ticket', icon: 'build_circle' },
            { id: 'label', label: 'Inventory Label', icon: 'label' },
            { id: 'receipt', label: 'Sales Receipt', icon: 'payments' },
            { id: 'estimate', label: 'Price Estimate', icon: 'request_quote' }
          ].map((tmpl) => (
            <div key={tmpl.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm group hover:shadow-md transition-all">
              <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-primary mb-6 group-hover:bg-primary group-hover:text-white transition-colors">
                <span className="material-symbols-outlined text-2xl">{tmpl.icon}</span>
              </div>
              <h4 className="text-lg font-black text-primary mb-1">{tmpl.label}</h4>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-6">Customize layout & fields</p>
              <button className="w-full py-3 bg-slate-100 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary hover:text-white transition-all">Edit Template</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">System Configuration</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Store Setup</h2>
        </div>
        <button className="bg-primary text-white px-8 py-3 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 hover:bg-primary/90 transition-all">
          Save All Changes
        </button>
      </header>

      <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm w-fit">
        {[
          { id: 'config', label: 'Configurations', icon: 'settings_suggest' },
          { id: 'hardware', label: 'Hardware & Print', icon: 'print' },
          { id: 'language', label: 'Language & Templates', icon: 'translate' }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as SettingsTab)}
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
          {activeTab === 'config' && renderConfig()}
          {activeTab === 'hardware' && renderHardware()}
          {activeTab === 'language' && renderLanguage()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
