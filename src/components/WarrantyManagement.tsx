import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState, type WarrantyClaimRecord } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import PageShell from './PageShell';

type ClaimStatus = WarrantyClaimRecord['status'];

const STATUS_CONFIG: Record<ClaimStatus, { label: string; color: string; icon: string; order: number }> = {
  'Submitted': { label: 'Submitted', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: 'upload_file', order: 1 },
  'Under Review': { label: 'Under Review', color: 'bg-amber-100 text-amber-700 border-amber-200', icon: 'pending', order: 2 },
  'Approved': { label: 'Approved', color: 'bg-lime-100 text-lime-700 border-lime-200', icon: 'check_circle', order: 3 },
  'Rejected': { label: 'Rejected', color: 'bg-rose-100 text-rose-700 border-rose-200', icon: 'cancel', order: 6 },
  'In Repair': { label: 'In Repair', color: 'bg-indigo-100 text-indigo-700 border-indigo-200', icon: 'build', order: 4 },
  'Replacement Pending': { label: 'Replacement Pending', color: 'bg-purple-100 text-purple-700 border-purple-200', icon: 'swap_horiz', order: 5 },
  'Completed': { label: 'Completed', color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: 'task_alt', order: 7 },
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

const parseWarrantyPeriod = (period: string): number => {
  const match = period.match(/(\d+)\s*(day|month|year)/i);
  if (!match) return 0;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('year')) return num * 365;
  if (unit.startsWith('month')) return num * 30;
  return num;
};

const getWarrantyExpiry = (originalDate: string, warrantyPeriod: string): Date => {
  const days = parseWarrantyPeriod(warrantyPeriod);
  const d = new Date(originalDate);
  d.setDate(d.getDate() + days);
  return d;
};

const isWarrantyExpired = (originalDate: string, warrantyPeriod: string): boolean => {
  return getWarrantyExpiry(originalDate, warrantyPeriod) < new Date();
};

const getClaimAge = (createdAt: string): number => {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
};

const getClaimPriority = (claim: WarrantyClaimRecord): { level: 'high' | 'medium' | 'low'; label: string; color: string } => {
  const age = getClaimAge(claim.createdAt);
  const isExpiring = (() => {
    const expiry = getWarrantyExpiry(claim.originalDate, claim.warrantyPeriod);
    const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return daysLeft <= 7 && daysLeft >= 0;
  })();
  if (age > 7 || isExpiring) return { level: 'high', label: 'High', color: 'bg-red-100 text-red-700 border-red-200' };
  if (age > 3) return { level: 'medium', label: 'Medium', color: 'bg-amber-100 text-amber-700 border-amber-200' };
  return { level: 'low', label: 'Normal', color: 'bg-slate-100 text-slate-600 border-slate-200' };
};

const AVAILABLE_TECHNICIANS = [
  { id: 'tech-john', name: 'John D.' },
  { id: 'tech-sarah', name: 'Sarah L.' },
  { id: 'tech-mike', name: 'Mike R.' },
];

