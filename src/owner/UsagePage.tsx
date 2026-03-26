import React, { useState } from 'react';
import { tenantUsage, tenants } from './mockData';

type SortKey = 'tenant' | 'seatsUsed' | 'apiCalls' | 'storageMb' | 'smsUsed' | 'ticketsThisMonth' | 'invoicesThisMonth';

const UsagePage: React.FC = () => {
  const [sortBy, setSortBy] = useState<SortKey>('tenant');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const totalSeats = tenantUsage.reduce((s, t) => s + t.seatsUsed, 0);
  const totalSeatsAllowed = tenantUsage.reduce((s, t) => s + t.seatsAllowed, 0);
  const totalStorage = tenantUsage.reduce((s, t) => s + t.storageMb, 0);
  const totalStorageLimit = tenantUsage.reduce((s, t) => s + t.storageLimitMb, 0);
  const totalApi = tenantUsage.reduce((s, t) => s + t.apiCalls, 0);
  const totalTickets = tenantUsage.reduce((s, t) => s + t.ticketsThisMonth, 0);

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  };

  const sorted = [...tenantUsage].sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (typeof av === 'string' && typeof bv === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
  });

  const pct = (used: number, limit: number) => {
    if (limit === 0) return 0;
    return Math.round((used / limit) * 100);
  };

  const usageColor = (used: number, limit: number) => {
    if (limit === 0) return 'text-slate-400';
    const p = pct(used, limit);
    if (p >= 90) return 'text-red-600';
    if (p >= 70) return 'text-amber-600';
    return 'text-slate-600';
  };

  const usageBar = (used: number, limit: number) => {
    if (limit === 0) return null;
    const p = Math.min(pct(used, limit), 100);
    const bg = p >= 90 ? 'bg-red-500' : p >= 70 ? 'bg-amber-500' : 'bg-lime-500';
    return (
      <div className="w-full bg-slate-100 rounded-full h-1.5 mt-1.5">
        <div className={`${bg} h-1.5 rounded-full transition-all`} style={{ width: `${p}%` }} />
      </div>
    );
  };

  const sortIcon = (key: SortKey) => {
    if (sortBy !== key) return null;
    return <span className="material-symbols-outlined text-[10px] ml-1">{sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}</span>;
  };

  const thClass = "px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:text-slate-600 transition-colors select-none";

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Platform Usage</h2>
        <p className="text-slate-500 font-medium">Monitor tenant resource utilization, limits, and activity.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Seats</p>
          <p className="text-2xl font-black text-primary">{totalSeats} / {totalSeatsAllowed}</p>
          {usageBar(totalSeats, totalSeatsAllowed)}
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Storage</p>
          <p className="text-2xl font-black text-primary">{(totalStorage / 1000).toFixed(1)} / {(totalStorageLimit / 1000).toFixed(0)} GB</p>
          {usageBar(totalStorage, totalStorageLimit)}
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">API Calls (Month)</p>
          <p className="text-2xl font-black text-primary">{totalApi.toLocaleString()}</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Tickets (Month)</p>
          <p className="text-2xl font-black text-primary">{totalTickets.toLocaleString()}</p>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100">
          <h3 className="text-sm font-black text-primary uppercase tracking-widest">Tenant Usage Breakdown</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className={thClass} onClick={() => handleSort('tenant')}>
                  <span className="flex items-center">Tenant {sortIcon('tenant')}</span>
                </th>
                <th className={thClass} onClick={() => handleSort('seatsUsed')}>
                  <span className="flex items-center">Seats {sortIcon('seatsUsed')}</span>
                </th>
                <th className={`${thClass} hidden md:table-cell`}>Locations</th>
                <th className={thClass} onClick={() => handleSort('apiCalls')}>
                  <span className="flex items-center">API Calls {sortIcon('apiCalls')}</span>
                </th>
                <th className={thClass} onClick={() => handleSort('storageMb')}>
                  <span className="flex items-center">Storage {sortIcon('storageMb')}</span>
                </th>
                <th className={thClass} onClick={() => handleSort('smsUsed')}>
                  <span className="flex items-center">SMS {sortIcon('smsUsed')}</span>
                </th>
                <th className={thClass} onClick={() => handleSort('ticketsThisMonth')}>
                  <span className="flex items-center">Tickets {sortIcon('ticketsThisMonth')}</span>
                </th>
                <th className={thClass} onClick={() => handleSort('invoicesThisMonth')}>
                  <span className="flex items-center">Invoices {sortIcon('invoicesThisMonth')}</span>
                </th>
                <th className={`${thClass} hidden md:table-cell`}>Plan</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(usage => {
                const tenant = tenants.find(t => t.id === usage.tenantId);
                return (
                  <tr key={usage.tenantId} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <span className="font-bold text-slate-900 text-sm">{usage.tenant}</span>
                      {tenant?.status === 'suspended' && <span className="ml-2 px-1.5 py-0.5 bg-slate-200 text-slate-500 text-[8px] font-black uppercase rounded">Suspended</span>}
                      {tenant?.status === 'trialing' && <span className="ml-2 px-1.5 py-0.5 bg-indigo-100 text-indigo-600 text-[8px] font-black uppercase rounded">Trial</span>}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-sm font-bold ${usageColor(usage.seatsUsed, usage.seatsAllowed)}`}>
                        {usage.seatsUsed} / {usage.seatsAllowed}
                      </span>
                      {usageBar(usage.seatsUsed, usage.seatsAllowed)}
                    </td>
                    <td className="px-6 py-4 hidden md:table-cell">
                      <span className="text-sm font-bold text-slate-600">
                        {tenant ? `${tenant.locationsUsed} / ${tenant.locationsAllowed}` : '-'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-sm font-bold ${usageColor(usage.apiCalls, usage.apiLimit)}`}>
                        {usage.apiLimit > 0 ? `${usage.apiCalls.toLocaleString()} / ${usage.apiLimit.toLocaleString()}` : <span className="text-slate-300">N/A</span>}
                      </span>
                      {usage.apiLimit > 0 && usageBar(usage.apiCalls, usage.apiLimit)}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-sm font-bold ${usageColor(usage.storageMb, usage.storageLimitMb)}`}>
                        {usage.storageMb >= 1000 ? `${(usage.storageMb / 1000).toFixed(1)} GB` : `${usage.storageMb} MB`}
                      </span>
                      {usageBar(usage.storageMb, usage.storageLimitMb)}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-sm font-bold ${usageColor(usage.smsUsed, usage.smsLimit)}`}>
                        {usage.smsLimit > 0 ? `${usage.smsUsed} / ${usage.smsLimit}` : <span className="text-slate-300">N/A</span>}
                      </span>
                      {usage.smsLimit > 0 && usageBar(usage.smsUsed, usage.smsLimit)}
                    </td>
                    <td className="px-6 py-4 text-sm font-bold text-slate-600">{usage.ticketsThisMonth}</td>
                    <td className="px-6 py-4 text-sm font-bold text-slate-600">{usage.invoicesThisMonth}</td>
                    <td className="px-6 py-4 hidden md:table-cell">
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-600 text-[9px] font-black uppercase tracking-widest rounded-lg border border-slate-200">
                        {tenant?.plan || '-'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default UsagePage;
