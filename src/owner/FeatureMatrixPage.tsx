import React from 'react';
import { featureMatrix } from './mockData';

const FeatureMatrixPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Feature Matrix</h2>
        <p className="text-slate-500 font-medium">Manage feature availability across subscription plans.</p>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Feature</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Essential</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Growth</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Advanced</th>
            </tr>
          </thead>
          <tbody>
            {featureMatrix.map((feature) => (
              <tr key={feature.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-6 font-bold text-slate-900">{feature.name}</td>
                <td className="px-8 py-6 text-center">
                  {feature.essential ? <span className="material-symbols-outlined text-lime-500">check_circle</span> : <span className="material-symbols-outlined text-slate-300">cancel</span>}
                </td>
                <td className="px-8 py-6 text-center">
                  {feature.growth ? <span className="material-symbols-outlined text-lime-500">check_circle</span> : <span className="material-symbols-outlined text-slate-300">cancel</span>}
                </td>
                <td className="px-8 py-6 text-center">
                  {feature.advanced ? <span className="material-symbols-outlined text-lime-500">check_circle</span> : <span className="material-symbols-outlined text-slate-300">cancel</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default FeatureMatrixPage;
