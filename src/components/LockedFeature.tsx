import React from 'react';

interface LockedFeatureProps {
  featureName: string;
  requiredPlan: string;
}

const LockedFeature: React.FC<LockedFeatureProps> = ({ featureName, requiredPlan }) => {
  return (
    <div className="p-8 bg-slate-50 rounded-[2.5rem] border border-slate-200 text-center space-y-4">
      <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mx-auto">
        <span className="text-2xl">🔒</span>
      </div>
      <h3 className="text-lg font-black text-primary tracking-tight">{featureName} is Locked</h3>
      <p className="text-slate-500 font-medium">This feature is included in the {requiredPlan} plan.</p>
      <button className="px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all uppercase tracking-widest">
        Upgrade Plan
      </button>
    </div>
  );
};

export default LockedFeature;
