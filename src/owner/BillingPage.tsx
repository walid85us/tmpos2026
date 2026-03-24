import React from 'react';

const BillingPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Billing Overview</h2>
        <p className="text-slate-500 font-medium">Manage platform billing, invoices, and payment status.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Revenue</p>
          <p className="text-3xl font-black text-primary">$124,500.00</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Failed Payments</p>
          <p className="text-3xl font-black text-orange-500">3</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Pending Refunds</p>
          <p className="text-3xl font-black text-slate-900">$1,200.00</p>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Amount</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-50">
              <td className="px-8 py-6 font-bold text-slate-900">Tech Repair Pro</td>
              <td className="px-8 py-6 text-sm font-bold text-slate-600">2026-03-20</td>
              <td className="px-8 py-6 font-black text-primary">$99.00</td>
              <td className="px-8 py-6">
                <span className="px-3 py-1 bg-lime-400/10 text-lime-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-400/20">Paid</span>
              </td>
            </tr>
            <tr className="border-b border-slate-50">
              <td className="px-8 py-6 font-bold text-slate-900">Gadget Fixers</td>
              <td className="px-8 py-6 text-sm font-bold text-slate-600">2026-03-19</td>
              <td className="px-8 py-6 font-black text-primary">$49.00</td>
              <td className="px-8 py-6">
                <span className="px-3 py-1 bg-red-400/10 text-red-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-red-400/20">Failed</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default BillingPage;
