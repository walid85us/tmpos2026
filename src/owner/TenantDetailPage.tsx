import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { tenants, tenantUsage } from './mockData';
import { tenantUsers } from './accessMockData';

const TenantDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const tenant = tenants.find(t => t.id === id);
  const [activeTab, setActiveTab] = useState('Overview');

  if (!tenant) return <div>Tenant not found</div>;

  const tabs = ['Overview', 'Owner & Users', 'Subscription', 'Features', 'Billing', 'Domains', 'Usage', 'Activity / Audit', 'Support Notes'];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">{tenant.name}</h2>
        <p className="text-slate-500 font-medium">Tenant ID: {tenant.id}</p>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2">
        {tabs.map(tab => (
          <button 
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-primary text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <h3 className="text-lg font-black text-primary tracking-tight mb-6">{activeTab}</h3>
        
        {activeTab === 'Owner & Users' && (
          <div className="space-y-6">
            <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
              <h4 className="font-black text-slate-900 mb-2">Store Owner</h4>
              <p className="text-sm font-bold text-slate-600">{tenant.owner.name} ({tenant.owner.email})</p>
            </div>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">User</th>
                  <th className="py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Role</th>
                  <th className="py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                  <th className="py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenantUsers.map(user => (
                  <tr key={user.id} className="border-b border-slate-50 last:border-0">
                    <td className="py-4 font-bold text-slate-900">{user.name}</td>
                    <td className="py-4 text-sm font-bold text-slate-600 capitalize">{user.role.replace('_', ' ')}</td>
                    <td className="py-4">
                      <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${user.status === 'active' ? 'bg-lime-400/10 text-lime-700 border-lime-400/20' : 'bg-amber-400/10 text-amber-700 border-amber-400/20'}`}>
                        {user.status}
                      </span>
                    </td>
                    <td className="py-4 text-right">
                      <button onClick={() => setActiveTab('Overview')} className="text-[10px] font-black text-primary uppercase tracking-widest hover:text-primary/70 transition-colors">Manage</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'Features' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {['Sales', 'Repairs', 'Inventory', 'Customers', 'Marketing', 'API Access'].map(feature => (
              <div key={feature} className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex justify-between items-center">
                <span className="font-bold text-slate-900">{feature}</span>
                <span className="px-3 py-1 bg-lime-400/10 text-lime-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-400/20">Enabled</span>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'Subscription' && (
          <div className="space-y-4">
            <p><span className="font-bold text-slate-900">Current Plan:</span> {tenant.plan.toUpperCase()}</p>
            <p><span className="font-bold text-slate-900">Renewal Date:</span> {tenant.renewal}</p>
            <button onClick={() => setActiveTab('Billing')} className="px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 active:scale-95 transition-all uppercase tracking-widest">
              Manage Subscription
            </button>
          </div>
        )}
        
        {activeTab === 'Overview' && (
          <div className="space-y-4">
            <p><span className="font-bold text-slate-900">Plan:</span> {tenant.plan}</p>
            <p><span className="font-bold text-slate-900">Status:</span> {tenant.status}</p>
            <p><span className="font-bold text-slate-900">Renewal:</span> {tenant.renewal}</p>
          </div>
        )}
        {activeTab === 'Usage' && (() => {
          const usage = tenantUsage.find(u => u.tenantId === tenant.id);
          if (!usage) return <p className="text-slate-400">No usage data available for this tenant.</p>;
          const usageBar = (used: number, limit: number) => {
            if (limit === 0) return <span className="text-[10px] text-slate-400">N/A</span>;
            const pct = Math.round((used / limit) * 100);
            const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-lime-500';
            return (
              <div className="flex items-center gap-2">
                <div className="w-24 h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                </div>
                <span className="text-[10px] font-bold text-slate-500">{pct}%</span>
              </div>
            );
          };
          return (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Seats</p>
                  <p className="font-black text-primary">{usage.seatsUsed}/{usage.seatsAllowed}</p>
                  {usageBar(usage.seatsUsed, usage.seatsAllowed)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">API Calls</p>
                  <p className="font-black text-primary">{usage.apiCalls.toLocaleString()}/{usage.apiLimit.toLocaleString()}</p>
                  {usageBar(usage.apiCalls, usage.apiLimit)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Storage</p>
                  <p className="font-black text-primary">{usage.storageMb}MB/{usage.storageLimitMb}MB</p>
                  {usageBar(usage.storageMb, usage.storageLimitMb)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">SMS</p>
                  <p className="font-black text-primary">{usage.smsUsed}/{usage.smsLimit}</p>
                  {usageBar(usage.smsUsed, usage.smsLimit)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Tickets This Month</p>
                  <p className="font-black text-primary">{usage.ticketsThisMonth}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Invoices This Month</p>
                  <p className="font-black text-primary">{usage.invoicesThisMonth}</p>
                </div>
              </div>
              <Link to={`/owner/usage?tenant=${tenant.id}`} className="inline-flex items-center gap-2 px-5 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 active:scale-95 transition-all uppercase tracking-widest">
                <span className="material-symbols-outlined text-sm">open_in_new</span>
                View Platform Usage
              </Link>
            </div>
          );
        })()}

        {activeTab !== 'Overview' && activeTab !== 'Owner & Users' && activeTab !== 'Features' && activeTab !== 'Subscription' && activeTab !== 'Usage' && <p>Content for {activeTab} tab goes here.</p>}
      </div>
    </div>
  );
};

export default TenantDetailPage;
