import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useAccess } from '../context/AccessContext';

interface ApprovalRequest {
  id: number;
  employee: string;
  action: string;
  type: string;
  status: string;
  details: Record<string, any>;
  comment?: string;
}

const fieldLabels: Record<string, string> = {
  firstName: 'First Name',
  lastName: 'Last Name',
  email: 'Email',
  roleId: 'Requested Role',
  status: 'Status',
  payRate: 'Pay Rate',
  payType: 'Pay Type',
  commissionEnabled: 'Commission Enabled',
  commissionType: 'Commission Type',
  commissionRate: 'Commission Rate',
  name: 'Role Name',
};

function formatValue(key: string, value: any): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'payRate') return `$${value}`;
  if (key === 'commissionRate') return `${value}%`;
  if (key === 'commissionEnabled') return value === 'on' || value === true ? 'Yes' : 'No';
  return String(value);
}

export default function ApprovalQueue() {
  const { session } = useAccess();
  const isStoreOwner = session?.role === 'store_owner' || session?.role === 'system_owner';

  const [requests, setRequests] = useState<ApprovalRequest[]>([
    {
      id: Date.now() - 200000,
      employee: 'Sarah Jenkins',
      action: 'Create New Manager',
      type: 'add_employee',
      status: 'pending',
      details: {
        firstName: 'Mike',
        lastName: 'Rodriguez',
        email: 'mike@example.com',
        roleId: 'manager',
        status: 'Active',
        payRate: 30,
        payType: 'Hourly',
        commissionEnabled: true,
        commissionType: 'percentage',
        commissionRate: 8
      }
    }
  ]);

  const [selectedRequest, setSelectedRequest] = useState<ApprovalRequest | null>(null);
  const [returnComment, setReturnComment] = useState('');

  const pendingCount = requests.filter(r => r.status === 'pending' || r.status === 'returned').length;

  const handleApprove = (id: number) => {
    setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'approved' } : r));
    setSelectedRequest(null);
  };

  const handleReject = (id: number) => {
    setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'rejected' } : r));
    setSelectedRequest(null);
  };

  const handleReturn = (id: number, comment: string) => {
    setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'returned', comment } : r));
    setSelectedRequest(null);
    setReturnComment('');
  };

  if (pendingCount === 0 && requests.length === 0) return null;

  return (
    <>
      <div className="bg-amber-50 p-6 rounded-2xl border border-amber-200 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-black text-amber-900 uppercase tracking-widest">Pending Approvals</h3>
            {pendingCount > 0 && (
              <span className="w-6 h-6 bg-amber-500 text-white text-[10px] font-black flex items-center justify-center rounded-full">
                {pendingCount}
              </span>
            )}
          </div>
          <Link
            to="/employees"
            className="text-[10px] font-black text-amber-700 uppercase tracking-widest hover:text-amber-900 flex items-center gap-1 transition-colors"
          >
            View All in Employees
            <span className="material-symbols-outlined text-sm">arrow_forward</span>
          </Link>
        </div>
        <div className="space-y-3">
          {requests.filter(r => r.status === 'pending' || r.status === 'returned').map(req => (
            <div
              key={req.id}
              onClick={() => { setSelectedRequest(req); setReturnComment(''); }}
              className="flex justify-between items-center p-4 bg-white rounded-xl border border-amber-100 cursor-pointer hover:bg-amber-50/50 hover:shadow-sm transition-all"
            >
              <div>
                <p className="font-bold text-slate-900 text-sm">{req.employee}</p>
                <p className="text-xs text-slate-500">{req.action}</p>
                {req.status === 'returned' && req.comment && (
                  <p className="text-[10px] text-rose-500 font-bold mt-1">Returned: {req.comment}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg ${
                  req.status === 'returned' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'
                }`}>
                  {req.status === 'returned' ? 'Returned' : 'Pending'}
                </span>
                <span className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">Review</span>
              </div>
            </div>
          ))}
          {requests.filter(r => r.status === 'approved' || r.status === 'rejected').length > 0 && (
            <div className="pt-3 border-t border-amber-200 mt-3">
              <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-2">Recently Processed</p>
              {requests.filter(r => r.status === 'approved' || r.status === 'rejected').map(req => (
                <div key={req.id} className="flex justify-between items-center p-3 bg-white/60 rounded-xl border border-slate-100 mb-2 last:mb-0">
                  <div>
                    <p className="font-bold text-slate-600 text-sm">{req.employee}</p>
                    <p className="text-xs text-slate-400">{req.action}</p>
                  </div>
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg ${
                    req.status === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                  }`}>
                    {req.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {selectedRequest && isStoreOwner && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => setSelectedRequest(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Review Request</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{selectedRequest.action}</p>
                </div>
                <button onClick={() => setSelectedRequest(null)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>

              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Requested By</p>
                    <p className="text-sm font-bold text-slate-800">{selectedRequest.employee}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</p>
                    <span className={`inline-block px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg ${
                      selectedRequest.status === 'returned' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'
                    }`}>
                      {selectedRequest.status}
                    </span>
                  </div>
                </div>

                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-4">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Request Information</h4>
                  <div className="grid grid-cols-2 gap-4">
                    {Object.entries(selectedRequest.details).filter(([k]) => k !== 'id').map(([key, value]) => (
                      <div key={key} className="space-y-1">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                          {fieldLabels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
                        </p>
                        <p className="text-sm font-bold text-slate-800">{formatValue(key, value)}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {selectedRequest.status === 'returned' && selectedRequest.comment && (
                  <div className="bg-rose-50 p-6 rounded-2xl border border-rose-100">
                    <h4 className="text-[10px] font-black text-rose-400 uppercase tracking-widest mb-2">Return Comment</h4>
                    <p className="text-sm font-bold text-rose-900">{selectedRequest.comment}</p>
                  </div>
                )}

                <div className="space-y-4 pt-4 border-t border-slate-100">
                  <div className="flex gap-4">
                    <button
                      onClick={() => handleApprove(selectedRequest.id)}
                      className="flex-1 py-3 bg-emerald-500 text-white font-black text-xs rounded-xl shadow-lg shadow-emerald-500/20 uppercase tracking-widest hover:bg-emerald-600 transition-all flex items-center justify-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      Approve
                    </button>
                    <button
                      onClick={() => handleReject(selectedRequest.id)}
                      className="flex-1 py-3 bg-rose-500 text-white font-black text-xs rounded-xl shadow-lg shadow-rose-500/20 uppercase tracking-widest hover:bg-rose-600 transition-all flex items-center justify-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">cancel</span>
                      Reject
                    </button>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Return for Changes</label>
                    <textarea
                      value={returnComment}
                      onChange={(e) => setReturnComment(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-medium text-slate-700 text-sm resize-none h-20"
                      placeholder="Explain what needs to be changed..."
                    />
                    <button
                      onClick={() => {
                        if (returnComment.trim()) {
                          handleReturn(selectedRequest.id, returnComment);
                        }
                      }}
                      disabled={!returnComment.trim()}
                      className="w-full py-3 bg-amber-500 text-white font-black text-xs rounded-xl shadow-lg shadow-amber-500/20 uppercase tracking-widest hover:bg-amber-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">undo</span>
                      Return for Changes
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
