import React from 'react';
import { motion } from 'motion/react';
import { plans } from './mockData';

const PlansPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Subscription Plans</h2>
          <p className="text-slate-500 font-medium">Manage available subscription tiers and their features.</p>
        </div>
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
          <span className="material-symbols-outlined text-sm">add</span>
          Create New Plan
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {plans.map((plan) => (
          <motion.div
            key={plan.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all flex flex-col"
          >
            <div className="mb-6">
              <h3 className="text-xl font-black text-primary tracking-tight">{plan.name}</h3>
              <div className="flex items-baseline gap-1 mt-2">
                <span className="text-4xl font-black text-primary">${plan.price}</span>
                <span className="text-slate-400 font-bold">/mo</span>
              </div>
            </div>

            <div className="space-y-4 flex-grow mb-8">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Features</p>
              <ul className="space-y-2">
                {plan.features.map((feature, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm font-bold text-slate-700">
                    <span className="material-symbols-outlined text-lime-500 text-sm">check</span>
                    {feature}
                  </li>
                ))}
              </ul>
              
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest pt-4">Limits</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Seats</p>
                  <p className="font-black text-primary">{plan.limits.seats}</p>
                </div>
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Locations</p>
                  <p className="font-black text-primary">{plan.limits.locations}</p>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">
                Edit
              </button>
              <button className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">
                Archive
              </button>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
};

export default PlansPage;
