import React from 'react';
import { tenants, auditLogs } from './mockData';

const DashboardPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Platform Overview</h2>
        <p className="text-slate-500 font-medium">Real-time platform performance and tenant activity.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">MRR</p>
          <p className="text-3xl font-black text-primary">$124,500.00</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Active Stores</p>
          <p className="text-3xl font-black text-primary">{tenants.length}</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Failed Payments</p>
          <p className="text-3xl font-black text-orange-500">3</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Support Alerts</p>
          <p className="text-3xl font-black text-red-500">1</p>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-6 border-b border-slate-100">
          <h3 className="text-lg font-black text-primary tracking-tight">Recent Tenant Activity</h3>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Actor</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Target</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
            </tr>
          </thead>
          <tbody>
            {auditLogs.slice(0, 3).map((log) => (
              <tr key={log.id} className="border-b border-slate-50 last:border-0">
                <td className="px-8 py-4 font-bold text-slate-900">{log.actor}</td>
                <td className="px-8 py-4 text-sm text-slate-600">{log.action}</td>
                <td className="px-8 py-4 font-bold text-slate-900">{log.target}</td>
                <td className="px-8 py-4 text-sm text-slate-600">{log.date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default DashboardPage;
