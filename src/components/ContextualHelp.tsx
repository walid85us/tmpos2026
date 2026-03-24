import React from 'react';
import { motion } from 'motion/react';

interface HelpItem {
  title: string;
  description: string;
  icon: string;
  link?: string;
}

interface ContextualHelpProps {
  title: string;
  items: HelpItem[];
  accentColor?: 'primary' | 'secondary' | 'lime';
}

const ContextualHelp: React.FC<ContextualHelpProps> = ({ title, items, accentColor = 'primary' }) => {
  const colorClasses = {
    primary: 'text-primary bg-primary/5 border-primary/10',
    secondary: 'text-secondary bg-secondary/5 border-secondary/10',
    lime: 'text-teal-900 bg-lime-400/10 border-lime-400/20',
  };

  const iconClasses = {
    primary: 'bg-primary text-white',
    secondary: 'bg-secondary text-white',
    lime: 'bg-teal-950 text-white',
  };

  return (
    <motion.section 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-12 bg-white/40 backdrop-blur-xl p-8 rounded-[3rem] border border-slate-200 shadow-sm overflow-hidden relative"
    >
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-xl font-black text-primary tracking-tight">{title}</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Pro Tips & System Logic</p>
          </div>
          <span className="material-symbols-outlined text-slate-200 text-4xl">lightbulb</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item, i) => (
            <div 
              key={i} 
              className={`p-5 rounded-[2rem] border transition-all cursor-pointer group hover:shadow-lg hover:scale-[1.02] ${colorClasses[accentColor]}`}
            >
              <div className="flex items-start gap-4">
                <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shadow-sm transition-transform group-hover:rotate-12 ${iconClasses[accentColor]}`}>
                  <span className="material-symbols-outlined text-xl">{item.icon}</span>
                </div>
                <div className="flex-1">
                  <h4 className="text-xs font-black uppercase tracking-widest mb-1">{item.title}</h4>
                  <p className="text-[10px] font-medium leading-relaxed opacity-70">{item.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      
      {/* Decorative background element */}
      <span className="material-symbols-outlined absolute -right-8 -bottom-8 text-[200px] text-slate-100/50 -rotate-12 select-none pointer-events-none">
        auto_awesome
      </span>
    </motion.section>
  );
};

export default ContextualHelp;
