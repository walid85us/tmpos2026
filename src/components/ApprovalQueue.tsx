import React from 'react';
import { Link } from 'react-router-dom';

export default function ApprovalQueue() {
  const pendingRequests = [
    { id: 1, employee: 'Jane Smith', action: 'Create New Manager', status: 'Pending' },
  ];

  return (
    <div className="bg-amber-50 p-6 rounded-2xl border border-amber-200 shadow-sm">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-black text-amber-900 uppercase tracking-widest">Pending Approvals</h3>
        <Link
          to="/employees"
          className="text-[10px] font-black text-amber-700 uppercase tracking-widest hover:text-amber-900 flex items-center gap-1 transition-colors"
        >
          View All
          <span className="material-symbols-outlined text-sm">arrow_forward</span>
        </Link>
      </div>
      <div className="space-y-3">
        {pendingRequests.map(req => (
          <div key={req.id} className="flex justify-between items-center p-4 bg-white rounded-xl border border-amber-100">
            <div>
              <p className="font-bold text-slate-900 text-sm">{req.employee}</p>
              <p className="text-xs text-slate-500">{req.action}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 bg-amber-100 text-amber-800 text-[10px] font-black uppercase tracking-widest rounded-lg">
                {req.status}
              </span>
              <Link
                to="/employees"
                className="px-3 py-1 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-lg hover:bg-primary/90 transition-colors"
              >
                Review
              </Link>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-amber-600 font-medium mt-3">
        Go to Employees to approve, reject, or return requests for changes.
      </p>
    </div>
  );
}
