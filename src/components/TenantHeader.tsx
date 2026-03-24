import React from 'react';
import { useAccess } from '../context/AccessContext';
import { accountStatusConfig } from '../context/accessConfig';

const TenantHeader: React.FC = () => {
  const { tenant, loading } = useAccess();

  if (loading || !tenant) return <div className="h-20 bg-white border-b border-slate-200" />;

  const status = accountStatusConfig[tenant.status];

  return (
    <div className="bg-white border-b border-slate-200 px-8 py-4 flex justify-between items-center">
      <div>
        <h1 className="text-xl font-black text-primary">{tenant.name}</h1>
        <div className="flex gap-2 mt-1">
          <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-indigo-200">{tenant.plan.toUpperCase()}</span>
          <span className={`px-2 py-0.5 ${status.color} text-[10px] font-black uppercase tracking-widest rounded-lg border`}>{status.label}</span>
        </div>
      </div>
    </div>
  );
};

export default TenantHeader;
