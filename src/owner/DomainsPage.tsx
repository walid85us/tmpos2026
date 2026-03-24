import React from 'react';
import { tenants } from './mockData';

const DomainsPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Domains</h2>
        <p className="text-slate-500 font-medium">Manage tenant subdomains and custom domains.</p>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Subdomain</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Custom Domain</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">SSL</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                <td className="px-8 py-4 font-bold text-slate-900">{tenant.name}</td>
                <td className="px-8 py-4 text-sm font-bold text-slate-600">{tenant.subdomain}</td>
                <td className="px-8 py-4 text-sm font-bold text-slate-600">{tenant.customDomain || '-'}</td>
                <td className="px-8 py-4">
                  <span className="px-3 py-1 bg-lime-400/10 text-lime-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-400/20">
                    {tenant.ssl}
                  </span>
                </td>
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

export default DomainsPage;
