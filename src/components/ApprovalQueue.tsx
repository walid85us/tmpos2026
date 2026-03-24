import React from 'react';

export default function ApprovalQueue() {
  const pendingRequests = [
    { id: 1, employee: 'Jane Smith', action: 'Create New Manager', status: 'Pending' },
  ];

  return (
    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
      <h2 className="text-lg font-bold mb-4">Approval Queue</h2>
      <ul className="space-y-4">
        {pendingRequests.map(req => (
          <li key={req.id} className="flex justify-between items-center p-4 bg-slate-50 rounded-lg border border-slate-100">
            <div>
              <p className="font-bold">{req.employee}</p>
              <p className="text-sm text-slate-500">{req.action}</p>
            </div>
            <div className="flex gap-2">
              <button className="px-3 py-1 bg-emerald-500 text-white rounded text-xs font-bold">Approve</button>
              <button className="px-3 py-1 bg-rose-500 text-white rounded text-xs font-bold">Reject</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
