import React from 'react';
import { roles } from './accessMockData';

const RoleTemplatesPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Role Templates</h2>
        <p className="text-slate-500 font-medium">Pre-defined role configurations.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {roles.map(role => (
          <div key={role.id} className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h3 className="text-lg font-black text-primary tracking-tight mb-4">{role.name}</h3>
            <p className="text-slate-500 font-medium text-sm mb-6">Template for {role.level} access.</p>
            <button className="px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all uppercase tracking-widest">
              Use Template
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default RoleTemplatesPage;
