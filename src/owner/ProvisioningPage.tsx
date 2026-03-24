import React from 'react';

const ProvisioningPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Provisioning</h2>
        <p className="text-slate-500 font-medium">Manage new tenant onboarding and provisioning workflows.</p>
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-lg font-black text-primary tracking-tight mb-6">New Tenant Onboarding</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Tenant Name</label>
            <input type="text" className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="e.g. New Repair Shop" />
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Plan</label>
            <select className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
              <option>Essential</option>
              <option>Growth</option>
              <option>Advanced</option>
            </select>
          </div>
        </div>
        <button className="mt-8 px-8 py-4 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest">
          Provision Tenant
        </button>
      </div>
    </div>
  );
};

export default ProvisioningPage;
