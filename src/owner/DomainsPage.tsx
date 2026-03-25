import React, { useState } from 'react';
import { tenants } from './mockData';
import { motion, AnimatePresence } from 'motion/react';

const DomainsPage: React.FC = () => {
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);

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
                  <button
                    onClick={() => setSelectedTenantId(tenant.id)}
                    className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95"
                  >
                    Manage
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {selectedTenantId && (() => {
          const tenant = tenants.find(t => t.id === selectedTenantId);
          if (!tenant) return null;
          return (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setSelectedTenantId(null)}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                onClick={e => e.stopPropagation()}
                className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden"
              >
                <div className="p-8 border-b border-slate-100">
                  <h3 className="text-xl font-black text-primary tracking-tight">{tenant.name}</h3>
                  <p className="text-sm text-slate-500 mt-1">Domain Configuration</p>
                </div>
                <div className="p-8 space-y-4">
                  <div className="flex justify-between items-center p-4 bg-slate-50 rounded-2xl">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subdomain</span>
                    <span className="text-sm font-bold text-slate-700">{tenant.subdomain}</span>
                  </div>
                  <div className="flex justify-between items-center p-4 bg-slate-50 rounded-2xl">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Custom Domain</span>
                    <span className="text-sm font-bold text-slate-700">{tenant.customDomain || 'Not configured'}</span>
                  </div>
                  <div className="flex justify-between items-center p-4 bg-slate-50 rounded-2xl">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">SSL Status</span>
                    <span className="px-3 py-1 bg-lime-400/10 text-lime-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-400/20">{tenant.ssl}</span>
                  </div>
                </div>
                <div className="p-8 border-t border-slate-100 bg-slate-50/50">
                  <button onClick={() => setSelectedTenantId(null)} className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
                    Done
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
};

export default DomainsPage;
