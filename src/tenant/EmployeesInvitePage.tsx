import React from 'react';

const EmployeesInvitePage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Invite Staff</h2>
        <p className="text-slate-500 font-medium">Send an invitation to a new employee.</p>
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
        <input type="email" className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="Email address..." />
        <button className="px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all uppercase tracking-widest">
          Send Invite
        </button>
      </div>
    </div>
  );
};

export default EmployeesInvitePage;
