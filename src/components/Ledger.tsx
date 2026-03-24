import React from 'react';

export default function Ledger() {
  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Financial Records</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">General Ledger</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-slate-100 px-4 py-2 rounded-xl ghost-border">
            <span className="material-symbols-outlined text-sm">filter_alt</span>
            <span className="text-sm font-semibold">Filter Period</span>
          </div>
          <button className="bg-primary text-white px-6 py-2 rounded-xl font-bold text-sm shadow-lg flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">add</span>
            Add Entry
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-3xl ghost-border shadow-sm border-l-4 border-lime-500">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Income</p>
          <p className="text-3xl font-black text-primary mt-1">$52,480.00</p>
          <p className="text-[10px] text-lime-600 font-bold mt-2">↑ 12% from last month</p>
        </div>
        <div className="bg-white p-6 rounded-3xl ghost-border shadow-sm border-l-4 border-red-500">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Expenses</p>
          <p className="text-3xl font-black text-primary mt-1">$14,210.00</p>
          <p className="text-[10px] text-red-500 font-bold mt-2">↑ 5% from last month</p>
        </div>
        <div className="signature-gradient p-6 rounded-3xl shadow-xl text-white">
          <p className="text-[10px] font-bold text-teal-100/60 uppercase tracking-widest">Net Cash Flow</p>
          <p className="text-3xl font-black mt-1">$38,270.00</p>
          <p className="text-[10px] text-lime-400 font-bold mt-2">Healthy Margin</p>
        </div>
      </div>

      <div className="bg-white rounded-[2rem] ghost-border shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 flex justify-between items-center">
          <h3 className="text-sm font-black text-primary uppercase tracking-widest">Transaction History</h3>
          <div className="flex gap-2">
            <button className="px-3 py-1 text-[10px] font-bold rounded-md bg-slate-100 text-slate-600">All</button>
            <button className="px-3 py-1 text-[10px] font-bold rounded-md hover:bg-slate-50 text-slate-400">Income</button>
            <button className="px-3 py-1 text-[10px] font-bold rounded-md hover:bg-slate-50 text-slate-400">Expense</button>
          </div>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Description</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Reference</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {[
              { date: 'Oct 24, 2023', desc: 'Repair Service - iPhone 14', cat: 'Service Income', ref: '#RE-2041', amount: '+ $249.00', type: 'income' },
              { date: 'Oct 23, 2023', desc: 'Parts Purchase - Screens', cat: 'Inventory Expense', ref: '#PO-9921', amount: '- $1,200.00', type: 'expense' },
              { date: 'Oct 23, 2023', desc: 'Shop Rent - October', cat: 'Fixed Expense', ref: 'RENT-OCT', amount: '- $2,500.00', type: 'expense' },
              { date: 'Oct 22, 2023', desc: 'Accessory Sale - Case Bundle', cat: 'Product Income', ref: '#INV-5521', amount: '+ $85.00', type: 'income' },
              { date: 'Oct 21, 2023', desc: 'Electricity Bill', cat: 'Utility Expense', ref: 'UTIL-442', amount: '- $145.00', type: 'expense' },
            ].map((item, i) => (
              <tr key={i} className="hover:bg-slate-50 transition-colors group">
                <td className="p-6 text-sm font-medium text-slate-600">{item.date}</td>
                <td className="p-6">
                  <p className="font-bold text-slate-900">{item.desc}</p>
                </td>
                <td className="p-6">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest bg-slate-100 px-2 py-1 rounded-md">{item.cat}</span>
                </td>
                <td className="p-6 text-sm font-bold text-primary">{item.ref}</td>
                <td className={`p-6 text-right font-black ${item.type === 'income' ? 'text-lime-600' : 'text-red-500'}`}>
                  {item.amount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
