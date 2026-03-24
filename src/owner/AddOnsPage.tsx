import React from 'react';
import { addOns } from './mockData';

const AddOnsPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Add-ons</h2>
        <p className="text-slate-500 font-medium">Manage optional add-ons for subscription plans.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {addOns.map((addon) => (
          <div key={addon.id} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-lg font-black text-primary tracking-tight">{addon.name}</h3>
              <span className="text-xl font-black text-primary">${addon.price}</span>
            </div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Compatible Plans</p>
            <div className="flex gap-2">
              {addon.compatiblePlans.map((plan, i) => (
                <span key={i} className="px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">
                  {plan}
                </span>
              ))}
            </div>
            <button className="w-full mt-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">
              Manage
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AddOnsPage;