const WarrantyManagement: React.FC = () => {
  const { warrantyClaims, updateWarrantyClaim, completedOrders, addWarrantyRepairTicket, addPendingReplacement } = useStoreLocalState();
  const { session, effectiveRole } = useAccess();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selectedClaim, setSelectedClaim] = useState<WarrantyClaimRecord | null>(null);
  const [transitionNote, setTransitionNote] = useState('');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'priority'>('newest');
  const [showRepairAssignModal, setShowRepairAssignModal] = useState(false);
  const [selectedTechnicianId, setSelectedTechnicianId] = useState<string>('anyone');
  const [repairAssignClaim, setRepairAssignClaim] = useState<WarrantyClaimRecord | null>(null);
  const [replacementSentToast, setReplacementSentToast] = useState('');

  const activeRole = effectiveRole || session?.role || '';
  const canManage = activeRole === 'system_owner' || activeRole === 'store_owner' || activeRole === 'manager';

  const filteredClaims = useMemo(() => {
    let list = warrantyClaims.filter(c => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (typeFilter !== 'all' && c.warrantyType !== typeFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return c.ticketNumber.toLowerCase().includes(q) || c.invoiceNumber.toLowerCase().includes(q) || c.customerName.toLowerCase().includes(q) || c.reason.toLowerCase().includes(q);
      }
      return true;
    });
    if (sortBy === 'newest') list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    else if (sortBy === 'oldest') list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    else list.sort((a, b) => {
      const pMap = { high: 0, medium: 1, low: 2 };
      return pMap[getClaimPriority(a).level] - pMap[getClaimPriority(b).level];
    });
    return list;
  }, [warrantyClaims, statusFilter, typeFilter, search, sortBy]);

  const handleStatusTransition = (claim: WarrantyClaimRecord, newStatus: ClaimStatus) => {
    if (!canManage) return;

    if (newStatus === 'In Repair') {
      setRepairAssignClaim(claim);
      setSelectedTechnicianId('anyone');
      setShowRepairAssignModal(true);
      return;
    }

    const operatorName = session?.user?.name || session?.user?.email || 'Unknown';
    const newHistory = [
      ...claim.statusHistory,
      { status: newStatus, date: new Date().toISOString(), by: operatorName, note: transitionNote || undefined },
    ];
    const updates: Partial<WarrantyClaimRecord> = { status: newStatus, statusHistory: newHistory };

    updateWarrantyClaim(claim.id, updates);
    setSelectedClaim({ ...claim, ...updates });
    setTransitionNote('');
  };

  const handleRepairAssign = () => {
    if (!repairAssignClaim || !canManage) return;
    const operatorName = session?.user?.name || session?.user?.email || 'Unknown';
    const tech = selectedTechnicianId === 'anyone' ? null : AVAILABLE_TECHNICIANS.find(t => t.id === selectedTechnicianId);
    const assignNote = tech
      ? `${transitionNote ? transitionNote + ' — ' : ''}Assigned to ${tech.name} for warranty repair`
      : `${transitionNote ? transitionNote + ' — ' : ''}Sent to general technician pool for warranty repair`;

    const newHistory = [
      ...repairAssignClaim.statusHistory,
      { status: 'In Repair', date: new Date().toISOString(), by: operatorName, note: assignNote },
    ];

    const repairTicketId = `wr-${Date.now()}`;
    const repairTicketNumber = `WR-${repairAssignClaim.ticketNumber.replace('WC-', '')}`;

    addWarrantyRepairTicket({
      id: repairTicketId,
      ticketNumber: repairTicketNumber,
      customerId: repairAssignClaim.customerId,
      customerName: repairAssignClaim.customerName,
      device: repairAssignClaim.itemName,
      issue: `Warranty Repair: ${repairAssignClaim.reason}`,
      status: tech ? 'In Progress' : 'Pending',
      priority: 'High',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      estimatedCost: 0,
      technicianId: tech?.id,
      technicianName: tech?.name || 'Unassigned (Pool)',
      diagnosticNotes: `Warranty claim ${repairAssignClaim.ticketNumber} — ${repairAssignClaim.notes}`,
      history: [
        { id: `h-${Date.now()}`, action: 'Created from warranty claim', performedBy: operatorName, timestamp: new Date().toISOString(), details: `Linked to warranty ${repairAssignClaim.ticketNumber}` },
      ],
    });

    const updates: Partial<WarrantyClaimRecord> = {
      status: 'In Repair',
      statusHistory: newHistory,
      linkedRepairId: repairTicketId,
      assignedTechnicianId: tech?.id || undefined,
      assignedTechnicianName: tech?.name || 'General Pool',
    };

    updateWarrantyClaim(repairAssignClaim.id, updates);
    setSelectedClaim({ ...repairAssignClaim, ...updates });
    setTransitionNote('');
    setShowRepairAssignModal(false);
    setRepairAssignClaim(null);
  };

  const handleSendReplacementToPOS = (claim: WarrantyClaimRecord) => {
    if (claim.replacementSentToPOS || !canManage) return;
    const originalOrder = completedOrders.find(o => o.id === claim.originalOrderId);
    const originalItem = originalOrder?.items.find(i => i.id === claim.itemId);
    addPendingReplacement({
      warrantyClaimId: claim.id,
      itemName: claim.itemName,
      customerName: claim.customerName,
      customerId: claim.customerId,
      originalPrice: originalItem?.unitPrice || 0,
      type: 'replacement',
    });
    updateWarrantyClaim(claim.id, { replacementSentToPOS: true });
    setSelectedClaim({ ...claim, replacementSentToPOS: true });
    setReplacementSentToast(`Replacement for "${claim.itemName}" sent to POS`);
    setTimeout(() => setReplacementSentToast(''), 3000);
  };

  const handleSendRepairReturnToPOS = (claim: WarrantyClaimRecord) => {
    if (claim.repairReturnSentToPOS || !canManage) return;
    const originalOrder = completedOrders.find(o => o.id === claim.originalOrderId);
    const originalItem = originalOrder?.items.find(i => i.id === claim.itemId);
    addPendingReplacement({
      warrantyClaimId: claim.id,
      itemName: claim.itemName,
      customerName: claim.customerName,
      customerId: claim.customerId,
      originalPrice: originalItem?.unitPrice || 0,
      type: 'repair_return',
    });
    updateWarrantyClaim(claim.id, { repairReturnSentToPOS: true });
    setSelectedClaim({ ...claim, repairReturnSentToPOS: true });
    setReplacementSentToast(`Repaired item "${claim.itemName}" sent to POS for return`);
    setTimeout(() => setReplacementSentToast(''), 3000);
  };

  const activeCount = warrantyClaims.filter(c => !['Completed', 'Rejected'].includes(c.status)).length;
  const awaitingReview = warrantyClaims.filter(c => c.status === 'Submitted' || c.status === 'Under Review').length;
  const inProgress = warrantyClaims.filter(c => c.status === 'In Repair' || c.status === 'Replacement Pending').length;
  const resolvedCount = warrantyClaims.filter(c => c.status === 'Completed').length;
  const originalOrder = selectedClaim ? completedOrders.find(o => o.id === selectedClaim.originalOrderId) : null;
  const selectedExpired = selectedClaim ? isWarrantyExpired(selectedClaim.originalDate, selectedClaim.warrantyPeriod) : false;
  const selectedExpiry = selectedClaim ? getWarrantyExpiry(selectedClaim.originalDate, selectedClaim.warrantyPeriod) : null;
  const selectedPriority = selectedClaim ? getClaimPriority(selectedClaim) : null;
  const selectedAge = selectedClaim ? getClaimAge(selectedClaim.createdAt) : 0;

  return (
    <PageShell title="Warranty Management">
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Claims</p>
            <p className="text-3xl font-black text-primary">{warrantyClaims.length}</p>
          </div>
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Active</p>
            <p className="text-3xl font-black text-amber-600">{activeCount}</p>
          </div>
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Awaiting Review</p>
            <p className="text-3xl font-black text-blue-600">{awaitingReview}</p>
          </div>
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">In Progress</p>
            <p className="text-3xl font-black text-indigo-600">{inProgress}</p>
          </div>
          <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] p-5 ghost-border">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Resolved</p>
            <p className="text-3xl font-black text-emerald-600">{resolvedCount}</p>
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
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl font-black text-xs uppercase tracking-widest"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
                <option value="priority">Priority</option>
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
                const priority = getClaimPriority(claim);
                const age = getClaimAge(claim.createdAt);
                const expired = isWarrantyExpired(claim.originalDate, claim.warrantyPeriod);
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
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <p className="font-black text-sm text-primary">{claim.ticketNumber}</p>
                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-lg border uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>
                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-lg uppercase tracking-wider ${claim.warrantyType === 'service' ? 'bg-indigo-50 text-indigo-600 border border-indigo-200' : 'bg-teal-50 text-teal-600 border border-teal-200'}`}>
                          {claim.warrantyType}
                        </span>
                        {!['Completed', 'Rejected'].includes(claim.status) && priority.level !== 'low' && (
                          <span className={`text-[9px] font-black px-2 py-0.5 rounded-lg border uppercase tracking-wider ${priority.color}`}>
                            {priority.label}
                          </span>
                        )}
                        {expired && !['Completed', 'Rejected'].includes(claim.status) && (
                          <span className="text-[9px] font-black px-2 py-0.5 rounded-lg border bg-red-50 text-red-600 border-red-200 uppercase tracking-wider">Expired</span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 truncate">{claim.itemName} — {claim.customerName}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-bold text-slate-400">{claim.invoiceNumber}</p>
                      <p className="text-[10px] text-slate-300">{age === 0 ? 'Today' : `${age}d ago`}</p>
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
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h3 className="text-2xl font-black text-primary tracking-tight">{selectedClaim.ticketNumber}</h3>
                    {(() => {
                      const cfg = STATUS_CONFIG[selectedClaim.status];
                      return <span className={`text-[10px] font-black px-3 py-1 rounded-lg border uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>;
                    })()}
                    {selectedPriority && !['Completed', 'Rejected'].includes(selectedClaim.status) && (
                      <span className={`text-[10px] font-black px-3 py-1 rounded-lg border uppercase tracking-wider ${selectedPriority.color}`}>
                        {selectedPriority.label} Priority
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-500">{selectedClaim.warrantyType === 'service' ? 'Service Warranty' : 'Part Warranty'} Claim · {selectedAge === 0 ? 'Filed today' : `Filed ${selectedAge} day${selectedAge !== 1 ? 's' : ''} ago`}</p>
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
                    {selectedExpiry && (
                      <p className={`text-[10px] font-bold mt-0.5 ${selectedExpired ? 'text-red-500' : 'text-lime-600'}`}>
                        {selectedExpired ? 'Expired ' : 'Expires '}{selectedExpiry.toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <div className="bg-slate-50 rounded-2xl p-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Filed By</p>
                    <p className="font-bold text-sm text-primary">{selectedClaim.processedBy}</p>
                  </div>
                </div>

                {selectedExpired && !['Completed', 'Rejected'].includes(selectedClaim.status) && (
                  <div className="bg-red-50 rounded-2xl p-4 border border-red-200 flex items-center gap-3">
                    <span className="material-symbols-outlined text-red-500">warning</span>
                    <div>
                      <p className="text-xs font-black text-red-700">Warranty Period Expired</p>
                      <p className="text-[10px] text-red-600">This warranty expired on {selectedExpiry?.toLocaleDateString()}. Review carefully before approving — consider goodwill resolution or rejection with explanation.</p>
                    </div>
                  </div>
                )}

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
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Status History & Audit Trail</p>
                  <div className="space-y-3">
                    {selectedClaim.statusHistory.map((entry, i) => {
                      const isLast = i === selectedClaim.statusHistory.length - 1;
                      return (
                        <div key={i} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className={`w-3 h-3 rounded-full ${isLast ? 'bg-primary' : 'bg-slate-300'}`} />
                            {i < selectedClaim.statusHistory.length - 1 && <div className="w-0.5 flex-1 bg-slate-200" />}
                          </div>
                          <div className="pb-3 flex-1">
                            <div className="flex items-center gap-2">
                              <p className={`text-xs font-black ${isLast ? 'text-primary' : 'text-slate-500'}`}>{entry.status}</p>
                              <p className="text-[10px] text-slate-400">{new Date(entry.date).toLocaleString()}</p>
                            </div>
                            <p className="text-[10px] text-slate-400">by {entry.by}</p>
                            {entry.note && (
                              <div className="mt-1 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                                <p className="text-xs text-slate-600">{entry.note}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {selectedClaim.linkedRepairId && (
                  <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-200 flex items-center gap-3">
                    <span className="material-symbols-outlined text-indigo-600">build</span>
                    <div className="flex-1">
                      <p className="text-xs font-black text-indigo-700">Linked Repair Ticket</p>
                      <p className="text-[10px] text-indigo-600">Assigned to: {selectedClaim.assignedTechnicianName || 'General Pool'}</p>
                      <p className="text-[10px] text-indigo-500 mt-0.5">This repair appears in the Repairs queue. When the technician marks it complete, update this claim to Completed.</p>
                    </div>
                  </div>
                )}

                {selectedClaim.status === 'Replacement Pending' && canManage && (
                  <div className="bg-purple-50 rounded-2xl p-4 border border-purple-200">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-purple-600">shopping_cart</span>
                        <div>
                          <p className="text-xs font-black text-purple-700">Replacement Transaction</p>
                          <p className="text-[10px] text-purple-600">
                            {selectedClaim.replacementSentToPOS
                              ? 'Replacement has been sent to POS. Complete the zero-charge transaction there.'
                              : 'Send this replacement to POS to create a zero-charge transaction for the customer.'}
                          </p>
                        </div>
                      </div>
                      {!selectedClaim.replacementSentToPOS && (
                        <button
                          onClick={() => handleSendReplacementToPOS(selectedClaim)}
                          className="px-4 py-2.5 bg-purple-600 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-purple-700 transition-all active:scale-95 flex items-center gap-2"
                        >
                          <span className="material-symbols-outlined text-sm">send</span>Send to POS
                        </button>
                      )}
                      {selectedClaim.replacementSentToPOS && (
                        <span className="text-[10px] font-black text-purple-600 bg-purple-100 px-3 py-1.5 rounded-lg flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">check</span>Sent
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2 italic">Note: This is a simulated local flow. In production, POS integration would handle this automatically via backend.</p>
                  </div>
                )}

                {canManage && selectedClaim.status === 'Completed' && selectedClaim.linkedRepairId && (
                  <div className="bg-indigo-50 rounded-2xl p-5 border border-indigo-200">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-indigo-600">build</span>
                        <div>
                          <p className="text-xs font-black text-indigo-700">Repaired Item Return</p>
                          <p className="text-[10px] text-indigo-600">
                            {selectedClaim.repairReturnSentToPOS
                              ? selectedClaim.repairReturnOrderId
                                ? 'Repaired item has been returned to customer via POS.'
                                : 'Repaired item sent to POS. Complete the zero-charge return there.'
                              : 'Repair is complete. Send the repaired item to POS to process customer return.'}
                          </p>
                        </div>
                      </div>
                      {!selectedClaim.repairReturnSentToPOS && (
                        <button
                          onClick={() => handleSendRepairReturnToPOS(selectedClaim)}
                          className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all active:scale-95 flex items-center gap-2"
                        >
                          <span className="material-symbols-outlined text-sm">send</span>Send to POS
                        </button>
                      )}
                      {selectedClaim.repairReturnSentToPOS && (
                        <span className="text-[10px] font-black text-indigo-600 bg-indigo-100 px-3 py-1.5 rounded-lg flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">check</span>{selectedClaim.repairReturnOrderId ? 'Completed' : 'Sent'}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2 italic">Note: This is a simulated local flow. In production, repair return would integrate with backend automatically.</p>
                  </div>
                )}

                {canManage && ALLOWED_TRANSITIONS[selectedClaim.status].length > 0 && (
                  <div className="bg-teal-50 rounded-2xl p-5 border border-teal-200">
                    <p className="text-[10px] font-black text-teal-600 uppercase tracking-widest mb-3">Update Claim Status</p>
                    <div className="space-y-3">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Resolution Note {selectedClaim.status === 'Under Review' ? '(recommended)' : '(optional)'}</label>
                        <textarea
                          value={transitionNote}
                          onChange={(e) => setTransitionNote(e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium min-h-[60px] focus:ring-2 focus:ring-primary/20 focus:outline-none"
                          placeholder={
                            selectedClaim.status === 'Under Review'
                              ? 'Describe review findings, approval reason, or rejection rationale...'
                              : selectedClaim.status === 'Approved'
                              ? 'Note the repair plan or replacement details...'
                              : selectedClaim.status === 'In Repair'
                              ? 'Note repair completion details...'
                              : 'Add a note about this decision...'
                          }
                        />
                      </div>
                      {selectedClaim.status === 'Under Review' && !transitionNote.trim() && (
                        <p className="text-[10px] text-amber-600 font-bold flex items-center gap-1">
                          <span className="material-symbols-outlined text-[10px]">info</span>
                          Adding a review note is recommended for audit trail completeness
                        </p>
                      )}
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

        {showRepairAssignModal && repairAssignClaim && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black text-primary tracking-tight">Assign Warranty Repair</h3>
                <button onClick={() => { setShowRepairAssignModal(false); setRepairAssignClaim(null); }} className="text-slate-400 hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <div className="space-y-4">
                <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-200">
                  <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-1">Warranty Claim</p>
                  <p className="text-sm font-bold text-indigo-800">{repairAssignClaim.ticketNumber}</p>
                  <p className="text-xs text-indigo-600">{repairAssignClaim.itemName} — {repairAssignClaim.reason}</p>
                  <p className="text-xs text-indigo-500">{repairAssignClaim.customerName}</p>
                </div>

                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Assign To</label>
                  <div className="space-y-2">
                    <button
                      onClick={() => setSelectedTechnicianId('anyone')}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${selectedTechnicianId === 'anyone' ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-slate-200 hover:bg-slate-50'}`}
                    >
                      <div className="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center">
                        <span className="material-symbols-outlined text-sm text-slate-600">group</span>
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-bold">General Pool</p>
                        <p className="text-[10px] text-slate-500">Any available technician can pick this up</p>
                      </div>
                    </button>
                    {AVAILABLE_TECHNICIANS.map(tech => (
                      <button
                        key={tech.id}
                        onClick={() => setSelectedTechnicianId(tech.id)}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${selectedTechnicianId === tech.id ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-slate-200 hover:bg-slate-50'}`}
                      >
                        <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center text-xs font-black text-indigo-700">
                          {tech.name.split(' ').map(n => n[0]).join('')}
                        </div>
                        <p className="text-sm font-bold">{tech.name}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Repair Note (optional)</label>
                  <textarea
                    value={transitionNote}
                    onChange={(e) => setTransitionNote(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm min-h-[60px] focus:ring-2 focus:ring-primary/20 focus:outline-none"
                    placeholder="Add context for the technician..."
                  />
                </div>

                <button
                  onClick={handleRepairAssign}
                  className="w-full py-4 bg-primary text-white rounded-2xl font-black uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-sm">build</span>
                  Create Repair Ticket & Assign
                </button>

                <p className="text-[10px] text-slate-400 text-center italic">This will create a linked repair ticket visible in Repair Management</p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {replacementSentToast && (
        <div className="fixed bottom-8 right-8 z-[200] bg-emerald-500 text-white px-6 py-3 rounded-2xl shadow-xl font-bold text-sm flex items-center gap-2 animate-in slide-in-from-bottom-2">
          <span className="material-symbols-outlined text-sm">check_circle</span>
          {replacementSentToast}
        </div>
      )}
    </PageShell>
  );
};

export default WarrantyManagement;
