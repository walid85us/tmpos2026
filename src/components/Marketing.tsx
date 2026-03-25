import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

export default function Marketing() {
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Growth Hub</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Marketing & Loyalty</h2>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => setShowNewCampaign(true)} className="bg-primary text-white px-6 py-2 rounded-xl font-bold text-sm shadow-lg flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">campaign</span>
            New Campaign
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-2 bg-white p-8 rounded-[2rem] ghost-border shadow-sm relative overflow-hidden">
          <div className="relative z-10">
            <h3 className="text-xl font-extrabold text-primary tracking-tight mb-2">Loyalty Program Performance</h3>
            <p className="text-sm text-slate-500 mb-8">Track how your points system is driving repeat business.</p>
            
            <div className="grid grid-cols-3 gap-6 mb-8">
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Enrolled Members</p>
                <p className="text-3xl font-black text-primary mt-1">1,150</p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Points Redeemed</p>
                <p className="text-3xl font-black text-secondary mt-1">45.2K</p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Retention Rate</p>
                <p className="text-3xl font-black text-lime-600 mt-1">74%</p>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-xs font-black text-slate-900 uppercase tracking-widest">Tier Distribution</h4>
              <div className="flex h-8 rounded-xl overflow-hidden shadow-inner">
                <div className="bg-primary w-[15%] flex items-center justify-center text-[10px] text-white font-bold">Platinum</div>
                <div className="bg-secondary w-[25%] flex items-center justify-center text-[10px] text-white font-bold">Gold</div>
                <div className="bg-lime-400 w-[40%] flex items-center justify-center text-[10px] text-teal-950 font-bold">Silver</div>
                <div className="bg-slate-200 w-[20%] flex items-center justify-center text-[10px] text-slate-500 font-bold">Bronze</div>
              </div>
            </div>
          </div>
          <span className="material-symbols-outlined absolute -right-8 -bottom-8 text-[200px] text-primary/5 rotate-12">stars</span>
        </div>

        <div className="bg-slate-900 p-8 rounded-[2rem] text-white shadow-xl relative overflow-hidden">
          <div className="relative z-10 flex flex-col h-full">
            <h3 className="text-xl font-extrabold tracking-tight mb-6">Active Campaigns</h3>
            <div className="space-y-4 flex-1">
              {[
                { name: 'Summer Screen Sale', type: 'SMS', reach: '850', conversion: '12%', color: 'bg-lime-400' },
                { name: 'Loyalty Bonus Week', type: 'Email', reach: '1.2K', conversion: '8%', color: 'bg-secondary' },
                { name: 'MacBook Pro Promo', type: 'Push', reach: '420', conversion: '15%', color: 'bg-primary' },
              ].map((campaign, i) => (
                <div key={i} onClick={() => setSelectedTool(campaign.name)} className="bg-white/10 p-4 rounded-2xl border border-white/5 hover:bg-white/20 transition-all cursor-pointer">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-bold">{campaign.name}</h4>
                    <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase text-teal-950 ${campaign.color}`}>{campaign.type}</span>
                  </div>
                  <div className="flex justify-between text-[10px] font-bold text-white/60 uppercase tracking-widest">
                    <span>Reach: {campaign.reach}</span>
                    <span className="text-lime-400">Conv: {campaign.conversion}</span>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => setSelectedTool('campaigns')} className="mt-8 w-full py-3 bg-white/10 hover:bg-white/20 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border border-white/10">
              View All Campaigns
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { title: 'SMS Marketing', icon: 'sms', desc: 'Send bulk updates to customers' },
          { title: 'Email Builder', icon: 'mail', desc: 'Design professional newsletters' },
          { title: 'Loyalty Rules', icon: 'settings_suggest', desc: 'Configure points & tiers' },
          { title: 'Review Booster', icon: 'thumb_up', desc: 'Automate Google Review requests' },
        ].map((tool, i) => (
          <div key={i} onClick={() => setSelectedTool(tool.title)} className="bg-white p-6 rounded-3xl ghost-border shadow-sm hover:shadow-md transition-all cursor-pointer group">
            <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-all mb-4">
              <span className="material-symbols-outlined text-2xl">{tool.icon}</span>
            </div>
            <h4 className="font-bold text-slate-900 mb-1">{tool.title}</h4>
            <p className="text-xs text-slate-500 leading-relaxed">{tool.desc}</p>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {showNewCampaign && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setShowNewCampaign(false)} />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <h3 className="text-2xl font-black text-primary tracking-tight">Create New Campaign</h3>
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Marketing Automation</p>
              </div>
              <div className="p-8 space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Campaign Name</label>
                  <input className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="e.g. Spring Sale 2025" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Channel</label>
                  <div className="grid grid-cols-3 gap-3">
                    {['SMS', 'Email', 'Push'].map(ch => (
                      <button key={ch} className="py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 hover:bg-primary hover:text-white transition-all">{ch}</button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Target Audience</label>
                  <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700">
                    <option>All Customers</option>
                    <option>Loyalty Members Only</option>
                    <option>New Customers (30 days)</option>
                    <option>Inactive (90+ days)</option>
                  </select>
                </div>
                <div className="flex gap-4 pt-4">
                  <button onClick={() => setShowNewCampaign(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                  <button onClick={() => setShowNewCampaign(false)} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all">Create Campaign</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {selectedTool && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setSelectedTool(null)} />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{selectedTool}</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Marketing Tool</p>
                </div>
                <button onClick={() => setSelectedTool(null)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-primary/5 rounded-full flex items-center justify-center mb-6">
                  <span className="material-symbols-outlined text-4xl text-primary">construction</span>
                </div>
                <p className="text-sm text-slate-500 mb-6">This tool will connect to your marketing automation pipeline when backend services are configured.</p>
                <button onClick={() => setSelectedTool(null)} className="px-8 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20">Got It</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
