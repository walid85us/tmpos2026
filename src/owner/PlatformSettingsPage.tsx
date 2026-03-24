import React from 'react';
import { platformSettings } from './mockData';

const PlatformSettingsPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Platform Settings</h2>
        <p className="text-slate-500 font-medium">Configure global platform settings and defaults.</p>
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-8">
        <div>
          <h3 className="text-lg font-black text-primary tracking-tight mb-4">Branding</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Platform Name</label>
              <input type="text" defaultValue={platformSettings.branding.name} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-lg font-black text-primary tracking-tight mb-4">Maintenance</h3>
          <div className="flex items-center gap-4">
            <input type="checkbox" defaultChecked={platformSettings.maintenance.enabled} className="w-6 h-6 rounded-lg border-slate-300 text-primary focus:ring-primary" />
            <label className="font-bold text-slate-900">Enable Maintenance Mode</label>
          </div>
        </div>
        
        <button className="px-8 py-4 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest">
          Save Settings
        </button>
      </div>
    </div>
  );
};

export default PlatformSettingsPage;
