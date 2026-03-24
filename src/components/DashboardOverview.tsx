import React from 'react';
import { Link } from 'react-router-dom';
import { useAccess } from '../context/AccessContext';
import ApprovalQueue from './ApprovalQueue';

export default function DashboardOverview({ onNewRepair }: { onNewRepair: () => void }) {
  const { session } = useAccess();

  return (
    <div className="space-y-8">
      {session?.role === 'store_owner' && <ApprovalQueue />}
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Operational Overview</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Welcome back, Architect</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-slate-100 px-4 py-2 rounded-xl ghost-border">
            <span className="material-symbols-outlined text-sm">calendar_today</span>
            <span className="text-sm font-semibold">Today, Oct 24</span>
          </div>
          <button 
            onClick={onNewRepair}
            className="bg-secondary text-white px-6 py-2 rounded-xl font-bold text-sm shadow-lg flex items-center gap-2 active:scale-95 transition-transform"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Quick Intake
          </button>
        </div>
      </header>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {[
          { label: 'New Sale', icon: 'shopping_cart', color: 'bg-primary', path: '/pos' },
          { label: 'Add Stock', icon: 'inventory_2', color: 'bg-teal-800', path: '/inventory/new' },
          { label: 'New Customer', icon: 'person_add', color: 'bg-secondary', path: '/customers/new' },
          { label: 'Print Label', icon: 'print', color: 'bg-slate-800', path: '/settings/hardware-print' },
          { label: 'Hold Sale', icon: 'pause_circle', color: 'bg-slate-600', path: '/pos' },
          { label: 'Scan QR', icon: 'qr_code_scanner', color: 'bg-lime-600', path: '/sales/scan' },
        ].map((action, i) => (
          <Link key={i} to={action.path} className="flex flex-col items-center justify-center p-4 bg-white rounded-2xl ghost-border shadow-sm hover:shadow-md transition-all group active:scale-95">
            <div className={`w-10 h-10 ${action.color} text-white rounded-xl flex items-center justify-center mb-2 group-hover:scale-110 transition-transform`}>
              <span className="material-symbols-outlined text-xl">{action.icon}</span>
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">{action.label}</span>
          </Link>
        ))}
      </div>
...

      {/* Bento Grid Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="signature-gradient p-8 rounded-[2rem] shadow-xl text-white relative overflow-hidden flex flex-col justify-between h-52">
          <div className="z-10">
            <span className="text-teal-100/60 uppercase text-[10px] font-bold tracking-widest">Today's Revenue</span>
            <div className="text-5xl font-black mt-2 tracking-tighter">$4,285.50</div>
          </div>
          <div className="z-10 flex items-center gap-2">
            <span className="bg-lime-400 text-teal-950 px-2 py-0.5 rounded text-[10px] font-bold">+12.5%</span>
            <span className="text-teal-100/50 text-xs">vs yesterday</span>
          </div>
          <span className="material-symbols-outlined absolute -right-4 -bottom-4 text-9xl opacity-10">payments</span>
        </div>

        <div className="bg-white p-8 rounded-[2rem] shadow-sm border border-outline-variant/10 flex flex-col justify-between h-52">
          <div>
            <span className="text-slate-500 uppercase text-[10px] font-bold tracking-widest">Active Repairs</span>
            <div className="text-5xl font-black text-primary mt-2 tracking-tighter">18</div>
          </div>
          <div className="flex -space-x-2">
            {[1,2,3].map(i => (
              <div key={i} className="w-10 h-10 rounded-full border-4 border-white bg-slate-200 overflow-hidden">
                <img src={`https://i.pravatar.cc/100?img=${i+10}`} alt="avatar" />
              </div>
            ))}
            <div className="w-10 h-10 rounded-full border-4 border-white bg-primary text-[10px] flex items-center justify-center text-white font-bold">+15</div>
          </div>
        </div>

        <div className="bg-red-50 p-8 rounded-[2rem] border border-red-100 flex flex-col justify-between h-52">
          <div>
            <span className="text-red-800 uppercase text-[10px] font-bold tracking-widest">Critical Stock</span>
            <div className="text-5xl font-black text-red-700 mt-2 tracking-tighter">04</div>
          </div>
          <div className="flex items-center gap-2 text-red-700">
            <span className="material-symbols-outlined text-sm">warning</span>
            <span className="text-xs font-bold uppercase tracking-wider">Immediate reorder required</span>
          </div>
        </div>
      </div>
    </div>
  );
}
