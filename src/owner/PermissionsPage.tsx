import React from 'react';
import { permissions } from './accessMockData';

const PermissionsPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Permissions</h2>
        <p className="text-slate-500 font-medium">Manage granular permission sets.</p>
      </div>

      <div className="space-y-6">
        {permissions.map((group) => (
          <div key={group.group} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h3 className="text-lg font-black text-primary tracking-tight mb-4">{group.group}</h3>
            <div className="flex flex-wrap gap-2">
              {group.actions.map(action => (
                <span key={action} className="px-3 py-1 bg-slate-100 text-slate-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-slate-200">
                  {action}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PermissionsPage;
