import React from 'react';
import { tenants } from './mockData';

const TenantsPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Tenants</h2>
          <p className="text-slate-500 font-medium">Manage and provision platform tenants.</p>
        </div>
        <button className="px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all uppercase tracking-widest">
          Provision Tenant
        </button>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Plan</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Domain</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                <td className="px-8 py-4 font-bold text-slate-900">{tenant.name}</td>
                <td className="px-8 py-4 text-sm font-bold text-slate-600 capitalize">{tenant.plan}</td>
                <td className="px-8 py-4">
                  <span className="px-3 py-1 bg-lime-400/10 text-lime-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-400/20">
                    {tenant.status}
                  </span>
                </td>
                <td className="px-8 py-4 text-sm font-bold text-slate-600">{tenant.subdomain}.repairplatform.com</td>
                <td className="px-8 py-4 text-right">
                  <button className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">
                    Manage
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TenantsPage;
