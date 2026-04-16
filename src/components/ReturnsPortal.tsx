import React, { useState, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import PageShell from './PageShell';
import { TrackingNumber } from './shared/TrackingNumber';
import type {
  Return,
  ReturnStatus,
  ReturnReason,
  ReturnResolution,
  ReturnSourceType,
  ReturnDisposition,
  ReturnItem,
  ReturnStatusHistoryEntry,
  Shipment,
  ShipmentStatus,
  ShipmentAddress,
  ShipmentPackage,
  Customer,
  Invoice,
  RepairTicket,
  RMA,
} from '../types';

export interface ReturnPrefill {
  sourceType: ReturnSourceType;
  sourceId: string;
  sourceNumber: string;
  customerId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  reason?: ReturnReason;
  items?: { name: string; quantity: number; sku?: string; unitPrice?: number; maxQuantity?: number }[];
  originalShipmentId?: string;
}

const RETURN_STATUS_CONFIG: Record<ReturnStatus, { color: string; icon: string }> = {
  'Draft': { color: 'bg-slate-100 text-slate-700 border-slate-200', icon: 'edit_note' },
  'Requested': { color: 'bg-blue-100 text-blue-700 border-blue-200', icon: 'send' },
  'Approved': { color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: 'check_circle' },
  'Ready': { color: 'bg-sky-100 text-sky-700 border-sky-200', icon: 'inventory_2' },
  'Label Created': { color: 'bg-indigo-100 text-indigo-700 border-indigo-200', icon: 'label' },
  'Packed': { color: 'bg-violet-100 text-violet-700 border-violet-200', icon: 'inbox' },
  'Dispatched': { color: 'bg-orange-100 text-orange-700 border-orange-200', icon: 'outbox' },
  'In Transit': { color: 'bg-amber-100 text-amber-700 border-amber-200', icon: 'local_shipping' },
  'Delivered': { color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: 'home_storage' },
  'Received': { color: 'bg-cyan-100 text-cyan-700 border-cyan-200', icon: 'inventory' },
  'Inspecting': { color: 'bg-purple-100 text-purple-700 border-purple-200', icon: 'search' },
  'Completed': { color: 'bg-lime-100 text-lime-700 border-lime-200', icon: 'task_alt' },
  'Rejected': { color: 'bg-red-100 text-red-700 border-red-200', icon: 'block' },
  'Cancelled': { color: 'bg-stone-100 text-stone-500 border-stone-200', icon: 'cancel' },
};

const REASON_LABELS: Record<ReturnReason, string> = {
  defective: 'Defective / Faulty',
  wrong_item: 'Wrong Item Sent',
  not_as_described: 'Not As Described',
  damaged_in_transit: 'Damaged In Transit',
  customer_changed_mind: 'Changed Mind',
  warranty_claim: 'Warranty Claim',
  repair_return: 'Repair Return / Send-Back',
  exchange_request: 'Exchange Request',
  missing_parts: 'Missing Parts',
  other: 'Other',
};

const RESOLUTION_LABELS: Record<ReturnResolution, string> = {
  refund: 'Refund',
  exchange: 'Exchange',
  repair: 'Repair',
  store_credit: 'Store Credit',
  inspection_only: 'Inspection Only',
  send_back: 'Send Back to Customer',
  dispose: 'Dispose',
};

const DISPOSITION_LABELS: Record<ReturnDisposition, string> = {
  restock: 'Restock',
  refurbish: 'Send to Refurbishment',
  dispose: 'Dispose / Scrap',
  return_to_vendor: 'Return to Vendor',
  send_back_to_customer: 'Send Back to Customer',
  warranty_replacement: 'Warranty Replacement',
};

const SOURCE_TYPE_LABELS: Record<ReturnSourceType, string> = {
  invoice: 'Invoice',
  repair: 'Repair Ticket',
  shipment: 'Shipment',
  rma: 'RMA',
  walk_in: 'Walk-In',
};

const CONDITION_OPTIONS = ['New', 'Like New', 'Good', 'Fair', 'Poor', 'Damaged', 'Defective'] as const;

type TabView = 'all' | 'active' | 'completed';

function StatusBadge({ status }: { status: ReturnStatus }) {
  const cfg = RETURN_STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[11px] font-bold uppercase tracking-wider border ${cfg.color}`}>
      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{cfg.icon}</span>
      {status}
    </span>
  );
}

function getNextStatuses(current: ReturnStatus): ReturnStatus[] {
  const transitions: Record<ReturnStatus, ReturnStatus[]> = {
    'Draft': ['Requested', 'Cancelled'],
    'Requested': ['Approved', 'Rejected', 'Cancelled'],
    'Approved': ['Ready', 'Label Created', 'Cancelled'],
    'Ready': ['Label Created', 'Cancelled'],
    'Label Created': ['Packed', 'In Transit', 'Cancelled'],
    'Packed': ['Dispatched', 'In Transit', 'Cancelled'],
    'Dispatched': ['In Transit'],
    'In Transit': ['Delivered', 'Received'],
    'Delivered': ['Received'],
    'Received': ['Inspecting', 'Completed'],
    'Inspecting': ['Completed', 'Rejected'],
    'Completed': [],
    'Rejected': [],
    'Cancelled': [],
  };
  return transitions[current] || [];
}

export default function ReturnsPortal() {
  const { returns, addReturn, updateReturn, shipments, addShipment, customers, invoices, repairTickets, rmas } = useStoreLocalState();
  const { session, checkPermission, checkSubPermission, isWriteBlocked, canAccess } = useAccess();
  const location = useLocation();
  const navigate = useNavigate();

  const canView = canAccess('returns');

  const [tabView, setTabView] = useState<TabView>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReturnStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<ReturnSourceType | 'all'>('all');
  const [selectedReturn, setSelectedReturn] = useState<Return | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showIntakeModal, setShowIntakeModal] = useState(false);
  const [showDispositionModal, setShowDispositionModal] = useState(false);
  const [showReturnShipmentModal, setShowReturnShipmentModal] = useState(false);
  const [showLabelDeliveryModal, setShowLabelDeliveryModal] = useState(false);
  const [prefillData, setPrefillData] = useState<ReturnPrefill | null>(null);

  const canCreate = checkSubPermission('create_return') && !isWriteBlocked;
  const canApprove = checkSubPermission('approve_return') && !isWriteBlocked;
  const canReceive = checkSubPermission('receive_return') && !isWriteBlocked;
  const canInspect = checkSubPermission('inspect_return') && !isWriteBlocked;
  const canDispose = checkSubPermission('complete_return_disposition') && !isWriteBlocked;
  const canCancel = checkSubPermission('cancel_return') && !isWriteBlocked;
  const canCreateShipment = checkSubPermission('create_return_shipment') && !isWriteBlocked;

  useEffect(() => {
    const state = location.state as { openCreate?: boolean; prefill?: ReturnPrefill } | null;
    if (state?.openCreate && state.prefill) {
      navigate(location.pathname, { replace: true, state: null });
      if (canCreate && canView) {
        setPrefillData(state.prefill);
        setShowCreateModal(true);
      }
    }
  }, [location.state, canCreate, canView, navigate, location.pathname]);

  useEffect(() => {
    // 1:1 mapping — do not collapse Packed into Label Created, do not collapse Dispatched into In Transit.
    // In Transit is only reached when the shipment itself reports In Transit (driven by actual carrier/provider events).
    const SHIPMENT_TO_RETURN_STATUS: Record<string, ReturnStatus> = {
      'Ready': 'Ready',
      'Label Created': 'Label Created',
      'Packed': 'Packed',
      'Dispatched': 'Dispatched',
      'In Transit': 'In Transit',
      'Delivered': 'Delivered',
    };
    const SYNC_ELIGIBLE: ReturnStatus[] = ['Approved', 'Ready', 'Label Created', 'Packed', 'Dispatched', 'In Transit', 'Delivered'];
    returns.forEach(ret => {
      if (!ret.returnShipmentId || !SYNC_ELIGIBLE.includes(ret.status)) return;
      const linkedShip = shipments.find(s => s.id === ret.returnShipmentId);
      if (!linkedShip) return;
      const mappedStatus = SHIPMENT_TO_RETURN_STATUS[linkedShip.status];
      if (!mappedStatus) return;
      const statusOrder: ReturnStatus[] = ['Draft', 'Requested', 'Approved', 'Ready', 'Label Created', 'Packed', 'Dispatched', 'In Transit', 'Delivered'];
      const currentIdx = statusOrder.indexOf(ret.status);
      const targetIdx = statusOrder.indexOf(mappedStatus);
      if (targetIdx > currentIdx) {
        const now = new Date().toISOString();
        const entry: ReturnStatusHistoryEntry = {
          id: `rsh-sync-${Date.now()}-${ret.id}`,
          status: mappedStatus,
          timestamp: now,
          performedBy: 'System',
          notes: `Auto-synced from shipment ${linkedShip.shipmentNumber} (${linkedShip.status})`,
        };
        updateReturn(ret.id, {
          status: mappedStatus,
          updatedAt: now,
          statusHistory: [...ret.statusHistory, entry],
        });
        if (selectedReturn?.id === ret.id) {
          setSelectedReturn(prev => prev ? { ...prev, status: mappedStatus, updatedAt: now, statusHistory: [...prev.statusHistory, entry] } : null);
        }
      }
    });
  }, [shipments]);

  const filteredReturns = useMemo(() => {
    let list = [...returns];
    if (tabView === 'active') list = list.filter(r => !['Completed', 'Rejected', 'Cancelled'].includes(r.status));
    if (tabView === 'completed') list = list.filter(r => ['Completed', 'Rejected', 'Cancelled'].includes(r.status));
    if (statusFilter !== 'all') list = list.filter(r => r.status === statusFilter);
    if (sourceFilter !== 'all') list = list.filter(r => r.sourceType === sourceFilter);
    if (searchTerm.trim()) {
      const s = searchTerm.toLowerCase();
      list = list.filter(r =>
        r.returnNumber.toLowerCase().includes(s) ||
        r.customerName.toLowerCase().includes(s) ||
        r.sourceNumber.toLowerCase().includes(s) ||
        (r.reasonDetails || '').toLowerCase().includes(s)
      );
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [returns, tabView, statusFilter, sourceFilter, searchTerm]);

  const stats = useMemo(() => ({
    total: returns.length,
    active: returns.filter(r => !['Completed', 'Rejected', 'Cancelled'].includes(r.status)).length,
    awaitingApproval: returns.filter(r => r.status === 'Requested').length,
    inTransit: returns.filter(r => r.status === 'In Transit').length,
    awaitingIntake: returns.filter(r => r.status === 'Received' || r.status === 'Inspecting').length,
  }), [returns]);

  const handleStatusTransition = (ret: Return, newStatus: ReturnStatus, notes?: string) => {
    if (isWriteBlocked) return;
    const now = new Date().toISOString();
    const entry: ReturnStatusHistoryEntry = {
      id: `rsh-${Date.now()}`,
      status: newStatus,
      timestamp: now,
      performedBy: session?.name || 'System',
      notes,
    };
    const updates: Partial<Return> = {
      status: newStatus,
      updatedAt: now,
      statusHistory: [...ret.statusHistory, entry],
    };
    if (newStatus === 'Received') {
      updates.receivedAt = now;
      updates.receivedBy = session?.name || 'System';
    }
    updateReturn(ret.id, updates);
    if (selectedReturn?.id === ret.id) {
      setSelectedReturn({ ...ret, ...updates, statusHistory: updates.statusHistory! });
    }
  };

  if (!canView) {
    return (
      <PageShell title="Returns Portal">
        <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-slate-200 flex flex-col items-center justify-center text-center">
          <span className="material-symbols-outlined text-4xl text-slate-300 mb-4">lock</span>
          <p className="text-sm font-bold text-slate-400">You do not have permission to view the Returns Portal.</p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="Returns Portal">
      <div className="space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: 'Total Returns', value: stats.total, icon: 'assignment_return', color: 'text-teal-600 bg-teal-50' },
            { label: 'Active', value: stats.active, icon: 'pending_actions', color: 'text-blue-600 bg-blue-50' },
            { label: 'Awaiting Approval', value: stats.awaitingApproval, icon: 'hourglass_top', color: 'text-amber-600 bg-amber-50' },
            { label: 'In Transit', value: stats.inTransit, icon: 'local_shipping', color: 'text-indigo-600 bg-indigo-50' },
            { label: 'Awaiting Intake', value: stats.awaitingIntake, icon: 'inventory_2', color: 'text-purple-600 bg-purple-50' },
          ].map(s => (
            <div key={s.label} className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 p-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.color}`}>
                  <span className="material-symbols-outlined text-xl">{s.icon}</span>
                </div>
                <div>
                  <div className="text-2xl font-black text-slate-900">{s.value}</div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{s.label}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 p-4">
          <div className="flex flex-col lg:flex-row gap-3 items-start lg:items-center justify-between">
            <div className="flex gap-2">
              {(['all', 'active', 'completed'] as TabView[]).map(t => (
                <button key={t} onClick={() => setTabView(t)}
                  className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all ${tabView === t ? 'bg-teal-600 text-white shadow-lg' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  {t === 'all' ? 'All Returns' : t === 'active' ? 'Active' : 'Completed'}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" style={{ fontSize: 18 }}>search</span>
                <input type="text" placeholder="Search returns..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                  className="pl-9 pr-4 py-2 rounded-xl border border-slate-200 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-teal-500/30" />
              </div>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}
                className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-semibold bg-white">
                <option value="all">All Statuses</option>
                {(Object.keys(RETURN_STATUS_CONFIG) as ReturnStatus[]).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value as any)}
                className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-semibold bg-white">
                <option value="all">All Sources</option>
                {(Object.keys(SOURCE_TYPE_LABELS) as ReturnSourceType[]).map(s => <option key={s} value={s}>{SOURCE_TYPE_LABELS[s]}</option>)}
              </select>
              {canCreate && (
                <button onClick={() => setShowCreateModal(true)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 text-white rounded-xl text-xs font-bold hover:bg-teal-700 transition-all shadow-lg shadow-teal-600/20">
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                  New Return
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Returns Table */}
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 overflow-hidden">
          {filteredReturns.length === 0 ? (
            <div className="p-12 text-center">
              <span className="material-symbols-outlined text-5xl text-slate-300 mb-3 block">assignment_return</span>
              <h3 className="text-lg font-bold text-slate-400 mb-1">No returns found</h3>
              <p className="text-sm text-slate-400">
                {searchTerm || statusFilter !== 'all' || sourceFilter !== 'all' ? 'Try adjusting your filters' : 'Returns will appear here once created'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Return #</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Status</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Customer</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Source</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Reason</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Resolution</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Items</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Created</th>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReturns.map(ret => (
                    <tr key={ret.id} className="border-b border-slate-50 hover:bg-slate-50/50 cursor-pointer transition-colors"
                      onClick={() => setSelectedReturn(ret)}>
                      <td className="px-4 py-3">
                        <span className="font-bold text-teal-700">{ret.returnNumber}</span>
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={ret.status} /></td>
                      <td className="px-4 py-3 font-medium text-slate-700">{ret.customerName}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-slate-500">{SOURCE_TYPE_LABELS[ret.sourceType]}</span>
                        <br />
                        <span className="text-[11px] font-mono text-slate-400">{ret.sourceNumber}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">{REASON_LABELS[ret.reason]}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{RESOLUTION_LABELS[ret.requestedResolution]}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{ret.items.length} item{ret.items.length !== 1 ? 's' : ''}</td>
                      <td className="px-4 py-3 text-xs text-slate-400">{new Date(ret.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <button onClick={e => { e.stopPropagation(); setSelectedReturn(ret); }}
                          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-teal-600 transition-colors">
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>visibility</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Return Detail Modal */}
      {selectedReturn && !showReturnShipmentModal && !showLabelDeliveryModal && (
        <ReturnDetailModal
          ret={selectedReturn}
          shipments={shipments}
          onClose={() => setSelectedReturn(null)}
          onStatusTransition={handleStatusTransition}
          onOpenIntake={() => setShowIntakeModal(true)}
          onOpenDisposition={() => setShowDispositionModal(true)}
          onOpenReturnShipment={() => setShowReturnShipmentModal(true)}
          onOpenLabelDelivery={() => setShowLabelDeliveryModal(true)}
          canCreate={canCreate}
          canApprove={canApprove}
          canReceive={canReceive}
          canInspect={canInspect}
          canDispose={canDispose}
          canCancel={canCancel}
          canCreateShipment={canCreateShipment}
          isWriteBlocked={isWriteBlocked}
        />
      )}

      {/* Create Return Modal */}
      {showCreateModal && (
        <CreateReturnModal
          customers={customers}
          invoices={invoices}
          repairTickets={repairTickets}
          shipments={shipments}
          rmas={rmas}
          prefill={prefillData}
          onClose={() => { setShowCreateModal(false); setPrefillData(null); }}
          onSave={(ret) => { addReturn(ret); setShowCreateModal(false); setPrefillData(null); }}
          createdBy={session?.name || 'System'}
        />
      )}

      {/* Return Shipment Modal */}
      {showReturnShipmentModal && selectedReturn && (
        <CreateReturnShipmentModal
          ret={selectedReturn}
          customers={customers}
          onClose={() => setShowReturnShipmentModal(false)}
          onSave={(shipment) => {
            if (selectedReturn.status !== 'Approved') return;
            addShipment(shipment);
            const now = new Date().toISOString();
            const entry: ReturnStatusHistoryEntry = {
              id: `rsh-${Date.now()}`,
              status: 'Approved' as ReturnStatus,
              timestamp: now,
              performedBy: session?.name || 'System',
              notes: `Return shipment ${shipment.shipmentNumber} created — awaiting label purchase in Shipping Center`,
            };
            const updates: Partial<Return> = {
              returnShipmentId: shipment.id,
              updatedAt: now,
              statusHistory: [...selectedReturn.statusHistory, entry],
            };
            updateReturn(selectedReturn.id, updates);
            setSelectedReturn({ ...selectedReturn, ...updates } as Return);
            setShowReturnShipmentModal(false);
          }}
          createdBy={session?.name || 'System'}
        />
      )}

      {/* Intake/Inspection Modal */}
      {showIntakeModal && selectedReturn && (
        <IntakeInspectionModal
          ret={selectedReturn}
          onClose={() => setShowIntakeModal(false)}
          onSave={(updates) => {
            updateReturn(selectedReturn.id, updates);
            setSelectedReturn({ ...selectedReturn, ...updates });
            setShowIntakeModal(false);
          }}
          performedBy={session?.name || 'System'}
        />
      )}

      {/* Disposition Modal */}
      {showDispositionModal && selectedReturn && (
        <DispositionModal
          ret={selectedReturn}
          onClose={() => setShowDispositionModal(false)}
          onSave={(updates) => {
            const now = new Date().toISOString();
            const fullUpdates: Partial<Return> = {
              ...updates,
              status: 'Completed' as ReturnStatus,
              updatedAt: now,
              statusHistory: [
                ...selectedReturn.statusHistory,
                { id: `rsh-${Date.now()}`, status: 'Completed' as ReturnStatus, timestamp: now, performedBy: session?.name || 'System', notes: 'Disposition completed' },
              ],
            };
            updateReturn(selectedReturn.id, fullUpdates);
            setSelectedReturn({ ...selectedReturn, ...fullUpdates } as Return);
            setShowDispositionModal(false);
          }}
          performedBy={session?.name || 'System'}
        />
      )}

      {showLabelDeliveryModal && selectedReturn && (() => {
        const linkedShip = selectedReturn.returnShipmentId ? shipments.find(s => s.id === selectedReturn.returnShipmentId) : null;
        return linkedShip ? (
          <LabelDeliveryModal
            ret={selectedReturn}
            shipment={linkedShip}
            onClose={() => setShowLabelDeliveryModal(false)}
          />
        ) : null;
      })()}
    </PageShell>
  );
}

function ShipmentStatusBadge({ status }: { status: ShipmentStatus }) {
  const colors: Partial<Record<ShipmentStatus, string>> = {
    'Draft': 'bg-slate-100 text-slate-700 border-slate-200',
    'Ready': 'bg-blue-100 text-blue-700 border-blue-200',
    'Label Created': 'bg-indigo-100 text-indigo-700 border-indigo-200',
    'Packed': 'bg-cyan-100 text-cyan-700 border-cyan-200',
    'Dispatched': 'bg-amber-100 text-amber-700 border-amber-200',
    'In Transit': 'bg-amber-100 text-amber-700 border-amber-200',
    'Delivered': 'bg-lime-100 text-lime-700 border-lime-200',
    'Exception': 'bg-red-100 text-red-700 border-red-200',
    'Returned': 'bg-purple-100 text-purple-700 border-purple-200',
    'Cancelled': 'bg-stone-100 text-stone-500 border-stone-200',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[11px] font-bold uppercase tracking-wider border ${colors[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
      {status}
    </span>
  );
}

function ReturnDetailModal({ ret, shipments, onClose, onStatusTransition, onOpenIntake, onOpenDisposition, onOpenReturnShipment, onOpenLabelDelivery, canCreate, canApprove, canReceive, canInspect, canDispose, canCancel, canCreateShipment, isWriteBlocked }: {
  ret: Return;
  shipments: Shipment[];
  onClose: () => void;
  onStatusTransition: (ret: Return, status: ReturnStatus, notes?: string) => void;
  onOpenIntake: () => void;
  onOpenDisposition: () => void;
  onOpenReturnShipment: () => void;
  onOpenLabelDelivery: () => void;
  canCreate: boolean;
  canApprove: boolean;
  canReceive: boolean;
  canInspect: boolean;
  canDispose: boolean;
  canCancel: boolean;
  canCreateShipment: boolean;
  isWriteBlocked: boolean;
}) {
  const navigate = useNavigate();
  const nextStatuses = getNextStatuses(ret.status);
  const linkedShipment = ret.returnShipmentId ? shipments.find(s => s.id === ret.returnShipmentId) : null;
  const originalShipment = ret.originalShipmentId ? shipments.find(s => s.id === ret.originalShipmentId) : null;
  const linkedShipmentDelivered = linkedShipment?.status === 'Delivered';
  const linkedShipmentDrivesShippingLeg = !!linkedShipment;

  const handleOpenShipment = (shipmentId: string) => {
    onClose();
    navigate('/shipping', { state: { openShipmentId: shipmentId } });
  };

  const canTransition = (status: ReturnStatus) => {
    if (isWriteBlocked) return false;
    if (status === 'Requested') return canCreate;
    if (status === 'Approved' || status === 'Rejected') return canApprove;
    // When a linked return shipment exists, the shipping-leg statuses (Ready / Label Created / Packed /
    // Dispatched / In Transit / Delivered) are exclusively driven by shipment auto-sync — manual buttons
    // for these are suppressed to keep the return in lock-step with the shipment.
    if (status === 'Ready') return canCreateShipment && !linkedShipmentDrivesShippingLeg;
    if (status === 'Label Created') return canCreateShipment && !linkedShipmentDrivesShippingLeg;
    if (status === 'Packed') return canCreateShipment && !linkedShipmentDrivesShippingLeg;
    if (status === 'Dispatched') return canCreateShipment && !linkedShipmentDrivesShippingLeg;
    if (status === 'In Transit') return canCreateShipment && !linkedShipmentDrivesShippingLeg;
    if (status === 'Delivered') return canCreateShipment && !linkedShipmentDrivesShippingLeg;
    if (status === 'Received') return canReceive && (ret.status === 'Delivered' || linkedShipmentDelivered || !linkedShipmentDrivesShippingLeg);
    if (status === 'Inspecting') return canInspect;
    if (status === 'Completed') return canDispose;
    if (status === 'Cancelled') return canCancel;
    return false;
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl my-8 border border-slate-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
              <span className="material-symbols-outlined text-teal-600">assignment_return</span>
              {ret.returnNumber}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">Created {new Date(ret.createdAt).toLocaleString()} by {ret.createdBy}</p>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={ret.status} />
            <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Customer & Source */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Customer</h3>
              <p className="font-bold text-slate-900">{ret.customerName}</p>
              {ret.customerEmail && <p className="text-xs text-slate-500">{ret.customerEmail}</p>}
              {ret.customerPhone && <p className="text-xs text-slate-500">{ret.customerPhone}</p>}
            </div>
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Source</h3>
              <p className="font-bold text-slate-900">{SOURCE_TYPE_LABELS[ret.sourceType]}</p>
              <p className="text-xs font-mono text-teal-600">{ret.sourceNumber}</p>
              {originalShipment && (
                <p className="text-xs text-slate-400 mt-1">Original Shipment:{' '}
                  <button onClick={() => handleOpenShipment(originalShipment.id)}
                    className="font-mono text-indigo-600 hover:text-indigo-800 underline-offset-2 hover:underline">
                    {originalShipment.shipmentNumber}
                  </button>
                </p>
              )}
            </div>
          </div>

          {/* Reason & Resolution */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Return Reason</h3>
              <p className="font-semibold text-slate-800">{REASON_LABELS[ret.reason]}</p>
              {ret.reasonDetails && <p className="text-xs text-slate-500 mt-1">{ret.reasonDetails}</p>}
            </div>
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Requested Resolution</h3>
              <p className="font-semibold text-slate-800">{RESOLUTION_LABELS[ret.requestedResolution]}</p>
              {ret.finalResolution && ret.finalResolution !== ret.requestedResolution && (
                <p className="text-xs text-amber-600 mt-1">Final: {RESOLUTION_LABELS[ret.finalResolution]}</p>
              )}
            </div>
          </div>

          {/* Items */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Return Items</h3>
            <div className="space-y-2">
              {ret.items.map(item => (
                <div key={item.id} className="bg-white rounded-xl p-3 border border-slate-100 flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-sm text-slate-800">{item.name}</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {item.sku && <span className="text-[10px] font-mono text-slate-400">{item.sku}</span>}
                      <span className="text-[10px] text-slate-400">Qty: {item.quantity}{item.maxQuantity && item.maxQuantity > 1 ? ` of ${item.maxQuantity}` : ''}</span>
                      {item.unitPrice != null && (
                        <span className="text-[10px] text-slate-500">@ <span className="font-mono font-bold text-slate-700">${item.unitPrice.toFixed(2)}</span> = <span className="font-bold text-emerald-700">${(item.unitPrice * item.quantity).toFixed(2)}</span></span>
                      )}
                      {item.condition && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${item.condition === 'Defective' || item.condition === 'Damaged' ? 'bg-red-50 text-red-600' : item.condition === 'New' || item.condition === 'Like New' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                          {item.condition}
                        </span>
                      )}
                    </div>
                    {item.notes && <p className="text-[11px] text-slate-500 mt-0.5">{item.notes}</p>}
                  </div>
                  {item.disposition && (
                    <span className="text-[10px] font-bold text-purple-600 bg-purple-50 px-2 py-1 rounded-lg">
                      {DISPOSITION_LABELS[item.disposition]}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Return Shipment */}
          {linkedShipment ? (
            <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-100">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-indigo-400">Return Shipment</h3>
                <ShipmentStatusBadge status={linkedShipment.status} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <button onClick={() => handleOpenShipment(linkedShipment.id)}
                    className="font-bold text-indigo-800 hover:text-indigo-900 underline-offset-2 hover:underline inline-flex items-center gap-1">
                    {linkedShipment.shipmentNumber}
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
                  </button>
                  <p className="text-xs text-indigo-600">Carrier: {linkedShipment.carrier || 'N/A'} • Service: {linkedShipment.serviceLevel || 'N/A'}</p>
                  {linkedShipment.trackingNumber ? (
                    <div className="flex items-center gap-2 mt-0.5">
                      <TrackingNumber value={linkedShipment.trackingNumber} size="md" colorClass="text-indigo-900" copyable label="Tracking:" />
                    </div>
                  ) : (
                    <p className="text-xs text-indigo-600">Tracking: <span className="font-mono">Pending</span></p>
                  )}
                  {linkedShipment.returnInfo?.returnLabelUrl && (
                    <a href={linkedShipment.returnInfo.returnLabelUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold mt-1">
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>label</span>
                      View Return Label
                    </a>
                  )}
                </div>
                {(linkedShipment.status === 'Label Created' || linkedShipment.trackingNumber || linkedShipment.returnInfo?.returnLabelUrl) && !isWriteBlocked && (
                  <button onClick={onOpenLabelDelivery}
                    className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 text-white rounded-xl text-[11px] font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-600/20">
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>send</span>
                    Send Label to Customer
                  </button>
                )}
              </div>
              {linkedShipment.status === 'Draft' && (
                <div className="mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-[11px] text-amber-700 font-medium">
                    <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 14 }}>info</span>
                    Shipment is still Draft — purchase a label in the Shipping Center to advance the return lifecycle.
                  </p>
                </div>
              )}
              {ret.status === 'Delivered' && canReceive && (
                <div className="mt-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <p className="text-[11px] text-emerald-700 font-medium">
                    <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 14 }}>check_circle</span>
                    Package delivered to your facility — awaiting intake. Click <span className="font-bold">Received</span> below to begin inspection.
                  </p>
                </div>
              )}
              {ret.status === 'In Transit' && !linkedShipmentDelivered && (
                <div className="mt-2 px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg">
                  <p className="text-[11px] text-slate-600 font-medium">
                    <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 14 }}>hourglass_top</span>
                    Reverse shipping leg is driven by the linked shipment. Return will advance to Delivered (Awaiting Receipt) automatically when the carrier marks the shipment Delivered.
                  </p>
                </div>
              )}
              {linkedShipmentDrivesShippingLeg && (['Approved', 'Ready', 'Label Created', 'Packed', 'Dispatched', 'In Transit'] as ReturnStatus[]).includes(ret.status) && (
                <div className="mt-2 px-3 py-2 bg-indigo-50/60 border border-indigo-200 rounded-lg">
                  <p className="text-[10px] text-indigo-600 font-medium">
                    <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 12 }}>sync</span>
                    Shipping-leg statuses are auto-synced from the linked shipment. Manual progression is disabled while the linked shipment is authoritative.
                  </p>
                </div>
              )}
              {linkedShipment.events && linkedShipment.events.length > 0 && (
                <div className="mt-3 pt-3 border-t border-indigo-200/50">
                  <p className="text-[10px] font-bold text-indigo-400 mb-1.5">Latest Activity</p>
                  {linkedShipment.events.slice(-3).reverse().map(evt => (
                    <p key={evt.id} className="text-[11px] text-indigo-600">
                      <span className="font-semibold">{evt.status}</span> — {new Date(evt.timestamp).toLocaleString()}
                      {evt.description && <span className="text-indigo-500"> · {evt.description}</span>}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ) : ret.status === 'Approved' && canCreateShipment ? (
            <div className="bg-indigo-50/50 rounded-2xl p-4 border border-dashed border-indigo-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-1">Return Shipment</h3>
                  <p className="text-xs text-slate-500">No return shipment created yet. Create one to generate a return label.</p>
                </div>
                <button onClick={onOpenReturnShipment}
                  className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-600/20">
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>local_shipping</span>
                  Create Return Shipment
                </button>
              </div>
            </div>
          ) : null}

          {/* Inspection Results */}
          {(ret.inspectionNotes || ret.receivedAt) && (
            <div className="bg-purple-50 rounded-2xl p-4 border border-purple-100">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-purple-400 mb-2">Intake & Inspection</h3>
              {ret.receivedAt && (
                <p className="text-xs text-purple-600 mb-1">Received: {new Date(ret.receivedAt).toLocaleString()} by {ret.receivedBy}</p>
              )}
              {ret.inspectionNotes && (
                <p className="text-sm text-purple-800">{ret.inspectionNotes}</p>
              )}
              {ret.itemCondition && (
                <p className="text-xs text-purple-600 mt-1">Condition: <span className="font-bold">{ret.itemCondition}</span></p>
              )}
              {ret.inspectionCompletedAt && (
                <p className="text-xs text-purple-500 mt-1">Completed: {new Date(ret.inspectionCompletedAt).toLocaleString()} by {ret.inspectedBy}</p>
              )}
            </div>
          )}

          {/* Disposition */}
          {ret.finalDisposition && (
            <div className="bg-lime-50 rounded-2xl p-4 border border-lime-100">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-lime-500 mb-2">Final Disposition</h3>
              <p className="font-bold text-lime-800">{DISPOSITION_LABELS[ret.finalDisposition]}</p>
              {ret.dispositionNotes && <p className="text-sm text-lime-700 mt-1">{ret.dispositionNotes}</p>}
              {ret.refundAmount != null && ret.refundAmount > 0 && (
                <p className="text-xs text-lime-600 mt-1">Refund Amount: <span className="font-bold">${ret.refundAmount.toFixed(2)}</span></p>
              )}
              {ret.storeCreditAmount != null && ret.storeCreditAmount > 0 && (
                <p className="text-xs text-lime-600">Store Credit: <span className="font-bold">${ret.storeCreditAmount.toFixed(2)}</span></p>
              )}
              {ret.restockingFee != null && ret.restockingFee > 0 && (
                <p className="text-xs text-amber-600">Restocking Fee: <span className="font-bold">${ret.restockingFee.toFixed(2)}</span></p>
              )}
            </div>
          )}

          {/* Status History / Audit */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Status History</h3>
            <div className="space-y-2">
              {ret.statusHistory.map((entry, i) => (
                <div key={entry.id} className="flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`w-3 h-3 rounded-full ${i === ret.statusHistory.length - 1 ? 'bg-teal-500' : 'bg-slate-300'}`} />
                    {i < ret.statusHistory.length - 1 && <div className="w-0.5 h-6 bg-slate-200" />}
                  </div>
                  <div className="pb-2">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={entry.status} />
                      <span className="text-[11px] text-slate-400">{new Date(entry.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">by {entry.performedBy}{entry.notes ? ` — ${entry.notes}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Actions Footer */}
        {nextStatuses.length > 0 && !isWriteBlocked && (
          <div className="px-6 py-4 border-t border-slate-100 flex flex-wrap gap-2 justify-end">
            {ret.status === 'Received' && canInspect && (
              <button onClick={onOpenIntake}
                className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 text-white rounded-xl text-xs font-bold hover:bg-purple-700 transition-all">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>search</span>
                Start Inspection
              </button>
            )}
            {ret.status === 'Inspecting' && canDispose && (
              <button onClick={onOpenDisposition}
                className="flex items-center gap-1.5 px-4 py-2 bg-lime-600 text-white rounded-xl text-xs font-bold hover:bg-lime-700 transition-all">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>task_alt</span>
                Complete Disposition
              </button>
            )}
            {nextStatuses.filter(s => s !== 'Inspecting' || ret.status !== 'Received').map(status => (
              canTransition(status) && (
                <button key={status} onClick={() => onStatusTransition(ret, status)}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                    status === 'Cancelled' || status === 'Rejected'
                      ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : 'bg-teal-100 text-teal-700 hover:bg-teal-200'
                  }`}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{RETURN_STATUS_CONFIG[status].icon}</span>
                  {status === 'Cancelled' ? 'Cancel' : status === 'Rejected' ? 'Reject' : `→ ${status}`}
                </button>
              )
            ))}
          </div>
        )}
        {isWriteBlocked && (
          <div className="px-6 py-3 border-t border-slate-100 text-center">
            <span className="text-xs font-bold text-amber-600 bg-amber-50 px-4 py-1.5 rounded-lg">Preview Mode — Actions Disabled</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CreateReturnModal({ customers, invoices, repairTickets, shipments, rmas, prefill, onClose, onSave, createdBy }: {
  customers: Customer[];
  invoices: Invoice[];
  repairTickets: RepairTicket[];
  shipments: Shipment[];
  rmas: RMA[];
  prefill?: ReturnPrefill | null;
  onClose: () => void;
  onSave: (ret: Return) => void;
  createdBy: string;
}) {
  const [sourceType, setSourceType] = useState<ReturnSourceType>(prefill?.sourceType || 'invoice');
  const [sourceNumber, setSourceNumber] = useState(prefill?.sourceNumber || '');
  const [sourceId, setSourceId] = useState(prefill?.sourceId || '');
  const [customerId, setCustomerId] = useState(prefill?.customerId || '');
  const [reason, setReason] = useState<ReturnReason>(prefill?.reason || 'defective');
  const [reasonDetails, setReasonDetails] = useState('');
  const [requestedResolution, setRequestedResolution] = useState<ReturnResolution>('refund');
  const [itemName, setItemName] = useState('');
  const [itemQty, setItemQty] = useState(1);
  const [itemCondition, setItemCondition] = useState<string>('');
  const [items, setItems] = useState<ReturnItem[]>(() => {
    if (prefill?.items && prefill.items.length > 0) {
      return prefill.items.map((pi, idx) => ({
        id: `ri-prefill-${idx}`,
        name: pi.name,
        quantity: pi.quantity,
        sku: pi.sku,
        unitPrice: pi.unitPrice,
        maxQuantity: pi.maxQuantity ?? pi.quantity,
        reason: prefill.reason || 'defective',
      }));
    }
    return [];
  });
  const [notes, setNotes] = useState('');
  const [originalShipmentId, setOriginalShipmentId] = useState(prefill?.originalShipmentId || '');
  const [sourceResolved, setSourceResolved] = useState<string | null>(prefill ? `Prefilled from ${SOURCE_TYPE_LABELS[prefill.sourceType]} ${prefill.sourceNumber}` : null);
  const [sourceResolveError, setSourceResolveError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  const selectedCustomer = customers.find(c => c.id === customerId);

  const ELIGIBLE_INVOICE_STATUSES = ['Paid', 'Partially Paid'];
  const ELIGIBLE_REPAIR_STATUSES = ['Completed', 'Delivered', 'Ready for Pickup'];
  const ELIGIBLE_SHIPMENT_STATUSES = ['Delivered'];

  function resolveSourceReference() {
    const ref = sourceNumber.trim();
    if (!ref) {
      setSourceResolveError('Enter a source reference number to resolve.');
      setSourceResolved(null);
      return;
    }
    setIsResolving(true);
    setSourceResolveError(null);
    setSourceResolved(null);

    if (sourceType === 'invoice') {
      const invoice = invoices.find(inv => inv.invoiceNumber.toLowerCase() === ref.toLowerCase());
      if (!invoice) { setSourceResolveError(`No invoice found with reference "${ref}".`); setIsResolving(false); return; }
      if (!ELIGIBLE_INVOICE_STATUSES.includes(invoice.status)) { setSourceResolveError(`Invoice ${invoice.invoiceNumber} has status "${invoice.status}" — only Paid or Partially Paid invoices are eligible for returns.`); setIsResolving(false); return; }
      setSourceId(invoice.id);
      setSourceNumber(invoice.invoiceNumber);
      setCustomerId(invoice.customerId);
      setItems(invoice.items.map((it, idx) => ({ id: `ri-res-${idx}`, name: it.name, quantity: it.quantity, maxQuantity: it.quantity, unitPrice: it.price, sku: it.stockItemId, reason })));
      setSourceResolved(`Resolved: ${invoice.invoiceNumber} — ${invoice.customerName} (${invoice.status})`);
    } else if (sourceType === 'repair') {
      const ticket = repairTickets.find(t => t.ticketNumber.toLowerCase() === ref.toLowerCase());
      if (!ticket) { setSourceResolveError(`No repair ticket found with reference "${ref}".`); setIsResolving(false); return; }
      if (!ELIGIBLE_REPAIR_STATUSES.includes(ticket.status)) { setSourceResolveError(`Repair ticket ${ticket.ticketNumber} has status "${ticket.status}" — only Completed, Delivered, or Ready for Pickup tickets are eligible for returns.`); setIsResolving(false); return; }
      setSourceId(ticket.id);
      setSourceNumber(ticket.ticketNumber);
      setCustomerId(ticket.customerId);
      setItems([{ id: `ri-res-0`, name: `${ticket.device} — ${ticket.issue}`, quantity: 1, reason }]);
      setSourceResolved(`Resolved: ${ticket.ticketNumber} — ${ticket.customerName}, ${ticket.device} (${ticket.status})`);
    } else if (sourceType === 'shipment') {
      const ship = shipments.find(s => s.shipmentNumber.toLowerCase() === ref.toLowerCase() && !s.returnInfo?.isReturn);
      if (!ship) { setSourceResolveError(`No outbound shipment found with reference "${ref}".`); setIsResolving(false); return; }
      if (!ELIGIBLE_SHIPMENT_STATUSES.includes(ship.status)) { setSourceResolveError(`Shipment ${ship.shipmentNumber} has status "${ship.status}" — only Delivered shipments are eligible for returns.`); setIsResolving(false); return; }
      setSourceId(ship.id);
      setSourceNumber(ship.shipmentNumber);
      setOriginalShipmentId(ship.id);
      const destCustomer = customers.find(c => c.name === ship.destinationAddress?.name || c.email === ship.destinationAddress?.email);
      if (destCustomer) setCustomerId(destCustomer.id);
      const pkgItems = ship.packages?.flatMap(p => p.contentsSummary ? [{ id: `ri-res-${Math.random()}`, name: p.contentsSummary, quantity: 1, reason }] : []) || [];
      if (pkgItems.length > 0) setItems(pkgItems as ReturnItem[]);
      setSourceResolved(`Resolved: ${ship.shipmentNumber} — ${ship.destinationAddress?.name || 'Customer'} (${ship.status})`);
    } else if (sourceType === 'rma') {
      const rma = rmas.find(r => r.rmaNumber.toLowerCase() === ref.toLowerCase());
      if (!rma) { setSourceResolveError(`No RMA found with reference "${ref}".`); setIsResolving(false); return; }
      setSourceId(rma.id);
      setSourceNumber(rma.rmaNumber);
      setItems(rma.items.map((it, idx) => ({ id: `ri-res-${idx}`, name: it.name, quantity: it.quantity, reason })));
      setSourceResolved(`Resolved: ${rma.rmaNumber} — ${rma.supplierName} (${rma.status})`);
    }
    setIsResolving(false);
  }

  const handleAddItem = () => {
    if (!itemName.trim()) return;
    setItems(prev => [...prev, {
      id: `ri-${Date.now()}`,
      name: itemName.trim(),
      quantity: itemQty,
      condition: (itemCondition || undefined) as ReturnItem['condition'],
      reason,
    }]);
    setItemName('');
    setItemQty(1);
    setItemCondition('');
  };

  const handleSave = () => {
    if (!customerId || !sourceNumber.trim() || items.length === 0) return;
    const now = new Date().toISOString();
    const retNum = `RTN-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const newReturn: Return = {
      id: `ret-${Date.now()}`,
      returnNumber: retNum,
      status: 'Draft',
      sourceType,
      sourceId: sourceId || `src-${Date.now()}`,
      sourceNumber: sourceNumber.trim(),
      customerId,
      customerName: selectedCustomer?.name || prefill?.customerName || '',
      customerEmail: selectedCustomer?.email || prefill?.customerEmail,
      customerPhone: selectedCustomer?.phone || prefill?.customerPhone,
      originalShipmentId: originalShipmentId || prefill?.originalShipmentId,
      reason,
      reasonDetails: reasonDetails.trim() || undefined,
      requestedResolution,
      items,
      createdBy,
      createdAt: now,
      updatedAt: now,
      statusHistory: [{ id: `rsh-${Date.now()}`, status: 'Draft', timestamp: now, performedBy: createdBy }],
      notes: notes.trim() || undefined,
    };
    onSave(newReturn);
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-8 border border-slate-200">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <span className="material-symbols-outlined text-teal-600">add_circle</span>
            New Return
          </h2>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-400">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Source Reference Resolution */}
          <div className="bg-teal-50 rounded-2xl p-4 border border-teal-100">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-teal-500 mb-3">Source Reference</h3>
            <div className="grid grid-cols-5 gap-3">
              <div className="col-span-2">
                <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Source Type</label>
                <select value={sourceType} onChange={e => { setSourceType(e.target.value as ReturnSourceType); setSourceResolved(null); setSourceResolveError(null); setSourceId(''); }}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30">
                  {(Object.keys(SOURCE_TYPE_LABELS) as ReturnSourceType[]).map(s => <option key={s} value={s}>{SOURCE_TYPE_LABELS[s]}</option>)}
                </select>
              </div>
              <div className="col-span-3">
                <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Source Reference # *</label>
                <div className="flex gap-2">
                  <input type="text" value={sourceNumber} onChange={e => { setSourceNumber(e.target.value); setSourceResolved(null); setSourceResolveError(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); resolveSourceReference(); } }}
                    placeholder={sourceType === 'invoice' ? 'e.g. INV-2026-001' : sourceType === 'repair' ? 'e.g. T-1001' : sourceType === 'shipment' ? 'e.g. SHP-2026-001' : sourceType === 'rma' ? 'e.g. RMA-2026-001' : 'Reference #'}
                    className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30" />
                  <button type="button" onClick={resolveSourceReference} disabled={isResolving || !sourceNumber.trim() || sourceType === 'walk_in'}
                    className="px-4 py-2.5 bg-teal-600 text-white font-bold text-[10px] uppercase tracking-widest rounded-xl hover:bg-teal-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0">
                    <span className="material-symbols-outlined text-sm">{isResolving ? 'hourglass_top' : 'search'}</span>
                    Resolve
                  </button>
                </div>
              </div>
            </div>
            {sourceResolveError && (
              <div className="mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                <span className="material-symbols-outlined text-red-500 text-sm mt-0.5">error</span>
                <p className="text-xs text-red-600 font-medium">{sourceResolveError}</p>
              </div>
            )}
            {sourceResolved && (
              <div className="mt-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-2">
                <span className="material-symbols-outlined text-emerald-500 text-sm mt-0.5">check_circle</span>
                <p className="text-xs text-emerald-700 font-medium">{sourceResolved}</p>
              </div>
            )}
          </div>

          {/* Customer Selection */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Customer *</label>
            <select value={customerId} onChange={e => setCustomerId(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30">
              <option value="">Select customer...</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name} — {c.email}</option>)}
            </select>
          </div>

          {/* Reason & Resolution */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Return Reason</label>
              <select value={reason} onChange={e => setReason(e.target.value as ReturnReason)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30">
                {(Object.keys(REASON_LABELS) as ReturnReason[]).map(r => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Requested Resolution</label>
              <select value={requestedResolution} onChange={e => setRequestedResolution(e.target.value as ReturnResolution)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30">
                {(Object.keys(RESOLUTION_LABELS) as ReturnResolution[]).map(r => <option key={r} value={r}>{RESOLUTION_LABELS[r]}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Reason Details</label>
            <textarea value={reasonDetails} onChange={e => setReasonDetails(e.target.value)} rows={2} placeholder="Additional details about the return reason..."
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30 resize-none" />
          </div>

          {/* Items */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Return Items *</h3>
            {items.length > 0 && (
              <div className="space-y-2 mb-3">
                {items.map((item, i) => {
                  const lineTotal = (item.unitPrice ?? 0) * item.quantity;
                  const max = item.maxQuantity || 99;
                  return (
                    <div key={item.id} className="bg-white rounded-xl p-3 border border-slate-100 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{item.name}</p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {item.unitPrice != null && (
                            <span className="text-[10px] text-slate-500">@ <span className="font-mono font-bold text-slate-700">${item.unitPrice.toFixed(2)}</span></span>
                          )}
                          {item.maxQuantity != null && item.maxQuantity > 1 && (
                            <span className="text-[10px] text-slate-400">of {item.maxQuantity} originally purchased</span>
                          )}
                          {item.condition && <span className="text-[10px] text-slate-500">({item.condition})</span>}
                          {item.unitPrice != null && (
                            <span className="text-[10px] font-bold text-emerald-700">Refund context: ${lineTotal.toFixed(2)}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <label className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Qty</label>
                        <input type="number" min={1} max={max} value={item.quantity}
                          onChange={e => {
                            const v = Math.max(1, Math.min(max, Number(e.target.value) || 1));
                            setItems(prev => prev.map((it, idx) => idx === i ? { ...it, quantity: v } : it));
                          }}
                          className="w-14 px-2 py-1 rounded-lg border border-slate-200 text-xs text-center focus:outline-none focus:ring-2 focus:ring-teal-500/30" />
                        <button onClick={() => setItems(prev => prev.filter((_, idx) => idx !== i))}
                          className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600" aria-label="Remove item">
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <input type="text" value={itemName} onChange={e => setItemName(e.target.value)} placeholder="Item name"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30" />
              </div>
              <div className="w-16">
                <input type="number" min={1} value={itemQty} onChange={e => setItemQty(Number(e.target.value) || 1)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-teal-500/30" />
              </div>
              <div className="w-28">
                <select value={itemCondition} onChange={e => setItemCondition(e.target.value)}
                  className="w-full px-2 py-2 rounded-lg border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-teal-500/30">
                  <option value="">Condition</option>
                  {CONDITION_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <button onClick={handleAddItem} disabled={!itemName.trim()}
                className="px-3 py-2 bg-teal-600 text-white rounded-lg text-xs font-bold hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Internal notes..."
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30 resize-none" />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-100 transition-all">Cancel</button>
          <button onClick={handleSave} disabled={!customerId || !sourceNumber.trim() || items.length === 0}
            className="px-5 py-2.5 bg-teal-600 text-white rounded-xl text-sm font-bold hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-teal-600/20">
            Create Return
          </button>
        </div>
      </div>
    </div>
  );
}

function IntakeInspectionModal({ ret, onClose, onSave, performedBy }: {
  ret: Return;
  onClose: () => void;
  onSave: (updates: Partial<Return>) => void;
  performedBy: string;
}) {
  const [inspectionNotes, setInspectionNotes] = useState(ret.inspectionNotes || '');
  const [itemCondition, setItemCondition] = useState(ret.itemCondition || '');
  const [itemUpdates, setItemUpdates] = useState<Record<string, { condition?: string; inspectionNotes?: string }>>(
    Object.fromEntries(ret.items.map(item => [item.id, { condition: item.condition || '', inspectionNotes: item.inspectionNotes || '' }]))
  );

  const handleSave = () => {
    const now = new Date().toISOString();
    const updatedItems: ReturnItem[] = ret.items.map(item => ({
      ...item,
      condition: (itemUpdates[item.id]?.condition || item.condition || undefined) as ReturnItem['condition'],
      inspectionNotes: itemUpdates[item.id]?.inspectionNotes || item.inspectionNotes,
    }));
    const newEntry: ReturnStatusHistoryEntry = {
      id: `rsh-${Date.now()}`,
      status: 'Inspecting',
      timestamp: now,
      performedBy,
      notes: 'Inspection completed',
    };
    onSave({
      status: 'Inspecting',
      inspectionNotes,
      itemCondition,
      inspectionCompletedAt: now,
      inspectedBy: performedBy,
      items: updatedItems,
      updatedAt: now,
      statusHistory: [...ret.statusHistory, newEntry],
    });
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-8 border border-slate-200">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <span className="material-symbols-outlined text-purple-600">search</span>
            Intake & Inspection — {ret.returnNumber}
          </h2>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-400">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Overall Condition Assessment</label>
            <select value={itemCondition} onChange={e => setItemCondition(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/30">
              <option value="">Select condition...</option>
              {CONDITION_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Inspection Notes</label>
            <textarea value={inspectionNotes} onChange={e => setInspectionNotes(e.target.value)} rows={3}
              placeholder="Document inspection findings, defects, condition details..."
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/30 resize-none" />
          </div>

          <div className="bg-purple-50 rounded-2xl p-4 border border-purple-100">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-purple-400 mb-3">Item-Level Inspection</h3>
            <div className="space-y-3">
              {ret.items.map(item => (
                <div key={item.id} className="bg-white rounded-xl p-4 border border-purple-100">
                  <p className="font-semibold text-sm text-slate-800 mb-2">{item.name} (×{item.quantity})</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 mb-1">Condition</label>
                      <select value={itemUpdates[item.id]?.condition || ''} onChange={e => setItemUpdates(prev => ({ ...prev, [item.id]: { ...prev[item.id], condition: e.target.value } }))}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs">
                        <option value="">Select...</option>
                        {CONDITION_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 mb-1">Item Notes</label>
                      <input type="text" value={itemUpdates[item.id]?.inspectionNotes || ''} onChange={e => setItemUpdates(prev => ({ ...prev, [item.id]: { ...prev[item.id], inspectionNotes: e.target.value } }))}
                        placeholder="Inspection notes..." className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={handleSave}
            className="px-5 py-2.5 bg-purple-600 text-white rounded-xl text-sm font-bold hover:bg-purple-700 shadow-lg shadow-purple-600/20 transition-all">
            Save Inspection
          </button>
        </div>
      </div>
    </div>
  );
}

function DispositionModal({ ret, onClose, onSave, performedBy }: {
  ret: Return;
  onClose: () => void;
  onSave: (updates: Partial<Return>) => void;
  performedBy: string;
}) {
  const [finalResolution, setFinalResolution] = useState<ReturnResolution>(ret.requestedResolution);
  const [finalDisposition, setFinalDisposition] = useState<ReturnDisposition>('restock');
  const [dispositionNotes, setDispositionNotes] = useState('');
  const [refundAmount, setRefundAmount] = useState(ret.refundAmount || 0);
  const [storeCreditAmount, setStoreCreditAmount] = useState(ret.storeCreditAmount || 0);
  const [restockingFee, setRestockingFee] = useState(ret.restockingFee || 0);

  const handleSave = () => {
    const now = new Date().toISOString();
    onSave({
      finalResolution,
      finalDisposition,
      dispositionNotes: dispositionNotes.trim() || undefined,
      dispositionCompletedAt: now,
      dispositionCompletedBy: performedBy,
      refundAmount: finalResolution === 'refund' ? refundAmount : undefined,
      storeCreditAmount: finalResolution === 'store_credit' ? storeCreditAmount : undefined,
      restockingFee: restockingFee > 0 ? restockingFee : undefined,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg my-8 border border-slate-200">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <span className="material-symbols-outlined text-lime-600">task_alt</span>
            Complete Disposition — {ret.returnNumber}
          </h2>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-400">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Final Resolution</label>
            <select value={finalResolution} onChange={e => setFinalResolution(e.target.value as ReturnResolution)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-lime-500/30">
              {(Object.keys(RESOLUTION_LABELS) as ReturnResolution[]).map(r => <option key={r} value={r}>{RESOLUTION_LABELS[r]}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Item Disposition</label>
            <select value={finalDisposition} onChange={e => setFinalDisposition(e.target.value as ReturnDisposition)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-lime-500/30">
              {(Object.keys(DISPOSITION_LABELS) as ReturnDisposition[]).map(d => <option key={d} value={d}>{DISPOSITION_LABELS[d]}</option>)}
            </select>
          </div>

          {finalResolution === 'refund' && (
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Refund Amount ($)</label>
              <input type="number" min={0} step={0.01} value={refundAmount} onChange={e => setRefundAmount(Number(e.target.value))}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-lime-500/30" />
            </div>
          )}

          {finalResolution === 'store_credit' && (
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Store Credit Amount ($)</label>
              <input type="number" min={0} step={0.01} value={storeCreditAmount} onChange={e => setStoreCreditAmount(Number(e.target.value))}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-lime-500/30" />
            </div>
          )}

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Restocking Fee ($)</label>
            <input type="number" min={0} step={0.01} value={restockingFee} onChange={e => setRestockingFee(Number(e.target.value))}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-lime-500/30" />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Disposition Notes</label>
            <textarea value={dispositionNotes} onChange={e => setDispositionNotes(e.target.value)} rows={3}
              placeholder="Final notes about what was done with the returned items..."
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-lime-500/30 resize-none" />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={handleSave}
            className="px-5 py-2.5 bg-lime-600 text-white rounded-xl text-sm font-bold hover:bg-lime-700 shadow-lg shadow-lime-600/20 transition-all">
            Complete Return
          </button>
        </div>
      </div>
    </div>
  );
}

const STORE_RETURN_ADDRESS: ShipmentAddress = { name: 'Main Warehouse', line1: '100 Commerce Dr', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', phone: '512-555-0100' };

function CreateReturnShipmentModal({ ret, customers, onClose, onSave, createdBy }: {
  ret: Return;
  customers: Customer[];
  onClose: () => void;
  onSave: (shipment: Shipment) => void;
  createdBy: string;
}) {
  const customer = customers.find(c => c.id === ret.customerId);
  const addrParts = (customer?.address || '').split(',').map(s => s.trim());

  const [origin, setOrigin] = useState<ShipmentAddress>({
    name: customer?.name || ret.customerName,
    line1: addrParts[0] || '',
    city: addrParts[1] || '',
    state: addrParts[2] || '',
    postalCode: addrParts[3] || '',
    country: 'US',
    phone: customer?.phone || ret.customerPhone || '',
    email: customer?.email || ret.customerEmail || '',
  });
  const [destination, setDestination] = useState<ShipmentAddress>(STORE_RETURN_ADDRESS);
  const [notes, setNotes] = useState(`Return shipment for ${ret.returnNumber}`);
  const [packages, setPackages] = useState<ShipmentPackage[]>([{
    id: `pkg-${Date.now()}`,
    contentsSummary: ret.items.map(i => `${i.name} x${i.quantity}`).join(', '),
  }]);

  const canSave = !!(origin.name && origin.line1 && origin.city && origin.state && origin.postalCode
    && destination.name && destination.line1 && destination.city && destination.state && destination.postalCode);

  const handleSave = () => {
    if (!canSave) return;
    // Defense-in-depth: hard-fail if any required field is somehow missing despite UI guards.
    const missingOrigin = !origin.name || !origin.line1 || !origin.city || !origin.state || !origin.postalCode;
    const missingDestination = !destination.name || !destination.line1 || !destination.city || !destination.state || !destination.postalCode;
    if (missingOrigin || missingDestination) return;
    const now = new Date().toISOString();
    const shipNum = `SHP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const shipment: Shipment = {
      id: `shp-ret-${Date.now()}`,
      shipmentNumber: shipNum,
      status: 'Draft',
      type: 'repair_return',
      sourceType: 'rma',
      sourceId: ret.id,
      sourceNumber: ret.returnNumber,
      originAddress: origin,
      destinationAddress: destination,
      packages,
      notes: notes.trim() || undefined,
      events: [{ id: `evt-${Date.now()}`, status: 'Created', timestamp: now, description: `Return shipment created for ${ret.returnNumber}` }],
      createdBy,
      createdAt: now,
      updatedAt: now,
      returnInfo: {
        isReturn: true,
        originalShipmentId: ret.originalShipmentId,
        returnReason: REASON_LABELS[ret.reason],
        returnRequestedAt: ret.createdAt,
      },
    };
    onSave(shipment);
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-8 border border-slate-200">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <span className="material-symbols-outlined text-indigo-600">local_shipping</span>
            Create Return Shipment — {ret.returnNumber}
          </h2>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-400">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
          <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-100">
            <p className="text-xs text-indigo-700">
              <span className="font-bold">Return shipments travel from the customer back to your warehouse.</span> The customer's address is the origin, and your store is the destination — both are editable below before dispatch.
              {' '}Carrier, service level, and tracking number are set later in the Shipping Center when you fetch rates and purchase the label.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-3">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Origin (Customer)</h3>
              <input value={origin.name} onChange={e => setOrigin(p => ({ ...p, name: e.target.value }))} placeholder="Name *"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              <input value={origin.line1} onChange={e => setOrigin(p => ({ ...p, line1: e.target.value }))} placeholder="Address Line 1 *"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              <div className="grid grid-cols-3 gap-2">
                <input value={origin.city} onChange={e => setOrigin(p => ({ ...p, city: e.target.value }))} placeholder="City *"
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
                <input value={origin.state} onChange={e => setOrigin(p => ({ ...p, state: e.target.value }))} placeholder="State *"
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
                <input value={origin.postalCode} onChange={e => setOrigin(p => ({ ...p, postalCode: e.target.value }))} placeholder="ZIP *"
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              </div>
              <input value={origin.phone || ''} onChange={e => setOrigin(p => ({ ...p, phone: e.target.value }))} placeholder="Phone"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
            </div>

            <div className="space-y-3">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Destination (Store)</h3>
              <input value={destination.name} onChange={e => setDestination(p => ({ ...p, name: e.target.value }))} placeholder="Store / Warehouse Name *"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              <input value={destination.line1} onChange={e => setDestination(p => ({ ...p, line1: e.target.value }))} placeholder="Address Line 1 *"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              <div className="grid grid-cols-3 gap-2">
                <input value={destination.city} onChange={e => setDestination(p => ({ ...p, city: e.target.value }))} placeholder="City *"
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
                <input value={destination.state} onChange={e => setDestination(p => ({ ...p, state: e.target.value }))} placeholder="State *"
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
                <input value={destination.postalCode} onChange={e => setDestination(p => ({ ...p, postalCode: e.target.value }))} placeholder="ZIP *"
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              </div>
              <input value={destination.phone || ''} onChange={e => setDestination(p => ({ ...p, phone: e.target.value }))} placeholder="Phone"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Package Contents</label>
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              {packages.map(pkg => (
                <p key={pkg.id} className="text-xs text-slate-600">{pkg.contentsSummary || 'No contents specified'}</p>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 resize-none" />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={handleSave} disabled={!canSave}
            className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 shadow-lg shadow-indigo-600/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            Create Return Shipment
          </button>
        </div>
      </div>
    </div>
  );
}

function LabelDeliveryModal({ ret, shipment, onClose }: {
  ret: Return;
  shipment: Shipment;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const labelUrl = shipment.returnInfo?.returnLabelUrl || shipment.labelUrl;
  const tracking = shipment.trackingNumber || 'N/A';
  const carrier = shipment.carrier || 'N/A';
  const service = shipment.serviceLevel || '';

  const customerInstructions = [
    `Return Authorization: ${ret.returnNumber}`,
    `Carrier: ${carrier}${service ? ` (${service})` : ''}`,
    `Tracking Number: ${tracking}`,
    labelUrl ? `Label: ${labelUrl}` : 'Label: Please print the label provided by the store.',
    '',
    'Instructions:',
    labelUrl ? '1. Download and print the return label from the link above.' : '1. Visit your nearest carrier location with this tracking number.',
    '2. Securely package the return item(s).',
    '3. Affix the return label to the outside of the package.',
    labelUrl ? '4. Drop off the package at any carrier location or schedule a pickup.' : `4. Provide the tracking number (${tracking}) to the carrier agent.`,
    '',
    `Items being returned: ${ret.items.map(i => `${i.name} x${i.quantity}`).join(', ')}`,
  ].join('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(customerInstructions).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const handleEmailCustomer = () => {
    if (!ret.customerEmail) return;
    const subject = encodeURIComponent(`Return Label — ${ret.returnNumber}`);
    const body = encodeURIComponent(customerInstructions);
    window.open(`mailto:${ret.customerEmail}?subject=${subject}&body=${body}`, '_blank');
    setEmailSent(true);
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg my-8 border border-slate-200">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
            <span className="material-symbols-outlined text-indigo-600">send</span>
            Share Return Label — {ret.returnNumber}
          </h2>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-400">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
          <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-100 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-400">Shipment Details</p>
              <ShipmentStatusBadge status={shipment.status} />
            </div>
            <p className="text-sm font-bold text-indigo-800">{shipment.shipmentNumber}</p>
            <div className="grid grid-cols-2 gap-2 text-xs text-indigo-700">
              <p>Carrier: <span className="font-bold">{carrier}</span></p>
              <p>Service: <span className="font-bold">{service || 'N/A'}</span></p>
              <p>Tracking: <span className="font-mono font-bold">{tracking}</span></p>
            </div>
            {labelUrl && (
              <a href={labelUrl} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
                Download Return Label
              </a>
            )}
          </div>

          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Customer: {ret.customerName}</p>
            {ret.customerEmail && <p className="text-xs text-slate-600">{ret.customerEmail}</p>}
            {ret.customerPhone && <p className="text-xs text-slate-600">{ret.customerPhone}</p>}
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Customer Instructions Preview</p>
            <pre className="bg-slate-50 rounded-xl p-4 border border-slate-200 text-[11px] text-slate-700 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
              {customerInstructions}
            </pre>
          </div>

          <div className="bg-amber-50 rounded-xl p-3 border border-amber-200 flex items-start gap-2">
            <span className="material-symbols-outlined text-amber-600 text-sm mt-0.5">info</span>
            <div className="text-[11px] text-amber-800 leading-relaxed">
              <p><span className="font-bold">Heads up:</span> the email button opens a draft in your default mail app — it does not send automatically. Direct send-from-server email is on the future roadmap.</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex flex-wrap justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-100 transition-all">Close</button>
          <button onClick={handleCopy}
            className={`flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg ${copied ? 'bg-emerald-600 text-white shadow-emerald-600/20' : 'bg-slate-700 text-white hover:bg-slate-800 shadow-slate-700/20'}`}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{copied ? 'check' : 'content_copy'}</span>
            {copied ? 'Copied!' : 'Copy Instructions'}
          </button>
          {ret.customerEmail && (
            <button onClick={handleEmailCustomer}
              title="Opens an email draft in your default mail app. Does not send automatically."
              className={`flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg ${emailSent ? 'bg-emerald-600 text-white shadow-emerald-600/20' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-600/20'}`}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{emailSent ? 'check' : 'drafts'}</span>
              {emailSent ? 'Draft Opened' : 'Open Email Draft'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
