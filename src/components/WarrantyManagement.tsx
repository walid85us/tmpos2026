import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState, type WarrantyClaimRecord } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import PageShell from './PageShell';

type ClaimStatus = WarrantyClaimRecord['status'];

const STATUS_CONFIG: Record<ClaimStatus, { label: string; color: string; icon: string }> = {
  'Submitted': { label: 'Submitted', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: 'upload_file' },
  'Under Review': { label: 'Under Review', color: 'bg-amber-100 text-amber-700 border-amber-200', icon: 'pending' },
  'Approved': { label: 'Approved', color: 'bg-lime-100 text-lime-700 border-lime-200', icon: 'check_circle' },
  'Rejected': { label: 'Rejected', color: 'bg-rose-100 text-rose-700 border-rose-200', icon: 'cancel' },
  'In Repair': { label: 'In Repair', color: 'bg-indigo-100 text-indigo-700 border-indigo-200', icon: 'build' },
  'Replacement Pending': { label: 'Replacement Pending', color: 'bg-purple-100 text-purple-700 border-purple-200', icon: 'swap_horiz' },
  'Completed': { label: 'Completed', color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: 'task_alt' },
};

const ALLOWED_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  'Submitted': ['Under Review', 'Rejected'],
  'Under Review': ['Approved', 'Rejected'],
  'Approved': ['In Repair', 'Replacement Pending', 'Completed'],
  'Rejected': [],
  'In Repair': ['Completed'],
  'Replacement Pending': ['Completed'],
  'Completed': [],
};

