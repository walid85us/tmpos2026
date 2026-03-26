import React, { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { tenantUsage, tenants, plans } from './mockData';

type SortKey = 'tenant' | 'seatsUsed' | 'apiCalls' | 'storageMb' | 'smsUsed' | 'ticketsThisMonth' | 'invoicesThisMonth';

const UsagePage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const focusTenantId = searchParams.get('tenant');
  const [sortBy, setSortBy] = useState<SortKey>('tenant');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [planFilter, setPlanFilter] = useState('all');
  const [showComparison, setShowComparison] = useState(false);

  const totalSeats = tenantUsage.reduce((s, t) => s + t.seatsUsed, 0);
  const totalSeatsAllowed = tenantUsage.reduce((s, t) => s + t.seatsAllowed, 0);
  const totalStorage = tenantUsage.reduce((s, t) => s + t.storageMb, 0);
  const totalStorageLimit = tenantUsage.reduce((s, t) => s + t.storageLimitMb, 0);
  const totalApi = tenantUsage.reduce((s, t) => s + t.apiCalls, 0);
  const totalTickets = tenantUsage.reduce((s, t) => s + t.ticketsThisMonth, 0);

  const alertCount = tenantUsage.filter(u => {
    const seatPct = u.seatsAllowed > 0 ? (u.seatsUsed / u.seatsAllowed) * 100 : 0;
    const storagePct = u.storageLimitMb > 0 ? (u.storageMb / u.storageLimitMb) * 100 : 0;
    const smsPct = u.smsLimit > 0 ? (u.smsUsed / u.smsLimit) * 100 : 0;
    return seatPct >= 90 || storagePct >= 90 || smsPct >= 90;
  }).length;

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  };

  const filtered = tenantUsage.filter(u => {
    if (planFilter !== 'all') {
      const tenant = tenants.find(t => t.id === u.tenantId);
      if (tenant?.plan !== planFilter) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
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

  const alertIcon = (used: number, limit: number) => {
    if (limit === 0) return null;
    const p = pct(used, limit);
    if (p >= 90) return <span className="material-symbols-outlined text-red-500 text-xs ml-1" title="Critical: 90%+ usage">error</span>;
    if (p >= 70) return <span className="material-symbols-outlined text-amber-500 text-xs ml-1" title="Warning: 70%+ usage">warning</span>;
    return null;
  };

  const sortIcon = (key: SortKey) => {
    if (sortBy !== key) return null;
    return <span className="material-symbols-outlined text-[10px] ml-1">{sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}</span>;
  };

  const exportCSV = () => {
    const headers = ['Tenant', 'Plan', 'Seats Used', 'Seats Allowed', 'API Calls', 'API Limit', 'Storage (MB)', 'Storage Limit (MB)', 'SMS Used', 'SMS Limit', 'Tickets', 'Invoices'];
    const rows = sorted.map(u => {
      const tenant = tenants.find(t => t.id === u.tenantId);
      return [u.tenant, tenant?.plan || '', u.seatsUsed, u.seatsAllowed, u.apiCalls, u.apiLimit, u.storageMb, u.storageLimitMb, u.smsUsed, u.smsLimit, u.ticketsThisMonth, u.invoicesThisMonth].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `usage-report-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const uniquePlans = [...new Set(tenants.map(t => t.plan))];

  const planComparison = plans.map(plan => {
    const planTenants = tenantUsage.filter(u => {
      const t = tenants.find(x => x.id === u.tenantId);
      return t?.plan === plan.id;
    });
    const count = planTenants.length;
    if (count === 0) return { plan: plan.name, count: 0, avgSeats: 0, avgStorage: 0, avgApi: 0, totalRevenue: 0 };
    return {
      plan: plan.name,
      count,
      avgSeats: Math.round(planTenants.reduce((s, t) => s + t.seatsUsed, 0) / count),
      avgStorage: Math.round(planTenants.reduce((s, t) => s + t.storageMb, 0) / count),
      avgApi: Math.round(planTenants.reduce((s, t) => s + t.apiCalls, 0) / count),
      totalRevenue: tenants.filter(t => t.plan === plan.id).reduce((s, t) => s + t.mrr, 0),
    };
  });

  const thClass = "px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:text-slate-600 transition-colors select-none";

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Platform Usage</h2>
          <p className="text-slate-500 font-medium">
            Monitor tenant resource utilization, limits, and activity.
            {focusTenantId && (() => { const t = tenants.find(x => x.id === focusTenantId); return t ? <span className="ml-2 text-blue-600 font-bold">Viewing: {t.name}</span> : null; })()}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowComparison(!showComparison)} className={`px-4 py-2.5 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center gap-1.5 ${showComparison ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}>
            <span className="material-symbols-outlined text-sm">compare</span>
            Compare Plans
          </button>
          <button onClick={exportCSV} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">download</span>
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
        <div className={`bg-white/80 backdrop-blur-xl p-5 rounded-[2.5rem] border shadow-sm ${alertCount > 0 ? 'border-red-200 bg-red-50/50' : 'border-slate-200'}`}>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Threshold Alerts</p>
          <p className={`text-2xl font-black ${alertCount > 0 ? 'text-red-500' : 'text-lime-600'}`}>{alertCount}</p>
          <p className="text-[10px] font-bold text-slate-400 mt-1">{alertCount > 0 ? 'Tenants at 90%+ capacity' : 'All within limits'}</p>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-4 rounded-2xl border border-slate-200 flex flex-wrap items-center gap-3">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Filters:</p>
        <select
          value={planFilter}
          onChange={e => setPlanFilter(e.target.value)}
          className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
        >
          <option value="all">All Plans</option>
          {uniquePlans.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        {planFilter !== 'all' && (
          <button onClick={() => setPlanFilter('all')} className="text-[10px] font-black text-red-500 uppercase tracking-widest hover:text-red-700">Clear</button>
        )}
      </div>

      {showComparison && (
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-8 py-5 border-b border-slate-100">
            <h3 className="text-sm font-black text-primary uppercase tracking-widest">Plan Comparison</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Plan</th>
                  <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenants</th>
                  <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Avg Seats</th>
                  <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Avg Storage</th>
                  <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Avg API Calls</th>
                  <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Revenue</th>
                </tr>
              </thead>
              <tbody>
                {planComparison.filter(p => p.count > 0).map(row => (
                  <tr key={row.plan} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4 font-bold text-primary text-sm">{row.plan}</td>
                    <td className="px-6 py-4 font-black text-slate-900">{row.count}</td>
                    <td className="px-6 py-4 font-bold text-slate-600">{row.avgSeats}</td>
                    <td className="px-6 py-4 font-bold text-slate-600">{row.avgStorage >= 1000 ? `${(row.avgStorage / 1000).toFixed(1)} GB` : `${row.avgStorage} MB`}</td>
                    <td className="px-6 py-4 font-bold text-slate-600">{row.avgApi.toLocaleString()}</td>
                    <td className="px-6 py-4 font-black text-primary">${row.totalRevenue}/mo</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center">
          <h3 className="text-sm font-black text-primary uppercase tracking-widest">Tenant Usage Breakdown</h3>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{sorted.length} tenant{sorted.length !== 1 ? 's' : ''}</span>
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
                  <tr key={usage.tenantId} className={`border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors ${focusTenantId === usage.tenantId ? 'bg-blue-50/80 ring-2 ring-blue-200' : ''}`}>
                    <td className="px-6 py-4">
                      <button onClick={() => navigate(`/owner/tenants/${usage.tenantId}`)} className="font-bold text-slate-900 text-sm hover:text-primary transition-colors text-left">
                        {usage.tenant}
                      </button>
                      {tenant?.status === 'suspended' && <span className="ml-2 px-1.5 py-0.5 bg-slate-200 text-slate-500 text-[8px] font-black uppercase rounded">Suspended</span>}
                      {tenant?.status === 'trialing' && <span className="ml-2 px-1.5 py-0.5 bg-indigo-100 text-indigo-600 text-[8px] font-black uppercase rounded">Trial</span>}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-sm font-bold ${usageColor(usage.seatsUsed, usage.seatsAllowed)}`}>
                        {usage.seatsUsed} / {usage.seatsAllowed}
                      </span>
                      {alertIcon(usage.seatsUsed, usage.seatsAllowed)}
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
                      {alertIcon(usage.apiCalls, usage.apiLimit)}
                      {usage.apiLimit > 0 && usageBar(usage.apiCalls, usage.apiLimit)}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-sm font-bold ${usageColor(usage.storageMb, usage.storageLimitMb)}`}>
                        {usage.storageMb >= 1000 ? `${(usage.storageMb / 1000).toFixed(1)} GB` : `${usage.storageMb} MB`}
                      </span>
                      {alertIcon(usage.storageMb, usage.storageLimitMb)}
                      {usageBar(usage.storageMb, usage.storageLimitMb)}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-sm font-bold ${usageColor(usage.smsUsed, usage.smsLimit)}`}>
                        {usage.smsLimit > 0 ? `${usage.smsUsed} / ${usage.smsLimit}` : <span className="text-slate-300">N/A</span>}
                      </span>
                      {alertIcon(usage.smsUsed, usage.smsLimit)}
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
