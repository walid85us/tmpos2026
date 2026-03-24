import React from 'react';

const UsagePage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Platform Usage</h2>
        <p className="text-slate-500 font-medium">Monitor tenant resource utilization and limits.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Active Tenants</p>
          <p className="text-3xl font-black text-primary">2</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Seats Used</p>
          <p className="text-3xl font-black text-primary">13 / 63</p>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Seats Used</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Locations</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-50">
              <td className="px-8 py-6 font-bold text-slate-900">Tech Repair Pro</td>
              <td className="px-8 py-6 text-sm font-bold text-slate-600">10 / 10</td>
              <td className="px-8 py-6 text-sm font-bold text-slate-600">3 / 3</td>
            </tr>
            <tr className="border-b border-slate-50">
              <td className="px-8 py-6 font-bold text-slate-900">Gadget Fixers</td>
              <td className="px-8 py-6 text-sm font-bold text-slate-600">3 / 3</td>
              <td className="px-8 py-6 text-sm font-bold text-slate-600">1 / 1</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default UsagePage;