const WarrantyManagement: React.FC = () => {
  const { warrantyClaims, updateWarrantyClaim, completedOrders } = useStoreLocalState();
  const { session } = useAccess();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selectedClaim, setSelectedClaim] = useState<WarrantyClaimRecord | null>(null);
  const [transitionNote, setTransitionNote] = useState('');

  const canManage = session?.role === 'system_owner' || session?.role === 'store_owner' || session?.role === 'manager';

  const filteredClaims = warrantyClaims.filter(c => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (typeFilter !== 'all' && c.warrantyType !== typeFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return c.ticketNumber.toLowerCase().includes(q) || c.invoiceNumber.toLowerCase().includes(q) || c.customerName.toLowerCase().includes(q) || c.reason.toLowerCase().includes(q);
    }
    return true;
  });

  const handleStatusTransition = (claim: WarrantyClaimRecord, newStatus: ClaimStatus) => {
    const operatorName = session?.name || session?.email || 'Unknown';
    updateWarrantyClaim(claim.id, {
      status: newStatus,
      statusHistory: [
        ...claim.statusHistory,
        { status: newStatus, date: new Date().toISOString(), by: operatorName, note: transitionNote || undefined },
      ],
    });
    setSelectedClaim({ ...claim, status: newStatus, statusHistory: [...claim.statusHistory, { status: newStatus, date: new Date().toISOString(), by: operatorName, note: transitionNote || undefined }] });
    setTransitionNote('');
  };

  const activeCount = warrantyClaims.filter(c => !['Completed', 'Rejected'].includes(c.status)).length;
  const originalOrder = selectedClaim ? completedOrders.find(o => o.id === selectedClaim.originalOrderId) : null;

  return (
    <PageShell title="Warranty Management">
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Claims</p>
            <p className="text-3xl font-black text-primary">{warrantyClaims.length}</p>
          </div>
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Active</p>
            <p className="text-3xl font-black text-amber-600">{activeCount}</p>
          </div>
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Service Claims</p>
            <p className="text-3xl font-black text-indigo-600">{warrantyClaims.filter(c => c.warrantyType === 'service').length}</p>
          </div>
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Part Claims</p>
            <p className="text-3xl font-black text-teal-600">{warrantyClaims.filter(c => c.warrantyType === 'part').length}</p>
          </div>
        </div>

        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] ghost-border overflow-hidden">
          <div className="p-6 border-b border-slate-100">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-medium text-sm"
                  placeholder="Search by ticket #, invoice #, customer, reason..."
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl font-black text-xs uppercase tracking-widest"
              >
                <option value="all">All Statuses</option>
                {Object.keys(STATUS_CONFIG).map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl font-black text-xs uppercase tracking-widest"
              >
                <option value="all">All Types</option>
                <option value="service">Service Warranty</option>
                <option value="part">Part Warranty</option>
              </select>
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {filteredClaims.length === 0 ? (
              <div className="py-16 text-center">
                <span className="material-symbols-outlined text-4xl text-slate-300 mb-3 block">verified_user</span>
                <p className="text-sm font-bold text-slate-400">No warranty claims found</p>
                <p className="text-xs text-slate-300 mt-1">Claims filed from POS will appear here</p>
              </div>
            ) : (
              filteredClaims.map(claim => {
                const cfg = STATUS_CONFIG[claim.status];
                return (
                  <button
                    key={claim.id}
                    onClick={() => { setSelectedClaim(claim); setTransitionNote(''); }}
                    className="w-full p-5 hover:bg-slate-50 transition-all text-left flex items-center gap-4"
                  >
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${cfg.color}`}>
                      <span className="material-symbols-outlined text-lg">{cfg.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="font-black text-sm text-primary">{claim.ticketNumber}</p>
                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-lg border uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>
                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-lg uppercase tracking-wider ${claim.warrantyType === 'service' ? 'bg-indigo-50 text-indigo-600 border border-indigo-200' : 'bg-teal-50 text-teal-600 border border-teal-200'}`}>
                          {claim.warrantyType}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 truncate">{claim.itemName} — {claim.customerName}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-bold text-slate-400">{claim.invoiceNumber}</p>
                      <p className="text-[10px] text-slate-300">{new Date(claim.createdAt).toLocaleDateString()}</p>
                    </div>
                    <span className="material-symbols-outlined text-slate-300">chevron_right</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {selectedClaim && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-teal-950/40 backdrop-blur-md p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white rounded-[2.5rem] shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-start shrink-0">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h3 className="text-2xl font-black text-primary tracking-tight">{selectedClaim.ticketNumber}</h3>
                    {(() => {
                      const cfg = STATUS_CONFIG[selectedClaim.status];
                      return <span className={`text-[10px] font-black px-3 py-1 rounded-lg border uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>;
                    })()}
                  </div>
                  <p className="text-sm text-slate-500">{selectedClaim.warrantyType === 'service' ? 'Service Warranty' : 'Part Warranty'} Claim</p>
                </div>
                <button onClick={() => setSelectedClaim(null)} className="w-10 h-10 rounded-full hover:bg-slate-100 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>

              <div className="p-8 space-y-6 overflow-y-auto flex-1">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 rounded-2xl p-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Customer</p>
                    <p className="font-bold text-sm text-primary">{selectedClaim.customerName}</p>
                  </div>
                  <div className="bg-slate-50 rounded-2xl p-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Original Invoice</p>
                    <p className="font-bold text-sm text-primary">{selectedClaim.invoiceNumber}</p>
                  </div>
                  <div className="bg-slate-50 rounded-2xl p-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Item / Service</p>
                    <p className="font-bold text-sm text-primary">{selectedClaim.itemName}</p>
                  </div>
                  <div className="bg-slate-50 rounded-2xl p-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Original Date</p>
                    <p className="font-bold text-sm text-primary">{new Date(selectedClaim.originalDate).toLocaleDateString()}</p>
                  </div>
                  <div className="bg-slate-50 rounded-2xl p-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Warranty Period</p>
                    <p className="font-bold text-sm text-primary">{selectedClaim.warrantyPeriod}</p>
                  </div>
                  <div className="bg-slate-50 rounded-2xl p-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Filed By</p>
                    <p className="font-bold text-sm text-primary">{selectedClaim.processedBy}</p>
                  </div>
                </div>

                <div className="bg-amber-50 rounded-2xl p-4 border border-amber-200">
                  <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-2">Claim Reason</p>
                  <p className="text-sm font-bold text-amber-800">{selectedClaim.reason}</p>
                  {selectedClaim.notes && (
                    <p className="text-xs text-amber-700 mt-2">{selectedClaim.notes}</p>
                  )}
                </div>

                {selectedClaim.originalNotes && (
                  <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-200">
                    <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-2">Original Service Notes</p>
                    <p className="text-xs text-indigo-700">{selectedClaim.originalNotes}</p>
                  </div>
                )}

                {originalOrder && (
                  <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Original Order Details</p>
                    <div className="space-y-1">
                      {originalOrder.items.map(item => (
                        <div key={item.id} className={`flex justify-between text-xs py-1 ${item.id === selectedClaim.itemId ? 'font-bold text-primary' : 'text-slate-500'}`}>
                          <span>{item.name} × {item.qty}{item.id === selectedClaim.itemId ? ' ← Claimed' : ''}</span>
                          <span>${(item.unitPrice * item.qty).toFixed(2)}</span>
                        </div>
                      ))}
                      <div className="border-t border-slate-200 pt-1 mt-1 flex justify-between text-xs font-bold text-primary">
                        <span>Order Total</span>
                        <span>${originalOrder.total.toFixed(2)}</span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1">Paid via: {originalOrder.payments.map(p => p.method).join(', ')}</p>
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Status History</p>
                  <div className="space-y-3">
                    {selectedClaim.statusHistory.map((entry, i) => {
                      const isLast = i === selectedClaim.statusHistory.length - 1;
                      return (
                        <div key={i} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className={`w-3 h-3 rounded-full ${isLast ? 'bg-primary' : 'bg-slate-300'}`} />
                            {i < selectedClaim.statusHistory.length - 1 && <div className="w-0.5 flex-1 bg-slate-200" />}
                          </div>
                          <div className="pb-3">
                            <div className="flex items-center gap-2">
                              <p className={`text-xs font-black ${isLast ? 'text-primary' : 'text-slate-500'}`}>{entry.status}</p>
                              <p className="text-[10px] text-slate-400">{new Date(entry.date).toLocaleString()}</p>
                            </div>
                            <p className="text-[10px] text-slate-400">by {entry.by}</p>
                            {entry.note && <p className="text-xs text-slate-600 mt-0.5 bg-slate-50 rounded-lg px-2 py-1">{entry.note}</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {canManage && ALLOWED_TRANSITIONS[selectedClaim.status].length > 0 && (
                  <div className="bg-teal-50 rounded-2xl p-5 border border-teal-200">
                    <p className="text-[10px] font-black text-teal-600 uppercase tracking-widest mb-3">Update Claim Status</p>
                    <div className="space-y-3">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Note (optional)</label>
                        <textarea
                          value={transitionNote}
                          onChange={(e) => setTransitionNote(e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium min-h-[60px] focus:ring-2 focus:ring-primary/20 focus:outline-none"
                          placeholder="Add a note about this decision..."
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {ALLOWED_TRANSITIONS[selectedClaim.status].map(nextStatus => {
                          const cfg = STATUS_CONFIG[nextStatus];
                          return (
                            <button
                              key={nextStatus}
                              onClick={() => handleStatusTransition(selectedClaim, nextStatus)}
                              className={`px-4 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest transition-all active:scale-95 flex items-center gap-2 ${cfg.color} hover:opacity-80`}
                            >
                              <span className="material-symbols-outlined text-sm">{cfg.icon}</span>
                              {nextStatus === 'In Repair' ? 'Send to Repair' : nextStatus === 'Replacement Pending' ? 'Issue Replacement' : cfg.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {!canManage && ALLOWED_TRANSITIONS[selectedClaim.status].length > 0 && (
                  <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200 text-center">
                    <span className="material-symbols-outlined text-slate-400 mb-1">lock</span>
                    <p className="text-xs font-bold text-slate-400">Only managers and owners can update claim status</p>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageShell>
  );
};

export default WarrantyManagement;
