import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { tenants, plans, tenantUsage, billingTransactions } from './mockData';

type StatusFilter = 'all' | 'active' | 'trialing' | 'overdue' | 'suspended';
type SortKey = 'name' | 'plan' | 'status' | 'mrr' | 'renewal';

const TenantsPage: React.FC = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(key); setSortDir('asc'); }
  };

  const computeHealth = (tenantId: string, status: string, seatsUsed: number, seatsAllowed: number) => {
    let score = 100;
    if (status === 'overdue') score -= 40;
    if (status === 'suspended') score -= 60;
    const usage = tenantUsage.find(u => u.tenantId === tenantId);
    if (usage) {
      if (usage.seatsAllowed > 0 && usage.seatsUsed / usage.seatsAllowed >= 0.9) score -= 10;
      if (usage.apiLimit > 0 && usage.apiCalls / usage.apiLimit >= 0.9) score -= 10;
      if (usage.smsLimit > 0 && usage.smsUsed / usage.smsLimit >= 0.9) score -= 10;
    }
    if (seatsUsed >= seatsAllowed) score -= 5;
    const failedTx = billingTransactions.filter(tx => tx.tenantId === tenantId && tx.status === 'failed');
    if (failedTx.length > 0) score -= 15;
    return Math.max(0, Math.min(100, score));
  };

  const filtered = useMemo(() => {
    let items = [...tenants];
    if (search) items = items.filter(t => t.name.toLowerCase().includes(search.toLowerCase()) || t.owner.email.toLowerCase().includes(search.toLowerCase()) || t.subdomain.toLowerCase().includes(search.toLowerCase()));
    if (statusFilter !== 'all') items = items.filter(t => t.status === statusFilter);
    if (planFilter !== 'all') items = items.filter(t => t.plan === planFilter);
    items.sort((a, b) => {
      let av: string | number = a[sortBy];
      let bv: string | number = b[sortBy];
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return items;
  }, [search, statusFilter, planFilter, sortBy, sortDir]);

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      trialing: 'bg-indigo-400/10 text-indigo-700 border-indigo-200',
      overdue: 'bg-red-400/10 text-red-700 border-red-400/20',
      suspended: 'bg-slate-400/10 text-slate-500 border-slate-200',
    };
    return <span className={`px-2.5 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg border ${styles[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>{status}</span>;
  };

  const sortIcon = (key: SortKey) => {
    if (sortBy !== key) return 'unfold_more';
    return sortDir === 'asc' ? 'expand_less' : 'expand_more';
  };

  const healthDot = (score: number) => {
    const color = score >= 80 ? 'bg-lime-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500';
    return (
      <div className="flex items-center gap-1.5">
        <div className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-[10px] font-black text-slate-500">{score}</span>
      </div>
    );
  };

  const activeCt = tenants.filter(t => t.status === 'active').length;
  const trialCt = tenants.filter(t => t.status === 'trialing').length;
  const overdueCt = tenants.filter(t => t.status === 'overdue').length;
  const suspendedCt = tenants.filter(t => t.status === 'suspended').length;
  const totalMrr = tenants.reduce((s, t) => s + t.mrr, 0);

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Tenants</h2>
          <p className="text-slate-500 font-medium">Manage and provision platform tenants.</p>
        </div>
        <button onClick={() => navigate('/owner/provisioning')} className="px-5 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 active:scale-95 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm">add</span>
          Provision Tenant
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <button onClick={() => setStatusFilter(statusFilter === 'active' ? 'all' : 'active')} className={`p-4 rounded-2xl border text-left transition-all ${statusFilter === 'active' ? 'bg-lime-50 border-lime-200' : 'bg-white/80 backdrop-blur-xl border-slate-200 hover:border-lime-200'}`}>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active</p>
          <p className="text-2xl font-black text-lime-600">{activeCt}</p>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'trialing' ? 'all' : 'trialing')} className={`p-4 rounded-2xl border text-left transition-all ${statusFilter === 'trialing' ? 'bg-indigo-50 border-indigo-200' : 'bg-white/80 backdrop-blur-xl border-slate-200 hover:border-indigo-200'}`}>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Trialing</p>
          <p className="text-2xl font-black text-indigo-600">{trialCt}</p>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'overdue' ? 'all' : 'overdue')} className={`p-4 rounded-2xl border text-left transition-all ${statusFilter === 'overdue' ? 'bg-red-50 border-red-200' : 'bg-white/80 backdrop-blur-xl border-slate-200 hover:border-red-200'}`}>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Overdue</p>
          <p className="text-2xl font-black text-red-500">{overdueCt}</p>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'suspended' ? 'all' : 'suspended')} className={`p-4 rounded-2xl border text-left transition-all ${statusFilter === 'suspended' ? 'bg-slate-100 border-slate-300' : 'bg-white/80 backdrop-blur-xl border-slate-200 hover:border-slate-300'}`}>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Suspended</p>
          <p className="text-2xl font-black text-slate-500">{suspendedCt}</p>
        </button>
        <div className="p-4 rounded-2xl border bg-primary/5 border-primary/10 text-left">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total MRR</p>
          <p className="text-2xl font-black text-primary">${totalMrr}</p>
          <p className="text-[10px] text-slate-400 font-bold">{tenants.length} tenants</p>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <div className="relative flex-1 min-w-[200px]">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
          <input value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-10 pr-4 py-3 bg-white/80 backdrop-blur-xl border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-sm" placeholder="Search tenants..." />
        </div>
        <select value={planFilter} onChange={e => setPlanFilter(e.target.value)} className="px-4 py-3 bg-white/80 backdrop-blur-xl border border-slate-200 rounded-xl font-bold text-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
          <option value="all">All Plans</option>
          {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {(search || statusFilter !== 'all' || planFilter !== 'all') && (
          <button onClick={() => { setSearch(''); setStatusFilter('all'); setPlanFilter('all'); }} className="px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest hover:text-primary transition-colors">Clear Filters</button>
        )}
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4"><button onClick={() => toggleSort('name')} className="flex items-center gap-1 text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-primary transition-colors">Tenant <span className="material-symbols-outlined text-xs">{sortIcon('name')}</span></button></th>
              <th className="px-6 py-4"><button onClick={() => toggleSort('plan')} className="flex items-center gap-1 text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-primary transition-colors">Plan <span className="material-symbols-outlined text-xs">{sortIcon('plan')}</span></button></th>
              <th className="px-6 py-4"><button onClick={() => toggleSort('status')} className="flex items-center gap-1 text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-primary transition-colors">Status <span className="material-symbols-outlined text-xs">{sortIcon('status')}</span></button></th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Health</th>
              <th className="px-6 py-4"><button onClick={() => toggleSort('mrr')} className="flex items-center gap-1 text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-primary transition-colors">MRR <span className="material-symbols-outlined text-xs">{sortIcon('mrr')}</span></button></th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Seats</th>
              <th className="px-6 py-4"><button onClick={() => toggleSort('renewal')} className="flex items-center gap-1 text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-primary transition-colors">Renewal <span className="material-symbols-outlined text-xs">{sortIcon('renewal')}</span></button></th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(tenant => {
              const health = computeHealth(tenant.id, tenant.status, tenant.seatsUsed, tenant.seatsAllowed);
              return (
                <tr key={tenant.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors cursor-pointer focus-within:bg-slate-50/80" tabIndex={0} role="link" onClick={() => navigate(`/owner/tenants/${tenant.id}`)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/owner/tenants/${tenant.id}`); } }}>
                  <td className="px-6 py-4">
                    <p className="font-bold text-slate-900">{tenant.name}</p>
                    <p className="text-[10px] text-slate-400">{tenant.owner.email}</p>
                  </td>
                  <td className="px-6 py-4 text-sm font-bold text-slate-600 capitalize">{tenant.plan}</td>
                  <td className="px-6 py-4">{statusBadge(tenant.status)}</td>
                  <td className="px-6 py-4">{healthDot(health)}</td>
                  <td className="px-6 py-4 font-black text-primary">${tenant.mrr}</td>
                  <td className="px-6 py-4">
                    <span className={`text-sm font-bold ${tenant.seatsUsed >= tenant.seatsAllowed ? 'text-red-500' : 'text-slate-600'}`}>{tenant.seatsUsed}/{tenant.seatsAllowed}</span>
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-500">{tenant.renewal}</td>
                  <td className="px-6 py-4 text-right" onClick={e => e.stopPropagation()}>
                    <button onClick={() => navigate(`/owner/tenants/${tenant.id}`)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">
                      Manage
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-6 py-12 text-center text-slate-400 font-bold">No tenants match your filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">{filtered.length} of {tenants.length} tenants</p>
    </div>
  );
};

export default TenantsPage;
