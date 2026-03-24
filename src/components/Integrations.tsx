import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

type IntegrationTab = 
  | 'accounting' 
  | 'ecommerce' 
  | 'membership' 
  | 'payments' 
  | 'phone' 
  | 'productivity' 
  | 'sms' 
  | 'vendors'
  | 'developers';

export default function Integrations() {
  const [activeTab, setActiveTab] = useState<IntegrationTab>('accounting');

  const renderAccounting = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {[
          { id: 'xero', name: 'Xero', desc: 'Sync invoices, payments, and inventory with Xero accounting.', icon: 'account_balance' },
          { id: 'quickbooks', name: 'QuickBooks', desc: 'Automate your bookkeeping by syncing RepairDesk with QuickBooks Online.', icon: 'payments' }
        ].map(item => (
          <div key={item.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm group hover:shadow-md transition-all">
            <div className="flex items-center gap-6 mb-8">
              <div className="w-16 h-16 bg-primary/5 rounded-[1.5rem] flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-colors">
                <span className="material-symbols-outlined text-3xl">{item.icon}</span>
              </div>
              <div>
                <h4 className="text-xl font-black text-primary tracking-tight">{item.name}</h4>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Accounting Integration</p>
              </div>
            </div>
            <p className="text-sm font-medium text-slate-500 mb-8">{item.desc}</p>
            <div className="flex gap-4">
              <button className="flex-1 py-4 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-lg shadow-primary/20">Connect Account</button>
              <button className="px-6 py-4 bg-slate-50 text-slate-400 rounded-2xl border border-slate-100"><span className="material-symbols-outlined text-sm">settings</span></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderEcommerce = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[
          { id: 'shopify', name: 'Shopify', desc: 'Sell devices and accessories online with real-time inventory sync.', icon: 'shopping_bag' },
          { id: 'woocommerce', name: 'WooCommerce', desc: 'Integrate your WordPress store for seamless repair service sales.', icon: 'shopping_cart' },
          { id: 'mailchimp', name: 'Mailchimp', desc: 'Sync customer data for automated marketing and email campaigns.', icon: 'mail' }
        ].map(item => (
          <div key={item.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm group hover:shadow-md transition-all">
            <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-primary mb-6 group-hover:bg-primary group-hover:text-white transition-colors">
              <span className="material-symbols-outlined text-2xl">{item.icon}</span>
            </div>
            <h4 className="text-lg font-black text-primary mb-2">{item.name}</h4>
            <p className="text-xs font-medium text-slate-500 mb-8">{item.desc}</p>
            <button className="w-full py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 hover:bg-primary hover:text-white transition-all">Setup Integration</button>
          </div>
        ))}
      </div>
    </div>
  );

  const renderMembership = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-10">
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">Membership Plans</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Loyalty & Retention Management</p>
          </div>
          <button className="px-8 py-3 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">+ Create New Plan</button>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
            <h4 className="text-sm font-black text-primary mb-4">Plan Configurations</h4>
            <div className="space-y-3">
              {['Exclusive Discounts', 'Priority Service', 'Loyalty Rewards', 'Free Diagnostics'].map(f => (
                <div key={f} className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-600">{f}</span>
                  <div className="w-8 h-4 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
            <h4 className="text-sm font-black text-primary mb-4">Subscription Billing</h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100">
                <div>
                  <p className="text-xs font-black text-primary">Auto-Renew Invoices</p>
                  <p className="text-[8px] font-medium text-slate-400">Automatically generate recurring bills</p>
                </div>
                <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                  <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
              <button className="w-full py-3 bg-white text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200">Manage Membership Invoices</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderPayments = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { id: 'rd_pay', name: 'RD Pay (TSYS)', icon: 'account_balance', desc: 'Integrated payment processing powered by TSYS.' },
          { id: 'nexgo', name: 'Nexgo Terminal', icon: 'point_of_sale', desc: 'Standalone payment terminal integration for Nexgo.' },
          { id: 'stripe', name: 'Stripe', icon: 'credit_card', desc: 'Online and in-person payments with Stripe.' },
          { id: 'square', name: 'Square Terminal', icon: 'terminal', desc: 'Sync Square hardware with your POS system.' },
          { id: 'paypal', name: 'PayPal', icon: 'payments', desc: 'Accept PayPal and Venmo payments securely.' },
          { id: 'payfacto', name: 'Payfacto', icon: 'account_balance_wallet', desc: 'Integrated payment solutions for repair shops.' },
          { id: 'paymentsense', name: 'Paymentsense', icon: 'contactless', desc: 'UK-based integrated payment processing.' },
          { id: 'safeware', name: 'Safeware', icon: 'security', desc: 'Device protection and warranty payments.' }
        ].map(item => (
          <div key={item.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm group hover:shadow-md transition-all">
            <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-primary mb-6 group-hover:bg-primary group-hover:text-white transition-colors">
              <span className="material-symbols-outlined text-2xl">{item.icon}</span>
            </div>
            <h4 className="text-lg font-black text-primary mb-1">{item.name}</h4>
            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-4">Payment Processor</p>
            <p className="text-[10px] font-medium text-slate-500 mb-6 leading-relaxed">{item.desc}</p>
            <button className="w-full py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 hover:bg-primary hover:text-white transition-all">Configure</button>
          </div>
        ))}
      </div>

      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-xl font-black text-primary tracking-tight">Terminal Management</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Hardware & Device Sync</p>
          </div>
          <div className="flex gap-2">
            <span className="px-3 py-1 bg-emerald-50 text-emerald-600 text-[10px] font-black uppercase tracking-widest rounded-lg border border-emerald-100">All Terminals Online</span>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm">
                <span className="material-symbols-outlined">settings_remote</span>
              </div>
              <h4 className="text-xs font-black text-primary uppercase tracking-widest">Nexgo Terminal Setup</h4>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Device Pairing Mode</span>
                <button className="text-[10px] font-black text-primary uppercase tracking-widest">Start Pairing</button>
              </div>
              <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Terminal Firmware</span>
                <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">v2.4.0 (Latest)</span>
              </div>
            </div>
          </div>

          <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm">
                <span className="material-symbols-outlined">account_balance</span>
              </div>
              <h4 className="text-xs font-black text-primary uppercase tracking-widest">RD Pay (TSYS) Config</h4>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Merchant ID Sync</span>
                <span className="material-symbols-outlined text-emerald-500 text-sm">check_circle</span>
              </div>
              <button className="w-full py-3 bg-white text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200">View Integration Guide</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );

  const renderPhone = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center gap-6 mb-10">
          <div className="w-20 h-20 bg-primary/5 rounded-[2rem] flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-4xl">call</span>
          </div>
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">3CX Phone System</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Unified Communication Integration</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">System Setup</label>
              <div className="space-y-2">
                <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                  3CX Configuration
                  <span className="material-symbols-outlined text-sm">settings</span>
                </button>
                <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                  IP Phone Provisioning
                  <span className="material-symbols-outlined text-sm">router</span>
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Office Hours</label>
              <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                Set Version 20 Hours
                <span className="material-symbols-outlined text-sm">schedule</span>
              </button>
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Call Management</label>
              <div className="space-y-2">
                <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                  Manage Ring Groups
                  <span className="material-symbols-outlined text-sm">group_work</span>
                </button>
                <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                  Manage Queues
                  <span className="material-symbols-outlined text-sm">reorder</span>
                </button>
                <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                  Digital Receptionist
                  <span className="material-symbols-outlined text-sm">robot_2</span>
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Messaging & Voicemail</label>
              <div className="space-y-2">
                <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                  Greeting Messages
                  <span className="material-symbols-outlined text-sm">record_voice_over</span>
                </button>
                <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                  Fetch Voicemails
                  <span className="material-symbols-outlined text-sm">voicemail</span>
                </button>
                <button className="w-full py-4 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl border border-slate-200 text-left px-6 flex justify-between items-center">
                  SMS & MMS (3CX Mobile)
                  <span className="material-symbols-outlined text-sm">sms</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
            <h4 className="text-sm font-black text-primary mb-4">Call Logs & Tracking</h4>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                <span className="text-xs font-bold text-slate-600">Track Call Logs in Ticket View</span>
                <div className="w-8 h-4 bg-emerald-500 rounded-full relative">
                  <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
              <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-100">
                <span className="text-xs font-bold text-slate-600">Automated SMS with Directions</span>
                <div className="w-8 h-4 bg-emerald-500 rounded-full relative">
                  <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                </div>
              </div>
            </div>
          </div>
          <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
            <h4 className="text-sm font-black text-primary mb-4">Phone System Quotes</h4>
            <p className="text-xs font-medium text-slate-500 mb-6">Generate and manage quotes for phone system hardware and services directly from RepairDesk.</p>
            <button className="w-full py-3 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20">Manage Quotes</button>
          </div>
        </div>
      </section>
    </div>
  );

  const renderProductivity = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { id: 'zapier', name: 'Zapier', icon: 'bolt', desc: 'Automate legwork between RepairDesk and 5000+ apps.' },
          { id: 'google_cal', name: 'Google Calendar', icon: 'calendar_month', desc: 'Sync repair appointments and tasks with your calendar.' },
          { id: 'slack', name: 'Slack', icon: 'forum', desc: 'Get real-time notifications for tickets and sales in Slack.' },
          { id: 'wiki', name: 'Internal Wiki', icon: 'menu_book', desc: 'Maintain a knowledge base for your repair team.' },
          { id: 'm360', name: 'M360', icon: 'smartphone', desc: 'Device diagnostics and data erasure integration.' },
          { id: 'akko', name: 'Akko', icon: 'verified', desc: 'Offer device protection and insurance plans.' },
          { id: 'microsoft', name: 'Microsoft Secure Sign-in', icon: 'login', desc: 'Enable SSO for your team using Microsoft accounts.' }
        ].map(item => (
          <div key={item.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm group hover:shadow-md transition-all">
            <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-primary mb-6 group-hover:bg-primary group-hover:text-white transition-colors">
              <span className="material-symbols-outlined text-2xl">{item.icon}</span>
            </div>
            <h4 className="text-lg font-black text-primary mb-2">{item.name}</h4>
            <p className="text-[10px] font-medium text-slate-500 mb-8">{item.desc}</p>
            <button className="w-full py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 hover:bg-primary hover:text-white transition-all">Setup</button>
          </div>
        ))}
      </div>
    </div>
  );

  const renderSMS = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-10">
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">SMS Gateways</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Global Messaging Integrations</p>
          </div>
          <div className="px-6 py-2 bg-emerald-50 text-emerald-600 text-[10px] font-black uppercase tracking-widest rounded-xl border border-emerald-100">
            10DLC Compliant
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {[
            { name: 'RepairDesk SMS', desc: 'Native SMS service with 2-way messaging and automated alerts.' },
            { name: 'Textlocal', desc: 'Popular SMS gateway for UK and international messaging.' },
            { name: 'Clickatell', desc: 'Global SMS API with support for 2-way messaging.' },
            { name: 'SMS Broadcast', desc: 'Australian-based SMS gateway for bulk messaging.' },
            { name: 'SMS Global', desc: 'Send job alerts and promotional campaigns globally.' }
          ].map(gw => (
            <div key={gw.name} className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100 group hover:bg-white hover:shadow-md transition-all">
              <h4 className="text-sm font-black text-primary mb-2">{gw.name}</h4>
              <p className="text-[10px] font-medium text-slate-500 mb-6">{gw.desc}</p>
              <button className="w-full py-3 bg-white text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 group-hover:bg-primary group-hover:text-white transition-all">Configure API</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const renderVendors = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {[
          { name: 'MobileSentrix', region: 'US & Canada', desc: 'Direct integration for parts sourcing and PO management.' },
          { name: 'Reusely', region: 'Global', desc: 'Trade-in and buyback platform integration.' },
          { name: 'Phone LCD Parts', region: 'US', desc: 'Sourcing for high-quality LCDs and repair parts.' },
          { name: 'Parts4Cells', region: 'US', desc: 'Direct catalog sync for cell phone parts.' },
          { name: 'Nexus Cellular', region: 'Canada', desc: 'Wholesale parts sourcing for Canadian repair shops.' },
          { name: 'OneSource', region: 'Global', desc: 'Unified supplier integration for multiple vendors.' },
          { name: 'Balaji Wireless', region: 'US', desc: 'Sourcing for wireless accessories and parts.' },
          { name: 'Injured Gadgets', region: 'US', desc: 'Premium parts sourcing and inventory sync.' },
          { name: 'Wholesale Gadget Parts', region: 'US', desc: 'Bulk parts sourcing for repair professionals.' }
        ].map(vendor => (
          <div key={vendor.name} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm group hover:shadow-md transition-all">
            <div className="flex justify-between items-start mb-6">
              <div className="w-12 h-12 bg-primary/5 rounded-2xl flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-2xl">inventory_2</span>
              </div>
              <span className="px-3 py-1 bg-slate-50 text-slate-400 text-[8px] font-black uppercase tracking-widest rounded-lg border border-slate-100">
                {vendor.region}
              </span>
            </div>
            <h4 className="text-lg font-black text-primary mb-1">{vendor.name}</h4>
            <p className="text-xs font-medium text-slate-500 mb-8">{vendor.desc}</p>
            <button className="w-full py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 hover:bg-primary hover:text-white transition-all">Connect Vendor</button>
          </div>
        ))}
      </div>
    </div>
  );

  const renderDevelopers = () => (
    <div className="space-y-8">
      <section className="bg-white/80 backdrop-blur-xl p-10 rounded-[3rem] border border-slate-200 shadow-sm">
        <div className="flex items-center gap-6 mb-10">
          <div className="w-20 h-20 bg-primary/5 rounded-[2rem] flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-4xl">code</span>
          </div>
          <div>
            <h3 className="text-2xl font-black text-primary tracking-tight">Public API & OAuth 2.0</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Build custom integrations and connect third-party apps.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="space-y-8">
            <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-6">API Documentation</h4>
              <div className="space-y-4">
                {[
                  { label: 'Public API Reference', desc: 'Comprehensive guide to all available endpoints.', icon: 'api' },
                  { label: 'OAuth 2.0 Guide', desc: 'Securely authenticate your custom applications.', icon: 'lock' },
                  { label: 'Webhooks Setup', desc: 'Receive real-time notifications for system events.', icon: 'notifications_active' }
                ].map(doc => (
                  <div key={doc.label} className="flex items-center gap-4 p-4 bg-white rounded-2xl border border-slate-100 group hover:border-primary transition-all cursor-pointer">
                    <div className="w-10 h-10 bg-slate-50 rounded-xl flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-colors">
                      <span className="material-symbols-outlined text-xl">{doc.icon}</span>
                    </div>
                    <div>
                      <h5 className="text-xs font-black text-primary">{doc.label}</h5>
                      <p className="text-[10px] font-medium text-slate-500">{doc.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-8">
            <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-100">
              <h4 className="text-sm font-black text-primary uppercase tracking-widest mb-6">Developer Credentials</h4>
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">API Key</label>
                  <div className="relative">
                    <input 
                      readOnly 
                      value="rd_live_51PjK2..." 
                      className="w-full px-6 py-4 bg-white rounded-2xl border border-slate-200 font-mono text-xs text-slate-600 pr-16"
                    />
                    <button className="absolute right-4 top-1/2 -translate-y-1/2 text-primary font-black text-[10px] uppercase tracking-widest">Copy</button>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">OAuth Client ID</label>
                  <div className="relative">
                    <input 
                      readOnly 
                      value="88231-992-x-112" 
                      className="w-full px-6 py-4 bg-white rounded-2xl border border-slate-200 font-mono text-xs text-slate-600 pr-16"
                    />
                    <button className="absolute right-4 top-1/2 -translate-y-1/2 text-primary font-black text-[10px] uppercase tracking-widest">Copy</button>
                  </div>
                </div>
                <button className="w-full py-4 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-xl shadow-primary/20">Generate New Credentials</button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-12 p-8 bg-teal-950 rounded-[2.5rem] text-white flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-lime-400">
              <span className="material-symbols-outlined text-2xl">terminal</span>
            </div>
            <div>
              <h4 className="text-lg font-black tracking-tight mb-1">Developer Sandbox</h4>
              <p className="text-white/60 text-xs font-medium">Test your API calls in a safe, isolated environment before going live.</p>
            </div>
          </div>
          <button className="px-8 py-4 bg-white text-primary text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-xl active:scale-95 transition-all">
            Access Sandbox
          </button>
        </div>
      </section>
    </div>
  );

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Ecosystem Connectivity</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Integrations</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-white/80 backdrop-blur-xl px-4 py-2 rounded-xl border border-slate-200 shadow-sm">
            <span className="material-symbols-outlined text-sm">hub</span>
            <span className="text-sm font-semibold">63 Connected Apps</span>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-3">
          <div className="bg-white/80 backdrop-blur-xl p-2 rounded-[2rem] border border-slate-200 shadow-sm space-y-1 sticky top-8">
            {[
              { id: 'accounting', label: 'Accounting', icon: 'account_balance' },
              { id: 'ecommerce', label: 'E-Commerce', icon: 'shopping_bag' },
              { id: 'membership', label: 'Membership', icon: 'card_membership' },
              { id: 'payments', label: 'Payments', icon: 'payments' },
              { id: 'phone', label: 'Phone System', icon: 'call' },
              { id: 'productivity', label: 'Productivity', icon: 'bolt' },
              { id: 'sms', label: 'SMS Gateways', icon: 'sms' },
              { id: 'vendors', label: 'Vendors', icon: 'inventory_2' },
              { id: 'developers', label: 'Public API', icon: 'code' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as IntegrationTab)}
                className={`w-full flex items-center gap-4 px-6 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${
                  activeTab === tab.id 
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
              key={activeTab}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'accounting' && renderAccounting()}
              {activeTab === 'ecommerce' && renderEcommerce()}
              {activeTab === 'membership' && renderMembership()}
              {activeTab === 'payments' && renderPayments()}
              {activeTab === 'phone' && renderPhone()}
              {activeTab === 'productivity' && renderProductivity()}
              {activeTab === 'sms' && renderSMS()}
              {activeTab === 'vendors' && renderVendors()}
              {activeTab === 'developers' && renderDevelopers()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
