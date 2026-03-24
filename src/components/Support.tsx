import React from 'react';

export default function Support() {
  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Help Center</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Support & Resources</h2>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-8">
          {/* Knowledge Base Search */}
          <section className="signature-gradient p-10 rounded-[3rem] shadow-2xl text-white relative overflow-hidden">
            <div className="relative z-10">
              <h3 className="text-2xl font-black mb-2 tracking-tight">How can we help you today?</h3>
              <p className="text-teal-100/70 mb-8 font-medium">Search our extensive knowledge base for guides and tutorials.</p>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-teal-900">search</span>
                <input 
                  className="w-full bg-white text-teal-950 border-none rounded-2xl py-4 pl-12 pr-4 text-lg font-bold placeholder:text-slate-300 shadow-xl focus:ring-lime-400" 
                  placeholder="Search for articles, videos, or FAQs..." 
                  type="text"
                />
              </div>
            </div>
            <span className="material-symbols-outlined absolute -right-12 -bottom-12 text-[300px] text-white/5 rotate-12">help_center</span>
          </section>

          {/* Popular Topics */}
          <section className="grid grid-cols-2 gap-6">
            {[
              { title: 'Getting Started', icon: 'rocket_launch', desc: 'New to Teal Metrics? Start here.' },
              { title: 'POS Training', icon: 'payments', desc: 'Master the checkout and tender engine.' },
              { title: 'Inventory Setup', icon: 'inventory_2', desc: 'Importing and managing your stock.' },
              { title: 'Repair Workflow', icon: 'build', desc: 'Optimizing your intake and tech flow.' },
            ].map((topic, i) => (
              <div key={i} className="bg-white p-6 rounded-3xl ghost-border shadow-sm hover:shadow-md transition-all cursor-pointer group">
                <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-all mb-4">
                  <span className="material-symbols-outlined text-2xl">{topic.icon}</span>
                </div>
                <h4 className="font-bold text-slate-900 mb-1">{topic.title}</h4>
                <p className="text-xs text-slate-500 leading-relaxed">{topic.desc}</p>
              </div>
            ))}
          </section>
        </div>

        {/* Sidebar: Contact & Community */}
        <div className="lg:col-span-4 space-y-6">
          <section className="bg-white p-8 rounded-[2.5rem] ghost-border shadow-sm">
            <h3 className="text-xl font-extrabold text-primary tracking-tight mb-6">Direct Support</h3>
            <div className="space-y-4">
              <button className="w-full flex items-center gap-4 p-4 bg-slate-50 hover:bg-lime-400/10 rounded-2xl transition-all group border border-transparent hover:border-lime-400/20">
                <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-secondary shadow-sm group-hover:bg-secondary group-hover:text-white transition-all">
                  <span className="material-symbols-outlined">chat</span>
                </div>
                <div className="text-left">
                  <p className="text-sm font-bold text-slate-900">Live Chat</p>
                  <p className="text-[10px] font-medium text-slate-500">Avg. response time: 2 mins</p>
                </div>
              </button>
              <button className="w-full flex items-center gap-4 p-4 bg-slate-50 hover:bg-lime-400/10 rounded-2xl transition-all group border border-transparent hover:border-lime-400/20">
                <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-secondary shadow-sm group-hover:bg-secondary group-hover:text-white transition-all">
                  <span className="material-symbols-outlined">mail</span>
                </div>
                <div className="text-left">
                  <p className="text-sm font-bold text-slate-900">Email Support</p>
                  <p className="text-[10px] font-medium text-slate-500">support@tealmetrics.com</p>
                </div>
              </button>
              <button className="w-full flex items-center gap-4 p-4 bg-slate-50 hover:bg-lime-400/10 rounded-2xl transition-all group border border-transparent hover:border-lime-400/20">
                <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-secondary shadow-sm group-hover:bg-secondary group-hover:text-white transition-all">
                  <span className="material-symbols-outlined">call</span>
                </div>
                <div className="text-left">
                  <p className="text-sm font-bold text-slate-900">Priority Phone</p>
                  <p className="text-[10px] font-medium text-slate-500">+1 (800) TEAL-HELP</p>
                </div>
              </button>
            </div>
          </section>

          <section className="bg-lime-400 p-8 rounded-[2.5rem] shadow-lg text-teal-950">
            <h3 className="text-xl font-black mb-4 tracking-tight">Community Forum</h3>
            <p className="text-sm font-medium mb-6 leading-relaxed opacity-80">Join 5,000+ other shop owners sharing tips and custom workflows.</p>
            <button className="w-full py-3 bg-teal-950 text-white rounded-xl text-xs font-bold uppercase tracking-widest shadow-xl active:scale-95 transition-all">
              Join the Conversation
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
