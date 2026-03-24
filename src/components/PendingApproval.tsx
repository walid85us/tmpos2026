import React from 'react';
import { useAccess } from '../context/AccessContext';

interface PendingApprovalProps {
  requests: any[];
  onApprove?: (id: number) => void;
  onReject?: (id: number) => void;
  onReturn?: (id: number, comment: string) => void;
  onResubmit?: (id: number, updatedDetails: any) => void;
}

export default function PendingApproval({ requests, onApprove, onReject, onReturn, onResubmit }: PendingApprovalProps) {
  const { session } = useAccess();
  const [selectedRequest, setSelectedRequest] = React.useState<any | null>(null);
  const [returnComment, setReturnComment] = React.useState('');
  const [editDetails, setEditDetails] = React.useState<any>(null);
  
  if (requests.length === 0) return null;

  const isStoreOwner = session?.role === 'store_owner' || session?.role === 'system_owner';
  const isManager = session?.role === 'manager';

  return (
    <div className="bg-amber-50 p-6 rounded-2xl border border-amber-200 shadow-sm mb-8">
      <h3 className="text-sm font-black text-amber-900 uppercase tracking-widest mb-4">Pending Approvals</h3>
      <div className="space-y-4">
        {requests.map(req => (
          <div key={req.id} className="flex justify-between items-center p-4 bg-white rounded-lg border border-amber-100 cursor-pointer hover:bg-amber-50/50 transition-colors" onClick={() => {
            setSelectedRequest(req);
            setEditDetails(req.details);
            setReturnComment('');
          }}>
            <div>
              <p className="font-bold text-slate-900">{req.employee}</p>
              <p className="text-xs text-slate-500">{req.action}</p>
              {req.status === 'returned' && (
                <p className="text-xs text-rose-500 mt-1 font-bold">Returned: {req.comment}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg ${
                req.status === 'returned' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'
              }`}>
                {req.status === 'returned' ? 'Returned' : 'Pending'}
              </span>
              {isStoreOwner && req.status !== 'returned' && (
                <>
                  <button 
                    onClick={(e) => { e.stopPropagation(); onApprove?.(req.id); }}
                    className="px-3 py-1 bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest rounded-lg hover:bg-emerald-600 transition-colors"
                  >
                    Approve
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); onReject?.(req.id); }}
                    className="px-3 py-1 bg-rose-500 text-white text-[10px] font-black uppercase tracking-widest rounded-lg hover:bg-rose-600 transition-colors"
                  >
                    Reject
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {selectedRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setSelectedRequest(null)} />
          <div className="relative w-full max-w-xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <div>
                <h3 className="text-2xl font-black text-primary tracking-tight">Request Details</h3>
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{selectedRequest.action}</p>
              </div>
              <button onClick={() => setSelectedRequest(null)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                <span className="material-symbols-outlined text-slate-400">close</span>
              </button>
            </div>
            
            <div className="p-8 overflow-y-auto flex-1 space-y-6">
              <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-4">
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Payload Data</h4>
                {selectedRequest.status === 'returned' && isManager ? (
                  <div className="space-y-4">
                    {Object.entries(editDetails || {}).map(([key, value]) => (
                      <div key={key} className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{key}</label>
                        <input 
                          type="text" 
                          value={value as string} 
                          onChange={(e) => setEditDetails({ ...editDetails, [key]: e.target.value })}
                          className="w-full px-4 py-2 bg-white rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 text-sm" 
                        />
                      </div>
                    ))}
                    <button 
                      onClick={() => {
                        onResubmit?.(selectedRequest.id, editDetails);
                        setSelectedRequest(null);
                      }}
                      className="w-full py-3 bg-primary text-white font-black text-xs rounded-xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all"
                    >
                      Resubmit Request
                    </button>
                  </div>
                ) : (
                  <pre className="text-xs font-mono text-slate-600 whitespace-pre-wrap">
                    {JSON.stringify(selectedRequest.details, null, 2)}
                  </pre>
                )}
              </div>

              {selectedRequest.status === 'returned' && (
                <div className="bg-rose-50 p-6 rounded-2xl border border-rose-100">
                  <h4 className="text-[10px] font-black text-rose-400 uppercase tracking-widest mb-2">Return Comment</h4>
                  <p className="text-sm font-bold text-rose-900">{selectedRequest.comment}</p>
                </div>
              )}

              {isStoreOwner && selectedRequest.status !== 'returned' && (
                <div className="space-y-4 pt-4 border-t border-slate-100">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Return for Changes Comment</label>
                    <textarea 
                      value={returnComment}
                      onChange={(e) => setReturnComment(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-medium text-slate-700 text-sm resize-none h-24"
                      placeholder="Explain what needs to be changed..."
                    />
                  </div>
                  <div className="flex gap-4">
                    <button 
                      onClick={() => {
                        if (returnComment.trim()) {
                          onReturn?.(selectedRequest.id, returnComment);
                          setSelectedRequest(null);
                        } else {
                          alert('Please provide a comment before returning.');
                        }
                      }}
                      className="flex-1 py-3 bg-amber-500 text-white font-black text-xs rounded-xl shadow-lg shadow-amber-500/20 uppercase tracking-widest hover:bg-amber-600 transition-all"
                    >
                      Return to Manager
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
