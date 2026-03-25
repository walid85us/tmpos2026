import React, { useState } from 'react';
import { addOns } from './mockData';
import { motion, AnimatePresence } from 'motion/react';

const AddOnsPage: React.FC = () => {
  const [selectedAddon, setSelectedAddon] = useState<string | null>(null);

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
            <button
              onClick={() => setSelectedAddon(addon.id)}
              className="w-full mt-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95"
            >
              Manage
            </button>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {selectedAddon && (() => {
          const addon = addOns.find(a => a.id === selectedAddon);
          if (!addon) return null;
          return (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setSelectedAddon(null)}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                onClick={e => e.stopPropagation()}
                className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden"
              >
                <div className="p-8 border-b border-slate-100">
                  <h3 className="text-xl font-black text-primary tracking-tight">{addon.name}</h3>
                  <p className="text-sm text-slate-500 mt-1">Add-on Management</p>
                </div>
                <div className="p-8 space-y-6">
                  <div className="flex justify-between items-center p-4 bg-slate-50 rounded-2xl">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Price</span>
                    <span className="text-lg font-black text-primary">${addon.price}/mo</span>
                  </div>
                  <div className="p-4 bg-slate-50 rounded-2xl">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-3">Compatible Plans</span>
                    <div className="flex gap-2 flex-wrap">
                      {addon.compatiblePlans.map((plan, i) => (
                        <span key={i} className="px-3 py-1.5 bg-white text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg border border-slate-200">{plan}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-between items-center p-4 bg-slate-50 rounded-2xl">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</span>
                    <span className="px-3 py-1 bg-lime-400/10 text-lime-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-400/20">Active</span>
                  </div>
                </div>
                <div className="p-8 border-t border-slate-100 bg-slate-50/50">
                  <button onClick={() => setSelectedAddon(null)} className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
                    Done
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
};

export default AddOnsPage;
