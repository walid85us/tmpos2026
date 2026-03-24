import React from 'react';

const SecuritySettingsPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Security</h2>
        <p className="text-slate-500 font-medium">Manage store-level security and access.</p>
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
        <h3 className="text-lg font-black text-primary tracking-tight">Access Control</h3>
        <div className="flex items-center gap-4">
          <input type="checkbox" className="w-6 h-6 rounded-lg border-slate-300 text-primary focus:ring-primary" />
          <label className="font-bold text-slate-900">Require 2FA for all staff</label>
        </div>
        <button className="px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all uppercase tracking-widest">
          Save Settings
        </button>
      </div>
    </div>
  );
};

export default SecuritySettingsPage;
